"""EasyStringNegEditor dataset storage.

Datasets (rows + presets) can live in a folder on disk instead of inside the
workflow JSON / browser. Default folder is <this node>/data; ComfyUI server
routes let the front-end list / load / save datasets:
  GET  /easystring/datasets        -> {"files": ["name.json", ...]}
  GET  /easystring/data?file=name  -> {"rows": [...], "presets": "..."}
  POST /easystring/data            (json {file, rows, presets})

Everything is optional: when ComfyUI PromptServer is unavailable (plain
script / test context) only the plain helper functions work.
"""

import json
import os
import re

__all__ = [
    "DATA_DIR", "data_dir_path", "list_datasets", "load_dataset",
    "save_dataset", "register_routes",
]

# Folder next to this module: ComfyUI-EasyStringNodes/data
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]*[.]json$")


def data_dir_path():
    """Create (if needed) and return the dataset folder."""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except OSError:
        pass
    return DATA_DIR


def sanitize_name(name):
    """Return a safe basename for a .json dataset, or None."""
    if not name:
        return None
    name = str(name).strip().replace("\\", "/").split("/")[-1]
    if not _SAFE.match(name):
        return None
    return name


def dataset_path(name):
    """Return the full path for a dataset name, or None when unsafe."""
    safe = sanitize_name(name)
    if not safe:
        return None
    return os.path.join(data_dir_path(), safe)


def list_datasets():
    """Return sorted [name, ...] of existing datasets."""
    folder = data_dir_path()
    try:
        names = [f for f in os.listdir(folder) if f.lower().endswith(".json")]
    except OSError:
        names = []
    return sorted(names)


def load_dataset(name):
    """Return {rows: [...], presets: str} from disk, or None on any error."""
    path = dataset_path(name)
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    rows = data.get("rows") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return None
    presets = data.get("presets", "")
    if not isinstance(presets, str):
        presets = ""
    return {"rows": rows, "presets": presets}


def save_dataset(name, rows, presets):
    """Write rows + presets to disk; returns (ok, message)."""
    safe = sanitize_name(name)
    if not safe:
        return False, "invalid dataset file name (use letters/digits and end with .json)"
    try:
        with open(os.path.join(data_dir_path(), safe), "w", encoding="utf-8") as fh:
            json.dump({"rows": rows, "presets": presets or ""}, fh,
                      ensure_ascii=False, indent=1)
    except OSError as exc:
        return False, "cannot write dataset: %s" % exc
    return True, safe


def register_routes():
    """Register ComfyUI server routes (no-op when unavailable)."""
    try:
        import aiohttp.web  # noqa: F401
        from server import PromptServer
    except Exception:
        return False

    routes = PromptServer.instance.routes

    @routes.get("/easystring/datasets")
    async def _datasets(request):
        return aiohttp.web.json_response({"files": list_datasets()})

    @routes.get("/easystring/data")
    async def _data_get(request):
        name = request.query.get("file", "")
        data = load_dataset(name)
        if data is None:
            return aiohttp.web.json_response(
                {"error": "dataset not found or invalid: %s" % name}, status=404)
        return aiohttp.web.json_response(data)

    @routes.post("/easystring/data")
    async def _data_post(request):
        try:
            body = await request.json()
        except Exception:
            return aiohttp.web.json_response({"error": "expected JSON body"}, status=400)
        name = body.get("file", "")
        rows = body.get("rows")
        presets = body.get("presets", "")
        if not isinstance(rows, list):
            return aiohttp.web.json_response({"error": "rows must be a JSON list"}, status=400)
        ok, msg = save_dataset(name, rows, presets)
        if not ok:
            return aiohttp.web.json_response({"error": msg}, status=400)
        return aiohttp.web.json_response({"ok": True, "file": msg})

    return True