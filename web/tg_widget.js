// EasyStringTokenGraph — the on-node widget.
//
// A compact strip drawn inside the node: the top tokens as bars, plus the
// controls that matter before opening the full panel. It is deliberately
// small - the panel is where the graph lives - so it shows the ranking, the
// run count and a button to open the graph.
//
// Like the EasyStringNegEditor widget this draws on the SHARED ComfyUI canvas,
// so every save() must be matched: tests/tg_widget_balance.mjs asserts that the
// stack depth after draw() equals the depth before it, over every branch.

import { stateOf, settings, statsFor, togglePanel, isPanelOpen } from "./tg_panel.js";
import { parseExclude, isExcluded, rankTokens } from "./tg_tokens.js";

const ROW_H = 18;
const MAX_ROWS = 6;
const HEADER_H = 26;
const NOTE_H = 15;
const FOOT_H = 15;
const PAD = 8;
const BAR_W = 74;
// The header button's box. draw() paints it and mouse() hit-tests it, so the
// two numbers exist ONCE: duplicating them is how the hit test drifted away
// from the painted rectangle in the first place.
const BTN_W = 96;
const BTN_H = 22;
const UI_NAME = "token_graph_ui";

const COL = {
  text: "#e8e8e8",
  textDim: "#a8a8a8", // 5.9:1 on the node body
  textMuted: "#9a9a9a", // 5.2:1
  bar: "#8ab4f8",
  barTop: "#ffd873",
  empty: "#a8a8a8", // 6.0:1
  accent: "#8ab4f8",
  accentOn: "#ffd873",
  hidden: "#c9a3ff",
  track: "#2c2c2c",
};

function labelFor(node) {
  return isPanelOpen(node) ? "hide graph" : "show graph";
}

// How tall the widget wants to be for the current state.
//
// The node reports this through computeSize(), and ComfyUI is free to give the
// widget less (a node resized by hand, or a layout that has not caught up).
// draw() therefore never assumes it got this much - it fits what it can into
// whatever band it was handed - but the request itself must stay honest and
// small, or the node grows a tall empty tail.
function widgetHeight(node) {
  const st = stateOf(node);
  const cfg = settings(node);
  const doc = statsFor(node);
  const rows = rankTokens(doc, {
    patterns: parseExclude(cfg.exclude),
    minN: cfg.minCount,
    limit: cfg.topN,
  });
  const shown = Math.min(MAX_ROWS, rows.length);
  let h = HEADER_H + 6;
  h += shown ? shown * ROW_H : 18;
  if (rows.length > shown) h += NOTE_H; // "+N more in the panel"
  if (hasHidden(doc, cfg)) h += FOOT_H; // boilerplate note
  void st;
  return h;
}

// Whether the footer line will be drawn: the two bottom lines are laid out in
// sequence, so both have to reserve room.
function hasHidden(doc, cfg) {
  const patterns = parseExclude(cfg.exclude);
  if (!patterns.length) return false;
  for (const key of Object.keys(doc.tokens || {})) {
    if (isExcluded(key, patterns)) return true;
  }
  return false;
}

