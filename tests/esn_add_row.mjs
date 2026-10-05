// "+ Add row" must append the row AND show it, without the user scrolling.
//
// WHY THIS EXISTS
// ---------------
// Reported from ComfyUI: pressing "+ Add row" in the rows dialog left the user
// scrolling to the very end of the list to find the row they had just created.
//
// The cause was NOT the position of the row. The list renders WINDOWED:
// applyFilter() builds at most RENDER_CHUNK (60) cards and appends more only as
// the container is scrolled. An appended row therefore had no card element at
// all, so `cardEls.get(row)` returned undefined, the focus() call was skipped,
// and `list.scrollTop = list.scrollHeight` reached the bottom of the *rendered
// window* - not the end of the list. Measured on a 2000-row list (headless
// Chromium, real web/esn_dialog.js): 60 of 2001 cards existed, the new row sat
// 10211px below the viewport, and document.activeElement was <body>.
//
// So the fix is to build the cards up to the new row and then scroll to it. The
// row itself must stay at the END, which is asserted here as the primary
// property: a row with no explicit # is addressed by its 1-based POSITION, so
// inserting above the others renumbers every existing row and silently changes
// what presets and line_numbers select. Measured through the python node: a
// preset "1: 1 2" over three unnumbered rows returned "alpha, beta", and
// returned only "alpha" once a row was inserted above them. A revision of this
// dialog did insert at the top and broke exactly that; this test fails it.
//
// The test drives the REAL showDialog() and clicks the REAL buttons; it does not
// reimplement the dialog or call an internal helper. A DOM shim is used because
// CI has no browser, and it models the two behaviours the bug depends on: the
// list is a scroller whose content is taller than its viewport (so renderChunk
// stops after one chunk), and scrollTop is clamped to the scrollable range the
// way a browser clamps it.
//
// Run:  node tests/esn_add_row.mjs
// Exit: 0 pass, 1 on any failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "web");
const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "esn-addrow-"));

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

// --------------------------------------------------------------------------
// minimal DOM
// --------------------------------------------------------------------------
const VIEWPORT = 343;   // the list's clientHeight (measured in the browser)
const CARD_H = 200;     // a card is far taller than one row of the viewport

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this._listeners = {};
    this._text = null;
    this._scrollTop = 0;
    this.value = "";
    this.checked = false;
    this.type = "";
    this.title = "";
    this.placeholder = "";
    this.className = "";
    this.files = [];
    this.rows = 0;
  }
  // a scroller whose content is taller than the viewport: this is what makes
  // renderChunk() stop after one chunk instead of building every card
  get clientHeight() { return VIEWPORT; }
  get scrollHeight() { return this.children.length * CARD_H; }
  get scrollTop() { return this._scrollTop; }
  // a browser clamps scrollTop to the scrollable range; without this the test
  // would accept a scroll position no browser can actually reach
  set scrollTop(v) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    const n = Number(v);
    this._scrollTop = Math.min(Math.max(0, Number.isFinite(n) ? n : 0), max);
  }
  // where this card sits in its container
  get offsetTop() {
    if (!this.parentNode) return 0;
    return this.parentNode.children.indexOf(this) * CARD_H;
  }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }
  get textContent() {
    if (this._text != null) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return ""; }
  set innerHTML(_v) {
    // clearing the container detaches whatever was focused inside it: this is
    // why the old handler ended with nothing focused at all
    const ae = document.activeElement;
    const lost = ae && ae !== this && this.contains(ae);
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = null;
    if (lost) document.activeElement = document.body;
  }
  appendChild(node) {
    if (node && node.__fragment) {
      for (const c of node.children.slice()) this.appendChild(c);
      node.children = [];
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    const i = this.children.indexOf(ref);
    if (i < 0) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) { this.children.splice(i, 1); node.parentNode = null; }
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) {
    if (n === this) return true;
    for (const c of this.children) {
      if (typeof c.contains === "function" ? c.contains(n) : c === n) return true;
    }
    return false;
  }
  addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); }
  removeEventListener(t, f) {
    const a = this._listeners[t];
    if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }
  }
  dispatch(type, ev) {
    for (const f of (this._listeners[type] || []).slice()) {
      f(ev || { target: this, preventDefault() {}, stopPropagation() {} });
    }
  }
  click() { this.dispatch("click"); }
  // only a real field can take focus; a div/span focus() is a no-op, the way a
  // browser treats it
  focus() {
    if (this.tagName === "TEXTAREA" || this.tagName === "INPUT") {
      document.activeElement = this;
    }
  }
  blur() { if (document.activeElement === this) document.activeElement = document.body; }
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      if (matches(el, sel)) out.push(el);
      for (const c of el.children) walk(c);
    };
    for (const c of this.children) walk(c);
    return out;
  }
}

