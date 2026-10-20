/* thesaintsforge.com/f/<id>: a short Forge link (functions/api/short.js keeps the fit under "f:<id>") opens the Fitting
   Tool with the fit's full link. An unknown id opens it with a note in the address ("#nofit"). */
const ID = /^[A-Za-z0-9]{6,14}$/;

export async function onRequestGet({ request, env, params }) {
  const id = String(params.id || ""), to = new URL("/fitting", request.url);
  let h = null;
  if (ID.test(id) && env.DOCTRINE) { try { h = await env.DOCTRINE.get("f:" + id); } catch (e) { h = null; } }
  to.hash = h || "nofit";
  return new Response(null, { status: 302, headers: { Location: to.toString(), "Cache-Control": "public, max-age=300" } });
}
