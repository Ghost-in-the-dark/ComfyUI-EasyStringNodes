"""Behavioral tests for the Easy String Nodes.

Run from the repository root:

    python3 tests/test_nodes.py

No third-party packages are required; node modules are imported directly.
These tests pin the fixed edge-case behavior: original line numbers,
html <br> handling, ranges/duplicates, preset triggers, element weighting.
"""

import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from easy_string import EasyString
from easy_stringV2 import EasyStringSelector, EasyStringSelectorNeg, EasyStringV2
from Concatenate_prompts import ConcatenatePromptsNode
from easy_string_neg_editor import EasyStringNegEditor
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


# ------------------------------------------------- EasyStringNegEditor

ROWS_JSON = (
    '[{"pos": "a cute cat", "neg": "dog, blurry", "img": ""},'
    '{"pos": "a bird in flight", "neg": "watermark", "img": ""}]'
)


# EasyStringNegEditor.process now returns
#   {"ui": {"esn_freq": [...]}, "result": (positive_prompt, negative_prompt)}
# to feed the usage-frequency counters back to the front-end.  Existing tests
# call node.process(...) and expect a plain tuple, so shadow the method with a
# transparent unpacker.  New frequency tests call _ESN_ORIG_PROCESS directly.
_ESN_ORIG_PROCESS = EasyStringNegEditor.process


def _esn_process_result(node, *args, **kwargs):
    out = _ESN_ORIG_PROCESS(node, *args, **kwargs)
    if isinstance(out, dict):
        return out["result"]
    return out


EasyStringNegEditor.process = _esn_process_result


def test_neg_editor_all_rows_plain():
    node = EasyStringNegEditor()
    pos, neg = node.process(ROWS_JSON, apply_weight=False)
    assert pos == "a cute cat, a bird in flight"
    assert neg == "dog, blurry, watermark"


def test_neg_editor_single_row_selection():
    node = EasyStringNegEditor()
    pos, neg = node.process(
        ROWS_JSON, line_numbers="2", select_all=False, apply_weight=False
    )
    assert pos == "a bird in flight"
    assert neg == "watermark"


def test_neg_editor_break():
    node = EasyStringNegEditor()
    pos, neg = node.process(ROWS_JSON, apply_weight=False, add_break=True)
    assert pos == "a cute cat, a bird in flight BREAK"
    assert neg == "dog, blurry, watermark"


def test_neg_editor_weight_applied():
    node = EasyStringNegEditor()
    pos, neg = node.process(ROWS_JSON, weight=1.2, apply_weight=True)
    assert pos == "(a cute cat:1.2), (a bird in flight:1.2)"
    assert neg == "(dog:1.2), (blurry:1.2), (watermark:1.2)"


def test_neg_editor_html_cleaned():
    node = EasyStringNegEditor()
    html_rows = '[{"pos": "<p>cat</p><br><p>dog</p>", "neg": "x", "img": ""}]'
    pos, neg = node.process(html_rows, apply_weight=False)
    assert pos == "cat dog"
    assert neg == "x"


def test_neg_editor_trigger_blocked():
    node = EasyStringNegEditor()
    with raises(ValueError):
        node.process(ROWS_JSON, preset_trigger=False)


def test_neg_editor_trigger_unset_runs():
    # optional input: leaving preset_trigger unconnected must not break the node
    node = EasyStringNegEditor()
    pos, _ = node.process(ROWS_JSON, apply_weight=False)
    assert pos != ""


def test_neg_editor_trigger_none_runs():
    # some frontends deliver None for an unconnected optional input
    node = EasyStringNegEditor()
    pos, _ = node.process(ROWS_JSON, preset_trigger=None, apply_weight=False)
    assert pos != ""


def test_neg_editor_trigger_true_runs():
    node = EasyStringNegEditor()
    pos, _ = node.process(ROWS_JSON, preset_trigger=True, apply_weight=False)
    assert pos != ""


def test_neg_editor_trigger_false_strings_block():
    # an explicitly connected false (bool, number or text) still blocks
    for bad in (False, 0, 0.0, "false", "0", "off", "no", "False", "OFF"):
        node = EasyStringNegEditor()
        with raises(ValueError):
            node.process(ROWS_JSON, preset_trigger=bad, apply_weight=False)


def test_neg_editor_bad_json_raises():
    node = EasyStringNegEditor()
    with raises(ValueError):
        node.process("not json at all")


def test_neg_editor_non_list_raises():
    node = EasyStringNegEditor()
    with raises(ValueError):
        node.process('{"pos": "cat"}')


def test_neg_editor_no_rows_raises():
    node = EasyStringNegEditor()
    with raises(ValueError):
        node.process("[]")


def test_neg_editor_no_match_raises():
    node = EasyStringNegEditor()
    with raises(ValueError):
        node.process(ROWS_JSON, line_numbers="9", select_all=False)


