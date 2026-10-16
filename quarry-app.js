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
  const SHORT = { "Crustal Anorthosite Crystals": "Crustal", "Massive Ataxite Matrix": "Ataxite", "Hydrated Gossan Matrix": "Gossan", "Irradiated Anthraxolite Veins": "Veins",
    "Irradiated Cryoconite Nodules": "Cryoconite", "Primordial Anthraxolite Sludge": "Sludge", "Primitive Rime Shards": "Rime", "Native Reef Nodules": "Reef" };
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
  // rifts: crude by kind from our own rift sessions (D.rifts, data/rifts.json), the in-game names, what we learned
  const R = D.rifts && D.rifts.kinds && D.rifts.kinds.length ? D.rifts : null;
  const RIFT_NAMES = R ? R.names.map(n => n.rift) : [];
  const riftKind = crude => R ? R.kinds.find(k => k.crude === crude) : null;
  // salvage: what we cut from wrecks, debris fields and ruins (D.salvage, data/salvage.json), and the sources pilots named
  const SV = D.salvage && D.salvage.materials && D.salvage.materials.length ? D.salvage : null;
  const salvMat = name => SV ? SV.materials.find(m => m.name === name) : null;
  const INDEX = [];
  for (const f of FAMS) INDEX.push({ name: f, tag: "rock" });
  const seenRock = new Set(FAMS);
  for (const a of D.rocks) if (!seenRock.has(a.rock)) { seenRock.add(a.rock); INDEX.push({ name: a.rock, tag: "rock" }); }
  for (const o of ORES) INDEX.push({ name: o, tag: "ore" });
  if (R) { INDEX.push({ name: "Rifts", tag: "crude" }); for (const n of RIFT_NAMES) INDEX.push({ name: n, tag: "rift" }); }
  if (SV) { INDEX.push({ name: "Salvage", tag: "wrecks" }); for (const s of SV.sources) INDEX.push({ name: s.name, tag: "salvage source" }); }
  for (const i of ALL) if (!ORESET.has(i)) INDEX.push({ name: i, tag: sourceTag(i) });

  function subjectOf(name) {
    const lc = String(name || "").trim().toLowerCase();
    if (!lc) return null;
    for (const f of FAMS) {
      if (lc === f.toLowerCase()) return { kind: "rock", name: f, family: f, prefix: "" };
      for (const p of PREF) if (lc === (p + " " + f).toLowerCase()) return { kind: "rock", name: p + " " + f, family: f, prefix: p };
    }
    if (R) {
      if (lc === "rifts" || lc === "rift") return { kind: "rifts", name: "Rifts" };
      const rn = RIFT_NAMES.find(n => n.toLowerCase() === lc);
      if (rn) return { kind: "rift", name: rn };
    }
    if (SV) {
      if (lc === "salvage" || lc === "wrecks" || lc === "wreck") return { kind: "salvage", name: "Salvage" };
      const sn = SV.sources.find(s => s.name.toLowerCase() === lc);
      if (sn) return { kind: "salvsource", name: sn.name };
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
    const bits = ["cut from " + (a.n === 1 ? "1 rock" : a.n + " rocks"), "~" + n0(a.per_min || 0) + "/min"];
    if (a.by && a.by.length) bits.push("by " + a.by.map(esc).join(", "));
    const more = `${a.n === 1 ? "What we cut from one rock" : "The average of what we cut from " + a.n + " rocks, every rock counted once"}: ${n0(a.units)} units. A rock is seldom mined out, so this is the part that was cut, not the whole rock. Units a minute depend on the ship's lasers and lens.`;
    return `<div class="meta">${bits.join(" \u00b7 ")} ${info(esc(more))}</div>`;
  }

  // ---------- views ----------
  function rockView(sub) {
    const F = sub.family, a = D.rocks.find(x => x.rock === sub.name);
    const gs = gameOf(F);
    const said = o => gs.find(g => g.ore === o);
    let h = head(sub.name, "Rock");
    const rows = [];
    if (a) for (const [o, f] of Object.entries(a.share)) if (f > 0) rows.push({ o, f });
    for (const g of gs) if (!rows.some(r => r.o === g.ore)) rows.push({ o: g.ore, f: 0 });
    rows.sort((x, y) => y.f - x.f || LEVEL_RANK[(said(y.o) || {}).level] - LEVEL_RANK[(said(x.o) || {}).level]);
    h += a ? measuredMeta(a) : `<div class="meta">not measured yet</div>`;
    h += `<div class="rows">` + rows.map(r => {
      const g = said(r.o);
      const tag = g ? `<span class="gtag" title="The game says: ${esc(D.levels[g.level])} (\u201c${esc(g.quote)}\u201d)">\u25c6</span>` : "";
      return `<div class="row"><span class="nm">${dot(r.o)}${go(r.o)}${tag}</span>${r.f ? bar(r.f, COLOR[r.o] || "#888") + `<span class="pc">${pct(r.f)}</span>` : (g ? `<span class="gonly">game says: ${esc(D.levels[g.level])}</span>` : "")}</div>`;
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
    if (meas.length) h += `<p class="key">share of what was cut, averaged over the rocks we cut from (N\u00d7 = how many)</p>`;
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
  // what 30 units of a crude become, and the fuel at the end of it, read off the recipes
  function fuelChain(crude) {
    const r = (uses[crude] || []).find(x => Object.keys(x.in).length === 1 && x.in[crude]);
    if (!r) return null;
    const per = r.in[crude], outs = Object.entries(r.out);
    let fuel = null;
    for (const [o, q] of outs) {
      const f = (uses[o] || []).find(x => Object.keys(x.in).length === 1 && Object.keys(x.out).some(y => /Fuel$/.test(y)));
      if (f) { const [fn, fq] = Object.entries(f.out).find(([y]) => /Fuel$/.test(y)); fuel = { from: o, q, fuel: fn, fin: f.in[o], fout: fq, perUnit: q / per * fq / f.in[o] }; break; }
    }
    return { per, outs, fuel };
  }
  const chainText = crude => {
    const c = fuelChain(crude);
    if (!c) return "";
    let t = `${n0(c.per)} units become ${c.outs.map(([o, q]) => n0(q) + " " + o).join(" + ")}`;
    if (c.fuel) t += `; ${n0(c.fuel.fin)} ${c.fuel.from} make ${n0(c.fuel.fout)} ${c.fuel.fuel}: about ${n0(Math.round(c.fuel.perUnit))} fuel a unit of crude`;
    return t + ".";
  };
  function riftBlock(crude) {
    const k = riftKind(crude);
    if (!k) return "";
    const bits = [k.n === 1 ? "1 rift session" : k.n + " rift sessions", n0(k.units) + " units", "~" + n0(k.per_min_one) + "/min per extractor"];
    if (k.names.length) bits.push("from " + k.names.map(esc).join(", "));
    const more = `${n0(k.cuts)} cuts in ${k.minutes} minutes of extracting, our own logs${k.desc ? ". The game: \u201c" + esc(k.desc) + "\u201d" : ""}`;
    return `<h3>From rifts</h3><div class="meta">${bits.join(" \u00b7 ")} ${info(more)}</div>` + (chainText(crude) ? `<p class="note">${esc(chainText(crude))}</p>` : "");
  }
  const sizesText = sz => Object.entries(sz || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} (${n0(v)}\u00d7)`).join(", ");
  function salvageBlock(name) {
    const m = salvMat(name);
    if (!m) return "";
    const bits = [m.n === 1 ? "1 run" : m.n + " runs", n0(m.units) + " units"];
    if (m.per_min) bits.push("~" + n0(m.per_min) + "/min");
    const more = `${n0(m.cuts)} cuts in ${m.minutes} minutes of cutting, our own logs. Units a cut: ${sizesText(m.sizes)}.`;
    return `<h3>From salvage</h3><div class="meta">${bits.join(" \u00b7 ")} ${info(more)}</div>`;
  }
  function salvageView() {
    let h = head("Salvage", "Wrecks", info("Salvage is cut with a laser from wrecks, debris fields and ruins. Numbers are from our own game logs and from the Quarry companion's sessions."));
    h += `<div class="meta">what we cut, how fast, and where it came from</div>`;
    h += `<div class="rows">` + SV.materials.map(m => `<div class="row"><span class="nm">${go(m.name)}<span class="dim small"> ${m.n}\u00d7</span></span><span class="pc">${n0(m.units)} units</span><span class="pc dim">${m.per_min ? "~" + n0(m.per_min) + "/min" : ""}</span></div>`).join("") + `</div>`;
    if (SV.sources.length) h += `<h3>By source</h3><div class="rows">` + SV.sources.map(s => `<div class="row"><span class="nm">${go(s.name)}<span class="dim small"> gave ${s.materials.map(esc).join(", ")}</span></span><span class="pc">${n0(s.units)} units</span><span class="pc dim">${s.n}\u00d7</span></div>`).join("") + `</div>`;
    else h += `<p class="note">No source has a name yet: name the wreck or ruin on the Quarry companion page when you cut it.</p>`;
    h += `<h3>Good to know</h3><ul class="facts">` + SV.facts.map(f => `<li>${esc(f)}</li>`).join("") + `</ul>`;
    return h;
  }
  function salvSourceView(sub) {
    const s = SV.sources.find(x => x.name === sub.name);
    let h = head(sub.name, "Salvage source");
    h += `<div class="meta">${s.n === 1 ? "1 run" : s.n + " runs"} \u00b7 ${n0(s.units)} units</div>`;
    h += `<h3>It gave</h3><div class="rows">` + s.materials.map(mn => { const m = salvMat(mn); const ss = m ? m.sessions.filter(x => x.source === sub.name) : []; const u = ss.reduce((a, x) => a + x.units, 0);
      return `<div class="row"><span class="nm">${go(mn)}</span><span class="pc">${n0(u)} units</span><span class="pc dim">${ss.length}\u00d7</span></div>`; }).join("") + `</div>`;
    return h;
  }
  function rawView(sub) {
    const s = D.sources[sub.name];
    let h = head(sub.name, sourceTag(sub.name));
    h += `<div class="meta">${s ? esc(s.h) : "not made by any recipe we know"}</div>`;
    h += riftBlock(sub.name);
    h += salvageBlock(sub.name);
    h += usedIn(sub.name, true);
    return h;
  }
  function riftsView() {
    let h = head("Rifts", "Crude", info("Crude comes out of rifts with a Crude Extractor and a lens, not a laser. Numbers are from our own game logs; rates are per extractor."));
    h += `<div class="meta">what each kind of crude gives, and what it becomes</div>`;
    h += `<div class="rows">` + R.kinds.map(k => {
      const c = fuelChain(k.crude);
      const fuel = c && c.fuel ? `${n0(Math.round(c.fuel.perUnit))} ${esc(c.fuel.fuel)} a unit` : "";
      return `<div class="row"><span class="nm">${go(k.crude)}<span class="dim small"> ${k.n}\u00d7${k.names.length ? " \u00b7 " + k.names.map(esc).join(", ") : ""}</span></span><span class="pc">${n0(k.units)} units</span><span class="pc dim">${fuel}</span></div>`;
    }).join("") + `</div>`;
    h += `<h3>By name in space</h3><div class="rows">` + R.names.map(n => `<div class="row"><span class="nm">${go(n.rift)}<span class="dim small"> gave ${n.crude.map(c => esc(c.replace("Crude - ", ""))).join(", ")}</span></span><span class="pc dim">${n.n}\u00d7</span></div>`).join("") + `</div>`;
    h += `<h3>Good to know</h3><ul class="facts">` + R.facts.map(f => `<li>${esc(f)}</li>`).join("") + `</ul>`;
    return h;
  }
  function riftNameView(sub) {
    const n = R.names.find(x => x.rift === sub.name);
    let h = head(sub.name, "Rift");
    const bits = [n.n === 1 ? "1 session" : n.n + " sessions", n0(n.units) + " units"];
    if (n.former && n.former.length) bits.push("earlier builds called it " + n.former.map(esc).join(" / "));
    h += `<div class="meta">${bits.join(" \u00b7 ")}</div>`;
    h += `<h3>It gave</h3><div class="rows">` + n.crude.map(c => { const k = riftKind(c); const s = k ? k.sessions.filter(x => x.rift === sub.name) : []; const u = s.reduce((a, x) => a + x.units, 0);
      return `<div class="row"><span class="nm">${go(c)}</span><span class="pc">${n0(u)} units</span><span class="pc dim">${s.length}\u00d7</span></div>`; }).join("") + `</div>`;
    h += `<p class="note">${esc("Other " + sub.name + "s may give the other grade: the log line says which.")}</p>`;
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
    // with an answer open the search box gives way to every rock, so another rock is one click away
    const qb = $("q-in").closest(".qbox"); if (qb) qb.hidden = on;
    if ($("q-jump")) {
      $("q-jump").hidden = !on;
      if (on) $("q-jumprocks").innerHTML = FAMS.map(f => `<button type="button" class="lk${cur.family === f ? " on" : ""}" data-go="${esc(f)}"${cur.family === f ? ' aria-current="true"' : ""}>${esc(f)}</button>`).join("");
    }
    if (!on) { try { localStorage.removeItem("quarry:last"); } catch (e) {} return; }
    $("q-in").value = cur.name;
    $("q-out").innerHTML = ({ rock: rockView, ore: oreView, item: itemView, raw: rawView, rifts: riftsView, rift: riftNameView, salvage: salvageView, salvsource: salvSourceView })[cur.kind](cur);
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
    if (b.id === "q-back") { const p = hist.pop(); if (p) open(p, false); else home(); return; }   /* the first page back is the Quarry's start */
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
  if ($("q-salv")) { $("q-salv").innerHTML = SV ? [go("Salvage", "what salvage gives")].concat(SV.materials.map(m => go(m.name))).concat(SV.sources.map(s => go(s.name))).join("") : ""; if ($("q-salvrow")) $("q-salvrow").hidden = !SV; }
  if ($("q-rifts")) { $("q-rifts").innerHTML = R ? [go("Rifts", "what rifts give")].concat(RIFT_NAMES.map(n => go(n))).concat(R.kinds.map(k => go(k.crude, k.crude.replace("Crude - ", "")))).join("") : ""; if ($("q-riftrow")) $("q-riftrow").hidden = !R; }
  $("q-foot").textContent = "data of " + D.generated;
  const CR = D.contributors || [];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d => { const p = String(d).split("-"); return p.length === 3 ? `${+p[2]} ${MON[+p[1] - 1]} ${p[0]}` : esc(d); };
  function drawRoll() {
    if (!CR.length || !$("q-roll")) return;
    $("q-roll").innerHTML = CR.map(c => { const ss = c.samples || [], u = ss.reduce((a, s) => a + (+s.units || 0), 0), n = ss.reduce((a, s) => a + (+s.n || 1), 0);
      return `<div class="who"><span class="nm">${esc(c.name)}</span><span class="what">${n} sample${n === 1 ? "" : "s"} \u00b7 ${n0(u)} units</span>`
        + `<span class="rk">${ss.map(s => go(s.rock)).join(", ")}</span></div>`; }).join("");
    $("q-credit").hidden = false;
  }
  drawRoll();
  let last = null;
  try { last = JSON.parse(localStorage.getItem("quarry:last") || "null"); } catch (e) {}
  if (!(last && last.name && open(last.name, false))) render();

  // ---------- the tribe's sessions from the site store ----------
  // The Quarry companion (frontier-toolkit `python frontier.py quarry`) reads the rock's name off the screen while a
  // Saint mines and sends each run to /api/quarry at the end of the session (user 2026-10-15). Every run is one rock;
  // they join the baked averages here exactly as the exporter would: each rock counted once, shares averaged over
  // rocks, the contributor named on the Roll. GET /api/quarry is public (no character names, no times, no systems).
  const splitRock = name => { const p = String(name).split(" "); return p.length > 1 && PREF.includes(p[0]) ? [p[0], p.slice(1).join(" ")] : ["", name]; };
  // a rift or salvage run from the store joins its crude kind / salvage material (and its named rift / source)
  function mergeOther(r, tot) {
    const date = String(r.date || "").slice(0, 10), by = typeof r.by === "string" ? r.by : "", minutes = +r.minutes || 0;
    for (const [mat, q] of Object.entries(r.ores)) {
      if (r.kind === "rift" && R) {
        let k = riftKind(mat);
        if (!k) { k = { crude: mat, age: "", grade: "", names: [], n: 0, units: 0, cuts: 0, minutes: 0, per_min_one: 0, sessions: [], desc: "" }; R.kinds.push(k); }
        k.n++; k.units += q; k.cuts += +r.cuts || 0; k.minutes = Math.round((k.minutes + minutes) * 10) / 10;
        k.sessions.push({ date, units: q, minutes, runs: 1, rift: RIFT_NAMES.includes(r.rock) ? r.rock : null });
        if (RIFT_NAMES.includes(r.rock)) { if (!k.names.includes(r.rock)) k.names.push(r.rock); const nm = R.names.find(x => x.rift === r.rock); if (nm) { nm.n++; nm.units += q; if (!nm.crude.includes(mat)) nm.crude.push(mat); } }
      } else if (r.kind === "salvage" && SV) {
        let m = salvMat(mat);
        if (!m) { m = { name: mat, n: 0, units: 0, cuts: 0, minutes: 0, per_min: null, sizes: {}, sessions: [] }; SV.materials.push(m); }
        m.n++; m.units += q; m.cuts += +r.cuts || 0; m.minutes = Math.round((m.minutes + minutes) * 10) / 10;
        m.sessions.push({ date, units: q, minutes, cuts: +r.cuts || 0, source: r.rock });
        let s = SV.sources.find(x => x.name === r.rock);
        if (!s) { s = { name: r.rock, n: 0, units: 0, materials: [] }; SV.sources.push(s); INDEX.push({ name: r.rock, tag: "salvage source" }); }
        s.n++; s.units += q; if (!s.materials.includes(mat)) s.materials.push(mat);
      } else return false;
    }
    if (by) { let c = CR.find(x => x.name === by); if (!c) { c = { name: by, samples: [] }; CR.push(c); } let s = c.samples.find(x => x.rock === r.rock); if (!s) { s = { rock: r.rock, date, units: 0, n: 0 }; c.samples.push(s); } s.units += tot; s.n++; if (date > s.date) s.date = date; }
    return true;
  }
  function mergeRuns(runs) {
    const byRock = {};
    let used = 0;
    for (const r of runs || []) {
      if (!r || typeof r.rock !== "string" || !r.ores || typeof r.ores !== "object") continue;
      const tot = Object.values(r.ores).reduce((a, b) => a + (+b || 0), 0);
      if (!(tot > 0)) continue;
      if (r.kind === "rift" || r.kind === "salvage") { if (mergeOther(r, tot)) used++; continue; }
      used++;
      (byRock[r.rock] = byRock[r.rock] || []).push({ share: Object.fromEntries(Object.entries(r.ores).filter(([o]) => ORESET.has(o)).map(([o, q]) => [o, q / tot])),
        rate: r.minutes >= 1 && (r.cuts == null || r.cuts >= 5) ? tot / r.minutes : null, units: tot, by: typeof r.by === "string" ? r.by : "", date: String(r.date || "").slice(0, 10) });
    }
    for (const [rock, rs] of Object.entries(byRock)) {
      let a = D.rocks.find(x => x.rock === rock);
      if (!a) {
        const [prefix, family] = splitRock(rock);
        a = { rock, prefix, family, n: 0, units: 0, share: {}, per_min: null, rated: 0, by: [], note: "" };
        D.rocks.push(a);
        if (!FAMS.includes(family)) { FAMS.push(family); INDEX.push({ name: family, tag: "rock" }); }
        if (!seenRock.has(rock)) { seenRock.add(rock); INDEX.push({ name: rock, tag: "rock" }); }
      }
      const n = a.n + rs.length, share = {};
      for (const o of new Set([...Object.keys(a.share), ...rs.flatMap(r => Object.keys(r.share))]))
        share[o] = (a.n * (a.share[o] || 0) + rs.reduce((s, r) => s + (r.share[o] || 0), 0)) / n;
      a.share = Object.fromEntries(Object.entries(share).sort((x, y) => y[1] - x[1]).map(([o, v]) => [o, Math.round(v * 10000) / 10000]));
      const rates = rs.filter(r => r.rate).map(r => r.rate), had = a.per_min ? (a.rated || a.n) : 0;
      if (had + rates.length) { a.per_min = Math.round(((a.per_min || 0) * had + rates.reduce((s, x) => s + x, 0)) / (had + rates.length)); a.rated = had + rates.length; }
      a.units += rs.reduce((s, r) => s + r.units, 0);
      a.n = n;
      for (const r of rs) if (r.by && !a.by.includes(r.by)) a.by.push(r.by);
      // the Roll of Honour
      for (const r of rs) {
        if (!r.by) continue;
        let c = CR.find(x => x.name === r.by);
        if (!c) { c = { name: r.by, samples: [] }; CR.push(c); }
        let s = c.samples.find(x => x.rock === rock);
        if (!s) { s = { rock, date: r.date, units: 0, n: 0 }; c.samples.push(s); }
        s.units += r.units; s.n += 1; if (r.date > s.date) s.date = r.date;
      }
    }
    for (const c of CR) c.samples.sort((x, y) => y.units - x.units);
    CR.sort((x, y) => x.name.localeCompare(y.name));
    drawRoll();
    if ($("q-rocks")) $("q-rocks").innerHTML = FAMS.map(f => go(f)).join("");
    if (cur) render();
    if ($("q-foot") && used) $("q-foot").textContent = "data of " + D.generated + " + " + used + " tribe session" + (used === 1 ? "" : "s");
    return used;
  }
  // ---------- the review list: samples sent from the Quarry companion wait here until a keeper approves them ----------
  // Shown to Paladins, Knights and the site keepers who are logged in (tribe.js shares the login: window.__tribeData).
  const SALV = new Set(["Debris", "Cargo Debris", "Salvaged Materials", "Cinderwrack"]);
  let reviewRuns = [], reviewBusy = false;
  const maxRate = () => Math.max(0, ...D.rocks.map(a => a.per_min || 0));
  function checksOf(r) {
    const tot = Object.values(r.ores).reduce((a, b) => a + b, 0), out = [];
    const rate = r.minutes >= 1 ? tot / r.minutes : null;
    const kind = r.kind || (Object.keys(r.ores).every(o => /^Crude/.test(o)) ? "rift" : Object.keys(r.ores).every(o => SALV.has(o)) ? "salvage" : "rock");
    if (rate && kind === "rock" && rate > 1.25 * maxRate()) out.push(["warn", `${n0(rate)} a minute: faster than any rock on the Quarry (${n0(maxRate())})`]);
    if (kind === "rock") {
      const [, fam] = splitRock(r.rock), named = new Set(gameOf(fam).map(g => g.ore));
      D.rocks.filter(a => a.family === fam).forEach(a => Object.keys(a.share).forEach(o => named.add(o)));
      const odd = Object.keys(r.ores).filter(o => !named.has(o));
      if (named.size && odd.length) out.push(["warn", `not seen in ${fam} before: ${odd.join(", ")}`]);
    }
    if (Array.isArray(r.lines) && r.lines.length) {
      const sz = {}; r.lines.forEach(l => { const k = (SHORT[l[1]] || l[1]) + " " + l[2]; sz[k] = (sz[k] || 0) + 1; });
      out.push(["", "cut sizes: " + Object.entries(sz).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} \u00d7${v}`).join(", ")]);
      let gap = 0; for (let i = 1; i < r.lines.length; i++) gap = Math.max(gap, r.lines[i][0] - r.lines[i - 1][0]);
      out.push(["", `longest pause between cuts: ${gap} s`]);
    } else out.push(["warn", "no cut lines sent: only the totals can be checked"]);
    if (r.reads) out.push(["", r.reads.total ? `screen reads naming it: ${r.reads.agree} of ${r.reads.total}` : "named by the pilot"]);
    if (r.full) out.push(["", "the hold filled"]);
    return { kind, tot, rate, out };
  }
  function drawReview() {
    const box = $("q-review"); if (!box) return;
    box.hidden = !reviewRuns.length;
    $("q-revn").textContent = reviewRuns.length === 1 ? "1 sample" : reviewRuns.length + " samples";
    $("q-revlist").innerHTML = reviewRuns.map(r => {
      const c = checksOf(r), when = String(r.start || "").replace("T", " ").slice(0, 16);
      const mix = Object.entries(r.ores).sort((a, b) => b[1] - a[1]).map(([o, q]) => `<span class="row"><span class="nm">${dot(o)}${esc(SHORT[o] || o)}</span>${bar(q / c.tot, COLOR[o] || "#888")}<span class="pc">${pct(q / c.tot)}</span></span>`).join("");
      return `<div class="rev" data-id="${esc(r.id)}"><div class="revhead"><b>${esc(r.rock)}</b><span class="tagk">${esc(c.kind)}</span><span class="dim small">by ${esc(r.by || "?")} \u00b7 ${esc(when)} UTC</span></div>`
        + `<div class="revnums">${n0(c.tot)} units \u00b7 ${(+r.minutes).toFixed(1)} min${c.rate ? " \u00b7 " + n0(c.rate) + " a minute" : ""} \u00b7 ${n0(r.cuts)} cuts \u00b7 ${n0(c.tot / Math.max(1, r.cuts))} a cut</div>`
        + `<div class="rows">${mix}</div><ul class="revchecks">${c.out.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join("")}</ul>${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}`
        + `<div class="revacts"><button type="button" class="navb ok" data-approve="${esc(r.id)}">Approve</button><button type="button" class="navb no" data-reject="${esc(r.id)}">Reject</button></div></div>`;
    }).join("");
  }
  async function loadReview() {
    if (reviewBusy) return; reviewBusy = true;
    try { const r = await fetch("/api/quarry?review=1", { credentials: "same-origin", cache: "no-store" }); const d = r.ok ? await r.json() : null; reviewRuns = d && Array.isArray(d.runs) ? d.runs : []; drawReview(); }
    catch (e) {} finally { reviewBusy = false; }
  }
  async function decide(id, act, btn) {
    if (act === "reject" && !btn.classList.contains("arm")) { btn.classList.add("arm"); btn.textContent = "Click again to reject"; setTimeout(() => { btn.classList.remove("arm"); btn.textContent = "Reject"; }, 4000); return; }
    btn.disabled = true;
    try {
      const r = await fetch("/api/quarry", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [act]: [id] }) });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || "not saved");
      const run = reviewRuns.find(x => x.id === id);
      reviewRuns = reviewRuns.filter(x => x.id !== id); drawReview();
      if (act === "approve" && run) mergeRuns([{ rock: run.rock, kind: checksOf(run).kind, date: String(run.start).slice(0, 10), cuts: run.cuts, ores: run.ores, minutes: run.minutes, full: !!run.full, by: run.by }]);
    } catch (e) { btn.disabled = false; btn.textContent = "failed: " + e.message; }
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-approve],[data-reject]"); if (!b) return;
    decide(b.dataset.approve || b.dataset.reject, b.dataset.approve ? "approve" : "reject", b);
  });
  const keeper = () => { const t = window.__tribeData; return !!(t && t.state === "in" && t.me && t.me.upload); };
  window.addEventListener("tribe:data", () => { if (keeper() && !reviewRuns.length) loadReview(); });
  if (keeper()) loadReview();
  window.__quarryReview = runs => { reviewRuns = runs || []; drawReview(); };   // test hook

  // ---------- the quarry key, right on the Quarry (it used to live only in the Forge's tribe box) ----------
  function drawKeyBox() {
    const out = $("q-keyout"); if (!out) return;
    const t = window.__tribeData;
    if (!(t && t.state === "in")) return;                          // logged out: the login link stays (it comes back here)
    out.innerHTML = `<button type="button" class="gabtn2" id="q-getkey">\u2720 Get my quarry key</button><div class="keynote">Logged in as ${esc(t.me && t.me.name || "")}. A new key replaces your old one.</div>`;
  }
  document.addEventListener("click", async e => {
    if (!e.target.closest("#q-getkey,#q-copykey")) return;
    const out = $("q-keyout");
    if (e.target.closest("#q-copykey")) { const i = $("q-keyin"); i.select(); try { await navigator.clipboard.writeText(i.value); $("q-copykey").textContent = "copied"; } catch (x) { $("q-copykey").textContent = "press Ctrl+C"; } return; }
    try {
      const r = await fetch("/api/appkey", { credentials: "same-origin", cache: "no-store" }); const d = r.ok ? await r.json() : null;
      if (!d || !d.ok) throw new Error(r.status === 401 ? "log in again" : "the site did not answer");
      out.innerHTML = `<div class="keyrow"><input id="q-keyin" readonly value="${esc(d.key)}" aria-label="Your quarry key"><button type="button" class="gabtn2" id="q-copykey">copy</button></div>`
        + `<div class="keynote">Valid until ${esc(d.expires)}. Paste it into the companion's page under <b>Send to the Quarry</b> \u2192 <b>Save key</b>. Keep it to yourself: it sends sessions as you.</div>`;
      try { await navigator.clipboard.writeText(d.key); $("q-copykey").textContent = "copied"; } catch (x) {}
    } catch (x) { out.insertAdjacentHTML("beforeend", `<div class="keynote">No key: ${esc(x.message)}.</div>`); }
  });
  window.addEventListener("tribe:data", drawKeyBox);
  drawKeyBox();

  window.__quarryMerge = mergeRuns;        // the site's test hook (and tribe.js, should it ever hand runs in)
  if (/thesaintsforge\.com$|^localhost$|^127\.0\.0\.1$/.test(location.hostname) && window.fetch)
    fetch("/api/quarry", { credentials: "omit" }).then(r => r.ok ? r.json() : null).then(d => { if (d && d.ok && Array.isArray(d.runs)) mergeRuns(d.runs); }).catch(() => {});
})();
