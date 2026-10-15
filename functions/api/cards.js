/* /api/cards
   GET: the doctrine ship-card prose (title, role, origin, motto, latin, weapon, purpose, how, why, sigil per doctrine
        fit name), only with a valid tribe session. Lives in the KV namespace bound as DOCTRINE under the key "cards",
        never in the public files: the card art, fonts and renderer are public, the words of the doctrine cards are not.
   POST: replace it (Paladins, Knights, the tribe leader and the ids in DOCTRINE_ADMINS): the body is the file written
        by tools/export_card_payload.py ({generated, cards: {name: {...}}}), checked before it is stored. */
import { session, json, canUpload } from "./_lib.js";

const FIELDS = ["title", "role", "origin", "motto", "latin", "weapon", "purpose", "how", "why", "sigil"];
const MAX_CARDS = 60, MAX_NAME = 60, MAX_TEXT = 2000;
function checkPayload(d) {
  if (!d || typeof d !== "object" || !d.cards || typeof d.cards !== "object" || Array.isArray(d.cards)) return "Not a card payload (expected {cards: {name: {...}}}).";
  const names = Object.keys(d.cards);
  if (names.length > MAX_CARDS) return `Too many cards (${names.length} > ${MAX_CARDS}).`;
  for (const name of names) {
    if (!name.trim() || name.length > MAX_NAME || /[<>]/.test(name)) return `A card name must be 1-${MAX_NAME} characters without < or >.`;
    const c = d.cards[name];
    if (!c || typeof c !== "object" || Array.isArray(c)) return `${name}: not an object.`;
    for (const k of Object.keys(c)) {
      if (!FIELDS.includes(k)) return `${name}: unknown field "${k}".`;
      if (typeof c[k] !== "string" || c[k].length > MAX_TEXT) return `${name}: ${k} must be a string of at most ${MAX_TEXT} characters.`;
    }
  }
  return null;
}

export async function onRequestGet({ request, env }) {
  const { s, cookies } = await session(env, request);
  if (!s) return json({ ok: false }, 401, cookies);
  const data = env.DOCTRINE ? await env.DOCTRINE.get("cards") : null;
  if (!data) return json({ ok: false, error: "No card text is stored yet." }, 503, cookies);
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
  await env.DOCTRINE.put("cards", JSON.stringify(data));
  return json({ ok: true, cards: Object.keys(data.cards).length, by: s.n }, 200, cookies);
}
