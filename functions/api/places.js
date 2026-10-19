/* /api/places: a pilot's own places (user 2026-10-19: "let me set a home system. let me set multiple systems as
   bookmarks"), shared by the Pilgrim Roads and the companion's navigator. One record per pilot, KV namespace DOCTRINE,
   key "places:u:<discord id>" = { home: {to, name} | null, marks: [{to, name}, ...] }, kept until changed.
   GET  (tribe session or companion key): { ok, home, marks }
   POST (tribe session or companion key), one change at a time:
        { home: {to, name} }  set the home      { home: null }  forget it
        { add: {to, name} }   add a bookmark    { remove: <system number> }  drop one
   Only the pilot's own record is read or written; a change that changes nothing writes nothing. */
import { json } from "./_lib.js";
import { who } from "./quarry.js";

const PREFIX = "places:u:", MAX_MARKS = 30;
const NAME = /^[A-Za-z0-9|.\-#() ]{1,40}$/;
const place = p => {
  if (!p || typeof p !== "object") return null;
  const to = Number(p.to), name = String(p.name == null ? "" : p.name).trim();
  return Number.isInteger(to) && to >= 30000000 && to <= 39999999 && NAME.test(name) ? { to, name } : null;
};
const clean = r => ({ home: place(r && r.home), marks: (Array.isArray(r && r.marks) ? r.marks : []).map(place).filter(Boolean).slice(0, MAX_MARKS) });

function answer(obj, status, cookies) {
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" });
  for (const c of cookies || []) h.append("Set-Cookie", c);
  return new Response(JSON.stringify(obj), { status, headers: h });
}

export async function onRequestGet({ request, env }) {
  const { s, cookies } = await who(env, request);
  if (!s || !s.u) return json({ ok: false }, 401, cookies);
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503, cookies);
  const r = clean(await env.DOCTRINE.get(PREFIX + s.u, "json"));
  return answer(Object.assign({ ok: true }, r), 200, cookies);
}

export async function onRequestPost({ request, env }) {
  if (!env.DOCTRINE) return json({ ok: false, error: "No store is bound." }, 503);
  const { s, cookies } = await who(env, request);
  if (!s || !s.u) return json({ ok: false, error: "Log in, or paste your companion key into the companion." }, 401, cookies);
  const text = await request.text();
  if (text.length > 1000) return json({ ok: false, error: "Too large." }, 413, cookies);
  let d; try { d = JSON.parse(text); } catch (e) { return json({ ok: false, error: "Not JSON." }, 400, cookies); }
  if (!d || typeof d !== "object") return json({ ok: false, error: "Not an object." }, 400, cookies);
  const key = PREFIX + s.u, r = clean(await env.DOCTRINE.get(key, "json")), before = JSON.stringify(r);
  if ("home" in d) {
    if (d.home === null) r.home = null;
    else { const p = place(d.home); if (!p) return json({ ok: false, error: "That is not a system." }, 400, cookies); r.home = p; }
  } else if ("add" in d) {
    const p = place(d.add); if (!p) return json({ ok: false, error: "That is not a system." }, 400, cookies);
    if (!r.marks.some(m => m.to === p.to)) {
      if (r.marks.length >= MAX_MARKS) return json({ ok: false, error: `${MAX_MARKS} bookmarks at most: drop one first.` }, 400, cookies);
      r.marks.push(p);
    }
  } else if ("remove" in d) {
    const to = Number(d.remove); r.marks = r.marks.filter(m => m.to !== to);
  } else return json({ ok: false, error: "Nothing to change." }, 400, cookies);
  if (JSON.stringify(r) !== before) {
    if (!r.home && !r.marks.length) await env.DOCTRINE.delete(key); else await env.DOCTRINE.put(key, JSON.stringify(r));
  }
  return answer(Object.assign({ ok: true }, r), 200, cookies);
}

export const __test = { clean, place };
