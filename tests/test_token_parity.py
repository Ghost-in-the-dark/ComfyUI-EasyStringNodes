"""Parity tests: the browser tokenizer must agree with the Python one.

`web/tg_tokens.js` re-implements esn_tokens.py so the floating panel can
re-rank the text the user is TYPING, before anything is queued. Two
implementations of one rule set drift apart silently, and a drift here is
invisible: the panel would simply draw a slightly different prompt than the
report describes.

So both are run over the same corpus and their output is compared token by
token, including the section split (which decides co-occurrence) and the
folding of each key.

Run from the repository root:

    python3 tests/test_token_parity.py

The test skips (exit 0) when node is unavailable, so the Python-only suite
still runs on a machine without a JS runtime; CI installs Node, so there it
is a real gate.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import esn_tokens as T  # noqa: E402

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")

# The corpus deliberately covers the awkward cases: escapes, nesting, weights,
# BREAK, doubled commas, a weight on a bracketed group, brackets that must NOT
# be treated as a wrapper, unicode, and the prompt from the feature request.
CORPUS = [
    "",
    "   ",
    ",,,",
    "cat",
    "a cute cat, a bird in flight",
    "best quality, masterpiece, detailed",
    "best quality,detailed eyes,detailed background",
    "(masterpiece:1.3)",
    "(masterpiece:1.30), (best quality:1.2)",
    "(day,light theme:1.1)",
    r"digital painting \(artwork\), digital media \(artwork\)",
    r"traditional media \(artwork\)",
    "a (b, c) d, e",
    "(a) (b), c",
    "[a, b], c",
    "{a, b}, c",
    "year 2023, year 2024, newest",
    "HDR photo, hdr PHOTO, Hdr Photo",
    "Best_Quality, best-quality, best   quality",
    "BREAK",
    "a, b BREAK c, d",
    "a, b BREAKBREAK c",
    "line one\nline two, three",
    "a,\n\nb",
    "  ,  , a , , b , ",
    "cinematic,,dramatic lighting",
    "((nested:1.1):1.2)",
    "weighted:1.1:2.2",
    "no weight: here",
    "tag:",
    ":1.2",
    "(empty:1.2)",
    "()",
    "[]",
    "ёмкость, дерево",
    "キャラクター, 背景",
    "a\\,b, c",
    "round(1.5), square[2], curly{3}",
    "((a), (b)), c",
    "(a, (b, c)), d",
    "a , b , c",
    "trailing comma,",
    ",leading comma",
    "x" * 300,
]

# The prompt from the feature request, verbatim.
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
CORPUS.append(REQUEST_PROMPT)

EXCLUDE_CORPUS = [
    "",
    "best quality",
    "BEST QUALITY, masterpiece",
    "year *",
    "year *\nnewest",
    "detailed",
    "detailed *",
    "# a comment\nhighres",
    "a  b, c-d, e_f",
    "*",
    "?",
    "  ,  ",
    "tag with spaces",
]


def _run_js(payload):
    """Run the JS tokenizer over the corpus; returns its parsed answer."""
    script = r"""
import { tokenizeText, tokenizeDisplayList, parseExclude, foldToken, isExcluded,
         splitSections } from "./tg_tokens.js";
