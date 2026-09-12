// EasyStringNegEditor — the custom canvas widget.
//
// Renders the on-node row list (with the search bar, usage counters ×N and
// the drag scrollbar) plus the presets panel, and handles clicks / wheel on
// them. The on-node search itself lives in esn_search.js; the scrollbar drag
// helpers here drive a window-level pointer grab.

import { app } from "../../scripts/app.js";
import {
  state, clampText, clampTextToWidth, findWidget, hideRowsWidget, syncFromWidget,
  commitRows, countPresets, presetEntries, presetChoice, categoryCounts,
  stepPresetChoice, UI_NAME,
  settingsCollapsed, applySettingsCollapsed, toggleSettingsCollapsed,
  MAX_DRAWN_ROWS, WHEEL_STEP, ROW_H, HEADER_H, SEARCH_H, TOOL_H, STATUS_H, SCROLL_H,
  FREQ_W, SB_W, SB_HIT_W, MAX_DRAWN_PRESETS, PRESET_H, PRESET_HDR_H, PRESET_GAP,
  PRESET_SCROLL_H, PRESET_CTRL_H, PRESET_EMPTY_H, COL,
} from "./esn_core.js";
import {
  rowCount, rebuildView, toggleFreqSort, toggleOnlyChecked, tickVisibleRows,
  setCategoryFilter, toggleCategoryPicker, closeCategoryPicker, tickedCount,
  listHeight, resizeNode,
} from "./esn_view.js";
import { focusSearch, clearSearch } from "./esn_search.js";
import { openEditor } from "./esn_dialog.js";

// --- small vector icons drawn on the canvas ------------------------------
// Paths, not emoji: an emoji glyph is rendered by the OS font stack, so the
// same node looks different (and sometimes renders as a blank box) on Windows,
// macOS and Linux. Every icon here is drawn with the current stroke/fill
// colour, so it inherits the control's state.
function drawToolIcon(ctx, kind, cx, cy, on) {
  const s = on ? 1.15 : 1;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 1.4;
  if (kind === "check") {
    ctx.beginPath();
    ctx.moveTo(cx - 4.5 * s, cy + 0.2 * s);
    ctx.lineTo(cx - 1.4 * s, cy + 3.4 * s);
    ctx.lineTo(cx + 4.6 * s, cy - 3.4 * s);
    ctx.stroke();
  } else if (kind === "cross") {
    ctx.beginPath();
    ctx.moveTo(cx - 3.6 * s, cy - 3.6 * s);
    ctx.lineTo(cx + 3.6 * s, cy + 3.6 * s);
    ctx.moveTo(cx + 3.6 * s, cy - 3.6 * s);
    ctx.lineTo(cx - 3.6 * s, cy + 3.6 * s);
    ctx.stroke();
  } else if (kind === "ticked") {
    ctx.beginPath();
    ctx.roundRect(cx - 5, cy - 5, 10, 10, [2]);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy + 0.2);
    ctx.lineTo(cx - 0.8, cy + 2.6);
    ctx.lineTo(cx + 3.2, cy - 2.6);
    ctx.stroke();
  } else if (kind === "tag") {
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy - 4.5);
    ctx.lineTo(cx + 1.5, cy - 4.5);
    ctx.lineTo(cx + 5, cy - 0.5);
    ctx.lineTo(cx - 0.5, cy + 4.5);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx - 2.2, cy - 1.8, 1, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === "sort") {
    // up/down arrows with different lengths = "ordered by count"
    ctx.beginPath();
    ctx.moveTo(cx - 3.2, cy + 4); ctx.lineTo(cx - 3.2, cy - 4);
    ctx.moveTo(cx - 5.4, cy - 1.6); ctx.lineTo(cx - 3.2, cy - 4); ctx.lineTo(cx - 1, cy - 1.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 3.2, cy - 4); ctx.lineTo(cx + 3.2, cy + 4);
    ctx.moveTo(cx + 1, cy + 1.6); ctx.lineTo(cx + 3.2, cy + 4); ctx.lineTo(cx + 5.4, cy + 1.6);
    ctx.stroke();
  } else if (kind === "gear") {
    ctx.beginPath();
    ctx.arc(cx, cy, 3.1, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 3.6, cy + Math.sin(a) * 3.6);
      ctx.lineTo(cx + Math.cos(a) * 5.6, cy + Math.sin(a) * 5.6);
      ctx.stroke();
    }
  } else if (kind === "caret") {
    ctx.beginPath();
    ctx.moveTo(cx - 4.2, cy + 1.8);
    ctx.lineTo(cx, cy - 2.6);
    ctx.lineTo(cx + 4.2, cy + 1.8);
    ctx.stroke();
  }
  ctx.restore();
}

