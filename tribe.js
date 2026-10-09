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
      + (knight ? '<label class="tribe-up" title="Replace the doctrine fits with an exported doctrine-payload.json">update doctrine<input type="file" accept="application/json,.json" hidden></label>' : "")
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
    return fetch("/api/doctrine", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.presets && window.__forgeAddPresets) { window.__forgeAddPresets(d.presets); note(d.presets.length + " doctrine fits loaded"); }
      else if (!d) note(knight ? "doctrine store empty: use update doctrine" : "doctrine store not ready");
    });
  }).catch(function () { loggedOut(""); });
})();
