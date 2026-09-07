"""Advanced string nodes: per-element weighting, presets and
positive/negative splitting.

All heavy lifting is delegated to utils.py so the three node classes only
declare their inputs and orchestrate the shared helpers.
"""

try:
    from .utils import (
        format_weight, join_elements, parse_content_lines, process_elements,
        resolve_lines, split_top_level,
    )
except ImportError:  # plain script / test context
    from utils import (
        format_weight, join_elements, parse_content_lines, process_elements,
        resolve_lines, split_top_level,
    )
DEFAULT_INPUT = "1: cat, dog\n2: bird, fish"
DEFAULT_SELECT = "1"
DEFAULT_PRESETS = "1: 1\n2: 1,2"


def _selected_lines(input_text, line_numbers):
    """Selected raw lines (with the 'N: ' prefix already stripped)."""
    return resolve_lines(input_text, line_numbers)


def _resolve_preset(preset_input, preset_line, node_label):
    """Return the content of the requested preset line (by number, then by
    1-based position). Raises a clear error when nothing matches."""
    presets = parse_content_lines(preset_input)
    for p in presets:
        if p["num"] == preset_line:
            return p["content"]
    if 1 <= preset_line <= len(presets):
        return presets[preset_line - 1]["content"]
    raise ValueError(
        f"{node_label}: preset line {preset_line} not found "
        f"({len(presets)} preset(s) available)"
    )


