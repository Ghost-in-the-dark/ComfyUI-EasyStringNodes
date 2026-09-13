// Canvas state balance for the EasyStringTokenGraph front-end.
//
// WHY THIS EXISTS
// ---------------
// The on-node strip (tg_widget.js) draws on ComfyUI's SHARED 2D context. The
// graph renderer wraps each node's renderNode in ctx.save()/ctx.restore(), so a
// draw() that restores one frame too many pops the renderer's own state and
// every node drawn afterwards renders blank or as a black slab - on a fresh
// workflow too. That regression already happened once in this pack (see
// tests/canvas_balance.mjs and commit 12dba28), so the same behavioural gate
// covers the new node.
//
// The invariant is behavioural, not textual: counting "ctx.save()" with grep
// also counts comments and dead branches. Depth after draw() must equal depth
// before it, over every branch that can execute.
//
// The panel's own <canvas> is private to the panel, so a mistake there cannot
// damage other nodes - but it would still leave the panel's own context in a
// wrong state between frames, so drawGraph() is checked too.
//
// Run:  node tests/tg_canvas_balance.mjs
// Exit: 0 balanced, 1 on any imbalance (prints the offending source line).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "web");
const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "tg-balance-"));

// Any module importing ComfyUI's app.js does so as "../../scripts/app.js", so
// the copies must sit two levels below the stub:
//
//   <tmp>/scripts/app.js        <- the stub
//   <tmp>/pkg/web/tg_widget.js  <- the module
//
// Copying into <tmp>/web/ instead resolves outside the temp root, and then the
// test passes only while a stray /tmp/scripts/app.js happens to exist - exactly
// the trap tests/canvas_balance.mjs had fallen into. Keep the layout correct.
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

// The panel and the widget touch these on the DOM only inside functions; the
// stubs keep the module top level importable.
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, innerWidth: 1600, innerHeight: 900,
  devicePixelRatio: 1,
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  createElement() {
    return {
      style: {}, dataset: {}, appendChild() {}, addEventListener() {},
      removeEventListener() {}, setAttribute() {}, getBoundingClientRect: () => ({ width: 300, height: 200, left: 0, top: 0 }),
      getContext: () => null,
    };
  },
  createDocumentFragment() { return { appendChild() {} }; },
  body: { appendChild() {} }, documentElement: { style: {} },
  querySelector: () => null,
};
if (typeof globalThis.CanvasRenderingContext2D === "undefined") {
  globalThis.CanvasRenderingContext2D = function () {};
  globalThis.CanvasRenderingContext2D.prototype = {};
}

const { makeTokenWidget } = await import(path.join(modDir, "tg_widget.js"));
const { drawGraph } = await import(path.join(modDir, "tg_panel.js"));
const { layout } = await import(path.join(modDir, "tg_layout.js"));
const { mergeRun, emptyStats } = await import(path.join(modDir, "tg_tokens.js"));

const NOOP = ["beginPath", "fill", "stroke", "fillRect", "rect", "roundRect", "moveTo", "lineTo",
  "arc", "arcTo", "closePath", "fillText", "strokeText", "drawImage", "translate", "scale", "clip",
  "setLineDash", "quadraticCurveTo", "bezierCurveTo", "strokeRect", "clearRect", "ellipse"];

