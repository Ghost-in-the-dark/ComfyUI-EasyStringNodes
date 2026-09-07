"""A node that concatenates multiple prompt strings into one.

Unlike a fixed 15-input layout, this node exposes the inputs as *optional*,
so only the ones you actually connect contribute to the output.
"""

MAX_INPUTS = 20


def _prompt_inputs():
    required = {}
    optional = {}
    for i in range(1, MAX_INPUTS + 1):
        optional[f"prompt_{i}"] = (
            "STRING",
            {"default": "", "multiline": True, "placeholder": f"prompt {i}"},
        )
    return required, optional


class ConcatenatePromptsNode:
    """Join the connected prompt inputs into one space-separated string."""

    @classmethod
    def INPUT_TYPES(cls):
        required, optional = _prompt_inputs()
        return {"required": required, "optional": optional}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("concatenated_prompt",)
    FUNCTION = "concatenate_prompts"
    CATEGORY = "Text Processing"
    DESCRIPTION = "Join the connected prompt inputs into one string."

    def concatenate_prompts(self, **kwargs):
        items = []
        for key in sorted(kwargs, key=_input_key):
            value = kwargs[key]
            if value is None:
                continue
            text = str(value).strip()
            if text:
                items.append(text)
        return (" ".join(items),)


def _input_key(name):
    """Sort 'prompt_2' before 'prompt_10'."""
    try:
        return (0, int(name.rsplit("_", 1)[1]))
    except (ValueError, IndexError):
        return (1, name)


NODE_CLASS_MAPPINGS = {
    "ConcatenatePromptsNode": ConcatenatePromptsNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ConcatenatePromptsNode": "Concatenate Prompts",
}
