// Per-row weight slider test for the EasyStringNegEditor canvas widget.
//
// WHY THIS EXISTS
// ---------------
// The node draws a weight slider inside every row. Two things are easy to get
// wrong and neither shows up in a screenshot:
//
//   1. COORDINATION WITH CLICK-TO-EDIT. Clicking a row opens the row dialog.
//      The slider lives inside that same row, so its pointer zone must be
//      tested BEFORE the "open the dialog" branch. If the order regresses,
//      dragging the slider opens a modal instead of changing the weight - and
//      the modal then swallows every later pointer event.
//
//   2. PERSISTENCE. A drag must reach the rows widget (widget mode) or bump
//      data_rev (dataset mode), exactly like a checkbox click does; a value
//      that only lives in the drawn state is lost on reload and never reaches
//      the prompt.
//
// The test drives the real mouse() handler on the real widget with a fake
// canvas and asserts both, plus the logarithmic mapping that puts 1.0 dead
// centre and round-trips.
//
// Run:  node tests/esn_row_weight.mjs
// Exit: 0 on success, 1 on the first failed assertion.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "web");
const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "esn-weight-"));

// The modules import ComfyUI's app.js as "../../scripts/app.js", so the copies
// must sit two levels below the stub (see canvas_balance.mjs for the details).
fs.mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
const appStub = { graph: { _nodes: [], setDirtyCanvas() {} }, registerExtension() {}, canvas: null };
fs.writeFileSync(
  path.join(tmpRoot, "scripts", "app.js"),
  "export const app = globalThis.__APP__;\n",
);
globalThis.__APP__ = appStub;
const modDir = path.join(tmpRoot, "pkg", "web");
fs.mkdirSync(modDir, { recursive: true });
for (const f of fs.readdirSync(webDir)) {
  if (f.endsWith(".js")) fs.copyFileSync(path.join(webDir, f), path.join(modDir, f));
}

// Minimal browser surface + a window that RECORDS pointer listeners, so a drag
// can be driven with the synthetic move/up events a real drag delivers.
const winListeners = { pointermove: [], pointerup: [], pointercancel: [], blur: [] };
globalThis.window = {
  addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
  removeEventListener(t, fn) {
    const a = winListeners[t];
    if (a) { const i = a.indexOf(fn); if (i !== -1) a.splice(i, 1); }
  },
  innerWidth: 1600, innerHeight: 900,
};
const fireWindow = (t, ev) => {
  for (const fn of (winListeners[t] || []).slice()) fn(ev);
};
const listenerCount = (t) => (winListeners[t] || []).length;
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  createElement() {
    return {
      style: {}, children: [], appendChild() {}, addEventListener() {},
      removeEventListener() {}, querySelectorAll: () => [],
    };
  },
  body: { appendChild() {} }, documentElement: { style: {} },
  querySelector: () => null,
};
if (typeof globalThis.CanvasRenderingContext2D === "undefined") {
  globalThis.CanvasRenderingContext2D = function () {};
  globalThis.CanvasRenderingContext2D.prototype = {};
}

const core = await import(path.join(modDir, "esn_core.js"));
const { state, makeListWidget } = { ...core, ...(await import(path.join(modDir, "esn_widget.js"))) };

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail === undefined ? "" : "  -> " + JSON.stringify(detail)));
  }
}

const NOOP = ["beginPath", "fill", "stroke", "fillRect", "rect", "roundRect", "moveTo", "lineTo",
  "arc", "arcTo", "closePath", "fillText", "drawImage", "translate", "scale", "clip",
  "setLineDash", "quadraticCurveTo", "bezierCurveTo", "strokeRect", "clearRect", "ellipse"];

function fakeCtx() {
  const ctx = { measureText: (t) => ({ width: String(t).length * 6 }), save() {}, restore() {} };
  for (const k of NOOP) ctx[k] = () => {};
  return ctx;
}

function mkNode(rows) {
  const widgets = [
    { name: "rows", value: JSON.stringify(rows), options: {} },
    { name: "presets", value: "", options: {} },
    { name: "data_file", value: "", options: {} },
    { name: "data_rev", value: 0, options: {} },
    { name: "line_numbers", value: "", options: {} },
    { name: "select_all", value: true, options: {} },
    { name: "preset_checked", value: false, options: {} },
    { name: "preset_trigger", value: "", options: {} },
  ];
  const node = {
    id: 1, type: "EasyStringNegEditor", pos: [0, 0], size: [340, 540],
    properties: {}, widgets, addCustomWidget(w) { this.widgets.push(w); },
  };
  const st = state(node);
  st.rows = core.cleanRows(rows);
  st.raw = JSON.stringify(rows);
  st.presets = "";
  return node;
}

