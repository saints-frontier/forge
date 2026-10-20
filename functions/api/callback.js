/* GET /api/callback?code&state: Discord sends the member back here. The code becomes a token, the token shows the
   member's roles on The Saints server; a rank in ALLOWED_ROLES (Saint or above) gets a signed session cookie, anyone else gets nothing. */
import { getCookie, setCookie, clearSession, redirect, redirectUri, tokenExchange, memberOf, allowedRoles, rankOf, sign, newSession, SESSION_SECONDS } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  const clear = [setCookie("sf_state", "", 0)];
  const back = "/" + (/^[0-9a-f-]{36}\.(fitting|doctrine-ships|building|mining|map|structures|forge|doctrine|lodge|quarry|roads|machines|companion|guide|aboutus)$/.test(state || "") ? state.split(".")[1] : "fitting");   // the page the login started from
  if (!code || !state || state !== getCookie(request, "sf_state")) return redirect("/fitting?tribe=error", clear);
  const tok = await tokenExchange(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(request) });
  if (!tok) return redirect(back + "?tribe=error", clear);
  const member = await memberOf(tok.access_token);
  const rank = member ? rankOf(member, await allowedRoles(env)) : null;
  if (!rank) return redirect(back + "?tribe=denied", clear.concat(clearSession()));
  const s = newSession(member, rank, tok);
  return redirect(back + "?tribe=ok", clear.concat(setCookie("sf_session", await sign(env, s), SESSION_SECONDS)));
}
