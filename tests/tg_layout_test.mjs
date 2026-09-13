// Layout tests for the token graph (web/tg_layout.js).
//
// The graph is drawn from simulated positions, so the properties that make it
// readable have to hold by construction, not by luck:
//
//   * determinism - the same tokens must land in the same place every redraw.
//     A layout that reshuffles on every frame is unusable: the token under the
//     pointer moves away before the user can read it.
//   * inside the canvas - a node outside the plot is invisible.
//   * no dependency on input order - the same set of tokens must produce the
//     same picture (positions come from the token text, not from the array
//     index), or a re-ranked list would jump around.
//   * radius monotonic in count - "bigger dot = used more often" only works
//     if it is actually monotonic.
//   * hit testing - topmost first, and a miss just outside every node is a miss.
//
// Run:  node tests/tg_layout_test.mjs
// Exit: 0 pass, 1 fail.

import { layout, hitTest, radiusFor, fitLabel, bounds, buildNodes, relax, MIN_R, MAX_R } from "../web/tg_layout.js";

let total = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  total += 1;
  try {
    fn();
  } catch (e) {
    failed += 1;
    failures.push(`${name}: ${e && e.message ? e.message : e}`);
    console.error(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function tokens(spec) {
  // spec: [["key","display",n], ...]
  return spec.map(([k, t, n]) => ({ k, t, n, runs: 1 }));
}

function edgesOf(rows, pairs) {
  const index = Object.create(null);
  rows.forEach((r, i) => { index[r.k] = i; });
  return pairs
    .map(([a, b, w]) => [index[a], index[b], w])
    .filter((e) => e[0] !== undefined && e[1] !== undefined && e[0] !== e[1]);
}

const ROWS = tokens([
  ["cinematic", "cinematic", 9],
  ["raccoon", "raccoon", 7],
  ["dramatic lighting", "dramatic lighting", 6],
  ["vignette", "vignette", 4],
  ["stippling", "stippling", 3],
  ["cel shading", "cel shading", 2],
  ["soft shading", "soft shading", 1],
]);
const EDGES = edgesOf(ROWS, [
  ["cinematic", "raccoon", 5],
  ["cinematic", "dramatic lighting", 4],
  ["raccoon", "stippling", 2],
  ["vignette", "cel shading", 1],
]);

const W = 520;
const H = 380;

// ---------------------------------------------------------------- radius

check("radius grows with the count", () => {
  const a = radiusFor(1, 100);
  const b = radiusFor(50, 100);
  const c = radiusFor(100, 100);
  assert(a < b && b < c, `expected ${a} < ${b} < ${c}`);
});

check("radius is clamped to the drawable range", () => {
  assert(radiusFor(0, 1) >= MIN_R, "zero count below MIN_R");
  assert(radiusFor(1, 1) <= MAX_R + 1e-9, "max count above MAX_R");
  assert(radiusFor(10000, 10000) <= MAX_R + 1e-9, "overflow above MAX_R");
  assert(radiusFor(5, 0) >= MIN_R, "maxN=0 must not divide by zero");
});

// ---------------------------------------------------------------- layout

check("layout is deterministic", () => {
  const a = layout(ROWS, EDGES, W, H, (t) => t);
  const b = layout(ROWS, EDGES, W, H, (t) => t);
  assert(a.length === b.length, "different node counts");
  for (let i = 0; i < a.length; i++) {
    assert(a[i].k === b[i].k, `node ${i} key differs`);
    assert(Math.abs(a[i].x - b[i].x) < 1e-9 && Math.abs(a[i].y - b[i].y) < 1e-9,
      `node ${a[i].k} moved between identical layouts`);
  }
});

check("positions do not depend on the order of the input rows", () => {
  const shuffled = ROWS.slice().reverse();
  const index = Object.create(null);
  shuffled.forEach((r, i) => { index[r.k] = i; });
  const shuffledEdges = EDGES.map(([i, j, w]) => [index[ROWS[i].k], index[ROWS[j].k], w]);
  const a = layout(ROWS, EDGES, W, H, (t) => t);
  const b = layout(shuffled, shuffledEdges, W, H, (t) => t);
  const byKey = Object.create(null);
  b.forEach((n) => { byKey[n.k] = n; });
  for (const n of a) {
    assert(byKey[n.k], `missing ${n.k}`);
    assert(Math.abs(n.x - byKey[n.k].x) < 1e-6 && Math.abs(n.y - byKey[n.k].y) < 1e-6,
      `${n.k} moved when the input order changed`);
  }
});

check("every node stays inside the canvas", () => {
  const nodes = layout(ROWS, EDGES, W, H, (t) => t);
  for (const n of nodes) {
    assert(n.x - n.r >= -0.51, `${n.k} left edge at ${n.x - n.r}`);
    assert(n.y - n.r >= -0.51, `${n.k} top edge at ${n.y - n.r}`);
    assert(n.x + n.r <= W + 0.51, `${n.k} right edge at ${n.x + n.r} (W=${W})`);
    assert(n.y + n.r <= H + 0.51, `${n.k} bottom edge at ${n.y + n.r} (H=${H})`);
  }
});

check("a dense graph still stays inside a small canvas", () => {
  const many = [];
  for (let i = 0; i < 60; i++) many.push([`t${i}`, `token ${i}`, 60 - i]);
  const rows = tokens(many);
  const pairs = [];
  for (let i = 0; i < 60; i++) pairs.push([`t${i}`, `t${(i + 1) % 60}`, 1 + (i % 5)]);
  const nodes = layout(rows, edgesOf(rows, pairs), 320, 240, (t) => t);
  for (const n of nodes) {
    assert(n.x - n.r >= -0.51 && n.y - n.r >= -0.51, `${n.k} outside (top/left)`);
    assert(n.x + n.r <= 320.51 && n.y + n.r <= 240.51, `${n.k} outside (bottom/right)`);
  }
});

check("an empty graph is not an error", () => {
  assert(layout([], [], W, H, (t) => t).length === 0, "expected no nodes");
  assert(layout([], [], 0, 0, (t) => t).length === 0, "expected no nodes on a zero canvas");
});

check("a single node does not explode on a tiny canvas", () => {
  const nodes = layout(ROWS.slice(0, 1), [], 40, 30, (t) => t);
  assert(nodes.length === 1, "expected one node");
});

check("each node has a finite position and a positive radius", () => {
  const nodes = layout(ROWS, EDGES, W, H, (t) => t);
  for (const n of nodes) {
    assert(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.k} has a non-finite position`);
    assert(n.r > 0, `${n.k} has radius ${n.r}`);
    assert(typeof n.k === "string" && n.k.length, `${n.k} lost its key`);
    assert(typeof n.t === "string", `${n.k} lost its display text`);
  }
});

check("connected tokens end up closer than unconnected ones", () => {
  // A minimal case: two tokens joined by a strong edge and one stranger.
  const rows = tokens([["a", "a", 5], ["b", "b", 5], ["z", "z", 5]]);
  const edges = edgesOf(rows, [["a", "b", 10]]);
  const nodes = layout(rows, edges, W, H, (t) => t);
  const at = Object.create(null);
  nodes.forEach((n) => { at[n.k] = n; });
  const dab = Math.hypot(at.a.x - at.b.x, at.a.y - at.b.y);
  const daz = Math.hypot(at.a.x - at.z.x, at.a.y - at.z.y);
  assert(dab < daz, `linked pair ${dab.toFixed(1)} not closer than stranger ${daz.toFixed(1)}`);
});

// ---------------------------------------------------------------- hit test

check("hit testing finds the token under the point", () => {
  const nodes = layout(ROWS, EDGES, W, H, (t) => t);
  for (const n of nodes) {
    const hit = hitTest(nodes, n.x, n.y);
    assert(hit && hit.k === n.k, `centre of ${n.k} returned ${hit ? hit.k : "null"}`);
  }
});

check("hit testing misses empty space", () => {
  const nodes = layout(ROWS, EDGES, W, H, (t) => t);
  // a corner should be empty for this graph; if a node really is there, the
  // test says so rather than failing on a null dereference
  const corner = hitTest(nodes, 2, 2);
  if (corner) {
    const dist = Math.hypot(corner.x - 2, corner.y - 2);
    assert(dist <= corner.r + 3.01,
      `corner hit ${corner.k} at distance ${dist.toFixed(1)} (r=${corner.r})`);
  }
});

check("hit testing prefers the topmost of two overlapping nodes", () => {
  const nodes = [
    { k: "under", t: "under", x: 100, y: 100, r: 20 },
    { k: "over", t: "over", x: 104, y: 100, r: 20 },
  ];
  const hit = hitTest(nodes, 102, 100);
  assert(hit && hit.k === "over", `expected the last-drawn node, got ${hit ? hit.k : "null"}`);
});

check("hit testing on an empty graph returns null", () => {
  assert(hitTest([], 10, 10) === null, "expected null");
  assert(hitTest([{ k: "a", t: "a", x: 50, y: 50, r: 8 }], 200, 200) === null, "expected null");
});

// ---------------------------------------------------------------- labels

check("labels are measured, not counted", () => {
  const wide = (s) => String(s).length * 10;
  const out = fitLabel("dramatic lighting", 60, wide);
  assert(out.length < "dramatic lighting".length, "expected truncation");
  assert(wide(out) <= 60, `label still ${wide(out)}px wide`);
  assert(out.endsWith("\u2026"), "expected an ellipsis");
});

check("a label that fits is untouched", () => {
  const measure = (s) => String(s).length * 6;
  assert(fitLabel("short", 200, measure) === "short", "short label was altered");
  assert(fitLabel("", 200, measure) === "", "empty label was altered");
});

check("a label too narrow for even one character does not produce junk", () => {
  const measure = (s) => String(s).length * 10;
  const out = fitLabel("abcdef", 4, measure);
  assert(out === "" || out === "\u2026" || measure(out) <= 4 || out.length <= 1,
    `expected an empty or 1-char label, got ${JSON.stringify(out)}`);
});

// ---------------------------------------------------------------- bounds

check("bounds enclose every node including its radius", () => {
  const nodes = layout(ROWS, EDGES, W, H, (t) => t);
  const b = bounds(nodes);
  for (const n of nodes) {
    assert(n.x - n.r >= b.x1 - 1e-6 && n.x + n.r <= b.x2 + 1e-6, `${n.k} outside the x bounds`);
    assert(n.y - n.r >= b.y1 - 1e-6 && n.y + n.r <= b.y2 + 1e-6, `${n.k} outside the y bounds`);
  }
});

check("bounds of an empty graph are degenerate, not NaN", () => {
  const b = bounds([]);
  assert(Number.isFinite(b.x1) && Number.isFinite(b.y1) && Number.isFinite(b.x2) && Number.isFinite(b.y2),
    "non-finite bounds");
});

// ---------------------------------------------------------------- internals

check("buildNodes and relax are usable on their own", () => {
  const nodes = buildNodes(ROWS, W, H);
  assert(nodes.length === ROWS.length, "wrong node count");
  for (const n of nodes) assert(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.k} not placed`);
  const before = nodes.map((n) => [n.x, n.y]);
  relax(nodes, EDGES, W, H, 5);
  const moved = nodes.some((n, i) => Math.abs(n.x - before[i][0]) > 1e-9 || Math.abs(n.y - before[i][1]) > 1e-9);
  assert(moved || nodes.length < 2, "relax did nothing at all");
  for (const n of nodes) assert(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.k} became non-finite`);
});

check("two nodes with the same count get the same radius", () => {
  const rows = tokens([["a", "a", 3], ["b", "b", 3]]);
  const nodes = layout(rows, [], W, H, (t) => t);
  assert(Math.abs(nodes[0].r - nodes[1].r) < 1e-9, "equal counts gave different radii");
});

console.log(`\ntg_layout: ${total - failed}/${total} layout tests passed`);
if (failed) {
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
