/* /api/intel: what the Saints Frontier Companion asks and reports beyond the roads (user 2026-10-19: "military
   intelligence ... not only shooting me but also me shooting them or their structure", kills in the system with how
   long ago, my nodes, the System Map's infestation, system numbers from copied links, visited systems).
   Every call needs the companion key or a tribe session; nothing here is public.
   GET  ?q=who&names=A|B          -> the tribe of each pilot, from the alerts Worker's roster (KV "alerts:roster":
                                    every character's name, tribe and address; tribe short names from the World API)
   GET  ?q=kills&sys=ID&hours=24  -> killmails in that system (chain, read-only), killer / victim named from the roster
   GET  ?q=nodes&char=ITEM_ID     -> that pilot's Network Nodes with their fuel (chain, read-only)
   GET  ?q=pilot&name=NAME        -> one pilot for the companion's combat view (2026-10-23): tribe from the roster and
                                    their kills / losses among the last seven days' killmails (chain, read-only;
                                    `since` = how far back the read really reached)
   GET  ?q=field                  -> the tribe's field records: system surveys, visited systems
   POST {type: "survey", sys, at, infest, word, transient, umbra, star, planets, belts, state}
        -> the System Map's readings for a system (one write per system per day, or when a reading changes)
   POST {type: "sysids", links: [{name, id}]}  -> system numbers copied in game (showinfo:5//ID), added to the Roads
        list's numbers when the name is new there; a different number for a known name is reported, never written
   The field records live in KV "field" (not in the Roads list "network" a Paladin edits, so the two never overwrite
   each other); the system numbers go into "network" list.systems, as the Roads page's own paste box does. */
import { json } from "./_lib.js";
import { who as whoIs } from "./quarry.js";
import { ownedIds, getObjects, fuelEfficiency, label, variant } from "./network.js";

const WORLD = "0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92";
const SUI = "https://graphql.testnet.sui.io/graphql", SAINTS = 98000655;
const SYS = /^[A-Za-z0-9|.\- ]{2,40}$/, ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,12}Z?$/;
const MAX_SYSTEMS = 2000;   // the Roads list's numbers; the same cap as network.js checkList (a longer list would refuse every later save of the settings page)
const WORDS = ["TRACE", "SCARCE", "MODEST", "PLENTIFUL", "ABUNDANT"];
const up = s => String(s == null ? "" : s).toUpperCase().trim();
const clip = (s, n) => String(s == null ? "" : s).replace(/[<>]/g, "").slice(0, n);

async function gql(query, variables) {
  const r = await fetch(SUI, { method: "POST", headers: { "content-type": "application/json", "user-agent": "saints-forge (read-only)" }, body: JSON.stringify({ query, variables }) });
  if (!r.ok) throw new Error("chain answered " + r.status);
  const b = await r.json(); if (!b.data) throw new Error("chain returned no data");
  return b.data;
}
async function kvJson(env, key, fallback) { try { const v = await env.DOCTRINE.get(key, "json"); return v == null ? fallback : v; } catch (e) { return fallback; } }

/* the roster, kept by the alerts Worker in the same KV namespace: chars {itemId: [name, tribe, address]}, tribes {id: tag} */
let ROSTER = null, ROSTER_AT = 0, BY_NAME = null;
async function roster(env) {
  if (ROSTER && Date.now() - ROSTER_AT < 10 * 60000) return ROSTER;
  ROSTER = await kvJson(env, "alerts:roster", { chars: {}, tribes: {} }); ROSTER_AT = Date.now(); BY_NAME = null;
  return ROSTER;
}
export function person(R, id) {
  const c = R && R.chars && R.chars[id];
  if (!c) return { id: String(id), name: "character " + id, tribe: 0, tag: "", saint: false };
  return { id: String(id), name: c[0] || "character " + id, tribe: c[1] || 0, tag: (R.tribes && R.tribes[c[1]]) || (c[1] ? String(c[1]) : ""), saint: c[1] === SAINTS };
}
export function byName(R, name) {
  if (!BY_NAME) { BY_NAME = new Map(); for (const id in (R && R.chars) || {}) { const k = up(R.chars[id][0]); if (k && !BY_NAME.has(k)) BY_NAME.set(k, id); } }
  const id = BY_NAME.get(up(name));
  return id ? person(R, id) : null;
}

