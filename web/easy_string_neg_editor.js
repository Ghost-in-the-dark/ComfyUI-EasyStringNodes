// EasyStringNegEditor — front-end row editor.
//
// Adds a visual row list + "Add / Edit" modal to the EasyStringNegEditor node.
// Compatible with BOTH the legacy ComfyUI web UI (v0.0.8-era litegraph) and
// the new ComfyUI_frontend based UI.
//
// Data model
// ----------
// The python "rows" STRING(multiline) widget stays the single source of
// truth and is left fully serializable, so workflows / copy-paste / API
// prompts keep working through the stock mechanisms on both front-ends
// (named widget value on the new UI, positional widgets_values on legacy).
// We only hide its textarea from the node body:
//   * legacy: zero-size layout + element display:none
//   * new:    widget.hidden = true (options.hidden)
// Our own canvas widget is APPENDED AFTER every python widget (so positional
// widget indices never shift) and draws the row list + the Add/Edit button.
// It is marked options.serialize = false and widget.serialize = false, so it
// never reaches the API prompt and never enters widgets_values.
//
// Editor dialog
// -------------
// Plain DOM overlay on document.body (works above either UI shell). Each row
// has Positive / Negative textareas and an image field (file picker, drag &
// drop, paste). Images are downscaled to a data URL embedded in the row JSON
// (keeps the workflow self-contained). Hovering a drawn row shows a floating
// preview with that row's image.

import { app } from "../../scripts/app.js";

const NODE_CLASS = "EasyStringNegEditor";
const ROWS_NAME = "rows";
const UI_NAME = "rows_list";

const ROW_H = 20; // px per drawn row
const HEADER_H = 24;
const MAX_DRAWN_ROWS = 9;
const IMG_MAX_EDGE = 384;
const IMG_QUALITY = 0.82;

