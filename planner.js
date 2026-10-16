/* The road planner, a Web Worker over every star of the archive (stars.bin), the client's public stargate network
   (gates.bin), every legal catapult hop of the galaxy (catapults.bin: the pairs within 250 LY that pass the empty-sphere
   interference test, computed once per cycle by tools/export_catapults.py) and the tribe's own roads read from the chain.
   Same rules as ftk/roadplan.py: Mini Catapult 60 LY, Heavy Catapult 250 LY, Mini Gate 105 LY, Heavy Gate 365 LY (a gate
   hop means two gates, and a gate pair may only join systems a builder can already reach), catapults blocked by any star
   inside the sphere on the hop's diameter, gates immune. A plain Dijkstra with a ranked cost: the pilot's priority list
   (launchers to build, hops, Building Foam, hops that are not public gates, hops that are not catapults, light-years),
   compared one criterion after the other.

     postMessage({ type: "plan", id, from, to, stops: [ids], avoid: [ids], tools: ["Heavy Catapult", ...],
                   priorities: ["launchers", "hops", "foam", "nonpublic", "noncatapult", "ly"], mode: "access" | "corridor" | "tree",
                   roundTrip: bool, roads: [{ a, b, kind, twoWay }], gateStates: [{ a, b, state }], stars, gates, catapults })
       -> { type: "progress", expanded } ... { type: "done", id, hops: [...], legs: [...], steps: [...], back: {...}|null, reached,
            diagnostics: { ... }, expanded, ms }
     postMessage({ type: "check", id, from, structure: "Mini Catapult" | ..., target, stars, catapults })
       -> { type: "checked", id, legal: [[id, ly]], blocked: [[id, ly]], target: { id, ly, inRange, legal, blockers: [ids] } | null, stepTo: id | null }

   A hop: { from, to, kind, ly, fromName, toName, free: true when nothing is to be built (a public gate, one of our roads, or
   something built earlier in the same plan), state: the recorded state of a public gate, step: "gate" for a corridor's
   "build this gate pair" line, gap: true for a crossing no tool can make }. */
"use strict";
const RANGE = { "Mini Catapult": 60, "Heavy Catapult": 250, "Mini Gate": 105, "Heavy Gate": 365 };
const LAUNCHERS = { "Mini Catapult": 1, "Heavy Catapult": 1, "Mini Gate": 2, "Heavy Gate": 2 };
const FOAM = { "Mini Catapult": 22, "Heavy Catapult": 141, "Mini Gate": 92, "Heavy Gate": 462 };   // Building Foam per hop, a gate pair = two gates (data/recipes.json)
const CRITERIA = ["launchers", "hops", "foam", "nonpublic", "noncatapult", "ly"];
const CELL = 125;
let N = 0, X = null, Y = null, Z = null, ID = null, NAME = null, grid = null, index = null, loading = null;
let GATES = null, gatesLoading = null;               // star index -> [star indices]: the public stargate network
let CATA = null, cataLoading = null, CATA_RANGE = 0;  // star index -> [[star index, ly]]: every legal catapult hop

