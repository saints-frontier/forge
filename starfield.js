/* The Pilgrim Roads, 3D: every star of the archived map (stars.bin, Cycle 6 coordinates in light-years, still valid
   for Cycle 7 space) as one WebGL point cloud, with the tribe's systems ringed and its roads drawn as arcs fixed in
   space. No library: ~300 lines of WebGL 1 plus a 2D overlay canvas for rings, labels and arrowheads.
   Rules borrowed from the EF-Map study (reports/ef-map-study-2026-10-10.md): nothing animates on its own, arcs keep
   their bow whatever the camera does, a pair of roads bows to opposite sides, colour sits in the arrowheads and rings,
   the stars themselves stay quiet. Draws only when something changed (camera, scene, size): idle costs nothing.

   const sf = Starfield(container, { onPick(systemId|null), onHover(systemId|null) });
   await sf.load("stars.bin");
   sf.setScene({ systems: [{ id, name, cls: "home"|"ours"|"inferred"|"far"|"plan"|"charted"|"uncharted", sub: "fuel 17 d" }],   // charted = a system named on the community map, not on our roads: a small ring, labelled up close
                 roads: [{ a: id, b: id, kind, twoWay, online, status: "built"|"planned"|"progress", source }] });
   sf.fit(); sf.select(id); sf.destroy(); */