const ROWS = [
  { num: 1, cat: "", on: false, pos: "cat", neg: "dog", img: "", freq: 0, weight: 1 },
  { num: 2, cat: "", on: false, pos: "bird", neg: "", img: "", freq: 0, weight: 2.5 },
];

// ---------------------------------------------------------------------------
console.log("log slider mapping (a multiplier needs a log track: 1.0 centred)");

check("frac 0 -> min 0.1", core.weightFromFrac(0) === 0.1, core.weightFromFrac(0));
check("frac 0.5 -> 1.0 (centre is neutral)", core.weightFromFrac(0.5) === 1,
  core.weightFromFrac(0.5));
check("frac 1 -> max 10", core.weightFromFrac(1) === 10, core.weightFromFrac(1));
check("1.0 sits exactly at frac 0.5", Math.abs(core.fracFromWeight(1) - 0.5) < 1e-9,
  core.fracFromWeight(1));
check("frac clamps below 0", core.weightFromFrac(-5) === 0.1, core.weightFromFrac(-5));
check("frac clamps above 1", core.weightFromFrac(5) === 10, core.weightFromFrac(5));

// round-trip: frac -> weight -> frac must be stable all along the track
let worst = 0;
for (let i = 0; i <= 100; i++) {
  const f = i / 100;
  worst = Math.max(worst, Math.abs(core.fracFromWeight(core.weightFromFrac(f)) - f));
}
check("frac <-> weight round-trips across the track", worst < 0.02, worst);

// the usable range must not be crushed into one end (the reason for the log
// scale): 0.5..2 has to occupy a decent share of the track. On a LOG track
// that share is log_100(2) - log_100(0.5) = 0.301; a LINEAR track would give
// only 15% and would put the neutral 1.0 at 9% of the width.
const share = core.fracFromWeight(2) - core.fracFromWeight(0.5);
check("0.5..2.0 spans >= 30% of the track (linear would give 15%)", share >= 0.3, share);
const neutralAt = core.fracFromWeight(1);
check("neutral 1.0 is centred, not 9% from the left",
  Math.abs(neutralAt - 0.5) < 1e-9, neutralAt);

check("formatWeightLabel(1) is '1'", core.formatWeightLabel(1) === "1", core.formatWeightLabel(1));
check("formatWeightLabel(10) is '10'", core.formatWeightLabel(10) === "10", core.formatWeightLabel(10));
check("formatWeightLabel(2.5) is '2.5'", core.formatWeightLabel(2.5) === "2.5",
  core.formatWeightLabel(2.5));

// ---------------------------------------------------------------------------
console.log("\nrow hit geometry + drag behaviour");

const node = mkNode(ROWS);
const widget = makeListWidget(node);
const ctx = fakeCtx();
widget.draw(ctx, node, 340, 20, 540);

const st = state(node);
check("a hit rect was recorded per drawn row", st.rects.length === 2, st.rects.length);
check("each row carries a weight zone", st.rects.every((r) => !!r.weight),
  st.rects.map((r) => !!r.weight));

const z0 = st.rects[0].weight;
const z1 = st.rects[1].weight;
// the zone must be a real target, not a hairline: >= 24 px wide, and as tall
// as the row allows (22 px, the existing row pitch)
check("weight zone is >= 24px wide", z0.w >= 24, z0.w);
check("weight zone is as tall as the row", z0.h >= 20 && z0.h <= 22, z0.h);
check("zone is inside the node width", z0.x + z0.w <= 340, [z0.x, z0.w]);
check("zone does not collide with the row-number column", z0.x > 40, z0.x);
check("zones of different rows do not overlap vertically",
  st.rects[0].bottom <= st.rects[1].top + 1);