function drawIcon(ctx, kind, cx, cy) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 1.4;
  if (kind === "graph") {
    // three dots joined by lines: "relations"
    const pts = [[-4.4, 3.2], [0.2, -3.6], [4.6, 2.4]];
    ctx.beginPath();
    ctx.moveTo(cx + pts[0][0], cy + pts[0][1]);
    ctx.lineTo(cx + pts[1][0], cy + pts[1][1]);
    ctx.lineTo(cx + pts[2][0], cy + pts[2][1]);
    ctx.stroke();
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(cx + p[0], cy + p[1], 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === "spark") {
    ctx.beginPath();
    ctx.moveTo(cx - 1.2, cy - 4.6);
    ctx.lineTo(cx + 1.6, cy - 0.4);
    ctx.lineTo(cx - 0.6, cy - 0.4);
    ctx.lineTo(cx + 1.2, cy + 4.6);
    ctx.lineTo(cx - 1.6, cy + 0.4);
    ctx.lineTo(cx + 0.6, cy + 0.4);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

function makeTokenWidget(node) {
  return {
    type: "custom",
    name: UI_NAME,
    value: "",
    options: { serialize: false },
    // The strip is UI only: it must never end up in widgets_values, or it
    // would change this node's execution-cache signature on every redraw.
    serialize: false,
    serializeValue: () => undefined,
    // Computed by ComfyUI each layout pass; keep it cheap and honest.
    computeSize(width) {
      return [width || node.size[0], widgetHeight(node)];
    },
    draw(ctx, n, widgetWidth, y, height) {
      const w = Math.max(120, widgetWidth || n.size[0]);
      const st = stateOf(n);
      const cfg = settings(n);
      const doc = statsFor(n);
      const patterns = parseExclude(cfg.exclude);
      const rows = rankTokens(doc, { patterns, minN: cfg.minCount, limit: cfg.topN });
      const maxN = rows.length ? Math.max(...rows.map((r) => r.n)) : 1;

      // Everything is placed from a single cursor that only moves DOWN, and
      // never past the band ComfyUI handed us. The previous version drew the
      // footer at `y + height - 8` and the "+N more" line at the end of the
      // list independently, so when the band was short the two landed on the
      // same line and rendered on top of each other as unreadable purple mush.
      // The `height` argument is NOT trustworthy. Observed on a real canvas: a
      // 590px-tall node handed this widget a band tall enough for the header
      // only, so every token row was skipped while the node body reserved their
      // full height - the strip looked blank and there was a large empty block
      // below it. The pack's other canvas widget avoids the whole class of bug
      // by treating `y` as the only trustworthy input and reading its height
      // from computeSize() instead (web/esn_widget.js draws with `y` and never
      // reads H). This widget does the same: it lays out the height it asked
      // for, so what is drawn always matches the space the node reserved.
      void height;
      const granted = widgetHeight(n);
      // Where this widget was painted, in node space. mouse() receives pos in
      // this same frame, so the button's hit test needs it (see mouse() below).
      st.widgetY = y;
      st.widgetH = granted;
      const bandBottom = y + granted;
      let cursor = y + 2;

      ctx.save();
      try {
        ctx.font = "11px sans-serif";
        ctx.textBaseline = "middle";

        // --- header: button + run count -------------------------------
        const btnX = PAD;
        const btnY = cursor;
        const open = isPanelOpen(n);
        ctx.beginPath();
        ctx.roundRect(btnX, btnY, BTN_W, BTN_H, [5]);
        ctx.fillStyle = open ? "#2f4536" : "#2c2c2c";
        ctx.fill();
        ctx.strokeStyle = open ? "#4c7a5c" : "#454545";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = open ? COL.accentOn : COL.accent;
        drawIcon(ctx, "graph", btnX + 13, btnY + BTN_H / 2);
        ctx.fillStyle = open ? COL.accentOn : COL.text;
        ctx.textAlign = "left";
        ctx.fillText(labelFor(n), btnX + 25, btnY + BTN_H / 2 + 0.5);

        ctx.textAlign = "right";
        ctx.fillStyle = COL.textMuted;
        ctx.fillText(`${doc.runs || 0} runs · ${rows.length} tokens`, w - PAD, btnY + BTN_H / 2 + 0.5);
        cursor = btnY + BTN_H + 4;

        // --- token bars -----------------------------------------------
        ctx.textAlign = "left";
        // The two bottom lines are reserved from the BOTTOM of the band, each
        // one only if the space left after the list can actually hold it. The
        // earlier version reserved a running total but then drew each line
        // behind a `reserved != 0` test, so a band tall enough for only one of
        // them still painted both and the second landed below the node.
        const room = Math.max(0, bandBottom - cursor);
        const wantMore = rows.length > MAX_ROWS;
        const wantFoot = hasHidden(doc, cfg);
        let reserved = 0;
        let moreShown = false;
        let footShown = false;
        if (wantFoot && room >= FOOT_H) {
          footShown = true;
          reserved += FOOT_H;
        }
        if (wantMore && room - reserved >= NOTE_H) {
          moreShown = true;
          reserved += NOTE_H;
        }
        const listBottom = bandBottom - reserved;

        if (!rows.length) {
          if (cursor + 12 <= listBottom) {
            ctx.fillStyle = COL.empty;
            ctx.fillText("no tokens yet — run the node or type a prompt", PAD, cursor + 7);
          }
        } else {
          const nameW = Math.max(60, w - PAD * 2 - BAR_W - 34);
          for (let i = 0; i < rows.length && i < MAX_ROWS; i++) {
            const ry = cursor + i * ROW_H + ROW_H / 2;
            // the row's text sits on the baseline, so require the full row box
            if (ry + ROW_H / 2 > listBottom) break;
            const row = rows[i];
            const dim = st.hoverKey && st.hoverKey !== row.k;
            ctx.globalAlpha = dim ? 0.45 : 1;
            ctx.fillStyle = i === 0 ? COL.barTop : COL.text;
            ctx.fillText(fit(ctx, row.t, nameW), PAD, ry);
            ctx.textAlign = "right";
            ctx.fillStyle = COL.textMuted;
            ctx.fillText(String(row.n), PAD + nameW + 22, ry);
            ctx.textAlign = "left";
            const bx = PAD + nameW + 28;
            ctx.fillStyle = COL.track;
            ctx.fillRect(bx, ry - 3, BAR_W, 6);
            ctx.fillStyle = i === 0 ? COL.barTop : COL.bar;
            ctx.fillRect(bx, ry - 3, Math.round(BAR_W * Math.max(0.04, row.n / maxN)), 6);
            ctx.globalAlpha = 1;
          }
        }

        // --- the two bottom lines, in sequence -------------------------
        // "+N more" sits above the boilerplate note, and each is drawn only if
        // it was actually reserved above.
        let line = listBottom;
        if (moreShown) {
          ctx.fillStyle = COL.textMuted;
          ctx.textAlign = "left";
          ctx.fillText(`+${rows.length - MAX_ROWS} more in the panel`, PAD, line + NOTE_H / 2);
          line += NOTE_H;
        }
        if (footShown) {
          let hiddenN = 0;
          let hiddenCount = 0;
          for (const key of Object.keys(doc.tokens || {})) {
            if (!isExcluded(key, patterns)) continue;
            hiddenN += Number(doc.tokens[key].n) || 0;
            hiddenCount += 1;
          }
          ctx.fillStyle = COL.hidden;
          ctx.textAlign = "left";
          ctx.fillText(`${hiddenCount} boilerplate token(s) hidden (${hiddenN} uses)`, PAD, line + FOOT_H / 2);
        }
      } finally {
        ctx.restore();
      }
    },
    mouse(event, pos, n) {
      // Only an actual left click toggles; a hover or a right-click must not.
      if (event.type !== "pointerdown" && event.type !== "mousedown") return false;
      if (event.button != null && event.button !== 0) return false;
      const st = stateOf(n);
      const [mx, my] = pos;
      // `pos` is in the SAME frame as the `y` that draw() was given, so the
      // button's rectangle has to be compared against that recorded origin.
      // Testing `my <= HEADER_H + 4` (i.e. as if pos were widget-relative while
      // nothing recorded the origin) is why the button rendered correctly and
      // then did nothing when clicked.
      const top = Number.isFinite(st.widgetY) ? st.widgetY : 0;
      if (my >= top && my <= top + BTN_H + 2 && mx >= PAD && mx <= PAD + BTN_W) {
        togglePanel(n);
        return true;
      }
      return false;
    },
  };
}

// Clip text to a pixel width using real measurement - a character count would
// be wrong for a proportional font.
function fit(ctx, text, maxPx) {
  const s = String(text == null ? "" : text);
  try {
    if (ctx.measureText(s).width <= maxPx) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(s.slice(0, mid) + "\u2026").width <= maxPx) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? s.slice(0, lo) + "\u2026" : "";
  } catch (e) {
    const room = Math.max(1, Math.floor(maxPx / 6));
    return s.length <= room ? s : s.slice(0, room - 1) + "\u2026";
  }
}

export { makeTokenWidget, widgetHeight, labelFor, drawIcon, fit, UI_NAME,
  COL, ROW_H, MAX_ROWS, HEADER_H, NOTE_H, FOOT_H, PAD, BAR_W, BTN_W, BTN_H };
