/* Saints Forge, public site: the tribe box in the Forge's top bar. Logged out: a "log in with Discord" link. Logged
   in (Squire or above): the member's name and rank, a log-out link, and the doctrine fits added to the preset list
   (fetched from /api/doctrine, which only answers a valid session). Only on thesaintsforge.com: the GitHub mirror has
   no /api. */
(function () {
  var box = document.getElementById("tribe");
  if (!box || !/thesaintsforge\.com$/.test(location.hostname)) return;
  var q = new URLSearchParams(location.search).get("tribe");
  if (q) history.replaceState(null, "", location.pathname + location.hash);
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function loggedOut(msg) {
    box.innerHTML = (msg ? '<span class="tribe-msg">' + esc(msg) + "</span>" : "") + '<a class="tribe-btn" href="/api/login">✠ Tribe fits · log in with Discord</a>';
  }
  fetch("/api/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
    if (!me || !me.ok) {
      loggedOut(q === "denied" ? "Saint rank or above needed. Ask in Discord." : q === "error" ? "The login did not go through. Try again." : "");
      return;
    }
    var knight = !!me.upload;                       // Paladins, Knights and the site keepers (DOCTRINE_ADMINS) may replace the fits
    box.innerHTML = '<span class="tribe-who">✠ ' + esc(me.name) + " · " + esc(me.rank) + '</span>'
      + (knight ? '<button type="button" class="tribe-up" id="tribe-set" title="Make the fit on screen a doctrine fit: it replaces the doctrine fit of the same name, or is added as a new one">set as doctrine</button>'
                + '<label class="tribe-up" title="Replace every doctrine fit with an exported doctrine-payload.json">upload file<input type="file" accept="application/json,.json" hidden></label>' : "")
      + '<a class="tribe-out" href="/api/logout">log out</a>';
    var who = box.querySelector(".tribe-who");
    function note(t) { var n = box.querySelector(".tribe-note"); if (!n) { n = document.createElement("span"); n.className = "tribe-note"; who.after(n); } n.textContent = " · " + t; }
    if (knight) box.querySelector(".tribe-up input").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      note("uploading " + f.name + "…");
      f.text().then(function (text) { return fetch("/api/doctrine", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: text }); })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) { if (x.ok) { note(x.d.fits + " doctrine fits stored. Reloading…"); setTimeout(function () { location.reload(); }, 900); } else note("not stored: " + (x.d && x.d.error || "error")); })
        .catch(function () { note("upload failed"); });
    });
    // "Set as doctrine" (Paladins, Knights, site keepers): the fit on screen goes into the store under a doctrine name,
    // replacing the fit of that name or joining the list as a new one. The store is the tribe's copy; the toolkit's
    // registry is brought in line from it afterwards.
    if (knight) box.querySelector("#tribe-set").addEventListener("click", function () {
      var fit = window.__forgeCurrentFit && window.__forgeCurrentFit();
      if (!fit || !fit.placements || !fit.placements.length) { note("open a fit in the Forge first"); return; }
      var base = String(fit.name || "").replace(/^\+|\+$/g, "").replace(/ proposal$/i, "").trim();
      var name = window.prompt("Doctrine name for this fit (an existing name replaces that fit):", base);
      if (!name || !name.trim()) return; name = name.trim();
      note("reading the doctrine…");
      fetch("/api/doctrine", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (!d || !d.presets) d = { presets: [] };
        var i = -1; d.presets.forEach(function (p, k) { if (String(p.name).toLowerCase() === name.toLowerCase()) i = k; });
        var old = i >= 0 ? d.presets[i] : null;
        var role = old ? old.role : (window.prompt("Role, as shown in the Load fit list (e.g. Warship · Stealth and Ambush):", "") || "");
        if (!window.confirm((old ? "Replace the doctrine fit \"" + name + "\"" : "Add \"" + name + "\" as a new doctrine fit") + " with the " + fit.placements.length + " modules on screen (" + fit.hull + ")? Every Saint sees it at their next login.")) { note(""); return; }
        var maxN = 100; d.presets.forEach(function (p) { if (+p.n > maxN) maxN = +p.n; });
        var p = { n: old ? old.n : maxN + 1, name: name, hull: fit.hull, role: role, doctrine: true, placements: fit.placements, exterior: fit.exterior || {}, carried: old && old.carried ? old.carried : {} };
        if (old) d.presets[i] = p; else d.presets.push(p);
        d.generated = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
        d.updated_by = me.name;
        note("saving " + name + "…");
        return fetch("/api/doctrine", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) })
          .then(function (r) { return r.json().then(function (x) { return { ok: r.ok, x: x }; }); })
          .then(function (res) { if (res.ok) { note(name + (old ? " replaced" : " added") + ": " + res.x.fits + " doctrine fits. Reloading…"); setTimeout(function () { location.reload(); }, 900); } else note("not saved: " + (res.x && res.x.error || "error")); });
      }).catch(function () { note("could not reach the doctrine store"); });
    });
    return fetch("/api/doctrine", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.presets && window.__forgeAddPresets) { window.__forgeAddPresets(d.presets); note(d.presets.length + " doctrine fits loaded"); }
      else if (!d) note(knight ? "doctrine store empty: set a fit as doctrine, or upload the export" : "doctrine store not ready");
    });
  }).catch(function () { loggedOut(""); });
})();
