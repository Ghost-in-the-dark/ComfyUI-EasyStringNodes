// Canvas state balance regression test for the EasyStringNegEditor widget.
//
// WHY THIS EXISTS
// ---------------
// The node's custom widget draws directly on the SHARED ComfyUI canvas context.
// LiteGraph wraps renderNode in ctx.save() / ctx.restore(), so if draw() performs
// one restore too many it pops a state frame that belongs to the graph renderer.
// Every node and link drawn after this one then inherits this widget's fillStyle,
// globalAlpha and lost transform - the symptom is a node that renders invisible,
// or a normal node that becomes a solid black slab, on a fresh workflow too.
//
// Counting `grep -c ctx.save()` is not a valid check: the words also appear in
// comments and in dead branches. The invariant is behavioural:
//
//     the stack depth after draw() MUST equal the depth before draw()
//
// This test drives draw() with a recording context that models the real stack
// and asserts the invariant over several widget states (rows present / empty,
// presets present / empty, category popover open, collapsed settings, filters).
//
// Run:  node tests/canvas_balance.mjs
// Exit: 0 balanced, 1 on any imbalance (prints the offending source line).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "web");
const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "esn-balance-"));

// The modules import ComfyUI's app.js. Link them in a scratch mirror with a
// minimal stub, so the test stays dependency-free and offline.
fs.mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(tmpRoot, "scripts", "app.js"),
  'export const app = { graph: { _nodes: [], setDirtyCanvas() {} }, registerExtension() {}, canvas: null };\n',
);
const modDir = path.join(tmpRoot, "web");
fs.mkdirSync(modDir, { recursive: true });
for (const f of fs.readdirSync(webDir)) {
  if (f.endsWith(".js")) fs.copyFileSync(path.join(webDir, f), path.join(modDir, f));
}

// Minimal browser surface for the module top-level side effects.
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1600, innerHeight: 900 };
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  createElement() { return { style: {}, appendChild() {}, addEventListener() {} }; },
  body: { appendChild() {} }, documentElement: { style: {} },
  querySelector: () => null,
};
if (typeof globalThis.CanvasRenderingContext2D === "undefined") {
  globalThis.CanvasRenderingContext2D = function () {};
  globalThis.CanvasRenderingContext2D.prototype = {};
}

const { state, cleanRows } = await import(path.join(modDir, "esn_core.js"));
const { makeListWidget } = await import(path.join(modDir, "esn_widget.js"));

const NOOP = ["beginPath", "fill", "stroke", "fillRect", "rect", "roundRect", "moveTo", "lineTo",
  "arc", "arcTo", "closePath", "fillText", "drawImage", "translate", "scale", "clip",
  "setLineDash", "quadraticCurveTo", "bezierCurveTo", "strokeRect", "clearRect", "ellipse"];

// A context that models the real save/restore stack and records each call site.
function recordingCtx() {
  let depth = 0;
  const events = [];
  const site = () => {
    const frames = new Error().stack.split("\n");
    for (const line of frames) {
      const m = /esn_widget\.js:(\d+):/.exec(line);
      if (m) return Number(m[1]);
    }
    return 0;
  };
  const ctx = {
    get depth() { return depth; },
    save() { depth += 1; events.push({ op: "save", line: site(), depth }); },
    restore() {
      depth -= 1;
      const ev = { op: "restore", line: site(), depth };
      if (depth < 0) ev.underflow = true;
      events.push(ev);
    },
  };
  for (const k of NOOP) ctx[k] = () => {};
  ctx.measureText = () => ({ width: 40 });
  return { ctx, events, depthNow: () => depth };
}

function mkNode(rows, presets, opts = {}) {
  const widgets = [
    { name: "rows", value: JSON.stringify(rows), options: {} },
    { name: "presets", value: presets, options: {} },
    { name: "data_file", value: "", options: {} },
    { name: "data_rev", value: 0, options: {} },
    { name: "line_numbers", value: "", options: {} },
    { name: "select_all", value: true, options: {} },
    { name: "preset_checked", value: !!opts.presetChecked, options: {} },
    { name: "preset_trigger", value: "", options: {} },
  ];
  const node = {
    id: 1, type: "EasyStringNegEditor", pos: [0, 0], size: [opts.w || 340, 540],
    properties: opts.collapsed ? { __esnSettingsCollapsed: true } : {},
    widgets,
    addCustomWidget(w) { this.widgets.push(w); },
  };
  const st = state(node);
  st.rows = cleanRows(rows);
  st.raw = JSON.stringify(rows);
  st.presets = presets;
  if (opts.search) st.search = opts.search;
  if (opts.onlyChecked) st.onlyChecked = true;
  if (opts.catFilter) st.catFilter = opts.catFilter;
  if (opts.catPickOpen) st.catPickOpen = true;
  if (opts.sortedByFreq) st.sortedByFreq = true;
  if (opts.scroll) st.scroll = opts.scroll;
  if (opts.presetScroll) st.presetScroll = opts.presetScroll;
  if (opts.catPopScroll) st.catPopScroll = opts.catPopScroll;
  if (opts.popHover !== undefined) st.popHover = opts.popHover;
  if (opts.hoverKey !== undefined) st.hoverKey = opts.hoverKey;
  if (opts.draggingSb) st.draggingSb = true;
  if (opts.toast) st.toast = { text: "ticked 12 rows", action: () => {}, label: "undo" };
  return node;
}

