/* /api/network: the tribe's road network (catapults, gates and their Network Nodes), for logged-in tribe members only.
   GET  -> { ok, at, canEdit, list, assemblies: [...], nodes: [...], names: { source, at, systems: [[id, name, status]], error } }
           assemblies and nodes are read from the chain (Sui GraphQL, read-only queries: nothing is signed or sent).
           Roads come from the chain only: the page (roads.js) places each launcher and gate from the names written
           in game. `list` holds settings, not roads (key "network" in the DOCTRINE namespace): which characters
           build for the tribe, the home system, the game's numbers of named systems, saved road plans.
   POST -> replace the settings (Paladins, Knights, site keepers), validated first; hand-placed roads are refused.
   Nothing about the network lives in this repository: the builders' addresses and every system name are in KV only. */
import { session, json, canUpload } from "./_lib.js";

const SUI = "https://graphql.testnet.sui.io/graphql";
const CATAPULT = { "95627": "Mini Catapult", "95628": "Mini Catapult", "95677": "Heavy Catapult", "95717": "Heavy Catapult" };
const FIELDS = "address asMoveObject { contents { type { repr } json } }";
const CACHE_SECONDS = 300, MAX_BUILDERS = 12, MAX_PAGES = 8;
const EMPTY = { builders: [], home: "", systems: {}, plans: [] };
/* settings only: a list stored before 2026-10-11 may still carry hand-placed nodes, launchers, links and notes; they are dropped */
const settings = l => ({ builders: Array.isArray(l.builders) ? l.builders : [], home: l.home || "", systems: l.systems || {}, gates: Array.isArray(l.gates) ? l.gates : [], plans: Array.isArray(l.plans) ? l.plans : [], updated: l.updated, updated_by: l.updated_by });

async function gql(query, variables) {
  const r = await fetch(SUI, { method: "POST", headers: { "content-type": "application/json", "user-agent": "saints-forge (read-only)" }, body: JSON.stringify({ query, variables: variables || {} }) });
  if (!r.ok) throw new Error("chain answered " + r.status);
  const b = await r.json();
  if (!b.data) throw new Error((b.errors && b.errors[0] && b.errors[0].message) || "chain returned no data");
  return b.data;                                        // partial data is fine: unreadable objects come back null
}
/* the ids of everything a character owns (through its OwnerCaps) */
async function ownedIds(character) {
  const ids = []; let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await gql("query($a:SuiAddress!,$c:String){ address(address:$a) { objects(first:50, after:$c) { pageInfo { hasNextPage endCursor } nodes { contents { type { repr } json } } } } }", { a: character, c: after });
    const o = d.address && d.address.objects; if (!o) break;
    for (const n of o.nodes || []) { const c = n && n.contents; if (c && /OwnerCap/.test(c.type.repr) && c.json && c.json.authorized_object_id) ids.push(c.json.authorized_object_id); }
    if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
  }
  return ids;
}
/* The public endpoint sometimes drops a few objects from a batch ("Failed to fetch object contents"), so whatever is
   missing is asked for again, twice at most. Ids that never answer are objects that no longer exist. */
async function getObjects(ids) {
  const out = new Map();
  let want = [...new Set(ids)];
  for (let round = 0; round < 3 && want.length; round++) {
    for (let i = 0; i < want.length; i += 50) {
      let d; try { d = await gql("query($k:[ObjectKey!]!){ multiGetObjects(keys:$k) { " + FIELDS + " } }", { k: want.slice(i, i + 50).map(a => ({ address: a })) }); } catch (e) { if (round === 2) throw e; continue; }
      for (const o of d.multiGetObjects || []) { const c = o && o.asMoveObject && o.asMoveObject.contents; if (c && c.json) out.set(o.address, { type: c.type.repr, json: c.json }); }
    }
    want = want.filter(a => !out.has(a));
  }
  return out;
}
const variant = j => (((j.status || {}).status || {})["@variant"]) || "?";
const label = j => String(((j.metadata || {}).name) || "").trim().slice(0, 80);

/* How long a node's fuel lasts. The chain's fuel module burns one unit every burn_rate_in_ms x efficiency / 100:
   a node says 3,000,000 ms (50 minutes), EU-40 Fuel has efficiency 40, so one unit lasts 20 minutes (3 an hour, as
   the game shows) and D1 Fuel (10) 5 minutes. The efficiencies live in the world's FuelConfig table; they are read
   with the nodes, and the values of 2026-10-13 stand in when that read fails. */
