"""EasyStringNegEditor: SelectorNeg logic plus a visual row editor.

Each "row" is {num?, cat?, on?, pos, neg, img}:
  * num   - optional original number kept when rows are imported from an
            old numbered dataset ("N: ... ~"); presets and line_numbers
            resolve numbers against num first, then by 1-based position
  * cat   - optional category label (free text, e.g. "artists", "body")
            used by the UI to filter / group the row list
  * on    - checkbox flag. When the node input 'select_checked' is on,
            only rows with on=true are used (manual pick mode). Rows the
            editor creates (new or imported) start unticked (on=false);
            rows without this field (legacy data) count as ticked.
  * pos   - positive prompt text
  * neg   - negative prompt text
  * img   - optional image, stored in the workflow JSON as a downscaled
            data URL so the workflow stays self-contained. The image is a
            UI aid (preview on hover); this Python module never loads it.
The row list lives in the hidden "rows" JSON widget and the
hidden "presets" plain-text widget ("N: 1 2 3" lines, one number set per
preset); both are edited through the custom front-end dialog (see
web/easy_string_neg_editor.js). A preset number selects the rows whose
numbers are listed in that preset (num first, position fallback).
Selection reuses the same syntax as the other nodes: "1", "1,3", "2-4".
"""

import json
import re

# dataset storage on disk (rows + presets saved as a .json file in <node>/data)
try:
    from .esn_storage import (  # package context (ComfyUI loads the folder as a package)
        load_dataset as esn_load_dataset,
        save_dataset as esn_save_dataset,
    )
except ImportError:  # plain script / test context
    from esn_storage import (
        load_dataset as esn_load_dataset,
        save_dataset as esn_save_dataset,
    )
try:
    from .utils import (  # package context (ComfyUI loads the folder as a package)
        format_weight,
        html_to_text,
        join_elements,
        parse_spec,
        process_elements,
        split_top_level,
    )
except ImportError:  # plain script / test context
    from utils import (
        format_weight,
        html_to_text,
        join_elements,
        parse_spec,
        process_elements,
        split_top_level,
    )


def default_rows():
    """Two demo rows so the node works right after it is added."""
    return [
        {"cat": "animals", "on": False, "pos": "a cute cat",
         "neg": "dog, blurry", "img": ""},
        {"cat": "animals", "on": False, "pos": "a bird in flight",
         "neg": "watermark", "img": ""},
    ]


def default_presets():
    """No presets by default."""
    return ""


