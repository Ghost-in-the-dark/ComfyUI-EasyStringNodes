"""Behavioral tests for the Easy String Nodes.

Run from the repository root:

    python3 tests/test_nodes.py

No third-party packages are required; node modules are imported directly.
These tests pin the fixed edge-case behavior: original line numbers,
html <br> handling, ranges/duplicates, preset triggers, element weighting.
"""

import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from easy_string import EasyString
from easy_stringV2 import EasyStringSelector, EasyStringSelectorNeg, EasyStringV2
from Concatenate_prompts import ConcatenatePromptsNode
from utils import (
    format_weight,
    html_to_text,
    join_elements,
    parse_content_lines,
    parse_spec,
    select_content,
    split_top_level,
    weight_element,
)


class _Raises:
    def __init__(self, exc_type):
        self.exc_type = exc_type

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            raise AssertionError(f"expected {self.exc_type.__name__} to be raised")
        if not issubclass(exc_type, self.exc_type):
            raise AssertionError(f"expected {self.exc_type.__name__}, got {exc_type.__name__}")
        return True


def raises(exc_type):
    return _Raises(exc_type)


# ---------------------------------------------------------------- utils

def test_parse_spec():
    assert parse_spec("1") == [1]
    assert parse_spec("1,3") == [1, 3]
    assert parse_spec("1, 3-5") == [1, 3, 4, 5]
    assert parse_spec("1 3 7") == [1, 3, 7]
    assert parse_spec("1,1") == [1, 1]
    assert parse_spec("") == []
    assert parse_spec(None) == []


def test_parse_spec_invalid():
    with raises(ValueError):
        parse_spec("abc")
    with raises(ValueError):
        parse_spec("1;2")


def test_parse_content_lines_numbered_and_plain():
    items = parse_content_lines("10: cat\n20: dog\nplain line")
    assert items == [
        {"num": 10, "content": "cat"},
        {"num": 20, "content": "dog"},
        {"num": None, "content": "plain line"},
    ]


def test_select_by_original_number():
    # EasyString bug: selection was done against re-numbered lines.
    items = parse_content_lines("10: cat\n20: dog")
    assert select_content(10, items) == "cat"
    assert select_content(2, items) == "dog"  # positional fallback


def test_html_to_text_breaks_lines():
    assert html_to_text("<p>cat</p><br><p>dog</p>") == "cat\ndog"
    assert html_to_text("a<br>b") == "a\nb"
    assert html_to_text("<ul><li>one</li><li>two</li></ul>") == "one\ntwo"
    assert html_to_text("plain") == "plain"


def test_weight_element_replaces_number():
    assert weight_element("(cat:1.2)", "1.5") == "(cat:1.5)"
    assert weight_element("(cat)", "1.5") == "(cat:1.5)"
    assert weight_element("[cat:1.2]", "2") == "[cat:2]"
    assert weight_element("cat", "1.5") == "(cat:1.5)"


def test_format_weight_short():
    assert format_weight(1.0) == "1"
    assert format_weight(1.2) == "1.2"
    assert format_weight(2.5) == "2.5"


def test_split_top_level_respects_brackets():
    assert split_top_level("(a:1), (b, c:2), d") == ["(a:1)", "(b, c:2)", "d"]
    assert split_top_level("") == []
    assert split_top_level("   ") == []


def test_join_elements():
    assert join_elements([]) == ""
    assert join_elements(["a", "b"]) == "a, b"


# ---------------------------------------------------------------- nodes

def test_easy_string_original_numbers():
    node = EasyString()
    out, = node.process("10: cat\n20: dog\n30: bird", "10,30")
    assert out == "cat bird"


def test_easy_string_duplicate_selection():
    node = EasyString()
    out, = node.process("1: a\n2: b", "1,1")
    assert out == "a a"


def test_easy_string_html_and_break():
    node = EasyString()
    out, = node.process("<p>a</p>\n<p>b</p>", "1,2", add_break=True)
    assert out == "a b BREAK"


def test_easy_string_no_match_raises():
    node = EasyString()
    with raises(ValueError):
        node.process("1: a\n2: b", "99")


def test_v2_weights_and_order():
    node = EasyStringV2()
    out, = node.process("1: cat, dog\n2: bird, fish", "2,1", weight=1.2)
    assert out == "(bird:1.2), (fish:1.2), (cat:1.2), (dog:1.2)"


def test_v2_apply_weight_off():
    node = EasyStringV2()
    out, = node.process("1: cat, dog", "1", weight=2.0, apply_weight=False)
    assert out == "cat, dog"


def test_v2_add_break():
    node = EasyStringV2()
    out, = node.process("1: cat", "1", add_break=True)
    assert out == "(cat:1) BREAK"


def test_selector_preset_and_trigger():
    node = EasyStringSelector()
    out, = node.process(
        input_text="1: a\n2: b\n3: c\n4: d",
        line_numbers="1",
        preset_input="1: 1\n2: 1,3",
        use_preset=True,
        preset_line=2,
        preset_trigger=True,
        weight=1.0,
        apply_weight=False,
        add_break=False,
    )
    assert out == "a, c"


def test_selector_trigger_blocked():
    node = EasyStringSelector()
    with raises(ValueError):
        node.process(
            input_text="1: a", line_numbers="1",
            preset_input="1: 1", use_preset=False, preset_line=1,
            preset_trigger=False, weight=1.0, apply_weight=False,
        )


def test_selector_neg_positive_negative():
    node = EasyStringSelectorNeg()
    pos, neg = node.process(
        input_text="1: cat --- dog\n2: bird",
        line_numbers="1,2",
        preset_input="1: 1", use_preset=False, preset_line=1,
        preset_trigger=True, weight=1.0, apply_weight=False, add_break=True,
    )
    assert pos == "cat, bird BREAK"
    assert neg == "dog"


def test_concatenate_sorts_and_skips_blank():
    node = ConcatenatePromptsNode()
    out, = node.concatenate_prompts(
        prompt_1="a", prompt_2=None, prompt_10="b", prompt_3="  "
    )
    assert out == "a b"


# ---------------------------------------------------------------- runner

if __name__ == "__main__":
    total = passed = 0
    failures = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            total += 1
            try:
                fn()
                passed += 1
            except Exception as exc:  # noqa: BLE001
                failures.append((name, exc))
                traceback.print_exc()
    print(f"\n{passed}/{total} tests passed")
    if failures:
        for name, exc in failures:
            print(f"  FAIL {name}: {exc}")
        sys.exit(1)