const WEEK_AGO = () => Date.now() - 7 * 24 * 3600000;
/* killmails, newest first: the last few hundred are kept a minute per isolate */
let KILLS = null, KILLS_AT = 0;
async function recentKills() {
  /* a week of killmails (2026-10-23: ~1,050 = 21 pages of 50, ~3.5 s); capped at 40 pages so a request stays well
     inside the Functions limits (50 subrequests on the free plan), kept 5 minutes per isolate */
  if (KILLS && Date.now() - KILLS_AT < 5 * 60000) return KILLS;
  const out = []; let before = null;
  for (let page = 0; page < 40; page++) {
    const d = await gql("query($t:String!,$b:String){ events(filter:{type:$t}, last:50, before:$b) { pageInfo { hasPreviousPage startCursor } nodes { timestamp contents { json } } } }", { t: WORLD + "::killmail::KillmailCreatedEvent", b: before });
    const e = d.events; for (const n of (e.nodes || []).slice().reverse()) out.push({ at: n.timestamp, j: (n.contents || {}).json || {} });
    if (!e.pageInfo.hasPreviousPage) break; before = e.pageInfo.startCursor;
    if (out.length && Date.now() - Date.parse(out[out.length - 1].at) > 7 * 24 * 3600000) break;
  }
  KILLS = out; KILLS_AT = Date.now(); return out;
}

/* system number -> the name the Map knows (the Roads list's numbers), for the pilot view */
let SYSNAMES = null, SYSNAMES_AT = 0;
async function systemNames(env) {
  if (SYSNAMES && Date.now() - SYSNAMES_AT < 10 * 60000) return SYSNAMES;
  const list = await kvJson(env, "network", {}), out = {};
  for (const [name, v] of Object.entries((list && list.systems) || {})) if (v && v.id) out[String(v.id)] = name;
  SYSNAMES = out; SYSNAMES_AT = Date.now(); return out;
}

/* a pilot's Network Nodes with fuel: the character's OwnerCaps -> the nodes among them */
async function nodesOf(address) {
  const objs = await getObjects(await ownedIds(address));
  const nodes = []; let pkg = "";
  for (const [id, o] of objs) {
    if (!/::network_node::NetworkNode$/.test(o.type || "")) continue;
    const j = o.json, f = j.fuel || {}; pkg = pkg || String(o.type || "").split("::")[0];
    nodes.push({ id, name: label(j), status: variant(j), fuel: { quantity: +f.quantity || 0, max: +f.max_capacity || 0, unit: +f.unit_volume || 0, burnMs: +f.burn_rate_in_ms || 0, burning: !!f.is_burning, type: String(f.type_id || "") }, connected: (j.connected_assembly_ids || []).length });
  }
  const eff = nodes.length ? await fuelEfficiency(pkg) : {};
  for (const n of nodes) { n.fuel.eff = eff[n.fuel.type] || 0; n.hours = n.fuel.burning && n.fuel.eff ? n.fuel.quantity * n.fuel.burnMs * n.fuel.eff / 100 / 3600000 : null; }
  return nodes;
}

