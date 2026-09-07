// EasyStringNegEditor — front-end row editor.
//
// Adds a visual row list + "Rows / Presets" dialog to the EasyStringNegEditor
// node. Compatible with BOTH the legacy ComfyUI web UI and the new
// ComfyUI_frontend based UI.
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
const UI_NAME = "rows_list";

const ROW_H = 20; // px per drawn row
const HEADER_H = 24;
const MAX_DRAWN_ROWS = 9;
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
    out.push({
      num: num,
      cat: typeof row.cat === "string" ? row.cat : "",
      on: on,
      pos: typeof row.pos === "string" ? row.pos : "",
      neg: typeof row.neg === "string" ? row.neg : "",
      img: typeof row.img === "string" ? row.img : "",
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
      // per-row node-local rects set during draw
      rects: [],
      widgetY: 0,
      widgetH: 0,
      scroll: 0, // rows scrolled past the top on the node canvas
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
  // hide both python text widgets (rows JSON + presets text)
  hideTextWidget(rowsWidget(node));
  hideTextWidget(presetsWidget(node));
}

function syncFromWidget(node) {
  const st = state(node);
  let changed = false;
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

function commitRows(node, rows) {
  const st = state(node);
  const w = rowsWidget(node);
  st.rows = cleanRows(rows);
  st.raw = dumpRows(st.rows);
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
// dest: "neg" (default) or "pos" - which prompt field receives the text.
function parseOldRows(text, dest) {
  const out = [];
  const lines = String(text == null ? "" : text).split(NL);
  for (const raw of lines) {
    const parsed = parseOldLine(raw);
    if (!parsed) continue;
    const row = { num: parsed.num, cat: "", on: true, pos: "", neg: "", img: "" };
    if (dest === "pos") {
      row.pos = parsed.content;
    } else {
      row.neg = parsed.content;
    }
    out.push(row);
  }
  return out;
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

function listHeight(node) {
  const n = Math.min(rowCount(node), MAX_DRAWN_ROWS);
  const extra = rowCount(node) > MAX_DRAWN_ROWS ? 16 : 0;
  return HEADER_H + n * ROW_H + extra + 6;
}

function openEditor(node, index) {
  // implemented below; indirection keeps definition order simple
  showDialog(node, index);
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
      ctx.fillText("✎ Rows (" + rowCount(n) + ") / Presets (" + pCount + ") — edit", cx, y + HEADER_H / 2 + 1);
      ctx.restore();

      // rows
      st.rects.length = 0;
      const total = rowCount(n);
      const maxScroll = Math.max(0, total - MAX_DRAWN_ROWS);
      if (st.scroll > maxScroll) st.scroll = maxScroll;
      if (st.scroll < 0) st.scroll = 0;
      const shown = Math.min(total - st.scroll, MAX_DRAWN_ROWS);
      let ry = y + HEADER_H;
      ctx.save();
      for (let i = 0; i < shown; i++) {
        const row = st.rows[st.scroll + i];
        ctx.fillStyle = (st.scroll + i) % 2 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.25)";
        ctx.fillRect(12, ry + 1, fullW - 24, ROW_H - 2);
        // checkbox column (manual pick)
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "12px sans-serif";
        if (row.on) {
          ctx.fillStyle = "#6cf";
          ctx.fillText("\u2611", 18, ry + ROW_H / 2);
        } else {
          ctx.strokeStyle = "rgba(255,255,255,0.5)";
          ctx.strokeRect(13, ry + ROW_H / 2 - 5, 11, 11);
        }
        // number
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = "10px monospace";
        ctx.textAlign = "left";
        const numTxt = row.num != null ? String(row.num) : String(st.scroll + i + 1);
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
        // label
        const hasImg = !!row.img;
        const avail = fullW - 24 - (lx - 12) - (hasImg ? 18 : 6);
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
          ctx.fillText("\u25e7", fullW - 18, ry + ROW_H / 2);
        }
        st.rects.push({ top: ry, bottom: ry + ROW_H, index: st.scroll + i });
        ry += ROW_H;
      }
      // scroll hint / bottom marker
      if (total > shown + st.scroll) {
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("\u2193 " + (total - (shown + st.scroll)) + " more - wheel scrolls", cx, ry + 9);
      } else if (total > MAX_DRAWN_ROWS) {
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("(wheel to scroll)", cx, ry + 9);
      }
      ctx.restore();
    },
    mouse(event, pos, node) {
      if (event.type !== "pointerdown" && event.type !== "mousedown") {
        return false;
      }
      if (event.button != null && event.button !== 0) return false;
      const x = pos[0];
      const y = pos[1];
      const st = state(node);
      // header → add/edit
      if (y >= st.widgetY - 1 && y <= st.widgetY + HEADER_H) {
        openEditor(node, null);
        return true;
      }
      for (const r of st.rects) {
        if (y >= r.top - 1 && y <= r.bottom + 1) {
          // checkbox column toggles the manual-pick flag in place
          if (x >= 10 && x <= 28) {
            const row = st.rows[r.index];
            if (row) {
              row.on = !row.on;
              const rw = rowsWidget(node);
              if (rw) {
                const st2 = state(node);
                const raw = dumpRows(st2.rows);
                st2.raw = raw;
                try { rw.value = raw; } catch (e) {}
                if (rw.inputEl && typeof rw.inputEl === "object") {
                  try { rw.inputEl.value = raw; } catch (e) {}
                }
                if (typeof rw.callback === "function") { try { rw.callback(raw); } catch (e) {} }
              }
              app.graph?.setDirtyCanvas?.(true, true);
            }
            return true;
          }
          openEditor(node, r.index);
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
    // wheel over a drawn row area scrolls the node row list (kept out of
    // the dialog; dialog has its own scrollable list)
    function onWheel(e) {
      hideHover();
      const graph = app.graph;
      if (!graph || !graph._nodes) return;
      const canvasEl = app.canvas && app.canvas.canvas;
      if (!canvasEl) return;
      // graph coords under the cursor
      let gx = null, gy = null;
      try {
        if (typeof app.canvas.adjustMouseEvent === "function") app.canvas.adjustMouseEvent(e);
        const rect = canvasEl.getBoundingClientRect();
        const scale = app.canvas.ds ? app.canvas.ds.scale : 1;
        const ox = app.canvas.ds ? app.canvas.ds.offset[0] : 0;
        const oy = app.canvas.ds ? app.canvas.ds.offset[1] : 0;
        gx = (e.clientX - rect.left) / scale + ox;
        gy = (e.clientY - rect.top) / scale + oy;
      } catch (err) { return; }
      // walk nodes topmost-first like hitRowAt
      for (let i = graph._nodes.length - 1; i >= 0; i--) {
        const node = graph._nodes[i];
        if (!node || node.type !== NODE_CLASS || !node.__esnListWidget) continue;
        const st0 = state(node);
        if (!st0.rects.length) continue;
        const x0 = node.pos ? node.pos[0] : 0;
        const y0 = node.pos ? node.pos[1] : 0;
        const size = node.size || [220, 100];
        if (gx < x0 || gx > x0 + size[0] || gy < y0 || gy > y0 + size[1]) continue;
        const ly = gy - y0;
        // only when over the row list area (below header)
        if (ly < st0.widgetY + HEADER_H || ly > st0.widgetY + st0.widgetH) continue;
        const delta = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
        if (!delta) continue;
        e.preventDefault();
        e.stopPropagation();
        const total = st0.rows.length;
        const maxScroll = Math.max(0, total - MAX_DRAWN_ROWS);
        st0.scroll = Math.max(0, Math.min(maxScroll, st0.scroll + delta));
        app.graph?.setDirtyCanvas?.(true, true);
        return;
      }
    }
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", hideHover);
  }
  attach();
}

// ---------------------------------------------------------------------------
// dialog (tabs: Rows / Presets)
// ---------------------------------------------------------------------------

let dialog = null;

function closeDialog() {
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
  topRow.append(onCb, idxLabel, numWrap, catWrap, up, down, spacer, del);

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
function showDialog(node, editIndex) {
  closeDialog();
  syncFromWidget(node);
  const rows = cleanRows(state(node).rows); // working copy

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
  const tabRows = tabBtn("Rows");
  const tabPresets = tabBtn("Presets");
  const setActive = (btn, on) => {
    btn.dataset.active = on ? "1" : "0";
    btn.style.color = on ? "#4af" : "#aaa";
    btn.style.borderBottomColor = on ? "#4af" : "transparent";
  };
  setActive(tabRows, true);
  setActive(tabPresets, false);
  tabBar.appendChild(tabRows);
  tabBar.appendChild(tabPresets);
  panelAppendTab: {
    frame.panel.insertBefore(tabBar, frame.header ? frame.header.nextSibling : frame.panel.firstChild);
  }

  // ---------------- Rows panel ----------------
  const rowsPanel = document.createElement("div");
  Object.assign(rowsPanel.style, { display: "flex", flexDirection: "column", gap: "8px" });

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
  const importBtn = mkBtn("↧ Import old data", { bg: "#5a4a2f", color: "#ffe8b0", title: "Paste numbered rows (N: … ~) or choose a file" });
  // category filter: built from all row cats; '' = all
  const catSel = document.createElement("select");
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All categories";
  catSel.appendChild(allOpt);
  (function fillCats() {
    const seen = [];
    rows.forEach((r) => { const c = (r.cat || "").trim(); if (c && seen.indexOf(c) === -1) seen.push(c); });
    seen.sort();
    seen.forEach((c) => {
      const o = document.createElement("option");
      o.value = c; o.textContent = c; catSel.appendChild(o);
    });
  })();
  Object.assign(catSel.style, { background: "#171717", color: "#eee", border: "1px solid #3d3d3d", borderRadius: "6px", padding: "7px 6px", fontSize: "13px", maxWidth: "170px" });
  catSel.title = "Filter rows by category";

  toolbar.appendChild(searchInp);
  toolbar.appendChild(catSel);
  toolbar.appendChild(addBtn);
  toolbar.appendChild(importBtn);
  rowsPanel.appendChild(toolbar);

  const hintEl = document.createElement("div");
  Object.assign(hintEl.style, { color: "#888", fontSize: "11px" });
  rowsPanel.appendChild(hintEl);

  const list = document.createElement("div");
  Object.assign(list.style, { display: "flex", flexDirection: "column", gap: "6px", marginTop: "2px", overflowY: "auto", maxHeight: "56vh", paddingRight: "4px" });
  rowsPanel.appendChild(list);

  const rowsApi = {
    moveUp(card) {
      const prev = card.previousElementSibling;
      if (!prev) return;
      list.insertBefore(card, prev);
      const i = rows.indexOf(card.__esnRow);
      if (i > 0) {
        const tmp = rows[i - 1];
        rows[i - 1] = rows[i];
        rows[i] = tmp;
      }
      applyFilter();
    },
    moveDown(card) {
      const next = card.nextElementSibling;
      if (!next) return;
      list.insertBefore(next, card);
      const i = rows.indexOf(card.__esnRow);
      if (i !== -1 && i < rows.length - 1) {
        const tmp = rows[i + 1];
        rows[i + 1] = rows[i];
        rows[i] = tmp;
      }
      applyFilter();
    },
    remove(card) {
      const i = rows.indexOf(card.__esnRow);
      if (i !== -1) rows.splice(i, 1);
      applyFilter();
    },
  };

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

  function applyFilter() {
    const q = searchInp.value.trim();
    const cat = catSel.value;
    const visible = [];
    rows.forEach((row) => { if (rowMatches(row, q, cat)) visible.push(row); });
    const cardEls = new Map();
    Array.from(list.children).forEach((c) => cardEls.set(c.__esnRow, c));
    list.innerHTML = "";
    visible.forEach((row) => {
      const i = rows.indexOf(row);
      let card = cardEls.get(row);
      if (!card) card = buildRowCard(row, i, rowsApi);
      const lbl = card.querySelector(".esn-idx");
      if (lbl) lbl.textContent = "Row " + (i + 1);
      list.appendChild(card);
    });
    const showAll = visible.length === rows.length;
    hintEl.textContent = visible.length + " of " + rows.length + " row(s)" +
      (!showAll ? " (filtered)" : "") + (cat ? " - category: " + cat : "") +
      " - tick a row to include it when select_checked is on";
  }

  searchInp.addEventListener("input", applyFilter);
  catSel.addEventListener("change", applyFilter);

  addBtn.addEventListener("click", () => {
    const row = { num: null, cat: "", on: true, pos: "", neg: "", img: "" };
    const card = buildRowCard(row, rows.length - 1, rowsApi);
    list.appendChild(card);
    card.scrollIntoView({ block: "nearest" });
    const ta = card.querySelector("textarea");
    if (ta) ta.focus();
    applyFilter();
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
    hT.textContent = "↧ Import old data";
    hT.style.fontWeight = "bold";
    const hX = mkBtn("✕", { bg: "transparent", border: "none", pad: "2px 8px", font: "16px" });
    hX.addEventListener("click", () => im.remove());
    hd.appendChild(hT);
    hd.appendChild(hX);
    box.appendChild(hd);

    const bd = document.createElement("div");
    Object.assign(bd.style, { overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px" });
    const info = document.createElement("div");
    info.textContent = "Paste the old numbered dataset below (each line: number: text …, optionally ending with ~). Every line becomes a row, its text is stored in the chosen field and the original number is kept (shown as # on each card) — presets / line selection then use those numbers.";
    Object.assign(info.style, { color: "#999", fontSize: "12px", lineHeight: "1.5" });
    bd.appendChild(info);

    const destRow = document.createElement("div");
    Object.assign(destRow.style, { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" });
    destRow.appendChild(document.createTextNode("Import into:"));
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
    ta.placeholder = "1: ;james m hardiman, ;lostgoose ~";
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
        info.textContent = "No numbered lines found — make sure each line starts with a number and a colon.";
        info.style.color = "#e88";
        return;
      }
      if (modeCb.checked) rows.length = 0;
      for (const r of imported) rows.push(r);
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
  const pTool = document.createElement("div");
  Object.assign(pTool.style, { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" });
  const pImp = mkBtn("↧ Import presets…", { bg: "#5a4a2f", color: "#ffe8b0", title: "Paste a preset block (merges)" });
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

  // ---- tab switching ----
  const showRows = () => {
    setActive(tabRows, true);
    setActive(tabPresets, false);
    rowsPanel.style.display = "flex";
    presetsPanel.style.display = "none";
  };
  const showPresets = () => {
    setActive(tabRows, false);
    setActive(tabPresets, true);
    rowsPanel.style.display = "none";
    presetsPanel.style.display = "flex";
  };
  tabRows.addEventListener("click", showRows);
  tabPresets.addEventListener("click", showPresets);

  // panels share the scrolling body
  body.appendChild(rowsPanel);
  body.appendChild(presetsPanel);

  // ---------------- footer (Save / Cancel) ----------------
  const hint = document.createElement("span");
  hint.textContent = "Images are embedded (downscaled) into the workflow JSON.";
  Object.assign(hint.style, { color: "#888", fontSize: "11px", flex: "1" });
  const cancelBtn = mkBtn("Cancel", {});
  cancelBtn.addEventListener("click", closeDialog);
  const saveBtn = mkBtn("Save", { bg: "#3a7bd5", color: "#fff", font: "13px" });
  Object.assign(saveBtn.style, { fontWeight: "bold" });
  saveBtn.addEventListener("click", () => {
    const out = [];
    rows.forEach((row, i) => {
      // find the live card for this row (may be filtered out — read DOM only when present)
      let card = null;
      const cardEls = list.children;
      for (let k = 0; k < cardEls.length; k++) {

        if (cardEls[k].__esnRow === row) { card = cardEls[k]; break; }
      }
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
      });
    });
    commitRows(node, out);
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

  applyFilter();

  // focus requested row (or first field)
  const cards = Array.from(list.children);
  const target = editIndex != null && cards[editIndex] ? cards[editIndex] : cards[0];
  if (target) {
    const ta = target.querySelector("textarea");
    if (ta) ta.focus();
    if (editIndex != null) target.scrollIntoView({ block: "center" });
  }
}

// ---------------------------------------------------------------------------
// setup (idempotent, retries until python widgets exist)
// ---------------------------------------------------------------------------

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
    return;
  }
  node.__esnSetupDone = true;
  hideRowsWidget(node);
  syncFromWidget(node);
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
  resizeNode(node);
}

// ---------------------------------------------------------------------------
// extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "Ghost.EasyStringNegEditor",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== NODE_CLASS) return;

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
