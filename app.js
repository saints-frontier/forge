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

  const state = { hull: "Reiver", name: "Untitled fit", placements: [], exterior: {}, selected: -1, zoom: 1, prio: { hold: 4, cap: 3, fuel: 0, hp: 0 }, order: ["hold", "cap", "fuel", "hp"], minCaps: 0, mins: { "Cargo Container": 0, "Fuel Bay": 0, "Structural Brace": 0 }, fuelGrade: "Unstable", preset: null, dirty: false };
  let solver = null, solverReady = false, running = null, pendingResolve = null;

  // ---------- solver plumbing ----------
  function startSolver() {
    solverReady = false;
    const payload = { type: "init", hull: D.hulls[state.hull], modules: Object.fromEntries(D.modules.map(m => [m.name, { cells: m.cells }])) };
    try {
      if (solver && solver.terminate) solver.terminate();
      solver = new Worker("solver.js?v=a819eb16");
      solver.onmessage = e => onSolver(e.data);
      solver.onerror = () => { solver = null; fallbackSolver(payload); };
      solver.postMessage(payload);
    } catch (e) { solver = null; fallbackSolver(payload); }
  }
  function fallbackSolver(payload) {
    if (!window.ForgeSolver || !window.ForgeSolver.post) {
      const s = document.createElement("script"); s.src = "solver.js?v=a819eb16"; s.onload = () => fallbackSolver(payload); document.head.appendChild(s); return;
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
      if (kind === "optimize") { state.placements = m.placements; markDirty(); render(); progressDone(`Forged: ${m.iterations} re-packs in ${m.seconds.toFixed(0)} s, ${m.gains} gains · ${hold(state.placements)} m³ hold`); setStatus("", "info"); }
      else progressStop();
      if (kind === "tryadd") { if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(m); } }
    }
  }
  function solve(msg, kind) { return new Promise(res => { running = kind; pendingResolve = res; solver.postMessage(msg); }); }

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
  function hold(pl) { let m = 0; pl.forEach(p => { const e = MOD[p[0]]; if (e && e.hold) m += e.hold; }); return m; }
  function counts(pl) { const c = {}; pl.forEach(p => c[p[0]] = (c[p[0]] || 0) + 1); return c; }

  // ---------- stats ----------
  function recharge(nCaps, trickle) { const r = D.models.recharge; return (nCaps > 0 ? r.a * Math.pow(nCaps, r.b) : 0) + trickle; }
  function stats() { return statsOf(state.hull, state.placements, state.exterior); }
  function statsOf(hullName, placements, exterior) {
    const c = counts(placements), ext = exterior;
    const cells = placements.reduce((a, p) => a + p[3].length, 0), total = D.hulls[hullName].cells_total;
    let fuel = 0, cap = 0, hp = D.models.hull_hp, repair = 0, draw = 0, drain = 0, trickle = 0, power = 0, payload = 0;
    for (const n in c) { const m = MOD[n]; if (!m) continue; const k = c[n];
      fuel += (m.fuel || 0) * k; cap += (m.cap || 0) * k; hp += (m.hp || 0) * k; repair += (m.repair || 0) * k; draw += (m.draw_mw || 0) * k;
      drain += (m.drain || 0) * k; trickle += (m.trickle || 0) * k; power += (m.power || 0) * k; payload += (m.payload || 0) * k; }
    let dps = 0, dpsRamped = 0, mining = 0; const hits = [];     // hits: what one weapon lands per hit at full spool-up (the number the logs show)
    for (const n in ext) { const e = EXT[n]; if (!e) continue; const k = ext[n]; drain += (e.drain || 0) * k; dps += (e.dps || 0) * k; dpsRamped += (e.dps_ramped || e.dps || 0) * k; if (e.mining) mining += k;
      if (e.dps && e.cycle_s) hits.push({ name: n, k, perHit: Math.round((e.dps_ramped || e.dps) * e.cycle_s), cycle: e.cycle_s, ramps: !!e.dps_ramped }); }
    const nCaps = c["Capacitor"] || 0;
    const rech = recharge(nCaps, trickle);
    const factor = D.models.fuel.factor[state.fuelGrade];
    const burn = draw * 60 / factor;                         // units per minute
    return { cells, total, free: total - cells, hold: hold(placements), fuel, cap, hp, repair, draw, power: power || D.models.power_mw, drain, rech, nCaps, hits,
             burn, hours: burn > 0 ? fuel / burn / 60 : Infinity, dps, dpsRamped, mining, payload, stable: rech >= drain, lastMin: drain > rech ? cap / (drain - rech) : Infinity };
  }
  function capsNeeded(drain, trickle) { const r = D.models.recharge; if (drain <= trickle) return 0; return Math.ceil(Math.pow((drain - trickle) / r.a, 1 / r.b)); }
  // What should I change? One line per thing a new rider wishes they had known, with the fix as a button.
  // [{text, add: [module, ...] | null, label}]
  function hints(st) {
    const c = counts(state.placements), ext = state.exterior, out = [];
    const has = n => (c[n] || 0) > 0;
    if (!st.stable) { const need = Math.max(1, capsNeeded(st.drain, (c["Blackstart Cell"] || 0) * 0.3) - st.nCaps);
      out.push({ text: `Capacitor runs dry in ${isFinite(st.lastMin) ? Math.round(st.lastMin) + " s" : "no time"} with everything on. Run it empty and you cannot warp away.`, add: Array(need).fill("Capacitor"), label: `Add ${need} Capacitor${need > 1 ? "s" : ""}` }); }
    if (!has("Hull Repairer")) out.push({ text: "No Hull Repairer: nothing heals you in the field. One repairs ~25 HP/s, your best survival module.", add: ["Hull Repairer"], label: "Add one" });
    if (!has("Leap")) out.push({ text: "No Leap: you cannot jump to another system on your own.", add: ["Leap"], label: "Add a Leap" });
    if (!has("Docking Clamp")) out.push({ text: "No Docking Clamp: no docking at Fueling Quays, so no free Unstable Fuel.", add: ["Docking Clamp"], label: "Add one" });
    if (!has("Transponder")) out.push({ text: "No Transponder: a tribe's catapults and gates stay invisible to you.", add: ["Transponder"], label: "Add one" });
    if (!has("Gravity Sensor") && !has("Ion Sensor")) out.push({ text: "No sensor: you cannot find rocks, sites or ships.", add: ["Gravity Sensor"], label: "Add a Gravity Sensor" });
    else if (!ext["Directional Scanner"]) out.push({ text: "No Directional Scanner on the sensor: no scanning for what is out there.", ext: "Directional Scanner", label: "Add one" });
    if (!(c["Weapon Receiver"] || 0)) out.push({ text: "No Weapon Receiver: nothing to mine or shoot with.", add: ["Weapon Receiver"], label: "Add one" });
    else if (!Object.keys(ext).some(n => EXT[n] && EXT[n].hardpoint === "weapon" && ext[n])) out.push({ text: "Empty Weapon Receiver: mount a Cutting Laser to mine and defend.", ext: "Cutting Laser", label: "Add a Cutting Laser" });
    if (st.burn > 0 && isFinite(st.hours) && st.hours < 2) out.push({ text: `Fuel for ${st.hours.toFixed(1)} h at this burn on ${state.fuelGrade}: a long trip ends in the dark.`, add: ["Fuel Bay"], label: "Add a Fuel Bay" });
    if (!st.fuel) out.push({ text: "No fuel tank: the ship cannot move.", add: ["Fuel Bay"], label: "Add a Fuel Bay" });
    if (st.draw > st.power) out.push({ text: `Over the power grid (${st.draw.toFixed(1)} of ${st.power} MW): switch modules off or remove some.`, add: null });
    if (st.hp <= D.models.hull_hp && (c["Weapon Receiver"] || 0) >= 2) out.push({ text: "A fighting fit with no Structural Brace: each adds +375 HP.", add: ["Structural Brace"], label: "Add a Brace" });
    return out;
  }
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
    if (receivers >= 2) out.push([(c["Repeater"] || 0) >= 1, "Repeater with two Weapon Receivers"]);
    const combat = D.base_ship.combat_weapons.some(w => ext[w]);
    if (combat) out.push([(c["Ion Sensor"] || 0) >= 1, "Ion Sensor on a combat fit"]);
    const scanners = (c["Gravity Sensor"] || 0) + (c["Ion Sensor"] || 0);
    out.push([(ext["Directional Scanner"] || 0) <= scanners, "Directional Scanner on a sensor"]);
    const engines = D.base_ship.engines.reduce((a, e) => a + (c[e] || 0), 0);
    out.push([(ext["External Thruster"] || 0) <= 6 * engines, `External Thrusters (${ext["External Thruster"] || 0} of ${6 * engines})`]);
    out.push([st.draw <= st.power, `power ${st.draw.toFixed(1)} of ${st.power} MW`]);
    out.push([st.stable, st.stable ? `cap-stable (${st.rech.toFixed(1)} GJ/s ≥ ${st.drain.toFixed(1)} drain)` : `cap runs dry in ${isFinite(st.lastMin) ? Math.round(st.lastMin) + " s" : "—"} with everything on`]);
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
    placements.forEach((p, i) => {
      const [label, s, rot, cells] = p; const [sx, sy] = L.slots[s]; const m = MOD[label] || { color: "#888" };
      const set = new Set(cells.map(c => c.join(",")));
      svg += `<g class="mod${i === opts.selected ? " sel" : ""}" data-i="${i}">`;
      cells.forEach(([x, y]) => { svg += `<rect x="${padX + sx + x * cell}" y="${padT + sy + y * cell}" width="${cell}" height="${cell}" fill="${m.color}"/>`; });
      cells.forEach(([x, y]) => { const X = padX + sx + x * cell, Y = padT + sy + y * cell;     // outline + bevel like the cards
        [[x, y - 1, X, Y, X + cell, Y, "#fff", 0.35], [x, y + 1, X, Y + cell, X + cell, Y + cell, "#000", 0.45], [x - 1, y, X, Y, X, Y + cell, "#fff", 0.25], [x + 1, y, X + cell, Y, X + cell, Y + cell, "#000", 0.35]].forEach(([nx, ny, a, b, c2, d, colr, op]) => {
          if (set.has(nx + "," + ny)) return;
          svg += `<line x1="${a}" y1="${b}" x2="${c2}" y2="${d}" stroke="${th.ink}" stroke-width="2.4"/><line x1="${a}" y1="${b}" x2="${c2}" y2="${d}" stroke="${colr}" stroke-opacity="${op}" stroke-width="1"/>`; }); });
      if (opts.numbers !== false) { const mx = cells.reduce((a, c) => a + c[0], 0) / cells.length, my = cells.reduce((a, c) => a + c[1], 0) / cells.length;
        svg += `<text class="modnum" style="font-size:${lai ? 9 : 10}px" x="${padX + sx + (mx + 0.5) * cell}" y="${padT + sy + (my + 0.5) * cell + 3.5}">${i + 1}</text>`; }
      svg += `</g>`;
    });
    if (opts.mark && opts.mark.size) {                 // cells that differ from the other fit, lit gold
      svg += `<g pointer-events="none">`;
      hull.sections.forEach((sec, s) => { const [sx, sy] = L.slots[s]; sec.cells.forEach(([x, y]) => { if (opts.mark.has(`${s}:${x}:${y}`)) svg += `<rect x="${padX + sx + x * cell + 1}" y="${padT + sy + y * cell + 1}" width="${cell - 2}" height="${cell - 2}" fill="none" stroke="#d9b24c" stroke-width="2"/>`; }); });
      svg += `</g>`;
    }
    svg += `</svg>`;
    return { svg, vw, vh };
  }
  function renderGrid() {
    const { svg, vw, vh } = hullSvg(state.hull, state.placements, { id: "hull-svg", selected: state.selected });
    $("grid").innerHTML = svg;
    const el = $("hull-svg");
    el.dataset.w = vw; el.dataset.h = vh;
    fitZoom();
    // Drag: the module follows the pointer as a ghost; on release the cell under the pointer receives the cell that was
    // grabbed (not the module's corner), so the piece lands where it looks. No cell under the pointer = snap back.
    el.addEventListener("pointerdown", ev => {
      const g = ev.target.closest("g.mod"); if (!g) { select(-1); return; }
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
      if (g) { g.setAttribute("transform", `translate(${((pt.x - drag.start.x) * k).toFixed(1)},${((pt.y - drag.start.y) * k).toFixed(1)})`); g.style.opacity = off ? "0.3" : "0.75"; g.style.pointerEvents = "none"; }
      if (off !== drag.off) { drag.off = off; const l = state.placements[drag.i][0]; setStatus(off ? (locked(l) ? `${l} cannot be removed (the game keeps it).` : `Release to remove ${l}.`) : "", off ? "warn" : "info"); }
    });
    const endDrag = ev => {
      if (!drag) return; const d = drag; drag = null;
      const g = el.querySelector(`g.mod[data-i="${d.i}"]`); if (g) { g.removeAttribute("transform"); g.style.opacity = ""; g.style.pointerEvents = ""; }
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
    $("zoom-v").textContent = state.zoom === 1 ? "fit" : Math.round(state.zoom * 100) + "%";
  }
  // ---------- drag from the palette onto the hull ----------
  let pdrag = null;                                           // { name, ghost, shown, target }
  function capMessage(name) {
    const c = counts(state.placements), cap = (D.base_ship.max_fit || {})[name];
    if (cap && (c[name] || 0) >= cap) return `${name}: the game allows at most ${cap} per ship.`;
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
    const row = ev.target.closest(".prow[data-mod]"); if (!row || ev.target.closest("button")) return;
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
    markDirty(); render(); setStatus(`${d.name} fitted in the ${D.hulls[state.hull].sections[d.spot.s].name} section.`, "ok");
  }
  function cellUnder(ev) { const els = document.elementsFromPoint(ev.clientX, ev.clientY); return els.find(e => e.classList && e.classList.contains("cell")) || null; }
  function svgPoint(svg, ev) { const r = svg.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
  function moveTo(i, s, x, y) {
    const p = state.placements[i];
    // the module's top-left cell lands on (x, y) of section s, keeping its shape and rotation
    const minx = Math.min(...p[3].map(c => c[0])), miny = Math.min(...p[3].map(c => c[1]));
    const cells = p[3].map(c => [c[0] - minx + x, c[1] - miny + y]);
    if (s === p[1] && cells.every((c, k) => c[0] === p[3][k][0] && c[1] === p[3][k][1])) { render(); return; }
    if (canPlace(s, cells, i)) { state.placements[i] = [p[0], s, p[2], cells]; markDirty(); render(); setStatus(`${p[0]} moved to the ${D.hulls[state.hull].sections[s].name} section.`, "ok"); }
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
      if (canPlace(p[1], cells, i)) { state.placements[i] = [p[0], p[1], rot, cells]; markDirty(); render(); return true; }
    }
    return false;
  }
  // Manual turns, each doing exactly what it says (the forge does the automatic fitting). rot counts the game's own
  // steps: +90 is a quarter turn counter-clockwise on screen, +270 clockwise.
  const TURNS = { cw: [270, "90° clockwise"], ccw: [90, "90° counter-clockwise"], half: [180, "180°"] };
  function turnSelected(kind) {
    const i = state.selected; if (i < 0) { setStatus("Select a module first (click it on the hull).", "info"); return; }
    const p = state.placements[i], [step, label] = TURNS[kind];
    if (turnTo(i, (p[2] + step) % 360)) setStatus(`${p[0]} turned ${label}.`, "ok");
    else setStatus(`${p[0]}: no room to turn ${label} here. Try another turn, or drag it somewhere roomier.`, "bad");
  }
  function rotateSelected() { turnSelected("cw"); }
  function locked(l) { return D.base_ship.never_removed[l] && counts(state.placements)[l] <= D.base_ship.never_removed[l]; }
  function offWindow(ev) { const r = $("grid").getBoundingClientRect(); return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom; }
  function removeAt(i) {
    const [l] = state.placements[i];
    if (locked(l)) { setStatus(`${l} cannot be removed (the game keeps it).`, "bad"); render(); return; }
    state.placements.splice(i, 1); state.selected = -1; keepByHand(l); markDirty(); render(); setStatus(`${l} removed.`, "ok");
  }
  function removeSelected() { if (state.selected >= 0) removeAt(state.selected); }
  function select(i) { state.selected = i; renderGrid(); renderSelection(); }
  function renderSelection() {
    const i = state.selected; const box = $("selbox");
    if (i < 0) { box.hidden = true; return; }
    const p = state.placements[i]; const m = MOD[p[0]]; box.hidden = false;
    $("sel-name").textContent = `#${i + 1} ${p[0]}`;
    $("sel-detail").textContent = `${m.size} cells · ${D.hulls[state.hull].sections[p[1]].name} · rotation ${p[2]}°` + (m.draw_mw ? ` · ${m.draw_mw} MW` : "") + (m.drain ? ` · ${m.drain} GJ/s active` : "");
  }

  function renderPalette() {
    const c = counts(state.placements); const groups = {};
    D.modules.forEach(m => (groups[m.group] = groups[m.group] || []).push(m));
    let html = "";
    for (const g of ["Command & sensors", "Engineering", "Propulsion", "Weapons", "Storage & crafting"]) {
      if (!groups[g]) continue;
      html += `<div class="pgroup"><h3>${g}</h3>`;
      groups[g].forEach(m => { const k = c[m.name] || 0;
        const lockMin = D.base_ship.never_removed[m.name] || 0, locked = k <= lockMin, full = ((D.base_ship.max_fit || {})[m.name] && k >= D.base_ship.max_fit[m.name]) || !!groupCap(m.name, c);
        html += `<div class="prow${k ? " has" : ""}${lockMin ? " core" : ""}" data-mod="${m.name}" title="drag onto the hull, or press +"><span class="sw" style="background:${m.color}"></span><span class="pname">${m.name}${lockMin ? ' <span class="lock" title="the game never lets this be removed">✠</span>' : ""}</span><span class="psize">${m.size}</span>` +
                `<span class="pcount">${k || ""}</span><button class="pbtn" data-add="${m.name}" title="${full ? "the game allows no more of these" : "add one"}" aria-label="add ${m.name}"${full ? " disabled" : ""}>+</button><button class="pbtn" data-sub="${m.name}" title="${lockMin ? "the game keeps " + lockMin : "remove one"}" aria-label="remove ${m.name}"${locked ? " disabled" : ""}>−</button></div>`; });
      html += `</div>`;
    }
    html += `<div class="pgroup"><h3>Exterior (hardpoints)</h3>`;
    D.exterior.forEach(e => { const k = state.exterior[e.name] || 0;
      html += `<div class="prow${k ? " has" : ""}"><span class="sw ext"></span><span class="pname">${e.name}</span><span class="psize">${e.hardpoint === "weapon" ? "hp" : ""}</span>` +
              `<span class="pcount">${k || ""}</span><button class="pbtn" data-addx="${e.name}" aria-label="add ${e.name}">+</button><button class="pbtn" data-subx="${e.name}" aria-label="remove ${e.name}"${k ? "" : " disabled"}>−</button></div>`; });
    html += `</div>`;
    $("palette").innerHTML = html;
  }
  function renderStats() {
    const st = stats();
    const f = (n, d) => n.toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 0 : d });
    $("st-cells").textContent = `${st.cells} / ${st.total}`; $("st-cells-sub").textContent = `${st.free} free`;
    $("st-hold").textContent = f(st.hold); $("st-hold-sub").textContent = st.payload ? `+ ${st.payload} m³ in Launch Bays` : `${Math.floor(st.hold / D.models.field_sentry_m3)} Field Sentries`;
    $("st-fuel").textContent = f(st.fuel); $("st-fuel-sub").textContent = st.burn > 0 ? `${st.burn.toFixed(2)}/min on ${state.fuelGrade} · ${isFinite(st.hours) ? st.hours.toFixed(1) + " h" : "—"}` : "—";
    $("st-cap").textContent = f(st.cap); $("st-cap-sub").textContent = `${st.rech.toFixed(1)} GJ/s est · ${st.drain.toFixed(1)} drain${st.stable ? " · stable" : " · " + (isFinite(st.lastMin) ? Math.round(st.lastMin) + " s" : "")}`;
    $("st-hp").textContent = `~${f(st.hp)}`; $("st-hp-sub").textContent = `${st.repair} HP/s repair`;
    // the big number is per second at full spool-up; the small line is per hit, as the combat log shows it
    $("st-dps").textContent = st.dps ? f(Math.round(st.dpsRamped)) : (st.mining ? `${st.mining}×` : "—");
    $("st-dps-sub").textContent = st.dps
      ? (st.hits.map(h => `${h.k} × ${h.perHit} a hit every ${h.cycle} s`).join(" · ") + (st.dpsRamped > st.dps ? ` · ${f(st.dpsRamped)}/s spooled, ${f(st.dps)}/s cold` : " per second"))
      : (st.mining ? "mining lasers / extractors" : "no weapons");
    $("st-power").textContent = `${st.draw.toFixed(1)} / ${st.power}`; $("st-power-sub").textContent = "MW";
    const ch = checks(st);
    $("checks").innerHTML = ch.map(([ok, t]) => `<li class="${ok ? "ok" : "bad"}"><span class="dot"></span>${t}</li>`).join("");
    const hs = hints(st), hb = $("hints");
    if (hb) hb.innerHTML = hs.length ? `<div class="hh">What should I change?</div>` + hs.map((h, i) => `<div class="hint"><span>${h.text}</span>${h.add || h.ext ? `<button type="button" data-hint="${i}">${h.label}</button>` : ""}</div>`).join("")
                             : `<div class="hh">What should I change?</div><div class="hint ok"><span>Nothing stands out: this ship can travel, dock, refuel, see and defend itself.</span></div>`;
    $("cap-stable-n").textContent = capsNeeded(st.drain, (counts(state.placements)["Blackstart Cell"] || 0) * 0.3);
    $("st-caprech-note").textContent = `recharge model: ${D.models.recharge.a}·n^${D.models.recharge.b}, measured at 2, 5 and 13 Capacitors`;
  }
  function renderHeader() { if (!K) return; const th = K.themes[state.hull].theme; $("tier").textContent = `✠ ${th.name} · ${th.tier} ✠`; }
  function render() { renderGrid(); renderPalette(); renderStats(); renderSelection(); renderHeader(); $("fit-name").value = state.name; $("hull-sel").value = state.hull; $("free-count").textContent = ""; syncKeepInputs(); record(); }

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
    Object.assign(state, { hull: o.h, placements: o.p, exterior: o.e, name: o.n, preset: o.b, dirty: o.d, minCaps: o.c, mins: Object.assign(zeroMins(), o.k || {}), selected: -1 });
    $("min-caps").value = state.minCaps; if (hullChanged) startSolver(); render(); undoButtons();
  }
  function undo() { if (pool || running || hidx <= 0) return; hidx--; restore(history[hidx]); setStatus("Undone.", "info"); }
  function redo() { if (pool || running || hidx >= history.length - 1) return; hidx++; restore(history[hidx]); setStatus("Redone.", "info"); }
  function setStatus(text, tone) { const s = $("status"); s.textContent = text; s.className = "status " + (tone || ""); }
  // Doctrine fits are written +NAME+ (the Saints' mark). The moment one is changed it becomes a proposal and loses the
  // marks, so nobody mistakes a modified fit for the doctrine. Ships outside the doctrine would carry no marks (none at the moment).
  function docName(p) { return p.doctrine ? "+" + p.name.toUpperCase() + "+" : p.name; }
  function markDirty() {
    if (!state.dirty && /^\+.+\+$/.test(state.name)) { const base = D.presets.find(x => x.n === state.preset); state.name = (base ? base.name : state.name.replace(/\+/g, "")) + " proposal"; $("fit-name").value = state.name; }
    state.dirty = true;
  }

  // ---------- actions ----------
  // the forge may trade Capacitors down to the minimum: one placed or removed by hand moves that minimum with it
  // 'Keep at least' for the other role fillers (user 2026-10-09): Cargo Containers (hold), Fuel Bays (fuel), Structural
  // Braces (armour). Same rules as the Capacitor minimum: a loaded fit sets them to its own counts, a module placed or
  // removed by hand moves its minimum with it, the forge never goes below them.
  const KEEP_IDS = { "Cargo Container": "min-cargo", "Fuel Bay": "min-fuel", "Structural Brace": "min-brace" };
  function zeroMins() { return { "Cargo Container": 0, "Fuel Bay": 0, "Structural Brace": 0 }; }
  function syncKeepInputs() { if ($("min-caps")) $("min-caps").value = state.minCaps; for (const n in KEEP_IDS) { const el = $(KEEP_IDS[n]); if (el) el.value = state.mins[n] || 0; } }
  function setMinsFromFit() { const c = counts(state.placements); state.mins = zeroMins(); for (const n in KEEP_IDS) state.mins[n] = c[n] || 0; syncKeepInputs(); }
  function keepByHand(name) { if (name === "Capacitor") return capsByHand(); if (KEEP_IDS[name]) { state.mins[name] = counts(state.placements)[name] || 0; syncKeepInputs(); } }
  function capsByHand() { const n = counts(state.placements)["Capacitor"] || 0; if (n !== state.minCaps) { state.minCaps = n; $("min-caps").value = n; } }
  async function addModule(name, quiet) {
    const cap = (D.base_ship.max_fit || {})[name];
    if (cap && (counts(state.placements)[name] || 0) >= cap) { setStatus(`${name}: the game allows at most ${cap} per ship.`, "bad"); return; }
    const grp = groupCap(name, counts(state.placements)); if (grp) { setStatus(grp, "bad"); return; }
    if (!solverReady) { setStatus("Solver still loading…", "warn"); return; }
    $("btn-forge").disabled = true; setStatus(`Fitting ${name}…`, "info"); progressStart(0, `Finding a spot for ${name}…`);
    const r = await solve({ type: "tryadd", placements: state.placements, add: [name], seconds: 6, seed: Date.now() & 0xffff }, "tryadd");
    $("btn-forge").disabled = false;
    if (r.missing && r.missing.length) { if (!quiet) setStatus(`No room for ${name}, even after rearranging.`, "bad"); return false; }
    state.placements = r.placements; keepByHand(name); markDirty(); render(); setStatus(`${name} fitted.`, "ok"); return true;
  }
  // Make me cap stable: fit the Capacitors the recharge model needs for the fitted drain, one at a time (rearranging
  // when the hull is tight), and keep that many as the minimum so a later Forge never trades them away.
  async function makeCapStable() {
    if (running || pool) return;
    const st = stats(), have = st.nCaps, need = capsNeeded(st.drain, (counts(state.placements)["Blackstart Cell"] || 0) * 0.3);
    if (st.stable || need <= have) { state.minCaps = Math.max(state.minCaps, have); syncKeepInputs(); setStatus(`Already cap-stable with ${have} Capacitor${have === 1 ? "" : "s"} (${st.rech.toFixed(1)} GJ/s est ≥ ${st.drain.toFixed(1)} drain).`, "ok"); return; }
    let added = 0;
    for (let k = have; k < need; k++) { if (!(await addModule("Capacitor", true))) break; added++; }
    const now = stats();
    state.minCaps = now.nCaps; syncKeepInputs();         // addModule moved the minimum with each Capacitor; show it
    if (now.stable) setStatus(`Cap-stable: ${added} Capacitor${added === 1 ? "" : "s"} added, ${now.nCaps} in all (${now.rech.toFixed(1)} GJ/s est ≥ ${now.drain.toFixed(1)} drain). Keeping ${now.nCaps} as the minimum.`, "ok");
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
    const idxs = state.placements.map((p, i) => p[0] === name ? i : -1).filter(i => i >= 0);
    if (!idxs.length) return;
    if (D.base_ship.never_removed[name] && idxs.length <= D.base_ship.never_removed[name]) { setStatus(`${name} cannot be removed (the game keeps it).`, "bad"); return; }
    state.placements.splice(idxs[idxs.length - 1], 1); state.selected = -1; keepByHand(name); markDirty(); render();
  }
  // A clean slate is never empty: the modules the game refuses to remove are fitted first.
  async function cleanSlate(keepExterior) {
    state.placements = []; if (!keepExterior) state.exterior = {}; state.preset = null; state.selected = -1; state.name = "Forge your own";
    holdHistory = true; render(); holdHistory = false;
    if (!solverReady) await new Promise(r => { const t = setInterval(() => { if (solverReady) { clearInterval(t); r(); } }, 50); });
    const core = []; for (const n in D.base_ship.never_removed) for (let i = 0; i < D.base_ship.never_removed[n]; i++) core.push(n);
    progressStart(0, "Laying the keel…");
    const r = await solve({ type: "tryadd", placements: [], add: core, seconds: 5, seed: 7 }, "tryadd");
    state.placements = r.placements; state.minCaps = D.base_ship.never_removed["Capacitor"] || 1; setMinsFromFit(); markDirty(); render();
    setStatus(`${state.hull}: clean slate with the ${core.length} modules the game never removes (${[...new Set(core)].join(", ")}). Add the rest from the palette, then forge for the role.`, "info");
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
  function forgeParallel(fillers, values, keepMin) {
    const K = forgeSearches(), t0 = Date.now();
    const valueOf = pl => pl.reduce((a, p) => a + (values[p[0]] || 0), 0);
    const startOk = Object.keys(keepMin).every(f => (counts(state.placements)[f] || 0) >= keepMin[f]);
    const P = pool = { workers: [], best: startOk ? valueOf(state.placements) : -Infinity, bestPl: state.placements, lastGain: t0, gains: 0, iters: [], done: 0, stopping: false, reason: "", timer: null, t0, K,
                       wBest: [], wLast: [], restarting: [], restarts: 0, fillers, values, keepMin };
    const init = { type: "init", hull: D.hulls[state.hull], modules: Object.fromEntries(D.modules.map(m => [m.name, { cells: m.cells }])) };
    const consider = m => { if (m.value > P.best) { P.best = m.value; P.bestPl = m.placements; P.lastGain = Date.now(); P.gains++; state.placements = m.placements; render(); } };
    const spawn = i => {
      let w; try { w = new Worker("solver.js?v=a819eb16"); } catch (e) { return null; }
      const launch = () => { P.wBest[i] = P.best; P.wLast[i] = Date.now(); P.restarting[i] = false;
        w.postMessage({ type: "optimize", placements: P.bestPl, fillers, values, keepMin, seconds: FORGE_MAX, seed: (Date.now() + i * 7919 + P.restarts * 104729) & 0xffff || i + 1, maxSections: 3 }); };
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
    P.workers.forEach(w => w.postMessage({ type: "stop" }));
    setTimeout(() => forgePolish(P), 2500);                  // a worker that never answers does not hold the page
  }
  // after the searches settle (not after a manual Stop): one worker re-packs every section exhaustively, then finish
  function forgePolish(P) {
    if (P.polishing || P.finished) return; P.polishing = true;
    clearInterval(P.timer); P.workers.forEach(w => w.terminate());
    if (P.reason === "stopped") { forgeFinish(P); return; }
    let w; try { w = new Worker("solver.js?v=a819eb16"); } catch (e) { forgeFinish(P); return; }
    $("fb-fill").classList.add("busy"); $("fb-text").textContent = `Polishing · ${hold(P.bestPl)} m³…`;
    const t0 = Date.now(); P.polishWorker = w;
    w.onmessage = e => { const m = e.data;
      if (m.type === "ready") w.postMessage({ type: "polish", placements: P.bestPl, fillers: P.fillers, values: P.values, keepMin: P.keepMin, seconds: POLISH_SECS, seed: Date.now() & 0xffff, tries: 6 });
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
    shortOfMinimums(P.keepMin);
  }
  // a minimum above what the hull can hold (with the other minimums kept) is never reached: say so instead of staying quiet
  function shortOfMinimums(keepMin) {
    const c = counts(state.placements), short = Object.keys(keepMin || {}).filter(n => (c[n] || 0) < keepMin[n]);
    if (short.length) setStatus(`No room for ${short.map(n => `${keepMin[n]} ${n}${keepMin[n] === 1 ? "" : "s"} (has ${c[n] || 0})`).join(", ")} while keeping the other minimums. Lower a minimum to make room, or remove a module by hand.`, "warn");
  }
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
    const values = {}; fillers.forEach(f => values[f] = FILL_BASE[f] * Math.pow(1000, prioOf(f) - 1));
    const keepMin = {};
    if (fillers.includes("Capacitor")) keepMin["Capacitor"] = Math.max(state.minCaps, D.base_ship.never_removed["Capacitor"] || 1);
    // every other filler keeps at least what the pilot placed by hand (the base ship's one Fuel Bay, Repairer ...)
    fillers.forEach(f => { if (f !== "Capacitor") keepMin[f] = Math.min(c[f] || 0, D.base_ship.always[f] || 0); });
    // and never below the pilot's own minimums (a filler whose priority is off is not traded at all)
    for (const n in KEEP_IDS) if (fillers.includes(n)) keepMin[n] = Math.max(keepMin[n] || 0, state.mins[n] || 0);
    // the small fillers have no box: what is fitted stays (the forge may add them, never trade them away; remove by hand)
    for (const n of ["Emergency Container", "Fuel Blister"]) if (fillers.includes(n)) keepMin[n] = Math.max(keepMin[n] || 0, c[n] || 0);
    $("btn-forge").textContent = "Stop";
    setStatus(capStable ? `Cap-stable at ${capsNow} Capacitors: they come last. Spare cells go to ${[...new Set(fillers.map(f => PRIO_OF[f]))].filter(k => k !== "cap").sort((x, y) => state.prio[y] - state.prio[x]).map(k => PRIO_NAME[k]).join(", then ")}, then Capacitors fill what nothing else fits.` : "", "info");
    if (forgeParallel(fillers, values, keepMin)) return;
    // no Workers here (the in-page solver): one search, 60 s
    running = "optimize"; progressStart(60, "Forging");
    solver.postMessage({ type: "optimize", placements: state.placements, fillers, values, keepMin, seconds: 60, seed: Date.now() & 0xffff, maxSections: 3 });
  }

  // ---------- presets, share, save ----------
  function loadPreset(n) {
    const p = D.presets.find(x => x.n === +n); if (!p) return;
    state.hull = p.hull; state.placements = p.placements.map(x => [x[0], x[1], x[2], x[3].map(c => [c[0], c[1]])]); state.exterior = Object.assign({}, p.exterior);
    state.name = docName(p); state.preset = p.n; state.selected = -1; state.dirty = false;
    state.minCaps = counts(state.placements)["Capacitor"] || 1; setMinsFromFit();
    startSolver(); render(); setStatus(`${p.name} loaded (${p.role}). Keeping its ${state.minCaps} Capacitors, ${state.mins["Cargo Container"]} Cargo Containers, ${state.mins["Fuel Bay"]} Fuel Bays and ${state.mins["Structural Brace"]} Braces unless you lower the minimums.`, "ok");
  }
  function encode() {
    const idx = {}; D.modules.forEach((m, i) => idx[m.name] = i);
    const obj = { h: state.hull, n: state.name, p: state.placements.map(p => [idx[p[0]], p[1], p[2], Math.min(...p[3].map(c => c[0])), Math.min(...p[3].map(c => c[1]))]), e: state.exterior, r: state.prio, c: state.minCaps, k: state.mins, b: state.preset };
    const s = JSON.stringify(obj);
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decodeFit(h) {
    try {
      const o = JSON.parse(decodeURIComponent(escape(atob(h.replace(/-/g, "+").replace(/_/g, "/")))));
      if (!o.h || !D.hulls[o.h]) return null;
      return { hull: o.h, name: o.n || "Shared fit", exterior: o.e || {}, placements: o.p.map(([mi, sec, rot, x, y]) => { const m = D.modules[mi]; const shape = rotShape(m.cells, rot); return [m.name, sec, rot, shape.map(c => [c[0] + x, c[1] + y])]; }) };
    } catch (e) { return null; }
  }
  function decode(h) {
    try {
      const s = decodeURIComponent(escape(atob(h.replace(/-/g, "+").replace(/_/g, "/"))));
      const o = JSON.parse(s); if (!o.h || !D.hulls[o.h]) return false;
      state.hull = o.h; state.name = o.n || "Shared fit"; state.exterior = o.e || {}; state.prio = Object.assign(state.prio, o.r || {}); delete state.prio.repair; orderFromPrio(); renderOrder(); state.minCaps = o.c || 0; state.preset = o.b || null;
      state.placements = o.p.map(([mi, s, rot, x, y]) => { const m = D.modules[mi]; const shape = rotShape(m.cells, rot); return [m.name, s, rot, shape.map(c => [c[0] + x, c[1] + y])]; });
      if (o.k) { state.mins = Object.assign(zeroMins(), o.k); syncKeepInputs(); } else setMinsFromFit();
      return true;
    } catch (e) { return false; }
  }
  function shareLink() {
    const url = location.href.split("#")[0] + "#" + encode();
    copy(url, "Proposal link copied. Paste it in Discord.");
  }
  function diffVsBase(base) {
    if (!base) return [];
    const c = counts(state.placements), bc = counts(base.placements), diff = []; const names = new Set([...Object.keys(c), ...Object.keys(bc)]);
    names.forEach(n => { const d = (c[n] || 0) - (bc[n] || 0); if (d) diff.push(`${d > 0 ? "+" : ""}${d} ${n}`); });
    return diff;
  }
  function discordText() {
    const st = stats(); const c = counts(state.placements);
    const base = state.preset ? D.presets.find(p => p.n === state.preset) : null;
    let t = `**${state.name}** (${state.hull})` + (base && state.dirty ? ` — proposal vs ${docName(base)}` : "") + "\n";
    t += `Hold ${st.hold} m³ · Fuel ${st.fuel} · Capacitor ${st.cap} GJ (${st.rech.toFixed(1)} GJ/s est, drain ${st.drain.toFixed(1)}) · Hull ~${st.hp} HP, ${st.repair} HP/s · ${st.draw.toFixed(1)} / ${st.power} MW\n`;
    const lines = Object.keys(c).sort().map(n => `${c[n]}x ${n}`); const ext = Object.keys(state.exterior).filter(n => state.exterior[n]).map(n => `${state.exterior[n]}x ${n}`);
    t += lines.join(", ") + (ext.length ? " · exterior: " + ext.join(", ") : "") + "\n";
    if (base) { const diff = diffVsBase(base); t += diff.length ? "Changes: " + diff.join(", ") + "\n" : "Same modules as the doctrine fit, re-packed.\n"; }
    t += location.href.split("#")[0] + "#" + encode();
    copy(t, "Discord text copied.");
  }
  function copy(text, okMsg) {
    const done = () => setStatus(okMsg, "ok");
    const fallback = () => { $("share-out").hidden = false; $("share-text").value = text; $("share-text").select(); setStatus("Copy the text below.", "info"); };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
  }
  function savedFits() { try { return JSON.parse(localStorage.getItem("forge:saved") || "[]"); } catch (e) { return []; } }
  function saveFit() {
    const list = savedFits().filter(x => x.name !== state.name); list.unshift({ name: state.name, hull: state.hull, code: encode(), when: new Date().toISOString() });
    try { localStorage.setItem("forge:saved", JSON.stringify(list.slice(0, 30))); } catch (e) { setStatus("Could not save in this browser.", "bad"); return; }
    renderSaved(); setStatus(`Saved "${state.name}" in this browser.`, "ok");
  }
  function renderSaved() {
    const list = savedFits(); const sel = $("saved-sel");
    sel.innerHTML = `<option value="">Saved fits (this browser)…</option>` + list.map((x, i) => `<option value="${i}">${x.name} · ${x.hull}</option>`).join("");
  }

  // ---------- the card dialog: the fit drawn in the doctrine-card design (cardgen.js), rendered to a PNG for Discord ----------
  let cardPng = null, cardTimer = null, downloads = undefined;
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
    const t = ForgeCard.texts({ preset: base, counts: counts(state.placements), exterior: state.exterior, name: state.name, hull: state.hull, dirty: state.dirty, diff: diffVsBase(base) });
    const k = base ? K.doctrine.indexOf(base.n) : -1;
    t.sigil = doctrine && k >= 0 ? K.roman[k] : "✠";
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
      $("card-save").hidden = !downloads; $("card-copy").hidden = !(navigator.clipboard && window.ClipboardItem);
      st.textContent = `PNG ready (${(cardPng.size / 1024).toFixed(0)} KB, 2880 × 1800).` + (window.FORGE_FONTS ? "" : " The PNG uses Georgia where Cinzel is not embedded.") + (downloads ? "" : " Right-click the image to save or copy it.");
      st.className = "status ok";
    } catch (e) { st.textContent = "Render failed: " + e.message; st.className = "status bad"; }
  }
  function cardFilename() { return (($("cf-title").value || "card").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "card") + "-saints-card.png"; }
  async function saveCard() {
    if (!cardPng || !downloads) return; const st = $("card-status");
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
    if (link) { const h = link.includes("#") ? link.split("#")[1] : link; const f = decodeFit(h); if (!f) { $("cmp-body").innerHTML = `<div class="note">That is not a proposal link from this page.</div>`; return null; } return f; }
    const n = +$("cmp-sel").value; const p = D.presets.find(x => x.n === n); if (!p) return null;
    return { hull: p.hull, name: docName(p), placements: p.placements, exterior: p.exterior || {} };
  }
  function renderCompare() {
    const B = otherFit(); if (!B) { if (!$("cmp-link").value.trim()) $("cmp-body").innerHTML = `<div class="note">Pick a fit to compare with.</div>`; return; }
    const A = { hull: state.hull, name: state.name, placements: state.placements, exterior: state.exterior };
    const sa = statsOf(A.hull, A.placements, A.exterior), sb = statsOf(B.hull, B.placements, B.exterior);
    const same = A.hull === B.hull;
    let markA = new Set(), markB = new Set();
    if (same) { const ma = cellMap(A.placements), mb = cellMap(B.placements); for (const [k, v] of ma) if (mb.get(k) !== v) markA.add(k); for (const [k, v] of mb) if (ma.get(k) !== v) markB.add(k); }
    const f = (n, d) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d === undefined ? 0 : d });
    const rows = [["Cells used", sa.cells, sb.cells, 0], ["Hold m³", sa.hold, sb.hold, 0], ["Fuel", sa.fuel, sb.fuel, 0], ["Fuel hours (" + state.fuelGrade + ")", isFinite(sa.hours) ? sa.hours : 0, isFinite(sb.hours) ? sb.hours : 0, 1],
                  ["Capacitor GJ", sa.cap, sb.cap, 0], ["Recharge GJ/s est", sa.rech, sb.rech, 1], ["Drain GJ/s", sa.drain, sb.drain, 1], ["Hull HP", sa.hp, sb.hp, 0], ["Repair HP/s", sa.repair, sb.repair, 0], ["DPS spooled", sa.dpsRamped, sb.dpsRamped, 0], ["Power MW", sa.draw, sb.draw, 1]];
    const ca = counts(A.placements), cb = counts(B.placements); const names = new Set([...Object.keys(ca), ...Object.keys(cb)]); const diff = [];
    names.forEach(n => { const d = (ca[n] || 0) - (cb[n] || 0); if (d) diff.push([d, n]); });
    const ea = A.exterior || {}, eb = B.exterior || {}; new Set([...Object.keys(ea), ...Object.keys(eb)]).forEach(n => { const d = (ea[n] || 0) - (eb[n] || 0); if (d) diff.push([d, n + " (exterior)"]); });
    diff.sort((x, y) => y[0] - x[0]);
    $("cmp-body").innerHTML = `<div class="cmp-hulls"><div><div class="cmp-name">${A.name} <span>(this fit)</span></div>${hullSvg(A.hull, A.placements, { mark: markA, numbers: false }).svg}</div><div><div class="cmp-name">${B.name}</div>${hullSvg(B.hull, B.placements, { mark: markB, numbers: false }).svg}</div></div>` +
      `<div class="note">${same ? `Gold outlines mark the cells that differ: ${markA.size} on this fit, ${markB.size} on the other.` : "Different hulls: no cell-by-cell diff."}</div>` +
      `<table class="cmp-table"><tr><th></th><th>${A.name}</th><th>${B.name}</th><th>Δ</th></tr>` + rows.map(([l, a, b, d]) => { const dd = a - b; return `<tr><td>${l}</td><td>${f(a, d)}</td><td>${f(b, d)}</td><td class="${dd > 0 ? "up" : dd < 0 ? "down" : ""}">${dd > 0 ? "+" : ""}${f(dd, d)}</td></tr>`; }).join("") + `</table>` +
      `<div class="cmp-diff"><b>Modules</b>: ${diff.length ? diff.map(([d, n]) => `<span class="${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d} ${n}</span>`).join(", ") : "the same modules, placed differently"}.</div>`;
  }
  function openCompare() {
    const sel = $("cmp-sel"); sel.innerHTML = D.presets.filter(p => p.hull === state.hull).concat(D.presets.filter(p => p.hull !== state.hull)).map(p => `<option value="${p.n}">${docName(p)} · ${p.hull}</option>`).join("");
    if (state.preset && D.presets.some(p => p.n === state.preset)) sel.value = state.preset;
    $("cmp-link").value = ""; $("cmpmodal").hidden = false; document.body.style.overflow = "hidden"; renderCompare();
  }

  // ---------- the shopping list: modules to print, materials summed ----------
  function shopping() {
    const c = counts(state.placements), ext = state.exterior, R = D.recipes || {};
    const rows = [], mats = {}, noRecipe = []; let secs = 0;
    const all = Object.keys(c).sort().map(n => [n, c[n]]).concat(Object.keys(ext).filter(n => ext[n]).sort().map(n => [n, ext[n]]));
    for (const [n, k] of all) {
      const r = R[n];
      if (!r) { noRecipe.push(`${k}x ${n}`); rows.push({ n, k, fac: "no known recipe" }); continue; }
      const runs = Math.ceil(k / (r.makes || 1)); rows.push({ n, k, fac: r.facility.replace(" (ship module)", ""), time: (r.time_s || 0) * runs });
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
    t += `\nPrint time about ${Math.round(s.secs / 60)} min on the printers. Command Pod and Weapon Receiver come with the ship; salvage spares from wrecks.`;
    return t;
  }
  function openShop() {
    const s = shopping(), f = n => n.toLocaleString("en-US");
    $("shop-sub").textContent = `${state.name} · ${s.rows.length} kinds of module · print time about ${Math.round(s.secs / 60)} min`;
    const mats = Object.keys(s.mats).sort((a, b) => s.mats[b] - s.mats[a]);
    $("shop-body").innerHTML = `<div><h3>Modules to print</h3><table>${s.rows.map(r => `<tr><td class="n">${r.k}x</td><td>${r.n}</td><td class="f">${r.fac}</td></tr>`).join("")}</table>` +
      `<div class="note">Command Pod and Weapon Receiver have no printer recipe: they come with the ship, and wrecks drop spares.</div></div>` +
      `<div><h3>Materials, total</h3><table>${mats.map(m => `<tr><td class="n">${f(s.mats[m])}x</td><td>${m}</td></tr>`).join("")}</table>` +
      `<div class="note">Recipes as read from the Industry window; the simplest printer that makes each module (the Emergency Printer where it can, else the Mini Printer; the ship Printer makes the same). Refining the raw ore into these is one step further.</div></div>`;
    $("shopmodal").hidden = false; document.body.style.overflow = "hidden";
  }
  // "Build it in the Lodge" (its own button under the share row): every module of the fit becomes a goal of the Mason's Lodge. On the site the Lodge is the
  // next page over (window.__lodgeImport + window.__siteGo); stand-alone, the fit travels in the Lodge's link as
  // #build-<base64url JSON> (a link keeps only letters, digits, - and _ after the #).
  const LODGE_URL = "https://claude.ai/artifact/GN4X4Zo2kfjPoWnoPuQ5cg";
  function lodgePayload() { return { name: state.name, hull: state.hull, goals: shopping().rows.map(r => ({ item: r.n, qty: r.k })) }; }
  function lodgeLink(p) {
    const b = btoa(unescape(encodeURIComponent(JSON.stringify(p)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return (window.__siteGo ? "/lodge" : LODGE_URL) + "#build-" + b;
  }

  // ---------- the guided first visit ----------
  const TOUR = [
    { at: "#hull-svg", title: "This is your ship", text: "The hull, drawn like the game's fitting window: every coloured block is a module sitting in the cells it needs. Drag a module to move it, R turns it, drag it off the window to remove it." },
    { at: "#palette", title: "Everything you can fit", text: "Every module in the game, with the cells it takes. Press + to fit one (the forge finds a spot, rearranging if it must), or drag it straight onto the hull." },
    { at: ".tiles", title: "These numbers decide if you get home", text: "Hold, fuel and how many hours it lasts, capacitor and whether it stays charged with everything running, hull HP, power. The ◀ ▶ arrows add or remove the module behind each one." },
    { at: "#hints", title: "What should I change?", text: "Red checks are rules the game enforces. Below them, one-line advice a new rider wishes they had known, each with a button that does it." },
    { at: "#btn-forge", title: "Forge for the role", text: "Set what matters (hold, capacitor, fuel, armour) and press Forge: several searches fill the spare cells at once and stop by themselves when nothing better turns up. Then share the fit with a proposal link." },
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
    window.addEventListener("resize", () => { if (tourI >= 0) tourShow(tourI); });
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
    $("hull-sel").addEventListener("change", e => { state.hull = e.target.value; startSolver(); cleanSlate(false); });
    $("btn-own").addEventListener("click", () => cleanSlate(false));
    $("preset-sel").addEventListener("change", e => { if (e.target.value) loadPreset(e.target.value); e.target.value = ""; });
    $("fit-name").addEventListener("input", e => { state.name = e.target.value; });
    $("hints").addEventListener("click", e => { const b = e.target.closest("button[data-hint]"); if (b && !running && !pool) applyHint(+b.dataset.hint); });
    document.querySelector(".tiles").addEventListener("click", e => { const b = e.target.closest("button[data-adj]"); if (b) adjust(b.dataset.adj, +b.dataset.d); });
    $("palette").addEventListener("pointerdown", paletteDown);
    document.addEventListener("pointermove", paletteMove, { passive: false });
    document.addEventListener("pointerup", paletteUp);
    document.addEventListener("pointercancel", paletteUp);
    document.addEventListener("keydown", e => { if (pdrag && pdrag.shown && (e.key === "r" || e.key === "R" || e.key === "e" || e.key === "E")) { pdrag.rot = (pdrag.rot + (e.key === "r" ? 270 : 90)) % 360; pdrag.ghost.remove(); pdrag.ghost = ghostFor(pdrag.name, pdrag.rot); e.stopImmediatePropagation(); } }, true);
    $("palette").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.add) addModule(b.dataset.add); else if (b.dataset.sub) subModule(b.dataset.sub);
      else if (b.dataset.addx) { state.exterior[b.dataset.addx] = (state.exterior[b.dataset.addx] || 0) + 1; markDirty(); render(); }
      else if (b.dataset.subx) { state.exterior[b.dataset.subx] = Math.max(0, (state.exterior[b.dataset.subx] || 0) - 1); if (!state.exterior[b.dataset.subx]) delete state.exterior[b.dataset.subx]; markDirty(); render(); }
    });
    $("btn-ccw").addEventListener("click", () => turnSelected("ccw"));
    $("btn-cw").addEventListener("click", () => turnSelected("cw"));
    $("btn-180").addEventListener("click", () => turnSelected("half"));
    $("btn-remove").addEventListener("click", removeSelected);
    document.addEventListener("keydown", e => { if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return; if (e.key === "r") turnSelected("cw"); if (e.key === "R" || e.key === "e" || e.key === "E") turnSelected("ccw"); if (e.key === "f" || e.key === "F") turnSelected("half"); if (e.key === "Delete" || e.key === "Backspace") removeSelected(); });
    document.addEventListener("keydown", e => {
      if (!(e.ctrlKey || e.metaKey) || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
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
    $("btn-makestable").addEventListener("click", makeCapStable);
    $("btn-capstable").addEventListener("click", () => { const n = +$("cap-stable-n").textContent; state.minCaps = n; $("min-caps").value = n; setStatus(`Minimum Capacitors set to ${n}: estimated recharge covers everything firing at once.`, "ok"); });
    $("fuel-sel").addEventListener("change", e => { state.fuelGrade = e.target.value; renderStats(); });
    $("btn-forge").addEventListener("click", forge);
    $("btn-share").addEventListener("click", shareLink);
    $("btn-discord").addEventListener("click", discordText);
    $("btn-save").addEventListener("click", saveFit);
    $("saved-sel").addEventListener("change", e => { const x = savedFits()[+e.target.value]; if (x && decode(x.code)) { startSolver(); render(); setStatus(`Loaded "${x.name}".`, "ok"); } e.target.value = ""; });
    $("btn-clear").addEventListener("click", () => cleanSlate(false));
    $("zoom-in").addEventListener("click", () => { state.zoom = Math.min(3, +(state.zoom * 1.25).toFixed(2)); fitZoom(); });
    $("zoom-out").addEventListener("click", () => { state.zoom = Math.max(0.4, +(state.zoom / 1.25).toFixed(2)); fitZoom(); });
    $("zoom-fit").addEventListener("click", () => { state.zoom = 1; fitZoom(); });
    window.addEventListener("resize", fitZoom);
    renderSaved();
  }

  if (/[?&]dev=1/.test(location.search)) window.__forge = { state, strip() { const keep = {}; state.placements = state.placements.filter(p => { if (!["Cargo Container", "Emergency Container", "Capacitor"].includes(p[0])) return true; keep[p[0]] = (keep[p[0]] || 0) + 1; return keep[p[0]] <= (D.base_ship.never_removed[p[0]] || 0); }); render(); }, hold: () => hold(state.placements), get pool() { return pool; }, last: null };
  function renderPresetSelect() {
    const sel = $("preset-sel"), cur = sel.value;
    sel.innerHTML = `<option value="">${D.presets.some(p => p.doctrine) ? "Load a doctrine fit…" : "Load a fit…"}</option>` + D.presets.map(p => `<option value="${p.n}">${docName(p)} · ${p.hull} · ${p.role}</option>`).join("");
    if (cur) sel.value = cur;
  }
  // the public site adds the doctrine fits here once a tribe member has logged in (tribe.js)
  // the fit on screen in the preset shape (tribe.js "Set as doctrine" writes it into the site's doctrine store)
  window.__forgeCurrentFit = () => ({ name: state.name, hull: state.hull, placements: state.placements.map(p => [p[0], p[1], p[2], p[3].map(c => [c[0], c[1]])]), exterior: Object.assign({}, state.exterior), preset: state.preset });
  window.__forgeAddPresets = list => { for (const p of list || []) if (!D.presets.some(x => x.n === p.n)) D.presets.push(p); renderPresetSelect(); };
  function boot() {
    renderPresetSelect();
    wire();
    const h = location.hash.replace(/^#/, "");
    if (h && decode(h)) { $("min-caps").value = state.minCaps || (counts(state.placements)["Capacitor"] || 1); state.minCaps = +$("min-caps").value; startSolver(); render(); setStatus(`Shared fit "${state.name}" loaded.`, "ok"); }
    else loadPreset(D.presets.some(p => p.n === 8) ? 8 : D.presets[0].n);
    $("build").textContent = `client build ${D.client_build} · data of ${D.generated}`;
    if (K && K.logo) $("crest").src = "data:image/png;base64," + K.logo;
  }
  boot();
})();
