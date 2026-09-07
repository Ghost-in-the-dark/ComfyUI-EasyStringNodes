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
from .easy_string_neg_editor import (
    NODE_CLASS_MAPPINGS as neg_editor_mappings,
    NODE_DISPLAY_NAME_MAPPINGS as neg_editor_display,
)

NODE_CLASS_MAPPINGS = {
    **easy_string_mappings,
    **easy_stringV2_mappings,
    **concatenate_mappings,
    **neg_editor_mappings,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **easy_string_display,
    **easy_stringV2_display,
    **concatenate_display,
    **neg_editor_display,
}

# Register /easystring/* dataset routes when running inside ComfyUI.
try:
    from .esn_storage import register_routes as _esn_register
    _esn_register()
except Exception:
    pass

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
