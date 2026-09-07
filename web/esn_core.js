// EasyStringNegEditor — core data layer.
//
// Constants, canvas helpers, row/preset parsing and persistence, dataset-file
// I/O and image downscaling for the EasyStringNegEditor node. No DOM/canvas
// widget code lives here; those live in the sibling modules:
//
//   esn_core.js        this file - shared data + helpers
//   esn_view.js        row list view model (filter / frequency sort / sizing)
//   esn_widget.js      the custom canvas widget (draw + mouse) + search / scrollbar
//   esn_hover.js       DOM hover preview + wheel scrolling over the lists
//   esn_dialog.js      the "Rows / Presets / Data file" DOM dialog
//   esn_lifecycle.js   node setup / refresh / dataset loading
//   easy_string_neg_editor.js  entry point - extension registration only
//
// v1.5.6: refactor — data layer extracted from the monolithic editor file.
// v1.5.5: on-node search bar, usage-frequency ranking (×N + ⇅ sort), drag
// scrollbar for long row lists.

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
  if (window.__ESN_DEBUG) {
    const onRows = st.rows.filter((r) => r && r.on !== false);
    console.log("[ESN-persist] saving file=" + st.file + " rows=" + st.rows.length +
      " on=true count=" + onRows.length +
      " firstOn=" + JSON.stringify(onRows.slice(0, 3).map((r) => (r.num != null ? "#" + r.num : "?") + ":" + (r.cat || "-"))));
  }
  dsSave(st.file, st.rows, st.presets).then((res) => {
    if (window.__ESN_DEBUG) console.log("[ESN-persist] save result ok=" + !!(res && res.ok));
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

export {
  app,
  // widget/column names
  NODE_CLASS, ROWS_NAME, PRESETS_NAME, DATA_NAME, UI_NAME,
  // layout constants
  MAX_DRAWN_ROWS, WHEEL_STEP, PRESET_WHEEL_STEP, RENDER_CHUNK,
  ROW_H, HEADER_H, SEARCH_H, FREQ_W, SB_W,
  MAX_DRAWN_PRESETS, PRESET_H, PRESET_HDR_H, PRESET_GAP,
  IMG_MAX_EDGE, IMG_QUALITY, NL, CR,
  // helpers
  isDigits, parseRows, cleanRows, dumpRows, clampText, state,
  findWidget, rowsWidget, presetsWidget, dataWidget, widgetRawValue,
  hideTextWidget, hideRowsWidget, syncFromWidget,
  persistFileNow, scheduleFilePersist,
  commitRows, commitPresets, commitDataFile,
  countPresets, presetEntries, presetChoice, stepPresetChoice,
  setPresetChoice, normalizePresetText,
  parseOldLine, parseOldRows, indexOfTopLevelDash,
  dsList, dsLoad, dsSave,
  fileToDataUrl, downscaleDataUrl, readImageFile,
};
