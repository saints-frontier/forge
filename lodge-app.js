/* The Mason's Lodge: the page. Data in data.js (LODGE_DATA), planning in planner.js (LodgePlanner). The form is the
   goal; "Lay the foundation" freezes it into a plan; the plan is a checklist whose progress lives in this browser
   (localStorage, per line) and survives a re-plan for the lines that are still there. */
(function () {
  "use strict";
  const D = window.LODGE_DATA, P = window.LodgePlanner;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => Math.round(n).toLocaleString("en-US");
  const FAC = {}; D.facilities.forEach(f => FAC[f.key] = f);
  const facLabel = k => (FAC[k] || { label: k }).label;
  const KIND = { mine: "Mine · asteroids", extract: "Extract · rift Crude Matter", cut: "Cut · wrecks and debris fields", loot: "Loot", unknown: "Found · source not recorded" };
  const KIND_ORDER = ["mine", "extract", "cut", "loot", "unknown"];
  const STAGE = { refine: "Refine", print: "Print", build: "Build" };
  const ITEMS = [...new Set(D.recipes.flatMap(r => Object.keys(r.out)))].sort((a, b) => a.localeCompare(b));
  const KEY = "lodge:v1";

  function dur(s) {
    s = Math.round(s);
    if (s < 60) return s + "s";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(r).padStart(2, "0")}s`;
  }
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* private window: the page still works */ } }
  function toast(t) { const el = document.createElement("div"); el.className = "toast"; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 2200); }

  // pasted inventory: "Name<TAB>qty" or "Name qty" per line, stacks summed (same rule as the toolkit's parser)
  function parseInventory(text) {
    const inv = {};
    for (let line of String(text || "").split(/\r?\n/)) {
      line = line.trim(); if (!line) continue;
      const m = line.match(/^(.*?)\s+([\d,]+)\s*$/);
      const name = (m ? m[1] : line).trim(), q = m ? +m[2].replace(/,/g, "") : 1;
      if (name) inv[name] = (inv[name] || 0) + q;
    }
    return inv;
  }

  const store = Object.assign({ form: null, opts: null, prog: {} }, load());
  // saved ticks and route choices name recipes; when the recipe data changes they would attach to the wrong ones
  const DATA_V = D.generated + "/" + D.recipes.length;
  if (store.dataV !== DATA_V) { store.own = {}; if (store.form) store.form.routes = {}; store.dataV = DATA_V; }
  // item names, case-insensitively (pasted inventories come in any case)
  const KNOWN = new Map([...new Set([...ITEMS, ...Object.keys(D.sources || {})])].map(n => [n.toLowerCase(), n]));
  function readInventory(text) {
    const have = {}, unknown = [];
    for (const [n, q] of Object.entries(parseInventory(text))) {
      const c = KNOWN.get(n.toLowerCase().replace(/\s+/g, " "));
      if (c) have[c] = (have[c] || 0) + q; else unknown.push(n);
    }
    return { have, unknown };
  }
  delete store.progress;   // v1 counted runs on every line; lines now count items
  const form = store.form || { goals: [{ item: "Network Node", qty: 1 }], facilities: D.facilities.filter(f => f.on).map(f => f.key), mode: "ore", salvage: "first", inv: "", routes: {} };

  // ---------- the form ----------
  function renderGoals() {
    $("goals").innerHTML = `<div class="goal ghead"><span>Item</span><span>How many items</span><span></span></div>` + form.goals.map((g, i) => `<div class="goalrow"><div class="goal">
      <input type="text" value="${esc(g.item)}" data-g="${i}" aria-label="item to build" placeholder="Search, e.g. Building Foam" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="picker" autocomplete="off" spellcheck="false">
      <input type="number" min="1" step="1" value="${Math.max(1, Math.floor(+g.qty || 1))}" data-q="${i}" aria-label="how many items">
      <button class="ghost" data-x="${i}" aria-label="remove this goal" ${form.goals.length < 2 ? "disabled" : ""}>×</button></div>
      <div class="ghint" data-h="${i}"></div></div>`).join("");
    goalHints();
  }
  // under each goal: how the item is made with the ticked facilities, in runs. The number is items wanted; a recipe
  // that makes 10 per run turns 5 into 1 run of 10 with 5 spare, and a button rounds the goal up to whole runs.
  function goalHints() {
    form.goals.forEach((g, i) => {
      const el = $("goals").querySelector(`[data-h="${i}"]`); if (!el) return;
      const item = ITEMS.find(x => x.toLowerCase() === String(g.item).trim().toLowerCase());
      if (!item || !(g.qty > 0)) { el.innerHTML = ""; return; }
      const r = P.planGreedy(D, { goals: [{ item, qty: g.qty }], facilities: form.facilities, mode: form.mode, salvage: form.salvage, routes: form.routes });   // quick: runs per item only
      if (r.blocked.some(b => b.item === item)) { el.innerHTML = `<span class="bad">None of your ticked facilities makes ${esc(item)}.</span>`; return; }
      const step = r.steps.find(x => x.id === r.routes[item]);
      if (!step) { el.innerHTML = ""; return; }
      const per = step.recipe.out[item], runs = step.runs, made = runs * per, spare = made - g.qty, where = esc(facLabel(step.recipe.f));
      if (per === 1) { el.innerHTML = `One per run on the ${where}: ${num(runs)} run${runs > 1 ? "s" : ""}.`; return; }
      el.innerHTML = `Comes in runs of <b>${num(per)}</b> on the ${where}: ${num(g.qty)} → ${num(runs)} run${runs > 1 ? "s" : ""} = ${num(made)}` +
        (spare > 0 ? `, ${num(spare)} spare. <button class="ghost mini" data-round="${i}" data-to="${made}">Make it ${num(made)}</button>` : ".");
    });
  }
  $("goals").addEventListener("input", e => {
    const t = e.target;
    if (t.dataset.g != null) { form.goals[+t.dataset.g].item = t.value; openPicker(t); }
    if (t.dataset.q != null) form.goals[+t.dataset.q].qty = Math.max(0, Math.floor(+t.value || 0));
    goalHints();
    persistForm();
  });
  // ---------- the item picker: our own list (the browser's datalist runs off the bottom of the screen) ----------
  // grouped by section, filtered as you type (names starting with the text first), at most 340 px tall, opening
  // upward when there is more room above; arrows + Enter, Esc closes, a click picks.
  const picker = document.createElement("div");
  picker.id = "picker"; picker.className = "picker"; picker.setAttribute("role", "listbox"); picker.hidden = true;
  document.body.appendChild(picker);
  let pickFor = null, pickList = [], pickAt = -1;
  function matches(q) {
    q = q.trim().toLowerCase();
    if (!q) return ITEMS.slice();
    const words = q.split(/\s+/);
    const hit = ITEMS.filter(i => { const l = i.toLowerCase(); return words.every(w => l.includes(w)); });
    const starts = i => i.toLowerCase().startsWith(q) ? 0 : i.toLowerCase().split(/[\s-]+/).some(w => w.startsWith(words[0])) ? 1 : 2;
    return hit.sort((a, b) => starts(a) - starts(b) || a.localeCompare(b));
  }
  function openPicker(input) {
    pickFor = input; const q = input.value; const exact = ITEMS.includes(q);
    pickList = matches(exact ? "" : q);
    const bySec = {};
    for (const i of pickList) (bySec[D.section[i] || "Materials"] = bySec[D.section[i] || "Materials"] || []).push(i);
    const order = q && !exact ? null : D.sections;   // typing: best matches first, no sections
    let html = "", k = 0;
    if (!pickList.length) html = `<div class="pk-none">Nothing called "${esc(q)}". Try fewer letters.</div>`;
    else if (!order) html = pickList.map(i => `<div class="pk-opt" role="option" id="pk-${k}" data-i="${k++}">${esc(i)}<span class="pk-sec">${esc(D.section[i] || "Materials")}</span></div>`).join("");
    else { pickList = []; for (const sec of order) { const l = bySec[sec]; if (!l) continue; html += `<div class="pk-h">${esc(sec)}</div>`; for (const i of l) { pickList.push(i); html += `<div class="pk-opt${i === q ? " cur" : ""}" role="option" id="pk-${k}" data-i="${k++}">${esc(i)}</div>`; } } }
    picker.innerHTML = html; picker.hidden = false; input.setAttribute("aria-expanded", "true");
    pickAt = -1; placePicker();
    const cur = picker.querySelector(".pk-opt.cur"); if (cur) cur.scrollIntoView({ block: "center" });
  }
  function placePicker() {
    if (!pickFor || picker.hidden) return;
    const r = pickFor.getBoundingClientRect(), vh = window.innerHeight, below = vh - r.bottom - 10, above = r.top - 10;
    const up = below < 220 && above > below;
    const h = Math.max(140, Math.min(340, up ? above : below));
    picker.style.left = Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 260) - 8)) + "px";
    picker.style.width = Math.max(r.width, 260) + "px";
    picker.style.maxHeight = h + "px";
    picker.style.top = up ? "" : (r.bottom + 4) + "px";
    picker.style.bottom = up ? (vh - r.top + 4) + "px" : "";
  }
  function closePicker() { if (pickFor) pickFor.setAttribute("aria-expanded", "false"); picker.hidden = true; pickFor = null; }
  function choose(k) {
    const input = pickFor, item = pickList[k]; if (!input || item == null) return;
    input.value = item; form.goals[+input.dataset.g].item = item; persistForm(); closePicker(); goalHints();
    const q = input.closest(".goal").querySelector("input[type=number]"); if (q) { q.focus(); q.select(); }
  }
  function highlight(k) {
    const opts = picker.querySelectorAll(".pk-opt"); if (!opts.length) return;
    pickAt = (k + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle("on", i === pickAt));
    opts[pickAt].scrollIntoView({ block: "nearest" }); pickFor.setAttribute("aria-activedescendant", opts[pickAt].id);
  }
  picker.addEventListener("mousedown", e => { const o = e.target.closest(".pk-opt"); if (o) { e.preventDefault(); choose(+o.dataset.i); } });
  $("goals").addEventListener("focusin", e => { if (e.target.dataset.g != null) { openPicker(e.target); e.target.select(); } });
  $("goals").addEventListener("focusout", e => { if (e.target === pickFor) setTimeout(() => { if (document.activeElement !== pickFor) closePicker(); }, 120); });
  $("goals").addEventListener("keydown", e => {
    if (e.target.dataset.g == null) return;
    if (picker.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) { openPicker(e.target); }
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(pickAt + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(pickAt - 1); }
    else if (e.key === "Enter" && !picker.hidden) { e.preventDefault(); choose(pickAt >= 0 ? pickAt : 0); }
    else if (e.key === "Escape") { closePicker(); }
  });
  window.addEventListener("resize", placePicker);
  window.addEventListener("scroll", placePicker, true);

  $("goals").addEventListener("click", e => {
    const rb = e.target.closest("button[data-round]");
    if (rb) { const i = +rb.dataset.round; form.goals[i].qty = +rb.dataset.to; $("goals").querySelector(`[data-q="${i}"]`).value = form.goals[i].qty; persistForm(); goalHints(); return; } const b = e.target.closest("button[data-x]"); if (b) { closePicker(); form.goals.splice(+b.dataset.x, 1); renderGoals(); persistForm(); } });
  $("add-goal").addEventListener("click", () => { form.goals.push({ item: "", qty: 1 }); renderGoals(); persistForm(); $("goals").querySelector(`[data-g="${form.goals.length - 1}"]`).focus(); });

  $("facs").innerHTML = D.facilities.filter(f => f.key !== "Build Mode").map(f =>
    `<label class="chk"><input type="checkbox" value="${esc(f.key)}" ${form.facilities.includes(f.key) ? "checked" : ""}> ${esc(f.label)}</label>`).join("");
  $("facs").addEventListener("change", () => { form.facilities = [...$("facs").querySelectorAll("input:checked")].map(i => i.value); persistForm(); goalHints(); });
  document.querySelectorAll("input[name=mode]").forEach(r => { r.checked = r.value === form.mode; r.addEventListener("change", () => { form.mode = r.value; persistForm(); goalHints(); }); });
  document.querySelectorAll("input[name=salvage]").forEach(r => { r.checked = r.value === form.salvage; r.addEventListener("change", () => { form.salvage = r.value; salvageNote(); persistForm(); goalHints(); }); });
  function salvageNote() {
    $("salvage-note").textContent = form.salvage === "use"
      ? "Salvage wherever it saves ore (Debris, Cinderwrack, Industrial Waste, Crystalline Refuse), ore for the rest."
      : "Ore wherever it can do the job; salvage only where nothing else makes the item.";
  }
  $("inv").value = form.inv || "";
  if (form.inv) $("inv-box").open = true;
  $("inv").addEventListener("input", () => { form.inv = $("inv").value; invNote(); persistForm(); });
  function invNote() {
    const { have, unknown } = readInventory(form.inv), n = Object.keys(have).length;
    $("inv-note").textContent = (n ? `${n} item${n > 1 ? "s" : ""} read. Anything the plan needs comes out of this first.` : "Plans start from zero. Paste what you hold and it's subtracted at every step.")
      + (unknown.length ? ` Not recognised: ${unknown.slice(0, 4).join(", ")}${unknown.length > 4 ? "…" : ""}.` : "");
  }
  function persistForm() { store.form = form; save(); }

  // ---------- the plan ----------
  let plan = null;
  function currentOpts() {
    const goals = form.goals.map(g => ({ item: (ITEMS.find(i => i.toLowerCase() === g.item.trim().toLowerCase()) || g.item.trim()), qty: g.qty })).filter(g => g.item && g.qty > 0);
    return { goals, facilities: form.facilities.slice(), mode: form.mode, salvage: form.salvage, have: readInventory(form.inv).have, routes: Object.assign({}, form.routes) };
  }
  $("lay").addEventListener("click", () => {
    const o = currentOpts();
    const unknown = o.goals.filter(g => !ITEMS.includes(g.item));
    if (!o.goals.length) { toast("Add something to build first."); return; }
    if (unknown.length) { toast(`No recipe makes "${unknown[0].item}". Pick it from the list.`); return; }
    store.opts = o; save(); build(); document.getElementById("h-work").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // the exact planner takes a second or two: it runs in a Worker (worker.js), the page waits with a note. Without
  // Workers (file://) it runs in the page.
  let worker = null, seq = 0; const pending = new Map();
  try { worker = new Worker("lodge-worker.js?v=602e21b7"); } catch (e) { worker = null; }
  if (worker) {
    worker.onmessage = e => { const cb = pending.get(e.data.id); pending.delete(e.data.id); if (cb) cb(e.data.error ? null : e.data.result); };
    worker.onerror = () => { worker = null; for (const cb of pending.values()) cb(null); pending.clear(); };
  }
  function planAsync(opt) {
    return new Promise(res => {
      if (!worker) { res(P.plan(D, opt)); return; }
      const id = ++seq; pending.set(id, r => res(r || P.plan(D, opt))); worker.postMessage({ id, opt });
    });
  }
  let buildN = 0;
  async function build() {
    if (!store.opts) return;
    const n = ++buildN; recomputeN++;                  // cascade results still in flight belong to the old plan
    try {
    $("work").innerHTML = `<div class="empty"><b>Laying the foundation…</b><span>Working out the plan with the least ore. A second or two.</span></div>`;
    $("work-count").textContent = "";
    const p = await planAsync(store.opts);
    if (n !== buildN) return;                      // a newer plan was asked for meanwhile
    plan = p; renderWork();
    } catch (e) {
      if (n !== buildN) return;
      $("work").innerHTML = `<div class="empty"><b>The plan could not be worked out.</b><span>${esc(String(e && e.message || e))}. Change the goal or the facilities and try again.</span></div>`;
    }
  }

  // ---------- the checklist ----------
  // Every line counts toward a total. Gather and print lines count ITEMS: they start at what you hold (grey, the
  // floor: you can't go below it) and run up to what the build needs; + / − move one run's worth. Refine lines count
  // RUNS (one ore turns into several products) and say what you already hold of those products. Items the inventory
  // covers completely still get a line, already full, so you can see the inventory was used.
  // Cascade: what you add on a print or build line (found while roaming, or printed) counts as held. The plan is
  // re-worked with it, and on every line above the part that is no longer needed shows as covered (gold, crossed
  // out) and can't be taken away; your own count (what you mined, refined, printed) sits on top of it, never counted twice.
  const isRaw = i => !ITEMS.includes(i);
  let lines = [], cover = {};
  if (!store.own) store.own = {};
  delete store.prog;
  const own = l => Math.max(0, store.own[l.id] || 0);
  const base = l => l.floor + (cover[l.id] || 0);                  // what you can't go below
  function val(l) { return Math.min(l.total, base(l) + own(l)); }
  function setVal(l, v) { store.own[l.id] = Math.max(0, Math.min(l.total - base(l), Math.round(v - base(l)) || 0)); save(); }
  // the cascade: re-plan with what was added counted as held (same recipes), in the background; the lines refresh
  // when it lands. A newer request supersedes an older one.
  let recomputeN = 0;
  async function recompute() {
    const n = ++recomputeN;
    const credit = {};
    for (const l of lines) if (l.credit && own(l) > 0) credit[l.item] = (credit[l.item] || 0) + own(l);
    if (!plan) return;
    if (!Object.keys(credit).length) { cover = {}; for (const el of [...$("work").querySelectorAll(".line")]) refreshLine(el, true); updateBar(); return; }
    const have = Object.assign({}, store.opts.have || {});
    for (const i in credit) have[i] = (have[i] || 0) + credit[i];
    let p1;
    try { p1 = await planAsync(Object.assign({}, store.opts, { have, only: plan.steps.map(s => s.id), cap: Object.fromEntries(plan.steps.map(s => [s.id, s.runs])), routes: {} })); }   // the same recipes, never more runs
    catch (e) { return; }
    if (n !== recomputeN) return;
    cover = {};
    const runs1 = {}; p1.steps.forEach(s => runs1[s.id] = s.runs);
    const gather1 = {}; p1.gather.forEach(g => gather1[g.item] = g.qty);
    for (const l of lines) {
      if (l.held) continue;
      let cv = 0;
      if (l.kind === "runs") cv = l.total - (runs1[l.step.id] || 0);
      else if (l.stage === "gather") cv = (l.total - l.floor) - (gather1[l.item] || 0);
      else cv = ((plan.need || {})[l.item] || 0) - ((p1.need || {})[l.item] || 0);   // demand from the lines below it
      cover[l.id] = Math.max(0, Math.min(l.total - l.floor, Math.round(cv)));
    }
    for (const el of [...$("work").querySelectorAll(".line")]) refreshLine(el, true);
    updateBar();
  }

  function model(p) {
    const used = p.used || {}, need = p.need || {}, out = [];
    // gather: raw items to find or mine, plus raw items the inventory already covers
    const raw = new Set([...p.gather.map(g => g.item), ...Object.keys(used).filter(i => isRaw(i) && used[i] > 0)]);
    for (const item of raw) {
      const g = p.gather.find(x => x.item === item) || {}, src = D.sources[item] || { k: "unknown", h: "" };
      const floor = used[item] || 0, total = floor + (g.qty || 0);
      out.push({ id: "g:" + item, stage: "gather", group: src.k, kind: "items", item, title: item, floor, total, per: 1,
                 found: g.found || ["cut", "loot", "unknown"].includes(src.k), hint: src.h, for: g.for || [] });
    }
    // steps
    const mains = new Set();
    for (const s of p.steps) {
      const kind = (FAC[s.recipe.f] || {}).kind;
      if (kind === "refine") {
        out.push({ id: "r:" + s.id, stage: "refine", group: s.recipe.f, kind: "runs", title: s.recipe.name, floor: 0, total: s.runs, per: 1, step: s, depth: s.depth });
        continue;
      }
      const outs = Object.keys(s.recipe.out);
      const named = outs.find(o => s.recipe.name === o || s.recipe.name.startsWith(o + " ("));
      const main = named || outs.slice().sort((a, b) => (need[b] || 0) - (need[a] || 0))[0];
      const per = s.recipe.out[main], floor = mains.has(main) ? 0 : (used[main] || 0);   // the inventory counts on one line only
      mains.add(main);
      out.push({ id: "i:" + s.id, stage: kind, group: s.recipe.f, kind: "items", item: main, title: s.recipe.name, floor, total: floor + s.runs * per, per, step: s, depth: s.depth, need: need[main] || 0, credit: true });
    }
    // made items the inventory covers completely: a full line where they would have been made
    for (const [item, q] of Object.entries(used)) {
      if (!(q > 0) || isRaw(item) || mains.has(item)) continue;
      const rid = p.routes[item], r = rid && D.recipes.find(x => x.id === rid), kind = r && (FAC[r.f] || {}).kind;
      if (kind === "refine") continue;          // shown on the refine line that makes it
      out.push({ id: "h:" + item, stage: kind || "print", group: r ? r.f : "__held", kind: "items", item, title: item, floor: q, total: q, per: 1, held: true, depth: 99, need: need[item] || 0 });
    }
    return out;
  }

  function counter(l) {
    const v = val(l), done = v >= l.total;
    if (l.kind === "runs")
      return `<div class="ctl"><button data-d="-1" aria-label="one run less">−</button><span class="n">${v}</span><span class="of">/ ${num(l.total)}</span><button data-d="1" aria-label="one run more">+</button><button class="all" data-all>${done ? "↺" : "✓"}</button></div>`;
    const minus = l.stage === "gather" || l.held ? "" : `<button data-d="-1" aria-label="one run less">−</button>`;
    const plus = l.stage === "gather" || l.held ? "" : `<button data-d="1" aria-label="one run more">+</button>`;
    return `<div class="ctl">${minus}<input type="number" min="${base(l)}" max="${l.total}" step="${l.per}" value="${v}" class="${v <= base(l) && base(l) > 0 ? "atfloor" : ""}" aria-label="${esc(l.title)}: how many you have"${l.held ? " disabled" : ""}><span class="of">/ ${num(l.total)}</span>${plus}${l.held ? "" : `<button class="all" data-all>${done ? "↺" : "✓"}</button>`}</div>`;
  }
  function meter(l) {
    if (!l.total) return "";
    const v = val(l), c = cover[l.id] || 0, pct = x => (x / l.total * 100).toFixed(2) + "%";
    return `<div class="lbar" aria-hidden="true"><span class="held" style="width:${pct(l.floor)}"></span><span class="cov" style="width:${pct(c)}"></span><span class="got" style="width:${pct(v - l.floor - c)}"></span></div>`;
  }
  function lineHTML(l) {
    const v = val(l), done = v >= l.total;
    let what = `<b>${esc(l.title)}</b>`;
    const sub = [];
    if (l.stage === "gather") {
      if (l.found) what += '<span class="tag found">found only</span>';
      if (l.hint) sub.push(esc(l.hint));
      if (l.found && l.for.length) sub.push("for " + l.for.map(esc).join(", "));
    } else if (l.held) {
      what += '<span class="tag held">from your hold</span>';
      sub.push(`All ${num(l.floor)} from your inventory; nothing to make.`);
    } else {
      const s = l.step;
      what += (s.recipe.t == null ? '<span class="tag unv" title="The game shows no time for this recipe yet">time unknown</span>' : `<span class="tag time">${dur(s.secs)}</span>`) + `${s.unverified ? '<span class="tag unv" title="Not yet confirmed in game on this facility">unverified</span>' : ""}`;
      const ins = Object.entries(s.ins).map(([i, q]) => `${num(q)} ${esc(i)}`).join(", ");
      const outs = Object.entries(s.outs).map(([i, q]) => `${num(q)} ${esc(i)}`).join(", ");
      sub.push(`${num(s.runs)} run${s.runs > 1 ? "s" : ""}: ${ins}<span class="arrow">→</span>${outs}`);
      if (l.kind === "runs") {
        const held = Object.keys(s.recipe.out).filter(o => (plan.used || {})[o] > 0);
        if (held.length) sub.push("you already hold " + held.map(o => `${num(plan.used[o])} ${esc(o)}`).join(", ") + " (counted)");
      }
    }
    if (l.kind === "items" && l.floor > 0 && !l.held) sub.push(`<span class="heldtxt">${num(l.floor)} from your inventory</span>`);
    if (cover[l.id] > 0) sub.push(`<span class="covtxt">${num(cover[l.id])}${l.kind === "runs" ? " run" + (cover[l.id] > 1 ? "s" : "") : ""} no longer needed: covered by what you added below</span>`);
    if (l.credit && own(l) > 0) sub.push(`<span class="owntxt">+${num(own(l))} added: the lines above count them</span>`);
    if (l.kind === "items" && l.stage !== "gather" && l.need && l.total > l.need) sub.push(`need ${num(l.need)}, ${num(l.total - l.need)} spare`);
    return `<div class="line${done ? " done" : ""}${l.held ? " heldline" : ""}" data-id="${esc(l.id)}">${counter(l)}<div class="what">${what}<div class="sub">${sub.join(" · ")}</div>${meter(l)}</div></div>`;
  }

  function renderWork() {
    const o = store.opts, p = plan, w = $("work");
    const goalsTxt = o.goals.map(g => `${num(g.qty)}x ${g.item}`).join(" · ");
    lines = model(p);
    cover = {}; recompute();
    const alerts = [];
    if (p.exact && p.proven) alerts.push(`<div class="alert ok"><b>Least ore there is</b> for these goals, facilities and routes: ${num(p.ore)} ore. Nothing better exists.</div>`);
    else if (p.exact) alerts.push(`<div class="alert ok"><b>Best plan found</b> in the time allowed: ${num(p.ore)} ore. A slightly better one may exist.</div>`);
    if (p.note) alerts.push(`<div class="alert ok">${esc(p.note)}</div>`);
    for (const b of p.blocked) alerts.push(`<div class="alert bad"><b>${num(b.qty)}x ${esc(b.item)}</b>: none of your facilities makes it. Tick ${b.facilities.map(f => "<b>" + esc(facLabel(f)) + "</b>").join(" or ")}.</div>`);
    for (const g of p.gather.filter(g => g.found || g.cut)) alerts.push(`<div class="alert"><b>This build needs ${num(g.qty)} ${esc(g.item)}</b>, which can't be made, only found. ${esc(g.hint.replace(/^Can't be made, only found[:;]\s*/i, "").replace(/^./, c => c.toUpperCase()))}</div>`);
    const used = Object.entries(p.used || {}).filter(([, q]) => q > 0);
    if (Object.keys(o.have || {}).length) alerts.push(used.length
      ? `<div class="alert ok"><b>Using your inventory:</b> ${used.map(([i, q]) => `${num(q)} ${esc(i)}`).join(", ")}. Grey on the lines below = already in your hold.</div>`
      : `<div class="alert">Your pasted inventory has nothing this build uses.</div>`);

    if (!lines.length) {
      w.innerHTML = `<div class="alerts">${alerts.join("")}</div><div class="empty"><b>Nothing to do.</b><span>${p.blocked.length ? "Tick a facility that can make it." : `You already hold everything for ${esc(goalsTxt)}.`}</span></div>`;
      $("work-count").textContent = goalsTxt; return;
    }
    let html = `<div class="alerts">${alerts.join("")}</div><div class="prog"><div class="track"><div class="fill" id="pfill"></div></div><span class="txt" id="ptxt"></span></div>`;
    const gather = lines.filter(l => l.stage === "gather");
    if (gather.length) {
      html += `<div class="stage"><h3>Gather <small>${num(gather.reduce((s, l) => s + l.total - l.floor, 0))} units to get</small></h3>`;
      for (const k of KIND_ORDER) {
        const list = gather.filter(l => l.group === k).sort((a, b) => b.total - a.total);
        if (list.length) html += `<div class="group"><h4>${esc(KIND[k])}</h4>${list.map(lineHTML).join("")}</div>`;
      }
      html += `</div>`;
    }
    for (const stage of ["refine", "print", "build"]) {
      const list = lines.filter(l => l.stage === stage);
      if (!list.length) continue;
      const runs = list.reduce((s, l) => s + (l.step ? l.step.runs : 0), 0);
      html += `<div class="stage"><h3>${STAGE[stage]} <small>${num(runs)} run${runs === 1 ? "" : "s"}</small></h3>`;
      for (const f of [...new Set(list.map(l => l.group))]) {
        const g = list.filter(l => l.group === f).sort((a, b) => b.depth - a.depth || a.title.localeCompare(b.title));
        const secs = g.reduce((s, l) => s + (l.step ? l.step.secs : 0), 0);
        html += `<div class="group"><h4><span>${f === "__held" ? "From your hold" : esc(facLabel(f))}</span><span class="sp"></span><span class="t">${secs ? dur(secs) : ""}</span></h4>${g.map(lineHTML).join("")}</div>`;
      }
      html += `</div>`;
    }
    const spare = Object.entries(p.spare).sort((a, b) => b[1] - a[1]);
    if (spare.length) html += `<div class="spare"><b>Spare at the end</b>${spare.map(([i, q]) => `${num(q)} ${esc(i)}`).join(" · ")}</div>`;
    const opts = Object.entries(p.options || {}).filter(([i]) => p.routes[i]);
    if (opts.length) {
      html += `<details class="rt"${store.routesOpen ? " open" : ""}><summary>Change how an item is made (${opts.length})</summary><div class="routes">`;
      for (const [item, list] of opts.sort((a, b) => a[0].localeCompare(b[0]))) {
        html += `<div class="r"><span>${esc(item)}</span><select data-route="${esc(item)}">${list.map(c => {
          const r = D.recipes.find(x => x.id === c.id);
          const ins = Object.entries(r.in).map(([i, q]) => `${q} ${i}`).join(" + ");
          return `<option value="${esc(c.id)}"${p.routes[item] === c.id ? " selected" : ""}>${esc(facLabel(r.f))}: ${esc(ins)} → ${r.out[item]}${r.t != null ? ` (${r.t}s)` : ""}</option>`;
        }).join("")}</select></div>`;
      }
      html += `</div></details>`;
    }
    html += `<div class="actions"><button id="copy">Copy what's left as text</button><button id="reset-prog">Clear ticks</button></div>`;
    w.innerHTML = html;
    $("work-count").textContent = goalsTxt;
    updateBar();
  }

  function updateBar() {
    if (!lines.length || !$("pfill")) return;
    let f = 0, done = 0;
    for (const l of lines) { const v = val(l); f += l.total ? v / l.total : 1; if (v >= l.total) done++; }
    $("pfill").style.width = (f / lines.length * 100).toFixed(1) + "%";
    $("pfill").classList.toggle("done", done === lines.length);
    $("ptxt").textContent = done === lines.length ? "✠ All done" : `${done} of ${lines.length} lines done`;
  }
  let recomputeTimer = null;
  function refreshAll(changed) {
    if (changed && changed.credit) { clearTimeout(recomputeTimer); recomputeTimer = setTimeout(recompute, 250); }   // typing settles first
    for (const el of [...$("work").querySelectorAll(".line")]) refreshLine(el, true);
    updateBar();
  }
  function refreshLine(el, quiet) {
    const l = lines.find(x => x.id === el.dataset.id); if (!l) return;
    const fresh = document.createElement("div"); fresh.innerHTML = lineHTML(l);
    const typing = document.activeElement && el.contains(document.activeElement) && document.activeElement.type === "number";
    if (typing) {           // typing in the box: update around it, don't replace it
      const v = val(l), inp = document.activeElement;
      el.classList.toggle("done", v >= l.total); inp.classList.toggle("atfloor", v <= base(l) && base(l) > 0);
      const m = el.querySelector(".lbar"), nm = fresh.querySelector(".lbar"); if (m && nm) m.replaceWith(nm);
      const a = el.querySelector("[data-all]"); if (a) a.textContent = v >= l.total ? "↺" : "✓";
    } else el.replaceWith(fresh.firstElementChild);
    if (!quiet) updateBar();
  }
  $("work").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "copy") { copyText(); return; }
    if (b.id === "reset-prog") { store.own = {}; save(); renderWork(); toast("Ticks cleared."); return; }
    const el = b.closest(".line"); if (!el) return;
    const l = lines.find(x => x.id === el.dataset.id), v = val(l);
    if (b.dataset.d) setVal(l, v + (+b.dataset.d) * l.per);
    else if (b.dataset.all != null) setVal(l, v >= l.total ? base(l) : l.total);
    refreshAll(l);
  });
  $("work").addEventListener("input", e => {
    const inp = e.target; if (inp.type !== "number" || !inp.closest(".line")) return;
    const el = inp.closest(".line"), l = lines.find(x => x.id === el.dataset.id);
    if (inp.value === "") return;
    setVal(l, +inp.value); refreshAll(l);
  });
  $("work").addEventListener("focusout", e => {     // leaving the box: show the clamped value (never below what you hold)
    const inp = e.target; if (inp.type !== "number" || !inp.closest(".line")) return;
    const el = inp.closest(".line"), l = lines.find(x => x.id === el.dataset.id);
    if (l) setTimeout(() => refreshAll(), 0);
  });
  $("work").addEventListener("change", e => {
    const s = e.target.closest("select[data-route]"); if (!s) return;
    form.routes[s.dataset.route] = s.value; store.opts.routes = Object.assign({}, form.routes); store.routesOpen = true; persistForm(); build();
    toast(`${s.dataset.route}: route changed.`);
  });
  $("work").addEventListener("toggle", e => { if (e.target.matches && e.target.matches("details.rt")) { store.routesOpen = e.target.open; save(); } }, true);

  function copyText() {
    const o = store.opts, out = [`The Mason's Lodge: ${o.goals.map(g => `${g.qty}x ${g.item}`).join(", ")}`];
    const left = l => l.total - val(l);
    const g = lines.filter(l => l.stage === "gather" && left(l) > 0);
    if (g.length) { out.push("", "GATHER"); g.forEach(l => out.push(`- ${num(left(l))} ${l.item}${l.found ? " (found only)" : ""}`)); }
    for (const stage of ["refine", "print", "build"]) {
      const st = lines.filter(l => l.stage === stage && l.step && left(l) > 0);
      if (!st.length) continue;
      out.push("", STAGE[stage].toUpperCase());
      st.sort((a, b) => b.depth - a.depth).forEach(l => {
        const r = l.step.recipe, n = l.kind === "runs" ? left(l) : Math.ceil(left(l) / l.per);
        out.push(`- ${n} run${n > 1 ? "s" : ""} ${r.name} (${facLabel(r.f)}): ${Object.entries(r.in).map(([i, q]) => `${num(q * n)} ${i}`).join(", ")} -> ${Object.entries(r.out).map(([i, q]) => `${num(q * n)} ${i}`).join(", ")}`);
      });
    }
    if (out.length === 1) out.push("", "All done.");
    const text = out.join("\n");
    const fallback = () => { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("Copied."); } catch (e) { toast("Select and copy the text."); } ta.remove(); };
    try { navigator.clipboard.writeText(text).then(() => toast("Copied."), fallback); } catch (e) { fallback(); }
  }

  renderGoals(); salvageNote(); invNote();
  $("foot-data").textContent = `DATA OF ${D.generated.toUpperCase()} · ${D.recipes.length} RECIPES`;
  // ---------- a fit from the Forge: "Build it in the Lodge" ----------
  // On the site the Forge calls window.__lodgeImport and switches the page; the stand-alone Lodge gets the fit in the
  // link as #build-<base64url JSON {name, hull, goals: [{item, qty}]}> (only letters, digits, - and _ survive a link).
  function importGoals(p) {
    const goals = [], skipped = [];
    for (const g of (p && p.goals) || []) {
      const item = ITEMS.find(i => i.toLowerCase() === String(g.item || "").trim().toLowerCase());
      if (item && g.qty > 0) goals.push({ item, qty: Math.floor(g.qty) }); else if (!item) skipped.push(`${g.qty}x ${g.item}`);
    }
    if (!goals.length) { toast(skipped.length ? "Nothing in that fit has a recipe here." : "Nothing to build in that fit."); return false; }
    closePicker(); form.goals = goals; renderGoals(); persistForm(); goalHints();
    store.opts = currentOpts(); save(); build();
    toast(`${p.name ? p.name + ": " : ""}${goals.length} kinds of module to build.` + (skipped.length ? ` No recipe for ${skipped.join(", ")}: they come with the ship.` : ""));
    setTimeout(() => { const h = document.getElementById("h-work"); if (h) h.scrollIntoView({ behavior: "smooth", block: "start" }); }, 80);
    return true;
  }
  window.__lodgeImport = importGoals;
  const fromLink = /^#build-([A-Za-z0-9_-]+)$/.exec(location.hash); let imported = false;
  if (fromLink) {
    try { imported = importGoals(JSON.parse(decodeURIComponent(escape(atob(fromLink[1].replace(/-/g, "+").replace(/_/g, "/")))))); } catch (e) { toast("That Forge link could not be read."); }
    history.replaceState(null, "", (window.__siteGo ? "/lodge" : location.pathname) + location.search);   // on the site the Lodge keeps its own address
  }
  if (!imported && store.opts) {                       // saved goals must still be items this data knows
    store.opts.goals = (store.opts.goals || []).filter(g => ITEMS.includes(g.item) && g.qty > 0);
    if (store.opts.goals.length) build(); else store.opts = null;
  }
  window.__lodge = { store, get plan() { return plan; }, get lines() { return lines; }, parseInventory };
})();
