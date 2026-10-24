/* Sites (/sites): every kind of site in ONE table, the game's own figures only. 2026-10-20, user: "a table ... if I
   see a site on the map, I hover over it and I see the name" (search by name), then "I just want to make sure that we're
   not lying to anybody. We need more data before we start making statements": no ratings, no levels, no verdicts;
   the raw spawn-point counts of each layout and the game's own design name. Data: window.SITES_DATA from
   sites-data.js (tools/export_sites_data.py). 2026-10-24 (user: "merge that in to the sites page"): the
   Frontier Belt Sites page merged in: a site's name opens its layouts drawn top-down and the named structures it can hold,
   and "All named structures" shows the client's renders (window.SITES_LAYOUTS from sites-layouts.js,
   tools/export_sites_layouts.py; pictures in site-renders/). Kept ASCII: special characters as \u escapes. */
(function () {
  "use strict";
  var D = window.SITES_DATA; if (!D) return;
  var LY = window.SITES_LAYOUTS || { belts: [], sites: {}, gallery: [] };
  var BELT = {}; LY.belts.forEach(function (b) { BELT[b.name] = b; });
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DOT = " \u00b7 ", DASH = "\u2014", TIMES = "\u00d7", RANGE = "\u2013";
  var RENDERS = (document.body && document.body.getAttribute("data-site-renders")) || "site-renders/";
  D.sites.forEach(function (s) { s.spawns = s.spawns || {}; });

  var COLS = { name: 1, design: 1, belt: 1, galaxy: 1, systems: 1, resource: 1, npc: 1, threat: 1, event: 1, fixed: 1 };
  var state = { sort: "name", dir: 1, q: "", open: {} };
  try { var sv = JSON.parse(localStorage.getItem("sites:raw") || "{}"); if (sv.sort && COLS[sv.sort]) { state.sort = sv.sort; state.dir = sv.dir === -1 ? -1 : 1; } } catch (e) {}
  var keep = function () { try { localStorage.setItem("sites:raw", JSON.stringify({ sort: state.sort, dir: state.dir })); } catch (e) {} };

  /* a name typed from the in-game map: case, extra spaces and missing words do not matter */
  var norm = function (t) { return String(t).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); };
  function matches(s, q) { if (!q) return true; var n = norm(s.name); return q.split(" ").every(function (w) { return n.indexOf(w) >= 0; }); }
  var KEY = {
    name: function (s) { return s.name.toLowerCase(); },
    design: function (s) { return (s.design || "").toLowerCase(); },
    belt: function (s) { return s.belt || "~"; },
    galaxy: function (s) { return s.galaxy || 0; },
    systems: function (s) { return s.systems || 0; },
    resource: function (s) { return s.spawns.resource || 0; },
    npc: function (s) { return s.spawns.npc || 0; },
    threat: function (s) { return s.spawns.threat || 0; },
    event: function (s) { return s.spawns.event || 0; },
    fixed: function (s) { return s.fixed.length ? s.fixed.join(" ") : "~"; }
  };
  function cmp(a, b) { var x = KEY[state.sort](a), y = KEY[state.sort](b); if (x < y) return -state.dir; if (x > y) return state.dir; return a.name < b.name ? -1 : 1; }
  var num = function (v) { return v ? String(v) : '<span class="st-zero">0</span>'; };
  var fmt = function (n) { return Number(n).toLocaleString("en-US"); };

  /* ---------- one layout, drawn from above: the site's spawn points and objects (x / z in km) ---------- */
  var KIND = { entry: "Entry beacon", event: "Event spawner (loot cans, events)", resource: "Resource spawner", threat: "Threat spawner", npc: "NPC spawner", dock: "Dock / fuel point", terminal: "Terminal", mega: "Landmark", other: "Landmark", can: "Fixed container" };
  function plot(s) {
    var W = 320, H = 240, pad = 14, r = Math.max(1, s.r), sc = (Math.min(W, H) / 2 - pad) / r, cx = W / 2, cy = H / 2;
    var X = function (x) { return (cx + x * sc).toFixed(1); }, Y = function (z) { return (cy - z * sc).toFixed(1); };
    var g = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Layout seen from above, ' + s.r + ' km across from the centre">';
    g += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * sc).toFixed(1) + '" class="ly-ring"/><circle cx="' + cx + '" cy="' + cy + '" r="' + (r * sc / 2).toFixed(1) + '" class="ly-ring d"/>';
    g += '<line x1="' + cx + '" y1="' + pad / 2 + '" x2="' + cx + '" y2="' + (H - pad / 2) + '" class="ly-ax"/><line x1="' + pad / 2 + '" y1="' + cy + '" x2="' + (W - pad / 2) + '" y2="' + cy + '" class="ly-ax"/>';
    (s.pts || []).forEach(function (p) { g += '<circle cx="' + X(p[0]) + '" cy="' + Y(p[1]) + '" r="1.3" class="ly-hull"/>'; });
    var order = ["entry", "mega", "other", "resource", "event", "npc", "threat", "can", "dock", "terminal"];
    (s.marks || []).slice().sort(function (a, b) { return order.indexOf(a[0]) - order.indexOf(b[0]); }).forEach(function (m) {
      var k = m[0], px = +X(m[1]), py = +Y(m[2]), t = "<title>" + esc(m[3] || KIND[k] || k) + "</title>";
      if (k === "event") g += '<rect x="' + (px - 3.5) + '" y="' + (py - 3.5) + '" width="7" height="7" transform="rotate(45 ' + px + " " + py + ')" class="ly-event">' + t + "</rect>";
      else if (k === "resource") g += '<rect x="' + (px - 3) + '" y="' + (py - 3) + '" width="6" height="6" class="ly-res">' + t + "</rect>";
      else if (k === "threat" || k === "npc") g += '<path d="M' + px + " " + (py - 4.5) + " L" + (px + 4.5) + " " + (py + 4) + " L" + (px - 4.5) + " " + (py + 4) + ' Z" class="ly-threat">' + t + "</path>";
      else if (k === "can") g += '<circle cx="' + px + '" cy="' + py + '" r="3.6" class="ly-can">' + t + "</circle>";
      else if (k === "dock") g += '<circle cx="' + px + '" cy="' + py + '" r="5" class="ly-dock">' + t + "</circle>";
      else if (k === "terminal") g += '<path d="M' + px + " " + (py - 7) + " L" + (px + 1.8) + " " + (py - 1.8) + " L" + (px + 7) + " " + py + " L" + (px + 1.8) + " " + (py + 1.8) + " L" + px + " " + (py + 7) + " L" + (px - 1.8) + " " + (py + 1.8) + " L" + (px - 7) + " " + py + " L" + (px - 1.8) + " " + (py - 1.8) + ' Z" class="ly-term">' + t + "</path>";
      else if (m[3] === "Point of Interest") g += '<g class="ly-poi">' + t + '<circle cx="' + px + '" cy="' + py + '" r="4.5"/><line x1="' + (px - 7) + '" y1="' + py + '" x2="' + (px + 7) + '" y2="' + py + '"/><line x1="' + px + '" y1="' + (py - 7) + '" x2="' + px + '" y2="' + (py + 7) + '"/></g>';
      else if (k === "mega" || k === "other") g += '<circle cx="' + px + '" cy="' + py + '" r="4" class="ly-mega">' + t + "</circle>";
      else if (k === "entry") g += '<circle cx="' + px + '" cy="' + py + '" r="3.5" class="ly-entry">' + t + "</circle>";
    });
    var bar = r >= 300 ? 100 : r >= 80 ? 50 : r >= 25 ? 10 : 5;
    g += '<line x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (pad + bar * sc).toFixed(1) + '" y2="' + (H - pad) + '" class="ly-bar"/><text x="' + pad + '" y="' + (H - pad - 5) + '" class="ly-km">' + bar + " km</text>";
    return g + "</svg>";
  }
  function layoutCard(ref) {
    var s = LY.sites[ref.d]; if (!s) return "";
    var title = s.name || (s.named || []).filter(function (n) { return /Megastructure|Outpost|Armory|Depot|Dock|Prefab/i.test(n); })[0] || "Layout " + ref.d;
    var sp = s.sp || {}, rows = [];
    rows.push(["Structure", s.pieces ? fmt(s.pieces) + " scenery pieces" : "no scenery pieces"]);
    rows.push(["Size", s.r + " km from the centre"]);
    var tn = (sp.threat || 0) + (sp.npc || 0), spawn = [sp.event && sp.event + " event", sp.resource && sp.resource + " resource", tn && tn + " threat / NPC"].filter(Boolean).join(DOT);
    if (spawn) rows.push(["Spawn points", spawn]);
    var cans = Object.keys(s.cans || {}); if (cans.length) rows.push(["Containers", cans.map(function (n) { return s.cans[n] + TIMES + " " + esc(n); }).join(", ")]);
    if (sp.terminal) rows.push(["Special", '<span class="ly-hl">Terminal</span>: takes Calamitous Marrow and gives a reward']);
    if (sp.dock) rows.push(["Special", sp.dock + " dock / fuel point" + (sp.dock > 1 ? "s" : "")]);
    var named = (s.named || []).filter(function (n, i, a) { return a.indexOf(n) === i && !/Fueling|Docking/i.test(n); });
    if (named.length) rows.push(["Landmarks", named.map(esc).join(", ")]);
    var n = ref.min === ref.max ? ref.min : ref.min + RANGE + ref.max;
    return '<article class="ly-card">' + plot(s) + '<div class="ly-body"><div class="ly-title"><b>' + esc(title) + "</b><span>#" + ref.d + '</span></div><span class="ly-tag ' + (ref.kind === "ruin" ? "ruin" : "nat") + '">' + (ref.kind === "ruin" ? "ruin layout" : "natural layout") + DOT + n + " per site</span>"
      + '<dl class="ly-rows">' + rows.map(function (r) { return "<dt>" + r[0] + "</dt><dd>" + r[1] + "</dd>"; }).join("") + "</dl></div></article>";
  }
  function figure(x, full) {
    var lines = [];
    if (x.aka && x.aka.length) lines.push("<small>Also: " + x.aka.map(esc).join(", ") + "</small>");
    if (full) {
      lines.push("<small>" + (x.belts.length ? "In: " + x.belts.map(esc).join(", ") : "In no site layout") + "</small>");
      if (x.used && x.used.length) lines.push("<small>Other places: " + x.used.map(esc).join(", ") + "</small>");
    }
    return '<figure class="ly-fig"><img src="' + RENDERS + esc(x.img) + '" alt="' + esc(x.name) + ', the game\'s render" loading="lazy"><figcaption><b>' + esc(x.name) + "</b>" + lines.join("") + "</figcaption></figure>";
  }
  var span = function (r) { return r[0] === r[1] ? String(r[0]) : r[0] + RANGE + r[1]; };
  var LEGEND = '<div class="ly-legend"><span><i class="k event"></i>event spawner (loot cans, events)</span><span><i class="k res"></i>resource spawner</span><span><i class="k threat"></i>threat / NPC spawner</span><span><i class="k can"></i>fixed container</span><span><i class="k dock"></i>dock / fuel point</span><span><i class="k term"></i>Terminal</span><span><i class="k mega"></i>landmark</span><span><i class="k entry"></i>entry beacon</span></div>';
  function detail(s) {
    var b = BELT[s.name], h = "";
    if (s.game) h += "<blockquote>" + esc(s.game) + "</blockquote>";
    if (b) {
      var named = LY.gallery.filter(function (x) { return x.belts.indexOf(s.name) >= 0; });
      h += '<p class="ly-note">Each ' + esc(s.name) + " rolls " + span(b.nb) + " ruin layout" + (b.nb[1] === 1 ? "" : "s") + " and " + span(b.nn) + " natural layout" + (b.nn[1] === 1 ? "" : "s") + " from the cards below, so two of them with the same name hold different things. Where each layout sits around the entry beacon is decided by the server; distances inside a layout are the game's.</p>";
      if (named.length) h += '<h4 class="ly-h">Named structures you can meet here' + DOT + named.length + '</h4><div class="ly-gal">' + named.map(function (x) { return figure(x, false); }).join("") + "</div>";
      var ruins = b.sites.filter(function (r) { return r.kind === "ruin"; }), nat = b.sites.filter(function (r) { return r.kind !== "ruin"; });
      if (ruins.length || nat.length) h += LEGEND;
      if (ruins.length) h += '<h4 class="ly-h">Ruin layouts' + DOT + ruins.length + '</h4><div class="ly-grid">' + ruins.map(layoutCard).join("") + "</div>";
      if (nat.length) h += '<h4 class="ly-h">Natural layouts' + DOT + nat.length + '</h4><div class="ly-grid">' + nat.map(layoutCard).join("") + "</div>";
    }
    return h || '<p class="ly-note">Nothing more on this one yet.</p>';
  }
  function gallery() {
    var g = LY.gallery, kinds = g.map(function (x) { return x.kind; }).filter(function (k, i, a) { return a.indexOf(k) === i; });
    return '<p class="ly-note">The game client\'s own pictures of every named structure, with the sites that can hold it. Many ruins are also built from hundreds of unnamed pieces with no picture.</p>'
      + kinds.map(function (k) { var l = g.filter(function (x) { return x.kind === k; }); return '<h4 class="ly-h">' + esc(k) + DOT + l.length + '</h4><div class="ly-gal big">' + l.map(function (x) { return figure(x, true); }).join("") + "</div>"; }).join("");
  }

  function row(s) {
    var open = !!state.open[s.name], more = !!(s.game || BELT[s.name]);
    var h = "<tr" + (open ? ' class="st-open"' : "") + ">"
      + '<th scope="row">' + (more ? '<button type="button" class="st-name" data-open="' + esc(s.name) + '" aria-expanded="' + open + '">' + esc(s.name) + '<span class="st-i">' + (open ? "\u2212" : "+") + "</span></button>" : '<span class="st-name plain">' + esc(s.name) + "</span>") + '<span class="st-sub">' + esc(s.design || "") + (s.belt ? DOT + esc(s.belt) : "") + "</span></th>"
      + '<td class="num">' + (s.galaxy ? fmt(s.galaxy) : DASH) + "</td>"
      + '<td class="num">' + (s.systems ? fmt(s.systems) : DASH) + "</td>"
      + '<td class="num">' + num(s.spawns.resource) + "</td>"
      + '<td class="num">' + num(s.spawns.npc) + "</td>"
      + '<td class="num">' + num(s.spawns.threat) + "</td>"
      + '<td class="num">' + num(s.spawns.event) + "</td>"
      + "<td>" + (s.fixed.length ? s.fixed.map(esc).join("<br>") : DASH) + "</td></tr>";
    if (open && more) h += '<tr class="st-text"><td colspan="8"><div class="ly-wrap">' + detail(s) + "</div></td></tr>";
    return h;
  }
  function draw() {
    var q = norm(state.q), list = D.sites.filter(function (s) { return matches(s, q); }).sort(cmp);
    $("st-body").innerHTML = list.length ? list.map(row).join("") : '<tr><td colspan="8" class="st-empty">No site by that name. Check the spelling, or type just one word of it.</td></tr>';
    $("st-count").textContent = q ? list.length + " of " + D.sites.length : D.sites.length + " kinds of site";
    var ths = document.querySelectorAll("#st-table th[data-sort]");
    for (var i = 0; i < ths.length; i++) { var k = ths[i].getAttribute("data-sort"); ths[i].setAttribute("aria-sort", k === state.sort ? (state.dir > 0 ? "ascending" : "descending") : "none"); }
    var gs = $("st-gallery"), gh = $("st-galhead");   /* always shown (user 2026-10-24: "lets not hide named structures") */
    if (gs && !gs.innerHTML && LY.gallery.length) { gs.innerHTML = gallery(); if (gh) gh.textContent = "Named structures" + DOT + LY.gallery.length; }
    if (gh) gh.hidden = !LY.gallery.length;
  }
  function init() {
    if (!$("st-body")) return;
    document.querySelector("#st-table thead").addEventListener("click", function (e) {
      var th = e.target.closest("th[data-sort]"); if (!th) return;
      var k = th.getAttribute("data-sort");
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = /^(galaxy|systems|resource|npc|threat|event)$/.test(k) ? -1 : 1; }
      keep(); draw();
    });
    $("st-body").addEventListener("click", function (e) { var b = e.target.closest("button[data-open]"); if (!b) return; var n = b.getAttribute("data-open"); state.open[n] = !state.open[n]; draw(); });
    $("st-find").addEventListener("input", function () { state.q = this.value; draw(); });
    try { var qs = new URLSearchParams(location.search), want = qs.get("site"); if (want) D.sites.forEach(function (x) { if (norm(x.name) === norm(want)) state.open[x.name] = true; }); if (qs.get("structures")) setTimeout(function () { var g = $("st-galhead"); if (g) g.scrollIntoView(); }, 50); } catch (e) {}   /* /sites?site=Outer%20Vestiges opens that site */
    var p = String(D.generated).split("-");
    $("st-foot").textContent = D.sites.length + " kinds of site" + DOT + "client build " + D.build + DOT + "data of " + (+p[2]) + " " + MON[+p[1] - 1] + " " + p[0];
    draw();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
