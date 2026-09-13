"""Token frequency and co-occurrence statistics for EasyStringTokenGraph.

This module is the single source of truth for how a prompt is cut into
tokens. The front-end mirrors it in web/tg_tokens.js so the floating panel
can preview the text the user is typing; `tests/test_token_parity.py` runs
both implementations over the same corpus and fails when they disagree, so
the mirror cannot drift silently.

What a token is
---------------
A prompt is split into SECTIONS (on `BREAK` and on newlines), each section
into ELEMENTS (a comma that is not inside brackets, see split_top_level),
and each element into one or more TOKENS:

    "best quality"                  -> best quality
    "(masterpiece:1.3)"             -> masterpiece          (weight dropped)
    "(day,light theme:1.1)"         -> day, light theme     (both, weight dropped)
    "digital painting \\(artwork\\)"  -> digital painting (artwork)   (escaped = literal)
    ",,  ,"                         -> nothing

Counting
--------
Each token key keeps the number of OCCURRENCES (`n`) and the number of RUNS
it appeared in (`runs`), which are different questions: a token repeated
five times in one prompt has n=5, r=1 and is not "popular" the way a token
seen once in five prompts is. Co-occurrence is counted over a sliding window
inside a section, so two tokens that sit next to each other score higher
than two that merely share a 25-token prompt:

    weight = window - distance + 1     (distance 1..window)

Exclusions
----------
Quality boilerplate ("best quality", "masterpiece", "highres", ...) is noise
in a frequency ranking: it is in every prompt and therefore says nothing.
`DEFAULT_EXCLUDE` hides it. A pattern may use `*` / `?` wildcards and is
matched against the folded key, so "year *" hides every year.
"""

import fnmatch
import json
import os
import re
import time

__all__ = [
    "DEFAULT_EXCLUDE", "DEFAULT_EXCLUDE_TEXT", "MAX_TOKENS", "MAX_PAIRS",
    "empty_stats", "normalize_stats", "split_sections", "split_top_level",
    "split_element_tokens", "unescape", "fold_token", "tokenize_text",
    "parse_exclude", "is_excluded", "merge_run", "prune_stats", "top_tokens",
    "pair_index", "build_payload", "PAIR_SEP", "set_exclude", "remove_token",
    "stats_filename", "stats_path", "load_stats", "save_stats",
    "list_stats_files", "pair_parts", "edges_for", "tokenize_display_list",
    "build_report", "stats_dir", "register_routes", "STATS_ROUTE",
]

# A prompt is normally small, but a runaway node should not be able to grow
# the statistics file without bound: the least frequent entries are dropped
# once these limits are reached.
MAX_TOKENS = 2000
MAX_PAIRS = 20000

# Pair keys are stored as "a\u0001b" (sorted) - a separator that cannot occur
# in a folded token, unlike a space or a comma.
PAIR_SEP = "\u0001"

# Quality / boilerplate tokens. These are in essentially every prompt, so a
# frequency ranking that includes them measures the boilerplate rather than
# the user's vocabulary. The list is a starting point and is editable in the
# panel; entries with * or ? are wildcards.
DEFAULT_EXCLUDE = [
    "best quality", "high quality", "highest quality", "quality", "highquality",
    "masterpiece", "best", "top quality", "professional",
    "highres", "hi res", "hires", "absurdres", "high resolution", "resolution",
    "ultra high res", "extremely high res", "high definition", "hd", "uhd",
    "8k", "4k", "2k", "1080p", "2160p",
    "sharp focus", "sharp", "focus",
    "detailed", "highly detailed", "ultra detailed", "super detailed",
    "extremely detailed", "more detail", "max detail", "high detail",
    "intricate details", "intricate detail",
    "hdr", "hdr photo", "photo", "photograph",
    "ultra realistic", "photorealistic", "photo realistic", "realistic",
    "newest", "latest", "award winning", "trending on artstation",
]
DEFAULT_EXCLUDE_TEXT = "\n".join(DEFAULT_EXCLUDE)

