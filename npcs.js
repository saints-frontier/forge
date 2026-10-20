/* NPCs (/npcs): the drones and towers that guard the Frontier (user 2026-10-20, under Guides).
   Data: window.NPCS_DATA from npcs-data.js (python tools/export_npcs_data.py). Kept ASCII: special characters as
   \u escapes. */
(function () {
  "use strict";
  var D = window.NPCS_DATA; if (!D) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var nf = function (n) { return Number(n).toLocaleString("en-US"); };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DOT = " · ", DASH = "—";
  var state = { fam: "all", met: false, q: "" };
  try { var s = JSON.parse(localStorage.getItem("npcs:view") || "{}"); if (s.fam) state.fam = s.fam; state.met = !!s.met; } catch (e) {}
  var keep = function () { try { localStorage.setItem("npcs:view", JSON.stringify({ fam: state.fam, met: state.met })); } catch (e) {} };
  var met = function (n) { return !!(n.met.length || n.fought); };
  function text(n) { return [n.name, n.game].concat(n.met, n.notes, n.drops).join(" ").toLowerCase(); }
  function stat(label, value, hot) { return '<div class="np-stat' + (hot ? " hot" : "") + '"><span>' + esc(label) + "</span><b>" + value + "</b></div>"; }
  function card(n) {
    var h = '<article class="np-card' + (met(n) ? "" : " unmet") + '"><h4>' + esc(n.name) + "</h4>";
    h += '<div class="np-stats">'
      + stat("Toughness", nf(n.tough), n.tough >= 3000)
      + stat("Speed", n.speed ? nf(n.speed) + " m/s" : "never moves")
      + stat("Fights within", n.fightsWithin != null ? n.fightsWithin + " km" : DASH)
      + stat("Locks you from", n.locks != null ? n.locks + " km" : DASH)
      + "</div>";
    if (n.repairs) h += '<div class="np-tags"><span class="np-tag">Repairs itself in a fight</span></div>';
    if (n.game) {
      var short = n.game.length > 170 ? n.game.slice(0, n.game.lastIndexOf(" ", 160)) + "…" : "";
      h += '<blockquote class="np-game" data-full="' + esc(n.game) + '">' + esc(short || n.game) + (short ? ' <button type="button" data-more>more</button>' : "") + "</blockquote>";
    }
    if (n.fight) {
      var f = n.fight;
      h += '<div class="np-sub">In our fights</div><p class="np-fight">About <b>' + nf(f.avgHit) + "</b> a hit, a shot every " + f.every + " s, " + f.hitRate + "% of its shots landed" + DOT + f.fights + (f.fights === 1 ? " fight" : " fights") + ".</p>";
    }
    else if (n.fought) h += '<div class="np-sub">In our fights</div><p class="np-fight">Met in ' + n.fought + (n.fought === 1 ? " fight" : " fights") + ", too few shots to tell how hard it hits.</p>";
    if (n.killedAt) h += '<p class="np-small">One took about ' + nf(n.killedAt) + " damage to kill" + (n.killedAt > n.tough * 1.3 ? ", more than its toughness: it repairs while you shoot." : ".") + "</p>";
    if (n.met.length) h += '<div class="np-sub">Where we met it</div><ul class="np-list">' + n.met.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>";
    if (n.notes.length) h += '<div class="np-sub">Good to know</div><ul class="np-list">' + n.notes.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>";
    if (n.drops.length) h += '<div class="np-sub">Dropped</div><div class="np-tags">' + n.drops.map(function (d) { return '<span class="np-tag">' + esc(d) + "</span>"; }).join("") + "</div>" + (n.dropsNote ? '<p class="np-small">' + esc(n.dropsNote) + "</p>" : "");
    if (!met(n)) h += '<p class="np-none">Not met by the Saints yet.</p>';
    return h + "</article>";
  }
  function draw() {
    var q = state.q.trim().toLowerCase(), out = "";
    D.families.forEach(function (fm) {
      if (state.fam !== "all" && state.fam !== fm.key) return;
      var list = D.npcs.filter(function (n) { return n.family === fm.key && (!state.met || met(n)) && (!q || text(n).indexOf(q) >= 0); });
      if (!list.length) return;
      out += '<section class="np-fam"><h3>' + esc(fm.title) + "</h3><p>" + esc(fm.note) + '</p><div class="np-grid">' + list.map(card).join("") + "</div></section>";
    });
    $("np-list").innerHTML = out || '<p class="np-empty">No NPC matches that.</p>';
    var bs = $("np-fams").querySelectorAll("button");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-pressed", String(bs[i].getAttribute("data-f") === state.fam));
  }
  function init() {
    if (!$("np-list")) return;
    $("np-fams").innerHTML = '<button type="button" data-f="all">All</button>' + D.families.map(function (f) { return '<button type="button" data-f="' + esc(f.key) + '">' + esc(f.title) + "</button>"; }).join("");
    $("np-fams").addEventListener("click", function (e) { var b = e.target.closest("button[data-f]"); if (!b) return; state.fam = b.getAttribute("data-f"); keep(); draw(); });
    $("np-met").checked = state.met;
    $("np-met").addEventListener("change", function () { state.met = this.checked; keep(); draw(); });
    $("np-find").addEventListener("input", function () { state.q = this.value; draw(); });
    $("np-list").addEventListener("click", function (e) { var b = e.target.closest("button[data-more]"); if (!b) return; var q = b.closest(".np-game"); q.textContent = q.getAttribute("data-full"); });
    var p = String(D.generated).split("-");
    $("np-foot").textContent = D.npcs.length + " NPCs" + DOT + D.npcs.filter(met).length + " met by the Saints" + DOT + "client build " + D.build + DOT + "data of " + (+p[2]) + " " + MON[+p[1] - 1] + " " + p[0];
    draw();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
