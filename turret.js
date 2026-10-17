/* The in-game panel of a Saints turret (thesaintsforge.com/turret). The game opens a turret's Custom dApp link with the
   turret's in-game item id (?itemId=...&tenant=stillness); this page finds the turret on chain, shows its state to
   anyone, and lets its OWNER switch the mode (war / peace / hold) and edit the four lists. Every change rewrites the
   turret's description in one transaction the owner signs in their wallet; the wallet proves ownership, so the panel
   needs no tribe login. No key is ever held here. The package ids and the helper's address are filled in by
   tools/build_forge_public.py from frontier-onchain/deploy/packages.json (user 2026-10-17: "build it"). */
import { connect, suiWallets, signAndExecute, simulate, characterOf, turretsOf, turretById, objectIdOf, installTx, describeTx, runsSaints, parseSettings } from "./saints-chain.js?v=3b61e9ff";

const PKG = "0x2c8c37e9dc3658d899f75dde149f798901e17a37fb07c5a01709dc450f970950";
const OLDER = [];
const MAX_LEN = 100;                      // the game's description box takes 100 characters
const U32 = 4294967295;
const LISTS = [
  { k: "f", label: "Allied tribes", hint: "spared unless they attack the base", what: "tribe id" },
  { k: "e", label: "Enemy tribes", hint: "always shot", what: "tribe id" },
  { k: "p", label: "Ally pilots", hint: "never shot", what: "character id" },
  { k: "x", label: "Enemy pilots", hint: "always shot, even a Saint", what: "character id" },
];
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const q = new URLSearchParams(location.search);

let turret = null;            // what the chain says
let saved = null;             // its settings as stored
let draft = null;             // the owner's unsaved edits
let me = null, char = null, mine = null;   // wallet, its character, this turret with its owner key when the wallet owns it
let busy = false;

function codeOf(t) {
  if (runsSaints(t, PKG)) return "saints";
  if (OLDER.some(p => runsSaints(t, p))) return "older";
  return t.extension ? "other" : "default";
}
function blockOf(s) {
  return "[SAINTS " + [s.mode].concat(LISTS.filter(l => s[l.k].length).map(l => l.k + "=" + s[l.k].join(","))).join(" ") + "]";
}
/** The description with its settings block replaced (or added in front); every other word stays. */
function withSettings(desc, s) {
  const d = String(desc || ""), low = d.toLowerCase(), at = low.indexOf("[saints"), block = blockOf(s);
  if (at < 0) return d.trim() ? block + " " + d.trim() : block;
  const end = low.indexOf("]", at);
  return d.slice(0, at) + block + (end < 0 ? "" : d.slice(end + 1));
}
const copy = s => ({ mode: s.mode, f: s.f.slice(), e: s.e.slice(), p: s.p.slice(), x: s.x.slice() });
const same = (a, b) => a.mode === b.mode && LISTS.every(l => a[l.k].join() === b[l.k].join());

function say(text, cls) { const m = $("t-msg"); if (m) { m.className = "msg " + (cls || ""); m.textContent = text; } }

