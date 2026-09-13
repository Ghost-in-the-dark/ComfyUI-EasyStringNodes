"""EasyStringNegEditor dataset storage.

Datasets (rows + presets) live in a folder on disk instead of inside the
workflow JSON. Default folder is <this node>/data; ComfyUI server routes let
the front-end list / load / save datasets:

  GET  /easystring/datasets            -> {"files": ["name.json", ...]}
  GET  /easystring/data?file=name      -> {"rows": [...], "presets": "..."}
  POST /easystring/data                (json {file, rows, presets})
  POST /easystring/data/image          (json {file, data}) -> {"ref": ...}
  GET  /easystring/data/image?file=&ref=  -> the image bytes

Images live beside the dataset, never inside it
-----------------------------------------------
A row image used to be a base64 data URL stored in the row object itself, so
every checkbox click rewrote the whole dataset - a 200-image dataset meant
~10 MB of JSON written per click and an equal amount pushed back to the
browser. Since v1.5.8 each image is a file in `<name>.img/` next to
`<name>.json`, and the row keeps only the file name (the "ref"):

    data/myset.json          the dataset - rows carry tiny image refs
    data/myset.img/u1a2b3.jpg

`load_dataset()` turns every ref into a ready-to-use URL
(`/easystring/data/image?file=...&ref=...&v=<mtime>`), so the front-end never
has to know how images are stored; `save_dataset()` does the reverse and pulls
any legacy inline `data:image/...` payload out of the rows into files, which
migrates an old dataset the first time it is saved.

Everything is optional: when ComfyUI PromptServer is unavailable (plain
script / test context) only the plain helper functions work.
"""

import base64
import binascii
import json
import os
import re
import time

__all__ = [
    "DATA_DIR", "data_dir_path", "list_datasets", "load_dataset",
    "save_dataset", "register_routes", "sanitize_name", "dataset_path",
    "image_dir", "image_path", "list_image_refs", "store_image_bytes",
    "store_image_data_url", "read_image", "prune_images",
    "safe_image_ref", "is_inline_image", "ref_from_value", "IMAGE_ROUTE",
]

# Folder next to this module: ComfyUI-EasyStringNodes/data
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# Uploaded images are already downscaled in the browser (384 px max edge,
# JPEG q0.82 ≈ 30-60 KB); the cap only guards against a hand-made request that
# would otherwise fill the disk.
MAX_IMAGE_BYTES = 8 * 1024 * 1024

IMAGE_ROUTE = "/easystring/data/image"

_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]*[.]json$")
# an image ref is a FLAT file name inside <dataset>.img/ - never a path
_IMG_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
_MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
_DATA_URL = re.compile(r"^data:([A-Za-z0-9.+/-]+);base64,(.*)$", re.S)
# uploaded-but-not-yet-saved images are protected from the prune window
PRUNE_MIN_AGE = 600.0


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


# ---------------------------------------------------------------------------
# image files
# ---------------------------------------------------------------------------

def image_dir(name, create=False):
    """Return the image folder of a dataset (`<name>.img`), or None."""
    safe = sanitize_name(name)
    if not safe:
        return None
    folder = os.path.join(data_dir_path(), safe[:-len(".json")] + ".img")
    if create:
        try:
            os.makedirs(folder, exist_ok=True)
        except OSError:
            return None
    return folder


def safe_image_ref(ref):
    """Return a sanitised image ref (a flat file name), or None.

    A ref is the file name inside the dataset's image folder. Anything that
    could escape that folder (a path, `..`, a drive letter, a wrong extension)
    is rejected rather than repaired.
    """
    if not ref or not isinstance(ref, str):
        return None
    ref = ref.strip().replace("\\", "/")
    if "/" in ref or ".." in ref or ":" in ref:
        return None
    if not _IMG_NAME.match(ref):
        return None
    if os.path.splitext(ref)[1].lower() not in _MIME_BY_EXT:
        return None
    return ref


def is_inline_image(value):
    """True when a row's img field is a legacy inline base64 data URL."""
    return isinstance(value, str) and value.startswith("data:image/")


