/* Sites (/sites): every kind of site in ONE table, the game's own figures only. 2026-10-20, user: "a table ... if I
   see a site on the map, I hover over it and I see the name" (search by name), then "I just want to make sure that we're
   not lying to anybody. We need more data before we start making statements": no ratings, no levels, no verdicts;
   the raw spawn-point counts of each layout and the game's own design name. Data: window.SITES_DATA from
   sites-data.js (tools/export_sites_data.py). Kept ASCII: special characters as \u escapes. */
(function () {
  "use strict";
  var D = window.SITES_DATA; if (!D) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DOT = " \u00b7 ", DASH = "\u2014";
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

  function row(s) {
    var open = !!state.open[s.name], hasText = !!s.game;
    var h = "<tr>"
      + '<th scope="row">' + (hasText ? '<button type="button" class="st-name" data-open="' + esc(s.name) + '" aria-expanded="' + open + '">' + esc(s.name) + '<span class="st-i">' + (open ? "\u2212" : "+") + "</span></button>" : '<span class="st-name plain">' + esc(s.name) + "</span>") + '<span class="st-sub">' + esc(s.design || "") + (s.belt ? DOT + esc(s.belt) : "") + "</span></th>"
      + '<td class="num">' + (s.galaxy ? s.galaxy.toLocaleString("en-US") : DASH) + "</td>"
      + '<td class="num">' + (s.systems ? s.systems.toLocaleString("en-US") : DASH) + "</td>"
      + '<td class="num">' + num(s.spawns.resource) + "</td>"
      + '<td class="num">' + num(s.spawns.npc) + "</td>"
      + '<td class="num">' + num(s.spawns.threat) + "</td>"
      + '<td class="num">' + num(s.spawns.event) + "</td>"
      + "<td>" + (s.fixed.length ? s.fixed.map(esc).join("<br>") : DASH) + "</td></tr>";
    if (open && hasText) h += '<tr class="st-text"><td colspan="8"><blockquote>' + esc(s.game) + "</blockquote></td></tr>";
    return h;
  }
  function draw() {
    var q = norm(state.q), list = D.sites.filter(function (s) { return matches(s, q); }).sort(cmp);
    $("st-body").innerHTML = list.length ? list.map(row).join("") : '<tr><td colspan="8" class="st-empty">No site by that name. Check the spelling, or type just one word of it.</td></tr>';
    $("st-count").textContent = q ? list.length + " of " + D.sites.length : D.sites.length + " kinds of site";
    var ths = document.querySelectorAll("#st-table th[data-sort]");
    for (var i = 0; i < ths.length; i++) { var k = ths[i].getAttribute("data-sort"); ths[i].setAttribute("aria-sort", k === state.sort ? (state.dir > 0 ? "ascending" : "descending") : "none"); }
  }
  function init() {
    if (!$("st-body")) return;
    document.querySelector("#st-table thead").addEventListener("click", function (e) {
      var th = e.target.closest("th[data-sort]"); if (!th) return;
      var k = th.getAttribute("data-sort");
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = /^(resource|npc|threat|event)$/.test(k) ? -1 : 1; }
      keep(); draw();
    });
    $("st-body").addEventListener("click", function (e) { var b = e.target.closest("button[data-open]"); if (!b) return; var n = b.getAttribute("data-open"); state.open[n] = !state.open[n]; draw(); });
    $("st-find").addEventListener("input", function () { state.q = this.value; draw(); });
    var p = String(D.generated).split("-");
    $("st-foot").textContent = D.sites.length + " kinds of site" + DOT + "client build " + D.build + DOT + "data of " + (+p[2]) + " " + MON[+p[1] - 1] + " " + p[0];
    draw();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
