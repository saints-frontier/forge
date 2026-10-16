/* /api/quarry: the tribe's mining samples for The Quarry (web/quarry), sent by the Quarry companion
   (frontier-toolkit ftk/quarry_app.py) at the end of a mining session.
   GET  public: every stored run with its public fields only (rock, date, cuts, units per ore, minutes, hold-full,
        contributor's name). No character names, no times of day, no systems, no notes. Cached in the edge cache for
        5 minutes (caches.default) and in the browser for 1 minute.
   POST a Quarry key (Authorization: Bearer, from /api/appkey) or a tribe session: {character, runs: [...]}; each run
        is checked field by field and stored under its id (sha of character + start, made by the companion), so a
        session sent twice stores once. Each MEMBER'S RUNS LIVE UNDER THEIR OWN KV KEY ("quarry:u:<discord id>"), so
        two members sending at the same time never overwrite each other (KV has no compare-and-swap). A run may only
        be replaced by the member who sent it, or removed by them or, with a tribe SESSION (not a key: a key's rank
        is frozen when it is minted), by a keeper ({remove: [ids]}). A key is revoked by minting a new one
        (/api/appkey bumps the member's serial, "quarry:key:<id>", which every key must match). */
import { session, json, verify, canUpload } from "./_lib.js";

const PREFIX = "quarry:u:", SERIAL = "quarry:key:", CACHE_PATH = "/api/quarry";
const MAX_RUNS = 5000, MAX_PER_POST = 200, MAX_NOTE = 300, MAX_BODY = 512 * 1024;
const ORES = ["Crustal Anorthosite Crystals", "Massive Ataxite Matrix", "Hydrated Gossan Matrix", "Irradiated Anthraxolite Veins",
  "Irradiated Cryoconite Nodules", "Primordial Anthraxolite Sludge", "Primitive Rime Shards", "Native Reef Nodules"];
// the rock names The Quarry knows (tools/export_quarry_data.py keeps these two lists in step with data.js and refuses
// to export when they differ); anything else is refused, so a stray word can never become a "rock" on the public page
export const FAMILIES = ["Bone", "Char", "Ember", "Flint", "Glaze", "Grist", "Ingot", "Marrow", "Mire", "Murk", "Pitch", "Rind", "Scale", "Soot", "Spall", "Spar"];
export const PREFIXES = ["Hollow", "Shocked", "Prime", "Deep"];
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

async function who(env, request) {
  const auth = request.headers.get("Authorization") || "";
  if (/^Bearer\s+/i.test(auth)) {
    const t = await verify(env, auth.replace(/^Bearer\s+/i, "").trim());
    if (!t || t.k !== "quarry" || !t.u || !Number.isInteger(t.v)) return { s: null, key: true, cookies: [] };
    const serial = env.DOCTRINE ? await env.DOCTRINE.get(SERIAL + t.u) : null;       // a newer key revokes this one
    if (serial == null || Number(serial) !== t.v) return { s: null, key: true, cookies: [] };
    return { s: { u: t.u, n: t.n, r: t.r }, key: true, cookies: [] };
  }
  const r = await session(env, request);
  return { s: r.s, key: false, cookies: r.cookies };
}

const titleCase = s => s.trim().split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");

export function checkRun(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "a run must be an object";
  if (!/^[0-9a-f]{12}$/.test(String(r.id || ""))) return "bad id";
  const rock = String(r.rock || "").trim();
  if (!/^[A-Za-z]{2,20}( [A-Za-z]{2,20})?$/.test(rock)) return `${r.id}: a rock name is one or two words`;
  const words = titleCase(rock).split(" ");
  if (!FAMILIES.includes(words[words.length - 1]) || (words.length === 2 && !PREFIXES.includes(words[0])))
    return `${r.id}: unknown rock "${rock}" (ask a keeper to add it to The Quarry first)`;
  if (!TS.test(String(r.start || "")) || !TS.test(String(r.end || "")) || r.end < r.start) return `${r.id}: bad start/end`;
  if (!Number.isInteger(r.cuts) || r.cuts < 1 || r.cuts > 100000) return `${r.id}: bad cut count`;
  if (!r.ores || typeof r.ores !== "object" || Array.isArray(r.ores)) return `${r.id}: ores missing`;
  let total = 0;
  for (const o of Object.keys(r.ores)) {
    if (!ORES.includes(o)) return `${r.id}: unknown ore "${o}"`;
    if (!Number.isInteger(r.ores[o]) || r.ores[o] < 1 || r.ores[o] > 10000000) return `${r.id}: bad units for ${o}`;
    total += r.ores[o];
  }
  if (total < 1) return `${r.id}: no units`;
  if (typeof r.minutes !== "number" || !(r.minutes >= 0.1 && r.minutes <= 1440)) return `${r.id}: bad minutes`;
  if (!Number.isInteger(r.full) || r.full < 0 || r.full > 1000) return `${r.id}: bad hold-full count`;
  if (r.reads && (typeof r.reads !== "object" || !Number.isInteger(r.reads.agree) || !Number.isInteger(r.reads.total)
      || r.reads.agree < 0 || r.reads.total < r.reads.agree || r.reads.total > 100000)) return `${r.id}: bad reads`;
  if (r.note != null && (typeof r.note !== "string" || r.note.length > MAX_NOTE || /[<>]/.test(r.note))) return `${r.id}: bad note`;
  return null;
}

