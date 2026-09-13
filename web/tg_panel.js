// EasyStringTokenGraph — the floating graph panel.
//
// A DOM window that can float (drag it by its header) or dock to a window
// edge, holding:
//
//   * a force-directed graph on its own <canvas> - size = how often the token
//     is used, an edge = two tokens used together, thickness = how strongly
//   * a ranked list of the most used tokens (the "which tokens do I use"
//     column), each row clickable
//   * a relations readout: resting the pointer on a token for a moment shows
//     what it is used WITH, ranked - the graph dims everything unrelated
//   * an exclusion drawer: quality boilerplate is hidden by default, and a
//     token can be ignored from the tooltip itself
//
// This canvas is the panel's OWN element, so unlike the on-node widget it
// cannot corrupt the graph renderer's state. It still keeps save/restore
// balanced, and tests/tg_panel_render.mjs asserts that.
//
// Data comes from two places: the payload the node returns after a run (the
// exact counts for that text) and GET /easystring/token_stats (the accumulated
// history, so the panel draws something before the next Queue). Typing in the
// node's text box re-ranks live by folding the current text once into a copy
// of the history, which is why the panel needs its own tokenizer (tg_tokens).
//
// The module is written for the two ComfyUI UIs at once: nothing here depends
// on LiteGraph, only on the node object (to read its widgets) and on DOM APIs
// that both UIs provide.

import {
  parseExclude, isExcluded, mergeRun, rankTokens, edgesFor,
  relationsOf, emptyStats, statsToJSON, DEFAULT_EXCLUDE_TEXT,
} from "./tg_tokens.js";
import { layout, hitTest, fitLabel } from "./tg_layout.js";

const NODE_CLASS = "EasyStringTokenGraph";
const STATS_ROUTE = "/easystring/token_stats";
const THEME_KEY = "__tgPanel";

// --- palette --------------------------------------------------------------
// Contrast is measured against the panel surfaces (#1b1b1b / #232323), and
// every text colour clears 4.5:1 (WCAG AA for normal text); the graph colours
// are non-text graphics and clear 3:1 against the plot background.
const C = {
  bg: "#1b1b1b",
  panel: "#232323",
  plot: "#151515",
  line: "#3a3a3a",
  text: "#e8e8e8",
  textDim: "#a8a8a8", // 7.0:1 on #232323
  textMuted: "#9a9a9a", // 5.9:1
  accent: "#8ab4f8",
  accentStrong: "#ffd873",
  edge: "#7f9dd8",
  edgeHot: "#ffd873",
  ok: "#8ed6a0",
  warn: "#ffcc66",
  track: "#2c2c2c",
  bar: "#3f6f9f",
  hidden: "#c9a3ff",
};

const HOVER_DELAY = 140; // ms of rest before the relations appear
const PANEL_W = 760;
const PANEL_H = 470;
const MIN_W = 420;
const MIN_H = 300;
const LIST_W = 244;
const SIDE_PAD = 12;

// --- per-node panel registry ---------------------------------------------

const panels = new WeakMap();

function widgetOf(node, name) {
  return (node && node.widgets ? node.widgets : []).find((w) => w && w.name === name) || null;
}

function widgetValue(node, name, fallback) {
  const w = widgetOf(node, name);
  if (!w) return fallback;
  const v = w.value;
  return v == null ? fallback : v;
}

function setWidgetValue(node, name, value) {
  const w = widgetOf(node, name);
  if (!w) return false;
  try {
    w.value = value;
  } catch (e) {
    return false;
  }
  if (w.inputEl && typeof w.inputEl === "object") {
    try {
      if (w.inputEl.value !== value) w.inputEl.value = value;
    } catch (e) {}
  }
  if (typeof w.callback === "function") {
    try {
      w.callback(value, node, w);
    } catch (e) {}
  }
  return true;
}

function settings(node) {
  return {
    file: String(widgetValue(node, "stats_file", "tokens") || "").trim(),
    exclude: String(widgetValue(node, "exclude", "") || ""),
    window: Math.max(1, Number(widgetValue(node, "window", 3)) || 3),
    topN: Math.max(1, Number(widgetValue(node, "top_n", 40)) || 40),
    minCount: Math.max(1, Number(widgetValue(node, "min_count", 1)) || 1),
    position: String(widgetValue(node, "position", "floating") || "floating"),
    text: String(widgetValue(node, "text", "") || ""),
  };
}

function nodeGeometry(node) {
  const saved = (node && node.properties && node.properties[THEME_KEY]) || {};
  return {
    floating: saved.floating !== false,
    x: Number.isFinite(saved.x) ? saved.x : null,
    y: Number.isFinite(saved.y) ? saved.y : null,
    w: Math.max(MIN_W, Number(saved.w) || PANEL_W),
    h: Math.max(MIN_H, Number(saved.h) || PANEL_H),
    dock: saved.dock || "floating",
  };
}

function saveGeometry(node, geo) {
  if (!node) return;
  if (!node.properties) node.properties = {};
  node.properties[THEME_KEY] = {
    floating: geo.floating !== false,
    x: geo.x,
    y: geo.y,
    w: geo.w,
    h: geo.h,
    dock: geo.dock || "floating",
  };
}

// --- stats loading --------------------------------------------------------

function stateOf(node) {
  if (!panels.has(node)) {
    panels.set(node, {
      node,
      el: null,
      canvas: null,
      ctx: null,
      listEl: null,
      tipEl: null,
      excludeEl: null,
      base: emptyStats(), // history as the server knows it
      payload: null, // payload of the last run
      serverFile: null,
      loaded: false,
      preview: true, // fold the text currently in the box
      hoverKey: null,
      pinnedKey: null,
      nodes: [],
      edges: [],
      disposers: [],
      hoverTimer: null,
      raf: null,
      dirty: true,
      status: "",
    });
  }
  return panels.get(node);
}

