// EasyStringTokenGraph — text analysis shared by the node widget and the panel.
//
// This is the browser half of esn_tokens.py. It exists because the panel has
// to answer questions about the text the user is EDITING, not only about the
// text of the last run: typing a prompt should re-rank the tokens without
// queueing anything.
//
// The two implementations must agree, and tests/test_token_parity.py runs both
// over the same corpus and fails on any difference. When you change the rules
// of tokenization, change BOTH files and re-run that test - a silent drift here
// means the panel and the report describe different prompts.

// A token's folded key: case, separators and spacing are not part of the
// identity of a tag, so "Best_Quality", "best-quality" and "best  quality" are
// one token. The spelling the user typed survives separately as the display
// form.
const ESCAPABLE = "()[]{},:";
const NL = String.fromCharCode(10);
const PAIR_SEP = "\u0001";
const ELLIPSIS = "\u2026";

// Matches Python's [^\W_] under re.U: any letter or digit, but not "_".
// The default quality-boilerplate exclusion list. This mirrors
// esn_tokens.DEFAULT_EXCLUDE exactly; tests/test_token_parity.py compares the
// two lists and fails on any drift, so edit both together.
const DEFAULT_EXCLUDE = [
  "best quality", "high quality", "highest quality", "quality", "highquality",
  "masterpiece", "best", "top quality", "professional",
  "highres", "hi res", "hires", "absurdres", "high resolution", "resolution",
  "ultra high res", "extremely high res", "high definition", "hd", "uhd",
  "8k", "4k", "2k", "1080p", "2160p",
  "sharp focus", "sharp", "focus",
  "detailed", "highly detailed", "ultra detailed", "super detailed",
  "extremely detailed", "more detail", "max detail", "high detail",
  "intricate details", "intricate detail",
  "hdr", "hdr photo", "photo", "photograph",
  "ultra realistic", "photorealistic", "photo realistic", "realistic",
  "newest", "latest", "award winning", "trending on artstation",
];
const DEFAULT_EXCLUDE_TEXT = DEFAULT_EXCLUDE.join("\n");

const ALNUM_RE = /[\p{L}\p{N}]/u;
const WEIGHT_RE = /^([\s\S]*?):\s*([0-9]*\.?[0-9]+)\s*$/;
const BRACKETS = { "(": ")", "[": "]", "{": "}" };

function unescapeText(text) {
  const s = String(text == null ? "" : text);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && ESCAPABLE.indexOf(s[i + 1]) >= 0) {
      out += s[i + 1];
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

// Split on `sep` outside brackets, honouring backslash escapes. `\(` is a
// literal bracket, not a group opener.
function splitTopLevel(text, sep) {
  const s = String(text == null ? "" : text);
  const delimiter = sep === undefined ? "," : sep;
  const parts = [];
  let buf = "";
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && ESCAPABLE.indexOf(s[i + 1]) >= 0) {
      buf += ch + s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      buf += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      buf += ch;
    } else if (ch === delimiter && depth === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
    i++;
  }
  parts.push(buf);
  return parts;
}

function splitSections(text) {
  const s = String(text == null ? "" : text).split("\r\n").join(NL).split("\r").join(NL);
  const out = [];
  for (const chunk of s.split(/\bBREAK\b/i)) {
    for (const line of chunk.split(NL)) {
      if (line.trim()) out.push(line);
    }
  }
  return out;
}

// Inner text of exactly one surrounding bracket pair, else null. "(a) (b)"
// starts with "(" and ends with ")" but is two elements, not one.
function singleWrapper(text) {
  const t = String(text == null ? "" : text).trim();
  if (t.length < 2) return null;
  const open = t[0];
  if (!Object.prototype.hasOwnProperty.call(BRACKETS, open)) return null;
  if (t[t.length - 1] !== BRACKETS[open]) return null;
  const body = t.slice(1, -1);
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length && ESCAPABLE.indexOf(body[i + 1]) >= 0) {
      i += 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth < 0) return null;
      if (depth === 0 && i !== body.length - 1) return null;
    }
    i++;
  }
  return depth === 0 ? body : null;
}

function collapseWs(text) {
  return String(text).replace(/\s+/g, " ");
}

