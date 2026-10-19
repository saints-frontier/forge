/* Short Forge links (2026-10-19, "is there a way to make the links shorter?"): the Forge sends the fit's link hash, the
   store keeps it under an id made from its SHA-256 (the same fit always gets the same id, so a second share writes
   nothing), and thesaintsforge.com/f/<id> opens it (functions/f/[id].js). Anyone may make one, as anyone may share a
   long link: only Forge link hashes are taken (the JSON form "eyJ..." or the compact "F..."), at most 3,000 characters,
   and one address may make 40 new ones an hour (counted in the edge cache, so the limit costs no store writes).
     POST {h}        -> {ok, id}
     GET  ?id=<id>   -> {ok, h}  (the Forge's Compare reads short links this way)
   KV binding DOCTRINE, keys "f:<id>". Nothing about who made a link is kept. */
import { json } from "./_lib.js";

const HASH = /^(eyJ[A-Za-z0-9_-]{20,3000}|F[A-Za-z0-9_-]{16,3000})$/;
const ID = /^[A-Za-z0-9]{6,14}$/;
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PER_HOUR = 40;

async function ids(h) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(h)));
  let s = ""; for (let k = 0; k < 14; k++) s += B62[d[k] % 62];
  return [s.slice(0, 7), s.slice(0, 10), s];                 // longer ids only if a shorter one is taken by another fit
}

async function overLimit(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown", hour = Math.floor(Date.now() / 3600000);
  const key = new Request(`https://short-limit.invalid/${encodeURIComponent(ip)}/${hour}`);
  const cache = caches.default, hit = await cache.match(key), n = hit ? +(await hit.text()) || 0 : 0;
  if (n >= PER_HOUR) return true;
  await cache.put(key, new Response(String(n + 1), { headers: { "cache-control": "max-age=3700" } }));
  return false;
}

export async function onRequestPost({ request, env }) {
  if (+(request.headers.get("content-length") || 0) > 4000) return json({ ok: false, error: "too big" }, 413);
  let d; try { d = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, error: "bad body" }, 400); }
  const h = String((d && d.h) || "");
  if (!HASH.test(h)) return json({ ok: false, error: "not a Forge link" }, 400);
  if (!env.DOCTRINE) return json({ ok: false, error: "no store" }, 503);
  for (const id of await ids(h)) {
    const have = await env.DOCTRINE.get("f:" + id);
    if (have === h) return json({ ok: true, id });             // shared before: nothing to write
    if (have) continue;                                        // another fit has this id: take the longer one
    if (await overLimit(request)) return json({ ok: false, error: "too many new links from here this hour" }, 429);
    await env.DOCTRINE.put("f:" + id, h);
    return json({ ok: true, id });
  }
  return json({ ok: false, error: "no free id" }, 500);
}

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!ID.test(id)) return json({ ok: false, error: "bad id" }, 400);
  if (!env.DOCTRINE) return json({ ok: false, error: "no store" }, 503);
  const h = await env.DOCTRINE.get("f:" + id);
  return h ? json({ ok: true, h }) : json({ ok: false, error: "unknown" }, 404);
}

export const __test = { ids, HASH, ID };
