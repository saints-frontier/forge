/* The Pilgrim Roads' core: the road model from the chain (who throws where, read from the names written in game),
   the stars and public gates from the site's files, and the navigator. No page code: used by the Roads page (roads.js)
   and by the Saints Frontier Companion's local page, so both read the network the same way.
   (Cut out of roads.js on 2026-10-19; the rules of the name reader are described at the top of roads.js.) */
(function (G) {
  "use strict";
  const up = s => String(s == null ? "" : s).toUpperCase().trim();
  const CODE = /[A-Z0-9]{3}\|[A-Z0-9]{3}/g;
  const STOP = new Set(["THE", "CAT", "LVL", "FOR", "AND", "OUT", "OFF", "NEW", "OLD", "WAY", "VIA", "TOP", "END", "ONE", "TWO", "HUB", "NET", "ALL", "GAS", "ORE"]);
  const RANGE = { "Mini Catapult": 60, "Heavy Catapult": 250, "Mini Gate": 105, "Heavy Gate": 365 };   // light-years
  // every system a text mentions, in order: a full name always; a three-character short code when exactly one known
  // full name starts with it (known: first three characters -> full name, "" when two names share them)
  let fullNames = new Set();          /* every full system name that is not ABC|D11-shaped (ours + EF-Map's), set by build() */
  /* Look-alike spellings (2026-10-20: builders typed AB0|C11 for ABO|C11, or both spellings for one system): 0 and O,
     1 and I count as the same. A name with no number that looks like exactly one numbered system IS that system; two
     unnumbered spellings of one system become the one the builders wrote most. Set by build(). */
  const fold = s => s.replace(/0/g, "O").replace(/1/g, "I");
  let canonOf = new Map();
  function mentions(text, known) {
    const out = [], re = /[A-Z0-9][A-Z0-9|.\-]*[A-Z0-9]|[A-Z0-9]/g; let m;
    while ((m = re.exec(text))) {
      const t = m[0];
      if (/^[A-Z0-9]{3}\|[A-Z0-9]{3}$/.test(t) || fullNames.has(t)) out.push({ name: canonOf.get(t) || t, at: m.index, end: m.index + t.length });
      else if (t.length > 3 && /\d/.test(t) && /[|.\-]/.test(t)) out.push({ name: null, raw: t, at: m.index, end: m.index + t.length });   /* shaped like a system name nobody knows */
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
  function build(d, dist) {          /* dist: (idA, idB) -> light-years, or null before the stars are loaded */
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
    // one unit of fuel lasts burn_rate x efficiency / 100 (the chain's rule: EU-40 Fuel, efficiency 40, in a node of 50 minutes = 20 minutes a unit)
    const daysOf = n => n && n.fuel && n.fuel.burning && n.fuel.burnMs && n.fuel.eff ? n.fuel.quantity * n.fuel.burnMs * n.fuel.eff / 100 / 86400000 : null;
    // look-alike spellings first (see canonOf): every code the builders wrote, grouped by its folded form
    const written = new Map(); for (const x of (d.assemblies || []).concat(d.nodes || [])) for (const c of up(x.name).match(CODE) || []) written.set(c, (written.get(c) || 0) + 1);
    const numbered = new Map(); for (const n of new Set([...ids.keys(), ...efByName.keys()])) { const f = fold(n); numbered.set(f, numbered.has(f) && numbered.get(f) !== n ? "" : n); }
    const groups = new Map(); for (const c of written.keys()) { const f = fold(c); if (!groups.has(f)) groups.set(f, []); groups.get(f).push(c); }
    canonOf = new Map(); const aliases = [];
    for (const [f, cs] of groups) {
      const nb = numbered.get(f), to = nb || (cs.length > 1 ? cs.slice().sort((a, b) => written.get(b) - written.get(a) || a.localeCompare(b))[0] : null);
      if (to) for (const c of cs) if (c !== to && !ids.has(c) && !efByName.has(c)) { canonOf.set(c, to); aliases.push([c, to, !!nb]); }
    }
    // every full system name the chain or the numbered systems mention: what a short code may stand for
    const known = new Map(), learn = n => { const k = n.slice(0, 3); known.set(k, known.has(k) && known.get(k) !== n ? "" : n); };
    for (const n of ids.keys()) if (/^[A-Z0-9]{3}\|[A-Z0-9]{3}$/.test(n)) learn(n);
    fullNames = new Set([...ids.keys(), ...efByName.keys()].filter(n => !/^[A-Z0-9]{3}\|[A-Z0-9]{3}$/.test(n)));
    for (const x of (d.assemblies || []).concat(d.nodes || [])) for (const c0 of up(x.name).match(CODE) || []) { const c = canonOf.get(c0) || c0; learn(c); fromEf(c); }

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
    // placed by a jump: a Saint's companion saw them jump through this player gate (the chain's JumpEvent + the Local log)
    for (const a of d.assemblies || []) { const p = (list.placed || {})[a.id]; if (p && p.sys && a.node) place(a.node, up(p.sys), "jump", `${p.by || "a Saint"} jumped through it (${String(p.at || "").slice(0, 10)})`); }
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
    const plans = (list.plans || []).map((p, i) => ({ i, name: p.name || `Plan ${i + 1}`, note: p.note || "", diag: p.diag || null, diagTarget: p.diagTarget, direct: p.direct || null, from: p.from, to: p.to, hops: (p.hops || []).map((h, n) => ({ ...h, n, fromSys: planName(h.from, h.fromName), toSys: planName(h.to, h.toName) })) }));
    for (const p of plans) for (const h of p.hops) if (!h.gap) roads.push({ id: null, kind: h.kind, name: p.name, node: null, days: null, source: "plan", plan: p.i, n: h.n, from: h.fromSys, to: h.toSys, twoWay: /Gate/.test(h.kind || "") && h.kind !== "Public Gate", online: true, status: "planned" });
    // public (NPC) stargates a Saint has jumped, recorded by hand under Manage: drawn as roads (the whole network the
    // client lists is the faint grey layer, gates.bin). A jumped gate is a two-way road that nobody fuels for us.
    for (const g of list.gates || []) { const a = up(g.a || ""), b = up(g.b || ""); if (!a || !b || a === b) continue; fromEf(a); fromEf(b);
      // the state a Saint found it in: working = a solid road; no fuel on the far side = dashed (bring fuel); dormant = red and skipped by Find a road (one-way without materials)
      add({ id: null, kind: "Public Gate", name: g.note || "", node: null, days: null, source: "public", from: a, to: b, twoWay: true, online: g.state !== "dormant", status: g.state === "unfueled" ? "progress" : "built", state: g.state || "" }); }
    // roads a Saint has jumped (the Saints Frontier Companion): a chain road between the two systems gets the record (a
    // "worked out" road is then confirmed); a jump no launcher name explains is drawn as a road of its own, "seen"
    for (const x of list.seen || []) { const a = up(x.a), b = up(x.b); if (!a || !b || a === b) continue;
      const hit = roads.find(r => r.source === "chain" && ((r.from === a && r.to === b) || (r.twoWay && r.from === b && r.to === a)));
      if (hit) { hit.seen = x; if (hit.inferred) { hit.inferred = false; hit.confirmed = true; hit.why = ""; } continue; }
      fromEf(a); fromEf(b);
      add({ id: null, kind: x.kind === "gate" ? "Player Gate" : "Catapult", name: "", node: null, days: null, source: "seen", from: a, to: b, twoWay: x.kind === "gate", online: true, status: "built", seen: x, why: "jumped by a Saint; no launcher name says so yet" }); }
    const systems = new Map(), sys = n => { if (!systems.has(n)) systems.set(n, { name: n, nodes: [], days: null, guess: false }); return systems.get(n); };
    for (const r of roads) { sys(r.from); sys(r.to); }
    for (const n of d.nodes || []) { const i = info.get(n.id); if (i && i.sys) sys(i.sys).nodes.push(n); }
    for (const s of systems.values()) { for (const n of s.nodes) { const dd = daysOf(n); if (dd != null && (s.days == null || dd < s.days)) s.days = dd; } s.guess = s.nodes.length > 0 && s.nodes.every(n => ni(n.id).basis === "inferred"); }
    // a plan hop's status: built when the chain shows a road of ours between its two systems, in progress when the
    // launch site has a Network Node of ours, else planned; a status set by hand on the page wins
    const chainRoad = new Set(); for (const r of roads) if (r.source !== "plan" && r.source !== "public") { chainRoad.add(r.from + ">" + r.to); if (r.twoWay) chainRoad.add(r.to + ">" + r.from); }
    for (const p of plans) for (const h of p.hops) { if (h.gap || h.free || h.kind === "Public Gate" || h.kind === "Our Road") continue; const auto = chainRoad.has(h.fromSys + ">" + h.toSys) ? "built" : (systems.has(h.fromSys) && systems.get(h.fromSys).nodes.length ? "progress" : "planned"); h.auto = !h.status; if (!h.status) h.status = auto; }
    for (const r of roads) if (r.source === "plan") { const h = plans[r.plan].hops[r.n]; r.status = h.free || h.kind === "Public Gate" || h.kind === "Our Road" ? "built" : h.status === "built" ? "built" : h.status === "progress" ? "progress" : "planned"; }
    let home = up(list.home); if (!systems.has(home)) home = [...systems.keys()].sort()[0] || "";
    const nodeSys = id => (id && info.has(id) && info.get(id).sys) || null, nodeGuess = id => !!(id && info.has(id) && info.get(id).basis === "inferred");
    const ef = { byId: efById, byName: efByName, notes: efNotes, count: efById.size, confirmed: [...efById.values()].filter(e => e.status === "confirmed").length, error: (d.names && d.names.error) || null, used: [...ids.values()].filter(k => k.ef).length };
    return { list, roads, unplaced, systems, ids, plans, nodeById, nodeSys, nodeGuess, daysOf, home, ef, aliases, canEdit: !!d.canEdit, at: d.at, error: d.error, nodes: d.nodes || [] };
  }

  // ---------- the stars and the public gates, read from the site's own files ----------
  /* stars.bin: "STAR"-less header (u32 at 4 = count), then per star u32 id + 3 x f32 (x, y, z in light-years, the
     chain's frame) + 4 bytes; then u32 count + the Cycle 6 names (u8 length + bytes) in the same order */
  function parseStars(buf) {
    const dv = new DataView(buf), n = dv.getUint32(4, true), index = new Map(), X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n), ids = new Uint32Array(n);
    for (let i = 0, o = 8; i < n; i++, o += 20) { ids[i] = dv.getUint32(o, true); X[i] = dv.getFloat32(o + 4, true); Y[i] = dv.getFloat32(o + 8, true); Z[i] = dv.getFloat32(o + 12, true); index.set(ids[i], i); }
    let names = []; let o = 8 + n * 20;
    if (o + 4 <= dv.byteLength) { const c = dv.getUint32(o, true); o += 4; const dec = new TextDecoder(); names = new Array(c); for (let i = 0; i < c; i++) { const l = dv.getUint8(o); names[i] = dec.decode(new Uint8Array(buf, o + 1, l)); o += 1 + l; } }
    const pos = id => { const i = index.get(id); return i == null ? null : [X[i], Y[i], Z[i]]; };
    const oldName = id => { const i = index.get(id); return i == null ? null : names[i] || null; };
    const dist = (a, b) => { const p = pos(a), q = pos(b); return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : null; };
    return { count: n, index, pos, oldName, dist };
  }
  /* gates.bin: "GATE", u32 build, u32 count, then 9-byte pairs (u32 a, u32 b, u8 kind) -> a flat list [a, b, a, b, ...] */
  function parseGates(buf) {
    const dv = new DataView(buf), c = dv.getUint32(8, true), out = new Uint32Array(c * 2);
    for (let i = 0, o = 12; i < c; i++, o += 9) { out[i * 2] = dv.getUint32(o, true); out[i * 2 + 1] = dv.getUint32(o + 4, true); }
    return out;
  }

  // ---------- names: ours, then EF-Map's, then the archive's Cycle 6 name marked (C6) ----------
  function namer(M, stars) {
    const byId = new Map(); for (const [n, k] of M.ids) if (!byId.has(k.id) && !k.c6) byId.set(k.id, n);
    return id => byId.get(id) || (M.ef.byId.get(id) || {}).name || (stars && stars.oldName(id) ? stars.oldName(id) + " (C6)" : "#" + id);
  }
  // a system's number from any name we know (ours, EF-Map's)
  function idOfName(M, name) { const n = up(name); const k = M.ids.get(n); if (k) return k.id; const e = M.ef.byName.get(n); return e ? e.id : null; }

  // ---------- the navigator: the way over what exists today ----------
  /* What a pilot can fly now: our roads from the chain (online, not past their reach; a catapult throws one way, a gate
     pair goes both ways) and the public stargates of the client (both ways). A public gate a Saint recorded as
     "unfueled" (no fuel on the far side) or "dormant" (the far side needs restoring) is used only when it saves the
     trip, and the hop says so: either can be a one-way jump. Cost per jump: our road 1, a public gate 1.25 (50 crude),
     unfueled 3, dormant 6. Returns { hops: [{ from, to, kind, how: "ours" | "public", state, name, inferred }], crude }
     or { hops: null, closest: { id, ly, jumps } } when the target cannot be reached. */
  /* how long a gate's fuel lasts at the rate its readings show (hours), or null: the first and the last reading of the
     last eight, at least half an hour apart, with jumps used between them */
  function hoursLeft(f) {
    const h = (f && f.hist) || []; if (h.length < 2 || f.jumps == null) return null;
    const a = h[0], z = h[h.length - 1], hrs = (Date.parse(z[0]) - Date.parse(a[0])) / 3600000, used = a[1] - z[1];
    return hrs >= 0.5 && used > 0 ? f.jumps / (used / hrs) : null;
  }
  function navigate(o) {
    const M = o.model, adj = new Map(), push = (a, b, e) => { let l = adj.get(a); if (!l) adj.set(a, l = []); l.push(Object.assign({ to: b }, e)); };
    const idOf = n => idOfName(M, n);
    for (const r of M.roads) {
      if ((r.source !== "chain" && r.source !== "seen") || r.online === false || r.tooFar) continue;   /* "seen" = a road a Saint jumped */
      const a = idOf(r.from), b = idOf(r.to); if (!a || !b || a === b) continue;
      const e = { kind: r.kind, how: "ours", name: r.name || "", inferred: !!r.inferred, cost: 1 };
      push(a, b, e); if (r.twoWay) push(b, a, e);
    }
    const st = new Map(), fuel = new Map();
    for (const g of M.list.gates || []) { const a = idOf(g.a), b = idOf(g.b); if (!a || !b) continue; st.set(a + ">" + b, g.state || ""); st.set(b + ">" + a, g.state || "");
      for (const [side, f] of Object.entries(g.fuel || {})) { if (!f || f.jumps == null) continue; const s = idOf(side); if (s === a) fuel.set(a + ">" + b, f); else if (s === b) fuel.set(b + ">" + a, f); } }
    const G = o.gates || [];
    for (let i = 0; i + 1 < G.length; i += 2) for (const [x, y] of [[G[i], G[i + 1]], [G[i + 1], G[i]]]) {
      const s = st.get(x + ">" + y) || "", f = fuel.get(x + ">" + y) || null;
      /* the gate's own tank, read from its window: none left = it cannot send anyone (as bad as dormant) */
      push(x, y, { kind: "Public Gate", how: "public", state: s, fuel: f ? { jumps: f.jumps, cap: f.cap, at: f.at, left: hoursLeft(f) } : null, cost: s === "dormant" || (f && f.jumps < 1) ? 6 : s === "unfueled" ? 3 : 1.25 });
    }
    const from = o.from, to = o.to, best = new Map([[from, 0]]), prev = new Map(), jumps = new Map([[from, 0]]);
    const heap = [[0, from]], pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; for (let i = 0;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
    const add = (c, id) => { heap.push([c, id]); for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
    while (heap.length) {
      const [c, x] = pop(); if (c > best.get(x)) continue; if (x === to) break;
      for (const e of adj.get(x) || []) { const nc = c + e.cost; if (nc < (best.has(e.to) ? best.get(e.to) : Infinity)) { best.set(e.to, nc); prev.set(e.to, [x, e]); jumps.set(e.to, jumps.get(x) + 1); add(nc, e.to); } }
    }
    if (from === to) return { hops: [], crude: 0 };
    if (!prev.has(to)) {
      let closest = null; if (o.dist) for (const id of best.keys()) { const ly = o.dist(id, to); if (ly != null && (!closest || ly < closest.ly)) closest = { id, ly, jumps: jumps.get(id) }; }
      return { hops: null, closest, reached: best.size };
    }
    const hops = []; for (let x = to; x !== from;) { const [p, e] = prev.get(x); hops.unshift({ from: p, to: x, kind: e.kind, how: e.how, state: e.state || "", name: e.name || "", inferred: !!e.inferred, fuel: e.fuel || null, ly: o.dist ? o.dist(p, x) : null }); x = p; }
    return { hops, crude: hops.filter(h => h.how === "public").length * 50 };
  }
  /* Where a pilot stands on a route: the hop to fly next, from the system the game says they are in (cur) and the
     index they were at before (was). A system whose name we do not know yet (shown with its old Cycle 6 name) cannot
     be matched by name: arriving at an unknown name right after the hop into such a system counts as being there. */
  function routeStep(route, cur, was) {
    const n = route.length, u = up(cur);
    if (!n) return { i: 0, arrived: true };
    if (up(route[n - 1].toName) === u) return { i: n, arrived: true };
    for (let i = 0; i < n; i++) if (up(route[i].fromName) === u) return { i };
    if (was != null && was < n && / \(C6\)$|^#/.test(route[was].toName || "")) return { i: was + 1, arrived: was + 1 >= n, guessed: true };
    return { i: null, off: true };
  }

  G.RoadsCore = { up, RANGE, readName, mentions, build, parseStars, parseGates, namer, idOfName, navigate, routeStep, hoursLeft };
})(typeof window !== "undefined" ? window : self);