def test_neg_editor_row_keeps_image_out_of_output():
    node = EasyStringNegEditor()
    with_img = (
        '[{"pos": "cat", "neg": "dog", "img": "data:image/png;base64,AAA"},'
        '{"pos": "bird", "neg": "fish", "img": "data:image/png;base64,BBB"}]'
    )
    pos, neg = node.process(with_img, apply_weight=False)
    assert pos == "cat, bird"
    assert neg == "dog, fish"
    assert "base64" not in pos and "base64" not in neg


def test_neg_editor_invalid_row_type_raises():
    node = EasyStringNegEditor()
    with raises(ValueError):
        node.process('[{"pos": "cat", "neg": "dog"}, "oops"]')


def test_neg_editor_empty_line_numbers_uses_ticked():
    # select_all off + empty line_numbers -> the checkbox-ticked rows are used
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'on': True, 'pos': 'a', 'neg': '', 'img': ''},
        {'on': False, 'pos': 'b', 'neg': '', 'img': ''},
    ])
    pos, _ = node.process(rows, line_numbers="", select_all=False,
                          apply_weight=False)
    assert pos == 'a'


def test_neg_editor_empty_line_numbers_all_default_ticked():
    # rows WITHOUT an "on" field (legacy data) count as ticked, so an empty
    # line_numbers field still selects them all
    node = EasyStringNegEditor()
    pos, _ = node.process(ROWS_JSON, line_numbers="", select_all=False,
                          apply_weight=False)
    assert pos == 'a cute cat, a bird in flight'


def test_neg_editor_empty_line_numbers_none_ticked_raises():
    # empty line_numbers with no ticked row is a clear error, not a crash
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'on': False, 'pos': 'a', 'neg': '', 'img': ''},
        {'on': False, 'pos': 'b', 'neg': '', 'img': ''},
    ])
    with raises(ValueError):
        node.process(rows, line_numbers="", select_all=False, apply_weight=False)


# ---------------- presets & numbering (EasyStringNegEditor)


def _num_rows(*nums):
    import json
    rows = []
    for i, n in enumerate(nums, 1):
        rows.append({'num': n, 'pos': 'row' + str(n), 'neg': 'n' + str(n), 'img': ''})
    return json.dumps(rows)


def test_neg_editor_preset_by_num_selects_rows():
    node = EasyStringNegEditor()
    # preset 7: rows with num 108, 193, 135
    rows = _num_rows(108, 193, 135, 57)
    presets = '7: 108 193 135'
    pos, neg = node.process(rows, presets=presets, use_preset=True,
                            preset_line=7, apply_weight=False)
    assert pos == 'row108, row193, row135'
    assert neg == 'n108, n193, n135'


def test_neg_editor_preset_fallback_to_position():
    node = EasyStringNegEditor()
    # rows without num: preset '1 3' -> positional rows 1 and 3
    rows = '[{"pos": "a", "neg": "", "img": ""},{"pos": "b", "neg": "", "img": ""},{"pos": "c", "neg": "", "img": ""}]'
    presets = '1: 1 3'
    pos, _ = node.process(rows, presets=presets, use_preset=True, preset_line=1,
                          apply_weight=False)
    assert pos == 'a, c'


def test_neg_editor_preset_mixed_num_and_position():
    # num=1 matches row with num 1; 3 has no num -> positional row 3
    node = EasyStringNegEditor()
    rows = '[{"num": 1, "pos": "one", "neg": "", "img": ""},{"pos": "two", "neg": "", "img": ""},{"pos": "three", "neg": "", "img": ""}]'
    presets = '5: 1 3'
    pos, _ = node.process(rows, presets=presets, use_preset=True, preset_line=5,
                          apply_weight=False)
    assert pos == 'one, three'


def test_neg_editor_preset_missing_raises():
    node = EasyStringNegEditor()
    with raises(ValueError):
        node.process(_num_rows(1, 2), presets='9: 1', use_preset=True,
                     preset_line=8, apply_weight=False)


def test_neg_editor_line_numbers_use_num():
    node = EasyStringNegEditor()
    rows = '[{"num": 108, "pos": "artist108", "neg": "", "img": ""},{"num": 193, "pos": "artist193", "neg": "", "img": ""}]'
    pos, _ = node.process(rows, line_numbers='193', select_all=False,
                          apply_weight=False)
    assert pos == 'artist193'


def test_neg_editor_parse_old_lines_helper():
    import json as _json
    # The JS import parser turns old numbered lines into rows; the python
    # side just sees rows carrying num with the text in neg. Pin that:
    rows = _json.loads('[{"num": 1, "pos": "", "neg": ";soranamae:0.7, ;james m hardiman", "img": ""},{"num": 2, "pos": "", "neg": ";fuchs", "img": ""}]')
    node = EasyStringNegEditor()
    pos, neg = node.process(_json.dumps(rows), apply_weight=False)
    assert neg == ';soranamae:0.7, ;james m hardiman, ;fuchs'


