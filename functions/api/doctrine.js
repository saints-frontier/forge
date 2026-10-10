/* /api/doctrine
   GET: the doctrine fits, only with a valid tribe session. The data lives in the KV namespace bound as DOCTRINE
        (key "fits", a JSON object {generated, presets: [...]}), never in the public files.
   POST: replace the fits (Paladins, Knights, the tribe leader and the ids in DOCTRINE_ADMINS): the body is the file written by
        tools/export_doctrine_payload.py. Checked to be JSON with a presets list before it is stored. */
import { session, json, canUpload } from "./_lib.js";

/* A broken preset would break the Forge for every Saint (one bad name used to throw inside the page and hide the
   tribe box), so the shape is checked here, preset by preset. Returns the problem, or null when the payload is sound. */
const HULLS = ["Reiver", "LAI"], MAX_PRESETS = 60, MAX_PLACEMENTS = 400, MAX_NAME = 60, MAX_ROLE = 120;
function checkPayload(d) {
  if (!d || typeof d !== "object" || !Array.isArray(d.presets)) return "Not a doctrine payload (expected {presets: [...]}).";
  if (d.presets.length > MAX_PRESETS) return `Too many presets (${d.presets.length} > ${MAX_PRESETS}).`;
  const seenN = new Set(), seenName = new Set();
  for (const [i, p] of d.presets.entries()) {
    const at = `preset ${i + 1}`;
    if (!p || typeof p !== "object") return `${at}: not an object.`;
    if (typeof p.name !== "string" || !p.name.trim() || p.name.length > MAX_NAME) return `${at}: name must be a string of 1-${MAX_NAME} characters.`;
    if (seenName.has(p.name.toLowerCase())) return `${at}: the name "${p.name}" appears twice.`;
    seenName.add(p.name.toLowerCase());
    if (!HULLS.includes(p.hull)) return `${at} (${p.name}): hull must be one of ${HULLS.join(", ")}.`;
    if (!Number.isInteger(p.n) || p.n < 100 || seenN.has(p.n)) return `${at} (${p.name}): n must be a unique integer of 100 or more.`;
    seenN.add(p.n);
    if (p.role != null && (typeof p.role !== "string" || p.role.length > MAX_ROLE)) return `${at} (${p.name}): role must be a short string.`;
    if (!Array.isArray(p.placements) || p.placements.length > MAX_PLACEMENTS) return `${at} (${p.name}): placements must be a list of at most ${MAX_PLACEMENTS}.`;
    for (const q of p.placements) {
      if (!Array.isArray(q) || q.length !== 4 || typeof q[0] !== "string" || !Number.isInteger(q[1]) || !Number.isInteger(q[2])
          || !Array.isArray(q[3]) || !q[3].length || !q[3].every(c => Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1])))
        return `${at} (${p.name}): a placement must be [module, section, rotation, [[x, y], ...]].`;
    }
    for (const k of ["exterior", "carried"]) if (p[k] != null && (typeof p[k] !== "object" || Array.isArray(p[k]) || !Object.values(p[k]).every(v => Number.isInteger(v) && v >= 0)))
      return `${at} (${p.name}): ${k} must map module names to counts.`;
  }
  return null;
}

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
  if (!canUpload(env, s)) return json({ ok: false, error: "Paladins, Knights and the site keepers only." }, 403, cookies);
  if (!env.DOCTRINE) return json({ ok: false, error: "No doctrine store is bound." }, 503, cookies);
  const text = await request.text();
  if (text.length > 1024 * 1024) return json({ ok: false, error: "Too large." }, 413, cookies);
  let data;
  try { data = JSON.parse(text); } catch (e) { return json({ ok: false, error: "Not JSON." }, 400, cookies); }
  const bad = checkPayload(data);
  if (bad) return json({ ok: false, error: bad }, 400, cookies);
  await env.DOCTRINE.put("fits", JSON.stringify(data));
  return json({ ok: true, fits: data.presets.length, by: s.n, generated: data.generated || null }, 200, cookies);
}
