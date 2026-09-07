// EasyStringNegEditor — the custom canvas widget.
//
// Renders the on-node row list (with the search bar, usage counters ×N and
// the drag scrollbar) plus the presets panel, and handles clicks / wheel on
// them. The on-node search itself lives in esn_search.js; the scrollbar drag
// helpers here drive a window-level pointer grab.

import { app } from "../../scripts/app.js";
import {
  state, clampText, findWidget, hideRowsWidget, syncFromWidget,
  commitRows, countPresets, presetEntries, presetChoice,
  stepPresetChoice, UI_NAME,
  MAX_DRAWN_ROWS, WHEEL_STEP, ROW_H, HEADER_H, SEARCH_H,
  FREQ_W, SB_W, MAX_DRAWN_PRESETS, PRESET_H, PRESET_HDR_H, PRESET_GAP,
} from "./esn_core.js";
import {
  rowCount, rebuildView, toggleFreqSort, listHeight, resizeNode,
} from "./esn_view.js";
import { focusSearch, clearSearch } from "./esn_search.js";
import { openEditor } from "./esn_dialog.js";

// --- rows scrollbar drag ---
let sbDragNode = null;

function startSbDrag(node, st, event, y) {
  const zone = st.sbZone;
  if (!zone) return;
  sbDragNode = node;
  st.draggingSb = true;
  st.sbStartClientY = (event && typeof event.clientY === "number") ? event.clientY : y;
  st.sbStartNodeY = y;
  const thumbY = zone.thumbY;
  const grabOffset = y - thumbY;
  // grabbing the track itself (not the thumb) grabs the thumb's middle
  st.sbGrabOffset = (grabOffset >= 0 && grabOffset <= zone.thumbH) ? grabOffset : zone.thumbH / 2;
  st.sbScale = (app.canvas && app.canvas.ds && app.canvas.ds.scale) ? app.canvas.ds.scale : 1;
  try { event.preventDefault(); } catch (e) {}
  try { event.stopPropagation(); } catch (e) {}
  app.graph?.setDirtyCanvas?.(true, true);
  // move + up on window so dragging outside the widget keeps working
  window.addEventListener("pointermove", onSbMove, { passive: false });
  window.addEventListener("pointerup", onSbUp);
  window.addEventListener("pointercancel", onSbUp);
}

