// EasyStringTokenGraph — graph layout and hit testing.
//
// Pure geometry: no DOM, no canvas, no app. The panel owns the drawing, this
// module owns "where is each token and what did the pointer touch", which is
// the part that is worth testing on its own.
//
// The layout is a small force-directed simulation:
//
//   * repulsion between every pair        - keeps tokens from stacking up
//   * spring along each co-occurrence edge - pulls related tokens together, so
//     a cluster on screen means "these appear together in your prompts"
//   * a weak pull to the centre            - keeps disconnected tokens on screen
//
// Frequency maps to RADIUS, so a token used often is a big node; edge weight
// maps to line width and alpha. The simulation is deterministic for a given
// payload (a seeded start position, fixed iteration count), because a layout
// that reshuffles between two identical renders would move the node under the
// user's pointer between the draw and the click.

import { ELLIPSIS } from "./tg_tokens.js";

const MIN_R = 7;
const MAX_R = 26;
const PAD = 10;
const LABEL_GAP = 3;

// Golden-angle placement: spreading the start positions by 137.5 degrees
// avoids the symmetric start that makes a force layout settle into a line.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function hash32(text) {
  let h = 2166136261;
  const s = String(text == null ? "" : text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

// Radius from a token's occurrence count. sqrt keeps AREA proportional to the
// count (a linear radius would make a 4x token look 4x heavier by area, which
// overstates it), and the min/max clamp keeps the smallest token clickable and
// the largest one from swallowing the canvas.
function radiusFor(n, maxN) {
  const top = Math.max(1, Number(maxN) || 1);
  const count = Math.max(0, Number(n) || 0);
  const t = top > 1 ? Math.sqrt(count / top) : 1;
  return MIN_R + (MAX_R - MIN_R) * Math.max(0, Math.min(1, t));
}

function clampToBox(x, y, r, w, h) {
  return {
    x: Math.max(r + PAD, Math.min(w - r - PAD, x)),
    y: Math.max(r + PAD, Math.min(h - r - PAD, y)),
  };
}

// Build the render model: [{k, t, n, runs, r, x, y, vx, vy, label}].
function buildNodes(tokens, width, height) {
  const w = Math.max(40, Number(width) || 0);
  const h = Math.max(40, Number(height) || 0);
  const list = Array.isArray(tokens) ? tokens : [];
  let maxN = 1;
  for (const t of list) maxN = Math.max(maxN, Number(t && t.n) || 0);
  const cx = w / 2;
  const cy = h / 2;
  const span = Math.min(w, h) * 0.34;
  const nodes = [];

  // The starting angle comes from the token's RANK IN KEY ORDER, not from its
  // index in the array. The ranking is rebuilt on every keystroke, so an
  // index-based angle would make every node jump the moment one token changes
  // count - the token under the pointer would move away mid-hover. Key order is
  // stable, so a re-ranked list keeps every node where it was.
  const keyOf = (t, i) => String(t && t.k != null ? t.k : i);
  const slots = new Array(list.length);
  list
    .map((t, i) => [keyOf(t, i), i])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]))
    .forEach((pair, rank) => { slots[pair[1]] = rank; });

  list.forEach((t, i) => {
    const seed = hash32(keyOf(t, i));
    const ang = slots[i] * GOLDEN;
    const rad = span * (0.35 + 0.65 * ((seed % 1000) / 1000));
    const r = radiusFor(t && t.n, maxN);
    nodes.push({
      k: keyOf(t, i),
      t: (t && t.t) || (t && t.k) || String(i),
      n: Number((t && t.n) || 0),
      runs: Number((t && t.runs) || 0),
      r,
      x: cx + Math.cos(ang) * rad,
      y: cy + Math.sin(ang) * rad,
      vx: 0,
      vy: 0,
    });
  });
  return nodes;
}

