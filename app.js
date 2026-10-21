/* Saints Forge: the page logic. Data in data.js (FORGE_DATA), packing in solver.js (a Web Worker, or in-page fallback). */
(function () {
  "use strict";
  const D = window.FORGE_DATA;
  const K = window.FORGE_CARD || null;                     // the card chrome (card.js): hull outlines, palette, prose
  const MOD = {}; D.modules.forEach(m => MOD[m.name] = m);
  const EXT = {}; D.exterior.forEach(e => EXT[e.name] = e);
  const FILLERS = ["Cargo Container", "Emergency Container", "Capacitor", "Fuel Bay", "Fuel Blister", "Structural Brace"];
  // filler value per unit at weight 1: tuned so every filler has the same value per cell (6/cell); the weight (0-3)
  // then orders them lexicographically (x1000 per step), so "Hold 3, Capacitor 2" means hold first, then capacitors.
  const FILL_BASE = { "Cargo Container": 36, "Emergency Container": 25, "Capacitor": 12, "Fuel Bay": 60, "Fuel Blister": 30, "Structural Brace": 42 };
  const PRIO_NAME = { hold: "hold", cap: "capacitor", fuel: "fuel", hp: "armour" };
  const PRIO_LABEL = { hold: "Hold", cap: "Capacitor", fuel: "Fuel", hp: "Armour" };
  // the ranked list: state.order is the pilot's order, state.prio[k] = 4 - rank (0 = off) so first beats second
  function prioFromOrder() { let r = 0; for (const k of state.order) state.prio[k] = state.prio[k] > 0 || state.prio[k] === undefined ? 4 - r++ : 0; }
  function orderFromPrio() { state.order = ["hold", "cap", "fuel", "hp"].sort((x, y) => (state.prio[y] || 0) - (state.prio[x] || 0) || state.order.indexOf(x) - state.order.indexOf(y)); prioFromOrder(); }
  function renderOrder() {
    const box = $("order"); if (!box) return; let rank = 0;
    box.innerHTML = state.order.map(k => { const on = state.prio[k] > 0; return `<div class="orow${on ? "" : " off"}"><span class="rank">${on ? ++rank : "–"}</span><label><input type="checkbox" data-on="${k}"${on ? " checked" : ""}> ${PRIO_LABEL[k]}</label><button type="button" class="pbtn" data-up="${k}" aria-label="move ${PRIO_LABEL[k]} up">▲</button><button type="button" class="pbtn" data-down="${k}" aria-label="move ${PRIO_LABEL[k]} down">▼</button></div>`; }).join("");
  }
  const PRIO_OF = { "Cargo Container": "hold", "Emergency Container": "hold", "Capacitor": "cap", "Fuel Bay": "fuel", "Fuel Blister": "fuel", "Structural Brace": "hp" };
  const $ = id => document.getElementById(id);

  const state = { hull: "Reiver", name: "Untitled fit", placements: [], exterior: {}, selected: -1, zoom: 1, prio: { hold: 4, cap: 3, fuel: 0, hp: 0 }, order: ["hold", "cap", "fuel", "hp"], minCaps: 0, mins: { hold: 0, fuel: 0, "Structural Brace": 0 }, fuelGrade: "Unstable", preset: null, dirty: false, saints: false };
  let solver = null, solverReady = false, running = null, pendingResolve = null;

  // ---------- solver plumbing ----------
  function startSolver() {
    solverReady = false;
    const payload = { type: "init", hull: D.hulls[state.hull], modules: Object.fromEntries(D.modules.map(m => [m.name, { cells: m.cells }])) };
    try {
      if (solver && solver.terminate) solver.terminate();
      solver = new Worker("solver.js?v=52969717");
      solver.onmessage = e => onSolver(e.data);
      solver.onerror = () => {                           // a dead Worker: free whatever waited on it, then carry on in the page
        solver = null; const waiting = pendingResolve, was = running; pendingResolve = null; running = null;
        if (was) { progressStop(); $("btn-forge").disabled = false; $("btn-forge").textContent = "Forge for the role"; }
        fallbackSolver(payload);
        if (waiting) waiting({ placements: state.placements, missing: ["?"] });
        if (was) setStatus("The solver stopped unexpectedly and was restarted. Try that again.", "warn");
      };
      solver.postMessage(payload);
    } catch (e) { solver = null; fallbackSolver(payload); }
  }
  function fallbackSolver(payload) {
    if (!window.ForgeSolver || !window.ForgeSolver.post) {
      const s = document.createElement("script"); s.src = "solver.js?v=52969717"; s.onload = () => fallbackSolver(payload); document.head.appendChild(s); return;
    }
    window.ForgeSolver.onmessage = onSolver;
    solver = { postMessage: m => setTimeout(() => window.ForgeSolver.post(m), 0), terminate() {} };
    solver.postMessage(payload);
    setStatus("Solver runs in the page (no worker): the page may pause while it works.", "warn");
  }
  function onSolver(m) {
    if (m.type === "ready") { solverReady = true; return; }
    if (m.type === "progress") { if (prog) { prog.iterations = m.iterations; prog.gains = m.gains; progressTick(); } if (running === "optimize") { state.placements = m.placements; render(); } return; }
    if (m.type === "done") {
      const kind = running; running = null; $("btn-forge").textContent = "Forge for the role"; $("btn-forge").disabled = false;
      if (kind === "optimize") { if (m.gains > 0) { state.placements = m.placements; markDirty(); } render(); progressDone(`Forged: ${m.iterations} re-packs in ${m.seconds.toFixed(0)} s, ${m.gains} gains · ${hold(state.placements)} m³ hold`); setStatus("", "info"); shortOfMinimums(null, lastSums); forgeEnded(); }
      else progressStop();
      if (kind === "tryadd") { if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(m); } }
    }
  }
  function solve(msg, kind) { return new Promise(res => { running = kind; pendingResolve = res; solver.postMessage(msg); }); }
  // while the forge or a fit search runs, the fit belongs to the Workers: every edit waits (audit 2026-10-09)
  function busy(quiet) { if (pool || running) { if (!quiet) setStatus(pool ? "The forge is running: press Stop first." : "Still fitting the last module…", "warn"); return true; } return false; }

  // ---------- the progress bar over the fitting window ----------
  let prog = null;                                           // { t0, secs, timer, iterations, gains } while the solver runs
  function progressStart(secs, label) {
    progressStop();
    prog = { t0: Date.now(), secs, timer: null, iterations: 0, gains: 0, label };
    const bar = $("forgebar"), fill = $("fb-fill"); if (!bar) return;
    bar.hidden = false; fill.classList.remove("done"); fill.classList.toggle("busy", !secs); fill.style.width = secs ? "0%" : "";
    $("fb-text").textContent = label;
    if (secs) prog.timer = setInterval(progressTick, 200);
  }
  function progressTick() {
    if (!prog || !prog.secs) return;
    const el = (Date.now() - prog.t0) / 1000, pct = Math.min(100, el / prog.secs * 100);
    $("fb-fill").style.width = pct.toFixed(1) + "%";
    $("fb-text").textContent = `${prog.label} ${Math.min(el, prog.secs).toFixed(0)} / ${prog.secs} s · ${prog.iterations} re-packs · ${prog.gains} gains`;
  }
  // the finished run stays on the bar (full, gold) until the next search starts
  function progressDone(text) {
    if (prog && prog.timer) clearInterval(prog.timer);
    prog = null; const bar = $("forgebar"); if (!bar) return;
    bar.hidden = false; $("fb-fill").classList.remove("busy"); $("fb-fill").classList.add("done"); $("fb-fill").style.width = "100%"; $("fb-text").textContent = text;
  }
  function progressStop() {
    if (prog && prog.timer) clearInterval(prog.timer);
    prog = null; const bar = $("forgebar"); if (bar) { bar.hidden = true; $("fb-fill").classList.remove("busy"); }
  }

  // ---------- geometry helpers ----------
  function rotShape(cells, rot) {
    let cur = cells.map(c => [c[0], c[1]]);
    for (let r = 0; r < rot; r += 90) cur = cur.map(c => [c[1], -c[0]]);
    const minx = Math.min(...cur.map(c => c[0])), miny = Math.min(...cur.map(c => c[1]));
    return cur.map(c => [c[0] - minx, c[1] - miny]);
  }
  const ROTS = [0, 90, 180, 270];
  // The turn whose footprint matches these cells. Stored labels are not trusted: the doctrine export carried 42 wrong
  // ones (audit 2026-10-11), so proposal links of several fits came back overlapping.
  function rotOf(name, cells, hint) {
    const m = MOD[name]; if (!m || !cells.length) return ROTS.includes(hint) ? hint : 0;
    const minx = Math.min(...cells.map(c => c[0])), miny = Math.min(...cells.map(c => c[1]));
    const key = cells.map(c => (c[0] - minx) + "," + (c[1] - miny)).sort().join("|");
    const fits = r => rotShape(m.cells, r).map(c => c.join(",")).sort().join("|") === key;
    if (ROTS.includes(hint) && fits(hint)) return hint;
    for (const r of ROTS) if (fits(r)) return r;
    return null;                                          // not this module's shape in any turn
  }
  // A fit from outside (a link, the tribe store) is checked before it is shown: known modules, their own shape, inside
  // the hull, on nothing else. Returns the placements with true turn labels, or null.
  function soundPlacements(hullName, list) {
    const hull = D.hulls[hullName]; if (!hull || !Array.isArray(list) || list.length > 600) return null;
    const sets = hull.sections.map(s => new Set(s.cells.map(c => c.join(",")))), used = hull.sections.map(() => new Set()), out = [];
    for (const t of list) {
      if (!Array.isArray(t) || !MOD[t[0]] || !Number.isInteger(t[1]) || !sets[t[1]] || !Array.isArray(t[3]) || t[3].length !== MOD[t[0]].cells.length) return null;
      const cells = [];
      for (const c of t[3]) { if (!Array.isArray(c) || !Number.isInteger(c[0]) || !Number.isInteger(c[1])) return null; const k = c[0] + "," + c[1]; if (!sets[t[1]].has(k) || used[t[1]].has(k)) return null; used[t[1]].add(k); cells.push([c[0], c[1]]); }
      const rot = rotOf(t[0], cells, t[2]); if (rot === null) return null;
      out.push([t[0], t[1], rot, cells]);
    }
    return out;
  }
  // hardpoint modules: known names, whole counts. External Thrusters are not kept: six come with the engine and change
  // nothing on the ship, so an old link or preset that lists them simply loses them (user 2026-10-12)
  function soundExterior(e) { const out = {}; if (e && typeof e === "object") for (const n in EXT) { if (EXT[n].auto) continue; const k = e[n]; if (Number.isInteger(k) && k > 0) out[n] = Math.min(k, 24); } return out; }
  function sectionSet(s) { return new Set(D.hulls[state.hull].sections[s].cells.map(c => c.join(","))); }
  function occupiedMap() {
    const occ = D.hulls[state.hull].sections.map(() => new Map());
    state.placements.forEach((p, i) => p[3].forEach(c => occ[p[1]].set(c.join(","), i)));
    return occ;
  }
  function canPlace(s, cells, ignore) {
    const set = sectionSet(s), occ = occupiedMap()[s];
    return cells.every(c => { const k = c.join(","); return set.has(k) && (!occ.has(k) || occ.get(k) === ignore); });
  }
  // a family cap (one engine of any class): the message when `name` would break it, else null
  function groupCap(name, c) {
    for (const g in (D.base_ship.max_group || {})) { const G = D.base_ship.max_group[g]; if (G.names.includes(name) && G.names.reduce((a, n) => a + (c[n] || 0), 0) >= G.max) return `${name}: the game allows at most ${G.max} ${g} per ship.`; }
    return null;
  }
  // The engine (user 2026-10-10): a ship cannot fly without one, so the last engine is never removed. Another class is
  // swapped in place: the three classes share one footprint, so the swap is a relabel and nothing else moves.
  const isEngine = n => (D.base_ship.engines || []).includes(n);
  const engineCount = c => (D.base_ship.engines || []).reduce((a, n) => a + (c[n] || 0), 0);
  const lastEngine = l => isEngine(l) && engineCount(counts(state.placements)) <= 1;
  // Saints Doctrine rules (user 2026-10-20): every Saints ship carries these; "Build a Saints Doctrine ship" turns them on,
  // and so does loading a doctrine fit. A Launch Bay brings an Autohelm with it while they are on.
  const SAINTS = { must: { "Transponder": 1, "Docking Clamp": 1, "Hull Repairer": 1, "Fuel Blister": 1, "Leap": 1, "Gravity Sensor": 1 },
                   mustExt: { "Directional Scanner": 1 }, withMod: { "Launch Bay": "Autohelm" }, engine: { Reiver: "Propulsion Engine R25", LAI: "Propulsion Engine R25" } };
  const saintsMin = n => state.saints ? (SAINTS.must[n] || 0) : 0;
  const saintsKept = l => !!saintsMin(l) && (counts(state.placements)[l] || 0) <= saintsMin(l);
  const keptMsg = l => isEngine(l) ? "A ship cannot fly without an engine: press + on another engine to switch." : saintsKept(l) && !(D.base_ship.never_removed[l] && counts(state.placements)[l] <= D.base_ship.never_removed[l]) ? `${l} is required on every Saints Doctrine ship.` : `${l} cannot be removed (the game keeps it).`;
  function swapEngine(name) {
    const i = state.placements.findIndex(p => isEngine(p[0])); if (i < 0) return false;
    const old = state.placements[i][0]; if (old === name) return true;
    if (JSON.stringify(MOD[old].cells) !== JSON.stringify(MOD[name].cells)) return false;     // never the case today: the caller then fits it the long way
    state.placements = state.placements.map((p, k) => k === i ? [name, p[1], p[2], p[3]] : p);
    markDirty(); render(); setStatus(`Engine switched: ${old} → ${name}.`, "ok"); return true;
  }
  function hold(pl) { let m = 0; pl.forEach(p => { const e = MOD[p[0]]; if (e && e.hold) m += e.hold; }); return m; }
  function counts(pl) { const c = {}; pl.forEach(p => c[p[0]] = (c[p[0]] || 0) + 1); return c; }

  // ---------- stats ----------
  // Capacitor recharge (corrected 2026-10-15 after Lacal of [WOLF]: "your cap regen is limited by your power generator,
  // not number of capacitors"): every Capacitor, and the Blackstart Cell, refills at 1.2 GJ/s (the client's rechargeRate
  // 0.0012), but the charge comes from the Power Generator, so together they never get more than it has left after the
  // modules' draw. Our readings agree: 2 Capacitors 2.4, 4 + the Cell 6.0, 13 Capacitors 12.9 GJ/s with 2.1 of 15 MW drawn
  // (13 x 1.2 would be 15.6). The Cell's starlight trickle needs no generator and comes on top. The old curve
  // (1.286 n^0.9) bent through that capped reading and promised 17-21 GJ/s to fits of 18-22 Capacitors.
  const PER_UNIT = () => D.models.recharge.per_unit || 1.2;
  function recharge(nUnits, trickle, free) { return Math.min(nUnits * PER_UNIT(), Math.max(0, free)) + trickle; }
  function stats() { return statsOf(state.hull, state.placements, state.exterior); }
  // what n EM Scramblers online leave of the signature: measured for 1-3, each one past the table helps as little as the last step
  function emMult(n) { const t = (D.models.em || {}).scrambler_mult || [1]; if (n < t.length) return t[n]; const last = t[t.length - 1], step = t.length > 1 ? last / t[t.length - 2] : 1; return last * Math.pow(Math.max(step, 0.85), n - t.length + 1); }
  function statsOf(hullName, placements, exterior) {
    const c = counts(placements), ext = exterior;
    const cells = placements.reduce((a, p) => a + p[3].length, 0), total = D.hulls[hullName].cells_total;
    let fuel = 0, cap = 0, hp = D.models.hull_hp, repair = 0, draw = 0, drain = 0, trickle = 0, power = 0, payload = 0;
    const hullMass = D.hulls[hullName].mass || 0; let mass = hullMass;                 // kg: the hull plus every fitted module (as the fitting screen counts it)
    for (const n in c) { const m = MOD[n]; if (!m) continue; const k = c[n];
      fuel += (m.fuel || 0) * k; cap += (m.cap || 0) * k; hp += (m.hp || 0) * k; repair += (m.repair || 0) * k; draw += (m.draw_mw || 0) * k;
      drain += (m.drain || 0) * k; trickle += (m.trickle || 0) * k; power += (m.power || 0) * k; payload += (m.payload || 0) * k; mass += (m.mass || 0) * k; }
    let dps = 0, dpsRamped = 0, mining = 0; const hits = [];     // hits: what one weapon lands per hit at full spool-up (the number the logs show)
    // Only as many weapons work at once as there are Weapon Receivers. A fit that lists a second set (lasers and the
    // extractors that swap in) used to count all of them as firing: a miner was given 26 Capacitors where 14 do
    // (2026-10-12). Counted: the hungriest ones for the drain, the hardest-hitting ones for the damage.
    const slots = c["Weapon Receiver"] || 0, wlist = []; for (const n in ext) { const e = EXT[n]; if (e && e.hardpoint === "weapon") for (let i = 0; i < ext[n]; i++) wlist.push(n); }
    const over = wlist.length > slots, pick = key => { const m = {}; wlist.slice().sort((x, y) => key(EXT[y]) - key(EXT[x])).slice(0, slots).forEach(n => m[n] = (m[n] || 0) + 1); return m; };
    const wDrain = over ? pick(e => e.drain || 0) : null, wDps = over ? pick(e => e.dps_ramped || e.dps || 0) : null;
    for (const n in ext) { const e = EXT[n]; if (!e) continue; const k = ext[n], isW = over && e.hardpoint === "weapon", kd = isW ? (wDrain[n] || 0) : k, kp = isW ? (wDps[n] || 0) : k;
      mass += (e.mass || 0) * k; drain += (e.drain || 0) * kd; dps += (e.dps || 0) * kp; dpsRamped += (e.dps_ramped || e.dps || 0) * kp; if (e.mining) mining += Math.min(k, isW ? Math.max(kd, kp) : k);
      if (e.dps && e.cycle_s && kp) hits.push({ name: n, k: kp, perHit: Math.round((e.dps_ramped || e.dps) * e.cycle_s), cycle: e.cycle_s, ramps: !!e.dps_ramped }); }
    const nCaps = c["Capacitor"] || 0, nCells = c["Blackstart Cell"] || 0;
    const pw = power || D.models.power_mw, free = Math.max(0, pw - draw);      /* what the generator has left to refill with */
    const rech = recharge(nCaps + nCells, trickle, free), rechMax = free + trickle, capLimited = (nCaps + nCells) * PER_UNIT() > free + 1e-9;
    const factor = D.models.fuel.factor[state.fuelGrade];
    const burn = draw * 60 / factor;                         // units per minute
    // EM signature at rest (measured model, data.js models.em): hull + Power Generator + each Capacitor + each module that
    // is switched on. A module counts once whatever it draws (a Transponder at 1.0 MW adds what a Docking Clamp does);
    // the Gravity Sensor and the engine have their own, larger numbers. Each EM Scrambler online adds a little of its
    // own and the total is multiplied (measured for 1-3). The Blackstart Cell is counted as a Capacitor (not measured).
    const E = D.models.em || {}, emHull = D.hulls[hullName].em || 100, scramblers = c[E.scrambler] || 0, emSpecial = E.special || {};
    const emOne = n => n === E.scrambler ? (E.scrambler_own || 0) : n in emSpecial ? emSpecial[n] : (E.per_module || 0);
    const emStore = (E.per_capacitor || 0) * (nCaps + nCells), emDark = emHull + emStore;   // only the Capacitors on
    const emWith = (base, n) => (base + (E.scrambler_own || 0) * n) * emMult(n);          // n Scramblers online on top of `base`
    const emParts = [["Hull", emHull], [`${nCaps} Capacitor${nCaps === 1 ? "" : "s"}${nCells ? " + Blackstart Cell" : ""}`, emStore]]; let emOther = 0;
    if (c["Power Generator"]) { emOther += E.generator || 0; emParts.push(["Power Generator", E.generator || 0]); }
    for (const n in c) { const m = MOD[n]; if (!m || !m.draw_mw) continue; const v = emOne(n) * c[n]; if (n !== E.scrambler) emOther += v; emParts.push([c[n] > 1 ? `${c[n]} ${n}s` : n, v]); }
    const emRaw = emDark + emOther, em = emWith(emRaw, scramblers);
    // fuel: recharging the capacitor burns fuel too, 1 MW for every GJ/s that flows back in (measured). So with every
    // drain running the burn is the draw plus what the Capacitors can put back (the drain itself, or the recharge if smaller)
    const burnBusy = (draw + Math.min(drain, rech)) * 60 / factor;
    emParts.sort((a, b) => b[1] - a[1]);
    return { cells, total, freeCells: total - cells, hold: hold(placements), fuel, cap, hp, repair, draw, power: power || D.models.power_mw, drain, rech, rechMax, capLimited, free, trickle, nCaps, hits,
             mass, hullMass, em, emHull, emRaw, emDark, emWith, emParts: emParts.filter(p => p[1] > 0), emCaps: emStore, emPower: emOther, scramblers, burnBusy, refill: cap / factor,
             burn, hours: burn > 0 ? fuel / burn / 60 : Infinity, dps, dpsRamped, mining, payload, stable: rech >= drain, lastMin: drain > rech ? cap / (drain - rech) : Infinity };
  }
  // units that refill `drain`; past what the generator can give (free) no number of them will: then the count that takes
  // all it can give (more only add storage)
  function capsNeeded(drain, trickle, free) { if (drain <= trickle) return 0; const n = Math.ceil((Math.min(drain - trickle, free)) / PER_UNIT() - 1e-9); return Math.max(0, n); }
  // Capacitors a fit needs for this drain, given its Blackstart Cells (each recharges like a Capacitor, plus its trickle)
  function capsWanted(drain, c, free) { const cells = c["Blackstart Cell"] || 0; return Math.max(0, capsNeeded(drain, cells * 0.3, free) - cells); }
  const f1 = x => (Math.round(x * 10 + 1e-6) / 10).toFixed(1);     // one decimal, halves up: the tile, the checks and Compare agree (5.05 read 5.0 here and 5.1 there)
  const overPower = st => Math.round(st.draw * 100) > Math.round(st.power * 100);    // 15.000000000000002 MW is not over 15
  // What should I change? One line per thing a new rider wishes they had known, with the fix as a button.
  // [{text, add: [module, ...] | null, label}]
  function hints(st) {
    const c = counts(state.placements), ext = state.exterior, out = [];
    const has = n => (c[n] || 0) > 0;
    if (!st.stable) { const need = capsWanted(st.drain, c, st.free) - st.nCaps, dry = isFinite(st.lastMin) ? Math.round(st.lastMin) + " s" : "no time";
      if (st.drain > st.rechMax + 1e-9) out.push({ text: `Capacitor runs dry in ${dry} with everything on, and more Capacitors cannot fix it: the Power Generator has ${f1(st.free)} MW left to refill with, everything on drains ${f1(st.drain)} GJ/s. Run fewer things at once${need > 0 ? ", or add " + need + " Capacitor" + (need > 1 ? "s" : "") + " to use all it can give" : ""}.`, add: need > 0 ? Array(need).fill("Capacitor") : null, label: `Add ${need} Capacitor${need > 1 ? "s" : ""}` });
      else { const n = Math.max(1, need); out.push({ text: `Capacitor runs dry in ${dry} with everything on. Run it empty and you cannot warp away.`, add: Array(n).fill("Capacitor"), label: `Add ${n} Capacitor${n > 1 ? "s" : ""}` }); } }
    if (!engineCount(c) && (D.base_ship.engines || []).length) out.push({ text: "No engine: the ship cannot fly.", add: [D.base_ship.engines[0]], label: "Add an engine" });
    if (!has("Hull Repairer")) out.push({ text: "No Hull Repairer: nothing heals you in the field. One repairs ~25 HP/s, your best survival module.", add: ["Hull Repairer"], label: "Add one" });
    if (!has("Leap")) out.push({ text: "No Leap: no burst of speed to hop between nearby sites or to break away.", add: ["Leap"], label: "Add a Leap" });
    if (!has("Docking Clamp")) out.push({ text: "No Docking Clamp: no docking at Fueling Docks, so no free Unstable Fuel.", add: ["Docking Clamp"], label: "Add one" });
    if (!has("Transponder")) out.push({ text: "No Transponder: a tribe's catapults and gates stay invisible to you.", add: ["Transponder"], label: "Add one" });
    if (!has("Gravity Sensor") && !has("Ion Sensor")) out.push({ text: "No sensor: you cannot find rocks, sites or ships.", add: ["Gravity Sensor"], label: "Add a Gravity Sensor" });
    else if (!scannerSlots(c)) out.push({ text: "No Gravity Sensor: the Directional Scanner mounts only on that one.", add: ["Gravity Sensor"], label: "Add a Gravity Sensor" });
    else if (!ext["Directional Scanner"]) out.push({ text: "No Directional Scanner on the sensor: no scanning for what is out there.", ext: "Directional Scanner", label: "Add one" });
    if (state.saints) { for (const n in SAINTS.mustExt) if ((ext[n] || 0) < SAINTS.mustExt[n] && scannerSlots(c) && !out.some(h => h.ext === n)) out.push({ text: `No ${n}: every Saints Doctrine ship carries one on its Gravity Sensor.`, ext: n, label: "Add one" });
      for (const n in SAINTS.must) if ((c[n] || 0) < SAINTS.must[n] && !out.some(h => h.add && h.add[0] === n)) out.push({ text: `No ${n}: every Saints Doctrine ship carries one.`, add: [n], label: "Add one" });
      for (const n in SAINTS.withMod) if (c[n] && !c[SAINTS.withMod[n]]) out.push({ text: `A ${n} needs an ${SAINTS.withMod[n]} on a Saints Doctrine ship.`, add: [SAINTS.withMod[n]], label: `Add an ${SAINTS.withMod[n]}` }); }
    if (!(c["Weapon Receiver"] || 0)) out.push({ text: "No Weapon Receiver: nothing to mine or shoot with.", add: ["Weapon Receiver"], label: "Add one" });
    else if (!Object.keys(ext).some(n => EXT[n] && EXT[n].hardpoint === "weapon" && ext[n])) out.push({ text: "Empty Weapon Receiver: mount a Cutting Laser to mine and defend.", ext: "Cutting Laser", label: "Add a Cutting Laser" });
    if (st.burn > 0 && isFinite(st.hours) && st.hours < 2) out.push({ text: `Fuel for ${st.hours.toFixed(1)} h at this burn on ${state.fuelGrade}: a long trip ends in the dark.`, add: ["Fuel Bay"], label: "Add a Fuel Bay" });
    if (!st.fuel) out.push({ text: "No fuel tank: the ship cannot move.", add: ["Fuel Bay"], label: "Add a Fuel Bay" });
    if (overPower(st)) out.push({ text: `Over the power grid (${st.draw.toFixed(1)} of ${st.power} MW): switch modules off or remove some.`, add: null });
    if (st.hp <= D.models.hull_hp && (c["Weapon Receiver"] || 0) >= 2) out.push({ text: "A fighting fit with no Structural Brace: each adds +375 HP.", add: ["Structural Brace"], label: "Add a Brace" });
    return out;
  }
  // sensors that carry a Directional Scanner (in game only the Gravity Sensor does; data.js marks them)
  function scannerSlots(c) { return D.modules.reduce((a, m) => a + (m.hardpoint === "scanner" ? (c[m.name] || 0) : 0), 0); }
  async function applyHint(i) {
    const h = hints(stats())[i]; if (!h) return;
    if (h.ext) { state.exterior[h.ext] = (state.exterior[h.ext] || 0) + 1; markDirty(); render(); setStatus(`${h.ext} added.`, "ok"); return; }
    for (const n of h.add || []) { if (!(await addModule(n))) break; }
  }
  function checks(st) {
    const c = counts(state.placements), ext = state.exterior, out = [];
    const need = D.base_ship.always;
    for (const n in need) { if (MOD[n]) out.push([(c[n] || 0) >= need[n], `${n} ×${need[n]}`]); else out.push([(ext[n] || 0) >= need[n], `${n} (exterior)`]); }
    const eng = D.base_ship.engines.some(e => c[e]); out.push([eng, "one engine (R10 / R25 / R50)"]);
    for (const n in (D.base_ship.max_fit || {})) if ((c[n] || 0) > D.base_ship.max_fit[n]) out.push([false, `${n}: at most ${D.base_ship.max_fit[n]} per ship (${c[n]} fitted)`]);
    for (const g in (D.base_ship.max_group || {})) { const G = D.base_ship.max_group[g], k = G.names.reduce((a, n) => a + (c[n] || 0), 0); if (k > G.max) out.push([false, `at most ${G.max} ${g} per ship (${k} fitted)`]); }
    const weapons = Object.keys(ext).filter(n => EXT[n] && EXT[n].hardpoint === "weapon").reduce((a, n) => a + ext[n], 0);
    const receivers = c["Weapon Receiver"] || 0;
    out.push([weapons <= receivers, `weapons on receivers (${weapons} of ${receivers})`]);
    if (receivers >= 2 && (D.base_ship.with_two_weapons || {}).Repeater) out.push([(c["Repeater"] || 0) >= 1, "Repeater with two Weapon Receivers"]);   // a tribe rule: the public edition carries none
    const combat = D.base_ship.combat_weapons.some(w => ext[w]);
    if (combat) out.push([(c["Ion Sensor"] || 0) >= 1, "Ion Sensor on a combat fit"]);
    const scanners = scannerSlots(c);
    out.push([(ext["Directional Scanner"] || 0) <= scanners, "Directional Scanner on a sensor"]);
    if (state.saints) {
      for (const n in SAINTS.must) out.push([(c[n] || 0) >= SAINTS.must[n], `Saints: ${n}`]);
      for (const n in SAINTS.mustExt) out.push([(ext[n] || 0) >= SAINTS.mustExt[n], `Saints: ${n}`]);
      for (const n in SAINTS.withMod) if (c[n]) out.push([(c[SAINTS.withMod[n]] || 0) >= 1, `Saints: ${SAINTS.withMod[n]} with the ${n}`]);
    }
    if (scanners) out.push([(ext["Directional Scanner"] || 0) >= 1, "Directional Scanner on the Gravity Sensor"]);
    out.push([!overPower(st), `power ${st.draw.toFixed(1)} of ${st.power} MW`]);
    out.push([st.stable, st.stable ? `cap-stable (${f1(st.rech)} GJ/s ≥ ${f1(st.drain)} drain)` : `cap runs dry in ${isFinite(st.lastMin) ? Math.round(st.lastMin) + " s" : "—"} with everything on`]);
    return out;
  }

  // ---------- rendering ----------
  function layoutSlots(hull, cell, gap) {
    const secs = D.hulls[hull].sections, cols = D.hulls[hull].columns;
    const dims = secs.map(s => [Math.max(...s.cells.map(c => c[0])) + 1, Math.max(...s.cells.map(c => c[1])) + 1]);
    const rows = []; for (let i = 0; i < dims.length; i += cols) rows.push(dims.slice(i, i + cols));
    const colW = Array.from({ length: cols }, (_, c) => Math.max(...rows.map(r => r[c] ? r[c][0] : 0)));
    const rowH = rows.map(r => Math.max(...r.map(d => d[1])));
    const slots = []; let y = 0;
    rows.forEach((r, ri) => { let x = 0; r.forEach((d, ci) => { slots.push([x + (colW[ci] - d[0]) * cell / 2, y + (rowH[ri] - d[1]) * cell / 2, d[0], d[1]]); x += colW[ci] * cell + gap; }); y += rowH[ri] * cell + gap; });
    return { slots, w: colW.reduce((a, b) => a + b, 0) * cell + gap * (cols - 1), h: y - gap };
  }
  let drag = null;
  // The hull with a fit on it, like the game's fitting window. opts: id, selected, mark (Set of "s:x:y" cells to light),
  // numbers (true = module numbers). -> { svg, vw, vh }
  // Where a module's number sits, in cell units from the section's corner: the module's centre of mass when a number
  // drawn there stays on the module's own cells, else the nearest spot that does (a cell centre, the middle of two
  // neighbouring cells or of a 2 x 2 block). An L, U or plus shape has its centre of mass on someone else's cell.
  function numberSpot(cells) {
    const own = new Set(cells.map(c => c.join(","))), has = (x, y) => own.has(Math.floor(x) + "," + Math.floor(y));
    const fits = (x, y) => has(x - 0.49, y - 0.4) && has(x + 0.49, y - 0.4) && has(x - 0.49, y + 0.4) && has(x + 0.49, y + 0.4);
    const mx = cells.reduce((a, c) => a + c[0], 0) / cells.length + 0.5, my = cells.reduce((a, c) => a + c[1], 0) / cells.length + 0.5;
    if (fits(mx, my)) return [mx, my];
    let best = null, bd = Infinity;
    for (const [x, y] of cells) for (const [px, py] of [[x + 0.5, y + 0.5], [x + 1, y + 0.5], [x + 0.5, y + 1], [x + 1, y + 1]]) {
      if (!fits(px, py)) continue; const d = (px - mx) ** 2 + (py - my) ** 2; if (d < bd - 1e-9) { bd = d; best = [px, py]; } }
    return best || [cells[0][0] + 0.5, cells[0][1] + 0.5];
  }
  function hullSvg(hullName, placements, opts) {
    opts = opts || {};
    const hull = D.hulls[hullName], ch = K && K.themes[hullName];
    const cell = ch ? ch.cell : (hullName === "LAI" ? 16 : 22), gap = ch ? ch.gap : 16, lai = hullName === "LAI";
    const L = layoutSlots(hullName, cell, gap);
    // room for the hull pieces' pointed tips (2.4 cells) and the LAI's two cosmetic pieces under the tail
    const padX = 3 * cell, padT = 3 * cell, padB = lai ? 2.6 * cell + 56 : 3 * cell;
    const vw = L.w + padX * 2, vh = L.h + padT + padB;
    const th = ch ? ch.theme : { cellbg: "#16141a", cellline: "#2a2630", ink: "#07070a" };
    let svg = `<svg viewBox="0 0 ${vw} ${vh}" xmlns="http://www.w3.org/2000/svg" class="hullsvg"${opts.id ? ` id="${opts.id}"` : ""}>`;
    svg += `<rect x="0" y="0" width="${vw}" height="${vh}" rx="6" fill="${th.ink}" fill-opacity="0.55"/>`;
    if (ch) svg += `<g transform="translate(${padX},${padT})" pointer-events="none">${ch.outline}</g>`;
    hull.sections.forEach((sec, s) => {
      const [sx, sy] = L.slots[s];
      svg += `<g class="sec" data-s="${s}">`;
      sec.cells.forEach(([x, y]) => { svg += `<rect class="cell" data-s="${s}" data-x="${x}" data-y="${y}" x="${padX + sx + x * cell}" y="${padT + sy + y * cell}" width="${cell}" height="${cell}" fill="${th.cellbg}" stroke="${th.cellline}"/>`; });
      svg += `</g>`;
    });
    const nums = [];
    placements.forEach((p, i) => {
      const [label, s, rot, cells] = p; const [sx, sy] = L.slots[s]; const m = MOD[label] || { color: "#888" };
      const set = new Set(cells.map(c => c.join(",")));
      svg += `<g class="mod${i === opts.selected ? " sel" : ""}${p[4] === 1 ? " locked" : p[4] === 2 ? " kept" : ""}" data-i="${i}">`;
      cells.forEach(([x, y]) => { svg += `<rect x="${padX + sx + x * cell}" y="${padT + sy + y * cell}" width="${cell}" height="${cell}" fill="${m.color}"/>`; });
      cells.forEach(([x, y]) => { const X = padX + sx + x * cell, Y = padT + sy + y * cell;     // outline + bevel like the cards
        [[x, y - 1, X, Y, X + cell, Y, "#fff", 0.35], [x, y + 1, X, Y + cell, X + cell, Y + cell, "#000", 0.45], [x - 1, y, X, Y, X, Y + cell, "#fff", 0.25], [x + 1, y, X + cell, Y, X + cell, Y + cell, "#000", 0.35]].forEach(([nx, ny, a, b, c2, d, colr, op]) => {
          if (set.has(nx + "," + ny)) return;
          svg += `<line x1="${a}" y1="${b}" x2="${c2}" y2="${d}" stroke="${th.ink}" stroke-width="2.4"/><line x1="${a}" y1="${b}" x2="${c2}" y2="${d}" stroke="${colr}" stroke-opacity="${op}" stroke-width="1"/>`; }); });
      if (p[4] === 2) { const [lx, ly] = cells.reduce((a, c) => (c[1] < a[1] || (c[1] === a[1] && c[0] < a[0])) ? c : a), X = padX + sx + lx * cell, Y = padT + sy + ly * cell, u = cell / 11;
        /* kept in its section: four silver corner brackets (it may move, but not out of these walls) */
        svg += `<g class="keepmark" pointer-events="none"><rect x="${X + 1.5 * u}" y="${Y + 1.5 * u}" width="${7 * u}" height="${7 * u}" rx="${1.2 * u}" fill="${th.ink}" fill-opacity="0.85"/>`
          + `<path d="M${X + 3 * u},${Y + 4.4 * u} v${-1.4 * u} h${1.4 * u} M${X + 5.6 * u},${Y + 3 * u} h${1.4 * u} v${1.4 * u} M${X + 7 * u},${Y + 5.6 * u} v${1.4 * u} h${-1.4 * u} M${X + 4.4 * u},${Y + 7 * u} h${-1.4 * u} v${-1.4 * u}" fill="none" stroke="#c9ced8" stroke-width="${0.8 * u}"/></g>`; }
      if (p[4] === 1) { const [lx, ly] = cells.reduce((a, c) => (c[1] < a[1] || (c[1] === a[1] && c[0] < a[0])) ? c : a), X = padX + sx + lx * cell, Y = padT + sy + ly * cell, u = cell / 11;
        svg += `<g class="lockmark" pointer-events="none"><rect x="${X + 1.5 * u}" y="${Y + 1.5 * u}" width="${7 * u}" height="${7 * u}" rx="${1.2 * u}" fill="${th.ink}" fill-opacity="0.85"/>`
          + `<path d="M${X + 3.6 * u},${Y + 5 * u} v${-1.2 * u} a${1.4 * u},${1.4 * u} 0 0 1 ${2.8 * u},0 v${1.2 * u}" fill="none" stroke="#d9b24c" stroke-width="${0.8 * u}"/>`
          + `<rect x="${X + 3 * u}" y="${Y + 5 * u}" width="${4 * u}" height="${2.8 * u}" rx="${0.5 * u}" fill="#d9b24c"/></g>`; }
      if (opts.numbers !== false) { const [nx, ny] = numberSpot(cells), fs = +(cell * 0.82).toFixed(1);   // as large as two digits fit in one cell (Rajdhani 700: two digits = 1.19 em)
        nums.push(`<text class="modnum" data-i="${i}" style="font-size:${fs}px" x="${(padX + sx + nx * cell).toFixed(1)}" y="${(padT + sy + ny * cell + fs * 0.34).toFixed(1)}">${i + 1}</text>`); }
      svg += `</g>`;
    });
    if (nums.length) svg += `<g class="modnums" pointer-events="none">${nums.join("")}</g>`;   // above every module: a neighbour never covers a number
    if (opts.mark && opts.mark.size) {                 // cells that differ from the other fit, lit gold
      svg += `<g pointer-events="none">`;
      hull.sections.forEach((sec, s) => { const [sx, sy] = L.slots[s]; sec.cells.forEach(([x, y]) => { if (opts.mark.has(`${s}:${x}:${y}`)) svg += `<rect x="${padX + sx + x * cell + 1}" y="${padT + sy + y * cell + 1}" width="${cell - 2}" height="${cell - 2}" fill="none" stroke="#d9b24c" stroke-width="2"/>`; }); });
      svg += `</g>`;
    }
    svg += `</svg>`;
    return { svg, vw, vh };
  }
  function renderGrid() {
    drag = null;                                           // a redraw (Delete, R, Undo mid-drag) ends the drag: its index may be gone
    if (!state.placements[state.selected]) state.selected = -1;
    const { svg, vw, vh } = hullSvg(state.hull, state.placements, { id: "hull-svg", selected: state.selected });
    $("grid").innerHTML = svg;
    const el = $("hull-svg");
    el.dataset.w = vw; el.dataset.h = vh;
    fitZoom();
    // Drag: the module follows the pointer as a ghost; on release the cell under the pointer receives the cell that was
    // grabbed (not the module's corner), so the piece lands where it looks. No cell under the pointer = snap back.
    el.addEventListener("pointerdown", ev => {
      if (ev.button) return;                               // only the main button selects and drags
      const g = ev.target.closest("g.mod"); if (!g) { select(-1); return; }
      if (busy()) return;
      const i = +g.dataset.i; const p = state.placements[i];
      const under = cellUnder(ev); const minx = Math.min(...p[3].map(c => c[0])), miny = Math.min(...p[3].map(c => c[1]));
      const dx = under && +under.dataset.s === p[1] ? +under.dataset.x - minx : 0, dy = under && +under.dataset.s === p[1] ? +under.dataset.y - miny : 0;
      const pt = svgPoint(el, ev); drag = { i, start: pt, moved: false, dx, dy, pointerId: ev.pointerId };
      if (state.selected !== i) { state.selected = i; renderSelection(); }
      el.querySelectorAll("g.mod.sel").forEach(x => x.classList.remove("sel")); g.classList.add("sel");
      try { el.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });
    el.addEventListener("pointermove", ev => {
      if (!drag) return; const pt = svgPoint(el, ev);
      if (!drag.moved && Math.hypot(pt.x - drag.start.x, pt.y - drag.start.y) > 4) drag.moved = true;
      if (!drag.moved) return;
      const k = (+el.dataset.w) / el.getBoundingClientRect().width;               // screen px -> drawing units
      const g = el.querySelector(`g.mod[data-i="${drag.i}"]`);
      const off = offWindow(ev);
      const t = el.querySelector(`text.modnum[data-i="${drag.i}"]`), tr = `translate(${((pt.x - drag.start.x) * k).toFixed(1)},${((pt.y - drag.start.y) * k).toFixed(1)})`;
      if (g) { g.setAttribute("transform", tr); g.style.opacity = off ? "0.3" : "0.75"; g.style.pointerEvents = "none"; }
      if (t) { t.setAttribute("transform", tr); t.style.opacity = off ? "0.3" : "0.75"; }
      if (off !== drag.off) { drag.off = off; const l = state.placements[drag.i][0]; setStatus(off ? (locked(l) ? keptMsg(l) : `Release to remove ${l}.`) : "", off ? "warn" : "info"); }
    });
    const endDrag = ev => {
      if (!drag) return; const d = drag; drag = null;
      const g = el.querySelector(`g.mod[data-i="${d.i}"]`); if (g) { g.removeAttribute("transform"); g.style.opacity = ""; g.style.pointerEvents = ""; }
      const t = el.querySelector(`text.modnum[data-i="${d.i}"]`); if (t) { t.removeAttribute("transform"); t.style.opacity = ""; }
      if (!d.moved || ev.type === "pointercancel") return;
      if (offWindow(ev)) { removeAt(d.i); return; }                // dragged off the fitting window = removed
      const cell = cellUnder(ev);
      if (!cell) { setStatus("Not on a hull cell: the module stays where it was.", "warn"); return; }
      moveTo(d.i, +cell.dataset.s, +cell.dataset.x - d.dx, +cell.dataset.y - d.dy);
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
  }
  // The drawing fits the visible pane (height and width), times the zoom factor; zoomed in, the pane scrolls.
  function fitZoom() {
    const el = $("hull-svg"); if (!el) return;
    const w = +el.dataset.w, h = +el.dataset.h, wrap = $("grid");
    const availW = Math.max(200, wrap.clientWidth - 24), availH = Math.max(220, window.innerHeight - 270);
    const base = Math.min(availW / w, availH / h);
    const scale = base * state.zoom;
    el.setAttribute("width", Math.round(w * scale)); el.setAttribute("height", Math.round(h * scale));
    $("zoom-v").textContent = Math.round(state.zoom * 100) + "%";
  }
  // ---------- drag from the palette onto the hull ----------
  let pdrag = null;                                           // { name, ghost, shown, target }
  function capMessage(name) {
    const c = counts(state.placements), cap = (D.base_ship.max_fit || {})[name];
    if (cap && (c[name] || 0) >= cap) return `${name}: the game allows at most ${cap} per ship.`;
    if (isEngine(name) && !c[name] && engineCount(c) > 0) return `One engine per ship: press + on ${name} to switch to it.`;
    return groupCap(name, c);
  }
  // where `name` would go if dropped on cell (s, x, y): the module's centre on that cell, the turn the drag is using
  // first, then the other turns, nudged up to 2 cells, nearest first. -> {s, rot, cells} or null
  function dropSpot(name, s, x, y, prefRot) {
    const offs = []; for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) offs.push([dx, dy]);
    offs.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
    for (const rot of [prefRot, ...[0, 90, 180, 270].filter(r => r !== prefRot)]) {
      const shape = rotShape(MOD[name].cells, rot);
      const sx = Math.round(shape.reduce((a, c) => a + c[0], 0) / shape.length - 0.01), sy = Math.round(shape.reduce((a, c) => a + c[1], 0) / shape.length - 0.01);
      for (const [dx, dy] of offs) {
        const cells = shape.map(c => [c[0] - sx + x + dx, c[1] - sy + y + dy]);
        if (canPlace(s, cells, -1)) return { s, rot, cells };
      }
    }
    return null;
  }
  function ghostFor(name, rot) {
    const el = $("hull-svg"), ch = K && K.themes[state.hull], cellU = ch ? ch.cell : 22;
    const k = el ? el.getBoundingClientRect().width / +el.dataset.w : 1, px = Math.max(8, cellU * k);
    const shape = rotShape(MOD[name].cells, rot), w = Math.max(...shape.map(c => c[0])) + 1, h = Math.max(...shape.map(c => c[1])) + 1;
    const g = document.createElement("div"); g.className = "pghost";
    g.innerHTML = `<svg width="${w * px}" height="${h * px}">${shape.map(([x, y]) => `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${MOD[name].color}" stroke="#07070a" stroke-width="1.5"/>`).join("")}</svg><span>${name}</span>`;
    document.body.appendChild(g); return g;
  }
  function clearHint() { document.querySelectorAll("#hull-svg rect.cell.hint-ok, #hull-svg rect.cell.hint-bad").forEach(r => r.classList.remove("hint-ok", "hint-bad")); }
  function showHint(spot, s, x, y, name) {
    clearHint();
    if (spot) { for (const [cx, cy] of spot.cells) { const r = document.querySelector(`#hull-svg rect.cell[data-s="${spot.s}"][data-x="${cx}"][data-y="${cy}"]`); if (r) r.classList.add("hint-ok"); } }
    else { const shape = rotShape(MOD[name].cells, pdrag.rot); for (const [cx, cy] of shape) { const r = document.querySelector(`#hull-svg rect.cell[data-s="${s}"][data-x="${cx + x}"][data-y="${cy + y}"]`); if (r) r.classList.add("hint-bad"); } }
  }
  function paletteDown(ev) {
    const row = ev.target.closest(".prow[data-mod]"); if (!row || ev.target.closest("button") || busy()) return;
    const name = row.dataset.mod; if (!MOD[name]) return;
    pdrag = { name, x0: ev.clientX, y0: ev.clientY, shown: false, ghost: null, spot: null, rot: 0, touch: ev.pointerType === "touch", t0: Date.now() };
    try { row.setPointerCapture(ev.pointerId); } catch (e) {}
  }
  function paletteMove(ev) {
    if (!pdrag) return;
    if (!pdrag.shown) {
      const far = Math.hypot(ev.clientX - pdrag.x0, ev.clientY - pdrag.y0) > 6;
      if (!far) return;
      if (pdrag.touch && Date.now() - pdrag.t0 < 250) { pdrag = null; return; }   // a quick swipe on a phone scrolls the list
      const msg = capMessage(pdrag.name); if (msg) { setStatus(msg, "bad"); pdrag = null; return; }
      pdrag.shown = true; pdrag.ghost = ghostFor(pdrag.name, pdrag.rot); document.body.classList.add("pdragging");
    }
    ev.preventDefault();
    pdrag.ghost.style.left = ev.clientX + "px"; pdrag.ghost.style.top = ev.clientY + "px";
    const cell = cellUnder(ev);
    if (!cell) { clearHint(); pdrag.spot = null; return; }
    const s = +cell.dataset.s, x = +cell.dataset.x, y = +cell.dataset.y;
    pdrag.spot = dropSpot(pdrag.name, s, x, y, pdrag.rot); showHint(pdrag.spot, s, x, y, pdrag.name);
  }
  function paletteUp(ev) {
    if (!pdrag) return; const d = pdrag; pdrag = null;
    clearHint(); document.body.classList.remove("pdragging"); if (d.ghost) d.ghost.remove();
    if (!d.shown || ev.type === "pointercancel") return;
    if (!cellUnder(ev)) { setStatus(`Drop ${d.name} on the hull to fit it.`, "info"); return; }
    if (!d.spot) { setStatus(`No room for ${d.name} there. Try another spot, or press + to let the forge rearrange.`, "bad"); return; }
    state.placements.push([d.name, d.spot.s, d.spot.rot, d.spot.cells]); state.selected = state.placements.length - 1; keepByHand(d.name);
    markDirty(); render(); setStatus(`${d.name} fitted in the ${D.hulls[state.hull].sections[d.spot.s].name} section.`, "ok"); afterAdd(d.name);
  }
  function cellUnder(ev) { const els = document.elementsFromPoint(ev.clientX, ev.clientY); return els.find(e => e.classList && e.classList.contains("cell")) || null; }
  function svgPoint(svg, ev) { const r = svg.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
  function moveTo(i, s, x, y) {
    const p = state.placements[i];
    // the module's top-left cell lands on (x, y) of section s, keeping its shape and rotation
    const minx = Math.min(...p[3].map(c => c[0])), miny = Math.min(...p[3].map(c => c[1]));
    const cells = p[3].map(c => [c[0] - minx + x, c[1] - miny + y]);
    if (s === p[1] && cells.every((c, k) => c[0] === p[3][k][0] && c[1] === p[3][k][1])) { render(); return; }
    if (canPlace(s, cells, i)) { state.placements[i] = [p[0], s, p[2], cells].concat(p[4] ? [p[4]] : []); markDirty(); render(); setStatus(`${p[0]} moved to the ${D.hulls[state.hull].sections[s].name} section.`, "ok"); }
    else { render(); setStatus(`${p[0]} does not fit there.`, "bad"); }
  }
  // Turn the selected module to `rot` degrees, keeping its centre where it was; nudges up to 3 cells, nearest spot first.
  function turnTo(i, rot) {
    const p = state.placements[i], shape = rotShape(MOD[p[0]].cells, rot);
    const cx = p[3].reduce((a, c) => a + c[0], 0) / p[3].length, cy = p[3].reduce((a, c) => a + c[1], 0) / p[3].length;
    const sx = shape.reduce((a, c) => a + c[0], 0) / shape.length, sy = shape.reduce((a, c) => a + c[1], 0) / shape.length;
    const bx = Math.round(cx - sx), by = Math.round(cy - sy);
    const offs = []; for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) offs.push([dx, dy]);
    offs.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
    for (const [dx, dy] of offs) {
      const cells = shape.map(c => [c[0] + bx + dx, c[1] + by + dy]);
      if (canPlace(p[1], cells, i)) { state.placements[i] = [p[0], p[1], rot, cells].concat(p[4] ? [p[4]] : []); markDirty(); render(); return true; }
    }
    return false;
  }
  // Manual turns, each doing exactly what it says (the forge does the automatic fitting). rot counts the game's own
  // steps: +90 is a quarter turn counter-clockwise on screen, +270 clockwise.
  const TURNS = { cw: [270, "90° clockwise"], ccw: [90, "90° counter-clockwise"], half: [180, "180°"] };
  function turnSelected(kind) {
    if (busy()) return;
    const i = state.selected; if (i < 0) { setStatus("Select a module first (click it on the hull).", "info"); return; }
    const p = state.placements[i], [step, label] = TURNS[kind]; if (!p) return;
    if (turnTo(i, ((rotOf(p[0], p[3], p[2]) || 0) + step) % 360)) setStatus(`${p[0]} turned ${label}.`, "ok");
    else setStatus(`${p[0]}: no room to turn ${label} here. Try another turn, or drag it somewhere roomier.`, "bad");
  }
  function rotateSelected() { turnSelected("cw"); }
  function locked(l) { return (D.base_ship.never_removed[l] && counts(state.placements)[l] <= D.base_ship.never_removed[l]) || lastEngine(l) || saintsKept(l); }
  function offWindow(ev) { const r = $("grid").getBoundingClientRect(); return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom; }
  function removeAt(i) {
    const [l] = state.placements[i];
    if (locked(l)) { setStatus(keptMsg(l), "bad"); render(); return; }
    state.placements.splice(i, 1); state.selected = -1; keepByHand(l); markDirty(); render(); setStatus(`${l} removed.`, "ok");
  }
  function removeSelected() { if (state.selected >= 0 && !busy()) removeAt(state.selected); }
  function select(i) { state.selected = i; renderGrid(); renderSelection(); }
  function renderSelection() {
    const i = state.selected; const box = $("selbox");
    if (i < 0 || !state.placements[i]) { state.selected = -1; box.hidden = true; return; }
    const p = state.placements[i]; const m = MOD[p[0]]; box.hidden = false;
    $("sel-name").textContent = `#${i + 1} ${p[0]}`;
    $("sel-detail").textContent = `${m.size} cells · ${D.hulls[state.hull].sections[p[1]].name} · rotation ${p[2]}°` + (m.draw_mw ? ` · ${m.draw_mw} MW` : "") + (m.drain ? ` · ${m.drain} GJ/s active` : "") + (p[4] === 1 ? " · locked in place" : p[4] === 2 ? " · kept in its section" : "");
    $("btn-lock").textContent = p[4] === 1 ? "Unlock" : "Lock in place"; $("btn-lock").classList.toggle("on", p[4] === 1);
    $("btn-keepsec").textContent = p[4] === 2 ? "Free to move" : "Keep in section"; $("btn-keepsec").classList.toggle("on", p[4] === 2);
  }
  // Lock in place (user 2026-10-16): the forge, + and the polish keep a locked module exactly where it is (flag 1,
  // solver.js splitFixed). Keep in section (user 2026-10-17: "stay in the section but ... move around for the optimal
  // layout"): flag 2, the forge may move and turn it but only inside its section. By hand the pilot can still move,
  // turn or remove either; a module moved by hand keeps its flag (kept = in the section it now sits in).
  // L toggles the lock, K the section on the selected module; one replaces the other.
  function lockSelected(mode) {
    const i = state.selected, p = state.placements[i]; if (!p || busy()) return;
    const want = mode === 2 ? 2 : 1;
    if (p[4] === want) p.length = 4; else p[4] = want;
    markDirty(); render(); renderSelection();
    const sec = D.hulls[state.hull].sections[p[1]].name;
    const nl = state.placements.filter(x => x[4] === 1).length, nk = state.placements.filter(x => x[4] === 2).length;
    setStatus(p[4] === 1 ? `${p[0]} is locked here: the forge packs everything else around it (${nl} locked).`
      : p[4] === 2 ? `${p[0]} stays in the ${sec} section: the forge may move and turn it there (${nk} kept in their section).`
      : `${p[0]} is free again: the forge may move it anywhere.`, "ok");
  }

  function renderPalette() {
    const c = counts(state.placements); const groups = {};
    D.modules.forEach(m => (groups[m.group] = groups[m.group] || []).push(m));
    let html = "";
    for (const g of ["Command & sensors", "Engineering", "Propulsion", "Weapons", "Storage & crafting"]) {
      if (!groups[g]) continue;
      html += `<div class="pgroup"><h3>${g}</h3>`;
      groups[g].forEach(m => { const k = c[m.name] || 0;
        const eng = isEngine(m.name), swap = eng && !k && engineCount(c) > 0, onlyEngine = eng && k > 0 && engineCount(c) <= 1;
        const lockMin = Math.max(D.base_ship.never_removed[m.name] || 0, saintsMin(m.name)), locked = k <= lockMin || onlyEngine, full = !swap && (((D.base_ship.max_fit || {})[m.name] && k >= D.base_ship.max_fit[m.name]) || !!groupCap(m.name, c));
        const mark = lockMin || onlyEngine;
        html += `<div class="prow${k ? " has" : ""}${mark ? " core" : ""}" data-mod="${m.name}" title="${swap ? "press + to switch to this engine" : "drag onto the hull, or press +"}"><span class="sw" style="background:${m.color}"></span><span class="pname">${m.name}${mark ? ` <span class="lock" title="${onlyEngine ? "a ship cannot fly without an engine: press + on another to switch" : D.base_ship.never_removed[m.name] ? "the game never lets this be removed" : "required on every Saints Doctrine ship"}">✠</span>` : ""}</span><span class="psize">${m.size}</span>` +
                `<span class="pcount">${k || ""}</span><button class="pbtn" data-add="${m.name}" title="${swap ? "switch to this engine" : full ? "the game allows no more of these" : "add one"}" aria-label="${swap ? "switch to" : "add"} ${m.name}"${full ? " disabled" : ""}>+</button><button class="pbtn" data-sub="${m.name}" title="${onlyEngine ? "a ship needs an engine: press + on another to switch" : lockMin ? (D.base_ship.never_removed[m.name] ? "the game keeps " : "a Saints Doctrine ship keeps ") + lockMin : "remove one"}" aria-label="remove ${m.name}"${locked ? " disabled" : ""}>−</button></div>`; });
      html += `</div>`;
    }
    html += `<div class="pgroup"><h3>Exterior (hardpoints)</h3>`;
    D.exterior.forEach(e => { if (e.auto) return; const k = state.exterior[e.name] || 0;
      html += `<div class="prow${k ? " has" : ""}"><span class="sw ext"></span><span class="pname">${e.name}</span><span class="psize">${e.hardpoint === "weapon" ? "hp" : ""}</span>` +
              `<span class="pcount">${k || ""}</span><button class="pbtn" data-addx="${e.name}" aria-label="add ${e.name}">+</button><button class="pbtn" data-subx="${e.name}" aria-label="remove ${e.name}"${k ? "" : " disabled"}>−</button></div>`; });
    if (engineCount(counts(state.placements))) html += `<div class="prow auto" title="Six External Thrusters come with every engine. They weigh nothing and draw no power, so there is nothing to fit."><span class="sw ext"></span><span class="pname">External Thrusters</span><span class="pauto">6 · with the engine</span></div>`;
    html += `</div>`;
    $("palette").innerHTML = html;
  }
  // Hiding (a fleet commander's question, 2026-10-10: "make my signature zero, if it is possible at all"): it is not,
  // so the page shows where the signature comes from and the lowest this fit can sit at, with the one fix that helps.
  function renderHiding(st, f) {
    const el = $("emwhy"); if (!el) return;
    const E = D.models.em || {}, r = n => f(Math.round(n)), scr = E.scrambler, n = st.scramblers, measured = (E.scrambler_mult || [1]).length - 1;
    const top = st.emParts.slice(0, 6), rest = st.emParts.slice(6).reduce((a, p) => a + p[1], 0);
    const dark = st.emWith(st.emDark, n), pct = k => Math.round(emMult(k) * 100);
    let html = `<div class="hh">Hiding: your EM signature</div>` +
      `<div class="eparts">${top.map(([name, v]) => `${esc(name)} ${r(v)}`).join(" · ")}${rest ? ` · the rest ${r(rest)}` : ""}${n ? ` · then ×${emMult(n).toFixed(2)} (${n} ${scr}${n > 1 ? "s" : ""})` : ""}</div>` +
      `<div class="erow"><span>Everything on</span><b>~${r(st.em)}</b></div>`;
    if (n) html += `<div class="erow"><span>Only the Capacitors on</span><b>~${r(st.emDark)}</b></div>` +
      `<div class="erow best"><span>Only the Capacitors and the ${n > 1 ? n + " " + scr + "s" : scr} on</span><b>~${r(dark)}</b></div>`;
    else html += `<div class="erow best"><span>Only the Capacitors on</span><b>~${r(st.emDark)}</b></div>`;
    html += `<div class="erow"><span>Emergency Shutoff: the Capacitors off as well</span><b>0</b></div>`;
    html += `<div class="enote">Lowest with the ship still alive: <b>~${r(Math.min(dark, st.emDark))}</b> (hull ${st.emHull}, each Capacitor ${E.per_capacitor}; Scramblers only take a share: one leaves ${pct(1)}%, two ${pct(2)}%, three ${pct(3)}%). ` +
      `With the Emergency Shutoff on the Power Management screen everything goes dark, the Capacitors too, and that screen reads <b>0</b>. The price: the ship cannot move, the capacitor empties, and filling it again burns about ${r(st.refill)} units of ${esc(state.fuelGrade)} fuel. Read once, on a starter ship; what another pilot's scan shows then is not tested.` +
      (n > measured ? ` More than ${measured} Scramblers has not been measured: the figure assumes each extra one helps as little as the last.` : "") + `</div>`;
    if (MOD[scr] && n < measured) { const to = Math.min(measured, n + (measured - n));
      html += `<div class="hint"><span>${n ? "More " : ""}${scr}s: with ${to} you hide at ~${r(st.emWith(st.emDark, to))} and fly at ~${r(st.emWith(st.emRaw, to))}.</span><button type="button" data-emadd="${to - n}">Fit ${to - n}${n ? " more" : ""}</button></div>`; }
    el.innerHTML = html;
  }
  function renderStats() {
    const st = stats();
    const f = (n, d) => n.toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 0 : d });
    $("st-cells").textContent = `${st.cells} / ${st.total}`; $("st-cells-sub").textContent = `${st.freeCells} free`;
    $("st-hold").textContent = f(st.hold); $("st-hold-sub").textContent = st.payload ? `+ ${st.payload} m³ in Launch Bays` : `${Math.floor(st.hold / D.models.field_sentry_m3)} Field Sentries`;
    $("st-fuel").textContent = f(st.fuel); $("st-fuel-sub").textContent = st.burn > 0 ? `${st.burn.toFixed(2)}/min on ${state.fuelGrade} · ${isFinite(st.hours) ? st.hours.toFixed(1) + " h" : "—"}` + (st.burnBusy > st.burn + 0.005 ? ` · ${st.burnBusy.toFixed(2)}/min with everything running` : "") : "—";
    $("st-fuel-sub").title = "At rest the burn is the power drawn. Recharging the capacitor burns fuel as well: 1 MW for every GJ/s that flows back in, so weapons, repairers and a refill from empty all cost fuel.";
    $("st-cap").textContent = f(st.cap); $("st-cap-sub").textContent = `${f1(st.rech)} GJ/s est${st.capLimited ? " (generator's limit)" : ""} · ${f1(st.drain)} drain${st.stable ? " · stable" : " · " + (isFinite(st.lastMin) ? "runs dry in " + Math.round(st.lastMin) + " s" : "runs dry")}`;
    $("st-hp").textContent = f(st.hp);   /* exact: hull 2,100 on both hulls and +375 a Brace match every fitting-screen reading (starter Reiver 2,100, stock LAI 2,100, a two-Brace Reiver 2,475, a six-Brace LAI 4,350) */ $("st-hp-sub").textContent = `${st.repair} HP/s repair`;
    // the big number is per second at full spool-up; the small line is per hit, as the combat log shows it
    $("st-dps").textContent = st.dps ? f(Math.round(st.dpsRamped)) : (st.mining ? `${st.mining}×` : "—");
    $("st-dps-sub").textContent = st.dps
      ? (st.hits.map(h => `${h.k} × ${h.perHit} a hit every ${h.cycle} s`).join(" · ") + (st.dpsRamped > st.dps ? ` · ${f(st.dpsRamped)}/s spooled, ${f(st.dps)}/s cold` : " per second"))
      : (st.mining ? "mining lasers / extractors" : "no weapons");
    $("st-power").textContent = `${st.draw.toFixed(1)} / ${st.power}`; $("st-power-sub").textContent = "MW";
    // mass in tonnes (the fitting screen shows kg: 12,456 t = 12,456,000 kg); EM signature as the fitting screen shows it
    const massChecked = [].concat((D.models.mass || {}).verified_on || []).includes(state.hull);        // "~" until the hull's own mass is checked against the game
    $("st-mass").textContent = (massChecked ? "" : "~") + f(Math.round(st.mass / 1000));
    $("st-mass-sub").textContent = `tonnes: hull ${f(Math.round(st.hullMass / 1000))} + fit ${f(Math.round((st.mass - st.hullMass) / 1000))}`;
    $("st-mass-sub").title = `${f(st.mass)} kg, without cargo or ammunition. ` + (massChecked ? "Matches the game's fitting screen." : `The ${state.hull} hull's own mass is the client's number, not yet checked in game.`);
    // EM signature: the big number is everything on, the second number everything off (user 2026-10-10); on a fit with
    // EM Scramblers "off" keeps them running, which is how such a ship hides
    $("st-em").textContent = `~${f(Math.round(st.em))}`;
    const es = $("st-em-sub"), nS = st.scramblers, emOff = st.emWith(st.emDark, nS); es.textContent = "";
    [["", "with everything on"], [`~${f(Math.round(emOff))}`, " with only the Capacitors on"]].concat(nS ? [["", `(the ${nS > 1 ? nS + " EM Scramblers stay" : "EM Scrambler stays"} on)`]] : []).forEach(([num, text]) => {
      const d = document.createElement("span"); if (num) { const b = document.createElement("b"); b.textContent = num; d.appendChild(b); } d.appendChild(document.createTextNode(text)); es.appendChild(d); });
    es.title = `Everything on: hull ${st.emHull} + Capacitors ${Math.round(st.emCaps)} + switched-on modules ${Math.round(st.emPower)}` + (nS ? ` = ${f(Math.round(st.emRaw))} before the ${nS} EM Scrambler${nS > 1 ? "s" : ""}` : "") + ". With every module and the Power Generator off, the hull and the Capacitors are left; the Emergency Shutoff reads 0.";
    // nothing under a tile's number is ever cut (user 2026-10-10): each part of a caption gets its own line and wraps
    document.querySelectorAll(".tiles .s[id]").forEach(el => { if (el === es) return; const bits = el.textContent.split(" · "); el.textContent = ""; bits.forEach(t => { const d = document.createElement("span"); d.textContent = t; el.appendChild(d); }); });
    renderHiding(st, f);
    const ch = checks(st);
    $("checks").innerHTML = ch.map(([ok, t]) => `<li class="${ok ? "ok" : "bad"}"><span class="dot"></span>${esc(t)}</li>`).join("");
    const hs = hints(st), hb = $("hints");
    if (hb) hb.innerHTML = hs.length ? `<div class="hh">What should I change?</div>` + hs.map((h, i) => `<div class="hint"><span>${esc(h.text)}</span>${h.add || h.ext ? `<button type="button" data-hint="${i}">${esc(h.label)}</button>` : ""}</div>`).join("")
                             : `<div class="hh">What should I change?</div><div class="hint ok"><span>Nothing stands out: this ship can travel, dock, refuel, see and defend itself.</span></div>`;
    $("cap-stable-n").textContent = capsWanted(st.drain, counts(state.placements), st.free);
    $("st-caprech-note").textContent = `recharge: ${PER_UNIT()} GJ/s per Capacitor (a Blackstart Cell counts as one), never more than the Power Generator has left: ${f1(st.free)} of ${f1(st.power)} MW. More Capacitors past that add storage, not recharge.`;
  }
  function renderHeader() { if (!K) return; const th = K.themes[state.hull].theme; $("tier").textContent = `✠ ${th.name} · ${th.tier} ✠`; }
  function render() { renderGrid(); renderPalette(); renderStats(); renderSelection(); renderHeader(); $("fit-name").value = state.name; $("hull-sel").value = state.hull; $("free-count").textContent = ""; syncKeepInputs(); record(); syncUnsave();
    if (forgeBefore && forgeBefore.after && !pool && !running && !$("forgediff").hidden && JSON.stringify(state.placements) !== forgeBefore.after) hideForgeDiff(); }

  // ---------- undo / redo ----------
  // Every render records the fit if it changed (a forge or a + search records once, when it ends). 100 steps kept.
  let history = [], hidx = -1, holdHistory = false;
  function snap() { return JSON.stringify({ h: state.hull, p: state.placements, e: state.exterior, n: state.name, b: state.preset, d: state.dirty, c: state.minCaps, k: state.mins }); }
  function record() {
    if (holdHistory || pool || running) return;
    const s = snap(); if (hidx >= 0 && history[hidx] === s) return;
    history = history.slice(0, hidx + 1); history.push(s); if (history.length > 100) history.shift(); hidx = history.length - 1; undoButtons();
  }
  function undoButtons() { const u = $("btn-undo"), r = $("btn-redo"); if (u) u.disabled = hidx <= 0; if (r) r.disabled = hidx >= history.length - 1; }
  function restore(s) {
    const o = JSON.parse(s), hullChanged = o.h !== state.hull;
    Object.assign(state, { hull: o.h, placements: o.p, exterior: o.e, name: o.n, preset: o.b, dirty: o.d, minCaps: o.c, mins: minsFrom(o.k), selected: -1 });
    $("min-caps").value = state.minCaps; if (hullChanged) startSolver(); render(); undoButtons();
  }
  function undo() { if (pool || running || hidx <= 0) return; hidx--; restore(history[hidx]); setStatus("Undone.", "info"); }
  function redo() { if (pool || running || hidx >= history.length - 1) return; hidx++; restore(history[hidx]); setStatus("Redone.", "info"); }
  function setStatus(text, tone) { const s = $("status"); s.textContent = text; s.className = "status " + (tone || ""); }
  // Doctrine fits are written +NAME+ (the Saints' mark). The moment one is changed it becomes a proposal and loses the
  // marks, so nobody mistakes a modified fit for the doctrine. Ships outside the doctrine would carry no marks (none at the moment).
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function docName(p) { const n = String(p.name == null ? "" : p.name); return p.doctrine ? "+" + n.toUpperCase() + "+" : n; }
  function markDirty() {
    if (!state.dirty && /^\+.+\+$/.test(state.name)) { const base = D.presets.find(x => x.n === state.preset); state.name = (base ? base.name : state.name.replace(/\+/g, "")) + " proposal"; $("fit-name").value = state.name; }
    state.dirty = true;
  }

  // ---------- actions ----------
  // the forge may trade Capacitors down to the minimum: one placed or removed by hand moves that minimum with it
  // 'Keep at least' for the other role fillers (user 2026-10-09): Cargo Containers (hold), Fuel Bays (fuel), Structural
  // Braces (armour). Same rules as the Capacitor minimum: a loaded fit sets them to its own counts, a module placed or
  // removed by hand moves its minimum with it, the forge never goes below them.
  // Hold and fuel are TOTALS (user 2026-10-12: "sometimes fuel blisters are better ... change that to fuel or cargo by
  // itself"): m³ of hold from Cargo Containers and Emergency Containers, units of fuel from Fuel Bays and Fuel Blisters.
  // The forge reaches the number with any mix and comes as close as the hull allows. The − and + beside each box move
  // it by the group's smallest module (25 m³, 250 fuel). Structural Braces stay a count.
  const KEEP_IDS = { "Structural Brace": "min-brace" };
  const SUM_IDS = { hold: "min-cargo", fuel: "min-fuel" }, SUM_MAX = { hold: 6000, fuel: 40000 }, SUM_UNIT = { hold: "m³ of hold", fuel: "fuel" };
  const SUM_PER = { hold: {}, fuel: {} }; FILLERS.forEach(n => { const m = MOD[n]; if (m && m.hold) SUM_PER.hold[n] = m.hold; if (m && m.fuel) SUM_PER.fuel[n] = m.fuel; });
  const sumStep = k => Math.min(...Object.values(SUM_PER[k]).concat(k === "hold" ? [25] : [250]));
  const sumNow = (k, pl) => (pl || state.placements).reduce((a, p) => a + (SUM_PER[k][p[0]] || 0), 0);
  const clampSum = (k, v) => Math.max(0, Math.min(SUM_MAX[k], Math.round(+v || 0)));
  function zeroMins() { return { hold: 0, fuel: 0, "Structural Brace": 0 }; }
  // a list of minimums from a link, a saved fit or an older page: module counts become the totals they stood for
  function minsFrom(k) {
    const out = zeroMins(); if (!k || typeof k !== "object") return out;
    const num = (v, cap) => Number.isFinite(+v) && +v > 0 ? Math.min(cap, Math.floor(+v)) : 0;
    out.hold = k.hold != null ? num(k.hold, SUM_MAX.hold) : num(k["Cargo Container"], 400) * (SUM_PER.hold["Cargo Container"] || 36);
    out.fuel = k.fuel != null ? num(k.fuel, SUM_MAX.fuel) : num(k["Fuel Bay"], 400) * (SUM_PER.fuel["Fuel Bay"] || 500);
    out.hold = Math.min(out.hold, SUM_MAX.hold); out.fuel = Math.min(out.fuel, SUM_MAX.fuel); out["Structural Brace"] = num(k["Structural Brace"], 400);
    return out;
  }
  function syncKeepInputs() { if ($("min-caps")) $("min-caps").value = state.minCaps; for (const n in KEEP_IDS) { const el = $(KEEP_IDS[n]); if (el) el.value = state.mins[n] || 0; } for (const k in SUM_IDS) { const el = $(SUM_IDS[k]); if (el && document.activeElement !== el) el.value = state.mins[k] || 0; } }
  function setMinsFromFit() { const c = counts(state.placements); state.mins = zeroMins(); for (const n in KEEP_IDS) state.mins[n] = c[n] || 0; for (const k in SUM_IDS) state.mins[k] = sumNow(k); syncKeepInputs(); }
  function keepByHand(name) { if (name === "Capacitor") return capsByHand(); if (KEEP_IDS[name]) state.mins[name] = counts(state.placements)[name] || 0; for (const k in SUM_IDS) if (SUM_PER[k][name]) state.mins[k] = sumNow(k); syncKeepInputs(); }
  function stepSum(k, d) { state.mins[k] = clampSum(k, (Math.round((state.mins[k] || 0) / sumStep(k)) + d) * sumStep(k)); syncKeepInputs(); }
  function capsByHand() { const n = counts(state.placements)["Capacitor"] || 0; if (n !== state.minCaps) { state.minCaps = n; $("min-caps").value = n; } }
  async function addModule(name, quiet) {
    if (busy(quiet)) return false;
    const cap = (D.base_ship.max_fit || {})[name];
    if (cap && (counts(state.placements)[name] || 0) >= cap) { setStatus(`${name}: the game allows at most ${cap} per ship.`, "bad"); return; }
    if (isEngine(name) && !(counts(state.placements)[name]) && engineCount(counts(state.placements)) > 0 && swapEngine(name)) return true;
    const grp = groupCap(name, counts(state.placements)); if (grp) { setStatus(grp, "bad"); return; }
    if (!solverReady) { setStatus("Solver still loading…", "warn"); return; }
    $("btn-forge").disabled = true; setStatus(`Fitting ${name}…`, "info"); progressStart(0, `Finding a spot for ${name}…`);
    const r = await solve({ type: "tryadd", placements: state.placements, add: [name], seconds: 6, seed: Date.now() & 0xffff }, "tryadd");
    $("btn-forge").disabled = false;
    if (r.missing && r.missing.length) { if (!quiet) setStatus(`No room for ${name}, even after rearranging.`, "bad"); return false; }
    state.placements = r.placements; state.selected = -1; keepByHand(name); markDirty(); render(); setStatus(`${name} fitted.`, "ok"); await afterAdd(name); return true;
  }
  // What comes with a module: a Gravity Sensor gets its Directional Scanner (everywhere); on a Saints Doctrine ship a
  // Launch Bay brings an Autohelm (user 2026-10-20).
  async function afterAdd(name) {
    const c = counts(state.placements);
    if (MOD[name] && MOD[name].hardpoint === "scanner" && EXT["Directional Scanner"] && (state.exterior["Directional Scanner"] || 0) < scannerSlots(c)) {
      state.exterior["Directional Scanner"] = (state.exterior["Directional Scanner"] || 0) + 1; markDirty(); render(); setStatus(`${name} fitted, with its Directional Scanner.`, "ok"); }
    const w = state.saints && SAINTS.withMod[name];
    if (w && !(c[w] || 0)) { if (await addModule(w, true)) setStatus(`${name} fitted, with an ${w} (Saints Doctrine rule).`, "ok"); else setStatus(`${name} fitted, but there is no room for its ${w}. Make room: a Saints Doctrine ship needs one.`, "warn"); }
  }
  // Make me cap stable: fit the Capacitors the recharge model needs for the fitted drain, one at a time (rearranging
  // when the hull is tight), and keep that many as the minimum so a later Forge never trades them away.
  async function makeCapStable() {
    if (running || pool) return;
    const st = stats(), have = st.nCaps, need = capsWanted(st.drain, counts(state.placements), st.free), never = st.drain > st.rechMax + 1e-9;
    if (never && need <= have) { state.minCaps = Math.max(state.minCaps, have); syncKeepInputs(); setStatus(`No number of Capacitors keeps up: everything on drains ${f1(st.drain)} GJ/s and the Power Generator has ${f1(st.free)} MW to refill with. Your ${have} already take all it can give; run fewer things at once.`, "warn"); return; }
    if (!never && (st.stable || need <= have)) { state.minCaps = Math.max(state.minCaps, have); syncKeepInputs(); setStatus(`Already cap-stable with ${have} Capacitor${have === 1 ? "" : "s"} (${f1(st.rech)} GJ/s est ≥ ${f1(st.drain)} drain).`, "ok"); return; }
    let added = 0;
    for (let k = have; k < need; k++) { if (!(await addModule("Capacitor", true))) break; added++; }
    const now = stats();
    state.minCaps = now.nCaps; syncKeepInputs();         // addModule moved the minimum with each Capacitor; show it
    if (never && now.nCaps >= need) setStatus(`${added} Capacitor${added === 1 ? "" : "s"} added: ${now.nCaps} take all the Power Generator can give (${f1(now.rech)} GJ/s), still short of the ${f1(now.drain)} GJ/s drain with everything on. Run fewer things at once.`, "warn");
    else if (now.stable) setStatus(`Cap-stable: ${added} Capacitor${added === 1 ? "" : "s"} added, ${now.nCaps} in all (${f1(now.rech)} GJ/s est ≥ ${f1(now.drain)} drain). Keeping ${now.nCaps} as the minimum.`, "ok");
    else setStatus(`Room for only ${added} of the ${need - have} Capacitors needed. Remove something, or set Capacitor priority high and Forge with "Keep at least ${need}".`, "warn");
  }
  // ◀ ▶ on the stat tiles: each stat has the module that raises it, and a smaller one to try when that does not fit
  const ADJ = { hold: ["Cargo Container", "Emergency Container"], fuel: ["Fuel Bay", "Fuel Blister"], cap: ["Capacitor"], hp: ["Structural Brace"] };
  async function adjust(key, d) {
    if (running || pool) return;
    const mods = ADJ[key], c = counts(state.placements);
    if (d > 0) {
      for (let k = 0; k < mods.length; k++) { if (await addModule(mods[k], k < mods.length - 1)) return; }
      setStatus(`No room for ${mods.join(" or ")}, even after rearranging.`, "bad"); return;
    }
    // less: the smaller module first (fine steps), never one the game keeps
    for (const n of mods.slice().reverse()) {
      const keep = D.base_ship.never_removed[n] || 0;
      if ((c[n] || 0) > keep) { subModule(n); setStatus(`${n} removed.`, "ok"); return; }
    }
    setStatus(`Nothing left to remove: the game keeps the last ${mods[0]}.`, "info");
  }
  function subModule(name) {
    if (busy()) return;
    const idxs = state.placements.map((p, i) => p[0] === name ? i : -1).filter(i => i >= 0);
    if (!idxs.length) return;
    if (locked(name)) { setStatus(keptMsg(name), "bad"); return; }
    state.placements.splice(idxs[idxs.length - 1], 1); state.selected = -1; keepByHand(name); markDirty(); render(); setStatus(`${name} removed.`, "ok");
  }
  // A clean slate is never empty: the modules the game refuses to remove are fitted first.
  async function cleanSlate(keepExterior) {
    if (busy()) return;
    const engine = (state.placements.find(p => isEngine(p[0])) || [])[0] || (D.base_ship.engines || [])[0];
    state.placements = []; if (!keepExterior) state.exterior = {}; state.preset = null; state.selected = -1; state.name = "Forge your own"; state.saints = false;
    holdHistory = true; render(); holdHistory = false;
    running = "tryadd";
    if (!solverReady) await new Promise(r => { const t = setInterval(() => { if (solverReady) { clearInterval(t); r(); } }, 50); });
    const core = []; for (const n in D.base_ship.never_removed) for (let i = 0; i < D.base_ship.never_removed[n]; i++) core.push(n);
    const kept = core.length; if (engine) core.push(engine);
    progressStart(0, "Laying the keel…");
    const r = await solve({ type: "tryadd", placements: [], add: core, seconds: 5, seed: 7 }, "tryadd");
    state.placements = r.placements; state.minCaps = D.base_ship.never_removed["Capacitor"] || 1; setMinsFromFit(); markDirty(); render();
    setStatus(`${state.hull}: clean slate with the ${kept} modules the game never removes (${[...new Set(core.slice(0, kept))].join(", ")})` + (engine ? ` and an engine (${engine}; + on another class switches it)` : "") + `. Add the rest from the palette, then forge for the role.`, "info");
  }

  // Build a Saints Doctrine ship: the game's never-removed modules, the hull's doctrine engine and every Saints module,
  // with the rules on (they stay on until another fit is loaded or Forge your own is pressed).
  async function saintsBuild(hull) {
    if (busy()) return;
    if (hull && hull !== state.hull) { state.hull = hull; startSolver(); }
    state.placements = []; state.exterior = {}; state.preset = null; state.selected = -1; state.saints = true; state.name = `Saints Doctrine ${state.hull}`;
    holdHistory = true; render(); holdHistory = false;
    running = "tryadd";
    if (!solverReady) await new Promise(r => { const t = setInterval(() => { if (solverReady) { clearInterval(t); r(); } }, 50); });
    const core = []; for (const n in D.base_ship.never_removed) for (let i = 0; i < D.base_ship.never_removed[n]; i++) core.push(n);
    const engine = SAINTS.engine[state.hull] || (D.base_ship.engines || [])[0]; if (engine && MOD[engine]) core.push(engine);
    for (const n in SAINTS.must) for (let i = 0; i < SAINTS.must[n]; i++) if (MOD[n]) core.push(n);
    progressStart(0, "Laying the keel of a Saints ship…");
    const r = await solve({ type: "tryadd", placements: [], add: core, seconds: 6, seed: 7 }, "tryadd");
    state.placements = r.placements; for (const n in SAINTS.mustExt) if (EXT[n]) state.exterior[n] = SAINTS.mustExt[n];
    state.minCaps = D.base_ship.never_removed["Capacitor"] || 1; setMinsFromFit(); markDirty(); render();
    setStatus(`Saints Doctrine ${state.hull}: ${engine ? engine + ", " : ""}${Object.keys(SAINTS.must).join(", ")} with its Directional Scanner fitted and kept. A Launch Bay brings an Autohelm. Add the rest from the palette, then forge for the role.` + (r.missing && r.missing.length ? ` No room for: ${r.missing.join(", ")}.` : ""), r.missing && r.missing.length ? "warn" : "info");
  }

  // ---------- Forge for the role: parallel searches until nothing better turns up ----------
  // Bench 2026-10-09 (27 runs, 9 fits x 3 seeds, 180 s): a single search reached only 92-99 % of the best found in 3 min,
  // while the best of three seeds in parallel was at 98.5-100 % within ~45 s; a stop after 30 s without a gain landed at
  // 95-100 % (mean ~99 %). Different seeds land in different layouts, so more searches beat more time.
  // The forge runs until Stop (user 2026-10-09: "it should be doing it forever, with a clear message that nothing better
  // was generated for the last N seconds, and an easy button to stop"). SETTLED_HINT: after this long without a gain the
  // bar turns gold and says so. FORGE_MAX is only the Workers' own budget (10 h), never reached in practice.
  const SETTLED_HINT = 300, FORGE_MAX = 36000, RESTART_AFTER = 15, POLISH_SECS = 12;
  const fmtSecs = s => s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s` : `${Math.floor(s)}s`;
  let pool = null;
  // one search per logical thread but one (the page keeps one for itself); a 10-core / 20-thread CPU runs 19. Capped at 32
  // so a big workstation does not open hundreds of Workers. (Was min(8, cores - 1) until 2026-10-09.)
  function forgeSearches() { return Math.max(2, Math.min(32, (navigator.hardwareConcurrency || 4) - 1)); }
  function forgeParallel(fillers, values, keepMin, keepSum) {
    const K = forgeSearches(), t0 = Date.now();
    // the solver's own score: the filler values, less a large amount for every total the fit is short of (solver.js scoreOf)
    const valueOf = pl => { let v = pl.reduce((a, p) => a + (values[p[0]] || 0), 0), short = 0; for (const g of keepSum || []) { const t = pl.reduce((a, p) => a + (g.per[p[0]] || 0), 0); if (t < g.min) short += (g.min - t) / g.min; } return short > 0 ? v - 1e17 * short : v; };
    const startOk = Object.keys(keepMin).every(f => (counts(state.placements)[f] || 0) >= keepMin[f]);
    const P = pool = { workers: [], best: startOk ? valueOf(state.placements) : -Infinity, bestPl: state.placements, lastGain: t0, gains: 0, iters: [], done: 0, stopping: false, reason: "", timer: null, t0, K,
                       wBest: [], wLast: [], restarting: [], restarts: 0, fillers, values, keepMin, keepSum };
    const init = { type: "init", hull: D.hulls[state.hull], modules: Object.fromEntries(D.modules.map(m => [m.name, { cells: m.cells }])) };
    const consider = m => { if (m.value > P.best) { P.best = m.value; P.bestPl = m.placements; P.lastGain = Date.now(); P.gains++; state.placements = m.placements; render(); } };
    const spawn = i => {
      let w; try { w = new Worker("solver.js?v=52969717"); } catch (e) { return null; }
      const launch = () => { P.wBest[i] = P.best; P.wLast[i] = Date.now(); P.restarting[i] = false;
        w.postMessage({ type: "optimize", placements: P.bestPl, fillers, values, keepMin, keepSum, seconds: FORGE_MAX, seed: (Date.now() + i * 7919 + P.restarts * 104729) & 0xffff || i + 1, maxSections: 3 }); };
      w.onmessage = e => {
        const m = e.data;
        if (m.type === "ready") launch();
        else if (m.type === "tick") P.iters[i] = (P.itersBase[i] || 0) + m.iterations;
        else if (m.type === "progress") { P.iters[i] = (P.itersBase[i] || 0) + m.iterations; if (m.value > (P.wBest[i] || 0)) { P.wBest[i] = m.value; P.wLast[i] = Date.now(); } consider(m); }
        else if (m.type === "done") { P.iters[i] = (P.itersBase[i] || 0) + m.iterations; consider(m); if (++P.done >= P.workers.length) forgePolish(P); }
      };
      w.onerror = () => { if (++P.done >= P.workers.length) forgePolish(P); };
      w.postMessage(init); return w;
    };
    P.itersBase = [];
    for (let i = 0; i < K; i++) { const w = spawn(i); if (!w) break; P.workers.push(w); }
    // a search that has gained nothing for a while, while the pool holds better, is replaced by a fresh one from the best
    P.restart = i => { P.restarting[i] = true; P.itersBase[i] = P.iters[i] || 0; P.workers[i].terminate(); P.restarts++; const w = spawn(i); if (w) P.workers[i] = w; };
    if (!P.workers.length) { pool = null; return false; }
    P.timer = setInterval(() => {
      const now = Date.now(), idle = (now - P.lastGain) / 1000, el = (now - P.t0) / 1000;
      const holdNow = hold(P.bestPl), its = P.iters.reduce((a, b) => a + (b || 0), 0);
      const settled = idle >= SETTLED_HINT;
      $("fb-fill").style.width = Math.min(100, idle / SETTLED_HINT * 100).toFixed(1) + "%"; $("fb-fill").classList.toggle("done", settled);
      $("fb-text").textContent = `Forging · ${P.workers.length} searches · ${fmtSecs(el)} · ${its.toLocaleString("en-US")} re-packs · ${holdNow} m³ · `
        + (P.gains ? `nothing better for ${fmtSecs(idle)}` : `no gain yet (${fmtSecs(idle)})`) + (settled ? " · press Stop to keep this fit" : "");
      // searches share their best: one that has gained nothing for a while, while the pool holds better, restarts from it
      if (!P.stopping) P.workers.forEach((w, i) => { if (!P.restarting[i] && P.wLast[i] && (now - P.wLast[i]) / 1000 >= RESTART_AFTER && (P.wBest[i] || 0) < P.best) P.restart(i); });
    }, 250);
    progressStart(0, `Forging · ${K} searches…`); $("fb-fill").classList.remove("busy"); $("fb-fill").style.width = "0%";
    return true;
  }
  function forgeStop(P, reason) {
    if (P.stopping) return; P.stopping = true; P.reason = reason;
    forgePolish(P);                                          // terminate() is the only stop a busy Worker hears
  }
  // after the searches settle (not after a manual Stop): one worker re-packs every section exhaustively, then finish
  function forgePolish(P) {
    if (P.polishing || P.finished) return; P.polishing = true;
    clearInterval(P.timer); P.workers.forEach(w => w.terminate());
    if (P.reason === "stopped") { forgeFinish(P); return; }
    let w; try { w = new Worker("solver.js?v=52969717"); } catch (e) { forgeFinish(P); return; }
    $("fb-fill").classList.add("busy"); $("fb-text").textContent = `Polishing · ${hold(P.bestPl)} m³…`;
    const t0 = Date.now(); P.polishWorker = w;
    w.onmessage = e => { const m = e.data;
      if (m.type === "ready") w.postMessage({ type: "polish", placements: P.bestPl, fillers: P.fillers, values: P.values, keepMin: P.keepMin, keepSum: P.keepSum, seconds: POLISH_SECS, seed: Date.now() & 0xffff, tries: 6 });
      else if (m.type === "progress" || m.type === "done") { if (m.value > P.best) { P.best = m.value; P.bestPl = m.placements; P.gains++; P.polishGains = (P.polishGains || 0) + 1; state.placements = m.placements; render(); }
        if (m.type === "progress") $("fb-text").textContent = `Polishing · ${hold(P.bestPl)} m³ · ${((Date.now() - t0) / 1000).toFixed(0)} s`;
        else { w.terminate(); forgeFinish(P); } } };
    w.onerror = () => { w.terminate(); forgeFinish(P); };
    w.postMessage({ type: "init", hull: D.hulls[state.hull], modules: Object.fromEntries(D.modules.map(m => [m.name, { cells: m.cells }])) });
    setTimeout(() => { if (!P.finished) { w.postMessage({ type: "stop" }); setTimeout(() => { w.terminate(); forgeFinish(P); }, 1500); } }, (POLISH_SECS + 4) * 1000);
  }
  function forgeFinish(P) {
    if (P.finished) return; P.finished = true;
    clearInterval(P.timer); P.workers.forEach(w => w.terminate()); if (P.polishWorker) P.polishWorker.terminate(); if (pool === P) pool = null;
    state.placements = P.bestPl; if (P.gains) markDirty(); render();
    const secs = ((Date.now() - P.t0) / 1000).toFixed(0), its = P.iters.reduce((a, b) => a + (b || 0), 0);
    const why = `stopped after ${fmtSecs(secs)}, nothing better for the last ${fmtSecs((Date.now() - P.lastGain) / 1000)}`;
    const extra = (P.restarts ? `, ${P.restarts} restarts from the best` : "") + (P.polishGains ? `, polish +${P.polishGains}` : "");
    if (window.__forge) window.__forge.last = { gains: P.gains, restarts: P.restarts, polishGains: P.polishGains || 0, secs, hold: hold(state.placements), reason: P.reason };
    progressDone(`Forged: ${P.gains} gains from ${P.workers.length} searches${extra}, ${its.toLocaleString("en-US")} re-packs · ${why} · ${hold(state.placements)} m³ hold`);
    $("btn-forge").textContent = "Forge for the role"; if (!/^Cap-stable/.test($("status").textContent)) setStatus("", "info");
    shortOfMinimums(P.keepMin, P.keepSum);
    forgeEnded();
  }
  // a minimum above what the hull can hold (with the other minimums kept) is never reached: say so instead of staying quiet
  function shortOfMinimums(keepMin, keepSum) {
    const c = counts(state.placements), short = Object.keys(keepMin || {}).filter(n => (c[n] || 0) < keepMin[n]);
    const f = n => n.toLocaleString("en-US"), sums = (keepSum || []).map(g => ({ g, has: sumNow(g.key) })).filter(x => x.has < x.g.min);
    const parts = short.map(n => `${keepMin[n]} ${n}${keepMin[n] === 1 ? "" : "s"} (has ${c[n] || 0})`).concat(sums.map(x => `${f(x.g.min)} ${SUM_UNIT[x.g.key]} (the closest so far is ${f(x.has)})`));
    if (parts.length) setStatus(`No room for ${parts.join(", ")} while keeping the other minimums. Lower a minimum to make room, remove a module by hand, or let the forge run longer.`, "warn");
  }
  let lastSums = null;                                      // the totals of the single in-page search, for its finish line
  function forge() {
    if (pool) { forgeStop(pool, "stopped"); return; }
    if (running) { solver.postMessage({ type: "stop" }); return; }
    if (!solverReady) { setStatus("Solver still loading…", "warn"); return; }
    const c = counts(state.placements);
    // Cap-stable rule (user 2026-10-09): once the estimated recharge covers the drain, Capacitors drop to the bottom of
    // the order, below every ticked row, wherever the pilot ranked them: the spare cells go to the other fillers first,
    // and Capacitors (the only 2-cell piece) fill what nothing else fits. Asking for more in "Keep at least" overrides it.
    const capsNow = c["Capacitor"] || 0, capsFor = +$("cap-stable-n").textContent || 0;
    const capStable = capsNow >= capsFor && state.minCaps <= capsNow && state.prio.cap > 0;
    const fillers = FILLERS.filter(f => state.prio[PRIO_OF[f]] > 0);
    if (!fillers.length) { setStatus("Tick at least one priority.", "bad"); return; }
    const prioOf = f => capStable && f === "Capacitor" ? 0.5 : state.prio[PRIO_OF[f]];      // 0.5: below rank 4, above empty
    // whole numbers only: the cap-stable Capacitor used to be worth 12 x 1000^-0.5 = 0.379..., and summing that in another
    // order differed in the last bits, so equal fits were counted as gains (audit 2026-10-11). 1 is still below every filler.
    const values = {}; fillers.forEach(f => values[f] = prioOf(f) < 1 ? 1 : FILL_BASE[f] * Math.pow(1000, prioOf(f) - 1));
    const keepMin = {};
    if (fillers.includes("Capacitor")) keepMin["Capacitor"] = Math.max(state.minCaps, D.base_ship.never_removed["Capacitor"] || 1, capStable ? capsFor : 0);
    // every other filler keeps at least what the pilot placed by hand (the base ship's one Fuel Bay, Repairer ...)
    fillers.forEach(f => { if (f !== "Capacitor") keepMin[f] = Math.min(c[f] || 0, D.base_ship.always[f] || 0); });
    // and never below the pilot's own minimums (a filler whose priority is off is not traded at all)
    for (const n in KEEP_IDS) if (fillers.includes(n)) keepMin[n] = Math.max(keepMin[n] || 0, state.mins[n] || 0);
    // the game's own never-removed modules among the fillers (one Cargo Container) stay whatever the totals say
    fillers.forEach(f => { const k = D.base_ship.never_removed[f] || 0; if (k && f !== "Capacitor") keepMin[f] = Math.max(keepMin[f] || 0, k); });   /* the game's minimum: a fit missing it (only Fuel Blisters, 2026-10-21) gets it back from the forge */
    fillers.forEach(f => { const k = saintsMin(f); if (k) keepMin[f] = Math.max(keepMin[f] || 0, k); });     /* Saints Doctrine: one Fuel Blister at least */
    // hold and fuel: totals, any mix. A total the fit already holds with its priority unticked needs nothing: those modules are not touched.
    const keepSum = []; for (const k in SUM_IDS) { const min = clampSum(k, state.mins[k]); if (min > 0 && (Object.keys(SUM_PER[k]).some(n => fillers.includes(n)) || sumNow(k) < min)) keepSum.push({ key: k, per: SUM_PER[k], min }); }
    forgeBefore = { snap: snap(), hull: state.hull, name: state.name, placements: JSON.parse(JSON.stringify(state.placements)), exterior: Object.assign({}, state.exterior), after: null }; hideForgeDiff();
    $("btn-forge").textContent = "Stop"; state.selected = -1;          // the searches reorder the modules: an index kept from before would point elsewhere
    setStatus(capStable ? `Cap-stable at ${capsNow} Capacitors: they come last. Spare cells go to ${[...new Set(fillers.map(f => PRIO_OF[f]))].filter(k => k !== "cap").sort((x, y) => state.prio[y] - state.prio[x]).map(k => PRIO_NAME[k]).join(", then ")}, then Capacitors fill what nothing else fits.` : "", "info");
    if (forgeParallel(fillers, values, keepMin, keepSum)) return;
    // no Workers here (the in-page solver): one search, 60 s
    running = "optimize"; progressStart(15, "Forging");            // in the page itself the search blocks everything: keep it short
    lastSums = keepSum; solver.postMessage({ type: "optimize", placements: state.placements, fillers, values, keepMin, keepSum, seconds: 15, seed: Date.now() & 0xffff, maxSections: 3 });
  }

  // ---------- presets, share, save ----------
  function loadPreset(n) {
    const p = D.presets.find(x => x.n === +n); if (!p || busy()) return;
    if (!D.hulls[p.hull]) { setStatus(`${docName(p)}: unknown hull "${p.hull}".`, "bad"); return; }
    state.hull = p.hull; state.placements = p.placements.map(x => [x[0], x[1], rotOf(x[0], x[3], x[2]) || 0, x[3].map(c => [c[0], c[1]])]); state.exterior = soundExterior(p.exterior);
    state.name = docName(p); state.preset = p.n; state.selected = -1; state.dirty = false; state.saints = !!p.doctrine;
    state.minCaps = counts(state.placements)["Capacitor"] || 1; setMinsFromFit();
    startSolver(); render(); setStatus(`${p.name} loaded (${p.role}). Keeping its ${state.minCaps} Capacitors, ${state.mins.hold.toLocaleString("en-US")} m³ of hold, ${state.mins.fuel.toLocaleString("en-US")} fuel and ${state.mins["Structural Brace"]} Braces unless you lower the minimums.`, "ok");
  }
  // Links store a module as its place in a name table. The table's fingerprint travels with the link (f), and data.js
  // keeps every table ever used (link_tables), so a link made before a patch added a module still reads right.
  const NAMES = D.modules.map(m => m.name), LINK_FP = D.link_fp || null, LINK_TABLES = D.link_tables || {};
  function linkTable(f) { if (f == null) return LINK_TABLES.legacy || NAMES; if (f === LINK_FP) return NAMES; return LINK_TABLES[f] || null; }
  // The compact link (2026-10-19, "is there a way to make the links shorter?"): "F" + base64url of bytes. Version 1:
  // version, flags (1 LAI, 2 changed, 4 preset, 8 data fingerprint), the fingerprint (4 bytes), the preset (u16), the
  // four priorities (3 bits each), the Capacitor minimum (u16), the kept totals (hold u16, fuel u16, Braces u8), the
  // name and the outside-the-hull list ("Name:count|...") as length-prefixed UTF-8, the module count (u16), then three
  // bytes a module: index 6 bits, section 4, turn/90 2, x + 32 6, y + 32 6. A 74-module LAI: about 330 characters.
  const b64u = a => btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function encodeBin(rows) {
    if (!rows.every(r => r[0] < 64 && r[1] < 16 && r[2] % 90 === 0 && r[3] >= -32 && r[3] < 32 && r[4] >= -32 && r[4] < 32) || rows.length > 600) return null;
    const B = [], u8 = v => B.push(v & 255), u16 = v => { u8(v >> 8); u8(v); }, te = new TextEncoder();
    const str = s => { const b = te.encode(s); if (b.length > 255) throw new Error("long"); u8(b.length); b.forEach(u8); };
    const fp = LINK_FP && /^[0-9a-f]{8}$/.test(LINK_FP) ? LINK_FP : null, pr = state.prio || {}, mins = state.mins || {};
    const flags = (state.hull === "LAI" ? 1 : 0) | (state.dirty ? 2 : 0) | (Number.isInteger(state.preset) && state.preset >= 0 && state.preset < 65536 ? 4 : 0) | (fp ? 8 : 0);
    try {
      u8(1); u8(flags);
      if (fp) for (let i = 0; i < 8; i += 2) u8(parseInt(fp.slice(i, i + 2), 16));
      if (flags & 4) u16(state.preset);
      const pv = ["hold", "cap", "fuel", "hp"].map(k => Math.max(0, Math.min(4, Math.round(+pr[k] || 0))));
      u16(pv[0] | pv[1] << 3 | pv[2] << 6 | pv[3] << 9);
      u16(Math.max(0, Math.min(65535, state.minCaps || 0)));
      u16(Math.max(0, Math.min(65535, Math.round(+mins.hold || 0)))); u16(Math.max(0, Math.min(65535, Math.round(+mins.fuel || 0)))); u8(Math.max(0, Math.min(255, +mins["Structural Brace"] || 0)));
      str(String(state.name).slice(0, 60));
      str(Object.keys(state.exterior).filter(n => state.exterior[n]).map(n => n + ":" + state.exterior[n]).join("|"));
      u16(rows.length);
      rows.forEach(r => { const v = r[0] << 18 | r[1] << 14 | (r[2] / 90) << 12 | (r[3] + 32) << 6 | (r[4] + 32); u8(v >> 16); u8(v >> 8); u8(v); });
    } catch (e) { return null; }
    return "F" + b64u(B);
  }
  function unbin(h) {                                       // the compact link -> the same object the JSON form gives
    let b; try { b = Uint8Array.from(atob(h.slice(1).replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); } catch (e) { return null; }
    let i = 0; const need = n => { if (i + n > b.length) throw new Error("short"); }, u8 = () => { need(1); return b[i++]; }, u16 = () => (u8() << 8) | u8();
    const str = () => { const n = u8(); need(n); const s = new TextDecoder("utf-8", { fatal: true }).decode(b.slice(i, i + n)); i += n; return s; };
    try {
      if (u8() !== 1) return null;
      const fl = u8(), o = { h: fl & 1 ? "LAI" : "Reiver", d: fl & 2 ? 1 : 0 };
      if (fl & 8) { let f = ""; for (let k = 0; k < 4; k++) f += u8().toString(16).padStart(2, "0"); o.f = f; }
      if (fl & 4) o.b = u16();
      const pv = u16(); o.r = { hold: pv & 7, cap: pv >> 3 & 7, fuel: pv >> 6 & 7, hp: pv >> 9 & 7 };
      o.c = u16(); o.k = { hold: u16(), fuel: u16(), "Structural Brace": u8() };
      o.n = str(); const ex = str(); o.e = {};
      if (ex) for (const x of ex.split("|")) { const m = x.match(/^(.{1,60}):(\d{1,3})$/); if (!m) return null; o.e[m[1]] = +m[2]; }
      const n = u16(); if (n > 600) return null; o.p = [];
      for (let k = 0; k < n; k++) { const v = u8() << 16 | u8() << 8 | u8(); o.p.push([v >> 18 & 63, v >> 14 & 15, (v >> 12 & 3) * 90, (v >> 6 & 63) - 32, (v & 63) - 32]); }
      return i === b.length ? o : null;
    } catch (e) { return null; }
  }
  function encode() {
    const idx = {}; NAMES.forEach((n, i) => idx[n] = i);
    const rows = state.placements.map(p => [idx[p[0]], p[1], rotOf(p[0], p[3], p[2]) || 0, Math.min(...p[3].map(c => c[0])), Math.min(...p[3].map(c => c[1]))]);
    const obj = { h: state.hull, n: String(state.name).slice(0, 60), e: state.exterior, r: state.prio, c: state.minCaps, k: state.mins, b: state.preset, d: state.dirty ? 1 : 0 };
    // q (2026-10-19, Discord's 2,000 characters): five characters a module (index, section, turn, x + 32, y + 32 in the
    // URL-safe base64 alphabet) instead of p's number lists, about half the link; p stays for anything q cannot hold
    const q = rows.every(r => r[0] < 64 && r[1] < 64 && r[3] > -32 && r[3] < 32 && r[4] > -32 && r[4] < 32) ? rows.map(r => Q64[r[0]] + Q64[r[1]] + Q64[r[2] / 90] + Q64[r[3] + 32] + Q64[r[4] + 32]).join("") : null;
    if (q) obj.q = q; else obj.p = rows;
    const bin = encodeBin(rows); if (bin) return bin;
    if (LINK_FP) obj.f = LINK_FP;
    const s = JSON.stringify(obj);
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const Q64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function unq(s) {                                         // q -> p's rows; null on anything that is not five clean characters a module
    if (typeof s !== "string" || s.length % 5 || s.length > 3000) return null;
    const rows = [];
    for (let i = 0; i < s.length; i += 5) { const v = [...s.slice(i, i + 5)].map(ch => Q64.indexOf(ch)); if (v.some(n => n < 0) || v[2] > 3) return null; rows.push([v[0], v[1], v[2] * 90, v[3] - 32, v[4] - 32]); }
    return rows;
  }
  const looksLikeFit = h => /^eyJ[A-Za-z0-9_-]{20,}$/.test(h) || /^F[A-Za-z0-9_-]{16,}$/.test(h);   // base64 of a JSON object, or the compact form
  // A link is somebody else's text (audit 2026-10-11: a crafted one ran script, froze the tab or loaded modules on top of
  // each other). Read into a fresh object, every field checked; one fault rejects the whole link and nothing is touched.
  function readLink(h) {
    let o; if (/^F/.test(String(h))) o = unbin(String(h)); else try { o = JSON.parse(decodeURIComponent(escape(atob(String(h).replace(/-/g, "+").replace(/_/g, "/"))))); } catch (e) { return null; }
    if (o && typeof o === "object" && o.q != null) { o.p = unq(o.q); if (!o.p) return null; }
    if (!o || typeof o !== "object" || typeof o.h !== "string" || !D.hulls[o.h] || !Array.isArray(o.p) || o.p.length > 600) return null;
    const table = linkTable(o.f); if (!table) return null;
    const list = [];
    for (const t of o.p) {
      if (!Array.isArray(t)) return null;
      const [mi, sec, rot, x, y] = t, m = Number.isInteger(mi) ? MOD[table[mi]] : null;
      if (!m || !ROTS.includes(rot) || !Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > 99 || Math.abs(y) > 99) return null;
      list.push([m.name, sec, rot, rotShape(m.cells, rot).map(c => [c[0] + x, c[1] + y])]);
    }
    const placements = soundPlacements(o.h, list); if (!placements) return null;
    const whole = (v, max) => Number.isInteger(v) ? Math.max(0, Math.min(max, v)) : 0;
    let prio = null; if (o.r && typeof o.r === "object") { prio = {}; for (const k of ["hold", "cap", "fuel", "hp"]) if (Number.isFinite(o.r[k])) prio[k] = Math.max(0, Math.min(4, Math.round(o.r[k]))); }
    const mins = o.k && typeof o.k === "object" ? minsFrom(o.k) : null;
    return { hull: o.h, name: (typeof o.n === "string" && o.n.trim() ? o.n.trim() : "Shared fit").slice(0, 60), placements, exterior: soundExterior(o.e), prio, minCaps: whole(o.c, 400), mins,
             preset: Number.isInteger(o.b) ? o.b : null, dirty: o.d != null ? !!o.d : null };
  }
  function decodeFit(h) { const L = readLink(h); return L && { hull: L.hull, name: L.name, exterior: L.exterior, placements: L.placements }; }
  function decode(h) {
    const L = readLink(h); if (!L) return false;
    state.hull = L.hull; state.name = L.name; state.exterior = L.exterior; state.placements = L.placements; state.selected = -1;
    if (L.prio) Object.assign(state.prio, L.prio);
    orderFromPrio(); renderOrder(); state.minCaps = L.minCaps; state.preset = L.preset; state.saints = !!(D.presets.find(p => p.n === L.preset) || {}).doctrine;
    if (L.mins) { state.mins = L.mins; syncKeepInputs(); } else setMinsFromFit();
    state.dirty = L.dirty != null ? L.dirty : (!!state.preset && !/^\+.+\+$/.test(state.name));   // old links: a named preset without the +marks+ was changed
    if (!state.minCaps) { state.minCaps = counts(state.placements)["Capacitor"] || 1; syncKeepInputs(); }
    return true;
  }
  // short links (2026-10-19): thesaintsforge.com/f/<id>, the fit kept in the site's store; anywhere else, or when the
  // store does not answer, the full link is used
  const SHORT_OK = () => /(^|\.)thesaintsforge\.com$/.test(location.hostname) || window.__forgeShortTest;
  function shortLink(hash) {
    if (!SHORT_OK()) return Promise.resolve(null);
    return fetch("/api/short", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ h: hash }) })
      .then(r => r.ok ? r.json() : null).then(d => d && d.ok && /^[A-Za-z0-9]{6,14}$/.test(d.id) ? location.origin + "/f/" + d.id : null).catch(() => null);
  }
  function linkNow() { const hash = encode(), long = (/^\/doctrine/.test(location.pathname) ? location.origin + "/fitting" : location.href.split("#")[0]) + "#" + hash; return shortLink(hash).then(s => s || long); }
  function copyLater(textP, msg) {
    // the clipboard call is made in the click itself with the text still to come, so the click still counts when it arrives
    if (navigator.clipboard && window.ClipboardItem) {
      navigator.clipboard.write([new ClipboardItem({ "text/plain": textP.then(t => new Blob([t], { type: "text/plain" })) })])
        .then(() => textP.then(t => setStatus(msg(t), "ok")), () => textP.then(t => copy(t, msg(t))));
    } else textP.then(t => copy(t, msg(t)));
  }
  function shareLink() {
    copyLater(linkNow(), t => /\/f\//.test(t) ? "Short link copied: " + t.replace(/^https?:\/\//, "") : "Proposal link copied. Paste it in Discord.");
  }
  function diffVsBase(base) {
    if (!base) return [];
    const c = counts(state.placements), bc = counts(base.placements), diff = []; const names = new Set([...Object.keys(c), ...Object.keys(bc)]);
    names.forEach(n => { const d = (c[n] || 0) - (bc[n] || 0); if (d) diff.push(`${d > 0 ? "+" : ""}${d} ${n}`); });
    return diff;
  }
  function discordText() { let msg = ""; copyLater(linkNow().then(link => { const r = discordBody(link); msg = r.msg; return r.t; }), () => msg); }
  function discordBody(link) {
    // a Discord message holds 2,000 characters without Nitro (tribe feedback 2026-10-19): the parts go in by rank and
    // a part that would pass the limit stays out (name and numbers, the changes, the link, then the module list)
    const LIMIT = 2000, st = stats(), c = counts(state.placements);
    const base = state.preset ? D.presets.find(p => p.n === state.preset) : null;
    const head = `**${state.name}** (${state.hull})` + (base && state.dirty ? ` — proposal vs ${docName(base)}` : "");
    const nums = `Hold ${st.hold} m³ · Fuel ${st.fuel} · Capacitor ${st.cap} GJ (${f1(st.rech)} GJ/s est, drain ${f1(st.drain)}) · Hull ~${st.hp} HP, ${st.repair} HP/s · ${st.draw.toFixed(1)} / ${st.power} MW`;
    const lines = Object.keys(c).sort((a, b) => c[b] - c[a] || a.localeCompare(b)).map(n => `${c[n]} ${n}`); const ext = Object.keys(state.exterior).filter(n => state.exterior[n]).map(n => `${state.exterior[n]} ${n}`);
    const mods = lines.join(", ") + (ext.length ? " · exterior: " + ext.join(", ") : "");
    const diff = base ? diffVsBase(base) : null;
    const changes = base && state.dirty ? (diff.length ? "Changes: " + diff.join(", ") : "Same modules as the doctrine fit, re-packed.") : "";
    const len = a => a.join("\n").length, parts = [head, nums], out = [];
    if (changes && len([...parts, changes]) <= LIMIT) parts.push(changes); else if (changes) out.push("the changes");
    const linkFits = len([...parts, link]) <= LIMIT;
    if (len([...parts, mods].concat(linkFits ? [link] : [])) <= LIMIT) parts.push(mods); else out.push("the module list");
    if (linkFits) parts.push(link); else out.push("the link (too long for one message: Copy proposal link, and send it on its own)");
    const t = parts.join("\n");
    return { t, msg: `Discord text copied (${t.length.toLocaleString("en-US")} of 2,000 characters)` + (out.length ? `. Left out to fit: ${out.join(", ")}. Copy layout image shows the whole fit.` : ".") };
  }
  // ---------- the layout as a picture (tribe feedback 2026-10-19: "copy/paste the layout page instead of a wall of text") ----------
  function layoutSvg() {
    const st = stats(), c = counts(state.placements), xe = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    const H0 = hullSvg(state.hull, state.placements, {}), hs = H0.svg, hw = H0.vw, hh = H0.vh;
    const keys = Object.keys(c).sort((a, b) => c[b] - c[a] || a.localeCompare(b));
    const ext = Object.keys(state.exterior).filter(n => state.exterior[n]);
    const W = 1600, LX = 1090, ROW = 34, legendH = 150 + keys.length * ROW + (ext.length ? 60 + ext.length * 28 : 0);
    const H = Math.max(900, legendH + 60), boxW = LX - 80, boxH = H - 200, k = Math.min(boxW / hw, boxH / hh);
    const hx = 40 + (boxW - hw * k) / 2, hy = 170 + (boxH - hh * k) / 2;
    const GOLD = "#d9b24c", RED = "#e3222c", INK = "#07070a", FG = "#f4f1ea", DIM = "#9a9aa6";
    const font = window.ForgeCard && window.ForgeCard.fontCss ? window.ForgeCard.fontCss() : "";
    const tile = (x, label, v) => `<text x="${x}" y="128" class="m" font-size="13" fill="${GOLD}" letter-spacing="2">${label}</text><text x="${x}" y="156" class="c" font-size="24" font-weight="800" fill="${FG}">${xe(v)}</text>`;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${font}`
      + `.c{font-family:'New Rocker',Georgia,serif;font-synthesis:none}.d{font-family:'New Rocker',Georgia,serif;font-synthesis:none}.m{font-family:Rajdhani,'IBM Plex Mono',Consolas,monospace;font-weight:700}`
      + `.modnum{font-family:Rajdhani,'Arial Narrow',Consolas,monospace;font-weight:700;fill:#fff;text-anchor:middle;paint-order:stroke;stroke:${INK};stroke-width:2.6px;stroke-linejoin:round}</style>`
      + `<rect width="${W}" height="${H}" fill="${INK}"/><rect x="0" y="0" width="14" height="${H}" fill="#8f1118"/><rect x="14" y="0" width="2" height="${H}" fill="${GOLD}"/>`
      + `<rect x="28" y="16" width="${W - 44}" height="${H - 32}" fill="none" stroke="${GOLD}" stroke-opacity=".55" stroke-width="2"/>`
      + `<text x="48" y="78" class="d" font-size="44" font-weight="900" fill="${GOLD}">${xe(state.name)}</text>`
      + `<text x="${W - 48}" y="62" class="m" font-size="16" fill="${DIM}" text-anchor="end" letter-spacing="2">${xe(state.hull)} · THESAINTSFORGE.COM/FORGE</text>`
      + tile(48, "HOLD", Number(st.hold).toLocaleString("en-US") + " m³") + tile(250, "FUEL", st.fuel.toLocaleString("en-US")) + tile(430, "CAPACITOR", st.cap + " GJ") + tile(640, "RECHARGE / DRAIN", f1(st.rech) + " / " + f1(st.drain))
      + tile(900, "HULL", "~" + st.hp.toLocaleString("en-US") + " HP") + tile(1110, "POWER", st.draw.toFixed(1) + " / " + st.power + " MW") + tile(1340, "CELLS", st.cells + " / " + st.total)
      + hs.replace(/^<svg viewBox="[^"]*"/, `<svg x="${hx.toFixed(1)}" y="${hy.toFixed(1)}" width="${(hw * k).toFixed(1)}" height="${(hh * k).toFixed(1)}" viewBox="0 0 ${hw} ${hh}"`)
      + `<text x="${LX}" y="212" class="m" font-size="14" fill="${GOLD}" letter-spacing="3">MODULES · ${state.placements.length}</text>`;
    keys.forEach((n, i) => { const y = 240 + i * ROW, col = (MOD[n] || { color: "#888" }).color;
      s += `<rect x="${LX}" y="${y}" width="22" height="22" fill="${col}" stroke="${INK}" stroke-width="2"/><text x="${LX + 34}" y="${y + 17}" class="m" font-size="20" fill="${FG}">${c[n]} × ${xe(n)}</text>`; });
    if (ext.length) { let y = 240 + keys.length * ROW + 30;
      s += `<text x="${LX}" y="${y}" class="m" font-size="14" fill="${GOLD}" letter-spacing="3">OUTSIDE THE HULL</text>`;
      ext.forEach((n, i) => { s += `<text x="${LX}" y="${y + 30 + i * 28}" class="m" font-size="19" fill="${DIM}">${state.exterior[n]} × ${xe(n)}</text>`; }); }
    return { svg: s + `</svg>`, W, H };
  }
  function layoutBlob() {
    const { svg, W, H } = layoutSvg();
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" })), img = new Image();
      img.onload = () => { try { const cv = document.createElement("canvas"); cv.width = W; cv.height = H; cv.getContext("2d").drawImage(img, 0, 0); URL.revokeObjectURL(url); cv.toBlob(b => b ? resolve(b) : reject(new Error("export failed")), "image/png"); } catch (e) { URL.revokeObjectURL(url); reject(e); } };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("the layout could not be drawn")); };
      img.src = url;
    });
  }
  function layoutImage() {
    const png = layoutBlob();
    const save = () => png.then(b => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = (state.name || "fit").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") + ".png"; document.body.appendChild(a); a.click(); a.remove(); setStatus("Layout image saved: drag it into Discord.", "ok"); }, e => setStatus("No image: " + e.message, "bad"));
    if (navigator.clipboard && window.ClipboardItem) {
      // the promise goes straight into the clipboard call, so the click still counts as the user's when the PNG is ready
      navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(() => setStatus("Layout image copied: paste it into Discord (Ctrl+V).", "ok"), save);
    } else save();
  }
  function copy(text, okMsg) {
    const done = () => setStatus(okMsg, "ok");
    const fallback = () => { $("share-out").hidden = false; $("share-text").value = text; $("share-text").select(); setStatus("Copy the text below.", "info"); };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
  }
  function savedFits() { try { return JSON.parse(localStorage.getItem("forge:saved") || "[]"); } catch (e) { return []; } }
  function saveFit() {
    const had = savedFits().some(x => x.name === state.name);
    const list = savedFits().filter(x => x.name !== state.name); list.unshift({ name: state.name, hull: state.hull, code: encode(), when: new Date().toISOString(), saints: !!state.saints });
    try { localStorage.setItem("forge:saved", JSON.stringify(list.slice(0, 30))); } catch (e) { setStatus("Could not save in this browser.", "bad"); return; }
    renderSaved(); setStatus(`Saved "${state.name}" in this browser${had ? " (it replaced the earlier fit of that name)" : ""}.`, "ok");
  }
  // Delete: the saved fit that carries the name on the page (load it first). The fit stays on the page, so a wrong
  // click costs nothing: Save puts it back. No confirm box: those never open inside an artifact.
  function syncUnsave() { const b = $("btn-unsave"); if (!b) return; const has = savedFits().some(x => x.name === state.name); b.disabled = !has; b.title = has ? `Remove "${state.name}" from the saved fits in this browser (the fit stays on the page)` : "Load a saved fit first: this removes it from the saved fits in this browser"; }
  function unsaveFit() {
    const name = state.name, list = savedFits(); if (!list.some(x => x.name === name)) { syncUnsave(); return; }
    try { localStorage.setItem("forge:saved", JSON.stringify(list.filter(x => x.name !== name))); } catch (e) { setStatus("Could not change the saved fits in this browser.", "bad"); return; }
    renderSaved(); setStatus(`Removed "${name}" from the saved fits in this browser. It is still on the page: Save puts it back.`, "ok");
  }
  function renderSaved() {
    const list = savedFits(); const sel = $("saved-sel");
    sel.innerHTML = `<option value="">Saved fits (this browser)…</option>` + list.map((x, i) => `<option value="${i}">${esc(x.name)} · ${esc(x.hull)}</option>`).join("");
    syncUnsave();
  }

  // ---------- the card dialog: the fit drawn in the doctrine-card design (cardgen.js), rendered to a PNG for Discord ----------
  let cardPng = null, cardTimer = null, downloads = undefined;
  // On the website the WORDS of the doctrine cards come from the tribe store (/api/cards, logged-in Saints only),
  // keyed by the fit's name; tribe.js hands them in through this hook (user 2026-10-15: the only Forge lives on the site).
  let cardText = {};
  window.__forgeCardText = d => { cardText = (d && d.cards && typeof d.cards === "object" && !Array.isArray(d.cards)) ? d.cards : {}; return Object.keys(cardText).length; };
  const cardWords = n => { if (cardText[n]) return cardText[n]; const l = String(n).toLowerCase(), k = Object.keys(cardText).find(x => x.toLowerCase() === l); return k ? cardText[k] : null; };   /* the store may hold a name in other capitals */
  const CF = ["title", "role", "origin", "motto", "latin", "sigil", "weapon", "purpose", "how", "why"];
  function cardOpts() {
    const base = state.preset ? D.presets.find(p => p.n === state.preset) : null;
    const doctrine = base && !state.dirty;
    const t = {}; CF.forEach(k => t[k] = $("cf-" + k).value);
    return { hull: state.hull, hullData: D.hulls[state.hull], placements: state.placements, exterior: state.exterior, text: t, sigil: t.sigil,
             eyebrow: doctrine ? "SAINTS DOCTRINE · SHIP FITS" : "FIT PROPOSAL · SAINTS FORGE" };
  }
  function openCard() {
    if (!window.ForgeCard || !K) { setStatus("The card design did not load (card.js).", "bad"); return; }
    const base = state.preset ? D.presets.find(p => p.n === state.preset) : null;
    const doctrine = base && !state.dirty;
    if (base && cardWords(base.name) && !(K.text && K.text[base.n])) { K.text = K.text || {}; K.text[base.n] = cardWords(base.name); }   /* the site: words from the store */
    const t = ForgeCard.texts({ preset: base, counts: counts(state.placements), exterior: state.exterior, name: state.name, hull: state.hull, dirty: state.dirty, diff: diffVsBase(base) });
    const k = base ? K.doctrine.indexOf(base.n) : -1;
    t.sigil = doctrine && k >= 0 ? K.roman[k] : "✠";
    if (doctrine && cardWords(base.name) && cardWords(base.name).sigil) t.sigil = cardWords(base.name).sigil;
    CF.forEach(f => $("cf-" + f).value = t[f] || "");
    $("card-sub").textContent = doctrine ? `${base.name}: the doctrine card, with the live numbers.` : "A proposal card: edit the words, then render the PNG for Discord.";
    cardPng = null; $("card-png").hidden = true; $("card-save").hidden = true; $("card-copy").hidden = true; $("card-status").textContent = "";
    $("cardmodal").hidden = false; document.body.style.overflow = "hidden";
    drawCard();
  }
  function closeCard() { $("cardmodal").hidden = true; document.body.style.overflow = ""; }
  function drawCard() { try { $("card-svg").innerHTML = ForgeCard.build(cardOpts()); } catch (e) { $("card-status").textContent = "Could not draw the card: " + e.message; } }
  async function renderCard() {
    const st = $("card-status"); st.textContent = "Rendering…"; st.className = "status info";
    try {
      const svg = ForgeCard.build(Object.assign(cardOpts(), { fonts: ForgeCard.fontCss() }));
      cardPng = await ForgeCard.toPng(svg, 1.5);
      const img = $("card-png"); if (img.src) URL.revokeObjectURL(img.src); img.src = URL.createObjectURL(cardPng); img.hidden = false;
      $("card-svg").innerHTML = "";
      if (downloads === undefined) downloads = (window.claude && window.claude.use) ? await window.claude.use("downloads").catch(() => null) : null;
      $("card-save").hidden = !(downloads || !window.claude); $("card-copy").hidden = !(navigator.clipboard && window.ClipboardItem);   /* a plain website downloads by itself */
      st.textContent = `PNG ready (${(cardPng.size / 1024).toFixed(0)} KB, 2880 × 1800).` + (window.FORGE_FONTS ? "" : " The PNG uses Georgia where New Rocker is not embedded.") + ($("card-save").hidden ? " Right-click the image to save or copy it." : "");
      st.className = "status ok";
    } catch (e) { st.textContent = "Render failed: " + e.message; st.className = "status bad"; }
  }
  function cardFilename() { return (($("cf-title").value || "card").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "card") + "-saints-card.png"; }
  async function saveCard() {
    if (!cardPng) return; const st = $("card-status");
    if (!downloads) {                                     // a plain website: the browser's own download (an artifact's sandbox blocked it, hence the capability below)
      const a = document.createElement("a"); a.href = URL.createObjectURL(cardPng); a.download = cardFilename(); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000); st.textContent = "Saved to your downloads."; st.className = "status ok"; return;
    }
    try { await downloads.save({ filename: cardFilename(), data: cardPng }); st.textContent = "Saved."; st.className = "status ok"; }
    catch (e) { st.textContent = e && e.code === "declined" ? "Save cancelled." : "Could not save: " + (e && e.message || e); st.className = "status warn"; }
  }
  async function copyCard() {
    if (!cardPng) return; const st = $("card-status");
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": cardPng })]); st.textContent = "Image copied: paste it into Discord."; st.className = "status ok"; }
    catch (e) { st.textContent = "Copy failed here; right-click the image and copy it instead."; st.className = "status warn"; }
  }

  // ---------- compare two fits ----------
  function cellMap(placements) { const m = new Map(); placements.forEach(p => p[3].forEach(c => m.set(`${p[1]}:${c[0]}:${c[1]}`, p[0]))); return m; }
  function otherFit() {
    const link = $("cmp-link").value.trim();
    const sm = link.match(/\/f\/([A-Za-z0-9]{6,14})\b/);
    if (sm && !link.includes("#")) {
      $("cmp-body").innerHTML = `<div class="note">Opening the short link...</div>`;
      fetch("/api/short?id=" + sm[1]).then(r => r.ok ? r.json() : null).then(d => { if ($("cmp-link").value.trim() !== link) return; if (d && d.ok && d.h) { $("cmp-link").value = location.origin + "/fitting#" + d.h; renderCompare(); } else $("cmp-body").innerHTML = `<div class="note">That short link is not known to the site.</div>`; }).catch(() => { $("cmp-body").innerHTML = `<div class="note">The site did not answer.</div>`; });
      return null;
    }
    if (link) { const h = link.includes("#") ? link.split("#")[1] : link; const f = decodeFit(h); if (!f) { $("cmp-body").innerHTML = `<div class="note">That is not a proposal link from this page.</div>`; return null; } return f; }
    const n = +$("cmp-sel").value; const p = D.presets.find(x => x.n === n); if (!p) return null;
    return { hull: p.hull, name: docName(p), placements: p.placements, exterior: soundExterior(p.exterior) };
  }
  function renderCompare() {
    const B = otherFit(); if (!B) { if (!$("cmp-link").value.trim()) $("cmp-body").innerHTML = `<div class="note">Pick a fit to compare with.</div>`; return; }
    const A = { hull: state.hull, name: state.name, placements: state.placements, exterior: state.exterior };
    const sa = statsOf(A.hull, A.placements, A.exterior), sb = statsOf(B.hull, B.placements, B.exterior);
    const same = A.hull === B.hull;
    let markA = new Set(), markB = new Set();
    if (same) { const ma = cellMap(A.placements), mb = cellMap(B.placements); for (const [k, v] of ma) if (mb.get(k) !== v) markA.add(k); for (const [k, v] of mb) if (ma.get(k) !== v) markB.add(k); }
    const f = (n, d) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d === undefined ? 0 : d });
    // [label, this fit, the other fit, decimals, which way is better: 1 = more, -1 = less (mass, EM signature), 0 = neither]
    const rows = [["Cells used", sa.cells, sb.cells, 0, 0], ["Hold m³", sa.hold, sb.hold, 0, 1], ["Fuel", sa.fuel, sb.fuel, 0, 1], ["Fuel hours (" + state.fuelGrade + ")", isFinite(sa.hours) ? sa.hours : 0, isFinite(sb.hours) ? sb.hours : 0, 1, 1],
                  ["Capacitor GJ", sa.cap, sb.cap, 0, 1], ["Recharge GJ/s est", sa.rech, sb.rech, 1, 1], ["Drain GJ/s", sa.drain, sb.drain, 1, 0], ["Hull HP", sa.hp, sb.hp, 0, 1], ["Repair HP/s", sa.repair, sb.repair, 0, 1], ["DPS spooled", sa.dpsRamped, sb.dpsRamped, 0, 1], ["Power MW", sa.draw, sb.draw, 1, 0],
                  ["Mass t", sa.mass / 1000, sb.mass / 1000, 0, -1], ["EM signature est", sa.em, sb.em, 0, -1]];
    const ca = counts(A.placements), cb = counts(B.placements); const names = new Set([...Object.keys(ca), ...Object.keys(cb)]); const diff = [];
    names.forEach(n => { const d = (ca[n] || 0) - (cb[n] || 0); if (d) diff.push([d, n]); });
    const ea = A.exterior || {}, eb = B.exterior || {}; new Set([...Object.keys(ea), ...Object.keys(eb)]).forEach(n => { const d = (ea[n] || 0) - (eb[n] || 0); if (d) diff.push([d, n + " (exterior)"]); });
    diff.sort((x, y) => y[0] - x[0]);
    $("cmp-body").innerHTML = `<div class="cmp-hulls"><div><div class="cmp-name">${esc(A.name)} <span>(this fit)</span></div>${hullSvg(A.hull, A.placements, { mark: markA, numbers: false }).svg}</div><div><div class="cmp-name">${esc(B.name)}</div>${hullSvg(B.hull, B.placements, { mark: markB, numbers: false }).svg}</div></div>` +
      `<div class="note">${same ? `Gold outlines mark the cells that differ: ${markA.size} on this fit, ${markB.size} on the other.` : "Different hulls: no cell-by-cell diff."}</div>` +
      `<table class="cmp-table"><tr><th></th><th>${esc(A.name)}</th><th>${esc(B.name)}</th><th>Δ</th></tr>` + rows.map(([l, a, b, d, dir]) => { const dd = +(a - b).toFixed(d); return `<tr><td>${l}</td><td>${f(a, d)}</td><td>${f(b, d)}</td><td class="${dd * dir > 0 ? "up" : dd * dir < 0 ? "down" : ""}">${dd > 0 ? "+" : ""}${f(dd, d)}</td></tr>`; }).join("") + `</table>` +
      `<div class="note">Green = this fit is better on that line, red = worse. For mass and EM signature less is better; cells, drain and power are neither.</div>` +
      `<div class="cmp-diff"><b>Modules</b>: ${diff.length ? diff.map(([d, n]) => `<span class="${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${+d} ${esc(n)}</span>`).join(", ") : "the same modules, placed differently"}.</div>`;
  }
  // ---------- what a forge changed, against the fit it started from: a small box under the status line ----------
  // (user 2026-10-12: a summary in the fitting window, not a dialog). It stays until the fit is edited, the old fit is
  // put back, the next forge starts, or it is closed.
  let forgeBefore = null;
  // [label, value of a stats object, decimals, +1 when more is better / -1 when less is better]
  const RES_ROWS = [["Hold m³", s => s.hold, 0, 1], ["Fuel", s => s.fuel, 0, 1], ["Capacitor GJ", s => s.cap, 0, 1], ["Recharge GJ/s", s => s.rech, 1, 1], ["Hull HP", s => s.hp, 0, 1], ["EM signature", s => s.em, 0, -1]];
  function hideForgeDiff() { const el = $("forgediff"); if (el) el.hidden = true; }
  function forgeEnded() {
    const B = forgeBefore, el = $("forgediff"); if (!B || !el) return;
    B.after = JSON.stringify(state.placements);
    if (B.after === JSON.stringify(B.placements)) { el.hidden = true; return; }           // nothing better was found: the finish line says so
    const sb = statsOf(B.hull, B.placements, B.exterior), sa = statsOf(state.hull, state.placements, state.exterior);
    const f = (n, d) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d }), sign = (n, d) => (n > 0 ? "+" : "−") + f(Math.abs(n), d);
    const moved = RES_ROWS.map(([label, get, d, dir]) => { const dd = +(get(sa) - get(sb)).toFixed(d); return dd ? `<span class="${dd * dir > 0 ? "up" : "down"}">${sign(dd, d)} ${esc(label)}</span>` : ""; }).filter(Boolean);
    const cb = counts(B.placements), ca = counts(state.placements), diff = [];
    new Set([...Object.keys(cb), ...Object.keys(ca)]).forEach(n => { const d = (ca[n] || 0) - (cb[n] || 0); if (d) diff.push([d, n]); }); diff.sort((x, y) => y[0] - x[0]);
    $("fd-head").innerHTML = `<span class="lab">The forge changed</span>` + (moved.length ? moved.join(" · ") : "the arrangement only: the numbers are the same");
    $("fd-mods").textContent = (diff.length ? diff.map(([d, n]) => `${d > 0 ? "+" : "−"}${Math.abs(d)} ${n}`).join(", ") : "The same modules, placed differently") + ` · ${sa.freeCells} free cell${sa.freeCells === 1 ? "" : "s"} left (was ${sb.freeCells})`;
    el.hidden = false;
  }
  function revertForge() {
    const B = forgeBefore; if (!B || busy()) return;
    restore(B.snap); hideForgeDiff(); setStatus("The fit from before the forge is back. Undo returns to the forged one.", "info");
  }
  function openCompare() {
    const sel = $("cmp-sel"); sel.innerHTML = D.presets.filter(p => p.hull === state.hull).concat(D.presets.filter(p => p.hull !== state.hull)).map(p => `<option value="${esc(p.n)}">${esc(docName(p))} · ${esc(p.hull)}</option>`).join("");
    if (state.preset && D.presets.some(p => p.n === state.preset)) sel.value = state.preset;
    $("cmp-link").value = ""; $("cmpmodal").hidden = false; document.body.style.overflow = "hidden"; renderCompare();
  }

  // ---------- the shopping list: modules to print, materials summed ----------
  function shopping() {
    const c = counts(state.placements), ext = state.exterior, R = D.recipes || {};
    const rows = [], mats = {}, noRecipe = []; let secs = 0;
    const all = Object.keys(c).sort().map(n => [n, c[n]]).concat(Object.keys(ext).filter(n => ext[n]).sort().map(n => [n, ext[n]]));
    // External Thrusters are not fitted on the page (six come with an engine), but a new ship still needs them: the list
    // keeps them as a reminder (user 2026-10-12: "good to have it in the recipe of a new ship, in case they're missing")
    const engines = engineCount(c), autoNames = new Set(); if (engines) D.exterior.forEach(e => { if (e.auto) { all.push([e.name, 6 * engines]); autoNames.add(e.name); } });
    for (const [n, k] of all) {
      const r = R[n];
      if (!r) { noRecipe.push(`${k}x ${n}`); rows.push({ n, k, fac: "no known recipe" }); continue; }
      const runs = Math.ceil(k / (r.makes || 1)); rows.push({ n, k, fac: r.facility.replace(" (ship module)", "") + (autoNames.has(n) ? ", or reuse the six from an old engine" : ""), time: (r.time_s || 0) * runs });
      secs += (r.time_s || 0) * runs;
      for (const m in r.in) mats[m] = (mats[m] || 0) + r.in[m] * runs;
    }
    return { rows, mats, secs, noRecipe };
  }
  function shopText() {
    const s = shopping(), f = n => n.toLocaleString("en-US");
    let t = `${state.name} (${state.hull}) — shopping list\n\nMODULES TO PRINT\n`;
    for (const r of s.rows) t += `${r.k}x ${r.n}  (${r.fac})\n`;
    t += `\nMATERIALS, TOTAL\n`;
    for (const m of Object.keys(s.mats).sort((a, b) => s.mats[b] - s.mats[a])) t += `${f(s.mats[m])}x ${m}\n`;
    t += `\nPrint time about ${Math.round(s.secs / 60)} min on the printers. Command Pod and Weapon Receiver come with the ship; salvage spares from wrecks. External Thrusters: reuse the six from an old engine if you have one.`;
    return t;
  }
  function openShop() {
    const s = shopping(), f = n => n.toLocaleString("en-US");
    $("shop-sub").textContent = `${state.name} · ${s.rows.length} kinds of module · print time about ${Math.round(s.secs / 60)} min`;
    const mats = Object.keys(s.mats).sort((a, b) => s.mats[b] - s.mats[a]);
    $("shop-body").innerHTML = `<div><h3>Modules to print</h3><table>${s.rows.map(r => `<tr><td class="n">${+r.k}x</td><td>${esc(r.n)}</td><td class="f">${esc(r.fac)}</td></tr>`).join("")}</table>` +
      `<div class="note">Command Pod and Weapon Receiver have no printer recipe: they come with the ship, and wrecks drop spares. External Thrusters are the same on every engine: move the six over from an old engine if you have one, print them if not.</div></div>` +
      `<div><h3>Materials, total</h3><table>${mats.map(m => `<tr><td class="n">${f(s.mats[m])}x</td><td>${esc(m)}</td></tr>`).join("")}</table>` +
      `<div class="note">Recipes as read from the Industry window; the simplest printer that makes each module (the Emergency Printer where it can, else the Mini Printer; the ship Printer makes the same). Refining the raw ore into these is one step further.</div></div>`;
    $("shopmodal").hidden = false; document.body.style.overflow = "hidden";
  }
  // "Build it in the Lodge" (its own button under the share row): every module of the fit becomes a goal of the Mason's Lodge. On the site the Lodge is the
  // next page over (window.__lodgeImport + window.__siteGo); stand-alone, the fit travels in the Lodge's link as
  // #build-<base64url JSON> (a link keeps only letters, digits, - and _ after the #).
  const LODGE_URL = "https://www.thesaintsforge.com/building";       // the Lodge lives on the site only (user 2026-10-15)
  function lodgePayload() { return { name: state.name, hull: state.hull, goals: shopping().rows.map(r => ({ item: r.n, qty: r.k })) }; }
  function lodgeLink(p) {
    const b = btoa(unescape(encodeURIComponent(JSON.stringify(p)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return (window.__siteGo ? "/building" : LODGE_URL) + "#build-" + b;
  }

  // ---------- the guided first visit ----------
  const TOUR = [
    { at: "#hull-svg", title: "This is your ship", text: "The hull, drawn like the game's fitting window: every coloured block is a module sitting in the cells it needs. Drag a module to move it, R turns it, drag it off the window to remove it. Zoom − and + above it make the window larger or smaller." },
    { at: "#palette", title: "Everything you can fit", text: "Every module in the game, with the cells it takes. Press + to fit one (the forge finds a spot, rearranging if it must), or drag it straight onto the hull." },
    { at: ".tiles", title: "These numbers decide if you get home", text: "Hold, fuel and how many hours it lasts, capacitor and whether it stays charged with everything running, hull HP, power. The ◀ ▶ arrows add or remove the module behind each one." },
    { at: "#hints", title: "What should I change?", text: "Red checks are rules the game enforces. Below them, one-line advice a new rider wishes they had known, each with a button that does it." },
    { at: "#btn-forge", title: "Forge for the role", text: "Set what matters (hold, capacitor, fuel, armour) and press Forge: several searches fill the spare cells at once and keep looking until you press Stop. The bar says how long it has been since anything better turned up. Then share the fit with a proposal link." },
  ];
  let tourI = -1;
  function tourSeen() { try { return localStorage.getItem("forge:tour") === "done"; } catch (e) { return true; } }
  function tourShow(i) {
    const box = $("tour"); if (!box) return;
    document.querySelectorAll(".tour-hi").forEach(e => e.classList.remove("tour-hi"));
    if (i < 0 || i >= TOUR.length) { box.hidden = true; tourI = -1; if ($("tour-never").checked) { try { localStorage.setItem("forge:tour", "done"); } catch (e) {} } return; }
    tourI = i; const step = TOUR[i]; const el = document.querySelector(step.at);
    box.hidden = false; $("tour-step").textContent = `${i + 1} / ${TOUR.length}`; $("tour-title").textContent = step.title; $("tour-text").textContent = step.text;
    $("tour-next").textContent = i === TOUR.length - 1 ? "Done" : "Next";
    if (el) { el.classList.add("tour-hi"); el.scrollIntoView({ block: "nearest" }); }
    // place the box beside the highlighted element, inside the viewport
    const r = el ? el.getBoundingClientRect() : { left: innerWidth / 2 - 190, right: innerWidth / 2 + 190, top: innerHeight / 2, bottom: innerHeight / 2 };
    const b = box.querySelector(".tour-box"), W = Math.min(380, innerWidth - 32), H = 200;
    let x = r.right + 16, y = r.top;
    if (x + W > innerWidth - 16) x = r.left - W - 16;
    if (x < 16) { x = Math.max(16, Math.min(innerWidth - W - 16, r.left)); y = r.bottom + 16; }
    if (y + H > innerHeight - 16) y = Math.max(16, innerHeight - H - 16);
    b.style.left = x + "px"; b.style.top = Math.max(16, y) + "px";
  }
  function tourWire() {
    if (!$("tour")) return;
    $("tour-next").addEventListener("click", () => tourShow(tourI + 1));
    $("tour-skip").addEventListener("click", () => tourShow(-1));
    $("tour-never").addEventListener("change", e => { try { if (e.target.checked) localStorage.setItem("forge:tour", "done"); else localStorage.removeItem("forge:tour"); } catch (x) {} });
    if ($("tour-open")) $("tour-open").addEventListener("click", () => { $("tour-never").checked = false; tourShow(0); });
    document.addEventListener("keydown", e => { if (tourI >= 0 && e.key === "Escape") tourShow(-1); });
    // A mouse wheel over a focused number box changes its value in every browser: scrolling the page with the pointer
    // on "Keep at least ... Capacitors" quietly took it down to 1, and the next forge traded the Capacitors away
    // (2026-10-12). The box lets go of the focus instead, so the wheel scrolls the page and the number stays.
    document.addEventListener("wheel", e => { const t = document.activeElement; if (t && t === e.target && t.tagName === "INPUT" && t.type === "number") t.blur(); }, { passive: true, capture: true });
    window.addEventListener("resize", () => { if (tourI >= 0) tourShow(tourI); });
    // the site's other pages: the tour waits while the Forge is not on screen and picks up where it was when it is back
    window.addEventListener("site:page", e => { if (tourI < 0 || !$("tour")) return; if (e.detail === "forge") tourShow(tourI); else { $("tour").hidden = true; document.querySelectorAll(".tour-hi").forEach(x => x.classList.remove("tour-hi")); } });
    // first visit: the tour waits until the Forge is on screen (the public site opens on About us; a proposal link skips it)
    const tourStart = () => {
      const fp = document.getElementById("tab-forge"), visible = () => !fp || (!fp.hidden && fp.offsetParent !== null);
      if (visible()) { tourShow(0); return; }
      const again = () => { if (visible()) { window.removeEventListener("resize", again); setTimeout(() => { if (!tourSeen() && tourI < 0) tourShow(0); }, 500); } };
      window.addEventListener("resize", again);
    };
    if (!tourSeen() && location.hash.length <= 8) setTimeout(tourStart, 900);
  }

  // ---------- wiring ----------
  function wire() {
    tourWire();
    $("btn-shop").addEventListener("click", openShop);
    $("btn-compare").addEventListener("click", openCompare);
    $("cmp-close").addEventListener("click", () => { $("cmpmodal").hidden = true; document.body.style.overflow = ""; });
    if ($("forgediff")) { $("fd-close").addEventListener("click", hideForgeDiff); $("fd-revert").addEventListener("click", revertForge); }
    $("cmpmodal").addEventListener("click", e => { if (e.target === $("cmpmodal")) { $("cmpmodal").hidden = true; document.body.style.overflow = ""; } });
    $("cmp-sel").addEventListener("change", () => { $("cmp-link").value = ""; renderCompare(); });
    $("cmp-link").addEventListener("input", renderCompare);
    $("shop-close").addEventListener("click", () => { $("shopmodal").hidden = true; document.body.style.overflow = ""; });
    $("shopmodal").addEventListener("click", e => { if (e.target === $("shopmodal")) { $("shopmodal").hidden = true; document.body.style.overflow = ""; } });
    $("shop-copy").addEventListener("click", () => copy(shopText(), "Shopping list copied."));
    const freshLodgeLink = () => { $("btn-lodge").href = lodgeLink(lodgePayload()); };   // the link always carries the fit as it is now
    ["pointerenter", "focus", "pointerdown"].forEach(ev => $("btn-lodge").addEventListener(ev, freshLodgeLink));
    $("btn-lodge").addEventListener("click", e => {
      freshLodgeLink();
      if (!(window.__lodgeImport && window.__siteGo)) return;          // stand-alone: the link opens the Lodge itself
      e.preventDefault();
      window.__lodgeImport(lodgePayload()); window.__siteGo("lodge");
    });
    if ($("btn-card")) {                                   // the public edition (tools/build_forge_public.py) has no cards
      $("btn-card").addEventListener("click", openCard);
      $("card-close").addEventListener("click", closeCard);
      $("cardmodal").addEventListener("click", e => { if (e.target === $("cardmodal")) closeCard(); });
      document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("cardmodal").hidden) closeCard(); });
      $("card-form").addEventListener("input", () => { clearTimeout(cardTimer); cardTimer = setTimeout(() => { if (!$("card-png").hidden) { $("card-png").hidden = true; $("card-save").hidden = true; $("card-copy").hidden = true; cardPng = null; } drawCard(); }, 200); });
      $("card-render").addEventListener("click", renderCard);
      $("card-save").addEventListener("click", saveCard);
      $("card-copy").addEventListener("click", copyCard);
    }
    $("hull-sel").addEventListener("change", e => { if (busy()) { e.target.value = state.hull; return; } if (state.saints && !state.preset) { saintsBuild(e.target.value); return; } state.hull = e.target.value; startSolver(); const stock = D.presets.find(p => p.starter && p.hull === state.hull); if (stock) loadPreset(stock.n); else cleanSlate(false); });   /* a hull's stock fit, as the game builds it, when the edition has one */
    $("btn-own").addEventListener("click", () => cleanSlate(false));
    if ($("saints-build")) $("saints-build").addEventListener("click", e => { const b = e.target.closest("button[data-sb]"); if (b) saintsBuild(b.dataset.sb); });
    $("preset-sel").addEventListener("change", e => { if (e.target.value) loadPreset(e.target.value); e.target.value = ""; });
    $("fit-name").addEventListener("input", e => { state.name = e.target.value; syncUnsave(); });
    $("hints").addEventListener("click", e => { const b = e.target.closest("button[data-hint]"); if (b && !running && !pool) applyHint(+b.dataset.hint); });
    if ($("emwhy")) $("emwhy").addEventListener("click", async e => {
      const b = e.target.closest("button[data-emadd]"); if (!b || busy()) return;
      const scr = (D.models.em || {}).scrambler, want = +b.dataset.emadd || 1; let added = 0;
      for (let k = 0; k < want; k++) { if (!(await addModule(scr, true))) break; added++; }
      const st = stats();
      setStatus(added ? `${added} ${scr}${added > 1 ? "s" : ""} fitted: ~${Math.round(st.em)} with everything on, ~${Math.round(st.emWith(st.emDark, st.scramblers))} hiding.` + (added < want ? ` No room for ${want - added} more.` : "")
                      : `No room for an ${scr}, even after rearranging.`, added ? "ok" : "bad");
    });
    document.querySelector(".tiles").addEventListener("click", e => { const b = e.target.closest("button[data-adj]"); if (b) adjust(b.dataset.adj, +b.dataset.d); });
    $("palette").addEventListener("pointerdown", paletteDown);
    document.addEventListener("pointermove", paletteMove, { passive: false });
    document.addEventListener("pointerup", paletteUp);
    document.addEventListener("pointercancel", paletteUp);
    document.addEventListener("keydown", e => { if (pdrag && pdrag.shown && (e.key === "r" || e.key === "R" || e.key === "e" || e.key === "E")) { pdrag.rot = (pdrag.rot + (e.key === "r" ? 270 : 90)) % 360; pdrag.ghost.remove(); pdrag.ghost = ghostFor(pdrag.name, pdrag.rot); e.stopImmediatePropagation(); } }, true);
    $("palette").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.add) addModule(b.dataset.add); else if (b.dataset.sub) subModule(b.dataset.sub);
      else if ((b.dataset.addx || b.dataset.subx) && busy()) return;
      else if (b.dataset.addx && EXT[b.dataset.addx] && EXT[b.dataset.addx].auto) return;
      else if (b.dataset.addx) { state.exterior[b.dataset.addx] = (state.exterior[b.dataset.addx] || 0) + 1; markDirty(); render(); }
      else if (b.dataset.subx && state.saints && (state.exterior[b.dataset.subx] || 0) <= ((SAINTS.mustExt || {})[b.dataset.subx] || 0)) setStatus(`${b.dataset.subx} is required on every Saints Doctrine ship.`, "bad");
      else if (b.dataset.subx) { state.exterior[b.dataset.subx] = Math.max(0, (state.exterior[b.dataset.subx] || 0) - 1); if (!state.exterior[b.dataset.subx]) delete state.exterior[b.dataset.subx]; markDirty(); render(); }
    });
    $("btn-ccw").addEventListener("click", () => turnSelected("ccw"));
    $("btn-cw").addEventListener("click", () => turnSelected("cw"));
    $("btn-180").addEventListener("click", () => turnSelected("half"));
    $("btn-remove").addEventListener("click", removeSelected);
    $("btn-lock").addEventListener("click", () => lockSelected(1));
    $("btn-keepsec").addEventListener("click", () => lockSelected(2));
    const keysOff = e => e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT" || !!document.querySelector(".modal:not([hidden])") || !$("grid").offsetParent;   // offsetParent: the Forge is not the page on screen
    document.addEventListener("keydown", e => { if (keysOff(e) || e.ctrlKey || e.metaKey || e.altKey) return; if (e.key === "r") turnSelected("cw"); if (e.key === "R" || e.key === "e" || e.key === "E") turnSelected("ccw"); if (e.key === "f" || e.key === "F") turnSelected("half"); if (e.key === "Delete" || e.key === "Backspace") removeSelected(); if (e.key === "l" || e.key === "L") lockSelected(1); if (e.key === "k" || e.key === "K") lockSelected(2); });
    document.addEventListener("keydown", e => {
      if (!(e.ctrlKey || e.metaKey) || keysOff(e)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); } else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    });
    $("btn-undo").addEventListener("click", undo); $("btn-redo").addEventListener("click", redo);
    renderOrder();
    $("order").addEventListener("click", e => {
      const b = e.target.closest("button[data-up], button[data-down]"); if (!b) return;
      const k = b.dataset.up || b.dataset.down, i = state.order.indexOf(k), j = b.dataset.up ? i - 1 : i + 1;
      if (j < 0 || j >= state.order.length) return;
      [state.order[i], state.order[j]] = [state.order[j], state.order[i]]; prioFromOrder(); renderOrder();
    });
    $("order").addEventListener("change", e => { const c = e.target.closest("input[data-on]"); if (!c) return; state.prio[c.dataset.on] = c.checked ? 1 : 0; prioFromOrder(); renderOrder(); });
    $("min-caps").addEventListener("input", e => { state.minCaps = +e.target.value || 0; });
    for (const n in KEEP_IDS) $(KEEP_IDS[n]).addEventListener("input", e => { state.mins[n] = Math.max(0, Math.floor(+e.target.value || 0)); });
    for (const k in SUM_IDS) { $(SUM_IDS[k]).addEventListener("input", e => { state.mins[k] = clampSum(k, e.target.value); }); $(SUM_IDS[k]).addEventListener("change", syncKeepInputs); }
    document.querySelectorAll("[data-kstep]").forEach(b => b.addEventListener("click", () => { if (busy()) return; stepSum(b.dataset.kstep, +b.dataset.d); }));
    $("btn-makestable").addEventListener("click", makeCapStable);
    $("btn-capstable").addEventListener("click", () => { const n = +$("cap-stable-n").textContent; state.minCaps = n; $("min-caps").value = n; setStatus(`Minimum Capacitors set to ${n}: estimated recharge covers everything firing at once.`, "ok"); });
    $("fuel-sel").addEventListener("change", e => { state.fuelGrade = e.target.value; renderStats(); });
    $("btn-forge").addEventListener("click", forge);
    $("btn-share").addEventListener("click", shareLink);
    $("btn-discord").addEventListener("click", discordText);
    $("btn-layoutimg").addEventListener("click", layoutImage);
    $("btn-save").addEventListener("click", saveFit); if ($("btn-unsave")) $("btn-unsave").addEventListener("click", unsaveFit);
    $("saved-sel").addEventListener("change", e => { if (busy()) { e.target.value = ""; return; } const x = savedFits()[+e.target.value]; if (x && decode(x.code)) { if (x.saints) state.saints = true; startSolver(); render(); setStatus(`Loaded "${x.name}".`, "ok"); } else if (x) setStatus(`"${x.name}" could not be read: it was saved by a different version of the Fitting Tool.`, "bad"); e.target.value = ""; });
    $("btn-clear").addEventListener("click", () => cleanSlate(false));
    const ZOOMS = [0.4, 0.5, 0.63, 0.8, 1, 1.25, 1.6, 2, 2.5, 3];
    $("zoom-in").addEventListener("click", () => { state.zoom = ZOOMS.find(z => z > state.zoom + 0.005) || 3; fitZoom(); });
    $("zoom-out").addEventListener("click", () => { state.zoom = ZOOMS.slice().reverse().find(z => z < state.zoom - 0.005) || 0.4; fitZoom(); });
    $("zoom-fit").addEventListener("click", () => { state.zoom = 1; fitZoom(); });
    // Ctrl + wheel over the fitting window zooms it (a touchpad pinch arrives the same way, in many small steps); a plain wheel still scrolls the page
    $("grid").addEventListener("wheel", e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const d = Math.max(-50, Math.min(50, e.deltaY)); state.zoom = Math.max(0.4, Math.min(3, +(state.zoom * Math.exp(-d * 0.004)).toFixed(3))); fitZoom(); }, { passive: false });
    window.addEventListener("resize", fitZoom);
    renderSaved();
  }

  if (/[?&]dev=1/.test(location.search)) window.__forge = { state, strip() { const keep = {}; state.placements = state.placements.filter(p => { if (!["Cargo Container", "Emergency Container", "Capacitor"].includes(p[0])) return true; keep[p[0]] = (keep[p[0]] || 0) + 1; return keep[p[0]] <= (D.base_ship.never_removed[p[0]] || 0); }); render(); }, hold: () => hold(state.placements), get pool() { return pool; }, last: null };
  function renderPresetSelect() {
    const sel = $("preset-sel"), cur = sel.value;
    sel.innerHTML = `<option value="">${D.presets.some(p => p.doctrine) ? "Load a doctrine fit…" : "Load a fit…"}</option>` + D.presets.map(p => `<option value="${esc(p.n)}">${esc(docName(p))} · ${esc(p.hull)}${p.role ? " · " + esc(p.role) : ""}</option>`).join("");
    if (cur) sel.value = cur;
  }
  // the public site adds the doctrine fits here once a tribe member has logged in (tribe.js)
  // the fit on screen in the preset shape (tribe.js "Set as doctrine" writes it into the site's doctrine store)
  window.__forgeCurrentFit = () => ({ name: state.name, hull: state.hull, placements: state.placements.map(p => [p[0], p[1], rotOf(p[0], p[3], p[2]) || 0, p[3].map(c => [c[0], c[1]])]), exterior: Object.assign({}, state.exterior), preset: state.preset });
  // for the Doctrine page: a stored fit made sound (or null), and loading a stored doctrine fit by its name
  window.__forgeSoundFit = p => { if (!p || !D.hulls[p.hull] || !Array.isArray(p.placements)) return null; const pl = soundPlacements(p.hull, JSON.parse(JSON.stringify(p.placements))); return pl ? { placements: pl, exterior: soundExterior(p.exterior) } : null; };
  window.__forgeBuildIt = () => { if (!(window.__lodgeImport && window.__siteGo)) return false; window.__lodgeImport(lodgePayload()); window.__siteGo("lodge"); return true; };   /* the Doctrine page's Build it */
  window.__forgeLinkNow = () => linkNow();          /* the Doctrine page's fit link: the fit on the page as a short link (or the full one) */
  window.__forgeLoadByName = name => { const l = String(name).toLowerCase(); const p = D.presets.find(x => x.fromStore && String(x.name).toLowerCase() === l) || D.presets.find(x => String(x.name).toLowerCase() === l); if (!p || busy()) return false; loadPreset(p.n); return true; };
  window.__forgeAddPresets = list => {
    let next = D.presets.reduce((m, p) => Math.max(m, +p.n || 0), 100) + 1, added = 0; const skipped = [];
    for (const p of list || []) {
      if (!p || typeof p.name !== "string" || !p.name.trim() || !D.hulls[p.hull] || !Array.isArray(p.placements)) continue;
      const sound = soundPlacements(p.hull, p.placements); if (!sound) { skipped.push(p.name.slice(0, 40)); continue; }   // unknown module, overlap, outside the hull
      p.placements = sound; p.exterior = soundExterior(p.exterior);
      if (D.presets.some(x => x.n === p.n || String(x.name).toLowerCase() === p.name.toLowerCase())) continue;
      if (!Number.isInteger(p.n)) p.n = next++;
      p.fromStore = true; D.presets.push(p); added++;
    }
    renderPresetSelect(); if (skipped.length) setStatus(`Not loaded, the layout is not valid: ${skipped.join(", ")}.`, "warn"); return added;
  };
  // The store's list after a save (set as doctrine, rename, remove, upload): the doctrine fits loaded from the store
  // make way for the new list and the fit on the page STAYS (the page used to reload and fall back to its first
  // fit; user 2026-10-12). `cur` = the number of the fit that was just saved from the page: the page then shows it
  // as that doctrine fit (its doctrine name, not a proposal).
  window.__forgeReplacePresets = (list, cur) => {
    for (let i = D.presets.length - 1; i >= 0; i--) if (D.presets[i].fromStore) D.presets.splice(i, 1);
    const added = window.__forgeAddPresets(JSON.parse(JSON.stringify(list || [])));
    const p = cur != null ? D.presets.find(x => x.n === cur) : null;
    if (p) { state.preset = p.n; state.name = docName(p); state.dirty = false; }
    else if (!D.presets.some(x => x.n === state.preset)) state.preset = null;      // its doctrine fit is gone or renamed: the fit stays, on its own
    renderPresetSelect(); render();
    if (p) setStatus(`${p.name} is saved as doctrine: this is the fit every Saint loads from now on. It stays on the page.`, "ok");
    return added;
  };
  const BAD_LINK = "That link does not hold a fit this page can read: it is damaged, or was made by a newer Forge (reload the page).";
  function boot() {
    renderPresetSelect();
    wire();
    const h = location.hash.replace(/^#/, "");
    if (h && decode(h)) { $("min-caps").value = state.minCaps || (counts(state.placements)["Capacitor"] || 1); state.minCaps = +$("min-caps").value; startSolver(); render(); setStatus(`Shared fit "${state.name}" loaded.`, "ok"); }
    else { loadPreset(D.presets.some(p => p.n === 8) ? 8 : D.presets[0].n); if (looksLikeFit(h)) setStatus(BAD_LINK, "bad"); else if (h === "nofit") setStatus("That short link is not known to the site.", "bad"); }
    window.addEventListener("hashchange", () => {            // a proposal link pasted into the address bar of an open Forge
      const x = location.hash.replace(/^#/, ""); if (!looksLikeFit(x)) return;
      if (busy()) return;
      if (decode(x)) { startSolver(); render(); setStatus(`Shared fit "${state.name}" loaded.`, "ok"); } else setStatus(BAD_LINK, "bad");
    });
    $("build").textContent = `client build ${D.client_build} · data of ${D.generated}`;
    if (K && K.logo) $("crest").src = "data:image/png;base64," + K.logo;
  }
  boot();
})();