// The slider must never be drawn ON TOP of the category chip: that chip is
// clickable (it filters the list), so a slider zone covering it would make the
// category un-clickable and its label unreadable. On a node too narrow for
// both, the slider is omitted instead - the invariant is therefore "either
// absent, or clear of the chip and inside the node".
{
  const probe = [
    { cat: "averylongcategoryname", img: "", freq: 3, w: 220 },
    { cat: "averylongcategoryname", img: "", freq: 3, w: 420 },
    { cat: "artists", img: "", freq: 3, w: 260 },
    { cat: "", img: "ref.png", freq: 3, w: 220 },
    { cat: "", img: "", freq: 0, w: 220 },
  ];
  let overlaps = 0, drawn = 0, hidden = 0;
  const seen = [];
  for (const c of probe) {
    const nd = mkNode([{ num: 1, cat: c.cat, on: false, pos: "a fairly long positive prompt here",
      neg: "", img: c.img, freq: c.freq, weight: 2 }]);
    const wd = makeListWidget(nd);
    wd.draw(fakeCtx(), nd, c.w, 20, 540);
    const r = state(nd).rects[0] || {};
    const catEnd = r.catW ? 52 + r.catW : 0;
    if (!r.weight) {
      hidden++;
    } else {
      drawn++;
      if (r.weight.x < catEnd) { overlaps++; seen.push({ ...c, catEnd, x: r.weight.x }); }
      if (r.weight.x + r.weight.w > c.w) { overlaps++; seen.push({ ...c, tooWide: true }); }
    }
  }
  check("the slider never overlaps a category chip on a narrow node", overlaps === 0, seen);
  check("the slider is drawn where there is room and hidden where there is not",
    drawn > 0 && hidden > 0, { drawn, hidden });
}

// A drag must change the weight AND persist it, and must NOT open the dialog.
function mouse(x, y, type = "pointerdown", extra = {}) {
  const ev = {
    type, clientX: x, clientY: y, buttons: 1, pointerId: 1,
    preventDefault() {}, stopPropagation() {}, ...extra,
  };
  widget.mouse(ev, [x, y], node);
}

// grab the middle of the track of row 2 (weight 2.5) -> drag right to max
const grabX = z1.trackX + z1.trackW / 2;
const grabY = z1.y + z1.h / 2;
mouse(grabX, grabY, "pointerdown");
check("grabbing the track starts a weight drag", state(node).draggingWeight === true,
  state(node).draggingWeight);
check("the dragged row is remembered", state(node).weightRowIndex === 1,
  state(node).weightRowIndex);
check("drag installs a window pointermove listener", listenerCount("pointermove") === 1,
  listenerCount("pointermove"));

// far to the right of the track == maximum weight
fireWindow("pointermove", {
  clientX: grabX + 500, clientY: grabY, buttons: 1,
  preventDefault() {}, stopPropagation() {},
});
check("dragging right raises the weight to the max", core.cleanWeight(state(node).rows[1].weight) === 10,
  state(node).rows[1].weight);

// Now drag far LEFT in a second move. This is the regression that matters:
// commitRows() replaces every row object, so if the drag held a captured row
// reference the second move would write to a DETACHED object and the value
// would stay at 10 instead of falling back to the minimum.
fireWindow("pointermove", {
  clientX: grabX - 500, clientY: grabY, buttons: 1,
  preventDefault() {}, stopPropagation() {},
});
check("dragging left lowers the weight to the min (rows are re-resolved each move)",
  core.cleanWeight(state(node).rows[1].weight) === 0.1, state(node).rows[1].weight);

// and it still persists after that second move
check("the second move is persisted into the rows widget",
  core.cleanWeight(JSON.parse(node.widgets.find((w) => w.name === "rows").value)[1].weight) === 0.1,
  JSON.parse(node.widgets.find((w) => w.name === "rows").value)[1].weight);

// releasing ends the drag and removes the window listeners
fireWindow("pointerup", {});
check("pointerup ends the drag", state(node).draggingWeight === false,
  state(node).draggingWeight);
check("pointerup removes the window pointermove listener",
  listenerCount("pointermove") === 0, listenerCount("pointermove"));

// a move with the button released must also end the drag (lost-pointerup net)
mouse(z1.trackX + 4, grabY, "pointerdown");
check("re-grabbing starts a fresh drag", state(node).draggingWeight === true);
fireWindow("pointermove", {
  clientX: grabX, clientY: grabY, buttons: 0,
  preventDefault() {}, stopPropagation() {},
});
check("a move with no button pressed ends the drag",
  state(node).draggingWeight === false, state(node).draggingWeight);

