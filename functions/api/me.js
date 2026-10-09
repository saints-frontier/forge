/* GET /api/me: who is logged in (name and rank), or 401. Re-checks the roles with Discord once a day. */
import { session, json } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const { s, cookies } = await session(env, request);
  return s ? json({ ok: true, name: s.n, rank: s.r }, 200, cookies) : json({ ok: false }, 401, cookies);
}