# Characters that a backslash may escape inside a prompt. `\(` is a literal
# bracket, not a grouping bracket, which is why splitting is escape-aware.
_ESCAPABLE = "()[]{},:"
_UNESCAPE_RE = re.compile(r"\\([()\[\]{},:])")
_WS_RE = re.compile(r"\s+")
# a trailing element weight: "tag:1.2", "tag : 1.2"
_WEIGHT_RE = re.compile(r"^(.*?):\s*([0-9]*\.?[0-9]+)\s*$", re.S)
_BRACKETS = {"(": ")", "[": "]", "{": "}"}
_BREAK_RE = re.compile(r"\bBREAK\b", re.I)
_HAS_ALNUM_RE = re.compile(r"[^\W_]", re.U)


# ---------------------------------------------------------------------------
# stats container
# ---------------------------------------------------------------------------

def empty_stats():
    """A fresh, empty statistics document.

    `exclude` and `window` live in the document rather than only in the node
    inputs: the panel has to render the same ranking the node would produce
    when it is opened BEFORE the next run, and the only place both sides can
    read it from then is the statistics file.
    """
    return {"version": 1, "runs": 0, "tokens": {}, "pairs": {}, "updated": 0.0,
            "exclude": [], "window": 3}


def normalize_stats(stats):
    """Coerce anything loaded from disk/JSON into a usable stats document.

    A truncated or hand-edited file must not be able to crash a render, so
    every field is checked and repaired here rather than trusted.
    """
    out = empty_stats()
    if not isinstance(stats, dict):
        return out
    try:
        out["runs"] = max(0, int(stats.get("runs") or 0))
    except (TypeError, ValueError):
        out["runs"] = 0
    try:
        out["updated"] = float(stats.get("updated") or 0.0)
    except (TypeError, ValueError):
        out["updated"] = 0.0
    tokens = stats.get("tokens")
    if isinstance(tokens, dict):
        for key, rec in tokens.items():
            if not isinstance(key, str) or not key:
                continue
            if not isinstance(rec, dict):
                continue
            try:
                n = int(rec.get("n") or 0)
                runs = int(rec.get("runs") or 0)
            except (TypeError, ValueError):
                continue
            if n <= 0:
                continue
            display = rec.get("display")
            if not isinstance(display, str) or not display.strip():
                display = key
            try:
                last = int(rec.get("last") or 0)
            except (TypeError, ValueError):
                last = 0
            inner = rec.get("in")  # reserved for later nesting; kept as a dict
            out["tokens"][key] = {
                "n": n, "runs": max(0, runs), "display": display, "last": max(0, last),
                "in": dict(inner) if isinstance(inner, dict) else {},
            }
    pairs = stats.get("pairs")
    if isinstance(pairs, dict):
        for key, weight in pairs.items():
            if not isinstance(key, str) or PAIR_SEP not in key:
                continue
            try:
                w = int(weight)
            except (TypeError, ValueError):
                continue
            if w > 0:
                out["pairs"][key] = w
    out["exclude"] = parse_exclude(stats.get("exclude"))
    try:
        out["window"] = max(1, min(20, int(stats.get("window") or 3)))
    except (TypeError, ValueError):
        out["window"] = 3
    return out


def set_exclude(stats, exclude):
    """Replace the exclusion list stored in a statistics document."""
    stats = normalize_stats(stats)
    stats["exclude"] = parse_exclude(exclude)
    return stats


def remove_token(stats, key):
    """Delete one token and every pair it takes part in; returns True if gone.

    Mutates `stats` IN PLACE and returns the same object: a caller that saves
    the document afterwards must see the removal, and normalize_stats() would
    otherwise hand back a fresh copy whose deletion is thrown away.

    Used by the panel's "hide this token" action: hiding a token from the
    ranking is a view filter, but a token the user never wants to count again
    has to leave the document, or it keeps showing up on every reload.
    """
    tokens = stats.get("tokens") if isinstance(stats, dict) else None
    pairs = stats.get("pairs") if isinstance(stats, dict) else None
    if not isinstance(tokens, dict) or not isinstance(pairs, dict):
        return False
    target = fold_token(key)
    if not target or target not in tokens:
        return False
    tokens.pop(target, None)
    for pair in [k for k in pairs if target in pair_parts(k)]:
        pairs.pop(pair, None)
    return True


# ---------------------------------------------------------------------------
# splitting
# ---------------------------------------------------------------------------

def unescape(text):
    """Turn `\\(` into a literal `(` (the prompt-writing escape).

    Called last, once the structure has been decided: an escaped separator has
    done its job by then and becomes an ordinary character.
    """
    return _UNESCAPE_RE.sub(r"\1", str(text if text is not None else ""))


