/* /api/location: where a pilot is, for the Pilgrim Roads (user 2026-10-18: "it tracks my location on the map and highlights
   it in the pilgrim roads"; "Each pilot chooses" who sees it).
   POST (the Saints Frontier Companion with its companion key, or a tribe session): {system, at, share, character}.
        system = the name the game's Local chat log gives ("Channel changed to Local : ABC|D11"), or null when the pilot
        logs off or the companion stops (the record is removed). share = true shows the pilot to the whole tribe on the
        Roads; false (the default) keeps it to the pilot alone. Stored in the KV namespace DOCTRINE as "loc:u:<discord id>"
        for 6 hours (a stale position must not linger); the ids that share are listed in "loc:shared", written only when a
        pilot's share choice changes.
   GET (a tribe session only): {me, mates}: the caller's own record and every record of a pilot who shares. Never public. */
import { json } from "./_lib.js";
import { who } from "./quarry.js";

const PREFIX = "loc:u:", SHARED = "loc:shared", TTL = 6 * 3600;
const NAME = /^[A-Za-z0-9|.\- ]{2,40}$/;

const clean = (x, n) => String(x == null ? "" : x).replace(/[<>]/g, "").trim().slice(0, n);

async function sharedIds(env) {
  try { const v = await env.DOCTRINE.get(SHARED, "json"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
}

export async function onRequestPost({ request, env }) {
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503);
  const { s, cookies } = await who(env, request);
  if (!s || !s.u) return json({ ok: false, error: "Log in, or paste your companion key into the companion." }, 401, cookies);
  const text = await request.text();
  if (text.length > 2000) return json({ ok: false, error: "Too large." }, 413, cookies);
  let d; try { d = JSON.parse(text); } catch (e) { return json({ ok: false, error: "Not JSON." }, 400, cookies); }
  if (!d || typeof d !== "object") return json({ ok: false, error: "Not an object." }, 400, cookies);
  const key = PREFIX + s.u, share = d.share === true;
  const shared = await sharedIds(env), was = !!shared[s.u];
  if (d.system == null || d.system === "") {
    await env.DOCTRINE.delete(key);
    if (was) { delete shared[s.u]; await env.DOCTRINE.put(SHARED, JSON.stringify(shared)); }
    MATES = null;
    return json({ ok: true, cleared: true }, 200, cookies);
  }
  const system = String(d.system).trim();
  if (!NAME.test(system)) return json({ ok: false, error: "That is not a system name." }, 400, cookies);
  const at = Date.parse(d.at) || Date.now();
  if (at > Date.now() + 5 * 60 * 1000) return json({ ok: false, error: "The time is in the future." }, 400, cookies);
  const rec = { u: String(s.u), n: clean(s.n, 60), c: clean(d.character, 40), s: system, at: new Date(at).toISOString(), share };
  await env.DOCTRINE.put(key, JSON.stringify(rec), { expirationTtl: TTL });
  if (share !== was) { if (share) shared[s.u] = 1; else delete shared[s.u]; await env.DOCTRINE.put(SHARED, JSON.stringify(shared)); }
  MATES = null;                                       // this isolate's copy of the shared list is stale now
  return json({ ok: true, system, share }, 200, cookies);
}

/* the shared records, read once per isolate every 20 s: every Roads page asks every 30 s and each ask used to cost one KV
   read per sharing pilot (the free plan's 100,000 reads a day; bug squash 2026-10-21). A pilot's own record is always fresh. */
let MATES = null, MATES_AT = 0;
async function matesList(env) {
  if (MATES && Date.now() - MATES_AT < 20000) return MATES;
  const shared = await sharedIds(env), out = [];
  for (const id of Object.keys(shared).slice(0, 60)) {
    const r = await env.DOCTRINE.get(PREFIX + id, "json");
    if (r && r.share) out.push({ u: String(id), n: r.n, c: r.c, s: r.s, at: r.at });
  }
  MATES = out; MATES_AT = Date.now();
  return out;
}

export async function onRequestGet({ request, env }) {
  const { s, key, cookies } = await who(env, request);
  if (!s || !s.u || key) return json({ ok: false }, 401, cookies);         // the Roads page only: a tribe login, not a key
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503, cookies);
  const me = await env.DOCTRINE.get(PREFIX + s.u, "json");
  const mates = (await matesList(env)).filter(r => r.u !== String(s.u)).map(r => ({ n: r.n, c: r.c, s: r.s, at: r.at }));
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(JSON.stringify({ ok: true, me: me ? { n: me.n, c: me.c, s: me.s, at: me.at, share: !!me.share } : null, mates }), { status: 200, headers: h });
}

export const __test = { NAME, clean, matesList, reset: () => { MATES = null; } };
