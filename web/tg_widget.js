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
const HINT_H = 18;
const PAD = 8;
const BAR_W = 74;
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
  let h = HEADER_H + HINT_H;
  h += shown ? shown * ROW_H + 4 : 20;
  h += 10; // footer with the hidden-token note
  void st;
  return h;
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
      const shown = rows.slice(0, MAX_ROWS);
      const maxN = rows.length ? Math.max(...rows.map((r) => r.n)) : 1;
      const listTop = y + HEADER_H;
      const listH = Math.max(0, (height || widgetHeight(n)) - HEADER_H - HINT_H - 10);

      ctx.save();
      try {
        ctx.font = "11px sans-serif";
        ctx.textBaseline = "middle";

        // --- header: button + run count -------------------------------
        const btnW = 96;
        const btnH = 22;
        const btnX = PAD;
        const btnY = y + 2;
        const open = isPanelOpen(n);
        ctx.beginPath();
        ctx.roundRect(btnX, btnY, btnW, btnH, [5]);
        ctx.fillStyle = open ? "#2f4536" : "#2c2c2c";
        ctx.fill();
        ctx.strokeStyle = open ? "#4c7a5c" : "#454545";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = open ? COL.accentOn : COL.accent;
        drawIcon(ctx, "graph", btnX + 13, btnY + btnH / 2);
        ctx.fillStyle = open ? COL.accentOn : COL.text;
        ctx.textAlign = "left";
        ctx.fillText(labelFor(n), btnX + 25, btnY + btnH / 2 + 0.5);

        ctx.textAlign = "right";
        ctx.fillStyle = COL.textMuted;
        const runs = `${doc.runs || 0} runs · ${rows.length} tokens`;
        ctx.fillText(runs, w - PAD, btnY + btnH / 2 + 0.5);

        // --- token bars -----------------------------------------------
        ctx.textAlign = "left";
        if (!shown.length) {
          ctx.fillStyle = COL.empty;
          ctx.fillText("no tokens yet — run the node or type a prompt", PAD, listTop + 10);
        } else {
          const nameW = Math.max(60, w - PAD * 2 - BAR_W - 34);
          shown.forEach((row, i) => {
            const ry = listTop + i * ROW_H + ROW_H / 2;
            if (ry > listTop + listH) return;
            const dim = st.hoverKey && st.hoverKey !== row.k;
            ctx.globalAlpha = dim ? 0.45 : 1;
            ctx.fillStyle = i === 0 ? COL.barTop : COL.text;
            const name = fit(ctx, row.t, nameW);
            ctx.fillText(name, PAD, ry);
            // count, right-aligned before the bar
            ctx.textAlign = "right";
            ctx.fillStyle = COL.textMuted;
            ctx.fillText(String(row.n), PAD + nameW + 22, ry);
            ctx.textAlign = "left";
            const bx = PAD + nameW + 28;
            ctx.fillStyle = COL.track;
            ctx.fillRect(bx, ry - 3, BAR_W, 6);
            ctx.fillStyle = i === 0 ? COL.barTop : COL.bar;
            const frac = Math.max(0.04, row.n / maxN);
            ctx.fillRect(bx, ry - 3, Math.round(BAR_W * frac), 6);
            ctx.globalAlpha = 1;
          });
          if (rows.length > shown.length) {
            const more = rows.length - shown.length;
            ctx.fillStyle = COL.textMuted;
            ctx.fillText(`+${more} more in the panel`, PAD, listTop + listH + 2);
          }
        }

        // --- footer: what the exclusions hide -------------------------
        let hiddenN = 0;
        let hiddenCount = 0;
        for (const key of Object.keys(doc.tokens || {})) {
          if (!isExcluded(key, patterns)) continue;
          hiddenN += Number(doc.tokens[key].n) || 0;
          hiddenCount += 1;
        }
        if (hiddenCount) {
          ctx.fillStyle = COL.hidden;
          ctx.fillText(
            `${hiddenCount} boilerplate token(s) hidden (${hiddenN} uses)`,
            PAD, y + (height || widgetHeight(n)) - 8,
          );
        }
      } finally {
        ctx.restore();
      }
    },
    mouse(event, pos, n) {
      const [mx, my] = pos;
      // header button hit area (the whole widget is only a few rows tall)
      if (my >= 0 && my <= HEADER_H + 4 && mx >= PAD && mx <= PAD + 100) {
        if (event.type === "pointerdown" || event.type === "mousedown") {
          togglePanel(n);
          return true;
        }
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
  COL, ROW_H, MAX_ROWS, HEADER_H, HINT_H, PAD, BAR_W };