function onSbMove(e) {
  const node = sbDragNode;
  if (!node) return;
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
  const node = sbDragNode;
  sbDragNode = null;
  if (node) {
    const st = state(node);
    st.draggingSb = false;
    app.graph?.setDirtyCanvas?.(true, true);
  }
  window.removeEventListener("pointermove", onSbMove);
  window.removeEventListener("pointerup", onSbUp);
  window.removeEventListener("pointercancel", onSbUp);
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
      const loading = st.file && st.loadedFile !== st.file && !st.loadFailed;
      const failed = st.file && st.loadedFile !== st.file && st.loadFailed;
      const totalShown = st.view ? st.view.length : rowCount(n);
      const titleTxt = failed ? "✎ dataset " + st.file + " not found — edit" : (loading ? "✎ dataset " + st.file + " — loading…" : "✎ Rows (" + totalShown + (st.search ? "/" + rowCount(n) : "") + ") / Presets (" + pCount + ") — edit");
      // sort-by-frequency toggle on the right edge of the header
      const sortX = fullW - 34;
      const sortY = y + 3;
      const sortW = 22;
      const sortH = HEADER_H - 6;
      st.sortBtn = { x: sortX, y: sortY, w: sortW, h: sortH };
      const canSort = (rowCount(n) || st.rows.length) > 1;
      ctx.textAlign = "right";
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = canSort ? (st.sortedByFreq ? "#ffcc66" : "rgba(255,255,255,0.6)") : "rgba(255,255,255,0.18)";
      ctx.fillText("⇅", sortX + sortW - 8, y + HEADER_H / 2 + 1);
      ctx.textAlign = "center";
      // title, squeezed so it doesn't overlap the sort control
      ctx.font = "bold 12px sans-serif";
      const titleMax = fullW - 24 - 42;
      ctx.fillText(clampText(titleTxt, Math.max(8, Math.floor(titleMax / 6.2))), 12 + (fullW - 24) / 2, y + HEADER_H / 2 + 1);
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
      st.view = rebuildView(st, st.rows);
      const total = st.view.length;
      const maxScroll = Math.max(0, total - MAX_DRAWN_ROWS);
      if (st.scroll > maxScroll) st.scroll = maxScroll;
      if (st.scroll < 0) st.scroll = 0;
      const shown = Math.min(total - st.scroll, MAX_DRAWN_ROWS);
      let ry = y + HEADER_H;

      // search bar (always visible): magnifier glyph + text + clear ✕
      const searchTop = ry;
      const searchBot = searchTop + SEARCH_H;
      st.searchZone = { top: searchTop, bottom: searchBot };
      const sbBoxW = fullW - 24 - SB_W - 6;
      ctx.save();
      ctx.fillStyle = "rgba(8,8,8,0.55)";
      ctx.strokeStyle = st.searchFocus ? "#5af" : "rgba(255,255,255,0.22)";
      ctx.lineWidth = st.searchFocus ? 1.5 : 1;
      ctx.beginPath();
      ctx.roundRect(12, searchTop + 2, sbBoxW, SEARCH_H - 4, [9]);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const hasQ = !!(st.search || "").trim();
      ctx.fillStyle = hasQ ? "#eee" : "rgba(255,255,255,0.42)";
      ctx.font = "10px sans-serif";
      const ph = hasQ ? st.search : "search rows…";
      ctx.fillText("🔍", 20, searchTop + SEARCH_H / 2 + 1);
      ctx.fillText(clampText(ph, Math.max(6, Math.floor(sbBoxW / 5.4) - 18)), 34, searchTop + SEARCH_H / 2 + 1);
      if (hasQ) {
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.textAlign = "center";
        ctx.fillText("✕", 12 + sbBoxW - 12, searchTop + SEARCH_H / 2 + 1);
        st.searchClear = { x: 12 + sbBoxW - 24, y: searchTop + 2, w: 22, h: SEARCH_H - 4 };
      } else {
        st.searchClear = null;
      }
      ctx.restore();
      ry += SEARCH_H;

      ctx.save();
      for (let i = 0; i < shown; i++) {
        const row = st.view[st.scroll + i].row;
        const oi = st.view[st.scroll + i].oi;
        const freq = row.freq || 0;
        if (freq > 0) {
          const a = Math.min(0.34, 0.08 + Math.log2(1 + freq) * 0.05);
          ctx.fillStyle = "rgba(255,170,60," + a.toFixed(3) + ")";
        } else {
          ctx.fillStyle = (st.scroll + i) % 2 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.25)";
        }
        ctx.fillRect(12, ry + 1, fullW - 24 - (freq > 0 ? FREQ_W - 4 : 0), ROW_H - 2);
        // checkbox column (manual pick)
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "12px sans-serif";
        if (row.on) {
          ctx.fillStyle = "#6cf";
          ctx.fillText("☑", 18, ry + ROW_H / 2);
        } else {
          ctx.strokeStyle = "rgba(255,255,255,0.5)";
          ctx.strokeRect(13, ry + ROW_H / 2 - 5, 11, 11);
        }
        // number
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = "10px monospace";
        ctx.textAlign = "left";
        const numTxt = row.num != null ? String(row.num) : String(oi + 1);
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
        // label (shrink by the reserved freq column / img marker)
        const hasImg = !!row.img;
        const reserved = (freq > 0 ? FREQ_W - 2 : 6) + (hasImg ? 18 : 0);
        const avail = fullW - 24 - (lx - 12) - reserved;
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
          ctx.fillText("◧", fullW - 24 - (freq > 0 ? FREQ_W - 4 : 0), ry + ROW_H / 2);
        }
        // usage counter on the right edge
        if (freq > 0) {
          ctx.textAlign = "right";
          ctx.fillStyle = freq >= 5 ? "#ffcc66" : "rgba(140,190,255,0.95)";
          ctx.font = "9px sans-serif";
          ctx.fillText("×" + freq, fullW - 14, ry + ROW_H / 2);
        }
        st.rects.push({ top: ry, bottom: ry + ROW_H, index: oi });
        ry += ROW_H;
      }
      // scroll area: arrows + wheel + drag scrollbar, drawn when rows hidden
      st.scrollUp = null;
      st.scrollDown = null;
      const canScroll = total > MAX_DRAWN_ROWS;
      let rowsBottom = ry; // rows area ends here (below the scroll hint)
      if (canScroll) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 11px sans-serif";
        ctx.fillStyle = st.scroll > 0 ? "#9cf" : "rgba(255,255,255,0.2)";
        const upY = ry + 4;
        ctx.fillText("▲", cx - 14, upY);
        ctx.fillText("▼", cx + 14, upY);
        st.scrollUp = { x: cx - 24, y: ry, w: 28, h: 12 };
        st.scrollDown = { x: cx + 4, y: ry, w: 28, h: 12 };
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        const leftCount = total - (st.scroll + shown);
        ctx.fillText(leftCount > 0 ? ("↓ " + leftCount + " more - wheel / arrows / drag") : "(wheel to scroll)", cx, ry + 15);
        rowsBottom = ry + 18;

        // drag scrollbar on the right edge of the drawn rows
        const sbX = fullW - SB_W - 4;
        const sbY = searchBot + 1;
        const sbH = rowsBottom - sbY - 1;
        if (sbH > 24 && shown > 0) {
          const trackH = sbH;
          const thumbH = Math.max(16, trackH * (shown / total));
          const frac = maxScroll > 0 ? st.scroll / maxScroll : 0;
          const thumbY = sbY + frac * (trackH - thumbH);
          st.sbZone = { x: sbX, y: sbY, w: SB_W, h: trackH, thumbY: thumbY, thumbH: thumbH, maxScroll: maxScroll };
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          ctx.fillRect(sbX, sbY, SB_W, trackH);
          ctx.fillStyle = st.draggingSb ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.35)";
          ctx.fillRect(sbX + 2, thumbY + 2, SB_W - 4, Math.max(8, thumbH - 4));
        }
      } else {
        if (shown === 0) {
          ctx.fillStyle = "rgba(255,255,255,0.25)";
          ctx.font = "10px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(st.search ? "(no rows match “" + clampText(st.search, 22) + "”)" : "(no rows yet - click the header to add)", cx, ry + 12);
          rowsBottom = ry + 18;
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
      ctx.fillStyle = "#fca";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("Presets (" + entries.length + ") — " + (entries.length ? "click a line to open · use/◀/▶ to pick" : "click to add"), secLeft + 6, secTop + PRESET_HDR_H / 2);
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
          ctx.fillStyle = isActive ? "#7f7" : "rgba(255,255,255,0.6)";
          ctx.textAlign = "left";
          const lineTxt = clampText(en.text, Math.max(8, secW - 6));
          ctx.fillText((isActive ? "\u25b6 " : "  ") + lineTxt, secLeft + 4, rowTop + PRESET_H / 2);
          st.presetRects.push({ top: rowTop, bottom: rowBottom, num: en.num });
          pBottom = rowBottom;
        }
        if (entries.length > MAX_DRAWN_PRESETS) {
          const ay = pBottom + 7;
          ctx.fillStyle = st.presetScroll > 0 ? "#c97" : "rgba(255,255,255,0.2)";
          ctx.font = "bold 10px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("\u25b2", cx - 14, ay);
          ctx.fillStyle = st.presetScroll < maxPScroll ? "#c97" : "rgba(255,255,255,0.2)";
          ctx.fillText("\u25bc", cx + 14, ay);
          st.presetUp = { x: cx - 28, y: ay - 8, w: 28, h: 16 };
          st.presetDown = { x: cx + 2, y: ay - 8, w: 28, h: 16 };
          pBottom += 16;
          st.presetListArea = { top: secTop + PRESET_HDR_H, bottom: pBottom };
        }
        // control row: use_preset toggle + active preset stepper
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(secLeft, pBottom, secW, 18);
        const ctlY = pBottom + 9;
        // left label
        ctx.font = "9px sans-serif";
        ctx.textAlign = "left";
        const active = choice.on ? entries.find((e) => e.num === choice.line) : null;
        ctx.fillStyle = active ? "#7f7" : "rgba(255,255,255,0.5)";
        ctx.fillText(active
          ? ("active preset " + choice.line + " → " + clampText(active.text, Math.max(6, secW - 120)))
          : (choice.on ? ("preset " + choice.line + " not found") : "preset off — all rows / line_numbers"),
          secLeft + 4, ctlY);
        // right: [use] [◀] [▶] mini buttons
        const btns = [
          { key: "use", label: choice.on ? "use:on" : "use:off", color: choice.on ? "#7f7" : "#888" },
          { key: "prev", label: "\u25c0", color: "#9cf", enabled: entries.length > 1 },
          { key: "next", label: "\u25b6", color: "#9cf", enabled: entries.length > 1 },
        ];
        let bx = secLeft + secW - 4;
        st.presetUse = null; st.presetPrev = null; st.presetNext = null;
        for (let bi = btns.length - 1; bi >= 0; bi--) {
          const b = btns[bi];
          const w2 = bi === 0 ? 38 : 16;
          bx -= w2;
          const zone = { x: bx, y: pBottom + 2, w: w2, h: 14, key: b.key };
          ctx.fillStyle = b.color;
          ctx.globalAlpha = b.enabled === false ? 0.3 : 0.9;
          ctx.strokeStyle = "rgba(255,255,255,0.25)";
          ctx.strokeRect(bx, pBottom + 2, w2, 14);
          ctx.font = b.key === "use" ? "8px sans-serif" : "9px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(b.label, bx + w2 / 2, ctlY);
          ctx.globalAlpha = 1;
          if (b.key === "use") st.presetUse = zone;
          else if (b.key === "prev") st.presetPrev = zone;
          else st.presetNext = zone;
        }
        pBottom += 20;
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("(no presets yet — click to add)", cx, pBottom + 9);
        pBottom += 18;
        // whole empty area opens the dialog on the Presets tab
        st.presetsHeader = { top: secTop, bottom: pBottom };
      }
      ctx.restore();
      st.presetsBottom = pBottom;
      st.widgetH = Math.max(st.widgetH, pBottom - y + 2);
    },
    mouse(event, pos, node) {
      if (event.type !== "pointerdown" && event.type !== "mousedown") {
        return false;
      }
      if (event.button != null && event.button !== 0) return false;
      const x = pos[0];
      const y = pos[1];
      const st = state(node);
      // header sort-by-frequency toggle (right edge)
      if (st.sortBtn && x >= st.sortBtn.x && x <= st.sortBtn.x + st.sortBtn.w &&
          y >= st.sortBtn.y && y <= st.sortBtn.y + st.sortBtn.h) {
        toggleFreqSort(node);
        return true;
      }
      // header → add/edit
      if (y >= st.widgetY - 1 && y <= st.widgetY + HEADER_H) {
        openEditor(node, null);
        return true;
      }
      // search bar: click focuses the hidden input; ✕ clears the filter
      if (st.searchZone && y >= st.searchZone.top && y <= st.searchZone.bottom) {
        const sx = x;
        if (st.searchClear && sx >= st.searchClear.x && sx <= st.searchClear.x + st.searchClear.w) {
          clearSearch();
          return true;
        }
        focusSearch(node);
        return true;
      }
      // rows scrollbar drag (pointer grab anywhere on the track)
      const viewRows = st.view.length;
      const maxScr = Math.max(0, viewRows - MAX_DRAWN_ROWS);
      if (maxScr > 0 && st.sbZone && x >= st.sbZone.x - 2 && x <= st.sbZone.x + st.sbZone.w + 2 &&
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
          // checkbox column toggles the manual-pick flag in place
          if (x >= 10 && x <= 28) {
            const row = st.rows[r.index];
            if (row) {
              row.on = !row.on;
              commitRows(node, st.rows); // dataset-aware (file vs widget)
              app.graph?.setDirtyCanvas?.(true, true);
            }
            return true;
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
