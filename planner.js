/* The road planner, a Web Worker: the fewest launchers from one system to another over every star of the archive
   (stars.bin), with the catapult interference rule (another star inside the sphere on the hop's diameter blocks a
   catapult; gates are immune) and the Cycle 7 ranges: Mini Catapult 60 LY, Heavy Catapult 250 LY, Mini Gate 105 LY,
   Heavy Gate 365 LY (a gate hop means two gates). A* with cost = launchers to build, ties broken by light-years.
   When the target cannot be reached, the plan runs to the reachable system closest to it and ends with one "gap" hop
   that only an NPC stargate can cross. Same rules as ftk/roadplan.py, ~20x faster here.
     postMessage({ type: "plan", from, to, tools: ["Heavy Catapult", ...], avoid: [ids] })
     -> { type: "progress", expanded } ... { type: "done", hops: [{ from, to, kind, ly } | { from, to, gap: true, ly }], reached, expanded, ms } */
"use strict";
const RANGE = { "Mini Catapult": 60, "Heavy Catapult": 250, "Mini Gate": 105, "Heavy Gate": 365 };
const COST = { "Mini Catapult": 1, "Heavy Catapult": 1, "Mini Gate": 2, "Heavy Gate": 2 };    // launchers to build
const CELL = 125;
let N = 0, X = null, Y = null, Z = null, ID = null, NAME = null, grid = null, index = null, loading = null;
let GATES = null, gatesLoading = null;               // star index -> [star indices]: the public stargate network (gates.bin), hops that cost nothing to build

function loadGates(url) {                           // after the stars: the pairs become index lists
  if (gatesLoading) return gatesLoading;
  gatesLoading = fetch(url).then(r => { if (!r.ok) throw new Error("gates " + r.status); return r.arrayBuffer(); }).then(buf => {
    const dv = new DataView(buf), cnt = dv.getUint32(8, true); GATES = new Map();
    const push = (a, b) => { let l = GATES.get(a); if (!l) GATES.set(a, l = []); l.push(b); };
    for (let i = 0, o = 12; i < cnt; i++, o += 9) { const a = index.get(dv.getUint32(o, true)), b = index.get(dv.getUint32(o + 4, true)); if (a == null || b == null) continue; push(a, b); push(b, a); }
  }).catch(() => { GATES = new Map(); });
  return gatesLoading;
}

function load(url) {
  if (loading) return loading;
  loading = fetch(url).then(r => r.arrayBuffer()).then(buf => {
    const dv = new DataView(buf); N = dv.getUint32(4, true);
    X = new Float32Array(N); Y = new Float32Array(N); Z = new Float32Array(N); ID = new Uint32Array(N); index = new Map(); grid = new Map();
    for (let i = 0, o = 8; i < N; i++, o += 20) {
      ID[i] = dv.getUint32(o, true); X[i] = dv.getFloat32(o + 4, true); Y[i] = dv.getFloat32(o + 8, true); Z[i] = dv.getFloat32(o + 12, true); index.set(ID[i], i);
      const k = key(X[i], Y[i], Z[i]); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i);
    }
    let o = 8 + N * 20; if (o + 4 <= dv.byteLength) { const cnt = dv.getUint32(o, true); o += 4; const dec = new TextDecoder(); NAME = new Array(cnt); for (let i = 0; i < cnt; i++) { const l = dv.getUint8(o); NAME[i] = dec.decode(new Uint8Array(buf, o + 1, l)); o += 1 + l; } }
  });
  return loading;
}
const key = (x, y, z) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
const dist = (i, j) => Math.hypot(X[i] - X[j], Y[i] - Y[j], Z[i] - Z[j]);
function within(x, y, z, r, out) {                  // star indices within r of a point
  out.length = 0; const r2 = r * r, c = Math.ceil(r / CELL), cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
  for (let i = cx - c; i <= cx + c; i++) for (let j = cy - c; j <= cy + c; j++) for (let k = cz - c; k <= cz + c; k++) {
    const a = grid.get(`${i},${j},${k}`); if (!a) continue;
    for (const s of a) { const dx = X[s] - x, dy = Y[s] - y, dz = Z[s] - z; if (dx * dx + dy * dy + dz * dz <= r2) out.push(s); } }
  return out;
}
const scratch = [];
function blocked(a, b) {                           // the empty-sphere rule on the diameter ab
  const mx = (X[a] + X[b]) / 2, my = (Y[a] + Y[b]) / 2, mz = (Z[a] + Z[b]) / 2, r = dist(a, b) / 2, r2 = r * r - 1e-6;
  for (const s of within(mx, my, mz, r, scratch)) { if (s === a || s === b) continue; const dx = X[s] - mx, dy = Y[s] - my, dz = Z[s] - mz; if (dx * dx + dy * dy + dz * dz < r2) return true; }
  return false;
}

// a binary heap of [f, g, node]
class Heap { constructor() { this.a = []; } push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; } }