// CanvasRenderingContext2D.roundRect is Chrome 99+; older engines used by
// embedded webviews may lack it, so fall back to plain rects.
if (typeof CanvasRenderingContext2D !== 'undefined' &&
    !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (typeof r === 'number') r = [r, r, r, r];
    if (!Array.isArray(r)) r = [0, 0, 0, 0];
    this.rect(x, y, w, h);
    return this;
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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
    out.push({
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
  t = String(t || "");
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function state(node) {
  if (!node.__esn) {
    node.__esn = {
      rows: [],
      raw: null,
      // per-row node-local rects set during draw
      rects: [],
      widgetY: 0,
      widgetH: 0,
    };
  }
  return node.__esn;
}

function rowsWidget(node) {
  if (!node.widgets) return null;
  return node.widgets.find((w) => w && w.name === ROWS_NAME) || null;
}

function syncFromWidget(node) {
  const st = state(node);
  const w = rowsWidget(node);
  if (!w) return false;
  let raw;
  try {
    raw = String(w.value ?? "");
  } catch (e) {
    raw = "";
  }
  if (raw !== st.raw) {
    st.raw = raw;
    st.rows = cleanRows(parseRows(raw));
    return true;
  }
  return false;
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
    // classic ComfyWidgets.STRING multiline: element is the textarea
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
// hide python rows widget
// ---------------------------------------------------------------------------

function hideRowsWidget(node) {
  const w = rowsWidget(node);
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
  // Legacy layout contract: this DOM widget contributes ~0 px.
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
      ctx.fillText("✎ Add / Edit rows (" + rowCount(n) + ")", cx, y + HEADER_H / 2 + 1);
      ctx.restore();

      // rows
      st.rects.length = 0;
      const shown = Math.min(rowCount(n), MAX_DRAWN_ROWS);
      let ry = y + HEADER_H;
      ctx.save();
      for (let i = 0; i < shown; i++) {
        const row = st.rows[i];
        ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.25)";
        ctx.fillRect(12, ry + 1, fullW - 24, ROW_H - 2);
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = "10px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), 18, ry + ROW_H / 2);
        const hasImg = !!row.img;
        const label = clampText(row.pos || row.neg || "(empty)", hasImg ? 30 : 38);
        ctx.fillStyle = row.pos
          ? "#beb"
          : row.neg
            ? "rgba(255,255,255,0.65)"
            : "rgba(255,255,255,0.3)";
        ctx.font = "10px sans-serif";
        ctx.fillText(label, 32, ry + ROW_H / 2);
        if (hasImg) {
          ctx.textAlign = "right";
          ctx.fillText("◧", fullW - 18, ry + ROW_H / 2);
        }
        st.rects.push({ top: ry, bottom: ry + ROW_H, index: i });
        ry += ROW_H;
      }
      if (rowCount(n) > shown) {
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("+ " + (rowCount(n) - shown) + " more — open editor", cx, ry + 9);
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
// dialog
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

function showDialog(node, editIndex) {
  closeDialog();
  syncFromWidget(node);
  const rows = cleanRows(state(node).rows); // working copy

  // ---- build UI ----
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
    width: "min(780px, 94vw)",
    maxHeight: "88vh",
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
  });
  const title = document.createElement("div");
  title.textContent = "✎ Easy String Neg Editor — rows";
  title.style.fontWeight = "bold";
  title.style.fontSize = "14px";
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

  const list = document.createElement("div");
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "8px";
  list.style.marginTop = "8px";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "+ Add row";
  Object.assign(addBtn.style, {
    cursor: "pointer", background: "#2f6f4f", color: "#fff", border: "none",
    borderRadius: "6px", padding: "7px 12px", fontSize: "13px", alignSelf: "flex-start",
  });

  // ---- one row card ----
  function buildCard(row, index) {
    const card = document.createElement("div");
    card.__esnRow = row; // image source bound to this card regardless of moves
    Object.assign(card.style, { border: "1px solid #3a3a3a", borderRadius: "8px", padding: "8px", background: "#202020" });

    const topRow = document.createElement("div");
    Object.assign(topRow.style, { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" });
    const idxLabel = document.createElement("span");
    idxLabel.textContent = "Row " + (index + 1);
    Object.assign(idxLabel.style, { fontWeight: "bold", minWidth: "52px" });

    const mkBtn = (text, titleText, color) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.title = titleText;
      Object.assign(b.style, {
        cursor: "pointer", background: "#2c2c2c", color: color || "#ddd",
        border: "1px solid #444", borderRadius: "4px", padding: "2px 8px", fontSize: "12px",
      });
      return b;
    };
    const up = mkBtn("↑", "Move up");
    const down = mkBtn("↓", "Move down");
    const del = mkBtn("🗑", "Delete row", "#f88");
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    topRow.append(idxLabel, up, down, spacer, del);

    const fields = document.createElement("div");
    Object.assign(fields.style, { display: "flex", gap: "8px", alignItems: "flex-start" });

    const mkText = (labelText, value, placeholder) => {
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
    };
    const pos = mkText("Positive", row.pos, "positive prompt");
    const neg = mkText("Negative", row.neg, "negative prompt");
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
    fileInput.addEventListener("change", () => onFiles(fileInput.files).then(() => (fileInput.value = "")));
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

    // renumber all cards after any structural change
    const renumber = () => {
      Array.from(list.children).forEach((c, i) => {
        const lbl = c.querySelector("span.esn-idx");
        if (lbl) lbl.textContent = "Row " + (i + 1);
      });
    };
    idxLabel.classList.add("esn-idx");

    up.addEventListener("click", () => {
      const prev = card.previousElementSibling;
      if (!prev) return;
      list.insertBefore(card, prev);
      const i = rows.indexOf(card.__esnRow);
      if (i > 0) {
        const tmp = rows[i - 1];
        rows[i - 1] = rows[i];
        rows[i] = tmp;
      }
      renumber();
    });
    down.addEventListener("click", () => {
      const next = card.nextElementSibling;
      if (!next) return;
      list.insertBefore(next, card);
      const i = rows.indexOf(card.__esnRow);
      if (i !== -1 && i < rows.length - 1) {
        const tmp = rows[i + 1];
        rows[i + 1] = rows[i];
        rows[i] = tmp;
      }
      renumber();
    });
    del.addEventListener("click", () => {
      card.remove();
      const i = rows.indexOf(card.__esnRow);
      if (i !== -1) rows.splice(i, 1);
      renumber();
    });

    card.appendChild(topRow);
    card.appendChild(fields);
    return card;
  }

  function rebuild() {
    list.innerHTML = "";
    rows.forEach((row, i) => list.appendChild(buildCard(row, i)));
  }
  rebuild();

  addBtn.addEventListener("click", () => {
    const row = { pos: "", neg: "", img: "" };
    rows.push(row);
    const card = buildCard(row, rows.length - 1);
    list.appendChild(card);
    card.scrollIntoView({ block: "nearest" });
    card.querySelector("textarea")?.focus();
  });

  const footer = document.createElement("div");
  Object.assign(footer.style, {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px",
    padding: "10px 14px", borderTop: "1px solid #333", flex: "0 0 auto",
  });
  const hint = document.createElement("span");
  hint.textContent = "Images are embedded (downscaled) into the workflow JSON.";
  Object.assign(hint.style, { color: "#888", fontSize: "11px", flex: "1" });
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  Object.assign(cancelBtn.style, { cursor: "pointer", background: "#2c2c2c", color: "#ddd", border: "1px solid #444", borderRadius: "6px", padding: "7px 14px", fontSize: "13px" });
  cancelBtn.addEventListener("click", closeDialog);
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  Object.assign(saveBtn.style, { cursor: "pointer", background: "#3a7bd5", color: "#fff", border: "none", borderRadius: "6px", padding: "7px 18px", fontSize: "13px", fontWeight: "bold" });
  saveBtn.addEventListener("click", () => {
    const out = [];
    Array.from(list.children).forEach((card) => {
      const tas = card.querySelectorAll("textarea");
      const bound = card.__esnRow || {};
      out.push({
        pos: tas[0] ? tas[0].value : "",
        neg: tas[1] ? tas[1].value : "",
        img: typeof bound.img === "string" ? bound.img : "",
      });
    });
    commitRows(node, out);
    resizeNode(node);
    closeDialog();
  });

  footer.appendChild(hint);
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  addBtn.style.marginTop = "4px";
  body.appendChild(addBtn);
  body.appendChild(list);
  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const dlg = { _overlay: overlay, _onKey: null };
  const onKey = (e) => {
    if (e.key === "Escape") closeDialog();
  };
  document.addEventListener("keydown", onKey);
  dlg._onKey = onKey;
  dialog = dlg;

  // focus requested row (or first field)
  const cards = Array.from(list.children);
  const target = editIndex != null && cards[editIndex] ? cards[editIndex] : cards[0];
  if (target) {
    (target.querySelector("textarea") || target).focus();
    if (editIndex != null) target.scrollIntoView({ block: "center" });
  }
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
    canvas.addEventListener("pointerdown", hideHover);
    canvas.addEventListener("wheel", hideHover);
  }
  attach();
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
});