// EasyStringNegEditor — node view model.
//
// Pure view logic over the rows state: visible-row filtering for the on-node
// search / "only ticked" / category filters, usage-frequency sorting (xN / use),
// bulk ticking, transient status messages, list sizing and dataset loading.
// The canvas widget in esn_widget.js calls into here.

import { app } from "../../scripts/app.js";
import {
  state, cleanRows, commitRows, presetEntries, dsLoad, dumpRows,
  ROWS_NAME, PRESETS_NAME, DATA_NAME, REV_NAME,
  MAX_DRAWN_ROWS, ROW_H, HEADER_H, SEARCH_H, TOOL_H, STATUS_H, SCROLL_H,
  MAX_DRAWN_PRESETS, PRESET_H, PRESET_HDR_H, PRESET_GAP,
  PRESET_SCROLL_H, PRESET_CTRL_H, PRESET_EMPTY_H,
  settingsCollapsed, ADV_WIDGETS,
} from "./esn_core.js";


function rowCount(node) {
  return state(node).rows.length;
}

function rowSearchText(row) {
  // what the on-node search matches against: number, category, pos, neg
  return String(row.num != null ? row.num : "") + " " +
    (row.cat || "") + " " + (row.pos || "") + " " + (row.neg || "");
}

// Number of rows currently ticked (on=true) - the count the node reports in
// its status bar and the number select_checked will hand to Python.
function tickedCount(rows) {
  let n = 0;
  for (const row of rows || []) if (row && row.on) n++;
  return n;
}

