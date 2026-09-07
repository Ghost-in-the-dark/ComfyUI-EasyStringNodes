"""EasyStringNegEditor: SelectorNeg logic plus a visual row editor.

Each "row" is {pos, neg, img}:
  * pos   - positive prompt text
  * neg   - negative prompt text
  * img   - optional image, stored in the workflow JSON as a downscaled
            data URL so the workflow stays self-contained. The image is a
            UI aid (preview on hover); this Python module never loads it.

The row list lives in the hidden "rows" JSON widget and is edited through
the custom front-end dialog (see web/easy_string_neg_editor.js). Selection
reuses the same syntax as the other nodes: "1", "1,3", "2-4".
"""

import json

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
        {"pos": "a cute cat", "neg": "dog, blurry", "img": ""},
        {"pos": "a bird in flight", "neg": "watermark", "img": ""},
    ]


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
                                   "(JSON: [{pos, neg, img}, ...])",
                    },
                ),
                "line_numbers": (
                    "STRING",
                    {
                        "default": "1",
                        "tooltip": "Rows to use when 'select_all' is off, "
                                   "e.g. 1,3 or 2-4",
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
                "preset_trigger": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "forceInput": True,
                        "label_on": "trigger",
                        "label_off": "blocked",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive_prompt", "negative_prompt")
    FUNCTION = "process"
    CATEGORY = "Text Processing"
    DESCRIPTION = ("Positive/negative builder with a visual row editor: "
                   "each row may carry an image shown on hover.")

    # ------------------------------------------------------------------
    # parsing
    # ------------------------------------------------------------------
    def _parse_rows(self, rows_value):
        """Turn the widget JSON into a clean [{pos, neg, img}, ...] list."""
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
                "{pos, neg, img} objects."
            )

        rows = []
        for i, item in enumerate(data, 1):
            if not isinstance(item, dict):
                raise ValueError(
                    f"EasyStringNegEditor: row #{i} is not an object "
                    f"(got {type(item).__name__})."
                )
            img = item.get("img") or ""
            rows.append({
                "pos": html_to_text(str(item.get("pos") or "")),
                "neg": html_to_text(str(item.get("neg") or "")),
                "img": img if isinstance(img, str) else "",
            })
        return rows

    def _select_rows(self, rows, select_all, line_numbers):
        if not rows:
            raise ValueError(
                "EasyStringNegEditor: no rows defined - click 'Add / Edit "
                "rows' on the node to create rows."
            )
        if select_all:
            return rows
        numbers = parse_spec(line_numbers)
        if not numbers:
            raise ValueError(
                "EasyStringNegEditor: 'select_all' is off but 'line_numbers' "
                "is empty."
            )
        chosen = []
        for n in numbers:
            if 1 <= n <= len(rows):
                chosen.append(rows[n - 1])
        if not chosen:
            raise ValueError(
                f"EasyStringNegEditor: no row matches selection "
                f"'{line_numbers}' ({len(rows)} row(s) available)."
            )
        return chosen

    # ------------------------------------------------------------------
    # main
    # ------------------------------------------------------------------
    def process(self, rows, line_numbers="1", select_all=True, weight=1.0,
                apply_weight=True, add_break=False, preset_trigger=True):
        if not preset_trigger:
            raise ValueError(
                "EasyStringNegEditor: preset_trigger is off. Connect a true "
                "input (or set the widget) to let this node run."
            )

        parsed = self._parse_rows(rows)
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