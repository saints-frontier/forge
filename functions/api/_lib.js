/* Saints Forge tribe login: shared code for the Cloudflare Pages Functions under /api.
   Discord OAuth2 (identify + guilds.members.read) -> the member's roles on The Saints server -> a signed cookie only
   when the member holds Squire or above. Secrets live in the project's environment variables, never in this repo:
     DISCORD_CLIENT_SECRET  the application's client secret (also seeds the cookie signing key)
     ALLOWED_ROLES          "Squire=<roleId>,Saint=<roleId>,Paladin=<roleId>,Knight=<roleId>,..." (or, instead,)
     DISCORD_BOT_TOKEN      a bot in the server with no permissions: roles are then matched by name
   The doctrine fits come from the KV namespace bound as DOCTRINE (key "fits"), never from the public files. */
export const CLIENT_ID = "1558205368553705522";
export const GUILD = "1358498942245142638";
export const RANKS = ["Squire", "Saint", "Paladin", "Knight"];     // lowest to highest; the leader role carries "Knight"
const SEVEN_DAYS = 7 * 24 * 3600 * 1000, ONE_DAY = 24 * 3600 * 1000;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function key(env) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode("saints-forge-session:" + (env.DISCORD_CLIENT_SECRET || "")));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function sign(env, obj) {
  const body = b64u(enc.encode(JSON.stringify(obj)));
  return body + "." + b64u(await crypto.subtle.sign("HMAC", await key(env), enc.encode(body)));
}
export async function verify(env, token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    if (!await crypto.subtle.verify("HMAC", await key(env), unb64u(sig), enc.encode(body))) return null;
    const o = JSON.parse(dec.decode(unb64u(body)));
    return o && o.exp > Date.now() ? o : null;
  } catch (e) { return null; }
}
export function getCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}
export const setCookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
export const clearSession = () => setCookie("sf_session", "", 0);
export function redirect(url, cookies = []) {
  const h = new Headers({ Location: url, "Cache-Control": "no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
}
export function json(obj, status = 200, cookies = []) {
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(JSON.stringify(obj), { status, headers: h });
}
export const redirectUri = req => new URL(req.url).origin + "/api/callback";

// ---- Discord ----
export async function tokenExchange(env, params) {
  const body = new URLSearchParams(Object.assign({ client_id: CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET }, params));
  const r = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  return r.ok ? r.json() : null;
}
export async function memberOf(accessToken) {
  const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${GUILD}/member`, { headers: { Authorization: "Bearer " + accessToken } });
  return r.ok ? r.json() : null;                        // 404: not a member of the server
}
/* role id -> rank name for the roles that unlock the doctrine */
export async function allowedRoles(env) {
  const m = new Map();
  if (env.ALLOWED_ROLES) {
    for (const part of env.ALLOWED_ROLES.split(",")) { const [name, id] = part.split("=").map(s => s.trim()); if (name && id) m.set(id, name); }
    return m;
  }
  if (env.DISCORD_BOT_TOKEN) {
    const r = await fetch(`https://discord.com/api/v10/guilds/${GUILD}/roles`, { headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN } });
    if (!r.ok) return m;
    const wanted = RANKS.map(s => s.toLowerCase());
    for (const role of await r.json()) if (wanted.includes(role.name.toLowerCase()) || /knight/i.test(role.name)) m.set(role.id, role.name);
  }
  return m;
}
/* the highest unlocking rank the member holds, or null */
export function rankOf(member, allowed) {
  let best = null, bestIdx = -2;
  for (const id of (member && member.roles) || []) {
    if (!allowed.has(id)) continue;
    const name = allowed.get(id), idx = RANKS.findIndex(r => name.toLowerCase().includes(r.toLowerCase()));
    const score = /knight/i.test(name) ? RANKS.length : idx;
    if (score > bestIdx) { best = name; bestIdx = score; }
  }
  return best;
}
export const displayName = member => (member && (member.nick || (member.user && (member.user.global_name || member.user.username)))) || "Saint";

/* the current session; once a day the roles are re-checked with Discord (a demotion or removal ends access) */
export async function session(env, req) {
  const s = await verify(env, getCookie(req, "sf_session"));
  if (!s) return { s: null, cookies: [] };
  if (Date.now() - (s.chk || 0) < ONE_DAY) return { s, cookies: [] };
  const tok = s.rt ? await tokenExchange(env, { grant_type: "refresh_token", refresh_token: s.rt }) : null;
  if (!tok) return { s: null, cookies: [clearSession()] };
  const member = await memberOf(tok.access_token);
  const rank = member ? rankOf(member, await allowedRoles(env)) : null;
  if (!rank) return { s: null, cookies: [clearSession()] };
  const s2 = Object.assign({}, s, { n: displayName(member), r: rank, rt: tok.refresh_token || s.rt, chk: Date.now(), exp: Date.now() + SEVEN_DAYS });
  return { s: s2, cookies: [setCookie("sf_session", await sign(env, s2), SEVEN_DAYS / 1000)] };
}
/* who may replace the doctrine fits: Knights (incl. the leader) and the Discord user ids listed in DOCTRINE_ADMINS */
export const canUpload = (env, s) => !!s && (/knight/i.test(s.r || "") ||
  (env.DOCTRINE_ADMINS || "").split(",").map(x => x.trim()).filter(Boolean).includes(String(s.u || "")));
export const newSession = (member, rank, tok) => ({ u: member.user && member.user.id, n: displayName(member), r: rank, rt: tok.refresh_token, chk: Date.now(), exp: Date.now() + SEVEN_DAYS });
export const SESSION_SECONDS = SEVEN_DAYS / 1000;
