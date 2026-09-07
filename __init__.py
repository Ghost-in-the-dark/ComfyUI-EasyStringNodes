from .easy_string import (
    NODE_CLASS_MAPPINGS as easy_string_mappings,
    NODE_DISPLAY_NAME_MAPPINGS as easy_string_display,
)
from .easy_stringV2 import (
    NODE_CLASS_MAPPINGS as easy_stringV2_mappings,
    NODE_DISPLAY_NAME_MAPPINGS as easy_stringV2_display,
)
from .Concatenate_prompts import (
    NODE_CLASS_MAPPINGS as concatenate_mappings,
    NODE_DISPLAY_NAME_MAPPINGS as concatenate_display,
)

NODE_CLASS_MAPPINGS = {
    **easy_string_mappings,
    **easy_stringV2_mappings,
    **concatenate_mappings,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **easy_string_display,
    **easy_stringV2_display,
    **concatenate_display,
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
