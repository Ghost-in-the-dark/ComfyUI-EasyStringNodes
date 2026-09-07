// EasyStringNegEditor — front-end row editor.
//
// Adds a visual row list + "Rows / Presets" dialog to the EasyStringNegEditor
// node. Compatible with BOTH the legacy ComfyUI web UI and the new
// ComfyUI_frontend based UI.
//
// v1.5.5: on-node search bar (filters by num/cat/pos/neg), a usage-frequency
// ranking (×N counters fed back from Python through onExecuted, header ⇅ sort
// and dialog ⇅ by use), and a draggable scrollbar for long row lists.
//
// Data model
// ----------
// The python "rows" STRING(multiline) widget stays the single source of
// truth for rows (JSON: [{num?, cat?, on?, pos, neg, img}, ...]) and is left fully
//   num - optional original number (kept from old-data import)
//   cat - optional category label (filters / groups the row list)
//   on  - checkbox flag: rows ticked here are used when the node input
//         select_checked is on (manual pick mode)
// and is left fully
// serializable, so workflows / copy-paste / API prompts keep working through
// the stock mechanisms on both front-ends. The python "presets" STRING
// widget holds one preset per line ("N: row numbers"). Both text widgets are
// hidden from the node body:
//   * legacy: zero-size layout + element display:none
//   * new:    widget.hidden = true (options.hidden)
// Our own canvas widget is APPENDED AFTER every python widget (so positional
// widget indices never shift) and draws the row list + the Add/Edit button.
// It is marked options.serialize = false and widget.serialize = false, so it
// never reaches the API prompt and never enters widgets_values.
//
// Editor dialog
// -------------
// Plain DOM overlay on document.body (works above either UI shell) with two
// tabs:
//   Rows    - compact, searchable row list; click a row to edit it in an
//             inline card (Positive / Negative textareas, optional original
//             number, image via file picker / drag&drop). Import old
//             numbered datasets ("N: text ~") into the negative field.
//   Presets - raw preset text "N: row numbers" (one per line) plus an
//             importer for pasted preset blocks.
// Images are downscaled to a data URL embedded in the row JSON (keeps the
// workflow self-contained). Hovering a drawn row shows a floating preview
// with that row's image.

import { app } from "../../scripts/app.js";

const NODE_CLASS = "EasyStringNegEditor";
const ROWS_NAME = "rows";
const PRESETS_NAME = "presets";
const DATA_NAME = "data_file";
const UI_NAME = "rows_list";
const MAX_DRAWN_ROWS = 9;
const WHEEL_STEP = 3;
const PRESET_WHEEL_STEP = 2; // wheel notches per preset-list scroll
const RENDER_CHUNK = 60;

const ROW_H = 20; // px per drawn row
const HEADER_H = 24;
const SEARCH_H = 20; // px of the always-visible search bar below the header
const FREQ_W = 26; // px reserved on the right of a row for the usage counter
const SB_W = 9; // scrollbar track width for the rows list
// presets section drawn below the row list on the node canvas
const MAX_DRAWN_PRESETS = 4; // preset lines visible on the node
const PRESET_H = 16; // px per preset line
const PRESET_HDR_H = 18; // px for the "Presets" section header
const PRESET_GAP = 4; // px above the section
const IMG_MAX_EDGE = 384;
const IMG_QUALITY = 0.82;
const NL = String.fromCharCode(10); // newline without backslash escapes
const CR = String.fromCharCode(13);

// CanvasRenderingContext2D.roundRect is Chrome 99+; older engines used by
// embedded webviews may lack it, so fall back to plain rects.
if (typeof CanvasRenderingContext2D !== "undefined" &&
    !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (typeof r === "number") r = [r, r, r, r];
    if (!Array.isArray(r)) r = [0, 0, 0, 0];
    this.rect(x, y, w, h);
    return this;
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isDigits(s) {
  s = String(s == null ? "" : s);
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c < "0" || c > "9") return false;
  }
  return true;
}

function parseRows(raw) {
  if (typeof raw !== "string") raw = "";
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function cleanRows(rows) {
  const out = [];
  for (const item of rows || []) {
    const row = item && typeof item === "object" ? item : {};
    let num = null;
    if (row.num != null) {
      const n = Number(row.num);
      if (Number.isInteger(n) && n >= 0) num = n;
    }
    let on = true;
    if (row.on === false || row.on === 0 || row.on === "0") on = false;
    else if (typeof row.on === "string") {
      const v = row.on.trim().toLowerCase();
      if (v === "" || v === "false" || v === "0" || v === "no" || v === "off") on = false;
    }
    let freq = 0;
    if (typeof row.freq === "number" && Number.isFinite(row.freq) && row.freq > 0) {
      freq = Math.floor(row.freq);
    } else if (typeof row.freq === "string") {
      const n = Number(row.freq);
      if (Number.isFinite(n) && n > 0) freq = Math.floor(n);
    }
    out.push({
      num: num,
      cat: typeof row.cat === "string" ? row.cat : "",
      on: on,
      pos: typeof row.pos === "string" ? row.pos : "",
      neg: typeof row.neg === "string" ? row.neg : "",
      img: typeof row.img === "string" ? row.img : "",
      freq: freq,
    });
  }
  return out;
}

function dumpRows(rows) {
  return JSON.stringify(rows || []);
}

function clampText(t, max) {
  t = String(t == null ? "" : t);
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + String.fromCharCode(8230); // ellipsis
}

function state(node) {
  if (!node.__esn) {
    node.__esn = {
      rows: [],
      raw: null,
      presets: "",
      search: "", // active filter text (typed in the on-node search bar)
      searchFocus: false, // is the on-node search field focused?
      view: [], // [{row, oi}] rows matching st.search (oi = index in st.rows)
      draggingSb: false, // dragging the rows scrollbar thumb
      sbStartY: 0, sbStartNodeY: 0, sbStartClientY: 0, sbScale: 1, sbGrabOffset: 0, sbZone: null,
      sortBtn: null, // header sort control hit zone
      sortedByFreq: false,
      freqOrderBackup: null, // pre-sort order for the header toggle
      // per-row node-local rects set during draw
      rects: [],
      widgetY: 0,
      widgetH: 0,
      scroll: 0, // rows scrolled past the top on the node canvas
      rowsAreaBottom: 0, // bottom (node-local y) of the drawn rows area
      presetScroll: 0, // presets scrolled past the top of the presets section
      presetListArea: null, // {top,bottom} of drawn preset lines (when overflowing)
      presetRects: [], // {top,bottom,num,content} hit zones of preset lines
      presetsHeader: null, // {top,bottom} hit zone of the section header
      presetUp: null, // {top,bottom} hit zone of the presets ▲
      presetDown: null, // {top,bottom} hit zone of the presets ▼
      presetUse: null, // {x,y,w,h} "use_preset" toggle button
      presetPrev: null, // {x,y,w,h} previous preset button
      presetNext: null, // {x,y,w,h} next preset button
      file: "", // dataset file name (data_file widget) or ""
      loadedFile: null, // name of the file already loaded into rows/presets
      fileLoading: false,
      loadFailed: false,
    };
  }
  return node.__esn;
}

function findWidget(node, name) {
  if (!node.widgets) return null;
  for (const w of node.widgets) {
    if (w && w.name === name) return w;
  }
  return null;
}

function rowsWidget(node) {
  return findWidget(node, ROWS_NAME);
}

function presetsWidget(node) {
  return findWidget(node, PRESETS_NAME);
}
function dataWidget(node) {
  return findWidget(node, DATA_NAME);
}

function widgetRawValue(w) {
  if (!w) return "";
  try {
    return w.value == null ? "" : String(w.value);
  } catch (e) {
    return "";
  }
}

function hideTextWidget(w) {
  if (!w) return;
  if (w.__esnHidden) return;
  w.__esnHidden = true;
  try {
    w.hidden = true; // new front-end
  } catch (e) {}
  try {
    w.options.hidden = true;
  } catch (e) {}
  try {
    w.computedHeight = 0;
  } catch (e) {}
  if (typeof w.options === "object") {
    try { w.options.getMinHeight = () => 0; } catch (e) {}
    try { w.options.getHeight = () => 0; } catch (e) {}
    try { w.options.getMaxHeight = () => 0; } catch (e) {}
  }
  if (typeof w.computeSize !== "function") {
    try {
      w.computeSize = function () { return [this.width || 200, 0]; };
    } catch (e) {}
  }
  const el = w.element || w.inputEl;
  if (el && el.style) {
    try { el.style.display = "none"; } catch (e) {}
    try { el.hidden = true; } catch (e) {}
    try { el.style.pointerEvents = "none"; } catch (e) {}
  }
}

function hideRowsWidget(node) {
  // hide the python text widgets (rows JSON + presets text + data file name)
  hideTextWidget(rowsWidget(node));
  hideTextWidget(presetsWidget(node));
  hideTextWidget(dataWidget(node));
}

function syncFromWidget(node) {
  const st = state(node);
  let changed = false;
  // dataset file name first: when set, rows/presets live on disk and must
  // NOT be overwritten from the (empty) widget values on every draw.
  const dw = dataWidget(node);
  let fileMode = false;
  if (dw) {
    const raw = widgetRawValue(dw);
    if (raw !== st.file) {
      st.file = raw;
      st.loadFailed = false;
      fileMode = !!raw;
      changed = true;
    } else {
      fileMode = !!st.file;
    }
  } else {
    fileMode = !!st.file;
  }
  if (fileMode) {
    // only the file name drives the state; rows/presets come from the file
    return changed;
  }
  const rw = rowsWidget(node);
  if (rw) {
    const raw = widgetRawValue(rw);
    if (raw !== st.raw) {
      st.raw = raw;
      st.rows = cleanRows(parseRows(raw));
      changed = true;
    }
  }
  const pw = presetsWidget(node);
  if (pw) {
    const raw = widgetRawValue(pw);
    if (raw !== st.presets) {
      st.presets = raw;
      changed = true;
    }
  }
  return changed;
}

let fileSaveTimer = null;
function persistFileNow(node) {
  const st = state(node);
  if (!st.file) return;
  dsSave(st.file, st.rows, st.presets).then((res) => {
    if (!res) console.warn("EasyStringNegEditor: could not save dataset " + st.file);
  });
}
function scheduleFilePersist(node) {
  if (fileSaveTimer) clearTimeout(fileSaveTimer);
  fileSaveTimer = setTimeout(() => { fileSaveTimer = null; persistFileNow(node); }, 600);
}
function commitRows(node, rows) {
  const st = state(node);
  const w = rowsWidget(node);
  st.rows = cleanRows(rows);
  st.raw = dumpRows(st.rows);
  if (st.file) {
    // dataset mode: keep the workflow lean - data lives on disk only
    scheduleFilePersist(node);
    return st.rows.length;
  }
  if (w) {
    try {
      w.value = st.raw;
    } catch (e) {}
    if (w.inputEl && typeof w.inputEl === "object") {
      try {
        if (w.inputEl.value !== st.raw) w.inputEl.value = st.raw;
      } catch (e) {}
    }
    if (typeof w.callback === "function") {
      try {
        w.callback(st.raw);
      } catch (e) {}
    }
  }
  return st.rows.length;
}

function commitPresets(node, text) {
  const st = state(node);
  const w = presetsWidget(node);
  text = String(text == null ? "" : text);
  st.presets = text;
  if (st.file) {
    scheduleFilePersist(node);
    return;
  }
  if (w) {
    try {
      w.value = text;
    } catch (e) {}
    if (w.inputEl && typeof w.inputEl === "object") {
      try {
        if (w.inputEl.value !== text) w.inputEl.value = text;
      } catch (e) {}
    }
    if (typeof w.callback === "function") {
      try {
        w.callback(text);
      } catch (e) {}
    }
  }
}

function commitDataFile(node, text) {
  const st = state(node);
  const w = dataWidget(node);
  text = String(text == null ? "" : text);
  st.file = text;
  if (w) {
    try { w.value = text; } catch (e) {}
    if (w.inputEl && typeof w.inputEl === "object") {
      try { if (w.inputEl.value !== text) w.inputEl.value = text; } catch (e) {}
    }
    if (typeof w.callback === "function") {
      try { w.callback(text); } catch (e) {}
    }
  }
}

function countPresets(text) {
  let n = 0;
  const lines = String(text == null ? "" : text).split(NL);
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    const ci = line.indexOf(":");
    if (ci > 0 && isDigits(line.slice(0, ci).trim())) n++;
  }
  return n;
}

