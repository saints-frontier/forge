/* Saints Forge, public site: THE DOCTRINE page (/doctrine). Every doctrine ship as its card, for Saints of rank Saint
   and above (user 2026-10-16). This file holds no fit and no card words: the fits come from /api/doctrine and the
   words from /api/cards, both of which answer only a logged-in Saint; tribe.js fetches them once for the whole site
   and hands them over (window.__tribeData + the "tribe:data" event). Each card is drawn in the browser by cardgen.js
   (the doctrine-card design), with the live numbers of the stored fit, and shown as an image (an SVG of its own, so
   the cards' gradient ids never collide). */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var page = $("tab-doctrine");
  if (!page) return;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  function roman(s) { s = String(s || "").toUpperCase(); var n = 0; for (var i = 0; i < s.length; i++) { var v = ROMAN[s[i]], w = ROMAN[s[i + 1]]; if (!v) return 999; n += w > v ? -v : v; } return n || 999; }
  var urls = [], shown = { key: "" }, cards = [], current = -1;

  function lock(kind, msg) {
    $("d-grid").hidden = true; $("d-lock").hidden = false; $("d-who").textContent = "";
    var here = "/api/login?next=doctrine";
    var body = kind === "denied"
      ? "<p>Your Discord account holds no Saints rank on The Saints' server (Squire or above). Ask in Discord.</p>"
      : kind === "checking" ? "<p>Checking who you are…</p>"
      : "<p>The doctrine ships are the tribe's own. Log in with Discord to see them: Squire rank or above.</p>" + (msg ? '<p class="d-msg">' + esc(msg) + "</p>" : "") + '<a class="d-login" href="' + here + '">✠ Log in with Discord</a>';
    $("d-lockbody").innerHTML = body;
  }

  function wordsFor(cardsByName, name) {
    if (!cardsByName) return null;
    if (cardsByName[name]) return cardsByName[name];
    var low = String(name).toLowerCase();                              // the store may hold a name in other capitals (OXEN)
    for (var k in cardsByName) if (k.toLowerCase() === low) return cardsByName[k];
    return null;
  }

  function draw(td) {
    var me = td.me, fits = td.fits, words = td.cards && td.cards.cards;
    if (td.state === "denied" || td.doctrineDenied) return lock("denied");
    if (td.state !== "in") return lock(td.state === "out" ? "out" : "checking", td.msg);
    $("d-lock").hidden = true;
    $("d-who").textContent = me ? "✠ " + me.name + " · " + me.rank : "";
    if (!window.ForgeCard || !window.FORGE_CARD || !window.FORGE_DATA) { $("d-status").textContent = "The card design did not load: reload the page."; return; }
    if (!fits) { $("d-status").textContent = td.fitsError || "Reading the doctrine…"; return; }
    var key = JSON.stringify([fits.length, fits.map(function (p) { return p.name + p.placements.length; }), Object.keys(words || {}).length]);
    if (key === shown.key) return;
    shown.key = key;
    urls.forEach(function (u) { URL.revokeObjectURL(u); }); urls = [];
    var K = window.FORGE_CARD, D = window.FORGE_DATA; K.text = K.text || {};
    var fonts = window.ForgeCard.fontCss();
    cards = [];
    fits.forEach(function (p, i) {
      if (!p || !D.hulls[p.hull]) return;
      var sound = window.__forgeSoundFit ? window.__forgeSoundFit(p) : { placements: p.placements, exterior: p.exterior || {} };
      if (!sound) return;
      var w = wordsFor(words, p.name), n = 9000 + i;                  // a private number for this page's copy of the words
      if (!w) return;                                                 // only ships whose card is written (user 2026-10-20: one by one)
      K.text[n] = w;
      var counts = {}; sound.placements.forEach(function (x) { counts[x[0]] = (counts[x[0]] || 0) + 1; });
      var t = window.ForgeCard.texts({ preset: w ? { n: n } : null, counts: counts, exterior: sound.exterior, name: p.name, hull: p.hull, dirty: false, diff: [] });
      if (!w) { t.title = p.name; t.role = p.role || t.role; t.why = "The card words for this fit are not in the store yet."; }
      var opts = { hull: p.hull, hullData: D.hulls[p.hull], placements: sound.placements, exterior: sound.exterior, text: t, sigil: (w && w.sigil) || "✠", eyebrow: "SAINTS DOCTRINE · SHIP FITS", fonts: fonts };
      var svg; try { svg = window.ForgeCard.build(opts); } catch (e) { return; }
      var url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" })); urls.push(url);
      cards.push({ name: p.name, title: t.title || p.name, role: t.role || p.role || "", hull: p.hull, sigil: opts.sigil, order: roman(opts.sigil), url: url, svg: svg });
    });
    cards.sort(function (a, b) { return a.order - b.order || a.name.localeCompare(b.name); });
    var grid = $("d-grid");
    grid.innerHTML = cards.map(function (c, i) {
      return '<figure class="d-card"><button type="button" class="d-img" data-view="' + i + '" aria-label="' + esc(c.title) + ' card, larger"><img src="' + c.url + '" alt="' + esc(c.title) + ' doctrine card" decoding="async" width="1920" height="1200"></button>'
        + '<figcaption><span class="d-name"><b>' + esc(c.title) + '</b><i>' + esc(c.role) + " · " + esc(c.hull) + "</i></span>"
        + '<span class="d-acts"><button type="button" class="d-btn" data-build="' + i + '" title="Every module of this fit as a build list in the Building Calculator">⚒ Import into the Building Calculator</button><button type="button" class="d-btn d-build" data-link="' + i + '" title="Copy a link that opens this fit in the Fitting Tool">🔗 Copy fit link</button><button type="button" class="d-btn" data-forge="' + i + '">Open in the Fitting Tool</button><button type="button" class="d-btn" data-png="' + i + '">Save PNG</button></span></figcaption></figure>';
    }).join("");
    grid.hidden = !cards.length;
    $("d-status").textContent = cards.length ? (cards.length === 1 ? "1 doctrine ship" : cards.length + " doctrine ships") + ", drawn from the tribe store. More join as their cards are finished." : (fits.length ? "No doctrine card is finished yet." : "The doctrine store holds no fits yet.");
  }

  function savePng(i, btn) {
    var c = cards[i]; if (!c) return;
    var label = btn ? btn.textContent : ""; if (btn) { btn.disabled = true; btn.textContent = "Rendering…"; }
    window.ForgeCard.toPng(c.svg, 1.5).then(function (png) {
      var a = document.createElement("a"); a.href = URL.createObjectURL(png);
      a.download = String(c.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-saints-card.png";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }).catch(function () { $("d-status").textContent = "The PNG could not be made here: right-click the card and save the image instead."; })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = label; } });
  }
  function openForge(i) {
    var c = cards[i]; if (!c) return;
    if (window.__forgeLoadByName && window.__forgeLoadByName(c.name) && window.__siteGo) { closeView(); window.__siteGo("forge"); }
    else $("d-status").textContent = "The Forge has not loaded " + c.title + " yet: open the Forge and pick it from the list.";
  }
  // Fit link (user 2026-10-20: "I care more about the fitting app link"): the fit is loaded into the Fitting Tool, its
  // link (a short /f/ link on the site) is copied and shown under the cards as a link anyone in the tribe can open
  function copyLink(i, btn) {
    var c = cards[i]; if (!c) return;
    if (!(window.__forgeLoadByName && window.__forgeLoadByName(c.name) && window.__forgeLinkNow)) { $("d-status").textContent = "The Fitting Tool has not loaded " + c.title + " yet: try again in a moment."; return; }
    var p = window.__forgeLinkNow(), label = btn ? btn.textContent : "";
    var show = function (link) {
      var st = $("d-status"); st.textContent = c.title + ": ";
      var a = document.createElement("a"); a.href = link; a.textContent = link.replace(/^https?:\/\//, ""); a.target = "_blank"; a.rel = "noopener"; st.appendChild(a);
      if (btn) { btn.textContent = "Link copied"; setTimeout(function () { btn.textContent = label; }, 2500); }
    };
    var done = false;
    try { if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) { navigator.clipboard.write([new ClipboardItem({ "text/plain": p.then(function (l) { return new Blob([l], { type: "text/plain" }); }) })]).then(function () { done = true; }).catch(function () {}); } } catch (e) {}
    p.then(function (l) { if (!done && navigator.clipboard) navigator.clipboard.writeText(l).catch(function () {}); show(l); }).catch(function () { $("d-status").textContent = "The link could not be made: open the fit in the Fitting Tool and press Share there."; });
  }
  // Build it: the fit into the Fitting Tool, then every module as a goal into the Building Calculator (its own hand-off)
  function openBuild(i) {
    var c = cards[i]; if (!c) return;
    if (window.__forgeLoadByName && window.__forgeLoadByName(c.name) && window.__forgeBuildIt && window.__forgeBuildIt()) closeView();
    else $("d-status").textContent = "The Building Calculator could not take " + c.title + " yet: open it in the Fitting Tool and press Build it there.";
  }
  function view(i) {
    var c = cards[i]; if (!c) return; current = i;
    $("d-view-img").src = c.url; $("d-view-img").alt = c.title + " doctrine card";
    $("d-view").hidden = false; document.body.style.overflow = "hidden"; $("d-view-close").focus();
  }
  function closeView() { if ($("d-view").hidden) return; $("d-view").hidden = true; document.body.style.overflow = ""; current = -1; }

  page.addEventListener("click", function (e) {
    var b = e.target.closest("[data-view],[data-forge],[data-link],[data-build],[data-png],#d-view-close,#d-view-prev,#d-view-next,#d-view-forge,#d-view-link,#d-view-build,#d-view-png");
    if (!b) { if (e.target.id === "d-view") closeView(); return; }
    if (b.hasAttribute("data-view")) view(+b.getAttribute("data-view"));
    else if (b.hasAttribute("data-forge")) openForge(+b.getAttribute("data-forge"));
    else if (b.hasAttribute("data-build")) openBuild(+b.getAttribute("data-build"));
    else if (b.hasAttribute("data-link")) copyLink(+b.getAttribute("data-link"), b);
    else if (b.hasAttribute("data-png")) savePng(+b.getAttribute("data-png"), b);
    else if (b.id === "d-view-close") closeView();
    else if (b.id === "d-view-prev") view((current - 1 + cards.length) % cards.length);
    else if (b.id === "d-view-next") view((current + 1) % cards.length);
    else if (b.id === "d-view-forge") openForge(current);
    else if (b.id === "d-view-build") openBuild(current);
    else if (b.id === "d-view-link") copyLink(current, b);
    else if (b.id === "d-view-png") savePng(current, b);
  });
  document.addEventListener("keydown", function (e) {
    if ($("d-view").hidden) return;
    if (e.key === "Escape") closeView();
    else if (e.key === "ArrowLeft") view((current - 1 + cards.length) % cards.length);
    else if (e.key === "ArrowRight") view((current + 1) % cards.length);
  });

  window.addEventListener("tribe:data", function () { draw(window.__tribeData || {}); });
  // tribe.js only talks to /api on the site itself; anywhere else (the GitHub mirror, a local build) the page stays locked
  var onSite = /thesaintsforge\.com$/.test(location.hostname);
  draw(window.__tribeData || { state: onSite ? "checking" : "out", msg: onSite ? "" : "The doctrine opens on thesaintsforge.com." });
  window.__doctrineDraw = draw;                                       // test hook: draw({state: "in", me, fits, cards})
})();