const many = [];
for (let i = 1; i <= 40; i++) {
  many.push({ num: i, cat: "c" + (i % 3), on: i % 3 === 0, pos: "row " + i, neg: "", img: "", freq: i % 5 });
}
const few = many.slice(0, 3);
const PRESETS = "1: 1 2 3\n2: 4 5 6\n3: 7 8 9\n4: 10 11\n5: 12 13\n6: 14 15";

// Every state that changes which drawing branches execute. A branch that saves
// without restoring only shows up when that branch runs, so all of them run.
const STATES = [
  ["rows + presets (default)", () => mkNode(many, PRESETS)],
  ["no rows, no presets (empty)", () => mkNode([], "")],
  ["no rows, with presets", () => mkNode([], PRESETS)],
  ["rows, no presets", () => mkNode(many, "")],
  ["few rows (no scroll band)", () => mkNode(few, PRESETS)],
  ["settings collapsed", () => mkNode(many, PRESETS, { collapsed: true })],
  ["preset_checked on", () => mkNode(many, PRESETS, { presetChecked: true })],
  ["category popover open", () => mkNode(many, PRESETS, { catPickOpen: true })],
  ["popover open + empty rows", () => mkNode([], "", { catPickOpen: true })],
  ["search filter, no matches", () => mkNode(many, PRESETS, { search: "zzzz-no-match" })],
  ["only-checked filter", () => mkNode(many, PRESETS, { onlyChecked: true })],
  ["category filter", () => mkNode(many, PRESETS, { catFilter: "c1" })],
  ["frequency sort", () => mkNode(many, PRESETS, { sortedByFreq: true })],
  ["scrolled deep", () => mkNode(many, PRESETS, { scroll: 25 })],
  ["narrow node 220px", () => mkNode(many, PRESETS, { w: 220 })],
  ["empty rows + popover + collapsed", () => mkNode([], "", { catPickOpen: true, collapsed: true })],
  ["toast with action button", () => mkNode(many, PRESETS, { toast: true })],
  ["toast + active category chip", () => mkNode(many, PRESETS, { toast: true, catFilter: "c1" })],
  ["presets scrolled (arrows shown)", () => mkNode(many, PRESETS, { presetScroll: 3 })],
  ["popover scrolled + hovered row", () => mkNode(many, PRESETS, { catPickOpen: true, catPopScroll: 2, popHover: 3 })],
  ["row hovered (hover chip)", () => mkNode(many, PRESETS, { hoverKey: 4 })],
  ["scrollbar being dragged", () => mkNode(many, PRESETS, { draggingSb: true, scroll: 5 })],
  ["search + category + only, combined", () => mkNode(many, PRESETS, { search: "row 1", catFilter: "c1", onlyChecked: true })],
  ["all filters, zero matches", () => mkNode(many, PRESETS, { search: "row", catFilter: "nope", onlyChecked: true })],
  ["220px + popover + toast", () => mkNode(many, PRESETS, { w: 220, catPickOpen: true, toast: true })],
];

const failures = [];
const results = [];

for (const [label, build] of STATES) {
  const node = build();
  const widget = makeListWidget(node);
  const rec = recordingCtx();
  const width = node.size[0];
  // Two pre-existing frames stand in for the caller's (LiteGraph) own saves.
  rec.ctx.save();
  rec.ctx.save();
  const depthIn = rec.depthNow();
  let threw = null;
  try {
    widget.draw(rec.ctx, node, width, 20, 540);
  } catch (e) {
    threw = e && e.message ? e.message : String(e);
  }
  const depthOut = rec.depthNow();
  const delta = depthOut - depthIn;

  const orphaned = [];
  const stack = [];
  for (const ev of rec.events) {
    if (ev.op === "save") stack.push(ev);
    else if (stack.length) stack.pop();
    else orphaned.push(ev);
  }
  const unclosed = stack;

  if (delta !== 0 || threw) {
    failures.push({
      state: label,
      delta,
      threw,
      orphanedRestores: orphaned.map((e) => e.line),
      unclosedSaves: unclosed.map((e) => e.line),
    });
  }
  results.push({ state: label, saves: rec.events.filter((e) => e.op === "save").length,
    restores: rec.events.filter((e) => e.op === "restore").length, delta, threw });
}

console.log("canvas state balance — depth after draw() must equal depth before");
for (const r of results) {
  const mark = r.delta === 0 && !r.threw ? "ok  " : "FAIL";
  console.log(`  ${mark} ${r.state.padEnd(34)} saves=${String(r.saves).padStart(2)} restores=${String(r.restores).padStart(2)} delta=${r.delta}`);
}

// Guard the static shape too: an `export`/comment mentioning the calls must not
// be able to hide a real imbalance, so compare only executable occurrences.
const src = fs.readFileSync(path.join(webDir, "esn_widget.js"), "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
const staticSaves = (src.match(/ctx\.save\(\)/g) || []).length;
const staticRestores = (src.match(/ctx\.restore\(\)/g) || []).length;
console.log(`\nstatic (comments stripped): save=${staticSaves} restore=${staticRestores}`);
if (staticSaves !== staticRestores) {
  failures.push({ state: "static count", delta: staticSaves - staticRestores });
}

if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) console.error("  " + JSON.stringify(f));
  console.error(
    "\nA draw() that restores more than it saves pops the graph renderer's own " +
    "state frame; nodes drawn afterwards then render blank or black.",
  );
  process.exit(1);
}
console.log("\nPASS: every state hands the canvas back with an unchanged stack depth.");