// Numbered preset entries from the presets widget text: [{num, text}].
function presetEntries(text) {
  const out = [];
  const lines = String(text == null ? "" : text).split(NL);
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    const ci = line.indexOf(":");
    if (ci <= 0) continue;
    const head = line.slice(0, ci).trim();
    if (!isDigits(head)) continue;
    out.push({ num: parseInt(head, 10), text: line });
  }
  return out;
}

// Current run-time preset choice from the python widgets (use_preset, preset_line).
function presetChoice(node) {
  const useW = findWidget(node, "use_preset");
  const lineW = findWidget(node, "preset_line");
  let on = false;
  let line = 1;
  try { if (useW && useW.value != null) on = !!useW.value; } catch (e) {}
  try {
    if (lineW && lineW.value != null) {
      const v = Number(lineW.value);
      if (Number.isFinite(v) && v >= 1) line = Math.round(v);
    }
  } catch (e) {}
  return { on: on, line: line };
}

// Move the active preset by dir (-1 / +1) along the numbered preset list.
function stepPresetChoice(node, dir) {
  const entries = presetEntries(state(node).presets);
  if (!entries.length) return;
  const cur = presetChoice(node);
  let idx = entries.findIndex((e) => e.num === cur.line);
  if (idx < 0) idx = cur.on ? 0 : 0;
  idx = (idx + dir + entries.length) % entries.length;
  setPresetChoice(node, entries[idx].num);
}

// Write the active preset number back into the python widgets.
function setPresetChoice(node, num) {
  const useW = findWidget(node, "use_preset");
  const lineW = findWidget(node, "preset_line");
  if (lineW) {
    try {
      lineW.value = num;
      if (typeof lineW.callback === "function") lineW.callback(num);
    } catch (e) {}
  }
  if (useW) {
    try {
      useW.value = true;
      if (typeof useW.callback === "function") useW.callback(true);
    } catch (e) {}
  }
  try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

// Keep only numbered "N: ..." preset lines (drops stray text).
function normalizePresetText(text) {
  const out = [];
  const lines = String(text == null ? "" : text).split(NL);
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    const ci = line.indexOf(":");
    if (ci > 0 && isDigits(line.slice(0, ci).trim())) out.push(line);
  }
  return out.join(NL);
}

// Parse an old numbered dataset line: "N: content ... ~"
// Returns {num, content} or null when the line is not numbered.
function parseOldLine(raw) {
  let line = String(raw == null ? "" : raw);
  if (line.endsWith(CR)) line = line.slice(0, -1);
  line = line.trim();
  if (!line) return null;
  // remove one trailing "~" separator used by the old data format
  if (line.charAt(line.length - 1) === "~") {
    line = line.slice(0, -1).trim();
  }
  const ci = line.indexOf(":");
  if (ci <= 0) return null;
  const head = line.slice(0, ci).trim();
  if (!isDigits(head)) return null;
  const num = parseInt(head, 10);
  const content = line.slice(ci + 1).trim();
  return { num: num, content: content };
}

// Turn an old numbered dataset into row objects.
// A line may follow the old SelectorNeg format "positive --- negative":
//   the part before the first top-level "---" becomes row.pos and the part
//   after it becomes row.neg (either may be empty).
// Lines without "---" go entirely into the chosen dest field ("neg" default).
function parseOldRows(text, dest) {
  const out = [];
  const lines = String(text == null ? "" : text).split(NL);
  for (const raw of lines) {
    const parsed = parseOldLine(raw);
    if (!parsed) continue;
    const row = { num: parsed.num, cat: "", on: false, pos: "", neg: "", img: "" };
    const marker = indexOfTopLevelDash(parsed.content);
    if (marker >= 0) {
      row.pos = parsed.content.slice(0, marker).trim();
      row.neg = parsed.content.slice(marker + 3).trim();
    } else if (dest === "pos") {
      row.pos = parsed.content;
    } else {
      row.neg = parsed.content;
    }
    out.push(row);
  }
  return out;
}

