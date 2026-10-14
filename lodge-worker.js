/* The Mason's Lodge: the planner in a Web Worker, so the exact search (a second or two) never freezes the page.
   in: {id, opt}  out: {id, result} or {id, error} */
self.window = self;                      // data.js and planner.js attach to window
importScripts("lodge-data.js?v=ed4d2f02", "lodge-planner.js?v=9e142809");
onmessage = function (e) {
  var id = e.data.id;
  try { postMessage({ id: id, result: LodgePlanner.plan(LODGE_DATA, e.data.opt) }); }
  catch (err) { postMessage({ id: id, error: String(err && err.message || err) }); }
};
