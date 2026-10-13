/* The Pilgrim Roads: the tribe's road network (catapults and gates) as a map, a fuel watch and a route finder.
   Data comes from /api/network (tribe session only): what the chain says about the builders' launchers, gates and
   Network Nodes. Nothing about a road is kept by hand: a road is on the map only when the names written in game say
   where it runs. The chain holds no readable position for these structures (a hash only), so the names are all there is.
     - a launcher or gate named with two systems is placed from the name:
         "ABC|D11 > XYZ|K22", "A >>> B", "A -> B", "A to B"   = from A to B
         "A ⇄ B", "A <> B", "A <-> B"                          = both ways
     - a name with one system is the destination ("XYZ|K22", "XYZ|K22 Level 4 System"); words in brackets are a
       route note ("XYZ|K22 (Route to QRS|T33)" = to XYZ, on the way to QRS);
     - the origin is then the system its Network Node stands in, known when the node's name starts with a full system
       name ("ABC|D11 > XYZ QRS"), when another launcher on the node carries its origin, or when a gate linked to a
       gate on that node is named for it (a gate is named for where it leads, so its partner stands there);
     - a node name that only lists systems ("XYZ / QRS", "to XYZ|K22") gives the destinations of its unnamed launchers;
     - a three-character short code counts when exactly one known full name starts with it;
     - last, a node is WORKED OUT (drawn dashed, marked as such) when a placed system throws to X and exactly one
       unplaced node throws back, with matching route notes and every one of its throws within launcher range of X.
   Whatever cannot be placed is listed under "Not on the map", with the name that would place it. */
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

  const STOP = new Set(["THE", "CAT", "LVL", "FOR", "AND", "OUT", "OFF", "NEW", "OLD", "WAY", "VIA", "TOP", "END", "ONE", "TWO", "HUB", "NET", "ALL", "GAS", "ORE"]);
  const RANGE = { "Mini Catapult": 60, "Heavy Catapult": 250, "Mini Gate": 105, "Heavy Gate": 365 };   // light-years
  // every system a text mentions, in order: a full name always; a three-character short code when exactly one known
  // full name starts with it (known: first three characters -> full name, "" when two names share them)
  function mentions(text, known) {
    const out = [], re = /[A-Z0-9]{3}\|[A-Z0-9]{3}|[A-Z0-9]+/g; let m;
    while ((m = re.exec(text))) {
      const t = m[0];
      if (t.length === 7 && t[3] === "|") out.push({ name: t, at: m.index, end: m.index + 7 });
      else if (t.length === 3 && !STOP.has(t)) { const full = known && known.get(t); if (full) out.push({ name: full, at: m.index, end: m.index + 3, short: true }); else if (/\d/.test(t)) out.push({ name: null, raw: t, at: m.index, end: m.index + 3 }); }
    }
    return out;
  }
  /* What a name says: { from, to, both, route, list, lead, unknown }.
     list = every system before a bracket; lead = the name starts with a full system name (a node named for its system);
     unknown = short codes no known system starts with. */
  function readName(name, known) {
    const s = up(name), cut = s.indexOf("("), main = cut < 0 ? s : s.slice(0, cut), tail = cut < 0 ? "" : s.slice(cut);
    const a = mentions(main, known), b = mentions(tail, known), ok = a.filter(x => x.name);
    const R = { from: null, to: null, both: false, route: (b.find(x => x.name) || {}).name || null, list: ok.map(x => x.name), lead: false, unknown: a.concat(b).filter(x => !x.name).map(x => x.raw) };
    if (ok.length >= 2) {
      const mid = main.slice(ok[0].end, ok[1].at);
      if (/⇄|↔|<-?>|<=>/.test(mid)) { R.from = ok[0].name; R.to = ok[1].name; R.both = true; }
      else if (/>|→|\bTO\b/.test(mid)) { R.from = ok[0].name; R.to = ok[1].name; }
    } else if (ok.length === 1) R.to = ok[0].name;
    R.lead = ok.length > 0 && !ok[0].short && main.slice(0, ok[0].at).trim() === "";
    return R;
  }

  // ---------- the model: systems, roads, what could not be placed ----------
  let dist = null;                                            // (idA, idB) -> light-years, once the stars are loaded
  function build(d) {
    const list = Object.assign({ builders: [], home: "", systems: {}, plans: [], gates: [] }, d.list || {});
    // the game's number of a system, captured from the game's own links: {"ABC|D11": 30000001} or {"ABC|D11": {"id": 30000001, "sure": false}}
    const ids = new Map(); for (const [name, v] of Object.entries(list.systems || {})) { const id = typeof v === "number" ? v : v && +v.id; if (id) ids.set(up(name), { id, sure: typeof v === "number" ? true : v.sure !== false }); }
    // Cycle 7 names charted on EF-Map's community map, read by the site with the tribe's partner key: [[id, name, status]].
    // A number copied from the game always wins; EF-Map fills in the systems nobody here has copied yet, and a name
    // only one player reported there counts as "not sure" (the dashed ring).
    const efById = new Map(), efByName = new Map(), efNotes = [];
    for (const x of (d.names && d.names.systems) || []) { const id = +x[0], name = up(x[1]); if (!id || !name) continue; efById.set(id, { name, status: x[2] }); efByName.set(name, { id, status: x[2] }); }
    for (const [name, k] of ids) { const byId = efById.get(k.id), byName = efByName.get(name);
      if (byId && byId.name !== name) efNotes.push(`${name} is number ${k.id} in our list; EF-Map calls that number ${byId.name}.`);
      else if (byName && byName.id !== k.id) efNotes.push(`${name} is number ${k.id} in our list; EF-Map has it as ${byName.id}.`); }
    const fromEf = name => { const e = efByName.get(name); if (!e || ids.has(name)) return; for (const k of ids.values()) if (k.id === e.id) return; ids.set(name, { id: e.id, sure: e.status === "confirmed", ef: e.status }); };
    fromEf(up(list.home));
    const nodeById = new Map((d.nodes || []).map(n => [n.id, n]));
    const daysOf = n => n && n.fuel && n.fuel.burning && n.fuel.burnMs ? n.fuel.quantity * n.fuel.burnMs / 86400000 : null;
    // every full system name the chain or the numbered systems mention: what a short code may stand for
    const known = new Map(), learn = n => { const k = n.slice(0, 3); known.set(k, known.has(k) && known.get(k) !== n ? "" : n); };
    for (const n of ids.keys()) if (/^[A-Z0-9]{3}\|[A-Z0-9]{3}$/.test(n)) learn(n);
    for (const x of (d.assemblies || []).concat(d.nodes || [])) for (const c of up(x.name).match(CODE) || []) { learn(c); fromEf(c); }

    // where each node stands: { sys, basis: "node" | "name" | "gate" | "inferred", why, dests }
    const info = new Map(), ni = id => { if (!info.has(id)) info.set(id, { sys: null, basis: null, why: "", dests: [] }); return info.get(id); };
    for (const n of d.nodes || []) { const r = readName(n.name, known), i = ni(n.id); if (r.lead) { i.sys = r.list[0]; i.basis = "node"; i.dests = r.list.slice(1); } else i.dests = r.list.slice(); }
    const L = (d.assemblies || []).map(a => { const r = readName(a.name, known); return { a, gate: /Gate/.test(a.kind), from: r.from, to: r.to, both: r.both, route: r.route, unknown: r.unknown, many: !r.to && r.list.length > 1 }; });
    const byId = new Map(L.map(l => [l.a.id, l])), onNode = new Map();
    for (const l of L) { const k = l.a.node || ""; if (!onNode.has(k)) onNode.set(k, []); onNode.get(k).push(l); }
    // unnamed catapults take the destinations their node's name lists and no named launcher on the node uses
    for (const [nid, ls] of onNode) { if (!nid) continue; const i = ni(nid), used = new Set(ls.map(l => l.to).filter(Boolean)), free = i.dests.filter(x => !used.has(x) && x !== i.sys), blank = ls.filter(l => !l.gate && !up(l.a.name));
      if (free.length && free.length === blank.length) blank.forEach((l, k) => { l.to = free[k]; l.viaNode = true; }); }
    const place = (nid, sys, basis, why) => { if (!nid || !sys) return false; const i = ni(nid); if (i.sys) return false; i.sys = sys; i.basis = basis; i.why = why || ""; return true; };
    for (const l of L) if (l.from && !l.both) place(l.a.node, l.from, "name");
    // a gate is named for where it leads, so the gate linked to it stands there
    for (const l of L) if (l.gate && l.a.linked && l.to && !l.from) { const h = byId.get(l.a.linked); if (h) place(h.a.node, l.to, "gate"); }
    for (const l of L) if (l.gate && l.both && l.a.linked) { const h = byId.get(l.a.linked), sy = ni(l.a.node).sys; if (h && (sy === l.from || sy === l.to)) place(h.a.node, sy === l.from ? l.to : l.from, "gate"); }
    // worked out: a placed system S throws to X, and exactly one unplaced node throws back to S; the route notes of
    // both throws must agree, and everything that node throws to must lie within launcher range of X
    const far = (x, y, kind) => { if (!dist) return false; const a = ids.get(x), b = ids.get(y); if (!a || !b) return false; const ly = dist(a.id, b.id); return ly != null && ly > (RANGE[kind] || 1e9) * 1.02; };
    const reaches = (nid, z) => (onNode.get(nid) || []).some(q => q.to === z || q.route === z);
    for (let changed = true; changed;) { changed = false;
      for (const sid of [...onNode.keys()].sort()) { const S = sid && ni(sid).sys; if (!S) continue;
        for (const l of onNode.get(sid)) { const X = l.to; if (l.gate || !X || X === S || (l.from && l.from !== S)) continue;
          if ([...info.values()].some(i => i.sys === X)) continue;
          const cands = [...onNode].filter(([nid, qs]) => nid && !ni(nid).sys
            && qs.some(q => q.to === S && !q.from && (!q.route || q.route === S || reaches(sid, q.route)))
            && (!l.route || l.route === X || reaches(nid, l.route))
            && !qs.some(q => q.to && (q.to === X || far(X, q.to, q.a.kind))));
          if (cands.length === 1 && place(cands[0][0], X, "inferred", `${S} throws to ${X}${l.route && l.route !== X ? ", on the way to " + l.route : ""}, and this is the one node that throws back to ${S}`)) changed = true;
        } } }

    const roads = [], unplaced = [], pairs = new Set(), none = { sys: null, basis: null, why: "" };
    const lyOf = (x, y) => { if (!dist) return null; const a = ids.get(x), b = ids.get(y); return a && b ? dist(a.id, b.id) : null; };
    const add = r => { const ly = lyOf(r.from, r.to); if (ly != null) { r.ly = ly; if (ly > (RANGE[r.kind] || 1e9) * 1.02) r.tooFar = true; } roads.push(r); };
    for (const l of L) {
      const a = l.a, i = a.node ? ni(a.node) : none, days = daysOf(nodeById.get(a.node));
      const base = { id: a.id, kind: a.kind, name: a.name, node: a.node, days, builder: a.builder, source: "chain" };
      if (l.gate) {
        if (!a.linked) { unplaced.push(Object.assign(base, { why: "it is not linked to another gate", fix: "Link it to its partner in game." })); continue; }
        const key = [a.id, a.linked].sort().join("|"); if (pairs.has(key)) continue; pairs.add(key);
        const h = byId.get(a.linked), j = h && h.a.node ? ni(h.a.node) : none, named = l.both ? l : (h && h.both ? h : null);
        const from = named ? named.from : (i.sys || (h && !h.from && h.to) || null), to = named ? named.to : (j.sys || (!l.from && l.to) || null);
        const db = h ? daysOf(nodeById.get(h.a.node)) : null, guess = !named && (i.basis === "inferred" || j.basis === "inferred");
        if (from && to && from !== to) add(Object.assign(base, { from, to, twoWay: true, online: a.status === "ONLINE" && (!h || h.a.status === "ONLINE"), days: days == null ? db : db == null ? days : Math.min(days, db), inferred: guess, why: guess ? (i.basis === "inferred" ? i.why : j.why) : "" }));
        else unplaced.push(Object.assign(base, { from, to, why: "the systems at its two ends are not on chain", fix: 'Name both gates "A <> B", full system names.' }));
        continue;
      }
      const from = l.from || i.sys, to = l.to, guess = !l.from && i.basis === "inferred";
      if (from && to && from !== to) { add(Object.assign(base, { from, to, twoWay: l.both, online: a.status === "ONLINE", inferred: guess, why: guess ? i.why : "" })); continue; }
      const u = Object.assign(base, { from, to, online: a.status === "ONLINE" });
      if (!to && l.unknown.length) { u.why = `"${l.unknown.join('", "')}" is not a system name the map knows`;
        const maybe = l.unknown.map(raw => { const m = [...efByName.keys()].filter(n => n.startsWith(raw)); return m.length === 1 ? m[0] : null; }).filter(Boolean);
        u.fix = maybe.length ? `EF-Map charts ${maybe.join(" and ")}: if that is the system, write the full name.` : "Use the full name, like ABC|D11."; }
      else if (to && !from) { u.why = "the chain does not say where it stands"; u.fix = `${up(a.name) ? "Rename" : "Name"} it "HERE > ${to}", HERE being the system it stands in.`; }
      else if (!up(a.name)) { u.why = "it has no name"; u.fix = from ? `Name it "${from} > DESTINATION".` : 'Name it "FROM > TO", full system names.'; }
      else if (l.many) { u.why = "its name holds several systems and no arrow"; u.fix = 'Name it "FROM > TO".'; }
      else if (!to) { u.why = "its name holds no system"; u.fix = from ? `Name it "${from} > DESTINATION".` : 'Name it "FROM > TO", full system names.'; }
      else { u.why = "its name gives the same system twice"; u.fix = 'Name it "FROM > TO".'; }
      unplaced.push(u);
    }
    // plans: every hop is a planned road between two numbered systems; a system with no Cycle 7 name yet is shown
    // by its number's old name, marked "(C6)"
    const planName = (id, old) => { for (const [n, k] of ids) if (k.id === id) return n; const e = efById.get(id); if (e && !ids.has(e.name)) { ids.set(e.name, { id, sure: e.status === "confirmed", ef: e.status }); return e.name; } const nm = old ? `${old} (C6)` : `#${id}`; if (!ids.has(nm)) ids.set(nm, { id, sure: true, c6: true }); return nm; };
    const plans = (list.plans || []).map((p, i) => ({ i, name: p.name || `Plan ${i + 1}`, note: p.note || "", hops: (p.hops || []).map(h => ({ ...h, fromSys: planName(h.from, h.fromName), toSys: planName(h.to, h.toName) })) }));
    for (const p of plans) for (const h of p.hops) if (!h.gap) roads.push({ id: null, kind: h.kind, name: p.name, node: null, days: null, source: "plan", plan: p.i, from: h.fromSys, to: h.toSys, twoWay: /Gate/.test(h.kind || ""), online: true, status: "planned" });
    // public (NPC) stargates a Saint has jumped, recorded by hand under Manage: drawn as roads (the whole network the
    // client lists is the faint grey layer, gates.bin). A jumped gate is a two-way road that nobody fuels for us.
    for (const g of list.gates || []) { const a = up(g.a || ""), b = up(g.b || ""); if (!a || !b || a === b) continue; fromEf(a); fromEf(b);
      add({ id: null, kind: "Public Gate", name: g.note || "", node: null, days: null, source: "public", from: a, to: b, twoWay: true, online: true, status: "built" }); }
    const systems = new Map(), sys = n => { if (!systems.has(n)) systems.set(n, { name: n, nodes: [], days: null, guess: false }); return systems.get(n); };
    for (const r of roads) { sys(r.from); sys(r.to); }
    for (const n of d.nodes || []) { const i = info.get(n.id); if (i && i.sys) sys(i.sys).nodes.push(n); }
    for (const s of systems.values()) { for (const n of s.nodes) { const dd = daysOf(n); if (dd != null && (s.days == null || dd < s.days)) s.days = dd; } s.guess = s.nodes.length > 0 && s.nodes.every(n => ni(n.id).basis === "inferred"); }
    let home = up(list.home); if (!systems.has(home)) home = [...systems.keys()].sort()[0] || "";
    const nodeSys = id => (id && info.has(id) && info.get(id).sys) || null, nodeGuess = id => !!(id && info.has(id) && info.get(id).basis === "inferred");
    const ef = { byId: efById, byName: efByName, notes: efNotes, count: efById.size, confirmed: [...efById.values()].filter(e => e.status === "confirmed").length, error: (d.names && d.names.error) || null, used: [...ids.values()].filter(k => k.ef).length };
    return { list, roads, unplaced, systems, ids, plans, nodeById, nodeSys, nodeGuess, daysOf, home, ef, canEdit: !!d.canEdit, at: d.at, error: d.error, nodes: d.nodes || [] };
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

  let M = null, selected = null, picked = null;             // picked: a charted system clicked on the star map (not one of ours)
  let unplacedBy = "builder"; try { unplacedBy = localStorage.getItem("roads:unplacedBy") === "node" ? "node" : "builder"; } catch (e) {}   // how Not on the map is grouped
  let showCharted = true; try { showCharted = localStorage.getItem("roads:charted") !== "0"; } catch (e) {}
  let showGates = true; try { showGates = localStorage.getItem("roads:gates") !== "0"; } catch (e) {}       // the public stargate network (gates.bin)
  // a system's name as the page knows it: ours, then EF-Map's, then the archived Cycle 6 name marked (C6)
  const nameOfId = id => { for (const [n, k] of M.ids) if (k.id === id) return n; const e = M.ef.byId.get(id); if (e && e.status === "confirmed") return e.name; const old = sf && sf.oldName(id); return old ? old + " (C6)" : "#" + id; };
  // has a Saint jumped this gate? (list.gates, recorded under Manage)
  const jumped = (a, b) => (M.list.gates || []).some(g => (up(g.a) === a && up(g.b) === b) || (up(g.a) === b && up(g.b) === a));
  // the public gates of one system, from the game client; a jumped one is marked, the rest are of unknown state
  function gateList(id) {
    if (!sf || !sf.gateCount()) return "";
    const g = sf.gatesOf(id); if (!g.length) return `<div class="roads-hint">No public stargate here, says the game client.</div>`;
    const me = nameOfId(id), rows = g.map(o => ({ o, d: dist ? dist(id, o) : null })).sort((a, b) => (a.d || 0) - (b.d || 0));
    return `<h4>Public gates · ${g.length}</h4><ul>${rows.map(r => { const n = nameOfId(r.o); return `<li><b>${esc(n)}</b>${r.d != null ? ` · ${Math.round(r.d).toLocaleString("en-US")} LY` : ""}${jumped(me, n) ? ' · <span class="ok">jumped</span>' : ""}</li>`; }).join("")}</ul><div class="roads-hint">From the game client. Working, unfueled or dormant: only a jump tells; record one under Manage.</div>`;
  }
  function drawMap() {
    const box = $("roads-map");
    if (!M.systems.size) { box.innerHTML = `<div class="roads-empty">No road is on the map yet. ${M.list.builders.length ? "A launcher appears when its name in game carries its systems: see Not on the map." : "No builder is set."}</div>`; return; }
    const avail = box.clientWidth - 14, L = layout(M, avail), groups = new Map();
    for (const r of M.roads) { const k = [r.from, r.to].sort().join("  "); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    let svg = "";
    for (const [k, rs] of groups) {
      const [a, b] = k.split("  "), pa = L.pos.get(a), pb = L.pos.get(b);
      // per direction: 1 = a working road, -1 = only offline ones (its arrowhead is drawn red), 0 = none
      const dir = (f, t) => { const d = rs.filter(r => (r.from === f && r.to === t) || r.twoWay); return d.length ? (d.some(r => r.online !== false) ? 1 : -1) : 0; };
      const ab = dir(a, b), ba = dir(b, a);
      const heavy = rs.some(r => /Heavy/.test(r.kind)), gate = rs.some(r => /Gate/.test(r.kind)), off = rs.every(r => r.online === false), hand = rs.every(r => r.inferred);
      const planned = rs.every(r => r.status === "planned");
      const col = off ? "var(--red)" : planned ? "var(--silver)" : hand ? "var(--silver)" : gate ? "var(--title)" : "var(--gold)";
      // a straight road, or a bowed one when a third system stands in the way
      const blocked = [...L.pos.entries()].some(([n, p]) => n !== a && n !== b && segHitsBox(pa.cx, pa.cy, pb.cx, pb.cy, p));
      const mx = (pa.cx + pb.cx) / 2, my = (pa.cy + pb.cy) / 2, len = Math.hypot(pb.cx - pa.cx, pb.cy - pa.cy) || 1;
      // the bow clears a box whichever way the road runs: wide for a road running down, low for one running across
      const ux = (pb.cx - pa.cx) / len, uy = (pb.cy - pa.cy) / len, bend = blocked ? 2 * (Math.abs(ux) * (BH / 2 + 26) + Math.abs(uy) * (BW / 2 + 26)) : 0;
      const qx = mx - uy * bend, qy = my + ux * bend;
      const [x1, y1] = edgePoint(pa, qx, qy), [x2, y2] = edgePoint(pb, qx, qy);
      svg += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${col}" stroke-width="${heavy ? 4 : 2}"${planned ? ' stroke-dasharray="2 5"' : off || hand ? ' stroke-dasharray="7 6"' : ""} stroke-linecap="round" opacity="${off ? .75 : 1}"/>`;
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
    if (!selected && picked) {                               // a star that is not on our roads: charted, reported once, or nothing known
      const e = M.ef.byId.get(picked), h = M.ids.get(M.home), ly = dist && h ? dist(h.id, picked) : null, old = sf && sf.oldName(picked);
      let near = null; if (dist) for (const name of M.systems.keys()) { const k = M.ids.get(name); if (!k) continue; const d = dist(k.id, picked); if (d != null && (!near || d < near.d)) near = { name, d }; }
      const reach = near ? (near.d <= RANGE["Mini Catapult"] ? "a Mini Catapult reaches it" : near.d <= RANGE["Heavy Catapult"] ? "a Heavy Catapult reaches it" : "beyond one catapult throw") : "";
      const where = (near ? ` Nearest of ours: ${esc(near.name)}, ${Math.round(near.d).toLocaleString("en-US")} LY (${reach}).` : "") + (ly != null && (!near || near.name !== M.home) ? ` ${Math.round(ly).toLocaleString("en-US")} LY from ${esc(M.home)}.` : "");
      const ok = e && e.status === "confirmed";
      const what = ok ? "Charted on EF-Map's community map: two or more players agree on the name. None of our roads goes there."
        : e && e.status === "conflict" ? `Not confirmed: players disagree on its name (most reported: ${esc(e.name)}).`
        : e ? `Not confirmed: one player has reported the name ${esc(e.name)}. A second matching report on EF-Map charts it.`
        : `Nobody has reported a name for it yet${old ? ` (its Cycle 6 name was ${esc(old)})` : ""}.`;
      el.hidden = false; el.innerHTML = `<div class="roads-dh">${ok ? esc(e.name) : "Uncharted"}</div><div class="roads-hint">${what}${where}</div>` + (showGates ? `<div class="roads-dcols"><div>${gateList(picked)}</div></div>` : ""); return; }
    if (!selected || !M.systems.has(selected)) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    const s = M.systems.get(selected), out = M.roads.filter(r => r.from === selected || (r.twoWay && r.to === selected)), inn = M.roads.filter(r => r.to === selected && !r.twoWay);
    const row = (r, other) => `<li><b>${esc(other)}</b> · ${esc(r.kind)}${r.twoWay ? " · both ways" : ""}${r.online === false ? ' · <span class="bad">offline</span>' : ""}${r.ly != null ? ` · ${r.ly.toFixed(0)} LY` : ""}${r.tooFar ? ` · <span class="bad">beyond its ${RANGE[r.kind]} LY reach: check the name</span>` : ""}${r.name ? ` · <i>${esc(r.name)}</i>` : ""}${r.inferred ? ` · <span class="roads-hint">worked out: ${esc(r.why)}</span>` : ""}</li>`;
    const kSel = M.ids.get(selected);
    el.innerHTML = `<div class="roads-dh">${esc(selected)}${kSel && kSel.ef ? ` <span class="roads-hint">· its place on the star map comes from EF-Map (${esc(kSel.ef)})</span>` : ""}</div>` +
      `<div class="roads-dcols"><div><h4>Roads out</h4><ul>${out.map(r => row(r, r.from === selected ? r.to : r.from)).join("") || "<li>None: a dead end.</li>"}</ul></div>` +
      `<div><h4>Roads in</h4><ul>${inn.map(r => row(r, r.from)).join("") || "<li>None.</li>"}</ul></div>` +
      `<div><h4>Our nodes here</h4><ul>${s.nodes.map(n => `<li><b>${esc(n.name || short(n.id))}</b>${M.nodeGuess(n.id) ? " · worked out" : ""} · ${n.fuel.quantity.toLocaleString("en-US")} fuel${M.daysOf(n) == null ? " · not burning" : ` · <span class="${fuelClass(M.daysOf(n))}">${fmtDays(M.daysOf(n))}</span>`}</li>`).join("") || "<li>None known.</li>"}</ul></div>` +
      (showGates && kSel ? `<div>${gateList(kSel.id)}</div>` : "") + `</div>`;
  }

  function drawFuel() {
    const all = M.nodes.map(n => ({ n, d: M.daysOf(n), s: M.nodeSys(n.id) })).sort((a, b) => (a.d == null) - (b.d == null) || a.d - b.d);
    const rows = all.filter(x => x.s), rest = all.filter(x => !x.s), restLow = rest.filter(x => x.d != null)[0];
    $("roads-fuel").innerHTML = (rows.length ? rows.map(x => `<div class="roads-frow"><span class="fs">${esc(x.s)}</span><span class="fn">${esc(x.n.name || "")}</span>` +
      `<span class="fd ${fuelClass(x.d)}">${x.d == null ? "idle" : fmtDays(x.d)}</span><span class="fu">${x.n.fuel.quantity.toLocaleString("en-US")}</span></div>`).join("") : `<div class="roads-hint">No node on the map yet.</div>`) +
      (rest.length ? `<div class="roads-hint">${rest.length} more node${rest.length === 1 ? "" : "s"} not on the map yet${restLow ? `, the shortest at <span class="${fuelClass(restLow.d)}">${fmtDays(restLow.d)}</span>` : ""}.</div>` : "");
    const low = all.filter(x => x.d != null && x.d < 3);
    $("roads-fuel-n").textContent = low.length ? ` · ${low.length} low` : "";
    const al = $("roads-alert"); al.hidden = !low.length;
    if (low.length) al.innerHTML = `⚠ Fuel runs out within three days: ` + low.map(x => `<b>${esc(x.s || "a node not on the map")}</b> ${fmtDays(x.d)}`).join(" · ");
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

  // ---------- the star map ----------
  let sf = null, sfLoading = null, view = "stars";
  function starsReady() {
    const box = $("roads-stars"); if (!box) return Promise.resolve(null);
    if (sf) return Promise.resolve(sf);
    if (!window.Starfield) return Promise.resolve(null);
    if (!sfLoading) {
      sf = window.Starfield(box, { onPick: id => { const name = [...M.ids].find(([, v]) => v.id === id); selected = name ? name[0] : null; picked = !name && M.ef.byId.has(id) ? id : null; if (sf) sf.mark(null); drawDetail(); },
        onPickStar: id => { if (selected) return; picked = id || null; if (sf) sf.mark(id, "uncharted"); drawDetail(); }, onHover: () => {},
        onPlainWheel: () => { const h = box.querySelector(".sf-hint"); if (!h) return; h.classList.add("flash"); clearTimeout(h._t); h._t = setTimeout(() => h.classList.remove("flash"), 1800); } });   // a plain wheel scrolls the page: light up how to zoom
      if (!sf) return Promise.resolve(null);
      window.__roadsStars = sf;                                      // tests
      box.insertAdjacentHTML("beforeend", '<div class="sf-hint">drag: turn · shift-drag: move · ctrl + wheel: zoom · click any star</div><div class="sf-missing" id="sf-missing"></div>' +
        '<div class="sf-tools"><button type="button" data-sf="gates" title="The public stargate network, read from the game client. Whether a gate works or lies dormant it does not say." hidden>Public gates</button><button type="button" data-sf="charted" title="Systems players have named on EF-Map\'s community map" hidden>Charted</button><button type="button" data-sf="out" title="Zoom out" aria-label="Zoom out">−</button><button type="button" data-sf="in" title="Zoom in" aria-label="Zoom in">+</button><button type="button" data-sf="fit" title="Our network">Our roads</button><button type="button" data-sf="all" title="The whole galaxy">Galaxy</button><button type="button" data-sf="flat">Edge-on</button><button type="button" data-sf="top">Top-down</button></div>');
      sfLoading = sf.load("stars.bin?v=2").then(() => { dist = (a, b) => { const p = sf.position(a), q = sf.position(b); return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : null; }; if (lastData && !draft) { M = build(lastData); drawMap(); drawDetail(); drawFuel(); fillRoute(); drawUnplaced(); stamp(lastData); }
        // the public gates come after the stars, never in their way: the button appears once they are in
        sf.showGates(showGates);
        sf.loadGates("gates.bin?v=2").then(n => { const b = box.querySelector('[data-sf="gates"]'); if (b) { b.hidden = false; b.textContent = `Public gates · ${n.toLocaleString("en-US")}`; b.classList.toggle("on", showGates); } if (M) drawDetail(); }).catch(() => {});
        return sf; }).catch(e => { box.insertAdjacentHTML("beforeend", `<div class="sf-nogl">The stars could not be loaded: ${esc(e.message)}.</div>`); return null; });
    }
    return sfLoading;
  }
  function drawStars() {
    if (view !== "stars") return;
    starsReady().then(s => {
      if (!s) { setView("flat"); return; }
      const systems = [], missing = [];
      for (const [name, sys] of M.systems) {
        const k = M.ids.get(name); if (!k || !s.has(k.id)) { missing.push(name); continue; }
        const cls = name === M.home ? "home" : !k.sure || sys.guess ? "inferred" : sys.nodes.length ? "ours" : "far";
        systems.push({ id: k.id, name, cls, sub: sys.days == null ? (sys.nodes.length ? "node idle" : "") : "fuel " + fmtDays(sys.days), subColor: sys.days == null ? "#8a8378" : sys.days < 3 ? "#e3222c" : sys.days < 14 ? "#e0a84a" : "#7ec98b" });
      }
      // a system with a number but no road yet (a landmark, a destination to come) is still pinned on the star map
      for (const [name, k] of M.ids) if (!M.systems.has(name) && s.has(k.id)) systems.push({ id: k.id, name, cls: k.sure ? "far" : "inferred", sub: "" });
      for (const x of systems) { const k = M.ids.get(x.name); if (k && k.c6 && x.cls === "far") x.cls = "plan"; }
      // the systems charted on EF-Map's community map that our roads do not touch: small rings, named up close
      // Charted = two or more players agree on the name. A system with one report (or a disputed name) is still
      // uncharted (user 2026-10-12): a faint dashed mark, named "uncharted" under the pointer.
      const placed = new Set(systems.map(x => x.id)); let chartedN = 0, waitingN = 0;
      for (const [id, e] of M.ef.byId) { if (!s.has(id) || placed.has(id)) continue; const ok = e.status === "confirmed"; if (ok) chartedN++; else waitingN++;
        if (showCharted) systems.push(ok ? { id, name: e.name, cls: "charted", sub: "" } : { id, name: "uncharted", cls: "uncharted", sub: "" }); }
      const cb = $("roads-stars").querySelector('[data-sf="charted"]'); if (cb) { cb.hidden = !(chartedN + waitingN); cb.textContent = `Charted · ${chartedN.toLocaleString("en-US")}`; cb.classList.toggle("on", showCharted); }
      const roads = [];
      for (const r of M.roads) { const a = M.ids.get(r.from), b = M.ids.get(r.to); if (a && b) roads.push({ a: a.id, b: b.id, kind: r.kind, twoWay: r.twoWay, online: r.online, source: r.inferred ? "inferred" : r.source, status: r.status || "built" }); }
      s.setScene({ systems, roads }); if (!drawStars.fitted) { if (location.search.indexOf("sf=all") >= 0) s.fitAll(); else s.fit(); drawStars.fitted = true; }
      const sel = selected && M.ids.get(selected); s.select(sel ? sel.id : null);
      $("sf-missing").innerHTML = missing.length ? `<b>${missing.length} system${missing.length === 1 ? "" : "s"} without a number:</b> ${missing.map(esc).join(", ")}${M.canEdit ? " · Manage → paste its link from the game" : ""}` : "";
    });
  }
  function setView(v) {
    view = v; $("roads-stars").hidden = v !== "stars"; $("roads-map").hidden = v !== "flat";
    root.querySelectorAll(".roads-view button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
    try { localStorage.setItem("roads:view", v); } catch (e) {}
    if (M) { if (v === "stars") drawStars(); else drawMap(); }
  }
  try { view = localStorage.getItem("roads:view") === "flat" ? "flat" : "stars"; } catch (e) {}

  // ---------- road plans: one button each, a hop table, the plan drawn on the star map ----------
  const COST = { "Mini Catapult": [102, 22, 4], "Heavy Catapult": [650, 141, 26], "Mini Gate": [210, 46, 8], "Heavy Gate": [1060, 231, 43] };   // Kerogen Tar, Building Foam, Still Kernel (data/recipes.json)
  function drawPlans() {
    $("roads-plan-btns").innerHTML = M.plans.map(p => `<button type="button" data-panel="plan" data-plan="${p.i}">${esc(p.name)}${(M.list.plans[p.i] || {}).draft ? " (unsaved)" : ""}</button>`).join("");
  }
  let openPlan = null;
  function drawPlan(i) {
    const p = M.plans.find(x => x.i === i); if (!p) return; openPlan = i;
    const isDraft = !!(M.list.plans[i] || {}).draft;
    const builds = p.hops.filter(h => !h.gap), gaps = p.hops.filter(h => h.gap), ly = p.hops.reduce((a, h) => a + (h.ly || 0), 0);
    const mats = [0, 0, 0]; let launchers = 0;
    for (const h of builds) { const c = COST[h.kind]; if (!c) continue; const n = /Gate/.test(h.kind) ? 2 : 1; launchers += n; c.forEach((v, k) => mats[k] += v * n); }
    const pub = builds.filter(h => h.kind === "Public Gate").length, nodes = builds.length - pub;   // a public gate is nothing to build, and no node
    const row = (h, k) => `<div class="roads-prow"><span>${k + 1}</span><span><b>${esc(h.fromSys)}</b></span><span><b>${esc(h.toSys)}</b></span><span class="${h.gap ? "gap" : h.kind === "Public Gate" ? "pub" : "k"}">${h.gap ? "STARGATE NEEDED" : h.kind === "Public Gate" ? (jumped(h.fromSys, h.toSys) ? "public gate · jumped before" : "public gate · state unknown") : esc(h.kind)}</span><span class="ly">${(h.ly || 0).toFixed(1)}</span></div>`;
    $("roads-plan").innerHTML = `<div class="roads-plan"><div class="ph">${esc(p.name)}<small>${p.hops.length} hops · ${f0(ly)} LY</small></div>` +
      (p.note ? `<div class="pnote">${esc(p.note)}</div>` : "") +
      `<div class="ptot"><span><b>${launchers}</b> launchers to build (a gate counts twice)</span><span><b>${nodes}</b> Network Nodes</span>${pub ? `<span><b>${pub}</b> public gate${pub > 1 ? "s" : ""} to jump (50 EU-40 or SOF-40 Fuel each; a gate may be unfueled or dormant)</span>` : ""}${gaps.length ? `<span class="gap" style="color:var(--red)"><b>${gaps.length}</b> stargate${gaps.length > 1 ? "s" : ""} to find</span>` : ""}` +
      `<span>Kerogen Tar <b>${f0(mats[0])}</b></span><span>Building Foam <b>${f0(mats[1])}</b></span><span>Still Kernel <b>${f0(mats[2])}</b></span><span>+ per node 8 Printed Circuits, 8 Carbon Weave, 8 Thermal Composites and fuel</span></div>` +
      `<div class="roads-phead"><span>#</span><span>From</span><span>To</span><span>Build</span><span class="ly">LY</span></div>` + p.hops.map(row).join("") +
      `<div class="roads-hint">Systems marked (C6) carry their Cycle 6 name: their Cycle 7 name is not known yet. Distances are straight lines from the archived positions.</div>` +
      (M.canEdit ? `<div class="pacts">${isDraft ? `<button type="button" class="primary" data-plansave="1">Keep this plan</button><button type="button" data-plandrop="1">Drop it</button>` : `<button type="button" data-planremove="${i}">Remove this plan</button>`}</div>` : "") + `</div>`;
    if (sf && view === "stars") { const ids = new Set(); for (const h of p.hops) { const a = M.ids.get(h.fromSys), b = M.ids.get(h.toSys); if (a) ids.add(a.id); if (b) ids.add(b.id); } sf.fitTo([...ids]); }
  }
  const f0 = n => Math.round(n).toLocaleString("en-US");
  // the planner: a Worker over stars.bin; results show as an unsaved plan the editors can keep
  let planner = null, planning = false, draft = null, lastData = null;
  function fillPlanner() {
    const own = [...M.ids].filter(([, k]) => k.id).sort((a, b) => a[0].localeCompare(b[0])), have = new Set(own.map(([, k]) => k.id));
    const more = [...M.ef.byName].filter(([, e]) => !have.has(e.id)).sort((a, b) => a[0].localeCompare(b[0]));
    const mine = own.map(([n, k]) => `<option value="${k.id}">${esc(n)}</option>`).join("");
    const grp = (label, rows) => rows.length ? `<optgroup label="${label}">${rows.map(([n, e]) => `<option value="${e.id}">${esc(n)}</option>`).join("")}</optgroup>` : "";
    const opts = more.length ? `<optgroup label="Ours">${mine}</optgroup>` + grp("Charted on EF-Map", more.filter(([, e]) => e.status === "confirmed")) + grp("Uncharted: reported once", more.filter(([, e]) => e.status !== "confirmed")) : mine;
    const a = $("plan-from"), b = $("plan-to"), va = a.value, vb = b.value; a.innerHTML = opts; b.innerHTML = opts;
    const home = M.ids.get(M.home); a.value = va || (home ? home.id : ""); if (vb) b.value = vb;
  }
  function runPlanner() {
    if (planning) return;
    const from = +$("plan-from").value, to = +$("plan-to").value, tools = [...$("plan-tools").querySelectorAll("input:checked")].map(i => i.value);
    if (!from || !to || from === to) { $("plan-status").textContent = "pick two different systems."; return; }
    if (!tools.some(t => t !== "Public Gate")) { $("plan-status").textContent = "tick at least one launcher to build; public gates alone only go where the network already leads."; }
    if (!planner) { planner = new Worker("planner.js?v=" + Date.now()); planner.onmessage = e => {
      const m = e.data;
      if (m.type === "progress") { $("plan-status").textContent = `searching… ${f0(m.expanded)} systems looked at, closest ${f0(m.closest)} LY`; return; }
      planning = false; $("plan-run").disabled = false;
      if (m.error) { $("plan-status").textContent = "the planner failed: " + m.error; return; }
      const nameOf = id => { for (const [n, k] of M.ids) if (k.id === id) return n; const e = M.ef.byId.get(id); return e ? e.name : null; };
      const target = nameOf(to) || ("#" + to);
      draft = { name: "Road to " + target.replace(/ \(C6\)$/, ""), hops: m.hops,
                note: m.reached ? "Found by the planner: fewest launchers, straight-line distances from the archived positions." : "The target cannot be reached with these tools: the road runs to the closest reachable system and ends with a gap only an NPC stargate can cross." };
      $("plan-status").textContent = `${m.reached ? "road found" : "no full road"} · ${f0(m.expanded)} systems looked at in ${(m.ms / 1000).toFixed(1)} s`;
      showDraft();
    }; }
    planning = true; $("plan-run").disabled = true; $("plan-status").textContent = "searching…";
    planner.postMessage({ type: "plan", id: Date.now(), from, to, tools, stars: "stars.bin?v=2", gates: "gates.bin?v=2" });   // the client's gate network: free hops
  }
  function showDraft() {                          // the draft rides along as an extra, unsaved plan until kept or dropped
    const d = JSON.parse(JSON.stringify(lastData)); d.list.plans = (d.list.plans || []).concat([Object.assign({ draft: true }, draft)]);
    M = build(d); drawMap(); drawStars(); drawPlans(); drawPlan(M.plans.length - 1);
  }

  function drawUnplaced() {
    const el = $("roads-unplaced"); $("roads-unplaced-n").textContent = M.unplaced.length ? ` · ${M.unplaced.length}` : "";
    const long = M.roads.filter(r => r.tooFar);
    const warn = long.length ? `<div class="roads-ugroup"><div class="roads-uh">Names to check</div>` + long.map(r => `<div class="roads-urow"><span><b>${esc(r.from)} → ${esc(r.to)}</b> · ${esc(r.kind)} ${r.name ? `<i>${esc(r.name)}</i>` : ""}<br><span class="roads-hint">${r.ly.toFixed(0)} LY apart, beyond its ${RANGE[r.kind]} LY reach: one of the names is wrong${r.builder ? " · " + esc(r.builder) : ""}.</span></span></div>`).join("") + `</div>` : "";
    const notes = M.ef.notes.length ? `<div class="roads-ugroup"><div class="roads-uh">Numbers to check</div>` + M.ef.notes.map(t => `<div class="roads-urow"><span class="roads-hint">${esc(t)} Ours was copied from the game: tell EF-Map if theirs is wrong.</span></div>`).join("") + `</div>` : "";
    if (!M.unplaced.length) { el.innerHTML = notes + warn + `<div class="roads-hint">Every launcher and gate read from the chain is on the map.</div>`; return; }
    // grouped by builder (each builder sees the list of what is theirs to rename) or by Network Node; the choice is kept
    const fuelOf = nid => { const n = M.nodeById.get(nid), d = M.daysOf(n); return n ? ` · <span class="${fuelClass(d)}">${d == null ? "idle" : "fuel " + fmtDays(d)}</span>` : ""; };
    const nodeLabel = nid => { const n = M.nodeById.get(nid), here = M.nodeSys(nid); return `node ${esc((n && n.name) || short(nid))}${here ? " · in " + esc(here) : ""}`; };
    const row = (u, withNode) => `<div class="roads-urow"><span><b>${esc(u.kind)}</b> ${u.name ? `<i>${esc(u.name)}</i>` : "(no name)"}${u.to ? " · to " + esc(u.to) : ""}${u.online === false ? ' · <span class="bad">offline</span>' : ""}${withNode ? ` · <span class="roads-unode">${nodeLabel(u.node)}${fuelOf(u.node)}</span>` : ""}<br><span class="roads-hint">Not placed: ${esc(u.why)}. ${esc(u.fix || "")}</span></span></div>`;
    const bar = `<div class="roads-usort"><span>Group by</span><span class="roads-view" role="group" aria-label="Group the list by"><button type="button" data-ugroup="builder"${unplacedBy === "builder" ? ' class="on"' : ""}>Builder</button><button type="button" data-ugroup="node"${unplacedBy === "node" ? ' class="on"' : ""}>Network Node</button></span></div>`;
    let body;
    if (unplacedBy === "builder") {
      const byB = new Map(); for (const u of M.unplaced) { const k = u.builder || "Builder not known"; if (!byB.has(k)) byB.set(k, []); byB.get(k).push(u); }
      body = [...byB].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([who, us]) => {
        const bare = us.filter(u => !up(u.name)).length, nodes = new Set(us.map(u => u.node || "")).size;
        us = us.slice().sort((a, b) => nodeLabel(a.node).localeCompare(nodeLabel(b.node)) || (a.name || "").localeCompare(b.name || ""));
        return `<div class="roads-ugroup"><div class="roads-uh">${esc(who)} · ${us.length} not placed${bare ? ` · ${bare} with no name` : ""} · on ${nodes} node${nodes === 1 ? "" : "s"}</div>` + us.map(u => row(u, true)).join("") + `</div>`;
      }).join("");
    } else {
      const byNode = new Map(); for (const u of M.unplaced) { const k = u.node || ""; if (!byNode.has(k)) byNode.set(k, []); byNode.get(k).push(u); }
      body = [...byNode].map(([nid, us]) => `<div class="roads-ugroup"><div class="roads-uh">${esc(us[0].builder || "")} · ${nodeLabel(nid)}${fuelOf(nid)}</div>` + us.map(u => row(u, false)).join("") + `</div>`).join("");
    }
    el.innerHTML = notes + warn + bar + body;
  }

  function stamp(d) {
    const mins = Math.max(0, Math.round((Date.now() - (d.at || Date.now())) / 60000)), built = M.roads.filter(r => r.source === "chain"), guess = built.filter(r => r.inferred).length;
    $("roads-stamp").textContent = (d.error ? "The chain did not answer: " + d.error + " · " : "") + `${M.systems.size} systems · ${built.length} roads${guess ? ` (${guess} worked out)` : ""} · read ${mins ? mins + " min ago" : "just now"}` + (M.ef.count ? ` · EF-Map: ${M.ef.confirmed.toLocaleString("en-US")} systems charted, ${(M.ef.count - M.ef.confirmed).toLocaleString("en-US")} reported once` : M.ef.error ? ` · EF-Map names: ${M.ef.error}` : "");
  }

  function render(d) {
    lastData = d; draft = null;
    M = build(d);
    $("roads-gate").hidden = true; $("roads-app").hidden = false;
    stamp(d);
    $("roads-manage-btn").hidden = !M.canEdit; if (!M.canEdit) $("roads-p-manage").hidden = true;
    setView(view); drawMap(); drawDetail(); drawFuel(); fillRoute(); drawUnplaced(); drawPlans(); fillPlanner(); if (openPlan != null && M.plans[openPlan]) drawPlan(openPlan);
    const ed = $("roads-editor"); ed.hidden = !M.canEdit; $("roads-gate-form").hidden = !M.canEdit;
    if (M.canEdit) $("roads-json").value = JSON.stringify({ builders: M.list.builders, home: M.list.home || "", systems: M.list.systems || {}, gates: M.list.gates || [], plans: (M.list.plans || []).filter(p => !p.draft) }, null, 1);
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
  const listCopy = () => JSON.parse(JSON.stringify({ builders: M.list.builders, home: M.list.home || "", systems: M.list.systems || {}, gates: M.list.gates || [], plans: M.list.plans || [] }));

  root.addEventListener("click", e => {
    const g = e.target.closest("[data-sys]"); if (g) { selected = selected === g.dataset.sys ? null : g.dataset.sys; drawMap(); drawDetail(); if (sf) { const k = selected && M.ids.get(selected); sf.select(k ? k.id : null); } return; }
    const b = e.target.closest("button"); if (!b || !M) return;
    if (b.dataset.ugroup) { unplacedBy = b.dataset.ugroup === "node" ? "node" : "builder"; try { localStorage.setItem("roads:unplacedBy", unplacedBy); } catch (e) {} drawUnplaced(); return; }
    if (b.id === "plan-run") { runPlanner(); return; }
    if (b.dataset.plansave) { const l = listCopy(); l.plans = l.plans.filter(p => !p.draft); l.plans.push({ name: draft.name, note: draft.note, hops: draft.hops }); save(l, "Plan"); return; }
    if (b.dataset.plandrop) { draft = null; render(lastData); $("plan-status").textContent = "dropped."; return; }
    if (b.dataset.planremove) { const l = listCopy(); l.plans.splice(+b.dataset.planremove, 1); openPlan = null; save(l, "Plan"); return; }
    if (b.dataset.panel) {
      const want = $("roads-p-" + b.dataset.panel), open = want.hidden || (b.dataset.plan != null && b.dataset.plan !== "new" && openPlan !== +b.dataset.plan);
      if (b.dataset.plan === "new") { openPlan = null; $("roads-plan").innerHTML = ""; } else if (b.dataset.plan != null) drawPlan(+b.dataset.plan); else openPlan = null;
      root.querySelectorAll(".roads-panel").forEach(x => { x.hidden = true; }); root.querySelectorAll(".roads-tabs [data-panel]").forEach(x => x.classList.remove("on"));
      if (open) { want.hidden = false; b.classList.add("on"); }
      return;
    }
    if (b.id === "roads-refresh") { load(true); return; }
    if (b.dataset.view) { setView(b.dataset.view); return; }
    if (b.dataset.sf === "gates") { showGates = !showGates; try { localStorage.setItem("roads:gates", showGates ? "1" : "0"); } catch (e) {} if (sf) sf.showGates(showGates); b.classList.toggle("on", showGates); drawDetail(); return; }
    if (b.dataset.sf === "charted") { showCharted = !showCharted; try { localStorage.setItem("roads:charted", showCharted ? "1" : "0"); } catch (e) {} if (!showCharted) { picked = null; if (sf) sf.mark(null); } drawStars(); drawDetail(); return; }
    if (b.dataset.sf && sf) { if (b.dataset.sf === "fit") sf.fit(); else if (b.dataset.sf === "all") sf.fitAll(); else if (b.dataset.sf === "in") sf.zoom(1 / 1.35); else if (b.dataset.sf === "out") sf.zoom(1.35); else sf.view(b.dataset.sf === "top" ? 88 : 4); return; }
    if (b.id === "roads-paste-save") {
      // the game's formatted copy of a system is a link carrying the system's number (5 = solar system)
      const text = $("roads-paste").value, found = new Map();
      // the game (2026-10-10): <a href="showinfo:5//30000001">ABC|D11</a>; EVE's older form: <url=showinfo:5//30000001>ABC|D11</url>
      for (const m of text.matchAll(/showinfo:5\/\/(\d{8})["']?\s*>\s*([^<\]\r\n]+?)\s*<\/(?:url|a)>/gi)) found.set(up(m[2]), +m[1]);
      if (!found.size) { $("roads-paste-note").textContent = "No system link found. Copy it with formatting from the game."; return; }
      const l = listCopy(); for (const [name, id] of found) l.systems[name] = { id, sure: true };
      $("roads-paste-note").textContent = `${found.size} system${found.size === 1 ? "" : "s"}: ${[...found.keys()].join(", ")}`; $("roads-paste").value = "";
      save(l, "System IDs"); return;
    }
    if (b.id === "roads-gate-save") {                 // a public gate someone has jumped: two full system names
      const a = up($("roads-gate-a").value.trim()), c = up($("roads-gate-b").value.trim());
      if (!a || !c || a === c) { $("roads-gate-note").textContent = "give both systems, full names."; return; }
      const l = listCopy(); if (l.gates.some(g => (up(g.a) === a && up(g.b) === c) || (up(g.a) === c && up(g.b) === a))) { $("roads-gate-note").textContent = "already recorded."; return; }
      l.gates.push({ a, b: c }); $("roads-gate-a").value = ""; $("roads-gate-b").value = ""; $("roads-gate-note").textContent = ""; save(l, "Public gate"); return;
    }
    if (b.id === "roads-json-save") { let l; try { l = JSON.parse($("roads-json").value); } catch (err) { $("roads-save-note").textContent = "that is not valid JSON."; return; } save(l, "Settings"); }
  });
  root.addEventListener("keydown", e => { const g = e.target.closest && e.target.closest("[data-sys]"); if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selected = g.dataset.sys; drawMap(); drawDetail(); } });
  root.addEventListener("change", e => { if (e.target.id === "roads-from" || e.target.id === "roads-to") route(); });

  // the page loads its data the first time it is shown
  const seen = () => { if (root.hidden) return; if (!loaded) { loaded = true; load(false); } else if (M) { drawMap(); drawStars(); } };
  // the map is redrawn whenever its pane changes width (window resize, the side menu folding, a late layout)
  let rz = 0, lastW = 0; const redraw = () => { clearTimeout(rz); rz = setTimeout(() => { const w = $("roads-map").clientWidth; if (M && !root.hidden && Math.abs(w - lastW) > 1) { lastW = w; drawMap(); } }, 120); };
  if (window.ResizeObserver) new ResizeObserver(redraw).observe($("roads-map")); else window.addEventListener("resize", redraw);
  new MutationObserver(seen).observe(root, { attributes: true, attributeFilter: ["hidden"] }); seen();
  // On the local test server the clipboard watcher (tools/road_clipboard.py) adds system numbers behind the page's
  // back: look every few seconds and redraw when the numbers changed. Not on the live site: there the list only
  // changes through this page.
  let sysKey = null;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") setInterval(() => {
    if (root.hidden || document.hidden || !M || planning || draft) return;
    fetch("/api/network", { credentials: "same-origin" }).then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return; const k = JSON.stringify((d.list && d.list.systems) || {});
      if (sysKey !== null && k !== sysKey) { const before = M.ids.size; render(d); $("roads-save-note").textContent = `picked up from the game: ${Math.max(0, M.ids.size - before)} new system number${M.ids.size - before === 1 ? "" : "s"}.`; }
      sysKey = k;
    }).catch(() => {});
  }, 5000);
  window.__roadsRender = d => { loaded = true; render(d); };          // tests and local previews feed a fixture
  window.__roadsParse = readName; window.__roadsModel = () => M;
  window.__roadsPick = id => { selected = null; picked = id; drawDetail(); return $("roads-detail").hidden ? null : $("roads-detail").innerText; };   // tests: what a click on any star says
})();