class EasyStringNegEditor:
    """SelectorNeg-style positive/negative builder backed by a visual editor."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "rows": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": json.dumps(default_rows(), ensure_ascii=False),
                        "tooltip": "Row list edited in the Add / Edit dialog "
                                   "(JSON: [{num?, cat?, on?, pos, neg, img}, ...])",
                    },
                ),
                "presets": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": default_presets(),
                        "tooltip": "Preset sets, one per line: 'N: row numbers' "
                                   "e.g. '1: 108 193 135'. Edited/imported in "
                                   "the dialog Presets tab.",
                    },
                ),
                "line_numbers": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Rows to use when 'select_all' is off and "
                                   "'use_preset'/'select_checked' are off, "
                                   "e.g. 1,3 or 2-4. Leave empty to use the "
                                   "rows ticked with the checkbox.",
                    },
                ),
                "select_all": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "use all rows",
                        "label_off": "use line_numbers",
                    },
                ),
                "use_preset": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "use preset",
                        "label_off": "use select_all / line_numbers",
                    },
                ),
                "preset_line": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 10000,
                        "step": 1,
                        "tooltip": "Which preset (by its N) to apply when "
                                   "'use_preset' is on",
                    },
                ),
                "weight": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.1,
                        "max": 10.0,
                        "step": 0.1,
                        "display": "slider",
                    },
                ),
                "apply_weight": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "apply (tag:weight)",
                        "label_off": "plain text",
                    },
                ),
                "add_break": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "add BREAK",
                        "label_off": "no BREAK",
                    },
                ),
                "select_checked": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "use ticked rows only",
                        "label_off": "use line_numbers / preset",
                        "tooltip": "On: only rows ticked with the checkbox in "
                                   "the editor are used (manual pick mode); "
                                   "overrides line_numbers and presets.",
                    },
                ),
                "data_file": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Dataset file name in the node data folder "
                                   "(e.g. artists.json). When set, rows and "
                                   "presets are loaded from that file at run time "
                                   "instead of from the widget values.",
                    },
                ),
            },
            "optional": {
                "preset_trigger": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "forceInput": True,
                        "label_on": "trigger",
                        "label_off": "blocked",
                        "tooltip": "Optional run gate: leave unconnected to "
                                   "always run, or connect false to block.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive_prompt", "negative_prompt")
    FUNCTION = "process"
    CATEGORY = "Text Processing"
    DESCRIPTION = ("Positive/negative builder with a visual row editor, "
                   "old-data import, categories, presets, checkbox pick "
                   "and image hover previews.")
    # parsing
    # ------------------------------------------------------------------
    @staticmethod
    def _as_num(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _parse_rows(self, rows_value):
        """Turn the widget JSON into a clean [{num, pos, neg, img}, ...] list."""
        if isinstance(rows_value, str):
            try:
                data = json.loads(rows_value)
            except ValueError as exc:
                raise ValueError(
                    "EasyStringNegEditor: 'rows' is not valid JSON "
                    f"({exc}). Use the 'Add / Edit rows' button."
                ) from exc
        else:
            data = rows_value

        if not isinstance(data, list):
            raise ValueError(
                "EasyStringNegEditor: 'rows' must be a JSON list of "
                "{num?, pos, neg, img} objects."
            )

        rows = []
        for i, item in enumerate(data, 1):
            if not isinstance(item, dict):
                raise ValueError(
                    f"EasyStringNegEditor: row #{i} is not an object "
                    f"(got {type(item).__name__})."
                )
            img = item.get("img") or ""
            cat = item.get("cat") or ""
            on_raw = item.get("on", True)
            if isinstance(on_raw, bool):
                on = on_raw
            elif isinstance(on_raw, (int, float)):
                on = bool(on_raw)
            elif isinstance(on_raw, str):
                on = on_raw.strip().lower() not in ("", "0", "false", "no", "off")
            else:
                on = True
            rows.append({
                "num": self._as_num(item.get("num")),
                "cat": str(cat).strip(),
                "on": on,
                "pos": html_to_text(str(item.get("pos") or "")),
                "neg": html_to_text(str(item.get("neg") or "")),
                "img": img if isinstance(img, str) else "",
            })
        return rows

    def _parse_preset_lines(self, presets_value):
        """Turn the 'presets' widget text into [{num, content}, ...].

        Format (same as the import dialog): one preset per line, numbered
        "N: 1 2 3" / "N: 1,3 5-7". Unnumbered non-blank lines are ignored.
        """
        out = []
        for raw in (presets_value or "").split("\n"):
            if not raw.strip():
                continue
            m = re.match(r"^\s*(\d+)\s*:\s*(.*?)\s*$", raw)
            if not m:
                continue
            content = (m.group(2) or "").strip()
            out.append({"num": int(m.group(1)), "content": content})
        return out

    def _resolve_preset_content(self, presets_value, preset_line):
        """Return the number list (as text) of the requested preset.

        Matches by explicit preset number first, then by 1-based position.
        """
        presets = self._parse_preset_lines(presets_value)
        for p in presets:
            if p["num"] == preset_line:
                return p["content"]
        if 1 <= preset_line <= len(presets):
            return presets[preset_line - 1]["content"]
        raise ValueError(
            f"EasyStringNegEditor: preset {preset_line} not found "
            f"({len(presets)} preset(s) defined in the Presets tab)."
        )

    @staticmethod
    def _resolve_row_number(rows, number):
        """Row whose explicit num == number, else 1-based position; None."""
        for r in rows:
            if r["num"] is not None and r["num"] == number:
                return r
        if 1 <= number <= len(rows):
            return rows[number - 1]
        return None

    def _select_rows(self, rows, select_all, line_numbers,
                      select_checked=False):
        if not rows:
            raise ValueError(
                "EasyStringNegEditor: no rows defined - click 'Add / Edit "
                "rows' on the node to create rows."
            )
        if select_checked:
            checked = [r for r in rows if r["on"]]
            if not checked:
                raise ValueError(
                    "EasyStringNegEditor: 'select_checked' is on but no "
                    "row is ticked - tick rows in the editor (checkbox)."
                )
            return checked
        if select_all:
            return rows
        numbers = parse_spec(line_numbers)
        if not numbers:
            # select_all off and no explicit row numbers: use the rows that are
            # ticked with the checkbox (manual pick without needing the
            # select_checked toggle)
            checked = [r for r in rows if r["on"]]
            if not checked:
                raise ValueError(
                    "EasyStringNegEditor: 'select_all' is off, 'line_numbers' "
                    "is empty and no row is ticked - either enter row numbers "
                    "in 'line_numbers' or tick rows in the editor (checkbox)."
                )
            return checked
        chosen = []
        for n in numbers:
            row = self._resolve_row_number(rows, n)
            if row is not None:
                chosen.append(row)
        if not chosen:
            raise ValueError(
                f"EasyStringNegEditor: no row matches selection "
                f"'{line_numbers}' ({len(rows)} row(s) available)."
            )
        return chosen

    def _select_preset(self, rows, presets_value, preset_line):
        if not rows:
            raise ValueError(
                "EasyStringNegEditor: no rows defined - click 'Add / Edit "
                "rows' on the node to create rows."
            )
        content = self._resolve_preset_content(presets_value, preset_line)
        if not content:
            raise ValueError(
                f"EasyStringNegEditor: preset {preset_line} is empty - "
                "add row numbers in the Presets tab."
            )
        numbers = parse_spec(content)
        if not numbers:
            raise ValueError(
                f"EasyStringNegEditor: preset {preset_line} has no usable "
                "row numbers."
            )
        chosen = []
        for n in numbers:
            row = self._resolve_row_number(rows, n)
            if row is not None:
                chosen.append(row)
        if not chosen:
            raise ValueError(
                f"EasyStringNegEditor: preset {preset_line} ('{content}') "
                f"matches no row ({len(rows)} row(s) available)."
            )
        return chosen

    # ------------------------------------------------------------------
    # main
    # ------------------------------------------------------------------
    def process(self, rows, presets="", line_numbers="", select_all=True,
                use_preset=False, preset_line=1, select_checked=False,
                data_file="", weight=1.0, apply_weight=True, add_break=False,
                preset_trigger=True):
        if preset_trigger is False or preset_trigger == 0 or (
            isinstance(preset_trigger, str)
            and preset_trigger.strip().lower() in ("0", "false", "no", "off")
        ):
            raise ValueError("EasyStringNegEditor: preset_trigger is off "
                             "(connected value is false). Leave the input "
                             "unconnected or connect true to let this node run.")

        if data_file:
            # dataset mode: rows + presets come from a file on disk, not from
            # the widget values (keeps the workflow small / reusable).
            stored = esn_load_dataset(data_file)
            if stored is None:
                raise ValueError(
                    "EasyStringNegEditor: dataset file not found or invalid: "
                    + str(data_file) + " - check the Data tab of the editor."
                )
            rows = json.dumps(stored.get("rows") or [], ensure_ascii=False)
            presets = stored.get("presets") or ""

        parsed = self._parse_rows(rows)
        # manual checkbox mode wins over everything else
        if select_checked:
            chosen = self._select_rows(parsed, select_all, line_numbers,
                                       select_checked=True)
        elif use_preset:
            chosen = self._select_preset(parsed, presets, preset_line)
        else:
            chosen = self._select_rows(parsed, select_all, line_numbers)

        formatted_weight = format_weight(weight) if apply_weight else None
        positives, negatives = [], []
        for row in chosen:
            if row["pos"]:
                positives.extend(
                    process_elements(split_top_level(row["pos"]),
                                     apply_weight, formatted_weight)
                )
            if row["neg"]:
                negatives.extend(
                    process_elements(split_top_level(row["neg"]),
                                     apply_weight, formatted_weight)
                )

        positive_output = join_elements(positives)
        negative_output = join_elements(negatives)
        if add_break and positive_output:
            positive_output = positive_output + " BREAK"
        return (positive_output, negative_output)


NODE_CLASS_MAPPINGS = {"EasyStringNegEditor": EasyStringNegEditor}
NODE_DISPLAY_NAME_MAPPINGS = {"EasyStringNegEditor": "Easy String Neg Editor"}