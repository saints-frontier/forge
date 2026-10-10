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
                + '<button type="button" class="tribe-up" id="tribe-manage" title="Rename or remove doctrine fits">manage</button>'
                + '<label class="tribe-up" title="Replace every doctrine fit with an exported doctrine-payload.json">upload file<input type="file" accept="application/json,.json" hidden></label>' : "")
      + '<a class="tribe-out" href="/api/logout">log out</a>';
    var who = box.querySelector(".tribe-who");
    function note(t) { var n = box.querySelector(".tribe-note"); if (!n) { n = document.createElement("span"); n.className = "tribe-note"; who.after(n); } n.textContent = t ? " · " + t : ""; }
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
    // reading and writing the store, the same way for every action: only a 503 counts as an empty store, any other
    // read error stops the write (never write over what could not be read); the whole payload goes back
    function readStore() {
      return fetch("/api/doctrine", { credentials: "same-origin" }).then(function (r) {
        if (r.ok) return r.json();
        if (r.status === 503) return { presets: [] };
        throw new Error("doctrine store answered " + r.status);
      }).then(function (d) { if (!d || !Array.isArray(d.presets)) throw new Error("doctrine store returned no list"); return d; });
    }
    function writeStore(d, what) {
      d.generated = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); d.updated_by = me.name;
      note("saving…");
      return fetch("/api/doctrine", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) })
        .then(function (r) { return r.json().then(function (x) { return { ok: r.ok, x: x }; }); })
        .then(function (res) { if (res.ok) { note(what + ": " + res.x.fits + " doctrine fits. Reloading…"); setTimeout(function () { location.reload(); }, 900); } else note("not saved: " + (res.x && res.x.error || "error")); });
    }
    // "manage": the list of doctrine fits with rename (name + role) and remove on every row (user 2026-10-09)
    var modal = null;
    function openManage() {
      if (!modal) {
        modal = document.createElement("div"); modal.className = "modal"; modal.id = "tribemodal";
        modal.innerHTML = '<div class="mbox tribe-mbox" role="dialog" aria-label="Doctrine fits"><div class="mhead"><span class="mt">Doctrine fits</span><span class="ms" id="tribe-mstat"></span><button type="button" id="tribe-mclose">Close</button></div><div class="tribe-list" id="tribe-list"></div></div>';
        document.body.appendChild(modal);
        modal.querySelector("#tribe-mclose").addEventListener("click", function () { modal.hidden = true; document.body.style.overflow = ""; });
        modal.querySelector("#tribe-list").addEventListener("click", function (e) {
          var b = e.target.closest("button[data-ren], button[data-del]"); if (!b) return;
          var n = +(b.dataset.ren || b.dataset.del), del = !!b.dataset.del;
          readStore().then(function (d) {
            var i = -1; d.presets.forEach(function (p, k) { if (+p.n === n) i = k; });
            if (i < 0) { note("that fit is no longer in the store"); return; }
            var p = d.presets[i];
            if (del) {
              if (!window.confirm("Remove the doctrine fit \"" + p.name + "\" (" + p.hull + ")? Every Saint loses it at their next login.")) return;
              d.presets.splice(i, 1);
              return writeStore(d, p.name + " removed");
            }
            var name = window.prompt("New name for \"" + p.name + "\":", p.name); if (name == null) return; name = name.trim();
            if (!name) { note("the name cannot be empty"); return; }
            if (d.presets.some(function (q, k) { return k !== i && String(q.name).toLowerCase() === name.toLowerCase(); })) { note("another doctrine fit is already called " + name); return; }
            var role = window.prompt("Role line for " + name + " (shown in the Load fit list):", p.role || ""); if (role == null) return;
            if (name === p.name && role.trim() === (p.role || "")) { note("nothing changed"); return; }
            p.name = name; p.role = role.trim();
            return writeStore(d, name + " renamed");
          }).catch(function (e) { note("not saved: " + (e && e.message || "could not reach the doctrine store")); });
        });
      }
      modal.hidden = false; document.body.style.overflow = "hidden";
      var list = modal.querySelector("#tribe-list"); list.innerHTML = '<div class="trow"><span class="tn">reading the doctrine store…</span></div>';
      readStore().then(function (d) {
        modal.querySelector("#tribe-mstat").textContent = d.presets.length + " fits" + (d.generated ? " · " + d.generated : "") + (d.updated_by ? " · last change by " + d.updated_by : "");
        list.innerHTML = d.presets.length ? d.presets.map(function (p) {
          return '<div class="trow"><span class="tn">' + esc(p.name) + '</span><span class="th">' + esc(p.hull) + (p.role ? " · " + esc(p.role) : "") + '</span><button type="button" class="tribe-up" data-ren="' + esc(p.n) + '">rename</button><button type="button" class="tribe-up" data-del="' + esc(p.n) + '">remove</button></div>';
        }).join("") : '<div class="trow"><span class="tn">The store is empty. Set a fit as doctrine to start it.</span></div>';
      }).catch(function (e) { list.innerHTML = '<div class="trow"><span class="tn">' + esc(e && e.message || "could not reach the doctrine store") + '</span></div>'; });
    }
    if (knight) box.querySelector("#tribe-manage").addEventListener("click", openManage);
    if (knight) box.querySelector("#tribe-set").addEventListener("click", function () {
      var fit = window.__forgeCurrentFit && window.__forgeCurrentFit();
      if (!fit || !fit.placements || !fit.placements.length) { note("open a fit in the Forge first"); return; }
      var base = String(fit.name || "").replace(/^\+|\+$/g, "").replace(/ proposal$/i, "").trim();
      var name = window.prompt("Doctrine name for this fit (an existing name replaces that fit):", base);
      if (!name || !name.trim()) return; name = name.trim();
      note("reading the doctrine…");
      fetch("/api/doctrine", { credentials: "same-origin" }).then(function (r) {
        if (r.ok) return r.json();
        if (r.status === 503) return { presets: [] };                       // the store is empty: the first fit starts it
        throw new Error("doctrine store answered " + r.status);          // anything else: do not write over what we could not read
      }).then(function (d) {
        if (!d || !Array.isArray(d.presets)) throw new Error("doctrine store returned no list");
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
      }).catch(function (e) { note("not saved: " + (e && e.message || "could not reach the doctrine store")); });
    });
    return fetch("/api/doctrine", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.presets && window.__forgeAddPresets) {
        var n = 0; try { n = window.__forgeAddPresets(d.presets); } catch (e) { n = -1; }
        note(n < 0 ? "the doctrine store holds a broken fit: upload a fresh export" : n + " doctrine fits loaded" + (n < d.presets.length ? " (" + (d.presets.length - n) + " skipped)" : ""));
      }
      else if (!d) note(knight ? "doctrine store empty: set a fit as doctrine, or upload the export" : "doctrine store not ready");
    });
  }).catch(function () { loggedOut(""); });
})();
