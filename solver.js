/* Saints Forge solver (Web Worker). A port of the toolkit's ftk/lns.py (2026-10-08): per-section exact packing in the
   RootFit style (candidates enumerated once, cover maps by cell, bitset collision tests), a randomized-greedy
   arrangement of the required modules followed by an exact fill of the free cells with the filler modules the pilot
   chose, and a ruin-and-recreate loop that empties one to three sections at a time and re-packs them.

   Messages in:  {type:"init", hull, modules}            hull = {sections:[{cells:[[x,y],...]}]}, modules = {name:{cells}}
                 {type:"optimize", placements, mandatory, fillers, keepMin, seconds, seed, maxSections}
                 {type:"tryadd", placements, add, seconds, seed}
                 {type:"stop"}
   Messages out: {type:"progress", placements, value, iterations, gains}  {type:"done", ...same}
   placements: [[label, section, rot, cells]] in the page's (screen) orientation. */
"use strict";

let HULL = null;           // {n, cells:[[(x,y)...]], index:[Map "x,y"->bit], words, full:[Uint32Array]}
let SHAPES = null;         // name -> [[rot, cells]]
let PLACE = new Map();     // key s|name -> {list:[placement], cover: Map(bit -> [placement]), bySize}
let STOP = false;
const IN_WORKER = typeof WorkerGlobalScope !== "undefined";
function emit(m) { if (IN_WORKER) postMessage(m); else if (self.ForgeSolver && self.ForgeSolver.onmessage) self.ForgeSolver.onmessage(m); }

function key(x, y) { return x + "," + y; }

function rotations(cells) {
  const out = [], seen = new Set();
  let cur = cells.map(c => [c[0], c[1]]);
  for (let rot = 0; rot < 360; rot += 90) {
    const minx = Math.min(...cur.map(c => c[0])), miny = Math.min(...cur.map(c => c[1]));
    const norm = cur.map(c => [c[0] - minx, c[1] - miny]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const k = norm.map(c => c.join(",")).join("|");
    if (!seen.has(k)) { seen.add(k); out.push([rot, norm]); }
    cur = cur.map(c => [c[1], -c[0]]);        // rotate 90°
  }
  return out;
}

function init(hull, modules) {
  const sections = hull.sections.map(s => s.cells.map(c => [c[0], c[1]]));
  HULL = { n: sections.length, cells: sections, index: [], words: 0, full: [], cellList: [] };
  for (let s = 0; s < HULL.n; s++) {
    const order = sections[s].slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);   // row-major: top-left first
    const idx = new Map(); order.forEach((c, i) => idx.set(key(c[0], c[1]), i));
    HULL.index.push(idx); HULL.cellList.push(order);
    HULL.words = Math.max(HULL.words, Math.ceil(order.length / 32));
  }
  for (let s = 0; s < HULL.n; s++) {
    const f = new Uint32Array(HULL.words);
    for (let i = 0; i < HULL.cellList[s].length; i++) f[i >>> 5] |= (1 << (i & 31)) >>> 0;
    HULL.full.push(f);
  }
  SHAPES = {};
  for (const name in modules) SHAPES[name] = rotations(modules[name].cells);
  PLACE = new Map();
}

function placementsOf(s, name) {
  const k = s + "|" + name;
  if (PLACE.has(k)) return PLACE.get(k);
  const idx = HULL.index[s], list = [], cover = new Map();
  for (const [rot, shape] of SHAPES[name]) {
    for (const [ax, ay] of HULL.cellList[s]) {
      const cells = shape.map(c => [c[0] + ax, c[1] + ay]);
      const bits = cells.map(c => idx.get(key(c[0], c[1])));
      if (bits.some(b => b === undefined)) continue;
      const mask = new Uint32Array(HULL.words);
      for (const b of bits) mask[b >>> 5] |= (1 << (b & 31)) >>> 0;
      const p = { s, rot, cells, bits, mask, corner: Math.min(...bits) };
      list.push(p);
      for (const b of bits) { if (!cover.has(b)) cover.set(b, []); cover.get(b).push(p); }
    }
  }
  list.sort((a, b) => a.corner - b.corner);
  const r = { list, cover }; PLACE.set(k, r); return r;
}

