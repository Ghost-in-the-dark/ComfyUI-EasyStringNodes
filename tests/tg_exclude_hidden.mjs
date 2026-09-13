// The `exclude` widget must be collapsed, and must survive being collapsed.
//
// WHY THIS EXISTS
// ---------------
// `exclude` is a multiline STRING input whose default is the 50-line
// boilerplate list. ComfyUI gives a multiline widget roughly its content
// height, so a freshly added node reserved ~546px for it. On the real canvas
// that pushed the token strip to the very bottom of a very tall node and left a
// large empty block in the middle (reported from ComfyUI: the node body below
// the `position` widget was blank).
//
// The node therefore hides it the way the pack's other node hides its data
// widgets (web/esn_core.js hideTextWidget, used by EasyStringNegEditor for
// rows/presets/data_file). Two things make that safe and both are asserted
// here, because getting either wrong is silent:
//
//   1. Hiding must zero the height. A "hidden" widget that still reports its
//      content height is exactly the blank-body bug.
//   2. The value must survive, and the panel must still be able to read AND
//      write it - the exclusions drawer edits this very input. A collapse that
//      clears or detaches the widget would silently drop the user's list.
//
// Run:  node tests/tg_exclude_hidden.mjs
// Exit: 0 pass, 1 on any failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "web");
const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "tg-exclude-"));

// Modules import ComfyUI's app as "../../scripts/app.js", so the copies sit two
// levels under the stub: <tmp>/scripts/app.js and <tmp>/pkg/web/*.js
fs.mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(tmpRoot, "scripts", "app.js"),
  'export const app = { graph: { _nodes: [], setDirtyCanvas() {} }, registerExtension() {}, canvas: null };\n',
);
const modDir = path.join(tmpRoot, "pkg", "web");
fs.mkdirSync(modDir, { recursive: true });
for (const f of fs.readdirSync(webDir)) {
  if (f.endsWith(".js")) fs.copyFileSync(path.join(webDir, f), path.join(modDir, f));
}

globalThis.window = {
  addEventListener() {}, removeEventListener() {}, innerWidth: 1600, innerHeight: 900,
  devicePixelRatio: 1,
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  createElement() {
    return {
      style: {}, dataset: {}, appendChild() {}, addEventListener() {},
      removeEventListener() {}, setAttribute() {},
      getBoundingClientRect: () => ({ width: 300, height: 200, left: 0, top: 0 }),
      getContext: () => null,
    };
  },
  createDocumentFragment() { return { appendChild() {} }; },
  body: { appendChild() {} }, documentElement: { style: {} },
  querySelector: () => null,
};

const { hideExcludeWidget, showExcludeWidget, setupTokenNode } = await import(path.join(modDir, "token_graph.js"));
const { settings } = await import(path.join(modDir, "tg_panel.js"));

