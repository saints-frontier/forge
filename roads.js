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
  const FUEL_NAME = { "78515": "SOF-80 Fuel", "78516": "EU-40 Fuel", "88319": "D2 Fuel", "78437": "EU-90 Fuel", "84868": "SOF-40 Fuel", "88335": "D1 Fuel", "77818": "Unstable Fuel" };
  const fuelName = n => (n && n.fuel && FUEL_NAME[n.fuel.type]) || "fuel";
  // a node with no days: switched off, or burning a fuel whose rate the chain table does not give
  const noDays = (n, off) => n && n.fuel && n.fuel.burning && !n.fuel.eff ? "rate unknown" : off;
  // how long a full node of this fuel lasts (capacity / unit volume units)
  const fullDays = n => n && n.fuel && n.fuel.unit && n.fuel.max && n.fuel.burnMs && n.fuel.eff ? Math.floor(n.fuel.max / n.fuel.unit) * n.fuel.burnMs * n.fuel.eff / 100 / 86400000 : null;

  const { RANGE, readName } = window.RoadsCore;            /* the model and the name reader live in roadscore.js (shared with the companion) */
  let dist = null;                                            // (idA, idB) -> light-years, once the stars are loaded
  const build = d => window.RoadsCore.build(d, dist);

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
  /* Points of interest (user 2026-10-18: "place all the interesting spots on the map with POI filter"): pois.json from
     tools/export_pois.py, client and public-chain data only; poiOn = the ticked categories (localStorage roads:poi) */
  let POI = null, poiBy = new Map(), poiOn = null; try { const v = JSON.parse(localStorage.getItem("roads:poi") || "null"); if (Array.isArray(v)) poiOn = new Set(v); } catch (e) {}
  let poiBox = false; try { poiBox = localStorage.getItem("roads:poibox") === "1"; } catch (e) {}
  function openPoiBox(on) { poiBox = on; try { localStorage.setItem("roads:poibox", on ? "1" : "0"); } catch (e) {} const box = $("sf-poi"), b = $("roads-stars").querySelector('[data-sf="poi"]'); if (box) box.hidden = !on; if (b) b.classList.toggle("on", on); if (on) drawPoi(); }
  const poiSave = () => { try { localStorage.setItem("roads:poi", JSON.stringify([...poiOn])); } catch (e) {} };
  /* Where the pilot is (user 2026-10-18: the Saints Frontier Companion "tracks my location on the map and highlights it in
     the pilgrim roads"): /api/location gives the pilot's own last system (from the game's Local chat log) and the tribe
     mates who chose to share; asked every 30 s while the page is open and on screen */
  let LOC = null, locTimer = 0, locPolls = 0;
  function locOf(name) {
    const u = up(name); if (!u || !M) return null;
    const k = M.ids.get(u); if (k) return k.id;
    for (const [n, e] of M.ef.byName) if (up(n) === u) return e.id;
    return null;
  }
  const ago = at => { const m = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000)); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
  function locPoll() {
    clearTimeout(locTimer); locTimer = setTimeout(locPoll, 30000);
    if (root.hidden || document.hidden || !M) return;
    fetch("/api/location", { credentials: "same-origin", cache: "no-store" }).then(r => r.ok ? r.json() : null).then(d => {
      const before = JSON.stringify(LOC); LOC = d && d.ok ? d : null;
      if (JSON.stringify(LOC) !== before) { drawStars(); drawLoc(); } else drawLoc();
    }).catch(() => {});
    navPoll(); if (locPolls++ % 10 === 0) placesPoll();   /* the places change from this page or the companion: read every 5 min, not every 30 s (bug squash 2026-10-21) */
  }
  /* Where the pilot wants to go (user 2026-10-19): /api/nav holds one destination per pilot, set here ("Navigate here")
     or on the companion page; the route over what exists today is worked out here with roadscore.js's navigator
     (our roads + the public gates), the companion follows it jump by jump. */
  let NAV = null, gatePairs = null;
  /* My places (user 2026-10-19: "let me set a home system. let me set multiple systems as bookmarks"): /api/places, one
     home and up to 30 bookmarks per pilot, the same in the companion's navigator. Drawn on the star map and listed under
     "You are in" with one-click navigation. */
  let PLACES = { home: null, marks: [] };
  const hasPlaces = () => !!(PLACES.home || PLACES.marks.length);
  function placesPoll() {
    fetch("/api/places", { credentials: "same-origin", cache: "no-store" }).then(r => r.ok ? r.json() : null).then(d => {
      if (!d || !d.ok) return; const before = JSON.stringify(PLACES); PLACES = { home: d.home || null, marks: d.marks || [] };
      if (JSON.stringify(PLACES) !== before) { drawStars(); drawLoc(); drawDetail(); }
    }).catch(() => {});
  }
  function placesSet(body) {
    return fetch("/api/places", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(r => r.json()).then(d => { if (d && d.ok) { PLACES = { home: d.home || null, marks: d.marks || [] }; drawStars(); drawLoc(); drawDetail(); } else alertNav((d && d.error) || "could not save it"); })
      .catch(() => alertNav("the site did not answer"));
  }
  const placeOf = id => ({ to: id, name: String(nameOfId(id)).slice(0, 40) });
  const placeName = p => p.label ? `${esc(p.label)} <span class="roads-hint">(${esc(p.name)})</span>` : esc(p.name);
  function askLabel(cur, sys) { const v = window.prompt(`A name for ${sys} (leave empty for none):`, cur || ""); return v == null ? null : v.replace(/\s+/g, " ").trim().slice(0, 30); }
  function placeBtns(id) {
    if (!id) return "";
    const home = PLACES.home && PLACES.home.to === id, mark = PLACES.marks.some(m => m.to === id);
    return (home ? ` <span class="roads-place">\u2302 your home</span>` : ` <button type="button" class="roads-quiet" data-home="${id}" title="your home system: one click from anywhere">Set as home</button>`)
      + (mark ? ` <button type="button" class="roads-quiet" data-unmark="${id}" title="drop this bookmark">\u2605 Bookmarked \u00d7</button>` : ` <button type="button" class="roads-quiet" data-mark="${id}" title="keep this system in your bookmarks">\u2605 Bookmark</button>`);
  }
  function placesLine() {
    if (!hasPlaces()) return "";
    const go = (p, label) => `<button type="button" class="roads-quiet" data-placego="${p.to}" title="navigate there">${label}</button>`;
    const find = p => `<button type="button" class="roads-link" data-placelook="${p.to}" title="show it on the map">${placeName(p)}</button><button type="button" class="roads-x" data-placelabel="${p.to}" title="give it a name of your own" aria-label="rename">\u270E</button>`;
    const home = PLACES.home ? `<span class="roads-place">\u2302 Home: ${find(PLACES.home)} ${go(PLACES.home, "Go home")}</span>` : "";
    const marks = PLACES.marks.map(m => `<span class="roads-place">\u2605 ${find(m)} ${go(m, "Go")}<button type="button" class="roads-x" data-unmark="${m.to}" title="drop this bookmark" aria-label="drop this bookmark">\u00d7</button></span>`).join("");
    return `<div class="roads-places">${home}${marks}</div>`;
  }
  function navPoll() {
    fetch("/api/nav", { credentials: "same-origin", cache: "no-store" }).then(r => r.ok ? r.json() : null).then(d => {
      const before = JSON.stringify(NAV); NAV = d && d.ok ? d.nav : null;
      if (JSON.stringify(NAV) !== before) drawLoc();
    }).catch(() => {});
    if (!gatePairs) { gatePairs = []; fetch("gates.bin?v=3").then(r => r.ok ? r.arrayBuffer() : null).then(b => { if (b) { gatePairs = window.RoadsCore.parseGates(b); drawLoc(); if ($("roads-route") && $("roads-route").textContent) route(); } }).catch(() => {}); }
  }
  function navSet(id) {
    /* a system without a number goes by its name ("n:NAME"): the navigator finds it over our roads */
    const body = typeof id === "string" && id.startsWith("n:") ? { to: null, name: id.slice(2).slice(0, 40) } : id ? { to: id, name: String(nameOfId(id)).slice(0, 40) } : { to: null };
    return fetch("/api/nav", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(r => r.json()).then(d => { if (d && d.ok) { NAV = d.nav; drawLoc(); return true; } alertNav((d && d.error) || "could not set it"); return false; }).catch(() => { alertNav("the site did not answer"); return false; });   /* true only when the site took it (bug squash 2026-10-21) */
  }
  function alertNav(msg) { const el = $("roads-me"); if (el) { el.hidden = false; el.insertAdjacentHTML("beforeend", ` <span class="bad">Navigation: ${esc(msg)}</span>`); } }
  function navLine(fromId) {
    if (!NAV) return "";
    const stop = ` <button type="button" class="roads-quiet" data-navstop="1" title="forget the destination">Stop</button>`;
    const head = `<span class="navto">➜ Heading to <b>${esc(NAV.name || "#" + NAV.to)}</b></span>`;
    if (!fromId) return `<div class="roads-nav">${head} <span class="roads-hint">· the next jump shows once the companion knows where you are</span>${stop}</div>`;
    if (!gatePairs || !gatePairs.length) return `<div class="roads-nav">${head} <span class="roads-hint">· reading the gates…</span>${stop}</div>`;
    const target = NAV.to || window.RoadsCore.navKey(M, NAV.name);
    if (!target) return `<div class="roads-nav">${head} <span class="roads-hint">· ${esc(NAV.name || "")} is not a system on our roads or the star map</span>${stop}</div>`;
    const r = window.RoadsCore.navigate({ model: M, gates: gatePairs, from: fromId, to: target, dist });
    if (r.hops && !r.hops.length) return `<div class="roads-nav">${head} <span class="good">· you are there</span>${stop}</div>`;
    if (!r.hops) {
      const c = r.closest;
      return `<div class="roads-nav">${head} <span class="roads-hint">· no road from here over our roads and the public gates${c ? `; the closest you can get is <b>${esc(nameOfId(c.id))}</b>${c.ly != null ? `, ${c.ly.toFixed(0)} LY short` : c.edge ? ", where our roads to it begin (they lead out of its group, not in)" : ""} (${c.jumps} jump${c.jumps === 1 ? "" : "s"})` : ""}</span>${stop}</div>`;
    }
    const h = r.hops[0], how = h => h.how === "ours" ? `our ${h.kind}` : `public gate${h.state === "unfueled" ? ", no fuel on the far side" : h.state === "dormant" ? ", dormant on the far side" : ""}${h.fuel ? `, ${h.fuel.jumps} jumps of fuel` : ""}`;
    const chain = [nameOfId(r.hops[0].from)].concat(r.hops.map(x => nameOfId(x.to))).map(esc).join(" → ");
    return `<div class="roads-nav">${head} <span>· next: <b>${esc(nameOfId(h.to))}</b> by ${esc(how(h))}</span> <span class="roads-hint">· ${r.hops.length} jump${r.hops.length === 1 ? "" : "s"}${r.crude ? ` · ${r.crude} crude for the public gates` : ""}</span>${stop}<div class="roads-hint navchain">${chain}</div></div>`;
  }
  function drawLoc() {
    const el = $("roads-me"), b = $("roads-stars") && $("roads-stars").querySelector('[data-sf="me"]');
    const me = LOC && LOC.me, id = me && locOf(me.s), n = LOC ? LOC.mates.length : 0;
    if (b) { b.hidden = !id; }
    if (!el) return;
    if (!me) { el.hidden = !n && !NAV && !hasPlaces(); el.innerHTML = (n ? `<span class="roads-hint">${n} tribe mate${n === 1 ? "" : "s"} on the map (they share their place from the Saints Frontier Companion).</span>` : "") + navLine(null) + placesLine(); return; }
    el.hidden = false;
    el.innerHTML = `<i class="melive"></i>You are in <b>${esc(me.s)}</b> <span class="roads-hint">· ${ago(me.at)} · ${me.share ? "the tribe sees you" : "only you see this"}${n ? ` · ${n} tribe mate${n === 1 ? "" : "s"} shown` : ""}</span>` +
      (id ? ` <button type="button" class="roads-quiet" data-sf="me">Find me</button>` : ` <span class="roads-hint">· not on the star map yet: copy its link in game (Manage) to chart it</span>`) + navLine(id || window.RoadsCore.navKey(M, me.s)) + placesLine();
  }
  function poiLoad() {
    if (POI) return; POI = { categories: [] };
    fetch("/api/pois", { credentials: "same-origin" }).then(r => r.ok ? r.json() : null).then(d => { if (!d || !Array.isArray(d.categories)) return; POI = d; poiBy = new Map();
      for (const c of d.categories) for (const [id, x] of c.items) { let l = poiBy.get(id); if (!l) poiBy.set(id, l = []); l.push({ c, x }); }
      if (!poiOn) poiOn = new Set();   /* nothing ticked until the pilot ticks it (user 2026-10-18: "set poi setting to none by default") */
      const pb = $("roads-stars").querySelector('[data-sf="poi"]'); if (pb) { pb.hidden = false; pb.textContent = `POI · ${poiBy.size.toLocaleString("en-US")}`; }
      if (poiBox) openPoiBox(true);
      if (M) { drawStars(); drawPoi(); drawDetail(); } }).catch(() => {});
  }
  /* the lines a picked or selected system gets for its points of interest */
  function poiLines(id) {
    const l = poiBy.get(id); if (!l) return "";
    return `<div class="roads-poilines">` + l.map(({ c, x }) => { let more = "";
      if (c.key === "longhaul" && x) { const [o, ly] = x.split(":"); more = ` Its other end: <b>${esc(nameOfId(+o))}</b>, ${(+ly).toLocaleString("en-US")} LY.`; }
      if (c.key === "kills" && x) more = ` ${(+x).toLocaleString("en-US")} killmail${+x === 1 ? "" : "s"} here.`;
      return `<div><i class="poikey" style="--c:${esc(c.color)}"></i><b>${esc(c.label)}</b> · ${esc(c.note)}${more}</div>`; }).join("") + `</div>`;
  }
  function drawPoi() {
    const box = $("roads-poi"); if (!box || !POI) return;
    if (!POI.categories.length) { box.innerHTML = `<div class="roads-hint">The points of interest are still loading, or could not be read.</div>`; return; }
    const h = M && M.ids.get(M.home), on = POI.categories.filter(c => poiOn.has(c.key));
    const rows = POI.categories.map(c => `<label class="roads-poirow" title="${esc(c.note)}"><input type="checkbox" data-poi="${esc(c.key)}"${poiOn.has(c.key) ? " checked" : ""}><i class="poikey" style="--c:${esc(c.color)}"></i><span>${esc(c.label)}</span><span class="n">${c.items.length.toLocaleString("en-US")}</span></label>`).join("");
    let near = "";
    if (h && dist && on.length) { const seen = new Set(), L = [];
      for (const c of on) for (const [id] of c.items) { if (seen.has(id)) continue; seen.add(id); const d = dist(h.id, id); if (d != null) L.push({ id, d, c }); }
      L.sort((a, b) => a.d - b.d);
      near = `<h4>Nearest to ${esc(M.home)} · ${L.length.toLocaleString("en-US")} on the map</h4><div class="roads-poinear">` + L.slice(0, 8).map(x => `<button type="button" class="roads-quiet" data-poigo="${x.id}"><i class="poikey" style="--c:${esc(x.c.color)}"></i>${esc(nameOfId(x.id))} <span class="roads-hint">${esc(x.c.label)} · ${Math.round(x.d).toLocaleString("en-US")} LY</span></button>`).join("") + `</div>`; }
    box.innerHTML = `<div class="roads-poiacts"><b>POI · points of interest</b><button type="button" class="roads-quiet" data-poiall="1">All</button><button type="button" class="roads-quiet" data-poiall="0">None</button><button type="button" class="roads-quiet" data-poiclose="1" title="Close" aria-label="Close">×</button></div><div class="roads-poirows">${rows}</div>` + near +
      `<div class="roads-hint">Game client and public chain${POI.generated ? `, ${esc(POI.generated)}` : ""}. Hover a row for what it is; click a diamond for what is known. The rare belts' sites are unbuilt placeholders in the client: maybe not in game yet.</div>`;
  }
  let showGates = true; try { showGates = localStorage.getItem("roads:gates") !== "0"; } catch (e) {}       // the public stargate network (gates.bin)
  // a system's name as the page knows it: ours, then EF-Map's, then the archived Cycle 6 name marked (C6)
  const nameOfId = id => { if (typeof id === "string" && id.startsWith("n:")) return id.slice(2); for (const [n, k] of M.ids) if (k.id === id) return n; const e = M.ef.byId.get(id); if (e && e.status === "confirmed") return e.name; const old = sf && sf.oldName(id); return old ? old + " (C6)" : "#" + id; };
  // has a Saint jumped this gate? (list.gates, recorded under Manage) -> the record, with the state it was found in
  const gateRec = (a, b) => (M.list.gates || []).find(g => (up(g.a) === a && up(g.b) === b) || (up(g.a) === b && up(g.b) === a)) || null;
  const jumped = (a, b) => !!gateRec(a, b);
  const STATE_TEXT = { working: "working", unfueled: "no fuel on the far side", dormant: "dormant: the far side needs restoring" };
  const stateHtml = g => { if (!g) return ""; const t = STATE_TEXT[g.state] || "jumped, state not noted"; const cls = g.state === "dormant" ? "off" : g.state === "unfueled" ? "warn" : "ok"; return ` · <span class="${cls}">${esc(t)}</span>${g.seen ? ` <span class="roads-hint">(${esc(g.seen)}${g.by ? ", " + esc(g.by) : ""})</span>` : ""}`; };
  // the public gates of one system, from the game client; a jumped one is marked, the rest are of unknown state
  function gateList(id) {
    if (!sf || !sf.gateCount()) return "";
    const g = sf.gatesOf(id); if (!g.length) return `<div class="roads-hint">No public stargate here, says the game client.</div>`;
    const me = nameOfId(id), rows = g.map(o => ({ o, d: dist ? dist(id, o) : null })).sort((a, b) => (a.d || 0) - (b.d || 0));
    const eta = f => { const h = (f && f.hist) || []; if (h.length < 2 || f.jumps == null) return ""; const a = h[0], z = h[h.length - 1], hrs = (Date.parse(z[0]) - Date.parse(a[0])) / 3600000, used = a[1] - z[1];
      if (hrs < 0.5 || used <= 0) return ""; const left = f.jumps / (used / hrs); return ` · <span class="${left < 24 ? "warn" : "roads-hint"}">about ${left < 48 ? Math.round(left) + " h" : Math.round(left / 24) + " days"} left at the recent rate (${used} jumps in ${hrs < 48 ? Math.round(hrs) + " h" : Math.round(hrs / 24) + " days"})</span>`; };
    const fuelHtml = (rec, side) => { const f = rec && rec.fuel && rec.fuel[side]; return f && f.jumps != null ? ` · <span class="${f.jumps < 10 ? "warn" : "roads-hint"}">fuel here ${Number(f.jumps).toLocaleString("en-US")}/${Number(f.cap || 0).toLocaleString("en-US")} jumps (${esc(String(f.at || "").slice(0, 10))}${f.by ? ", " + esc(f.by) : ""})</span>${eta(f)}` : ""; };
    return `<h4>Public gates · ${g.length}</h4><ul>${rows.map(r => { const n = nameOfId(r.o), rec = gateRec(me, n); return `<li><b>${esc(n)}</b>${r.d != null ? ` · ${Math.round(r.d).toLocaleString("en-US")} LY` : ""}${rec ? stateHtml(rec) + fuelHtml(rec, me) : (r.d > 365 ? ' · <span class="roads-hint">longer than any gate jumped so far: check it on the game map</span>' : "")}</li>`; }).join("")}</ul><div class="roads-hint">From the game client. Working, unfueled or dormant: only a jump tells. The Saints Frontier Companion records it as you jump; or record it under Manage.</div>`;
  }
  function drawMap() {
    const box = $("roads-map");
    if (!M.systems.size) { box.innerHTML = `<div class="roads-empty">No road is on the map yet. ${M.list.builders.length ? "A launcher appears when its name in game carries its systems: see Not on the map." : "No builder is set."}</div>`; return; }
    const avail = box.clientWidth - 14, L = layout(M, avail), groups = new Map();
    for (const r of M.roads) { const k = JSON.stringify([r.from, r.to].sort()); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    let svg = "";
    for (const [k, rs] of groups) {
      const [a, b] = JSON.parse(k), pa = L.pos.get(a), pb = L.pos.get(b);
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

  // the system window (2026-10-23, user: "as much information about the system as possible when we double-click on it,
  // in a window that is easy to view and somewhere visible"): the detail, docked on the map's top-right corner in the
  // star view, with the system's number, old name, charting, distances, kills of the last day and an in-game link
  let detailMini = false;   /* the pilot folded the window: it stays folded for the next system too */
  function drawDetail() { drawDetail0(); decorate(); const d = $("roads-detail"); d.classList.toggle("mini", detailMini && !d.hidden); const mb = d.querySelector("[data-mindetail]"); if (mb && detailMini) { mb.textContent = "+"; mb.title = "Open the window"; } }
  const killCache = new Map();
  function decorate() {
    const el = $("roads-detail"); if (el.hidden) return;
    /* the window opens on the first click of a double-click and may land on the star: for a moment it lets clicks
       through, so the second click still reaches the map (tribe feedback 2026-10-23: "I can't double-click on a star") */
    el.classList.add("passthru"); clearTimeout(el._pt); el._pt = setTimeout(() => el.classList.remove("passthru"), 500);
    const k = selected ? M.ids.get(selected) : null, id = k ? k.id : picked; if (!id && !selected) return;
    const e = id ? M.ef.byId.get(id) : null, old = id && sf ? sf.oldName(id) : null, name = selected || (e && e.name) || old || "";
    const facts = [];
    if (id) facts.push(`system <b>${id}</b>`); if (old && old !== name) facts.push(`Cycle 6 name ${esc(old)}`);
    if (e) facts.push(e.status === "confirmed" ? "charted on EF-Map" : e.status === "conflict" ? "name disputed on EF-Map" : "reported once on EF-Map");
    const h = M.ids.get(M.home), meId = LOC && LOC.me ? locOf(LOC.me.s) : null;
    if (id && meId === id) facts.push('<span class="ok">you are here</span>');
    else if (id && meId && dist) { const d = dist(meId, id); if (d != null) facts.push(`${Math.round(d).toLocaleString("en-US")} LY from you`); }
    if (id && h && h.id !== id && dist) { const d = dist(h.id, id); if (d != null) facts.push(`${Math.round(d).toLocaleString("en-US")} LY from ${esc(M.home)}`); }
    el.insertAdjacentHTML("afterbegin", '<button type="button" class="roads-dclose" data-closedetail="1" title="Close" aria-label="Close">×</button><button type="button" class="roads-dclose roads-dmin" data-mindetail="1" title="Fold to the title bar" aria-label="Fold">–</button>');
    /* dock on the side away from the star, so the window never sits on it (tribe feedback 2026-10-23: on a narrower
       page the window covered the star even after a double-click centred it) */
    if (id && sf) { const box = $("roads-stars"), p = sf.project(sf.position(id)); el.classList.toggle("dock-left", !!(p && box && p[0] > box.clientWidth / 2 + 4)); }
    const dh = el.querySelector(".roads-dh"); if (!dh) return;
    dh.insertAdjacentHTML("afterend", `<div class="roads-dfacts">${facts.join(" · ")}${id ? ` <button type="button" class="roads-quiet" data-copylink="${id}" data-copyname="${esc(name || "system")}" title="A link to paste into a chat line in game">Copy in-game link</button>` : ""}</div>` + (id ? `<div class="roads-dkills" id="roads-dkills">kills here in the last day: reading the chain…</div>` : ""));
    if (id) loadKills(id);
  }
  async function loadKills(id) {
    const show = d => { const box = $("roads-dkills"); if (!box) return;
      if (!d || !d.ok) { box.textContent = "kills here: could not be read just now"; return; }
      const ks = d.kills || []; if (!ks.length) { box.innerHTML = `<span class="ok">no kills here in the last day</span>`; return; }
      const who = p => p ? esc(p.name || "?") + (p.tag ? ` [${esc(p.tag)}]` : "") : "?";
      box.innerHTML = `<h4>Kills here, last day · ${ks.length}</h4><ul>` + ks.slice(0, 6).map(x => `<li><span class="bad">${ago(x.at)}</span> · ${who(x.killer)} killed ${who(x.victim)}${x.loss && x.loss !== "?" ? ` (${esc(String(x.loss).toLowerCase())})` : ""}</li>`).join("") + (ks.length > 6 ? `<li>… ${ks.length - 6} more</li>` : "") + "</ul>"; };
    const c = killCache.get(id); if (c && Date.now() - c.t < 120000) { show(c.d); return; }
    try { const r = await fetch(`/api/intel?q=kills&sys=${id}&hours=24`, { credentials: "same-origin", cache: "no-store" }); const d = r.ok ? await r.json() : null; killCache.set(id, { t: Date.now(), d }); show(d); } catch (err) { show(null); }
  }
  function drawDetail0() {
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
      el.hidden = false; el.innerHTML = `<div class="roads-dh">${ok ? esc(e.name) : "Uncharted"} <button type="button" class="roads-quiet" data-checkfrom="${picked}" title="every catapult or gate jump from this star">Check jumps from here</button> <button type="button" class="roads-quiet" data-planto="${picked}" title="plan a road from the planner's From to this star">Plan a road here</button> <button type="button" class="roads-quiet" data-navto="${picked}" title="the companion tells you every jump on the way">Navigate here</button>${placeBtns(picked)}</div><div class="roads-hint">${what}${where}</div>${poiLines(picked)}${fieldLines(picked)}` + (showGates ? `<div class="roads-dcols"><div>${gateList(picked)}</div></div>` : ""); return; }
    if (!selected || !M.systems.has(selected)) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    const s = M.systems.get(selected), out = M.roads.filter(r => r.from === selected || (r.twoWay && r.to === selected)), inn = M.roads.filter(r => r.to === selected && !r.twoWay);
    const row = (r, other) => `<li><b>${esc(other)}</b> · ${esc(r.kind)}${r.twoWay ? " · both ways" : ""}${r.online === false ? ' · <span class="bad">offline</span>' : ""}${r.ly != null ? ` · ${r.ly.toFixed(0)} LY` : ""}${r.tooFar ? ` · <span class="bad">beyond its ${RANGE[r.kind]} LY reach: check the name</span>` : ""}${r.name ? ` · <i>${esc(r.name)}</i>` : ""}${r.inferred ? ` · <span class="roads-hint">worked out: ${esc(r.why)}</span>` : ""}${r.seen ? ` · <span class="roads-hint">${r.source === "seen" ? "seen only: " : r.confirmed ? "confirmed: " : ""}jumped on ${r.seen.days || 1} day${(r.seen.days || 1) === 1 ? "" : "s"}, last ${esc(String(r.seen.last || "").slice(0, 10))}${r.seen.by ? " by " + esc(r.seen.by) : ""}</span>` : ""}</li>`;
    const kSel = M.ids.get(selected);
    el.innerHTML = `<div class="roads-dh">${esc(selected)}${kSel ? ` <button type="button" class="roads-quiet" data-checkfrom="${kSel.id}" title="every catapult or gate jump from this system">Check jumps from here</button> <button type="button" class="roads-quiet" data-planto="${kSel.id}" title="plan a road from the planner's From to this system">Plan a road here</button> <button type="button" class="roads-quiet" data-navto="${kSel.id}" title="the companion tells you every jump on the way">Navigate here</button>${placeBtns(kSel.id)}` : selected && M.systems.has(selected) ? ` <button type="button" class="roads-quiet" data-navname="${esc(selected)}" title="the companion tells you every jump on the way, over our roads">Navigate here</button>` : ""}${kSel && kSel.ef ? ` <span class="roads-hint">· its place on the star map comes from EF-Map (${esc(kSel.ef)})</span>` : ""}</div>` +
      `${kSel ? poiLines(kSel.id) : ""}${fieldLines(kSel ? kSel.id : 0, selected)}<div class="roads-dcols"><div><h4>Roads out</h4><ul>${out.map(r => row(r, r.from === selected ? r.to : r.from)).join("") || "<li>None: a dead end.</li>"}</ul></div>` +
      `<div><h4>Roads in</h4><ul>${inn.map(r => row(r, r.from)).join("") || "<li>None.</li>"}</ul></div>` +
      `<div><h4>Our nodes here</h4><ul>${s.nodes.map(n => `<li><b>${esc(n.name || short(n.id))}</b>${M.nodeGuess(n.id) ? " · worked out" : ""} · ${n.fuel.quantity.toLocaleString("en-US")} ${esc(fuelName(n))}${M.daysOf(n) == null ? " · " + noDays(n, "not burning") : ` · <span class="${fuelClass(M.daysOf(n))}">${fmtDays(M.daysOf(n))}</span>${fullDays(n) ? ` <span class="roads-hint">(full: ${fmtDays(fullDays(n))})</span>` : ""}`}</li>`).join("") || "<li>None known.</li>"}</ul></div>` +
      (showGates && kSel ? `<div>${gateList(kSel.id)}</div>` : "") + `</div>`;
  }

  function drawFuel() {
    const all = M.nodes.map(n => ({ n, d: M.daysOf(n), s: M.nodeSys(n.id) })).sort((a, b) => (a.d == null) - (b.d == null) || a.d - b.d);
    const rows = all.filter(x => x.s), rest = all.filter(x => !x.s), restLow = rest.filter(x => x.d != null)[0];
    $("roads-fuel").innerHTML = (rows.length ? rows.map(x => `<div class="roads-frow"><span class="fs">${esc(x.s)}</span><span class="fn">${esc(x.n.name || "")}</span>` +
      `<span class="fd ${fuelClass(x.d)}">${x.d == null ? noDays(x.n, "idle") : fmtDays(x.d)}</span><span class="fu">${x.n.fuel.quantity.toLocaleString("en-US")} ${esc(fuelName(x.n).replace(/ Fuel$/, ""))}</span></div>`).join("") : `<div class="roads-hint">No node on the map yet.</div>`) +
      (rest.length ? `<div class="roads-hint">${rest.length} more node${rest.length === 1 ? "" : "s"} not on the map yet${restLow ? `, the shortest at <span class="${fuelClass(restLow.d)}">${fmtDays(restLow.d)}</span>` : ""}.</div>` : "");
    const low = all.filter(x => x.d != null && x.d < 3);
    $("roads-fuel-n").textContent = low.length ? ` · ${low.length} low` : "";
    const al = $("roads-alert"); al.hidden = true;   /* the Fuel button says how many are low (user 2026-10-23: the page was too busy) */
    if (low.length) al.innerHTML = `⚠ Fuel runs out within three days: ` + low.map(x => `<b>${esc(x.s || "a node not on the map")}</b> ${fmtDays(x.d)}`).join(" · ");
  }

  function fillRoute() {
    const names = [...M.systems.keys()].sort(), a = $("roads-from"), b = $("roads-to"), va = a.value, vb = b.value;
    const opts = names.map(n => `<option>${esc(n)}</option>`).join("");
    a.innerHTML = opts; b.innerHTML = opts;
    const here = LOC && LOC.me && window.RoadsCore.up(LOC.me.s);   /* where the companion says you are */
    a.value = names.includes(va) ? va : here && names.includes(here) ? here : (M.home || names[0] || ""); b.value = names.includes(vb) ? vb : (names.find(n => n !== a.value) || "");
    route();
  }
  function route() {
    const from = $("roads-from").value, to = $("roads-to").value, out = $("roads-route");
    if (!from || !to) { out.textContent = ""; return; }
    if (from === to) { out.innerHTML = `<span class="roads-hint">You are there.</span>`; return; }
    /* the companion's navigator (2026-10-20): our roads, the public gates, and systems that have no number yet */
    const C = window.RoadsCore, a = C.navKey(M, from), b = C.navKey(M, to);
    const go = b ? ` <button type="button" class="roads-quiet" data-navgo="${esc(to)}" title="the companion tells you every jump on the way, with a card over the game">Navigate with the companion</button>` : "";
    if (!gatePairs || !gatePairs.length) { navPoll(); out.innerHTML = `<span class="roads-hint">reading the public gates…</span>`; return; }
    const r = C.navigate({ model: M, gates: gatePairs, from: a, to: b, dist });
    if (!r.hops) {
      const c = r.closest;
      out.innerHTML = `<span class="bad">No road from ${esc(from)} to ${esc(to)}</span> over our roads and the public gates.` + (c ? ` The closest you can get is <b>${esc(nameOfId(c.id))}</b>${c.ly != null ? `, ${c.ly.toFixed(0)} LY short` : c.edge ? ", where our roads to it begin (they lead out of its group, not in)" : ""}, ${c.jumps} jump${c.jumps === 1 ? "" : "s"}.` : "") + go;
      return;
    }
    const how = h => h.how === "ours" ? h.kind : "public gate" + (h.state === "unfueled" ? ", no fuel on the far side" : h.state === "dormant" ? ", dormant" : "");
    out.innerHTML = `<div class="roads-hops"><b>${esc(from)}</b>` + r.hops.map(h => ` <span class="hop">→ <i>${esc(how(h))}</i> →</span> <b>${esc(nameOfId(h.to))}</b>`).join("") + `</div><div class="roads-hint">${r.hops.length} jump${r.hops.length === 1 ? "" : "s"}${r.crude ? ` · ${r.crude} crude for the public gates` : ""}.${go}</div>`;
  }

  // the tool column sits centred beside the map while no panel is open, and level with the map's top while one is
  // (user 2026-10-23: "let's center them with the map")
  new MutationObserver(() => { const app = $("roads-app"); if (app) app.classList.toggle("panel-open", !!root.querySelector(".roads-panel:not([hidden])")); })
    .observe(root, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
  // ---------- the star map ----------
  let sf = null, sfLoading = null, view = "stars";
  function starsReady() {
    const box = $("roads-stars"); if (!box) return Promise.resolve(null);
    if (sf) return Promise.resolve(sf);
    if (!window.Starfield) return Promise.resolve(null);
    if (!sfLoading) {
      sf = window.Starfield(box, { onPick: id => { if (checkClick(id) || planClick(id)) return; const name = [...M.ids].find(([, v]) => v.id === id); selected = name ? name[0] : null; picked = !name && (M.ef.byId.has(id) || poiBy.has(id)) ? id : null; if (sf) sf.mark(null); drawDetail(); },
        onPickStar: id => { if (checkClick(id) || planClick(id)) return; if (selected) return; picked = id || null; if (sf) sf.mark(id, "uncharted"); drawDetail(); }, onHover: () => {},
        onPlainWheel: () => { const h = box.querySelector(".sf-hint"); if (!h) return; h.classList.add("flash"); clearTimeout(h._t); h._t = setTimeout(() => h.classList.remove("flash"), 1800); } });   // a plain wheel scrolls the page: light up how to zoom
      if (!sf) return Promise.resolve(null);
      window.__roadsStars = sf;
      setTimeout(findBox, 0);
      setTimeout(() => { const ul = box.querySelector(".sf-legend ul"); if (ul) ul.insertAdjacentHTML("beforeend", '<li><button type="button" class="sf-l-more" data-panel="legend">More about the lines and names ›</button></li>'); }, 0);                                     /* the find box is in the toolbar HTML below */                                      // tests
      box.insertAdjacentHTML("beforeend", '<div class="sf-hint"></div><div class="sf-missing" id="sf-missing"></div>' +
        '<div class="sf-find"><input type="search" id="sf-find" placeholder="Find a system: name or number" aria-label="Find a system by name or system number" autocomplete="off" spellcheck="false"></div><div class="sf-poi" id="sf-poi" hidden><div id="roads-poi"></div></div><div class="sf-layers" id="sf-layers" hidden><b>Show on the map</b><button type="button" data-sf="gates" title="The public stargate network, read from the game client. Whether a gate works or lies dormant it does not say." hidden>Public gates</button><button type="button" data-sf="charted" title="Systems players have named on EF-Map\'s community map" hidden>Charted</button><button type="button" data-sf="poi" title="Rare stars, old capitals, long-haul gates and kill hotspots: tick what the map shows" hidden>POI</button><button type="button" data-sf="survey" title="Systems Saints have surveyed with the companion: infestation 1 (green) to 6 (red)" hidden>Survey</button><b>View</b><button type="button" data-sf="flat">Edge-on</button><button type="button" data-sf="top">Top-down</button><button type="button" data-sf="all" title="The whole galaxy">Whole galaxy</button></div><div class="sf-tools"><button type="button" data-sf="me" title="Fly to where you are (from the Saints Frontier Companion)" hidden>You</button><button type="button" data-sf="fit" title="Back to our roads">Our roads</button><button type="button" data-sf="out" title="Zoom out" aria-label="Zoom out">−</button><button type="button" data-sf="in" title="Zoom in" aria-label="Zoom in">+</button><button type="button" data-sf="layers" title="What the map shows, and the view">Layers ▾</button></div>');
      sfLoading = sf.load("stars.bin?v=2").then(() => { dist = (a, b) => { const p = sf.position(a), q = sf.position(b); return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : null; }; if (lastData && !draft) { M = build(lastData); drawMap(); drawDetail(); drawFuel(); fillRoute(); drawUnplaced(); stamp(lastData); }
        // the public gates come after the stars, never in their way: the button appears once they are in
        sf.showGates(showGates); poiLoad(); locPoll();
        sf.loadGates("gates.bin?v=3").then(n => { const b = box.querySelector('[data-sf="gates"]'); if (b) { b.hidden = false; b.textContent = `Public gates · ${n.toLocaleString("en-US")}`; b.classList.toggle("on", showGates); } if (M) drawDetail(); }).catch(() => {});
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
        systems.push({ id: k.id, name, cls, subWarn: sys.days != null && sys.days < 3, sub: sys.days == null ? (sys.nodes.length ? "node idle" : "") : "fuel " + fmtDays(sys.days), subColor: sys.days == null ? "#8a8378" : sys.days < 3 ? "#e3222c" : sys.days < 14 ? "#e0a84a" : "#7ec98b" });
      }
      // a system with a number but no road yet (a landmark, a destination to come) is still pinned on the star map
      for (const [name, k] of M.ids) if (!M.systems.has(name) && s.has(k.id)) systems.push({ id: k.id, name, cls: k.sure ? "far" : "inferred", sub: "" });
      for (const x of systems) { const k = M.ids.get(x.name); if (k && k.c6 && x.cls === "far") x.cls = "plan"; }
      // the systems charted on EF-Map's community map that our roads do not touch: small rings, named up close
      // Charted = two or more players agree on the name. A system with one report (or a disputed name) is still
      // uncharted (user 2026-10-12): a faint dashed mark, named "uncharted" under the pointer.
      const placed = new Set(systems.map(x => x.id)); let chartedN = 0, waitingN = 0;
      for (const [id, e] of M.ef.byId) { if (!s.has(id) || placed.has(id)) continue; const ok = e.status === "confirmed"; if (ok) chartedN++; else waitingN++;
        if (showCharted && !chartOn) systems.push(ok ? { id, name: e.name, cls: "charted", sub: "" } : { id, name: "uncharted", cls: "uncharted", sub: "" }); }
      if (LOC) { const mk = (r, cls, label) => { const id = locOf(r.s); if (!id || !s.has(id)) return; const i = systems.findIndex(x => x.id === id); const o = { id, name: label, cls, subWarn: true, sub: r.s + " · " + ago(r.at), subColor: cls === "me" ? "#5fe3ff" : "#8fe0b0" }; if (i >= 0) systems.splice(i, 1, o); else systems.push(o); placed.add(id); };
        for (const m of LOC.mates) mk(m, "mate", m.n || m.c || "a Saint"); if (LOC.me) mk(LOC.me, "me", "\u25B2 You"); }
      for (const [pl, isHome] of (PLACES.home ? [[PLACES.home, true]] : []).concat(PLACES.marks.map(m => [m, false]))) {
        const id = pl.to; if (!s.has(id)) continue; const note = (isHome ? "your home" : "bookmark") + (pl.label ? ": " + pl.label : ""), i = systems.findIndex(x => x.id === id);
        if (i >= 0) { systems[i].sub = (systems[i].sub ? systems[i].sub + " · " : "") + note; continue; }
        placed.add(id); systems.push({ id, name: (isHome ? "Home: " : "\u2605 ") + (pl.label || pl.name), cls: "far", color: isHome ? "#ffd27a" : "#c9ced8", sub: pl.label ? pl.name + " \u00b7 " + note : note });
      }
      if (surveyOn) for (const [nm, r] of Object.entries(FIELD.survey || {})) { const id = window.RoadsCore.idOfName(M, nm); if (!id || !s.has(id) || !r.infest) continue;
        const i = systems.findIndex(x => x.id === id); if (i >= 0) { systems[i].sub = (systems[i].sub ? systems[i].sub + " · " : "") + "inf " + r.infest; continue; }
        placed.add(id); systems.push({ id, name: `${nm} · inf ${r.infest}`, cls: "poi", color: INF_COL[r.infest], sub: r.transient ? r.transient.toLowerCase() : "" }); }
      if (POI && poiOn) for (const c of POI.categories) { if (!poiOn.has(c.key)) continue;
        for (const [id] of c.items) { if (!s.has(id) || placed.has(id)) continue; placed.add(id); systems.push({ id, name: `${c.label} · ${nameOfId(id).replace(/ \(C6\)$/, "")}`, cls: "poi", color: c.color, sub: "" }); } }
      const cb = $("roads-stars").querySelector('[data-sf="charted"]'); if (cb) { cb.hidden = !(chartedN + waitingN); cb.textContent = `Charted · ${chartedN.toLocaleString("en-US")}`; cb.classList.toggle("on", showCharted); }
      const roads = [];
      for (const r of M.roads) { const a = M.ids.get(r.from), b = M.ids.get(r.to); if (a && b) roads.push({ a: a.id, b: b.id, kind: r.kind, twoWay: r.twoWay, online: r.online, source: r.inferred ? "inferred" : r.source, status: r.status || "built", state: r.state || "" }); }
      s.setScene({ systems, roads }); if (!drawStars.fitted) { if (location.search.indexOf("sf=all") >= 0) s.fitAll(); else s.fit(); drawStars.fitted = true; }
      const sel = selected && M.ids.get(selected); s.select(sel ? sel.id : null);
      const al = (M.aliases || []).filter(x => x[2]).map(x => `${esc(x[0])} = ${esc(x[1])}`);
      const mi = $("sf-missing"), wasOpen = mi.classList.contains("open");
      mi.innerHTML = missing.length || al.length ? `<button type="button" class="sf-chip" data-sfmissing="1">${missing.length ? `${missing.length} not on the star map` : "names read as one"}</button><div class="sf-chipbox">`
        + (missing.length ? `<b>No number yet:</b> ${missing.map(esc).join(", ")}. To put one on the star map, copy its link in game (drag the system into a chat line, select it, right-click › Copy selected with formatting) with the companion's "Save system links" switch on${M.canEdit ? ", or paste it under Manage" : ""}.` : "")
        + (al.length ? `${missing.length ? "<br>" : ""}<span class="roads-hint">read as the same system: ${al.join(", ")}</span>` : "") + "</div>" : "";
      mi.classList.toggle("open", wasOpen && !!(missing.length || al.length));
    });
  }
  function setView(v) {
    view = v; $("roads-stars").hidden = v !== "stars"; $("roads-map").hidden = v !== "flat";
    const mainEl = root.querySelector(".roads-main"); if (mainEl) mainEl.classList.toggle("stars-view", v === "stars");
    root.querySelectorAll(".roads-view button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
    try { localStorage.setItem("roads:view", v); } catch (e) {}
    if (M) { if (v === "stars") drawStars(); else drawMap(); }
  }
  try { view = localStorage.getItem("roads:view") === "flat" ? "flat" : "stars"; } catch (e) {}

  // ---------- road plans: one button each, a hop table with a build sheet, the plan drawn on the star map ----------
  // per launcher: Kerogen Tar, Building Foam, Still Kernel, print minutes (data/recipes.json, Build Mode); a gate hop = two gates
  const COST = { "Mini Catapult": [102, 22, 4, 15], "Heavy Catapult": [650, 141, 26, 48], "Mini Gate": [420, 92, 16, 96], "Heavy Gate": [2120, 462, 86, 720] };
  const NODE = { parts: [8, 8, 8], minutes: 0.5, fuelDay: 72 };        // Printed Circuits, Carbon Weave, Thermal Composites; 1 unit of 40-grade fuel per 20 min = 72 a day (chain fuel rule)
  const VOL = { tar: 0.3, foam: 47, kernel: 5, pc: 4, cw: 15, tc: 10 };   // m3 per unit (client type volumes)
  const CRIT = { launchers: "fewest launchers to build", hops: "fewest hops", foam: "least Building Foam", nonpublic: "prefer public stargates", noncatapult: "prefer catapults", ly: "shortest distance" };
  const PRIO_DEFAULT = [["launchers", 1], ["hops", 1], ["foam", 1], ["ly", 1], ["nonpublic", 0], ["noncatapult", 0]];
  let planPrio = PRIO_DEFAULT.map(x => x.slice()); try { const s = JSON.parse(localStorage.getItem("roads:prio") || "null"); if (Array.isArray(s) && s.length === 6 && s.every(x => CRIT[x[0]])) planPrio = s; } catch (e) {}
  let planStops = [], planAvoid = [];
  const isBuild = h => !h.gap && !h.free && COST[h.kind];               // a hop that costs a launcher
  const isCharted = id => [...M.ids.values()].some(k => k.id === id && !k.c6) || M.ef.byId.has(id);
  const starName = id => { const n = nameOfId(id); return isCharted(id) ? n : n.replace(/ \(C6\)$/, "") + " (uncharted)"; };
  // what a plan costs: launchers, nodes, materials, print time, hauling, fuel, public gate jumps
  function planBill(hops) {
    const b = { launchers: 0, tar: 0, foam: 0, kernel: 0, minutes: 0, pub: 0, gaps: 0, kinds: {}, sites: new Map() };
    for (const h of hops) {
      if (h.gap) { b.gaps++; continue; }
      if (h.kind === "Public Gate") b.pub++;
      if (!isBuild(h)) continue;
      const c = COST[h.kind], n = /Gate/.test(h.kind) ? 2 : 1; b.launchers += n; b.tar += c[0]; b.foam += c[1]; b.kernel += c[2]; b.minutes += c[3]; b.kinds[h.kind] = (b.kinds[h.kind] || 0) + 1;
      b.sites.set(h.fromSys, true); if (/Gate/.test(h.kind)) b.sites.set(h.toSys, true);
    }
    b.newNodes = [...b.sites.keys()].filter(s => !((M.systems.get(s) || {}).nodes || []).length); b.oldNodes = b.sites.size - b.newNodes.length;
    const nn = b.newNodes.length; b.pc = NODE.parts[0] * nn; b.cw = NODE.parts[1] * nn; b.tc = NODE.parts[2] * nn; b.minutes += NODE.minutes * nn;
    b.m3 = b.tar * VOL.tar + b.foam * VOL.foam + b.kernel * VOL.kernel + b.pc * VOL.pc + b.cw * VOL.cw + b.tc * VOL.tc; b.cargo = Math.ceil(b.m3 / 36);
    b.fuelDay = nn * NODE.fuelDay;
    return b;
  }
  // the words for a leg that did not reach its target
  function diagText(d, target) {
    if (!d) return "";
    const from = esc(nameOfId(d.end)), to = esc(nameOfId(target)), ly = f0(d.ly);
    if (d.reason === "range") return `<b>${from}</b> is the closest the road gets: <b>${to}</b> is ${ly} LY away, beyond everything ticked (${esc(d.beyond)} LY). Only a public stargate crosses that, or a road from another side.`;
    if (d.reason === "blocked") return `<b>${from} → ${to}</b> is ${ly} LY, in range, but the shot is blocked by ${(Array.isArray(d.blockers) ? d.blockers : []).map(x => `<b>${esc(starName(x.id))}</b> (${f0(x.ly)} LY out)`).join(", ")}. Build through the blocking star instead, or chart it: an uncharted blocker is one nobody has seen yet.`;
    if (d.reason === "gatefar") return `A gate pair could span <b>${from} → ${to}</b> (${ly} LY), but nobody can reach ${to} to build the far gate: a catapult or a public gate has to get a builder there first.`;
    if (d.reason === "avoided") return `The only way from <b>${from}</b> to <b>${to}</b> runs through a system on the avoid list.`;
    return `<b>${from} → ${to}</b>: ${ly} LY, no tool crosses it.`;
  }
  function directText(d, from, to) {
    if (!d) return "";
    if (!d.tool) return `Straight line ${esc(nameOfId(from))} → ${esc(nameOfId(to))}: ${f0(d.ly)} LY, no single hop reaches that.`;
    if (Array.isArray(d.blockers) && d.blockers.length) return `A direct ${esc(d.tool)} shot (${f0(d.ly)} LY) is blocked by ${d.blockers.map(x => `<b>${esc(starName(x.id))}</b>`).join(", ")}.`;
    return "";
  }
  const hopKindText = h => h.gap ? "STARGATE NEEDED" : h.step === "gate" ? `BUILD ${esc(h.kind).toUpperCase()} PAIR` : h.kind === "Public Gate" ? "public gate · " + (STATE_TEXT[h.state || (gateRec(h.fromSys, h.toSys) || {}).state] || (gateRec(h.fromSys, h.toSys) ? "jumped before" : "state unknown")) : h.kind === "Our Road" ? "our road · built" : h.free ? esc(h.kind) + " · built above" : "build " + esc(h.kind);
  const STATUS_TEXT = { planned: "planned", progress: "in progress", built: "built" };
  function drawPlans() {
    $("roads-plan-btns").innerHTML = M.plans.map(p => `<button type="button" data-panel="plan" data-plan="${p.i}"${(M.list.plans[p.i] || {}).mine ? ' title="one of my routes, kept in this browser"' : ""}>${(M.list.plans[p.i] || {}).mine ? "★ " : ""}${esc(p.name)}${(M.list.plans[p.i] || {}).draft ? " (unsaved)" : ""}</button>`).join("");
  }
  let openPlan = null;
  function drawPlan(i) {
    const p = M.plans.find(x => x.i === i); if (!p) return; openPlan = i;
    const raw = M.list.plans[i] || {}, isDraft = !!raw.draft, mode = raw.mode || "access";
    const fwd = p.hops.filter(h => h.leg !== "back"), back = p.hops.filter(h => h.leg === "back");
    const ly = fwd.reduce((a, h) => a + (h.ly || 0), 0), bill = planBill(fwd), bb = back.length ? planBill(back) : null;
    const row = (h, k) => `<div class="roads-prow${h.step === "gate" ? " step" : ""}"><span>${k + 1}</span><span><b>${esc(h.fromSys)}</b></span><span><b>${esc(h.toSys)}</b></span><span class="${h.gap ? "gap" : h.kind === "Public Gate" ? "pub" : h.free || h.kind === "Our Road" ? "have" : "k"}">${hopKindText(h)}</span><span class="ly">${(h.ly || 0).toFixed(1)}</span>` +
      (isDraft ? "" : `<span class="st ${h.status || "planned"}" ${isBuild(h) && M.canEdit && !raw.mine ? `data-hopstatus="${i}:${h.n}"` : ""} title="${h.auto ? "read from the chain" : "set by hand"}">${isBuild(h) ? STATUS_TEXT[h.status || "planned"] + (h.auto ? " ·" : "") : ""}</span>` +
      `<span class="who">${isBuild(h) ? (M.canEdit && !raw.mine ? `<input type="text" maxlength="24" placeholder="who builds" value="${esc(h.who || "")}" data-hopwho="${i}:${h.n}"><input type="date" value="${esc(h.by || "")}" data-hopby="${i}:${h.n}">` : esc([h.who, h.by].filter(Boolean).join(" · "))) : ""}</span>`) + `</div>`;
    const head = `<div class="roads-phead"><span>#</span><span>From</span><span>To</span><span>Build</span><span class="ly">LY</span>${isDraft ? "" : "<span>Status</span><span>Builder · by</span>"}</div>`;
    const kinds = Object.entries(bill.kinds).map(([k, n]) => `${n}× ${esc(k)}`).join(", ");
    const sheet = `<div class="ptot"><span><b>${bill.launchers}</b> launcher${bill.launchers === 1 ? "" : "s"} to build${kinds ? ` (${kinds})` : ""}</span><span><b>${bill.newNodes.length}</b> new Network Node${bill.newNodes.length === 1 ? "" : "s"}${bill.oldNodes ? ` (${bill.oldNodes} site${bill.oldNodes === 1 ? "" : "s"} already ha${bill.oldNodes === 1 ? "s" : "ve"} one of ours)` : ""}</span>` +
      (bill.pub ? `<span><b>${bill.pub}</b> public gate jump${bill.pub > 1 ? "s" : ""} · ${f0(bill.pub * 50)} EU-40 or SOF-40 Fuel</span>` : "") + (bill.gaps ? `<span class="gap" style="color:var(--red)"><b>${bill.gaps}</b> crossing${bill.gaps > 1 ? "s" : ""} no tool makes</span>` : "") +
      (bill.launchers ? `<span>Kerogen Tar <b>${f0(bill.tar)}</b> · Building Foam <b>${f0(bill.foam)}</b> · Still Kernel <b>${f0(bill.kernel)}</b></span>` + (bill.newNodes.length ? `<span>nodes: Printed Circuits <b>${bill.pc}</b> · Carbon Weave <b>${bill.cw}</b> · Thermal Composites <b>${bill.tc}</b></span>` : "") +
      `<span>printing <b>${bill.minutes >= 90 ? (bill.minutes / 60).toFixed(1) + " h" : f0(bill.minutes) + " min"}</b> · hauling <b>${f0(bill.m3)} m³</b> (${bill.cargo} Cargo Container${bill.cargo === 1 ? "" : "s"})</span>` + (bill.fuelDay ? `<span>the new nodes burn <b>${f0(bill.fuelDay)}</b> EU-40 or SOF-40 Fuel a day together</span>` : "") : "") + `</div>`;
    const diag = p.diag ? `<div class="roads-diag">${diagText(p.diag, p.diagTarget)}</div>` : "", dir = p.direct ? directText(p.direct, p.from, p.to) : "";
    const corridor = mode === "corridor" ? `<div class="roads-hint">A corridor: the gate pairs make a permanent two-way road; the catapult hops above each pair get a builder to the next site. Build in the order listed.</div>` : mode === "tree" ? `<div class="roads-hint">A network: each stop was reached from the nearest point of what the plan had built before it.</div>` : "";
    const backHtml = back.length ? `<div class="ph" style="margin-top:12px">The way home<small>${back.length} hops · ${f0(back.reduce((a, h) => a + (h.ly || 0), 0))} LY · ${bb.launchers} more launcher${bb.launchers === 1 ? "" : "s"}</small></div>` + head + back.map(row).join("") : "";
    const acts = `<div class="pacts">${isDraft ? `<button type="button" class="primary" data-mysave="1">Save to my routes</button>${M.canEdit ? `<button type="button" data-plansave="1">Keep for the tribe</button>` : ""}<button type="button" data-plandrop="1">Drop it</button>`
      : raw.mine ? `<button type="button" data-myremove="${esc(raw.id)}">Remove from my routes</button>` : M.canEdit ? `<button type="button" data-planremove="${i}">Remove this plan</button>` : ""}` +
      `<button type="button" data-copynote="${i}">Copy as in-game note</button><button type="button" data-copytext="${i}">Copy for Discord</button>${bill.launchers ? `<button type="button" data-lodge="${i}">⚒ Build it in the Building Calculator</button>` : ""}<span class="roads-hint" id="plan-copied"></span></div>`;
    const have = fwd.filter(h => !h.gap && (h.free || h.kind === "Our Road" || h.kind === "Public Gate")), ours = have.filter(h => h.kind === "Our Road" || h.free === true && h.kind !== "Public Gate").length, pubs = have.length - ours, todo = fwd.filter(isBuild).length;
    const haveLine = `<div class="roads-have"><span class="have"><b>${have.length}</b> hop${have.length === 1 ? "" : "s"} over what exists</span>${have.length ? ` (${[ours ? `${ours} on our roads` : "", pubs ? `${pubs} through public gates` : ""].filter(Boolean).join(", ")})` : ""} · <span class="k"><b>${todo}</b> to build</span>${bill.gaps ? ` · <span class="gap">${bill.gaps} crossing${bill.gaps > 1 ? "s" : ""} no tool makes</span>` : ""}</div>`;
    $("roads-plan").innerHTML = `<div class="roads-plan${isDraft ? "" : " saved"}"><div class="ph">${esc(p.name)}<small>${fwd.length} hops · ${f0(ly)} LY${raw.priorities ? " · " + raw.priorities.map(k => CRIT[k]).filter(Boolean).slice(0, 3).join(", ") : ""}</small></div>` + haveLine +
      (p.note ? `<div class="pnote">${esc(p.note)}</div>` : "") + diag + (dir ? `<div class="roads-hint">${dir}</div>` : "") + sheet + corridor + head + fwd.map(row).join("") + backHtml +
      `<div class="roads-hint">Systems marked (C6) carry their Cycle 6 name: their Cycle 7 name is not known yet; in the in-game note they open under their real name. Distances are straight lines from the archived positions.${isDraft ? "" : " Status comes from the chain when a launcher with the right name appears; click a status to set it by hand."}</div>` + acts + `</div>`;
    if (sf && view === "stars") { const ids = new Set(); for (const h of p.hops) { const a = M.ids.get(h.fromSys), b = M.ids.get(h.toSys); if (a) ids.add(a.id); if (b) ids.add(b.id); } sf.fitTo([...ids]); }
  }
  const f0 = n => Math.round(n).toLocaleString("en-US");
  // ---------- the planner: a Worker over stars.bin, gates.bin and catapults.bin; results show as an unsaved plan the editors can keep ----------
  let planner = null, planning = false, draft = null, lastData = null, checker = null, lastCheck = null, onPlanned = null;
  /* my routes (user 2026-10-18): a plan anyone can save and reopen, kept in this browser (localStorage), listed after the
     tribe's plans with a star; the tribe's shared plans stay the editors' (Keep for the tribe) */
  const MINE_KEY = "roads:mine";
  const loadMine = () => { try { const v = JSON.parse(localStorage.getItem(MINE_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  const storeMine = a => { try { localStorage.setItem(MINE_KEY, JSON.stringify(a)); return true; } catch (e) { return false; } };
  function withMine(d) { const c = JSON.parse(JSON.stringify(d)); c.list = c.list || {}; c.list.plans = (c.list.plans || []).filter(p => !p.mine).concat(loadMine().map(p => Object.assign({}, p, { mine: true }))); return c; }
  function getPlanner() {
    if (planner) return planner;
    planner = new Worker("planner.js?v=" + Date.now());
    planner.onmessage = e => { const m = e.data; if (m.type === "checked") onChecked(m); else if (m.type === "progress") { $("plan-status").textContent = `searching… ${f0(m.expanded)} systems looked at, closest ${f0(m.closest)} LY`; } else if (onPlanned) onPlanned(m); };
    planner.onerror = e => { planning = false; try { planner.terminate(); } catch (x) {} planner = null; $("plan-run").disabled = false; $("plan-status").textContent = "the planner failed: " + (e.message || "worker error"); };
    return planner;
  }
  // ---------- the system boxes: type a name, pick it from the matches (ours, charted on EF-Map, reported once, a star
  // picked on the map, any archived star by its Cycle 6 name, or a system number) ----------
  function systemIndex() {
    const rows = [], seen = new Set();
    for (const [n, k] of M.ids) if (k.id && !k.c6 && !seen.has(k.id)) { seen.add(k.id); rows.push({ id: k.id, name: n, tag: "ours", rank: 0 }); }
    for (const [n, e] of M.ef.byName) if (!seen.has(e.id)) { seen.add(e.id); rows.push({ id: e.id, name: n, tag: e.status === "confirmed" ? "charted" : "reported once", rank: e.status === "confirmed" ? 1 : 2 }); }
    if (picked && !seen.has(picked)) rows.push({ id: picked, name: nameOfId(picked), tag: "picked on the map", rank: 3 });
    return rows;
  }
  function sysSearch(q, limit) {
    q = q.trim().toLowerCase(); if (!q) return [];
    const idx = systemIndex(), out = [], seen = new Set();
    const score = r => { if (String(r.id) === q) return 0; const n = r.name.toLowerCase(); return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 9; };   // a system number matches its system too
    for (const r of idx) { const sc = score(r); if (sc < 9) out.push(Object.assign({ s: sc }, r)); }
    if (/^[0-9]{8}$/.test(q)) { const id = +q; if (!idx.some(r => r.id === id) && sf && sf.has(id)) out.push({ id, name: nameOfId(id), tag: "by number", rank: 3, s: 0 }); }
    out.sort((x, y) => x.s - y.s || x.rank - y.rank || x.name.localeCompare(y.name));
    for (const r of out) seen.add(r.id);
    if (sf && sf.searchOld && q.length >= 2 && out.length < limit) for (const r of sf.searchOld(q, limit)) if (!seen.has(r.id)) { seen.add(r.id); out.push({ id: r.id, name: r.name + " (C6)", tag: "uncharted · Cycle 6 name", rank: 4, s: 3 }); }
    return out.slice(0, limit);
  }
  const sysId = id => +($(id).dataset.id || 0);
  function setSys(id, sid) { const el = $(id); el.dataset.id = sid ? String(sid) : ""; el.value = sid ? nameOfId(sid) : ""; }
  function sysbox(el) {
    if (el.dataset.boxed) return; el.dataset.boxed = "1";
    const menu = document.createElement("ul"); menu.className = "sysmenu"; menu.hidden = true; el.parentNode.appendChild(menu);
    let rows = [], hi = -1;
    const close = () => { menu.hidden = true; hi = -1; };
    const pick = i => { const r = rows[i]; if (!r) return; el.dataset.id = String(r.id); el.value = r.name; close(); el.dispatchEvent(new Event("change", { bubbles: true })); };
    const draw = () => { menu.innerHTML = rows.map((r, i) => `<li class="${i === hi ? "hi" : ""}" data-i="${i}"><b>${esc(r.name)}</b><span>${esc(r.tag)}</span></li>`).join("") || `<li class="none">no system matches</li>`; menu.hidden = false; };
    el.addEventListener("input", () => { el.dataset.id = ""; rows = sysSearch(el.value, 12); hi = rows.length ? 0 : -1; if (el.value.trim()) draw(); else close(); });
    el.addEventListener("focus", () => { if (el.value.trim() && !el.dataset.id) { rows = sysSearch(el.value, 12); hi = rows.length ? 0 : -1; draw(); } });
    el.addEventListener("keydown", e => {
      if (menu.hidden) { if (e.key === "Enter" && /^plan-(from|to)$/.test(el.id)) { e.preventDefault(); $("plan-run").click(); } return; }
      if (e.key === "ArrowDown") { hi = Math.min(rows.length - 1, hi + 1); draw(); e.preventDefault(); } else if (e.key === "ArrowUp") { hi = Math.max(0, hi - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter") { if (hi >= 0) pick(hi); e.preventDefault(); } else if (e.key === "Escape") close(); });
    el.addEventListener("blur", () => setTimeout(() => { if (!el.dataset.id && rows.length && rows[0].s === 0) pick(0); close(); }, 150));   // the full name typed and left: it counts
    menu.addEventListener("mousedown", e => { const li = e.target.closest("li[data-i]"); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  }
  // Find a system (user 2026-10-20: "can we search the map by system id?"): a name, a Cycle 6 name or the game's
  // 8-digit system number; the pick flies the camera there and opens its detail line, as a click on it would
  function findBox() {
    const el = $("sf-find"); if (!el || el.dataset.boxed) return;
    sysbox(el);
    el.addEventListener("change", () => {
      const id = +(el.dataset.id || 0); if (!id || !sf) return;
      const name = [...M.ids].find(([, v]) => v.id === id);
      selected = name ? name[0] : null; picked = name ? null : id;
      sf.look(id, 300); sf.mark(name ? null : id, name ? null : "found"); drawStars(); drawDetail();
    });
  }
  function fillPlanner() {
    for (const id of ["plan-from", "plan-to", "plan-stop", "plan-avoid", "check-from", "chart-from"]) { const el = $(id); if (el) sysbox(el); }
    const home = M.ids.get(M.home); if (!$("plan-from").value && home) setSys("plan-from", home.id);
    renderPrio(); renderChips();
  }
  function renderPrio() {
    $("plan-prio").innerHTML = planPrio.map(([k, on], i) => `<li class="${on ? "on" : "off"}"><label><input type="checkbox" data-priotick="${i}" ${on ? "checked" : ""}>${CRIT[k]}</label><span><button type="button" data-prioup="${i}" ${i ? "" : "disabled"} title="earlier">▲</button><button type="button" data-priodown="${i}" ${i < 5 ? "" : "disabled"} title="later">▼</button></span></li>`).join("");
    try { localStorage.setItem("roads:prio", JSON.stringify(planPrio)); } catch (e) {}
  }
  function renderChips() {
    $("plan-stops").innerHTML = planStops.map((id, i) => `<span class="chip">${esc(nameOfId(id))}<button type="button" data-chip="stop:${i}" title="remove">×</button></span>`).join("");
    $("plan-avoids").innerHTML = planAvoid.map((id, i) => `<span class="chip">${esc(nameOfId(id))}<button type="button" data-chip="avoid:${i}" title="remove">×</button></span>`).join("");
  }
  // our built roads and recorded public gates, by system number, for the planner (what exists costs nothing to use)
  function ownRoads() {
    const out = [];
    for (const r of M.roads) { if (r.source === "plan" || r.online === false) continue; const a = M.ids.get(r.from), b = M.ids.get(r.to); if (!a || !b) continue; out.push({ a: a.id, b: b.id, kind: r.kind === "Public Gate" ? "Public Gate" : "Our Road", twoWay: !!r.twoWay }); }
    return out;
  }
  const gateStateList = () => (M.list.gates || []).map(g => { const a = M.ids.get(up(g.a)), b = M.ids.get(up(g.b)); return a && b ? { a: a.id, b: b.id, state: g.state || "" } : null; }).filter(Boolean);
  const WORKER_MSG = () => ({ stars: "stars.bin?v=2", gates: "gates.bin?v=3", catapults: "catapults.bin?v=1" });
  function runPlanner() {
    if (planning) return;
    const from = sysId("plan-from"), to = sysId("plan-to"), tools = [...$("plan-tools").querySelectorAll("input:checked")].map(i => i.value), mode = $("plan-mode").value, roundTrip = $("plan-round").checked;
    if (!from || !to || from === to) { $("plan-status").textContent = !from || !to ? "type both systems and pick each from the matches." : "pick two different systems."; return; }
    if (!tools.some(t => t !== "Public Gate")) { $("plan-status").textContent = "tick at least one launcher to build; public gates alone only go where the network already leads."; }
    if (mode === "corridor" && !tools.some(t => /Gate$/.test(t) && t !== "Public Gate")) { $("plan-status").textContent = "a corridor is made of gate pairs: tick Mini Gate or Heavy Gate."; return; }
    const priorities = planPrio.filter(x => x[1]).map(x => x[0]);
    getPlanner();
    onPlanned = m => {
      planning = false; $("plan-run").disabled = false;
      if (m.error) { $("plan-status").textContent = "the planner failed: " + m.error; return; }
      const target = nameOfId(to).replace(/ \(C6\)$/, ""), word = mode === "corridor" ? "Corridor to " : mode === "tree" ? "Network to " : "Road to ";
      const hops = m.hops.slice(); if (m.back) for (const h of m.back.hops) hops.push(Object.assign({ leg: "back" }, h));
      const prio = priorities.map(k => CRIT[k]).join(", ");
      draft = { name: (word + target).slice(0, 40), hops, mode, priorities, from, to, diag: m.reached ? null : m.diagnostics, diagTarget: m.reached ? null : (m.legs.find(l => !l.reached) || {}).to, direct: m.direct,
                note: (m.reached ? `Found by the planner (${prio}); straight-line distances from the archived positions.` : `The target cannot be reached with these tools: the road runs as far as it can and ends with a crossing no tool makes.`) + (m.back && !m.back.reached ? " The way home is not complete either." : "") };
      $("plan-status").textContent = `${m.reached ? "road found" : "no full road"} · ${f0(m.expanded)} systems looked at in ${m.ms < 1000 ? m.ms + " ms" : (m.ms / 1000).toFixed(1) + " s"} · catapult hops ${m.graph}`;
      showDraft();
    };
    planning = true; $("plan-run").disabled = true; $("plan-status").textContent = "searching…";
    planner.postMessage(Object.assign({ type: "plan", id: Date.now(), from, to, stops: planStops, avoid: planAvoid, tools, priorities, mode, roundTrip, roads: ownRoads(), gateStates: gateStateList() }, WORKER_MSG()));
  }
  function showDraft() {                          // the draft rides along as an extra, unsaved plan until kept or dropped
    const d = withMine(lastData); d.list.plans = d.list.plans.concat([Object.assign({ draft: true }, draft)]);
    M = build(d); drawMap(); drawStars(); drawPlans(); drawPlan(M.plans.length - 1);
  }
  // ---------- copies: an in-game note (clickable system links, EF-Map's line format), a Discord text, the Lodge ----------
  const gameLink = (id, name) => `<a href="showinfo:5//${id}">${name.replace(/ \(C6\)$/, "")}</a>`;
  const stateMark = h => { const s = h.state || (gateRec(h.fromSys, h.toSys) || {}).state; return s === "dormant" ? "*" : s === "unfueled" ? "!" : s === "working" ? "" : "?"; };
  function noteText(p) {
    const fwd = p.hops.filter(h => h.leg !== "back"), back = p.hops.filter(h => h.leg === "back"), bill = planBill(fwd);
    const line = hs => { if (!hs.length) return ""; let s = gameLink(hs[0].from, hs[0].fromSys); for (const h of hs) { const tag = h.gap ? "[STARGATE NEEDED]→" : h.step === "gate" ? `[${h.kind} pair ${h.ly}]⇄` : h.kind === "Public Gate" ? `(Gate${stateMark(h)})→` : h.kind === "Our Road" ? "(ours)→" : h.free ? `(${h.kind.replace("Propulsion ", "")}, built)→` : `[${h.kind.replace(" Catapult", "").replace(" Gate", " Gate")} ${h.ly}]→`; s += ` ${tag} ${gameLink(h.to, h.toSys)}`; } return s; };
    return `The Saints · ${p.name}\nBuild list, not a flyable route. ${bill.launchers} launcher${bill.launchers === 1 ? "" : "s"}: ${Object.entries(bill.kinds).map(([k, n]) => `${n}× ${k}`).join(", ") || "none"}; ${bill.newNodes.length} new Network Node${bill.newNodes.length === 1 ? "" : "s"}.\nLegend: (Gate)→ public stargate (* dormant, ! no fuel, ? unknown) · [Mini 45.4]→ build a one-way catapult · [Heavy Gate pair 120]⇄ build a gate pair · (ours)→ our road.\n${line(fwd)}${back.length ? "\nThe way home: " + line(back) : ""}`;
  }
  function discordText(p) {
    const fwd = p.hops.filter(h => h.leg !== "back"), bill = planBill(fwd), ly = fwd.reduce((a, h) => a + (h.ly || 0), 0);
    const rows = fwd.map((h, k) => `${k + 1}. ${h.fromSys.replace(/ \(C6\)$/, "")} → ${h.toSys.replace(/ \(C6\)$/, "")} · ${h.gap ? "STARGATE NEEDED" : h.step === "gate" ? "build " + h.kind + " pair" : h.kind === "Public Gate" ? "public gate" : h.kind === "Our Road" ? "our road" : h.free ? h.kind + " (built above)" : h.kind} · ${Math.round(h.ly || 0)} LY${h.status && h.status !== "planned" ? " · " + STATUS_TEXT[h.status] : ""}${h.who ? " · " + h.who : ""}`);
    return `**${p.name}** · ${fwd.length} hops · ${f0(ly)} LY\n${rows.join("\n")}\n**To build:** ${bill.launchers} launcher${bill.launchers === 1 ? "" : "s"} (${Object.entries(bill.kinds).map(([k, n]) => `${n}× ${k}`).join(", ") || "none"}), ${bill.newNodes.length} new Network Node${bill.newNodes.length === 1 ? "" : "s"}${bill.launchers ? ` · ${f0(bill.tar)}x Kerogen Tar, ${f0(bill.foam)}x Building Foam, ${f0(bill.kernel)}x Still Kernel` : ""}${bill.pub ? ` · ${bill.pub} public gate jump${bill.pub > 1 ? "s" : ""}` : ""}\nThe Map: https://www.thesaintsforge.com/map`;
  }
  async function copyText(text, note) {
    try { await navigator.clipboard.writeText(text); $("plan-copied").textContent = note; }
    catch (e) { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); $("plan-copied").textContent = note; } catch (e2) { $("plan-copied").textContent = "copy failed: select the text by hand."; } ta.remove(); }
    setTimeout(() => { if ($("plan-copied")) $("plan-copied").textContent = ""; }, 4000);
  }
  function toLodge(p) {
    const bill = planBill(p.hops.filter(h => h.leg !== "back")), goals = Object.entries(bill.kinds).map(([k, n]) => ({ item: k, qty: n * (/Gate/.test(k) ? 2 : 1) }));
    if (bill.newNodes.length) goals.push({ item: "Network Node", qty: bill.newNodes.length });
    if (!(window.__lodgeImport && window.__siteGo)) { $("plan-copied").textContent = "the Building Calculator is on the site: open thesaintsforge.com/map there."; return; }
    window.__lodgeImport({ name: p.name, goals }); window.__siteGo("lodge");
  }
  // ---------- Check a jump: one structure from one star, every legal target on the map ----------
  let checkTarget = null;                        // the jump under test, picked from the list
  let checkLit = new Set();                      /* the stars the last check lit green or red: a map click on one tests that jump */
  const checkOpen = () => !$("roads-p-check").hidden;
  /* Check a jump from any star (user 2026-10-17): with the panel open, a click on the star map sets From to that star,
     ours, charted or uncharted, and lists every jump from it; a click on a lit result ring tests that jump instead */
  function checkClick(id) {
    if (!id || !checkOpen()) return false;
    if (checkLit.has(id) && lastCheck) { runChecker(id === checkTarget ? null : id); return true; }
    setSys("check-from", id); runChecker(null); return true;
  }
  /* Plan by clicking (user 2026-10-18): with the planner open, a click on any star sets To (or From, as chosen) and
     plans at once when both ends are set; "Plan a road here" in a star's detail line does the same from anywhere */
  const planOpen = () => !$("roads-p-plan").hidden;
  function planClick(id) {
    if (!id || !planOpen()) return false;
    const which = (root.querySelector('input[name="plan-click"]:checked') || {}).value === "from" ? "plan-from" : "plan-to";
    setSys(which, id); if (sf) sf.mark(id, which === "plan-to" ? "to" : "from");
    const f = sysId("plan-from"), t = sysId("plan-to");
    if (f && t && f !== t) runPlanner(); else $("plan-status").textContent = which === "plan-to" ? "destination set: pick a From too." : "start set: pick a To too.";
    return true;
  }
  function planTo(id) {
    const tab = root.querySelector('.roads-tabs [data-panel="plan"][data-plan="new"]');
    if (!planOpen() && tab) tab.click();
    setSys("plan-to", id);
    const f = sysId("plan-from");
    if (f && f !== id) runPlanner(); else $("plan-status").textContent = "destination set: pick a From too.";
  }
  function checkFrom(id) {                       /* "Check jumps from here": open the panel on that star */
    const tab = root.querySelector('.roads-tabs [data-panel="check"]');
    if (!checkOpen() && tab) tab.click();
    setSys("check-from", id); runChecker(null);
    const p = $("roads-p-check"); if (p && p.scrollIntoView) p.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function runChecker(target) {
    const from = sysId("check-from"), structure = $("check-kind").value; checkTarget = target || null;
    if (!from) { $("check-status").textContent = "type the system you jump from and pick it from the matches."; return; }
    getPlanner();
    $("check-status").textContent = "checking…";
    lastCheck = { id: Date.now(), from };
    planner.postMessage(Object.assign({ type: "check", id: lastCheck.id, from, structure, target }, WORKER_MSG()));
  }
  function onChecked(m) {
    if (m.error) { $("check-status").textContent = "the check failed: " + m.error; return; }
    if (!lastCheck || m.id !== lastCheck.id) return;   /* an older answer: the pilot changed the From box since */
    const from = lastCheck.from;
    $("check-status").textContent = `${m.legal.length} legal target${m.legal.length === 1 ? "" : "s"} within ${m.range} LY, ${m.blocked.length} in range but blocked`;
    const li = (id, ly, cls, extra) => `<li class="${cls}${m.target && m.target.id === id ? " hi" : ""}"><button type="button" class="jump" data-jump="${id}" title="test this jump"><b>${esc(starName(id))}</b> · ${ly} LY</button>${extra || ""}</li>`;
    let verdict = "";
    if (m.target) { const t = m.target, n = esc(starName(t.id));
      verdict = t.legal ? `<div class="roads-diag ok"><b>${n}</b>: a legal ${esc(m.structure)} jump, ${t.ly} LY.</div>`
        : !t.inRange ? `<div class="roads-diag"><b>${n}</b> is ${t.ly} LY away, beyond a ${esc(m.structure)} (${m.range} LY).${m.stepTo ? ` The legal hop that ends closest to it: <b>${esc(starName(m.stepTo))}</b>. <button type="button" data-stepto="${m.stepTo}">Step there</button>` : ""}</div>`
        : `<div class="roads-diag"><b>${n}</b> is ${t.ly} LY away, in range, but the shot is blocked by ${t.blockers.map(b => `<b>${esc(starName(b.id))}</b> (${b.ly} LY out)`).join(", ")}.${m.stepTo ? ` Closest legal hop toward it: <b>${esc(starName(m.stepTo))}</b>. <button type="button" data-stepto="${m.stepTo}">Step there</button>` : ""}</div>`; }
    const CAP = 80;
    $("roads-check").innerHTML = verdict + `<div class="roads-dcols"><div><h4>Can jump to · ${m.legal.length}</h4><ul>${m.legal.slice(0, CAP).map(([id, ly]) => li(id, ly, "ok")).join("") || "<li>none within range</li>"}${m.legal.length > CAP ? `<li class="roads-hint">and ${m.legal.length - CAP} more, nearest first</li>` : ""}</ul></div>` +
      (/Catapult/.test(m.structure) ? `<div><h4>In range, blocked · ${m.blocked.length}</h4><ul>${m.blocked.slice(0, CAP).map(([id, ly]) => li(id, ly, "bad")).join("") || "<li>none</li>"}${m.blocked.length > CAP ? `<li class="roads-hint">and ${m.blocked.length - CAP} more</li>` : ""}</ul></div>` : "") +
      `</div><div class="roads-hint">Click a system to test that jump. Green rings on the star map can be jumped to, red ones are in range but blocked; the dashed circle is the interference sphere of the tested jump. Gates ignore interference. <button type="button" class="roads-quiet" data-checkclear="1">clear the marks</button></div>`;
    checkLit = new Set(m.legal.map(([id]) => id).concat(m.blocked.map(([id]) => id)));
    if (sf) { const marks = m.legal.map(([id]) => ({ id, cls: "ok" })).concat(m.blocked.map(([id]) => ({ id, cls: "bad" }))); if (m.target) marks.push({ id: m.target.id, cls: m.target.legal ? "ok" : "aim", label: starName(m.target.id) }); sf.markMany(marks); sf.sphere(m.target && m.target.inRange && !m.target.legal ? { a: from, b: m.target.id } : null); sf.fitTo([from].concat(m.target ? [m.target.id] : m.legal.slice(0, 12).map(x => x[0]))); }
  }

  // ---------- Chart the uncharted: every uncharted system in reach, and a run through them (user 2026-10-14) ----------
  // Uncharted = no sure name for the system: not copied from the game by a Saint and not charted on EF-Map (two players
  // agreeing). Reach = the public gates (one a Saint found dormant left out) plus our own roads (catapults one way), or
  // every star within a straight-line distance. The run: the nearest target from where you stand, again and again.
  let chartOn = false, chartRes = null;
  const CHART_WORD = { unknown: "nobody has reported it", reported: "one report on EF-Map", disputed: "disputed name on EF-Map" };
  function chartState(id, own) {
    if (own.has(id)) return "ours";
    { const nm = fieldName(id); if (nm && (FIELD.visited || {})[nm]) return "visited"; }
    const e = M.ef.byId.get(id);
    return !e ? "unknown" : e.status === "confirmed" ? "charted" : e.status === "conflict" ? "disputed" : "reported";
  }
  function chartName(id) {
    const e = M.ef.byId.get(id), old = sf && sf.oldName(id);
    return e && e.status !== "confirmed" ? e.name + " (reported)" : old ? old + " (C6)" : String(id);
  }
  const lyBetween = (a, b) => { const p = sf && sf.position(a), q = sf && sf.position(b); return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : 0; };
  function chartNext() {
    const key = (a, b) => Math.min(a, b) + ":" + Math.max(a, b);
    const dormant = new Set(gateStateList().filter(g => g.state === "dormant").map(g => key(g.a, g.b)));
    const ours = new Map(), add = (a, b) => { if (!ours.has(a)) ours.set(a, []); ours.get(a).push(b); };
    for (const r of ownRoads()) { add(r.a, r.b); if (r.twoWay) add(r.b, r.a); }
    return id => (sf.gatesOf(id) || []).filter(x => !dormant.has(key(id, x))).concat(ours.get(id) || []);
  }
  function chartBfs(start, next) {
    const dist = new Map([[start, 0]]), prev = new Map(), q = [start];
    for (let i = 0; i < q.length; i++) { const x = q[i]; for (const y of next(x)) if (!dist.has(y)) { dist.set(y, dist.get(x) + 1); prev.set(y, x); q.push(y); } }
    return { dist, prev };
  }
  const chartPath = (prev, start, id) => { const p = [id]; while (p[0] !== start && prev.has(p[0])) p.unshift(prev.get(p[0])); return p; };
  function runChart() {
    if (!M || !sf) { $("chart-status").textContent = "the star map is still loading."; return; }
    const from = sysId("chart-from");
    if (!from) { $("chart-status").textContent = "type the system you start from and pick it from the matches."; return; }
    const reach = $("chart-reach").value, R = Math.max(20, Math.min(1000, +$("chart-ly").value || 150)), N = Math.max(1, Math.min(60, Math.round(+$("chart-n").value || 20)));
    $("chart-ly-wrap").hidden = reach !== "ly";
    const own = new Set([...M.ids.values()].filter(k => k.id && !k.c6).map(k => k.id)), next = chartNext();
    let pool;
    if (reach === "gates") { const { dist } = chartBfs(from, next); pool = [...dist.keys()].filter(id => id !== from).map(id => ({ id, hops: dist.get(id) })); }
    else pool = sf.near(from, R).map(([id, ly]) => ({ id, ly }));
    const cand = pool.filter(c => { const st = chartState(c.id, own); return st !== "ours" && st !== "charted" && st !== "visited"; });   /* a system a Saint has been in is known now */
    const tour = [], left = new Set(cand.map(c => c.id));
    let cur = from;
    while (tour.length < N && left.size) {
      let best = null;
      if (reach === "gates") {
        const { dist, prev } = chartBfs(cur, next);
        for (const id of left) { const d = dist.get(id); if (d == null) continue; const l = lyBetween(cur, id); if (!best || d < best.hops || (d === best.hops && l < best.ly)) best = { id, hops: d, ly: l, path: chartPath(prev, cur, id) }; }
      } else for (const id of left) { const l = lyBetween(cur, id); if (!best || l < best.ly) best = { id, ly: l }; }
      if (!best) break;
      tour.push(best); left.delete(best.id); cur = best.id;
    }
    chartRes = { from, reach, R, reachN: pool.length, cand, tour, own };
    drawChart();
  }
  function drawChart() {
    const c = chartRes; if (!c) return;
    const by = { unknown: 0, reported: 0, disputed: 0 };
    for (const x of c.cand) by[chartState(x.id, c.own)]++;
    $("chart-status").textContent = (c.reach === "gates" ? `${c.reachN} systems reachable by public gates and our roads` : `${c.reachN} stars within ${c.R} LY`) + ` · ${c.cand.length} uncharted`;
    const counts = `<div class="roads-chart-counts">${by.unknown} nobody has reported · ${by.reported} reported once · ${by.disputed} disputed · ${c.own.size} systems charted by Saints so far</div>`;
    if ($("chart-show").value === "ef") {
      const ef = chartEf(c);
      $("roads-chart").innerHTML = `<h4>Reported on EF-Map, not yet charted · ${ef.length}</h4><div class="roads-hint">One player has reported each of these, or two disagree on the name: one more report charts it. They are places players reach, all ringed on the star map; nearest to your start first. Every other star nobody has reported at all. Click a system to fly there; switch Show back to the run to plan a trip.</div>`
        + (ef.length ? `<ol>${ef.slice(0, 30).map(x => `<li><button type="button" class="jump" data-chartgo="${x.id}"><b>${esc(x.name)}</b></button> <span class="roads-hint">${x.st === "disputed" ? "disputed name" : "one report"} · ${f0(x.ly)} LY from the start</span></li>`).join("")}</ol>${ef.length > 30 ? `<div class="roads-hint">and ${ef.length - 30} more on the map.</div>` : ""}`
          : `<div class="roads-hint">EF-Map has no such reports right now${M.ef.byId.size ? "" : " (its names did not load)"}.</div>`);
      chartMarks(); return;
    }
    if (!c.cand.length) { $("roads-chart").innerHTML = counts + `<div class="roads-hint">Everything in reach is charted. Try another start or a wider reach.</div>`; chartMarks(); return; }
    const rows = c.tour.map((t, k) => {
      const st = chartState(t.id, c.own), via = c.reach === "gates" ? `${t.hops} jump${t.hops === 1 ? "" : "s"} from the stop before` : `${f0(t.ly)} LY from the stop before`;
      const through = c.reach === "gates" && t.path && t.path.length > 2 ? ` via ${t.path.slice(1, -1).map(x => esc(starName(x))).join(", ")}` : "";
      return `<li><button type="button" class="jump" data-chartgo="${t.id}"><b>${k + 1}. ${esc(chartName(t.id))}</b></button> <span class="roads-hint">${CHART_WORD[st]} · ${via}${through}</span></li>`;
    }).join("");
    const more = c.cand.length - c.tour.length;
    $("roads-chart").innerHTML = counts + `<h4>The run · ${c.tour.length} stop${c.tour.length === 1 ? "" : "s"}</h4><ol>${rows}</ol>`
      + (more > 0 ? `<div class="roads-hint">${more} more uncharted in reach${c.tour.length < +$("chart-n").value ? ": not reachable from the last stop (one-way roads)" : ": raise Visit up to"}. All of them are ringed on the star map.</div>` : "")
      + (c.reach === "ly" ? `<div class="roads-hint">Straight-line targets: how you get there (a catapult, a gate) is up to you.</div>` : `<div class="roads-hint">Public gates are listed by the game client; whether one works, has no fuel on the far side or lies dormant only a jump tells.</div>`)
      + `<div class="roads-copy"><button type="button" data-chartcopy="note">Copy as in-game note</button> <button type="button" data-chartcopy="discord">Copy for Discord</button> <span class="roads-hint" id="chart-copied"></span></div>`;
    chartMarks();
  }
  // every system EF-Map has a report of but no agreement on (one report, or a disputed name), not ours: nearest first
  function chartEf(c) {
    const out = [];
    for (const [id, e] of M.ef.byId) { if (e.status === "confirmed" || c.own.has(id) || !sf.has(id)) continue; out.push({ id, name: e.name, st: e.status === "conflict" ? "disputed" : "reported", ly: lyBetween(c.from, id) }); }
    return out.sort((a, b) => a.ly - b.ly);
  }
  function chartMarks() {
    const c = chartRes; if (!sf || !c || !chartOn) return;
    const only = $("chart-only").checked, inTour = new Set(c.tour.map(t => t.id));
    sf.dimStars(only);
    let marks, fit;
    if ($("chart-show").value === "ef") {
      const ef = chartEf(c);
      marks = ef.map(x => ({ id: x.id, cls: "unc" }));
      fit = [c.from].concat(ef.map(x => x.id));
    } else {
      marks = c.cand.filter(x => !inTour.has(x.id)).slice(0, 600).map(x => ({ id: x.id, cls: "unc" }));
      c.tour.forEach((t, k) => marks.push({ id: t.id, cls: "tour", label: String(k + 1) }));
      fit = [c.from].concat(c.tour.slice(0, 30).map(t => t.id));
    }
    marks.push({ id: c.from, cls: "aim", label: "start" });
    sf.markMany(marks); sf.sphere(null);
    sf.fitTo(fit);
  }
  function setChart(on) {
    if (on === chartOn) return;
    chartOn = on;
    if (!on) { if (sf) { sf.markMany([]); sf.dimStars(false); } drawStars(); return; }
    $("chart-save").hidden = !(M && M.canEdit);
    if (M && !sysId("chart-from")) { const home = M.ids.get(M.home); if (home) setSys("chart-from", home.id); }
    if (view !== "stars") setView("stars"); else drawStars();
    starsReady().then(s => { if (s && chartOn) runChart(); });
  }
  function chartNote() {
    const c = chartRes;
    return `The Saints · charting run from ${nameOfId(c.from).replace(/ \(C6\)$/, "")}\n` + c.tour.map((t, k) => `${k + 1}. ${gameLink(t.id, chartName(t.id).replace(/ \((C6|reported)\)$/, ""))}`).join("\n");
  }
  function chartDiscord() {
    const c = chartRes;
    return `**Charting run** from ${nameOfId(c.from).replace(/ \(C6\)$/, "")} · ${c.tour.length} uncharted systems\n` + c.tour.map((t, k) => `${k + 1}. ${chartName(t.id)}${c.reach === "gates" ? ` · ${t.hops} jump${t.hops === 1 ? "" : "s"}` : ` · ${f0(t.ly)} LY`}`).join("\n") + `\nThe Map: https://www.thesaintsforge.com/map`;
  }
  async function chartCopy(text, note) {
    const out = $("chart-copied");
    try { await navigator.clipboard.writeText(text); if (out) out.textContent = note; }
    catch (e) { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); if (out) out.textContent = note; } catch (e2) { if (out) out.textContent = "copy failed: select the text by hand."; } ta.remove(); }
  }

  function drawUnplaced() {
    const el = $("roads-unplaced"); $("roads-unplaced-n").textContent = M.unplaced.length ? ` · ${M.unplaced.length}` : "";
    const long = M.roads.filter(r => r.tooFar);
    const warn = long.length ? `<div class="roads-ugroup"><div class="roads-uh">Names to check</div>` + long.map(r => `<div class="roads-urow"><span><b>${esc(r.from)} → ${esc(r.to)}</b> · ${esc(r.kind)} ${r.name ? `<i>${esc(r.name)}</i>` : ""}<br><span class="roads-hint">${r.ly.toFixed(0)} LY apart, beyond its ${RANGE[r.kind]} LY reach: one of the names is wrong${r.builder ? " · " + esc(r.builder) : ""}.</span></span></div>`).join("") + `</div>` : "";
    const notes = M.ef.notes.length ? `<div class="roads-ugroup"><div class="roads-uh">Numbers to check</div>` + M.ef.notes.map(t => `<div class="roads-urow"><span class="roads-hint">${esc(t)} Ours was copied from the game: tell EF-Map if theirs is wrong.</span></div>`).join("") + `</div>` : "";
    const once = (M.seenOnce || []).length ? `<div class="roads-ugroup"><div class="roads-uh">Jumps seen once, not on the map</div>` + M.seenOnce.map(x => `<div class="roads-urow"><span><b>${esc(x.a)} → ${esc(x.b)}</b> · ${esc(x.kind)}<br><span class="roads-hint">One jump on ${esc(String(x.first || "").slice(0, 10))}${x.by ? " by " + esc(x.by) : ""}; no launcher of ours explains it (another tribe's catapult, or a respawn). It becomes a road once it is jumped on a second day.</span></span></div>`).join("") + `</div>` : "";
    if (!M.unplaced.length) { el.innerHTML = notes + warn + once + `<div class="roads-hint">Every launcher and gate read from the chain is on the map.</div>`; return; }
    // grouped by builder (each builder sees the list of what is theirs to rename) or by Network Node; the choice is kept
    const fuelOf = nid => { const n = M.nodeById.get(nid), d = M.daysOf(n); return n ? ` · <span class="${fuelClass(d)}">${d == null ? noDays(n, "idle") : "fuel " + fmtDays(d)}</span>` : ""; };
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
    el.innerHTML = notes + warn + once + bar + body;
  }

  function stamp(d) {
    const mins = Math.max(0, Math.round((Date.now() - (d.at || Date.now())) / 60000)), built = M.roads.filter(r => r.source === "chain"), guess = built.filter(r => r.inferred).length;
    $("roads-stamp").textContent = (d.error ? "The chain did not answer: " + d.error + " · " : "") + `${M.systems.size} systems · ${built.length} roads${guess ? ` (${guess} worked out)` : ""} · read ${mins ? mins + " min ago" : "just now"}` + (M.ef.count ? ` · EF-Map: ${M.ef.confirmed.toLocaleString("en-US")} systems charted, ${(M.ef.count - M.ef.confirmed).toLocaleString("en-US")} reported once` : M.ef.error ? ` · EF-Map names: ${M.ef.error}` : "");
  }

  /* The companions' field records (2026-10-19): the System Map's readings per system (infestation 1-6, transient
     mass, crude umbra, star) and the systems Saints have been in. Keyed by system name. */
  let FIELD = { survey: {}, visited: {}, rifts: [] }, surveyOn = (() => { try { return localStorage.getItem("roads:survey") !== "0"; } catch (e) { return true; } })();
  const INF_COL = ["#7d8894", "#5bb36a", "#9bc45a", "#d9b24c", "#e0a83a", "#e0702e", "#e3222c"];
  const fieldName = id => { const n = nameOfId(id); return /\(C6\)$|^#/.test(n) ? null : up(n); };
  function fieldLines(id, nameHint) {
    const nm = up(nameHint || "") || fieldName(id); if (!nm) return "";
    const sv = (FIELD.survey || {})[nm], vi = (FIELD.visited || {})[nm];
    const out = [];
    if (sv) out.push(`<div class="roads-field">${sv.infest ? `<span class="inf" style="--c:${INF_COL[sv.infest]}">Infestation ${sv.infest}/6${sv.word ? " " + esc(sv.word.toLowerCase()) : ""}</span>` : ""}${sv.transient ? ` · transient mass <b>${esc(sv.transient.toLowerCase())}</b>` : ""}${sv.umbra ? ` · crude umbra <b>${esc(sv.umbra.toLowerCase())}</b>` : ""}${sv.star ? ` · star ${esc(sv.star)}` : ""}${sv.planets != null ? ` · ${sv.planets} planets` : ""}${sv.belts != null ? ` · ${sv.belts} belts` : ""} <span class="roads-hint">(System Map, ${esc(String(sv.at).slice(0, 10))}${sv.by ? ", " + esc(sv.by) : ""})</span></div>`);
    if (vi) out.push(`<div class="roads-hint">Visited by Saints on ${vi.days} day${vi.days === 1 ? "" : "s"}, last ${esc(String(vi.last).slice(0, 10))}${vi.by ? " (" + esc(vi.by) + ")" : ""}.</div>`);
    return out.join("");
  }
  function drawSurveyBtn() { const b = $("roads-stars") && $("roads-stars").querySelector('[data-sf="survey"]'), n = Object.keys(FIELD.survey || {}).length; if (!b) return; b.hidden = !n; b.textContent = "Survey · " + n; b.classList.toggle("on", surveyOn); }
  function render(d) {
    lastData = d; draft = null; FIELD = Object.assign({ survey: {}, visited: {}, rifts: [] }, d.field || {});
    M = build(withMine(d));
    $("roads-gate").hidden = true; $("roads-app").hidden = false;
    stamp(d);
    $("roads-manage-btn").hidden = !M.canEdit; if (!M.canEdit) $("roads-p-manage").hidden = true;
    drawSurveyBtn(); setView(view); drawMap(); drawDetail(); drawFuel(); fillRoute(); drawUnplaced(); drawPlans(); fillPlanner(); if (openPlan != null && M.plans[openPlan]) drawPlan(openPlan);
    if (chartOn) { $("chart-save").hidden = !M.canEdit; starsReady().then(s => { if (s && chartOn) runChart(); }); }
    const ed = $("roads-editor"); ed.hidden = !M.canEdit; $("roads-gate-form").hidden = !M.canEdit;
    if (M.canEdit) $("roads-json").value = JSON.stringify({ builders: M.list.builders, home: M.list.home || "", systems: M.list.systems || {}, gates: M.list.gates || [], plans: (M.list.plans || []).filter(p => !p.draft && !p.mine) }, null, 1);
  }

  // ---------- loading and saving ----------
  let loaded = false;
  function gate(html) { $("roads-app").hidden = true; const g = $("roads-gate"); g.hidden = false; g.innerHTML = html; }
  function load(fresh) {
    if (!/(^|\.)thesaintsforge\.com$|^localhost$|^127\.0\.0\.1$/.test(location.hostname)) { gate("The Map is kept for the tribe. Open them on <b>thesaintsforge.com</b> and log in with Discord."); return Promise.resolve(); }   // localhost = tools/roads_local.py
    gate("Reading the roads from the chain…");
    return fetch("/api/network" + (fresh ? "?fresh=1" : ""), { credentials: "same-origin" }).then(r => {
      if (r.status === 401) { gate('The Map is for the tribe only. <a class="tribe-btn" href="/api/login?next=map">✠ Log in with Discord</a><br><span class="roads-hint">Squire rank or above.</span>'); return null; }
      if (!r.ok) throw new Error("the site answered " + r.status);
      return r.json();
    }).then(d => { if (d) render(d); }).catch(e => gate("The roads could not be read: " + esc(e.message) + "."));
  }
  function save(list, what) {
    $("roads-save-note").textContent = "saving…";
    return fetch("/api/network", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(list) })
      .then(r => r.json().then(x => ({ ok: r.ok, x })))
      .then(res => { if (!res.ok) { $("roads-save-note").textContent = "not saved: " + ((res.x && res.x.error) || "error"); return; } $("roads-save-note").textContent = what + " saved."; if (M && M.list) Object.assign(M.list, JSON.parse(JSON.stringify(list))); if (lastData && lastData.list) Object.assign(lastData.list, JSON.parse(JSON.stringify(list))); return load(false); })   /* the settings changed, not the chain: no fresh chain read (every status click used to cost one, bug squash 2026-10-21) */
      .catch(() => { $("roads-save-note").textContent = "not saved: the site could not be reached."; });
  }
  const listCopy = () => JSON.parse(JSON.stringify({ builders: M.list.builders, home: M.list.home || "", systems: M.list.systems || {}, gates: M.list.gates || [], plans: (M.list.plans || []).filter(p => !p.draft && !p.mine) }));

  root.addEventListener("click", e => {
    const g = e.target.closest("[data-sys]"); if (g) { selected = selected === g.dataset.sys ? null : g.dataset.sys; drawMap(); drawDetail(); if (sf) { const k = selected && M.ids.get(selected); sf.select(k ? k.id : null); } return; }
    const st = e.target.closest("[data-hopstatus]");
    if (st && M && M.canEdit) { const [i, n] = st.dataset.hopstatus.split(":").map(Number); const l = listCopy(), h = l.plans[i].hops[n], cur = h.status || null; const next = cur == null ? "progress" : cur === "progress" ? "built" : cur === "built" ? "planned" : null; if (next) h.status = next; else delete h.status; save(l, "Plan"); return; }
    const b = e.target.closest("button"); if (!b || !M) return;
    if (b.dataset.ugroup) { unplacedBy = b.dataset.ugroup === "node" ? "node" : "builder"; try { localStorage.setItem("roads:unplacedBy", unplacedBy); } catch (e) {} drawUnplaced(); return; }
    if (b.id === "plan-run") { runPlanner(); return; }
    if (b.id === "plan-stop-add") { const v = sysId("plan-stop"); if (v && !planStops.includes(v)) planStops.push(v); setSys("plan-stop", 0); renderChips(); return; }
    if (b.id === "plan-avoid-add") { const v = sysId("plan-avoid"); if (v && !planAvoid.includes(v)) planAvoid.push(v); setSys("plan-avoid", 0); renderChips(); return; }
    if (b.dataset.chip) { const [k, i] = b.dataset.chip.split(":"); (k === "stop" ? planStops : planAvoid).splice(+i, 1); renderChips(); return; }
    if (b.dataset.prioup != null) { const i = +b.dataset.prioup; if (i > 0) { [planPrio[i - 1], planPrio[i]] = [planPrio[i], planPrio[i - 1]]; renderPrio(); } return; }
    if (b.dataset.priodown != null) { const i = +b.dataset.priodown; if (i < planPrio.length - 1) { [planPrio[i + 1], planPrio[i]] = [planPrio[i], planPrio[i + 1]]; renderPrio(); } return; }
    if (b.dataset.copynote) { copyText(noteText(M.plans[+b.dataset.copynote]), "copied: paste it into a note in game."); return; }
    if (b.dataset.copytext) { copyText(discordText(M.plans[+b.dataset.copytext]), "copied for Discord."); return; }
    if (b.dataset.lodge) { toLodge(M.plans[+b.dataset.lodge]); return; }
    if (b.id === "check-run") { runChecker(checkTarget); return; }
    if (b.dataset.jump) { runChecker(+b.dataset.jump === checkTarget ? null : +b.dataset.jump); return; }
    if (b.dataset.stepto) { setSys("check-from", +b.dataset.stepto); runChecker(checkTarget); return; }
    if (b.dataset.checkfrom) { checkFrom(+b.dataset.checkfrom); return; }
    if (b.dataset.checkclear) { checkLit = new Set(); checkTarget = null; if (sf) { sf.markMany([]); sf.sphere(null); } $("roads-check").innerHTML = ""; $("check-status").textContent = ""; return; }
    if (b.dataset.plansave) { const l = listCopy(); l.plans = l.plans.filter(p => !p.draft); l.plans.push({ name: draft.name, note: draft.note, hops: draft.hops, mode: draft.mode, priorities: draft.priorities }); save(l, "Plan"); return; }
    if (b.dataset.plandrop) { draft = null; render(lastData); $("plan-status").textContent = "dropped."; return; }
    if (b.dataset.mysave && draft) {
      const name = (window.prompt("Name this route", draft.name) || "").trim(); if (!name) return;
      const mine = loadMine(), route = { id: String(Date.now()), name: name.slice(0, 40), note: draft.note, hops: draft.hops, mode: draft.mode, priorities: draft.priorities, from: draft.from, to: draft.to,
        diag: draft.diag, diagTarget: draft.diagTarget, direct: draft.direct, saved: new Date().toISOString().slice(0, 10) };
      mine.push(route);
      if (!storeMine(mine)) { $("plan-status").textContent = "this browser would not keep it (private window?)."; return; }
      draft = null; render(lastData); const p = M.plans.find(x => (M.list.plans[x.i] || {}).id === route.id); if (p) drawPlan(p.i);
      $("plan-status").textContent = `saved to my routes: \u2605 ${route.name} (kept in this browser).`; return;
    }
    if (b.dataset.myremove) { storeMine(loadMine().filter(p => p.id !== b.dataset.myremove)); openPlan = null; $("roads-plan").innerHTML = ""; render(lastData); $("plan-status").textContent = "removed from my routes."; return; }
    if (b.dataset.planto) { planTo(+b.dataset.planto); return; }
    if (b.dataset.navto) { navSet(+b.dataset.navto); return; }
    if (b.dataset.navname) { navSet("n:" + b.dataset.navname); return; }
    if (b.dataset.navgo) { const k = window.RoadsCore.navKey(M, b.dataset.navgo); if (k) navSet(k).then(ok => { const o = $("roads-route"); if (ok && o) o.insertAdjacentHTML("beforeend", `<div class="good">Sent to the companion: it shows the next jump as you fly.</div>`); }); return; }
    if (b.dataset.navstop) { navSet(null); return; }
    if (b.dataset.home) { placesSet({ home: placeOf(+b.dataset.home) }); return; }
    if (b.dataset.mark) { const pl = placeOf(+b.dataset.mark), lab = askLabel("", pl.name); if (lab === null) return; if (lab) pl.label = lab; placesSet({ add: pl }); return; }
    if (b.dataset.placelabel) { const to = +b.dataset.placelabel, pl = (PLACES.home && PLACES.home.to === to ? PLACES.home : null) || PLACES.marks.find(m => m.to === to); if (!pl) return; const lab = askLabel(pl.label, pl.name); if (lab === null) return; placesSet({ label: { to, label: lab } }); return; }
    if (b.dataset.unmark) { placesSet({ remove: +b.dataset.unmark }); return; }
    if (b.dataset.placego) { navSet(+b.dataset.placego); return; }
    if (b.dataset.placelook && sf) { const id = +b.dataset.placelook, name = [...M.ids].find(([, v]) => v.id === id); selected = name ? name[0] : null; picked = name ? null : id; sf.look(id, 400); if (!name) sf.mark(null); drawStars(); drawDetail(); return; }
    if (b.dataset.poiall != null && POI) { poiOn = new Set(b.dataset.poiall === "1" ? POI.categories.map(c => c.key) : []); poiSave(); drawStars(); drawPoi(); return; }
    if (b.dataset.poigo && sf) { const id = +b.dataset.poigo; selected = null; picked = id; sf.look(id, 400); sf.mark(null); drawDetail(); return; }
    if (b.dataset.planremove) { const l = listCopy(); l.plans.splice(+b.dataset.planremove, 1); openPlan = null; save(l, "Plan"); return; }
    if (b.dataset.panel) {
      const want = $("roads-p-" + b.dataset.panel), open = want.hidden || (b.dataset.plan != null && b.dataset.plan !== "new" && openPlan !== +b.dataset.plan);
      if (b.dataset.plan === "new") { openPlan = null; $("roads-plan").innerHTML = ""; } else if (b.dataset.plan != null) drawPlan(+b.dataset.plan); else openPlan = null;
      root.querySelectorAll(".roads-panel").forEach(x => { x.hidden = true; }); root.querySelectorAll(".roads-tabs [data-panel]").forEach(x => x.classList.remove("on"));
      if (open) { want.hidden = false; b.classList.add("on"); }
      setChart(!$("roads-p-chart").hidden);
      return;
    }
    if (b.dataset.chartgo && sf) { const id = +b.dataset.chartgo; sf.look(id, 400); sf.mark(id, chartName(id)); return; }
    if (b.dataset.chartcopy && chartRes) { if (b.dataset.chartcopy === "note") chartCopy(chartNote(), "copied: paste it into a note in game."); else chartCopy(chartDiscord(), "copied for Discord."); return; }
    if (b.id === "chart-paste-save") {
      const text = $("chart-paste").value, found = new Map();
      for (const m of text.matchAll(/showinfo:5\/\/(\d{8})["']?\s*>\s*([^<\]\r\n]+?)\s*<\/(?:url|a)>/gi)) found.set(up(m[2]), +m[1]);
      if (!found.size) { $("chart-paste-note").textContent = "No system link found. Copy it with formatting from the game."; return; }
      const l = listCopy(); for (const [name, id] of found) l.systems[name] = { id, sure: true };
      $("chart-paste-note").textContent = `${found.size} charted: ${[...found.keys()].join(", ")}`; $("chart-paste").value = "";
      save(l, "Charted systems"); return;
    }
    if (b.dataset.mindetail) { const d = $("roads-detail"); d.classList.toggle("mini"); detailMini = d.classList.contains("mini"); b.textContent = detailMini ? "+" : "–"; b.title = detailMini ? "Open the window" : "Fold to the title bar"; return; }
    if (b.dataset.closedetail) { selected = null; picked = null; if (sf) { sf.select(null); sf.mark(null); } drawDetail(); drawMap(); return; }
    if (b.dataset.copylink) { const t = `<a href="showinfo:5//${b.dataset.copylink}">${b.dataset.copyname}</a>`; const done = () => { b.textContent = "Copied: paste it into a chat line"; };
      try { navigator.clipboard.writeText(t).then(done, () => { prompt("Copy this link:", t); }); } catch (err) { prompt("Copy this link:", t); } return; }
    if (b.id === "roads-refresh") { load(true); return; }
    if (b.dataset.view) { setView(b.dataset.view); return; }
    if (b.dataset.sfmissing) { $("sf-missing").classList.toggle("open"); return; }
    if (b.dataset.sf === "layers") { const L = $("sf-layers"); L.hidden = !L.hidden; b.classList.toggle("on", !L.hidden); return; }
    if (b.dataset.sf === "gates") { showGates = !showGates; try { localStorage.setItem("roads:gates", showGates ? "1" : "0"); } catch (e) {} if (sf) sf.showGates(showGates); b.classList.toggle("on", showGates); drawDetail(); return; }
    if (b.dataset.sf === "charted") { showCharted = !showCharted; try { localStorage.setItem("roads:charted", showCharted ? "1" : "0"); } catch (e) {} if (!showCharted) { picked = null; if (sf) sf.mark(null); } drawStars(); drawDetail(); return; }
    if (b.dataset.sf === "poi") { openPoiBox(!poiBox); return; }
    if (b.dataset.sf === "survey") { surveyOn = !surveyOn; try { localStorage.setItem("roads:survey", surveyOn ? "1" : "0"); } catch (e) {} drawStars(); drawSurveyBtn(); return; }
    if (b.dataset.sf === "me" && sf && LOC && LOC.me) { const id = locOf(LOC.me.s); if (id) { const name = [...M.ids].find(([, v]) => v.id === id); selected = name ? name[0] : null; picked = name ? null : id; sf.look(id, 300); if (!name) sf.mark(null); drawStars(); drawDetail(); } return; }
    if (b.dataset.poiclose) { openPoiBox(false); return; }
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
      const state = ($("roads-gate-state") || {}).value || "", seen = new Date().toISOString().slice(0, 10);
      const l = listCopy(), old = l.gates.find(g => (up(g.a) === a && up(g.b) === c) || (up(g.a) === c && up(g.b) === a));
      if (old) { if ((old.state || "") === state) { $("roads-gate-note").textContent = "already recorded with that state."; return; } if (state) old.state = state; else delete old.state; old.seen = seen; }
      else { const rec = { a, b: c, seen }; if (state) rec.state = state; l.gates.push(rec); }
      $("roads-gate-a").value = ""; $("roads-gate-b").value = ""; $("roads-gate-note").textContent = old ? "state updated." : ""; save(l, "Public gate"); return;
    }
    if (b.id === "roads-json-save") { let l; try { l = JSON.parse($("roads-json").value); } catch (err) { $("roads-save-note").textContent = "that is not valid JSON."; return; } save(l, "Settings"); }
  });
  root.addEventListener("keydown", e => { const g = e.target.closest && e.target.closest("[data-sys]"); if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selected = g.dataset.sys; drawMap(); drawDetail(); } });
  root.addEventListener("change", e => {
    const t = e.target;
    if (t.dataset && (t.dataset.hopwho || t.dataset.hopby)) { const [i, n] = (t.dataset.hopwho || t.dataset.hopby).split(":").map(Number); const l = listCopy(), h = l.plans[i].hops[n]; if (t.dataset.hopwho) { if (t.value.trim()) h.who = t.value.trim().slice(0, 24); else delete h.who; } else { if (t.value) h.by = t.value; else delete h.by; } save(l, "Plan"); return; }
    if (t.dataset && t.dataset.priotick != null) { planPrio[+t.dataset.priotick][1] = t.checked ? 1 : 0; renderPrio(); return; }
    if (t.id === "check-from" || t.id === "check-kind") { if (sysId("check-from")) runChecker(null); return; }
    if (t.id === "chart-from" || t.id === "chart-reach" || t.id === "chart-ly" || t.id === "chart-n") { if (chartOn) runChart(); return; }
    if (t.id === "chart-only") { chartMarks(); if (!t.checked && sf) sf.dimStars(false); return; }
    if (t.id === "chart-show") { if (chartOn) drawChart(); return; }
    if (t.dataset && t.dataset.poi && poiOn) { if (t.checked) poiOn.add(t.dataset.poi); else poiOn.delete(t.dataset.poi); poiSave(); drawStars(); drawPoi(); return; }
    if (t.id === "roads-from" || t.id === "roads-to") route();
  });

  // the page loads its data the first time it is shown
  const seen = () => { if (root.hidden) return; if (!loaded) { loaded = true; load(false); } else if (M) { drawMap(); drawStars(); } };
  // the map is redrawn whenever its pane changes width (window resize, the side menu folding, a late layout)
  let rz = 0, lastW = 0; const redraw = () => { clearTimeout(rz); rz = setTimeout(() => { const w = $("roads-map").clientWidth; if (M && !root.hidden && Math.abs(w - lastW) > 1) { lastW = w; drawMap(); } }, 120); };
  if (window.ResizeObserver) new ResizeObserver(redraw).observe($("roads-map")); else window.addEventListener("resize", redraw);
  new MutationObserver(seen).observe(root, { attributes: true, attributeFilter: ["hidden"] }); seen();
  document.addEventListener("visibilitychange", () => { if (!document.hidden && M) locPoll(); });
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
  window.__roadsCheckClick = id => checkClick(id);   /* tests: what a map click on any star does while Check a jump is open */
  window.__roadsMapClick = id => checkClick(id) || planClick(id);   // tests: what a map click on a star does first (the same path as onPick / onPickStar)
  window.__roadsPoi = () => ({ on: poiOn ? [...poiOn] : null, n: POI ? POI.categories.length : 0 });   /* tests */
  window.__roadsNav = (nav, pairs) => { NAV = nav; if (pairs) gatePairs = pairs; drawLoc(); return $("roads-me").innerText; };   /* tests */
  window.__roadsField = f => { FIELD = Object.assign({ survey: {}, visited: {}, rifts: [] }, f || {}); drawSurveyBtn(); drawStars(); drawDetail(); return Object.keys(FIELD.survey).length; };   /* tests */
  window.__roadsPlaces = d => { PLACES = { home: d.home || null, marks: d.marks || [] }; drawStars(); drawLoc(); drawDetail(); return PLACES; };   /* tests */
  window.__roadsLoc = d => { LOC = d; drawStars(); drawLoc(); return locOf(d && d.me && d.me.s); };   /* tests */
  window.__roadsPick = id => { selected = null; picked = id; drawDetail(); return $("roads-detail").hidden ? null : $("roads-detail").innerText; };   // tests: what a click on any star says
})();