function matches(el, sel) {
  if (sel[0] === ".") return String(el.className || "").split(/\s+/).indexOf(sel.slice(1)) !== -1;
  const m = /^([a-zA-Z]+)\[([a-zA-Z-]+)="?([^"\]]*)"?\]$/.exec(sel);
  if (m) return el.tagName === m[1].toUpperCase() && String(el[m[2]]) === m[3];
  return el.tagName === sel.toUpperCase();
}

const document = {
  body: new El("body"),
  documentElement: new El("html"),
  activeElement: null,
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ tagName: "#text", textContent: String(t), children: [], parentNode: null, style: {} }),
  createDocumentFragment: () => ({
    __fragment: true, children: [],
    appendChild(n) { this.children.push(n); return n; },
  }),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [],
};
document.activeElement = document.body;

globalThis.document = document;
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
};
// the dialog lists dataset files on open; there is no server here
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });

const all = (root, pred) => {
  const out = [];
  const walk = (el) => {
    if (pred(el)) out.push(el);
    for (const c of el.children || []) walk(c);
  };
  walk(root);
  return out;
};

// --------------------------------------------------------------------------
const { openEditor } = await import(path.join(modDir, "esn_dialog.js"))
  .catch((e) => { console.error("import failed: " + e.message); process.exit(1); });
const { RENDER_CHUNK } = await import(path.join(modDir, "esn_core.js"));

const N_ROWS = 2000;

function mkNode() {
  const rows = [];
  for (let i = 0; i < N_ROWS; i++) {
    rows.push({ num: 1000 + i, cat: "", on: false, pos: "row " + i, neg: "", img: "", freq: 0 });
  }
  const w = (name, value) => ({ name, value, options: {}, callback: null });
  return {
    id: 1, type: "EasyStringNegEditor", size: [420, 300], properties: {},
    widgets: [
      w("rows", JSON.stringify(rows)),
      w("presets", "1: 1000 1001"),
      w("line_numbers", ""),
      w("select_all", false),
      w("use_preset", false),
      w("preset_line", 1),
      w("weight", 1.0),
      w("apply_weight", false),
      w("add_break", false),
      w("select_checked", false),
      w("preset_checked", false),
      w("data_file", ""),
      w("data_rev", 0),
    ],
    addCustomWidget(x) { this.widgets.push(x); },
    computeSize() { return [420, 300]; },
  };
}