const input = JSON.parse(await new Promise((res) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { buf += d; });
  process.stdin.on("end", () => res(buf));
}));
const out = {
  texts: [], excludes: [], sections: [],
};
for (const text of input.texts) {
  const sections = tokenizeText(text);
  out.texts.push({
    sections: sections.map((s) => s.map((t) => ({ d: t.d, k: t.k }))),
    display: tokenizeDisplayList(text),
  });
  out.sections.push(splitSections(text));
}
for (const raw of input.excludes) {
  const pats = parseExclude(raw);
  out.excludes.push({
    patterns: pats,
    // probe how the compiled patterns behave against a fixed key list
    hits: input.probe.filter((k) => isExcluded(k, pats)),
    folded: input.probe.map((k) => foldToken(k)),
  });
}
console.log(JSON.stringify(out));
"""
    tmp = tempfile.mkdtemp(prefix="tg-parity-")
    try:
        for name in os.listdir(WEB_DIR):
            if name.endswith(".js") and name.startswith("tg_"):
                shutil.copyfile(os.path.join(WEB_DIR, name), os.path.join(tmp, name))
        js_path = os.path.join(tmp, "run.mjs")
        with open(js_path, "w", encoding="utf-8") as fh:
            fh.write(script)
        proc = subprocess.run(
            ["node", js_path],
            input=json.dumps(payload), capture_output=True, text=True,
            cwd=tmp, timeout=120,
        )
        if proc.returncode != 0:
            raise AssertionError("node failed: %s" % (proc.stderr or proc.stdout))
        return json.loads(proc.stdout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_browser_tokenizer_matches_python():
    if not shutil.which("node"):
        print("  (skipped: node not available)")
        return
    probe = [
        "best quality", "best  quality", "year 2023", "year 2024", "newest",
        "detailed", "detailed eyes", "highres", "masterpiece", "a b", "abc",
    ]
    js = _run_js({"texts": CORPUS, "excludes": EXCLUDE_CORPUS, "probe": probe})

    for i, text in enumerate(CORPUS):
        py_sections = [[{"d": t["d"], "k": t["k"]} for t in sec]
                       for sec in T.tokenize_text(text)]
        got = js["texts"][i]["sections"]
        assert got == py_sections, (
            "tokenizer drift for %r\n  python: %s\n  js:     %s"
            % (text[:80], py_sections, got)
        )
        py_display = T.tokenize_display_list(text)
        assert js["texts"][i]["display"] == py_display, (
            "display drift for %r\n  python: %s\n  js:     %s"
            % (text[:80], py_display, js["texts"][i]["display"])
        )
        assert js["sections"][i] == T.split_sections(text), (
            "section drift for %r" % (text[:80],)
        )

    for i, raw in enumerate(EXCLUDE_CORPUS):
        assert js["excludes"][i]["patterns"] == T.parse_exclude(raw), (
            "exclude drift for %r\n  python: %s\n  js:     %s"
            % (raw, T.parse_exclude(raw), js["excludes"][i]["patterns"])
        )

    py_patterns = T.parse_exclude(EXCLUDE_CORPUS[3])  # "year *"
    py_hits = [k for k in probe if T.is_excluded(k, py_patterns)]
    assert js["excludes"][3]["hits"] == py_hits, (
        "wildcard drift: python %s, js %s" % (py_hits, js["excludes"][3]["hits"])
    )


def test_stats_merge_matches_counts():
    """The headline numbers: occurrences and runs, over the request prompt."""
    stats = T.merge_run(T.empty_stats(), REQUEST_PROMPT, window=3, run_index=1)
    stats = T.merge_run(stats, REQUEST_PROMPT, window=3, run_index=2)
    assert stats["runs"] == 2
    # "cinematic" is in both runs, once each
    assert stats["tokens"]["cinematic"]["n"] == 2
    assert stats["tokens"]["cinematic"]["runs"] == 2
    # a token used five times in one prompt: many occurrences, one run
    s = T.merge_run(T.empty_stats(), "cat, cat, cat, cat, cat", window=3, run_index=1)
    assert s["tokens"]["cat"]["n"] == 5
    assert s["tokens"]["cat"]["runs"] == 1


def test_cooccurrence_prefers_neighbours():
    """A nearer pair must outrank a farther one for the same two tokens."""
    near = T.merge_run(T.empty_stats(), "a, b, x, y", window=3, run_index=1)
    far = T.merge_run(T.empty_stats(), "a, x, y, b", window=3, run_index=1)
    key = T.pair_index("a", "b")
    assert near["pairs"][key] > far["pairs"][key], (near["pairs"][key], far["pairs"][key])
    # window=1 means immediate neighbours only
    w1 = T.merge_run(T.empty_stats(), "a, b, x", window=1, run_index=1)
    assert T.pair_index("a", "b") in w1["pairs"]
    assert T.pair_index("a", "x") not in w1["pairs"]



def test_default_exclude_list_matches():
    """The default exclusion list must be one list, not two copies.

    The node ships the list to the browser through its `exclude` widget default
    (python), and the panel's "reset to defaults" button needs the same list in
    javascript. They are separate literals, so without this check a token added
    to one side would silently keep appearing on the other - and "reset to
    defaults" would restore a different list than a freshly created node starts
    with.
    """
    if not shutil.which("node"):
        print("  (skipped: node not available)")
        return
    script = r"""
import { DEFAULT_EXCLUDE, DEFAULT_EXCLUDE_TEXT } from "./tg_tokens.js";
console.log(JSON.stringify({
  list: DEFAULT_EXCLUDE,
  text: DEFAULT_EXCLUDE_TEXT,
}));
"""
    tmp = tempfile.mkdtemp(prefix="tg-exclude-")
    try:
        for name in os.listdir(WEB_DIR):
            if name.endswith(".js") and name.startswith("tg_"):
                shutil.copyfile(os.path.join(WEB_DIR, name), os.path.join(tmp, name))
        with open(os.path.join(tmp, "run.mjs"), "w", encoding="utf-8") as fh:
            fh.write(script)
        proc = subprocess.run(
            ["node", os.path.join(tmp, "run.mjs")],
            capture_output=True, text=True, cwd=tmp, timeout=60,
        )
        if proc.returncode != 0:
            raise AssertionError(f"node failed: {proc.stderr.strip()[:400]}")
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    js_list = payload["list"]
    py_list = list(T.DEFAULT_EXCLUDE)
    assert js_list == py_list, (
        "default exclude lists differ\n"
        f"  only in python: {[x for x in py_list if x not in js_list]}\n"
        f"  only in js    : {[x for x in js_list if x not in py_list]}"
    )
    # and the text form the widget uses is the same newline-joined list
    assert payload["text"] == T.DEFAULT_EXCLUDE_TEXT
    assert payload["text"].split("\n") == py_list



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
                import traceback
                traceback.print_exc()
                failures.append((name, exc))
    print(f"\n{passed}/{total} parity tests passed")
    if failures:
        for name, exc in failures:
            print(f"  FAIL {name}: {exc}")
        sys.exit(1)
