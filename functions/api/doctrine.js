/* /api/doctrine
   GET: the doctrine fits, only with a valid tribe session. The data lives in the KV namespace bound as DOCTRINE
        (key "fits", a JSON object {generated, presets: [...]}), never in the public files.
   POST: replace the fits (Knights, the tribe leader and the ids in DOCTRINE_ADMINS): the body is the file written by
        tools/export_doctrine_payload.py. Checked to be JSON with a presets list before it is stored. */
import { session, json, canUpload } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const { s, cookies } = await session(env, request);
  if (!s) return json({ ok: false }, 401, cookies);
  const data = env.DOCTRINE ? await env.DOCTRINE.get("fits") : null;
  if (!data) return json({ ok: false, error: "The doctrine store is empty." }, 503, cookies);
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(data, { status: 200, headers: h });
}

export async function onRequestPost({ request, env }) {
  const { s, cookies } = await session(env, request);
  if (!s) return json({ ok: false }, 401, cookies);
  if (!canUpload(env, s)) return json({ ok: false, error: "Knights and the site keepers only." }, 403, cookies);
  if (!env.DOCTRINE) return json({ ok: false, error: "No doctrine store is bound." }, 503, cookies);
  const text = await request.text();
  if (text.length > 1024 * 1024) return json({ ok: false, error: "Too large." }, 413, cookies);
  let data;
  try { data = JSON.parse(text); } catch (e) { return json({ ok: false, error: "Not JSON." }, 400, cookies); }
  if (!data || !Array.isArray(data.presets) || !data.presets.every(p => p && p.name && p.hull && Array.isArray(p.placements)))
    return json({ ok: false, error: "Not a doctrine payload (expected {presets: [...]})." }, 400, cookies);
  await env.DOCTRINE.put("fits", JSON.stringify(data));
  return json({ ok: true, fits: data.presets.length, by: s.n, generated: data.generated || null }, 200, cookies);
}