// every star reachable from `src` by hops of at most `r` (no interference: gates ignore it; a quick pre-check)
function component(src, r, gates) {               // gates: the public network counts as reach too (a pilot can jump it, status permitting)
  const seen = new Set([src]), q = [src], cand = [];
  for (let qi = 0; qi < q.length; qi++) { const s = q[qi]; if (r > 0) { within(X[s], Y[s], Z[s], r, cand); for (const n of cand) if (!seen.has(n)) { seen.add(n); q.push(n); } }
    if (gates) for (const n of gates.get(s) || []) if (!seen.has(n)) { seen.add(n); q.push(n); } }
  return seen;
}
function plan(fromId, toId, tools, avoidIds) {
  const src = index.get(fromId), dst0 = index.get(toId); let dst = dst0;
  if (src == null || dst == null) return { error: "unknown system" };
  // an unreachable target (a pocket behind a gap wider than every tool): aim for the reachable star closest to it
  // "Public Gate" among the tools: the client's NPC gate network may be jumped, nothing to build, state unknown
  const gates = tools.includes("Public Gate") && GATES && GATES.size ? GATES : null;
  const kinds0 = tools.filter(t => RANGE[t]); if (!kinds0.length && !gates) return { error: "no tool" };
  const comp = component(src, kinds0.length ? Math.max(...kinds0.map(k => RANGE[k])) : 0, gates);
  let pocket = false;
  if (!comp.has(dst)) { pocket = true; let bd = Infinity; for (const i of comp) { const d = dist(i, dst0); if (d < bd) { bd = d; dst = i; } } }
  // a gate pair needs a builder at BOTH ends, so a gate can only join systems a catapult can already reach: with a
  // catapult among the tools, gate hops stay inside the catapult-reachable set (gates then save launchers or add a
  // two-way road, never reach); with gates alone the rule is off and the pilot must know another way across.
  // Public gates extend that reach: a builder can ride them to the far side.
  const catR = Math.max(0, ...kinds0.filter(k => /Catapult/.test(k)).map(k => RANGE[k]));
  const reach = catR ? component(src, catR, gates) : null;
  if (reach && !reach.has(dst)) { let bd = Infinity; for (const i of reach) { const d = dist(i, dst0); if (d < bd) { bd = d; dst = i; } } pocket = true; }
  const kinds = tools.filter(t => RANGE[t]).sort((a, b) => RANGE[a] - RANGE[b]);      // shortest range first: the cheapest tool that reaches wins
  const maxR = kinds.length ? Math.max(...kinds.map(k => RANGE[k])) : 0, BIG = 1e7;
  const avoid = new Set((avoidIds || []).map(id => index.get(id)).filter(i => i != null));
  // with public gates a far target may cost no launcher at all, so the launcher part of the heuristic is dropped (slower, still exact)
  const h = gates ? (i => dist(i, dst)) : (i => Math.ceil(Math.max(0, dist(i, dst) - 1e-9) / maxR) * BIG + dist(i, dst));
  const best = new Map([[src, 0]]), came = new Map(), via = new Map();
  const heap = new Heap(); heap.push([h(src), 0, src]);
  const cand = []; let expanded = 0, t0 = Date.now(), lastMsg = t0, done = false;
  while (heap.size) {
    const [, g, s] = heap.pop();
    if (s === dst) { done = true; break; }
    if (g > best.get(s)) continue;
    expanded++;
    if (Date.now() - lastMsg > 500) { lastMsg = Date.now(); postMessage({ type: "progress", expanded, closest: Math.round(dist(s, dst)) }); }
    if (maxR > 0) within(X[s], Y[s], Z[s], maxR, cand); else cand.length = 0;
    for (const n of cand) {
      if (n === s || (avoid.has(n) && n !== dst)) continue;
      const d = dist(s, n); let kind = null, blk = null;
      for (const k of kinds) { if (d > RANGE[k]) continue; if (/Catapult/.test(k)) { if (blk == null) blk = blocked(s, n); if (blk) continue; } else if (reach && !reach.has(n)) continue; kind = k; break; }
      if (!kind) continue;
      const ng = g + COST[kind] * BIG + d;
      if (ng >= (best.get(n) ?? Infinity)) continue;
      best.set(n, ng); came.set(n, s); via.set(n, kind); heap.push([ng + h(n), ng, n]);
    }
    if (gates) for (const n of gates.get(s) || []) {          // a public gate hop: nothing to build, only the light-years
      if (avoid.has(n) && n !== dst) continue;
      const ng = g + dist(s, n);
      if (ng >= (best.get(n) ?? Infinity)) continue;
      best.set(n, ng); came.set(n, s); via.set(n, "Public Gate"); heap.push([ng + h(n), ng, n]);
    }
  }
  let end = dst, reached = done && !pocket;
  if (!done) {                                     // blocked on the way (interference): the reachable system closest to the target
    let bd = Infinity; for (const i of best.keys()) { const d = dist(i, dst0); if (d < bd) { bd = d; end = i; } }
  }
  const hops = []; for (let s = end; s !== src; s = came.get(s)) { const p = came.get(s); hops.push({ from: ID[p], to: ID[s], kind: via.get(s), ly: +dist(p, s).toFixed(1), fromName: NAME ? NAME[p] : undefined, toName: NAME ? NAME[s] : undefined }); }
  hops.reverse();
  if (!reached && end !== dst0) hops.push({ from: ID[end], to: ID[dst0], gap: true, ly: +dist(end, dst0).toFixed(1), fromName: NAME ? NAME[end] : undefined, toName: NAME ? NAME[dst0] : undefined });
  return { hops, reached, pocket, expanded, ms: Date.now() - t0 };
}

onmessage = async e => {
  const m = e.data;
  try {
    await load(m.stars || "stars.bin?v=2");
    if (m.gates && (m.tools || []).includes("Public Gate")) await loadGates(m.gates);
    if (m.type === "plan") { const r = plan(m.from, m.to, m.tools || ["Heavy Catapult"], m.avoid); postMessage(Object.assign({ type: "done", id: m.id }, r)); }
  } catch (err) { postMessage({ type: "done", id: m.id, error: String(err && err.message || err) }); }
};