function fits(mask, free) { for (let w = 0; w < mask.length; w++) if ((mask[w] & ~free[w]) !== 0) return false; return true; }
function take(free, mask) { for (let w = 0; w < mask.length; w++) free[w] = (free[w] & ~mask[w]) >>> 0; }
function give(free, mask) { for (let w = 0; w < mask.length; w++) free[w] = (free[w] | mask[w]) >>> 0; }
function popcount(x) { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }
function countFree(free) { let n = 0; for (const f of free) for (let w = 0; w < f.length; w++) n += popcount(f[w]); return n; }
function lowestBit(f) { for (let w = 0; w < f.length; w++) if (f[w]) { const v = f[w]; let b = 0; while (!((v >>> b) & 1)) b++; return w * 32 + b; } return -1; }
function anyFree(f) { for (let w = 0; w < f.length; w++) if (f[w]) return true; return false; }

/* Waste of a placement = free cells touching it after it is taken (fewer = tighter). */
function waste(s, p, free) {
  const idx = HULL.index[s]; let w = 0;
  const own = new Set(p.bits);
  for (const [x, y] of p.cells) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const b = idx.get(key(x + dx, y + dy));
    if (b !== undefined && !own.has(b) && ((free[b >>> 5] >>> (b & 31)) & 1)) w++;
  }
  return w;
}

/* Exact-ish pack of the free cells of the chosen sections: every label in `mandatory` placed, then fillers by value.
   Returns {value, placed:[[label,s,rot,cells]]} or null. */
function pack(free0, mandatory, fillers, values, budget, rnd) {
  const n = HULL.n;
  const active = [];
  for (let s = 0; s < n; s++) if (anyFree(free0[s])) active.push(s);
  const steps = { n: 0 };
  // per-cell bound: best filler value density of any filler placement covering the cell
  const density = {}; for (const f of fillers) density[f] = values[f] / SHAPES[f][0][1].length;
  const cellBound = active.map(() => new Map());
  for (let i = 0; i < active.length; i++) {
    const s = active[i];
    for (const f of fillers) {
      const { cover } = placementsOf(s, f);
      for (const [bit, lst] of cover) if (lst.some(p => fits(p.mask, free0[s]))) cellBound[i].set(bit, Math.max(cellBound[i].get(bit) || 0, density[f]));
    }
  }
  function bound(free) {
    let t = 0;
    for (let i = 0; i < active.length; i++) {
      const s = active[i], f = free[s], cb = cellBound[i];
      for (const [bit, d] of cb) if ((f[bit >>> 5] >>> (bit & 31)) & 1) t += d;
    }
    return t;
  }
  const best = { value: -1, placed: null };
  function fillExact(free, placed, value) {
    steps.n++;
    if (value > best.value) { best.value = value; best.placed = placed.slice(); }
    if (steps.n > budget) return;
    let s = -1; for (const a of active) if (anyFree(free[a])) { s = a; break; }
    if (s < 0) return;
    if (value + bound(free) <= best.value) return;
    const low = lowestBit(free[s]);
    for (const f of fillers) {
      const lst = placementsOf(s, f).cover.get(low);
      if (!lst) continue;
      for (const p of lst) {
        if (!fits(p.mask, free[s])) continue;
        take(free[s], p.mask); placed.push([f, s, p.rot, p.cells]);
        fillExact(free, placed, value + values[f]);
        placed.pop(); give(free[s], p.mask);
        if (steps.n > budget) return;
      }
    }
    free[s][low >>> 5] = (free[s][low >>> 5] & ~((1 << (low & 31)) >>> 0)) >>> 0;
    fillExact(free, placed, value);
    free[s][low >>> 5] = (free[s][low >>> 5] | ((1 << (low & 31)) >>> 0)) >>> 0;
  }
  const bigFirst = mandatory.slice().sort((a, b) => SHAPES[b][0][1].length - SHAPES[a][0][1].length);
  let restart = 0;
  while (steps.n <= budget && !STOP) {
    restart++;
    const order = restart === 1 ? bigFirst : mandatory.slice().sort((a, b) => (SHAPES[b][0][1].length - SHAPES[a][0][1].length) + (rnd() - 0.5) * 10);
    const free = free0.map(f => Uint32Array.from(f));
    const placed = [];
    let ok = true;
    for (const l of order) {
      let bestOpt = null, bestW = Infinity;
      for (const s of active) {
        if (!anyFree(free[s])) continue;
        for (const p of placementsOf(s, l).list) {
          if (!fits(p.mask, free[s])) continue;
          const w = waste(s, p, free[s]) + (restart === 1 ? 0 : rnd() * 2.5);
          if (w < bestW) { bestW = w; bestOpt = p; }
        }
      }
      if (!bestOpt) { ok = false; break; }
      take(free[bestOpt.s], bestOpt.mask); placed.push([l, bestOpt.s, bestOpt.rot, bestOpt.cells]);
    }
    steps.n += 50;
    if (!ok) { if (restart > 20 && !best.placed) return null; continue; }
    if (best.placed && bound(free) <= best.value) continue;
    fillExact(free, placed, 0);
  }
  return best.placed ? best : null;
}