const nocache = (body, cookies) => { const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" }); for (const c of cookies || []) h.append("Set-Cookie", c); return new Response(JSON.stringify(body), { status: 200, headers: h }); };

export async function onRequestGet({ request, env }) {
  const { s, cookies } = await whoIs(env, request);
  if (!s || !s.u) return json({ ok: false }, 401, cookies);
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503, cookies);
  const u = new URL(request.url), q = u.searchParams.get("q");
  try {
    if (q === "who") {
      const R = await roster(env), names = String(u.searchParams.get("names") || "").split("|").map(x => x.trim()).filter(Boolean).slice(0, 40);
      return nocache({ ok: true, rosterAt: R.at || 0, who: names.map(n => Object.assign({ asked: n }, byName(R, n) || { name: n, unknown: true })) }, cookies);
    }
    if (q === "kills") {
      const sys = String(u.searchParams.get("sys") || ""), hours = Math.min(48, Math.max(1, +u.searchParams.get("hours") || 24));
      if (!/^3[0-9]{7}$/.test(sys)) return json({ ok: false, error: "sys must be a system number" }, 400, cookies);
      const R = await roster(env), since = Date.now() - hours * 3600000, list = [];
      for (const k of await recentKills()) {
        const j = k.j, when = (+j.kill_timestamp || 0) * 1000 || Date.parse(k.at);
        if (when < since || (j.key && j.key.tenant && j.key.tenant !== "stillness")) continue;
        if (String((j.solar_system_id || {}).item_id || "") !== sys) continue;
        list.push({ id: String((j.key || {}).item_id || ""), at: new Date(when).toISOString(), reported: k.at, loss: ((j.loss_type || {})["@variant"]) || "?", killer: person(R, (j.killer_id || {}).item_id), victim: person(R, (j.victim_id || {}).item_id) });
      }
      return nocache({ ok: true, sys, hours, kills: list }, cookies);
    }
    if (q === "nodes") {
      const R = await roster(env), char = String(u.searchParams.get("char") || "");
      const c = R.chars && R.chars[char];
      if (!c) return nocache({ ok: true, nodes: [], note: "this pilot is not in the roster yet (it is refreshed hourly)" }, cookies);
      return nocache({ ok: true, pilot: person(R, char), nodes: await nodesOf(c[2]) }, cookies);
    }
    if (q === "pilot") {
      const R = await roster(env), p = byName(R, clip(u.searchParams.get("name"), 60));
      if (!p) return nocache({ ok: true, unknown: true, rosterAt: R.at || 0 }, cookies);
      const sysName = await systemNames(env), kills = [], losses = [];
      for (const k of await recentKills()) {
        const j = k.j; if (j.key && j.key.tenant && j.key.tenant !== "stillness") continue;
        const when = (+j.kill_timestamp || 0) * 1000 || Date.parse(k.at), sys = String((j.solar_system_id || {}).item_id || "");
        if (when < WEEK_AGO()) continue;
        const row = { at: new Date(when).toISOString(), sys, sysName: sysName[sys] || "", loss: ((j.loss_type || {})["@variant"]) || "?" };
        if (String((j.killer_id || {}).item_id) === p.id) kills.push(Object.assign(row, { victim: person(R, (j.victim_id || {}).item_id) }));
        else if (String((j.victim_id || {}).item_id) === p.id) losses.push(Object.assign(row, { killer: person(R, (j.killer_id || {}).item_id) }));
      }
      const all = await recentKills(), oldest = all.length ? all.map(k => k.at).sort()[0] : null;
      const since = oldest && Date.parse(oldest) < WEEK_AGO() ? new Date(WEEK_AGO()).toISOString() : oldest,   /* how far back it really reached, at most a week */ newest = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
      kills.sort(newest); losses.sort(newest);
      return nocache({ ok: true, pilot: p, since, kills: kills.slice(0, 10), killCount: kills.length, losses: losses.slice(0, 10), lossCount: losses.length }, cookies);
    }
    if (q === "field") return nocache(Object.assign({ ok: true }, await kvJson(env, "field", {})), cookies);
  } catch (e) { return json({ ok: false, error: "the chain did not answer" }, 502, cookies); }
  return json({ ok: false, error: "ask q=who, kills, nodes, pilot or field" }, 400, cookies);
}

/* the field records' updates, pure (tested): each returns the new object, or null when nothing changes */
export function addSurvey(field, r) {
  const f = Object.assign({ survey: {}, visited: {}, rifts: [] }, field || {}), old = (f.survey || {})[r.sys];
  const keep = ["infest", "word", "transient", "umbra", "star", "planets", "belts", "state"];
  if (old && String(old.at || "").slice(0, 10) === r.at.slice(0, 10) && keep.every(k => old[k] === r[k])) return null;
  if (old && old.at && r.at < old.at) return null;
  f.survey = Object.assign({}, f.survey, { [r.sys]: Object.assign({}, r, { hist: ((old && old.hist) || []).concat([[r.at, r.infest]]).slice(-10) }) });
  return f;
}
export function addVisit(field, sys, at, by) {
  const f = Object.assign({ survey: {}, visited: {}, rifts: [] }, field || {}), old = (f.visited || {})[sys];
  if (old && String(old.last || "").slice(0, 10) === at.slice(0, 10)) return null;
  const v = Object.assign({}, f.visited); v[sys] = { first: (old && old.first) || at, last: at, days: ((old && old.days) || 0) + 1, by };
  const keys = Object.keys(v); if (keys.length > 5000) delete v[keys[0]];
  f.visited = v; return f;
}

