// EasyStringNegEditor — on-node search bar.
//
// The search bar draws on the node canvas (esn_widget.js) and its text
// editing does NOT rely on a DOM <input> being focused. Both the legacy and
// the new ComfyUI front-ends keep keyboard focus on the graph canvas, and
// legacy LiteGraph sometimes does not deliver widget.mouse() events for the
// bar's zone, so the bar is driven by global capture listeners instead:
//
//   * activation: a capture-phase pointerdown on window hit-tests the search
//     capsule of every EasyStringNegEditor node and activates the topmost
//     one, swallowing the click so LiteGraph does not also treat it as a row
//     click;
//   * typing: a capture-phase keydown on window edits the active node's
//     st.search directly (printable characters in any layout, Backspace,
//     Escape clears, Enter deactivates). Keys with Ctrl/Cmd/Alt and any
//     keypress while a real DOM field (dialog input, etc.) has focus pass
//     through untouched, so ComfyUI shortcuts and dialog typing keep working;
//   * blur: a pointerdown outside every search capsule deactivates the bar.
//
// The search text is only one of three view filters: it combines (AND) with
// the node's "only ticked" flag and its category filter, so every bulk action
// in the toolbar works on exactly the rows the list shows.
//
// No hidden <input> is created, so the bar behaves identically on both UIs
// and never depends on focus() succeeding for an invisible element.

import { app } from "../../scripts/app.js";
import { state, NODE_CLASS } from "./esn_core.js";

// --- on-node search (canvas bar driven by window capture listeners) ---
let searchNode = null; // node whose on-node search bar is active (or null)
let installed = false;

function activeState() {
  if (!searchNode || !searchNode.__esn) { searchNode = null; return null; }
  const st = searchNode.__esn;
  if (!st.searchFocus) { searchNode = null; return null; }
  return st;
}

function setDirty() {
  try { app.graph?.setDirtyCanvas?.(true, true); } catch (err) {}
}

function deactivate() {
  const st = searchNode && searchNode.__esn ? searchNode.__esn : null;
  if (st) st.searchFocus = false;
  searchNode = null;
  setDirty();
}

function focusSearch(node) {
  if (!node || !node.__esn) return;
  const st = node.__esn;
  if (typeof st.search !== "string") st.search = "";
  searchNode = node;
  st.searchFocus = true;
  setDirty();
}

function clearSearch() {
  const st = activeState();
  if (st) {
    st.search = "";
    st.searchFocus = false;
  }
  searchNode = null;
  setDirty();
}

function blurActiveSearch() {
  deactivate();
}

// --- activation / deactivation by click -------------------------------

function canvasPoint(e) {
  const canvas = app.canvas;
  if (!canvas || !canvas.canvas) return null;
  try { if (typeof canvas.adjustMouseEvent === "function") canvas.adjustMouseEvent(e); } catch (err) {}
  try {
    if (typeof canvas.convertEventToCanvasOffset === "function") {
      const pt = canvas.convertEventToCanvasOffset(e);
      if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) return { gx: pt[0], gy: pt[1] };
    }
  } catch (err) {}
  try {
    const rect = canvas.canvas.getBoundingClientRect();
    const ds = canvas.ds || {};
    const scale = ds.scale || 1;
    const ox = ds.offset ? ds.offset[0] : 0;
    const oy = ds.offset ? ds.offset[1] : 0;
    return { gx: (e.clientX - rect.left) / scale + ox, gy: (e.clientY - rect.top) / scale + oy };
  } catch (err) { return null; }
}