function render() {
  if (!turret) return;
  const code = codeOf(turret), owner = !!mine, s = draft || saved;
  $("t-name").textContent = turret.name || "Saints turret";
  $("t-chips").innerHTML = [
    turret.online ? '<span class="chip ok">online</span>' : '<span class="chip off">offline</span>',
    { saints: '<span class="chip ok">Saints code</span>', older: '<span class="chip warn">Saints code · older version</span>', other: '<span class="chip warn">someone else\'s code</span>', default: '<span class="chip warn">game default targeting</span>' }[code],
    owner ? '<span class="chip ok">you own it</span>' : "",
  ].join("");
  document.querySelectorAll(".mode").forEach(b => {
    b.classList.toggle("on", b.dataset.mode === s.mode);
    b.disabled = !owner || busy;
    b.classList.toggle("busy", busy);
    b.title = owner ? "Switch the turret to " + b.dataset.mode : "Only the turret's owner can switch it";
  });
  const n = LISTS.reduce((a, l) => a + s[l.k].length, 0);
  $("t-count").textContent = n ? n + " id" + (n > 1 ? "s" : "") : "";
  $("t-lists").innerHTML = LISTS.map(l => {
    const ids = s[l.k].map(v => `<span class="id${saved[l.k].includes(v) ? "" : " new"}">${v}${owner ? `<button type="button" data-del="${l.k}:${v}" title="Remove">×</button>` : ""}</span>`).join("");
    const add = owner ? `<span class="add"><input inputmode="numeric" placeholder="${l.what}" aria-label="Add a ${esc(l.what)} to ${esc(l.label)}" data-add="${l.k}"><button type="button" data-addbtn="${l.k}">Add</button></span>` : "";
    return `<div class="row"><div class="lab">${esc(l.label)}<small>${l.k}= · ${esc(l.hint)}</small></div><div class="ids">${ids || (owner ? "" : '<span class="none">none</span>')}${add}</div></div>`;
  }).join("");
  const dirty = draft && !same(draft, saved), text = withSettings(turret.description, s);
  $("t-save").hidden = !dirty;
  $("t-meter").textContent = text.length + " / " + MAX_LEN + " characters" + (text.length > MAX_LEN ? ": too long, remove an id" : "");
  $("t-meter").classList.toggle("over", text.length > MAX_LEN);
  $("t-commit").disabled = busy || text.length > MAX_LEN;
  renderOwn(code);
}

function renderOwn(code) {
  const box = $("t-own"), msg = $("t-msg") ? $("t-msg").outerHTML : '<div class="msg" id="t-msg"></div>';
  let body;
  if (!me) {
    body = `<div>The owner can switch the mode and edit the lists here. Each change is one small transaction (about 0.002 test SUI) signed in your wallet. Editing the description in the game stays free.</div>`
      + `<div class="acts"><button type="button" class="btn go" id="t-connect">Connect wallet</button></div>`;
  } else if (!mine) {
    body = `<div>Your wallet${char && char.name ? " (" + esc(char.name) + ")" : ""} does not own this turret: only its owner can change it.</div>`;
  } else if (code !== "saints") {
    body = `<div>${code === "default" ? "This turret still uses the game's default targeting." : code === "older" ? "This turret runs an older version of the Saints code." : "This turret runs someone else's code."} Install the Saints code so the mode and lists take effect. It starts in peace.</div>`
      + `<div class="acts"><button type="button" class="btn go" id="t-install">${code === "older" ? "Update the Saints code" : "Install the Saints code"}</button></div>`;
  } else {
    body = `<div>Press a mode to switch it, or edit a list and save. Your wallet asks you to sign each change.</div>`;
  }
  box.innerHTML = body + msg;
}

function diag() {
  const w = suiWallets().map(x => x.name);
  $("t-diag").innerHTML = "opened with: " + esc(location.search || "(nothing)") + "<br>wallets in this browser: " + esc(w.length ? w.join(", ") : "none")
    + (turret ? "<br>turret: " + esc(turret.id) + (turret.itemId ? " · item " + esc(turret.itemId) : "") : "");
}

function empty(title, text) {
  $("t-main").hidden = true; $("t-empty").hidden = false;
  $("t-empty").innerHTML = `<b>${esc(title)}</b>${text}`;
}