// Index of the first "---" that is not inside (), [] or {}, or -1.
function indexOfTopLevelDash(text) {
  if (!text) return -1;
  let depth = 0;
  for (let i = 0; i < text.length - 2; i++) {
    const ch = text.charAt(i);
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === "-" && text.charAt(i + 1) === "-" && text.charAt(i + 2) === "-") {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// dataset files on disk (server routes from esn_storage.py)
// ---------------------------------------------------------------------------

function dsList() {
  return fetch('/easystring/datasets', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { files: [] }))
    .then((j) => (j && Array.isArray(j.files) ? j.files : []))
    .catch(() => []);
}

function dsLoad(name) {
  if (!name) return Promise.resolve(null);
  return fetch('/easystring/data?file=' + encodeURIComponent(name), { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

function dsSave(name, rows, presets) {
  return fetch('/easystring/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: name, rows: rows, presets: presets }),
  })
    .then((r) => r.json())
    .then((j) => (j && j.ok ? j : null))
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// image handling
// ---------------------------------------------------------------------------

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

function downscaleDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.naturalWidth || 1;
        let h = img.naturalHeight || 1;
        const scale = Math.min(1, IMG_MAX_EDGE / Math.max(w, h));
        const nw = Math.max(1, Math.round(w * scale));
        const nh = Math.max(1, Math.round(h * scale));
        const c = document.createElement("canvas");
        c.width = nw;
        c.height = nh;
        c.getContext("2d").drawImage(img, 0, 0, nw, nh);
        const isPng = /^data:image\/png/i.test(dataUrl);
        resolve(c.toDataURL(isPng ? "image/png" : "image/jpeg", isPng ? undefined : IMG_QUALITY));
      } catch (err) {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function readImageFile(file) {
  if (!file) return "";
  if (!/^image\//i.test(file.type)) return "";
  try {
    return await downscaleDataUrl(await fileToDataUrl(file));
  } catch (err) {
    console.error("EasyStringNegEditor: image load failed", err);
    return "";
  }
}

// ---------------------------------------------------------------------------
// custom canvas widget (drawn row list + header button)
// ---------------------------------------------------------------------------

function rowCount(node) {
  return state(node).rows.length;
}

function rowSearchText(row) {
  // what the on-node search matches against: number, category, pos, neg
  return String(row.num != null ? row.num : "") + " " +
    (row.cat || "") + " " + (row.pos || "") + " " + (row.neg || "");
}

// Visible rows honoring the search filter: [{row, oi}] where oi is the index
// in st.rows. Kept in st.view by draw(); standalone for sizing/hits.
function rebuildView(st, rows) {
  const q = (st.search || "").toLowerCase().trim();
  const out = [];
  rows = rows || st.rows || [];
  for (let oi = 0; oi < rows.length; oi++) {
    const row = rows[oi];
    if (!q || rowSearchText(row).toLowerCase().indexOf(q) !== -1) out.push({ row: row, oi: oi });
  }
  return out;
}

function sortRowsByFreq(rows) {
  // stable descending by usage counter; rows without a counter stay at the end
  const withIdx = rows.map((row, i) => ({ row: row, i: i }));
  withIdx.sort((a, b) => {
    const fa = a.row.freq || 0, fb = b.row.freq || 0;
    if (fb !== fa) return fb - fa;
    return a.i - b.i;
  });
  return withIdx.map((x) => x.row);
}

function toggleFreqSort(node) {
  const st = state(node);
  const rows = st.rows;
  if (!rows || rows.length < 2) return;
  if (st.sortedByFreq) {
    // restore the exact pre-sort order from the serialized backup
    if (st.freqOrderBackup) {
      try {
        const restored = cleanRows(JSON.parse(st.freqOrderBackup));
        if (restored.length === rows.length) commitRows(node, restored);
      } catch (e) {}
    }
    st.sortedByFreq = false;
    st.freqOrderBackup = null;
  } else {
    st.freqOrderBackup = JSON.stringify(rows); // snapshot original order
    commitRows(node, sortRowsByFreq(rows.slice()));
    st.sortedByFreq = true;
  }
  if (st.search) { st.scroll = 0; }
  app.graph?.setDirtyCanvas?.(true, true);
  resizeNode(node);
}

function listHeight(node) {
  const st = state(node);
  const total = rowCount(node);
  const n = Math.min(total, MAX_DRAWN_ROWS);
  let h = HEADER_H + SEARCH_H + n * ROW_H;
  if (total > MAX_DRAWN_ROWS || n === 0) h += 18; // scroll hint / "no rows"
  const entries = presetEntries(st.presets);
  const nP = Math.min(entries.length, MAX_DRAWN_PRESETS);
  h += PRESET_GAP + PRESET_HDR_H + nP * PRESET_H;
  if (entries.length > MAX_DRAWN_PRESETS) h += 16; // ▲/▼ row
  h += entries.length ? 20 : 18; // control row or "no presets" hint
  return h + 4;
}

function openEditor(node, index, initialTab) {
  // implemented below; indirection keeps definition order simple
  showDialog(node, index, initialTab);
}

// --- on-node search (hidden DOM <input> focused on demand) ---
let searchInput = null;
let searchNode = null; // node currently being searched

function ensureSearchInput() {
  if (searchInput && searchInput.parentNode) return searchInput;
  searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.setAttribute("autocomplete", "off");
  searchInput.setAttribute("spellcheck", "false");
  Object.assign(searchInput.style, {
    position: "fixed", left: "0", top: "0", width: "1px", height: "1px",
    opacity: "0", border: "0", padding: "0", margin: "0", outline: "none",
    zIndex: "-1", pointerEvents: "none",
  });
  searchInput.addEventListener("input", () => {
    const st = searchNode ? state(searchNode) : null;
    if (st) {
      st.search = searchInput.value || "";
      app.graph?.setDirtyCanvas?.(true, true);
    }
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      clearSearch();
      e.stopPropagation();
    } else if (e.key === "Enter") {
      e.stopPropagation();
    } else {
      // keep graph hotkeys from firing while typing
      e.stopPropagation();
    }
  });
  searchInput.addEventListener("blur", () => {
    const st = searchNode ? state(searchNode) : null;
    if (st) st.searchFocus = false;
    app.graph?.setDirtyCanvas?.(true, true);
  });
  searchInput.addEventListener("focus", () => {
    const st = searchNode ? state(searchNode) : null;
    if (st) st.searchFocus = true;
    app.graph?.setDirtyCanvas?.(true, true);
  });
  document.body.appendChild(searchInput);
  return searchInput;
}

function focusSearch(node) {
  searchNode = node;
  const inp = ensureSearchInput();
  const st = state(node);
  if (st.searchFocus) {
    // already focused: keep focus and select-all so typing replaces the text
    inp.focus();
    inp.select();
    return;
  }
  inp.value = st.search || "";
  st.searchFocus = true;
  inp.focus();
  inp.select();
}

function clearSearch() {
  const st = searchNode ? state(searchNode) : null;
  if (searchInput) searchInput.value = "";
  if (st) {
    st.search = "";
    st.searchFocus = false;
    if (searchInput) searchInput.blur();
    app.graph?.setDirtyCanvas?.(true, true);
  }
}

// --- rows scrollbar drag ---
let sbDragNode = null;

function startSbDrag(node, st, event, y) {
  const zone = st.sbZone;
  if (!zone) return;
  sbDragNode = node;
  st.draggingSb = true;
  st.sbStartClientY = (event && typeof event.clientY === "number") ? event.clientY : y;
  st.sbStartNodeY = y;
  const thumbY = zone.thumbY;
  const grabOffset = y - thumbY;
  // grabbing the track itself (not the thumb) grabs the thumb's middle
  st.sbGrabOffset = (grabOffset >= 0 && grabOffset <= zone.thumbH) ? grabOffset : zone.thumbH / 2;
  st.sbScale = (app.canvas && app.canvas.ds && app.canvas.ds.scale) ? app.canvas.ds.scale : 1;
  try { event.preventDefault(); } catch (e) {}
  try { event.stopPropagation(); } catch (e) {}
  app.graph?.setDirtyCanvas?.(true, true);
  // move + up on window so dragging outside the widget keeps working
  window.addEventListener("pointermove", onSbMove, { passive: false });
  window.addEventListener("pointerup", onSbUp);
  window.addEventListener("pointercancel", onSbUp);
}

function onSbMove(e) {
  const node = sbDragNode;
  if (!node) return;
  const st = state(node);
  const zone = st.sbZone;
  if (!zone) return;
  try { e.preventDefault(); } catch (err) {}
  try { e.stopPropagation(); } catch (err) {}
  const usable = zone.h - zone.thumbH;
  if (usable <= 0) return;
  // convert the client delta to node-local units via the canvas scale
  const nodeY = st.sbStartNodeY + ((e.clientY - st.sbStartClientY) / (st.sbScale || 1));
  let frac = (nodeY - zone.y - st.sbGrabOffset) / usable;
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;
  const next = Math.round(frac * zone.maxScroll);
  if (next !== st.scroll) {
    st.scroll = next;
    app.graph?.setDirtyCanvas?.(true, true);
  }
}

function onSbUp() {
  const node = sbDragNode;
  sbDragNode = null;
  if (node) {
    const st = state(node);
    st.draggingSb = false;
    app.graph?.setDirtyCanvas?.(true, true);
  }
  window.removeEventListener("pointermove", onSbMove);
  window.removeEventListener("pointerup", onSbUp);
  window.removeEventListener("pointercancel", onSbUp);
}

function makeListWidget(node) {
  const st = state(node);
  const widget = {
    type: "custom",
    name: UI_NAME,
    value: "",
    options: { serialize: false },
    serialize: false,
    serializeValue: () => undefined,
    computeSize() {
      return [this.width || 220, listHeight(node)];
    },
    draw(ctx, n, width, y, H) {
      hideRowsWidget(n);
      if (syncFromWidget(n)) {
        resizeNode(n);
      }
      st.widgetY = y;
      st.widgetH = this.computeSize()[1];
      const fullW = width || 220;
      const cx = fullW / 2;

      // header pill / button
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#4a6";
      ctx.fillStyle = "rgba(20,20,20,0.9)";
      ctx.beginPath();
      ctx.roundRect(12, y + 3, fullW - 24, HEADER_H - 6, [4]);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#cfc";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const pCount = countPresets(st.presets);
      const loading = st.file && st.loadedFile !== st.file && !st.loadFailed;
      const failed = st.file && st.loadedFile !== st.file && st.loadFailed;
      const totalShown = st.view ? st.view.length : rowCount(n);
      const titleTxt = failed ? "✎ dataset " + st.file + " not found — edit" : (loading ? "✎ dataset " + st.file + " — loading…" : "✎ Rows (" + totalShown + (st.search ? "/" + rowCount(n) : "") + ") / Presets (" + pCount + ") — edit");
      // sort-by-frequency toggle on the right edge of the header
      const sortX = fullW - 34;
      const sortY = y + 3;
      const sortW = 22;
      const sortH = HEADER_H - 6;
      st.sortBtn = { x: sortX, y: sortY, w: sortW, h: sortH };
      const canSort = (rowCount(n) || st.rows.length) > 1;
      ctx.textAlign = "right";
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = canSort ? (st.sortedByFreq ? "#ffcc66" : "rgba(255,255,255,0.6)") : "rgba(255,255,255,0.18)";
      ctx.fillText("⇅", sortX + sortW - 8, y + HEADER_H / 2 + 1);
      ctx.textAlign = "center";
      // title, squeezed so it doesn't overlap the sort control
      ctx.font = "bold 12px sans-serif";
      const titleMax = fullW - 24 - 42;
      ctx.fillText(clampText(titleTxt, Math.max(8, Math.floor(titleMax / 6.2))), 12 + (fullW - 24) / 2, y + HEADER_H / 2 + 1);
      ctx.restore();

      // rows
      st.rects.length = 0;
      st.presetRects.length = 0;
      st.presetsHeader = null;
      st.presetUp = null;
      st.presetDown = null;
      st.presetUse = null;
      st.presetPrev = null;
      st.presetNext = null;
      st.presetListArea = null;
      st.sbZone = null;
      st.view = rebuildView(st, st.rows);
      const total = st.view.length;
      const maxScroll = Math.max(0, total - MAX_DRAWN_ROWS);
      if (st.scroll > maxScroll) st.scroll = maxScroll;
      if (st.scroll < 0) st.scroll = 0;
      const shown = Math.min(total - st.scroll, MAX_DRAWN_ROWS);
      let ry = y + HEADER_H;

      // search bar (always visible): magnifier glyph + text + clear ✕
      const searchTop = ry;
      const searchBot = searchTop + SEARCH_H;
      st.searchZone = { top: searchTop, bottom: searchBot };
      const sbBoxW = fullW - 24 - SB_W - 6;
      ctx.save();
      ctx.fillStyle = "rgba(8,8,8,0.55)";
      ctx.strokeStyle = st.searchFocus ? "#5af" : "rgba(255,255,255,0.22)";
      ctx.lineWidth = st.searchFocus ? 1.5 : 1;
      ctx.beginPath();
      ctx.roundRect(12, searchTop + 2, sbBoxW, SEARCH_H - 4, [9]);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const hasQ = !!(st.search || "").trim();
      ctx.fillStyle = hasQ ? "#eee" : "rgba(255,255,255,0.42)";
      ctx.font = "10px sans-serif";
      const ph = hasQ ? st.search : "search rows…";
      ctx.fillText("🔍", 20, searchTop + SEARCH_H / 2 + 1);
      ctx.fillText(clampText(ph, Math.max(6, Math.floor(sbBoxW / 5.4) - 18)), 34, searchTop + SEARCH_H / 2 + 1);
      if (hasQ) {
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.textAlign = "center";
        ctx.fillText("✕", 12 + sbBoxW - 12, searchTop + SEARCH_H / 2 + 1);
        st.searchClear = { x: 12 + sbBoxW - 24, y: searchTop + 2, w: 22, h: SEARCH_H - 4 };
      } else {
        st.searchClear = null;
      }
      ctx.restore();
      ry += SEARCH_H;

      ctx.save();
      for (let i = 0; i < shown; i++) {
        const row = st.view[st.scroll + i].row;
        const oi = st.view[st.scroll + i].oi;
        const freq = row.freq || 0;
        if (freq > 0) {
          const a = Math.min(0.34, 0.08 + Math.log2(1 + freq) * 0.05);
          ctx.fillStyle = "rgba(255,170,60," + a.toFixed(3) + ")";
        } else {
          ctx.fillStyle = (st.scroll + i) % 2 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.25)";
        }
        ctx.fillRect(12, ry + 1, fullW - 24 - (freq > 0 ? FREQ_W - 4 : 0), ROW_H - 2);
        // checkbox column (manual pick)
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "12px sans-serif";
        if (row.on) {
          ctx.fillStyle = "#6cf";
          ctx.fillText("☑", 18, ry + ROW_H / 2);
        } else {
          ctx.strokeStyle = "rgba(255,255,255,0.5)";
          ctx.strokeRect(13, ry + ROW_H / 2 - 5, 11, 11);
        }
        // number
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = "10px monospace";
        ctx.textAlign = "left";
        const numTxt = row.num != null ? String(row.num) : String(oi + 1);
        ctx.fillText(numTxt, 30, ry + ROW_H / 2);
        let lx = 52;
        // category chip
        if (row.cat) {
          ctx.fillStyle = "#8af";
          ctx.font = "9px sans-serif";
          const cw = ctx.measureText(row.cat).width + 8;
          ctx.fillRect(52, ry + 3, cw, ROW_H - 8);
          ctx.fillStyle = "#04121f";
          ctx.fillText(row.cat, 56, ry + ROW_H / 2);
          lx = 56 + cw;
        }
        // label (shrink by the reserved freq column / img marker)
        const hasImg = !!row.img;
        const reserved = (freq > 0 ? FREQ_W - 2 : 6) + (hasImg ? 18 : 0);
        const avail = fullW - 24 - (lx - 12) - reserved;
        const label = clampText(row.pos || row.neg || "(empty)", Math.max(8, avail));
        ctx.fillStyle = row.pos
          ? "#beb"
          : row.neg
            ? "rgba(255,255,255,0.65)"
            : "rgba(255,255,255,0.3)";
        ctx.font = "10px sans-serif";
        ctx.fillText(label, lx, ry + ROW_H / 2);
        if (hasImg) {
          ctx.textAlign = "right";
          ctx.fillText("◧", fullW - 24 - (freq > 0 ? FREQ_W - 4 : 0), ry + ROW_H / 2);
        }
        // usage counter on the right edge
        if (freq > 0) {
          ctx.textAlign = "right";
          ctx.fillStyle = freq >= 5 ? "#ffcc66" : "rgba(140,190,255,0.95)";
          ctx.font = "9px sans-serif";
          ctx.fillText("×" + freq, fullW - 14, ry + ROW_H / 2);
        }
        st.rects.push({ top: ry, bottom: ry + ROW_H, index: oi });
        ry += ROW_H;
      }
      // scroll area: arrows + wheel + drag scrollbar, drawn when rows hidden
      st.scrollUp = null;
      st.scrollDown = null;
      const canScroll = total > MAX_DRAWN_ROWS;
      let rowsBottom = ry; // rows area ends here (below the scroll hint)
      if (canScroll) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 11px sans-serif";
        ctx.fillStyle = st.scroll > 0 ? "#9cf" : "rgba(255,255,255,0.2)";
        const upY = ry + 4;
        ctx.fillText("▲", cx - 14, upY);
        ctx.fillText("▼", cx + 14, upY);
        st.scrollUp = { x: cx - 24, y: ry, w: 28, h: 12 };
        st.scrollDown = { x: cx + 4, y: ry, w: 28, h: 12 };
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        const leftCount = total - (st.scroll + shown);
        ctx.fillText(leftCount > 0 ? ("↓ " + leftCount + " more - wheel / arrows / drag") : "(wheel to scroll)", cx, ry + 15);
        rowsBottom = ry + 18;

        // drag scrollbar on the right edge of the drawn rows
        const sbX = fullW - SB_W - 4;
        const sbY = searchBot + 1;
        const sbH = rowsBottom - sbY - 1;
        if (sbH > 24 && shown > 0) {
          const trackH = sbH;
          const thumbH = Math.max(16, trackH * (shown / total));
          const frac = maxScroll > 0 ? st.scroll / maxScroll : 0;
          const thumbY = sbY + frac * (trackH - thumbH);
          st.sbZone = { x: sbX, y: sbY, w: SB_W, h: trackH, thumbY: thumbY, thumbH: thumbH, maxScroll: maxScroll };
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          ctx.fillRect(sbX, sbY, SB_W, trackH);
          ctx.fillStyle = st.draggingSb ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.35)";
          ctx.fillRect(sbX + 2, thumbY + 2, SB_W - 4, Math.max(8, thumbH - 4));
        }
      } else {
        if (shown === 0) {
          ctx.fillStyle = "rgba(255,255,255,0.25)";
          ctx.font = "10px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(st.search ? "(no rows match “" + clampText(st.search, 22) + "”)" : "(no rows yet - click the header to add)", cx, ry + 12);
          rowsBottom = ry + 18;
        }
      }
      st.rowsAreaBottom = rowsBottom;
      ctx.restore();

      // ---- presets section (visible on the node like the old SelectorNeg) ----
      const entries = presetEntries(st.presets);
      const secTop = rowsBottom + PRESET_GAP;
      const secLeft = 12;
      const secW = fullW - 24;
      // section header (click → dialog Presets tab)
      st.presetsHeader = { top: secTop, bottom: secTop + PRESET_HDR_H };
      ctx.save();
      ctx.fillStyle = "rgba(60,40,20,0.35)";
      ctx.fillRect(secLeft, secTop, secW, PRESET_HDR_H);
      ctx.fillStyle = "#fca";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("Presets (" + entries.length + ") — " + (entries.length ? "click a line to open · use/◀/▶ to pick" : "click to add"), secLeft + 6, secTop + PRESET_HDR_H / 2);
      let pBottom = secTop + PRESET_HDR_H;
      if (entries.length) {
        const choice = presetChoice(n);
        const activeIdx = entries.findIndex((e) => choice.on && e.num === choice.line);
        const maxPScroll = Math.max(0, entries.length - MAX_DRAWN_PRESETS);
        if (st.presetScroll > maxPScroll) st.presetScroll = maxPScroll;
        if (st.presetScroll < 0) st.presetScroll = 0;
        // keep the active preset visible when possible
        if (activeIdx >= 0 && (activeIdx < st.presetScroll || activeIdx >= st.presetScroll + MAX_DRAWN_PRESETS)) {
          st.presetScroll = Math.max(0, Math.min(maxPScroll, activeIdx - Math.floor(MAX_DRAWN_PRESETS / 2)));
        }
        const shownP = Math.min(entries.length - st.presetScroll, MAX_DRAWN_PRESETS);
        ctx.font = "10px monospace";
        for (let i = 0; i < shownP; i++) {
          const en = entries[st.presetScroll + i];
          const rowTop = pBottom;
          const rowBottom = rowTop + PRESET_H;
          const isActive = activeIdx >= 0 && en.num === entries[activeIdx].num;
          ctx.fillStyle = isActive ? "rgba(30,120,70,0.35)" : ((st.presetScroll + i) % 2 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.2)");
          ctx.fillRect(secLeft, rowTop, secW, PRESET_H);
          ctx.fillStyle = isActive ? "#7f7" : "rgba(255,255,255,0.6)";
          ctx.textAlign = "left";
          const lineTxt = clampText(en.text, Math.max(8, secW - 6));
          ctx.fillText((isActive ? "\u25b6 " : "  ") + lineTxt, secLeft + 4, rowTop + PRESET_H / 2);
          st.presetRects.push({ top: rowTop, bottom: rowBottom, num: en.num });
          pBottom = rowBottom;
        }
        if (entries.length > MAX_DRAWN_PRESETS) {
          const ay = pBottom + 7;
          ctx.fillStyle = st.presetScroll > 0 ? "#c97" : "rgba(255,255,255,0.2)";
          ctx.font = "bold 10px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("\u25b2", cx - 14, ay);
          ctx.fillStyle = st.presetScroll < maxPScroll ? "#c97" : "rgba(255,255,255,0.2)";
          ctx.fillText("\u25bc", cx + 14, ay);
          st.presetUp = { x: cx - 28, y: ay - 8, w: 28, h: 16 };
          st.presetDown = { x: cx + 2, y: ay - 8, w: 28, h: 16 };
          pBottom += 16;
          st.presetListArea = { top: secTop + PRESET_HDR_H, bottom: pBottom };
        }
        // control row: use_preset toggle + active preset stepper
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(secLeft, pBottom, secW, 18);
        const ctlY = pBottom + 9;
        // left label
        ctx.font = "9px sans-serif";
        ctx.textAlign = "left";
        const active = choice.on ? entries.find((e) => e.num === choice.line) : null;
        ctx.fillStyle = active ? "#7f7" : "rgba(255,255,255,0.5)";
        ctx.fillText(active
          ? ("active preset " + choice.line + " → " + clampText(active.text, Math.max(6, secW - 120)))
          : (choice.on ? ("preset " + choice.line + " not found") : "preset off — all rows / line_numbers"),
          secLeft + 4, ctlY);
        // right: [use] [◀] [▶] mini buttons
        const btns = [
          { key: "use", label: choice.on ? "use:on" : "use:off", color: choice.on ? "#7f7" : "#888" },
          { key: "prev", label: "\u25c0", color: "#9cf", enabled: entries.length > 1 },
          { key: "next", label: "\u25b6", color: "#9cf", enabled: entries.length > 1 },
        ];
        let bx = secLeft + secW - 4;
        st.presetUse = null; st.presetPrev = null; st.presetNext = null;
        for (let bi = btns.length - 1; bi >= 0; bi--) {
          const b = btns[bi];
          const w2 = bi === 0 ? 38 : 16;
          bx -= w2;
          const zone = { x: bx, y: pBottom + 2, w: w2, h: 14, key: b.key };
          ctx.fillStyle = b.color;
          ctx.globalAlpha = b.enabled === false ? 0.3 : 0.9;
          ctx.strokeStyle = "rgba(255,255,255,0.25)";
          ctx.strokeRect(bx, pBottom + 2, w2, 14);
          ctx.font = b.key === "use" ? "8px sans-serif" : "9px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(b.label, bx + w2 / 2, ctlY);
          ctx.globalAlpha = 1;
          if (b.key === "use") st.presetUse = zone;
          else if (b.key === "prev") st.presetPrev = zone;
          else st.presetNext = zone;
        }
        pBottom += 20;
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("(no presets yet — click to add)", cx, pBottom + 9);
        pBottom += 18;
        // whole empty area opens the dialog on the Presets tab
        st.presetsHeader = { top: secTop, bottom: pBottom };
      }
      ctx.restore();
      st.presetsBottom = pBottom;
      st.widgetH = Math.max(st.widgetH, pBottom - y + 2);
    },
    mouse(event, pos, node) {
      if (event.type !== "pointerdown" && event.type !== "mousedown") {
        return false;
      }
      if (event.button != null && event.button !== 0) return false;
      const x = pos[0];
      const y = pos[1];
      const st = state(node);
      // header sort-by-frequency toggle (right edge)
      if (st.sortBtn && x >= st.sortBtn.x && x <= st.sortBtn.x + st.sortBtn.w &&
          y >= st.sortBtn.y && y <= st.sortBtn.y + st.sortBtn.h) {
        toggleFreqSort(node);
        return true;
      }
      // header → add/edit
      if (y >= st.widgetY - 1 && y <= st.widgetY + HEADER_H) {
        openEditor(node, null);
        return true;
      }
      // search bar: click focuses the hidden input; ✕ clears the filter
      if (st.searchZone && y >= st.searchZone.top && y <= st.searchZone.bottom) {
        const sx = x;
        if (st.searchClear && sx >= st.searchClear.x && sx <= st.searchClear.x + st.searchClear.w) {
          clearSearch();
          return true;
        }
        focusSearch(node);
        return true;
      }
      // rows scrollbar drag (pointer grab anywhere on the track)
      const viewRows = st.view.length;
      const maxScr = Math.max(0, viewRows - MAX_DRAWN_ROWS);
      if (maxScr > 0 && st.sbZone && x >= st.sbZone.x - 2 && x <= st.sbZone.x + st.sbZone.w + 2 &&
          y >= st.sbZone.y - 2 && y <= st.sbZone.y + st.sbZone.h + 2) {
        startSbDrag(node, st, event, y);
        return true;
      }
      // scroll arrows (visible when more rows than fit)
      if (maxScr > 0) {
        const hitZone = (z) => z && x >= z.x - 2 && x <= z.x + z.w + 2 && y >= z.y - 2 && y <= z.y + z.h + 2;
        if (hitZone(st.scrollUp)) {
          st.scroll = Math.max(0, st.scroll - WHEEL_STEP);
          app.graph?.setDirtyCanvas?.(true, true);
          return true;
        }
        if (hitZone(st.scrollDown)) {
          st.scroll = Math.min(maxScr, st.scroll + WHEEL_STEP);
          app.graph?.setDirtyCanvas?.(true, true);
          return true;
        }
      }
      for (const r of st.rects) {
        if (y >= r.top - 1 && y <= r.bottom + 1) {
          // checkbox column toggles the manual-pick flag in place
          if (x >= 10 && x <= 28) {
            const row = st.rows[r.index];
            if (row) {
              row.on = !row.on;
              commitRows(node, st.rows); // dataset-aware (file vs widget)
              app.graph?.setDirtyCanvas?.(true, true);
            }
            return true;
          }
          openEditor(node, r.index);
          return true;
        }
      }
      // ---- presets section interactions ----
      const maxPScroll = Math.max(0, presetEntries(st.presets).length - MAX_DRAWN_PRESETS);
      const hitP = (z) => z && x >= z.x - 2 && x <= z.x + z.w + 2 && y >= z.y - 2 && y <= z.y + z.h + 2;
      // ▲/▼ list scroll (only drawn when the list overflows)
      if (maxPScroll > 0) {
        if (hitP(st.presetUp)) {
          st.presetScroll = Math.max(0, st.presetScroll - 2);
          app.graph?.setDirtyCanvas?.(true, true);
          return true;
        }
        if (hitP(st.presetDown)) {
          st.presetScroll = Math.min(maxPScroll, st.presetScroll + 2);
          app.graph?.setDirtyCanvas?.(true, true);
          return true;
        }
      }
      // control buttons on the bottom control row
      if (hitP(st.presetUse)) {
        const useW = findWidget(node, "use_preset");
        if (useW) {
          try {
            useW.value = !useW.value;
            if (typeof useW.callback === "function") useW.callback(useW.value);
          } catch (e) {}
        }
        app.graph?.setDirtyCanvas?.(true, true);
        return true;
      }
      if (hitP(st.presetPrev)) { stepPresetChoice(node, -1); return true; }
      if (hitP(st.presetNext)) { stepPresetChoice(node, 1); return true; }
      // section header → dialog on the Presets tab (edit text)
      if (st.presetsHeader && y >= st.presetsHeader.top - 1 && y <= st.presetsHeader.bottom + 1) {
        openEditor(node, null, "presets");
        return true;
      }
      // clicking a preset line opens the dialog on the Presets tab too
      for (const pr of st.presetRects) {
        if (y >= pr.top - 1 && y <= pr.bottom + 1) {
          openEditor(node, null, "presets");
          return true;
        }
      }
      return false;
    },
  };
  return widget;
}

// ---------------------------------------------------------------------------
// node body sizing
// ---------------------------------------------------------------------------

function resizeNode(node) {
  try {
    if (!node.size) node.size = [220, 100];
    let w = node.size[0] || 220;
    if (w < 220) w = 220;
    // rough total: python widgets above (default 26px each) + our list
    const py = (node.widgets ? node.widgets.length - 1 : 0) * 26;
    const h = Math.max(node.size[1] || 100, py + listHeight(node));
    node.size = [w, h];
  } catch (e) {}
  try {
    app.graph?.setDirtyCanvas?.(true, true);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// hover preview (DOM overlay hit-tested against drawn rows)
// ---------------------------------------------------------------------------

let hoverEl = null;
let hoverKey = null;

function ensureHoverEl() {
  if (hoverEl) return hoverEl;
  hoverEl = document.createElement("div");
  Object.assign(hoverEl.style, {
    position: "fixed",
    zIndex: "2147483001",
    pointerEvents: "none",
    display: "none",
    background: "#161616",
    color: "#eee",
    border: "1px solid #3d3d3d",
    borderRadius: "8px",
    padding: "6px",
    maxWidth: "340px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    fontFamily: "sans-serif",
    fontSize: "11px",
  });
  document.body.appendChild(hoverEl);
  return hoverEl;
}

function hideHover() {
  hoverKey = null;
  if (hoverEl) hoverEl.style.display = "none";
}

function showHover(clientX, clientY, row) {
  const el = ensureHoverEl();
  el.innerHTML = "";
  if (row && row.img) {
    const img = document.createElement("img");
    img.src = row.img;
    Object.assign(img.style, { display: "block", maxWidth: "300px", maxHeight: "220px", borderRadius: "4px", margin: "0 auto 4px" });
    el.appendChild(img);
  }
  if (row && row.pos) {
    const p = document.createElement("div");
    p.textContent = row.pos;
    p.style.whiteSpace = "pre-wrap";
    el.appendChild(p);
  }
  if (row && row.neg) {
    const nn = document.createElement("div");
    nn.textContent = "− " + row.neg;
    nn.style.whiteSpace = "pre-wrap";
    nn.style.color = "#e88";
    if (row.pos) { nn.style.borderTop = "1px solid #333"; nn.style.marginTop = "4px"; nn.style.paddingTop = "4px"; }
    el.appendChild(nn);
  }
  if (!row || (!row.pos && !row.neg && !row.img)) el.textContent = "(empty row)";
  el.style.display = "block";
  let left = clientX + 14;
  let top = clientY + 14;
  const rect = el.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - 14;
  if (top + rect.height > window.innerHeight - 8) top = clientY - rect.height - 14;
  el.style.left = Math.max(4, left) + "px";
  el.style.top = Math.max(4, top) + "px";
}

function graphCoordsOf(e, canvas) {
  const c = canvas.canvas || canvas;
  if (typeof e.canvasX === "number" && typeof e.canvasY === "number") {
    return { x: e.canvasX, y: e.canvasY };
  }
  try {
    const rect = c.getBoundingClientRect();
    const scale = canvas.ds ? canvas.ds.scale : 1;
    const ox = canvas.ds ? canvas.ds.offset[0] : 0;
    const oy = canvas.ds ? canvas.ds.offset[1] : 0;
    return { x: (e.clientX - rect.left) / scale + ox, y: (e.clientY - rect.top) / scale + oy };
  } catch (err) {
    return { x: -1, y: -1 };
  }
}

function hitRowAt(gx, gy) {
  const graph = app.graph;
  if (!graph || !graph._nodes) return null;
  for (let i = graph._nodes.length - 1; i >= 0; i--) {
    const node = graph._nodes[i];
    if (!node || node.type !== NODE_CLASS || !node.__esnListWidget) continue;
    const st = state(node);
    if (!st.rects.length) continue;
    const x0 = node.pos ? node.pos[0] : 0;
    const y0 = node.pos ? node.pos[1] : 0;
    const size = node.size || [220, 100];
    if (gx < x0 || gx > x0 + size[0] || gy < y0 || gy > y0 + size[1]) continue;
    const ly = gy - y0;
    for (const r of st.rects) {
      if (ly >= r.top && ly <= r.bottom) return { node, row: st.rows[r.index], index: r.index };
    }
    return null;
  }
  return null;
}

function onCanvasPointerMove(e) {
  const canvas = app.canvas;
  if (!canvas || !canvas.canvas) return;
  try {
    if (typeof canvas.adjustMouseEvent === "function") canvas.adjustMouseEvent(e);
  } catch (err) {}
  const { x, y } = graphCoordsOf(e, canvas);
  const hit = hitRowAt(x, y);
  if (!hit || !hit.row || !hit.row.img) {
    hideHover();
    return;
  }
  const key = (hit.node.id ?? hit.node) + ":" + hit.index;
  if (key !== hoverKey) {
    hoverKey = key;
    showHover(e.clientX, e.clientY, hit.row);
  } else {
    const el = ensureHoverEl();
    if (el.style.display !== "none") {
      let left = e.clientX + 14;
      let top = e.clientY + 14;
      const rect = el.getBoundingClientRect();
      if (left + rect.width > window.innerWidth - 8) left = e.clientX - rect.width - 14;
      if (top + rect.height > window.innerHeight - 8) top = e.clientY - rect.height - 14;
      el.style.left = Math.max(4, left) + "px";
      el.style.top = Math.max(4, top) + "px";
    }
  }
}

let hoverInstalled = false;
function installHover() {
  if (hoverInstalled) return;
  hoverInstalled = true;
  function attach() {
    const canvas = app.canvas && app.canvas.canvas;
    if (!canvas) {
      setTimeout(attach, 300);
      return;
    }
    canvas.addEventListener("pointermove", onCanvasPointerMove);
    canvas.addEventListener("pointerleave", hideHover);
    // Wheel over the node's row / preset lists scrolls that list. The
    // listener lives on document in the CAPTURE phase so it runs BEFORE
    // LiteGraph's own canvas wheel handler (which zooms the workflow);
    // when the wheel belongs to one of our lists we stop propagation so
    // the workflow is not zoomed instead of the list scrolling.
    function graphPointFromEvent(e) {
      try {
        const cv = app.canvas;
        if (!cv) return null;
        // Prefer litegraph's own screen->world conversion so the result always
        // matches where the nodes are drawn (it uses rect + ds.scale/ds.offset
        // with the SAME sign conventions as the renderer).
        if (typeof cv.convertEventToCanvasOffset === "function") {
          const pt = cv.convertEventToCanvasOffset(e);
          if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
            return { gx: pt[0], gy: pt[1] };
          }
        }
        if (typeof cv.adjustMouseEvent === "function") {
          cv.adjustMouseEvent(e);
          if (Number.isFinite(e.canvasX) && Number.isFinite(e.canvasY)) {
            return { gx: e.canvasX, gy: e.canvasY };
          }
        }
        // Manual fallback: same math as DragAndScale.convertCanvasToOffset,
        // world = (client - rect) / scale - offset.
        const canvasEl = cv.canvas;
        if (!canvasEl) return null;
        const rect = canvasEl.getBoundingClientRect();
        const ds = cv.ds || {};
        const scale = ds.scale || 1;
        const ox = ds.offset ? ds.offset[0] : 0;
        const oy = ds.offset ? ds.offset[1] : 0;
        const xr = e.clientX - rect.left;
        const yr = e.clientY - rect.top;
        return { gx: xr / scale - ox, gy: yr / scale - oy };
      } catch (err) {
        return null;
      }
    }
    // True when the wheel event sits over a scrollable list of one of our
    // nodes; in that case the list is scrolled. Returns false when nothing
    // was scrolled so the event may reach ComfyUI (zoom etc.).
    function hitScrollableList(e) {
      const graph = app.graph;
      if (!graph || !graph._nodes) return false;
      const canvasEl = app.canvas && app.canvas.canvas;
      if (!canvasEl) return false;
      // Decide by hit-testing the pointer position rather than by e.target:
      // frontends may wrap the canvas or dispatch synthetic events, but the
      // element under the cursor tells us reliably whether the wheel is aimed
      // at the graph canvas (where our nodes live) or at DOM UI.
      try {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        let ok = false;
        if (el && (el === canvasEl || el instanceof HTMLCanvasElement)) {
          ok = true;
        } else if (el && typeof el.closest === "function" && el.closest("canvas")) {
          ok = true;
        }
        if (!ok) return false;
      } catch (err) {
        return false;
      }
      const pt = graphPointFromEvent(e);
      if (!pt) return false;
      // topmost node first (later nodes are drawn on top)
      for (let i = graph._nodes.length - 1; i >= 0; i--) {
        const node = graph._nodes[i];
        if (!node || node.type !== NODE_CLASS || !node.__esnListWidget) continue;
        const st0 = state(node);
        const x0 = node.pos ? node.pos[0] : 0;
        const y0 = node.pos ? node.pos[1] : 0;
        const size = node.size || [220, 100];
        if (pt.gx < x0 || pt.gx > x0 + size[0] || pt.gy < y0 || pt.gy > y0 + size[1]) continue;
        const lx = pt.gx - x0; // node-local x
        const ly = pt.gy - y0; // node-local y
        const delta = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
        // rows list scroll (only when the list overflows its area)
        const viewRows = st0.view ? st0.view.length : st0.rows.length;
        const maxRowScroll = viewRows - MAX_DRAWN_ROWS;
        if (maxRowScroll > 0 && st0.rowsAreaBottom) {
          const rowsTop = (st0.searchZone && st0.searchZone.bottom) ? st0.searchZone.bottom : st0.widgetY + HEADER_H + SEARCH_H;
          // stop at the scroll hint row so the ▲/▼ arrows keep working
          const rowsBottom = st0.rowsAreaBottom - 18;
          if (ly > rowsTop && ly < rowsBottom && lx > 0 && lx < size[0]) {
            if (delta !== 0) {
              st0.scroll = Math.max(0, Math.min(maxRowScroll, st0.scroll + delta * WHEEL_STEP));
              app.graph?.setDirtyCanvas?.(true, true);
            }
            return true; // over a scrollable list - swallow the wheel
          }
        }
        // presets list scroll (only when it overflows its area)
        const entries = presetEntries(st0.presets);
        const maxPScroll = entries.length - MAX_DRAWN_PRESETS;
        if (maxPScroll > 0 && st0.presetListArea) {
          if (ly > st0.presetListArea.top && ly < st0.presetListArea.bottom &&
              lx > 0 && lx < size[0]) {
            if (delta !== 0) {
              st0.presetScroll = Math.max(0, Math.min(maxPScroll, st0.presetScroll + delta * PRESET_WHEEL_STEP));
              app.graph?.setDirtyCanvas?.(true, true);
            }
            return true; // over a scrollable list - swallow the wheel
          }
        }
        // over this node but not over a scrollable list: keep looking for a
        // (possibly lower) overlapping node with a scrollable list
        continue;
      }
      return false;
    }
    // Shared handler: scroll the list when the wheel is over one of our
    // scrollable lists, otherwise leave the event alone (zoom/pan still work).
    let lastDbg = 0;
    function onWheelCapture(e) {
      if (dialog) return; // the dialog has its own scrollers
      try {
        const hit = hitScrollableList(e);
        // Diagnostic aid: enable with  window.__ESN_DEBUG = true  in the
        // browser console, then wheel over the node and paste the output.
        if (window.__ESN_DEBUG) {
          const now = Date.now();
          if (now - lastDbg > 400) {
            lastDbg = now;
            const cv = app.canvas;
            const ds = cv && cv.ds ? cv.ds : {};
            const dsg = ds.scale != null ? ds.scale.toFixed(3) : "?";
            const dso = ds.offset ? "[" + ds.offset[0].toFixed(1) + "," + ds.offset[1].toFixed(1) + "]" : "?";
            const cn = (window.graph && window.graph._nodes ? window.graph._nodes.length : -1);
            console.log("[ESN-wheel] phase=" + (e.eventPhase) + " deltaY=" + e.deltaY +
              " hit=" + hit + " canvasScale=" + dsg + " dsOffset=" + dso +
              " nodes=" + cn + " target=" + (e.target && e.target.tagName));
          }
        }
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          hideHover();
        }
      } catch (err) {
        // never break the canvas because of our hit-testing
      }
    }
    // document capture runs before any canvas bubble listener; also attach to
    // the canvas itself in the capture phase (canvas capture runs before
    // canvas bubble handlers that zoom) and to window for the newest
    // frontends that listen on window.
    document.addEventListener("wheel", onWheelCapture, { capture: true, passive: false });
    canvas.addEventListener("wheel", onWheelCapture, { capture: true, passive: false });
    window.addEventListener("wheel", onWheelCapture, { capture: true, passive: false });
    canvas.addEventListener("pointerdown", hideHover);
  }
  attach();
}

// ---------------------------------------------------------------------------
// dialog (tabs: Rows / Presets)
// ---------------------------------------------------------------------------

let dialog = null;
let dlgTimerRef = null;

function closeDialog() {
  if (dlgTimerRef && dlgTimerRef._poll) {
    clearInterval(dlgTimerRef._poll);
    dlgTimerRef._poll = null;
  }
  dlgTimerRef = null;
  if (dialog) {
    const d = dialog;
    dialog = null;
    document.removeEventListener("keydown", d._onKey);
    if (d._overlay && d._overlay.parentNode) d._overlay.parentNode.removeChild(d._overlay);
  }
}

// build a modal frame; returns { overlay, panel, title, header, body, footer }
function makeModalFrame(titleText) {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.55)",
    fontFamily: "sans-serif",
  });
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) closeDialog();
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    background: "#1b1b1b",
    color: "#eee",
    border: "1px solid #444",
    borderRadius: "10px",
    width: "min(820px, 95vw)",
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
  });

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    borderBottom: "1px solid #333",
    flex: "0 0 auto",
    gap: "8px",
  });
  const title = document.createElement("div");
  title.textContent = titleText || "";
  title.style.fontWeight = "bold";
  title.style.fontSize = "14px";
  title.style.marginRight = "auto";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close (Esc)";
  Object.assign(closeBtn.style, { cursor: "pointer", background: "transparent", color: "#ccc", border: "none", fontSize: "16px" });
  closeBtn.addEventListener("click", closeDialog);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  Object.assign(body.style, { overflowY: "auto", padding: "10px 14px", flex: "1 1 auto" });

  const footer = document.createElement("div");
  Object.assign(footer.style, {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px",
    padding: "10px 14px", borderTop: "1px solid #333", flex: "0 0 auto",
  });

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  overlay.appendChild(panel);

  return { overlay, panel, title, header, body, footer, closeBtn };
}

