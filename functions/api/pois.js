/* /api/pois
   GET: the Pilgrim Roads' points of interest (rare stars, old capitals, long-haul gates, kill hotspots), only with a valid
        tribe session. Lives in the KV namespace bound as DOCTRINE under the key "pois", never in the public files (user
        2026-10-18: "Take pois.json out of the public files and serve it only to that login, like the doctrine fits").
   POST: replace it (Paladins, Knights, the tribe leader and the ids in DOCTRINE_ADMINS): the body is the file written by
        tools/export_pois.py ({generated, categories: [{key, label, color, note, on, items: [[systemId, extra], ...]}]}),
        checked before it is stored. */
import { session, json, canUpload } from "./_lib.js";

const MAX_CATS = 40, MAX_ITEMS = 5000, MAX_TEXT = 400;
function checkPayload(d) {
  if (!d || typeof d !== "object" || !Array.isArray(d.categories)) return "Not a points-of-interest file (expected {categories: [...]}).";
  if (d.categories.length > MAX_CATS) return `Too many categories (${d.categories.length} > ${MAX_CATS}).`;
  const keys = new Set();
  for (const c of d.categories) {
    if (!c || typeof c !== "object") return "A category is not an object.";
    if (typeof c.key !== "string" || !/^[a-z0-9_-]{1,20}$/.test(c.key) || keys.has(c.key)) return "Each category needs a unique short key (a-z, 0-9).";
    keys.add(c.key);
    for (const f of ["label", "note"]) if (typeof c[f] !== "string" || c[f].length > MAX_TEXT || /[<>]/.test(c[f])) return `${c.key}: ${f} must be text of at most ${MAX_TEXT} characters without < or >.`;
    if (typeof c.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(c.color)) return `${c.key}: color must be #rrggbb.`;
    if (!Array.isArray(c.items) || c.items.length > MAX_ITEMS) return `${c.key}: items must be a list of at most ${MAX_ITEMS}.`;
    for (const it of c.items)
      if (!Array.isArray(it) || it.length !== 2 || !Number.isInteger(it[0]) || it[0] < 30000000 || it[0] > 39999999 || typeof it[1] !== "string" || it[1].length > 40 || /[<>]/.test(it[1])) return `${c.key}: an item must be [system number, short text].`;
  }
  return null;
}

export async function onRequestGet({ request, env }) {
  const { s, cookies } = await session(env, request);
  if (!s) return json({ ok: false }, 401, cookies);
  const data = env.DOCTRINE ? await env.DOCTRINE.get("pois") : null;
  if (!data) return json({ ok: false, error: "No points of interest are stored yet." }, 503, cookies);
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(data, { status: 200, headers: h });
}

export async function onRequestPost({ request, env }) {
  const { s, cookies } = await session(env, request);
  if (!s) return json({ ok: false }, 401, cookies);
  if (!canUpload(env, s)) return json({ ok: false, error: "Paladins, Knights and the site keepers only." }, 403, cookies);
  if (!env.DOCTRINE) return json({ ok: false, error: "No doctrine store is bound." }, 503, cookies);
  const text = await request.text();
  if (text.length > 512 * 1024) return json({ ok: false, error: "Too large." }, 413, cookies);
  let data;
  try { data = JSON.parse(text); } catch (e) { return json({ ok: false, error: "Not JSON." }, 400, cookies); }
  const bad = checkPayload(data);
  if (bad) return json({ ok: false, error: bad }, 400, cookies);
  await env.DOCTRINE.put("pois", JSON.stringify(data));
  return json({ ok: true, pois: data.categories.reduce((a, c) => a + c.items.length, 0), by: s.n }, 200, cookies);
}

export const __test = { checkPayload };