// Where the game might name the turret (2026-10-17: it opened the panel with no ?itemId): every query and hash
// parameter, and messages the game window posts to the page. What came is shown on the "No turret" screen.
const messages = [];
function paramsAll() {
  const out = [];
  for (const src of [location.search.slice(1), location.hash.slice(1)]) for (const [k, v] of new URLSearchParams(src)) out.push([k.toLowerCase(), v]);
  return out;
}
function findId() {
  const ps = paramsAll();
  const pick = names => { for (const [k, v] of ps) if (names.includes(k)) return v; return null; };
  const raw = pick(["id", "objectid", "object_id", "assemblyid", "assembly_id", "smartobjectid", "smart_object_id"]);
  const item = pick(["itemid", "item_id", "smartassemblyid", "smart_assembly_id", "assemblykey", "key"]);
  if (raw && /^0x[0-9a-fA-F]{1,64}$/.test(raw)) return raw;
  const digits = [raw, item].find(v => v && /^\d{1,20}$/.test(v));
  return digits ? objectIdOf(digits) : null;
}
function seen() {
  const w = suiWallets().map(x => x.name);
  return "address: " + location.href.replace(location.origin, "") + "\nreferrer: " + (document.referrer || "none") + "\nwindow name: " + (window.name || "none")
    + "\nmessages from the game: " + (messages.length ? messages.join(" | ") : "none") + "\nwallets: " + (w.length ? w.join(", ") : "none");
}
window.addEventListener("message", e => {
  let d = e.data; try { d = typeof d === "string" ? d : JSON.stringify(d); } catch (x) { d = String(d); }
  messages.push((e.origin || "?") + ": " + String(d).slice(0, 200));
  if (!turret) {
    const m = String(d).match(/"?(?:itemId|item_id|objectId|assemblyId)"?\s*[:=]\s*"?(0x[0-9a-fA-F]{1,64}|\d{1,20})/i);
    if (m) { const v = m[1]; history.replaceState(null, "", "?" + (v.startsWith("0x") ? "id=" : "itemId=") + v); load(); return; }
    const pre = document.getElementById("t-seen"); if (pre) pre.textContent = seen();
  }
});

/** No turret named: say what came, and let the owner pick one of their turrets with their wallet. */
function noTurret() {
  empty("No turret named", "<p>The game opened this panel without saying which turret it is. Connect your wallet and pick your turret:</p>"
    + '<p><button type="button" class="btn go" id="t-pick">Connect wallet and pick</button></p><div id="t-picklist"></div>'
    + '<div class="msg" id="t-msg"></div><pre class="seen" id="t-seen"></pre>');
  $("t-seen").textContent = seen();
}
async function pickList() {
  say("asking the wallet…");
  me = await connect(true);
  char = await characterOf(me.account.address);
  if (!char || !char.id) { say("No EVE Frontier character belongs to this wallet.", "bad"); return; }
  const list = await turretsOf(char.id);
  say(list.length ? "" : "This character owns no turret.", list.length ? "" : "bad");
  $("t-picklist").innerHTML = list.map((t, i) => `<button type="button" class="btn pick" data-pick="${i}">${esc(t.name || "Turret")} · ${t.online ? "online" : "offline"} · ${esc(parseSettings(t.description).mode)}</button>`).join("");
  pickList.list = list;
}

async function load() {
  const id = findId();
  if (!id) { noTurret(); diag(); return; }
  const t = await turretById(id);
  if (!t) { empty("Not a turret", "<p>The game opened this panel for an object that is not a turret on the chain. The Saints code runs on turrets only (storage and gates later).</p>"); diag(); return; }
  turret = t;
  if (mine) mine = { ...mine, ...t };
  saved = parseSettings(t.description); draft = null;
  $("t-empty").hidden = true; $("t-main").hidden = false;
  render(); diag();
}

async function findOwner() {
  char = await characterOf(me.account.address);
  mine = null;
  if (char && char.id) {
    const list = await turretsOf(char.id);
    const t = list.find(x => x.id === turret.id);
    if (t) mine = t;
  }
  render();
}

async function send(makeTx, doneText) {
  busy = true; render(); say("checking with the chain…");
  try {
    const sim = await simulate(makeTx(), me.account.address);
    const st = (sim.Transaction || sim.FailedTransaction || {}).effects?.status;
    if (st && !st.success) throw new Error("the chain would refuse it: " + JSON.stringify(st.error || st).slice(0, 160));
    say("sign it in your wallet…", "warn");
    await signAndExecute(me, makeTx());
    say(doneText, "ok");
    busy = false;
    setTimeout(() => load().then(() => say(doneText, "ok")).catch(() => {}), 2500);
  } catch (e) {
    busy = false; render(); say(e && e.message ? e.message : String(e), "bad");
  }
}

function saveSettings(s, doneText) {
  const text = withSettings(turret.description, s);
  if (text.length > MAX_LEN) { say("The description would be " + text.length + " characters; the game allows " + MAX_LEN + ". Remove an id first.", "bad"); return; }
  send(() => describeTx(char.id, mine, text), doneText);
}

document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  if (b.id === "t-connect") {
    try { me = await connect(true); await findOwner(); }
    catch (x) { render(); say(x && x.message ? x.message + " Use thesaintsforge.com/machines in your browser instead." : String(x), "bad"); }
    diag(); return;
  }
  if (b.id === "t-pick") { b.disabled = true; try { await pickList(); } catch (x) { say((x && x.message || String(x)) + " Use thesaintsforge.com/machines in your browser instead.", "bad"); } b.disabled = false; return; }
  if (b.dataset.pick) {
    const t = pickList.list[+b.dataset.pick]; if (!t) return;
    history.replaceState(null, "", "?id=" + t.id);
    turret = t; mine = t; saved = parseSettings(t.description); draft = null;
    $("t-empty").hidden = true; $("t-main").hidden = false; render(); diag(); return;
  }
  if (b.id === "t-install") { send(() => installTx(PKG, char.id, mine), "Saints code installed."); return; }
  if (b.dataset.mode && mine && !busy) {
    if (b.dataset.mode === (draft || saved).mode && !(draft && !same(draft, saved))) return;
    const s = copy(draft || saved); s.mode = b.dataset.mode;
    saveSettings(s, "Switched to " + s.mode + ".");
    return;
  }
  if (b.dataset.del) {
    const [k, v] = b.dataset.del.split(":"); draft = copy(draft || saved);
    draft[k] = draft[k].filter(x => String(x) !== v); render(); return;
  }
  if (b.dataset.addbtn) addFrom(document.querySelector(`input[data-add="${b.dataset.addbtn}"]`));
  if (b.id === "t-undo") { draft = null; render(); say(""); }
  if (b.id === "t-commit") saveSettings(draft, "Lists saved.");
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.dataset && e.target.dataset.add) addFrom(e.target); });