def split_top_level(text, sep=","):
    """Split on `sep` outside brackets, honouring backslash escapes.

    This is the escape-aware cousin of utils.split_top_level: there a `\\(`
    still counts as a bracket, which only happens to work while escapes come
    in balanced pairs. `\\(` here is a literal character and never opens a
    group.
    """
    text = str(text if text is not None else "")
    parts, buf, depth = [], [], 0
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n and text[i + 1] in _ESCAPABLE:
            buf.append(ch)
            buf.append(text[i + 1])
            i += 2
            continue
        if ch in "([{":
            depth += 1
            buf.append(ch)
        elif ch in ")]}":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif ch == sep and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return parts


def split_sections(text):
    """Cut a prompt into BREAK/newline separated sections (raw strings)."""
    text = str(text if text is not None else "").replace("\r\n", "\n").replace("\r", "\n")
    out = []
    for chunk in _BREAK_RE.split(text):
        for line in chunk.split("\n"):
            if line.strip():
                out.append(line)
    return out


def _single_wrapper(text):
    """Inner text of one surrounding bracket pair, or None.

    Returns None when `text` is not exactly one wrapped group: `(a) (b)`
    starts with `(` and ends with `)` but is two elements, not one.
    """
    t = text.strip()
    if len(t) < 2 or t[0] not in _BRACKETS or t[-1] != _BRACKETS[t[0]]:
        return None
    depth = 0
    body = t[1:-1]
    i, n = 0, len(body)
    while i < n:
        ch = body[i]
        if ch == "\\" and i + 1 < n and body[i + 1] in _ESCAPABLE:
            i += 2
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth < 0:
                return None
            if depth == 0 and i != n - 1:
                return None  # the group closed before the end
        i += 1
    return body if depth == 0 else None


def split_element_tokens(element):
    """One comma-separated element -> its display tokens ([] when empty)."""
    s = unescape(element).strip()
    if not s:
        return []
    body = s
    inner = _single_wrapper(body)
    if inner is not None:
        body = inner.strip()
    # a trailing ":1.2" weight is not part of the token name
    m = _WEIGHT_RE.match(body)
    if m and m.group(1).strip():
        body = m.group(1).strip()
        inner = _single_wrapper(body)
        if inner is not None:
            body = inner.strip()
    out = []
    for piece in split_top_level(body):
        token = _WS_RE.sub(" ", unescape(piece)).strip().strip(",").strip()
        # another wrapper layer may survive one level of unwrapping
        inner = _single_wrapper(token)
        if inner is not None and inner.strip():
            token = _WS_RE.sub(" ", inner).strip()
        m = _WEIGHT_RE.match(token)
        if m and m.group(1).strip():
            token = m.group(1).strip()
        if not token:
            continue
        if not _HAS_ALNUM_RE.search(token):
            continue  # stray brackets / punctuation
        out.append(token)
    return out


def fold_token(token):
    """The comparison key of a token: case, separators and spacing folded.

    `Best_Quality`, `best-quality` and `best   quality` are the same tag for
    counting purposes; the spelling a user actually typed is kept separately
    as the display form.
    """
    key = unescape(token).lower()
    key = key.replace("_", " ").replace("-", " ")
    key = _WS_RE.sub(" ", key).strip()
    return key.strip(" ,")


def tokenize_text(text):
    """Tokenize a prompt for counting: [[{d: display, k: key}, ...], ...].

    The outer list is the section list (one inner list per BREAK/newline
    group), which is what co-occurrence is computed within.
    """
    sections = []
    for raw in split_sections(text):
        tokens = []
        for element in split_top_level(raw):
            for token in split_element_tokens(element):
                key = fold_token(token)
                if key:
                    tokens.append({"d": token, "k": key})
        if tokens:
            sections.append(tokens)
    return sections


def tokenize_display_list(text):
    """Flat display tokens of a prompt (handy for tests and the report)."""
    return [t["d"] for section in tokenize_text(text) for t in section]


# ---------------------------------------------------------------------------
# exclusions
# ---------------------------------------------------------------------------

