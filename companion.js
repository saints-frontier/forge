/* The Companion page: the companion key (moved from the Quarry, 2026-10-19). The key is fetched from /api/appkey with
   the tribe login (tribe.js shares the login as window.__tribeData and the event "tribe:data"). */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function drawKeyBox() {
    const out = $("c-keyout"); if (!out) return;
    const t = window.__tribeData;
    if (!(t && t.state === "in")) return;                          // logged out: the login link stays (it comes back here)
    if (out.querySelector("#c-keyin")) return;                     // a key is on screen: keep it
    out.innerHTML = `<button type="button" class="c-btn" id="c-getkey">✠ Get my companion key</button><div class="c-keynote">Logged in as ${esc(t.me && t.me.name || "")}. A new key replaces your old one.</div>`;
  }
  document.addEventListener("click", async e => {
    if (!e.target.closest("#c-getkey,#c-copykey")) return;
    const out = $("c-keyout");
    if (e.target.closest("#c-copykey")) { const i = $("c-keyin"); i.select(); try { await navigator.clipboard.writeText(i.value); $("c-copykey").textContent = "copied"; } catch (x) { $("c-copykey").textContent = "press Ctrl+C"; } return; }
    try {
      const r = await fetch("/api/appkey", { credentials: "same-origin", cache: "no-store" }); const d = r.ok ? await r.json() : null;
      if (!d || !d.ok) throw new Error(r.status === 401 ? "log in again" : "the site did not answer");
      out.innerHTML = `<div class="c-keyrow"><input id="c-keyin" readonly value="${esc(d.key)}" aria-label="Your companion key"><button type="button" class="c-btn" id="c-copykey">copy</button></div>`
        + `<div class="c-keynote">Valid until ${esc(d.expires)}. Paste it into the companion's page under <b>Send to Mining</b> → <b>Save key</b>. Keep it to yourself: it sends sessions as you.</div>`;
      try { await navigator.clipboard.writeText(d.key); $("c-copykey").textContent = "copied"; } catch (x) {}
    } catch (x) { out.insertAdjacentHTML("beforeend", `<div class="c-keynote">No key: ${esc(x.message)}.</div>`); }
  });
  window.addEventListener("tribe:data", drawKeyBox);
  drawKeyBox();
})();