def test_neg_editor_preset_with_commas_and_ranges():
    node = EasyStringNegEditor()
    rows = _num_rows(1, 2, 3, 4, 5)
    presets = '3: 1,3 4-5'
    pos, _ = node.process(rows, presets=presets, use_preset=True, preset_line=3,
                          apply_weight=False)
    assert pos == 'row1, row3, row4, row5'


def test_neg_editor_preset_duplicates_kept():
    node = EasyStringNegEditor()
    rows = _num_rows(1, 2)
    presets = '2: 1 1 2'
    pos, _ = node.process(rows, presets=presets, use_preset=True, preset_line=2,
                          apply_weight=False)
    assert pos == 'row1, row1, row2'


def test_neg_editor_use_preset_overrides_select_all():
    node = EasyStringNegEditor()
    rows = _num_rows(1, 2, 3)
    presets = '1: 2'
    pos, _ = node.process(rows, presets=presets, use_preset=True, preset_line=1,
                          select_all=True, apply_weight=False)
    assert pos == 'row2'


def test_neg_editor_empty_preset_raises():
    node = EasyStringNegEditor()
    with raises(ValueError):
        node.process(_num_rows(1), presets='1: 2', use_preset=True,
                     preset_line=1, apply_weight=False)




# ---------------- categories & checkbox mode (EasyStringNegEditor)


def test_neg_editor_select_checked_uses_only_ticked():
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'num': 1, 'cat': 'a', 'on': True, 'pos': 'one', 'neg': '', 'img': ''},
        {'num': 2, 'cat': 'a', 'on': False, 'pos': 'two', 'neg': '', 'img': ''},
        {'num': 3, 'cat': 'b', 'on': True, 'pos': 'three', 'neg': '', 'img': ''},
    ])
    pos, _ = node.process(rows, select_checked=True, apply_weight=False)
    assert pos == 'one, three'


def test_neg_editor_select_checked_overrides_preset_and_all():
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'on': True, 'pos': 'a', 'neg': '', 'img': ''},
        {'on': False, 'pos': 'b', 'neg': '', 'img': ''},
    ])
    # overrides select_all
    pos, _ = node.process(rows, select_all=True, select_checked=True,
                          apply_weight=False)
    assert pos == 'a'
    # overrides preset
    pos, _ = node.process(rows, presets='1: 2', use_preset=True, preset_line=1,
                          select_checked=True, apply_weight=False)
    assert pos == 'a'


def test_neg_editor_select_checked_none_ticked_raises():
    node = EasyStringNegEditor()
    rows = json.dumps([{'on': False, 'pos': 'x', 'neg': '', 'img': ''}])
    with raises(ValueError):
        node.process(rows, select_checked=True, apply_weight=False)


def test_neg_editor_rows_without_on_default_to_ticked():
    # rows WITHOUT an "on" field (legacy data) still count as ticked
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'pos': 'a', 'neg': '', 'img': ''},
        {'pos': 'b', 'neg': '', 'img': ''},
    ])
    pos, _ = node.process(rows, select_checked=True, apply_weight=False)
    assert pos == 'a, b'


def test_neg_editor_rows_with_explicit_false_start_unticked():
    # rows the editor creates (explicit on=false) are NOT included unless ticked
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'on': False, 'pos': 'a', 'neg': '', 'img': ''},
        {'on': False, 'pos': 'b', 'neg': '', 'img': ''},
    ])
    with raises(ValueError):
        node.process(rows, select_checked=True, apply_weight=False)
    # ... but normal select_all still uses them all
    pos, _ = node.process(rows, select_all=True, apply_weight=False)
    assert pos == 'a, b'


def test_neg_editor_cat_parsed_and_not_emitted():
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'cat': 'artists', 'on': True, 'pos': 'a', 'neg': '', 'img': ''},
    ])
    parsed = node._parse_rows(rows)
    assert parsed[0]['cat'] == 'artists'
    assert parsed[0]['on'] is True
    pos, _ = node.process(rows, select_all=True, apply_weight=False)
    assert pos == 'a'


def test_neg_editor_on_string_false_coerced():
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'on': 'false', 'pos': 'a', 'neg': '', 'img': ''},
        {'on': '0', 'pos': 'b', 'neg': '', 'img': ''},
    ])
    parsed = node._parse_rows(rows)
    assert parsed[0]['on'] is False
    assert parsed[1]['on'] is False


import esn_storage as _esn_storage