const FUEL_EFF = { "78515": 80, "78516": 40, "88319": 15, "78437": 90, "84868": 40, "88335": 10 };
async function fuelEfficiency(pkg) {
  const eff = Object.assign({}, FUEL_EFF);
  if (!/^0x[0-9a-f]{64}$/.test(pkg || "")) return eff;
  try {
    const d = await gql("query($t:String!){ objects(first:1, filter:{type:$t}) { nodes { asMoveObject { contents { json } } } } }", { t: pkg + "::fuel::FuelConfig" });
    const cfg = (((d.objects || {}).nodes || [])[0] || {}).asMoveObject, table = cfg && cfg.contents && cfg.contents.json && cfg.contents.json.fuel_efficiency && cfg.contents.json.fuel_efficiency.id;
    if (!table) return eff;
    const f = await gql("query($a:SuiAddress!){ address(address:$a) { dynamicFields(first:50) { nodes { name { json } value { ... on MoveValue { json } } } } } }", { a: table });
    for (const n of (((f.address || {}).dynamicFields || {}).nodes) || []) { const k = String((n.name || {}).json || ""), v = +((n.value || {}).json); if (/^[0-9]{1,9}$/.test(k) && v > 0 && v <= 1000) eff[k] = v; }
  } catch (e) {}
  return eff;
}

async function readChain(builders) {
  const assemblies = [], nodeIds = new Set(), seen = new Set();
  for (const b of builders) {
    const objs = await getObjects(await ownedIds(b.address));
    for (const [id, o] of objs) {
      if (seen.has(id)) continue; seen.add(id);
      const j = o.json, tid = String(j.type_id || "");
      const isGate = /::gate::Gate$/.test(o.type), kind = CATAPULT[tid] || (isGate ? (tid === "88086" ? "Mini Gate" : "Heavy Gate") : null);
      if (!kind) continue;
      assemblies.push({ id, kind, name: label(j), status: variant(j), node: j.energy_source_id || null, linked: j.linked_gate_id || null, builder: b.name });
      if (j.energy_source_id) nodeIds.add(j.energy_source_id);
    }
  }
  const nodes = []; let pkg = "";
  for (const [id, o] of await getObjects([...nodeIds])) {
    const j = o.json, f = j.fuel || {}; pkg = pkg || String(o.type || "").split("::")[0];
    nodes.push({ id, name: label(j), status: variant(j), fuel: { quantity: +f.quantity || 0, max: +f.max_capacity || 0, unit: +f.unit_volume || 0, burnMs: +f.burn_rate_in_ms || 0, burning: !!f.is_burning, type: String(f.type_id || "") },
                 connected: (j.connected_assembly_ids || []).length });
  }
  const eff = nodes.length ? await fuelEfficiency(pkg) : FUEL_EFF;
  for (const n of nodes) n.fuel.eff = eff[n.fuel.type] || 0;          // 0 = a fuel the table does not know: the page says so instead of guessing
  return { assemblies, nodes };
}

/* Cycle 7 system names charted on EF-Map's community map (their partner API, scope community-map.names.read).
   The key is the secret EFMAP_API_KEY: it is sent to EF-Map only, never to the page, and never written to a log or
   an error text. Names only, as [[id, name, status], ...]; status = confirmed | reported | conflict. Asked for at most
   once an hour (EF-Map asks callers to cache); nothing about the tribe is sent with the request. */