const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(`${name}${detail ? " -- " + detail : ""}`);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? "  " + detail : ""}`);
}

// A multiline widget the way ComfyUI builds one: it reports its content height
// through computeSize()/computeLayoutSize() and carries the sizing hooks on
// options, which is what hideTextWidget has to neutralise.
const EXCLUDE_TEXT = "best quality\nhigh quality\nmasterpiece\n8k\nsharp focus";
// The multiline `text` box is small by default (a few visible rows); `exclude`
// is the one that reserves hundreds of pixels, because its default value is a
// fifty-line list. Those two numbers are what make the collapse measurable.
const TEXT_H = 140;
const EXCLUDE_H = 546;
function mkNode(excludeValue = EXCLUDE_TEXT) {
  const mk = (name, value, height) => {
    const w = { name, value, options: {}, width: 420 };
    if (height) {
      w.computeSize = function () { return [this.width || 420, height]; };
      w.computeLayoutSize = function () { return { minHeight: height, maxHeight: height, minWidth: 0 }; };
    }
    return w;
  };
  return {
    id: 1, type: "EasyStringTokenGraph", size: [420, 300], properties: {},
    widgets: [
      mk("text", "raccoon, cinematic", TEXT_H),
      mk("stats_file", "tokens", 0),
      mk("reset", false, 0),
      mk("window", 3, 0),
      mk("top_n", 40, 0),
      mk("min_count", 1, 0),
      mk("exclude", excludeValue, EXCLUDE_H),
      mk("position", "floating", 0),
    ],
  };
}
const exclOf = (n) => n.widgets.find((w) => w.name === "exclude");
// Only the widgets the node is DECLARED with. setupTokenNode() also appends the
// token strip as a custom widget, and its height depends on the statistics, so
// including it would make the expected delta drift with unrelated state.
const PY_NAMES = new Set(["text", "stats_file", "reset", "window", "top_n", "min_count", "exclude", "position"]);
const contentHeight = (n) => n.widgets
  .filter((w) => PY_NAMES.has(w.name))
  .reduce((a, w) => a + (w.hidden ? 0
    : (typeof w.computeSize === "function" ? w.computeSize(420)[1] : 26)), 0);

console.log("exclude widget collapse\n");

// --- the real entry point collapses it -----------------------------------
// This is the assertion that matters: it goes through setupTokenNode(), the
// function ComfyUI actually calls from onNodeCreated, so removing the collapse
// from there fails here. Calling hideExcludeWidget() directly would keep
// passing even with the call site deleted.
{
  const node = mkNode();
  const before = contentHeight(node);
  setupTokenNode(node);
  const after = contentHeight(node);
  check("setupTokenNode collapses the exclude block", after <= before - EXCLUDE_H,
    `${before} -> ${after}, expected at least ${EXCLUDE_H}px less`);
  check("setupTokenNode leaves a compact node", after < EXCLUDE_H,
    `${after}px of content, exclude alone used to reserve ${EXCLUDE_H}px`);
  check("setupTokenNode keeps the exclude value",
    exclOf(node).value === EXCLUDE_TEXT, JSON.stringify(exclOf(node).value));
}

// --- hiding zeroes the height -------------------------------------------
{
  const node = mkNode();
  const before = contentHeight(node);
  const ok = hideExcludeWidget(node);
  const widget = exclOf(node);
  check("hideExcludeWidget finds and hides the widget", ok === true);
  check(
    "hidden widget reports zero height",
    widget.computeSize(420)[1] === 0,
    `got ${widget.computeSize(420)[1]}`,
  );
  check("node content shrinks by the exclude block",
    contentHeight(node) <= before - EXCLUDE_H, `${before} -> ${contentHeight(node)}`);
  check("idempotent when applied twice", hideExcludeWidget(node) === true);
}

// --- the value and the panel's access to it ------------------------------
{
  const node = mkNode();
  hideExcludeWidget(node);
  const widget = exclOf(node);
  check("value is preserved verbatim", widget.value === EXCLUDE_TEXT,
    JSON.stringify(widget.value));
  check("the widget is still attached to the node (not removed from the array)",
    node.widgets.includes(widget));
  // The panel reads settings() from the widget list on every draw.
  check("panel still reads the collapsed input", settings(node).exclude === EXCLUDE_TEXT,
    JSON.stringify(settings(node).exclude));
  // The exclusions drawer writes through setWidgetValue -> w.value = next.
  widget.value = "only this";
  check("panel can still write the collapsed input", settings(node).exclude === "only this");
}

// --- restoring ------------------------------------------------------------
{
  const node = mkNode();
  hideExcludeWidget(node);
  const widget = exclOf(node);
  const ok = showExcludeWidget(node);
  check("showExcludeWidget restores the widget",
    ok === true && widget.computeSize(420)[1] === EXCLUDE_H,
    `height ${widget.computeSize(420)[1]} (want ${EXCLUDE_H}), hidden ${widget.hidden}`);
  check("restore keeps the value", widget.value === EXCLUDE_TEXT);
}

// --- a node without the widget must not throw ----------------------------
{
  const node = mkNode();
  node.widgets = node.widgets.filter((w) => w.name !== "exclude");
  let threw = null;
  try { hideExcludeWidget(node); } catch (e) { threw = e.message; }
  check("no exclude widget -> no throw, returns false",
    threw === null && hideExcludeWidget(node) === false, threw || "");
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log();
if (failures.length) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
console.log("PASS: exclude is collapsed, keeps its value, and stays editable from the panel.");
