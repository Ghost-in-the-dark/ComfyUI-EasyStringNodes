// "+ Add row" must put the new row where the user can see it.
//
// WHY THIS EXISTS
// ---------------
// Reported from ComfyUI: pressing "+ Add row" in the rows dialog left the user
// scrolling to the very end of the list to find the row they had just created.
//
// Two things combined to cause that, and both are reproduced here:
//
//   1. The handler appended the row (`rows.push`) to the END of a list that can
//      hold thousands of rows.
//   2. The list renders WINDOWED: applyFilter() builds at most RENDER_CHUNK (60)
//      cards and appends more only as the container is scrolled. So the new
//      row's card did not exist, `cardEls.get(row)` returned undefined, the
//      focus() call was skipped, and `list.scrollTop = list.scrollHeight` only
//      reached the bottom of the *rendered window* - not the real end.
//
// Measured on a 2000-row list (headless Chromium, real web/esn_dialog.js): the
// new row sat 10211px below the viewport, nothing was focused, and 60 of 2001
// cards existed. The row is now inserted at the TOP, which additionally matches
// how a new row is used - it is almost always the one being worked on next.
//
// The test drives the REAL showDialog() and clicks the REAL buttons; it does not
// reimplement the dialog or call an internal helper. A DOM shim is used because
// CI has no browser, and it models the one behaviour the bug depends on: the
// list is a scroller whose content is taller than its viewport, so renderChunk
// stops after one chunk, and clearing innerHTML drops focus that was inside it.
//
// The last check is the safety property that makes the top insertion acceptable:
// every existing row keeps its own # (orig) number, so presets and
// line_numbers still resolve through those numbers exactly as before.
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
    this.value = "";
    this.checked = false;
    this.type = "";
    this.title = "";
    this.placeholder = "";
    this.className = "";
    this.files = [];
    this.rows = 0;
    this.scrollTop = 0;
  }
  // a scroller whose content is taller than the viewport: this is what makes
  // renderChunk() stop after one chunk instead of building every card
  get clientHeight() { return VIEWPORT; }
  get scrollHeight() { return this.children.length * CARD_H; }
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

console.log("\n\"+ Add row\" puts the new row at the top\n");

const node = mkNode();
openEditor(node, null, "rows");

const list = findList();
check("the rows list exists", !!list);
if (!list) process.exit(1);

// --- the windowed rendering that caused the bug is really reproduced -------
check("the list renders only one window of cards", list.children.length === RENDER_CHUNK,
  `${list.children.length} cards for ${N_ROWS} rows, RENDER_CHUNK=${RENDER_CHUNK}`);
check("the list is far taller than its viewport", list.scrollHeight > list.clientHeight,
  `scrollHeight ${list.scrollHeight} vs clientHeight ${list.clientHeight}`);

// --- press the real button -------------------------------------------------
const addBtn = findButton("+ Add row");
check("the \"+ Add row\" button exists", !!addBtn);
if (!addBtn) process.exit(1);
addBtn.click();

const firstCard = list.children[0];
const firstRow = firstCard && firstCard.__esnRow;
check("a new row was added", firstRow && firstRow.num == null && firstRow.pos === "" && firstRow.neg === "",
  JSON.stringify(firstRow && { num: firstRow.num, pos: firstRow.pos }));
check("it is the FIRST row of the list", !!(firstRow && firstRow.num == null),
  `first card holds #${firstRow && firstRow.num}`);
check("the list is scrolled to the top, so no scrolling is needed",
  list.scrollTop === 0, `scrollTop=${list.scrollTop}`);
check("nothing had to be scrolled past", list.children.length >= 1 && list.children[0] === firstCard);

// focus: the caret must be in the new row's first field, ready to type
const focused = document.activeElement;
const focusedTa = focused && focused.tagName === "TEXTAREA" ? focused : null;
check("the new row's first field has focus", !!focusedTa,
  `activeElement is ${focused && focused.tagName}`);
check("focus is inside the card just added", !!(focusedTa && firstCard && firstCard.contains(focusedTa)));

// --- Save persists the new order ------------------------------------------
const saveBtn = findButton("Save");
check("the Save button exists", !!saveBtn);
if (saveBtn) saveBtn.click();

const saved = JSON.parse(widgetValue(node, "rows"));
check("all rows are saved", saved.length === N_ROWS + 1, `${saved.length} rows`);
check("the new row is saved FIRST", saved[0].num === null && saved[0].pos === "",
  `saved[0] = ${JSON.stringify({ num: saved[0].num, pos: saved[0].pos })}`);
// the safety property that makes a top insertion acceptable: an existing row
// keeps the # its presets and line_numbers address it by
check("the existing rows kept their original #",
  saved.slice(1).every((r, i) => r.num === 1000 + i),
  "numbers were renumbered or dropped");
check("the original first row is still addressed by its #",
  saved.slice(1)[0].num === 1000 && saved.slice(1)[0].pos === "row 0",
  JSON.stringify(saved.slice(1)[0]));

// --------------------------------------------------------------------------
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("\nall checks passed");