// A context that models the real save/restore stack and records call sites.
function recordingCtx(file) {
  let depth = 0;
  const events = [];
  const site = () => {
    const frames = new Error().stack.split("\n");
    for (const line of frames) {
      const m = new RegExp(`${file}:(\\d+):`).exec(line);
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
  ctx.measureText = (s) => ({ width: String(s).length * 6 });
  return { ctx, events, depthNow: () => depth };
}

function mkNode(opts = {}) {
  const widgets = [
    { name: "text", value: opts.text || "" },
    { name: "stats_file", value: opts.statsFile === undefined ? "tokens" : opts.statsFile },
    { name: "reset", value: false },
    { name: "window", value: opts.window || 3 },
    { name: "top_n", value: opts.topN || 40 },
    { name: "min_count", value: opts.minCount || 1 },
    { name: "exclude", value: opts.exclude === undefined ? "best quality\nmasterpiece" : opts.exclude },
    { name: "position", value: "floating" },
  ];
  return {
    id: 1, type: "EasyStringTokenGraph", pos: [0, 0], size: [340, 220],
    properties: opts.properties || {}, widgets,
    addCustomWidget(w) { this.widgets.push(w); },
  };
}

// Feed a node a statistics document directly, bypassing the server.

const { stateOf } = await import(path.join(modDir, "tg_panel.js"));

function seedStats(node, texts) {
  const st = stateOf(node);
  st.base = emptyStats();
  texts.forEach((t, i) => mergeRun(st.base, t, 3, i + 1));
  st.loaded = true;
  return st;
}

const CORPUS = [
  "cinematic, dramatic lighting, raccoon, vignette",
  "cinematic, dramatic lighting, detailed eyes",
  "cinematic, raccoon, stippling, cel shading",
  "best quality, masterpiece, sharp focus",
];

// ---------------------------------------------------------------- widget

function buildWidgetStates() {
  const states = [];

  const empty = mkNode({ exclude: "" });
  stateOf(empty).base = emptyStats();
  states.push(["widget: no tokens at all", empty, { h: 120 }]);

  const few = mkNode({ exclude: "" });
  seedStats(few, CORPUS.slice(0, 1));
  states.push(["widget: few tokens", few, { h: 140 }]);

  const many = mkNode({ exclude: "" });
  seedStats(many, CORPUS);
  states.push(["widget: many tokens (scroll note)", many, { h: 160 }]);

  const excluded = mkNode({});
  seedStats(excluded, CORPUS);
  states.push(["widget: boilerplate hidden (footer)", excluded, { h: 160 }]);

  const hovered = mkNode({ exclude: "" });
  seedStats(hovered, CORPUS);
  stateOf(hovered).hoverKey = "cinematic";
  states.push(["widget: one token hovered (dimmed rest)", hovered, { h: 160 }]);

  const filtered = mkNode({ exclude: "", minCount: 5 });
  seedStats(filtered, CORPUS);
  states.push(["widget: min_count filters everything out", filtered, { h: 140 }]);

  const narrow = mkNode({ exclude: "" });
  seedStats(narrow, CORPUS);
  narrow.size = [180, 220];
  states.push(["widget: narrow node", narrow, { h: 160, w: 180 }]);

  const live = mkNode({ text: "raccoon, cinematic, dramatic lighting", exclude: "" });
  seedStats(live, CORPUS);
  states.push(["widget: live preview from the text box", live, { h: 160 }]);

  const topOne = mkNode({ exclude: "", topN: 1 });
  seedStats(topOne, CORPUS);
  states.push(["widget: top_n = 1", topOne, { h: 140 }]);

  return states;
}

// ---------------------------------------------------------------- graph

function buildGraphStates() {
  const states = [];
  const tokens = (texts, opts = {}) => {
    const stats = emptyStats();
    texts.forEach((t, i) => mergeRun(stats, t, opts.window || 3, i + 1));
    const rows = Object.keys(stats.tokens).map((k) => ({
      k, t: stats.tokens[k].display, n: stats.tokens[k].n, runs: stats.tokens[k].runs,
    }));
    const index = Object.create(null);
    rows.forEach((r, i) => { index[r.k] = i; });
    const edges = Object.keys(stats.pairs).map((key) => {
      const i = key.indexOf("\u0001");
      return [index[key.slice(0, i)], index[key.slice(i + 1)], stats.pairs[key]];
    }).filter((e) => e[0] !== undefined && e[1] !== undefined);
    return { rows, edges };
  };

  const small = tokens(CORPUS.slice(0, 2));
  const big = tokens(CORPUS);

  states.push(["graph: empty payload", [], [], "no tokens yet"]);
  states.push(["graph: one node, no edges", small.rows.slice(0, 1), [], null]);
  states.push(["graph: small graph", small.rows, small.edges, null]);
  states.push(["graph: bigger graph", big.rows, big.edges, null]);
  states.push(["graph: hovered node", big.rows, big.edges, null, { hoverKey: big.rows[0].k }]);
  states.push(["graph: pinned node", big.rows, big.edges, null, { selectedKey: big.rows[1] ? big.rows[1].k : null }]);
  states.push(["graph: hovered node with no edges", big.rows, [], null, { hoverKey: big.rows[0].k }]);
  states.push(["graph: many isolated nodes", big.rows, [], null]);
  states.push(["graph: tiny canvas", big.rows, big.edges, null, { w: 60, h: 50 }]);
  return states;
}

const failures = [];
const results = [];

for (const [label, node, opts] of buildWidgetStates()) {
  const widget = makeTokenWidget(node);
  const rec = recordingCtx("tg_widget.js");
  const w = opts.w || node.size[0];
  // two pre-existing frames stand in for the caller's (LiteGraph) own saves
  rec.ctx.save();
  rec.ctx.save();
  const depthIn = rec.depthNow();
  let threw = null;
  try {
    widget.draw(rec.ctx, node, w, 20, opts.h);
  } catch (e) {
    threw = e && e.message ? e.message : String(e);
  }
  const delta = rec.depthNow() - depthIn;
  if (delta !== 0 || threw) {
    failures.push({ state: label, delta, threw });
  }
  results.push({ state: label, delta, threw });
}

for (const [label, rows, edges, emptyText, opts] of buildGraphStates()) {
  const o = opts || {};
  const w = o.w || 520;
  const h = o.h || 380;
  const nodes = layout(rows, edges, w, h, (t) => t);
  const rec = recordingCtx("tg_panel.js");
  rec.ctx.save();
  const depthIn = rec.depthNow();
  let threw = null;
  try {
    drawGraph(rec.ctx, {
      nodes, edges, hoverKey: o.hoverKey || null, selectedKey: o.selectedKey || null,
    }, { width: w, height: h, emptyText });
  } catch (e) {
    threw = e && e.message ? e.message : String(e);
  }
  const delta = rec.depthNow() - depthIn;
  if (delta !== 0 || threw) {
    failures.push({ state: label, delta, threw });
  }
  results.push({ state: label, delta, threw });
}

console.log("canvas state balance — depth after draw() must equal depth before");
for (const r of results) {
  const mark = r.delta === 0 && !r.threw ? "ok  " : "FAIL";
  console.log(`  ${mark} ${r.state.padEnd(38)} delta=${r.delta}${r.threw ? " threw=" + r.threw : ""}`);
}

// Static shapes too: comments and dead branches must not be able to hide a
// real imbalance, so compare only executable occurrences.
for (const file of ["tg_widget.js", "tg_panel.js"]) {
  const src = fs.readFileSync(path.join(webDir, file), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const saves = (src.match(/ctx\.save\(\)/g) || []).length;
  const restores = (src.match(/ctx\.restore\(\)/g) || []).length;
  console.log(`\nstatic ${file} (comments stripped): save=${saves} restore=${restores}`);
  if (saves !== restores) {
    failures.push({ state: `static count ${file}`, delta: saves - restores });
  }
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