const pub = r => ({ id: r.id, rock: r.rock, date: r.start.slice(0, 10), cuts: r.cuts, ores: r.ores, minutes: r.minutes, full: r.full > 0, by: r.by });

async function readUser(env, u) {
  const raw = await env.DOCTRINE.get(PREFIX + u);
  let d = null;
  try { d = raw ? JSON.parse(raw) : null; } catch (e) { d = null; }
  return d && d.runs && typeof d.runs === "object" && !Array.isArray(d.runs) ? d : { runs: {} };
}

async function userIds(env) {
  const ids = [];
  let cursor;
  do {
    const page = await env.DOCTRINE.list({ prefix: PREFIX, cursor });
    for (const k of page.keys) ids.push(k.name.slice(PREFIX.length));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return ids;
}

async function readAll(env) {
  const all = {};
  if (!env.DOCTRINE) return all;
  for (const u of await userIds(env)) all[u] = await readUser(env, u);
  return all;
}

const cacheKey = request => new Request(new URL(request.url).origin + CACHE_PATH, { method: "GET" });

export async function onRequestGet({ request, env, waitUntil }) {
  const cache = typeof caches !== "undefined" && caches.default;
  if (cache) { const hit = await cache.match(cacheKey(request)); if (hit) return hit; }
  const all = await readAll(env);
  const runs = Object.values(all).flatMap(d => Object.values(d.runs)).map(pub).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const generatedAt = Math.max(0, ...Object.values(all).map(d => d.updatedAt || 0)) || null;
  const res = new Response(JSON.stringify({ ok: true, runs, generatedAt }),
    { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=300" } });
  if (cache) { const p = cache.put(cacheKey(request), res.clone()); if (waitUntil) waitUntil(p); else await p; }
  return res;
}

export async function onRequestPost({ request, env, waitUntil }) {
  const { s, key, cookies } = await who(env, request);
  if (!s) return json({ ok: false, error: key ? "This Quarry key is not valid any more: fetch a new one on the site." : "Not logged in (a Quarry key or the tribe login)." }, 401, cookies);
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503, cookies);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: "Too large." }, 413, cookies);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ ok: false, error: "Not JSON." }, 400, cookies); }
  if (!body || typeof body !== "object") return json({ ok: false, error: "Not an object." }, 400, cookies);
  const me = String(s.u), keeper = !key && canUpload(env, s);
  const mine = await readUser(env, me), touched = { [me]: mine };
  let removed = 0, stored = 0;
  if (Array.isArray(body.remove)) {
    const others = keeper ? await readAll(env) : {};
    for (const id of body.remove.map(String)) {
      if (own(mine.runs, id)) { delete mine.runs[id]; removed++; continue; }
      if (!keeper) continue;
      for (const [u, d] of Object.entries(others)) {
        if (u !== me && own(d.runs, id)) { delete d.runs[id]; removed++; touched[u] = d; break; }
      }
    }
  }
  if (Array.isArray(body.runs)) {
    if (body.runs.length > MAX_PER_POST) return json({ ok: false, error: `At most ${MAX_PER_POST} runs per upload.` }, 400, cookies);
    for (const r of body.runs) {
      const bad = checkRun(r);
      if (bad) return json({ ok: false, error: bad }, 400, cookies);
    }
    for (const r of body.runs) {
      const old = own(mine.runs, r.id) ? mine.runs[r.id] : null;      // another member's run of the same id stays theirs: ids carry the character
      mine.runs[r.id] = { id: r.id, rock: titleCase(r.rock), start: r.start, end: r.end, cuts: r.cuts, ores: r.ores, minutes: Math.round(r.minutes * 10) / 10,
        full: r.full, reads: r.reads ? { agree: r.reads.agree, total: r.reads.total } : null, note: (r.note || "").trim(),
        by: old ? old.by : s.n, u: me, at: Date.now() };
      stored++;
    }
  }
  const n = Object.keys(mine.runs).length;
  if (n > MAX_RUNS) return json({ ok: false, error: `Your part of the store is full (${n} runs).` }, 507, cookies);
  for (const [u, d] of Object.entries(touched)) {
    d.updatedAt = Date.now();
    await env.DOCTRINE.put(PREFIX + u, JSON.stringify(d));
  }
  const cache = typeof caches !== "undefined" && caches.default;
  if (cache) { const p = cache.delete(cacheKey(request)); if (waitUntil) waitUntil(p); else await p; }   // this colo; others keep it up to 5 min
  return json({ ok: true, stored, removed, by: s.n, mine: n }, 200, cookies);
}