// topmost ESN node whose search capsule contains the click, or null
function searchCapsuleHit(e) {
  const pt = canvasPoint(e);
  if (!pt) return null;
  const graph = app.graph;
  if (!graph || !graph._nodes) return null;
  for (let i = graph._nodes.length - 1; i >= 0; i--) {
    const node = graph._nodes[i];
    if (!node || node.type !== NODE_CLASS || !node.__esn) continue;
    const stn = node.__esn;
    const x0 = node.pos ? node.pos[0] : 0;
    const y0 = node.pos ? node.pos[1] : 0;
    const size = node.size || [220, 100];
    if (pt.gx < x0 || pt.gx > x0 + size[0] || pt.gy < y0 || pt.gy > y0 + size[1]) continue;
    const lx = pt.gx - x0;
    const ly = pt.gy - y0;
    const sz = stn.searchZone;
    if (sz && ly >= sz.top && ly <= sz.bottom) return { node, st: stn, lx };
    return null; // over this node but not its capsule -> not a search click
  }
  return null;
}

function isCanvasEvent(e) {
  const t = e.target;
  if (!t) return false;
  try {
    const cv = app.canvas && app.canvas.canvas;
    if (cv && t === cv) return true;
    if (typeof t.closest === "function" && t.closest("canvas")) return true;
  } catch (err) {}
  return false;
}

function onPointerDownCapture(e) {
  if (e.button != null && e.button !== 0) return;
  const onCanvas = isCanvasEvent(e);
  const hit = onCanvas ? searchCapsuleHit(e) : null;
  if (hit) {
    // click on a search capsule: activate that node's bar (or keep it), and
    // swallow the click so LiteGraph does not also treat it as a row click
    if (hit.st.searchClear && hit.lx >= hit.st.searchClear.x && hit.lx <= hit.st.searchClear.x + hit.st.searchClear.w) {
      // the field's clear mark clears the filter (and deactivates)
      searchNode = hit.node;
      hit.st.search = "";
      hit.st.searchFocus = false;
      searchNode = null;
      setDirty();
    } else {
      const st = activeState();
      if (!st || searchNode !== hit.node) {
        focusSearch(hit.node);
      } else {
        hit.st.searchFocus = true; // keep active
        setDirty();
      }
    }
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    return;
  }
  // a click anywhere outside every search capsule stops the search
  if (activeState()) deactivate();
}

// --- typing ------------------------------------------------------------

function isTypingInDom() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  try { if (el.isContentEditable) return true; } catch (err) {}
  return false;
}

function onKeyDownCapture(e) {
  const st = activeState();
  if (!st) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // ComfyUI shortcuts
  if (isTypingInDom()) return; // real DOM field (dialog) is being typed in
  const k = e.key;
  if (k === "Escape") {
    e.preventDefault(); e.stopPropagation();
    clearSearch();
    return;
  }
  if (k === "Enter") {
    e.preventDefault(); e.stopPropagation();
    deactivate();
    return;
  }
  if (k === "Backspace") {
    e.preventDefault(); e.stopPropagation();
    st.search = st.search.slice(0, -1);
    setDirty();
    return;
  }
  if (k === "Delete") {
    e.preventDefault(); e.stopPropagation();
    st.search = "";
    setDirty();
    return;
  }
  if (k.length === 1) {
    e.preventDefault(); e.stopPropagation();
    st.search += k;
    setDirty();
    return;
  }
  // arrows / Tab / F-keys etc.: leave to the graph
}

function onPasteCapture(e) {
  const st = activeState();
  if (!st) return;
  if (isTypingInDom()) return;
  const txt = e.clipboardData ? e.clipboardData.getData("text") : "";
  if (!txt) return;
  e.preventDefault(); e.stopPropagation();
  st.search += txt.replace(/[\r\n]+/g, " ");
  setDirty();
}

// --- install (once) ----------------------------------------------------
// The capture listeners must exist from module load: activation itself flows
// through onPointerDownCapture, so it cannot be installed lazily from
// focusSearch (that would be a chicken-and-egg deadlock).
function ensureInstalled() {
  if (installed) return;
  installed = true;
  window.addEventListener("pointerdown", onPointerDownCapture, true);
  window.addEventListener("mousedown", onPointerDownCapture, true);
  window.addEventListener("keydown", onKeyDownCapture, true);
  window.addEventListener("paste", onPasteCapture, true);
}
ensureInstalled();

export { focusSearch, clearSearch, blurActiveSearch };