function stripEdge(text) {
  return String(text).replace(/^[,\s]+/, "").replace(/[,\s]+$/, "");
}

// One comma-separated element -> its display tokens ([] when empty).
function splitElementTokens(element) {
  const raw = unescapeText(element).trim();
  if (!raw) return [];
  let body = raw;
  let inner = singleWrapper(body);
  if (inner !== null) body = inner.trim();
  let m = WEIGHT_RE.exec(body);
  if (m && m[1].trim()) {
    body = m[1].trim();
    inner = singleWrapper(body);
    if (inner !== null) body = inner.trim();
  }
  const out = [];
  for (const piece of splitTopLevel(body, ",")) {
    let token = collapseWs(unescapeText(piece)).trim();
    token = stripEdge(token);
    inner = singleWrapper(token);
    if (inner !== null && inner.trim()) token = collapseWs(inner).trim();
    m = WEIGHT_RE.exec(token);
    if (m && m[1].trim()) token = m[1].trim();
    if (!token) continue;
    if (!ALNUM_RE.test(token)) continue;
    out.push(token);
  }
  return out;
}

function foldToken(token) {
  let key = unescapeText(token).toLowerCase();
  key = key.split("_").join(" ").split("-").join(" ");
  key = collapseWs(key).trim();
  return stripEdge(key);
}

// [[{d: display, k: key}, ...], ...] — one inner array per BREAK/newline
// section, which is what co-occurrence is computed within.
function tokenizeText(text) {
  const sections = [];
  for (const raw of splitSections(text)) {
    const tokens = [];
    for (const element of splitTopLevel(raw, ",")) {
      for (const token of splitElementTokens(element)) {
        const key = foldToken(token);
        if (key) tokens.push({ d: token, k: key });
      }
    }
    if (tokens.length) sections.push(tokens);
  }
  return sections;
}

function tokenizeDisplayList(text) {
  const out = [];
  for (const section of tokenizeText(text)) for (const t of section) out.push(t.d);
  return out;
}

// --------------------------------------------------------------- exclusions

// Accepts an array or one string with newlines/commas; "#" starts a comment.
function parseExclude(value) {
  if (value == null) return [];
  let raw;
  if (Array.isArray(value)) raw = value.map((v) => String(v));
  else raw = String(value).split(",").join(NL).split(NL);
  const out = [];
  for (let item of raw) {
    item = item.trim();
    if (!item || item.startsWith("#")) continue;
    const key = foldToken(item);
    if (key && out.indexOf(key) < 0) out.push(key);
  }
  return out;
}

