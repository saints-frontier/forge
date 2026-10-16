/* /api/appkey  GET: a Quarry key for the logged-in Saint, for the Quarry companion (frontier-toolkit
   `python frontier.py quarry key`). The key is a signed token like the session cookie (same HMAC key, see _lib.js)
   carrying the member's Discord id, name and rank, marked k: "quarry", good for 90 days. It can only be spent on
   /api/quarry (that function checks the mark); used as a session cookie it fails at once, because it carries no
   refresh token. Each key carries a serial `v`; the member's current serial is stored in KV ("quarry:key:<id>") and
   bumped here on every mint, so FETCHING A NEW KEY REVOKES EVERY OLDER ONE (a leaked key: log in and fetch a new one).
   A key's rank is frozen at minting: /api/quarry never trusts it for keeper actions (those need the tribe session). */
import { session, json, sign } from "./_lib.js";

const DAYS = 24 * 3600 * 1000, LIFE = 90 * DAYS, SERIAL = "quarry:key:";

export async function onRequestGet({ request, env }) {
  const { s, cookies } = await session(env, request);
  if (!s) return json({ ok: false }, 401, cookies);
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503, cookies);
  const v = (Number(await env.DOCTRINE.get(SERIAL + s.u)) || 0) + 1;
  await env.DOCTRINE.put(SERIAL + s.u, String(v));
  const exp = Date.now() + LIFE;
  const key = await sign(env, { u: s.u, n: s.n, r: s.r, k: "quarry", v, iat: Date.now(), exp });
  return json({ ok: true, key, name: s.n, expires: new Date(exp).toISOString().slice(0, 10), serial: v }, 200, cookies);
}
