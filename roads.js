/* The Pilgrim Roads: the tribe's road network (catapults and gates) as a map, a fuel watch and a route finder.
   Data comes from /api/network (tribe session only): what the chain says about the builders' launchers, gates and
   Network Nodes, plus the hand-kept list. This file joins the two:
     - a launcher or gate whose name carries system names is placed from the name:
         "ABC|D11 > XYZ|K22", "A >>> B", "A -> B", "A to B"   = from A to B
         "A ⇄ B", "A <> B", "A <-> B"                          = both ways
         "XYZ|K22   Level 4 System"                            = to XYZ|K22 (the builder's destination-only habit)
     - its origin, when the name has none, is the system of its Network Node: from the hand-kept list, or from a system
       name in the node's own name;
     - the hand-kept list wins over both, and can add links the chain cannot show.
   Whatever cannot be placed is listed under "Not on the map yet", where Paladins and Knights can place it. */
(function () {
  "use strict";
  const root = document.getElementById("tab-roads");
  if (!root) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const up = s => String(s == null ? "" : s).toUpperCase().trim();
  const CODE = /[A-Z0-9]{3}\|[A-Z0-9]{3}/g;                  // Cycle 7 system names look like ABC|D11 (no real name is written in this file: the network lives in the store)
  const short = id => id ? id.slice(0, 6) + "…" + id.slice(-4) : "?";
  const fmtDays = d => d == null ? "" : d >= 10 ? Math.round(d) + " d" : d >= 1 ? d.toFixed(1) + " d" : Math.max(0, Math.round(d * 24)) + " h";
  const fuelClass = d => d == null ? "none" : d < 3 ? "bad" : d < 14 ? "warn" : "good";

  function parseName(name) {
    const s = up(name), codes = s.match(CODE) || [];
    if (codes.length >= 2) {
      const between = s.slice(s.indexOf(codes[0]) + codes[0].length, s.indexOf(codes[1], s.indexOf(codes[0]) + codes[0].length));
      if (/⇄|↔|<-?>|<=>/.test(between)) return { from: codes[0], to: codes[1], both: true };
      if (/>|→|\bTO\b/.test(between)) return { from: codes[0], to: codes[1], both: false };
    }
    return { from: null, to: codes[0] || null, both: false };
  }

  // ---------- the model: systems, roads, what could not be placed ----------
  function build(d) {
    const list = Object.assign({ builders: [], nodes: {}, launchers: {}, links: [], notes: {}, home: "" }, d.list || {});
    const nodeById = new Map((d.nodes || []).map(n => [n.id, n]));
    const daysOf = n => n && n.fuel && n.fuel.burning && n.fuel.burnMs ? n.fuel.quantity * n.fuel.burnMs / 86400000 : null;
    const nodeSys = id => { if (!id) return null; if (list.nodes[id]) return up(list.nodes[id]); const n = nodeById.get(id), c = n && up(n.name).match(CODE); return c ? c[0] : null; };
    const roads = [], unplaced = [], byId = new Map((d.assemblies || []).map(a => [a.id, a])), pairs = new Set();
    for (const a of d.assemblies || []) {
      const days = daysOf(nodeById.get(a.node));
      const base = { id: a.id, kind: a.kind, name: a.name, node: a.node, days, builder: a.builder, source: "chain" };
      const ov = list.launchers[a.id], p = parseName(a.name);
      if (/Gate/.test(a.kind)) {
        if (!a.linked) { unplaced.push(Object.assign(base, { why: "not linked to another gate" })); continue; }
        const key = [a.id, a.linked].sort().join("|"); if (pairs.has(key)) continue; pairs.add(key);
        const b = byId.get(a.linked), ovb = ov || list.launchers[a.linked];
        const from = ovb ? up(ovb.from) : (p.from || nodeSys(a.node)), to = ovb ? up(ovb.to) : (p.from ? p.to : (b ? nodeSys(b.node) : null));
        const db = b ? daysOf(nodeById.get(b.node)) : null;
        if (from && to && from !== to) roads.push(Object.assign(base, { from, to, twoWay: true, online: a.status === "ONLINE" && (!b || b.status === "ONLINE"), days: days == null ? db : db == null ? days : Math.min(days, db) }));
        else unplaced.push(Object.assign(base, { from, to, why: "the systems at its two ends are not known" }));
        continue;
      }
      const from = ov ? up(ov.from) : (p.from || nodeSys(a.node)), to = ov ? up(ov.to) : p.to;
      if (from && to && from !== to) roads.push(Object.assign(base, { from, to, twoWay: !ov && p.both, online: a.status === "ONLINE" }));
      else unplaced.push(Object.assign(base, { from, to, online: a.status === "ONLINE", why: !a.name ? "it has no name" : !to ? "its name holds no system" : "the system of its node is not known" }));
    }
    for (const l of list.links || []) roads.push({ id: null, kind: l.kind, name: l.note || "", node: null, days: null, source: "list", from: up(l.from), to: up(l.to), twoWay: !!l.twoWay, online: true });
    const systems = new Map(), sys = n => { if (!systems.has(n)) systems.set(n, { name: n, nodes: [], days: null, note: (list.notes || {})[n] || "" }); return systems.get(n); };
    for (const r of roads) { sys(r.from); sys(r.to); }
    for (const n of d.nodes || []) { const s = nodeSys(n.id); if (s) sys(s).nodes.push(n); }
    for (const s of systems.values()) for (const n of s.nodes) { const dd = daysOf(n); if (dd != null && (s.days == null || dd < s.days)) s.days = dd; }
    let home = up(list.home); if (!systems.has(home)) home = [...systems.keys()].sort()[0] || "";
    return { list, roads, unplaced, systems, nodeById, nodeSys, daysOf, home, canEdit: !!d.canEdit, at: d.at, error: d.error, nodes: d.nodes || [] };
  }

  // ---------- layout: columns by hops from home, one band per connected group ----------
  const BW = 156, BH = 60, GY = 40, PAD = 22;
  function layout(M, avail) {
    const adj = new Map([...M.systems.keys()].map(k => [k, new Set()]));
    for (const r of M.roads) { adj.get(r.from).add(r.to); adj.get(r.to).add(r.from); }
    const pos = new Map(); let band = 0, cols = 0;
    const starts = [M.home].concat([...M.systems.keys()].filter(k => k !== M.home).sort((a, b) => adj.get(b).size - adj.get(a).size || a.localeCompare(b)));
    for (const start of starts) {
      if (!start || pos.has(start)) continue;
      const levels = [[start]], seen = new Set([start]);
      for (let i = 0; i < levels.length; i++) {
        const next = [];
        for (const k of levels[i]) for (const n of [...adj.get(k)].sort()) if (!seen.has(n)) { seen.add(n); next.push(n); }
        if (next.length) levels.push(next);
      }
      const tall = Math.max(...levels.map(l => l.length));
      levels.forEach((l, x) => l.forEach((k, i) => pos.set(k, { col: x, row: band + (tall - l.length) / 2 + i })));
      band += tall; cols = Math.max(cols, levels.length);
    }
    // on a narrow pane (a phone) the road runs down the screen: hops from home become rows
    if (avail > 0 && avail < 560 && cols > 1) {
      const VX = 18, VY = 44;
      for (const p of pos.values()) { p.x = PAD + p.row * (BW + VX); p.y = PAD + p.col * (BH + VY); p.cx = p.x + BW / 2; p.cy = p.y + BH / 2; }
      return { pos, w: PAD * 2 + band * BW + Math.max(0, band - 1) * VX, h: PAD * 2 + cols * BH + Math.max(0, cols - 1) * VY };
    }
    // the gap between columns stretches to the pane's width (within reason); a longer network scrolls sideways
    const GX = cols > 1 ? Math.max(40, Math.min(130, ((avail || 0) - PAD * 2 - cols * BW) / (cols - 1))) : 0;
    for (const p of pos.values()) { p.x = PAD + p.col * (BW + GX); p.y = PAD + p.row * (BH + GY); p.cx = p.x + BW / 2; p.cy = p.y + BH / 2; }
    return { pos, w: PAD * 2 + cols * BW + Math.max(0, cols - 1) * GX, h: PAD * 2 + band * BH + Math.max(0, band - 1) * GY };
  }
  // where the line from a box's centre towards (tx, ty) leaves the box
  function edgePoint(p, tx, ty) {
    const dx = tx - p.cx, dy = ty - p.cy; if (!dx && !dy) return [p.cx, p.cy];
    const k = Math.min(dx ? (BW / 2 + 5) / Math.abs(dx) : Infinity, dy ? (BH / 2 + 5) / Math.abs(dy) : Infinity);
    return [p.cx + dx * k, p.cy + dy * k];
  }
  const head = (x, y, ang, col) => { const a = 9, w = 4.5, c = Math.cos(ang), s = Math.sin(ang);
    return `<polygon points="${x},${y} ${x - a * c + w * s},${y - a * s - w * c} ${x - a * c - w * s},${y - a * s + w * c}" fill="${col}"/>`; };

  let M = null, selected = null;
  function drawMap() {
    const box = $("roads-map");
    if (!M.systems.size) { box.innerHTML = `<div class="roads-empty">No road is on the map yet. ${M.list.builders.length ? "Name a launcher after its systems, or place it by hand below." : "No builder is set in the list."}</div>`; return; }
    const avail = box.clientWidth - 14, L = layout(M, avail), groups = new Map();
    for (const r of M.roads) { const k = [r.from, r.to].sort().join("  "); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    let svg = "";
    for (const [k, rs] of groups) {
      const [a, b] = k.split("  "), pa = L.pos.get(a), pb = L.pos.get(b);
      // per direction: 1 = a working road, -1 = only offline ones (its arrowhead is drawn red), 0 = none
      const dir = (f, t) => { const d = rs.filter(r => (r.from === f && r.to === t) || r.twoWay); return d.length ? (d.some(r => r.online !== false) ? 1 : -1) : 0; };
      const ab = dir(a, b), ba = dir(b, a);
      const heavy = rs.some(r => /Heavy/.test(r.kind)), gate = rs.some(r => /Gate/.test(r.kind)), off = rs.every(r => r.online === false), hand = rs.every(r => r.source === "list");
      const col = off ? "var(--red)" : hand ? "var(--silver)" : gate ? "var(--title)" : "var(--gold)";
      // a straight road, or a bowed one when a third system stands in the way
      const blocked = [...L.pos.entries()].some(([n, p]) => n !== a && n !== b && segHitsBox(pa.cx, pa.cy, pb.cx, pb.cy, p));
      const mx = (pa.cx + pb.cx) / 2, my = (pa.cy + pb.cy) / 2, len = Math.hypot(pb.cx - pa.cx, pb.cy - pa.cy) || 1;
      // the bow clears a box whichever way the road runs: wide for a road running down, low for one running across
      const ux = (pb.cx - pa.cx) / len, uy = (pb.cy - pa.cy) / len, bend = blocked ? 2 * (Math.abs(ux) * (BH / 2 + 26) + Math.abs(uy) * (BW / 2 + 26)) : 0;
      const qx = mx - uy * bend, qy = my + ux * bend;
      const [x1, y1] = edgePoint(pa, qx, qy), [x2, y2] = edgePoint(pb, qx, qy);
      svg += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${col}" stroke-width="${heavy ? 4 : 2}"${off || hand ? ' stroke-dasharray="7 6"' : ""} stroke-linecap="round" opacity="${off ? .75 : 1}"/>`;
      if (ab) svg += head(x2, y2, Math.atan2(y2 - qy, x2 - qx), ab < 0 ? "var(--red)" : col);
      if (ba) svg += head(x1, y1, Math.atan2(y1 - qy, x1 - qx), ba < 0 ? "var(--red)" : col);
    }
    for (const [name, p] of L.pos) {
      const s = M.systems.get(name), cls = fuelClass(s.days), isHome = name === M.home, sel = name === selected;
      svg += `<g class="roads-sys${sel ? " sel" : ""}${isHome ? " home" : ""}" data-sys="${esc(name)}" tabindex="0" role="button" aria-label="${esc(name)}">` +
        `<rect x="${p.x}" y="${p.y}" width="${BW}" height="${BH}" rx="3"/>` +
        `<text class="rn" x="${p.cx}" y="${p.y + 24}" text-anchor="middle">${isHome ? "✠ " : ""}${esc(name)}</text>` +
        `<text class="rf ${cls}" x="${p.cx}" y="${p.y + 45}" text-anchor="middle">${s.days == null ? (s.nodes.length ? "node idle" : "no node of ours") : "fuel " + fmtDays(s.days)}</text></g>`;
    }
    // a map a little wider than the pane is drawn smaller (down to 70 %); past that it scrolls sideways
    const k = avail > 0 ? Math.max(.7, Math.min(1, avail / L.w)) : 1;
    box.innerHTML = `<svg class="roads-svg" width="${Math.floor(L.w * k)}" height="${Math.ceil(L.h * k)}" viewBox="0 0 ${L.w} ${L.h}" role="img" aria-label="Map of the tribe's roads">${svg}</svg>`;
  }
  function segHitsBox(x1, y1, x2, y2, p) {                    // does the segment pass through the box (with a margin)?
    const m = 6, l = p.x - m, r = p.x + BW + m, t = p.y - m, b = p.y + BH + m;
    for (let i = 1; i < 20; i++) { const x = x1 + (x2 - x1) * i / 20, y = y1 + (y2 - y1) * i / 20; if (x > l && x < r && y > t && y < b) return true; }
    return false;
  }

  function drawDetail() {
    const el = $("roads-detail");
    if (!selected || !M.systems.has(selected)) { el.innerHTML = `<span class="roads-hint">Click a system for its roads and nodes.</span>`; return; }
    const s = M.systems.get(selected), out = M.roads.filter(r => r.from === selected || (r.twoWay && r.to === selected)), inn = M.roads.filter(r => r.to === selected && !r.twoWay);
    const row = (r, other) => `<li><b>${esc(other)}</b> · ${esc(r.kind)}${r.twoWay ? " · both ways" : ""}${r.online === false ? ' · <span class="bad">offline</span>' : ""}${r.source === "list" ? " · from the hand-kept list" : ""}${r.name ? ` · <i>${esc(r.name)}</i>` : ""}</li>`;
    el.innerHTML = `<div class="roads-dh">${esc(selected)}${s.note ? ` <span class="roads-note">${esc(s.note)}</span>` : ""}</div>` +
      `<div class="roads-dcols"><div><h4>Roads out</h4><ul>${out.map(r => row(r, r.from === selected ? r.to : r.from)).join("") || "<li>None: a dead end.</li>"}</ul></div>` +
      `<div><h4>Roads in</h4><ul>${inn.map(r => row(r, r.from)).join("") || "<li>None.</li>"}</ul></div>` +
      `<div><h4>Our nodes here</h4><ul>${s.nodes.map(n => `<li><b>${esc(n.name || short(n.id))}</b> · ${n.fuel.quantity.toLocaleString("en-US")} fuel${M.daysOf(n) == null ? " · not burning" : ` · <span class="${fuelClass(M.daysOf(n))}">${fmtDays(M.daysOf(n))}</span>`}</li>`).join("") || "<li>None known.</li>"}</ul></div></div>`;
  }

  function drawFuel() {
    const rows = M.nodes.map(n => ({ n, d: M.daysOf(n), s: M.nodeSys(n.id) })).sort((a, b) => (a.d == null) - (b.d == null) || a.d - b.d);
    $("roads-fuel").innerHTML = rows.length ? rows.map(x => `<div class="roads-frow"><span class="fs">${esc(x.s || "not placed")}</span><span class="fn">${esc(x.n.name || short(x.n.id))}</span>` +
      `<span class="fd ${fuelClass(x.d)}">${x.d == null ? "idle" : fmtDays(x.d)}</span><span class="fu">${x.n.fuel.quantity.toLocaleString("en-US")}</span></div>`).join("") : `<div class="roads-hint">No node read from the chain.</div>`;
    const low = rows.filter(x => x.d != null && x.d < 14).length;
    $("roads-fuel-n").textContent = low ? low + " under two weeks" : rows.length + " nodes";
  }

  function fillRoute() {
    const names = [...M.systems.keys()].sort(), a = $("roads-from"), b = $("roads-to"), va = a.value, vb = b.value;
    const opts = names.map(n => `<option>${esc(n)}</option>`).join("");
    a.innerHTML = opts; b.innerHTML = opts;
    a.value = names.includes(va) ? va : (M.home || names[0] || ""); b.value = names.includes(vb) ? vb : (names.find(n => n !== a.value) || "");
    route();
  }
  function route() {
    const from = $("roads-from").value, to = $("roads-to").value, out = $("roads-route");
    if (!from || !to) { out.textContent = ""; return; }
    if (from === to) { out.innerHTML = `<span class="roads-hint">You are there.</span>`; return; }
    const step = new Map([[from, null]]), q = [from];
    while (q.length && !step.has(to)) {
      const k = q.shift();
      for (const r of M.roads) { if (r.online === false) continue;
        const n = r.from === k ? r.to : (r.twoWay && r.to === k ? r.from : null);
        if (n && !step.has(n)) { step.set(n, { via: r, prev: k }); q.push(n); } }
    }
    if (!step.has(to)) { out.innerHTML = `<span class="bad">No road from ${esc(from)} to ${esc(to)}.</span> Catapults throw one way: check the roads into ${esc(to)}.`; return; }
    const hops = []; for (let k = to; step.get(k); k = step.get(k).prev) hops.unshift({ to: k, via: step.get(k).via });
    out.innerHTML = `<div class="roads-hops"><b>${esc(from)}</b>` + hops.map(h => ` <span class="hop">→ <i>${esc(h.via.kind)}</i> →</span> <b>${esc(h.to)}</b>`).join("") + `</div><div class="roads-hint">${hops.length} jump${hops.length === 1 ? "" : "s"}.</div>`;
  }

  function drawUnplaced() {
    const el = $("roads-unplaced"); $("roads-unplaced-n").textContent = M.unplaced.length ? String(M.unplaced.length) : "none";
    if (!M.unplaced.length) { el.innerHTML = `<div class="roads-hint">Every launcher and gate read from the chain is on the map.</div>`; return; }
    const byNode = new Map(); for (const u of M.unplaced) { const k = u.node || ""; if (!byNode.has(k)) byNode.set(k, []); byNode.get(k).push(u); }
    el.innerHTML = [...byNode].map(([nid, us]) => {
      const n = M.nodeById.get(nid), d = M.daysOf(n), known = M.nodeSys(nid);
      return `<div class="roads-ugroup"><div class="roads-uh">Node ${esc((n && n.name) || short(nid))}${known ? " · in " + esc(known) : ""}${n ? ` · <span class="${fuelClass(d)}">${d == null ? "idle" : "fuel " + fmtDays(d)}</span>` : ""}</div>` +
        (M.canEdit && nid && !known ? `<div class="roads-uedit"><input type="text" placeholder="System this node stands in, e.g. ABC|D11" data-node="${esc(nid)}" maxlength="24"><button type="button" data-savenode="${esc(nid)}">Place node</button></div>` : "") +
        us.map(u => `<div class="roads-urow"><span><b>${esc(u.kind)}</b> ${u.name ? `<i>${esc(u.name)}</i>` : "(no name)"}${u.to ? " · to " + esc(u.to) : ""}<br><span class="roads-hint">Not placed: ${esc(u.why)}.</span></span>` +
          (M.canEdit ? `<span class="roads-uedit"><input type="text" placeholder="from" data-from="${esc(u.id)}" value="${esc(u.from || "")}" maxlength="24"><input type="text" placeholder="to" data-to="${esc(u.id)}" value="${esc(u.to || "")}" maxlength="24"><button type="button" data-savelauncher="${esc(u.id)}">Place</button></span>` : "") + `</div>`).join("") + `</div>`;
    }).join("");
  }

  function render(d) {
    M = build(d);
    $("roads-gate").hidden = true; $("roads-app").hidden = false;
    const mins = Math.max(0, Math.round((Date.now() - (d.at || Date.now())) / 60000));
    $("roads-stamp").textContent = (d.error ? "The chain did not answer: " + d.error + " · " : "") + `${M.systems.size} systems · ${M.roads.length} roads · read from the chain ${mins ? mins + " min ago" : "just now"}` + (M.list.updated_by ? ` · list last changed by ${M.list.updated_by}` : "");
    drawMap(); drawDetail(); drawFuel(); fillRoute(); drawUnplaced();
    const ed = $("roads-editor"); ed.hidden = !M.canEdit;
    if (M.canEdit) $("roads-json").value = JSON.stringify({ builders: M.list.builders, home: M.list.home || "", nodes: M.list.nodes, launchers: M.list.launchers, links: M.list.links, notes: M.list.notes }, null, 1);
  }

  // ---------- loading and saving ----------
  let loaded = false;
  function gate(html) { $("roads-app").hidden = true; const g = $("roads-gate"); g.hidden = false; g.innerHTML = html; }
  function load(fresh) {
    if (!/(^|\.)thesaintsforge\.com$|^localhost$|^127\.0\.0\.1$/.test(location.hostname)) { gate("The roads are kept for the tribe. Open them on <b>thesaintsforge.com</b> and log in with Discord."); return Promise.resolve(); }   // localhost = tools/roads_local.py
    gate("Reading the roads from the chain…");
    return fetch("/api/network" + (fresh ? "?fresh=1" : ""), { credentials: "same-origin" }).then(r => {
      if (r.status === 401) { gate('The roads are for the tribe only. <a class="tribe-btn" href="/api/login">✠ Log in with Discord</a><br><span class="roads-hint">Saint rank or above. After the login, come back to this page.</span>'); return null; }
      if (!r.ok) throw new Error("the site answered " + r.status);
      return r.json();
    }).then(d => { if (d) render(d); }).catch(e => gate("The roads could not be read: " + esc(e.message) + "."));
  }
  function save(list, what) {
    $("roads-save-note").textContent = "saving…";
    return fetch("/api/network", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(list) })
      .then(r => r.json().then(x => ({ ok: r.ok, x })))
      .then(res => { if (!res.ok) { $("roads-save-note").textContent = "not saved: " + ((res.x && res.x.error) || "error"); return; } $("roads-save-note").textContent = what + " saved."; return load(true); })
      .catch(() => { $("roads-save-note").textContent = "not saved: the site could not be reached."; });
  }
  const listCopy = () => JSON.parse(JSON.stringify({ builders: M.list.builders, home: M.list.home || "", nodes: M.list.nodes || {}, launchers: M.list.launchers || {}, links: M.list.links || [], notes: M.list.notes || {} }));

  root.addEventListener("click", e => {
    const g = e.target.closest("[data-sys]"); if (g) { selected = g.dataset.sys; drawMap(); drawDetail(); return; }
    const b = e.target.closest("button"); if (!b || !M) return;
    if (b.id === "roads-refresh") { load(true); return; }
    if (b.dataset.savenode) { const v = up(root.querySelector(`input[data-node="${b.dataset.savenode}"]`).value); if (!v) return; const l = listCopy(); l.nodes[b.dataset.savenode] = v; save(l, "Node"); return; }
    if (b.dataset.savelauncher) { const id = b.dataset.savelauncher, f = up(root.querySelector(`input[data-from="${id}"]`).value), t = up(root.querySelector(`input[data-to="${id}"]`).value); if (!f || !t) { $("roads-save-note").textContent = "give both systems."; return; } const l = listCopy(); l.launchers[id] = { from: f, to: t }; save(l, "Launcher"); return; }
    if (b.id === "roads-json-save") { let l; try { l = JSON.parse($("roads-json").value); } catch (err) { $("roads-save-note").textContent = "that is not valid JSON."; return; } save(l, "List"); }
  });
  root.addEventListener("keydown", e => { const g = e.target.closest && e.target.closest("[data-sys]"); if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selected = g.dataset.sys; drawMap(); drawDetail(); } });
  root.addEventListener("change", e => { if (e.target.id === "roads-from" || e.target.id === "roads-to") route(); });

  // the page loads its data the first time it is shown
  const seen = () => { if (root.hidden) return; if (!loaded) { loaded = true; load(false); } else if (M) drawMap(); };
  // the map is redrawn whenever its pane changes width (window resize, the side menu folding, a late layout)
  let rz = 0, lastW = 0; const redraw = () => { clearTimeout(rz); rz = setTimeout(() => { const w = $("roads-map").clientWidth; if (M && !root.hidden && Math.abs(w - lastW) > 1) { lastW = w; drawMap(); } }, 120); };
  if (window.ResizeObserver) new ResizeObserver(redraw).observe($("roads-map")); else window.addEventListener("resize", redraw);
  new MutationObserver(seen).observe(root, { attributes: true, attributeFilter: ["hidden"] }); seen();
  window.__roadsRender = d => { loaded = true; render(d); };          // tests and local previews feed a fixture
  window.__roadsParse = parseName;
})();