// Chevron button used by the rows and presets scroll bands: a 28x22 housing
// with a triangle, so the band reads as two real buttons.
function drawArrowButton(ctx, x, y, w, h, dir, enabled) {
  ctx.save();
  ctx.globalAlpha = enabled ? 1 : 0.4;
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.strokeStyle = enabled ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.14)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, [4]);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = enabled ? COL.text : COL.textMuted;
  const mx = x + w / 2;
  const my = y + h / 2;
  ctx.beginPath();
  if (dir === "up") {
    ctx.moveTo(mx, my - 3.4);
    ctx.lineTo(mx + 4.4, my + 2.4);
    ctx.lineTo(mx - 4.4, my + 2.4);
  } else {
    ctx.moveTo(mx, my + 3.4);
    ctx.lineTo(mx + 4.4, my - 2.4);
    ctx.lineTo(mx - 4.4, my - 2.4);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// --- rows scrollbar drag ---
let sbDragNode = null;

function startSbDrag(node, st, event, y) {
  const zone = st.sbZone;
  if (!zone) return;
  // safety net: if a previous drag never received its pointerup (ComfyUI /
  // LiteGraph can swallow it with stopPropagation, or the button was released
  // outside the browser window), finish it before starting a new one so the
  // scrollbar can never stay bound to the cursor.
  if (sbDragNode && sbDragNode !== node) endSbDrag();
  sbDragNode = node;
  st.draggingSb = true;
  st.sbStartClientY = (event && typeof event.clientY === "number") ? event.clientY : y;
  st.sbStartNodeY = y;
  const thumbY = zone.thumbY;
  const grabOffset = y - thumbY;
  // grabbing the track itself (not the thumb) grabs the thumb's middle
  st.sbGrabOffset = (grabOffset >= 0 && grabOffset <= zone.thumbH) ? grabOffset : zone.thumbH / 2;  st.sbScale = (app.canvas && app.canvas.ds && app.canvas.ds.scale) ? app.canvas.ds.scale : 1;
  try { event.preventDefault(); } catch (e) {}
  try { event.stopPropagation(); } catch (e) {}
  app.graph?.setDirtyCanvas?.(true, true);
  // Take over the pointer on the canvas: the browser then keeps delivering
  // pointermove/pointerup to us even when the cursor leaves the canvas or the
  // button is released outside the window (which would otherwise produce no
  // pointerup at all and leave the drag stuck).
  try {
    const cv = app.canvas && app.canvas.canvas;
    if (cv && typeof cv.setPointerCapture === "function" && event && event.pointerId != null) {
      cv.setPointerCapture(event.pointerId);
    }
  } catch (err) {}
  // Listen in the CAPTURE phase on window: capture runs before any canvas
  // handler, so ComfyUI / LiteGraph stopPropagation on pointerup (or on any
  // pointermove over their own overlays) can no longer keep the up/move from
  // reaching us. Blur ends the drag too (alt-tab etc.).
  window.addEventListener("pointermove", onSbMove, { capture: true, passive: false });
  window.addEventListener("pointerup", onSbUp, { capture: true });
  window.addEventListener("pointercancel", onSbUp, { capture: true });
  window.addEventListener("blur", endSbDrag);
}

function endSbDrag() {
  const node = sbDragNode;
  sbDragNode = null;
  if (node) {
    const st = state(node);
    st.draggingSb = false;
    app.graph?.setDirtyCanvas?.(true, true);
  }
  window.removeEventListener("pointermove", onSbMove, { capture: true });
  window.removeEventListener("pointerup", onSbUp, { capture: true });
  window.removeEventListener("pointercancel", onSbUp, { capture: true });
  window.removeEventListener("blur", endSbDrag);
}

function onSbMove(e) {
  const node = sbDragNode;
  if (!node) return;
  // final safety net: if the pointerup was lost (e.g. released over a browser
  // UI element that stopped the event), any move with no pressed button ends
  // the drag immediately instead of letting the thumb chase the cursor.
  if (typeof e.buttons === "number" && (e.buttons & 1) === 0) {
    endSbDrag();
    return;
  }
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
  endSbDrag();
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
      // keep the collapse state in sync on every draw (a reloaded workflow
      // carries the property; the widgets may have just been (re)created)
      applySettingsCollapsed(n, settingsCollapsed(n));
      st.widgetY = y;
      st.widgetH = this.computeSize()[1];
      const fullW = width || 220;
      const cx = fullW / 2;

      // the visible set drives the header count, the toolbar badges and the
      // status bar, so it is computed ONCE here - before anything is drawn.
      // (Reading st.view before rebuilding it showed the previous draw's
      // count: the very first paint of a fresh node said "Rows (0/18)".)
      st.view = rebuildView(st, st.rows);

      // header pill / button
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#4a6";
      ctx.fillStyle = "rgba(20,20,20,0.9)";
      ctx.beginPath();
      ctx.roundRect(12, y + 3, fullW - 24, HEADER_H - 6, [4]);
      ctx.fill();
      ctx.stroke();
      const pCount = countPresets(st.presets);
      const loading = st.file && st.loadedFile !== st.file && !st.loadFailed;
      const failed = st.file && st.loadedFile !== st.file && st.loadFailed;
      const totalRows = rowCount(n);
      const totalShown = st.view.length;
      // the header reports what is DRAWABLE: with any view filter active the
      // count is "shown / total", so the number always matches the list below
      const titleTxt = failed
        ? "dataset " + st.file + " not found \u00b7 edit"
        : (loading
            ? "dataset " + st.file + " \u00b7 loading..."
            : "Rows (" + totalShown + (totalShown !== totalRows ? "/" + totalRows : "") +
              ") / Presets (" + pCount + ") \u00b7 edit");
      ctx.fillStyle = COL.textStrong;
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // centre the title in the space left of the settings switch so a long
      // caption never runs underneath it (the switch now sits INSIDE the
      // header pill, near its right edge - not flush to the node border)
      const titleAreaX = 12;
      const titleAreaW = fullW - 24 - 34; // leave room for the in-pill switch
      ctx.fillText(
        clampTextToWidth(ctx, titleTxt, titleAreaW - 12),
        titleAreaX + titleAreaW / 2 + 6,
        y + HEADER_H / 2 + 1);

      // settings switch inside the header pill: a drawn gear (settings block
      // expanded) / caret (collapsed) in a 28x20 target. Stored in
      // node.properties so it survives save / reload.
      const swW = 28;
      const swH = HEADER_H - 8;
      const swX = fullW - 12 - swW - 2;
      const swY = y + 4;
      const swOn = !settingsCollapsed(n);
      st.settingsBtn = { x: swX, y: y + 2, w: swW, h: HEADER_H - 2 };
      ctx.save();
      ctx.fillStyle = swOn ? "rgba(120,120,255,0.25)" : "rgba(120,120,120,0.2)";
      ctx.strokeStyle = swOn ? "#79c" : "rgba(255,255,255,0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(swX + 0.5, swY + 0.5, swW - 1, swH - 1, [4]);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = swOn ? "#cfe" : COL.textMuted;
      drawToolIcon(ctx, swOn ? "gear" : "caret", swX + swW / 2, swY + swH / 2, false);
      ctx.restore();
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
      st.statusAction = null;
      st.catBtn = null;
      st.catPop = null;
      st.catPopRows = null;
      const total = st.view.length;
      const maxScroll = Math.max(0, total - MAX_DRAWN_ROWS);
      if (st.scroll > maxScroll) st.scroll = maxScroll;
      if (st.scroll < 0) st.scroll = 0;
      const shown = Math.min(total - st.scroll, MAX_DRAWN_ROWS);
      let ry = y + HEADER_H;

      // search bar (always visible): magnifier icon + text + clear button
      const searchTop = ry;
      const searchBot = searchTop + SEARCH_H;
      st.searchZone = { top: searchTop, bottom: searchBot };
      const clearW = 24; // >= 24 px target (SC 2.5.8)
      const sbBoxW = fullW - 24 - SB_HIT_W - 6;
      const sbMid = searchTop + SEARCH_H / 2;
      ctx.save();
      ctx.fillStyle = "rgba(8,8,8,0.55)";
      ctx.strokeStyle = st.searchFocus ? "#5af" : "rgba(255,255,255,0.28)";
      ctx.lineWidth = st.searchFocus ? 1.5 : 1;
      ctx.beginPath();
      ctx.roundRect(12, searchTop + 1, sbBoxW, SEARCH_H - 2, [9]);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const hasQ = !!(st.search || "").trim();
      // magnifier drawn as a path: no emoji, renders identically everywhere
      ctx.strokeStyle = hasQ ? COL.text : COL.placeholder;
      ctx.beginPath();
      ctx.arc(22, sbMid - 1, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(25, sbMid + 2);
      ctx.lineTo(28, sbMid + 5);
      ctx.stroke();
      ctx.font = "11px sans-serif";
      const ph = hasQ ? st.search : "search rows...";
      const textX = 12 + 20;
      const textMax = sbBoxW - 20 - (hasQ ? clearW + 4 : 10);
      ctx.fillStyle = hasQ ? COL.text : COL.placeholder;
      ctx.fillText(clampTextToWidth(ctx, ph, Math.max(24, textMax)), textX, sbMid);
      if (hasQ) {
        // the clear button drawn as two strokes, centred in its 24xSEARCH_H target
        const cxc = 12 + sbBoxW - clearW / 2;
        ctx.strokeStyle = COL.textMuted;
        ctx.beginPath();
        ctx.moveTo(cxc - 4, sbMid - 4);
        ctx.lineTo(cxc + 4, sbMid + 4);
        ctx.moveTo(cxc + 4, sbMid - 4);
        ctx.lineTo(cxc - 4, sbMid + 4);
        ctx.stroke();
        st.searchClear = { x: 12 + sbBoxW - clearW, y: searchTop, w: clearW, h: SEARCH_H };
      } else {
        st.searchClear = null;
      }
      ctx.restore();
      ry += SEARCH_H;

      // --- toolbar: all / none / only / cat / use -------------------------
      // Bulk-tick buttons act on ALL rows, or - when any view filter (search,
      // "only", category) is active - only on the rows matching it. The
      // number of rows a button would touch is drawn as a BADGE in its top
      // right corner instead of inside the label: a count appended to the
      // caption is the first thing a 46 px button truncates, which is exactly
      // the information the button exists to convey.
      ctx.save();
      const tbY = ry + 2;
      const tbH = TOOL_H - 4; // 24 px targets
      const tGap = 4;
      const nBtn = 5;
      const tbW = (fullW - 24 - tGap * (nBtn - 1)) / nBtn;
      const visCount = st.view ? st.view.length : 0;
      const catActive = !!(st.catFilter || "").trim();
      const filterActive = !!(st.search || "").trim() || !!st.onlyChecked || catActive;
      const canSort = (rowCount(n) || st.rows.length) > 1;
      const tbs = [
        { key: "tick", label: "all", icon: "check", on: false, badge: filterActive ? visCount : 0 },
        { key: "none", label: "none", icon: "cross", on: false, badge: filterActive ? visCount : 0 },
        { key: "only", label: "only", icon: "ticked", on: !!st.onlyChecked },
        { key: "cat", label: "cat", icon: "tag", on: catActive, enabled: (st.rows || []).length > 0 },
        { key: "sort", label: "use", icon: "sort", on: !!st.sortedByFreq, enabled: canSort },
      ];
      const tz = {};
      for (let bi = 0; bi < tbs.length; bi++) {
        const b = tbs[bi];
        const bx = 12 + bi * (tbW + tGap);
        tz[b.key] = { x: bx, y: tbY, w: tbW, h: tbH };
        const on = !!b.on;
        const enabled = b.enabled !== false;
        ctx.fillStyle = on ? "rgba(120,90,20,0.5)" : "rgba(255,255,255,0.07)";
        ctx.strokeStyle = on ? "rgba(255,200,80,0.75)" : (enabled ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.12)");
        ctx.lineWidth = 1;
        ctx.globalAlpha = enabled ? 1 : 0.45;
        ctx.beginPath();
        ctx.roundRect(bx, tbY, tbW, tbH, [4]);
        ctx.fill();
        ctx.stroke();
        // icon (drawn, never emoji) + label, centred as a group
        ctx.font = "10px sans-serif";
        const labelW = ctx.measureText(b.label).width;
        const iconW = 11;
        const inner = labelW + 3 + iconW;
        let ix = bx + Math.max(5, (tbW - inner) / 2);
        const iy = tbY + tbH / 2;
        ctx.strokeStyle = on ? COL.accentSort : COL.text;
        ctx.lineWidth = 1.3;
        drawToolIcon(ctx, b.icon, ix + iconW / 2, iy, on);
        ctx.fillStyle = on ? COL.accentSort : COL.text;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(b.label, ix + iconW + 3, iy + 0.5);
        // count badge: how many rows this button would act on
        if (b.badge > 0) {
          const bt = String(b.badge);
          ctx.font = "bold 8px sans-serif";
          const bw = Math.max(12, ctx.measureText(bt).width + 6);
          const bxx = bx + tbW - bw - 1;
          ctx.fillStyle = on ? COL.accentSort : "#6a6a6a";
          ctx.beginPath();
          ctx.roundRect(bxx, tbY - 5, bw, 11, [5]);
          ctx.fill();
          // ink contrasts with BOTH badge backgrounds (white on the idle grey
          // 5.4:1, near-black on the active amber 13.9:1)
          ctx.fillStyle = on ? "#101010" : "#ffffff";
          ctx.textAlign = "center";
          ctx.fillText(bt, bxx + bw / 2, tbY + 0.5);
          ctx.textAlign = "left";
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      st.toolbarBtns = { y: ry, h: TOOL_H, tick: tz.tick, none: tz.none, only: tz.only, cat: tz.cat, sort: tz.sort };
      ry += TOOL_H;

      // --- status bar: what the filters currently show / how many are ticked
      ctx.save();
      const stMid = ry + STATUS_H / 2;
      const totalAll = st.rows.length;
      let statusTxt;
      if (!totalAll) statusTxt = "no rows yet - click the header to add some";
      else if (st.toast) statusTxt = st.toast.text;
      else if (filterActive) {
        const parts = [];
        if (catActive) parts.push("cat " + clampTextToWidth(ctx, st.catFilter, 90));
        if (st.onlyChecked) parts.push("ticked only");
        if ((st.search || "").trim()) parts.push("\u201c" + clampTextToWidth(ctx, st.search.trim(), 70) + "\u201d");
        statusTxt = "showing " + visCount + " / " + totalAll + "  \u00b7  " + parts.join(" + ");
      } else {
        statusTxt = "ticked " + tickedCount(st.rows) + " / " + totalAll;
      }
      ctx.font = "10px sans-serif";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      // toast + action chip on the right
      let statusRight = fullW - 14;
      st.statusAction = null;
      if (st.toast && st.toast.action && st.toast.label) {
        const lw = ctx.measureText(st.toast.label).width + 12;
        const ax = fullW - 12 - lw;
        ctx.fillStyle = "rgba(255,200,80,0.9)";
        ctx.beginPath();
        ctx.roundRect(ax, ry + 2, lw, STATUS_H - 4, [4]);
        ctx.fill();
        ctx.fillStyle = "#101010";
        ctx.textAlign = "center";
        ctx.fillText(st.toast.label, ax + lw / 2, stMid);
        ctx.textAlign = "left";
        statusRight = ax - 6;
      }
      // active category chip: its own clickable target with a clear mark
      st.catChip = null;
      if (catActive) {
        const name = clampTextToWidth(ctx, st.catFilter, 110);
        const cwid = Math.min(150, ctx.measureText(name).width + 22);
        let cx0 = 12;
        // the chip sits at the LEFT of the status text when nothing else is
        // shown, otherwise at the right, so the numbers stay readable
        if (!st.toast) {
          cx0 = statusRight - cwid;
          statusRight = cx0 - 6;
          ctx.fillStyle = "rgba(255,216,115,0.16)";
          ctx.strokeStyle = "rgba(255,216,115,0.6)";
          ctx.beginPath();
          ctx.roundRect(cx0, ry + 1, cwid, STATUS_H - 2, [4]);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = COL.accentCatOn;
          ctx.fillText(name, cx0 + 6, stMid);
          ctx.fillStyle = COL.textMuted;
          ctx.textAlign = "right";
          ctx.fillText("\u00d7", cx0 + cwid - 7, stMid);
          ctx.textAlign = "left";
          st.catChip = { x: cx0, y: ry, w: cwid, h: STATUS_H };
        }
      }
      const stTxt = clampTextToWidth(ctx, statusTxt, Math.max(40, statusRight - 14));
      ctx.fillStyle = st.toast ? "#ffe8b0" : COL.textMuted;
      ctx.fillText(stTxt, 14, stMid);
      st.statusBar = { y: ry, h: STATUS_H };
      ctx.restore();
      ry += STATUS_H;

      ctx.save();
      for (let i = 0; i < shown; i++) {
        const row = st.view[st.scroll + i].row;
        const oi = st.view[st.scroll + i].oi;
        const freq = row.freq || 0;
        const rowY = ry + 1;
        const rowH = ROW_H - 2;
        // usage is never encoded by colour alone: a row with a counter gets a
        // reserved column carrying an explicit "xN" chip; the warm background
        // is only a secondary cue. Rows without a counter keep the plain
        // alternating background.
        const hovered = st.hoverKey === oi;
        if (freq > 0) {
          const a = Math.min(0.22, 0.07 + Math.log2(1 + freq) * 0.035);
          ctx.fillStyle = "rgba(255,170,60," + a.toFixed(3) + ")";
          ctx.fillRect(12, rowY, fullW - 24, rowH);
        } else {
          ctx.fillStyle = (st.scroll + i) % 2 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.25)";
          ctx.fillRect(12, rowY, fullW - 24, rowH);
        }
        if (hovered) {
          ctx.fillStyle = "rgba(255,255,255,0.06)";
          ctx.fillRect(12, rowY, fullW - 24, rowH);
        }
        const midY = rowY + rowH / 2;
        // checkbox column: 24 px wide, full row height = a 24x22 target
        // (with the row's 1 px hit tolerance: 24x24). A real square, so the
        // tick state is not colour-only.
        const cbX = 13;
        const cbY = midY - 6;
        if (row.on) {
          ctx.fillStyle = COL.accentTick;
          ctx.beginPath();
          ctx.roundRect(cbX, cbY, 12, 12, [2]);
          ctx.fill();
          ctx.strokeStyle = "#08243a";
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(cbX + 2.6, cbY + 6.2);
          ctx.lineTo(cbX + 5, cbY + 9);
          ctx.lineTo(cbX + 9.6, cbY + 3.2);
          ctx.stroke();
          ctx.lineWidth = 1;
        } else {
          ctx.strokeStyle = hovered ? "#dcdcdc" : "#b4b4b4";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.roundRect(cbX + 0.5, cbY + 0.5, 11, 11, [2]);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        // number
        ctx.fillStyle = COL.textDim;
        ctx.font = "10px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const numTxt = row.num != null ? String(row.num) : String(oi + 1);
        ctx.fillText(clampTextToWidth(ctx, numTxt, 20), 30, midY);
        let lx = 52;
        // category chip: CLICKABLE - clicking it filters the node list by that
        // category (the same filter the dialog's category picker sets). The
        // chip of the ACTIVE filter is highlighted; clicking it again clears.
        st.rects.push({ top: ry, bottom: ry + ROW_H, index: oi, catX: 52 });
        if (row.cat) {
          const catOn = catActive && String(row.cat).trim() === (st.catFilter || "").trim();
          ctx.font = "9px sans-serif";
          const cw = ctx.measureText(row.cat).width + 10;
          ctx.fillStyle = catOn ? COL.accentCatOn : COL.accentCat;
          ctx.beginPath();
          ctx.roundRect(52, rowY + 2, cw, rowH - 4, [3]);
          ctx.fill();
          ctx.fillStyle = COL.chipInk;
          ctx.fillText(clampTextToWidth(ctx, row.cat, cw - 8), 57, midY);
          const last = st.rects[st.rects.length - 1];
          last.catX = 52;
          last.catW = cw;
          lx = 52 + cw + 5;
          ctx.font = "10px sans-serif";
        }
        // label (shrink by the reserved freq column / img marker)
        const hasImg = !!row.img;
        const reserved = (freq > 0 ? FREQ_W - 2 : 6) + (hasImg ? 14 : 0);
        const avail = fullW - 24 - (lx - 12) - reserved - 12; // -12: right padding
        const label = clampTextToWidth(ctx, row.pos || row.neg || "(empty)", Math.max(16, avail));
        ctx.fillStyle = row.pos
          ? "#beb"
          : row.neg
            ? COL.text
            : COL.textEmpty;
        ctx.font = "10px sans-serif";
        ctx.fillText(label, lx, midY);
        if (hasImg) {
          // image marker drawn as a small framed square, not an emoji
          ctx.strokeStyle = COL.textMuted;
          ctx.strokeRect(fullW - 24 - (freq > 0 ? FREQ_W - 2 : 2) - 8, midY - 4, 8, 8);
        }
        // usage counter: explicit "xN" chip on the right edge of the row
        if (freq > 0) {
          const ft = "\u00d7" + freq;
          ctx.font = "bold 9px sans-serif";
          const fw = Math.max(16, ctx.measureText(ft).width + 8);
          const fx = fullW - 14 - fw;
          ctx.fillStyle = freq >= 5 ? "rgba(255,204,102,0.22)" : "rgba(140,190,255,0.18)";
          ctx.beginPath();
          ctx.roundRect(fx, rowY + 3, fw, rowH - 6, [3]);
          ctx.fill();
          ctx.fillStyle = freq >= 5 ? COL.warn : "#bcd8ff";
          ctx.textAlign = "center";
          ctx.fillText(ft, fx + fw / 2, midY);
          ctx.textAlign = "left";
        }
        ry += ROW_H;
      }
      // scroll area: arrows + wheel + drag scrollbar, drawn when rows hidden
      st.scrollUp = null;
      st.scrollDown = null;
      const canScroll = total > MAX_DRAWN_ROWS;
      let rowsBottom = ry; // rows area ends here (below the scroll hint)
      if (canScroll) {
        const bandY = ry;
        const mid = bandY + SCROLL_H / 2;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const upOn = st.scroll > 0;
        const dnOn = st.scroll < maxScroll;
        // 28x24 arrow buttons on both sides of the hint text
        drawArrowButton(ctx, cx - 46, bandY + 1, 28, SCROLL_H - 2, "up", upOn);
        drawArrowButton(ctx, cx + 18, bandY + 1, 28, SCROLL_H - 2, "down", dnOn);
        st.scrollUp = { x: cx - 46, y: bandY + 1, w: 28, h: SCROLL_H - 2 };
        st.scrollDown = { x: cx + 18, y: bandY + 1, w: 28, h: SCROLL_H - 2 };
        const leftCount = total - (st.scroll + shown);
        ctx.fillStyle = COL.textMuted;
        ctx.font = "10px sans-serif";
        ctx.fillText(leftCount > 0 ? (leftCount + " more below") : "wheel to scroll", cx, mid);
        rowsBottom = ry + SCROLL_H;

        // drag scrollbar on the right edge of the drawn rows (visual track is
        // SB_W wide; the pointer band is SB_HIT_W so it can be grabbed)
        const sbX = fullW - SB_W - 4;
        const sbY = (st.toolbarBtns ? st.toolbarBtns.y + st.toolbarBtns.h : searchBot) + 1;
        const sbH = rowsBottom - sbY - 1;
        if (sbH > 24 && shown > 0) {
          const trackH = sbH;
          const thumbH = Math.max(16, trackH * (shown / total));
          const frac = maxScroll > 0 ? st.scroll / maxScroll : 0;
          const thumbY = sbY + frac * (trackH - thumbH);
          st.sbZone = {
            x: sbX + SB_W / 2 - SB_HIT_W / 2, y: sbY, w: SB_HIT_W, h: trackH,
            trackX: sbX, trackW: SB_W,
            thumbY: thumbY, thumbH: thumbH, maxScroll: maxScroll,
          };
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          ctx.fillRect(sbX, sbY, SB_W, trackH);
          ctx.fillStyle = st.draggingSb ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.45)";
          ctx.fillRect(sbX + 2, thumbY + 2, SB_W - 4, Math.max(8, thumbH - 4));
        }
      } else {
        if (shown === 0) {
          ctx.fillStyle = COL.textEmpty;
          ctx.font = "11px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(
            st.search
              ? "(no rows match \u201c" + clampTextToWidth(ctx, st.search, 90) + "\u201d)"
              : (catActive
                  ? "(no rows in category \u201c" + clampTextToWidth(ctx, st.catFilter, 70) + "\u201d)"
                  : (st.onlyChecked
                      ? "(no ticked rows - tick some or turn off only)"
                      : "(no rows yet - click the header to add)")),
            cx, ry + SCROLL_H / 2);
          rowsBottom = ry + SCROLL_H;
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
      ctx.fillStyle = COL.accentPreset;
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(
        clampTextToWidth(ctx,
          "Presets (" + entries.length + ") " +
            (entries.length ? "\u00b7 click a line to open, use/arrows to pick" : "\u00b7 click to add"),
          secW - 10),
        secLeft + 6, secTop + PRESET_HDR_H / 2);
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
          ctx.fillStyle = isActive ? "#8f8" : COL.text;
          ctx.textAlign = "left";
          // active-preset marker drawn as a triangle, not a text glyph
          if (isActive) {
            const my = rowTop + PRESET_H / 2;
            ctx.beginPath();
            ctx.moveTo(secLeft + 5, my - 4);
            ctx.lineTo(secLeft + 10, my);
            ctx.lineTo(secLeft + 5, my + 4);
            ctx.closePath();
            ctx.fill();
          }
          const lineTxt = clampTextToWidth(ctx, en.text, secW - 20);
          ctx.fillText(lineTxt, secLeft + 14, rowTop + PRESET_H / 2);
          st.presetRects.push({ top: rowTop, bottom: rowBottom, num: en.num });
          pBottom = rowBottom;
        }
        if (entries.length > MAX_DRAWN_PRESETS) {
          const bandY = pBottom + 1;
          const bh = PRESET_SCROLL_H - 2;
          drawArrowButton(ctx, cx - 46, bandY, 28, bh, "up", st.presetScroll > 0);
          drawArrowButton(ctx, cx + 18, bandY, 28, bh, "down", st.presetScroll < maxPScroll);
          st.presetUp = { x: cx - 46, y: bandY, w: 28, h: bh };
          st.presetDown = { x: cx + 18, y: bandY, w: 28, h: bh };
          ctx.fillStyle = COL.textMuted;
          ctx.font = "10px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText((st.presetScroll + 1) + "-" + (st.presetScroll + shownP) + " / " + entries.length, cx, bandY + bh / 2);
          pBottom += PRESET_SCROLL_H;
          st.presetListArea = { top: secTop + PRESET_HDR_H, bottom: pBottom };
        }
        // control row: use_preset toggle + active preset stepper
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(secLeft, pBottom, secW, PRESET_CTRL_H);
        const ctlY = pBottom + PRESET_CTRL_H / 2;
        // left label (measured truncation, never runs under the buttons)
        const active = choice.on ? entries.find((e) => e.num === choice.line) : null;
        const btnAreaW = 42 + 28 + 28 + 6;
        ctx.font = "9px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = active ? "#8f8" : COL.textDim;
        const ctlTxt = active
          ? ("active " + choice.line + ": " + active.text)
          : (choice.on ? ("preset " + choice.line + " not found") : "preset off \u00b7 all rows / line_numbers");
        ctx.fillText(clampTextToWidth(ctx, ctlTxt, secW - btnAreaW - 10), secLeft + 5, ctlY);
        // right: [use] [◀] [▶] buttons, all at least 28x24
        const btnH = PRESET_CTRL_H - 4;
        const btnY = pBottom + 2;
        const btns = [
          { key: "use", label: choice.on ? "use:on" : "use:off", w: 42, color: choice.on ? "#8f8" : COL.textDim },
          { key: "prev", label: "prev", icon: "left", w: 28, color: COL.accentSort, enabled: entries.length > 1 },
          { key: "next", label: "next", icon: "right", w: 28, color: COL.accentSort, enabled: entries.length > 1 },
        ];
        let bx = secLeft + secW - 4;
        st.presetUse = null; st.presetPrev = null; st.presetNext = null;
        for (let bi = btns.length - 1; bi >= 0; bi--) {
          const b = btns[bi];
          bx -= b.w;
          const zone = { x: bx, y: btnY, w: b.w, h: btnH, key: b.key };
          ctx.globalAlpha = b.enabled === false ? 0.35 : 1;
          ctx.fillStyle = "rgba(255,255,255,0.06)";
          ctx.strokeStyle = "rgba(255,255,255,0.3)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(bx + 0.5, btnY + 0.5, b.w - 1, btnH - 1, [3]);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = b.color;
          if (b.icon) {
            // 7x7 triangle, centred in a 28x24 target
            const mx = bx + b.w / 2;
            const my = btnY + btnH / 2;
            ctx.beginPath();
            if (b.icon === "left") {
              ctx.moveTo(mx + 3, my - 4); ctx.lineTo(mx - 3, my); ctx.lineTo(mx + 3, my + 4);
            } else {
              ctx.moveTo(mx - 3, my - 4); ctx.lineTo(mx + 3, my); ctx.lineTo(mx - 3, my + 4);
            }
            ctx.closePath();
            ctx.fill();
          } else {
            ctx.font = "9px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(b.label, bx + b.w / 2, btnY + btnH / 2);
          }
          ctx.globalAlpha = 1;
          if (b.key === "use") st.presetUse = zone;
          else if (b.key === "prev") st.presetPrev = zone;
          else st.presetNext = zone;
        }
        bx -= 6;
        pBottom += PRESET_CTRL_H;
      } else {
        ctx.fillStyle = COL.textEmpty;
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("no presets yet \u00b7 click to add", cx, pBottom + PRESET_EMPTY_H / 2);
        pBottom += PRESET_EMPTY_H;
        // whole empty area opens the dialog on the Presets tab
        st.presetsHeader = { top: secTop, bottom: pBottom };
      }
      ctx.restore();
      st.presetsBottom = pBottom;
      st.widgetH = Math.max(st.widgetH, pBottom - y + 2);

      // ---- category picker popover (drawn last, on top of everything) ----
      // A canvas-drawn list would be unreadable and unclickable at small node
      // widths, so the picker mirrors the toolbar button geometry, sits under
      // the status bar and is hit-tested in mouse() with 24 px rows.
      if (st.catPickOpen) {
        const cats = categoryCounts(st.rows);
        const items = [{ name: "", count: st.rows.length, label: "All categories" }].concat(
          cats.map((c) => ({ name: c.name, count: c.count, label: c.name })));
        const popW = Math.min(fullW - 24, 190);
        const rowH2 = 22;
        const maxVisible = 6;
        const vis = Math.min(items.length, maxVisible);
        const popH = vis * rowH2 + 2;
        const popX = 12;
        const popY = st.statusBar ? st.statusBar.y + STATUS_H : ry;
        const maxScroll2 = Math.max(0, items.length - maxVisible);
        // catPopScroll may be unset (undefined) on a fresh state object, which
        // would index items[NaN] and read undefined.name
        st.catPopScroll = Math.max(0, Math.min(maxScroll2, Number(st.catPopScroll) || 0));
        ctx.save();
        // fully opaque: a popover drawn over the row list must not let the row
        // text bleed through, and a shadow separates it from the rows
        ctx.globalAlpha = 1;
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = "#161616";
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(popX + 0.5, popY + 0.5, popW - 1, popH - 1, [5]);
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.stroke();
        ctx.globalAlpha = 1;
        const rows2 = [];
        for (let i = 0; i < vis; i++) {
          const it = items[st.catPopScroll + i];
          const iy = popY + 1 + i * rowH2;
          const isActive = (it.name || "") === (st.catFilter || "");
          const hovered2 = st.popHover === st.catPopScroll + i;
          if (isActive) {
            ctx.fillStyle = "rgba(255,216,115,0.18)";
            ctx.fillRect(popX + 1, iy, popW - 2, rowH2);
          } else if (hovered2) {
            ctx.fillStyle = "rgba(255,255,255,0.06)";
            ctx.fillRect(popX + 1, iy, popW - 2, rowH2);
          }
          ctx.font = "11px sans-serif";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillStyle = isActive ? COL.accentCatOn : COL.text;
          ctx.fillText(clampTextToWidth(ctx, it.label, popW - 54), popX + 8, iy + rowH2 / 2);
          ctx.textAlign = "right";
          ctx.fillStyle = COL.textMuted;
          ctx.font = "10px sans-serif";
          ctx.fillText(String(it.count), popX + popW - 8, iy + rowH2 / 2);
          ctx.textAlign = "left";
          if (i) { // separators between rows
            ctx.strokeStyle = "rgba(255,255,255,0.07)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(popX + 1, iy);
            ctx.lineTo(popX + popW - 1, iy);
            ctx.stroke();
          }
          rows2.push({ index: st.catPopScroll + i, top: iy, bottom: iy + rowH2, name: it.name });
        }        // scroll indicator when the category list is longer than the popover
        if (maxScroll2 > 0) {
          ctx.fillStyle = COL.textMuted;
          ctx.font = "9px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("scroll", popX + popW - 28, popY + popH - 6);
          ctx.textAlign = "left";
        }
        st.catPop = { x: popX, y: popY, w: popW, h: popH, rows: vis, maxScroll: maxScroll2, total: items.length };
        st.catPopRows = rows2;
        ctx.restore();
      }
    },
    mouse(event, pos, node) {
      const st = state(node);
      const x0 = pos[0];
      const y0 = pos[1];
      if (event.type !== "pointerdown" && event.type !== "mousedown") {
        // Hover feedback (row highlight + category-popover highlight). The
        // front-end only delivers these when it routes move events to custom
        // widgets; when it does not, the canvas simply draws without hover.
        let nextRow = -1;
        for (const r of st.rects) {
          if (y0 >= r.top && y0 <= r.bottom) { nextRow = r.index; break; }
        }
        let nextPop = -1;
        if (st.catPickOpen && st.catPop && x0 >= st.catPop.x && x0 <= st.catPop.x + st.catPop.w) {
          for (const r2 of st.catPopRows || []) {
            if (y0 >= r2.top && y0 <= r2.bottom) { nextPop = r2.index; break; }
          }
        }
        if (nextRow !== st.hoverKey || nextPop !== st.popHover) {
          st.hoverKey = nextRow;
          st.popHover = nextPop;
          app.graph?.setDirtyCanvas?.(true, true);
        }
        return false;
      }
      if (event.button != null && event.button !== 0) return false;
      const x = x0;
      const y = y0;
      // The category popover is drawn on top of everything, so it also gets
      // the click first: a click inside picks a category (or closes on
      // "All categories"), a click outside dismisses it.
      if (st.catPickOpen && st.catPop) {
        const pop = st.catPop;
        if (x >= pop.x && x <= pop.x + pop.w && y >= pop.y && y <= pop.y + pop.h) {
          for (const r2 of st.catPopRows || []) {
            if (y >= r2.top && y <= r2.bottom) {
              setCategoryFilter(node, r2.name);
              return true;
            }
          }
          return true; // padding of the popover: swallow the click
        }
        closeCategoryPicker(node);
        // fall through: the click may also be meant for a control underneath
      }
      // header → add/edit, except the settings switch in its corner
      if (y >= st.widgetY - 1 && y <= st.widgetY + HEADER_H) {
        const sw = st.settingsBtn;
        if (sw && x >= sw.x && x <= sw.x + sw.w && y >= sw.y && y <= sw.y + sw.h) {
          toggleSettingsCollapsed(node);
          resizeNode(node);
          return true;
        }
        openEditor(node, null);
        return true;
      }
      // search bar: click focuses the on-node search (window-capture in
      // esn_search.js handles activation; returning true here just stops
      // LiteGraph from treating the click as a row click)
      if (st.searchZone && y >= st.searchZone.top && y <= st.searchZone.bottom) {
        const sx = x;
        if (st.searchClear && sx >= st.searchClear.x && sx <= st.searchClear.x + st.searchClear.w) {
          clearSearch();
          return true;
        }
        focusSearch(node);
        return true;
      }
      // toolbar buttons: ✓ all / ✗ none / only / cat / sort. The hit zone is
      // the button box extended by 6 px on every side to cover the badge that
      // overlaps the top edge (still >= 24 px tall between buttons).
      const tb = st.toolbarBtns;
      if (tb && y >= tb.y - 6 && y <= tb.y + tb.h + 3) {
        const hit = (z) => z && x >= z.x - 2 && x <= z.x + z.w + 2 && y >= z.y - 6 && y <= z.y + z.h + 3;
        if (hit(tb.tick)) { tickVisibleRows(node, true); return true; }
        if (hit(tb.none)) { tickVisibleRows(node, false); return true; }
        if (hit(tb.only)) { toggleOnlyChecked(node); return true; }
        if (hit(tb.cat)) { toggleCategoryPicker(node); return true; }
        if (hit(tb.sort)) { toggleFreqSort(node); return true; }
        return false; // gap between toolbar buttons: let it fall through
      }
      // status bar: the active-category chip (its x clears the filter) and the
      // toast's inline action button
      if (st.statusBar && y >= st.statusBar.y && y <= st.statusBar.y + st.statusBar.h) {
        const chip = st.catChip;
        if (chip && x >= chip.x && x <= chip.x + chip.w && y >= chip.y && y <= chip.y + chip.h) {
          setCategoryFilter(node, "");
          return true;
        }
        const act = st.statusAction;
        if (act && x >= act.x && x <= act.x + act.w && y >= act.y && y <= act.y + act.h) {
          const fn = st.toast && st.toast.action;
          st.toast = null;
          if (typeof fn === "function") fn();
          app.graph?.setDirtyCanvas?.(true, true);
          return true;
        }
        return true; // nothing else lives in the status bar
      }
      // rows scrollbar drag (pointer band is SB_HIT_W wide, 24 px)
      const viewRows = st.view.length;
      const maxScr = Math.max(0, viewRows - MAX_DRAWN_ROWS);
      if (maxScr > 0 && st.sbZone && x >= st.sbZone.x && x <= st.sbZone.x + st.sbZone.w &&
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
          const row = st.rows[r.index];
          if (!row) return false;
          // checkbox column toggles the manual-pick flag in place (24x22
          // target, 24x24 with the row's own hit tolerance)
          if (x >= 10 && x <= 34) {
            row.on = !row.on;
            commitRows(node, st.rows); // dataset-aware (file vs widget)
            app.graph?.setDirtyCanvas?.(true, true);
            return true;
          }
          // category chip: clicking it filters the whole node list by that
          // category; clicking the chip of the active filter clears it
          if (row.cat) {
            const cw = r.catW || 0;
            if (x >= 52 && x <= 52 + cw) {
              const cur = (st.catFilter || "").trim();
              setCategoryFilter(node, cur === String(row.cat).trim() ? "" : row.cat);
              return true;
            }
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

export { makeListWidget, startSbDrag };