function mkBtn(text, opts) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  opts = opts || {};
  Object.assign(b.style, {
    cursor: "pointer",
    background: opts.bg || "#2c2c2c",
    color: opts.color || "#ddd",
    border: opts.border || "1px solid #444",
    borderRadius: "6px",
    padding: opts.pad || "7px 12px",
    fontSize: opts.font || "13px",
  });
  if (opts.title) b.title = opts.title;
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  return b;
}

function mkField(labelText, value, placeholder) {
  const col = document.createElement("div");
  Object.assign(col.style, { flex: "1", display: "flex", flexDirection: "column", gap: "3px", minWidth: "0" });
  const lab = document.createElement("label");
  lab.textContent = labelText;
  Object.assign(lab.style, { fontSize: "11px", color: "#aaa", textTransform: "uppercase", letterSpacing: "0.4px" });
  const ta = document.createElement("textarea");
  ta.value = value || "";
  ta.placeholder = placeholder || "";
  ta.rows = 2;
  Object.assign(ta.style, {
    background: "#171717", color: "#eee", border: "1px solid #3d3d3d",
    borderRadius: "4px", padding: "5px 6px", fontFamily: "monospace",
    fontSize: "12px", resize: "vertical", width: "100%", boxSizing: "border-box",
    minHeight: "44px",
  });
  col.appendChild(lab);
  col.appendChild(ta);
  return { col, ta };
}

