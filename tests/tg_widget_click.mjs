// The on-node "show graph" button must actually respond to a click.
//
// WHY THIS EXISTS
// ---------------
// ComfyUI hands a custom widget two different coordinate frames:
//
//   draw(ctx, node, width, y, height)   y is the widget's TOP in node space
//   mouse(event, pos, node)             pos is relative to the widget's top
//
// The strip drew its button at `y + 2` but hit-tested `pos[1] <= HEADER_H + 4`,
// i.e. as if pos were already widget-relative while nothing recorded where the
// widget had been drawn. Nothing failed loudly: the button rendered perfectly
// and simply did nothing when clicked, which is exactly the bug reported from
// ComfyUI ("кнопка show graph не работает").
//
// The pack's other canvas widget gets this right by remembering the draw
// position (web/esn_widget.js: st.widgetY = y in draw(), then
// `y >= st.widgetY - 1 && y <= st.widgetY + HEADER_H` in mouse()).
//
// This test drives draw() and mouse() with the SAME number for the widget's
// origin, the way the front-end does, and asserts the click lands.
//
// Run:  node tests/tg_widget_click.mjs
// Exit: 0 pass, 1 on any failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "web");
const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "tg-click-"));

// Modules import ComfyUI's app as "../../scripts/app.js": <tmp>/pkg/web/*.js
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
const made = [];
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  createElement() {
    const el = {
      style: {}, dataset: {}, className: "", children: [], innerHTML: "", textContent: "",
      appendChild(c) { this.children.push(c); return c; },
      removeChild() {}, addEventListener() {}, removeEventListener() {},
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
      querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 320, height: 240, left: 0, top: 0, right: 320, bottom: 240 }),
      getContext: () => null, remove() {}, focus() {}, blur() {}, click() {},
    };
    made.push(el);
    return el;
  },
  createDocumentFragment() { return { appendChild() {} }; },
  body: { appendChild() {} }, documentElement: { style: {} },
  querySelector: () => null, querySelectorAll: () => [],
};

const { makeTokenWidget, HEADER_H, PAD } = await import(path.join(modDir, "tg_widget.js"));
const { stateOf, isPanelOpen } = await import(path.join(modDir, "tg_panel.js"));
const { mergeRun, emptyStats } = await import(path.join(modDir, "tg_tokens.js"));