def parse_exclude(value):
    """A user-editable exclusion list -> folded patterns.

    Accepts a list/tuple, or one string with newlines and/or commas. Blank
    entries and `#` comments are ignored.
    """
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        raw = [str(v) for v in value]
    else:
        raw = str(value).replace(",", "\n").split("\n")
    out = []
    for item in raw:
        item = item.strip()
        if not item or item.startswith("#"):
            continue
        key = fold_token(item)
        if key and key not in out:
            out.append(key)
    return out


def is_excluded(key, patterns):
    """True when a folded token key matches any exclusion pattern."""
    if not key or not patterns:
        return False
    for pat in patterns:
        if pat == key:
            return True
        if ("*" in pat or "?" in pat) and fnmatch.fnmatchcase(key, pat):
            return True
    return False


# ---------------------------------------------------------------------------
# counting
# ---------------------------------------------------------------------------

def _better_display(old, new):
    """Pick the spelling to show: prefer one that carries capitalisation.

    "HDR photo" and "hdr photo" are one token; showing the version the user
    capitalised is friendlier than the first one seen in a lower-case prompt.
    """
    if not old:
        return new
    if not new:
        return old
    if old.islower() and not new.islower():
        return new
    return old


def pair_index(a, b):
    """Canonical key of an unordered token pair."""
    return a + PAIR_SEP + b if a <= b else b + PAIR_SEP + a


def pair_parts(key):
    """Split a pair key back into its two token keys (or (None, None))."""
    if not isinstance(key, str) or PAIR_SEP not in key:
        return None, None
    a, b = key.split(PAIR_SEP, 1)
    return (a, b) if a and b else (None, None)


def parse_pair_key(key):
    """Alias of pair_parts, exposed for the front-end payload builder."""
    return pair_parts(key)


def merge_run(stats, text, window=3, run_index=None, timestamp=None):
    """Fold one run of `text` into `stats`; returns the updated stats.

    `run_index` lets a caller replay a fixed history in tests; by default the
    document's own counter is incremented, giving every run a stable ordinal
    so the panel can say when a token was last seen.
    """
    stats = normalize_stats(stats)
    try:
        window = max(1, int(window))
    except (TypeError, ValueError):
        window = 3
    if run_index is None:
        stats["runs"] = int(stats.get("runs") or 0) + 1
        run_index = stats["runs"]
    else:
        stats["runs"] = max(int(stats.get("runs") or 0), int(run_index))
        run_index = int(run_index)

    sections = tokenize_text(text)
    seen_this_run = {}
    for section in sections:
        keys = [t["k"] for t in section]
        for tok in section:
            rec = stats["tokens"].get(tok["k"])
            if rec is None:
                rec = {"n": 0, "runs": 0, "display": tok["d"], "last": 0, "in": {}}
                stats["tokens"][tok["k"]] = rec
            rec["n"] = int(rec.get("n") or 0) + 1
            rec["display"] = _better_display(rec.get("display"), tok["d"])
            seen_this_run[tok["k"]] = True
        # co-occurrence inside a sliding window: closer pairs weigh more.
        # Distance runs 1..window inclusive, so window=1 means "immediate
        # neighbours only" exactly as the input tooltip promises.
        for i in range(len(keys)):
            for j in range(i + 1, min(i + window + 1, len(keys))):
                a, b = keys[i], keys[j]
                if a == b:
                    continue
                key = pair_index(a, b)
                stats["pairs"][key] = int(stats["pairs"].get(key) or 0) + (window - (j - i) + 1)
    for key in seen_this_run:
        rec = stats["tokens"].get(key)
        if rec is not None:
            rec["runs"] = int(rec.get("runs") or 0) + 1
            rec["last"] = run_index
    stats["updated"] = float(timestamp if timestamp is not None else time.time())
    prune_stats(stats)
    return stats


def _drop_least(dct, limit, weight):
    """Trim a {key: value} dict to `limit` entries, dropping the smallest."""
    if len(dct) <= limit:
        return
    ordered = sorted(dct.items(), key=lambda kv: (weight(kv[1]), kv[0]))
    for key, _ in ordered[:len(dct) - limit]:
        dct.pop(key, None)


