try:
    from .utils import (  # package context (ComfyUI loads the folder as a package)
        html_to_text, parse_content_lines, parse_spec, select_content
    )
except ImportError:  # plain script / test context
    from utils import html_to_text, parse_content_lines, parse_spec, select_content


DEFAULT_INPUT = "1: a cat\n2: a dog\n3: a bird"
DEFAULT_SELECT = "1"


class EasyString:
    """Pick lines from a numbered multiline text and join them."""

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
    DESCRIPTION = "Pick lines from a numbered multiline text and join them."

    def process(self, input_text, line_numbers, add_break=False):
        items = parse_content_lines(input_text)
        numbers = parse_spec(line_numbers)

        selected = []
        for n in numbers:
            content = select_content(n, items)
            if content is not None:
                selected.append(content)

        if not selected:
            raise ValueError(
                f"EasyString: no line matches the selection '{line_numbers}'"
            )

        output = html_to_text(" ".join(selected))
        if add_break and output:
            output = output + " BREAK"
        return (output,)


NODE_CLASS_MAPPINGS = {"EasyString": EasyString}
NODE_DISPLAY_NAME_MAPPINGS = {"EasyString": "Easy String"}