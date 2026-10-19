/* /api/gatestate: a public (NPC) stargate's state, seen by a pilot's Saints Frontier Companion (user 2026-10-19: "can
   the companion check the public gate state ... as i jump through it?", and yes to letting every tribe member's
   companion record it).
   The game writes a warning to its game log when the far side of a public gate is not working ("The stargate on the
   other side has no fuel" / "is dormant" / "could not be determined"); the Local chat log names every system change.
   The companion pairs them: a jump with no warning before it = working; a jump after a warning = that state; a warning
   where the pilot stayed = that state for the system's only public gate.
   POST (companion key or tribe session): { from, to | null, at (ISO time), state: working | unfueled | dormant | unknown,
          window?: { jumps, cap, status, dest, toText, at } }  (window = the game's STARGATE DEPOT window, read by the
          companion's screen reader: AVAILABLE JUMPS jumps/cap is the fuel of the gate in `from`, in jumps)
     -> the two names are resolved to system numbers (our list, then EF-Map's names) and must be a pair of the client's
        public gates (gates.bin, the site's own file); then the pair's record in the Pilgrim Roads list (KV "network",
        list.gates) gets { state, seen, at, by } unless a newer observation is already there. "unknown" and anything
        that is not a public gate pair are answered and dropped. Every tribe member may report; the name goes with it. */
import { json } from "./_lib.js";
import { who } from "./quarry.js";
import { readNames } from "./network.js";

const STATES = ["working", "unfueled", "dormant", "unknown"];
const NAME = /^[A-Za-z0-9|.\- ]{2,40}$/;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z?$/;
const up = s => String(s == null ? "" : s).toUpperCase().trim();
const WORD = /^[A-Z ]{0,12}$/, TOTEXT = /^[A-Za-z0-9|.\- ]{0,40}$/;
/* names as the screen reader sees them: "AO3|T11" can be read "A031T11", "ABC|O11" "ABC 1011" */
const ocrKey = s => up(s).replace(/\|/g, "I").replace(/[^A-Z0-9]/g, "").replace(/0/g, "O").replace(/1/g, "I").replace(/5/g, "S").replace(/8/g, "B");
function lev(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length]; }
/* which of a system's gates a read name means: the closest, when it is close (2 edits) and nobody else is as close */
export function pickByText(cands, text, nameOf) {
  const k = ocrKey(text); if (k.length < 3) return null;
  const sc = cands.map(id => ({ id, d: nameOf(id) ? lev(ocrKey(nameOf(id)), k) : 99 })).sort((a, b) => a.d - b.d);
  return sc.length && sc[0].d <= 2 && (sc.length === 1 || sc[1].d > sc[0].d) ? sc[0].id : null;
}
function cleanWindow(w) {
  if (w == null) return null;
  if (typeof w !== "object") return false;
  const int = (v, lo) => v == null || (Number.isInteger(v) && v >= lo && v <= 1000000);
  if (!int(w.jumps, 0) || !int(w.cap, 1) || !WORD.test(String(w.status || "")) || !WORD.test(String(w.dest || "")) || !TOTEXT.test(String(w.toText || ""))) return false;
  return { jumps: w.jumps == null ? null : w.jumps, cap: w.cap == null ? null : w.cap, status: String(w.status || ""), dest: String(w.dest || ""), toText: String(w.toText || "") };
}

let PAIRS = null;      // "a|b" (a < b) -> true, and system -> [partners]: the client's public stargates
async function gatePairs(env, request) {
  if (PAIRS) return PAIRS;
  const r = await env.ASSETS.fetch(new URL("/gates.bin", request.url));
  if (!r.ok) throw new Error("gates.bin " + r.status);
  const dv = new DataView(await r.arrayBuffer()), n = dv.getUint32(8, true), set = new Set(), of = new Map();
  const add = (x, y) => { let l = of.get(x); if (!l) of.set(x, l = []); l.push(y); };
  for (let i = 0, o = 12; i < n; i++, o += 9) { const a = dv.getUint32(o, true), b = dv.getUint32(o + 4, true); set.add(Math.min(a, b) + "|" + Math.max(a, b)); add(a, b); add(b, a); }
  PAIRS = { set, of };
  return PAIRS;
}

export function resolver(list, names) {
  const byName = new Map(), byId = new Map();
  for (const [n, v] of Object.entries(list.systems || {})) { const id = typeof v === "number" ? v : v && +v.id; if (id) { byName.set(up(n), id); if (!byId.has(id)) byId.set(id, up(n)); } }
  for (const x of (names && names.systems) || []) { const id = +x[0], n = up(x[1]); if (!id || !n) continue; if (!byName.has(n)) byName.set(n, id); if (!byId.has(id)) byId.set(id, n); }
  return { id: n => byName.get(up(n)) || null, name: id => byId.get(id) || null };
}

/* the record update: returns the new gates list, or null when nothing changes. The state (and seen / at / by) moves
   only with a newer observation that has one ("unknown" carries fuel only); the fuel is kept per side of the pair:
   fuel[<system>] = { jumps, cap, status, dest, at, by }, the gate standing in that system. */