def prune_stats(stats):
    """Keep the statistics document bounded; returns the same object."""
    tokens = stats.get("tokens") or {}
    _drop_least(tokens, MAX_TOKENS, lambda rec: (rec or {}).get("n") or 0)
    pairs = stats.get("pairs") or {}
    _drop_least(pairs, MAX_PAIRS, lambda w: w)
    # a pair whose token was just pruned can never be rendered again
    if len(tokens) < MAX_TOKENS:
        for key in [k for k in pairs if not all(p in tokens for p in pair_parts(k))]:
            pairs.pop(key, None)
    return stats


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------

def top_tokens(stats, exclude=None, limit=40, min_n=1, include_excluded=False):
    """Ranked [{t, k, n, runs, last}] of the most used tokens.

    `n` is total occurrences and `runs` the number of runs the token appeared
    in; the ranking sorts by occurrences, then runs, then alphabetically so
    the order is stable between calls (an unstable order would make the panel
    jump while the user is hovering it).
    """
    stats = normalize_stats(stats)
    patterns = parse_exclude(exclude) if exclude is not None else []
    rows = []
    for key, rec in stats["tokens"].items():
        n = int(rec.get("n") or 0)
        if n < max(1, int(min_n or 1)):
            continue
        if not include_excluded and is_excluded(key, patterns):
            continue
        rows.append({
            "t": rec.get("display") or key,
            "k": key,
            "n": n,
            "runs": int(rec.get("runs") or 0),
            "last": int(rec.get("last") or 0),
        })
    rows.sort(key=lambda r: (-r["n"], -r["runs"], r["k"]))
    if limit:
        rows = rows[:max(0, int(limit))]
    return rows


def edges_for(stats, tokens, limit=0):
    """Co-occurrence edges among `tokens` (the output of top_tokens).

    Returns [[i, j, weight], ...] indexing into `tokens`, strongest first, so
    the panel can draw the relations of the selected token without walking
    the whole pair table.
    """
    if not tokens:
        return []
    index = {row["k"]: i for i, row in enumerate(tokens)}
    out = []
    for key, weight in (stats.get("pairs") or {}).items():
        a, b = pair_parts(key)
        if a is None or a not in index or b not in index:
            continue
        out.append([index[a], index[b], int(weight)])
    out.sort(key=lambda e: (-e[2], e[0], e[1]))
    if limit:
        out = out[:max(0, int(limit))]
    return out


def build_payload(stats, exclude=None, limit=40, min_n=1, max_edges=800, window=3):
    """The compact document the front-end renders after a run.

    Everything crossing to the browser is bounded: at most `limit` tokens and
    `max_edges` edges, plus a small summary of what the exclusions hid.
    """
    stats = normalize_stats(stats)
    patterns = parse_exclude(exclude) if exclude is not None else []
    tokens = top_tokens(stats, exclude=patterns, limit=limit, min_n=min_n)
    hidden = []
    hidden_n = 0
    for key, rec in stats["tokens"].items():
        if not is_excluded(key, patterns):
            continue
        n = int(rec.get("n") or 0)
        hidden_n += n
        hidden.append({"t": rec.get("display") or key, "n": n})
    hidden.sort(key=lambda r: (-r["n"], r["t"]))
    return {
        "runs": int(stats.get("runs") or 0),
        "distinct": len(stats.get("tokens") or {}),
        "window": max(1, int(window or 3)),
        "tokens": tokens,
        "edges": edges_for(stats, tokens, limit=max_edges),
        "excluded": hidden[:60],
        "excluded_n": hidden_n,
        "excluded_count": len(hidden),
        "total_n": sum(int(r.get("n") or 0) for r in (stats.get("tokens") or {}).values()),
    }


def build_report(stats, exclude=None, limit=40, min_n=1):
    """The JSON string the node returns on its second output."""
    import json
    payload = build_payload(stats, exclude=exclude, limit=limit, min_n=min_n)
    return json.dumps({
        "runs": payload["runs"],
        "distinct": payload["distinct"],
        "tokens": [{"token": r["t"], "count": r["n"], "runs": r["runs"]} for r in payload["tokens"]],
        "excluded": payload["excluded_count"],
        "edges": len(payload["edges"]),
    }, ensure_ascii=False)


# ---------------------------------------------------------------------------
# statistics file
# ---------------------------------------------------------------------------

