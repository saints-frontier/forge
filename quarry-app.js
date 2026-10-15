/* The Quarry: two questions over one data set (window.QUARRY_DATA, from tools/export_quarry_data.py).
   Where do I get it?   ore -> the rocks that hold it, ranked by evidence; material -> how it is made, down to the
                        ores and rocks (a tree that opens on demand); a rock -> what is known about finding it.
   What do I get from it?  rock -> its ores (our measured cuts, the game's descriptions) and what each refines into;
                        ore or material -> every recipe that uses it.
   Evidence is never mixed: Measured (our own mining, or a Saint's game log, credited by name) / The game says (the
   ore's own description). No player reports or hearsay (user 2026-10-14).
   Every id the page uses starts with q- (the site is one page shared with the Forge and the Lodge). */
(function () {
  "use strict";
  const D = window.QUARRY_DATA;
  const $ = id => document.getElementById(id);
  if (!D || !$("q-in")) return;

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n0 = x => Math.round(x).toLocaleString("en-US");
  const pct = x => Math.round(x * 100) + "%";
  const ORES = D.ores, ORESET = new Set(ORES), FAMS = D.families, PREF = D.prefixes;
  const COLOR = { "Crustal Anorthosite Crystals": "#cfc6ae", "Massive Ataxite Matrix": "#8fa6bf", "Hydrated Gossan Matrix": "#3fa0d0",
    "Irradiated Anthraxolite Veins": "#e07b2e", "Irradiated Cryoconite Nodules": "#9a78e0", "Primordial Anthraxolite Sludge": "#9c6a40",
    "Primitive Rime Shards": "#bfeaf0", "Native Reef Nodules": "#d9b24c" };
  const LEVEL_RANK = { rich: 6, main: 5, common: 4, carries: 3, some: 2, traces: 1 };
  const KIND_HEAD = { refine: "Refine it", print: "Print with it", build: "Build with it" };

  // ---------- indexes ----------
  const makes = {}, uses = {};
  for (const r of D.recipes) {
    for (const o in r.out) (makes[o] = makes[o] || []).push(r);
    for (const i in r.in) (uses[i] = uses[i] || []).push(r);
  }
  const ALL = [...new Set([...Object.keys(makes), ...Object.keys(uses), ...ORES])].sort((a, b) => a.localeCompare(b));
  const facLabel = f => D.facilities[f] || f;
  const facKind = f => D.facilityKind[f] || "build";
  const samplesOf = F => D.samples.filter(s => s.family === F);
  const gameOf = F => D.game.filter(g => g.rocks.includes(F));

  function sourceTag(i) {
    const s = D.sources[i];
    if (!s) return makes[i] ? (D.section[i] || "material").toLowerCase() : "material";
    return { extract: "rift crude", cut: "salvage", loot: "loot", mine: "ore", unknown: "found" }[s.k] || "found";
  }
  const INDEX = [];
  for (const f of FAMS) INDEX.push({ name: f, tag: "rock" });
  const seenRock = new Set(FAMS);
  for (const s of D.samples) if (!seenRock.has(s.rock)) { seenRock.add(s.rock); INDEX.push({ name: s.rock, tag: "rock" }); }
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

  // ---------- evidence ----------
  // rocks that hold an ore, strongest evidence first: a measured share beats the game's word
  function rankRocks(ore) {
    return FAMS.map(F => {
      const ms = samplesOf(F).filter(s => s.ores[ore]).sort((a, b) => b.ores[ore] / b.total - a.ores[ore] / a.total);
      const g = D.game.find(x => x.ore === ore && x.rocks.includes(F));
      if (!ms.length && !g) return null;
      const share = ms.length ? ms[0].ores[ore] / ms[0].total : 0;
      return { F, ms, g, score: (ms.length ? 1000 + 1000 * share : 0) + (g ? LEVEL_RANK[g.level] * 10 : 0) };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
  }
  function oresOfRock(F) {
    const score = {};
    for (const s of samplesOf(F)) for (const o in s.ores) score[o] = (score[o] || 0) + 1000 + 1000 * s.ores[o] / s.total;
    for (const g of gameOf(F)) score[g.ore] = (score[g.ore] || 0) + LEVEL_RANK[g.level] * 10;
    return Object.keys(score).sort((a, b) => score[b] - score[a]);
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
  const go = (name, mode, label) => `<button type="button" class="lk" data-go="${esc(name)}"${mode ? ` data-mode="${mode}"` : ""}>${esc(label || name)}</button>`;
  const dot = o => COLOR[o] ? `<i style="background:${COLOR[o]}"></i>` : "";
  const qty = (q, name) => `${n0(q)} ${go(name)}`;
  function head(title, kicker) { return `<h2><span class="k">${esc(kicker)}</span>${title}</h2>`; }
  function recipeLine(r) {
    const k = facKind(r.f);
    const ins = Object.entries(r.in).map(([i, q]) => qty(q, i)).join(" + ");
    const outs = Object.entries(r.out).map(([o, q]) => qty(q, o)).join(" + ");
    return `<div class="rline"><span class="fac ${k}">${esc(facLabel(r.f))}</span>${ins} <span class="arrow">\u2192</span> ${outs}`
      + (r.t ? ` <span class="t">${n0(r.t)} s</span>` : "") + (r.u ? ` <span class="unv" title="not yet confirmed on this facility">unverified</span>` : "") + `</div>`;
  }
  function recipesByKind(rs) {
    const by = {};
    for (const r of rs) (by[facKind(r.f)] = by[facKind(r.f)] || []).push(r);
    return ["refine", "print", "build"].filter(k => by[k]).map(k => `<h3>${KIND_HEAD[k]}</h3>` + by[k].map(recipeLine).join("")).join("");
  }
  function sampleHtml(s) {
    const word = s.kind === "bore" ? "bored straight through" : "mining run";
    const ores = Object.entries(s.ores).sort((a, b) => b[1] - a[1]);
    const bar = ores.map(([o, q]) => `<span style="width:${(q / s.total * 100).toFixed(2)}%;background:${COLOR[o] || "#666"}" title="${esc(o)} ${pct(q / s.total)}"></span>`).join("");
    return `<div class="sample"><div class="hd"><b>${esc(s.rock)}</b><span>${word} \u00b7 ${esc(s.date)} \u00b7 ${s.minutes} min \u00b7 ${n0(s.total)} units${s.per_min ? " \u00b7 " + n0(s.per_min) + " a minute" : ""}${s.by ? " \u00b7 measured by " + esc(s.by) : ""}</span></div>`
      + `<div class="bar" role="img" aria-label="${esc(ores.map(([o, q]) => o + " " + pct(q / s.total)).join(", "))}">${bar}</div>`
      + `<div class="mix">${ores.map(([o, q]) => `<span>${dot(o)}${go(o)} ${n0(q)} (${pct(q / s.total)})</span>`).join("")}</div>`
      + (s.note ? `<p class="note">${esc(s.note)}</p>` : "") + `</div>`;
  }
  function rocksLine(ore, n) {
    const rows = rankRocks(ore).slice(0, n);
    return rows.length ? rows.map(r => go(r.F)).join(", ") : "no rock recorded yet";
  }

  // ---------- views ----------
  function rockWhat(sub) {
    const F = sub.family, P = sub.prefix, ores = oresOfRock(F);
    let h = head(`What comes out of ${esc(sub.name)}`, "What do I get from it");
    h += ores.length ? `<div class="comes">${ores.map(o => `<button type="button" class="chip" data-go="${esc(o)}">${dot(o)}${esc(o)}</button>`).join("")}</div>`
      : `<p class="lead">Nothing is recorded for ${esc(F)} yet.</p>`;
    if (P) h += `<p class="note">The prefix (${esc(P)}) comes from the game's server and changes the mix, so ${esc(P)} ${esc(F)} cuts come first below.</p>`;
    const ss = samplesOf(F).sort((a, b) => (b.prefix === P) - (a.prefix === P) || b.total - a.total);
    h += `<h3><span class="ev m">Measured</span></h3>` + (ss.length ? ss.map(sampleHtml).join("") + `<p class="note">Units a minute depend on the ship's lasers and lens.</p>`
      : `<p class="note">Nobody has measured a ${esc(F)} yet.</p>`);
    const gs = gameOf(F).sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
    h += `<h3><span class="ev g">The game says</span></h3>` + (gs.length ? `<ul class="plain">${gs.map(g => `<li>${dot(g.ore)}${go(g.ore)}: ${esc(D.levels[g.level])}<div class="quote">\u201c${esc(g.quote)}.\u201d</div></li>`).join("")}</ul>`
      : `<p class="note">No ore's in-game description names ${esc(F)} asteroids.</p>`);
    if (ores.length) {
      h += `<h3>Then refine it</h3>`;
      for (const o of ores) {
        const rs2 = (uses[o] || []).filter(r => facKind(r.f) === "refine");
        h += `<p class="lead" style="margin-top:12px">${dot(o)}<b>${go(o)}</b></p>` + (rs2.length ? rs2.map(recipeLine).join("") : `<p class="note">No refining recipe recorded.</p>`);
      }
    }
    return h;
  }
  function rockWhere(sub) {
    const F = sub.family;
    let h = head(`Where do I find ${esc(sub.name)}?`, "Where do I get it");
    h += `<p class="note">Rocks sit in asteroid belts; their names show on scan labels and when you target one. The game's server picks what spawns where.</p>`;
    h += `<p class="lead" style="margin-top:12px">${go(sub.name, "what", "What comes out of " + sub.name + " \u2192")}</p>`;
    return h;
  }
  function oreWhere(sub) {
    const o = sub.name, rows = rankRocks(o);
    let h = head(`Where do I get ${esc(o)}?`, "Where do I get it");
    h += `<div class="quote">\u201c${esc(D.desc[o] || "")}\u201d</div><p class="note">The game's own description of the ore.</p>`;
    h += `<h3>Rocks that hold it</h3>`;
    if (!rows.length) h += `<p class="note">No rock recorded yet.</p>`;
    else h += `<div class="scroll"><table><thead><tr><th>Rock</th><th><span class="ev m">Measured</span></th><th><span class="ev g">The game says</span></th></tr></thead><tbody>`
      + rows.map(r => {
        const b = r.ms[0];
        const m = b ? `${pct(b.ores[o] / b.total)} of a ${esc(b.rock)} <span class="sub">${n0(b.ores[o])} units in ${b.minutes} min${r.ms.length > 1 ? " \u00b7 " + r.ms.length + " cuts measured" : ""}${b.by ? " \u00b7 measured by " + esc(b.by) : ""}</span>` : `<span class="sub">not measured</span>`;
        const g = r.g ? esc(D.levels[r.g.level]) : `<span class="sub">not named</span>`;
        return `<tr><td>${go(r.F)}</td><td>${m}</td><td>${g}</td></tr>`;
      }).join("") + `</tbody></table></div>`;
    const ref = (uses[o] || []).filter(r => facKind(r.f) === "refine");
    if (ref.length) h += `<h3>It refines into</h3>` + ref.map(recipeLine).join("");
    return h;
  }
  function rawHint(item) {
    if (ORESET.has(item)) return `ore \u00b7 in ${rocksLine(item, 3)}`;
    const s = D.sources[item];
    return s ? esc(s.h) : "not made by any recipe we know";
  }
  function nodeHtml(item, q, depth) {
    const label = `${n0(q)} ${go(item)}`;
    if (!makes[item]) return `<div class="leaf">${label} <span class="src">\u00b7 ${rawHint(item)}</span></div>`;
    const n = makes[item].length;
    return `<details class="node" data-item="${esc(item)}" data-depth="${depth}"><summary>${label} <span class="t">${n === 1 ? "one way to make it" : n + " ways to make it"}</span></summary><div class="kids"></div></details>`;
  }
  function kidsHtml(item, depth) {
    return makes[item].map(r => `<div class="way">${recipeLine(r)}${Object.entries(r.in).map(([i, q]) => nodeHtml(i, q, depth + 1)).join("")}</div>`).join("");
  }
  function itemWhere(sub) {
    const it = sub.name;
    let h = head(`Where do I get ${esc(it)}?`, "Where do I get it");
    const raw = [...rawOf(it)];
    const ores = raw.filter(x => ORESET.has(x)), other = raw.filter(x => !ORESET.has(x));
    if (ores.length) h += `<p class="lead">It can come down to these ores:</p><div class="comes">${ores.map(o => `<button type="button" class="chip" data-go="${esc(o)}">${dot(o)}${esc(o)}</button>`).join("")}</div>`
      + `<ul class="plain" style="margin-top:8px">${ores.map(o => `<li>${dot(o)}${esc(o)}: ${rocksLine(o, 3)}</li>`).join("")}</ul>`;
    if (other.length) h += `<p class="lead" style="margin-top:10px">${ores.length ? "Or from" : "It comes from"}: ${other.map(x => `${go(x)} <span class="note" style="display:inline">(${esc(sourceTag(x))})</span>`).join(", ")}</p>`;
    h += `<h3>How it is made</h3><p class="note">Each line is one way to make it; open an ingredient to see how that is made, down to the rock.</p>` + kidsHtml(it, 0);
    if (window.__lodgeImport && window.__siteGo) h += `<button type="button" class="lodge" data-lodge="${esc(it)}">\u2692 Plan it in the Lodge</button>`;
    return h;
  }
  function rawWhere(sub) {
    let h = head(`Where do I get ${esc(sub.name)}?`, "Where do I get it");
    h += `<p class="lead">${rawHint(sub.name)}</p>`;
    if (uses[sub.name]) h += `<p class="lead" style="margin-top:12px">${go(sub.name, "what", "What it is used for \u2192")}</p>`;
    return h;
  }
  function usesView(sub) {
    const rs = uses[sub.name] || [];
    let h = head(`What do I get from ${esc(sub.name)}?`, "What do I get from it");
    if (sub.kind === "ore") h += `<p class="lead">${dot(sub.name)}Found in ${rocksLine(sub.name, 4)}.</p>`;
    h += rs.length ? recipesByKind(rs) : `<p class="lead">No recipe we know uses ${esc(sub.name)}.</p>`;
    return h;
  }

  // ---------- state ----------
  let cur = null, mode = "where";
  const hist = [];
  function open(name, m, push) {
    const sub = subjectOf(name);
    if (!sub) return false;
    if (push !== false && cur) hist.push({ name: cur.name, mode });
    cur = sub;
    mode = m || (sub.kind === "rock" ? "what" : "where");
    render();
    return true;
  }
  function render() {
    document.querySelectorAll(".quarry .mode").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    if (!cur) return;
    $("q-in").value = cur.name;
    const v = mode === "where"
      ? ({ rock: rockWhere, ore: oreWhere, item: itemWhere, raw: rawWhere })[cur.kind](cur)
      : (cur.kind === "rock" ? rockWhat(cur) : usesView(cur));
    $("q-out").innerHTML = v;
    $("q-back").hidden = !hist.length;
    $("q-crumb").textContent = hist.length ? hist.slice(-3).map(x => x.name).join(" \u203a ") + " \u203a " + cur.name : "";
    try { localStorage.setItem("quarry:last", JSON.stringify({ name: cur.name, mode })); } catch (e) {}
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
    if (b.classList.contains("mode")) { mode = b.dataset.mode; if (cur) render(); else document.querySelectorAll(".quarry .mode").forEach(x => x.setAttribute("aria-pressed", String(x === b))); return; }
    if (b.id === "q-back") { const p = hist.pop(); if (p) open(p.name, p.mode, false); return; }
    if (b.dataset.lodge && window.__lodgeImport && window.__siteGo) { window.__lodgeImport({ name: b.dataset.lodge, goals: [{ item: b.dataset.lodge, qty: 1 }] }); window.__siteGo("lodge"); return; }
    if (b.dataset.go) { open(b.dataset.go, b.dataset.mode || null); window.scrollTo({ top: root.getBoundingClientRect().top + window.scrollY - 10, behavior: "smooth" }); }
  });
  // the tree fills a branch the first time it is opened (toggle does not bubble: listen in the capture phase)
  $("q-out").addEventListener("toggle", e => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open || !d.dataset.item) return;
    const kids = d.querySelector(":scope > .kids");
    if (kids && !kids.dataset.done) { kids.innerHTML = kidsHtml(d.dataset.item, +d.dataset.depth); kids.dataset.done = "1"; }
  }, true);

  // ---------- start ----------
  $("q-rocks").innerHTML = FAMS.map(f => `<button type="button" class="chip" data-go="${esc(f)}">${esc(f)}</button>`).join("");
  $("q-ores").innerHTML = ORES.map(o => `<button type="button" class="chip" data-go="${esc(o)}">${dot(o)}${esc(o)}</button>`).join("");
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
  if (last && last.name) open(last.name, last.mode, false);
})();
