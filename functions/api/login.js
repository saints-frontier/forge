/* GET /api/login: send the member to Discord to confirm who they are (identify) and their roles on The Saints
   server (guilds.members.read). A random state in a short cookie guards the round trip. */
import { CLIENT_ID, setCookie, redirect, redirectUri } from "./_lib.js";

export async function onRequestGet({ request }) {
  const state = crypto.randomUUID();
  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri(request));
  u.searchParams.set("scope", "identify guilds.members.read");
  u.searchParams.set("state", state);
  return redirect(u.toString(), [setCookie("sf_state", state, 600)]);
}
