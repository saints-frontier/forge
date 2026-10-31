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
  const COLORS = { me: "#5fe3ff", mate: "#8fe0b0", home: "#e3222c", ours: "#d9b24c", inferred: "#b8b3a8", far: "#8a8378", plan: "#9a9389", charted: "#9fd8ff", uncharted: "#ff7a5c", road: "#d9b24c", planned: "#b8b3a8", off: "#e3222c", gate: "#f1e9d2", hand: "#b8b3a8", pub: "#7d8894", cat: "#ff8a3d", longhaul: "#ff5fa2", pubOk: "#6fd08c", pubFuel: "#f0b74a", pubDead: "#e3222c" };
  /* the line grammar (2026-10-23, user: "those arching lines are confusing ... only straight lines ... the color coding
     should be better"): every road is a straight line; the colour says WHAT it is, the dash says how sure, the arrows
     say which way. Shown in the legend over the map. */
  const LEGEND = [
    ["gate", "solid", "Our gate pair (both ways)"], ["cat", "arrow", "Our catapult (one way)"],
    ["pub", "thin", "Public stargate, state unknown"], ["pubOk", "solid", "Public stargate, working"],
    ["pubFuel", "dash", "Public stargate, no fuel far side"], ["pubDead", "dash", "Public stargate, dormant"],
    ["planned", "dot", "Planned road"], ["off", "dash", "Ours, offline"],
    ["longhaul", "dash", "Long-haul stargate pair (POI layer, never jumped)"]];

  function Starfield(container, opts) {
    opts = opts || {};
    const gl3 = document.createElement("canvas"), ov = document.createElement("canvas");
    gl3.className = "sf-gl"; ov.className = "sf-ov";
    container.appendChild(gl3); container.appendChild(ov);
    const gl = gl3.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) { container.innerHTML = '<div class="sf-nogl">Your browser has no WebGL: the flat map still works.</div>'; return null; }
    const ctx = ov.getContext("2d");
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--num").trim() || getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "Consolas, monospace";
    const display = getComputedStyle(document.documentElement).getPropertyValue("--data").trim() || "'IBM Plex Sans', 'Segoe UI', Arial, sans-serif";   /* --data, not --body: the cathedral theme makes --body gothic (2026-10-25) */   /* system names in a plain sans: the gothic display font is hard to read on the map (user 2026-10-20) */

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
    const starBuf = gl.createBuffer(), glowBuf = gl.createBuffer(), markBuf = gl.createBuffer(), gateBuf = gl.createBuffer(), paintBuf = gl.createBuffer();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);

    // ---------- state ----------
    let n = 0, pos = null, byId = new Map(), ids = null, names = null, galaxy = { c: [0, 0, 0], r: 9000 };
    const readNames = (dv, o) => { if (o + 4 > dv.byteLength) return null; const cnt = dv.getUint32(o, true); o += 4; const dec = new TextDecoder(), out = new Array(cnt); for (let i = 0; i < cnt; i++) { const l = dv.getUint8(o); out[i] = dec.decode(new Uint8Array(dv.buffer, o + 1, l)); o += 1 + l; } return out; };
    let scene = { systems: [], roads: [] }, marks = [], markCount = 0, polylines = [];
    let selected = null, hovered = null, marked = null;
    let many = [], sphereOf = null;             // Check a jump: rings for every legal / blocked target, the sphere of the tested jump
    let starDim = 1;                            // Chart the uncharted: the background stars dimmed so only the targets stand out
    let roadFade = 1;                           /* the infestation hunt (2026-10-31): our roads fade so the hits stand out */
    let paintCount = 0;                         // the charted / uncharted filter (2026-10-26): one coloured point per star, over the dimmed cloud
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
      const pairSeen = new Map(), pairCount = new Map();
      for (const r of scene.roads) { const k = [r.a, r.b].sort().join("|"); pairCount.set(k, (pairCount.get(k) || 0) + 1); }
      for (const r of scene.roads) {
        const A = P(r.a), B = P(r.b), d = sub(B, A), dist = len(d);
        const key = [r.a, r.b].sort().join("|"), nth = pairSeen.get(key) || 0; pairSeen.set(key, nth + 1);
        const kind = r.kind || "", pub = kind === "Public Gate", cat = /Catapult/.test(kind), heavy = /Heavy/.test(kind);
        let col, dash = [], alpha = 0.95;
        if (r.status === "planned") { col = COLORS.planned; dash = [2, 5]; alpha = 0.7; }
        else if (kind === "Long-haul Gate") { col = COLORS.longhaul; dash = [10, 6]; alpha = 0.8; }   /* the client's 64M stargate pairs, shown with the POI layer */
        else if (pub) { const st = r.state || (r.online === false ? "dormant" : r.status === "progress" ? "unfueled" : "");
          col = st === "dormant" ? COLORS.pubDead : st === "unfueled" ? COLORS.pubFuel : st === "working" ? COLORS.pubOk : COLORS.pub; if (st === "dormant" || st === "unfueled") dash = [6, 5]; }
        else if (r.online === false) { col = COLORS.off; dash = [7, 6]; }
        else { col = cat ? COLORS.cat : COLORS.gate; if (r.source === "inferred" || r.status === "progress" || r.source === "seen") dash = [7, 5]; }
        /* a pair of roads between the same two systems (there and back): each is moved 3 px to its own left on screen */
        polys.push({ road: r, pts: [A, B], col, dash, alpha, cat, pub, heavy, shift: pairCount.get(key) > 1 ? 3 : 0 });
      }
      for (const s of scene.systems) { const p = P(s.id), col = s.color || COLORS[s.cls] || COLORS.far, minor = s.cls === "charted" || s.cls === "uncharted" || s.cls === "poi", size = s.cls === "home" || s.cls === "me" ? 9 : s.cls === "ours" ? 7 : s.cls === "uncharted" ? 2.6 : minor ? 3 : 5; M.push(...p, ...rgba(col, minor ? 0.07 : 0.16), size * 4.5); M.push(...p, ...rgba(col, minor ? 0.75 : 0.95), size); }
      marks = new Float32Array(M); markCount = M.length / 8; polylines = polys;
      gl.bindBuffer(gl.ARRAY_BUFFER, markBuf); gl.bufferData(gl.ARRAY_BUFFER, marks, gl.STATIC_DRAW);
      dirty = true; schedule();
    }
    // ---------- smooth camera moves (2026-10-23): fitTo / look / double-click glide there in ~0.45 s ----------
    let fly = null;
    function flyTo(target, dist) { fly = { t0: performance.now(), from: cam.target.slice(), fromD: cam.dist, to: target.slice(), toD: dist == null ? cam.dist : dist }; tick(); }
    function flyStep(now) { if (!fly) return false; const t = Math.min(1, (now - fly.t0) / 450), e = 1 - Math.pow(1 - t, 3);
      for (let i = 0; i < 3; i++) cam.target[i] = fly.from[i] + (fly.to[i] - fly.from[i]) * e;
      cam.dist = Math.exp(Math.log(fly.fromD) + (Math.log(fly.toD) - Math.log(fly.fromD)) * e); if (t >= 1) fly = null; return true; }
    // WASD moves the camera over the galaxy's plane (W = where the camera looks), Q down, E up; Shift = faster.
    // Keys count while the pointer is over the map or the map has the focus, and never while typing in a box.
    const keys = new Set(), vel = [0, 0, 0]; let over = false, lastT = 0, loopOn = false;
    const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable); };
    const MOVE = { KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1, KeyQ: 1, KeyE: 1 };
    function onKey(e) { if (!MOVE[e.code] || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.type === "keyup") { keys.delete(e.code); return; }
      if (typing() || !(over || document.activeElement === ov)) return;
      e.preventDefault(); keys.add(e.code); tick(); }
    window.addEventListener("keydown", onKey); window.addEventListener("keyup", onKey); window.addEventListener("blur", () => keys.clear());
    function tick() { if (loopOn) return; loopOn = true; lastT = performance.now(); requestAnimationFrame(loop); }
    function loop(now) {
      const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now; let moving = flyStep(now);
      const f = [-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw)], r = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
      const want = [0, 0, 0], sp = cam.dist * (keys.has("ShiftLeft") || keys.has("ShiftRight") || keys.shift ? 2.6 : 0.9);
      const ax = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0), az = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0), ay = (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0);
      for (let i = 0; i < 3; i++) want[i] = (r[i] * ax + f[i] * az) * sp; want[1] += ay * sp;
      const k = 1 - Math.exp(-dt * 9);
      for (let i = 0; i < 3; i++) { vel[i] += (want[i] - vel[i]) * k; cam.target[i] += vel[i] * dt; }
      const still = Math.hypot(vel[0], vel[1], vel[2]) < cam.dist * 0.002 && !keys.size;
      if (still) { vel[0] = vel[1] = vel[2] = 0; } else moving = true;
      if (moving) { dirty = true; render(); }
      if (moving || keys.size) requestAnimationFrame(loop); else loopOn = false;
    }
    window.addEventListener("keydown", e => { if (e.key === "Shift") keys.shift = true; }); window.addEventListener("keyup", e => { if (e.key === "Shift") keys.shift = false; });
    function fitTo(idList) {
      const ps = idList.map(P).filter(Boolean); if (!ps.length) return;
      const c = [0, 1, 2].map(k => ps.reduce((a, p) => a + p[k], 0) / ps.length), r = Math.max(8, ...ps.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
      flyTo(c, Math.max(40, r / Math.tan(LY_FOV / 2) * 1.35 + 20));
    }
    function fit() {
      // the network = the home, every system with a node of ours and both ends of every road that is not a plan;
      // far pins (a landmark, a plan's waypoints) do not drag the first view out to the whole galaxy
      const net = new Set(scene.systems.filter(s => s.cls === "home" || s.cls === "ours" || s.cls === "inferred").map(s => s.id));
      for (const r of scene.roads) if (r.status !== "planned" && r.kind !== "Long-haul Gate") { net.add(r.a); net.add(r.b); }
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
      mat(); if (comp) comp.firstChild.style.transform = `rotate(${cam.yaw}rad)`;
      gl.viewport(0, 0, gl3.width, gl3.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (n) {
        gl.useProgram(starProg); gl.uniformMatrix4fv(uloc(starProg, "uVP"), false, VP); gl.uniform1f(uloc(starProg, "uDpr"), dpr); gl.uniform1f(uloc(starProg, "uFade"), cam.dist * 1.4); const dim = Math.max(0.32, Math.min(1, 2500 / cam.dist)); gl.uniform1f(uloc(starProg, "uScale"), 0.75 + 0.25 * dim); gl.uniform1f(uloc(starProg, "uDim"), dim * starDim);
        gl.bindBuffer(gl.ARRAY_BUFFER, starBuf); const ap = loc(starProg, "aPos"); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, glowBuf); const ag = loc(starProg, "aGlowHue"); gl.enableVertexAttribArray(ag); gl.vertexAttribPointer(ag, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, n);
      }
      if (paintCount) {
        gl.useProgram(markProg); gl.uniformMatrix4fv(uloc(markProg, "uVP"), false, VP); gl.uniform1f(uloc(markProg, "uDpr"), dpr); gl.uniform1f(uloc(markProg, "uK"), Math.max(0.55, zoomK()));
        gl.bindBuffer(gl.ARRAY_BUFFER, paintBuf); const ap = loc(markProg, "aPos"), ac = loc(markProg, "aCol"), as = loc(markProg, "aSize");
        gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 32, 0); gl.enableVertexAttribArray(ac); gl.vertexAttribPointer(ac, 4, gl.FLOAT, false, 32, 12); gl.enableVertexAttribArray(as); gl.vertexAttribPointer(as, 1, gl.FLOAT, false, 32, 28);
        gl.drawArrays(gl.POINTS, 0, paintCount);
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
      // the roads: straight lines (a pair moved apart on screen), arrows on one-way roads, a dot mid-line on gate pairs
      const k0 = zoomK();
      for (const pl of polylines) {
        let a = project(pl.pts[0]), b = project(pl.pts[1]); if (!a || !b) continue;
        let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy); if (L < 2) continue; dx /= L; dy /= L;
        if (pl.shift) { const ox = -dy * pl.shift, oy = dx * pl.shift; a = [a[0] + ox, a[1] + oy]; b = [b[0] + ox, b[1] + oy]; }
        const w = pl.pub ? 1.6 : pl.heavy ? 3.2 : 2.3;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        ctx.setLineDash(pl.dash); ctx.globalAlpha = pl.alpha * (pl.pub ? 1 : roadFade); ctx.strokeStyle = pl.col; ctx.lineWidth = w;
        ctx.shadowColor = pl.col; ctx.shadowBlur = pl.dash.length || pl.pub || roadFade < 1 ? 0 : 7; ctx.stroke(); ctx.shadowBlur = 0; ctx.setLineDash([]);
        const ring = 10 * Math.max(k0, 0.6);
        const head = (p, ux, uy, s) => { ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] - s * (ux * Math.cos(0.45) - uy * Math.sin(0.45)), p[1] - s * (uy * Math.cos(0.45) + ux * Math.sin(0.45)));
          ctx.lineTo(p[0] - s * (ux * Math.cos(-0.45) - uy * Math.sin(-0.45)), p[1] - s * (uy * Math.cos(-0.45) + ux * Math.sin(-0.45))); ctx.closePath(); ctx.fillStyle = pl.col; ctx.fill(); };
        const s = pl.heavy ? 11 : 8; if (!pl.pub && roadFade < 1) { ctx.globalAlpha = 1; continue; }   /* no arrowheads on faded roads */
        if (!pl.road.twoWay) {
          if (L > ring * 2 + 6) head([b[0] - dx * ring, b[1] - dy * ring], dx, dy, s);                     // the arrowhead stops at the target's ring
          if (L > 120) { const m = [(a[0] + b[0]) / 2 + dx * 4, (a[1] + b[1]) / 2 + dy * 4]; head(m, dx, dy, s - 1); }   // and one mid-line on a long road
        } else if (L > 30) { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d = pl.pub ? 2.5 : 3.5;
          ctx.beginPath(); ctx.moveTo(m[0], m[1] - d); ctx.lineTo(m[0] + d, m[1]); ctx.lineTo(m[0], m[1] + d); ctx.lineTo(m[0] - d, m[1]); ctx.closePath(); ctx.fillStyle = pl.col; ctx.fill(); }
        ctx.globalAlpha = 1;
      }
      // Check a jump: the interference sphere of the tested jump (a circle of the sphere's radius at its centre) and
      // the legal (green) and blocked (red) targets, plus the aimed-at system in gold
      if (sphereOf) { const A = P(sphereOf.a), B = P(sphereOf.b); if (A && B) { const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2], r = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) / 2, c = project(mid);
        if (c) { let px = 0; for (const k of [[r, 0, 0], [0, r, 0], [0, 0, r]]) { const q = project([mid[0] + k[0], mid[1] + k[1], mid[2] + k[2]]); if (q) px = Math.max(px, Math.hypot(q[0] - c[0], q[1] - c[1])); }
          ctx.beginPath(); ctx.arc(c[0], c[1], px, 0, Math.PI * 2); ctx.strokeStyle = "#f1e9d2"; ctx.lineWidth = 1; ctx.setLineDash([4, 5]); ctx.globalAlpha = 0.55; ctx.stroke(); ctx.globalAlpha = 0.08; ctx.fillStyle = "#f1e9d2"; ctx.fill(); ctx.globalAlpha = 1; ctx.setLineDash([]);
          const a = project(A), b = project(B); if (a && b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.strokeStyle = "#d9b24c"; ctx.lineWidth = 1.2; ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]); } } } }
      for (const m of many) { const p = project(P(m.id)); if (!p) continue; const col = m.cls === "ok" ? "#7ec98b" : m.cls === "bad" ? "#e3222c" : m.cls === "unc" ? "#8fb8e8" : "#d9b24c", R = m.cls === "aim" ? 9 : m.cls === "tour" ? 7 : m.cls === "unc" ? 4 : 5;
        ctx.beginPath(); ctx.arc(p[0], p[1], R, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.lineWidth = m.cls === "aim" || m.cls === "tour" ? 2 : 1.4; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1;
        if (m.label) { ctx.font = `600 12.5px ${display}`; ctx.fillStyle = "rgba(7,7,10,.8)"; ctx.fillText(m.label, p[0] + R + 7, p[1] + 1); ctx.fillStyle = col; ctx.fillText(m.label, p[0] + R + 6, p[1]); } }
      // rings and labels. In priority order (selected, home, ours, the rest, plan waypoints): far from the camera a
      // system close to one already drawn (34 px at galaxy scale, 10 px mid-way, never up close) folds into it (the leader's label gains "+N"); a label whose box would
      // cover another label is left out, its ring stays. Nothing is ever stacked.
      ctx.textBaseline = "middle";
      const k = zoomK(), far = k < 0.75, foldR = k < 0.45 ? 34 : k < 0.75 ? 10 : 0, labelPlans = cam.dist < 900;
      const rank = s => s.id === selected || s.id === hovered ? 0 : s.hunt ? 0.6 : s.quiet ? 8 : s.cls === "me" ? 0.5 : s.cls === "mate" ? 1.5 : s.cls === "home" ? 1 : s.cls === "ours" ? 2 : s.cls === "inferred" ? 3 : s.cls === "plan" ? 5 : s.cls === "charted" ? 6 : s.cls === "poi" ? 6 : s.cls === "uncharted" ? 7 : 4;
      const order = scene.systems.map(s => ({ s, p: project(P(s.id)) })).filter(o => o.p).sort((a, b) => rank(a.s) - rank(b.s));
      const leaders = [], folded = [];
      for (const o of order) {
        if (foldR && rank(o.s) > 0 && !o.s.hunt) { const L = leaders.find(l => Math.hypot(l.p[0] - o.p[0], l.p[1] - o.p[1]) < foldR); if (L) { if (o.s.cls !== "charted" && o.s.cls !== "uncharted" && o.s.cls !== "poi") L.more++; folded.push(o); continue; } }   // a charted system folds silently: "+N" counts our own only
        o.more = 0; leaders.push(o);
      }
      // a folded system keeps a small mark, so a road never ends in empty space
      for (const o of folded) { if (o.s.cls === "plan" || o.s.cls === "charted" || o.s.cls === "uncharted" || o.s.cls === "poi") continue; ctx.beginPath(); ctx.arc(o.p[0], o.p[1], 2.5, 0, Math.PI * 2); ctx.strokeStyle = COLORS[o.s.cls] || COLORS.far; ctx.lineWidth = 1; ctx.stroke(); }
      const boxes = [], hit = (b) => boxes.some(q => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]);
      for (const o of leaders) {
        const s = o.s, p = o.p, col = s.color || COLORS[s.cls] || COLORS.far, unch = s.cls === "uncharted", poi = s.cls === "poi", charted = s.cls === "charted" || unch || poi, plan = s.cls === "plan" || charted, hot = s.id === selected || s.id === hovered;
        const R = s.hunt ? 11 * Math.max(k, 0.8) : Math.max(2.5, (s.cls === "me" ? 12 : s.cls === "mate" ? 9 : s.cls === "home" ? 11 : s.cls === "ours" ? 9 : plan ? (unch ? 3 : 4) : 7) * (plan ? Math.max(k, 0.7) : k));
        ctx.beginPath(); if (poi) { const D = R + 1.5; ctx.moveTo(p[0], p[1] - D); ctx.lineTo(p[0] + D, p[1]); ctx.lineTo(p[0], p[1] + D); ctx.lineTo(p[0] - D, p[1]); ctx.closePath(); } else ctx.arc(p[0], p[1], R, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.lineWidth = s.id === selected ? 2.5 : poi ? 1.6 : 1.3; ctx.setLineDash(s.cls === "inferred" || unch ? [3, 3] : []); ctx.globalAlpha = s.quiet && !hot ? 0.3 : unch && !hot ? 0.85 : 1; ctx.stroke(); ctx.globalAlpha = 1; ctx.setLineDash([]);
        if (hot || s.cls === "me" || s.hunt) { ctx.beginPath(); ctx.arc(p[0], p[1], R + 5, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.globalAlpha = s.hunt ? 0.7 : 0.45; ctx.lineWidth = s.hunt ? 2 : ctx.lineWidth; ctx.stroke(); ctx.globalAlpha = 1; }
        if (s.hunt) { ctx.beginPath(); ctx.arc(p[0], p[1], R + 11, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.globalAlpha = 0.25; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1; }
        if (s.quiet && !hot) continue;
        if ((plan && !labelPlans && !hot) || (unch && !hot)) continue;   // an uncharted mark is named only under the pointer
        const label = (s.cls === "home" ? "✠ " : "") + (s.name || String(s.id)) + (o.more ? `  +${o.more}` : "");
        ctx.font = charted ? `600 12.5px ${display}` : `700 13.5px ${display}`;
        const x = p[0] + R + 6, y = p[1] - (s.sub && !far ? 4 : 0), wdt = ctx.measureText(label).width, showSub = !!s.sub && !far && (hot || !!s.subWarn);
        const box = [x - 3, y - 9, x + wdt + 3, y + (showSub ? 22 : 9)];
        if (!hot && !s.hunt && hit(box)) continue;
        boxes.push(box);
        if (k < 0.45) { ctx.fillStyle = "rgba(7,7,10,.82)"; ctx.fillRect(box[0] - 2, box[1] - 1, box[2] - box[0] + 4, box[3] - box[1] + 2); ctx.strokeStyle = "rgba(217,178,76,.45)"; ctx.lineWidth = 1; ctx.strokeRect(box[0] - 1.5, box[1] - 0.5, box[2] - box[0] + 3, box[3] - box[1] + 1); }
        ctx.fillStyle = "rgba(7,7,10,.75)"; ctx.fillText(label, x + 1, y + 1); ctx.fillStyle = s.cls === "home" ? "#ffd27a" : s.hunt || poi || s.cls === "me" || s.cls === "mate" ? col : s.cls === "charted" ? COLORS.charted : charted ? "#aab3bc" : "#f1e9d2"; ctx.fillText(label, x, y);
        if (showSub) { ctx.font = `600 11px ${mono}`; ctx.fillStyle = s.subColor || "#b8b3a8"; ctx.fillText(s.sub, x, y + 14); }
      }
      // the hover card (2026-10-23): what the system under the pointer is, its roads and public gates
      if (hovered != null && ptr && !drag) { const sys = scene.systems.find(x => x.id === hovered); const p = project(P(hovered));
        if (sys && p) { const out = scene.roads.filter(r => r.a === hovered && r.kind !== "Public Gate" && r.kind !== "Long-haul Gate").length, inn = scene.roads.filter(r => r.b === hovered && r.kind !== "Public Gate" && r.kind !== "Long-haul Gate" && !r.twoWay).length, pg = (gateAdj.get(hovered) || []).length;
          const what = { home: "Home", ours: "On our roads", inferred: "On our roads (worked out)", me: "You are here", mate: "A tribe mate", charted: "Charted", uncharted: "Uncharted", poi: "Point of interest", plan: "On a plan", far: "Marked" }[sys.cls] || "";
          const lines = [[sys.name || String(sys.id), "#f1e9d2", `700 13px ${display}`], [what, COLORS[sys.cls] || "#b8b3a8", `600 11px ${mono}`]];
          if (sys.sub) lines.push([sys.sub, sys.subColor || "#b8b3a8", `600 11px ${mono}`]);
          if (out || inn) lines.push([`our roads: ${out} out${inn ? ` · ${inn} in` : ""}`, COLORS.gate, `600 11px ${mono}`]);
          lines.push([pg ? `public stargates: ${pg}` : "no public stargate", pg ? "#aab3bc" : "#737d86", `600 11px ${mono}`]);
          let W = 0; for (const l of lines) { ctx.font = l[2]; W = Math.max(W, ctx.measureText(l[0]).width); }
          const H = lines.length * 16 + 10; let x = ptr[0] + 16, y = ptr[1] + 14; if (x + W + 20 > w) x = ptr[0] - W - 30; if (y + H > h) y = ptr[1] - H - 10;
          ctx.fillStyle = "rgba(9,8,12,.92)"; ctx.fillRect(x, y, W + 20, H); ctx.strokeStyle = "rgba(217,178,76,.55)"; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, W + 19, H - 1);
          ctx.fillStyle = COLORS[sys.cls] || COLORS.gate; ctx.fillRect(x, y, 3, H);
          ctx.textBaseline = "top"; lines.forEach((l, i) => { ctx.font = l[2]; ctx.fillStyle = l[1]; ctx.fillText(l[0], x + 11, y + 6 + i * 16); }); ctx.textBaseline = "middle"; } }
      // a star picked from the background (no ring of its own): a dashed ring and its label
      if (marked) { const p = project(P(marked.id)); if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, Math.PI * 2); ctx.strokeStyle = "#f1e9d2"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
        ctx.font = `600 12.5px ${display}`; ctx.fillStyle = "rgba(7,7,10,.8)"; ctx.fillText(marked.label, p[0] + 14, p[1] + 1); ctx.fillStyle = "#f1e9d2"; ctx.fillText(marked.label, p[0] + 13, p[1]); } }
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
    // the legend (always on the map, folds to one line on a click)
    const leg = document.createElement("div"); leg.className = "sf-legend";
    leg.innerHTML = '<button type="button" class="sf-legend-t">Legend</button><ul>' + LEGEND.map(([c, st, t]) => `<li><i class="sf-l-${st}" style="--c:${COLORS[c]}"></i>${t}</li>`).join("") + "</ul>";
    leg.querySelector("button").addEventListener("click", () => { leg.classList.toggle("shut"); try { localStorage.setItem("roads:legend", leg.classList.contains("shut") ? "shut" : "open"); } catch (e) {} });
    leg.classList.add("shut"); try { if (localStorage.getItem("roads:legend") === "open") leg.classList.remove("shut"); } catch (e) {}
    container.appendChild(leg);
    /* the compass (user 2026-10-23: "in the game you have one"): as the game's Map draws it, a ring whose orange chevron
       is north and white ticks east / south / west, turning with the camera only (the game's own shots: chevron at the
       camera's yaw, no tilt). North = the game's +Z, the same camera fit that proved the mirror. A click faces north. */
    const comp = document.createElement("button"); comp.type = "button"; comp.className = "sf-compass"; comp.title = "Compass: the orange mark is north. Click to face north.";
    comp.innerHTML = '<svg viewBox="-30 -30 60 60" aria-hidden="true"><circle r="21" class="ring"/><path class="north" d="M-5 -21 L0 -26.5 L5 -21"/><path class="tick" d="M21 0 H26 M0 21 V26 M-21 0 H-26"/><text y="-9.5">N</text></svg>';
    comp.addEventListener("click", () => { const y0 = ((cam.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI, t0 = performance.now();
      const step = now => { const t = Math.min(1, (now - t0) / 400); cam.yaw = y0 * Math.pow(1 - t, 3); dirty = true; schedule(); if (t < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); });
    container.appendChild(comp);

    // ---------- input: drag orbits, shift/right drag pans, wheel zooms, click picks ----------
    let drag = null, ptr = null;
    ov.tabIndex = 0; ov.setAttribute("aria-label", "Star map: drag to turn, WASD to move, Q / E down / up, wheel to zoom");
    ov.addEventListener("pointerenter", () => { over = true; }); ov.addEventListener("pointerleave", () => { over = false; ptr = null; if (hovered != null) { hovered = null; dirty = true; schedule(); } });
    const pickAt = (x, y) => { let best = null, bd = 14; for (const s of scene.systems) { const p = project(P(s.id)); if (!p) continue; const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = s.id; } } return best; };
    // any star at all, for a click that hit no ring: the nearest one within 9 px
    const pickStar = (x, y) => { let best = null, bd = 9; for (let i = 0; i < n; i++) { const p = project([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]); if (!p) continue; const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = ids[i]; } } return best; };
    ov.addEventListener("pointerdown", e => { ov.focus({ preventScroll: true }); fly = null; drag = { x: e.clientX, y: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey, id: e.pointerId }; ov.setPointerCapture(e.pointerId); e.preventDefault(); });
    ov.addEventListener("pointermove", e => {
      ptr = [e.offsetX, e.offsetY]; if (!drag) { const id = pickAt(e.offsetX, e.offsetY); if (hovered != null) { dirty = true; schedule(); } if (id !== hovered) { hovered = id; ov.classList.toggle("over", !!id); /* pointer over a system (cursor rules: roads.css; tools/make_cursors.py) */ dirty = true; schedule(); if (opts.onHover) opts.onHover(id); } return; }
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
    ov.addEventListener("wheel", e => { /* a plain wheel zooms again (user 2026-10-23: "zoom without control, just regular mouse scroll") */ e.preventDefault(); zoomBy(Math.exp(Math.max(-1, Math.min(1, e.deltaY / 100)) * 0.14)); }, { passive: false });
    ov.addEventListener("dblclick", e => { const id = pickAt(e.offsetX, e.offsetY) || pickStar(e.offsetX, e.offsetY); /* any star, ringed or not (user 2026-10-18) */ if (id) flyTo(P(id), Math.max(30, Math.min(cam.dist, 160))); });

    return {
      load, setScene, fit, fitTo, fitAll, project, has: id => byId.has(id), position: P, oldName: id => { const i = byId.get(id); return names && i != null ? names[i] : null; },
      select(id) { selected = id; dirty = true; schedule(); },
      mark(id, label) { marked = id != null && byId.has(id) ? { id, label: label || "" } : null; dirty = true; schedule(); },
      // the archived (Cycle 6) names, for the system boxes: names starting with q first, then names containing it
      searchOld(q, limit) { const out = [], inc = []; if (!names) return out; q = String(q).toLowerCase(); for (let i = 0; i < n && out.length < limit; i++) { const nm = names[i]; if (!nm) continue; const l = nm.toLowerCase(); if (l.startsWith(q)) out.push({ id: ids[i], name: nm }); else if (inc.length < limit && l.includes(q)) inc.push({ id: ids[i], name: nm }); } return out.concat(inc).slice(0, limit); },
      markMany(list) { many = (list || []).filter(m => m && byId.has(m.id)); dirty = true; schedule(); },
      dimStars(on) { starDim = on ? 0.1 : 1; dirty = true; schedule(); },
      /* colour stars by id: [[id, "#rrggbb", size px, alpha], ...]; null or [] clears (the charted / uncharted filter) */
      paint(list) { const a = new Float32Array((list || []).length * 8), cache = new Map(); let k = 0;
        for (const [id, col, size, al] of list || []) { const i = byId.get(id); if (i == null) continue; const key = col + al; let c = cache.get(key); if (!c) cache.set(key, c = rgba(col, al));
          a[k++] = pos[i * 3]; a[k++] = pos[i * 3 + 1]; a[k++] = pos[i * 3 + 2]; a[k++] = c[0]; a[k++] = c[1]; a[k++] = c[2]; a[k++] = c[3]; a[k++] = size; }
        paintCount = k / 8; gl.bindBuffer(gl.ARRAY_BUFFER, paintBuf); gl.bufferData(gl.ARRAY_BUFFER, a.subarray(0, k), gl.STATIC_DRAW); dirty = true; schedule(); },
      ids: () => ids,
      /* every star within r light-years of a star: [[id, ly], ...], nearest first (Chart the uncharted) */
      near(id, r) { const i = byId.get(id); if (i == null || !pos) return []; const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], r2 = r * r, out = [];
        for (let k = 0; k < n; k++) { if (k === i) continue; const dx = pos[k * 3] - x, dy = pos[k * 3 + 1] - y, dz = pos[k * 3 + 2] - z, d2 = dx * dx + dy * dy + dz * dz; if (d2 <= r2) out.push([ids[k], Math.sqrt(d2)]); }
        return out.sort((a, b) => a[1] - b[1]); },
      sphere(s) { sphereOf = s && byId.has(s.a) && byId.has(s.b) ? { a: s.a, b: s.b } : null; dirty = true; schedule(); },
      look(id, dist) { const p = P(id); if (p) flyTo(p, dist || cam.dist); },
      view(pitchDeg) { cam.pitch = pitchDeg * Math.PI / 180; dirty = true; schedule(); },
      zoom(f) { zoomBy(f); },
      count: () => n,
      loadGates, gatesOf: id => (gateAdj.get(id) || []).slice(), gateCount: () => gatePairs,
      showGates(on) { gatesOn = !!on; dirty = true; schedule(); },
      fadeRoads(f) { roadFade = f; dirty = true; schedule(); },
      destroy() { ro.disconnect(); if (raf) cancelAnimationFrame(raf); window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey); gl3.remove(); ov.remove(); leg.remove(); }
    };
  }
  window.Starfield = Starfield;
})();