def stats_filename(name):
    """A safe `<base>.stats.json` file name, or None.

    Mirrors esn_storage.sanitize_name's rules (flat name, letters/digits at
    the start) but appends its own suffix and lives in its own subfolder, so a
    statistics file can never be listed as, or loaded as, a dataset.
    """
    if not name:
        return None
    text = str(name).strip().replace("\\", "/").split("/")[-1]
    for suffix in (".stats.json", ".tokens.json", ".json"):
        if text.lower().endswith(suffix):
            text = text[:-len(suffix)]
            break
    base = text.strip()
    if not base or not re.match(r"^[A-Za-z0-9][A-Za-z0-9 _.-]*$", base):
        return None
    return base + ".stats.json"


def _data_dir():
    """The dataset folder, shared with the dataset files when available."""
    try:
        try:
            from .esn_storage import data_dir_path
        except ImportError:
            from esn_storage import data_dir_path
        return data_dir_path()
    except Exception:
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def stats_dir():
    """Folder holding statistics files (`<data>/token_stats`)."""
    folder = os.path.join(_data_dir(), "token_stats")
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError:
        pass
    return folder


def stats_path(name):
    """Full path of a statistics file, or None when the name is unsafe."""
    safe = stats_filename(name)
    if not safe:
        return None
    return os.path.join(stats_dir(), safe)


def load_stats(name):
    """Read a statistics file; an empty document when absent or unreadable."""
    path = stats_path(name)
    if not path or not os.path.isfile(path):
        return empty_stats()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return normalize_stats(json.load(fh))
    except (OSError, ValueError):
        return empty_stats()


def save_stats(name, stats):
    """Write a statistics file atomically; returns (ok, message)."""
    safe = stats_filename(name)
    path = stats_path(name)
    if not safe or not path:
        return False, "invalid statistics file name"
    folder = os.path.dirname(path)
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError as exc:
        return False, "cannot create data folder: %s" % exc
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(normalize_stats(stats), fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except OSError as exc:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return False, "cannot write statistics: %s" % exc
    return True, safe


def list_stats_files():
    """Sorted names of the statistics files in the statistics folder."""
    try:
        names = [f for f in os.listdir(stats_dir()) if f.lower().endswith(".stats.json")]
    except OSError:
        return []
    return sorted(names)


STATS_ROUTE = "/easystring/token_stats"


def register_routes():
    """Register the statistics routes with ComfyUI (no-op when unavailable).

    The panel reads the accumulated history through these routes so it can
    draw a graph BEFORE the next run, and the "forget this token" action has
    to reach the file rather than only the widget.
    """
    try:
        import aiohttp.web  # noqa: F401
        from server import PromptServer
    except Exception:
        return False

    routes = PromptServer.instance.routes

    @routes.get(STATS_ROUTE)
    async def _stats_get(request):
        name = request.query.get("file", "tokens")
        if not stats_filename(name):
            return aiohttp.web.json_response({"error": "invalid statistics name"}, status=400)
        return aiohttp.web.json_response({
            "ok": True, "file": stats_filename(name), "stats": load_stats(name),
        })

    @routes.post(STATS_ROUTE)
    async def _stats_post(request):
        """Replace (or create) a statistics document."""
        try:
            body = await request.json()
        except Exception:
            return aiohttp.web.json_response({"error": "expected JSON body"}, status=400)
        name = body.get("file", "tokens")
        stats = body.get("stats")
        if not isinstance(stats, dict):
            return aiohttp.web.json_response({"error": "stats must be a JSON object"}, status=400)
        ok, msg = save_stats(name, stats)
        if not ok:
            return aiohttp.web.json_response({"error": msg}, status=400)
        return aiohttp.web.json_response({"ok": True, "file": msg})

    @routes.post(STATS_ROUTE + "/remove")
    async def _stats_remove(request):
        """Forget one token: drop it and every relation it takes part in."""
        try:
            body = await request.json()
        except Exception:
            return aiohttp.web.json_response({"error": "expected JSON body"}, status=400)
        name = body.get("file", "tokens")
        key = body.get("key", "")
        if not stats_filename(name) or not str(key).strip():
            return aiohttp.web.json_response({"error": "file and key are required"}, status=400)
        stats = load_stats(name)
        removed = remove_token(stats, key)
        if removed:
            save_stats(name, stats)
        return aiohttp.web.json_response({"ok": True, "removed": removed})

    return True
