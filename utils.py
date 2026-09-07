"""Shared helpers for the Easy String Nodes pack.

All parsing, HTML-to-text conversion, line-number resolution and prompt
weighting logic lives here so the individual node classes stay thin and the
behavior stays consistent across them.
"""

import re
from html.parser import HTMLParser

__all__ = [
    "html_to_text",
    "parse_spec",
    "parse_content_lines",
    "select_content",
    "resolve_lines",
    "split_top_level",
    "format_weight",
    "weight_element",
    "process_elements",
    "join_elements",
]

# ---------------------------------------------------------------------------
# HTML -> plain text (block-level tags become line breaks)
# ---------------------------------------------------------------------------

_BLOCK_TAGS = {
    "p", "div", "li", "ul", "ol", "tr", "table", "thead", "tbody",
    "blockquote", "pre", "section", "article",
    "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr",
}
_SKIP_TAGS = {"script", "style"}


class _HtmlToText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._parts = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip = True
            return
        if tag in _BLOCK_TAGS:
            self._newline()

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip = False
            return
        if tag in _BLOCK_TAGS:
            self._newline()

    def handle_data(self, data):
        if not self._skip:
            self._parts.append(data)

    def _newline(self):
        if self._parts and not self._parts[-1].endswith("\n"):
            self._parts.append("\n")


def html_to_text(text):
    """Convert HTML to plain text; block tags (incl. <br>) become newlines."""
    if not text:
        return ""
    parser = _HtmlToText()
    try:
        parser.feed(text)
        parser.close()
    except Exception:
        # Never fail because of malformed markup: fall back to raw text.
        return text
    out = "".join(parser._parts).replace("\xa0", " ")
    out = re.sub(r"[ \t]+\n", "\n", out)   # trailing spaces before newline
    out = re.sub(r"\n{2,}", "\n", out)       # collapse blank lines
    return out.strip()


# ---------------------------------------------------------------------------
# "N: text" line lists
# ---------------------------------------------------------------------------

# A numbered line: "10: cat", "10: cat: with colons", or bare "10:".
# The number must be followed by a space/tab (or end of line) so content such
# as "2:30 pm" is never mistaken for a line numbered 2.
_LINE_RE = re.compile(r"^(\d+):(?:[ \t](.*))?$")
_INT_RE = re.compile(r"^\d+$")
_RANGE_RE = re.compile(r"^(\d+)\s*-\s*(\d+)$")


def parse_content_lines(text):
    """Return an ordered list of {num, content} dicts for a multiline string.

    * Lines matching "N: text" keep their explicit number N.
    * Any other line is addressed positionally (num=None).
    * Duplicate explicit numbers keep the first occurrence.
    * HTML markup is removed from every line first.
    """
    items = []
    seen = set()
    for raw in (text or "").split("\n"):
        line = html_to_text(raw)
        if not line:
            continue
        m = _LINE_RE.match(line)
        if m:
            num = int(m.group(1))
            if num in seen:
                continue
            seen.add(num)
            content = (m.group(2) or "").strip()
            items.append({"num": num, "content": content})
        else:
            items.append({"num": None, "content": line})
    return items


def parse_spec(spec):
    """Parse a line-selection string into an ordered list of ints.

    Accepts "1", "1,3", "1, 3-5", "1 3 7". Ranges are inclusive. Duplicates
    are preserved so "1,1" repeats the line on purpose.
    """
    if spec is None:
        return []
    text = str(spec).strip()
    if not text:
        return []
    result = []
    for token in re.split(r"[,\s]+", text):
        if not token:
            continue
        m = _RANGE_RE.match(token)
        if m:
            start, end = int(m.group(1)), int(m.group(2))
            if start > end:
                start, end = end, start
            result.extend(range(start, end + 1))
            continue
        if _INT_RE.match(token):
            result.append(int(token))
            continue
        raise ValueError(
            "Easy String Nodes: cannot parse line selection "
            f"'{spec}' (bad token '{token}')"
        )
    return result