const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(`${name}${detail ? " -- " + detail : ""}`);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? "  " + detail : ""}`);
}

const widgetValue = (node, name) => node.widgets.find((x) => x.name === name).value;
// the rows list is the only scroller the dialog creates
const findList = () => all(document.body, (el) => el.style.overflowY === "auto" && el.style.maxHeight === "56vh")[0] || null;
const findButton = (label) => all(document.body, (el) => el.tagName === "BUTTON" && el.textContent.trim() === label)[0] || null;

console.log("\n\"+ Add row\" appends the row at the end and shows it\n");

const node = mkNode();
const originalSaved = JSON.parse(widgetValue(node, "rows"));
openEditor(node, null, "rows");

const list = findList();
check("the rows list exists", !!list);
if (!list) process.exit(1);

// --- the windowed rendering that caused the bug is really reproduced -------
check("the list starts with only one window of cards", list.children.length === RENDER_CHUNK,
  `${list.children.length} cards for ${N_ROWS} rows, RENDER_CHUNK=${RENDER_CHUNK}`);
check("the list is far taller than its viewport", list.scrollHeight > list.clientHeight,
  `scrollHeight ${list.scrollHeight} vs clientHeight ${list.clientHeight}`);

// --- press the real button -------------------------------------------------
const addBtn = findButton("+ Add row");
check("the \"+ Add row\" button exists", !!addBtn);
if (!addBtn) process.exit(1);
addBtn.click();

// --- 1. the row is at the END, so no existing row is renumbered ------------
const lastCard = list.children[list.children.length - 1];
const lastRow = lastCard && lastCard.__esnRow;
check("a new empty row was added", !!lastRow && lastRow.num == null && lastRow.pos === "" && lastRow.neg === "",
  JSON.stringify(lastRow && { num: lastRow.num, pos: lastRow.pos }));
check("it is the LAST row of the list", !!(lastRow && lastRow.num == null),
  `last card holds #${lastRow && lastRow.num}`);
check("the row before it is still the original final row",
  !!(lastCard && list.children[list.children.length - 2] &&
     list.children[list.children.length - 2].__esnRow.num === 1000 + N_ROWS - 1),
  "an existing row was displaced");

// --- 2. it is visible, without the user scrolling -------------------------
check("every card up to the new row was built", list.children.length === N_ROWS + 1,
  `${list.children.length} cards, expected ${N_ROWS + 1}`);
const visibleTop = list.scrollTop;
const visibleBottom = list.scrollTop + list.clientHeight;
const cardTop = lastCard ? lastCard.offsetTop : -1;
const cardBottom = cardTop + CARD_H;
check("the list was scrolled to its end", visibleBottom >= list.scrollHeight - 1,
  `visibleBottom=${visibleBottom}, scrollHeight=${list.scrollHeight}`);
check("the new row is inside the visible area",
  cardTop >= visibleTop && cardBottom <= visibleBottom,
  `card [${cardTop}, ${cardBottom}] vs visible [${visibleTop}, ${visibleBottom}]`);

// focus: the caret must be in the new row's first field, ready to type
const focused = document.activeElement;
const focusedTa = focused && focused.tagName === "TEXTAREA" ? focused : null;
check("the new row's first field has focus", !!focusedTa,
  `activeElement is ${focused && focused.tagName}`);
check("focus is inside the card just added", !!(focusedTa && lastCard && lastCard.contains(focusedTa)));

// --- 3. Save keeps every original row exactly where it was ----------------
const saveBtn = findButton("Save");
check("the Save button exists", !!saveBtn);
if (saveBtn) saveBtn.click();

const saved = JSON.parse(widgetValue(node, "rows"));
check("all rows are saved", saved.length === N_ROWS + 1, `${saved.length} rows`);
check("the new row is saved LAST", saved[saved.length - 1].num === null && saved[saved.length - 1].pos === "",
  `saved[last] = ${JSON.stringify({ num: saved[saved.length - 1].num, pos: saved[saved.length - 1].pos })}`);

// THE regression this test exists for: positional addressing means the order of
// the existing rows is what presets and line_numbers resolve against, so not one
// of them may move or change. A top insertion fails here.
const existing = saved.slice(0, N_ROWS);
const unchanged = existing.every((r, i) =>
  r.num === originalSaved[i].num && r.pos === originalSaved[i].pos && r.cat === originalSaved[i].cat);
