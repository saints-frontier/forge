/* The Quarry: where every ore comes from and what every rock gives (window.QUARRY_DATA, tools/export_quarry_data.py).
   One page per subject, both ways at once: a rock shows what comes out of it; an ore shows the rocks that hold it and
   what it refines into; a material shows how it is made and what uses it; loot and salvage say where they are found.
   Little text on screen (user 2026-10-15: "too busy ... info is good but thats too much text"): bars and short labels,
   details behind an (i) or a fold, no mode switch, no nested trees (click an ingredient to open it).
   Evidence is never mixed: measured (our own mining, or a Saint's game log, credited by name) / the game says (the
   ore's in-game description). No player reports or hearsay (user 2026-10-14). Measured = ONE AVERAGE per rock name
   (D.rocks; passes on one rock pooled, every rock counts once), never the single passes (user 2026-10-15).
   Every id the page uses starts with q- (the site is one page shared with the Forge and the Lodge). */
(function () {
  "use strict";
  const D = window.QUARRY_DATA;
  const $ = id => document.getElementById(id);
  if (!D || !$("q-in")) return;

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n0 = x => Math.round(x).toLocaleString("en-US");
  const pct = x => (x > 0 && x < 0.005 ? "<1" : Math.round(x * 100)) + "%";
  const ORES = D.ores, ORESET = new Set(ORES), FAMS = D.families, PREF = D.prefixes;
  const COLOR = { "Crustal Anorthosite Crystals": "#cfc6ae", "Massive Ataxite Matrix": "#8fa6bf", "Hydrated Gossan Matrix": "#3fa0d0",
    "Irradiated Anthraxolite Veins": "#e07b2e", "Irradiated Cryoconite Nodules": "#9a78e0", "Primordial Anthraxolite Sludge": "#9c6a40",
    "Primitive Rime Shards": "#bfeaf0", "Native Reef Nodules": "#d9b24c" };
  const LEVEL_RANK = { rich: 6, main: 5, common: 4, carries: 3, some: 2, traces: 1 };
  const KIND_ORDER = { refine: 0, print: 1, build: 2 };

  // ---------- indexes ----------
  const makes = {}, uses = {};
  for (const r of D.recipes) {
    for (const o in r.out) (makes[o] = makes[o] || []).push(r);
    for (const i in r.in) (uses[i] = uses[i] || []).push(r);
  }
  const ALL = [...new Set([...Object.keys(makes), ...Object.keys(uses), ...ORES])].sort((a, b) => a.localeCompare(b));
  const facLabel = f => D.facilities[f] || f;
  const facKind = f => D.facilityKind[f] || "build";
  const avgsOf = F => D.rocks.filter(a => a.family === F);
  const gameOf = F => D.game.filter(g => g.rocks.includes(F));

  function sourceTag(i) {
    const s = D.sources[i];
    if (!s) return makes[i] ? (D.section[i] || "material").toLowerCase() : "material";
    return { extract: "rift crude", cut: "salvage", loot: "loot", mine: "ore", unknown: "found" }[s.k] || "found";
  }
  const INDEX = [];
  for (const f of FAMS) INDEX.push({ name: f, tag: "rock" });
  const seenRock = new Set(FAMS);
  for (const a of D.rocks) if (!seenRock.has(a.rock)) { seenRock.add(a.rock); INDEX.push({ name: a.rock, tag: "rock" }); }
  for (const o of ORES) INDEX.push({ name: o, tag: "ore" });
  for (const i of ALL) if (!ORESET.has(i)) INDEX.push({ name: i, tag: sourceTag(i) });

  function subjectOf(name) {
    const lc = String(name || "").trim().toLowerCase();
    if (!lc) return null;
    for (const f of FAMS) {
      if (lc === f.toLowerCase()) return { kind: "rock", name: f, family: f, prefix: "" };
      for (const p of PREF) if (lc === (p + " " + f).toLowerCase()) return { kind: "rock", name: p + " " + f, family: f, prefix: p };
    }
    const ore = ORES.find(o => o.toLowerCase() === lc);
    if (ore) return { kind: "ore", name: ore };
    const item = ALL.find(i => i.toLowerCase() === lc);
    if (item) return { kind: makes[item] ? "item" : "raw", name: item };
    return null;
  }

  // every raw input an item can come down to, through any recipe (memoised; a loop through an item already on the
  // path stops there)
  const rawMemo = {};
  function rawOf(item, stack) {
    if (rawMemo[item]) return rawMemo[item];
    if (!makes[item]) return (rawMemo[item] = new Set([item]));
    stack = stack || new Set();
    if (stack.has(item)) return new Set();
    stack.add(item);
    const out = new Set();
    for (const r of makes[item]) for (const i in r.in) for (const x of rawOf(i, stack)) out.add(x);
    stack.delete(item);
    return (rawMemo[item] = out);
  }

  // ---------- pieces ----------
  const go = (name, label) => `<button type="button" class="lk" data-go="${esc(name)}">${esc(label || name)}</button>`;
  const dot = o => `<i class="dot" style="background:${COLOR[o] || "#666"}"></i>`;
  const info = text => `<details class="info"><summary aria-label="More">i</summary><div class="pop">${text}</div></details>`;
  const head = (title, kind, more) => `<div class="kind">${esc(kind)}</div><h2>${esc(title)}${more ? " " + more : ""}</h2>`;
  const bar = (f, color) => `<span class="mbar"><span style="width:${Math.max(1, f * 100).toFixed(1)}%;background:${color}"></span></span>`;
  function recipeLine(r) {
    const side = o => Object.entries(o).map(([i, q]) => `${n0(q)} ${go(i)}`).join(" + ");
    return `<div class="rline"><span class="fac" title="${esc(facKind(r.f))}">${esc(facLabel(r.f))}</span><span class="rx">${side(r.in)} <span class="arrow">\u2192</span> ${side(r.out)}`
      + (r.u ? ` <span class="unv" title="not yet confirmed on this facility">?</span>` : "") + `</span></div>`;
  }
  const byKind = rs => rs.slice().sort((a, b) => KIND_ORDER[facKind(a.f)] - KIND_ORDER[facKind(b.f)]);
  const usedIn = (name, open) => {
    const rs = uses[name] || [];
    if (!rs.length) return "";
    return open ? `<h3>Used in</h3>` + byKind(rs).map(recipeLine).join("")
      : `<details class="fold"><summary>Used in ${rs.length} recipe${rs.length === 1 ? "" : "s"}</summary>${byKind(rs).map(recipeLine).join("")}</details>`;
  };
  // the line under a rock's name: how many rocks, how fast; the long words sit in the (i)
  function measuredMeta(a) {
    const bits = [a.n === 1 ? "1 rock" : a.n + " rocks", "~" + n0(a.per_min || 0) + "/min"];
    if (a.by && a.by.length) bits.push("by " + a.by.map(esc).join(", "));
    const more = `${a.n === 1 ? "Measured on one rock" : "The average of " + a.n + " rocks we measured, every rock counted once"}: ${n0(a.units)} units. Units a minute depend on the ship's lasers and lens.`;
    return `<div class="meta">${bits.join(" \u00b7 ")} ${info(esc(more))}</div>`;
  }

  // ---------- views ----------
  function rockView(sub) {
    const F = sub.family, a = D.rocks.find(x => x.rock === sub.name);
    const gs = gameOf(F);
    const said = o => gs.find(g => g.ore === o);
    let h = head(sub.name, "Rock");
    const rows = [];
    if (a) for (const [o, f] of Object.entries(a.share)) rows.push({ o, f });
    for (const g of gs) if (!rows.some(r => r.o === g.ore)) rows.push({ o: g.ore, f: 0 });
    rows.sort((x, y) => y.f - x.f || LEVEL_RANK[(said(y.o) || {}).level] - LEVEL_RANK[(said(x.o) || {}).level]);
    h += a ? measuredMeta(a) : `<div class="meta">not measured yet</div>`;
    h += `<div class="rows">` + rows.map(r => {
      const g = said(r.o);
      const tag = g ? `<span class="gtag" title="The game says: ${esc(D.levels[g.level])} (\u201c${esc(g.quote)}\u201d)">\u25c6</span>` : "";
      return `<div class="row"><span class="nm">${dot(r.o)}${go(r.o)}${tag}</span>${r.f ? bar(r.f, COLOR[r.o] || "#888") + `<span class="pc">${pct(r.f)}</span>` : `<span class="gonly">game says: ${esc(D.levels[g.level])}</span>`}</div>`;
    }).join("") + `</div>`;
    if (gs.length) h += `<p class="key"><span class="gtag">\u25c6</span> named in the game's own ore description</p>`;
    if (a && a.note) h += `<p class="note">${esc(a.note)}</p>`;
    const others = avgsOf(F).filter(x => x.rock !== sub.name).sort((x, y) => y.n - x.n || y.units - x.units);
    if (others.length) h += `<h3>Other ${esc(F)}</h3><div class="rows">` + others.map(x => {
      const segs = Object.entries(x.share).map(([o, f]) => `<span style="width:${(f * 100).toFixed(1)}%;background:${COLOR[o] || "#666"}" title="${esc(o)} ${pct(f)}"></span>`).join("");
      return `<div class="row"><span class="nm">${go(x.rock)}</span><span class="minibar">${segs}</span><span class="pc dim">${x.n}\u00d7</span></div>`;
    }).join("") + `</div>`;
    return h;
  }
  function oreView(sub) {
    const o = sub.name;
    let h = head(o, "Ore", info(`<i>\u201c${esc(D.desc[o] || "")}\u201d</i><br>The game's own description.`));
    const meas = D.rocks.filter(a => a.share[o]).sort((x, y) => y.share[o] - x.share[o]);
    const famsMeasured = new Set(meas.map(a => a.family));
    const gameOnly = D.game.filter(g => g.ore === o).flatMap(g => g.rocks.filter(F => !famsMeasured.has(F)).map(F => ({ F, g })));
    h += `<h3>Found in</h3>`;
    if (!meas.length && !gameOnly.length) h += `<div class="meta">no rock recorded yet</div>`;
    h += `<div class="rows">` + meas.map(a => `<div class="row"><span class="nm">${go(a.rock)}<span class="dim small"> ${a.n}\u00d7${a.by && a.by.length ? " \u00b7 by " + a.by.map(esc).join(", ") : ""}</span></span>${bar(a.share[o], COLOR[o] || "#888")}<span class="pc">${pct(a.share[o])}</span></div>`).join("")
      + gameOnly.map(({ F, g }) => `<div class="row"><span class="nm">${go(F)}</span><span class="gonly">game says: ${esc(D.levels[g.level])}</span></div>`).join("") + `</div>`;
    if (meas.length) h += `<p class="key">share of the rock, average of the rocks we measured (N\u00d7 = how many)</p>`;
    const ref = byKind(uses[o] || []);
    if (ref.length) h += `<h3>Becomes</h3>` + ref.map(recipeLine).join("");
    return h;
  }
  function itemView(sub) {
    const it = sub.name;
    let h = head(it, D.section[it] || "Material");
    h += `<h3>Made from</h3>` + byKind(makes[it]).map(recipeLine).join("");
    const raw = [...rawOf(it)];
    const ores = raw.filter(x => ORESET.has(x)), other = raw.filter(x => !ORESET.has(x));
    if (ores.length || other.length) h += `<h3>Comes down to</h3><div class="chips">` + ores.map(o => `<button type="button" class="chip" data-go="${esc(o)}">${dot(o)}${esc(o)}</button>`).join("")
      + other.map(x => `<button type="button" class="chip" data-go="${esc(x)}" title="${esc(sourceTag(x))}">${esc(x)}</button>`).join("") + `</div>`;
    if (window.__lodgeImport && window.__siteGo) h += `<button type="button" class="lodge" data-lodge="${esc(it)}">\u2692 Plan it in the Lodge</button>`;
    h += usedIn(it, false);
    return h;
  }
  function rawView(sub) {
    const s = D.sources[sub.name];
    let h = head(sub.name, sourceTag(sub.name));
    h += `<div class="meta">${s ? esc(s.h) : "not made by any recipe we know"}</div>`;
    h += usedIn(sub.name, true);
    return h;
  }

  // ---------- state ----------
  let cur = null;
  const hist = [];
  function open(name, push) {
    const sub = subjectOf(name);
    if (!sub) return false;
    if (push !== false && cur && cur.name !== sub.name) hist.push(cur.name);
    cur = sub;
    render();
    return true;
  }
  function home() { cur = null; hist.length = 0; $("q-in").value = ""; render(); }
  function render() {
    const on = !!cur;
    $("q-answer").hidden = !on;
    $("q-browse").hidden = on;
    if (!on) { try { localStorage.removeItem("quarry:last"); } catch (e) {} return; }
    $("q-in").value = cur.name;
    $("q-out").innerHTML = ({ rock: rockView, ore: oreView, item: itemView, raw: rawView })[cur.kind](cur);
    $("q-back").hidden = !hist.length;
    try { localStorage.setItem("quarry:last", JSON.stringify({ name: cur.name })); } catch (e) {}
  }

  // ---------- the search box ----------
  const menu = $("q-menu"), box = $("q-in");
  let rows = [], hi = -1;
  function search(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const sc = n => { const l = n.toLowerCase(); return l === q ? 0 : l.startsWith(q) ? 1 : l.split(/[\s/-]+/).some(w => w.startsWith(q)) ? 2 : l.includes(q) ? 3 : 9; };
    return INDEX.map(r => Object.assign({ s: sc(r.name) }, r)).filter(r => r.s < 9)
      .sort((a, b) => a.s - b.s || (a.tag === "rock" ? -1 : 0) - (b.tag === "rock" ? -1 : 0) || a.name.localeCompare(b.name)).slice(0, 14);
  }
  const closeMenu = () => { menu.hidden = true; hi = -1; };
  function drawMenu() {
    menu.innerHTML = rows.map((r, i) => `<li role="option" data-i="${i}" class="${i === hi ? "hi" : ""}"><b>${esc(r.name)}</b><span>${esc(r.tag)}</span></li>`).join("") || `<li class="none">nothing matches</li>`;
    menu.hidden = false;
  }
  function pick(i) { const r = rows[i]; if (!r) return; closeMenu(); open(r.name); }
  box.addEventListener("input", () => { rows = search(box.value); hi = rows.length ? 0 : -1; if (box.value.trim()) drawMenu(); else closeMenu(); });
  box.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" && !menu.hidden) { hi = Math.min(rows.length - 1, hi + 1); drawMenu(); e.preventDefault(); }
    else if (e.key === "ArrowUp" && !menu.hidden) { hi = Math.max(0, hi - 1); drawMenu(); e.preventDefault(); }
    else if (e.key === "Enter") { e.preventDefault(); if (subjectOf(box.value)) { closeMenu(); open(box.value); } else if (!menu.hidden && hi >= 0) pick(hi); }   /* a full name typed wins over the highlighted match */
    else if (e.key === "Escape") closeMenu();
  });
  box.addEventListener("focus", () => { if (box.value.trim() && (!cur || box.value !== cur.name)) { rows = search(box.value); hi = rows.length ? 0 : -1; drawMenu(); } });
  box.addEventListener("blur", () => setTimeout(closeMenu, 150));
  menu.addEventListener("mousedown", e => { const li = e.target.closest("li[data-i]"); if (li) { e.preventDefault(); pick(+li.dataset.i); } });

  // ---------- clicks ----------
  const root = document.querySelector("main.quarry");
  root.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || !root.contains(b)) return;
    if (b.id === "q-back") { const p = hist.pop(); if (p) open(p, false); return; }
    if (b.id === "q-home") { home(); return; }
    if (b.dataset.lodge && window.__lodgeImport && window.__siteGo) { window.__lodgeImport({ name: b.dataset.lodge, goals: [{ item: b.dataset.lodge, qty: 1 }] }); window.__siteGo("lodge"); return; }
    if (b.dataset.go) { open(b.dataset.go); window.scrollTo({ top: root.getBoundingClientRect().top + window.scrollY - 10, behavior: "smooth" }); }
  });
  // one (i) open at a time; a click elsewhere closes it
  document.addEventListener("click", e => {
    for (const d of document.querySelectorAll(".quarry details.info[open]")) if (!d.contains(e.target)) d.open = false;
  });

  // ---------- start ----------
  $("q-rocks").innerHTML = FAMS.map(f => go(f)).join("");
  $("q-ores").innerHTML = ORES.map(o => `<button type="button" class="lk" data-go="${esc(o)}">${dot(o)}${esc(o)}</button>`).join("");
  $("q-foot").textContent = "data of " + D.generated;
  const CR = D.contributors || [];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d => { const p = String(d).split("-"); return p.length === 3 ? `${+p[2]} ${MON[+p[1] - 1]} ${p[0]}` : esc(d); };
  if (CR.length && $("q-roll")) {
    $("q-roll").innerHTML = CR.map(c => `<div class="who"><span class="nm">${esc(c.name)}</span>`
      + (c.samples || []).map(s => `<span class="what">${go(s.rock)} \u00b7 ${n0(s.units)} units \u00b7 ${day(s.date)}</span>`).join("") + `</div>`).join("");
    $("q-credit").hidden = false;
  }
  let last = null;
  try { last = JSON.parse(localStorage.getItem("quarry:last") || "null"); } catch (e) {}
  if (!(last && last.name && open(last.name, false))) render();
})();
