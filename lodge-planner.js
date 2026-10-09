/* The Mason's Lodge planner: goals -> whole runs per recipe, what to gather, what is left over. Pure (no page code).
   plan() = the exact planner (integer linear program, below), started from and falling back to the quick greedy one.
   window.LodgePlanner.plan(D, opt) with D = window.LODGE_DATA and
     opt = { goals: [{item, qty}], facilities: [keys], mode: "ore" | "time", salvage: "first" | "use",
             have: {item: qty}, routes: {item: recipeId} }
   Route per item: among the ticked facilities, the recipe with the least found-only material first (salvage, loot,
   unknown: things no recipe makes), then the least ore (mode "ore") or the least facility time (mode "time"),
   counted all the way down; ties go to the faster recipe. "Ore first" treats salvage as found-only; "Ore + salvage"
   counts it like ore. Whole runs, by-products credited, a shortfall covered by an extra run of a recipe already in the
   plan when that costs at most 3x a new chain (no tiny side-mines), then every run that is not needed is trimmed. */
(function (root) {
  "use strict";
  const EPS = 1e-9, INF = [Infinity, Infinity];
  const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
  const better = (a, b) => a[0] < b[0] - EPS || (Math.abs(a[0] - b[0]) <= EPS && a[1] < b[1] - EPS);
  const same = (a, b) => Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS;

  function solve(D, opt) {
    const facs = new Set(opt.facilities || []); facs.add("Build Mode");
    const have = opt.have || {};
    const time = opt.mode === "time";
    const byId = {}, allMakers = {}, makers = {};
    for (const r of D.recipes) {
      byId[r.id] = r;
      for (const o in r.out) {
        (allMakers[o] = allMakers[o] || []).push(r);
        if (facs.has(r.f)) (makers[o] = makers[o] || []).push(r);
      }
    }
    const kindOf = item => (D.sources[item] || { k: "unknown" }).k;
    const isRaw = item => !allMakers[item];
    const found = item => { const k = kindOf(item); return !(k === "mine" || k === "extract" || (k === "cut" && opt.salvage === "use")); };

    // cost of one unit: [found-only units, ore units or facility seconds]
    const memo = {};
    function cost(item, stack) {
      if (memo[item]) return memo[item];
      if (isRaw(item)) return memo[item] = [found(item) ? 1 : 0, time ? 0 : 1];
      if (stack.has(item)) return INF;
      stack.add(item);
      let best = INF, bestT = Infinity;
      for (const r of makers[item] || []) {
        const c = perUnit(r, item, stack), t = (r.t == null ? 999 : r.t) / r.out[item];
        if (better(c, best) || (same(c, best) && t < bestT)) { best = c; bestT = t; }
      }
      stack.delete(item);
      if (isFinite(best[0]) || stack.size === 0) memo[item] = best;
      return best;
    }
    function runCost(r, stack) {
      let f = 0, p = time ? (r.t == null ? 999 : r.t) : 0;
      for (const i in r.in) { const c = cost(i, stack || new Set()); f += r.in[i] * c[0]; p += r.in[i] * c[1]; }
      return [f, p];
    }
    const perUnit = (r, item, stack) => { const c = runCost(r, stack); return [c[0] / r.out[item], c[1] / r.out[item]]; };

    // the chosen recipe per item (a pilot's own choice wins when it is still possible)
    const route = {}, options = {};
    function pick(item) {
      if (item in route) return route[item];
      const list = makers[item] || [];
      if (list.length > 1) options[item] = list.map(r => ({ id: r.id, cost: perUnit(r, item, new Set()) }));
      const own = opt.routes && opt.routes[item] && list.find(r => r.id === opt.routes[item]);
      let best = own || null;
      if (!best) {
        let bc = INF, bt = Infinity;
        for (const r of list) {
          const c = perUnit(r, item, new Set()), t = (r.t == null ? 999 : r.t) / r.out[item];
          if (better(c, bc) || (same(c, bc) && t < bt)) { best = r; bc = c; bt = t; }
        }
        if (best && !isFinite(bc[0])) best = null;
      }
      return route[item] = best;
    }

    const goals = (opt.goals || []).filter(g => g.item && g.qty > 0);
    const runs = new Map();
    function balance() {
      const need = {}, made = {};
      for (const g of goals) add(need, g.item, g.qty);
      for (const [id, n] of runs) {
        if (!n) continue;
        const r = byId[id];
        for (const i in r.in) add(need, i, r.in[i] * n);
        for (const o in r.out) add(made, o, r.out[o] * n);
      }
      return { need, made };
    }
    const shortOf = (item, b) => (b.need[item] || 0) - (have[item] || 0) - (b.made[item] || 0);

    // depth: goals 0, a route's inputs one deeper (for the work order and for picking shortfalls top-down)
    const depth = {};
    function deepen(item, d, seen) {
      if ((depth[item] != null && depth[item] >= d) || seen.has(item) || d > 60) return;
      depth[item] = d;
      const r = pick(item); if (!r) return;
      seen.add(item);
      for (const i in r.in) deepen(i, d + 1, seen);
      seen.delete(item);
    }
    for (const g of goals) deepen(g.item, 0, new Set());

    function fill(banned) {
      for (let iter = 0; iter < 20000; iter++) {
        const b = balance();
        const pending = Object.keys(b.need).filter(i => shortOf(i, b) > EPS && pick(i));
        if (!pending.length) return;
        for (const i of pending) if (!(i in depth)) deepen(i, 1, new Set());
        pending.sort((x, y) => (depth[x] || 0) - (depth[y] || 0));
        // an item another pending item's recipe also makes waits: its by-product may cover it
        const item = pending.find(x => !pending.some(y => y !== x && route[y] && route[y].out[x])) || pending[0];
        const net = shortOf(item, b), r = route[item];
        let use = r, n = Math.ceil(net / r.out[item] - EPS);
        if ((opt.bump || banned.has(r.id)) && !runs.get(r.id)) {
          const rc = runCost(r).map(v => v * n);
          for (const [id, k] of runs) {
            const s = byId[id];
            if (!k || s === r || !s.out[item]) continue;
            const m = Math.ceil(net / s.out[item] - EPS), sc = runCost(s).map(v => v * m);
            if (banned.has(r.id) || (sc[0] <= rc[0] + EPS && sc[1] <= 3 * rc[1] + EPS)) { use = s; n = m; break; }
          }
        }
        runs.set(use.id, (runs.get(use.id) || 0) + n);
      }
    }

    // trim: drop every run the plan can do without (rounding and by-products leave some)
    const ok = () => { const b = balance(); return Object.keys(b.need).every(i => isRaw(i) || !pick(i) || shortOf(i, b) <= EPS); };
    function trim() {
      for (let changed = true, guard = 0; changed && guard < 50; guard++) {
        changed = false;
        for (const [id, n] of [...runs].sort((a, b) => b[1] - a[1])) {
          if (!n) continue;
          let k = n;
          while (k > 0) { runs.set(id, k - 1); if (ok()) { k--; changed = true; } else { runs.set(id, k); break; } }
        }
      }
    }
    // what a plan costs: found-only units, then ore (or seconds), then how many different things to gather
    function score() {
      const b = balance(); let f = 0, p = 0, kinds = 0;
      for (const i in b.need) {
        const s = shortOf(i, b);
        if (s > EPS && isRaw(i)) { kinds++; if (found(i)) f += s; else if (!time) p += s; }
      }
      if (time) for (const [id, n] of runs) p += (byId[id].t || 0) * n;
      return [f, p, kinds];
    }
    // a is worse than b: more found-only units; or, with fewer things to gather, over 10 % more ore/time; with more
    // things to gather, not at least 10 % cheaper; with as many, simply more
    const worse = (a, b) => {
      if (Math.abs(a[0] - b[0]) > EPS) return a[0] > b[0];
      if (a[2] < b[2]) return a[1] > b[1] * 1.1 + EPS;
      if (a[2] > b[2]) return a[1] * 1.1 > b[1] + EPS;
      return a[1] > b[1] + EPS;
    };

    fill(new Set()); trim();
    // improve: take out each small chain and refill from what is already planned; keep it when the plan gets better
    if (opt.bump) {
      for (const id of [...runs.keys()]) {
        if (!runs.get(id)) continue;
        const before = new Map(runs), sc = score();
        runs.set(id, 0); fill(new Set([id])); trim();
        if (!ok() || worse(score(), sc)) { runs.clear(); for (const [k, v] of before) runs.set(k, v); }
      }
    }

    const b = balance();
    const gather = [], blocked = [], used = {};
    for (const item of Object.keys(b.need)) {
      const want = b.need[item] - (b.made[item] || 0);
      if (have[item] && want > 0) used[item] = Math.min(have[item], want);
      const s = shortOf(item, b);
      if (s <= EPS) continue;
      if (isRaw(item)) {
        const src = D.sources[item] || { k: "unknown", h: "" };
        const forWhat = [...new Set([...runs].filter(([id, n]) => n && byId[id].in[item]).map(([id]) => Object.keys(byId[id].out)[0]))];
        gather.push({ item, qty: Math.ceil(s - EPS), kind: src.k, hint: src.h, found: found(item), cut: src.k === "cut", for: forWhat, have: have[item] || 0 });
      } else if (!pick(item)) {
        const facsThatMake = [...new Set(allMakers[item].map(r => r.f))];
        blocked.push({ item, qty: Math.ceil(s - EPS), facilities: facsThatMake });
      }
    }
    const steps = [];
    for (const [id, n] of runs) {
      if (!n) continue;
      const r = byId[id];
      const d = Math.max(...Object.keys(r.out).map(o => depth[o] == null ? 0 : depth[o]));
      const ins = {}, outs = {};
      for (const i in r.in) ins[i] = r.in[i] * n;
      for (const o in r.out) outs[o] = r.out[o] * n;
      steps.push({ id, recipe: r, runs: n, depth: d, secs: (r.t || 0) * n, ins, outs, unverified: !!r.u });
    }
    const spare = {};
    for (const o in b.made) { const s = (b.made[o] || 0) + (have[o] || 0) - (b.need[o] || 0); if (s > EPS && b.made[o]) spare[o] = Math.round(s); }
    const opts = {};
    for (const item in options) if (b.need[item] || goals.some(g => g.item === item)) opts[item] = options[item];
    return { steps, gather, blocked, spare, used, need: b.need, routes: Object.fromEntries(Object.entries(route).filter(([, r]) => r).map(([i, r]) => [i, r.id])), options: opts,
             ore: gather.filter(g => !g.found).reduce((s, g) => s + g.qty, 0), foundUnits: gather.filter(g => g.found).reduce((s, g) => s + g.qty, 0),
             secs: steps.reduce((s, x) => s + x.secs, 0) };
  }

  // Ore first, but salvage already in the hold is used when switching to Ore + salvage needs no extra cutting and
  // saves ore.
  // the greedy is run twice, with and without covering shortfalls by extra runs of recipes already planned; fewer
  // things to gather wins only when it costs at most 10 % more
  function best(D, opt) {
    const a = solve(D, Object.assign({}, opt, { bump: false })), b = solve(D, Object.assign({}, opt, { bump: true }));
    const prim = r => opt.mode === "time" ? r.secs : r.ore;
    if (a.blocked.length !== b.blocked.length) return a.blocked.length < b.blocked.length ? a : b;
    if (a.foundUnits !== b.foundUnits) return a.foundUnits < b.foundUnits ? a : b;
    if (b.gather.length < a.gather.length && prim(b) <= prim(a) * 1.1) return b;
    if (a.gather.length < b.gather.length && prim(a) <= prim(b) * 1.1) return a;
    return prim(b) < prim(a) ? b : a;
  }

  function planGreedy(D, opt) {
    const base = best(D, opt);
    if (opt.salvage !== "first") return base;
    const held = (D.salvage || []).filter(s => (opt.have || {})[s] > 0);
    if (!held.length) return base;
    const alt = best(D, Object.assign({}, opt, { salvage: "use" }));
    if (!alt.blocked.length && !alt.gather.some(g => g.kind === "cut" && (D.salvage || []).includes(g.item)) && alt.ore < base.ore) {
      alt.note = "Uses the salvage you already have (" + held.join(", ") + "): " + (base.ore - alt.ore).toLocaleString("en-US") + " less ore.";
      return alt;
    }
    return base;
  }

  // ================= exact planner: an integer linear program =================
  // Unknowns: x_r = runs of recipe r (whole numbers), g_i = units of raw item i to gather, b_i = units of an item no ticked
  // facility makes ("blocked"). For every item: held + made + gathered - used >= wanted. Cost, in order of importance:
  // blocked units, found-only units (salvage under Ore first, loot, unknown), then ore (or facility seconds when
  // "fastest"), with a tiny tie-break on the other so idle runs never appear. Solved by simplex + branch and bound, so
  // the plan is the least-ore plan there is ("proven"), or the best found in the time allowed. Held items, salvage
  // included, simply count as held: partial stocks are used for what they cover.

  function simplex(c, A, b) {
    // minimise c.x subject to A x >= b, x >= 0 (dense, two-phase; Dantzig's rule, Bland's after many pivots)
    const m = A.length, n = c.length;
    const artRows = []; for (let i = 0; i < m; i++) if (b[i] > 1e-9) artRows.push(i);
    const W = n + m + artRows.length, T = new Array(m), basis = new Array(m);
    let a = 0;
    for (let i = 0; i < m; i++) {
      const row = new Float64Array(W + 1), pos = b[i] > 1e-9;
      for (let j = 0; j < n; j++) row[j] = pos ? A[i][j] : -A[i][j];
      row[n + i] = pos ? -1 : 1;
      row[W] = pos ? b[i] : Math.max(0, -b[i]);
      if (pos) { row[n + m + a] = 1; basis[i] = n + m + a; a++; } else basis[i] = n + i;
      T[i] = row;
    }
    let z = new Float64Array(W + 1);
    function pivot(r, s) {
      const pr = T[r], pv = pr[s];
      for (let j = 0; j <= W; j++) pr[j] /= pv;
      for (let i = 0; i < m; i++) if (i !== r) { const f = T[i][s]; if (f !== 0) { const ri = T[i]; for (let j = 0; j <= W; j++) ri[j] -= f * pr[j]; } }
      const f = z[s]; if (f !== 0) for (let j = 0; j <= W; j++) z[j] -= f * pr[j];
      basis[r] = s;
    }
    let capped = false;
    function optimise(cols) {
      for (let it = 0; it < 20000; it++) {
        let s = -1, best = -1e-9;
        if (it < 3000) { for (let j = 0; j < cols; j++) if (z[j] < best) { best = z[j]; s = j; } }
        else { for (let j = 0; j < cols; j++) if (z[j] < -1e-9) { s = j; break; } }
        if (s < 0) return true;
        let r = -1, ratio = Infinity;
        for (let i = 0; i < m; i++) { const v = T[i][s]; if (v > 1e-9) { const q = T[i][W] / v; if (q < ratio - 1e-12 || (Math.abs(q - ratio) <= 1e-12 && basis[i] < basis[r])) { ratio = q; r = i; } } }
        if (r < 0) return false;                       // unbounded
        pivot(r, s);
      }
      capped = true;                                   // pivot cap: the result is not trustworthy as a bound
      return true;
    }
    // phase 1: drive the artificial variables to zero
    for (let k = 0; k < artRows.length; k++) z[n + m + k] = 1;
    for (let i = 0; i < m; i++) if (basis[i] >= n + m) { const ri = T[i]; for (let j = 0; j <= W; j++) z[j] -= ri[j]; }
    optimise(W);
    if (-z[W] > 1e-6) return null;                     // infeasible
    for (let i = 0; i < m; i++) if (basis[i] >= n + m) {
      for (let j = 0; j < n + m; j++) if (Math.abs(T[i][j]) > 1e-9) { pivot(i, j); break; }
    }
    // phase 2: the real objective, artificial columns barred
    z = new Float64Array(W + 1);
    for (let j = 0; j < n; j++) z[j] = c[j];
    for (let i = 0; i < m; i++) { const cb = basis[i] < n ? c[basis[i]] : 0; if (cb !== 0) { const ri = T[i]; for (let j = 0; j <= W; j++) z[j] -= cb * ri[j]; } }
    if (!optimise(n + m)) return null;
    const x = new Float64Array(n);
    for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][W];
    let obj = 0; for (let j = 0; j < n; j++) obj += c[j] * x[j];
    return { x, obj, capped };
  }

  // the item a recipe is "for": the output it is named after ("Reinforced Alloys (from ore)" -> Reinforced Alloys).
  // Refines named after their input (Massive Ataxite Matrix -> Silica, Iron-Rich, Palladium) are for no single item:
  // by-product makers, never touched by a route choice. mainOut falls back to the largest output, ties by name.
  const madeFor = r => { const outs = Object.keys(r.out); return outs.find(o => r.name === o || r.name.startsWith(o + " (")) || null; };
  const mainOut = r => madeFor(r) || Object.keys(r.out).slice().sort((p, q) => r.out[q] - r.out[p] || p.localeCompare(q))[0];

  function exactPlan(D, opt, greedy, seeds) {
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const facs = new Set(opt.facilities || []); facs.add("Build Mode");
    const have = opt.have || {}, time = opt.mode === "time";
    const goals = (opt.goals || []).filter(g => g.item && g.qty > 0);
    const allMakers = {}; for (const r of D.recipes) for (const o in r.out) (allMakers[o] = allMakers[o] || []).push(r);
    const kindOf = item => (D.sources[item] || { k: "unknown" }).k;
    const found = item => { const k = kindOf(item); return !(k === "mine" || k === "extract" || (k === "cut" && opt.salvage === "use")); };
    let pool = D.recipes.filter(r => facs.has(r.f));
    if (opt.only) { const only = new Set(opt.only); pool = pool.filter(r => only.has(r.id)); }   // the cascade: this plan's recipes only
    for (const item in (opt.routes || {})) {                 // the pilot's choice: other recipes made FOR that item are out
      const keep = opt.routes[item];
      if (pool.some(r => r.id === keep && r.out[item])) pool = pool.filter(r => r.id === keep || madeFor(r) !== item);
    }
    const makers = {}; for (const r of pool) for (const o in r.out) (makers[o] = makers[o] || []).push(r);
    // everything that can matter, starting from the goals
    const expanded = new Set(), rowItems = new Set(), recs = new Set(), queue = goals.map(g => g.item);
    while (queue.length) {
      const item = queue.pop();
      rowItems.add(item);
      if (expanded.has(item)) continue;
      expanded.add(item);
      for (const r of makers[item] || []) if (!recs.has(r)) {
        recs.add(r);
        for (const i in r.in) queue.push(i);
        for (const o in r.out) rowItems.add(o);
      }
    }
    const R = [...recs], items = [...rowItems];
    const isRaw = i => !allMakers[i], isBlocked = i => !!allMakers[i] && !makers[i];
    // weights: one blocked unit outweighs any number of found units, one found unit any amount of ore (scaled to the
    // size of the build, from the quick plan)
    const prim0 = Math.max(100, time ? greedy.secs : greedy.ore);
    const Wf = prim0 * 20 + 1000, Wb = Wf * (greedy.foundUnits + 20) * 20, eps = 1e-3;

    function build(forbid) {
      const vars = [];                                     // {kind: 'x'|'g'|'b', ref, cost}
      for (const r of R) vars.push({ kind: "x", ref: r, cost: time ? (r.t == null ? 999 : r.t) : eps * (r.t == null ? 999 : r.t) });
      for (const i of items) {
        if (isRaw(i) && !forbid.has(i)) vars.push({ kind: "g", ref: i, cost: found(i) ? Wf : (time ? eps : 1) });
        else if (isBlocked(i)) vars.push({ kind: "b", ref: i, cost: Wb });
      }
      const col = new Map(vars.map((v, j) => [v.kind === "x" ? v.ref.id : v.kind + ":" + v.ref, j]));
      const A = [], rhs = [];
      const goalOf = {}; for (const g of goals) goalOf[g.item] = (goalOf[g.item] || 0) + g.qty;
      for (const i of items) {
        const row = new Float64Array(vars.length);
        R.forEach((r, j) => { row[j] = (r.out[i] || 0) - (r.in[i] || 0); });
        if (col.has("g:" + i)) row[col.get("g:" + i)] = 1;
        if (col.has("b:" + i)) row[col.get("b:" + i)] = 1;
        A.push(row); rhs.push((goalOf[i] || 0) - (have[i] || 0));
      }
      return { vars, col, A, rhs, c: vars.map(v => v.cost), nx: R.length };
    }
    function solveNode(M, lo, hi) {
      const A = M.A.slice(), b = M.rhs.slice();
      for (const j in lo) { const row = new Float64Array(M.vars.length); row[j] = 1; A.push(row); b.push(lo[j]); }
      for (const j in hi) { const row = new Float64Array(M.vars.length); row[j] = -1; A.push(row); b.push(-hi[j]); }
      return simplex(M.c, A, b);
    }
    function costOf(M, runs) {                             // an integer start: the quick plan, priced in this model
      const x = new Float64Array(M.vars.length);
      for (const [id, n] of runs) {
        if (!M.col.has(id) || (opt.cap && opt.cap[id] != null && n > opt.cap[id])) return null;   // not in this model, or over a cap
        x[M.col.get(id)] = n;
      }
      for (let r = 0; r < M.A.length; r++) {
        let s = 0; for (let j = 0; j < M.nx; j++) s += M.A[r][j] * x[j];
        const short = M.rhs[r] - s;
        if (short > 1e-9) {
          const i = items[r], j = M.col.has("g:" + i) ? M.col.get("g:" + i) : M.col.has("b:" + i) ? M.col.get("b:" + i) : -1;
          if (j < 0) return null;
          x[j] += short;
        }
      }
      let obj = 0; for (let j = 0; j < x.length; j++) obj += M.c[j] * x[j];
      return { x, obj };
    }
    function branchAndBound(M, start, nodeLimit, msLimit, hi0) {
      let best = start, nodes = 0, complete = true, root = null, capped = false;
      const t0 = now(), stack = [{ lo: {}, hi: hi0 || {} }];
      while (stack.length) {
        if (nodes >= nodeLimit || now() - t0 > msLimit) { complete = false; break; }
        const nd = stack.pop(); nodes++;
        const sol = solveNode(M, nd.lo, nd.hi);
        if (nodes === 1 && sol) root = sol.obj;          // the relaxation: no whole-number plan can cost less
        if (!sol) continue;
        if (sol.capped) capped = true;
        if (best && sol.obj >= best.obj - 0.5) continue;  // whole-number plans differ by at least one unit
        let j = -1, far = 0;
        for (let k = 0; k < M.nx; k++) { const v = sol.x[k], f = v - Math.floor(v + 1e-7); if (f > 1e-6 && f < 1 - 1e-6) { const d = Math.min(f, 1 - f); if (d > far) { far = d; j = k; } } }
        if (j < 0) { best = sol; continue; }
        const v = sol.x[j];
        stack.push({ lo: nd.lo, hi: Object.assign({}, nd.hi, { [j]: Math.floor(v) }) });
        stack.push({ lo: Object.assign({}, nd.lo, { [j]: Math.ceil(v) }), hi: nd.hi });   // rounding up first: quick, good plans
      }
      // proven when the search finished, or the best plan is within one unit (ore, or a second) of the bound
      const proven = !!best && !capped && (complete || (root != null && best.obj - root < 1));
      return { best, complete: proven, nodes, gap: best && root != null ? best.obj - root : null };
    }
    function runsOf(M, sol) {
      const runs = new Map();
      for (let j = 0; j < M.nx; j++) { const n = Math.round(sol.x[j]); if (n > 0) runs.set(M.vars[j].ref.id, n); }
      return runs;
    }
    const greedyRuns = new Map(greedy.steps.map(s => [s.id, s.runs]));
    const quick = !!opt.quick;
    let M = build(new Set());
    // the best of the starting plans (the quick plan, plus any seeds such as the plan without inventory)
    const starts = [greedyRuns].concat(seeds || []).map(r => costOf(M, r)).filter(Boolean).sort((a, b) => a.obj - b.obj);
    // the cascade: no recipe may run more often than in the plan on screen (opt.cap), so covered work only shrinks
    const hi0 = {};
    if (opt.cap) R.forEach((r, j) => { if (opt.cap[r.id] != null) hi0[j] = opt.cap[r.id]; });
    let res = branchAndBound(M, starts[0] || null, quick ? 150 : 8000, quick ? 60 : 1200, hi0);
    const debug = { seeds: starts.map(s => Math.round(s.obj)), nodes: res.nodes, gap: res.gap == null ? null : Math.round(res.gap * 100) / 100 };
    if (!res.best) return null;
    let runs = runsOf(M, res.best), proven = res.complete;
    let out = report(D, opt, runs, pool);
    // no tiny side-mines: leaving out one ore type wins if it costs at most 10 % more ore (or time), no more found units
    if (!quick && !opt.noSide) {
      const forbid = new Set(), prim = r => time ? r.secs : r.ore;
      for (let round = 0; round < 3; round++) {
        let better = null;
        for (const g of out.gather.filter(g => !g.found).sort((p, q) => p.qty - q.qty)) {
          const f = new Set([...forbid, g.item]), M2 = build(f);
          const r2 = branchAndBound(M2, costOf(M2, runs), 4000, 700, hi0);
          if (!r2.best) continue;
          const runs2 = runsOf(M2, r2.best), o2 = report(D, opt, runs2, pool);
          if (o2.blocked.length > out.blocked.length || o2.foundUnits > out.foundUnits) continue;
          if (o2.gather.length < out.gather.length && prim(o2) <= prim(out) * 1.1) { better = { f, runs2, o2, complete: r2.complete }; break; }
        }
        if (!better) break;
        forbid.clear(); better.f.forEach(i => forbid.add(i)); runs = better.runs2; out = better.o2; proven = better.complete;
      }
      out.sideMineSkipped = [...forbid];
      if (forbid.size) proven = false;                   // a cheaper plan with one more ore type was set aside on purpose
    }
    out.proven = proven; out.exact = true; out.debug = debug;
    return out;
  }

  // the plan as the page shows it, for any set of runs: what to gather, what is blocked, steps with depth, spare, used
  function report(D, opt, runs, pool) {
    const have = opt.have || {}, byId = {}; for (const r of D.recipes) byId[r.id] = r;
    const allMakers = {}; for (const r of D.recipes) for (const o in r.out) (allMakers[o] = allMakers[o] || []).push(r);
    const makers = {}; for (const r of pool) for (const o in r.out) (makers[o] = makers[o] || []).push(r);
    const kindOf = item => (D.sources[item] || { k: "unknown" }).k;
    const found = item => { const k = kindOf(item); return !(k === "mine" || k === "extract" || (k === "cut" && opt.salvage === "use")); };
    const goals = (opt.goals || []).filter(g => g.item && g.qty > 0);
    const need = {}, made = {};
    for (const g of goals) need[g.item] = (need[g.item] || 0) + g.qty;
    for (const [id, n] of runs) { const r = byId[id]; for (const i in r.in) need[i] = (need[i] || 0) + r.in[i] * n; for (const o in r.out) made[o] = (made[o] || 0) + r.out[o] * n; }
    // depth: goals 0, a step's inputs one deeper than its outputs
    const depth = {}; for (const g of goals) depth[g.item] = 0;
    for (let k = 0; k < 60; k++) {
      let changed = false;
      for (const [id] of runs) {
        const r = byId[id], d = Math.max(-1, ...Object.keys(r.out).map(o => depth[o] == null ? -1 : depth[o]));
        if (d < 0) continue;
        for (const i in r.in) if (depth[i] == null || depth[i] < d + 1) { if (d + 1 < 60) { depth[i] = d + 1; changed = true; } }
      }
      if (!changed) break;
    }
    const gather = [], blocked = [], used = {};
    for (const item of Object.keys(need)) {
      const want = need[item] - (made[item] || 0);
      if (have[item] && want > 0) used[item] = Math.min(have[item], want);
      const short = need[item] - (have[item] || 0) - (made[item] || 0);
      if (short <= 1e-9) continue;
      if (!allMakers[item]) {
        const src = D.sources[item] || { k: "unknown", h: "" };
        const forWhat = [...new Set([...runs].filter(([id]) => byId[id].in[item]).map(([id]) => mainOut(byId[id])))];
        gather.push({ item, qty: Math.ceil(short - 1e-9), kind: src.k, hint: src.h, found: found(item), cut: src.k === "cut", for: forWhat, have: have[item] || 0 });
      } else if (!makers[item]) {
        blocked.push({ item, qty: Math.ceil(short - 1e-9), facilities: [...new Set(allMakers[item].map(r => r.f))] });
      }
    }
    const steps = [];
    for (const [id, n] of runs) {
      const r = byId[id], ins = {}, outs = {};
      for (const i in r.in) ins[i] = r.in[i] * n;
      for (const o in r.out) outs[o] = r.out[o] * n;
      const d = Math.max(0, ...Object.keys(r.out).map(o => depth[o] == null ? 0 : depth[o]));
      steps.push({ id, recipe: r, runs: n, depth: d, secs: (r.t || 0) * n, ins, outs, unverified: !!r.u });
    }
    const spare = {};
    for (const o in made) { const s = made[o] + (have[o] || 0) - (need[o] || 0); if (s > 1e-9) spare[o] = Math.round(s); }
    // how each item is made in this plan, and the other recipes a pilot could switch it to
    const routes = {}, options = {}, ticked = new Set((opt.facilities || []).concat("Build Mode"));
    for (const item of Object.keys(need)) {
      const forIt = D.recipes.filter(r => ticked.has(r.f) && madeFor(r) === item);
      if (forIt.length < 2) continue;                    // one way to make it (or only as a by-product): nothing to choose
      let bestId = null, bestN = 0;
      for (const [id, n] of runs) if (madeFor(byId[id]) === item && n > bestN) { bestN = n; bestId = id; }
      if (!bestId) continue;
      routes[item] = bestId; options[item] = forIt.map(r => ({ id: r.id }));
    }
    const heldSalvage = (D.salvage || []).filter(s => used[s] > 0);
    const out = { steps, gather, blocked, spare, used, need, routes, options,
                  ore: gather.filter(g => !g.found).reduce((s, g) => s + g.qty, 0), foundUnits: gather.filter(g => g.found).reduce((s, g) => s + g.qty, 0),
                  secs: steps.reduce((s, x) => s + x.secs, 0) };
    if (heldSalvage.length) out.note = "Uses the salvage you hold: " + heldSalvage.map(s => used[s].toLocaleString("en-US") + " " + s).join(", ") + ".";
    return out;
  }

  // the planner the page uses: the exact plan, starting from the quick one (which is also the fallback)
  function planExact(D, opt) {
    const greedy = planGreedy(D, opt);
    try {
      const seeds = [];
      if (Object.keys(opt.have || {}).length) {            // the exact plan without inventory stays feasible with it: a second
        const o0 = Object.assign({}, opt, { have: {}, noSide: true });   // start, so holding more can never cost more ore
        const ex0 = exactPlan(D, o0, planGreedy(D, o0));
        if (ex0) seeds.push(new Map(ex0.steps.map(s => [s.id, s.runs])));
      }
      const ex = exactPlan(D, opt, greedy, seeds);
      if (!ex) return greedy;
      if (opt.only) return ex;                                     // the cascade: only the exact plan honours "same recipes, no more runs"
      if (ex.blocked.length && greedy.blocked.length) return ex;   // the exact plan names the parts that are blocked
      const score = r => [r.blocked.reduce((s, b) => s + b.qty, 0), r.foundUnits, opt.mode === "time" ? r.secs : r.ore];
      const a = score(ex), b = score(greedy);
      for (let k = 0; k < 3; k++) { if (a[k] < b[k] - 1e-9) return ex; if (a[k] > b[k] + 1e-9) { greedy.proven = false; return greedy; } }
      return ex;
    } catch (e) {
      greedy.proven = false;
      return greedy;
    }
  }

  root.LodgePlanner = { plan: planExact, planGreedy, solve, best, simplex };
})(typeof window !== "undefined" ? window : globalThis);
