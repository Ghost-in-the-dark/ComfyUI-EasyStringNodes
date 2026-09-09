// EasyStringNegEditor — the Rows / Presets / Data-file dialog.
//
// A DOM modal ("✎ Easy String Neg Editor") with three tabs: Rows (list of
// row cards + bulk import), Presets (legacy string preset list) and Data
// file (dataset *.json management). Rows are rendered windowed so huge
// lists stay responsive. Nothing here touches the canvas; it commits back
// into the node through the core commit* helpers.

import {
  state, cleanRows, syncFromWidget, commitRows, commitPresets,
  commitDataFile, countPresets, normalizePresetText, parseOldRows,
  dsList, dsLoad, dsSave, readImageFile, RENDER_CHUNK,
  bumpDataRev, dataWidget,
} from "./esn_core.js";
import {
  sortRowsByFreq, sortRowsByNum, resizeNode, loadDatasetInto,
} from "./esn_view.js";
import { blurActiveSearch } from "./esn_search.js";

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
  blurActiveSearch();
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
  const sortNumB = mkBtn("↺ # order", { pad: "5px 9px", font: "12px", title: "Restore the original order by the row number (#) - undoes a frequency sort" });
  sortNumB.addEventListener("click", () => {
    const ordered = sortRowsByNum(rows);
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
  toolbar.appendChild(sortNumB);
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
    // if this file is the node's active dataset, bump the hidden data_rev
    // counter so the very next Queue re-executes the node (its widget inputs
    // are unchanged - only the file on disk changed - so ComfyUI's execution
    // cache would otherwise keep serving the stale result).
    try {
      const dw = dataWidget(node);
      if (dw && String(dw.value || "").trim() === name) bumpDataRev(node);
    } catch (e) {}
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
// open a dialog card for one row, or for the whole row set (editIndex null);
// initialTab lets the presets / data sections be opened directly.
function openEditor(node, index, initialTab) {
  // implemented below; indirection keeps definition order simple
  showDialog(node, index, initialTab);
}

export {
  closeDialog, makeModalFrame, mkBtn, mkField, buildRowCard,
  openEditor, showDialog, isDialogOpen,
};

// used by esn_hover.js: while the DOM dialog is open its own scrollers own
// the wheel, so the node-list wheel capture must stand down.
function isDialogOpen() {
  return !!dialog;
}