export function merge(gates, a, b, obs) {
  const out = (gates || []).map(g => Object.assign({}, g));
  const i = out.findIndex(g => (up(g.a) === a && up(g.b) === b) || (up(g.a) === b && up(g.b) === a));
  const old = i >= 0 ? out[i] : null, oldAt = old ? (old.at || (old.seen ? old.seen + "T00:00:00Z" : "")) : "";
  const rec = Object.assign({}, old || { a, b });
  if (obs.state && obs.state !== "unknown" && !(old && oldAt && obs.at < oldAt)) Object.assign(rec, { state: obs.state, seen: obs.at.slice(0, 10), at: obs.at, by: obs.by });
  if (obs.window && (obs.window.jumps != null || obs.window.status)) {
    const f = Object.assign({}, old && old.fuel), prev = f[a];
    if (!prev || !prev.at || obs.window.at >= prev.at) { f[a] = { jumps: obs.window.jumps, cap: obs.window.cap, status: obs.window.status, dest: obs.window.dest, at: obs.window.at, by: obs.by }; rec.fuel = f; }
  }
  if (old && JSON.stringify(old) === JSON.stringify(rec)) return null;   // the same news: no write
  if (!old && !rec.state && !rec.fuel) return null;
  if (i >= 0) out[i] = rec; else { if (out.length >= 500) return null; out.push(rec); }
  return out;
}

export async function onRequestPost({ request, env }) {
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503);
  const { s, cookies } = await who(env, request);
  if (!s || !s.u) return json({ ok: false, error: "Log in, or paste your companion key into the companion." }, 401, cookies);
  const text = await request.text();
  if (text.length > 1000) return json({ ok: false, error: "Too large." }, 413, cookies);
  let d; try { d = JSON.parse(text); } catch (e) { return json({ ok: false, error: "Not JSON." }, 400, cookies); }
  if (!d || typeof d !== "object" || !NAME.test(String(d.from || "")) || (d.to != null && !NAME.test(String(d.to))) || !STATES.includes(d.state) || !ISO.test(String(d.at || "")))
    return json({ ok: false, error: "Send {from, to or null, at, state}." }, 400, cookies);
  let at = String(d.at); if (!at.endsWith("Z")) at += "Z";
  if (Date.parse(at) > Date.now() + 5 * 60000) return json({ ok: false, error: "The time is in the future." }, 400, cookies);
  const win = cleanWindow(d.window);
  if (win === false) return json({ ok: false, error: "The window reading is not in the right shape." }, 400, cookies);
  if (win) { let wa = String(d.window.at || at); if (!ISO.test(wa)) wa = at; if (!wa.endsWith("Z")) wa += "Z"; win.at = Date.parse(wa) > Date.now() + 5 * 60000 ? at : wa; }
  if (d.state === "unknown" && !(win && (win.jumps != null || win.status))) return json({ ok: true, recorded: false, why: "the game could not tell the far side's state" }, 200, cookies);

  let raw = null; try { raw = await env.DOCTRINE.get("network"); } catch (e) {}
  const stored = raw ? JSON.parse(raw) : {};
  const R = resolver(stored, await readNames(env, false));
  const P = await gatePairs(env, request);
  const fromId = R.id(d.from);
  if (!fromId) return json({ ok: true, recorded: false, why: `${up(d.from)} has no system number on the map yet` }, 200, cookies);
  let toId = d.to != null ? R.id(d.to) : null, toName = d.to != null ? up(d.to) : null;
  if (d.to == null) {                                    // a warning where the pilot stayed: the system's only public gate
    const l = P.of.get(fromId) || [];
    toId = l.length === 1 ? l[0] : (win && win.toText ? pickByText(l, win.toText, R.name) : null);
    if (!toId) return json({ ok: true, recorded: false, why: l.length ? `${up(d.from)} has ${l.length} public gates and the reading does not say which` : `${up(d.from)} has no public gate` }, 200, cookies);
    toName = R.name(toId);
    if (!toName) return json({ ok: true, recorded: false, why: "the far system has no name on the map yet" }, 200, cookies);
  }
  if (!toId) return json({ ok: true, recorded: false, why: `${toName} has no system number on the map yet` }, 200, cookies);
  if (!P.set.has(Math.min(fromId, toId) + "|" + Math.max(fromId, toId))) return json({ ok: true, recorded: false, why: "not a public gate (a catapult, a player gate, or a respawn)" }, 200, cookies);

  const by = String(s.n || "a Saint").replace(/[<>]/g, "").slice(0, 40);
  const gates = merge(stored.gates, up(d.from), toName, { state: d.state, at, by, window: win });
  if (gates) { stored.gates = gates; stored.updated = new Date().toISOString(); await env.DOCTRINE.put("network", JSON.stringify(stored)); }
  return json({ ok: true, recorded: !!gates, gate: [up(d.from), toName], state: d.state, fuel: win && win.jumps != null ? [win.jumps, win.cap] : null, why: gates ? "" : "already known" }, 200, cookies);
}

export const __test = { resolver, merge, gatePairs, pickByText, ocrKey, cleanWindow, reset: () => { PAIRS = null; } };