// ---------------------------------------------------------------------------
console.log("\nclicking the value resets to 1 instead of opening the dialog");

const node2 = mkNode(ROWS);
const w2 = makeListWidget(node2);
w2.draw(fakeCtx(), node2, 340, 20, 540);
const st2 = state(node2);
const z = st2.rects[1].weight;
check("row 2 starts at its stored 2.5", core.cleanWeight(st2.rows[1].weight) === 2.5,
  st2.rows[1].weight);
const ev = {
  type: "pointerdown", clientX: z.labelX + z.labelW / 2, clientY: z.y + z.h / 2,
  buttons: 1, pointerId: 1, preventDefault() {}, stopPropagation() {},
};
const handled = w2.mouse(ev, [ev.clientX, ev.clientY], node2);
check("the click is consumed by the node", handled === true, handled);
check("clicking the value resets the row to 1", core.cleanWeight(st2.rows[1].weight) === 1,
  st2.rows[1].weight);
check("no weight drag was started by the reset click",
  !state(node2).draggingWeight, state(node2).draggingWeight);

// A click far LEFT of the slider must still open the row dialog (the normal
// click-to-edit path has to keep working). openEditor() builds a DOM dialog,
// so that path is only exercised up to the point where it needs a real
// document: we assert the WEIGHT branch was not taken (which is what would
// break click-to-edit) and that the keyboard/mouse routing reaches openEditor.
const node3 = mkNode(ROWS);
const w3 = makeListWidget(node3);
w3.draw(fakeCtx(), node3, 340, 20, 540);
const st3 = state(node3);
const r0 = st3.rects[0];
let reachedOpenEditor = false;
globalThis.document.createElement = () => {
  reachedOpenEditor = true;
  // a minimal element good enough for the dialog builder to keep going
  const el = {
    style: {}, dataset: {}, children: [], value: "", textContent: "", innerHTML: "",
    appendChild() {}, addEventListener() {}, removeEventListener() {}, remove() {},
    querySelectorAll: () => [], querySelector: () => null,
    setAttribute() {}, getAttribute: () => null, focus() {}, blur() {},
    classList: { add() {}, remove() {}, toggle() {} },
  };
  return el;
};
const labelClick = {
  type: "pointerdown", clientX: 60, clientY: (r0.top + r0.bottom) / 2,
  buttons: 1, pointerId: 1, preventDefault() {}, stopPropagation() {},
};
let threw = null;
try {
  w3.mouse(labelClick, [labelClick.clientX, labelClick.clientY], node3);
} catch (e) {
  threw = e && e.message ? e.message : String(e);
}
check("a click on the row label does NOT start a weight drag",
  !state(node3).draggingWeight, state(node3).draggingWeight);
check("a click on the row label falls through to click-to-edit",
  reachedOpenEditor || threw !== null, { reachedOpenEditor, threw });

// ---------------------------------------------------------------------------
console.log("\ndouble-click on the control resets the row to 1");

// Press exactly ON THE TRACK (not the value label), twice, quickly. A single
// press there starts a drag instead of resetting, so this is the gesture that
// has to be added: without it, getting a log slider back to exactly 1.0 means
// hunting for the centre of the track.
{
  const nd = mkNode([
    { num: 1, cat: "", on: false, pos: "cat", neg: "", img: "", freq: 0, weight: 4 },
  ]);
  const wd = makeListWidget(nd);
  wd.draw(fakeCtx(), nd, 340, 20, 540);
  const s = state(nd);
  const zone = s.rects[0].weight;
  // grab the track well away from the label, so the label's own reset
  // shortcut cannot be what makes this pass
  const trackX = zone.trackX + zone.trackW * 0.75;
  const trackY = zone.y + zone.h / 2;
  const press = (x, y) => {
    const e = {
      type: "pointerdown", clientX: x, clientY: y, buttons: 1, pointerId: 1,
      preventDefault() {}, stopPropagation() {},
    };
    return wd.mouse(e, [x, y], nd);
  };

  check("row starts at its stored 4", core.cleanWeight(s.rows[0].weight) === 4,
    s.rows[0].weight);

  // first press: starts a drag (it must NOT reset yet)
  press(trackX, trackY);
  check("the first press on the track starts a drag, not a reset",
    s.draggingWeight === true && core.cleanWeight(s.rows[0].weight) === 4,
    { dragging: s.draggingWeight, weight: s.rows[0].weight });
  fireWindow("pointerup", {});

  // second press within the double-click window: resets to 1
  press(trackX, trackY);
  check("a second quick press on the track resets the row to 1",
    core.cleanWeight(s.rows[0].weight) === 1, s.rows[0].weight);
  check("the reset press does not leave a drag running",
    s.draggingWeight === false, s.draggingWeight);
  check("the reset is persisted into the rows widget",
    core.cleanWeight(JSON.parse(nd.widgets.find((w) => w.name === "rows").value)[0].weight) === 1,
    JSON.parse(nd.widgets.find((w) => w.name === "rows").value)[0].weight);
  fireWindow("pointerup", {});
}

