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
  * weight- per-row weight (float, 0.1 .. 10, default 1). It multiplies the
            node's global "weight" input and is applied to EVERY element of
            the row (both its pos and its neg text), where an element is one
            comma-separated token; a row without commas is a single element.
            Left at 1 it changes nothing, so old row data keeps its meaning.
            Ignored when "apply_weight" is off (nothing is tagged then).
  * img   - optional image reference. In dataset-file mode it is the file
            name inside the dataset's "<name>.img" folder (the front-end
            uploads the picture once and stores only this reference, so
            saving a dataset no longer rewrites megabytes of base64); in
            widget mode it is still a downscaled data URL, so the workflow
            stays self-contained. The image is a UI aid (preview on hover);
            this Python module never reads it.
  * freq  - optional usage counter (int >= 0, default 0). The Python side
            bumps it once per selected row on every run and sends the new
            counters back through the "ui" channel; the front-end persists
            them into the row list so the editor can show a by-frequency
            ranking.
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
                "preset_checked": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "preset: ticked only",
                        "label_off": "preset: all its rows",
                        "tooltip": "On: a preset may only use rows that are "
                                   "also ticked with the checkbox in the "
                                   "editor, so a tick is a per-row veto "
                                   "inside the chosen preset. Off: the preset "
                                   "decides on its own (default).",
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
                "data_rev": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 2147483647,
                        "step": 1,
                        "tooltip": "Hidden revision counter bumped by the front-end "
                                   "each time the dataset file is saved, so ComfyUI "
                                   "re-executes this node after a checkbox / edit "
                                   "change (its widget inputs would otherwise look "
                                   "unchanged). Ignored by this node.",
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
                   "(rows and, optionally, inside a preset), per-row weight "
                   "sliders and image hover previews.")
    # parsing
    # ------------------------------------------------------------------
    @staticmethod
    def _as_num(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _as_freq(value):
        """Non-negative usage counter; anything invalid becomes 0.

        Accepts ints and numeric strings; bools map to 1/0; floats and other
        types are treated as invalid so a fractional value never truncates
        into a fake counter.
        """
        if value is None:
            return 0
        if isinstance(value, bool):
            return 1 if value else 0
        if isinstance(value, int):
            return value if value > 0 else 0
        if isinstance(value, str):
            try:
                n = int(float(value.strip()))
            except (TypeError, ValueError):
                return 0
            return n if n > 0 else 0
        return 0

    @staticmethod
    def _as_weight(value):
        """Per-row weight as a float clamped to the node's 0.1 .. 10 range.

        Anything missing or unparsable becomes 1.0 ("no change"), so legacy
        rows - which have no "weight" field at all - keep their old output.
        Strings are accepted so a row saved by the front-end as
        {"weight": "1.2"} behaves the same as the numeric form.
        """
        if value is None or isinstance(value, bool):
            return 1.0
        try:
            number = float(value)
        except (TypeError, ValueError):
            return 1.0
        if number != number or number in (float("inf"), float("-inf")):
            return 1.0  # NaN / inf: not a weight
        return max(0.1, min(10.0, number))

    def _parse_rows(self, rows_value):
        """Turn the widget JSON into a clean row list (see module docstring)."""
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
                "freq": self._as_freq(item.get("freq")),
                "weight": self._as_weight(item.get("weight")),
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
        # preset not found -> treat it as an empty selection (no rows chosen)
        return None

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
            # manual checkbox pick: only the ticked rows, or nothing at all
            # (an empty choice is a valid "no rows" result, not a crash)
            return [r for r in rows if r["on"]]
        if select_all:
            return rows
        numbers = parse_spec(line_numbers)
        if not numbers:
            # select_all off and no explicit row numbers: use the rows that are
            # ticked with the checkbox (manual pick without needing the
            # select_checked toggle); none ticked -> empty output
            return [r for r in rows if r["on"]]
        chosen = []
        for n in numbers:
            row = self._resolve_row_number(rows, n)
            if row is not None:
                chosen.append(row)
        # numbers that match nothing simply select no row (empty output)
        return chosen

    def _select_preset(self, rows, presets_value, preset_line,
                       ticked_only=False):
        """Rows of one preset.

        With ``ticked_only`` (the 'preset_checked' toggle) the preset's row
        list is intersected with the ticked rows, so the checkbox works as a
        per-row veto INSIDE the preset. Numbers that match nothing select no
        row, and an empty preset is an empty selection, not an error.
        """
        if not rows:
            raise ValueError(
                "EasyStringNegEditor: no rows defined - click 'Add / Edit "
                "rows' on the node to create rows."
            )
        content = self._resolve_preset_content(presets_value, preset_line)
        if not content:
            # empty / missing / empty-number-list preset -> no rows chosen
            return []
        numbers = parse_spec(content)
        if not numbers:
            return []
        chosen = []
        for n in numbers:
            row = self._resolve_row_number(rows, n)
            if row is not None and (not ticked_only or row["on"]):
                chosen.append(row)
        # preset numbers that match nothing simply select no row
        return chosen

    # ------------------------------------------------------------------
    # main
    # ------------------------------------------------------------------
    def process(self, rows, presets="", line_numbers="", select_all=True,
                use_preset=False, preset_line=1, select_checked=False,
                data_file="", data_rev=0, weight=1.0, apply_weight=True,
                add_break=False, preset_trigger=True, preset_checked=False):
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
            # preset_checked narrows the preset to its ticked rows; with the
            # (default) preset_checked=False a preset picks its rows itself,
            # so existing workflows keep their exact behavior
            chosen = self._select_preset(parsed, presets, preset_line,
                                         ticked_only=bool(preset_checked))
        else:
            chosen = self._select_rows(parsed, select_all, line_numbers)

        # Weighting is the node's global "weight" MULTIPLIED by the row's own
        # weight, so the global slider stays the master multiplier and a row
        # slider is a local correction; a row left at 1 therefore produces
        # exactly what it produced before this feature existed. The combined
        # value is what every element of the row is tagged with - one element
        # per comma-separated token, and a row without commas is one element.
        # format_weight() clamps to the node's 0.1 .. 10 range.
        formatted_global = format_weight(weight) if apply_weight else None
        positives, negatives = [], []
        for row in chosen:
            formatted_weight = formatted_global
            if apply_weight:
                try:
                    base = float(weight)
                except (TypeError, ValueError):
                    base = 1.0
                formatted_weight = format_weight(
                    base * row.get("weight", 1.0))
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

        # usage-frequency feedback: bump freq once per row that was actually
        # selected in this run and hand the updated counters to the front-end
        # through the ui channel (the JS side stores them back into the rows
        # widget, so the counters survive across runs).
        if chosen:
            ticked_ids = {id(row) for row in chosen}
            for row in parsed:
                if id(row) in ticked_ids:
                    row["freq"] = (row.get("freq") or 0) + 1
        freq_list = [(row.get("freq") or 0) for row in parsed]
        return {
            "ui": {"esn_freq": freq_list},
            "result": (positive_output, negative_output),
        }


NODE_CLASS_MAPPINGS = {"EasyStringNegEditor": EasyStringNegEditor}
NODE_DISPLAY_NAME_MAPPINGS = {"EasyStringNegEditor": "Easy String Neg Editor"}