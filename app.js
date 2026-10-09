/* Saints Forge: the page logic. Data in data.js (FORGE_DATA), packing in solver.js (a Web Worker, or in-page fallback). */
(function () {
  "use strict";
  const D = window.FORGE_DATA;
  const K = window.FORGE_CARD || null;                     // the card chrome (card.js): hull outlines, palette, prose
  const MOD = {}; D.modules.forEach(m => MOD[m.name] = m);
  const EXT = {}; D.exterior.forEach(e => EXT[e.name] = e);
  const FILLERS = ["Cargo Container", "Emergency Container", "Capacitor", "Fuel Bay", "Fuel Blister", "Structural Brace", "Hull Repairer"];
  // filler value per unit at weight 1: tuned so every filler has the same value per cell (6/cell); the weight (0-3)
  // then orders them lexicographically (x1000 per step), so "Hold 3, Capacitor 2" means hold first, then capacitors.
  const FILL_BASE = { "Cargo Container": 36, "Emergency Container": 25, "Capacitor": 12, "Fuel Bay": 60, "Fuel Blister": 30, "Structural Brace": 42, "Hull Repairer": 84 };
  const PRIO_OF = { "Cargo Container": "hold", "Emergency Container": "hold", "Capacitor": "cap", "Fuel Bay": "fuel", "Fuel Blister": "fuel", "Structural Brace": "hp", "Hull Repairer": "repair" };
  const $ = id => document.getElementById(id);

  const state = { hull: "Reiver", name: "Untitled fit", placements: [], exterior: {}, selected: -1, zoom: 1, prio: { hold: 3, cap: 2, fuel: 0, hp: 0, repair: 0 }, minCaps: 0, fuelGrade: "EU-40", preset: null, dirty: false };
  let solver = null, solverReady = false, running = null, pendingResolve = null;

  // ---------- solver plumbing ----------
  function startSolver() {
    solverReady = false;
    const payload = { type: "init", hull: D.hulls[state.hull], modules: Object.fromEntries(D.modules.map(m => [m.name, { cells: m.cells }])) };
    try {
      if (solver && solver.terminate) solver.terminate();
      solver = new Worker("solver.js");
      solver.onmessage = e => onSolver(e.data);
      solver.onerror = () => { solver = null; fallbackSolver(payload); };
      solver.postMessage(payload);
    } catch (e) { solver = null; fallbackSolver(payload); }
  }
  function fallbackSolver(payload) {
    if (!window.ForgeSolver || !window.ForgeSolver.post) {
      const s = document.createElement("script"); s.src = "solver.js"; s.onload = () => fallbackSolver(payload); document.head.appendChild(s); return;
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
  function stats() {
    const c = counts(state.placements), ext = state.exterior;
    const cells = state.placements.reduce((a, p) => a + p[3].length, 0), total = D.hulls[state.hull].cells_total;
    let fuel = 0, cap = 0, hp = D.models.hull_hp, repair = 0, draw = 0, drain = 0, trickle = 0, power = 0, payload = 0;
    for (const n in c) { const m = MOD[n]; if (!m) continue; const k = c[n];
      fuel += (m.fuel || 0) * k; cap += (m.cap || 0) * k; hp += (m.hp || 0) * k; repair += (m.repair || 0) * k; draw += (m.draw_mw || 0) * k;
      drain += (m.drain || 0) * k; trickle += (m.trickle || 0) * k; power += (m.power || 0) * k; payload += (m.payload || 0) * k; }
    let dps = 0, dpsRamped = 0, mining = 0;
    for (const n in ext) { const e = EXT[n]; if (!e) continue; const k = ext[n]; drain += (e.drain || 0) * k; dps += (e.dps || 0) * k; dpsRamped += (e.dps_ramped || e.dps || 0) * k; if (e.mining) mining += k; }
    const nCaps = c["Capacitor"] || 0;
    const rech = recharge(nCaps, trickle);
    const factor = D.models.fuel.factor[state.fuelGrade];
    const burn = draw * 60 / factor;                         // units per minute
    return { cells, total, free: total - cells, hold: hold(state.placements), fuel, cap, hp, repair, draw, power: power || D.models.power_mw, drain, rech, nCaps,
             burn, hours: burn > 0 ? fuel / burn / 60 : Infinity, dps, dpsRamped, mining, payload, stable: rech >= drain, lastMin: drain > rech ? cap / (drain - rech) : Infinity };
  }
  function capsNeeded(drain, trickle) { const r = D.models.recharge; if (drain <= trickle) return 0; return Math.ceil(Math.pow((drain - trickle) / r.a, 1 / r.b)); }
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
  function renderGrid() {
    const hull = D.hulls[state.hull], ch = K && K.themes[state.hull];
    const cell = ch ? ch.cell : (state.hull === "LAI" ? 16 : 22), gap = ch ? ch.gap : 16, lai = state.hull === "LAI";
    const L = layoutSlots(state.hull, cell, gap);
    // room for the hull pieces' pointed tips (2.4 cells) and the LAI's two cosmetic pieces under the tail
    const padX = 3 * cell, padT = 3 * cell, padB = lai ? 2.6 * cell + 56 : 3 * cell;
    const vw = L.w + padX * 2, vh = L.h + padT + padB;
    const th = ch ? ch.theme : { cellbg: "#16141a", cellline: "#2a2630", ink: "#07070a" };
    let svg = `<svg viewBox="0 0 ${vw} ${vh}" xmlns="http://www.w3.org/2000/svg" class="hullsvg" id="hull-svg">`;
    svg += `<rect x="0" y="0" width="${vw}" height="${vh}" rx="6" fill="${th.ink}" fill-opacity="0.55"/>`;
    if (ch) svg += `<g transform="translate(${padX},${padT})" pointer-events="none">${ch.outline}</g>`;
    hull.sections.forEach((sec, s) => {
      const [sx, sy] = L.slots[s];
      svg += `<g class="sec" data-s="${s}">`;
      sec.cells.forEach(([x, y]) => { svg += `<rect class="cell" data-s="${s}" data-x="${x}" data-y="${y}" x="${padX + sx + x * cell}" y="${padT + sy + y * cell}" width="${cell}" height="${cell}" fill="${th.cellbg}" stroke="${th.cellline}"/>`; });
      svg += `</g>`;
    });
    state.placements.forEach((p, i) => {
      const [label, s, rot, cells] = p; const [sx, sy] = L.slots[s]; const m = MOD[label] || { color: "#888" };
      const set = new Set(cells.map(c => c.join(",")));
      svg += `<g class="mod${i === state.selected ? " sel" : ""}" data-i="${i}">`;
      cells.forEach(([x, y]) => { svg += `<rect x="${padX + sx + x * cell}" y="${padT + sy + y * cell}" width="${cell}" height="${cell}" fill="${m.color}"/>`; });
      cells.forEach(([x, y]) => { const X = padX + sx + x * cell, Y = padT + sy + y * cell;     // outline + bevel like the cards
        [[x, y - 1, X, Y, X + cell, Y, "#fff", 0.35], [x, y + 1, X, Y + cell, X + cell, Y + cell, "#000", 0.45], [x - 1, y, X, Y, X, Y + cell, "#fff", 0.25], [x + 1, y, X + cell, Y, X + cell, Y + cell, "#000", 0.35]].forEach(([nx, ny, a, b, c2, d, colr, op]) => {
          if (set.has(nx + "," + ny)) return;
          svg += `<line x1="${a}" y1="${b}" x2="${c2}" y2="${d}" stroke="${th.ink}" stroke-width="2.4"/><line x1="${a}" y1="${b}" x2="${c2}" y2="${d}" stroke="${colr}" stroke-opacity="${op}" stroke-width="1"/>`; }); });
      const mx = cells.reduce((a, c) => a + c[0], 0) / cells.length, my = cells.reduce((a, c) => a + c[1], 0) / cells.length;
      svg += `<text class="modnum" style="font-size:${lai ? 9 : 10}px" x="${padX + sx + (mx + 0.5) * cell}" y="${padT + sy + (my + 0.5) * cell + 3.5}">${i + 1}</text></g>`;
    });
    svg += `</svg>`;
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
    state.placements.push([d.name, d.spot.s, d.spot.rot, d.spot.cells]); state.selected = state.placements.length - 1;
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
  // R: the next quarter turn that fits (90, then 180, then 270), so a turn that is blocked never stops the next one.
  function rotateSelected() {
    const i = state.selected; if (i < 0) return; const p = state.placements[i];
    for (const step of [90, 180, 270]) {
      if (turnTo(i, (p[2] + step) % 360)) { setStatus(step === 90 ? `${p[0]} rotated.` : `${p[0]} turned ${step}° (the smaller turn does not fit here).`, step === 90 ? "ok" : "info"); return; }
    }
    setStatus(`${p[0]} has no room to turn here; drag it somewhere roomier first.`, "bad");
  }
  // F: half a turn (upside down). The game rotates modules but never mirrors them (player, 2026-10-05), so this is the
  // only "flip" a real fit can have.
  function flipSelected() {
    const i = state.selected; if (i < 0) return; const p = state.placements[i];
    if (turnTo(i, (p[2] + 180) % 360)) setStatus(`${p[0]} flipped.`, "ok"); else setStatus(`${p[0]} has no room to flip here.`, "bad");
  }
  function locked(l) { return D.base_ship.never_removed[l] && counts(state.placements)[l] <= D.base_ship.never_removed[l]; }
  function offWindow(ev) { const r = $("grid").getBoundingClientRect(); return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom; }
  function removeAt(i) {
    const [l] = state.placements[i];
    if (locked(l)) { setStatus(`${l} cannot be removed (the game keeps it).`, "bad"); render(); return; }
    state.placements.splice(i, 1); state.selected = -1; markDirty(); render(); setStatus(`${l} removed.`, "ok");
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
    $("st-dps").textContent = st.dps ? f(st.dps) : (st.mining ? `${st.mining}×` : "—"); $("st-dps-sub").textContent = st.dps ? (st.dpsRamped > st.dps ? `${f(st.dpsRamped)} ramped` : "DPS") : (st.mining ? "mining lasers / extractors" : "no weapons");
    $("st-power").textContent = `${st.draw.toFixed(1)} / ${st.power}`; $("st-power-sub").textContent = "MW";
    const ch = checks(st);
    $("checks").innerHTML = ch.map(([ok, t]) => `<li class="${ok ? "ok" : "bad"}"><span class="dot"></span>${t}</li>`).join("");
    $("cap-stable-n").textContent = capsNeeded(st.drain, (counts(state.placements)["Blackstart Cell"] || 0) * 0.3);
    $("st-caprech-note").textContent = `recharge model: ${D.models.recharge.a}·n^${D.models.recharge.b}, measured at 2, 5 and 13 Capacitors`;
  }
  function renderHeader() { if (!K) return; const th = K.themes[state.hull].theme; $("tier").textContent = `✠ ${th.name} · ${th.tier} ✠`; }
  function render() { renderGrid(); renderPalette(); renderStats(); renderSelection(); renderHeader(); $("fit-name").value = state.name; $("hull-sel").value = state.hull; $("free-count").textContent = ""; record(); }

  // ---------- undo / redo ----------
  // Every render records the fit if it changed (a forge or a + search records once, when it ends). 100 steps kept.
  let history = [], hidx = -1, holdHistory = false;
  function snap() { return JSON.stringify({ h: state.hull, p: state.placements, e: state.exterior, n: state.name, b: state.preset, d: state.dirty, c: state.minCaps }); }
  function record() {
    if (holdHistory || pool || running) return;
    const s = snap(); if (hidx >= 0 && history[hidx] === s) return;
    history = history.slice(0, hidx + 1); history.push(s); if (history.length > 100) history.shift(); hidx = history.length - 1; undoButtons();
  }
  function undoButtons() { const u = $("btn-undo"), r = $("btn-redo"); if (u) u.disabled = hidx <= 0; if (r) r.disabled = hidx >= history.length - 1; }
  function restore(s) {
    const o = JSON.parse(s), hullChanged = o.h !== state.hull;
    Object.assign(state, { hull: o.h, placements: o.p, exterior: o.e, name: o.n, preset: o.b, dirty: o.d, minCaps: o.c, selected: -1 });
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
  async function addModule(name) {
    const cap = (D.base_ship.max_fit || {})[name];
    if (cap && (counts(state.placements)[name] || 0) >= cap) { setStatus(`${name}: the game allows at most ${cap} per ship.`, "bad"); return; }
    const grp = groupCap(name, counts(state.placements)); if (grp) { setStatus(grp, "bad"); return; }
    if (!solverReady) { setStatus("Solver still loading…", "warn"); return; }
    $("btn-forge").disabled = true; setStatus(`Fitting ${name}…`, "info"); progressStart(0, `Finding a spot for ${name}…`);
    const r = await solve({ type: "tryadd", placements: state.placements, add: [name], seconds: 6, seed: Date.now() & 0xffff }, "tryadd");
    $("btn-forge").disabled = false;
    if (r.missing && r.missing.length) { setStatus(`No room for ${name}, even after rearranging.`, "bad"); return; }
    state.placements = r.placements; markDirty(); render(); setStatus(`${name} fitted.`, "ok");
  }
  function subModule(name) {
    const idxs = state.placements.map((p, i) => p[0] === name ? i : -1).filter(i => i >= 0);
    if (!idxs.length) return;
    if (D.base_ship.never_removed[name] && idxs.length <= D.base_ship.never_removed[name]) { setStatus(`${name} cannot be removed (the game keeps it).`, "bad"); return; }
    state.placements.splice(idxs[idxs.length - 1], 1); state.selected = -1; markDirty(); render();
  }
  // A clean slate is never empty: the modules the game refuses to remove are fitted first.
  async function cleanSlate(keepExterior) {
    state.placements = []; if (!keepExterior) state.exterior = {}; state.preset = null; state.selected = -1; state.name = "Forge your own";
    holdHistory = true; render(); holdHistory = false;
    if (!solverReady) await new Promise(r => { const t = setInterval(() => { if (solverReady) { clearInterval(t); r(); } }, 50); });
    const core = []; for (const n in D.base_ship.never_removed) for (let i = 0; i < D.base_ship.never_removed[n]; i++) core.push(n);
    progressStart(0, "Laying the keel…");
    const r = await solve({ type: "tryadd", placements: [], add: core, seconds: 5, seed: 7 }, "tryadd");
    state.placements = r.placements; state.minCaps = D.base_ship.never_removed["Capacitor"] || 1; $("min-caps").value = state.minCaps; markDirty(); render();
    setStatus(`${state.hull}: clean slate with the ${core.length} modules the game never removes (${[...new Set(core)].join(", ")}). Add the rest from the palette, then forge for the role.`, "info");
  }

  // ---------- Forge for the role: parallel searches until nothing better turns up ----------
  // Bench 2026-10-09 (27 runs, 9 fits x 3 seeds, 180 s): a single search reached only 92-99 % of the best found in 3 min,
  // while the best of three seeds in parallel was at 98.5-100 % within ~45 s; a stop after 30 s without a gain landed at
  // 95-100 % (mean ~99 %). Different seeds land in different layouts, so more searches beat more time.
  const FORGE_IDLE = 30, FORGE_MAX = 180;
  let pool = null;
  function forgeSearches() { return Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)); }
  function forgeParallel(fillers, values, keepMin) {
    const K = forgeSearches(), t0 = Date.now();
    const valueOf = pl => pl.reduce((a, p) => a + (values[p[0]] || 0), 0);
    const P = pool = { workers: [], best: valueOf(state.placements), bestPl: state.placements, lastGain: t0, gains: 0, iters: [], done: 0, stopping: false, reason: "", timer: null, t0, K };
    const init = { type: "init", hull: D.hulls[state.hull], modules: Object.fromEntries(D.modules.map(m => [m.name, { cells: m.cells }])) };
    const consider = m => { if (m.value > P.best) { P.best = m.value; P.bestPl = m.placements; P.lastGain = Date.now(); P.gains++; state.placements = m.placements; render(); } };
    for (let i = 0; i < K; i++) {
      let w; try { w = new Worker("solver.js"); } catch (e) { break; }
      w.onmessage = e => {
        const m = e.data;
        if (m.type === "ready") w.postMessage({ type: "optimize", placements: P.bestPl, fillers, values, keepMin, seconds: FORGE_MAX, seed: (Date.now() + i * 7919) & 0xffff || i + 1, maxSections: 3 });
        else if (m.type === "progress") { P.iters[i] = m.iterations; consider(m); }
        else if (m.type === "done") { P.iters[i] = m.iterations; consider(m); if (++P.done >= P.workers.length) forgeFinish(P); }
      };
      w.onerror = () => { if (++P.done >= P.workers.length) forgeFinish(P); };
      w.postMessage(init); P.workers.push(w);
    }
    if (!P.workers.length) { pool = null; return false; }
    P.timer = setInterval(() => {
      const now = Date.now(), idle = (now - P.lastGain) / 1000, el = (now - P.t0) / 1000;
      const holdNow = hold(P.bestPl), its = P.iters.reduce((a, b) => a + (b || 0), 0);
      $("fb-fill").style.width = Math.min(100, idle / FORGE_IDLE * 100).toFixed(1) + "%";
      $("fb-text").textContent = `Forging · ${P.workers.length} searches · ${el.toFixed(0)} s · ${its} re-packs · ${holdNow} m³ · ${P.gains ? "last gain " + idle.toFixed(0) + " s ago" : "no gain yet"}`;
      if (!P.stopping && (idle >= FORGE_IDLE || el >= FORGE_MAX)) forgeStop(P, idle >= FORGE_IDLE ? "settled" : "time");
    }, 250);
    progressStart(0, `Forging · ${K} searches…`); $("fb-fill").classList.remove("busy"); $("fb-fill").style.width = "0%";
    return true;
  }
  function forgeStop(P, reason) {
    if (P.stopping) return; P.stopping = true; P.reason = reason;
    P.workers.forEach(w => w.postMessage({ type: "stop" }));
    setTimeout(() => forgeFinish(P), 2500);                  // a worker that never answers does not hold the page
  }
  function forgeFinish(P) {
    if (P.finished) return; P.finished = true;
    clearInterval(P.timer); P.workers.forEach(w => w.terminate()); if (pool === P) pool = null;
    state.placements = P.bestPl; if (P.gains) markDirty(); render();
    const secs = ((Date.now() - P.t0) / 1000).toFixed(0), its = P.iters.reduce((a, b) => a + (b || 0), 0);
    const why = P.reason === "settled" ? `nothing better for ${FORGE_IDLE} s` : P.reason === "time" ? "3 min limit" : "stopped";
    progressDone(`Forged: ${P.gains} gains from ${P.workers.length} searches, ${its} re-packs in ${secs} s (${why}) · ${hold(state.placements)} m³ hold`);
    $("btn-forge").textContent = "Forge for the role"; setStatus("", "info");
  }
  function forge() {
    if (pool) { forgeStop(pool, "stopped"); return; }
    if (running) { solver.postMessage({ type: "stop" }); return; }
    if (!solverReady) { setStatus("Solver still loading…", "warn"); return; }
    const fillers = FILLERS.filter(f => state.prio[PRIO_OF[f]] > 0);
    if (!fillers.length) { setStatus("Set at least one priority above 0.", "bad"); return; }
    const values = {}; fillers.forEach(f => values[f] = FILL_BASE[f] * Math.pow(1000, state.prio[PRIO_OF[f]] - 1));
    const c = counts(state.placements);
    const keepMin = {};
    keepMin["Capacitor"] = Math.max(state.minCaps, D.base_ship.never_removed["Capacitor"] || 1);
    // every other filler keeps at least what the pilot placed by hand (the base ship's one Fuel Bay, Repairer ...)
    fillers.forEach(f => { if (f !== "Capacitor") keepMin[f] = Math.min(c[f] || 0, D.base_ship.always[f] || 0); });
    $("btn-forge").textContent = "Stop"; setStatus("", "info");
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
    state.minCaps = counts(state.placements)["Capacitor"] || 1; $("min-caps").value = state.minCaps;
    startSolver(); render(); setStatus(`${p.name} loaded (${p.role}). Keeping its ${state.minCaps} Capacitors unless you lower the minimum.`, "ok");
  }
  function encode() {
    const idx = {}; D.modules.forEach((m, i) => idx[m.name] = i);
    const obj = { h: state.hull, n: state.name, p: state.placements.map(p => [idx[p[0]], p[1], p[2], Math.min(...p[3].map(c => c[0])), Math.min(...p[3].map(c => c[1]))]), e: state.exterior, r: state.prio, c: state.minCaps, b: state.preset };
    const s = JSON.stringify(obj);
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decode(h) {
    try {
      const s = decodeURIComponent(escape(atob(h.replace(/-/g, "+").replace(/_/g, "/"))));
      const o = JSON.parse(s); if (!o.h || !D.hulls[o.h]) return false;
      state.hull = o.h; state.name = o.n || "Shared fit"; state.exterior = o.e || {}; state.prio = Object.assign(state.prio, o.r || {}); state.minCaps = o.c || 0; state.preset = o.b || null;
      state.placements = o.p.map(([mi, s, rot, x, y]) => { const m = D.modules[mi]; const shape = rotShape(m.cells, rot); return [m.name, s, rot, shape.map(c => [c[0] + x, c[1] + y])]; });
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

  // ---------- wiring ----------
  function wire() {
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
    $("palette").addEventListener("pointerdown", paletteDown);
    document.addEventListener("pointermove", paletteMove, { passive: false });
    document.addEventListener("pointerup", paletteUp);
    document.addEventListener("pointercancel", paletteUp);
    document.addEventListener("keydown", e => { if (pdrag && pdrag.shown && (e.key === "r" || e.key === "R")) { pdrag.rot = (pdrag.rot + 90) % 360; pdrag.ghost.remove(); pdrag.ghost = ghostFor(pdrag.name, pdrag.rot); e.stopImmediatePropagation(); } }, true);
    $("palette").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.add) addModule(b.dataset.add); else if (b.dataset.sub) subModule(b.dataset.sub);
      else if (b.dataset.addx) { state.exterior[b.dataset.addx] = (state.exterior[b.dataset.addx] || 0) + 1; markDirty(); render(); }
      else if (b.dataset.subx) { state.exterior[b.dataset.subx] = Math.max(0, (state.exterior[b.dataset.subx] || 0) - 1); if (!state.exterior[b.dataset.subx]) delete state.exterior[b.dataset.subx]; markDirty(); render(); }
    });
    $("btn-rotate").addEventListener("click", rotateSelected);
    $("btn-flip").addEventListener("click", flipSelected);
    $("btn-remove").addEventListener("click", removeSelected);
    document.addEventListener("keydown", e => { if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return; if (e.key === "r" || e.key === "R") rotateSelected(); if (e.key === "f" || e.key === "F") flipSelected(); if (e.key === "Delete" || e.key === "Backspace") removeSelected(); });
    document.addEventListener("keydown", e => {
      if (!(e.ctrlKey || e.metaKey) || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); } else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    });
    $("btn-undo").addEventListener("click", undo); $("btn-redo").addEventListener("click", redo);
    ["hold", "cap", "fuel", "hp", "repair"].forEach(k => { const el = $("prio-" + k); el.value = state.prio[k]; el.addEventListener("input", () => { state.prio[k] = +el.value; $("prio-" + k + "-v").textContent = ["off", "low", "mid", "top"][+el.value]; }); $("prio-" + k + "-v").textContent = ["off", "low", "mid", "top"][state.prio[k]]; });
    $("min-caps").addEventListener("input", e => { state.minCaps = +e.target.value || 0; });
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

  function boot() {
    const sel = $("preset-sel");
    sel.innerHTML = `<option value="">${D.presets.some(p => p.doctrine) ? "Load a doctrine fit…" : "Load a fit…"}</option>` + D.presets.map(p => `<option value="${p.n}">${docName(p)} · ${p.hull} · ${p.role}</option>`).join("");
    wire();
    const h = location.hash.replace(/^#/, "");
    if (h && decode(h)) { $("min-caps").value = state.minCaps || (counts(state.placements)["Capacitor"] || 1); state.minCaps = +$("min-caps").value; startSolver(); render(); setStatus(`Shared fit "${state.name}" loaded.`, "ok"); }
    else loadPreset(D.presets.some(p => p.n === 8) ? 8 : D.presets[0].n);
    $("build").textContent = `client build ${D.client_build} · data of ${D.generated}`;
    if (K && K.logo) $("crest").src = "data:image/png;base64," + K.logo;
  }
  boot();
})();
