/* NPCs (/npcs): every drone and guard tower in ONE table, the game's own numbers only. 2026-10-20, user: "Just the
   stuff that we know from the game client", then "I just want to make sure that we're not lying to anybody. We need
   more data before we start making statements": no ratings or verdicts, the game's figures under neutral names.
   Data: window.NPCS_DATA from npcs-data.js (tools/export_npcs_data.py). Kept ASCII: special characters as \u escapes. */
(function () {
  "use strict";
  var D = window.NPCS_DATA; if (!D) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var nf = function (n) { return Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 }); };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DOT = " \u00b7 ", DASH = "\u2014";
  var KIND = {}; D.families.forEach(function (f, i) { KIND[f.key] = { title: f.title, i: i }; });
  D.npcs.forEach(function (n) { n.kind = (KIND[n.family] || {}).title || ""; });

  var COLS = { name: 1, tough: 1, hit: 1, speed: 1, within: 1, locks: 1, repairs: 1 };
  var state = { sort: "name", dir: 1, q: "", open: {} };
  try { var sv = JSON.parse(localStorage.getItem("npcs:raw") || "{}"); if (sv.sort && COLS[sv.sort]) { state.sort = sv.sort; state.dir = sv.dir === -1 ? -1 : 1; } } catch (e) {}
  var keep = function () { try { localStorage.setItem("npcs:raw", JSON.stringify({ sort: state.sort, dir: state.dir })); } catch (e) {} };

  var norm = function (t) { return String(t).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); };
  function matches(n, q) { if (!q) return true; var s = norm(n.name); return q.split(" ").every(function (w) { return s.indexOf(w) >= 0; }); }
  var KEY = {
    name: function (n) { return n.name.toLowerCase(); },
    tough: function (n) { return n.tough; },
    hit: function (n) { return n.hit; },
    speed: function (n) { return n.speed; },
    within: function (n) { return n.fightsWithin == null ? -1 : n.fightsWithin; },
    locks: function (n) { return n.locks == null ? -1 : n.locks; },
    repairs: function (n) { return n.repairs ? 1 : 0; }
  };
  function cmp(a, b) { var x = KEY[state.sort](a), y = KEY[state.sort](b); if (x < y) return -state.dir; if (x > y) return state.dir; return a.name < b.name ? -1 : 1; }
  var unit = function (v, u) { return v == null ? DASH : nf(v) + '<span class="np-unit"> ' + u + "</span>"; };

  function row(n) {
    var open = !!state.open[n.name], hasText = !!n.game;
    var h = "<tr>"
      + '<th scope="row">' + (hasText ? '<button type="button" class="np-name" data-open="' + esc(n.name) + '" aria-expanded="' + open + '">' + esc(n.name) + '<span class="np-i">' + (open ? "\u2212" : "+") + "</span></button>" : '<span class="np-name plain">' + esc(n.name) + "</span>") + '<span class="np-kind">' + esc(n.kind) + "</span></th>"
      + '<td class="num">' + nf(n.tough) + "</td>"
      + '<td class="num">' + (n.hit ? nf(n.hit) : "0") + "</td>"
      + '<td class="num">' + unit(n.speed, "m/s") + "</td>"
      + '<td class="num">' + unit(n.fightsWithin, "km") + "</td>"
      + '<td class="num">' + unit(n.locks, "km") + "</td>"
      + "<td>" + (n.repairs ? "yes" : "no") + "</td></tr>";
    if (open && hasText) h += '<tr class="np-text"><td colspan="7"><blockquote>' + esc(n.game) + "</blockquote></td></tr>";
    return h;
  }
  function draw() {
    var q = norm(state.q), list = D.npcs.filter(function (n) { return matches(n, q); }).sort(cmp);
    $("np-body").innerHTML = list.length ? list.map(row).join("") : '<tr><td colspan="7" class="np-empty">No NPC by that name. Check the spelling, or type just one word of it.</td></tr>';
    $("np-count").textContent = q ? list.length + " of " + D.npcs.length : D.npcs.length + " NPCs";
    var ths = document.querySelectorAll("#np-table th[data-sort]");
    for (var i = 0; i < ths.length; i++) { var k = ths[i].getAttribute("data-sort"); ths[i].setAttribute("aria-sort", k === state.sort ? (state.dir > 0 ? "ascending" : "descending") : "none"); }
  }
  function init() {
    if (!$("np-body")) return;
    document.querySelector("#np-table thead").addEventListener("click", function (e) {
      var th = e.target.closest("th[data-sort]"); if (!th) return;
      var k = th.getAttribute("data-sort");
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === "name" ? 1 : -1; }
      keep(); draw();
    });
    $("np-body").addEventListener("click", function (e) { var b = e.target.closest("button[data-open]"); if (!b) return; var n = b.getAttribute("data-open"); state.open[n] = !state.open[n]; draw(); });
    $("np-find").addEventListener("input", function () { state.q = this.value; draw(); });
    var p = String(D.generated).split("-");
    $("np-foot").textContent = D.npcs.length + " NPCs" + DOT + "client build " + D.build + DOT + "data of " + (+p[2]) + " " + MON[+p[1] - 1] + " " + p[0];
    draw();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