def test_neg_editor_data_file_mode():
    import shutil as _shutil
    import tempfile as _tempfile
    node = EasyStringNegEditor()
    tmp = _tempfile.mkdtemp(prefix="esn_test_")
    old_dir = _esn_storage.DATA_DIR
    _esn_storage.DATA_DIR = tmp
    try:
        rows = [
            {"num": 1, "cat": "x", "on": True, "pos": "alpha", "neg": "", "img": ""},
            {"num": 2, "cat": "x", "on": False, "pos": "beta", "neg": "", "img": ""},
        ]
        ok, msg = _esn_storage.save_dataset("ds.json", rows, "1: 1")
        assert ok, msg
        pos, neg = node.process(
            rows="[]", presets="", select_all=True, data_file="ds.json",
            apply_weight=False)
        assert pos == "alpha, beta", pos
        pos, neg = node.process(
            rows="[]", presets="", select_all=True, select_checked=True,
            data_file="ds.json", apply_weight=False)
        assert pos == "alpha", pos
        try:
            node.process(rows="[]", presets="", select_all=True,
                         data_file="missing.json", apply_weight=False)
        except ValueError as exc:
            assert "not found" in str(exc), str(exc)
        else:
            raise AssertionError("expected ValueError for missing dataset")
    finally:
        _esn_storage.DATA_DIR = old_dir
        _shutil.rmtree(tmp, ignore_errors=True)



# ---------------- usage-frequency feedback (EasyStringNegEditor)


def test_neg_editor_parse_rows_default_freq_zero():
    node = EasyStringNegEditor()
    parsed = node._parse_rows(ROWS_JSON)
    assert parsed[0]["freq"] == 0
    assert parsed[1]["freq"] == 0


def test_neg_editor_freq_increments_all_when_select_all():
    node = EasyStringNegEditor()
    out = _ESN_ORIG_PROCESS(node, ROWS_JSON, apply_weight=False)
    assert isinstance(out, dict), "expected dict ui/result return"
    assert out["result"][0] == "a cute cat, a bird in flight"
    assert out["ui"]["esn_freq"] == [1, 1]
    # the front-end stores the counters back into the rows JSON; a second run
    # on that updated payload keeps counting from where it stopped
    rows2 = json.loads(ROWS_JSON)
    for row, fr in zip(rows2, out["ui"]["esn_freq"]):
        row["freq"] = fr
    out2 = _ESN_ORIG_PROCESS(node, json.dumps(rows2), apply_weight=False)
    assert out2["ui"]["esn_freq"] == [2, 2]


def test_neg_editor_freq_only_selected_rows():
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'pos': 'a', 'neg': '', 'img': ''},
        {'pos': 'b', 'neg': '', 'img': ''},
        {'pos': 'c', 'neg': '', 'img': ''},
    ])
    out = _ESN_ORIG_PROCESS(node, rows, line_numbers="2", select_all=False,
                            apply_weight=False)
    assert out["ui"]["esn_freq"] == [0, 1, 0]
    assert out["result"][0] == "b"


def test_neg_editor_freq_preset_selection():
    node = EasyStringNegEditor()
    rows = '[{"pos": "a", "neg": "", "img": ""},{"pos": "b", "neg": "", "img": ""},{"pos": "c", "neg": "", "img": ""}]'
    out = _ESN_ORIG_PROCESS(node, rows, presets="1: 1 3", use_preset=True,
                            preset_line=1, apply_weight=False)
    assert out["ui"]["esn_freq"] == [1, 0, 1]


def test_neg_editor_freq_respects_existing_count():
    # existing freq counters carry over and keep counting from there
    node = EasyStringNegEditor()
    rows = json.dumps([{'freq': 5, 'pos': 'a', 'neg': '', 'img': ''}])
    out = _ESN_ORIG_PROCESS(node, rows, apply_weight=False)
    assert out["ui"]["esn_freq"] == [6]


def test_neg_editor_freq_invalid_values_coerce_to_zero():
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'freq': -3, 'pos': 'a', 'neg': '', 'img': ''},
        {'freq': 'x', 'pos': 'b', 'neg': '', 'img': ''},
        {'freq': 2.9, 'pos': 'c', 'neg': '', 'img': ''},
    ])
    parsed = node._parse_rows(rows)
    # floats are rejected (no silent truncation), negatives clamp to 0
    assert [r["freq"] for r in parsed] == [0, 0, 0]


def test_neg_editor_freq_checkbox_mode():
    node = EasyStringNegEditor()
    rows = json.dumps([
        {'on': True, 'pos': 'a', 'neg': '', 'img': ''},
        {'on': False, 'pos': 'b', 'neg': '', 'img': ''},
    ])
    out = _ESN_ORIG_PROCESS(node, rows, select_checked=True, apply_weight=False)
    assert out["ui"]["esn_freq"] == [1, 0]


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