function addFrom(input) {
  if (!input) return;
  // a pilot or tribe copied in game with "Copy selected with formatting" carries its id: showinfo:1373//2112112383
  const k = input.dataset.add, typed = input.value.trim(), link = typed.match(/showinfo:\d+\/\/(\d+)/i), raw = link ? link[1] : typed;
  if (!/^\d+$/.test(raw) || Number(raw) > U32 || Number(raw) === 0) { say("An id is a whole number (a tribe id like 98000655, a character id like 2112112652), or paste a name copied in game with Copy selected with formatting.", "bad"); input.focus(); return; }
  draft = copy(draft || saved);
  const v = Number(raw);
  if (!draft[k].includes(v)) draft[k].push(v);
  render(); say("");
  const again = document.querySelector(`input[data-add="${k}"]`); if (again) again.focus();
}

// read-only test hook: show the panel as the given wallet sees it (no wallet, so nothing can be signed)
window.__turretOwnerTest = async address => { me = { account: { address } }; await findOwner(); return { owner: !!mine, char: char && char.name }; };
// No wallet call on load (2026-10-17: in the game's panel the page showed for a second, then went grey); the wallet
// is asked only when Connect wallet is pressed. Errors are shown under 'details' instead of breaking the page.
window.addEventListener("error", e => { $("t-diag").innerHTML += "<br>error: " + esc(e.message); });
window.addEventListener("unhandledrejection", e => { $("t-diag").innerHTML += "<br>error: " + esc(e.reason && e.reason.message || e.reason); });
load().catch(e => { empty("Could not read the chain", "<p>" + esc(e && e.message || e) + "</p><p>Close and open the panel again.</p>"); diag(); });