(function () {
  "use strict";
  const LY_FOV = 50 * Math.PI / 180;
  const COLORS = { home: "#e3222c", ours: "#d9b24c", inferred: "#b8b3a8", far: "#8a8378", plan: "#9a9389", charted: "#8d98a3", uncharted: "#737d86", road: "#d9b24c", planned: "#b8b3a8", off: "#e3222c", gate: "#f1e9d2", hand: "#b8b3a8", pub: "#7d8894" };

  function Starfield(container, opts) {
    opts = opts || {};
    const gl3 = document.createElement("canvas"), ov = document.createElement("canvas");
    gl3.className = "sf-gl"; ov.className = "sf-ov";
    container.appendChild(gl3); container.appendChild(ov);
    const gl = gl3.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) { container.innerHTML = '<div class="sf-nogl">Your browser has no WebGL: the flat map still works.</div>'; return null; }
    const ctx = ov.getContext("2d");
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "Consolas, monospace";
    const display = getComputedStyle(document.documentElement).getPropertyValue("--display").trim() || "Georgia, serif";

    // ---------- shaders ----------
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const program = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };
    const starProg = program(`
      attribute vec3 aPos; attribute vec2 aGlowHue;
      uniform mat4 uVP; uniform float uDpr; uniform float uFade; uniform float uScale; uniform float uDim;
      varying float vAlpha; varying vec3 vCol;
      void main() {
        vec4 cp = uVP * vec4(aPos, 1.0); gl_Position = cp;
        float depth = max(cp.w, 1.0);
        float g = aGlowHue.x, t = aGlowHue.y;
        gl_PointSize = (1.6 + 3.6 * g) * uDpr * uScale * clamp(220.0 / sqrt(depth), 0.55, 1.6);
        vAlpha = (0.22 + 0.7 * g) * clamp(uFade / depth, 0.25, 1.0) * uDim;
        vec3 cool = vec3(1.0, 0.42, 0.30), mid = vec3(1.0, 0.80, 0.48), hot = vec3(0.86, 0.90, 1.0);
        vCol = t < 0.5 ? mix(cool, mid, t * 2.0) : mix(mid, hot, (t - 0.5) * 2.0);
      }`, `
      precision mediump float; varying float vAlpha; varying vec3 vCol;
      void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.12, d) * vAlpha; gl_FragColor = vec4(vCol * a, a); }`);
    const markProg = program(`
      attribute vec3 aPos; attribute vec4 aCol; attribute float aSize; uniform mat4 uVP; uniform float uDpr; uniform float uK; varying vec4 vCol;
      void main() { gl_Position = uVP * vec4(aPos, 1.0); gl_PointSize = max(1.5, aSize * uDpr * uK); vCol = aCol; }`, `
      precision mediump float; varying vec4 vCol;
      void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.1, d) * vCol.a; gl_FragColor = vec4(vCol.rgb * a, a); }`);
    // the public stargate network (gates.bin, from the client's location cache): one colour for every line, faint at
    // galaxy scale (the alpha is a uniform)
    const gateProg = program(`
      attribute vec3 aPos; uniform mat4 uVP; void main() { gl_Position = uVP * vec4(aPos, 1.0); }`, `
      precision mediump float; uniform vec4 uCol; void main() { gl_FragColor = vec4(uCol.rgb * uCol.a, uCol.a); }`);
    const loc = (p, n) => gl.getAttribLocation(p, n), uloc = (p, n) => gl.getUniformLocation(p, n);
    const starBuf = gl.createBuffer(), glowBuf = gl.createBuffer(), markBuf = gl.createBuffer(), gateBuf = gl.createBuffer();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);

    // ---------- state ----------
    let n = 0, pos = null, byId = new Map(), ids = null, names = null, galaxy = { c: [0, 0, 0], r: 9000 };
    const readNames = (dv, o) => { if (o + 4 > dv.byteLength) return null; const cnt = dv.getUint32(o, true); o += 4; const dec = new TextDecoder(), out = new Array(cnt); for (let i = 0; i < cnt; i++) { const l = dv.getUint8(o); out[i] = dec.decode(new Uint8Array(dv.buffer, o + 1, l)); o += 1 + l; } return out; };
    let scene = { systems: [], roads: [] }, marks = [], markCount = 0, polylines = [];
    let selected = null, hovered = null, marked = null;
    let many = [], sphereOf = null;             // Check a jump: rings for every legal / blocked target, the sphere of the tested jump
    let starDim = 1;                            // Chart the uncharted: the background stars dimmed so only the targets stand out
    let gateVerts = 0, gatePairs = 0, gateAdj = new Map(), gatesOn = true;      // the public stargate network: id -> [neighbour ids]
    const cam = { target: [0, 0, 0], dist: 9000, yaw: 0.6, pitch: 0.35 };
    let w = 1, h = 1, dpr = 1, dirty = true, raf = 0;
    const VP = new Float32Array(16);

    // ---------- data ----------
    async function load(url) {
      const buf = await fetch(url).then(r => { if (!r.ok) throw new Error("stars " + r.status); return r.arrayBuffer(); });
      const dv = new DataView(buf); if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "SFLD") throw new Error("not a star file");
      n = dv.getUint32(4, true); pos = new Float32Array(n * 3); ids = new Uint32Array(n); const gh = new Float32Array(n * 2);
      for (let i = 0, o = 8; i < n; i++, o += 20) {
        ids[i] = dv.getUint32(o, true); pos[i * 3] = dv.getFloat32(o + 4, true); pos[i * 3 + 1] = dv.getFloat32(o + 8, true); pos[i * 3 + 2] = -dv.getFloat32(o + 12, true);   // z NEGATED: the game draws these coordinates left-handed, WebGL is right-handed; without this the map is a mirror image (checked on two in-game Map screenshots, 2026-10-13)
        gh[i * 2] = dv.getUint8(o + 16) / 255; gh[i * 2 + 1] = dv.getUint8(o + 17) / 255; byId.set(ids[i], i);
      }
      names = readNames(dv, 8 + n * 20, n);
      { const c = [0, 0, 0]; for (let i = 0; i < n; i++) { c[0] += pos[i * 3]; c[1] += pos[i * 3 + 1]; c[2] += pos[i * 3 + 2]; } c[0] /= n; c[1] /= n; c[2] /= n;
        let r = 0; for (let i = 0; i < n; i++) r = Math.max(r, Math.hypot(pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2])); galaxy = { c, r }; }
      gl.bindBuffer(gl.ARRAY_BUFFER, starBuf); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, glowBuf); gl.bufferData(gl.ARRAY_BUFFER, gh, gl.STATIC_DRAW);
      dirty = true; schedule(); return n;
    }
    // gates.bin (tools/export_gates.py, from the client's location cache): "GATE", u32 build, u32 count, then u32 a,
    // u32 b, u8 kind per stargate pair. One GL line list, plus every system's neighbour list for the detail panel.
    async function loadGates(url) {
      const buf = await fetch(url).then(r => { if (!r.ok) throw new Error("gates " + r.status); return r.arrayBuffer(); });
      const dv = new DataView(buf); if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "GATE") throw new Error("not a gate file");
      const cnt = dv.getUint32(8, true), v = new Float32Array(cnt * 6); let k = 0; gateAdj = new Map(); gatePairs = 0;
      const push = (id, o) => { let a = gateAdj.get(id); if (!a) gateAdj.set(id, a = []); a.push(o); };
      for (let i = 0, o = 12; i < cnt; i++, o += 9) {
        const a = dv.getUint32(o, true), b = dv.getUint32(o + 4, true), ia = byId.get(a), ib = byId.get(b); if (ia == null || ib == null) continue;
        v[k++] = pos[ia * 3]; v[k++] = pos[ia * 3 + 1]; v[k++] = pos[ia * 3 + 2]; v[k++] = pos[ib * 3]; v[k++] = pos[ib * 3 + 1]; v[k++] = pos[ib * 3 + 2];
        push(a, b); push(b, a); gatePairs++;
      }
      gateVerts = k / 3;
      gl.bindBuffer(gl.ARRAY_BUFFER, gateBuf); gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, k), gl.STATIC_DRAW);
      dirty = true; schedule(); return gatePairs;
    }
    const P = id => { const i = byId.get(id); return i == null ? null : [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]; };
    const rgba = (hex, a) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, a];

    // ---------- the scene: rings, arcs ----------
    function setScene(s) {
      scene = { systems: (s.systems || []).filter(x => byId.has(x.id)), roads: (s.roads || []).filter(r => byId.has(r.a) && byId.has(r.b)) };
      const L = [], M = [], polys = [];
      const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], len = a => Math.hypot(a[0], a[1], a[2]), norm = a => { const l = len(a) || 1; return mul(a, 1 / l); };
      const pairSeen = new Map();
      for (const r of scene.roads) {
        const A = P(r.a), B = P(r.b), d = sub(B, A), dist = len(d);
        const key = [r.a, r.b].sort().join("|"), nth = pairSeen.get(key) || 0; pairSeen.set(key, nth + 1);
        const catapult = /Catapult/.test(r.kind || "");
        // the bow lies in the plane of the road and the galaxy's up: fixed in space, never facing the camera;
        // the second road of a pair bows the other way
        // (the side is taken from the pair's canonical direction, so the return road, whose d points the other way,
        // does not land on the same side by accident)
        let side = norm(cross(r.a < r.b ? d : mul(d, -1), [0, 1, 0])); if (len(side) < 1e-6) side = [1, 0, 0];
        const bow = catapult ? mul(side, (nth % 2 ? -1 : 1) * Math.max(4, dist * 0.18)) : [0, 0, 0];
        const C = add(mul(add(A, B), 0.5), bow);
        const segs = catapult ? 28 : 1, pts = [];
        for (let i = 0; i <= segs; i++) { const t = i / segs, u = 1 - t; pts.push(add(add(mul(A, u * u), mul(C, 2 * u * t)), mul(B, t * t))); }
        const col = r.online === false ? COLORS.off : r.kind === "Public Gate" ? COLORS.pub : r.status === "planned" ? COLORS.planned : r.source === "inferred" ? COLORS.hand : /Gate/.test(r.kind || "") ? COLORS.gate : COLORS.road;   // a public gate someone has jumped: grey, straight, both ways
        polys.push({ road: r, pts, col, heavy: /Heavy/.test(r.kind || ""), dash: r.status === "planned" ? [2, 5] : r.status === "progress" || r.online === false || r.source === "inferred" ? [7, 6] : [], alpha: r.status === "planned" ? 0.6 : 0.95 });
      }
      for (const s of scene.systems) { const p = P(s.id), col = s.color || COLORS[s.cls] || COLORS.far, minor = s.cls === "charted" || s.cls === "uncharted" || s.cls === "poi", size = s.cls === "home" ? 9 : s.cls === "ours" ? 7 : s.cls === "uncharted" ? 2 : minor ? 2.6 : 5; M.push(...p, ...rgba(col, minor ? 0.07 : 0.16), size * 4.5); M.push(...p, ...rgba(col, minor ? 0.75 : 0.95), size); }
      marks = new Float32Array(M); markCount = M.length / 8; polylines = polys;
      gl.bindBuffer(gl.ARRAY_BUFFER, markBuf); gl.bufferData(gl.ARRAY_BUFFER, marks, gl.STATIC_DRAW);
      dirty = true; schedule();
    }
    function fitTo(idList) {
      const ps = idList.map(P).filter(Boolean); if (!ps.length) return;
      const c = [0, 1, 2].map(k => ps.reduce((a, p) => a + p[k], 0) / ps.length), r = Math.max(8, ...ps.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
      cam.target = c; cam.dist = Math.max(40, r / Math.tan(LY_FOV / 2) * 1.35 + 20); dirty = true; schedule();
    }
    function fit() {
      // the network = the home, every system with a node of ours and both ends of every road that is not a plan;
      // far pins (a landmark, a plan's waypoints) do not drag the first view out to the whole galaxy
      const net = new Set(scene.systems.filter(s => s.cls === "home" || s.cls === "ours" || s.cls === "inferred").map(s => s.id));
      for (const r of scene.roads) if (r.status !== "planned") { net.add(r.a); net.add(r.b); }
      const ids = net.size ? [...net] : scene.systems.map(s => s.id);
      if (!ids.length) { fitAll(); return; }
      fitTo(ids); cam.pitch = 0.35;
    }
    function fitAll() { cam.target = galaxy.c.slice(); cam.dist = galaxy.r / Math.tan(LY_FOV / 2) * 0.62; cam.pitch = 0.3; dirty = true; schedule(); }

    // ---------- camera and projection ----------
    function mat() {
      const eye = [cam.target[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), cam.target[1] + cam.dist * Math.sin(cam.pitch), cam.target[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw)];
      const f = norm3(sub3(cam.target, eye)), s = norm3(cross3(f, [0, 1, 0])), u = cross3(s, f);
      const V = [s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot3(s, eye), -dot3(u, eye), dot3(f, eye), 1];
      const near = Math.max(0.5, cam.dist * 0.01), far = cam.dist * 6 + 30000, t = 1 / Math.tan(LY_FOV / 2), asp = w / h;
      const Pm = [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let v = 0; for (let k = 0; k < 4; k++) v += Pm[k * 4 + j] * V[i * 4 + k]; VP[i * 4 + j] = v; }
    }
    const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], norm3 = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    function project(p) {                           // -> [x, y] in CSS pixels, or null when behind the camera
      const x = VP[0] * p[0] + VP[4] * p[1] + VP[8] * p[2] + VP[12], y = VP[1] * p[0] + VP[5] * p[1] + VP[9] * p[2] + VP[13], cw = VP[3] * p[0] + VP[7] * p[1] + VP[11] * p[2] + VP[15];
      if (cw <= 0.01) return null; return [(x / cw * 0.5 + 0.5) * w, (0.5 - y / cw * 0.5) * h, cw];
    }

    // ---------- drawing ----------
    function render() {
      raf = 0; if (!dirty) return; dirty = false;
      mat();
      gl.viewport(0, 0, gl3.width, gl3.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (n) {
        gl.useProgram(starProg); gl.uniformMatrix4fv(uloc(starProg, "uVP"), false, VP); gl.uniform1f(uloc(starProg, "uDpr"), dpr); gl.uniform1f(uloc(starProg, "uFade"), cam.dist * 1.4); const dim = Math.max(0.32, Math.min(1, 2500 / cam.dist)); gl.uniform1f(uloc(starProg, "uScale"), 0.75 + 0.25 * dim); gl.uniform1f(uloc(starProg, "uDim"), dim * starDim);
        gl.bindBuffer(gl.ARRAY_BUFFER, starBuf); const ap = loc(starProg, "aPos"); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, glowBuf); const ag = loc(starProg, "aGlowHue"); gl.enableVertexAttribArray(ag); gl.vertexAttribPointer(ag, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, n);
      }
      if (gatesOn && gateVerts) {
        // 4,800 lines: faint from far away, clear as the camera closes in
        const a = Math.max(0.12, Math.min(0.55, 140 / cam.dist)), c = rgba(COLORS.pub, a);
        gl.useProgram(gateProg); gl.uniformMatrix4fv(uloc(gateProg, "uVP"), false, VP); gl.uniform4f(uloc(gateProg, "uCol"), c[0], c[1], c[2], c[3]);
        gl.bindBuffer(gl.ARRAY_BUFFER, gateBuf); const ap = loc(gateProg, "aPos"); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, gateVerts);
      }
      if (markCount) {
        gl.useProgram(markProg); gl.uniformMatrix4fv(uloc(markProg, "uVP"), false, VP); gl.uniform1f(uloc(markProg, "uDpr"), dpr); gl.uniform1f(uloc(markProg, "uK"), zoomK());
        gl.bindBuffer(gl.ARRAY_BUFFER, markBuf); const ap = loc(markProg, "aPos"), ac = loc(markProg, "aCol"), as = loc(markProg, "aSize");
        gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 32, 0); gl.enableVertexAttribArray(ac); gl.vertexAttribPointer(ac, 4, gl.FLOAT, false, 32, 12); gl.enableVertexAttribArray(as); gl.vertexAttribPointer(as, 1, gl.FLOAT, false, 32, 28);
        gl.drawArrays(gl.POINTS, 0, markCount);
      }
      overlay();
    }
    function overlay() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      // the public gates of the system under the pointer, the selected one and a picked star: bright over the faint network
      if (gatesOn && gateAdj.size) {
        const hot = new Set([selected, hovered, marked && marked.id].filter(x => x != null));
        for (const id of hot) { const pa = P(id); if (!pa) continue; const a = project(pa); if (!a) continue;
          for (const o of gateAdj.get(id) || []) { const b = project(P(o)); if (!b) continue;
            ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.strokeStyle = "#aab3bc"; ctx.lineWidth = 1.4; ctx.globalAlpha = 0.85; ctx.stroke(); ctx.globalAlpha = 1;
            ctx.beginPath(); ctx.arc(b[0], b[1], 3, 0, Math.PI * 2); ctx.fillStyle = "#aab3bc"; ctx.fill(); } }
      }
      // the roads: arcs and lines projected point by point, then the arrowheads (both ends of a two-way road)
      for (const pl of polylines) {
        const q = pl.pts.map(project); if (q.some(x => !x)) continue;
        ctx.beginPath(); q.forEach((x, i) => i ? ctx.lineTo(x[0], x[1]) : ctx.moveTo(x[0], x[1]));
        ctx.setLineDash(pl.dash); ctx.globalAlpha = pl.alpha; ctx.strokeStyle = pl.col; ctx.lineWidth = pl.heavy ? 3 : 1.6;
        ctx.shadowColor = pl.col; ctx.shadowBlur = pl.dash.length ? 0 : 6; ctx.stroke(); ctx.shadowBlur = 0; ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
      for (const pl of polylines) {
        const r = pl.road, last = pl.pts.length - 1;
        const head = (i0, i1, col) => { const a = project(pl.pts[i0]), b = project(pl.pts[i1]); if (!a || !b) return; const ang = Math.atan2(b[1] - a[1], b[0] - a[0]); const s = pl.heavy ? 11 : 8;
          ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(b[0] - s * Math.cos(ang - 0.42), b[1] - s * Math.sin(ang - 0.42)); ctx.lineTo(b[0] - s * Math.cos(ang + 0.42), b[1] - s * Math.sin(ang + 0.42)); ctx.closePath(); ctx.fillStyle = col; ctx.fill(); };
        const col = r.online === false ? COLORS.off : pl.col;
        head(last - 1, last, col); if (r.twoWay) head(1, 0, col);
      }
      // Check a jump: the interference sphere of the tested jump (a circle of the sphere's radius at its centre) and
      // the legal (green) and blocked (red) targets, plus the aimed-at system in gold
      if (sphereOf) { const A = P(sphereOf.a), B = P(sphereOf.b); if (A && B) { const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2], r = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) / 2, c = project(mid);
        if (c) { let px = 0; for (const k of [[r, 0, 0], [0, r, 0], [0, 0, r]]) { const q = project([mid[0] + k[0], mid[1] + k[1], mid[2] + k[2]]); if (q) px = Math.max(px, Math.hypot(q[0] - c[0], q[1] - c[1])); }
          ctx.beginPath(); ctx.arc(c[0], c[1], px, 0, Math.PI * 2); ctx.strokeStyle = "#f1e9d2"; ctx.lineWidth = 1; ctx.setLineDash([4, 5]); ctx.globalAlpha = 0.55; ctx.stroke(); ctx.globalAlpha = 0.08; ctx.fillStyle = "#f1e9d2"; ctx.fill(); ctx.globalAlpha = 1; ctx.setLineDash([]);
          const a = project(A), b = project(B); if (a && b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.strokeStyle = "#d9b24c"; ctx.lineWidth = 1.2; ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]); } } } }
      for (const m of many) { const p = project(P(m.id)); if (!p) continue; const col = m.cls === "ok" ? "#7ec98b" : m.cls === "bad" ? "#e3222c" : m.cls === "unc" ? "#8fb8e8" : "#d9b24c", R = m.cls === "aim" ? 9 : m.cls === "tour" ? 7 : m.cls === "unc" ? 4 : 5;
        ctx.beginPath(); ctx.arc(p[0], p[1], R, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.lineWidth = m.cls === "aim" || m.cls === "tour" ? 2 : 1.4; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1;
        if (m.label) { ctx.font = `600 12px ${display}`; ctx.fillStyle = "rgba(7,7,10,.8)"; ctx.fillText(m.label, p[0] + R + 7, p[1] + 1); ctx.fillStyle = col; ctx.fillText(m.label, p[0] + R + 6, p[1]); } }
      // rings and labels. In priority order (selected, home, ours, the rest, plan waypoints): far from the camera a
      // system close to one already drawn (34 px at galaxy scale, 10 px mid-way, never up close) folds into it (the leader's label gains "+N"); a label whose box would
      // cover another label is left out, its ring stays. Nothing is ever stacked.
      ctx.textBaseline = "middle";
      const k = zoomK(), far = k < 0.75, foldR = k < 0.45 ? 34 : k < 0.75 ? 10 : 0, labelPlans = cam.dist < 900;
      const rank = s => s.id === selected || s.id === hovered ? 0 : s.cls === "home" ? 1 : s.cls === "ours" ? 2 : s.cls === "inferred" ? 3 : s.cls === "plan" ? 5 : s.cls === "charted" ? 6 : s.cls === "poi" ? 6 : s.cls === "uncharted" ? 7 : 4;
      const order = scene.systems.map(s => ({ s, p: project(P(s.id)) })).filter(o => o.p).sort((a, b) => rank(a.s) - rank(b.s));
      const leaders = [], folded = [];
      for (const o of order) {
        if (foldR && rank(o.s) > 0) { const L = leaders.find(l => Math.hypot(l.p[0] - o.p[0], l.p[1] - o.p[1]) < foldR); if (L) { if (o.s.cls !== "charted" && o.s.cls !== "uncharted" && o.s.cls !== "poi") L.more++; folded.push(o); continue; } }   // a charted system folds silently: "+N" counts our own only
        o.more = 0; leaders.push(o);
      }
      // a folded system keeps a small mark, so a road never ends in empty space
      for (const o of folded) { if (o.s.cls === "plan" || o.s.cls === "charted" || o.s.cls === "uncharted" || o.s.cls === "poi") continue; ctx.beginPath(); ctx.arc(o.p[0], o.p[1], 2.5, 0, Math.PI * 2); ctx.strokeStyle = COLORS[o.s.cls] || COLORS.far; ctx.lineWidth = 1; ctx.stroke(); }
      const boxes = [], hit = (b) => boxes.some(q => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]);
      for (const o of leaders) {
        const s = o.s, p = o.p, col = s.color || COLORS[s.cls] || COLORS.far, unch = s.cls === "uncharted", poi = s.cls === "poi", charted = s.cls === "charted" || unch || poi, plan = s.cls === "plan" || charted, hot = s.id === selected || s.id === hovered;
        const R = Math.max(2.5, (s.cls === "home" ? 11 : s.cls === "ours" ? 9 : plan ? (unch ? 3 : 4) : 7) * (plan ? Math.max(k, 0.7) : k));
        ctx.beginPath(); if (poi) { const D = R + 1.5; ctx.moveTo(p[0], p[1] - D); ctx.lineTo(p[0] + D, p[1]); ctx.lineTo(p[0], p[1] + D); ctx.lineTo(p[0] - D, p[1]); ctx.closePath(); } else ctx.arc(p[0], p[1], R, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.lineWidth = s.id === selected ? 2.5 : poi ? 1.6 : 1.3; ctx.setLineDash(s.cls === "inferred" || unch ? [3, 3] : []); ctx.globalAlpha = charted && !hot ? 0.7 : 1; ctx.stroke(); ctx.globalAlpha = 1; ctx.setLineDash([]);
        if (hot) { ctx.beginPath(); ctx.arc(p[0], p[1], R + 5, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.globalAlpha = 0.45; ctx.stroke(); ctx.globalAlpha = 1; }
        if ((plan && !labelPlans && !hot) || (unch && !hot)) continue;   // an uncharted mark is named only under the pointer
        const label = (s.cls === "home" ? "✠ " : "") + (s.name || String(s.id)) + (o.more ? `  +${o.more}` : "");
        ctx.font = charted ? `600 12px ${display}` : `700 13px ${display}`;
        const x = p[0] + R + 6, y = p[1] - (s.sub && !far ? 4 : 0), wdt = ctx.measureText(label).width, showSub = !!s.sub && !far;
        const box = [x - 3, y - 9, x + wdt + 3, y + (showSub ? 22 : 9)];
        if (!hot && hit(box)) continue;
        boxes.push(box);
        if (k < 0.45) { ctx.fillStyle = "rgba(7,7,10,.82)"; ctx.fillRect(box[0] - 2, box[1] - 1, box[2] - box[0] + 4, box[3] - box[1] + 2); ctx.strokeStyle = "rgba(217,178,76,.45)"; ctx.lineWidth = 1; ctx.strokeRect(box[0] - 1.5, box[1] - 0.5, box[2] - box[0] + 3, box[3] - box[1] + 1); }
        ctx.fillStyle = "rgba(7,7,10,.75)"; ctx.fillText(label, x + 1, y + 1); ctx.fillStyle = s.cls === "home" ? "#ffd27a" : poi ? col : charted ? "#aab3bc" : "#f1e9d2"; ctx.fillText(label, x, y);
        if (showSub) { ctx.font = `600 11px ${mono}`; ctx.fillStyle = s.subColor || "#b8b3a8"; ctx.fillText(s.sub, x, y + 14); }
      }
      // a star picked from the background (no ring of its own): a dashed ring and its label
      if (marked) { const p = project(P(marked.id)); if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, Math.PI * 2); ctx.strokeStyle = "#f1e9d2"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
        ctx.font = `600 12px ${display}`; ctx.fillStyle = "rgba(7,7,10,.8)"; ctx.fillText(marked.label, p[0] + 14, p[1] + 1); ctx.fillStyle = "#f1e9d2"; ctx.fillText(marked.label, p[0] + 13, p[1]); } }
    }
    // 1 when the camera is within ~350 LY of its target (rings at full size), falling to 0.3 at galaxy scale
    function zoomK() { return Math.max(0.3, Math.min(1, 350 / cam.dist)); }
    function schedule() { if (!raf) raf = requestAnimationFrame(render); }

    // ---------- size ----------
    function resize() {
      const r = container.getBoundingClientRect(); w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height)); dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const c of [gl3, ov]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + "px"; c.style.height = h + "px"; }
      dirty = true; schedule();
    }
    const ro = new ResizeObserver(resize); ro.observe(container); resize();

    // ---------- input: drag orbits, shift/right drag pans, wheel zooms, click picks ----------
    let drag = null;
    const pickAt = (x, y) => { let best = null, bd = 14; for (const s of scene.systems) { const p = project(P(s.id)); if (!p) continue; const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = s.id; } } return best; };
    // any star at all, for a click that hit no ring: the nearest one within 9 px
    const pickStar = (x, y) => { let best = null, bd = 9; for (let i = 0; i < n; i++) { const p = project([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]); if (!p) continue; const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = ids[i]; } } return best; };
    ov.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey, id: e.pointerId }; ov.setPointerCapture(e.pointerId); e.preventDefault(); });
    ov.addEventListener("pointermove", e => {
      if (!drag) { const id = pickAt(e.offsetX, e.offsetY); if (id !== hovered) { hovered = id; ov.classList.toggle("over", !!id); /* pointer over a system (cursor rules: roads.css; tools/make_cursors.py) */ dirty = true; schedule(); if (opts.onHover) opts.onHover(id); } return; }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; ov.classList.add("drag"); } /* the closed gauntlet while the map is dragged */ drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { mat(); const s = 2 * Math.tan(LY_FOV / 2) * cam.dist / h;   // light-years per pixel at the target: the map follows the pointer
        const right = norm3(cross3(norm3([Math.sin(cam.yaw), 0, Math.cos(cam.yaw)]), [0, 1, 0])), up = [0, 1, 0];
        cam.target = [cam.target[0] + right[0] * dx * s + up[0] * dy * s, cam.target[1] + right[1] * dx * s + up[1] * dy * s, cam.target[2] + right[2] * dx * s + up[2] * dy * s]; }   // + right: this vector points to screen-left (the drag was mirrored sideways, user 2026-10-12)
      else { cam.yaw -= dx * 0.006; cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch + dy * 0.006)); }
      dirty = true; schedule();
    });
    const endDrag = e => { if (!drag) return; const d = drag; drag = null; ov.classList.remove("drag"); if (!d.moved && e.type === "pointerup") { const id = pickAt(e.offsetX, e.offsetY); selected = id; dirty = true; schedule(); if (opts.onPick) opts.onPick(id); if (id == null && opts.onPickStar) opts.onPickStar(pickStar(e.offsetX, e.offsetY)); } };
    ov.addEventListener("pointerup", endDrag); ov.addEventListener("pointercancel", endDrag);
    ov.addEventListener("contextmenu", e => e.preventDefault());
    // The wheel zooms only with Ctrl (or Cmd) held, as in the Forge: a plain wheel scrolls the page (user 2026-10-12: the
    // map swallowed page scrolls and ended up at galaxy scale). A trackpad pinch arrives as ctrl + wheel with small steps.
    const zoomBy = f => { cam.dist = Math.max(15, Math.min(30000, cam.dist * f)); dirty = true; schedule(); };
    ov.addEventListener("wheel", e => { if (!(e.ctrlKey || e.metaKey)) { if (opts.onPlainWheel) opts.onPlainWheel(); return; } e.preventDefault(); zoomBy(Math.exp(Math.max(-1, Math.min(1, e.deltaY / 100)) * 0.14)); }, { passive: false });
    ov.addEventListener("dblclick", e => { const id = pickAt(e.offsetX, e.offsetY) || pickStar(e.offsetX, e.offsetY); /* any star, ringed or not (user 2026-10-18) */ if (id) { cam.target = P(id); cam.dist = Math.max(30, Math.min(cam.dist, 160)); dirty = true; schedule(); } });

    return {
      load, setScene, fit, fitTo, fitAll, project, has: id => byId.has(id), position: P, oldName: id => { const i = byId.get(id); return names && i != null ? names[i] : null; },
      select(id) { selected = id; dirty = true; schedule(); },
      mark(id, label) { marked = id != null && byId.has(id) ? { id, label: label || "" } : null; dirty = true; schedule(); },
      // the archived (Cycle 6) names, for the system boxes: names starting with q first, then names containing it
      searchOld(q, limit) { const out = [], inc = []; if (!names) return out; q = String(q).toLowerCase(); for (let i = 0; i < n && out.length < limit; i++) { const nm = names[i]; if (!nm) continue; const l = nm.toLowerCase(); if (l.startsWith(q)) out.push({ id: ids[i], name: nm }); else if (inc.length < limit && l.includes(q)) inc.push({ id: ids[i], name: nm }); } return out.concat(inc).slice(0, limit); },
      markMany(list) { many = (list || []).filter(m => m && byId.has(m.id)); dirty = true; schedule(); },
      dimStars(on) { starDim = on ? 0.1 : 1; dirty = true; schedule(); },
      /* every star within r light-years of a star: [[id, ly], ...], nearest first (Chart the uncharted) */
      near(id, r) { const i = byId.get(id); if (i == null || !pos) return []; const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], r2 = r * r, out = [];
        for (let k = 0; k < n; k++) { if (k === i) continue; const dx = pos[k * 3] - x, dy = pos[k * 3 + 1] - y, dz = pos[k * 3 + 2] - z, d2 = dx * dx + dy * dy + dz * dz; if (d2 <= r2) out.push([ids[k], Math.sqrt(d2)]); }
        return out.sort((a, b) => a[1] - b[1]); },
      sphere(s) { sphereOf = s && byId.has(s.a) && byId.has(s.b) ? { a: s.a, b: s.b } : null; dirty = true; schedule(); },
      look(id, dist) { const p = P(id); if (p) { cam.target = p; if (dist) cam.dist = dist; dirty = true; schedule(); } },
      view(pitchDeg) { cam.pitch = pitchDeg * Math.PI / 180; dirty = true; schedule(); },
      zoom(f) { zoomBy(f); },
      count: () => n,
      loadGates, gatesOf: id => (gateAdj.get(id) || []).slice(), gateCount: () => gatePairs,
      showGates(on) { gatesOn = !!on; dirty = true; schedule(); },
      destroy() { ro.disconnect(); if (raf) cancelAnimationFrame(raf); gl3.remove(); ov.remove(); }
    };
  }
  window.Starfield = Starfield;
})();