class EasyStringV2:
    """Pick lines, split them into elements and rewrite each as (text:weight)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_text": ("STRING", {
                    "multiline": True,
                    "default": DEFAULT_INPUT,
                }),
                "line_numbers": ("STRING", {
                    "default": DEFAULT_SELECT,
                }),
                "weight": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider",
                }),
                "apply_weight": ("BOOLEAN", {
                    "default": True,
                    "label_on": "apply (tag:weight)",
                    "label_off": "plain text",
                }),
                "add_break": ("BOOLEAN", {
                    "default": False,
                    "label_on": "add BREAK",
                    "label_off": "no BREAK",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("output_text",)
    FUNCTION = "process"
    CATEGORY = "Text Processing"
    DESCRIPTION = "Pick lines, split into elements and apply (text:weight)."

    def process(self, input_text, line_numbers, weight=1.0,
                apply_weight=True, add_break=False):
        formatted_weight = format_weight(weight) if apply_weight else None
        all_elements = []
        for line in _selected_lines(input_text, line_numbers):
            all_elements.extend(
                process_elements(split_top_level(line), apply_weight,
                                 formatted_weight)
            )

        output = join_elements(all_elements)
        if add_break and output:
            output = output + " BREAK"
        return (output,)


class EasyStringSelector:
    """Like EasyStringV2, with preset-based line selection."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_text": ("STRING", {
                    "multiline": True,
                    "default": DEFAULT_INPUT,
                }),
                "line_numbers": ("STRING", {
                    "default": DEFAULT_SELECT,
                }),
                "preset_input": ("STRING", {
                    "multiline": True,
                    "default": DEFAULT_PRESETS,
                }),
                "use_preset": ("BOOLEAN", {
                    "default": False,
                    "label_on": "use preset",
                    "label_off": "use line_numbers",
                }),
                "preset_line": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 100,
                    "step": 1,
                }),
                "preset_trigger": ("BOOLEAN", {
                    "default": True,
                    "forceInput": True,
                    "label_on": "trigger",
                    "label_off": "blocked",
                }),
                "weight": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider",
                }),
                "apply_weight": ("BOOLEAN", {
                    "default": True,
                    "label_on": "apply (tag:weight)",
                    "label_off": "plain text",
                }),
                "add_break": ("BOOLEAN", {
                    "default": False,
                    "label_on": "add BREAK",
                    "label_off": "no BREAK",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("output_text",)
    FUNCTION = "process"
    CATEGORY = "Text Processing"
    DESCRIPTION = "EasyStringV2 with preset-driven line selection."

    def _effective_spec(self, input_text, line_numbers, preset_input,
                        use_preset, preset_line):
        """(spec, source): preset content, or line_numbers when presets are
        disabled."""
        if use_preset:
            return _resolve_preset(preset_input, preset_line,
                                   "EasyStringSelector"), "preset"
        return line_numbers, "line_numbers"

    def process(self, input_text, line_numbers, preset_input, use_preset,
                preset_line, preset_trigger=True, weight=1.0,
                apply_weight=True, add_break=False):
        if not preset_trigger:
            raise ValueError(
                "EasyStringSelector: preset_trigger is off. Connect a true "
                "input (or set the widget) to let this node run."
            )
        spec, _ = self._effective_spec(
            input_text, line_numbers, preset_input, use_preset, preset_line
        )

        formatted_weight = format_weight(weight) if apply_weight else None
        all_elements = []
        for line in _selected_lines(input_text, spec):
            all_elements.extend(
                process_elements(split_top_level(line), apply_weight,
                                 formatted_weight)
            )

        output = join_elements(all_elements)
        if add_break and output:
            output = output + " BREAK"
        return (output,)


class EasyStringSelectorNeg:
    """Split selected lines on '---' into positive and negative prompts."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_text": ("STRING", {
                    "multiline": True,
                    "default": "1: cat --- dog\n2: bird --- fish",
                }),
                "line_numbers": ("STRING", {
                    "default": DEFAULT_SELECT,
                }),
                "preset_input": ("STRING", {
                    "multiline": True,
                    "default": DEFAULT_PRESETS,
                }),
                "use_preset": ("BOOLEAN", {
                    "default": False,
                    "label_on": "use preset",
                    "label_off": "use line_numbers",
                }),
                "preset_line": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 100,
                    "step": 1,
                }),
                "preset_trigger": ("BOOLEAN", {
                    "default": True,
                    "forceInput": True,
                    "label_on": "trigger",
                    "label_off": "blocked",
                }),
                "weight": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider",
                }),
                "apply_weight": ("BOOLEAN", {
                    "default": True,
                    "label_on": "apply (tag:weight)",
                    "label_off": "plain text",
                }),
                "add_break": ("BOOLEAN", {
                    "default": False,
                    "label_on": "add BREAK",
                    "label_off": "no BREAK",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive_prompt", "negative_prompt")
    FUNCTION = "process"
    CATEGORY = "Text Processing"
    DESCRIPTION = "Split selected lines on '---' into positive/negative prompts."

    def process(self, input_text, line_numbers, preset_input, use_preset,
                preset_line, preset_trigger=True, weight=1.0,
                apply_weight=True, add_break=False):
        if not preset_trigger:
            raise ValueError(
                "EasyStringSelectorNeg: preset_trigger is off. Connect a true "
                "input (or set the widget) to let this node run."
            )

        spec = line_numbers
        if use_preset:
            spec = _resolve_preset(preset_input, preset_line,
                                   "EasyStringSelectorNeg")

        formatted_weight = format_weight(weight) if apply_weight else None
        positives, negatives = [], []

        for line in _selected_lines(input_text, spec):
            if "---" in line:
                pos_line, neg_line = line.split("---", 1)
            else:
                pos_line, neg_line = line, ""
            positives.extend(
                process_elements(split_top_level(pos_line), apply_weight,
                                 formatted_weight)
            )
            if neg_line.strip():
                negatives.extend(
                    process_elements(split_top_level(neg_line), apply_weight,
                                     formatted_weight)
                )

        positive_output = join_elements(positives)
        negative_output = join_elements(negatives)
        if add_break and positive_output:
            positive_output = positive_output + " BREAK"
        return (positive_output, negative_output)


NODE_CLASS_MAPPINGS = {
    "EasyStringV2": EasyStringV2,
    "EasyStringSelector": EasyStringSelector,
    "EasyStringSelectorNeg": EasyStringSelectorNeg,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EasyStringV2": "Easy String V2",
    "EasyStringSelector": "Easy String Selector",
    "EasyStringSelectorNeg": "Easy String Selector Neg",
}