function occupancy(placements) {
  const free = HULL.full.map(f => Uint32Array.from(f));
  for (const [, s, , cells] of placements) {
    const idx = HULL.index[s];
    for (const [x, y] of cells) { const b = idx.get(key(x, y)); if (b !== undefined) free[s][b >>> 5] = (free[s][b >>> 5] & ~((1 << (b & 31)) >>> 0)) >>> 0; }
  }
  return free;
}

function valueOf(placements, fillers, values) {
  let v = 0; for (const [l] of placements) if (values[l]) v += values[l]; return v;
}

function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

/* Ruin-and-recreate for `seconds`. mandatory = labels never removed (everything that is not a filler); keepMin = minimum
   counts of fillers that must survive (re-placed as mandatory in the ruined sections). */
function optimize(msg) {
  const { placements, fillers, values, keepMin, seconds, seed, maxSections } = msg;
  const rnd = rng(seed || 1);
  const fillSet = new Set(fillers);
  let cur = placements.map(p => [p[0], p[1], p[2], p[3]]);
  let curValue = valueOf(cur, fillers, values);
  const t0 = Date.now(); let it = 0, gains = 0, lastPost = 0;
  const trace = [[0, curValue]];                     // [ms, value] at every strict gain: how fast the search converges
  const n = HULL.n;
  while (Date.now() - t0 < seconds * 1000 && !STOP) {
    it++;
    const k = n === 1 || rnd() < 0.3 ? 1 : 2 + Math.floor(rnd() * Math.min(maxSections || 3, n) - 1 + 0.999);
    const chosen = new Set(); while (chosen.size < Math.min(k, n)) chosen.add(Math.floor(rnd() * n));
    const keep = cur.filter(p => !chosen.has(p[1])), gone = cur.filter(p => chosen.has(p[1]));
    const mandatory = gone.filter(p => !fillSet.has(p[0])).map(p => p[0]);
    const outside = {}; for (const p of keep) outside[p[0]] = (outside[p[0]] || 0) + 1;
    for (const f in keepMin) for (let i = 0; i < Math.max(0, keepMin[f] - (outside[f] || 0)); i++) mandatory.push(f);
    const free = HULL.full.map((f, s) => chosen.has(s) ? Uint32Array.from(f) : new Uint32Array(HULL.words));
    const res = pack(free, mandatory, fillers, values, k === 1 ? 60000 : 120000, rnd);
    if (!res) continue;
    const cand = keep.concat(res.placed);
    const counts = {}; for (const p of cand) counts[p[0]] = (counts[p[0]] || 0) + 1;
    let okMin = true; for (const f in keepMin) if ((counts[f] || 0) < keepMin[f]) okMin = false;
    if (!okMin) continue;
    const v = valueOf(cand, fillers, values);
    if (v >= curValue) {
      const gain = v > curValue;
      if (gain) { gains++; trace.push([Date.now() - t0, v]); }
      cur = cand; curValue = v;
      if (gain || Date.now() - lastPost > 400) { lastPost = Date.now(); emit({ type: "progress", placements: cur, value: curValue, iterations: it, gains }); }
    }
  }
  emit({ type: "done", placements: cur, value: curValue, iterations: it, gains, seconds: (Date.now() - t0) / 1000, trace });
}