def ref_from_value(value):
    """The stored file name behind a row's img field, or None.

    Accepts the two shapes a front-end can hand back: a bare ref, and the URL
    this module produced in load_dataset() (`.../image?file=..&ref=..&v=..`).
    Recognising its own URL matters because a client that loaded a dataset and
    saves it again would otherwise look like a row with no usable image - and
    the prune would then delete a picture that is still in use.
    """
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.startswith(IMAGE_ROUTE):
        query = text.split("?", 1)[1] if "?" in text else ""
        for part in query.split("&"):
            if part.startswith("ref="):
                from urllib.parse import unquote
                return safe_image_ref(unquote(part[4:]))
        return None
    return safe_image_ref(text)


def image_path(name, ref):
    """Full path of an image ref, or None when the ref is unsafe/missing."""
    safe = safe_image_ref(ref)
    folder = image_dir(name)
    if not safe or not folder:
        return None
    return os.path.join(folder, safe)


def list_image_refs(name):
    """Sorted refs of the image files currently stored for a dataset."""
    folder = image_dir(name)
    if not folder:
        return []
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    return sorted(n for n in names if safe_image_ref(n))


def _new_ref(name, ext):
    """A collision-free file name for a new image of this dataset."""
    folder = image_dir(name, create=True)
    if not folder:
        return None
    seed = "%s%08x" % (str(time.time()), id(object()) & 0xFFFFFFFF)
    token = "u%08x" % (abs(hash(seed)) & 0xFFFFFFFF)
    ref = token + ext
    tries = 0
    while os.path.exists(os.path.join(folder, ref)) and tries < 50:
        tries += 1
        ref = "%s_%d%s" % (token, tries, ext)
    return ref


def store_image_bytes(name, raw, ext):
    """Write image bytes into the dataset image folder; return ref or None."""
    if not raw or ext not in _MIME_BY_EXT:
        return None
    ref = _new_ref(name, ext)
    path = image_path(name, ref) if ref else None
    if not path:
        return None
    try:
        with open(path, "wb") as fh:
            fh.write(raw)
    except OSError:
        return None
    return ref


def store_image_data_url(name, data_url):
    """Store a browser `data:image/...;base64,...` upload; return ref or None."""
    m = _DATA_URL.match(str(data_url or "").strip())
    if not m:
        return None
    ext = _EXT_BY_MIME.get(m.group(1).lower())
    if not ext:
        return None
    payload = m.group(2).strip()
    if len(payload) > (MAX_IMAGE_BYTES * 4) // 3 + 16:
        return None
    try:
        raw = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError):
        return None
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        return None
    return store_image_bytes(name, raw, ext)


def read_image(name, ref):
    """Return (bytes, content_type) for a stored image, or (None, None)."""
    path = image_path(name, ref)
    if not path or not os.path.isfile(path):
        return None, None
    try:
        with open(path, "rb") as fh:
            raw = fh.read(MAX_IMAGE_BYTES + 1)
    except OSError:
        return None, None
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        return None, None
    mime = _MIME_BY_EXT.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
    return raw, mime


def prune_images(name, rows, min_age=PRUNE_MIN_AGE):
    """Delete stored images no row references any more.

    `min_age` protects images uploaded into an open editor that has not been
    saved yet: a ref is only deleted once the file is older than the window,
    so an unsaved dialog can never lose the picture the user just dropped in.
    Returns the number of deleted files.
    """
    folder = image_dir(name)
    if not folder:
        return 0
    keep = set()
    for row in rows or []:
        if isinstance(row, dict):
            ref = ref_from_value(row.get("img"))
            if ref:
                keep.add(ref)
    removed = 0
    now = time.time()
    try:
        names = os.listdir(folder)
    except OSError:
        return 0
    for fname in names:
        if fname in keep or not safe_image_ref(fname):
            continue
        path = os.path.join(folder, fname)
        try:
            if now - os.path.getmtime(path) < min_age:
                continue
            os.remove(path)
            removed += 1
        except OSError:
            continue
    return removed


def dataset_url(name, ref, version=None):
    """Public URL of a stored image (empty string when the ref is unusable)."""
    safe = safe_image_ref(ref)
    if not safe:
        return ""
    url = "%s?file=%s&ref=%s" % (IMAGE_ROUTE, _quote(name), _quote(safe))
    if version:
        url += "&v=%s" % _quote(version)
    return url