export async function onRequestPost({ request, env }) {
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503);
  const { s, cookies } = await whoIs(env, request);
  if (!s || !s.u) return json({ ok: false, error: "Log in, or paste your companion key into the companion." }, 401, cookies);
  const text = await request.text(); if (text.length > 6000) return json({ ok: false, error: "Too large." }, 413, cookies);
  let d; try { d = JSON.parse(text); } catch (e) { return json({ ok: false, error: "Not JSON." }, 400, cookies); }
  const by = clip(s.n || "a Saint", 40);
  if (d && d.type === "sysids") {
    const links = (Array.isArray(d.links) ? d.links : []).slice(0, 50).filter(l => l && SYS.test(String(l.name || "")) && /^3[0-9]{7}$/.test(String(l.id || "")));
    if (!links.length) return json({ ok: false, error: "no system links" }, 400, cookies);
    let raw = null; try { raw = await env.DOCTRINE.get("network"); } catch (e) {}
    const list = raw ? JSON.parse(raw) : {}; list.systems = list.systems || {};
    const added = [], known = [], differ = [];
    for (const l of links) {
      const name = up(l.name), id = +l.id, cur = list.systems[name] != null ? list.systems[name] : Object.entries(list.systems).find(([n]) => up(n) === name);
      const curId = cur == null ? null : typeof cur === "number" ? cur : Array.isArray(cur) ? (typeof cur[1] === "number" ? cur[1] : +cur[1].id) : +cur.id;
      if (curId == null) { if (Object.keys(list.systems).length >= MAX_SYSTEMS) return json({ ok: false, error: `the map's list of numbers is full (${MAX_SYSTEMS})` }, 400, cookies); list.systems[name] = { id, sure: true, from: "companion", by }; added.push(name); }
      else if (curId === id) known.push(name); else differ.push({ name, ours: curId, copied: id });
    }
    if (added.length) { list.updated = new Date().toISOString(); await env.DOCTRINE.put("network", JSON.stringify(list)); }
    return json({ ok: true, added, known, differ }, 200, cookies);
  }
  if (!d || !SYS.test(String(d.sys || "")) || !ISO.test(String(d.at || ""))) return json({ ok: false, error: "Send {type, sys, at, ...}." }, 400, cookies);
  let at = String(d.at); if (!at.endsWith("Z")) at += "Z";
  if (Date.parse(at) > Date.now() + 5 * 60000) return json({ ok: false, error: "The time is in the future." }, 400, cookies);
  const sys = up(d.sys), field = await kvJson(env, "field", {});
  let next = null;
  if (d.type === "survey") {
    const infest = Number.isInteger(d.infest) && d.infest >= 1 && d.infest <= 6 ? d.infest : null;
    const word = v => WORDS.includes(up(v)) ? up(v) : null;
    const r = { sys, at, by, infest, word: /^[A-Z ]{3,14}$/.test(up(d.word)) ? up(d.word) : null, transient: word(d.transient), umbra: word(d.umbra),
                star: /^[A-Z][0-9]?$/.test(up(d.star)) ? up(d.star) : null, planets: Number.isInteger(d.planets) && d.planets >= 0 && d.planets < 40 ? d.planets : null,
                belts: Number.isInteger(d.belts) && d.belts >= 0 && d.belts < 40 ? d.belts : null, state: /^[A-Z ]{3,14}$/.test(up(d.state)) ? up(d.state) : null };
    if (r.infest == null && !r.transient && !r.umbra) return json({ ok: false, error: "nothing was read" }, 400, cookies);
    next = addSurvey(field, r);
  } else return json({ ok: false, error: "type is survey or sysids" }, 400, cookies);
  if (next) await env.DOCTRINE.put("field", JSON.stringify(next));
  return json({ ok: true, recorded: !!next, why: next ? "" : "already known" }, 200, cookies);
}

export const __test = { person, byName, addSurvey, addVisit, reset: () => { ROSTER = null; KILLS = null; BY_NAME = null; } };
