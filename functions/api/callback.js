/* GET /api/callback?code&state: Discord sends the member back here. The code becomes a token, the token shows the
   member's roles on The Saints server; Squire or above gets a signed session cookie, anyone else gets nothing. */
import { getCookie, setCookie, clearSession, redirect, redirectUri, tokenExchange, memberOf, allowedRoles, rankOf, sign, newSession, SESSION_SECONDS } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  const clear = [setCookie("sf_state", "", 0)];
  if (!code || !state || state !== getCookie(request, "sf_state")) return redirect("/forge?tribe=error", clear);
  const tok = await tokenExchange(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(request) });
  if (!tok) return redirect("/forge?tribe=error", clear);
  const member = await memberOf(tok.access_token);
  const rank = member ? rankOf(member, await allowedRoles(env)) : null;
  if (!rank) return redirect("/forge?tribe=denied", clear.concat(clearSession()));
  const s = newSession(member, rank, tok);
  return redirect("/forge?tribe=ok", clear.concat(setCookie("sf_session", await sign(env, s), SESSION_SECONDS)));
}