// ---------- data ----------
function load(url) {
  if (loading) return loading;
  loading = fetch(url).catch(e => { loading = null; throw e; }).then(r => { if (!r.ok) { loading = null; throw new Error("stars " + r.status); } return r.arrayBuffer(); }).then(buf => {
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
function loadGates(url) {
  if (gatesLoading) return gatesLoading;
  gatesLoading = fetch(url).then(r => { if (!r.ok) throw new Error("gates " + r.status); return r.arrayBuffer(); }).then(buf => {
    const dv = new DataView(buf), cnt = dv.getUint32(8, true); GATES = new Map();
    const push = (a, b) => { let l = GATES.get(a); if (!l) GATES.set(a, l = []); l.push(b); };
    for (let i = 0, o = 12; i < cnt; i++, o += 9) { const a = index.get(dv.getUint32(o, true)), b = index.get(dv.getUint32(o + 4, true)); if (a == null || b == null) continue; push(a, b); push(b, a); }
  }).catch(() => { GATES = new Map(); });
  return gatesLoading;
}
function loadCatapults(url) {
  if (cataLoading) return cataLoading;
  cataLoading = fetch(url).then(r => { if (!r.ok) throw new Error("catapults " + r.status); return r.arrayBuffer(); }).then(buf => {
    const dv = new DataView(buf), cnt = dv.getUint32(8, true); CATA_RANGE = dv.getUint16(12, true); CATA = new Map();
    const push = (a, b, d) => { let l = CATA.get(a); if (!l) CATA.set(a, l = []); l.push([b, d]); };
    for (let i = 0, o = 14; i < cnt; i++, o += 10) { const a = index.get(dv.getUint32(o, true)), b = index.get(dv.getUint32(o + 4, true)), d = dv.getUint16(o + 8, true) / 10; if (a == null || b == null) continue; push(a, b, d); push(b, a, d); }
  }).catch(() => { CATA = null; });
  return cataLoading;
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
function blockers(a, b) {                          // the stars inside the sphere on the diameter ab (the interference rule)
  const mx = (X[a] + X[b]) / 2, my = (Y[a] + Y[b]) / 2, mz = (Z[a] + Z[b]) / 2, r = dist(a, b) / 2, r2 = r * r - 1e-6, out = [];
  for (const s of within(mx, my, mz, r, scratch)) { if (s === a || s === b) continue; const dx = X[s] - mx, dy = Y[s] - my, dz = Z[s] - mz; if (dx * dx + dy * dy + dz * dz < r2) out.push(s); }
  return out;
}
// legal catapult targets of s within r: from the precomputed graph, else by the sphere test over the grid
function catapultTargets(s, r) {
  if (CATA) return (CATA.get(s) || []).filter(e => e[1] <= r);
  const out = [], cand = [];
  for (const n of within(X[s], Y[s], Z[s], r, cand)) { if (n === s) continue; const d = dist(s, n); if (d <= r && !blockers(s, n).length) out.push([n, d]); }
  return out;
}

// ---------- the search ----------
class Heap { constructor(cmp) { this.a = []; this.cmp = cmp; } push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (this.cmp(a[p], a[i]) <= 0) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l; if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; } }
const cmpCost = (p, q) => { for (let i = 0; i < p.length; i++) { if (p[i] < q[i] - 1e-9) return -1; if (p[i] > q[i] + 1e-9) return 1; } return 0; };

/* The context of one search: the tools, the free hops (our roads, what the plan built already), the public gates and
   their recorded states, the systems to avoid, the reach set for gate pairs, and the priority order. */
function makeCtx(m) {
  const tools = new Set(m.tools || []), avoid = new Set((m.avoid || []).map(id => index.get(id)).filter(i => i != null));
  const own = new Map(), add = (a, b, kind, free) => { let l = own.get(a); if (!l) own.set(a, l = []); l.push({ n: b, kind, free }); };
  for (const r of m.roads || []) { const a = index.get(r.a), b = index.get(r.b); if (a == null || b == null) continue; add(a, b, r.kind || "Our Road", "road"); if (r.twoWay) add(b, a, r.kind || "Our Road", "road"); }
  const states = new Map(); for (const g of m.gateStates || []) { const a = index.get(g.a), b = index.get(g.b); if (a == null || b == null) continue; states.set(a + "|" + b, g.state || ""); states.set(b + "|" + a, g.state || ""); }
  let prio = (m.priorities || []).filter(k => CRITERIA.includes(k)); if (!prio.length) prio = ["launchers", "hops", "foam", "ly"]; if (!prio.includes("ly")) prio.push("ly");
  return { tools, avoid, own, built: new Map(), states, prio, gatesOn: tools.has("Public Gate") && GATES && GATES.size > 0, catR: Math.max(0, ...["Mini Catapult", "Heavy Catapult"].filter(t => tools.has(t)).map(t => RANGE[t])), gateR: Math.max(0, ...["Mini Gate", "Heavy Gate"].filter(t => tools.has(t)).map(t => RANGE[t])) };
}
function addBuilt(ctx, a, b, kind) {               // a hop built earlier in the plan is free from then on (a gate pair both ways)
  const push = (x, y) => { let l = ctx.built.get(x); if (!l) ctx.built.set(x, l = []); l.push({ n: y, kind, free: "built" }); };
  push(a, b); if (/Gate/.test(kind)) push(b, a);
}
// every hop out of s: [n, kind, ly, free]
function edgesOf(s, ctx, dst, cand) {
  const out = [], ok = n => n === dst || !ctx.avoid.has(n);
  for (const e of ctx.own.get(s) || []) if (ok(e.n)) out.push([e.n, e.kind, dist(s, e.n), e.free]);
  for (const e of ctx.built.get(s) || []) if (ok(e.n)) out.push([e.n, e.kind, dist(s, e.n), e.free]);
  if (ctx.gatesOn) for (const n of GATES.get(s) || []) if (ok(n)) out.push([n, "Public Gate", dist(s, n), "public"]);
  if (ctx.catR) for (const [n, d] of catapultTargets(s, ctx.catR)) { if (!ok(n)) continue; const kind = d <= 60 && ctx.tools.has("Mini Catapult") ? "Mini Catapult" : d <= 250 && ctx.tools.has("Heavy Catapult") ? "Heavy Catapult" : null; if (kind) out.push([n, kind, d, null]); }
  if (ctx.gateR && ctx.reach) for (const n of within(X[s], Y[s], Z[s], ctx.gateR, cand)) { if (n === s || !ok(n) || !ctx.reach.has(n)) continue; const d = dist(s, n); const kind = d <= 105 && ctx.tools.has("Mini Gate") ? "Mini Gate" : d <= 365 && ctx.tools.has("Heavy Gate") ? "Heavy Gate" : null; if (kind) out.push([n, kind, d, null]); }
  return out;
}
// "prefer public stargates" counts every hop that is not a public gate and not free; "prefer catapults" counts public
// gate hops and new gate pairs (our own roads and hops built earlier in the plan are catapults of ours: nothing to prefer over)
const hopCost = (kind, ly, free, ctx) => ctx.prio.map(c => c === "launchers" ? (free ? 0 : LAUNCHERS[kind] || 0) : c === "hops" ? 1 : c === "foam" ? (free ? 0 : FOAM[kind] || 0) : c === "nonpublic" ? (kind === "Public Gate" || free ? 0 : 1) : c === "noncatapult" ? (/Catapult/.test(kind) || free === "road" || free === "built" ? 0 : 1) : ly);
// everything a builder can reach from the seeds with catapults, public gates and free hops (the far end of a gate pair must be reachable)
function component(seeds, ctx) {
  const seen = new Set(seeds), q = [...seeds];
  for (let qi = 0; qi < q.length; qi++) { const s = q[qi];
    for (const e of ctx.own.get(s) || []) if (!seen.has(e.n)) { seen.add(e.n); q.push(e.n); }
    for (const e of ctx.built.get(s) || []) if (!seen.has(e.n)) { seen.add(e.n); q.push(e.n); }
    if (ctx.gatesOn) for (const n of GATES.get(s) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    if (ctx.catR) for (const [n] of catapultTargets(s, ctx.catR)) if (!seen.has(n)) { seen.add(n); q.push(n); } }
  return seen;
}
/* Dijkstra from the seeds (cost 0 at each) to dst. Returns { end, hops, reached, expanded, best }: when dst is out of
   reach, end is the reached star closest to it and the hops lead there. */
function search(seeds, dst, ctx, progress) {
  const best = new Map(), came = new Map(), via = new Map(), heap = new Heap((a, b) => cmpCost(a[0], b[0]));
  const zero = ctx.prio.map(() => 0);
  for (const s of seeds) { best.set(s, zero); heap.push([zero, s]); }
  const cand = []; let expanded = 0, lastMsg = Date.now(), done = false;
  while (heap.size) {
    const [c, s] = heap.pop();
    if (s === dst) { done = true; break; }
    if (cmpCost(c, best.get(s)) > 0) continue;
    expanded++;
    if (progress && Date.now() - lastMsg > 500) { lastMsg = Date.now(); progress(expanded, Math.round(dist(s, dst))); }
    for (const [n, kind, ly, free] of edgesOf(s, ctx, dst, cand)) {
      const h = hopCost(kind, ly, free, ctx), nc = c.map((v, i) => v + h[i]);
      const b = best.get(n); if (b && cmpCost(nc, b) >= 0) continue;
      best.set(n, nc); came.set(n, s); via.set(n, [kind, ly, free]); heap.push([nc, n]);
    }
  }
  let end = dst;
  if (!done) { let bd = Infinity; for (const i of best.keys()) { const d = dist(i, dst); if (d < bd) { bd = d; end = i; } } }
  const hops = [];
  for (let s = end; came.has(s); s = came.get(s)) { const p = came.get(s), [kind, ly, free] = via.get(s); hops.push(hop(p, s, kind, ly, free, ctx)); }
  hops.reverse();
  return { end, hops, reached: done, expanded, best };
}
function hop(a, b, kind, ly, free, ctx) {
  const h = { from: ID[a], to: ID[b], kind, ly: +ly.toFixed(1), fromName: NAME ? NAME[a] : undefined, toName: NAME ? NAME[b] : undefined };
  if (free) h.free = true;
  if (kind === "Public Gate") { const st = ctx.states.get(a + "|" + b); if (st) h.state = st; }
  return h;
}
const gapHop = (a, b) => ({ from: ID[a], to: ID[b], gap: true, ly: +dist(a, b).toFixed(1), fromName: NAME ? NAME[a] : undefined, toName: NAME ? NAME[b] : undefined });

/* Why a target was not reached: the gap from the closest reached star, what the ticked tools could do about it. */
function diagnose(end, dst, ctx) {
  const ly = dist(end, dst), d = { end: ID[end], endName: NAME ? NAME[end] : undefined, ly: +ly.toFixed(1), reason: "gap" };
  const catR = ctx.catR, gateR = ctx.gateR, best = Math.max(catR, gateR);
  if (!best) return d;                                                     // public gates only: a gap, not a range
  if (ly > best) { d.reason = "range"; d.beyond = best; return d; }
  if (catR && ly <= catR) { d.reason = "blocked"; d.blockers = blockers(end, dst).map(i => ({ id: ID[i], name: NAME ? NAME[i] : undefined, ly: +dist(end, i).toFixed(1) })); if (!d.blockers.length) d.reason = "avoided"; return d; }
  if (gateR && ly <= gateR) { d.reason = "gatefar"; return d; }             // a gate pair could span it, but the far end cannot be reached to build its gate
  return d;
}
// the direct jump from src to dst: in range of what, blocked by whom
function direct(src, dst, ctx) {
  const ly = dist(src, dst), tool = ["Mini Catapult", "Heavy Catapult", "Mini Gate", "Heavy Gate"].find(t => ctx.tools.has(t) && ly <= RANGE[t]) || null;
  const o = { ly: +ly.toFixed(1), tool };
  if (tool && /Catapult/.test(tool)) o.blockers = blockers(src, dst).map(i => ({ id: ID[i], name: NAME ? NAME[i] : undefined, ly: +dist(src, i).toFixed(1) }));
  return o;
}

function plan(m, progress) {
  const src = index.get(m.from), dst = index.get(m.to);
  if (src == null || dst == null) return { error: "unknown system" };
  const ctx = makeCtx(m);
  if (!ctx.catR && !ctx.gateR && !ctx.gatesOn && !ctx.own.size) return { error: "no tool" };
  const stops = (m.stops || []).map(id => index.get(id)).filter(i => i != null && i !== src && i !== dst);
  const t0 = Date.now(); let expanded = 0, legs = [], steps = [];
  const prog = (e, c) => progress && progress(expanded + e, c);
  if (m.mode === "corridor") {
    // 1. the permanent corridor: gate pairs only, range-only, fewest pairs then light-years
    const gctx = Object.assign({}, ctx, { catR: 0, gatesOn: false, own: new Map(), built: new Map(), reach: null, prio: ["launchers", "ly"] });
    const allReach = { has: () => true }; gctx.reach = allReach;
    if (!gctx.gateR) return { error: "a corridor needs Mini Gate or Heavy Gate among the tools" };
    const cor = search([src], dst, gctx, prog); expanded += cor.expanded;
    const sites = [src, ...cor.hops.map(h => index.get(h.to))];
    // 2. the catapult access to every site in order; each built pair is a two-way free hop from then on
    const actx = Object.assign({}, ctx, { gateR: 0 }); actx.reach = null;
    let at = src;
    for (let i = 1; i < sites.length; i++) {
      const site = sites[i], leg = search([at], site, actx, prog); expanded += leg.expanded;
      const hops = leg.hops.slice(); if (!leg.reached) hops.push(gapHop(leg.end, site));
      for (const h of leg.hops) if (!h.free && !h.gap) addBuilt(actx, index.get(h.from), index.get(h.to), h.kind);
      const g = cor.hops[i - 1]; const gate = { from: g.from, to: g.to, kind: g.kind, ly: g.ly, fromName: g.fromName, toName: g.toName, step: "gate" };
      addBuilt(actx, sites[i - 1], site, g.kind);
      legs.push({ from: ID[sites[i - 1]], to: ID[site], hops, reached: leg.reached, diagnostics: leg.reached ? null : diagnose(leg.end, site, actx) });
      steps.push(...hops, gate); at = site;
    }
    if (!cor.reached) { steps.push(gapHop(cor.end, dst)); legs.push({ from: ID[cor.end], to: ID[dst], hops: [gapHop(cor.end, dst)], reached: false, diagnostics: diagnose(cor.end, dst, gctx) }); }
    const hops = steps;
    return { hops, legs, steps, reached: cor.reached && legs.every(l => l.reached), diagnostics: cor.reached ? (legs.find(l => !l.reached) || {}).diagnostics || null : diagnose(cor.end, dst, gctx), direct: direct(src, dst, ctx), expanded, ms: Date.now() - t0, corridor: sites.map(i => ID[i]) };
  }
  // access (legs in order, each starting where the last ended) or tree (each target from the whole network built so far)
  const targets = [...stops, dst]; let seeds = [src]; const network = new Set([src]); let allHops = [], reached = true, diagnostics = null, back = null;
  for (const t of targets) {
    ctx.reach = ctx.gateR ? component(m.mode === "tree" ? [...network] : seeds, ctx) : null;
    const leg = search(m.mode === "tree" ? [...network] : seeds, t, ctx, prog); expanded += leg.expanded;
    const hops = leg.hops.slice(); if (!leg.reached) { hops.push(gapHop(leg.end, t)); reached = false; if (!diagnostics) diagnostics = diagnose(leg.end, t, ctx); }
    for (const h of leg.hops) { if (!h.free && !h.gap) addBuilt(ctx, index.get(h.from), index.get(h.to), h.kind); network.add(index.get(h.from)); network.add(index.get(h.to)); }
    network.add(t); legs.push({ from: ID[m.mode === "tree" ? (leg.hops.length ? index.get(leg.hops[0].from) : t) : seeds[0]], to: ID[t], hops, reached: leg.reached, diagnostics: leg.reached ? null : diagnose(leg.end, t, ctx) });
    allHops = allHops.concat(hops); seeds = [t];
  }
  if (m.roundTrip && reached) {                     // the way home: built gate pairs are two-way, built catapults are not
    const bctx = Object.assign({}, ctx); bctx.reach = ctx.gateR ? component([dst], bctx) : null;
    const b = search([dst], src, bctx, prog); expanded += b.expanded;
    const hops = b.hops.slice(); if (!b.reached) hops.push(gapHop(b.end, src));
    back = { hops, reached: b.reached, diagnostics: b.reached ? null : diagnose(b.end, src, bctx) };
  }
  return { hops: allHops, legs, steps: allHops, back, reached, diagnostics, direct: direct(src, dst, ctx), expanded, ms: Date.now() - t0 };
}

/* One jump by hand: every legal target of a structure from a star, the blocked ones, and the verdict for a target. */
function check(m) {
  const src = index.get(m.from); if (src == null) return { error: "unknown system" };
  const structure = m.structure || "Mini Catapult", r = RANGE[structure] || 60, cat = /Catapult/.test(structure), cand = [];
  const inRange = within(X[src], Y[src], Z[src], r, cand).filter(n => n !== src).map(n => [n, dist(src, n)]).sort((a, b) => a[1] - b[1]);
  const legalSet = cat ? new Set(catapultTargets(src, r).map(e => e[0])) : new Set(inRange.map(e => e[0]));
  const legal = inRange.filter(e => legalSet.has(e[0])).map(([n, d]) => [ID[n], +d.toFixed(1)]), blocked = inRange.filter(e => !legalSet.has(e[0])).map(([n, d]) => [ID[n], +d.toFixed(1)]);
  let target = null, stepTo = null;
  const t = m.target != null ? index.get(m.target) : null;
  if (t != null && t !== src) {
    const ly = dist(src, t), ok = ly <= r && legalSet.has(t);
    target = { id: ID[t], ly: +ly.toFixed(1), inRange: ly <= r, legal: ok, blockers: cat && ly <= r && !ok ? blockers(src, t).map(i => ({ id: ID[i], name: NAME ? NAME[i] : undefined, ly: +dist(src, i).toFixed(1) })) : [] };
    if (!ok) { let bd = ly; for (const n of legalSet) { const d = dist(n, t); if (d < bd) { bd = d; stepTo = ID[n]; } } }
  }
  return { legal, blocked, target, stepTo, range: r, structure };
}

onmessage = async e => {
  const m = e.data;
  try {
    await load(m.stars || "stars.bin?v=2");
    if (m.gates) await loadGates(m.gates);
    if (m.catapults) await loadCatapults(m.catapults);
    if (m.type === "plan") { const r = plan(m, (expanded, closest) => postMessage({ type: "progress", id: m.id, expanded, closest })); postMessage(Object.assign({ type: "done", id: m.id, graph: CATA ? "precomputed" : "on the fly" }, r)); }
    else if (m.type === "check") { postMessage(Object.assign({ type: "checked", id: m.id }, check(m))); }
  } catch (err) { postMessage({ type: m.type === "check" ? "checked" : "done", id: m.id, error: String(err && err.message || err) }); }
};
