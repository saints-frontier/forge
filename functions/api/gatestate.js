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
        that is not a public gate pair are answered and dropped. Every tribe member may report; the name goes with it.
   Any OTHER move (2026-10-19, user: "collect the information on catapults ... cross-reference everything"): the chain
   logs every PLAYER gate jump (gate::JumpEvent: source and destination gate objects + the character), catapults leave
   nothing. So a move with the pilot's character id (`char`, from the log's file name) is looked up among the chain's
   jump events: found = a player gate jump, and both gate objects are placed in their systems (list.placed[object id]
   = {sys, at, by}); not found and within a Heavy Catapult's 250 LY = a catapult throw. Either way the road goes into
   list.seen [{a, b, kind: gate | catapult, days, first, last, by}] (a day counted once): the Roads mark chain roads as
   jumped (a "worked out" road becomes confirmed) and draw seen roads the launcher names do not explain. Farther than
   250 LY with no gate event = a death and respawn, dropped. */
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

const WORLD = "0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92";   // the Stillness world package (Cycle 7)
const SUI = "https://graphql.testnet.sui.io/graphql", CATAPULT_LY = 250 * 1.02, MAX_SEEN = 500, MAX_PLACED = 500;
let STARS = null;      // system number -> [x, y, z] in light-years (the site's stars.bin)
async function stars(env, request) {
  if (STARS) return STARS;
  const r = await env.ASSETS.fetch(new URL("/stars.bin", request.url));
  if (!r.ok) throw new Error("stars.bin " + r.status);
  const dv = new DataView(await r.arrayBuffer()), cnt = dv.getUint32(4, true), m = new Map();
  for (let i = 0, o = 8; i < cnt; i++, o += 20) m.set(dv.getUint32(o, true), [dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)]);
  STARS = m; return m;
}
const lyBetween = (S, a, b) => { const p = S.get(a), q = S.get(b); return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : null; };
/* the chain's player gate jump of this character near this time, or null (two pages of the newest events at most) */
export async function findJump(char, atMs, fetcher) {
  const F = fetcher || fetch;
  let before = null;
  for (let page = 0; page < 3; page++) {
    const r = await F(SUI, { method: "POST", headers: { "content-type": "application/json", "user-agent": "saints-forge (read-only)" },
      body: JSON.stringify({ query: "query($t:String!,$b:String){ events(filter:{type:$t}, last:50, before:$b) { pageInfo { hasPreviousPage startCursor } nodes { timestamp contents { json } } } }", variables: { t: WORLD + "::gate::JumpEvent", b: before } }) });
    if (!r.ok) throw new Error("chain answered " + r.status);
    const e = ((await r.json()).data || {}).events; if (!e) return null;
    for (const x of e.nodes || []) {
      const j = (x.contents || {}).json || {}, t = Date.parse(x.timestamp);
      if (String(((j.character_key || {}).item_id) || "") === char && t >= atMs - 90000 && t <= atMs + 30000) return { src: j.source_gate_id, dst: j.destination_gate_id, at: x.timestamp };
    }
    const oldest = e.nodes && e.nodes.length ? Date.parse(e.nodes[0].timestamp) : 0;
    if (!e.pageInfo.hasPreviousPage || oldest < atMs - 90000) return null;
    before = e.pageInfo.startCursor;
  }
  return null;
}
/* a road a Saint jumped: returns the new seen list, or null when nothing changes (the same road the same day) */
export function mergeSeen(seen, a, b, kind, at, by) {
  const out = (seen || []).map(x => Object.assign({}, x)), day = at.slice(0, 10);
  const i = out.findIndex(x => x.a === a && x.b === b && x.kind === kind);
  if (i >= 0) { const x = out[i]; if (String(x.last || "").slice(0, 10) === day) return null; x.days = (x.days || 1) + 1; x.last = at; x.by = by; return out; }
  if (out.length >= MAX_SEEN) out.splice(0, out.length - MAX_SEEN + 1);
  out.push({ a, b, kind, days: 1, first: at, last: at, by });
  return out;
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
    const loses = obs.window.jumps == null && prev && prev.jumps != null;      // a reading without the count never replaces one with it
    if (!loses && (!prev || !prev.at || obs.window.at >= prev.at)) { f[a] = { jumps: obs.window.jumps, cap: obs.window.cap, status: obs.window.status, dest: obs.window.dest, at: obs.window.at, by: obs.by }; rec.fuel = f; }
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
  if (!P.set.has(Math.min(fromId, toId) + "|" + Math.max(fromId, toId))) return otherMove(env, request, stored, d, up(d.from), toName, fromId, toId, at, String(s.n || "a Saint").replace(/[<>]/g, "").slice(0, 40), cookies);

  const by = String(s.n || "a Saint").replace(/[<>]/g, "").slice(0, 40);
  const gates = merge(stored.gates, up(d.from), toName, { state: d.state, at, by, window: win });
  if (gates) { stored.gates = gates; stored.updated = new Date().toISOString(); await env.DOCTRINE.put("network", JSON.stringify(stored)); }
  return json({ ok: true, recorded: !!gates, gate: [up(d.from), toName], state: d.state, fuel: win && win.jumps != null ? [win.jumps, win.cap] : null, why: gates ? "" : "already known" }, 200, cookies);
}

/* a move that is no public gate: a player gate (on chain) or a catapult (within its reach), else a respawn */
async function otherMove(env, request, stored, d, from, to, fromId, toId, at, by, cookies) {
  const char = /^[0-9]{6,14}$/.test(String(d.char || "")) ? String(d.char) : "";
  let jump = null; try { if (char) jump = await findJump(char, Date.parse(at)); } catch (e) { /* the chain did not answer: judged by distance alone */ }
  let kind = null;
  if (jump) kind = "gate";
  else {
    let ly = null; try { ly = lyBetween(await stars(env, request), fromId, toId); } catch (e) {}
    if (ly == null) return json({ ok: true, recorded: false, why: "the distance is unknown: not recorded" }, 200, cookies);
    if (ly > CATAPULT_LY) return json({ ok: true, recorded: false, why: `${Math.round(ly)} LY with no gate on chain: a respawn, not a road` }, 200, cookies);
    kind = "catapult";
  }
  let changed = false;
  const seen = mergeSeen(stored.seen, from, to, kind, at, by); if (seen) { stored.seen = seen; changed = true; }
  if (jump) {
    const placed = Object.assign({}, stored.placed || {});
    for (const [id, sys] of [[jump.src, from], [jump.dst, to]]) {
      if (!/^0x[0-9a-f]{64}$/.test(String(id || ""))) continue;
      if (!placed[id] || placed[id].sys !== sys) { placed[id] = { sys, at, by }; changed = true; }
    }
    const keys = Object.keys(placed); if (keys.length > MAX_PLACED) for (const k of keys.slice(0, keys.length - MAX_PLACED)) delete placed[k];
    stored.placed = placed;
  }
  if (changed) { stored.updated = new Date().toISOString(); await env.DOCTRINE.put("network", JSON.stringify(stored)); }
  return json({ ok: true, recorded: changed, seen: kind, gate: [from, to], why: changed ? "" : "already known today" }, 200, cookies);
}

export const __test = { findJump, mergeSeen, resolver, merge, gatePairs, pickByText, ocrKey, cleanWindow, reset: () => { PAIRS = null; } };