const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(`${name}${detail ? " -- " + detail : ""}`);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? "  " + detail : ""}`);
}

function mkNode() {
  return {
    id: 1, type: "EasyStringTokenGraph", size: [420, 320], properties: {},
    widgets: [
      { name: "text", value: "raccoon, cinematic, best quality", options: {} },
      { name: "stats_file", value: "tokens", options: {} },
      { name: "reset", value: false, options: {} },
      { name: "window", value: 3, options: {} },
      { name: "top_n", value: 40, options: {} },
      { name: "min_count", value: 1, options: {} },
      { name: "exclude", value: "best quality", options: {} },
      { name: "position", value: "floating", options: {} },
    ],
  };
}

// A recording 2D context: enough for the strip to draw, and it keeps the
// rounded-rect bounds so the test can find the button's real geometry.
function mkCtx() {
  const noop = () => {};
  const stack = [];
  const rects = [];
  const ctx = {
    canvas: { width: 420, height: 400 },
    font: "", textAlign: "", textBaseline: "", fillStyle: "", strokeStyle: "", lineWidth: 1,
    globalAlpha: 1,
    save() { stack.push(1); }, restore() { stack.pop(); },
    measureText: (s) => ({ width: String(s).length * 6 }),
    beginPath: noop, closePath: noop, stroke: noop, moveTo: noop, lineTo: noop, arc: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, clip: noop, setLineDash: noop,
    translate: noop, scale: noop, rotate: noop, setTransform: noop, clearRect: noop,
    fillText: noop, strokeText: noop, fill: noop,
    fillRect: (x, y, w, h) => rects.push({ x, y, w, h }),
    roundRect: (x, y, w, h) => rects.push({ x, y, w, h }),
  };
  return { ctx, rects };
}

console.log("on-node \"show graph\" button\n");

// --- the click lands on the button where it is drawn ----------------------
for (const originY of [200, 260, 310]) {
  const node = mkNode();
  const st = stateOf(node);
  st.base = emptyStats();
  mergeRun(st.base, "raccoon, cinematic, best quality", 3, 1);
  const widget = makeTokenWidget(node);
  const { ctx, rects } = mkCtx();
  const height = widget.computeSize(420)[1];
  widget.draw(ctx, node, 420, originY, height);

  // the button is the first rounded rect the widget paints
  const btn = rects[0];
  check(`widget drawn at y=${originY} paints a button`, !!btn && btn.h > 0,
    btn ? `w=${btn.w} h=${btn.h}` : "no rounded rect");
  if (!btn) continue;

  // The front-end passes pos in the same frame it passed y to draw(). Every
  // point inside the PAINTED rectangle must toggle; the centre and all four
  // corners are checked so the hit test cannot be tied to one lucky offset.
  const cx = btn.x + btn.w / 2;
  const cy = btn.y + btn.h / 2;
  const points = [
    ["centre", cx, cy],
    ["top-left", btn.x + 3, btn.y + 3],
    ["top-right", btn.x + btn.w - 3, btn.y + 3],
    ["bottom-left", btn.x + 3, btn.y + btn.h - 3],
    ["bottom-right", btn.x + btn.w - 3, btn.y + btn.h - 3],
  ];
  let allOpen = true;
  const misses = [];
  for (const [name, px, py] of points) {
    if (isPanelOpen(node)) widget.mouse({ type: "pointerdown", button: 0 }, [cx, cy], node);
    const wasClosed = isPanelOpen(node) === false;
    const hit = widget.mouse({ type: "pointerdown", button: 0 }, [px, py], node);
    const nowOpen = isPanelOpen(node) === true;
    if (!(hit === true && wasClosed && nowOpen)) {
      allOpen = false;
      misses.push(`${name}@(${px},${py}) handled=${hit} open=${nowOpen}`);
    }
  }
  if (isPanelOpen(node)) widget.mouse({ type: "pointerdown", button: 0 }, [cx, cy], node);
  check(`  every point inside the painted button toggles the panel (y=${originY})`,
    allOpen && made.length > 0, misses.join("; ") + ` domEls=${made.length}`);

  // ...and just OUTSIDE the painted rectangle nothing happens, so the hit area
  // cannot simply be "the whole header row".
  const outside = [
    ["above the button", btn.x + btn.w / 2, btn.y - 6],
    ["below the button", btn.x + btn.w / 2, btn.y + btn.h + 6],
    ["left of the button", btn.x - 8, cy],
    ["right of the button", btn.x + btn.w + 8, cy],
  ];
  let allMissed = true;
  const wrongHits = [];
  for (const [name, px, py] of outside) {
    const hit = widget.mouse({ type: "pointerdown", button: 0 }, [px, py], node);
    if (hit === true || isPanelOpen(node)) { allMissed = false; wrongHits.push(name); }
  }
  check(`  clicks outside the painted button are ignored (y=${originY})`,
    allMissed, wrongHits.join(", "));
}

// --- a click elsewhere must NOT be swallowed ------------------------------
{
  const node = mkNode();
  const widget = makeTokenWidget(node);
  const { ctx } = mkCtx();
  const height = widget.computeSize(420)[1];
  widget.draw(ctx, node, 420, 200, height);
  const before = isPanelOpen(node);
  // a token row, well below the header
  const hit = widget.mouse({ type: "pointerdown", button: 0 }, [30, 200 + HEADER_H + 20], node);
  check("a click on a token row is not treated as the button",
    hit === false && isPanelOpen(node) === before, `handled=${hit}`);
  // empty space to the right of the button in the header row
  const hit2 = widget.mouse({ type: "pointerdown", button: 0 }, [PAD + 240, 200 + 6], node);
  check("a click right of the button (same row) is not the button",
    hit2 === false && isPanelOpen(node) === before, `handled=${hit2}`);
}

// --- non-click events never toggle ---------------------------------------
{
  const node = mkNode();
  const widget = makeTokenWidget(node);
  const { ctx } = mkCtx();
  widget.draw(ctx, node, 420, 200, widget.computeSize(420)[1]);
  const before = isPanelOpen(node);
  widget.mouse({ type: "pointermove" }, [PAD + 6, 206], node);
  check("a hover over the button does not toggle the panel",
    isPanelOpen(node) === before);
  widget.mouse({ type: "pointerdown", button: 2 }, [PAD + 6, 206], node);
  check("a right-click does not toggle the panel", isPanelOpen(node) === before);
}

// --- the widget must remember where it was drawn -------------------------
{
  const node = mkNode();
  const widget = makeTokenWidget(node);
  const { ctx } = mkCtx();
  widget.draw(ctx, node, 420, 275, widget.computeSize(420)[1]);
  const st = stateOf(node);
  const recorded = st.widgetY;
  check("draw() records the widget's origin in node state",
    typeof recorded === "number" && recorded === 275,
    `widgetY=${JSON.stringify(recorded)}`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log();
if (failures.length) {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
console.log("PASS: the strip's button toggles the panel from its real position.");
