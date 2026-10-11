/* /api/network: the tribe's road network (catapults, gates and their Network Nodes), for logged-in tribe members only.
   GET  -> { ok, at, canEdit, list, assemblies: [...], nodes: [...] }
           assemblies and nodes are read from the chain (Sui GraphQL, read-only queries: nothing is signed or sent);
           `list` is the hand-kept list from the KV store (key "network" in the DOCTRINE namespace): which characters
           build for the tribe, which system a node stands in, launchers placed by hand, links the chain cannot show.
           The page (roads.js) joins the two.
   POST -> replace the hand-kept list (Paladins, Knights, site keepers), validated first.
   Nothing about the network lives in this repository: the builders' addresses and every system name are in KV only. */
import { session, json, canUpload } from "./_lib.js";

const SUI = "https://graphql.testnet.sui.io/graphql";
const CATAPULT = { "95627": "Mini Catapult", "95628": "Mini Catapult", "95677": "Heavy Catapult", "95717": "Heavy Catapult" };
const FIELDS = "address asMoveObject { contents { type { repr } json } }";
const CACHE_SECONDS = 300, MAX_BUILDERS = 12, MAX_PAGES = 8;
const EMPTY = { builders: [], nodes: {}, launchers: {}, links: [], notes: {}, home: "" };

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
  const nodes = [];
  for (const [id, o] of await getObjects([...nodeIds])) {
    const j = o.json, f = j.fuel || {};
    nodes.push({ id, name: label(j), status: variant(j), fuel: { quantity: +f.quantity || 0, max: +f.max_capacity || 0, burnMs: +f.burn_rate_in_ms || 0, burning: !!f.is_burning },
                 connected: (j.connected_assembly_ids || []).length });
  }
  return { assemblies, nodes };
}

async function loadList(env) {
  let raw = null; try { raw = env.DOCTRINE ? await env.DOCTRINE.get("network") : null; } catch (e) {}
  try { return Object.assign({}, EMPTY, raw ? JSON.parse(raw) : {}); } catch (e) { return Object.assign({}, EMPTY); }
}

export async function onRequestGet({ request, env }) {
  const { s, cookies } = await session(env, request);
  if (!s) return json({ ok: false }, 401, cookies);
  const list = await loadList(env);
  const builders = (list.builders || []).slice(0, MAX_BUILDERS);
  let chain = { assemblies: [], nodes: [] }, at = Date.now(), error = null, cached = false;
  if (builders.length) {
    const key = new Request("https://cache.saints-forge.internal/network/" + encodeURIComponent(builders.map(b => b.address).join(",")));
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    let hit = null; try { hit = fresh ? null : await caches.default.match(key); } catch (e) {}
    if (hit) { const c = await hit.json(); chain = c.chain; at = c.at; cached = true; }
    else {
      try {
        chain = await readChain(builders);
        try { await caches.default.put(key, new Response(JSON.stringify({ chain, at }), { headers: { "Cache-Control": "max-age=" + CACHE_SECONDS } })); } catch (e) {}
      } catch (e) { error = String(e && e.message || e).slice(0, 200); }
    }
  }
  return json({ ok: true, at, cached, error, canEdit: canUpload(env, s), list, assemblies: chain.assemblies, nodes: chain.nodes }, 200, cookies);
}

const SYS = v => typeof v === "string" && v.length >= 1 && v.length <= 24;
const ADDR = v => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
const KINDS = ["Mini Catapult", "Heavy Catapult", "Mini Gate", "Heavy Gate"];
function checkList(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "Not a network list.";
  if (!Array.isArray(d.builders) || d.builders.length > MAX_BUILDERS || !d.builders.every(b => b && typeof b.name === "string" && b.name.length <= 40 && ADDR(b.address))) return "builders must be up to " + MAX_BUILDERS + " of {name, address}.";
  const maps = [["nodes", v => SYS(v)], ["launchers", v => v && SYS(v.from) && SYS(v.to)], ["notes", v => typeof v === "string" && v.length <= 200]];
  for (const [k, ok] of maps) {
    const m = d[k] == null ? {} : d[k];
    if (typeof m !== "object" || Array.isArray(m) || Object.keys(m).length > 300) return k + " must be a map.";
    for (const [id, v] of Object.entries(m)) if ((k !== "notes" && !ADDR(id)) || (k === "notes" && !SYS(id)) || !ok(v)) return k + ": bad entry " + String(id).slice(0, 20) + ".";
  }
  const links = d.links == null ? [] : d.links;
  if (!Array.isArray(links) || links.length > 200 || !links.every(l => l && SYS(l.from) && SYS(l.to) && KINDS.includes(l.kind) && (l.note == null || (typeof l.note === "string" && l.note.length <= 120)))) return "links must be a list of {from, to, kind, note}.";
  if (d.home != null && d.home !== "" && !SYS(d.home)) return "home must be a system name.";
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
  const clean = { builders: d.builders.map(b => ({ name: b.name, address: b.address })), nodes: d.nodes || {}, launchers: d.launchers || {}, links: d.links || [], notes: d.notes || {}, home: d.home || "",
                  updated: new Date().toISOString(), updated_by: s.n };
  await env.DOCTRINE.put("network", JSON.stringify(clean));
  return json({ ok: true, by: s.n }, 200, cookies);
}

/* for tests only (tools and the browser import this module and call the pieces; Pages ignores extra exports) */
export const __test = { readChain, checkList, getObjects, ownedIds };