def select_content(number, items):
    """Resolve one requested number against parsed lines.

    An explicit "N:" match wins; otherwise the number is treated as a 1-based
    position in the line list (so plain, unnumbered text stays selectable).
    Returns None when nothing matches.
    """
    for it in items:
        if it["num"] is not None and it["num"] == number:
            return it["content"]
    if 1 <= number <= len(items):
        return items[number - 1]["content"]
    return None


def resolve_lines(input_text, spec):
    """Return the selected line contents in request order (duplicates kept).

    Raises ValueError when the selection matches nothing at all, so a typo
    does not silently produce an empty prompt.
    """
    items = parse_content_lines(input_text)
    numbers = parse_spec(spec)
    chosen = []
    for n in numbers:
        content = select_content(n, items)
        if content is not None:
            chosen.append(content)
    if numbers and not chosen:
        raise ValueError(
            f"Easy String Nodes: no line matches selection '{spec}' "
            f"({len(items)} line(s) available)"
        )
    return chosen


# ---------------------------------------------------------------------------
# Prompt element helpers
# ---------------------------------------------------------------------------

_WEIGHTED_RE = re.compile(r"^(.+):([0-9]*\.?[0-9]+)$", re.S)


def split_top_level(line):
    """Split a prompt line on commas that are not inside (), [] or {}."""
    if not line:
        return []
    parts, buf, depth = [], [], 0
    for ch in line:
        if ch in "([{":
            depth += 1
            buf.append(ch)
        elif ch in ")]}":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif ch == "," and depth == 0:
            piece = "".join(buf).strip()
            if piece:
                parts.append(piece)
            buf = []
        else:
            buf.append(ch)
    piece = "".join(buf).strip()
    if piece:
        parts.append(piece)
    return parts


def format_weight(weight):
    """Normalize a weight to a short decimal string ("1", "1.2")."""
    try:
        value = float(weight)
    except (TypeError, ValueError):
        value = 1.0
    value = max(0.1, min(10.0, value))
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _rewrite_weighted(inner, open_b, close_b, formatted_weight):
    m = _WEIGHTED_RE.match(inner)
    if m:
        text_part = m.group(1).strip()
        if text_part:
            return f"{open_b}{text_part}:{formatted_weight}{close_b}"
        return f"{open_b}{inner}{close_b}"
    return f"{open_b}{inner}:{formatted_weight}{close_b}"


def weight_element(elem, formatted_weight):
    """Rewrap one element with the given weight.

    * "(text:1.2)"  -> "(text:WEIGHT)"   (weight replaced)
    * "(text)"      -> "(text:WEIGHT)"
    * "[text:1.2]"  -> "[text:WEIGHT]"   (bracket style preserved)
    * "{text}"      -> "{text:WEIGHT}"
    * anything else -> "(text:WEIGHT)"
    """
    elem = elem.strip()
    if not elem:
        return elem
    if elem.startswith("(") and elem.endswith(")"):
        return _rewrite_weighted(elem[1:-1], "(", ")", formatted_weight)
    if elem.startswith("[") and elem.endswith("]"):
        return _rewrite_weighted(elem[1:-1], "[", "]", formatted_weight)
    if elem.startswith("{") and elem.endswith("}"):
        return _rewrite_weighted(elem[1:-1], "{", "}", formatted_weight)
    return f"({elem}:{formatted_weight})"


def process_elements(elements, apply_weight, formatted_weight):
    """Map a list of raw elements to their output form."""
    if apply_weight:
        return [weight_element(e, formatted_weight) for e in elements]
    return list(elements)


def join_elements(elements):
    """Join weighted elements into one prompt string: "(a:1), (b:1)". """
    if not elements:
        return ""
    joined = " ".join(f"{e}," for e in elements)
    joined = re.sub(r"\s+", " ", joined).strip()
    return joined[:-1] if joined.endswith(",") else joined