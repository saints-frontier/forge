/* Saints Forge, public site: THINKING MACHINES (/machines). The Saints' own turret code (frontier-onchain/saints_turret)
   installed on a member's turrets, behind the tribe login (user 2026-10-17). Reads the public Sui testnet; every change
   is a transaction the member signs in EVE Vault; no key is ever held here. The page holds nothing private: the lock
   only keeps the tool for the tribe. The package ids and the helper's address are filled in by tools/build_forge_public.py from
   frontier-onchain/deploy/packages.json. */
import { connect, signAndExecute, simulate, characterOf, turretsOf, installTx, removeTx, runsSaints, parseSettings, suiBalance } from "./saints-chain.js?v=bde582e9";

// opened by the game with a turret id (the Custom dApp link set to /machines): that is the turret panel
if (/[?&]itemId=/i.test(location.search)) location.replace("/turret" + location.search);
const PKG = "0x2c8c37e9dc3658d899f75dde149f798901e17a37fb07c5a01709dc450f970950";
const OLDER = [];
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = $("tab-machines");
let me = null, char = null, turrets = [];

function lock(kind, msg) {
  $("s-body").hidden = true; $("s-lock").hidden = false; $("s-who").textContent = "";
  $("s-lockbody").innerHTML = kind === "denied"
    ? "<p>Your Discord account is not of rank Saint or above on The Saints' server. Ask in Discord.</p>"
    : kind === "checking" ? "<p>Checking who you are…</p>"
    : "<p>The Saints' own code for our turrets. Log in with Discord to use it.</p>" + (msg ? '<p class="d-msg">' + esc(msg) + "</p>" : "")
      + '<a class="d-login" href="/api/login?next=machines">✠ Log in with Discord</a>';
}
function gate(td) {
  if (td.state === "denied") return lock("denied");
  if (td.state !== "in") return lock(td.state === "out" ? "out" : "checking", td.msg);
  $("s-lock").hidden = true; $("s-body").hidden = false;
  $("s-who").textContent = td.me ? "✠ " + td.me.name + " · " + td.me.rank : "";
}

function describe(s) {
  const n = (k, w) => s[k].length ? `${s[k].length} ${w}` : "";
  return `${s.found ? "" : "no settings line, so "}<b>${s.mode}</b>` + ["f", "e", "p", "x"].map((k, i) => n(k, ["allied tribe(s)", "enemy tribe(s)", "friendly pilot(s)", "enemy pilot(s)"][i])).filter(Boolean).map(t => " · " + t).join("");
}
function codeOf(t) {
  if (runsSaints(t, PKG)) return "saints";
  if (OLDER.some(p => runsSaints(t, p))) return "older";
  return t.extension ? "other" : "default";
}
function draw() {
  if (!turrets.length) { $("s-list").innerHTML = '<p class="s-dim">This character owns no turret on the chain yet. Anchor one, bring it online, then press ↻.</p>'; return; }
  $("s-list").innerHTML = '<div class="s-wrap"><table class="s-list"><tr><th>Turret</th><th>State</th><th>Code</th><th>Settings</th><th></th></tr>' + turrets.map((t, i) => {
    const c = codeOf(t);
    const code = { saints: '<span class="s-ok">Saints</span>', older: '<span class="s-warn">Saints, older version</span>', other: '<span class="s-warn">someone else\'s code</span>', default: '<span class="s-dim">game default</span>' }[c];
    const act = c === "saints" ? `<button type="button" class="d-btn" data-rm="${i}">Remove</button>`
      : `<button type="button" class="d-btn s-go" data-in="${i}">${{ older: "Update", other: "Replace with Saints", default: "Install" }[c]}</button>`;
    return `<tr><td><b>${esc(t.name || "Turret")}</b><div class="s-id">${esc(t.id.slice(0, 10))}…</div></td><td>${t.online ? "online" : "offline"}</td><td>${code}</td>`
      + `<td>${describe(parseSettings(t.description))}</td><td>${act}<div class="s-msg" id="s-msg${i}"></div></td></tr>`;
  }).join("") + "</table></div>";
}
async function load() {
  $("s-list").innerHTML = '<p class="s-dim">Reading the chain…</p>';
  char = await characterOf(me.account.address);
  if (!char) { $("s-list").innerHTML = '<p class="s-bad">No EVE Frontier character belongs to this wallet.</p>'; return; }
  turrets = await turretsOf(char.id); draw();
}
async function wallet() {
  const bal = await suiBalance(me.account.address);
  $("s-wallet").innerHTML = `<code>${esc(me.account.address.slice(0, 10))}…</code> · ${bal.toFixed(3)} SUI`
    + (bal < 0.02 ? ' · <span class="s-warn">needs a little SUI: Faucet test SUI in EVE Vault</span>' : "")
    + ' <button type="button" class="d-btn" id="s-reload" title="Read the chain again">↻</button>';
}
$("s-connect").addEventListener("click", async () => {
  try { me = await connect(); await wallet(); await load(); }
  catch (e) { $("s-wallet").innerHTML = `<span class="s-bad">${esc(e.message)}</span>`; }
});
page.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.id === "s-reload") { try { await wallet(); await load(); } catch (x) { $("s-list").innerHTML = `<p class="s-bad">${esc(x.message)}</p>`; } return; }
  if (!(b.dataset.in || b.dataset.rm)) return;
  const i = +(b.dataset.in || b.dataset.rm), t = turrets[i], out = $("s-msg" + i);
  const make = () => b.dataset.in ? installTx(PKG, char.id, t) : removeTx(char.id, t);
  b.disabled = true; out.textContent = "checking…";
  try {
    const sim = await simulate(make(), me.account.address);
    const st = (sim.Transaction || sim.FailedTransaction || {}).effects?.status;
    if (st && !st.success) throw new Error("the chain would refuse it: " + JSON.stringify(st.error || st).slice(0, 200));
    out.textContent = "waiting for EVE Vault…";
    const res = await signAndExecute(me, make());
    out.innerHTML = `<span class="s-ok">done</span>`;
    setTimeout(() => load().catch(() => {}), 2500);
  } catch (x) { out.innerHTML = `<span class="s-bad">${esc(x.message)}</span>`; b.disabled = false; }
});
const tryIt = () => { $("s-tryout").innerHTML = describe(parseSettings($("s-try").value)); };
$("s-try").addEventListener("input", tryIt); tryIt();
window.addEventListener("tribe:data", () => gate(window.__tribeData || {}));
const onSite = /thesaintsforge\.com$/.test(location.hostname);
gate(window.__tribeData || (onSite ? { state: "checking" } : { state: "out", msg: "Thinking Machines open on thesaintsforge.com." }));
window.__machinesTest = async address => { me = { account: { address } }; await load(); return turrets.map(t => ({ name: t.name, code: codeOf(t), desc: t.description })); };   // read-only test hook
