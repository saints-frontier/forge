/* Sites (/sites): every kind of site, what may be there and what the Saints found there (user 2026-10-20).
   Data: window.SITES_DATA from sites-data.js (python tools/export_sites_data.py). Kept ASCII: special characters as
   \u escapes. */
(function () {
  "use strict";
  var D = window.SITES_DATA; if (!D) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var day = function (iso) { var p = String(iso).split("-"); return p.length === 3 ? (+p[2]) + " " + MON[+p[1] - 1] : esc(iso); };
  var nf = function (n) { return Number(n).toLocaleString("en-US"); };
  var DOT = " · ";
  var state = { group: "all", q: "" };
  try { var s = JSON.parse(localStorage.getItem("sites:view") || "{}"); if (s.group) state.group = s.group; } catch (e) {}
  var keep = function () { try { localStorage.setItem("sites:view", JSON.stringify({ group: state.group })); } catch (e) {} };
  /* client info only since 2026-10-20: the export carries no sightings; these stay empty unless OUR_DATA comes back */
  D.sites.forEach(function (s) { s.seen = s.seen || []; s.rocks = s.rocks || []; s.foes = s.foes || []; s.loot = s.loot || []; });

  function text(site) {                                   // everything a search can match on a card
    var t = [site.name, site.place, site.belt, site.game].concat(site.rocks, site.foes, site.fixed);
    site.seen.forEach(function (x) { t.push(x.text); });
    site.loot.forEach(function (l) { t.push(l.from); for (var k in l.items) t.push(k); });
    return t.join(" ").toLowerCase();
  }
  function tag(word, label, kind) { return '<span class="st-tag ' + kind + '">' + esc(label) + ": " + esc(word) + "</span>"; }
  function card(site) {
    var visited = site.seen.length && !site.mapOnly, ours = site.seen.length || site.rocks.length || site.loot.length;
    var where = [site.place, site.belt].filter(Boolean).join(DOT);
    var placeNote = site.place && D.places[site.place] ? D.places[site.place] : "";
    var h = '<article class="st-card' + (visited || !ours ? "" : " unseen") + '"><h4>' + esc(site.name) + "</h4>";
    if (where) h += '<div class="st-where">' + esc(where) + (placeNote ? DOT + esc(placeNote) : "") + "</div>";
    var tags = [];
    if (!site.noLevels) {
      tags.push(tag(site.rockSpots, "Rocks", site.rockSpots === "none" ? "calm" : "good"));
      tags.push(tag(site.hostiles, "Hostiles", site.hostiles === "none expected" ? "calm" : (site.hostiles === "a few" ? "" : "warn")));
    }
    site.fixed.forEach(function (f) { tags.push('<span class="st-tag good">' + esc(f) + "</span>"); });
    if (tags.length) h += '<div class="st-tags">' + tags.join("") + "</div>";
    if (site.game) {
      var short = site.game.length > 190 ? site.game.slice(0, site.game.lastIndexOf(" ", 180)) + "…" : "";
      h += '<blockquote class="st-game" data-full="' + esc(site.game) + '">' + esc(short || site.game) + (short ? ' <button type="button" data-more>more</button>' : "") + "</blockquote>";
    }
    if (site.rocks.length) h += '<div class="st-sub">Rocks found</div><div class="st-tags">' + site.rocks.map(function (r) { return '<a class="st-tag good" href="/mining" title="What ' + esc(r) + ' gives, on Mining">' + esc(r) + "</a>"; }).join("") + "</div>";
    if (site.foes.length) h += '<div class="st-sub">Met here</div><div class="st-tags">' + site.foes.map(function (f) { return '<span class="st-tag warn">' + esc(f) + "</span>"; }).join("") + "</div>";
    if (site.seen.length && !site.mapOnly) {
      h += '<div class="st-sub">' + (visited ? "What the Saints found" : "Seen") + '</div><ul class="st-seen">';
      site.seen.forEach(function (x) { h += "<li><time datetime=\"" + esc(x.date) + "\">" + day(x.date) + "</time><span>" + esc(x.text) + "</span></li>"; });
      h += "</ul>";
    }
    site.loot.forEach(function (l) {
      var items = Object.keys(l.items).map(function (k) { return "<li>" + nf(l.items[k]) + "x " + esc(k) + "</li>"; }).join("");
      h += '<div class="st-loot"><b>Looted from ' + esc(l.from) + "</b>" + DOT + day(l.date) + "<ul>" + items + "</ul></div>";
    });
    if (ours && !visited) h += '<p class="st-none">' + (site.mapOnly ? "Seen on a system map, not visited by the Saints yet." : "Not visited by the Saints yet.") + "</p>";
    return h + "</article>";
  }
  function draw() {
    var q = state.q.trim().toLowerCase(), out = "", shown = 0;
    D.groups.forEach(function (g) {
      if (state.group !== "all" && state.group !== g.key) return;
      var list = D.sites.filter(function (s) { return s.group === g.key && (!q || text(s).indexOf(q) >= 0); });
      if (!list.length) return;
      shown += list.length;
      out += '<section class="st-group"><h3>' + esc(g.title) + "</h3><p>" + esc(g.note) + '</p><div class="st-grid">' + list.map(card).join("") + "</div></section>";
    });
    $("st-list").innerHTML = out || '<p class="st-empty">No site matches that.</p>';
    var bs = $("st-groups").querySelectorAll("button");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-pressed", String(bs[i].getAttribute("data-g") === state.group));
  }
  function init() {
    if (!$("st-list")) return;
    var chips = '<button type="button" data-g="all">All</button>' + D.groups.map(function (g) { return '<button type="button" data-g="' + esc(g.key) + '">' + esc(g.title) + "</button>"; }).join("");
    $("st-groups").innerHTML = chips;
    $("st-groups").addEventListener("click", function (e) { var b = e.target.closest("button[data-g]"); if (!b) return; state.group = b.getAttribute("data-g"); keep(); draw(); });
    $("st-find").addEventListener("input", function () { state.q = this.value; draw(); });
    $("st-list").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-more]"); if (!b) return;
      var q = b.closest(".st-game"); q.textContent = q.getAttribute("data-full");
    });
    $("st-foot").textContent = D.sites.length + " kinds of site" + DOT + "client build " + D.build + DOT + "data of " + day(D.generated) + " " + String(D.generated).slice(0, 4);
    draw();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.__sitesDraw = draw;
})();
