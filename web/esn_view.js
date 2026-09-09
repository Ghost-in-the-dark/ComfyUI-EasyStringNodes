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

// Visible rows honoring the search filter AND the "show only ticked" view
// filter: [{row, oi}] where oi is the index in st.rows. Kept in st.view by
// draw(); standalone for sizing/hits.
//
// Order: st.rows holds the authoritative order (workflow widget or dataset
// file). The on-node ⇅ by use sort is a VIEW-ONLY reordering — it never
// rewrites st.rows (see toggleFreqSort), so toggling it off restores the
// stored order and a page reload cannot leave the list stuck in frequency
// order. rebuildView therefore applies the frequency sort to the FILTERED
// matches only, using oi as the stable tie-breaker.
function rebuildView(st, rows) {
  const q = (st.search || "").toLowerCase().trim();
  const only = !!st.onlyChecked;
  const out = [];
  rows = rows || st.rows || [];
  for (let oi = 0; oi < rows.length; oi++) {
    const row = rows[oi];
    if (only && !row.on) continue; // "show only ticked" view filter
    if (!q || rowSearchText(row).toLowerCase().indexOf(q) !== -1) out.push({ row: row, oi: oi });
  }
  if (st.sortedByFreq && out.length > 1) {
    out.sort((a, b) => {
      const fa = a.row.freq || 0, fb = b.row.freq || 0;
      if (fb !== fa) return fb - fa;
      return a.oi - b.oi; // stable: keep the stored order for equal counters
    });
  }
  return out;
}

// View-only frequency sort toggle. The STORED row order (st.rows / the
// dataset file / the workflow widget) is never changed here - only the
// display order of the next draw is. That is why toggling off always
// restores the original order and a workflow reload cannot leave the node
// permanently sorted by usage (which used to happen when the old ⇅ button
// rewrote st.rows and persisted the reordering).
function toggleFreqSort(node) {
  const st = state(node);
  const rows = st.rows;
  if (!rows || rows.length < 2) return;
  st.sortedByFreq = !st.sortedByFreq;
  if (st.search || st.onlyChecked) { st.scroll = 0; }
  app.graph?.setDirtyCanvas?.(true, true);
  resizeNode(node);
}

// Stable descending-by-frequency sort of a row COPY (used by the dialog's
// "⇅ by use" button, which intentionally reorders the working rows so the
// order can be saved). Rows without a counter stay at the end.
function sortRowsByFreq(rows) {
  const withIdx = rows.map((row, i) => ({ row: row, i: i }));
  withIdx.sort((a, b) => {
    const fa = a.row.freq || 0, fb = b.row.freq || 0;
    if (fb !== fa) return fb - fa;
    return a.i - b.i;
  });
  return withIdx.map((x) => x.row);
}

// Restore the "original" order by the explicit row number (#) of a row COPY:
// rows with num sort ascending by it, rows without num keep their relative
// order at the end. This undoes a previously persisted frequency reordering
// (the old ⇅ used to rewrite the stored rows) for datasets whose rows carry
// their original import numbers.
function sortRowsByNum(rows) {
  const withIdx = rows.map((row, i) => ({ row: row, i: i }));
  withIdx.sort((a, b) => {
    const na = a.row.num, nb = b.row.num;
    const ha = na != null, hb = nb != null;
    if (ha && hb) return (na - nb) || (a.i - b.i);
    if (ha) return -1;
    if (hb) return 1;
    return a.i - b.i;
  });
  return withIdx.map((x) => x.row);
}

// Tick (on=true) or untick (on=false) every row currently visible in the
// on-node list. With an active search or "☑ only" view filter the buttons act
// only on the visible (matching) rows; without a filter, on the whole set.
function tickVisibleRows(node, on) {
  const st = state(node);
  const rows = st.rows;
  if (!rows || !rows.length) return 0;
  const q = (st.search || "").trim();
  const filtered = q || st.onlyChecked;
  const targets = filtered ? (st.view || []) : rows.map((row, oi) => ({ row, oi }));
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
  if (filtered) { st.scroll = 0; }
  app.graph?.setDirtyCanvas?.(true, true);
  resizeNode(node);
  return n;
}

// View filter: show only the rows ticked with the checkbox (on=true).
// Combines with the on-node search (AND); toggle off to show all rows again.
function toggleOnlyChecked(node) {
  const st = state(node);
  st.onlyChecked = !st.onlyChecked;
  if (!st.onlyChecked || st.search) { st.scroll = 0; }
  app.graph?.setDirtyCanvas?.(true, true);
  resizeNode(node);
}

function listHeight(node) {
  const st = state(node);
  // the node shows only the rows passing the current view filters (search /
  // "☑ only"), so the height follows the visible count, not the raw total
  const visible = st.rows.length ? rebuildView(st, st.rows).length : 0;
  const n = Math.min(visible, MAX_DRAWN_ROWS);
  let h = HEADER_H + SEARCH_H + TOOL_H + n * ROW_H;
  if (visible > MAX_DRAWN_ROWS || n === 0) h += 18; // scroll hint / "no rows"
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
    // a freshly loaded dataset starts with a clean view: no search filter,
    // no "only ticked" filter, no frequency sort (all view-only state)
    st.search = "";
    st.onlyChecked = false;
    st.sortedByFreq = false;
    st.scroll = 0;
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    resizeNode(node);
  });
}

export {
  rowCount, rowSearchText, rebuildView,
  sortRowsByFreq, sortRowsByNum, toggleFreqSort, toggleOnlyChecked,
  tickVisibleRows, listHeight,
  resizeNode, loadDatasetInto,
};