check("every existing row kept its position, # and content", unchanged,
  (() => {
    const i = existing.findIndex((r, k) => r.num !== originalSaved[k].num || r.pos !== originalSaved[k].pos);
    return i === -1 ? "" : `first difference at index ${i}: ` +
      JSON.stringify(existing[i]) + " vs " + JSON.stringify(originalSaved[i]);
  })());
check("the original first row is still row 1", saved[0].num === 1000 && saved[0].pos === "row 0",
  JSON.stringify({ num: saved[0].num, pos: saved[0].pos }));

// --------------------------------------------------------------------------
// per-row weight control in a card: the slider must drive row.weight and the
// value must survive Save -> the rows widget (it is what Python multiplies
// into every token of that row).
console.log("\nthe card's weight slider drives the saved row weight\n");

const node2 = mkNode();
openEditor(node2, 0, "rows"); // edit row #1 directly

const card = all(document.body, (el) => el.__esnRow)[0];
check("the edited row has a card", !!card);
const range = card ? all(card, (el) => el.tagName === "INPUT" && el.type === "range")[0] : null;
const numBox = card ? all(card, (el) => el.tagName === "INPUT" && el.type === "number")[0] : null;
check("the card has a range slider", !!range);
check("the card has a number box", !!numBox);
check("the slider spans the weight range", !!range && range.min === "0.1" && range.max === "10",
  range && `${range.min}..${range.max}`);
check("the slider starts at the neutral 1", !!range && Number(range.value) === 1,
  range && range.value);

if (range && numBox) {
  // dragging the slider: the browser fires "input" on every move
  range.value = "2.5";
  range.dispatch("input");
  check("dragging the slider writes row.weight", card.__esnRow.weight === 2.5,
    card.__esnRow.weight);
  check("the number box mirrors the slider", numBox.value === "2.5", numBox.value);

  // typing in the number box is the other direction
  numBox.value = "3";
  numBox.dispatch("input");
  check("typing a number writes row.weight", card.__esnRow.weight === 3,
    card.__esnRow.weight);
  check("the slider mirrors the number box", Number(range.value) === 3, range.value);

  // an out-of-range value is clamped, never stored raw
  numBox.value = "99";
  numBox.dispatch("change");
  check("an out-of-range weight is clamped to the maximum", card.__esnRow.weight === 10,
    card.__esnRow.weight);

  // reset button returns the row to neutral
  const resetBtn = findButton("1");
  check("the reset-to-1 button exists", !!resetBtn);
  if (resetBtn) {
    resetBtn.click();
    check("the reset button returns the row to 1", card.__esnRow.weight === 1,
      card.__esnRow.weight);
  }

  // double-click on the slider is the same reset, for the same reason as on
  // the node: hitting exactly 1.0 by dragging a log track is fiddly
  range.value = "3.5";
  range.dispatch("input");
  check("the slider can be set to 3.5", card.__esnRow.weight === 3.5, card.__esnRow.weight);
  range.dispatch("dblclick");
  check("double-clicking the slider resets the row to 1", card.__esnRow.weight === 1,
    card.__esnRow.weight);
  numBox.value = "2";
  numBox.dispatch("input");
  numBox.dispatch("dblclick");
  check("double-clicking the number box resets the row to 1", card.__esnRow.weight === 1,
    card.__esnRow.weight);

  // set a real weight and save: it must reach the rows widget
  range.value = "1.4";
  range.dispatch("input");
  const saveBtn2 = findButton("Save");
  if (saveBtn2) saveBtn2.click();
  const saved2 = JSON.parse(widgetValue(node2, "rows"));
  check("the row weight is saved into the rows widget", Number(saved2[0].weight) === 1.4,
    saved2[0].weight);
  check("only the edited row carries a weight change",
    saved2.slice(1).every((r) => Number(r.weight) === 1),
    saved2.slice(1, 3).map((r) => r.weight));
}

// --------------------------------------------------------------------------
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("\nall checks passed");