const EF_NAMES = "https://ef-map.com/api/community-map/system-names", NAMES_SECONDS = 3600, NAMES_KEEP = 86400, MAX_NAMES = 30000;   // asked again after an hour; the last good answer is kept a day in case EF-Map is down
function cleanNames(body) {
  const out = [], seen = new Set();
  for (const x of (body && Array.isArray(body.systems) ? body.systems : [])) {
    const id = x && typeof x.id === "number" ? x.id : NaN, name = x && typeof x.name === "string" ? x.name.trim().toUpperCase() : "";
    if (!Number.isInteger(id) || id < 30000000 || id > 39999999 || !/^[A-Z0-9][A-Z0-9.|\- ]{2,23}$/.test(name) || seen.has(id)) continue;
    seen.add(id); out.push([id, name, x.nameStatus === "confirmed" ? "confirmed" : x.nameStatus === "conflict" ? "conflict" : "reported"]);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}
async function readNames(env, fresh) {
  if (!env.EFMAP_API_KEY) return { at: 0, systems: [], error: "no EF-Map key is set" };
  const key = new Request("https://cache.saints-forge.internal/efmap/system-names");
  let old = null; try { const hit = await caches.default.match(key); if (hit) old = await hit.json(); } catch (e) {}
  if (old && Date.now() - old.at < (fresh ? 300 : NAMES_SECONDS) * 1000) return { at: old.at, systems: old.systems, error: null };
  try {
    const r = await fetch(EF_NAMES, { headers: { "X-API-Key": env.EFMAP_API_KEY, Accept: "application/json" } });
    if (!r.ok) throw new Error("EF-Map answered " + r.status);
    const body = await r.json(); if (!body || body.ok === false) throw new Error("EF-Map refused the request");
    const got = { at: Date.now(), systems: cleanNames(body) };
    try { await caches.default.put(key, new Response(JSON.stringify(got), { headers: { "Cache-Control": "max-age=" + NAMES_KEEP } })); } catch (e) {}
    return { at: got.at, systems: got.systems, error: null };
  } catch (e) {
    if (old) return { at: old.at, systems: old.systems, error: null };
    const m = String(e && e.message || e); return { at: 0, systems: [], error: /^EF-Map /.test(m) ? m.slice(0, 60) : "EF-Map could not be reached" };
  }
}

async function loadList(env) {
  let raw = null; try { raw = env.DOCTRINE ? await env.DOCTRINE.get("network") : null; } catch (e) {}
  try { return settings(Object.assign({}, EMPTY, raw ? JSON.parse(raw) : {})); } catch (e) { return Object.assign({}, EMPTY); }
}

export async function onRequestGet({ request, env }) {
  const { s, cookies } = await session(env, request);
  if (!s) return json({ ok: false }, 401, cookies);
  const list = await loadList(env);
  const builders = (list.builders || []).slice(0, MAX_BUILDERS);
  let chain = { assemblies: [], nodes: [] }, at = Date.now(), error = null, cached = false;
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const namesP = readNames(env, fresh);                 // runs beside the chain read
  if (builders.length) {
    const key = new Request("https://cache.saints-forge.internal/network/v2/" + encodeURIComponent(builders.map(b => b.address).join(",")));
    let hit = null; try { hit = fresh ? null : await caches.default.match(key); } catch (e) {}
    if (hit) { const c = await hit.json(); chain = c.chain; at = c.at; cached = true; }
    else {
      try {
        chain = await readChain(builders);
        try { await caches.default.put(key, new Response(JSON.stringify({ chain, at }), { headers: { "Cache-Control": "max-age=" + CACHE_SECONDS } })); } catch (e) {}
      } catch (e) { error = String(e && e.message || e).slice(0, 200); }
    }
  }
  return json({ ok: true, at, cached, error, canEdit: canUpload(env, s), list, assemblies: chain.assemblies, nodes: chain.nodes, names: Object.assign({ source: "EF-Map" }, await namesP) }, 200, cookies);
}

const SYS = v => typeof v === "string" && v.length >= 1 && v.length <= 24;
const ADDR = v => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
const KINDS = ["Mini Catapult", "Heavy Catapult", "Mini Gate", "Heavy Gate", "Public Gate", "Our Road"];   // Our Road = a road of ours the plan rides   // Public Gate = an NPC stargate someone has jumped (nothing to build)
function checkList(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "Not a network list.";
  if (!Array.isArray(d.builders) || d.builders.length > MAX_BUILDERS || !d.builders.every(b => b && typeof b.name === "string" && b.name.length <= 40 && ADDR(b.address))) return "builders must be up to " + MAX_BUILDERS + " of {name, address}.";
  const SID = v => Number.isInteger(v) && v >= 30000000 && v <= 39999999;
  for (const k of ["nodes", "launchers", "links", "notes"]) if (d[k] != null && Object.keys(d[k]).length) return k + ": roads are read from the chain only; nothing is placed by hand.";
  const maps = [["systems", v => SID(v) || (v && typeof v === "object" && SID(v.id) && (v.sure == null || typeof v.sure === "boolean"))]];
  for (const [k, ok] of maps) {
    const m = d[k] == null ? {} : d[k];
    if (typeof m !== "object" || Array.isArray(m) || Object.keys(m).length > 300) return k + " must be a map.";
    for (const [id, v] of Object.entries(m)) if (!SYS(id) || !ok(v)) return k + ": bad entry " + String(id).slice(0, 20) + ".";
  }
  if (d.home != null && d.home !== "" && !SYS(d.home)) return "home must be a system name.";
  // public (NPC) stargates someone has jumped: pairs of full system names, the only hand record on the page
  const gates = d.gates == null ? [] : d.gates;
  const GATE_STATES = ["working", "unfueled", "dormant"], DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  if (!Array.isArray(gates) || gates.length > 500 || !gates.every(g => g && SYS(g.a) && SYS(g.b) && g.a !== g.b && (g.note == null || (typeof g.note === "string" && g.note.length <= 80))
      && (g.state == null || GATE_STATES.includes(g.state)) && (g.seen == null || (typeof g.seen === "string" && DAY.test(g.seen))))) return "gates must be a list of {a, b, state?, seen?} (a gate someone has jumped; state working, unfueled or dormant; seen YYYY-MM-DD).";
  const plans = d.plans == null ? [] : d.plans;
  const HSTAT = ["planned", "progress", "built"], DAYS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  const HOP = h => h && SID(h.from) && SID(h.to) && (h.gap === true || KINDS.includes(h.kind)) && (h.ly == null || typeof h.ly === "number") && (h.fromName == null || SYS(h.fromName)) && (h.toName == null || SYS(h.toName))
    && (h.status == null || HSTAT.includes(h.status)) && (h.who == null || (typeof h.who === "string" && h.who.length <= 24)) && (h.by == null || (typeof h.by === "string" && DAYS.test(h.by)))
    && (h.leg == null || h.leg === "back") && (h.step == null || h.step === "gate") && (h.free == null || h.free === true) && (h.state == null || GATE_STATES.includes(h.state));
  const PLAN = p => p && typeof p.name === "string" && p.name.length <= 40 && (p.note == null || (typeof p.note === "string" && p.note.length <= 400)) && Array.isArray(p.hops) && p.hops.length <= 400 && p.hops.every(HOP)
    && (p.mode == null || ["access", "corridor", "tree"].includes(p.mode)) && (p.priorities == null || (Array.isArray(p.priorities) && p.priorities.length <= 6 && p.priorities.every(k => typeof k === "string" && k.length <= 12)));
  if (!Array.isArray(plans) || plans.length > 20 || !plans.every(PLAN)) return "plans must be a list of {name, note, mode?, priorities?, hops: [{from, to, kind | gap, ly, status?, who?, by?}]}.";
  return null;
}

export async function onRequestPost({ request, env }) {
  const { s, cookies } = await session(env, request);
  if (!s) return json({ ok: false }, 401, cookies);
  if (!canUpload(env, s)) return json({ ok: false, error: "Paladins, Knights and the site keepers only." }, 403, cookies);
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503, cookies);
  const text = await request.text();
  if (text.length > 200 * 1024) return json({ ok: false, error: "Too large." }, 413, cookies);
  let d; try { d = JSON.parse(text); } catch (e) { return json({ ok: false, error: "Not JSON." }, 400, cookies); }
  const bad = checkList(d);
  if (bad) return json({ ok: false, error: bad }, 400, cookies);
  const clean = { builders: d.builders.map(b => ({ name: b.name, address: b.address })), home: d.home || "", systems: d.systems || {}, gates: d.gates || [], plans: d.plans || [],
                  updated: new Date().toISOString(), updated_by: s.n };
  await env.DOCTRINE.put("network", JSON.stringify(clean));
  return json({ ok: true, by: s.n }, 200, cookies);
}

/* for tests only (tools and the browser import this module and call the pieces; Pages ignores extra exports) */
export const __test = { readChain, checkList, getObjects, ownedIds, readNames, cleanNames, fuelEfficiency, FUEL_EFF };
