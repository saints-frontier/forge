/* GET /api/logout[?next=page]: drop the session cookie and go back to the page it was pressed on (the Forge when the
   page is not one of the site's own). */
import { clearSession, redirect } from "./_lib.js";

const PAGES = ["forge", "doctrine", "lodge", "quarry", "roads", "guide"];

export async function onRequestGet({ request }) {
  const next = String(new URL(request.url).searchParams.get("next") || "").toLowerCase();
  return redirect("/" + (PAGES.includes(next) ? next : "forge"), [clearSession()]);
}