// Visible rows honoring the search filter AND the "show only ticked" view
// filter AND the category filter: [{row, oi}] where oi is the index in
// st.rows. Kept in st.view by draw(); standalone for sizing/hits.
//
// The three filters are independent and combine with AND:
//   st.search      free text over number / category / pos / neg
//   st.onlyChecked only rows ticked with the checkbox
//   st.catFilter   only rows whose category matches exactly
// Every bulk action (✓ all / ✗ none) and the header count operate on the
// INTERSECTION, which is exactly what is drawn.
//
// Order: st.rows holds the authoritative order (workflow widget or dataset
// file). The on-node "use" sort is a VIEW-ONLY reordering - it never
// rewrites st.rows (see toggleFreqSort), so toggling it off restores the
// stored order and a page reload cannot leave the list stuck in frequency
// order. rebuildView therefore applies the frequency sort to the FILTERED
// matches only, using oi as the stable tie-breaker.
function rebuildView(st, rows) {
  const q = (st.search || "").toLowerCase().trim();
  const only = !!st.onlyChecked;
  const cat = (st.catFilter || "").trim();
  const out = [];
  rows = rows || st.rows || [];
  for (let oi = 0; oi < rows.length; oi++) {
    const row = rows[oi];
    if (only && !row.on) continue; // "show only ticked" view filter
    if (cat && String(row.cat || "").trim() !== cat) continue; // category filter
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

// ---------------------------------------------------------------------------
// transient status message on the node (status bar line)
// ---------------------------------------------------------------------------
// A short-lived note shown inside the node's status bar, optionally with one
// clickable action ("none"). Used where an action would otherwise look like
// it did nothing - e.g. the "only" filter on a fresh dataset where every row
// is already ticked, so the filter legitimately shows all rows. The ticker
// keeps the canvas redrawing while the message (and its hit zone) is live.
function toast(node, text, actionLabel, action) {
  const st = state(node);
  st.toast = {
    text: String(text == null ? "" : text),
    label: actionLabel || "",
    action: typeof action === "function" ? action : null,
    until: Date.now() + 6000,
  };
  if (!node.__esnToastTimer) {
    node.__esnToastTimer = setInterval(() => {
      const s2 = node && node.__esn;
      if (!s2 || !s2.toast) {
        clearInterval(node.__esnToastTimer);
        node.__esnToastTimer = null;
        return;
      }
      if (Date.now() > s2.toast.until) {
        s2.toast = null;
        clearInterval(node.__esnToastTimer);
        node.__esnToastTimer = null;
      }
      try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    }, 500);
  }
  try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

function clearToast(node) {
  const st = state(node);
  if (!st.toast) return false;
  st.toast = null;
  try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
  return true;
}

// View-only frequency sort toggle. The STORED row order (st.rows / the
// dataset file / the workflow widget) is never changed here - only the
// display order of the next draw is. That is exactly what the dialog's
// "By usage" button does too: it sorts its WORKING COPY for the next save and
// leaves the file alone until Save is pressed. So "on" means the same thing
// everywhere: the list is currently ordered by usage, nothing is written.
function toggleFreqSort(node) {
  const st = state(node);
  const rows = st.rows;
  if (!rows || rows.length < 2) {
    toast(node, "Need at least 2 rows to sort by usage");
    return false;
  }
  st.sortedByFreq = !st.sortedByFreq;
  if (st.search || st.onlyChecked || st.catFilter) { st.scroll = 0; }
  app.graph?.setDirtyCanvas?.(true, true);
  resizeNode(node);
  return true;
}

// Stable descending-by-frequency sort of a row COPY (used by the dialog's
// "By usage" button, which intentionally reorders the working rows so the
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
// (the old sort used to rewrite the stored rows) for datasets whose rows carry
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
// on-node list. With an active search, the "only" filter or a category, the buttons
// act only on the visible (matching) rows; without a filter, on the whole set.
// Returns the number of rows that actually changed.
function tickVisibleRows(node, on) {
  const st = state(node);
  const rows = st.rows;
  if (!rows || !rows.length) return 0;
  if (!on && !tickedCount(rows)) return 0; // already nothing ticked
  st.view = rebuildView(st, rows); // never act on a stale view
  const filtered = !!((st.search || "").trim() || st.onlyChecked || (st.catFilter || "").trim());
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
  st.view = rebuildView(st, rows);
  if (filtered) { st.scroll = 0; }
  app.graph?.setDirtyCanvas?.(true, true);
  resizeNode(node);
  return n;
}

// View filter: show only the rows ticked with the checkbox (on=true).
// Combines with the on-node search and the category filter (AND); toggle off
// to show all rows again.
function toggleOnlyChecked(node) {
  const st = state(node);
  st.onlyChecked = !st.onlyChecked;
  if (!st.onlyChecked || st.search || st.catFilter) { st.scroll = 0; }
  if (st.onlyChecked) {
    // A dataset whose rows are all ticked makes this filter a no-op that
    // looks like a broken button. Say so once and offer the fix inline.
    const total = st.rows.length;
    const ticked = tickedCount(st.rows);
    if (total > 0 && ticked === total) {
      toast(node, "All " + total + " rows are ticked", "none", () => {
        tickVisibleRows(node, false);
      });
    }
  }
  app.graph?.setDirtyCanvas?.(true, true);
  resizeNode(node);
}

// Category filter (view-only, never written to the row data). An empty name
// clears it. Called by the chip on a row, by the category button list and by
// the dialog's category picker - so the same filter exists in every view.
function setCategoryFilter(node, cat) {
  const st = state(node);
  const next = String(cat == null ? "" : cat).trim();
  st.catFilter = next;
  st.catPickOpen = false;
  st.scroll = 0;
  app.graph?.setDirtyCanvas?.(true, true);
  resizeNode(node);
  return next;
}

function toggleCategoryPicker(node) {
  const st = state(node);
  st.catPickOpen = !st.catPickOpen;
  if (st.catPickOpen && st.catFilter) {
    // open the list scrolled to the active category
    const rows = st.rows;
    let idx = -1;
    const seen = [];
    for (const r of rows) {
      const c = (r.cat || "").trim();
      if (c && seen.indexOf(c) === -1) seen.push(c);
    }
    seen.sort();
    idx = seen.indexOf(st.catFilter);
    st.catPopScroll = idx >= 0 ? Math.max(0, idx - 1) : 0;
  }
  app.graph?.setDirtyCanvas?.(true, true);
  return st.catPickOpen;
}
function closeCategoryPicker(node) {
  const st = state(node);
  if (!st.catPickOpen) return false;
  st.catPickOpen = false;
  app.graph?.setDirtyCanvas?.(true, true);
  return true;
}

function listHeight(node) {
  const st = state(node);
  // the node shows only the rows passing the current view filters (search /
  // "only" / category), so the height follows the visible count, not the
  // raw total
  const visible = st.rows.length ? rebuildView(st, st.rows).length : 0;
  const n = Math.min(visible, MAX_DRAWN_ROWS);
  let h = HEADER_H + SEARCH_H + TOOL_H + STATUS_H + n * ROW_H;
  if (visible > MAX_DRAWN_ROWS) h += SCROLL_H; // arrow buttons + wheel hint band
  else if (n === 0) h += SCROLL_H; // "(no rows…)" line, same band height
  const entries = presetEntries(st.presets);
  const nP = Math.min(entries.length, MAX_DRAWN_PRESETS);
  h += PRESET_GAP + PRESET_HDR_H + nP * PRESET_H;
  if (entries.length > MAX_DRAWN_PRESETS) h += PRESET_SCROLL_H; // arrow buttons row
  h += entries.length ? PRESET_CTRL_H : PRESET_EMPTY_H; // control row / hint
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
    // Rough vertical space taken by the python widgets above the list.
    // Keep the same heuristic as before for the expanded state (every python
    // widget row except the always-hidden rows/presets/data/data_rev and the
    // forceInput preset_trigger contributes ~26px), so a workflow that never
    // uses the collapse feature keeps its exact previous node height. When
    // the settings block is collapsed, its widgets (line_numbers …
    // select_checked) contribute nothing and only the hidden data widgets
    // remain above the list.
    const collapsed = settingsCollapsed(node);
    let py = 0;
    if (node.widgets) {
      for (const wdg of node.widgets) {
        if (!wdg || wdg.name === UI_NAME) continue;
        const nm = wdg.name;
        if (nm === ROWS_NAME || nm === PRESETS_NAME ||
            nm === DATA_NAME || nm === REV_NAME || nm === "preset_trigger") continue;
        if (collapsed && ADV_WIDGETS.indexOf(nm) !== -1) continue;
        py += 26;
      }
    }
    const target = py + listHeight(node);
    // always write the exact height so collapsing/expanding can shrink too
    node.size = [w, Math.max(80, target)];
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
    // no "only ticked" filter, no category filter, no frequency sort (all
    // view-only state)
    st.search = "";
    st.onlyChecked = false;
    st.catFilter = "";
    st.catPickOpen = false;
    st.sortedByFreq = false;
    st.scroll = 0;
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    resizeNode(node);
  });
}

export {
  rowCount, rowSearchText, rebuildView, tickedCount,
  sortRowsByFreq, sortRowsByNum, toggleFreqSort, toggleOnlyChecked,
  setCategoryFilter, toggleCategoryPicker, closeCategoryPicker,
  tickVisibleRows, listHeight, toast, clearToast,
  resizeNode, loadDatasetInto,
};