// A pattern is a plain key, or a glob where * and ? are wildcards. "[" is
// literal: fnmatch character classes are not supported on either side.
function patternToRegExp(pattern) {
  let src = "^";
  for (const ch of pattern) {
    if (ch === "*") src += "[\\s\\S]*";
    else if (ch === "?") src += "[\\s\\S]";
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(src + "$");
}

function isExcluded(key, patterns) {
  if (!key || !patterns || !patterns.length) return false;
  for (const pat of patterns) {
    if (pat === key) return true;
    if ((pat.indexOf("*") >= 0 || pat.indexOf("?") >= 0) && patternToRegExp(pat).test(key)) {
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ counting

function pairIndex(a, b) {
  return a <= b ? a + PAIR_SEP + b : b + PAIR_SEP + a;
}

function pairParts(key) {
  if (typeof key !== "string" || key.indexOf(PAIR_SEP) < 0) return [null, null];
  const i = key.indexOf(PAIR_SEP);
  const a = key.slice(0, i);
  const b = key.slice(i + 1);
  return a && b ? [a, b] : [null, null];
}

// Prefer a spelling that carries capitalisation: "HDR photo" over "hdr photo".
function betterDisplay(oldText, newText) {
  if (!oldText) return newText;
  if (!newText) return oldText;
  const oldLower = oldText === oldText.toLowerCase();
  const newLower = newText === newText.toLowerCase();
  if (oldLower && !newLower) return newText;
  return oldText;
}

function emptyStats() {
  return { version: 1, runs: 0, tokens: {}, pairs: {}, updated: 0, exclude: [], window: 3 };
}

// Fold one run of text into a plain-object stats document. This is the shape
// the Python payload is converted into, so both sides feed the same renderer.
function mergeRun(stats, text, window, runIndex) {
  const win = Math.max(1, Math.floor(window || 3));
  stats.tokens = stats.tokens || {};
  stats.pairs = stats.pairs || {};
  const index = runIndex == null ? (Number(stats.runs) || 0) + 1 : Math.floor(runIndex);
  stats.runs = Math.max(Number(stats.runs) || 0, index);

  const seen = Object.create(null);
  for (const section of tokenizeText(text)) {
    const keys = section.map((t) => t.k);
    for (const tok of section) {
      let rec = stats.tokens[tok.k];
      if (!rec) {
        rec = { n: 0, runs: 0, display: tok.d, last: 0 };
        stats.tokens[tok.k] = rec;
      }
      rec.n = (Number(rec.n) || 0) + 1;
      rec.display = betterDisplay(rec.display, tok.d);
      seen[tok.k] = true;
    }
    // Distance runs 1..window inclusive, so window=1 means "immediate
    // neighbours only" exactly as the input tooltip promises.
    for (let i = 0; i < keys.length; i++) {
      const end = Math.min(i + win + 1, keys.length);
      for (let j = i + 1; j < end; j++) {
        const a = keys[i];
        const b = keys[j];
        if (a === b) continue;
        const key = pairIndex(a, b);
        stats.pairs[key] = (Number(stats.pairs[key]) || 0) + (win - (j - i) + 1);
      }
    }
  }
  for (const key of Object.keys(seen)) {
    const rec = stats.tokens[key];
    if (rec) {
      rec.runs = (Number(rec.runs) || 0) + 1;
      rec.last = index;
    }
  }
  stats.updated = Date.now() / 1000;
  return stats;
}

// The item list of a payload's ranking, as the panel renders it.
function rankTokens(stats, opts) {
  opts = opts || {};
  const patterns = opts.patterns || [];
  const minN = Math.max(1, Math.floor(opts.minN || 1));
  const rows = [];
  const tokens = (stats && stats.tokens) || {};
  for (const key of Object.keys(tokens)) {
    const rec = tokens[key] || {};
    const n = Number(rec.n) || 0;
    if (n < minN) continue;
    if (!opts.includeExcluded && isExcluded(key, patterns)) continue;
    rows.push({
      t: rec.display || key,
      k: key,
      n,
      runs: Number(rec.runs) || 0,
      last: Number(rec.last) || 0,
    });
  }
  // occurrences, then runs, then alphabetically: a stable order matters
  // because the panel must not reshuffle under the user's pointer
  rows.sort((a, b) => (b.n - a.n) || (b.runs - a.runs) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const limit = opts.limit == null ? 40 : Math.max(0, Math.floor(opts.limit));
  return limit ? rows.slice(0, limit) : rows;
}

// Co-occurrence edges among a ranking, as [i, j, weight] indexing into it.
function edgesFor(stats, rows, limit) {
  if (!rows || !rows.length) return [];
  const index = Object.create(null);
  rows.forEach((row, i) => { index[row.k] = i; });
  const out = [];
  const pairs = (stats && stats.pairs) || {};
  for (const key of Object.keys(pairs)) {
    const parts = pairParts(key);
    const a = parts[0];
    const b = parts[1];
    if (a == null || !(a in index) || !(b in index)) continue;
    out.push([index[a], index[b], Number(pairs[key]) || 0]);
  }
  out.sort((x, y) => (y[2] - x[2]) || (x[0] - y[0]) || (x[1] - y[1]));
  return limit ? out.slice(0, limit) : out;
}

// The relations of ONE token, strongest first: what the panel shows when the
// pointer rests on a node ("which tokens is this one used with?").
function relationsOf(stats, key, nameOf, limit) {
  const pairs = (stats && stats.pairs) || {};
  const out = [];
  for (const pair of Object.keys(pairs)) {
    const parts = pairParts(pair);
    let other = null;
    if (parts[0] === key) other = parts[1];
    else if (parts[1] === key) other = parts[0];
    if (!other) continue;
    out.push({ k: other, w: Number(pairs[pair]) || 0 });
  }
  out.sort((a, b) => (b.w - a.w) || (a.k < b.k ? -1 : 1));
  const named = out.map((r) => ({
    k: r.k,
    w: r.w,
    t: nameOf ? (nameOf(r.k) || r.k) : r.k,
  }));
  return limit ? named.slice(0, limit) : named;
}

function emptyPayload(window) {
  return {
    runs: 0, distinct: 0, window: Math.max(1, Math.floor(window || 3)),
    tokens: [], edges: [], excluded: [], excluded_n: 0, excluded_count: 0,
    total_n: 0, text: "", stats_file: "",
  };
}

// A payload built from an in-browser stats document: the same shape Python
// produces, so the panel has exactly one input format.
function payloadFromStats(stats, opts) {
  opts = opts || {};
  const patterns = opts.patterns || [];
  const rows = rankTokens(stats, {
    patterns: patterns,
    minN: opts.minN,
    limit: opts.limit == null ? 40 : opts.limit,
  });
  const hidden = [];
  let hiddenN = 0;
  const tokens = (stats && stats.tokens) || {};
  for (const key of Object.keys(tokens)) {
    if (!isExcluded(key, patterns)) continue;
    const n = Number(tokens[key].n) || 0;
    hiddenN += n;
    hidden.push({ t: tokens[key].display || key, n });
  }
  hidden.sort((a, b) => (b.n - a.n) || (a.t < b.t ? -1 : 1));
  let total = 0;
  for (const key of Object.keys(tokens)) total += Number(tokens[key].n) || 0;
  return {
    runs: Number(stats && stats.runs) || 0,
    distinct: Object.keys(tokens).length,
    window: Math.max(1, Math.floor((stats && stats.window) || opts.window || 3)),
    tokens: rows,
    edges: edgesFor(stats, rows),
    excluded: hidden.slice(0, 60),
    excluded_n: hiddenN,
    excluded_count: hidden.length,
    total_n: total,
    text: opts.text || "",
    stats_file: opts.statsFile || "",
  };
}

// Download the whole statistics document as a JSON-stringifiable plain object.
function statsToJSON(stats) {
  const tokens = {};
  for (const key of Object.keys((stats && stats.tokens) || {})) {
    const rec = stats.tokens[key] || {};
    tokens[key] = {
      n: Number(rec.n) || 0,
      runs: Number(rec.runs) || 0,
      display: rec.display || key,
      last: Number(rec.last) || 0,
    };
  }
  return {
    version: 1,
    runs: Number(stats && stats.runs) || 0,
    tokens,
    pairs: Object.assign({}, (stats && stats.pairs) || {}),
    window: Math.max(1, Math.floor((stats && stats.window) || 3)),
    updated: Number((stats && stats.updated) || 0),
  };
}

// Rebuild a stats document from a Python payload's ranking (the payload is
// bounded, so this is only the visible part of the history - enough for a
// preview ranking, which is what the panel needs before its first run).
function statsFromPayload(payload) {
  const stats = emptyStats();
  if (!payload) return stats;
  stats.runs = Number(payload.runs) || 0;
  stats.window = Math.max(1, Math.floor(payload.window || 3));
  for (const row of payload.tokens || []) {
    const key = row.k || foldToken(row.t || "");
    if (!key) continue;
    stats.tokens[key] = {
      n: Number(row.n) || 0,
      runs: Number(row.runs) || 0,
      display: row.t || key,
      last: Number(row.last) || 0,
    };
  }
  for (const edge of payload.edges || []) {
    const a = (payload.tokens || [])[edge[0]];
    const b = (payload.tokens || [])[edge[1]];
    if (!a || !b) continue;
    const ka = a.k || foldToken(a.t || "");
    const kb = b.k || foldToken(b.t || "");
    if (!ka || !kb) continue;
    stats.pairs[pairIndex(ka, kb)] = Number(edge[2]) || 0;
  }
  return stats;
}

export {
  PAIR_SEP, ELLIPSIS, DEFAULT_EXCLUDE, DEFAULT_EXCLUDE_TEXT,
  unescapeText, splitTopLevel, splitSections, splitElementTokens, foldToken,
  tokenizeText, tokenizeDisplayList,
  parseExclude, isExcluded, pairIndex, pairParts,
  emptyStats, mergeRun, rankTokens, edgesFor, relationsOf,
  emptyPayload, payloadFromStats, statsToJSON, statsFromPayload,
};