// Run the simulation in place. Iterations scale with node count but stay
// bounded, so a 200-token panel still lays out in a few milliseconds.
function relax(nodes, edges, width, height, iterations) {
  const w = Math.max(40, Number(width) || 0);
  const h = Math.max(40, Number(height) || 0);
  const n = nodes.length;
  if (!n) return nodes;
  const steps = Math.max(1, Math.floor(iterations == null ? Math.min(320, 40 + n * 12) : iterations));
  const cx = w / 2;
  const cy = h / 2;
  const links = (Array.isArray(edges) ? edges : [])
    .map((e) => ({ a: e[0], b: e[1], w: Math.max(0, Number(e[2]) || 0) }))
    .filter((e) => nodes[e.a] && nodes[e.b] && e.a !== e.b);
  let maxW = 1;
  for (const e of links) maxW = Math.max(maxW, e.w);

  // Cool down over the run: large early moves untangle the graph, small late
  // ones let it settle instead of oscillating forever.
  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps;

    // repulsion — O(n^2), acceptable for the bounded token count
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          // exactly overlapping: nudge deterministically, not randomly
          dx = ((hash32(a.k + b.k) % 100) / 100 - 0.5) || 0.5;
          dy = ((hash32(b.k + a.k) % 100) / 100 - 0.5) || 0.5;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const minGap = a.r + b.r + 14;
        const force = (minGap * minGap) / (d2 + 1) * 0.45 * cool;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // springs — stronger edges pull harder, so co-occurring tokens cluster.
    //
    // The rest length of a STRONG edge must be shorter than the repulsion gap
    // between unrelated nodes (a.r + b.r + 14 above), otherwise "linked tokens
    // sit closer together" is false and the picture says nothing: with the old
    // constants a strong pair settled at r_a + r_b + 26 while a stranger was
    // only pushed out to r_a + r_b + 14, i.e. linked tokens ended up FARTHER
    // apart than unrelated ones. 4 keeps a strong pair inside the gap, and the
    // 44px spread still pushes a weak pair well outside it.
    for (const e of links) {
      const a = nodes[e.a];
      const b = nodes[e.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const rest = a.r + b.r + 4 + 44 * (1 - e.w / maxW);
      const k = 0.035 * (0.35 + 0.65 * (e.w / maxW)) * cool;
      const f = (d - rest) * k;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // centring + integration
    for (const node of nodes) {
      node.vx += (cx - node.x) * 0.002 * cool;
      node.vy += (cy - node.y) * 0.002 * cool;
      node.vx *= 0.82;
      node.vy *= 0.82;
      node.x += node.vx;
      node.y += node.vy;
      const p = clampToBox(node.x, node.y, node.r, w, h);
      node.x = p.x;
      node.y = p.y;
    }
  }
  return nodes;
}

// The layout the panel draws: nodes placed, radii set, labels clamped.
function layout(tokens, edges, width, height, labelFn) {
  const nodes = buildNodes(tokens, width, height);
  relax(nodes, edges, width, height);
  for (const node of nodes) {
    node.label = labelFn ? labelFn(node.t, node.r) : node.t;
  }
  return nodes;
}

function hitTest(nodes, x, y) {
  // topmost (drawn last) first, and a slightly generous radius so a small
  // token stays clickable at normal zoom
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const dx = x - node.x;
    const dy = y - node.y;
    const reach = node.r + 3;
    if (dx * dx + dy * dy <= reach * reach) return node;
  }
  return null;
}

// Fit a label to a maximum width by measuring it. The panel passes a real
// ctx.measureText; a caller without one falls back to an estimate, so the
// geometry stays usable in a test that has no canvas.
function fitLabel(text, maxPx, measure) {
  const s = String(text == null ? "" : text);
  const max = Math.max(8, Number(maxPx) || 0);
  if (typeof measure === "function") {
    try {
      if (measure(s) <= max) return s;
      let lo = 0;
      let hi = s.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measure(s.slice(0, mid) + ELLIPSIS) <= max) lo = mid;
        else hi = mid - 1;
      }
      return lo > 0 ? s.slice(0, lo) + ELLIPSIS : "";
    } catch (e) {
      // fall through to the estimate below
    }
  }
  const per = 6.2; // ~1 char of 10px sans
  const room = Math.max(1, Math.floor(max / per));
  return s.length <= room ? s : s.slice(0, Math.max(1, room - 1)) + ELLIPSIS;
}

// A bounding box of the drawn graph, so the panel can report "N tokens" and
// decide whether the layout is worth re-running.
function bounds(nodes) {
  if (!nodes || !nodes.length) return { x1: 0, y1: 0, x2: 0, y2: 0, w: 0, h: 0 };
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const node of nodes) {
    x1 = Math.min(x1, node.x - node.r);
    y1 = Math.min(y1, node.y - node.r);
    x2 = Math.max(x2, node.x + node.r);
    y2 = Math.max(y2, node.y + node.r);
  }
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

export {
  MIN_R, MAX_R, PAD, LABEL_GAP,
  radiusFor, buildNodes, relax, layout, hitTest, fitLabel, bounds,
};
