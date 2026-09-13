"""Behavioral tests for EasyStringTokenGraph.

Run from the repository root:

    python3 tests/test_token_graph.py

No third-party packages are required. The tests pin the behaviour that is easy
to break silently: the tokenizer's edge cases, the two counters (occurrences
vs runs), co-occurrence weighting, the exclusion list, that a run is counted
exactly once, and that a statistics file survives a round trip.
"""

import json
import os
import shutil
import sys
import tempfile
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import esn_tokens as T
from token_graph_node import EasyStringTokenGraph

REQUEST_PROMPT = (
    "rich details,intense,highly detailed,highres,hi res,sharp focus,best quality,"
    "detailed,masterpiece,absurdres,HDR photo, year 2023, year 2024,year 2022, "
    "newest,  snowskau, repzzmonster, honovy, sepulte, pixelsketcher BREAK  ,"
    "raccoon,    cinematic, dramatic lighting, shallow depth of field, vignette, "
    "simple shading, stippling, cel shading, soft shading, shaded, countershading  "
    "photorealistic,ultra realistic,realistic,detailed eyes, detailed background,   ,"
    "(day,light theme:1.1), digital painting \\(artwork\\), digital media \\(artwork\\), "
    "digital drawing \\(artwork\\), traditional media \\(artwork\\)      ,"
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


def _isolated_stats_dir():
    """Point the statistics storage at a temp folder; returns (old, tmp)."""
    tmp = tempfile.mkdtemp(prefix="tg-tests-")
    old = getattr(T, "_data_dir", None)
    T._data_dir = lambda: tmp
    return old, tmp


def _restore_stats_dir(old, tmp):
    if old is None:
        T.__dict__.pop("_data_dir", None)
    else:
        T._data_dir = old
    shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- tokenizer

def test_split_sections():
    assert T.split_sections("a, b") == ["a, b"]
    assert T.split_sections("a BREAK b") == ["a ", " b"]
    assert T.split_sections("a, b BREAK c, d") == ["a, b ", " c, d"]
    assert T.split_sections("line one\nline two") == ["line one", "line two"]
    assert T.split_sections("a,\n\nb") == ["a,", "b"]
    assert T.split_sections("") == []
    assert T.split_sections("   \n  ") == []
    # BREAK inside a tag name is still a section break (the prompt syntax has
    # no escaping for it, and no realistic tag contains a standalone BREAK)
    assert T.split_sections("a BREAK b BREAK c") == ["a ", " b ", " c"]


def test_escaped_brackets_are_literal():
    """`\\(` is a literal bracket: it must not open a group."""
    assert T.tokenize_display_list(r"digital painting \(artwork\)") == ["digital painting (artwork)"]
    # Because an escaped bracket is NOT a group, a comma inside it is still a
    # top-level separator (the same rule A1111 applies). This is deliberate:
    # the escape removes bracket meaning, it does not add separator protection.
    assert T.tokenize_display_list(r"a \(b, c\) d") == ["a (b", "c) d"]
    # and the unescaped version really is a group, so a comma inside it does
    # not split the element
    assert T.tokenize_display_list("(day,light theme)") == ["day", "light theme"]


def test_weights_are_dropped():
    assert T.tokenize_display_list("(masterpiece:1.3)") == ["masterpiece"]
    assert T.tokenize_display_list("(day,light theme:1.1)") == ["day", "light theme"]
    assert T.tokenize_display_list("tag:1.20") == ["tag"]
    # a colon that is not a weight stays part of the name
    assert T.tokenize_display_list("no weight: here") == ["no weight: here"]


def test_empty_elements_are_ignored():
    assert T.tokenize_display_list(",,,,") == []
    assert T.tokenize_display_list("  ,  , a , , b , ") == ["a", "b"]
    assert T.tokenize_display_list("()") == []
    assert T.tokenize_display_list("[], {}") == []


def test_fold_token():
    assert T.fold_token("Best_Quality") == T.fold_token("best-quality")
    assert T.fold_token("best   quality") == "best quality"
    assert T.fold_token("  HDR Photo  ") == "hdr photo"


def test_request_prompt_tokenizes_fully():
    """The prompt from the feature request, end to end."""
    sections = T.tokenize_text(REQUEST_PROMPT)
    assert len(sections) == 2  # one BREAK
    first = [t["d"] for t in sections[0]]
    second = [t["d"] for t in sections[1]]
    assert first[0] == "rich details"
    assert "HDR photo" in first
    assert "year 2023" in first
    # the escaped artwork tags survive as single tokens
    assert "digital painting (artwork)" in second
    assert "traditional media (artwork)" in second
    # the weighted group became two tokens without weights
    assert "day" in second and "light theme" in second
    # no empty token can ever come out
    assert all(t.strip() for sec in sections for t in [x["d"] for x in sec])


def test_tokenizer_never_returns_blank():
    for text in ["", " ", ",", ",,", " () ", "[]", ":1.2", "\\", "((((", "))))"]:
        for token in T.tokenize_display_list(text):
            assert token.strip(), (text, token)


# ---------------------------------------------------------------- counting

def test_two_counters_answer_different_questions():
    """Occurrences vs runs: 5 uses inside one prompt is one run."""
    stats = T.merge_run(T.empty_stats(), "cat, cat, cat, cat, cat", run_index=1)
    assert stats["tokens"]["cat"]["n"] == 5
    assert stats["tokens"]["cat"]["runs"] == 1
    stats = T.merge_run(T.empty_stats(), "cat, cat", run_index=1)
    stats = T.merge_run(stats, "cat, cat", run_index=2)
    assert stats["tokens"]["cat"]["n"] == 4
    assert stats["tokens"]["cat"]["runs"] == 2
    assert stats["tokens"]["cat"]["last"] == 2


def test_runs_counter_advances_once_per_run():
    stats = T.empty_stats()
    for i in range(3):
        stats = T.merge_run(stats, "a, b")
    assert stats["runs"] == 3
    assert stats["tokens"]["a"]["runs"] == 3


def test_cooccurrence_weight_prefers_neighbours():
    near = T.merge_run(T.empty_stats(), "a, b, x, y", run_index=1)
    far = T.merge_run(T.empty_stats(), "a, x, y, b", run_index=1)
    key = T.pair_index("a", "b")
    assert near["pairs"][key] > far["pairs"][key]
    # window=1: immediate neighbours only (the input tooltip promises this)
    w1 = T.merge_run(T.empty_stats(), "a, b, x", window=1, run_index=1)
    assert T.pair_index("a", "b") in w1["pairs"]
    assert T.pair_index("a", "x") not in w1["pairs"]
    # a token never pairs with itself
    solo = T.merge_run(T.empty_stats(), "a, a, a", window=3, run_index=1)
    assert all(T.PAIR_SEP not in k or len(set(T.pair_parts(k))) == 2 for k in solo["pairs"])
    assert not solo["pairs"]


def test_cooccurrence_is_not_cross_section():
    """Two BREAK-separated sections must not be treated as neighbours."""
    stats = T.merge_run(T.empty_stats(), "a, b BREAK c, d", window=3, run_index=1)
    assert T.pair_index("a", "b") in stats["pairs"]
    assert T.pair_index("c", "d") in stats["pairs"]
    assert T.pair_index("b", "c") not in stats["pairs"]
    assert T.pair_index("a", "d") not in stats["pairs"]


def test_display_form_keeps_capitalisation():
    stats = T.merge_run(T.empty_stats(), "HDR photo, hdr PHOTO", run_index=1)
    assert stats["tokens"]["hdr photo"]["display"] == "HDR photo"
    assert stats["tokens"]["hdr photo"]["n"] == 2


# ---------------------------------------------------------------- exclusions

def test_default_exclude_hides_quality_boilerplate():
    patterns = T.parse_exclude(T.DEFAULT_EXCLUDE_TEXT)
    for token in ["best quality", "masterpiece", "highres", "hi res", "sharp focus",
                  "detailed", "absurdres", "hdr photo", "newest", "ultra realistic"]:
        assert T.is_excluded(T.fold_token(token), patterns), token


def test_exclude_does_not_hide_compound_tokens():
    """`detailed` is boilerplate; `detailed eyes` is content."""
    patterns = T.parse_exclude(T.DEFAULT_EXCLUDE_TEXT)
    assert T.is_excluded("detailed", patterns)
    assert not T.is_excluded("detailed eyes", patterns), "compound token wrongly hidden"
    assert not T.is_excluded("detailed background", patterns)
    # "year *" hides years but not other words
    years = T.parse_exclude("year *")
    assert T.is_excluded("year 2023", years)
    assert T.is_excluded("year 2024", years)
    assert not T.is_excluded("newest", years)


def test_exclude_parsing():
    assert T.parse_exclude("") == []
    assert T.parse_exclude("a\nb") == ["a", "b"]
    assert T.parse_exclude("a, b") == ["a", "b"]
    assert T.parse_exclude("  ,  ") == []
    assert T.parse_exclude("# comment\nhighres") == ["highres"]
    # duplicates are collapsed
    assert T.parse_exclude("a\nA\na") == ["a"]


def test_excluded_tokens_are_ranked_out():
    stats = T.merge_run(T.empty_stats(), "best quality, cinematic, masterpiece", run_index=1)
    patterns = T.parse_exclude("best quality\nmasterpiece")
    rows = T.top_tokens(stats, exclude=patterns)
    assert [r["k"] for r in rows] == ["cinematic"]
    payload = T.build_payload(stats, exclude=patterns)
    assert payload["excluded_count"] == 2
    assert payload["excluded_n"] == 2
    # the counts are still in the document: hiding is a view, not a deletion
    assert stats["tokens"]["best quality"]["n"] == 1


def test_remove_token_clears_its_pairs():
    stats = T.merge_run(T.empty_stats(), "a, b, c", run_index=1)
    assert T.remove_token(stats, "a") is True
    assert "a" not in stats["tokens"]
    assert all("a" not in T.pair_parts(k) for k in stats["pairs"])
    assert T.remove_token(stats, "a") is False  # already gone


# ---------------------------------------------------------------- ranking

def test_ranking_order_is_stable():
    stats = T.empty_stats()
    stats = T.merge_run(stats, "b, c", run_index=1)
    stats = T.merge_run(stats, "a, b", run_index=2)
    rows = T.top_tokens(stats, limit=10)
    assert [r["k"] for r in rows] == ["b", "a", "c"]
    # repeated calls give the identical order
    assert T.top_tokens(stats, limit=10) == rows


def test_min_count_filters():
    stats = T.merge_run(T.empty_stats(), "a, b, b", run_index=1)
    assert [r["k"] for r in T.top_tokens(stats, limit=10, min_n=1)] == ["b", "a"]
    assert [r["k"] for r in T.top_tokens(stats, limit=10, min_n=2)] == ["b"]


def test_edges_index_into_the_ranking():
    stats = T.merge_run(T.empty_stats(), "a, b, c", run_index=1)
    rows = T.top_tokens(stats, limit=10)
    edges = T.edges_for(stats, rows)
    assert edges, "expected co-occurrence edges"
    for i, j, w in edges:
        assert 0 <= i < len(rows) and 0 <= j < len(rows)
        assert i < j  # each unordered pair once
        assert w > 0


# ---------------------------------------------------------------- documents

def test_normalize_stats_repairs_broken_documents():
    assert T.normalize_stats(None)["runs"] == 0
    assert T.normalize_stats("nonsense")["tokens"] == {}
    repaired = T.normalize_stats({
        "runs": "7",
        "tokens": {
            "ok": {"n": 2, "runs": 1, "display": "OK"},
            "bad": "not a dict",
            "zero": {"n": 0},
            "negative": {"n": -4},
        },
        "pairs": {"a\u0001b": 3, "broken": 5, "x\u0001y": "no"},
    })
    assert repaired["runs"] == 7
    assert set(repaired["tokens"]) == {"ok"}
    assert repaired["pairs"] == {"a\u0001b": 3}


def test_prune_keeps_the_document_bounded():
    stats = T.empty_stats()
    stats["tokens"] = {f"t{i}": {"n": i + 1, "runs": 1, "display": f"t{i}"} for i in range(T.MAX_TOKENS + 50)}
    stats["pairs"] = {f"a{i}\u0001b{i}": i + 1 for i in range(T.MAX_PAIRS + 50)}
    T.prune_stats(stats)
    assert len(stats["tokens"]) == T.MAX_TOKENS
    assert len(stats["pairs"]) <= T.MAX_PAIRS
    # the most frequent survive
    assert "t0" not in stats["tokens"] or stats["tokens"]["t0"]["n"] < 20
    assert f"t{T.MAX_TOKENS + 49}" in stats["tokens"]


def test_stats_file_round_trip():
    old, tmp = _isolated_stats_dir()
    try:
        assert T.stats_filename("tokens") == "tokens.stats.json"
        assert T.stats_filename("my set.json") == "my set.stats.json"
        assert T.stats_filename("") is None
        # traversal is neutralised, never repaired into a path
        assert T.stats_filename("../evil.json") == "evil.stats.json"
        assert T.stats_filename("a/b.json") == "b.stats.json"

        stats = T.merge_run(T.empty_stats(), "cinematic, raccoon", run_index=1)
        stats = T.set_exclude(stats, "best quality\nmasterpiece")
        ok, msg = T.save_stats("tokens", stats)
        assert ok, msg
        back = T.load_stats("tokens")
        assert back["runs"] == 1
        assert back["tokens"]["cinematic"]["n"] == 1
        assert back["exclude"] == ["best quality", "masterpiece"]
        assert T.load_stats("missing") == T.empty_stats()
    finally:
        _restore_stats_dir(old, tmp)


def test_stats_are_isolated_from_datasets():
    """A statistics file must never be listed or loaded as a dataset."""
    old, tmp = _isolated_stats_dir()
    try:
        stats = T.merge_run(T.empty_stats(), "cinematic", run_index=1)
        T.save_stats("tokens", stats)
        import esn_storage
        old_data = esn_storage.DATA_DIR
        try:
            esn_storage.DATA_DIR = tmp
            # the dataset folder contains no .json directly: stats live in a
            # subfolder, so list_datasets() cannot pick one up
            assert esn_storage.list_datasets() == []
            assert T.list_stats_files() == ["tokens.stats.json"]
        finally:
            esn_storage.DATA_DIR = old_data
    finally:
        _restore_stats_dir(old, tmp)


# ---------------------------------------------------------------- the node

def test_every_run_is_counted_exactly_once():
    """IS_CHANGED records; analyse consumes that snapshot, not a second fold."""
    old, tmp = _isolated_stats_dir()
    try:
        node = EasyStringTokenGraph()
        EasyStringTokenGraph._PENDING = None
        for _ in range(3):
            EasyStringTokenGraph.IS_CHANGED(text="cinematic, raccoon", stats_file="tokens")
            out = node.analyse(text="cinematic, raccoon", stats_file="tokens")
        stats = T.load_stats("tokens")
        assert stats["runs"] == 3, stats["runs"]
        assert stats["tokens"]["cinematic"]["n"] == 3, stats["tokens"]["cinematic"]
    finally:
        _restore_stats_dir(old, tmp)


def test_direct_call_without_is_changed_still_counts():
    """An engine that skips IS_CHANGED must still record the run exactly once."""
    old, tmp = _isolated_stats_dir()
    try:
        node = EasyStringTokenGraph()
        EasyStringTokenGraph._PENDING = None
        node.analyse(text="cinematic", stats_file="tokens")
        node.analyse(text="cinematic", stats_file="tokens")
        stats = T.load_stats("tokens")
        assert stats["runs"] == 2, stats["runs"]
        assert stats["tokens"]["cinematic"]["n"] == 2
    finally:
        _restore_stats_dir(old, tmp)


def test_outputs_and_payload_shape():
    old, tmp = _isolated_stats_dir()
    try:
        node = EasyStringTokenGraph()
        EasyStringTokenGraph._PENDING = None
        text = "cinematic, dramatic lighting, best quality"
        EasyStringTokenGraph.IS_CHANGED(text=text, stats_file="tokens",
                                        exclude="best quality")
        out = node.analyse(text=text, stats_file="tokens", exclude="best quality")
        # the text passes through unchanged, minus nothing
        assert out["result"][0] == text
        report = json.loads(out["result"][1])
        assert report["runs"] == 1
        assert report["excluded"] == 1
        assert [t["token"] for t in report["tokens"]] == ["cinematic", "dramatic lighting"]
        payload = out["ui"]["esn_token_graph"][0]
        assert payload["text"] == text
        assert payload["runs"] == 1
        assert [t["t"] for t in payload["tokens"]] == ["cinematic", "dramatic lighting"]
        assert payload["edges"], "the two content tokens co-occur"
        assert payload["stats_file"] == "tokens.stats.json"
    finally:
        _restore_stats_dir(old, tmp)


def test_position_and_caps_are_echoed_for_the_panel():
    old, tmp = _isolated_stats_dir()
    try:
        node = EasyStringTokenGraph()
        EasyStringTokenGraph._PENDING = None
        EasyStringTokenGraph.IS_CHANGED(text="a, b, c", stats_file="tokens")
        out = node.analyse(text="a, b, c", stats_file="tokens", top_n=2,
                           min_count=1, position="left", window=2)
        payload = out["ui"]["esn_token_graph"][0]
        assert payload["position"] == "left"
        assert payload["top_n"] == 2
        assert payload["window"] == 2
    finally:
        _restore_stats_dir(old, tmp)


def test_reset_clears_the_counters():
    old, tmp = _isolated_stats_dir()
    try:
        node = EasyStringTokenGraph()
        EasyStringTokenGraph._PENDING = None
        EasyStringTokenGraph.IS_CHANGED(text="cinematic", stats_file="tokens")
        EasyStringTokenGraph.IS_CHANGED(text="cinematic", stats_file="tokens")
        assert T.load_stats("tokens")["runs"] == 2
        EasyStringTokenGraph.IS_CHANGED(text="cinematic", stats_file="tokens", reset=True)
        stats = T.load_stats("tokens")
        assert stats["runs"] == 1, stats["runs"]
        assert stats["tokens"]["cinematic"]["n"] == 1
    finally:
        _restore_stats_dir(old, tmp)


def test_text_in_overrides_the_text_box():
    old, tmp = _isolated_stats_dir()
    try:
        node = EasyStringTokenGraph()
        EasyStringTokenGraph._PENDING = None
        EasyStringTokenGraph.IS_CHANGED(text="ignored", text_in="raccoon", stats_file="tokens")
        out = node.analyse(text="ignored", text_in="raccoon", stats_file="tokens")
        assert out["result"][0] == "raccoon"
        assert "raccoon" in T.load_stats("tokens")["tokens"]
        assert "ignored" not in T.load_stats("tokens")["tokens"]
        # an empty or blank connected input falls back to the text box
        EasyStringTokenGraph._PENDING = None
        EasyStringTokenGraph.IS_CHANGED(text="from box", text_in="   ", stats_file="tokens")
        assert "from box" in T.load_stats("tokens")["tokens"]
    finally:
        _restore_stats_dir(old, tmp)


def test_empty_stats_file_keeps_everything_in_memory():
    """An empty stats_file must not create a file on disk."""
    old, tmp = _isolated_stats_dir()
    try:
        node = EasyStringTokenGraph()
        EasyStringTokenGraph._PENDING = None
        EasyStringTokenGraph._MEM = None
        EasyStringTokenGraph.IS_CHANGED(text="cinematic, raccoon", stats_file="")
        out = node.analyse(text="cinematic, raccoon", stats_file="")
        payload = out["ui"]["esn_token_graph"][0]
        assert payload["runs"] == 1
        assert payload["stats_file"] == ""
        assert os.listdir(tmp) == [], "in-memory mode wrote to disk"
    finally:
        EasyStringTokenGraph._MEM = None
        _restore_stats_dir(old, tmp)


def test_recording_never_raises_on_a_broken_file():
    old, tmp = _isolated_stats_dir()
    try:
        path = T.stats_path("tokens")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{ this is not json")
        node = EasyStringTokenGraph()
        EasyStringTokenGraph._PENDING = None
        EasyStringTokenGraph.IS_CHANGED(text="cinematic", stats_file="tokens")
        out = node.analyse(text="cinematic", stats_file="tokens")
        assert out["result"][0] == "cinematic"
        assert T.load_stats("tokens")["tokens"]["cinematic"]["n"] == 1
    finally:
        _restore_stats_dir(old, tmp)


def test_node_input_contract():
    """The declared inputs and outputs the front-end depends on."""
    types = EasyStringTokenGraph.INPUT_TYPES()
    required = types["required"]
    for name in ("text", "stats_file", "reset", "window", "top_n", "min_count",
                 "exclude", "position"):
        assert name in required, name
    assert required["position"][0][0] == "floating"  # the default opens floating
    assert required["position"][1]["default"] == "floating"
    assert "text_in" in types["optional"]
    assert "trigger" in types["optional"]
    assert EasyStringTokenGraph.RETURN_TYPES == ("STRING", "STRING")
    assert EasyStringTokenGraph.FUNCTION == "analyse"


def test_trigger_input_is_accepted_and_ignored():
    """The optional gate is a run signal; the node itself never blocks."""
    old, tmp = _isolated_stats_dir()
    try:
        node = EasyStringTokenGraph()
        EasyStringTokenGraph._PENDING = None
        for value in (True, False):
            EasyStringTokenGraph.IS_CHANGED(text="a, b", stats_file="tokens", trigger=value)
            out = node.analyse(text="a, b", stats_file="tokens", trigger=value)
            assert out["result"][0] == "a, b"
    finally:
        _restore_stats_dir(old, tmp)


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
                traceback.print_exc()
                failures.append((name, exc))
    print(f"\n{passed}/{total} token graph tests passed")
    if failures:
        for name, exc in failures:
            print(f"  FAIL {name}: {exc}")
        sys.exit(1)