def _quote(text):
    try:
        from urllib.parse import quote
        return quote(str(text), safe="")
    except Exception:  # pragma: no cover - urllib is always available
        return str(text)


def _to_row_image(row, name):
    """Give one stored row a browser-usable `img` value."""
    if not isinstance(row, dict):
        return row
    img = row.get("img")
    if is_inline_image(img) or not img:
        return row  # legacy inline data URL / no image: use as-is
    ref = safe_image_ref(img)
    if not ref:
        row["img"] = ""
        return row
    path = image_path(name, ref)
    if not path or not os.path.isfile(path):
        row["img"] = ""  # the file is gone: a broken URL is worse than none
        return row
    try:
        version = int(os.path.getmtime(path))
    except OSError:
        version = None
    row["img"] = dataset_url(name, ref, version)
    return row


def list_datasets():
    """Return sorted [name, ...] of existing datasets."""
    folder = data_dir_path()
    try:
        names = [f for f in os.listdir(folder) if f.lower().endswith(".json")]
    except OSError:
        names = []
    return sorted(names)


def load_dataset(name):
    """Return {rows: [...], presets: str} from disk, or None on any error.

    Image refs are resolved to full URLs here, so every caller (canvas,
    dialog, hover preview) receives a value it can put straight into an
    <img> / CSS background.
    """
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
    return {"rows": [_to_row_image(r, name) for r in rows], "presets": presets}


def _extract_row_images(name, rows):
    """Move inline data URLs out of the rows and into image files.

    Returns a NEW list of row dicts. A row keeps its ref when it already has
    one (that is the normal case: the ref was assigned at upload time).
    """
    out = []
    for row in rows or []:
        if not isinstance(row, dict):
            out.append(row)
            continue
        item = dict(row)
        img = item.get("img")
        if is_inline_image(img):
            ref = store_image_data_url(name, img)
            item["img"] = ref or ""
        elif img:
            # the resolved URL this module hands out is accepted as well, so a
            # load -> save round trip keeps the picture instead of dropping it
            item["img"] = ref_from_value(img) or ""
        else:
            item["img"] = ""
        out.append(item)
    return out


def save_dataset(name, rows, presets):
    """Write rows + presets to disk; returns (ok, message).

    Any image still stored inline in a row (a legacy dataset, or a node that
    was never in dataset mode) is written out as a file first, so the JSON
    stays small and a checkbox click no longer rewrites megabytes.
    """
    safe = sanitize_name(name)
    if not safe:
        return False, "invalid dataset file name (use letters/digits and end with .json)"
    clean_rows = _extract_row_images(safe, rows)
    payload = {"rows": clean_rows, "presets": presets or ""}
    path = os.path.join(data_dir_path(), safe)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)  # atomic: a killed write cannot truncate the dataset
    except OSError as exc:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return False, "cannot write dataset: %s" % exc
    prune_images(safe, clean_rows)
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

    @routes.post(IMAGE_ROUTE)
    async def _image_post(request):
        """Store one uploaded image and return its ref (row.img value)."""
        try:
            body = await request.json()
        except Exception:
            return aiohttp.web.json_response({"error": "expected JSON body"}, status=400)
        name = body.get("file", "")
        if not sanitize_name(name):
            return aiohttp.web.json_response({"error": "invalid dataset file name"}, status=400)
        ref = store_image_data_url(name, body.get("data", ""))
        if not ref:
            return aiohttp.web.json_response(
                {"error": "expected a base64 image data URL (png/jpeg/webp/gif)"}, status=400)
        return aiohttp.web.json_response({
            "ok": True, "file": name, "ref": ref,
            "url": dataset_url(name, ref, int(time.time())),
        })

    @routes.get(IMAGE_ROUTE)
    async def _image_get(request):
        name = request.query.get("file", "")
        ref = request.query.get("ref", "")
        raw, mime = read_image(name, ref)
        if raw is None:
            return aiohttp.web.json_response({"error": "image not found"}, status=404)
        return aiohttp.web.Response(
            body=raw, content_type=mime,
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    return True
