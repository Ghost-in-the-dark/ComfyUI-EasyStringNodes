// EasyStringNegEditor — node view model.
//
// Pure view logic over the rows state: visible-row filtering for the on-node
// search, usage-frequency sorting (×N / ⇅), list sizing and dataset loading.
// The canvas widget in esn_widget.js calls into here.

import { app } from "../../scripts/app.js";
import {
  state, cleanRows, commitRows, presetEntries, dsLoad, dumpRows,
  MAX_DRAWN_ROWS, ROW_H, HEADER_H, SEARCH_H, TOOL_H,
  MAX_DRAWN_PRESETS, PRESET_H, PRESET_HDR_H, PRESET_GAP,
} from "./esn_core.js";


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

// Tick (on=true) or untick (on=false) every row currently visible in the
// on-node list. With an active search filter only the rows matching it are
// touched (like the dialog's ✓ all / ✗ none, but search-aware on the node);
// without a filter the whole set is changed.
function tickVisibleRows(node, on) {
  const st = state(node);
  const rows = st.rows;
  if (!rows || !rows.length) return 0;
  // With an active search filter the buttons act on the rows matching it
  // (even when that set is empty - a no-op); without a filter, on the whole
  // set. st.view holds the matches, so it must not be silently replaced by
  // the full list when a search yields nothing.
  const q = (st.search || "").trim();
  const targets = q ? (st.view || []) : rows.map((row, oi) => ({ row, oi }));
  let n = 0;
  for (const t of targets) {
    const row = rows[t.oi];
    if (row && row.on !== !!on) {
      row.on = !!on;
      n++;
    }
  }
  if (!n) return 0;
  commitRows(node, rows); // dataset-aware (file vs widget) + bumps data_rev on user edits
  if (st.search) { st.scroll = 0; }
  app.graph?.setDirtyCanvas?.(true, true);
  resizeNode(node);
  return n;
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
  let h = HEADER_H + SEARCH_H + TOOL_H + n * ROW_H;
  if (total > MAX_DRAWN_ROWS || n === 0) h += 18; // scroll hint / "no rows"
  const entries = presetEntries(st.presets);
  const nP = Math.min(entries.length, MAX_DRAWN_PRESETS);
  h += PRESET_GAP + PRESET_HDR_H + nP * PRESET_H;
  if (entries.length > MAX_DRAWN_PRESETS) h += 16; // ▲/▼ row
  h += entries.length ? 20 : 18; // control row or "no presets" hint
  return h + 4;
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

export {
  rowCount, rowSearchText, rebuildView,
  sortRowsByFreq, toggleFreqSort, tickVisibleRows, listHeight,
  resizeNode, loadDatasetInto,
};