// A DRAG followed by a click must NOT be read as a double-click: that would
// silently throw away the value the user just dragged to.
{
  const nd = mkNode([
    { num: 1, cat: "", on: false, pos: "cat", neg: "", img: "", freq: 0, weight: 1 },
  ]);
  const wd = makeListWidget(nd);
  wd.draw(fakeCtx(), nd, 340, 20, 540);
  const s = state(nd);
  const zone = s.rects[0].weight;
  const y = zone.y + zone.h / 2;
  const press = (x) => {
    const e = {
      type: "pointerdown", clientX: x, clientY: y, buttons: 1, pointerId: 1,
      preventDefault() {}, stopPropagation() {},
    };
    return wd.mouse(e, [x, y], nd);
  };

  press(zone.trackX + zone.trackW * 0.5);
  fireWindow("pointermove", {
    clientX: zone.trackX + zone.trackW * 0.95, clientY: y, buttons: 1,
    preventDefault() {}, stopPropagation() {},
  });
  const draggedTo = core.cleanWeight(s.rows[0].weight);
  check("the drag raised the weight above 1", draggedTo > 1, draggedTo);
  fireWindow("pointerup", {});

  // a click within the double-click window, but after a DRAG: keep the value
  press(zone.trackX + zone.trackW * 0.5);
  check("a click after a drag does not reset the dragged value",
    core.cleanWeight(s.rows[0].weight) > 1, s.rows[0].weight);
  fireWindow("pointerup", {});
}

// Two presses on DIFFERENT rows are not a double-click.
{
  const nd = mkNode([
    { num: 1, cat: "", on: false, pos: "cat", neg: "", img: "", freq: 0, weight: 5 },
    { num: 2, cat: "", on: false, pos: "dog", neg: "", img: "", freq: 0, weight: 5 },
  ]);
  const wd = makeListWidget(nd);
  wd.draw(fakeCtx(), nd, 340, 20, 540);
  const s = state(nd);
  const press = (r) => {
    const z = s.rects[r].weight;
    const x = z.trackX + z.trackW * 0.75, y = z.y + z.h / 2;
    const e = {
      type: "pointerdown", clientX: x, clientY: y, buttons: 1, pointerId: 1,
      preventDefault() {}, stopPropagation() {},
    };
    wd.mouse(e, [x, y], nd);
    fireWindow("pointerup", {});
  };
  press(0);
  press(1);
  check("presses on two different rows do not reset either one",
    core.cleanWeight(s.rows[0].weight) === 5 && core.cleanWeight(s.rows[1].weight) === 5,
    [s.rows[0].weight, s.rows[1].weight]);
}

// ---------------------------------------------------------------------------
console.log("\nrow.weight survives a clean/dump round-trip");

const dumped = core.dumpRows(core.cleanRows(ROWS));
const back = JSON.parse(dumped);
check("weight is preserved through cleanRows -> dumpRows",
  core.cleanWeight(back[1].weight) === 2.5, back[1].weight);
check("a missing weight defaults to 1",
  core.cleanWeight({}).weight === undefined
    ? true
    : core.cleanWeight(undefined) === 1, core.cleanWeight(undefined));
check("cleanRows fills a default weight", core.cleanRows([{ pos: "x" }])[0].weight === 1,
  core.cleanRows([{ pos: "x" }])[0].weight);

if (failed) {
  console.log(`\nFAILED: ${failed} assertion(s).`);
  process.exit(1);
}
console.log("\nPASS: the row weight slider drags, persists and never steals the row click.");
