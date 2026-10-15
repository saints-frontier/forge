/* Saints Forge: ship cards in the browser. The chrome (palette, geometry, ornaments, hull outline, CSS, defs) comes
   from card.js (FORGE_CARD, exported from guides/ships/make_ship_cards.py); this file draws the fit on top of it the same
   way card_html() does, so a card made here matches the doctrine cards pixel for pixel in layout. Exposes
   window.ForgeCard = { build(opts) -> svg string, texts(preset, numbers, ...) -> prose, toPng(svg) -> Blob }. */
(function () {
  "use strict";
  const K = window.FORGE_CARD;
  if (!K) { window.ForgeCard = null; return; }
  const W = K.W, H = K.H;
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmtN = n => Number(n).toLocaleString("en-US");

  // ---------- numbers and prose (make_ship_cards.numbers_of / card_text) ----------
  function numbersOf(counts, modules) {
    const caps = counts["Capacitor"] || 0, containers = counts["Cargo Container"] || 0, ec = counts["Emergency Container"] || 0;
    const cargo = 36 * containers + 25 * ec;
    const fuel = 500 * (counts["Fuel Bay"] || 0) + 250 * (counts["Fuel Blister"] || 0);
    const braces = counts["Structural Brace"] || 0, reps = counts["Hull Repairer"] || 0;
    const word = n => K.number_words[String(n)] || String(n);
    return { cargo, fuel, caps, Caps: word(caps), capgj: 100 * (caps + (counts["Blackstart Cell"] || 0)), rep: 25 * reps, reps, containers, ec, hull: 2100 + 375 * braces,
             braces, Braces: word(braces), sentries: Math.floor(cargo / 48),
             holds: `room for ${fmtN(cargo)} Crustal Anorthosite Crystals, ${fmtN(Math.floor(cargo / 0.28))} EU-40 or SOF-40 Fuel (0.28 m³ a unit) or ${Math.floor(cargo / 48)} Field Sentries` };
  }
  // Python str.format subset: {name} and {name:,}
  function fill(tpl, v) { return String(tpl || "").replace(/\{(\w+)(:,)?\}/g, (m, k, comma) => (k in v) ? (comma ? fmtN(v[k]) : String(v[k])) : m); }

  // Prose for a card. A doctrine preset keeps its own text (filled with the live numbers); anything else gets a
  // description written from the fit, which the pilot can edit in the dialog.
  function texts(opts) {
    const { preset, counts, exterior, name, hull, dirty, diff } = opts;
    const v = numbersOf(counts);
    const t = preset && K.text[preset.n] ? K.text[preset.n] : null;
    const extW = Object.keys(exterior || {}).filter(n => exterior[n] && /Stuttergun|Needle|Laser|Extractor/.test(n));
    if (t && !dirty) {
      return { title: t.title, origin: t.origin || "", role: t.role, motto: t.motto, latin: t.latin || "", weapon: t.weapon || "",
               purpose: fill(t.purpose, v), how: fill(t.how, v), why: fill(t.why, v), numbers: v };
    }
    const base = t ? t.title : null;
    const parts = [];
    if (v.containers || v.ec) parts.push(`${v.containers} Cargo Container${v.containers === 1 ? "" : "s"}${v.ec ? ` and ${v.ec} Emergency Container${v.ec === 1 ? "" : "s"}` : ""}: ${fmtN(v.cargo)} m³.`);
    const bays = counts["Fuel Bay"] || 0, bl = counts["Fuel Blister"] || 0;
    if (bays || bl) parts.push(`${bays ? bays + " Fuel Bay" + (bays === 1 ? "" : "s") : ""}${bays && bl ? " and " : ""}${bl ? bl + " Fuel Blister" + (bl === 1 ? "" : "s") : ""}: ${fmtN(v.fuel)} fuel.`);
    parts.push(`${v.Caps} Capacitor${v.caps === 1 ? "" : "s"} (${fmtN(v.capgj)} GJ).`);
    if (v.braces) parts.push(`${v.Braces} Brace${v.braces === 1 ? "" : "s"} (~${fmtN(v.hull)} HP).`);
    if (v.reps) parts.push(`${v.reps === 1 ? "One Repairer" : K.number_words[String(v.reps)] + " Repairers"} (${v.rep} HP/s).`);
    if (extW.length) parts.push(extW.map(n => `${exterior[n]}x ${n}`).join(", ") + " on the hardpoints.");
    const why = diff && diff.length ? `Changes against ${base ? "+" + base.toUpperCase() + "+" : "the doctrine fit"}: ${diff.join(", ")}.` : "Describe what this fit is for and why it beats the doctrine fit.";
    return { title: name || (base ? base + " proposal" : "Proposal"), origin: "", role: t ? t.role : (hull === "LAI" ? "LAI fit" : "Reiver fit"), motto: "", latin: t ? t.latin || "" : "",
             weapon: extW.length ? extW.join(" + ") : "", purpose: t ? fill(t.purpose, v) : "What this ship is for.", how: parts.join(" "), why, numbers: v };
  }

  // ---------- the grid (make_ship_cards.type_order / numbers / grid_svg) ----------
  function typeOrder(placements) {
    const counts = {}; placements.forEach(p => counts[p[0]] = (counts[p[0]] || 0) + 1);
    const order = Object.keys(counts).sort((a, b) => {
      const ka = [a === "Cargo Container" ? 1 : 0, a !== "Cargo Container" ? -counts[a] : 0, a], kb = [b === "Cargo Container" ? 1 : 0, b !== "Cargo Container" ? -counts[b] : 0, b];
      for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1; return 0; });
    return { counts, order };
  }
  function numbering(placements) {
    const { order } = typeOrder(placements);
    const idx = placements.map((p, i) => i).sort((i, j) => {
      const a = placements[i], b = placements[j];
      const ka = [order.indexOf(a[0]), a[1], Math.min(...a[3].map(c => c[1])), Math.min(...a[3].map(c => c[0]))];
      const kb = [order.indexOf(b[0]), b[1], Math.min(...b[3].map(c => c[1])), Math.min(...b[3].map(c => c[0]))];
      for (let k = 0; k < 4; k++) if (ka[k] !== kb[k]) return ka[k] - kb[k]; return 0; });
    const num = {}; idx.forEach((i, k) => num[i] = k + 1); return num;
  }
  function gridSvg(hull, placements, ch) {
    const th = ch.theme, cell = ch.cell, slots = ch.slots, secs = hull.sections;
    const num = numbering(placements); const out = [], tags = [];
    secs.forEach((sec, s) => {
      const [sx, sy] = slots[s];
      sec.cells.forEach(([cx, cy]) => out.push(`<rect x="${(sx + cx * cell).toFixed(1)}" y="${(sy + cy * cell).toFixed(1)}" width="${cell}" height="${cell}" fill="${th.cellbg}" stroke="${th.cellline}"/>`));
      placements.forEach((p, i) => {
        if (p[1] !== s) return;
        const cs = p[3], set = new Set(cs.map(c => c.join(","))), col = K.colors[p[0]] || "#888";
        cs.forEach(([cx, cy]) => out.push(`<rect x="${(sx + cx * cell).toFixed(1)}" y="${(sy + cy * cell).toFixed(1)}" width="${cell}" height="${cell}" fill="${col}"/>`));
        cs.forEach(([cx, cy]) => {                                  // outline + bevel: light top/left, dark bottom/right
          const X = sx + cx * cell, Y = sy + cy * cell;
          [[[cx, cy - 1], [X, Y, X + cell, Y], "#fff", 0.35], [[cx - 1, cy], [X, Y, X, Y + cell], "#fff", 0.25],
           [[cx, cy + 1], [X, Y + cell, X + cell, Y + cell], "#000", 0.45], [[cx + 1, cy], [X + cell, Y, X + cell, Y + cell], "#000", 0.35]].forEach(([nb, [a, b, c, d], colr, op]) => {
            if (set.has(nb.join(","))) return;
            out.push(`<line x1="${a.toFixed(1)}" y1="${b.toFixed(1)}" x2="${c.toFixed(1)}" y2="${d.toFixed(1)}" stroke="${th.ink}" stroke-width="2.6"/>`);
            out.push(`<line x1="${a.toFixed(1)}" y1="${b.toFixed(1)}" x2="${c.toFixed(1)}" y2="${d.toFixed(1)}" stroke="${colr}" stroke-opacity="${op}" stroke-width="1"/>`); }); });
        const mx = cs.reduce((a, c) => a + c[0], 0) / cs.length, my = cs.reduce((a, c) => a + c[1], 0) / cs.length;
        let best = null, bk = null;
        cs.forEach(c => { const k = [(c[0] - mx) ** 2 + (c[1] - my) ** 2, c[1], c[0]]; if (!bk || k[0] < bk[0] || (k[0] === bk[0] && (k[1] < bk[1] || (k[1] === bk[1] && k[2] < bk[2])))) { bk = k; best = c; } });
        let [bx, by] = best; if (cs.length >= 4 && Math.abs(bx - mx) < 0.6 && Math.abs(by - my) < 0.6) { bx = mx; by = my; }
        tags.push(`<text x="${(sx + (bx + 0.5) * cell).toFixed(1)}" y="${(sy + (by + 0.5) * cell + 4).toFixed(1)}" class="num">${num[i]}</text>`);
      });
    });
    return out.join("") + tags.join("");
  }
  function legend(placements, weapon, exterior, x, y, ch) {
    const th = ch.theme, width = ch.leg_w, nx = width > 300 ? 98 : 84;
    const { counts, order } = typeOrder(placements); const rows = []; let yy = y, first = 1;
    order.forEach(k => {
      const rng = counts[k] === 1 ? `${first}` : `${first}–${first + counts[k] - 1}`; first += counts[k];
      rows.push(`<rect x="${x}" y="${yy - 16}" width="20" height="20" fill="${K.colors[k] || "#888"}" stroke="${th.silver}" stroke-width="1"/><text x="${x + 30}" y="${yy}" class="legr">${rng}</text><text x="${x + nx}" y="${yy}" class="leg">${esc(k)}</text><text x="${x + width}" y="${yy}" class="legn">×${counts[k]}</text>`);
      if (k === "Weapon Receiver" && weapon) { yy += 24; rows.push(`<text x="${x + 32}" y="${yy}" style="font:600 15px Consolas,monospace;fill:${th.accent}">↳ ${esc(weapon)}</text>`); }
      yy += 33; });
    Object.keys(exterior || {}).filter(k => exterior[k]).forEach(k => {
      rows.push(`<rect x="${x}" y="${yy - 16}" width="20" height="20" fill="none" stroke="${th.gold}" stroke-width="1" stroke-dasharray="3 2"/><text x="${x + 30}" y="${yy}" class="legr">ext</text><text x="${x + nx}" y="${yy}" class="leg">${esc(k)}</text><text x="${x + width}" y="${yy}" class="legn">×${exterior[k]}</text>`);
      yy += 33; });
    return [rows.join(""), yy];
  }
  function statBoxes(v, ch, x0, y0, boxW) {
    const th = ch.theme, mx = th.stat_max, cut = ch.lai ? 16 : 8;
    const stats = [["CARGO", fmtN(v.cargo), "m³", v.cargo / mx.cargo], ["FUEL", fmtN(v.fuel), "units", v.fuel / mx.fuel], ["CAPACITOR", fmtN(v.capgj), "GJ", v.capgj / mx.cap], ["HULL", "~" + fmtN(v.hull), "HP", v.hull / mx.hull]];
    return stats.map(([lab, val, unit, frac], i) => { const x = x0 + i * (boxW + 16), bar = Math.max(0.04, Math.min(1, frac)) * (boxW - 32);
      return `<g transform="translate(${x},${y0})"><path d="M${cut},0 H${boxW} V${96 - cut} L${boxW - cut},96 H0 V${cut} Z" fill="${th.panel_top}" stroke="${th.gold}" stroke-opacity="0.6"/><path d="M${cut},0 H${boxW}" stroke="${th.accent}" stroke-width="4"/><text x="16" y="30" class="stl">${lab}</text><text x="16" y="66" class="stv">${val}</text><text x="${boxW - 14}" y="30" class="stu" text-anchor="end">${unit}</text><rect x="16" y="78" width="${boxW - 32}" height="4" fill="#fff" opacity="0.08"/><rect x="16" y="78" width="${bar.toFixed(0)}" height="4" fill="${th.accent}"/>${lab === "HULL" ? `<text x="16" y="93" class="stu">repair ${v.rep} HP/s</text>` : ""}</g>`; }).join("");
  }

  // ---------- wrapped text as SVG <text> (a foreignObject would taint the export canvas in Chromium) ----------
  const meas = document.createElement("canvas").getContext("2d");
  function width(txt, font) { meas.font = font; return meas.measureText(txt).width; }
  function wrap(text, font, maxW) {
    const words = String(text || "").split(/\s+/).filter(Boolean), lines = []; let line = "";
    words.forEach(w => { const t = line ? line + " " + w : w; if (line && width(t, font) > maxW) { lines.push(line); line = w; } else line = t; });
    if (line) lines.push(line); return lines;
  }
  // text-wrap: balance — the narrowest width that still gives the same number of lines
  function balance(text, font, maxW) {
    const n = wrap(text, font, maxW).length; if (n < 2) return wrap(text, font, maxW);
    let lo = maxW / 2, hi = maxW;
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (wrap(text, font, mid).length > n) lo = mid; else hi = mid; }
    return wrap(text, font, hi);
  }
  function lines(arr, x, y, lh, cls, anchor) { return arr.map((l, i) => `<text x="${x}" y="${(y + i * lh).toFixed(1)}" class="${cls}"${anchor ? ` text-anchor="${anchor}"` : ""}>${esc(l)}</text>`).join(""); }

  // ---------- the card ----------
  // opts: { hull: "Reiver"|"LAI", hullData, placements, exterior, text: {title, origin, role, motto, latin, weapon, purpose, how, why},
  //         sigil: "III" | "✠", eyebrow: "SAINTS DOCTRINE · SHIP FITS", fonts: optional @font-face css to embed }
  function build(o) {
    const ch = K.themes[o.hull], th = ch.theme, lai = ch.lai, t = o.text, A = th.accent, G = th.gold, C = th.crimson;
    const text_w = ch.text_w, v = numbersOf(countsOf(o.placements));
    const rw = text_w - 120;
    const ribbon = t.latin ? `<g transform="translate(${96 + (text_w - rw) / 2},464)"><path d="M0,0 H${rw} L${rw - 12},12 L${rw},24 H0 L12,12 Z" fill="${C}" opacity="0.6"/><text x="${rw / 2}" y="17" text-anchor="middle" class="cin" style="font-weight:700;font-size:13px;fill:${G};letter-spacing:6px">✠ ${esc(t.latin)} ✠</text></g>` : "";
    const sigil = `<text x="${ch.sx}" y="${ch.sy + 24}" class="cin" text-anchor="middle" style="font-weight:900;font-size:${o.sigil && o.sigil.length > 3 ? 40 : 58}px;fill:${lai ? A : C}" filter="url(#glowf)">${esc(o.sigil || "✠")}</text>`;
    const [legSvg, legEnd] = legend(o.placements, t.weapon, o.exterior, ch.leg_x, 226, ch);
    const sealTop = legEnd - 29 + 36, sealBottom = H - 44, scale = Math.min(1, (sealBottom - sealTop) / 202), cx = ch.leg_x + ch.leg_w / 2;
    const sealXs = lai ? [cx - 62 * scale, cx + 62 * scale] : [cx];
    const seals = scale > 0.3 ? sealXs.map(sx => `<g transform="translate(${sx.toFixed(1)},${(sealTop + 34 * scale).toFixed(1)}) scale(${scale.toFixed(3)})">${ch.seal}</g>`).join("") : "";
    const title = String(t.title || "").toUpperCase();
    const fs = Math.min(74, Math.floor(text_w / (0.72 * Math.max(4, title.length))));        // long proposal names shrink to fit the column
    const pf = `400 ${lai ? 18 : 20}px 'Segoe UI',Arial`, lh = (lai ? 18 : 20) * 1.4;
    const origin = lines(balance(t.origin, "italic " + pf, text_w), 96 + text_w / 2, 292 + lh * 0.72, lh, "p origin", "middle");
    let para = "", cy = 506;
    [["PURPOSE", t.purpose], ["HOW IT WORKS", t.how], ["WHY THIS FIT", t.why]].filter(([, x]) => x).forEach(([hd, tx]) => {
      para += `<text x="96" y="${cy + 15}" class="h">${hd}</text>`; cy += 26;
      const ls = wrap(tx, pf, text_w); para += lines(ls, 96, cy + lh * 0.72, lh, "p"); cy += ls.length * lh + 18; });
    const crest = ch.crest.replace("__LOGO__", K.logo);
    const extraCss = `svg.card text.p{fill:${th.text}} svg.card text.p.origin{fill:${th.silver};font-style:italic}`;
    return `<svg class="card" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><style>${o.fonts || ""}${ch.css}${extraCss}</style><defs>${ch.defs}</defs>${ch.bg}${ch.band}${ch.frame}${ch.tier}${crest}${ch.header.replace("__EYEBROW__", esc(o.eyebrow || "SAINTS DOCTRINE · SHIP FITS"))}${ch.sigil_base}${sigil}${ribbon}${ch.title_line}` +
      `<text x="${96 + text_w / 2}" y="276" text-anchor="middle" class="cin" style="font-family:'Cinzel Decorative',Cinzel,Georgia,serif;font-weight:900;font-size:${fs}px;fill:url(#goldtitle);letter-spacing:${lai ? 2 : 1}px" filter="url(#titleglow)">${esc(title)}</text>` +
      origin +
      `<text x="${96 + text_w / 2}" y="404" text-anchor="middle" style="font:700 24px ${th.font_role};fill:${A};letter-spacing:5px">${esc(String(t.role || "").toUpperCase())}</text>` +
      (t.motto ? `<text x="${96 + text_w / 2}" y="444" text-anchor="middle" class="cin" style="font-weight:600;font-style:italic;font-size:23px;fill:${G}">“${esc(t.motto)}”</text>` : "") +
      para +
      statBoxes(v, ch, 96, 880, Math.floor((text_w - 48) / 4)) + ch.arch + ch.hull_label +
      `<g transform="translate(${ch.gx},${ch.gy})">${gridSvg(o.hullData, o.placements, ch)}</g>` + ch.modules_head + legSvg + seals + ch.footer + `</svg>`;
  }
  function countsOf(pl) { const c = {}; pl.forEach(p => c[p[0]] = (c[p[0]] || 0) + 1); return c; }

  // ---------- PNG export: the SVG drawn through an <img> onto a canvas at 1.5x (2880 x 1800, like the doctrine cards) ----------
  // Web fonts never load inside an SVG image, so the faces come embedded as data: URIs (fonts.js, FORGE_FONTS) when present;
  // without them the export falls back to Georgia / Arial.
  function fontCss() {
    const F = window.FORGE_FONTS; if (!F) return "";
    return F.map(f => `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:${f.style || "normal"};src:url(${f.data}) format('woff2')}`).join("");
  }
  function toPng(svg, scale) {
    scale = scale || 1.5;
    return new Promise((resolve, reject) => {
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob); const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement("canvas"); cv.width = W * scale; cv.height = H * scale;
          const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0, cv.width, cv.height);
          URL.revokeObjectURL(url);
          cv.toBlob(b => b ? resolve(b) : reject(new Error("canvas export failed")), "image/png");
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("the card image could not be drawn")); };
      img.src = url;
    });
  }
  window.ForgeCard = { build, texts, numbersOf, fontCss, toPng, typeOrder };
})();
