// EasyStringNegEditor — hover preview + wheel scrolling.
//
// Shows a floating DOM preview (image / text) for the row under the mouse and
// makes the mouse wheel scroll the node's row / preset lists. The wheel
// listener is on document in the CAPTURE phase so it runs before LiteGraph's
// zoom handler; when the wheel targets one of our lists it stops propagation
// instead of zooming the workflow.

import { app } from "../../scripts/app.js";
import {
  state, presetEntries, NODE_CLASS,
  MAX_DRAWN_ROWS, WHEEL_STEP, PRESET_WHEEL_STEP,
  HEADER_H, SEARCH_H, TOOL_H, STATUS_H, SCROLL_H, MAX_DRAWN_PRESETS,
} from "./esn_core.js";
import { isDialogOpen } from "./esn_dialog.js";

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

// Row index under a graph point, for the hover highlight, or null.
function hoverRowIndexAt(gx, gy) {
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
      if (ly >= r.top && ly <= r.bottom) return { node, index: r.index };
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
  // hover feedback for the row highlight / category popover rows: the canvas
  // only redraws when something actually changed
  const hov = hoverRowIndexAt(x, y);
  if (hov && hov.node.__esn) {
    const stn = hov.node.__esn;
    if (stn.hoverKey !== hov.index) {
      stn.hoverKey = hov.index;
      app.graph?.setDirtyCanvas?.(true, true);
    }
  }
  for (const node of (app.graph && app.graph._nodes) || []) {
    if (!node || node.type !== NODE_CLASS || !node.__esn) continue;
    const stn = node.__esn;
    if (stn === (hov && hov.node.__esn)) continue;
    if (stn.hoverKey !== -1) {
      stn.hoverKey = -1;
      app.graph?.setDirtyCanvas?.(true, true);
    }
  }
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
          // rows begin below the search bar, the button toolbar and the status
          // bar; the band stops at the scroll hint row so the ▲/▼ arrows keep
          // working
          let rowsTop = st0.widgetY + HEADER_H + SEARCH_H + TOOL_H + STATUS_H;
          if (st0.toolbarBtns) rowsTop = st0.toolbarBtns.y + st0.toolbarBtns.h + STATUS_H;
          const rowsBottom = st0.rowsAreaBottom - SCROLL_H;
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
        if (st0.catPickOpen && st0.catPop && st0.catPop.maxScroll > 0) {
          if (lx >= st0.catPop.x && lx <= st0.catPop.x + st0.catPop.w &&
              ly >= st0.catPop.y && ly <= st0.catPop.y + st0.catPop.h) {
            if (delta !== 0) {
              st0.catPopScroll = Math.max(0, Math.min(st0.catPop.maxScroll, (st0.catPopScroll || 0) + delta));
              app.graph?.setDirtyCanvas?.(true, true);
            }
            return true;
          }
        }
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
      if (isDialogOpen()) return; // the dialog has its own scrollers
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
export { installHover };
