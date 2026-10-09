/* GET /api/logout: drop the session cookie and go back to the Forge. */
import { clearSession, redirect } from "./_lib.js";

export async function onRequestGet() {
  return redirect("/forge", [clearSession()]);
}