function statsFor(node) {
  const st = stateOf(node);
  const cfg = settings(node);
  // History plus, when enabled, the text currently in the box: that is what
  // makes the panel answer "what am I using NOW" while typing, not only after
  // a Queue.
  const doc = {
    version: 1,
    runs: st.base.runs || 0,
    tokens: {},
    pairs: Object.assign({}, st.base.pairs || {}),
    window: cfg.window,
  };
  for (const key of Object.keys(st.base.tokens || {})) {
    const rec = st.base.tokens[key];
    doc.tokens[key] = { n: rec.n, runs: rec.runs, display: rec.display, last: rec.last };
  }
  if (st.preview && cfg.text.trim()) {
    // One extra "run" that is not counted in the history: it only shifts the
    // ranking towards what the user is writing right now.
    mergeRun(doc, cfg.text, cfg.window, (doc.runs || 0) + 1);
  }
  return doc;
}

async function loadStats(node) {
  const st = stateOf(node);
  const cfg = settings(node);
  if (!cfg.file) {
    // in-memory mode: the payload of the last run is all we can know
    st.base = emptyStats();
    st.loaded = true;
    st.serverFile = "";
    st.status = "in-memory counters (set stats_file to keep history)";
    st.dirty = true;
    scheduleDraw(node);
    return;
  }
  try {
    const res = await fetch(`${STATS_ROUTE}?file=${encodeURIComponent(cfg.file)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const stats = body && body.stats;
    if (stats && typeof stats === "object") {
      st.base = normalizeClientStats(stats);
      st.serverFile = body.file || cfg.file;
      st.status = `${st.base.runs || 0} runs recorded`;
    }
  } catch (e) {
    // the panel must still draw from the last payload when the route is
    // unavailable (older server, or ComfyUI not running the pack as a package)
    st.status = "history unavailable - showing the last run";
  }
  st.loaded = true;
  st.dirty = true;
  scheduleDraw(node);
}

function normalizeClientStats(raw) {
  const out = emptyStats();
  if (!raw || typeof raw !== "object") return out;
  out.runs = Math.max(0, Number(raw.runs) || 0);
  out.window = Math.max(1, Number(raw.window) || 3);
  const tokens = raw.tokens && typeof raw.tokens === "object" ? raw.tokens : {};
  for (const key of Object.keys(tokens)) {
    const rec = tokens[key];
    if (!rec || typeof rec !== "object") continue;
    const n = Math.max(0, Number(rec.n) || 0);
    if (!n) continue;
    out.tokens[key] = {
      n,
      runs: Math.max(0, Number(rec.runs) || 0),
      display: typeof rec.display === "string" && rec.display ? rec.display : key,
      last: Math.max(0, Number(rec.last) || 0),
    };
  }
  const pairs = raw.pairs && typeof raw.pairs === "object" ? raw.pairs : {};
  for (const key of Object.keys(pairs)) {
    const w = Number(pairs[key]) || 0;
    if (w > 0) out.pairs[key] = w;
  }
  return out;
}

// Called by the entry point when a run reports its payload.
function acceptPayload(node, payload) {
  if (!node || !payload || typeof payload !== "object") return;
  const st = stateOf(node);
  st.payload = payload;
  if (Array.isArray(payload.excluded)) st.lastExcluded = payload.excluded;
  if (st.el) {
    st.dirty = true;
    scheduleDraw(node);
  }
  // the run just wrote the history, so refresh it when the panel is open
  if (st.el) loadStats(node);
}

// --- drawing --------------------------------------------------------------

// A backgrounded tab does not run requestAnimationFrame at all. Coalescing on
// it alone would leave the panel blank - worse, the pending handle would stay
// truthy and block every later draw, so the panel would stay frozen even after
// the tab became visible again. Hence: a timeout backstop, and a first paint
// that does not wait for a frame at all.
const RAF_BACKSTOP_MS = 250;

function scheduleDraw(node) {
  const st = stateOf(node);
  if (!st.el) return;
  if (!st.rendered) {
    // opening the panel must show content immediately, not one frame later
    render(node);
    st.rendered = true;
    return;
  }
  if (st.raf) return;
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    if (st.rafTimer) {
      clearTimeout(st.rafTimer);
      st.rafTimer = null;
    }
    st.raf = null;
    if (st.el) render(node);
  };
  if (typeof requestAnimationFrame === "function") {
    st.raf = requestAnimationFrame(fire);
    st.rafTimer = setTimeout(fire, RAF_BACKSTOP_MS);
  } else {
    st.raf = setTimeout(fire, 16);
  }
}

function drawGraph(ctx, model, opts) {
  const o = opts || {};
  const w = Math.max(1, Number(o.width) || 0);
  const h = Math.max(1, Number(o.height) || 0);
  const nodes = model.nodes || [];
  const edges = model.edges || [];
  const hover = model.hoverKey;
  const selected = model.selectedKey;

  ctx.save();
  try {
    ctx.fillStyle = o.plot || C.plot;
    ctx.fillRect(0, 0, w, h);

    if (!nodes.length) {
      ctx.fillStyle = C.textDim;
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(o.emptyText || "no tokens yet - run the node or type a prompt", w / 2, h / 2);
      return;
    }

    // neighbours of the highlighted token: everything else is dimmed, which is
    // what turns "a cloud of dots" into "these go together"
    const focus = hover || selected || null;
    const related = Object.create(null);
    if (focus) {
      for (const e of edges) {
        const a = nodes[e[0]];
        const b = nodes[e[1]];
        if (!a || !b) continue;
        if (a.k === focus) related[b.k] = Number(e[2]) || 0;
        else if (b.k === focus) related[a.k] = Number(e[2]) || 0;
      }
    }

    // edges first, so the nodes sit on top of them
    let maxW = 1;
    for (const e of edges) maxW = Math.max(maxW, Number(e[2]) || 0);
    for (const e of edges) {
      const a = nodes[e[0]];
      const b = nodes[e[1]];
      if (!a || !b) continue;
      const weight = Number(e[2]) || 0;
      const isHot = focus && (a.k === focus || b.k === focus);
      const dim = focus && !isHot;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = 0.7 + 3.3 * (weight / maxW);
      ctx.strokeStyle = isHot ? C.edgeHot : C.edge;
      ctx.globalAlpha = isHot ? 0.95 : (dim ? 0.06 : 0.12 + 0.4 * (weight / maxW));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // nodes
    for (const n of nodes) {
      const isFocus = focus && n.k === focus;
      const isRelated = focus && related[n.k] !== undefined;
      const dim = focus && !isFocus && !isRelated;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = isFocus ? C.accentStrong : C.accent;
      ctx.globalAlpha = isFocus ? 0.95 : (dim ? 0.1 : (isRelated ? 0.6 : 0.32));
      ctx.fill();
      ctx.globalAlpha = dim ? 0.12 : 1;
      ctx.lineWidth = isFocus ? 2 : 1.2;
      ctx.strokeStyle = isFocus ? C.accentStrong : C.accent;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // labels, collision-avoided: an unreadable pile of captions is worse than
    // labels on the most important nodes only
    ctx.font = o.labelFont || "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const measure = (s) => ctx.measureText(s).width;
    // draw the biggest / focused nodes' labels first so they always win
    const order = nodes.slice().sort((a, b) => {
      const rank = (n) => (n.k === focus ? 2 : (related[n.k] !== undefined ? 1 : 0));
      return (rank(b) - rank(a)) || (b.r - a.r);
    });
    const taken = [];
    const hitsBox = (r) => taken.some((t) => !(r.x2 < t.x1 || r.x1 > t.x2 || r.y2 < t.y1 || r.y1 > t.y2));
    // A caption must also clear the circles themselves: text lying across a
    // node fill is unreadable, and a label clipped by the canvas edge looks
    // like a bug ("soft sh...", "al media (at..."). Both are skipped rather
    // than drawn badly - the ranking list next to the graph still names every
    // token, so a missing caption loses nothing.
    const hitsCircle = (r, self) => nodes.some((n) => {
      if (n === self) return false;
      const cx = Math.max(r.x1, Math.min(n.x, r.x2));
      const cy = Math.max(r.y1, Math.min(n.y, r.y2));
      return (cx - n.x) ** 2 + (cy - n.y) ** 2 < n.r * n.r;
    });
    const drawn = [];
    for (const n of order) {
      const isFocus = focus && n.k === focus;
      const isRelated = focus && related[n.k] !== undefined;
      const ok = isFocus || isRelated || n.r >= 11;
      if (!ok) continue;
      const label = fitLabel(n.t, Math.max(40, n.r * 4.4), measure);
      if (!label) continue;
      const lw = measure(label);
      const box = {
        x1: n.x - lw / 2 - 2, x2: n.x + lw / 2 + 2,
        y1: n.y + n.r + 3, y2: n.y + n.r + 16,
      };
      // fully inside the plot, below the node, on no other caption or circle
      if (box.x1 < 2 || box.x2 > w - 2 || box.y2 > h - 2 || box.y1 < 0) continue;
      if (hitsBox(box) || hitsCircle(box, n)) continue;
      taken.push(box);
      drawn.push({ n, label, isFocus, isRelated });
    }
    o.onLabels?.(drawn, { width: w, height: h });
    for (const d of drawn) {
      // a dark halo keeps the caption readable where it crosses an edge
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(21,21,21,0.92)";
      ctx.globalAlpha = 1;
      ctx.strokeText(d.label, d.n.x, d.n.y + d.n.r + 3);
      ctx.fillStyle = d.isFocus ? C.accentStrong : (d.isRelated ? C.text : C.textDim);
      ctx.fillText(d.label, d.n.x, d.n.y + d.n.r + 3);
    }
  } finally {
    ctx.restore();
  }
}

function render(node) {
  const st = stateOf(node);
  if (!st.el || !st.ctx) return;
  const cfg = settings(node);
  const doc = statsFor(node);
  const patterns = parseExclude(cfg.exclude);
  const rows = rankTokens(doc, { patterns, minN: cfg.minCount, limit: cfg.topN });
  const edges = edgesFor(doc, rows);
  const plotW = st.canvas.width;
  const plotH = st.canvas.height;

  const nodes = layout(rows, edges, plotW, plotH, (text, r) => text);
  st.nodes = nodes;
  st.edges = edges;
  st.rows = rows;

  drawGraph(st.ctx, {
    nodes, edges, hoverKey: st.hoverKey, selectedKey: st.pinnedKey,
  }, { width: plotW, height: plotH, plot: C.plot });

  st.model = { nodes, edges, doc, patterns, cfg, rows };
  renderList(node);
  renderExcluded(node);
  updateSummary(node);
  st.dirty = false;
}

function updateSummary(node) {
  const st = stateOf(node);
  if (!st.summaryEl || !st.model) return;
  const { doc, cfg, rows } = st.model;
  const shown = rows.length;
  const total = Object.keys(doc.tokens || {}).length;
  const hiddenN = (() => {
    let n = 0;
    const patterns = st.model.patterns || [];
    for (const key of Object.keys(doc.tokens || {})) {
      if (isExcluded(key, patterns)) n += Number(doc.tokens[key].n) || 0;
    }
    return n;
  })();
  const parts = [
    `${doc.runs || 0} runs`,
    `${shown} of ${total} tokens`,
  ];
  if (hiddenN) parts.push(`${hiddenN} uses hidden as boilerplate`);
  if (st.preview && cfg.text.trim()) parts.push("previewing the text in the box");
  if (st.status) parts.push(st.status);
  st.summaryEl.textContent = parts.join(" · ");
}

function renderList(node) {
  const st = stateOf(node);
  if (!st.listEl || !st.model) return;
  const rows = st.model.rows || [];
  const max = rows.length ? Math.max(...rows.map((r) => r.n)) : 1;
  st.listEl.textContent = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.textContent = "no tokens match the current filters";
    Object.assign(empty.style, { color: C.textDim, fontSize: "12px", padding: "8px 4px" });
    st.listEl.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tg-row";
    item.dataset.key = row.k;
    item.title = `${row.t} - ${row.n} uses in ${row.runs} run(s)`;
    Object.assign(item.style, {
      display: "grid",
      gridTemplateColumns: "1fr auto",
      gap: "4px 8px",
      alignItems: "center",
      width: "100%",
      minHeight: "24px",
      padding: "3px 6px",
      margin: "0",
      background: row.k === st.pinnedKey ? "#31394a" : "transparent",
      color: C.text,
      border: "1px solid transparent",
      borderRadius: "5px",
      cursor: "pointer",
      font: "12px sans-serif",
      textAlign: "left",
    });
    const name = document.createElement("span");
    name.textContent = row.t;
    Object.assign(name.style, {
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    });
    const count = document.createElement("span");
    count.textContent = String(row.n);
    Object.assign(count.style, { color: C.warn, fontVariantNumeric: "tabular-nums" });

    const track = document.createElement("div");
    Object.assign(track.style, {
      gridColumn: "1 / span 2", height: "3px", background: C.track,
      borderRadius: "2px", overflow: "hidden",
    });
    const fill = document.createElement("div");
    Object.assign(fill.style, {
      width: `${Math.max(2, Math.round((row.n / max) * 100))}%`,
      height: "100%", background: C.bar,
    });
    track.appendChild(fill);

    item.appendChild(name);
    item.appendChild(count);
    item.appendChild(track);
    item.addEventListener("pointerenter", () => setHover(node, row.k, true));
    item.addEventListener("pointerleave", () => setHover(node, null, true));
    item.addEventListener("focus", () => setHover(node, row.k, true));
    item.addEventListener("blur", () => setHover(node, null, true));
    item.addEventListener("click", () => {
      st.pinnedKey = st.pinnedKey === row.k ? null : row.k;
      st.dirty = true;
      scheduleDraw(node);
    });
    frag.appendChild(item);
  }
  st.listEl.appendChild(frag);
}

function renderExcluded(node) {
  const st = stateOf(node);
  if (!st.excludedEl || !st.model) return;
  const doc = st.model.doc;
  const patterns = st.model.patterns || [];
  const hidden = [];
  for (const key of Object.keys(doc.tokens || {})) {
    if (!isExcluded(key, patterns)) continue;
    hidden.push({ k: key, t: doc.tokens[key].display || key, n: doc.tokens[key].n });
  }
  hidden.sort((a, b) => b.n - a.n);
  st.excludedEl.textContent = "";
  if (!hidden.length) {
    const none = document.createElement("span");
    none.textContent = "nothing hidden";
    Object.assign(none.style, { color: C.textDim, fontSize: "12px" });
    st.excludedEl.appendChild(none);
    return;
  }
  const head = document.createElement("span");
  head.textContent = `hidden as boilerplate (${hidden.length}):`;
  Object.assign(head.style, { color: C.textDim, fontSize: "11px", marginRight: "6px" });
  st.excludedEl.appendChild(head);
  for (const row of hidden.slice(0, 24)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.textContent = `${row.t} ×${row.n}`;
    chip.title = `Counts ${row.n} uses but is hidden by the exclude list. Click to match what hides it.`;
    Object.assign(chip.style, {
      minHeight: "24px", margin: "2px 4px 2px 0", padding: "2px 8px",
      background: "#2f2740", color: C.hidden, border: "1px solid #4b3f66",
      borderRadius: "12px", cursor: "pointer", font: "11px sans-serif",
    });
    chip.addEventListener("click", () => revealPattern(node, row.k));
    st.excludedEl.appendChild(chip);
  }
}

// Highlight the exclude-list entry responsible for hiding a token.
function revealPattern(node, key) {
  const st = stateOf(node);
  if (!st.excludeInput) return;
  const patterns = parseExclude(st.excludeInput.value);
  let hit = null;
  for (const pat of patterns) {
    if (pat === key) { hit = pat; break; }
    if ((pat.indexOf("*") >= 0 || pat.indexOf("?") >= 0) && isExcluded(key, [pat])) { hit = pat; break; }
  }
  if (!hit) return;
  const lines = st.excludeInput.value.split("\n");
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === hit) {
      st.excludeInput.focus();
      try {
        st.excludeInput.setSelectionRange(pos, pos + lines[i].length);
      } catch (e) {}
      return;
    }
    pos += lines[i].length + 1;
  }
}

// --- hover / tooltip ------------------------------------------------------

function setHover(node, key, immediate) {
  const st = stateOf(node);
  if (!st.el) return;
  if (st.hoverTimer) {
    clearTimeout(st.hoverTimer);
    st.hoverTimer = null;
  }
  const apply = () => {
    if (st.hoverKey === key) return;
    st.hoverKey = key;
    // The relations readout is a DOM tooltip anchored to the token, so it
    // never depends on canvas text rendering and stays selectable.
    if (key) {
      const n = (st.nodes || []).find((x) => x.k === key);
      showTooltip(node, key, n);
    } else {
      hideTooltip(node);
    }
    st.dirty = true;
    scheduleDraw(node);
  };
  if (key && !immediate) st.hoverTimer = setTimeout(apply, HOVER_DELAY);
  else apply();
}

function showTooltip(node, key, graphNode) {
  const st = stateOf(node);
  if (!st.tipEl || !st.model) return;
  const doc = st.model.doc;
  const rec = doc.tokens[key];
  if (!rec) return;
  const window_ = doc.window || 3;
  const rel = relationsOf(doc, key, (k) => {
    const t = doc.tokens[k];
    return t ? (t.display || k) : k;
  }, 10);

  st.tipEl.textContent = "";
  const title = document.createElement("div");
  title.textContent = rec.display || key;
  Object.assign(title.style, { font: "600 13px sans-serif", color: C.text, marginBottom: "2px" });

  const meta = document.createElement("div");
  meta.textContent = `${rec.n} uses · in ${rec.runs} run(s)` +
    (rec.last ? ` · last seen on run ${rec.last}` : "");
  Object.assign(meta.style, { font: "11px sans-serif", color: C.textDim, marginBottom: "6px" });

  const head = document.createElement("div");
  head.textContent = rel.length
    ? `used together with (within ${window_} tokens):`
    : "no related tokens seen yet";
  Object.assign(head.style, { font: "11px sans-serif", color: C.textDim, marginBottom: "3px" });

  st.tipEl.appendChild(title);
  st.tipEl.appendChild(meta);
  st.tipEl.appendChild(head);

  const maxW = rel.length ? rel[0].w : 1;
  for (const r of rel) {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "1fr auto", gap: "0 8px",
      alignItems: "center", font: "11px sans-serif", marginBottom: "2px",
    });
    const name = document.createElement("span");
    name.textContent = r.t;
    Object.assign(name.style, {
      color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    });
    const weight = document.createElement("span");
    weight.textContent = String(r.w);
    Object.assign(weight.style, { color: C.accentStrong, fontVariantNumeric: "tabular-nums" });
    const track = document.createElement("div");
    Object.assign(track.style, {
      gridColumn: "1 / span 2", height: "2px", background: C.track, borderRadius: "1px",
    });
    const fill = document.createElement("div");
    Object.assign(fill.style, {
      width: `${Math.max(3, Math.round((r.w / maxW) * 100))}%`, height: "100%",
      background: C.edgeHot,
    });
    track.appendChild(fill);
    row.appendChild(name);
    row.appendChild(weight);
    row.appendChild(track);
    st.tipEl.appendChild(row);
  }

  const ignore = document.createElement("button");
  ignore.type = "button";
  ignore.textContent = "hide this token";
  ignore.title = "Add it to the exclude list so it stops appearing in the ranking";
  Object.assign(ignore.style, {
    marginTop: "6px", minHeight: "24px", padding: "3px 10px",
    background: "#2c2c2c", color: C.text, border: "1px solid #444",
    borderRadius: "6px", cursor: "pointer", font: "11px sans-serif",
  });
  ignore.addEventListener("click", (e) => {
    e.stopPropagation();
    addExclude(node, key);
  });
  st.tipEl.appendChild(ignore);

  st.tipEl.style.display = "block";
  positionTooltip(node, graphNode);
}

function positionTooltip(node, graphNode) {
  const st = stateOf(node);
  if (!st.tipEl || !st.canvas) return;
  const cbox = st.canvas.getBoundingClientRect();
  const tbox = st.tipEl.getBoundingClientRect();
  let x = cbox.left + 12;
  let y = cbox.top + 12;
  if (graphNode) {
    x = cbox.left + graphNode.x + graphNode.r + 8;
    y = cbox.top + graphNode.y - 10;
  }
  const maxX = window.innerWidth - tbox.width - 8;
  const maxY = window.innerHeight - tbox.height - 8;
  x = Math.max(8, Math.min(maxX, x));
  y = Math.max(8, Math.min(maxY, y));
  st.tipEl.style.left = `${Math.round(x)}px`;
  st.tipEl.style.top = `${Math.round(y)}px`;
}

function hideTooltip(node) {
  const st = stateOf(node);
  if (st.tipEl) st.tipEl.style.display = "none";
}

function addExclude(node, key) {
  const st = stateOf(node);
  const rec = st.model && st.model.doc.tokens[key];
  const name = (rec && rec.display) || key;
  const current = String(widgetValue(node, "exclude", "") || "");
  if (isExcluded(key, parseExclude(current))) return;
  const next = current.trim() ? `${current.replace(/\s+$/, "")}\n${name}` : name;
  setWidgetValue(node, "exclude", next);
  if (st.excludeInput) st.excludeInput.value = next;
  persistExclude(node, next);
  st.hoverKey = null;
  hideTooltip(node);
  st.dirty = true;
  scheduleDraw(node);
}

// The exclude list has to reach the statistics file too: the panel renders
// from it before the next run, and a ranking that disagrees with what the node
// would produce is worse than no ranking.
async function persistExclude(node, text) {
  const cfg = settings(node);
  if (!cfg.file) return;
  try {
    const doc = statsFor(node);
    const payload = statsToJSON(doc);
    payload.exclude = parseExclude(text);
    await fetch(STATS_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: cfg.file, stats: payload }),
    });
  } catch (e) {
    // best effort: the node input still carries the list, so the next run
    // applies it even when the file could not be updated now
  }
}

// --- panel construction ---------------------------------------------------

function mkButton(label, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (title) b.title = title;
  if (onClick) b.addEventListener("click", onClick);
  Object.assign(b.style, {
    minHeight: "26px", minWidth: "26px", padding: "4px 10px",
    background: "#2c2c2c", color: C.text, border: "1px solid #444",
    borderRadius: "6px", cursor: "pointer", font: "12px sans-serif",
  });
  return b;
}

function buildPanel(node) {
  const st = stateOf(node);
  const geo = nodeGeometry(node);
  const cfg = settings(node);

  const el = document.createElement("div");
  el.className = "tg-panel";
  Object.assign(el.style, {
    position: "fixed",
    zIndex: "2147483002",
    width: `${geo.w}px`,
    height: `${geo.h}px`,
    display: "flex",
    flexDirection: "column",
    background: C.bg,
    color: C.text,
    border: "1px solid #454545",
    borderRadius: "10px",
    boxShadow: "0 14px 44px rgba(0,0,0,0.62)",
    font: "12px sans-serif",
    overflow: "hidden",
    resize: "both",
    minWidth: `${MIN_W}px`,
    minHeight: `${MIN_H}px`,
  });
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Token use graph");

  // header (also the drag handle)
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex", alignItems: "center", gap: "8px",
    padding: "8px 10px", borderBottom: "1px solid #383838",
    background: "#202020", flex: "0 0 auto", cursor: "move",
  });
  const title = document.createElement("div");
  title.textContent = "Token use graph";
  Object.assign(title.style, { fontWeight: "600", fontSize: "13px", marginRight: "auto" });

  const summary = document.createElement("div");
  Object.assign(summary.style, {
    color: C.textDim, fontSize: "11px", flex: "1 1 auto",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    textAlign: "right", marginRight: "6px",
  });

  const previewBtn = mkButton("live", "Include the text currently in the node's box in the ranking", () => {
    st.preview = !st.preview;
    previewBtn.style.background = st.preview ? "#2f4536" : "#2c2c2c";
    previewBtn.setAttribute("aria-pressed", st.preview ? "true" : "false");
    st.dirty = true;
    scheduleDraw(node);
  });
  previewBtn.setAttribute("aria-pressed", st.preview ? "true" : "false");
  previewBtn.style.background = st.preview ? "#2f4536" : "#2c2c2c";

  const dockSel = document.createElement("select");
  for (const value of ["floating", "top", "bottom", "left", "right"]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    dockSel.appendChild(opt);
  }
  dockSel.value = geo.dock || "floating";
  dockSel.title = "Where the panel sits: a movable window, or docked to a window edge";
  Object.assign(dockSel.style, {
    minHeight: "26px", background: "#2c2c2c", color: C.text,
    border: "1px solid #444", borderRadius: "6px", font: "12px sans-serif",
  });
  dockSel.addEventListener("change", () => {
    const g = nodeGeometry(node);
    g.dock = dockSel.value;
    g.floating = dockSel.value === "floating";
    saveGeometry(node, g);
    applyDock(node);
  });

  const excludeBtn = mkButton("exclusions", "Edit which tokens stay out of the ranking", () => {
    const shown = drawer.style.display !== "none";
    drawer.style.display = shown ? "none" : "block";
    excludeBtn.setAttribute("aria-expanded", shown ? "false" : "true");
    if (!shown) {
      excludeInput.value = String(widgetValue(node, "exclude", "") || "");
      scheduleDraw(node);
    }
  });
  excludeBtn.setAttribute("aria-expanded", "false");

  const reloadBtn = mkButton("reload", "Re-read the accumulated history from the server", () => {
    st.loaded = false;
    loadStats(node);
  });

  const closeBtn = mkButton("close", "Close the panel (Esc)", () => closePanel(node));

  header.appendChild(title);
  header.appendChild(summary);
  header.appendChild(previewBtn);
  header.appendChild(dockSel);
  header.appendChild(excludeBtn);
  header.appendChild(reloadBtn);
  header.appendChild(closeBtn);

  // body: graph + ranked list
  const body = document.createElement("div");
  Object.assign(body.style, {
    display: "flex", flex: "1 1 auto", minHeight: "0",
  });

  const plotWrap = document.createElement("div");
  Object.assign(plotWrap.style, {
    position: "relative", flex: "1 1 auto", minWidth: "0", background: C.plot,
  });
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, {
    display: "block", width: "100%", height: "100%",
  });
  canvas.setAttribute("aria-label", "Graph of token use and co-occurrence");
  plotWrap.appendChild(canvas);

  const side = document.createElement("div");
  Object.assign(side.style, {
    width: `${LIST_W}px`, flex: "0 0 auto", borderLeft: "1px solid #383838",
    background: C.panel, display: "flex", flexDirection: "column", minHeight: "0",
  });
  const sideHead = document.createElement("div");
  sideHead.textContent = "most used tokens";
  Object.assign(sideHead.style, {
    padding: "6px 10px", color: C.textDim, fontSize: "11px",
    textTransform: "uppercase", letterSpacing: "0.4px",
    borderBottom: "1px solid #383838", flex: "0 0 auto",
  });
  const listEl = document.createElement("div");
  Object.assign(listEl.style, {
    overflowY: "auto", padding: "4px 6px", flex: "1 1 auto", minHeight: "0",
  });
  side.appendChild(sideHead);
  side.appendChild(listEl);

  // exclusions drawer
  const drawer = document.createElement("div");
  Object.assign(drawer.style, {
    display: "none", flex: "0 0 auto", borderTop: "1px solid #383838",
    background: "#202020", padding: "8px 10px",
  });
  const drawerHint = document.createElement("div");
  drawerHint.textContent = "One pattern per line. Quality boilerplate goes here because it is in every prompt. " +
    "* and ? are wildcards (e.g. \"year *\"). Applies on the next run and immediately to this panel.";
  Object.assign(drawerHint.style, { color: C.textDim, fontSize: "11px", marginBottom: "6px" });
  const excludeInput = document.createElement("textarea");
  excludeInput.value = String(widgetValue(node, "exclude", "") || "");
  excludeInput.rows = 4;
  excludeInput.spellcheck = false;
  excludeInput.setAttribute("aria-label", "Tokens to exclude from the ranking");
  Object.assign(excludeInput.style, {
    width: "100%", boxSizing: "border-box", background: "#171717", color: C.text,
    border: "1px solid #3d3d3d", borderRadius: "6px", padding: "6px",
    font: "12px monospace", resize: "vertical", minHeight: "64px",
  });
  const drawerRow = document.createElement("div");
  Object.assign(drawerRow.style, {
    display: "flex", gap: "8px", alignItems: "center", marginTop: "6px", flexWrap: "wrap",
  });
  const applyBtn = mkButton("apply", "Use this list in the node and in the panel", () => {
    const text = excludeInput.value;
    setWidgetValue(node, "exclude", text);
    persistExclude(node, text);
    st.dirty = true;
    scheduleDraw(node);
  });
  const resetBtn = mkButton("reset to defaults", "Restore the default quality-boilerplate list", () => {
    excludeInput.value = DEFAULT_EXCLUDE_TEXT;
    setWidgetValue(node, "exclude", DEFAULT_EXCLUDE_TEXT);
    persistExclude(node, DEFAULT_EXCLUDE_TEXT);
    st.dirty = true;
    scheduleDraw(node);
  });
  const excludedEl = document.createElement("div");
  Object.assign(excludedEl.style, { marginTop: "8px", display: "flex", flexWrap: "wrap", alignItems: "center" });
  drawerRow.appendChild(applyBtn);
  drawerRow.appendChild(resetBtn);
  drawer.appendChild(drawerHint);
  drawer.appendChild(excludeInput);
  drawer.appendChild(drawerRow);
  drawer.appendChild(excludedEl);

  body.appendChild(plotWrap);
  body.appendChild(side);
  el.appendChild(header);
  el.appendChild(body);
  el.appendChild(drawer);

  // tooltip (outside the panel so it can never be clipped by it)
  const tipEl = document.createElement("div");
  Object.assign(tipEl.style, {
    position: "fixed", zIndex: "2147483003", display: "none", pointerEvents: "auto",
    background: "#161616", color: C.text, border: "1px solid #454545",
    borderRadius: "8px", padding: "8px 10px", width: "230px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.6)", font: "11px sans-serif",
  });
  document.body.appendChild(tipEl);

  st.el = el;
  st.canvas = canvas;
  st.ctx = canvas.getContext("2d");
  st.listEl = listEl;
  st.tipEl = tipEl;
  st.drawer = drawer;
  st.excludeInput = excludeInput;
  st.excludedEl = excludedEl;
  st.summaryEl = summary;
  document.body.appendChild(el);

  makeDraggable(node, header, el);
  installCanvasEvents(node, canvas);
  installResize(node, el, canvas);
  applyDock(node);

  // Esc closes; the listener is removed in closePanel
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePanel(node);
    }
  };
  document.addEventListener("keydown", onKey, true);
  st.disposers.push(() => document.removeEventListener("keydown", onKey, true));

  // focus the panel so its own controls are reachable by keyboard
  try {
    el.tabIndex = -1;
    el.focus();
  } catch (e) {}

  st.loaded = false;
  loadStats(node);
  sizeCanvas(node);
  return el;
}

function installResize(node, el, canvas) {
  const st = stateOf(node);
  const resize = () => {
    sizeCanvas(node);
    const g = nodeGeometry(node);
    g.w = Math.max(MIN_W, Math.round(el.getBoundingClientRect().width));
    g.h = Math.max(MIN_H, Math.round(el.getBoundingClientRect().height));
    saveGeometry(node, g);
    st.dirty = true;
    scheduleDraw(node);
  };
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    st.disposers.push(() => ro.disconnect());
  } else {
    // older embedded webviews: fall back to a periodic size check
    let last = "";
    const timer = setInterval(() => {
      const box = el.getBoundingClientRect();
      const key = `${Math.round(box.width)}x${Math.round(box.height)}`;
      if (key !== last) {
        last = key;
        resize();
      }
    }, 300);
    st.disposers.push(() => clearInterval(timer));
  }
}

function sizeCanvas(node) {
  const st = stateOf(node);
  if (!st.canvas) return;
  const box = st.canvas.getBoundingClientRect();
  const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
  // The backing store is scaled by the device pixel ratio so the graph is
  // crisp on a HiDPI display; hit testing works in CSS pixels, so both are
  // tracked and converted in one place.
  const w = Math.max(1, Math.round((box.width || st.canvas.clientWidth || 300) * dpr));
  const h = Math.max(1, Math.round((box.height || st.canvas.clientHeight || 200) * dpr));
  if (st.canvas.width !== w || st.canvas.height !== h) {
    st.canvas.width = w;
    st.canvas.height = h;
  }
  st.dpr = dpr;
  st.cssW = w / dpr;
  st.cssH = h / dpr;
}

function installCanvasEvents(node, canvas) {
  const st = stateOf(node);
  const toGraph = (e) => {
    const box = canvas.getBoundingClientRect();
    const dpr = st.dpr || 1;
    return {
      x: (e.clientX - box.left) * dpr,
      y: (e.clientY - box.top) * dpr,
    };
  };
  const onMove = (e) => {
    const p = toGraph(e);
    const hit = hitTest(st.nodes || [], p.x, p.y);
    setHover(node, hit ? hit.k : null, false);
    canvas.style.cursor = hit ? "pointer" : "default";
  };
  const onLeave = () => setHover(node, null, true);
  const onClick = (e) => {
    const p = toGraph(e);
    const hit = hitTest(st.nodes || [], p.x, p.y);
    if (!hit) {
      st.pinnedKey = null;
    } else {
      st.pinnedKey = st.pinnedKey === hit.k ? null : hit.k;
      setHover(node, hit.k, true);
    }
    st.dirty = true;
    scheduleDraw(node);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);
  st.disposers.push(() => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("click", onClick);
  });
}

function makeDraggable(node, handle, el) {
  const st = stateOf(node);
  let drag = null;
  const onDown = (e) => {
    // only the header drags, and never a header button
    if (e.target && e.target.closest && e.target.closest("button,select,input,textarea")) return;
    const box = el.getBoundingClientRect();
    drag = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    el.style.right = "auto";
    el.style.bottom = "auto";
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!drag) return;
    const g = nodeGeometry(node);
    const w = el.getBoundingClientRect().width;
    const h = el.getBoundingClientRect().height;
    const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - drag.dy));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    g.x = Math.round(x);
    g.y = Math.round(y);
    g.dock = "floating";
    g.floating = true;
    saveGeometry(node, g);
    void w;
    void h;
  };
  const onUp = () => {
    drag = null;
  };
  handle.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  st.disposers.push(() => {
    handle.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  });
}

function applyDock(node) {
  const st = stateOf(node);
  if (!st.el) return;
  const geo = nodeGeometry(node);
  const el = st.el;
  const dock = geo.dock || "floating";
  el.style.left = "auto";
  el.style.top = "auto";
  el.style.right = "auto";
  el.style.bottom = "auto";
  if (dock === "floating") {
    const x = geo.x == null ? Math.max(12, window.innerWidth - geo.w - 24) : geo.x;
    const y = geo.y == null ? Math.max(12, Math.round((window.innerHeight - geo.h) / 2) - 60) : geo.y;
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  } else if (dock === "top") {
    el.style.top = "0px";
    el.style.left = "0px";
    el.style.width = "100vw";
  } else if (dock === "bottom") {
    el.style.bottom = "0px";
    el.style.left = "0px";
    el.style.width = "100vw";
  } else if (dock === "left") {
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.height = "100vh";
  } else if (dock === "right") {
    el.style.right = "0px";
    el.style.top = "0px";
    el.style.height = "100vh";
  }
  sizeCanvas(node);
  st.dirty = true;
  scheduleDraw(node);
}

// --- public API -----------------------------------------------------------

// The default exclusion list lives in tg_tokens.js next to the rest of the
// tokenizer mirror, so it sits beside its Python counterpart instead of being a
// second, independently drifting copy. tests/test_token_parity.py asserts the
// two are identical.

function isPanelOpen(node) {
  const st = panels.get(node);
  return !!(st && st.el);
}

function openPanel(node) {
  if (!node || node.type !== NODE_CLASS) return null;
  const st = stateOf(node);
  if (st.el) {
    st.el.style.display = "flex";
    applyDock(node);
    return st.el;
  }
  return buildPanel(node);
}

function closePanel(node) {
  const st = panels.get(node);
  if (!st || !st.el) return;
  for (const dispose of st.disposers) {
    try {
      dispose();
    } catch (e) {}
  }
  st.disposers = [];
  if (st.hoverTimer) clearTimeout(st.hoverTimer);
  st.hoverTimer = null;
  if (st.rafTimer) clearTimeout(st.rafTimer);
  st.rafTimer = null;
  st.raf = null;
  st.rendered = false;
  if (st.el.parentNode) st.el.parentNode.removeChild(st.el);
  if (st.tipEl && st.tipEl.parentNode) st.tipEl.parentNode.removeChild(st.tipEl);
  st.el = null;
  st.canvas = null;
  st.ctx = null;
  st.listEl = null;
  st.tipEl = null;
  st.excludedEl = null;
  st.summaryEl = null;
  st.excludeInput = null;
  st.nodes = [];
}

function togglePanel(node) {
  if (isPanelOpen(node)) {
    closePanel(node);
    return false;
  }
  openPanel(node);
  return true;
}

export {
  NODE_CLASS, STATS_ROUTE, C, HOVER_DELAY, DEFAULT_EXCLUDE_TEXT,
  openPanel, closePanel, togglePanel, isPanelOpen, acceptPayload,
  drawGraph, stateOf, settings, statsFor, loadStats, setHover,
  nodeGeometry, saveGeometry, applyDock,
};