/* Try to add modules: first a direct spot for each; if none, ruin-and-recreate with the new modules mandatory. */
function tryAdd(msg) {
  const { placements, add, seconds, seed } = msg;
  const rnd = rng(seed || 1);
  let cur = placements.map(p => [p[0], p[1], p[2], p[3]]);
  const left = add.slice();
  // pass 1: direct placement, tightest spot
  for (const l of left.slice()) {
    const free = occupancy(cur);
    let bestOpt = null, bestW = Infinity;
    for (let s = 0; s < HULL.n; s++) for (const p of placementsOf(s, l).list) {
      if (!fits(p.mask, free[s])) continue;
      const w = waste(s, p, free[s]);
      if (w < bestW) { bestW = w; bestOpt = p; }
    }
    if (bestOpt) { cur.push([l, bestOpt.s, bestOpt.rot, bestOpt.cells]); left.splice(left.indexOf(l), 1); }
  }
  if (!left.length) { emit({ type: "done", placements: cur, added: add.length, missing: [] }); return; }
  // pass 2: ruin-and-recreate with the missing modules as mandatory in the ruined sections. The sections' own
  // fillers (containers, capacitors) are re-placed by the exact fill, and the result counts only if none is lost.
  const FILL = ["Cargo Container", "Emergency Container", "Capacitor"].filter(f => SHAPES[f]);
  const vals = { "Cargo Container": 36, "Emergency Container": 25, "Capacitor": 12 };
  const before = {}; for (const p of cur) before[p[0]] = (before[p[0]] || 0) + 1;
  const t0 = Date.now(); const n = HULL.n; let it = 0;
  while (Date.now() - t0 < seconds * 1000 && left.length && !STOP) {
    it++;
    const k = Math.min(n, 1 + Math.floor(rnd() * 3));
    const chosen = new Set(); while (chosen.size < k) chosen.add(Math.floor(rnd() * n));
    const keep = cur.filter(p => !chosen.has(p[1])), gone = cur.filter(p => chosen.has(p[1]));
    const fillers = FILL.filter(f => !left.includes(f));
    const mandatory = gone.filter(p => !fillers.includes(p[0])).map(p => p[0]).concat(left);
    const free = HULL.full.map((f, s) => chosen.has(s) ? Uint32Array.from(f) : new Uint32Array(HULL.words));
    const res = pack(free, mandatory, fillers, vals, 60000, rnd);
    if (!res) continue;
    const cand = keep.concat(res.placed);
    const counts = {}; for (const p of cand) counts[p[0]] = (counts[p[0]] || 0) + 1;
    let lost = false; for (const f of fillers) if ((counts[f] || 0) < (before[f] || 0)) lost = true;
    if (lost) continue;
    cur = cand; left.length = 0; break;
  }
  emit({ type: "done", placements: cur, added: add.length - left.length, missing: left, iterations: it });
}

/* Finishing polish: each section on its own, re-packed from scratch with a big budget and several seeds (the
   mandatory modules of that section re-arranged, the fillers re-dealt), kept when the value rises. Deterministic
   given the seed; bounded by `seconds`. */
function polish(msg) {
  const { placements, fillers, values, keepMin, seconds, seed, tries } = msg;
  const rnd = rng(seed || 3);
  const fillSet = new Set(fillers);
  let cur = placements.map(p => [p[0], p[1], p[2], p[3]]);
  let curValue = valueOf(cur, fillers, values);
  const t0 = Date.now(); let gains = 0, it = 0;
  const n = HULL.n;
  outer: for (let round = 0; round < 2; round++) {
    for (let s = 0; s < n; s++) {
      for (let t = 0; t < (tries || 6); t++) {
        if (Date.now() - t0 > seconds * 1000 || STOP) break outer;
        it++;
        const keep = cur.filter(p => p[1] !== s), gone = cur.filter(p => p[1] === s);
        const mandatory = gone.filter(p => !fillSet.has(p[0])).map(p => p[0]);
        const outside = {}; for (const p of keep) outside[p[0]] = (outside[p[0]] || 0) + 1;
        for (const f in keepMin) for (let i = 0; i < Math.max(0, keepMin[f] - (outside[f] || 0)); i++) mandatory.push(f);
        const free = HULL.full.map((f, k) => k === s ? Uint32Array.from(f) : new Uint32Array(HULL.words));
        const res = pack(free, mandatory, fillers, values, 400000, rnd);
        if (!res) continue;
        const cand = keep.concat(res.placed);
        const counts = {}; for (const p of cand) counts[p[0]] = (counts[p[0]] || 0) + 1;
        let okMin = true; for (const f in keepMin) if ((counts[f] || 0) < keepMin[f]) okMin = false;
        if (!okMin) continue;
        const v = valueOf(cand, fillers, values);
        if (v > curValue) { gains++; cur = cand; curValue = v; emit({ type: "progress", placements: cur, value: curValue, iterations: it, gains }); }
      }
    }
  }
  emit({ type: "done", placements: cur, value: curValue, iterations: it, gains, seconds: (Date.now() - t0) / 1000 });
}

function handle(m) {
  if (m.type === "init") { init(m.hull, m.modules); emit({ type: "ready" }); }
  else if (m.type === "optimize") { STOP = false; optimize(m); }
  else if (m.type === "tryadd") { STOP = false; tryAdd(m); }
  else if (m.type === "polish") { STOP = false; polish(m); }
  else if (m.type === "stop") { STOP = true; }
}
if (IN_WORKER) self.onmessage = e => handle(e.data);
else self.ForgeSolver = Object.assign(self.ForgeSolver || {}, { post: handle });   // main-thread fallback (no Worker)