function buildRowCard(row, idx, api) {
  const card = document.createElement("div");
  card.__esnRow = row; // image/num bound regardless of reorder
  Object.assign(card.style, { border: "1px solid #3a3a3a", borderRadius: "8px", padding: "8px", background: "#202020" });

  const topRow = document.createElement("div");
  Object.assign(topRow.style, { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" });
  const idxLabel = document.createElement("span");
  idxLabel.textContent = "Row " + (idx + 1);
  idxLabel.className = "esn-idx";
  Object.assign(idxLabel.style, { fontWeight: "bold", minWidth: "46px" });
  const freqBadge = document.createElement("span");
  const refreshFreqBadge = () => {
    const fq = (row.freq || 0) > 0 ? (row.freq | 0) : 0;
    if (fq > 0) {
      freqBadge.textContent = "×" + fq + " used";
      freqBadge.style.color = "#ffcc66";
      freqBadge.style.display = "";
      freqBadge.title = "Used " + fq + " time(s) when this node ran";
    } else {
      freqBadge.textContent = "";
      freqBadge.style.display = "none";
    }
  };
  Object.assign(freqBadge.style, { fontSize: "11px", marginLeft: "2px", color: "#ffcc66", fontWeight: "normal" });
  refreshFreqBadge();

  const numWrap = document.createElement("span");
  Object.assign(numWrap.style, { display: "flex", alignItems: "center", gap: "4px", color: "#aaa", fontSize: "11px" });
  numWrap.appendChild(document.createTextNode("#"));
  const numInp = document.createElement("input");
  numInp.type = "text";
  numInp.value = row.num != null ? String(row.num) : "";
  numInp.placeholder = "auto";
  numInp.title = "Original row number (from old data import). Empty = positional. Presets resolve by this number first.";
  Object.assign(numInp.style, {
    width: "56px", background: "#171717", color: "#eee", border: "1px solid #3d3d3d",
    borderRadius: "4px", padding: "2px 4px", fontFamily: "monospace", fontSize: "11px",
  });
  numInp.addEventListener("change", () => {
    const v = numInp.value.trim();
    if (v === "") row.num = null;
    else {
      const n = Number(v);
      row.num = Number.isInteger(n) && n >= 0 ? n : null;
      numInp.value = row.num != null ? String(row.num) : "";
    }
  });
  numWrap.appendChild(numInp);
  numWrap.appendChild(document.createTextNode("(orig)"));
  numInp.title = "Original row number (old-data import). Empty = positional. Presets use it first.";

  const mk = (t, tt) => {
    const bb = document.createElement("button");
    bb.type = "button";
    bb.textContent = t;
    bb.title = tt;
    Object.assign(bb.style, {
      cursor: "pointer", background: "#2c2c2c", color: "#ddd",
      border: "1px solid #444", borderRadius: "4px", padding: "2px 8px", fontSize: "12px",
    });
    return bb;
  };
  const up = mk("↑", "Move up");
  const down = mk("↓", "Move down");
  const del = mk("🗑", "Delete row");
  del.style.color = "#f88";
  // checkbox: manual pick (select_checked input uses rows with on=true)
  const onCb = document.createElement("input");
  onCb.type = "checkbox";
  onCb.checked = row.on !== false;
  onCb.title = "Tick to include this row when 'select_checked' is on";
  Object.assign(onCb.style, { width: "16px", height: "16px", cursor: "pointer", accentColor: "#3a7bd5" });
  onCb.addEventListener("change", () => { row.on = onCb.checked; });

  // category label (free text, filters the list / groups rows)
  const catWrap = document.createElement("span");
  Object.assign(catWrap.style, { display: "flex", alignItems: "center", gap: "4px", color: "#aaa", fontSize: "11px" });
  catWrap.appendChild(document.createTextNode("Cat:"));
  const catInp = document.createElement("input");
  catInp.type = "text";
  catInp.value = row.cat || "";
  catInp.placeholder = "category";
  catInp.title = "Row category (free text) - used to filter / group rows";
  Object.assign(catInp.style, {
    width: "110px", background: "#171717", color: "#eee", border: "1px solid #3d3d3d",
    borderRadius: "4px", padding: "2px 4px", fontSize: "11px",
  });
  catInp.addEventListener("input", () => { row.cat = catInp.value; });
  catWrap.appendChild(catInp);

  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  topRow.append(onCb, idxLabel, freqBadge, numWrap, catWrap, up, down, spacer, del);

  const fields = document.createElement("div");
  Object.assign(fields.style, { display: "flex", gap: "8px", alignItems: "flex-start", flexWrap: "wrap" });

  const pos = mkField("Positive", row.pos, "positive prompt");
  const neg = mkField("Negative", row.neg, "negative prompt");
  // keep the bound row live so a hidden (filtered-out) card still saves
  pos.ta.addEventListener("input", () => { row.pos = pos.ta.value; });
  neg.ta.addEventListener("input", () => { row.neg = neg.ta.value; });
  fields.appendChild(pos.col);
  fields.appendChild(neg.col);

  // image column
  const imgCol = document.createElement("div");
  Object.assign(imgCol.style, { flex: "0 0 92px", display: "flex", flexDirection: "column", gap: "4px", alignItems: "center" });
  const imgLab = document.createElement("label");
  imgLab.textContent = "Image";
  Object.assign(imgLab.style, { fontSize: "11px", color: "#aaa", textTransform: "uppercase", letterSpacing: "0.4px", alignSelf: "flex-start" });
  imgCol.appendChild(imgLab);

  const thumb = document.createElement("div");
  Object.assign(thumb.style, {
    width: "76px", height: "76px", border: "1px dashed #555", borderRadius: "6px",
    display: "flex", alignItems: "center", justifyContent: "center", color: "#777",
    fontSize: "10px", textAlign: "center", overflow: "hidden",
    background: "#151515 center/contain no-repeat", cursor: "pointer",
  });
  thumb.title = "Click or drop an image";
  const setThumb = () => {
    thumb.style.backgroundImage = row.img ? "url(" + row.img + ")" : "";
    thumb.textContent = row.img ? "" : "no image";
  };
  setThumb();

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.style.display = "none";
  const onFiles = async (files) => {
    const file = files && files[0];
    const dataUrl = await readImageFile(file);
    if (dataUrl) {
      row.img = dataUrl;
      setThumb();
    }
  };
  thumb.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => onFiles(fileInput.files).then(() => { fileInput.value = ""; }));
  thumb.addEventListener("dragover", (e) => { e.preventDefault(); });
  thumb.addEventListener("drop", (e) => {
    e.preventDefault();
    onFiles(e.dataTransfer && e.dataTransfer.files);
  });

  const clearImg = document.createElement("button");
  clearImg.type = "button";
  clearImg.textContent = "Remove";
  Object.assign(clearImg.style, { cursor: "pointer", background: "transparent", border: "none", color: "#e88", fontSize: "11px", padding: "0" });
  clearImg.addEventListener("click", () => { row.img = ""; setThumb(); });

  imgCol.appendChild(thumb);
  imgCol.appendChild(fileInput);
  imgCol.appendChild(clearImg);
  fields.appendChild(imgCol);

  card.appendChild(topRow);
  card.appendChild(fields);

  up.addEventListener("click", () => api.moveUp(card));
  down.addEventListener("click", () => api.moveDown(card));
  del.addEventListener("click", () => api.remove(card));
  return card;
}

// Rows working copy + API shared between the list and each card
function showDialog(node, editIndex, initialTab) {
  closeDialog();
  // typing belongs to the dialog now, not to the on-node search field
  if (searchInput && document.activeElement === searchInput) {
    try { searchInput.blur(); } catch (e) {}
  }
  syncFromWidget(node);
  const rows = cleanRows(state(node).rows); // working copy
  let pendingFile = state(node).file || "";

  const frame = makeModalFrame("✎ Easy String Neg Editor");
  const overlay = frame.overlay;
  const body = frame.body;
  const footer = frame.footer;

  // ---------------- tabs ----------------
  const tabBar = document.createElement("div");
  Object.assign(tabBar.style, {
    display: "flex", gap: "4px", padding: "0 10px", flex: "0 0 auto",
    borderBottom: "1px solid #333",
  });
  const tabBtn = (label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    Object.assign(b.style, {
      cursor: "pointer", background: "transparent", color: "#aaa", border: "none",
      borderBottom: "2px solid transparent", padding: "8px 12px", fontSize: "13px",
    });
    return b;
  };
  const tabRowsB = tabBtn("Rows");
  const tabPresetsB = tabBtn("Presets");
  const tabDataB = tabBtn("Data file");
  const setActive = (btn, on) => {
    btn.dataset.active = on ? "1" : "0";
    btn.style.color = on ? "#4af" : "#aaa";
    btn.style.borderBottomColor = on ? "#4af" : "transparent";
  };
  setActive(tabRowsB, true);
  setActive(tabPresetsB, false);
  setActive(tabDataB, false);
  tabBar.appendChild(tabRowsB);
  tabBar.appendChild(tabPresetsB);
  tabBar.appendChild(tabDataB);
  frame.panel.insertBefore(tabBar, frame.header ? frame.header.nextSibling : frame.panel.firstChild);

  // ---------------- shared working state ----------------
  let currentTab = "rows";
  const fullRows = () => rows;
  const pTaRef = { value: "" };

  // ---------------- Rows panel ----------------
  const rowsPanel = document.createElement("div");
  Object.assign(rowsPanel.style, { display: "flex", flexDirection: "column", gap: "8px", minHeight: "0", flex: "1 1 auto" });

  const toolbar = document.createElement("div");
  Object.assign(toolbar.style, { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" });

  const searchInp = document.createElement("input");
  searchInp.type = "text";
  searchInp.placeholder = "Search rows (pos / neg / number)…";
  Object.assign(searchInp.style, {
    flex: "1", minWidth: "140px", background: "#171717", color: "#eee",
    border: "1px solid #3d3d3d", borderRadius: "6px", padding: "7px 10px", fontSize: "13px",
  });
  const addBtn = mkBtn("+ Add row", { bg: "#2f6f4f", color: "#fff" });
  const importBtn = mkBtn("↗ Import old data", { bg: "#5a4a2f", color: "#ffe8b0", title: "Paste numbered rows (N: … ~) or choose a file" });
  // tick / untick every row at once (rows start unticked; only ticked rows
  // are used when the node input select_checked is on)
  const checkAllB = mkBtn("✓ all", { pad: "5px 9px", font: "12px", title: "Tick every row" });
  checkAllB.addEventListener("click", () => { rows.forEach((r) => { r.on = true; }); applyFilter(); });
  const uncheckAllB = mkBtn("✗ none", { pad: "5px 9px", font: "12px", title: "Untick every row" });
  uncheckAllB.addEventListener("click", () => { rows.forEach((r) => { r.on = false; }); applyFilter(); });
  const sortFreqB = mkBtn("⇅ by use", { pad: "5px 9px", font: "12px", title: "Sort rows by usage frequency (most used first)" });
  sortFreqB.addEventListener("click", () => {
    const ordered = sortRowsByFreq(rows);
    rows.length = 0;
    for (const r of ordered) rows.push(r);
    applyFilter();
  });
  // category filter: built from all row cats; '' = all
  const catSel = document.createElement("select");
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All categories";
  catSel.appendChild(allOpt);
  const rebuildCats = () => {
    const cur = catSel.value;
    catSel.innerHTML = "";
    catSel.appendChild(allOpt);
    const seen = [];
    rows.forEach((r) => { const c = (r.cat || "").trim(); if (c && seen.indexOf(c) === -1) seen.push(c); });
    seen.sort();
    seen.forEach((c) => {
      const o = document.createElement("option");
      o.value = c; o.textContent = c; catSel.appendChild(o);
    });
    if (cur && seen.indexOf(cur) !== -1) catSel.value = cur;
  };
  rebuildCats();
  Object.assign(catSel.style, { background: "#171717", color: "#eee", border: "1px solid #3d3d3d", borderRadius: "6px", padding: "7px 6px", fontSize: "13px", maxWidth: "170px" });
  catSel.title = "Filter rows by category";

  toolbar.appendChild(searchInp);
  toolbar.appendChild(catSel);
  toolbar.appendChild(addBtn);
  toolbar.appendChild(importBtn);
  toolbar.appendChild(checkAllB);
  toolbar.appendChild(uncheckAllB);
  toolbar.appendChild(sortFreqB);
  rowsPanel.appendChild(toolbar);

  const hintEl = document.createElement("div");
  Object.assign(hintEl.style, { color: "#888", fontSize: "11px" });
  rowsPanel.appendChild(hintEl);

  const list = document.createElement("div");
  Object.assign(list.style, { display: "flex", flexDirection: "column", gap: "6px", marginTop: "2px", overflowY: "auto", maxHeight: "56vh", paddingRight: "4px" });
  rowsPanel.appendChild(list);

  const rowsApi = {
    moveUp(card) {
      const i = rows.indexOf(card.__esnRow);
      if (i > 0) {
        const tmp = rows[i - 1];
        rows[i - 1] = rows[i];
        rows[i] = tmp;
        applyFilter();
      }
    },
    moveDown(card) {
      const i = rows.indexOf(card.__esnRow);
      if (i !== -1 && i < rows.length - 1) {
        const tmp = rows[i + 1];
        rows[i + 1] = rows[i];
        rows[i] = tmp;
        applyFilter();
      }
    },
    remove(card) {
      const i = rows.indexOf(card.__esnRow);
      if (i !== -1) rows.splice(i, 1);
      rebuildCats();
      applyFilter();
    },
  };

  // ---- windowed rendering: only build cards for what is visible ----
  let viewRows = []; // filtered rows currently backing the DOM list
  let renderedCount = 0;
  const cardEls = new Map(); // row -> live card element

  function rowMatches(row, q, cat) {
    if (cat) {
      const rc = (row.cat || "").trim();
      if (rc !== cat) return false;
    }
    if (!q) return true;
    q = q.toLowerCase();
    const rc = (row.cat || "").toLowerCase();
    return (String(row.num != null ? row.num : "") + " " + rc + " " + row.pos + " " + row.neg).toLowerCase().indexOf(q) !== -1;
  }

  function renderChunk(extra) {
    const want = Math.min(viewRows.length, renderedCount + RENDER_CHUNK + (extra || 0));
    let frag = document.createDocumentFragment();
    let idx = renderedCount;
    for (; idx < want; idx++) {
      const row = viewRows[idx];
      const i = rows.indexOf(row);
      let card = cardEls.get(row);
      if (!card) {
        card = buildRowCard(row, i, rowsApi);
        cardEls.set(row, card);
      }
      const lbl = card.querySelector(".esn-idx");
      if (lbl) lbl.textContent = "Row " + (i + 1);
      frag.appendChild(card);
    }
    renderedCount = idx;
    if (idx > 0) list.appendChild(frag);
    // if the container still has free space, keep filling
    if (renderedCount < viewRows.length && list.scrollHeight <= list.clientHeight + 4) {
      renderChunk(0);
    }
  }

  function applyFilter() {
    const q = searchInp.value.trim();
    const cat = catSel.value;
    viewRows = [];
    rows.forEach((row) => { if (rowMatches(row, q, cat)) viewRows.push(row); });
    list.innerHTML = "";
    cardEls.clear();
    renderedCount = 0;
    renderChunk(0);
    const showAll = viewRows.length === rows.length;
    hintEl.textContent = viewRows.length + " of " + rows.length + " row(s)" +
      (!showAll ? " (filtered)" : "") + (cat ? " - category: " + cat : "") +
      " - rows start unticked: tick the ones to use when select_checked is on";
  }

  list.addEventListener("scroll", () => {
    if (renderedCount < viewRows.length &&
        list.scrollTop + list.clientHeight > list.scrollHeight - 420) {
      renderChunk(0);
    }
  });

  searchInp.addEventListener("input", applyFilter);
  catSel.addEventListener("change", applyFilter);

  addBtn.addEventListener("click", () => {
    const row = { num: null, cat: "", on: false, pos: "", neg: "", img: "" };
    rows.push(row);
    rebuildCats();
    searchInp.value = "";
    catSel.value = "";
    applyFilter();
    list.scrollTop = list.scrollHeight;
    const card = cardEls.get(row);
    if (card) {
      const ta = card.querySelector("textarea");
      if (ta) ta.focus();
    }
  });

  // ---------------- import modal (old data) ----------------
  function openImportModal() {
    const im = document.createElement("div");
    Object.assign(im.style, {
      position: "fixed", inset: "0", zIndex: "2147483002",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.6)", fontFamily: "sans-serif",
    });
    im.addEventListener("pointerdown", (e) => { if (e.target === im) im.remove(); });
    const box = document.createElement("div");
    Object.assign(box.style, {
      background: "#1b1b1b", color: "#eee", border: "1px solid #555", borderRadius: "10px",
      width: "min(700px, 92vw)", maxHeight: "86vh", display: "flex", flexDirection: "column",
      boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
    });
    const hd = document.createElement("div");
    Object.assign(hd.style, { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #333" });
    const hT = document.createElement("div");
    hT.textContent = "↗ Import old data";
    hT.style.fontWeight = "bold";
    const hX = mkBtn("✕", { bg: "transparent", border: "none", pad: "2px 8px", font: "16px" });
    hX.addEventListener("click", () => im.remove());
    hd.appendChild(hT);
    hd.appendChild(hX);
    box.appendChild(hd);

    const bd = document.createElement("div");
    Object.assign(bd.style, { overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px" });
    const info = document.createElement("div");
    info.textContent = "Paste old numbered rows (each line: number: text …, optional trailing ~). " +
      "A line in the old SelectorNeg style \"positive --- negative\" is split: text before --- becomes the " +
      "positive field, text after --- the negative field. Lines without --- go into the chosen field below. " +
      "The original number is kept (shown as # on each card) and is used by presets / line selection.";
    Object.assign(info.style, { color: "#999", fontSize: "12px", lineHeight: "1.5" });
    bd.appendChild(info);

    const destRow = document.createElement("div");
    Object.assign(destRow.style, { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" });
    destRow.appendChild(document.createTextNode("Lines without --- go into:"));
    const destSel = document.createElement("select");
    const optNeg = document.createElement("option");
    optNeg.value = "neg";
    optNeg.textContent = "negative (recommended)";
    const optPos = document.createElement("option");
    optPos.value = "pos";
    optPos.textContent = "positive";
    destSel.appendChild(optNeg);
    destSel.appendChild(optPos);
    Object.assign(destSel.style, { background: "#171717", color: "#eee", border: "1px solid #3d3d3d", borderRadius: "4px", padding: "5px 8px" });
    destRow.appendChild(destSel);
    const modeAdd = document.createElement("label");
    modeAdd.style.cssText = "color:#ccc;font-size:12px;display:flex;gap:4px;align-items:center";
    const modeCb = document.createElement("input");
    modeCb.type = "checkbox";
    modeAdd.appendChild(modeCb);
    modeAdd.appendChild(document.createTextNode("replace existing rows"));
    destRow.appendChild(modeAdd);
    bd.appendChild(destRow);

    const ta = document.createElement("textarea");
    ta.placeholder = "1: ;james m hardiman, ;lostgoose ~\n2: ;alan moore --- ;comics ~";
    Object.assign(ta.style, {
      width: "100%", minHeight: "240px", boxSizing: "border-box", background: "#141414",
      color: "#eee", border: "1px solid #3d3d3d", borderRadius: "6px", padding: "8px",
      fontFamily: "monospace", fontSize: "12px", resize: "vertical",
    });
    bd.appendChild(ta);
    const fileRow = document.createElement("div");
    Object.assign(fileRow.style, { display: "flex", gap: "8px", alignItems: "center" });
    const fileBtn = mkBtn("Choose .txt file…", {});
    const fileInp = document.createElement("input");
    fileInp.type = "file";
    fileInp.accept = ".txt,.csv,text/plain";
    fileInp.style.display = "none";
    fileBtn.addEventListener("click", () => fileInp.click());
    fileInp.addEventListener("change", () => {
      const f = fileInp.files && fileInp.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => { ta.value = String(fr.result || ""); };
      fr.onerror = () => {};
      fr.readAsText(f);
    });
    fileRow.appendChild(fileBtn);
    fileRow.appendChild(fileInp);
    bd.appendChild(fileRow);
    box.appendChild(bd);

    const ft = document.createElement("div");
    Object.assign(ft.style, { display: "flex", justifyContent: "flex-end", gap: "8px", padding: "10px 14px", borderTop: "1px solid #333" });
    const cancel = mkBtn("Cancel", {});
    cancel.addEventListener("click", () => im.remove());
    const go = mkBtn("Import", { bg: "#3a7bd5", color: "#fff", font: "13px" });
    go.addEventListener("click", () => {
      const dest = destSel.value;
      const imported = parseOldRows(ta.value, dest);
      if (!imported.length) {
        info.textContent = "No numbered lines found - make sure each line starts with a number and a colon.";
        info.style.color = "#e88";
        return;
      }
      if (modeCb.checked) rows.length = 0;
      for (const r of imported) rows.push(r);
      rebuildCats();
      applyFilter();
      im.remove();
    });
    ft.appendChild(cancel);
    ft.appendChild(go);
    box.appendChild(ft);
    im.appendChild(box);
    document.body.appendChild(im);
    ta.focus();
  }

  importBtn.addEventListener("click", openImportModal);

  // ---------------- Presets panel ----------------
  const presetsPanel = document.createElement("div");
  Object.assign(presetsPanel.style, { display: "none", flexDirection: "column", gap: "8px" });
  const pInfo = document.createElement("div");
  pInfo.textContent = "One preset per line:  presetNumber: row numbers  (spaces, commas or ranges).  Example:  1: 108 193 135  → preset 1 uses rows 108, 193, 135 (matched by their original #, fallback to position).";
  Object.assign(pInfo.style, { color: "#999", fontSize: "12px", lineHeight: "1.5" });
  const pTa = document.createElement("textarea");
  pTa.value = state(node).presets;
  pTa.placeholder = "1: 108 193 135";
  Object.assign(pTa.style, {
    width: "100%", minHeight: "160px", boxSizing: "border-box", background: "#141414",
    color: "#eee", border: "1px solid #3d3d3d", borderRadius: "6px", padding: "8px",
    fontFamily: "monospace", fontSize: "12px", resize: "vertical",
  });
  pTaRef.value = pTa;
  const pTool = document.createElement("div");
  Object.assign(pTool.style, { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" });
  const pImp = mkBtn("↗ Import presets…", { bg: "#5a4a2f", color: "#ffe8b0", title: "Paste a preset block (merges)" });
  const pCnt = document.createElement("span");
  Object.assign(pCnt.style, { color: "#888", fontSize: "11px" });
  const refreshCnt = () => { pCnt.textContent = countPresets(pTa.value) + " preset(s)"; };
  pTa.addEventListener("input", refreshCnt);
  refreshCnt();
  pTool.appendChild(pImp);
  pTool.appendChild(pCnt);
  presetsPanel.appendChild(pInfo);
  presetsPanel.appendChild(pTool);
  presetsPanel.appendChild(pTa);

  pImp.addEventListener("click", () => {
    const cur = pTa.value || "";
    const pv = window.prompt("Paste preset lines, one per line:\n\n1: 108 193 135\n2: 292 273\n\nThey merge with the existing presets.", cur);
    if (pv == null) return;
    const merged = normalizePresetText(cur + (cur ? "\n" : "") + pv);
    pTa.value = merged;
    refreshCnt();
  });

  // ---------------- Data file panel ----------------
  const dataPanel = document.createElement("div");
  Object.assign(dataPanel.style, { display: "none", flexDirection: "column", gap: "10px" });
  const dInfo = document.createElement("div");
  dInfo.textContent = "Store this dataset (rows + presets) in a .json file inside the node\u2019s data folder. The workflow keeps only the file name, so one dataset can be reused across workflows. Editing happens in memory and is written when you press Save here or the main Save button.";
  Object.assign(dInfo.style, { color: "#999", fontSize: "12px", lineHeight: "1.5" });
  const dRow1 = document.createElement("div");
  Object.assign(dRow1.style, { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" });
  const dName = document.createElement("input");
  dName.type = "text";
  dName.value = pendingFile;
  dName.placeholder = "dataset.json";
  dName.title = "File name inside the node data folder (letters/digits/space/dot/dash/underscore, must end with .json)";
  Object.assign(dName.style, {
    flex: "1", minWidth: "200px", background: "#171717", color: "#eee",
    border: "1px solid #3d3d3d", borderRadius: "6px", padding: "7px 10px", fontSize: "13px",
  });
  dName.addEventListener("input", () => { pendingFile = dName.value.trim(); });
  const dSave = mkBtn("Save to file", { bg: "#2f6f4f", color: "#fff" });
  const dLoad = mkBtn("Load from file", { bg: "#3a7bd5", color: "#fff" });
  const dRefresh = mkBtn("↻", { title: "Refresh file list" });
  dRow1.appendChild(dName);
  dRow1.appendChild(dSave);
  dRow1.appendChild(dLoad);
  dRow1.appendChild(dRefresh);
  dataPanel.appendChild(dInfo);
  dataPanel.appendChild(dRow1);
  const dStatus = document.createElement("div");
  Object.assign(dStatus.style, { color: "#888", fontSize: "11px" });
  dataPanel.appendChild(dStatus);
  const dList = document.createElement("div");
  Object.assign(dList.style, { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "220px", overflowY: "auto", border: "1px solid #333", borderRadius: "6px", padding: "6px" });
  dataPanel.appendChild(dList);

  function statusText(msg, err) {
    dStatus.textContent = msg;
    dStatus.style.color = err ? "#e88" : "#8b8";
  }

  function collectRowsFromCards() {
    const out = [];
    rows.forEach((row, i) => {
      const card = cardEls.get(row);
      let pos = "", neg = "";
      if (card) {
        const tas = card.querySelectorAll("textarea");
        pos = tas[0] ? tas[0].value : "";
        neg = tas[1] ? tas[1].value : "";
      } else {
        pos = row.pos;
        neg = row.neg;
      }
      out.push({
        num: row.num != null ? row.num : null,
        cat: typeof row.cat === "string" ? row.cat : "",
        on: row.on !== false,
        pos: pos,
        neg: neg,
        img: typeof row.img === "string" ? row.img : "",
        freq: (typeof row.freq === "number" && row.freq > 0) ? Math.floor(row.freq) : 0,
      });
    });
    return out;
  }

  async function refreshFileList() {
    const files = await dsList();
    dList.innerHTML = "";
    if (!files.length) {
      const empty = document.createElement("div");
      empty.textContent = "(no datasets saved yet)";
      empty.style.color = "#666";
      empty.style.fontSize = "12px";
      empty.style.padding = "4px";
      dList.appendChild(empty);
      return;
    }
    files.forEach((name) => {
      const rowBtn = mkBtn(name, { bg: "transparent", font: "12px", pad: "4px 8px" });
      rowBtn.style.textAlign = "left";
      rowBtn.addEventListener("click", () => {
        dName.value = name;
        pendingFile = name;
        doLoad(name);
      });
      dList.appendChild(rowBtn);
    });
  }

  async function doLoad(name) {
    statusText("Loading " + name + "…", false);
    const data = await dsLoad(name);
    if (!data) {
      statusText("Could not load " + name + " - missing or invalid JSON.", true);
      return;
    }
    rows.length = 0;
    const loaded = cleanRows(data.rows);
    for (const r of loaded) rows.push(r);
    pTa.value = (data.presets || "");
    refreshCnt();
    rebuildCats();
    applyFilter();
    pendingFile = name;
    statusText("Loaded " + loaded.length + " row(s) from " + name + ". Changes are applied when you press Save.", false);
  }

  async function doSaveFile() {
    const name = pendingFile.trim();
    if (!name) {
      statusText("Enter a file name first (e.g. artists.json).", true);
      return;
    }
    const outRows = collectRowsFromCards();
    const res = await dsSave(name, outRows, pTa.value || "");
    if (!res) {
      statusText("Save failed - check the file name and that the data folder is writable.", true);
      return;
    }
    pendingFile = name;
    // make the node re-read the freshly written file
    const stf = state(node);
    stf.loadedFile = null;
    stf.loadFailed = false;
    loadDatasetInto(node);
    statusText("Saved " + outRows.length + " row(s) + presets to " + res.file + ".", false);
    refreshFileList();
  }

  dSave.addEventListener("click", doSaveFile);
  dLoad.addEventListener("click", () => doLoad(dName.value.trim()));
  dRefresh.addEventListener("click", refreshFileList);
  refreshFileList();

  // ---------------- panel switching ----------------
  const panels = { rows: rowsPanel, presets: presetsPanel, data: dataPanel };
  const buttons = { rows: tabRowsB, presets: tabPresetsB, data: tabDataB };
  const showTab = (name) => {
    currentTab = name;
    Object.keys(panels).forEach((k) => {
      panels[k].style.display = k === name ? "flex" : "none";
      setActive(buttons[k], k === name);
    });
  };
  tabRowsB.addEventListener("click", () => showTab("rows"));
  tabPresetsB.addEventListener("click", () => showTab("presets"));
  tabDataB.addEventListener("click", () => showTab("data"));
  body.appendChild(rowsPanel);
  body.appendChild(presetsPanel);
  body.appendChild(dataPanel);

  // ---------------- footer (Save / Cancel) ----------------
  const hint = document.createElement("span");
  hint.style.cssText = "color:#888;font-size:11px;flex:1";
  const updateHint = () => {
    hint.textContent = pendingFile
      ? "Dataset file: " + pendingFile + " (rows+presets written to it on Save)"
      : "No dataset file - rows/presets are stored in the workflow";
  };
  updateHint();
  const cancelBtn = mkBtn("Cancel", {});
  cancelBtn.addEventListener("click", closeDialog);
  const saveBtn = mkBtn("Save", { bg: "#3a7bd5", color: "#fff", font: "13px" });
  Object.assign(saveBtn.style, { fontWeight: "bold" });
  saveBtn.addEventListener("click", () => {
    const out = collectRowsFromCards();
    const fname = pendingFile.trim();
    // dataset name first: commitRows/commitPresets then know whether they
    // should write the widgets (embedded mode) or only the file (dataset mode)
    commitDataFile(node, fname);
    commitRows(node, out);
    commitPresets(node, pTa.value || "");
    if (fname) {
      dsSave(fname, out, pTa.value || "").then((res) => {
        if (!res) console.warn("EasyStringNegEditor: dataset file save failed for " + fname);
      });
      // refresh the canvas list from the file we just wrote
      const stf = state(node);
      stf.loadedFile = null;
      stf.loadFailed = false;
      loadDatasetInto(node);
    }
    resizeNode(node);
    closeDialog();
  });

  footer.appendChild(hint);
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  document.body.appendChild(overlay);

  const dlg = { _overlay: overlay, _onKey: null };
  const onKey = (e) => {
    if (e.key === "Escape") closeDialog();
  };
  document.addEventListener("keydown", onKey);
  dlg._onKey = onKey;
  dialog = dlg;
  dlgTimerRef = dlg;

  if (initialTab === "presets" || initialTab === "data") {
    showTab(initialTab);
  }
  applyFilter();
  pTaRef.value = pTa;
  updateHint();
  if (initialTab === "presets") {
    try { if (pTa && typeof pTa.focus === "function") pTa.focus(); } catch (e) {}
  }

  // focus requested row (or first field) once its card is rendered
  const targetIndex = editIndex != null ? editIndex : 0;
  const focusTarget = () => {
    const target = viewRows.length ? cardEls.get(viewRows[Math.min(targetIndex, viewRows.length - 1)]) : null;
    if (!target) return false;
    const ta = target.querySelector("textarea");
    if (ta) ta.focus();
    if (editIndex != null) target.scrollIntoView({ block: "center" });
    return true;
  };
  if (!focusTarget() && viewRows.length > RENDER_CHUNK && editIndex != null) {
    // requested row is far below the first chunk - scroll the list there first
    list.scrollTop = list.scrollHeight;
    renderChunk(Math.max(0, Math.min(viewRows.length, targetIndex + RENDER_CHUNK) - renderedCount));
    setTimeout(() => { if (!focusTarget()) applyFilter(); }, 30);
  } else if (editIndex == null) {
    const first = cardEls.get(viewRows[0]);
    if (first) {
      const ta = first.querySelector("textarea");
      if (ta) ta.focus();
    }
  }
  updateHint();

  // dataset mode: if the file has not reached the state yet, load it into
  // the open dialog so the rows list shows real content
  const dSt = state(node);
  if (dSt.file && !rows.length && dSt.loadedFile !== dSt.file && !dSt.fileLoading) {
    hint.textContent = "Loading dataset " + dSt.file + " …";
    loadDatasetInto(node);
    const pollTimer = setInterval(() => {
      const s2 = state(node);
      if (s2.loadedFile === s2.file) {
        clearInterval(pollTimer);
        if (dlgTimerRef) dlgTimerRef._poll = null;
        rows.length = 0;
        const loaded = cleanRows(s2.rows);
        for (const r of loaded) rows.push(r);
        if (pTa) pTa.value = s2.presets || "";
        if (typeof refreshCnt === "function") refreshCnt();
        rebuildCats();
        applyFilter();
        updateHint();
      } else if (!s2.fileLoading) {
        clearInterval(pollTimer);
        if (dlgTimerRef) dlgTimerRef._poll = null;
        hint.textContent = "Could not load dataset " + s2.file;
        hint.style.color = "#e88";
      }
    }, 160);
    if (dlgTimerRef) dlgTimerRef._poll = pollTimer;
  }
}

// ---------------------------------------------------------------------------
// setup (idempotent, retries until python widgets exist)
// ---------------------------------------------------------------------------

function clearWidgetValuesForFileMode(node) {
  const st = state(node);
  if (!st.file) return;
  // dataset mode: keep the serialized workflow small - the widgets only
  // carry the file name; rows/presets live on disk.
  const rw = rowsWidget(node);
  if (rw && widgetRawValue(rw) !== "[]") {
    try { rw.value = "[]"; } catch (e) {}
    try { if (rw.inputEl && typeof rw.inputEl === "object") rw.inputEl.value = "[]"; } catch (e) {}
  }
  const pw = presetsWidget(node);
  if (pw && widgetRawValue(pw) !== "") {
    try { pw.value = ""; } catch (e) {}
    try { if (pw.inputEl && typeof pw.inputEl === "object") pw.inputEl.value = ""; } catch (e) {}
  }
  // only blank the in-memory rows when they belong to a different file
  if (st.loadedFile !== st.file) {
    st.raw = "[]";
    st.rows = [];
    st.presets = "";
    st.loadedFile = null;
  }
}

function setupNode(node) {
  if (!node || node.__esnSetupDone) return;
  if (!node.widgets || !rowsWidget(node)) {
    // python widgets may be created a tick after onNodeCreated on some UIs
    if (!node.__esnRetries) node.__esnRetries = 0;
    if (node.__esnRetries < 200) {
      node.__esnRetries += 1;
      setTimeout(() => setupNode(node), 30);
    }
    return;
  }
  if (node.widgets.some((w) => w && w.name === UI_NAME)) {
    // already added (e.g. reconfigure) — just refresh
    node.__esnSetupDone = true;
    hideRowsWidget(node);
    syncFromWidget(node);
    clearWidgetValuesForFileMode(node);
    loadDatasetInto(node);
    return;
  }
  node.__esnSetupDone = true;
  hideRowsWidget(node);
  syncFromWidget(node);
  clearWidgetValuesForFileMode(node);
  loadDatasetInto(node);
  const widget = makeListWidget(node);
  try {
    if (typeof node.addCustomWidget === "function") {
      node.addCustomWidget(widget);
    } else if (node.widgets) {
      node.widgets.push(widget);
    }
  } catch (err) {
    console.error("EasyStringNegEditor: failed to add widget", err);
    return;
  }
  node.__esnListWidget = widget;
  installHover();
  resizeNode(node);
}

function refreshNode(node) {
  if (!node || node.type !== NODE_CLASS) return;
  syncFromWidget(node);
  loadDatasetInto(node);
  resizeNode(node);
}

// Dataset mode: load rows+presets from disk into the node state (async).
// The canvas then shows the real rows; nothing is written into the widget
// values so the workflow keeps only the file name.
function loadDatasetInto(node) {
  const st = state(node);
  if (!st.file) {
    st.loadedFile = null;
    return;
  }
  if (st.fileLoading) return;
  if (st.loadedFile === st.file) return;
  if (st.loadFailed) return;
  st.fileLoading = true;
  st.loadFailed = false;
  dsLoad(st.file).then((data) => {
    st.fileLoading = false;
    if (!data) {
      console.warn("EasyStringNegEditor: cannot load dataset " + st.file);
      st.loadFailed = true;
      try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
      resizeNode(node);
      return;
    }
    st.rows = cleanRows(data.rows || []);
    st.raw = dumpRows(st.rows);
    st.presets = data.presets || "";
    st.loadedFile = st.file;
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    resizeNode(node);
  });
}

// ---------------------------------------------------------------------------
// extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "Ghost.EasyStringNegEditor",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== NODE_CLASS) return;

    // apply usage-frequency counters that the Python side returns through the
    // "ui" channel after each execution ({"esn_freq": [0, 2, 1, ...]})
    nodeType.prototype.onExecuted = function (message) {
      try {
        const st = this.__esn ? state(this) : null;
        if (!st || !message || !Array.isArray(message.esn_freq)) return;
        const freqs = message.esn_freq;
        if (freqs.length !== st.rows.length) return; // rows changed meanwhile
        let changed = false;
        for (let i = 0; i < freqs.length; i++) {
          const n = Number(freqs[i]);
          const fq = (Number.isFinite(n) && n > 0) ? Math.floor(n) : 0;
          if ((st.rows[i].freq || 0) !== fq) {
            st.rows[i].freq = fq;
            changed = true;
          }
        }
        if (!changed) return;
        commitRows(this, st.rows); // persist into widget (or dataset file)
        try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
        resizeNode(this);
      } catch (err) {
        // the frequency feedback is best-effort; never break the graph on it
        console.warn("EasyStringNegEditor: onExecuted freq sync failed", err);
      }
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      setupNode(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      // after a workflow/config restore, python widgets may be fresh —
      // re-run setup (idempotent) and resync our list height
      this.__esnSetupDone = false;
      setupNode(this);
      refreshNode(this);
    };
  },
})
