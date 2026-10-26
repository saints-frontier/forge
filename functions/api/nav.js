/* /api/nav: where a pilot wants to go (user 2026-10-19: "a navigation feature to the companion that would tell me where
   to jump next to get to where i want to be"; the destination is set on the Pilgrim Roads or on the companion page).
   One record per pilot, KV namespace DOCTRINE, key "nav:u:<discord id>" = { to, name, at }, kept 7 days.
   GET  (tribe session or companion key): { ok, nav: {to, name, way, avoid, at} | null }
   POST (tribe session or companion key): { to: <system number>, name } sets it; { to: null, name } sets a system that
        has no number yet (our roads reach it by name, 2026-10-20); { to: null } with no name clears it.
   Only the pilot's own record is read or written. The route itself is worked out on the page (roadscore.js). */
import { json } from "./_lib.js";
import { who } from "./quarry.js";

const PREFIX = "nav:u:", TTL = 7 * 86400;
const NAME = /^[A-Za-z0-9|.\-#() ]{1,40}$/;
const WAYS = ["safe", "ours", "known", "short"];
const AVOID = /^(3\d{7}|n:[A-Za-z0-9|.\-#() ]{1,40})>(3\d{7}|n:[A-Za-z0-9|.\-#() ]{1,40})$/;   // "from>to" of the navigator's ids

export async function onRequestGet({ request, env }) {
  const { s, cookies } = await who(env, request);
  if (!s || !s.u) return json({ ok: false }, 401, cookies);
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503, cookies);
  const nav = await env.DOCTRINE.get(PREFIX + s.u, "json");
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(JSON.stringify({ ok: true, nav: nav || null }), { status: 200, headers: h });
}

export async function onRequestPost({ request, env }) {
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503);
  const { s, cookies } = await who(env, request);
  if (!s || !s.u) return json({ ok: false, error: "Log in, or paste your companion key into the companion." }, 401, cookies);
  const text = await request.text();
  if (text.length > 4000) return json({ ok: false, error: "Too large." }, 413, cookies);
  let d; try { d = JSON.parse(text); } catch (e) { return json({ ok: false, error: "Not JSON." }, 400, cookies); }
  if (!d || typeof d !== "object") return json({ ok: false, error: "Not an object." }, 400, cookies);
  const key = PREFIX + s.u;
  if (d.to == null && !d.name) { await env.DOCTRINE.delete(key); return json({ ok: true, nav: null }, 200, cookies); }
  const to = d.to == null ? null : Number(d.to), name = String(d.name == null ? "" : d.name).trim();
  if (to !== null && (!Number.isInteger(to) || to < 30000000 || to > 39999999)) return json({ ok: false, error: "That is not a system number." }, 400, cookies);
  if (!NAME.test(name)) return json({ ok: false, error: "That is not a system name." }, 400, cookies);
  /* the way the pilot chose and the hops struck off (2026-10-26): kept with the destination so the Map and the
     companion plan the same route; a POST without them keeps what was stored for the same destination */
  const old = await env.DOCTRINE.get(key, "json");
  const same = old && old.to === to && old.name === name;
  const way = WAYS.includes(d.way) ? d.way : same && WAYS.includes(old.way) ? old.way : "safe";
  let avoid = Array.isArray(d.avoid) ? d.avoid : same && Array.isArray(old.avoid) ? old.avoid : [];
  avoid = [...new Set(avoid.map(String).filter(a => AVOID.test(a)))].slice(0, 24);
  const nav = { to, name, way, avoid, at: new Date().toISOString() };
  await env.DOCTRINE.put(key, JSON.stringify(nav), { expirationTtl: TTL });
  return json({ ok: true, nav }, 200, cookies);
}

export const __test = { NAME, WAYS, AVOID };
