// scenes.js — direction: rooms, blocking, camera, lights, acting, events. Everything is a function of time.
(function () {
  'use strict';
  const S = {}; window.SCENES = S;
  const E = window.ENGINE, W = window.WORLD;
  const clamp = E.clamp, lerp = E.lerp, ramp = E.ramp, track = E.track, ease = E.ease;
  const C = () => window.CHAR;
  const COL = { pip: '#a9d6ff', pipShout: '#dff4ff', nan: '#ffb347', tobi: '#ff7a3d', mira: '#ff5fb0', drip: '#6ff2b0', gus: '#8dff6a', gusLight: '#c6f5b4', fungus: '#3ddcb0', moon: '#cfe4ff', white: '#ffffff', ambRoost: '#112124', ambCath: '#0f1620' };

  // ---------- data ----------
  let DATA = null, LINES = {}, LINEBYWHO = {};
  S.init = function (data) {
    DATA = data;
    for (const L of data.lines.lines) { LINES[L.id] = L; (LINEBYWHO[L.who] = LINEBYWHO[L.who] || []).push(L); }
    // fall back to script timings for lines without audio
    for (const L of data.script.lines) if (!LINES[L.id]) { const est = { id: L.id, who: L.who, t: L.t, dur: Math.max(0.6, L.text.length / 14), frames: [], peakEnv: [] }; LINES[L.id] = est; (LINEBYWHO[L.who] = LINEBYWHO[L.who] || []).push(est); }
    window.SKY.init();
    for (const sc of SCENES) sc.build();
  };
  const line = id => LINES[id];
  // mouth/viseme for a character at time t
  function mouth(who, t, smile) {
    const arr = LINEBYWHO[who] || [];
    for (const L of arr) {
      if (t >= L.t && t < L.t + L.dur) {
        const i = Math.floor((t - L.t) * 24);
        const f = L.frames && L.frames[i];
        if (f) return { viseme: f[0], open: f[1], smile: smile || 0 };
        return { viseme: 'A', open: 0.5, smile: smile || 0 };
      }
    }
    return { viseme: 'rest', open: 0, smile: smile || 0 };
  }
  function env(who, t) {
    const arr = LINEBYWHO[who] || [];
    for (const L of arr) if (t >= L.t && t < L.t + L.dur) { const i = Math.floor((t - L.t) * 24); return (L.peakEnv && L.peakEnv[i]) || 0; }
    return 0;
  }
  function speaking(who, t) { return env(who, t) > 0.05; }
  // deterministic blink: returns eye openness multiplier
  function blink(who, t, base) {
    const seed = { pip: 1, nan: 2, gus: 3, tobi: 4, mira: 5 }[who] || 6;
    let o = 1;
    // blinks every 2.6..4.8 s
    const period = 3.4 + W.hash1(seed) * 1.2;
    const k = Math.floor((t + seed * 1.37) / period);
    const bt = (k + 0.3 + 0.5 * W.hash1(k * 7 + seed)) * period - seed * 1.37;
    const d = t - bt;
    if (d > 0 && d < 0.18) o = d < 0.07 ? 1 - d / 0.07 : (d - 0.07) / 0.11;
    return (base == null ? 1 : base) * o;
  }
  // onsets of a line (for speech rings): times where envelope rises
  function onsets(L, minGap) {
    const out = []; if (!L.peakEnv || !L.peakEnv.length) { out.push(L.t); return out; }
    let last = -9, below = true;
    for (let i = 0; i < L.peakEnv.length; i++) {
      const v = L.peakEnv[i], tt = L.t + i / 24;
      if (below && v > 0.3 && tt - last > (minGap || 0.35)) { out.push(tt); last = tt; below = false; }
      if (v < 0.15) below = true;
    }
    if (!out.length) out.push(L.t);
    return out;
  }

  // ---------- rings ----------
  const RING = {
    drip: { color: COL.drip, speed: 520, life: 1.6, width: 14, bright: 0.85, glow: 0.35, maxR: 900 },
    pipW: { color: COL.pip, speed: 140, life: 1.3, width: 10, bright: 0.95, glow: 0.5, maxR: 200 },
    pipS: { color: COL.pip, speed: 700, life: 2.4, width: 28, bright: 1.0, glow: 0.5, maxR: 1800 },
    pipFlight: { color: COL.pip, speed: 1500, life: 1.1, width: 40, bright: 1.0, glow: 0.55, maxR: 1400 },
    pipBig: { color: COL.pipShout, speed: 1900, life: 9, width: 160, bright: 1.6, glow: 0.7, maxR: 9000, tau: 2.6 },
    nan: { color: COL.nan, speed: 1000, life: 3.2, width: 70, bright: 0.95, glow: 0.5, maxR: 3000 },
    nanBig: { color: COL.nan, speed: 1150, life: 5.5, width: 110, bright: 1.15, glow: 0.6, maxR: 5000, tau: 1.3 },
    tobi: { color: COL.tobi, speed: 1500, life: 3.6, width: 90, bright: 1.2, glow: 0.55, maxR: 4000 },
    mira: { color: COL.mira, speed: 1400, life: 3.4, width: 80, bright: 1.15, glow: 0.55, maxR: 4000 },
    gusTalk: { color: COL.gus, speed: 260, life: 1.0, width: 12, bright: 0.5, glow: 0.3, maxR: 300 },
    flock: { color: '#ffd9a0', speed: 1100, life: 0.9, width: 40, bright: 0.55, glow: 0.4, maxR: 700 },
    splash: { color: COL.drip, speed: 700, life: 1.8, width: 26, bright: 1.0, glow: 0.4, maxR: 1400 },
  };
  function mkRing(kind, x, y, t0, over) { return Object.assign({}, RING[kind], { x, y, t0, vis: null, kind }, over || {}); }
  function drawRings(ctx, rings, t, room, clipVis) {
    for (const r of rings) {
      if (t < r.t0 || t > r.t0 + r.life) continue;
      if (clipVis && room && r.vis === null && r.clip !== false) r.vis = W.visibility(r.x, r.y, room.segs, r.maxR);
      E.drawRing(ctx, r, t);
    }
  }
  function drawFronts(cam, rings, t, mul) {
    const x = E.xT; E.applyCam(x, cam); x.globalCompositeOperation = 'lighter';
    for (const r of rings) { if (t < r.t0 || t > r.t0 + r.life) continue; if (r.front === false) continue; E.drawRingFront(x, r, t, mul); }
    x.globalCompositeOperation = 'source-over';
  }

  // ---------- characters helpers ----------
  function drawPip(ctx, p) { ctx.save(); ctx.translate(p.x, p.y); C().drawBat(ctx, Object.assign({ kind: 'pip' }, p)); ctx.restore(); }
  function drawEyes(ctx, p) { ctx.save(); ctx.translate(p.x, p.y); C().drawBatEyesOnly(ctx, Object.assign({ kind: 'pip' }, p)); ctx.restore(); }
  function drawBat(ctx, kind, p) { ctx.save(); ctx.translate(p.x, p.y); C().drawBat(ctx, Object.assign({ kind }, p)); ctx.restore(); }
  function gusPos(p) { const a = C().gusAnchor(Object.assign({ kind: 'pip' }, p)); return [p.x + a.x, p.y + a.y]; }
  function mouthPos(kind, p) { const a = C().headAnchor(Object.assign({ kind }, p)); return [p.x + a.mouthX, p.y + a.mouthY]; }
  function drawGus(ctx, x, y, p) { ctx.save(); ctx.translate(x, y); C().drawGus(ctx, p); ctx.restore(); }
  function flockBat(ctx, x, y, p) { ctx.save(); ctx.translate(x, y); C().drawFlockBat(ctx, p); ctx.restore(); }
  function wobble(t, f, seed) { return E.noise1(t * f, seed); }

  // ---------- water ----------
  function waterSurfaceY(x, t, level, amp) { return level + Math.sin(x * 0.012 + t * 2.1) * amp + Math.sin(x * 0.031 - t * 3.3) * amp * 0.5 + Math.sin(x * 0.0043 + t * 0.8) * amp * 1.4; }
  function drawWater(ctx, room, t, level, amp, view, bright) {
    // water fills the air below the surface line
    ctx.save();
    ctx.beginPath(); for (const a of room.airs) W.polyPath(ctx, a); ctx.clip();
    const x0 = view.x0 - 100, x1 = view.x1 + 100;
    ctx.beginPath(); ctx.moveTo(x0, view.y1 + 500);
    for (let x = x0; x <= x1; x += 16) ctx.lineTo(x, waterSurfaceY(x, t, level, amp));
    ctx.lineTo(x1, view.y1 + 500); ctx.closePath();
    const g = ctx.createLinearGradient(0, level - 40, 0, level + 500);
    g.addColorStop(0, '#1d3b55'); g.addColorStop(1, '#040a12');
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = bright || '#9fe8ff'; ctx.lineWidth = 3; ctx.lineJoin = 'round';
    ctx.beginPath(); for (let x = x0; x <= x1; x += 16) { const y = waterSurfaceY(x, t, level, amp); if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke();
    // sparkles
    ctx.fillStyle = 'rgba(200,245,255,0.8)';
    for (let x = x0; x <= x1; x += 40) { const h = W.hash1(Math.floor(x / 40) * 3 + Math.floor(t * 6)); if (h > 0.7) { const y = waterSurfaceY(x, t, level, amp) + 6 + h * 20; ctx.fillRect(x + h * 20, y, 6 + h * 10, 1.5); } }
    ctx.restore();
  }
  // splash particles (stateless ballistic)
  function drawSplash(ctx, x, y, t0, t, n, power, color) {
    const a = t - t0; if (a < 0 || a > 1.4) return;
    ctx.fillStyle = color || 'rgba(190,240,255,0.9)';
    for (let i = 0; i < n; i++) {
      const h1 = W.hash1(i * 3.1 + t0), h2 = W.hash1(i * 7.7 + t0 * 2), h3 = W.hash1(i * 1.3 + t0 * 3);
      const vx = (h1 - 0.5) * power * 1.6, vy = -(0.5 + h2) * power;
      const px = x + vx * a, py = y + vy * a + 900 * a * a;
      if (py > y + 10) continue;
      const r = 2 + h3 * 4 * (1 - a / 1.4);
      ctx.beginPath(); ctx.arc(px, py, r, 0, 6.283); ctx.fill();
    }
  }

  // ---------- events ----------
  const EVENTS = [];
  function ev(o) { EVENTS.push(o); }
  S.events = function () { EVENTS.sort((a, b) => a.t - b.t); return { fps: 24, duration: DATA.script.duration, events: EVENTS }; };
  // screen x (0..1) of a world point for an event
  function sx(cam, x, y) { const p = E.worldToScreen(cam, x, y); return clamp(p[0] / E.W, 0, 1); }

  // =====================================================================================
  // ROOMS
  // =====================================================================================
  const ROOMS = {};
  function buildRooms() {
    ROOMS.roost = W.chamber({
      name: 'roost', seed: 11, bounds: { x0: -2600, y0: -1500, x1: 2600, y1: 1500 },
      control: [[-2100, -300], [-1700, -800], [-1100, -1050], [-300, -1150], [500, -1000], [1300, -1100], [1900, -700], [2300, -200], [2250, 350], [1800, 800], [1100, 1050], [300, 1150], [-500, 1100], [-1300, 950], [-1900, 600], [-2200, 150]],
      rough: 55, stalDensity: 0.7, stalLen: 330, stalagDensity: 0.35, fungusDensity: 0.45,
      columns: [{ x: -900, y: -500, r: 60, sx: 1, sy: 9 }, { x: 1500, y: 300, r: 140, sx: 1, sy: 1.6 }, { x: -1600, y: 700, r: 160, sx: 1.4, sy: 0.7 }]
    });
    // class ledge
    ROOMS.roost.solids.push(W.roughen(W.catmull([[-760, 700], [-600, 600], [-350, 580], [-100, 585], [200, 575], [480, 600], [620, 720], [560, 900], [200, 980], [-300, 970], [-700, 900]], true, 5), 8, 5, true, 0.1));
    // the stalactite Nan hangs from: reaches down to y=330 at x=-900 (column above handles it) — add a knob
    ROOMS.roost.solids.push(W.catmull([[-960, 20], [-900, 10], [-840, 30], [-830, 200], [-870, 330], [-930, 330], [-965, 200]], true, 5));
    ROOMS.roost.decor.fungus.push([-300, 980, 180, 0.2], [400, 990, 120, 0.6], [-1200, 940, 160, 0.9], [900, 1040, 140, 0.4], [-1700, 650, 90, 0.1], [1700, 760, 110, 0.7], [-520, 900, 90, 0.5]);
    ROOMS.roost.hangers = []; // hanging colony positions along the ceiling
    { const R = W.rng(21); const air = ROOMS.roost.airs[0]; const n = air.length;
      for (let i = 0; i < n; i++) { const a = air[i], b = air[(i + 1) % n]; const dx = b[0] - a[0], dy = b[1] - a[1];
        if (dx > 0 && Math.abs(dy) < Math.abs(dx)) { for (let k = 0; k < 3; k++) if (R() < 0.6) { const t = R(); ROOMS.roost.hangers.push({ x: a[0] + dx * t, y: a[1] + dy * t + 14 + R() * 60, s: 0.45 + R() * 0.4, ph: R() * 6.28, drop: 55.4 + R() * 2.6, v: 500 + R() * 400, side: R() }); } } }
      // some on stalactites
      for (const s of ROOMS.roost.solids) { if (s.length === 16 && R() < 0.7) { const tip = s[7]; ROOMS.roost.hangers.push({ x: tip[0] + (R() - 0.5) * 20, y: tip[1] - 4 + R() * 10, s: 0.4 + R() * 0.4, ph: R() * 6.28, drop: 55.4 + R() * 2.6, v: 500 + R() * 400, side: R() }); } }
      finalizeHangers();
    }
    function finalizeHangers() { finalize(ROOMS.roost); }
    function finalize(room) { room.segs = []; for (const a of room.airs) room.segs.push(...W.segsOf(a, true)); for (const s of room.solids) room.segs.push(...W.segsOf(s, true)); }

    ROOMS.tunnel = W.tunnel({
      name: 'tunnel', seed: 31, bounds: { x0: -600, y0: -1400, x1: 8400, y1: 1400 },
      path: [[-400, 0], [700, -220], [1700, 160], [2700, -140], [3700, 280], [4600, 60], [5500, -260], [6400, -40], [7300, 160], [8100, 40]],
      halfWidth: t => 300 + 120 * Math.sin(t * 9), wobble: 0.5, rough: 18, spikeDensity: 0.35, spikeLen: 90
    });
    // side crack at the fork (around x=6400): goes up-right
    { const crack = W.tunnel({ name: 'crackmouth', seed: 32, bounds: ROOMS.tunnel.bounds, path: [[6350, -300], [6600, -560], [6900, -820], [7300, -1000]], halfWidth: 110, wobble: 0.4, rough: 10, spikeDensity: 0.3, spikeLen: 40 });
      ROOMS.tunnel.airs.push(crack.airs[0]); ROOMS.tunnel.solids.push(...crack.solids); ROOMS.tunnel.crackCenter = crack.center; finalize(ROOMS.tunnel); ROOMS.tunnel.hatch.push(...crack.hatch); }

    ROOMS.crack = W.tunnel({
      name: 'crack', seed: 41, bounds: { x0: -600, y0: -2600, x1: 6400, y1: 1400 },
      path: [[0, 0], [500, -260], [900, 120], [1400, -300], [1700, -900], [2200, -1100], [2700, -700], [3200, -1000], [3800, -1300], [4300, -900], [4800, -1150], [5400, -1000], [5900, -1100]],
      halfWidth: t => 120 + 50 * Math.sin(t * 13) + 40 * Math.sin(t * 31), wobble: 0.5, rough: 12, spikeDensity: 0.5, spikeLen: 55
    });
    ROOMS.crack.decor.pebbles.push([300, 60, 6], [1200, 40, 5]);

    ROOMS.cathedral = W.chamber({
      name: 'cathedral', seed: 51, bounds: { x0: -4200, y0: -3200, x1: 4200, y1: 3200 },
      control: [[-3600, 300], [-3300, -900], [-2500, -1700], [-1200, -2300], [300, -2500], [1600, -2300], [2500, -2100], [3200, -1500], [3600, -600], [3500, 600], [3000, 1500], [2000, 2200], [600, 2500], [-800, 2400], [-2000, 2100], [-2900, 1500], [-3500, 900]],
      rough: 70, stalDensity: 0.8, stalLen: 520, stalagDensity: 0.2, fungusDensity: 0,
      columns: [{ x: -600, y: 600, r: 150, sx: 1, sy: 5 }, { x: 900, y: -300, r: 130, sx: 1, sy: 6 }, { x: 1900, y: -900, r: 110, sx: 1, sy: 5 }, { x: -1600, y: 1300, r: 220, sx: 1.3, sy: 1 }, { x: 2600, y: 300, r: 180, sx: 1, sy: 3 }, { x: 200, y: -1500, r: 90, sx: 1, sy: 4 }]
    });
    // ledge where the crack lets out (left wall) + the crack stub + exit crack top-right
    ROOMS.cathedral.solids.push(W.roughen(W.catmull([[-3700, 420], [-3200, 400], [-2700, 430], [-2450, 520], [-2500, 700], [-2900, 760], [-3400, 720], [-3700, 650]], true, 5), 10, 7, true, 0.1));
    { const stub = W.tunnel({ name: 'stub', seed: 52, bounds: ROOMS.cathedral.bounds, path: [[-4100, 300], [-3700, 330], [-3350, 360]], halfWidth: 120, wobble: 0.3, rough: 8, spikeDensity: 0.2, spikeLen: 30 });
      ROOMS.cathedral.airs.push(stub.airs[0]);
      const exit = W.tunnel({ name: 'exit', seed: 53, bounds: ROOMS.cathedral.bounds, path: [[2650, -1950], [2900, -2300], [3100, -2800], [3300, -3300]], halfWidth: t => 90 + 60 * (1 - t), wobble: 0.3, rough: 8, spikeDensity: 0.3, spikeLen: 30 });
      ROOMS.cathedral.airs.push(exit.airs[0]); ROOMS.cathedral.exitCenter = exit.center;
      finalize(ROOMS.cathedral); }

    // outside: the cliff with the cave mouth (2D polygons drawn over the shader)
    ROOMS.sky = { name: 'sky', airs: [], solids: [], segs: [], decor: { fungus: [], pebbles: [], puddles: [] }, hatch: [] };
    ROOMS.sky.cliff = W.roughen(W.catmull([[-3000, -2600], [-1500, -2400], [-700, -1500], [-350, -700], [-250, -150], [-420, 120], [-300, 350], [-700, 900], [-1100, 1600], [-1400, 2600], [-3000, 2600]], true, 6), 30, 61, true, 0.03);
    ROOMS.sky.mouth = W.roughen(W.catmull([[-150, -260], [-330, -180], [-520, -40], [-560, 120], [-420, 240], [-230, 230], [-110, 120], [-90, -80]], true, 5), 12, 62, true, 0.1);
  }

  // =====================================================================================
  // SCENE DEFINITIONS
  // =====================================================================================
  const SCENES = [];
  function scene(o) { SCENES.push(o); return o; }

  // ---------- shared roost blocking ----------
  // pups on the ledge, Nan hanging. Positions (world).
  const ROOST = { tobi: [-350, 582], mira: [-100, 586], pip: [190, 578], nanHang: [-900, 330] };
  function pipRoostParams(t) {
    const nervous = 0.4 + 0.6 * ramp(t, 24, 36);
    const pipTalking = speaking('pip', t);
    const joke = ramp(t, 28, 30) * (1 - ramp(t, 40, 42));
    const gusMoment = ramp(t, 40.5, 41.5) * (1 - ramp(t, 48.5, 49.5));
    const p = {
      x: ROOST.pip[0], y: ROOST.pip[1], scale: 1, flipX: true, pose: t > 55.6 ? 'crouch' : 'perch',
      flap: 0, lean: -0.2 * nervous + 0.15 * Math.sin(t * 1.7),
      eyes: { open: blink('pip', t, 1 - joke * 0.5), pupil: 0.45 - 0.2 * nervous + 0.25 * gusMoment, lookX: t < 24 ? -0.7 : (joke ? 0.2 : (gusMoment ? 0 : -0.6)), lookY: joke ? 0.6 : (gusMoment ? 0.8 : -0.2) },
      brow: -0.4 - 0.5 * nervous + 0.3 * gusMoment,
      mouth: mouth('pip', t, joke ? -0.6 : -0.2),
      ears: 0.8 - 0.6 * joke - 0.3 * nervous + 0.3 * gusMoment,
      breath: 0.5 + 0.5 * Math.sin(t * 2.4), glowEyes: 0.25,
    };
    if (t > 55.6) { p.eyes.lookX = -0.4; p.eyes.lookY = -0.9; p.eyes.pupil = 0.2; p.brow = -1; p.ears = 0.1; }
    return p;
  }
  function nanRoostParams(t) {
    const stern = ramp(t, 30.8, 31.2) * (1 - ramp(t, 37.5, 38.5));
    const launch = ramp(t, 55.4, 56.6, 'inCubic');
    const p = {
      x: ROOST.nanHang[0], y: ROOST.nanHang[1], scale: 1.15, flipX: false, pose: launch > 0 ? 'fly' : 'hang',
      flap: (t * 5.5) % 1, lean: 0.1 * Math.sin(t * 0.9) + 0.4 * launch,
      eyes: { open: blink('nan', t, stern ? 0.55 : 0.75), pupil: 0.5, lookX: 0.5, lookY: stern ? 0.2 : 0 },
      brow: stern ? 0.6 : (t > 38 && t < 41 ? -0.3 : 0.1),
      mouth: mouth('nan', t, t > 38 && t < 41 ? 0.5 : (t > 45 && t < 47 ? -0.3 : 0.2)),
      ears: 0.7, breath: 0.5 + 0.5 * Math.sin(t * 1.3), glowEyes: 0.15, rot: 0,
    };
    if (launch > 0) { // drops, swoops right and up out of frame
      p.x = lerp(ROOST.nanHang[0], 2600, ease.inCubic(ramp(t, 55.5, 58.5))) ; p.y = ROOST.nanHang[1] + 420 * Math.sin(Math.PI * ramp(t, 55.5, 57.2, 'linear')) * (1 - ramp(t, 57, 58.5)) - 900 * ramp(t, 57, 58.5, 'in');
      p.rot = -0.25 * launch; p.flipX = false; p.pose = 'fly'; p.flap = (t * 6) % 1; p.eyes.lookX = 0.8;
    }
    return p;
  }
  function pupParams(kind, t) {
    const shoutT = kind === 'tobi' ? 20.5 : 22.2;
    const inhale = ramp(t, shoutT - 0.6, shoutT - 0.05) * (1 - ramp(t, shoutT, shoutT + 0.1));
    const shout = ramp(t, shoutT, shoutT + 0.08) * (1 - ramp(t, shoutT + 0.7, shoutT + 1.2));
    const grin = ramp(t, 27.5, 28.5) * (1 - ramp(t, 31, 31.6));
    const scared = ramp(t, 55.6, 56.6);
    const p = {
      x: ROOST[kind][0], y: ROOST[kind][1], scale: kind === 'tobi' ? 1.05 : 1.0, flipX: true, pose: scared ? 'crouch' : 'perch',
      flap: 0, lean: 0.45 * shout - 0.3 * inhale + 0.1 * Math.sin(t * 1.5 + (kind === 'tobi' ? 1 : 3)),
      eyes: { open: blink(kind, t, kind === 'mira' ? 0.65 : 1) * (1 - 0.7 * shout), pupil: 0.5, lookX: grin ? 0.7 : -0.5, lookY: grin ? 0.3 : 0 },
      brow: kind === 'tobi' ? 0.5 : 0.1, mouth: mouth(kind, t, grin ? 0.9 : (kind === 'tobi' ? 0.5 : 0.2)),
      ears: 0.8 + 0.2 * shout - 0.6 * scared, breath: 0.5 + 0.5 * Math.sin(t * 2 + (kind === 'tobi' ? 0 : 2)) + inhale, glowEyes: 0.2,
    };
    if (shout) p.mouth = { viseme: 'A', open: 1, smile: 0.3 };
    if (inhale) p.mouth = { viseme: 'O', open: 0.6 * inhale, smile: 0 };
    return p;
  }
  function gusParams(t, lit, extra) {
    return Object.assign({ scale: 1, rot: 0, lit, eyes: { open: blink('gus', t), lookX: 0, lookY: -0.2 }, mouth: mouth('gus', t, 0.4), wiggle: (t * 1.3) % 1, fear: 0 }, extra || {});
  }
  function drawHangers(ctx, t, from, to) {
    const H = ROOMS.roost.hangers;
    for (const h of H) {
      if (t < h.drop) {
        const sway = Math.sin(t * 1.1 + h.ph) * 0.05;
        flockBat(ctx, h.x, h.y, { scale: h.s, rot: Math.PI + sway, flap: 0.5 + 0.02 * Math.sin(t * 3 + h.ph), tint: '#2b3344', hang: true });
      } else {
        const a = t - h.drop; // fall then fly toward the right exit
        const fx = h.x + h.v * a * 1.6 + 300 * a * a, fy = h.y + 300 * a - 220 * a * a * (0.5 + h.side) ;
        flockBat(ctx, fx, fy, { scale: h.s, rot: 0.1 - 0.2 * h.side, flap: (t * (7 + h.side * 3) + h.ph) % 1, tint: '#2b3344' });
      }
    }
  }
  function roostAmbient(ctx, t, strength) {
    for (const f of ROOMS.roost.decor.fungus) { const pulse = 0.85 + 0.15 * Math.sin(t * 1.3 + f[3] * 6.28); E.drawGlow(ctx, f[0], f[1] - 10, f[2] * 2.6, COL.fungus, 0.5 * strength * pulse, 0.15); }
  }

  // =====================================================================================
  // SCENE 0: COLD OPEN (0–14)
  // =====================================================================================
  scene({
    id: 'cold_open', start: 0, end: 14,
    build() {
      this.rings = [];
      const drips = [[0.8, -1500, 1100, 1.0], [2.3, 1300, 1050, 0.8], [3.4, -200, 1150, 1.1], [4.4, 700, 1040, 0.9]];
      this.drips = drips;
      for (const d of drips) this.rings.push(mkRing('drip', d[1], d[2] - 2, d[0], { bright: 1.2, speed: 650, life: 2.4, width: 22, maxR: 1100 }));
      // Nan's PIP! from off to the upper left (she is somewhere in the roost)
      this.rings.push(mkRing('nanBig', -1700, -500, line('L00').t, { life: 8, speed: 1250, bright: 1.8, width: 160, tau: 2.6 }));
      this.cam = { x: -200, y: 0, zoom: 0.42, rot: 0 };
      for (const d of drips) ev({ t: d[0], type: 'drip', x: sx(this.cam, d[1], d[2]), gain: 0.9 * d[3], room: 'roost', size: 1.1 });
      ev({ t: 0.0, type: 'cave_amb', dur: 14, gain: 0.5, room: 'none' });
      ev({ t: line('L00').t, type: 'ping', who: 'nan', size: 1.0, x: 0.2, gain: 0.5, room: 'roost' });
      ev({ t: 10.6, type: 'title_hit', gain: 0.8 });
    },
    render(t, frame) {
      const cam = Object.assign({}, this.cam);
      cam.zoom = 0.42 + 0.02 * ramp(t, 0, 14, 'linear');
      E.begin();
      const view = E.viewRect(cam);
      E.applyCam(E.xE, cam);
      W.drawRoom(E.xE, ROOMS.roost, view, { zoom: cam.zoom });
      W.drawFungus(E.xE, ROOMS.roost, t);
      drawHangers(E.xE, t);
      // Pip, tiny, on the ledge (as in the lesson to come) — barely glimpsed
      drawPip(E.xE, pipRoostParams(14.5));
      E.applyCam(E.xM, cam);
      roostAmbient(E.xM, t, 0.3 * ramp(t, 5.5, 9.5));
      drawRings(E.xM, this.rings, t, ROOMS.roost, true);
      drawFronts(cam, this.rings, t, 0.5);
      // the roost blooms into view behind the ring front, then fades back to black
      const t0 = line('L00').t; const swept = ramp(t, t0 + 0.2, t0 + 3.4, 'out') * Math.exp(-Math.max(0, t - t0 - 1.2) / 2.2);
      E.compose({ airGlow: 0.1, bloom: 0.5, flash: 0.9 * swept });
      // title
      const x = E.ctx;
      const ta = ramp(t, 10.2, 11.4) * (1 - ramp(t, 13.0, 13.9));
      if (ta > 0) {
        E.text(x, 'PIPSQUEAK', E.W / 2, E.H / 2 - 10, { font: '150px Lilita', color: '#eaf6ff', alpha: ta, spacing: '14px', glow: '#7fc8ff', glowBlur: 40 });
        // a thin pale ring expanding under the title
        x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = ta * 0.6; x.strokeStyle = COL.pip; x.lineWidth = 2;
        const r = 60 + (t - 10.2) * 160; x.beginPath(); x.ellipse(E.W / 2, E.H / 2 + 8, r * 1.9, r * 0.5, 0, 0, 6.283); x.stroke(); x.restore();
      }
      E.post(frame, { fade: ramp(t, 13.4, 14.0), grain: 0.08 });
    }
  });

  // =====================================================================================
  // SCENE 1: THE ROOST (14–58)
  // =====================================================================================
  scene({
    id: 'roost', start: 14, end: 58,
    build() {
      this.rings = [];
      const R = this.rings;
      const nanMouth = (t) => mouthPos('nan', nanRoostParams(t));
      // speech rings for Nan's lines (per onset)
      for (const id of ['L01', 'L04', 'L07', 'L08', 'L10', 'L12', 'L14']) { const L = line(id); for (const o of onsets(L, 0.5)) { const m = nanMouth(o); R.push(mkRing('nan', m[0], m[1], o, { bright: 0.75, life: 2.6 })); } }
      // Tobi and Mira shouts
      { const m = mouthPos('tobi', pupParams('tobi', 20.55)); R.push(mkRing('tobi', m[0], m[1], line('L02').t)); }
      { const m = mouthPos('mira', pupParams('mira', 22.25)); R.push(mkRing('mira', m[0], m[1], line('L03').t)); }
      { const L = line('L06'); for (const o of onsets(L, 0.3)) { const m = mouthPos('tobi', pupParams('tobi', o)); R.push(mkRing('tobi', m[0], m[1], o, { speed: 600, life: 1.6, bright: 0.6, width: 30, maxR: 900 })); } }
      // Pip's whispers
      for (const id of ['L05', 'L09']) { const L = line(id); const m = mouthPos('pip', pipRoostParams(L.t)); R.push(mkRing('pipW', m[0] - 30, m[1], L.t, id === 'L05' ? { speed: 120, life: 2.2, bright: 1.4, width: 14, tau: 1.2 } : { speed: 170, life: 1.8, bright: 1.2 })); }
      // Gus talking: little green pulses
      for (const id of ['L11', 'L13']) { const L = line(id); for (const o of onsets(L, 0.4)) { const g = gusPos(pipRoostParams(o)); R.push(mkRing('gusTalk', g[0], g[1], o)); } }
      // drips in the roost
      this.drips = [[16.5, 900, 1040], [33.5, -1500, 1100], [43.0, 1300, 1050], [52.0, -200, 1150]];
      for (const d of this.drips) { R.push(mkRing('drip', d[1], d[2], d[0], { bright: 0.7 })); }
      // flock exodus ring sparkle 55.5–58
      const Rn = W.rng(77); this.flockRings = [];
      for (let i = 0; i < 40; i++) { const t0 = 55.8 + Rn() * 2.2; const h = ROOMS.roost.hangers[Math.floor(Rn() * ROOMS.roost.hangers.length)]; const a = t0 - h.drop; if (a < 0) continue; this.flockRings.push(mkRing('flock', h.x + h.v * a * 1.6 + 300 * a * a, h.y + 300 * a - 220 * a * a * (0.5 + h.side), t0, { clip: false })); }
      // events
      ev({ t: 14, type: 'cave_amb', dur: 44, gain: 0.55 });
      for (const d of this.drips) ev({ t: d[0], type: 'drip', x: 0.5, gain: 0.5, room: 'roost' });
      ev({ t: 29.6, type: 'giggle', n: 2, x: 0.4, gain: 0.7, room: 'roost' });
      ev({ t: 41.0, type: 'gus_on', x: 0.6, gain: 0.5, room: 'roost' });
      ev({ t: 55.5, type: 'wingflap', dur: 2.5, rate: 5, size: 1.0, x: 0.3, gain: 0.8, room: 'roost' });
      ev({ t: 55.5, type: 'whoosh', dur: 1.2, x: 0.3, x_end: 0.9, gain: 0.7 });
      ev({ t: 55.8, type: 'flock', dur: 4.0, density: 1.0, x: 0.3, x_end: 0.8, gain: 1.0, room: 'roost' });
      ev({ t: 56.2, type: 'rumble', dur: 2.0, gain: 0.3 });
    },
    camera(t) {
      // shot list
      const shots = [
        [14.0, { x: -350, y: 450, zoom: 0.78 }, { x: -300, y: 470, zoom: 0.84 }, 24.4],  // wide lesson, slow push
        [24.4, { x: 190, y: 540, zoom: 2.0 }, { x: 190, y: 540, zoom: 2.15 }, 26.9],      // medium on Pip
        [26.9, { x: 60, y: 585, zoom: 3.4 }, { x: 60, y: 585, zoom: 3.5 }, 28.0],         // the pebble
        [28.0, { x: -230, y: 540, zoom: 1.7 }, { x: -230, y: 540, zoom: 1.7 }, 30.9],     // Tobi and Mira grinning
        [30.9, { x: -890, y: 400, zoom: 1.9 }, { x: -890, y: 420, zoom: 2.0 }, 35.5],     // Nan upside down
        [35.5, { x: 190, y: 540, zoom: 2.4 }, { x: 190, y: 540, zoom: 2.7 }, 38.0],       // close on Pip
        [38.0, { x: -400, y: 480, zoom: 1.25 }, { x: -380, y: 480, zoom: 1.3 }, 40.9],    // two-shot
        [40.9, { x: 210, y: 600, zoom: 2.9 }, { x: 210, y: 600, zoom: 3.0 }, 45.5],       // Gus on Pip's chest
        [45.5, { x: -890, y: 420, zoom: 2.1 }, { x: -890, y: 420, zoom: 2.1 }, 47.1],     // Nan deadpan
        [47.1, { x: 210, y: 600, zoom: 3.0 }, { x: 210, y: 600, zoom: 3.1 }, 49.2],       // Gus proud
        [49.2, { x: -300, y: 420, zoom: 0.82 }, { x: -250, y: 350, zoom: 0.7 }, 58.0],    // wide; launch
      ];
      for (const s of shots) if (t >= s[0] && t < s[3]) { const u = ease.inOut((t - s[0]) / (s[3] - s[0])); return { x: lerp(s[1].x, s[2].x, u), y: lerp(s[1].y, s[2].y, u), zoom: lerp(s[1].zoom, s[2].zoom, u), rot: 0 }; }
      return { x: -300, y: 450, zoom: 0.8, rot: 0 };
    },
    render(t, frame) {
      const cam = this.camera(t);
      // shakes on shouts
      const sh = Math.max(ramp(t, 20.5, 20.55) * (1 - ramp(t, 20.6, 21.3)), ramp(t, 22.2, 22.25) * (1 - ramp(t, 22.3, 23))) * 6 + ramp(t, 55.5, 55.8) * (1 - ramp(t, 57.5, 58)) * 5;
      E.shake(cam, t, sh, 12);
      E.begin(COL.ambRoost);
      const view = E.viewRect(cam);
      const xE = E.xE; E.applyCam(xE, cam);
      W.drawRoom(xE, ROOMS.roost, view, { zoom: cam.zoom });
      W.drawFungus(xE, ROOMS.roost, t);
      drawHangers(xE, t);
      // the pebble (hero prop)
      xE.fillStyle = '#2a323c'; xE.strokeStyle = '#cfe6f2'; xE.lineWidth = 2; xE.beginPath(); xE.ellipse(60, 578, 11, 7, 0.2, 0, 6.283); xE.fill(); xE.stroke();
      // characters
      const pp = pipRoostParams(t), np = nanRoostParams(t), tp = pupParams('tobi', t), mp = pupParams('mira', t);
      drawBat(xE, 'tobi', tp); drawBat(xE, 'mira', mp); drawPip(xE, pp);
      if (t < 58.6) drawBat(xE, 'nan', np);
      // Gus on Pip's chest (visible from 40.9 on; before that hidden in fur)
      const g = gusPos(pp); const gusOut = ramp(t, 40.6, 41.2, 'outBack');
      if (gusOut > 0) drawGus(xE, g[0], g[1] - 6 * gusOut, gusParams(t, 1, { scale: 0.9, eyes: { open: blink('gus', t), lookX: t > 45 && t < 47 ? -0.8 : -0.3, lookY: -0.3 }, mouth: mouth('gus', t, t > 47 ? 0.9 : 0.5) }));
      // lights
      const xM = E.xM; E.applyCam(xM, cam);
      roostAmbient(xM, t, 1.3);
      if (gusOut > 0) E.drawGlow(xM, g[0], g[1], 230 * gusOut, COL.gusLight, 0.8);
      drawRings(xM, this.rings, t, ROOMS.roost, true);
      drawRings(xM, this.flockRings, t, ROOMS.roost, false);
      drawFronts(cam, this.rings, t, 0.45);
      E.compose({ airGlow: 0.12, bloom: 0.45 });
      // cut flashes: none. fade in from black at start
      E.post(frame, { fade: 1 - ramp(t, 14, 15.2), grain: 0.07 });
    }
  });

  // =====================================================================================
  // SCENE 2: EXODUS (58–80)
  // =====================================================================================
  const FLOCK_N = 420;
  function flockBatPos(i, t) {
    const h1 = W.hash1(i * 1.7), h2 = W.hash1(i * 3.3), h3 = W.hash1(i * 5.9), h4 = W.hash1(i * 7.1);
    const speed = 0.085 + h1 * 0.03; // path units per second (path ≈ 8500px)
    const s0 = -0.28 + h2 * 0.5;      // staggered start
    const s = s0 + speed * (t - 58);
    if (s < 0 || s > 1) return null;
    const p = W.along(ROOMS.tunnel.center, s), d = W.alongDir(ROOMS.tunnel.center, s);
    const lat = (h3 - 0.5) * 380 + Math.sin(t * (1.5 + h4) + i) * 60;
    return { x: p[0] - Math.sin(d) * lat, y: p[1] + Math.cos(d) * lat, rot: d + Math.sin(t * 3 + i) * 0.1, s, scale: 0.55 + h4 * 0.45, flap: (t * (6 + h1 * 4) + h2 * 7) % 1 };
  }
  scene({
    id: 'exodus', start: 58, end: 80,
    build() {
      this.rings = [];
      const R = W.rng(91);
      // flock pings: sample bats and times
      for (let k = 0; k < 420; k++) { const i = Math.floor(R() * FLOCK_N); const t0 = 58 + R() * 12.5; const p = flockBatPos(i, t0); if (!p) continue; this.rings.push(mkRing('flock', p.x, p.y, t0, { clip: false, color: ['#ffd9a0', '#ff9a6a', '#ffb0d0', '#c9b6ff', '#ffe08a'][k % 5], bright: 0.7 + R() * 0.4, speed: 900 + R() * 600, life: 1.1, width: 50 })); }
      // Pip's and Gus's talk rings at the fork
      const pipAt = (t) => this.pipParams(t);
      for (const id of ['L15', 'L17']) { const L = line(id); const m = mouthPos('pip', pipAt(L.t)); this.rings.push(mkRing('pipW', m[0], m[1], L.t, { speed: 150, life: 1.5 })); }
      { const L = line('L16'); for (const o of onsets(L, 0.4)) { const g = gusPos(pipAt(o)); this.rings.push(mkRing('gusTalk', g[0], g[1], o)); } }
      // echoes of the colony far down the Long Throat (fading rings from the right)
      for (let k = 0; k < 18; k++) { const t0 = 69 + k * 0.62 + R() * 0.4; this.rings.push(mkRing('flock', 7200 + R() * 500, 60 + (R() - 0.5) * 300, t0, { clip: false, bright: 1.0 * (1 - k / 22), speed: 900, life: 2.0, width: 70, tau: 1.0 })); }
      // drips (one in the crack mouth so we see the quiet way)
      this.drips = [[72.4, 6480, 260], [74.2, 6760, -640], [76.0, 7000, -860]];
      for (const d of this.drips) this.rings.push(mkRing('drip', d[1], d[2], d[0]));
      ev({ t: 58, type: 'flock', dur: 12, density: 1.0, x: 0.3, x_end: 0.7, gain: 1.0, room: 'tunnel' });
      ev({ t: 58, type: 'whoosh', dur: 1.0, x: 0.1, x_end: 0.9, gain: 0.8 });
      for (const r of this.rings) if (r.kind === 'flock' && r.t0 < 70.5) { if (W.hash1(r.t0 * 13) < 0.35) ev({ t: r.t0, type: 'ping', who: 'flock', size: 0.5, x: 0.3 + W.hash1(r.t0) * 0.5, gain: 0.35, room: 'tunnel' }); }
      ev({ t: 66, type: 'wingflap', dur: 4, rate: 6, size: 0.3, x: 0.5, gain: 0.5, room: 'tunnel' });
      ev({ t: 69.5, type: 'stone_scrape', x: 0.5, gain: 0.5, room: 'tunnel' });
      ev({ t: 68.5, type: 'cave_amb', dur: 11.5, gain: 0.5 });
      for (const d of this.drips) ev({ t: d[0], type: 'drip', x: 0.55, gain: 0.45, room: 'tunnel' });
      ev({ t: 78.0, type: 'wingflap', dur: 1.6, rate: 7, size: 0.25, x: 0.6, gain: 0.5, room: 'tunnel' });
      ev({ t: 78.6, type: 'stone_scrape', x: 0.6, gain: 0.4, room: 'tunnel' });
    },
    pipParams(t) {
      // arrives last at the fork (68–70): flies in from the left, lands at (6380, 230) on the floor
      const arrive = ramp(t, 67.5, 70.0, 'outCubic');
      const p = W.along(ROOMS.tunnel.center, 0.63 + 0.12 * arrive);
      const landed = t >= 70.0;
      const go = ramp(t, 78.0, 80.0, 'inOut'); // into the crack
      let x = p[0], y = p[1] + 120 * arrive; let rot = 0.05 * (1 - arrive);
      if (go > 0) { const c = W.along(ROOMS.tunnel.crackCenter, go * 0.45); x = lerp(x, c[0], go); y = lerp(y, c[1], go); rot = -0.4 * go; }
      const lookLeft = t > 70.5 && t < 73;
      return {
        x, y, scale: 0.9, flipX: false, pose: landed && go === 0 ? 'perch' : 'fly', flap: (t * 7.5) % 1, lean: 0.1,
        eyes: { open: blink('pip', t), pupil: 0.35, lookX: lookLeft ? -0.8 : (t > 73 && t < 77 ? 0.3 : 0.7), lookY: t > 73 && t < 77 ? 0.7 : -0.3 },
        brow: -0.7, mouth: mouth('pip', t, -0.3), ears: 0.5, breath: 0.5 + 0.5 * Math.sin(t * 3), glowEyes: 0.3, rot
      };
    },
    camera(t) {
      if (t < 68.5) {
        const s = 0.02 + 0.76 * ease.inOut(ramp(t, 58, 68.5, 'linear'));
        const p = W.along(ROOMS.tunnel.center, s), d = W.alongDir(ROOMS.tunnel.center, s);
        return { x: p[0], y: p[1], zoom: 0.62 + 0.1 * Math.sin(t * 0.5), rot: -d * 0.35 };
      }
      const u = ramp(t, 68.5, 70.5);
      const base = { x: lerp(6600, 6520, u), y: lerp(-50, 60, u), zoom: lerp(0.62, 0.95, u), rot: lerp(-0.1, 0, u) };
      if (t > 72.8 && t < 77.2) { const v = ramp(t, 72.8, 73.6); return { x: lerp(base.x, 6800, v), y: lerp(base.y, -250, v), zoom: lerp(base.zoom, 0.62, v), rot: 0 }; } // look at both openings
      if (t >= 77.2) { const v = ramp(t, 77.2, 80); return { x: lerp(6800, 6750, v), y: lerp(-250, -550, v), zoom: lerp(0.62, 1.5, v), rot: 0 }; }
      return base;
    },
    render(t, frame) {
      const cam = this.camera(t);
      E.shake(cam, t, t < 68.5 ? 7 : 1.5, 8);
      E.begin(t > 69 ? '#070b0e' : '#000');
      const view = E.viewRect(cam);
      const xE = E.xE; E.applyCam(xE, cam);
      W.drawRoom(xE, ROOMS.tunnel, view, { zoom: cam.zoom });
      // flock
      if (t < 73) for (let i = 0; i < FLOCK_N; i++) { const p = flockBatPos(i, t); if (!p) continue; if (p.x < view.x0 - 100 || p.x > view.x1 + 100 || p.y < view.y0 - 100 || p.y > view.y1 + 100) continue; flockBat(xE, p.x, p.y, { scale: p.scale, rot: p.rot, flap: p.flap, tint: '#1f2733' }); }
      const pp = this.pipParams(t);
      if (t > 66.5) { drawPip(xE, pp); const g = gusPos(pp); drawGus(xE, g[0], g[1], gusParams(t, 1, { scale: 0.85, mouth: mouth('gus', t, 0.6), eyes: { open: blink('gus', t), lookX: t > 73 && t < 77 ? 0.6 : 0, lookY: -0.3 } })); }
      const xM = E.xM; E.applyCam(xM, cam);
      // the colony's massed calls make a travelling glow
      if (t < 71) { const s = 0.02 + 0.76 * ease.inOut(ramp(t, 58, 68.5, 'linear')) + 0.05; const fp = W.along(ROOMS.tunnel.center, Math.min(0.99, s)); E.drawGlow(xM, fp[0], fp[1], 1100, '#ffd7a8', 0.55 * (1 - ramp(t, 68.5, 71)), 0.1); }
      drawRings(xM, this.rings, t, ROOMS.tunnel, false);
      if (t > 66.5) { const g = gusPos(pp); E.drawGlow(xM, g[0], g[1], t > 70 ? 650 : 260, COL.gusLight, 0.85); }
      drawFronts(cam, this.rings, t, 0.35);
      // iris out on Gus's light at the end
      E.compose({ airGlow: 0.12, bloom: 0.45 });
      const iris = ramp(t, 79.0, 80.0, 'inOut');
      if (iris > 0) { const x = E.ctx; const g = gusPos(pp); const sp = E.worldToScreen(cam, g[0], g[1]); x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.fillStyle = '#000'; x.beginPath(); x.rect(0, 0, E.W, E.H); x.arc(sp[0], sp[1], lerp(1400, 0, iris), 0, 6.283, true); x.fill(); x.restore(); }
      E.post(frame, { fade: 1 - ramp(t, 58, 58.4), grain: 0.07 });
    }
  });

  // =====================================================================================
  // SCENE 3: THE QUIET WAY (80–112)
  // =====================================================================================
  scene({
    id: 'quiet_way', start: 80, end: 112,
    build() {
      this.rings = []; this.drips = [];
      this.splashes = [[96.4, 0.7], [100.2, 0.9], [103.6, 1.2], [105.2, 0.8], [108.0, 0.6], [110.0, 0.7]];
      const R = W.rng(101);
      for (let k = 0; k < 16; k++) { const t0 = 80.5 + k * 1.7 + R() * 1.2; const s = this.pipS(t0) + 0.04 + R() * 0.12; const p = W.along(ROOMS.crack.center, Math.min(0.98, s)); this.drips.push([t0, p[0] + (R() - 0.5) * 60, p[1] + 60 + R() * 60]); }
      for (const d of this.drips) this.rings.push(mkRing('drip', d[1], d[2], d[0], { bright: 0.9, speed: 420 }));
      // Gus talk rings
      for (const id of ['L18', 'L19']) { const L = line(id); for (const o of onsets(L, 0.4)) { const g = gusPos(this.pipParams(o)); this.rings.push(mkRing('gusTalk', g[0], g[1], o, { bright: 0.4 })); } }
      // splash rings as water hits
      for (const s of this.splashes) { const p = W.along(ROOMS.crack.center, this.pipS(s[0]) - 0.02); this.rings.push(mkRing('splash', p[0], p[1] + 70, s[0], { bright: 0.8 * s[1], speed: 600 })); }
      // events
      ev({ t: 80, type: 'cave_amb', dur: 32, gain: 0.6 });
      for (const d of this.drips) ev({ t: d[0], type: 'drip', x: 0.5 + (W.hash1(d[0]) - 0.5) * 0.6, gain: 0.55, room: 'crack', size: 0.8 + W.hash1(d[0] * 3) * 0.6 });
      ev({ t: 80, type: 'wingflap', dur: 8, rate: 5, size: 0.25, x: 0.5, gain: 0.35, room: 'crack' });
      ev({ t: 81.5, type: 'stone_scrape', x: 0.5, gain: 0.35, room: 'crack' });
      ev({ t: 85.0, type: 'stone_scrape', x: 0.5, gain: 0.3, room: 'crack' });
      ev({ t: 88.0, type: 'thunder', dist: 0.75, gain: 0.9 });
      ev({ t: 86.0, type: 'rain', dur: 26, gain: 0.25 });
      ev({ t: 93.0, type: 'water_rush', dur: 19, gain: 0.15, gain_end: 0.9, x: 0.6 });
      for (const s of this.splashes) ev({ t: s[0], type: s[1] > 1 ? 'wave' : 'splash', size: s[1], x: 0.5, gain: 0.8, room: 'crack' });
      ev({ t: 101.2, type: 'gus_flicker', x: 0.5, gain: 0.6 });
      ev({ t: 103.0, type: 'gus_flicker', x: 0.5, gain: 0.6 });
      ev({ t: 105.9, type: 'gus_off', x: 0.5, gain: 0.8 });
      ev({ t: 106.3, type: 'breath_in', dur: 1.0, gain: 0.5 });
      ev({ t: 107.6, type: 'breath_out', gain: 0.4 });
      ev({ t: 108.5, type: 'heartbeat', dur: 44, bpm: 92, bpm_end: 118, gain: 0.55 });
    },
    pipS(t) { return 0.03 + 0.80 * ease.inOut(clamp((t - 80) / 24, 0, 1)) ; },
    pipParams(t) {
      const s = this.pipS(t);
      const p = W.along(ROOMS.crack.center, s), d = W.alongDir(ROOMS.crack.center, s);
      const crawl = Math.sin(t * 6) * 4;
      const fear = ramp(t, 98, 106);
      const flinch = ramp(t, 88, 88.1) * (1 - ramp(t, 88.6, 90));
      const wet = Math.max(0, ...this.splashes.map(s2 => ramp(t, s2[0], s2[0] + 0.1) * (1 - ramp(t, s2[0] + 0.3, s2[0] + 1.2))));
      const stopped = t > 104;
      return {
        x: p[0] + (stopped ? 0 : crawl * 0.3), y: p[1] + 40 + (stopped ? 0 : Math.abs(crawl) * 0.5) - 20 * wet, scale: 0.9, flipX: false, pose: t > 97 ? 'crouch' : 'perch', flap: 0, lean: 0.15 + 0.1 * Math.sin(t * 3) - 0.3 * flinch,
        rot: stopped ? 0 : d * 0.5,
        eyes: { open: blink('pip', t, 1 - 0.5 * flinch - 0.3 * wet), pupil: 0.4 - 0.25 * fear - 0.1 * flinch, lookX: flinch ? 0.9 : (t > 90 && t < 93 ? -0.3 : 0.4), lookY: t > 93 ? 0.6 : -0.1 },
        brow: -0.6 - 0.4 * fear, mouth: mouth('pip', t, -0.3 - 0.4 * fear), ears: 0.5 - 0.4 * fear + 0.5 * flinch, breath: 0.5 + 0.5 * Math.sin(t * (2.5 + 2 * fear)), glowEyes: 0.35
      };
    },
    gusLit(t) {
      if (t < 101) return 1;
      const f1 = (t > 101.2 && t < 101.9) ? (0.3 + 0.7 * Math.abs(Math.sin(t * 40))) : 1;
      const f2 = (t > 103.0 && t < 103.8) ? (0.2 + 0.6 * Math.abs(Math.sin(t * 55))) : 1;
      const die = 1 - ramp(t, 105.2, 106.0, 'in');
      const spark = (t > 105.5 && t < 105.9) ? Math.abs(Math.sin(t * 90)) * 0.5 : 0;
      return clamp(Math.min(f1, f2) * die + spark, 0, 1) * (t < 106 ? 1 : 0);
    },
    camera(t) {
      const p = this.pipParams(t);
      const lead = 120 + 80 * Math.sin(t * 0.3);
      const d = W.alongDir(ROOMS.crack.center, this.pipS(t));
      const zoom = 1.35 + 0.1 * Math.sin(t * 0.21) + 0.9 * ramp(t, 104, 111);
      const thunder = ramp(t, 87.6, 88.0) * (1 - ramp(t, 89.5, 90.5));
      return { x: p.x + Math.cos(d) * lead * (1 - thunder) + 420 * thunder, y: p.y - 30 - 200 * thunder, zoom: zoom * (1 - 0.35 * thunder), rot: 0 };
    },
    render(t, frame) {
      const cam = this.camera(t);
      E.shake(cam, t, 2 + 5 * ramp(t, 94, 106), 7);
      E.begin();
      const view = E.viewRect(cam);
      const xE = E.xE; E.applyCam(xE, cam);
      W.drawRoom(xE, ROOMS.crack, view, { zoom: cam.zoom });
      const pp = this.pipParams(t);
      const lit = this.gusLit(t);
      // water rising (in the crack it's the lowest parts flooding: a level relative to the path)
      const level = (t < 93) ? 1e6 : lerp(300, -1250, ease.inOut(ramp(t, 93, 112, 'linear')));
      if (t >= 93) drawWater(xE, ROOMS.crack, t, level, 6 + 10 * ramp(t, 100, 110), view);
      for (const s of this.splashes) drawSplash(xE, pp.x - 30, pp.y + 60, s[0], t, 24, 280 * s[1]);
      drawPip(xE, pp);
      const g = gusPos(pp);
      drawGus(xE, g[0], g[1], gusParams(t, lit, { scale: 0.85, fear: ramp(t, 96, 100), mouth: mouth('gus', t, -0.2), eyes: { open: blink('gus', t) * (1 - 0.5 * ramp(t, 104, 106)), lookX: 0.3, lookY: 0.4 } }));
      // lights
      const xM = E.xM; E.applyCam(xM, cam);
      if (lit > 0) E.drawGlow(xM, g[0], g[1], 300 * (0.6 + 0.4 * lit), COL.gusLight, 0.9 * lit);
      drawRings(xM, this.rings, t, ROOMS.crack, true);
      drawFronts(cam, this.rings, t, 0.4);
      // thunder flash at 88 (far): the passage ahead is revealed for a moment
      const li = E.lightning(t, 88.0, 0.6);
      // eyes always visible
      E.applyCam(E.xT, cam);
      if (lit < 0.6) { E.xT.globalAlpha = 1 - lit; drawEyes(E.xT, Object.assign({}, pp, { glowEyes: 0.9 })); E.xT.globalAlpha = 1; }
      E.compose({ airGlow: 0.12, bloom: 0.5, flash: li.lit, whiteout: li.whiteout * 0.5 });
      E.post(frame, { fade: 1 - ramp(t, 80, 81.2), grain: 0.08 + 0.05 * ramp(t, 104, 108) });
    }
  });

  // =====================================================================================
  // SCENE 4: THE DARK (112–152)  &  SCENE 5: THE SHOUT (152–185) — the cathedral
  // =====================================================================================
  const LEDGE = { x: -2850, y: 418 };
  function flightPath() {
    return W.catmull([[-2850, 400], [-2500, 250], [-1900, 150], [-1300, -250], [-700, 100], [-200, 450], [300, 200], [700, -500], [1200, -900], [1600, -700], [2000, -1300], [2400, -1750], [2700, -2050], [2950, -2450], [3150, -2900]], false, 16);
  }
  function floodLevel(t) {
    if (t < 112) return 2300;
    return lerp(2300, 700, ease.inOut(clamp((t - 112) / 72, 0, 1)));
  }
  scene({
    id: 'dark', start: 112, end: 152,
    build() {
      this.rings = [];
      const pm = (t) => mouthPos('pip', this.pipParams(t));
      for (const id of ['L20', 'L22', 'L24']) { const L = line(id); const m = pm(L.t); this.rings.push(mkRing('pipW', m[0], m[1], L.t, { speed: 130, life: 1.6, bright: 1.0 })); }
      // the count: growing rings
      { const m = pm(141); this.rings.push(mkRing('pipS', m[0], m[1], line('L26').t, { speed: 260, life: 2.0, width: 16, bright: 1.0, maxR: 700 })); }
      { const m = pm(143); this.rings.push(mkRing('pipS', m[0], m[1], line('L27').t, { speed: 380, life: 2.2, width: 20, bright: 1.05, maxR: 1100 })); }
      { const m = pm(145); this.rings.push(mkRing('pipS', m[0], m[1], line('L28').t, { speed: 560, life: 2.6, width: 26, bright: 1.1, maxR: 1600 })); }
      // Gus's faint talk pulses (he's unlit: barely)
      for (const id of ['L21', 'L23', 'L25']) { const L = line(id); for (const o of onsets(L, 0.5)) { const g = gusPos(this.pipParams(o)); this.rings.push(mkRing('gusTalk', g[0], g[1], o, { bright: 0.22, speed: 200, life: 0.8, maxR: 160 })); } }
      // drips & water: the flood is heard (and seen) rising
      this.drips = []; const R = W.rng(121);
      for (let k = 0; k < 22; k++) { const t0 = 112.5 + k * 1.75 + R() * 1.1; if (k % 2 === 0) { const x = -3250 + R() * 700; this.drips.push([t0, x, LEDGE.y + 2 + (x < -2500 ? 0 : 200), 0.5 + R() * 0.5]); } else { const x = -3200 + R() * 5600; this.drips.push([t0, x, waterSurfaceY(x, t0, floodLevel(t0), 14) + 2, 0.6 + R() * 0.6]); } }
      for (const d of this.drips) this.rings.push(mkRing('drip', d[1], d[2], d[0], { bright: 0.75 * d[3], speed: 560, life: 1.8, maxR: 1100 }));
      this.waves = [[139.2, 1.3], [146.8, 1.0]];
      for (const wv of this.waves) { this.rings.push(mkRing('splash', -2440, 560, wv[0], { bright: 1.1, speed: 900, maxR: 2200, width: 40 })); }
      ev({ t: 112, type: 'cave_amb', dur: 40, gain: 0.5 });
      ev({ t: 112, type: 'water_rush', dur: 40, gain: 0.5, gain_end: 0.75, x: 0.5 });
      for (const d of this.drips) ev({ t: d[0], type: 'drip', x: sx({ x: 0, y: 0, zoom: 0.3 }, d[1], d[2]), gain: 0.5 * d[3], room: 'cathedral', size: 1.2 });
      ev({ t: 119.0, type: 'thunder', dist: 0.15, gain: 1.0 });
      ev({ t: 119.3, type: 'rumble', dur: 3, gain: 0.5 });
      ev({ t: 121.0, type: 'breath_out', gain: 0.35 });
      for (const wv of this.waves) ev({ t: wv[0], type: 'wave', size: wv[1], x: 0.55, gain: 0.9, room: 'cathedral' });
      ev({ t: 147.0, type: 'breath_in', dur: 2.6, gain: 0.8 });
      ev({ t: 150.0, type: 'breath_in', dur: 1.8, gain: 0.9 });
      ev({ t: 112.0, type: 'rain', dur: 40, gain: 0.12 });
    },
    pipParams(t) {
      const resolve = ramp(t, 145.4, 147.5);
      const inhale = ramp(t, 147, 151.8, 'inOut');
      const shiver = (1 - resolve) * Math.sin(t * 22) * 1.5 * ramp(t, 112, 116);
      const count = Math.max(ramp(t, 141, 141.2) * (1 - ramp(t, 141.6, 142.5)), ramp(t, 143.2, 143.4) * (1 - ramp(t, 143.8, 144.6)), ramp(t, 145.4, 145.6) * (1 - ramp(t, 146.2, 147.2)));
      const eyesClosed = ramp(t, 147.5, 148.5) * (1 - ramp(t, 150.9, 151.3, 'in'));
      return {
        x: LEDGE.x + shiver, y: LEDGE.y, scale: 0.9, flipX: false, pose: t < 145 ? 'crouch' : 'perch', flap: 0, lean: -0.2 + 0.5 * inhale + 0.15 * count,
        eyes: { open: blink('pip', t, 1 - eyesClosed), pupil: 0.2 + 0.25 * resolve + 0.2 * inhale, lookX: t > 119 && t < 122.5 ? 0.9 : (t > 126 && t < 140 ? 0.1 : 0.5), lookY: t > 119 && t < 122.5 ? -0.9 : (t > 132 && t < 140 ? 0.7 : -0.2) },
        brow: -1 + 1.6 * resolve + 0.4 * inhale, mouth: inhale > 0.1 ? { viseme: 'O', open: 0.3 + 0.6 * inhale, smile: 0 } : mouth('pip', t, -0.5 + 0.6 * resolve),
        ears: 0.1 + 0.7 * resolve + 0.3 * inhale, breath: 0.4 + 0.6 * Math.sin(t * 4) * (1 - inhale) + inhale, glowEyes: 0.9, rot: 0
      };
    },
    camera(t) {
      if (t < 118.6) return { x: LEDGE.x + 40, y: LEDGE.y - 40, zoom: 2.6 - 0.2 * ramp(t, 112, 118.6, 'linear'), rot: 0 };
      if (t < 121.6) return { x: 0, y: -450, zoom: 0.28, rot: 0 }; // the flash shows everything
      if (t < 141) return { x: LEDGE.x + 30, y: LEDGE.y - 45, zoom: 2.3 + 0.15 * ramp(t, 121.6, 141, 'linear'), rot: 0 };
      // the count: step back a little each number, then push in hard for the inhale
      const z = E.track(t, [[141, 2.2], [143, 1.9], [145, 1.6], [147, 1.4], [152, 3.2, 'inCubic']]);
      return { x: LEDGE.x + 20, y: LEDGE.y - 40 - 10 * ramp(t, 147, 152), zoom: z, rot: 0 };
    },
    render(t, frame) {
      const cam = this.camera(t);
      E.shake(cam, t, 1 + 3 * ramp(t, 118.9, 119.2) * (1 - ramp(t, 120, 121.5)) + 2.5 * ramp(t, 147, 152), 8);
      E.begin();
      const view = E.viewRect(cam);
      const xE = E.xE; E.applyCam(xE, cam);
      W.drawRoom(xE, ROOMS.cathedral, view, { zoom: cam.zoom });
      drawWater(xE, ROOMS.cathedral, t, floodLevel(t), 14 + 10 * ramp(t, 130, 150), view);
      for (const wv of this.waves) drawSplash(xE, -2440, 560, wv[0], t, 40, 520 * wv[1]);
      const pp = this.pipParams(t);
      drawPip(xE, pp);
      const g = gusPos(pp);
      drawGus(xE, g[0], g[1], gusParams(t, 0.06 + 0.04 * Math.sin(t * 2), { scale: 0.85, fear: 0.6, mouth: mouth('gus', t, 0.1), eyes: { open: blink('gus', t), lookX: 0.2, lookY: -0.6 } }));
      // moon glimmer at the exit crack (hope)
      const ex = ROOMS.cathedral.exitCenter; const ep = W.along(ex, 0.15);
      const xM = E.xM; E.applyCam(xM, cam);
      E.drawGlow(xM, ep[0], ep[1], 520, COL.moon, 0.22 + 0.05 * Math.sin(t * 0.7), 0.1);
      // the faintest memory of light around Pip, so her face can act in the dark
      { const h = C().headAnchor(Object.assign({ kind: 'pip' }, pp)); E.drawGlow(xM, pp.x + h.x, pp.y + h.y, 150, '#9fc4e8', 0.16 + 0.05 * Math.sin(t * 1.1) + 0.3 * ramp(t, 147, 152), 0.3); }
      drawRings(xM, this.rings, t, ROOMS.cathedral, true);
      drawFronts(cam, this.rings, t, 0.5);
      const li = E.lightning(t, 119.0, 1.0);
      E.applyCam(E.xT, cam);
      drawEyes(E.xT, Object.assign({}, pp, { glowEyes: 0.95 }));
      E.compose({ airGlow: 0.1, bloom: 0.5, flash: li.lit, whiteout: li.whiteout });
      E.post(frame, { grain: 0.1, vignette: 0.7 });
    }
  });

  scene({
    id: 'shout', start: 152, end: 185,
    build() {
      this.path = flightPath();
      this.rings = [];
      const m = mouthPos('pip', SCENES[4].pipParams(151.9));
      this.big = mkRing('pipBig', m[0], m[1], 152.0, { life: 14, tau: 4.5 });
      this.rings.push(this.big);
      // flight calls: accelerating strobe
      let tt = 158.4; const R = W.rng(151); let k = 0;
      while (tt < 183.2) { const p = this.pipParams(tt); const mp = mouthPos('pip', p); const gap = tt < 165 ? 0.3 : (tt < 175 ? 0.2 : 0.14); this.rings.push(mkRing('pipFlight', mp[0], mp[1], tt, { bright: 0.9 + 0.2 * R(), life: 1.0 + 0.3 * R(), maxR: 1300 })); if (k % 2 === 0) ev({ t: tt, type: 'ping', who: 'pip', size: 0.9, x: 0.5, gain: 0.55, room: 'cathedral' }); tt += gap + R() * 0.05; k++; }
      // rockfall at 163.6 (thunder 163.4): rocks fall from the ceiling near column 2
      this.rocks = []; for (let i = 0; i < 9; i++) this.rocks.push({ x: 700 + R() * 500, y: -2000 + R() * 200, t0: 163.5 + R() * 0.5, vx: (R() - 0.5) * 150, r: 14 + R() * 30, rot: R() * 6 });
      for (const r of this.rocks) this.rings.push(mkRing('splash', r.x + r.vx * 1.4, floodLevel(r.t0 + 1.4), r.t0 + 1.35 + W.hash1(r.x) * 0.3, { bright: 0.7, speed: 700, maxR: 1000 }));
      // Gus relights at 170
      { const L = line('L30'); for (const o of onsets(L, 0.3)) { const g = gusPos(this.pipParams(o)); this.rings.push(mkRing('gusTalk', g[0], g[1], o, { bright: 0.6, speed: 400, maxR: 400 })); } }
      // events
      ev({ t: 152.0, type: 'shout', size: 1.0, x: 0.5, gain: 1.0, room: 'cathedral' });
      ev({ t: 152.0, type: 'rumble', dur: 4, gain: 0.5 });
      ev({ t: 152, type: 'water_rush', dur: 33, gain: 0.6, gain_end: 0.9, x: 0.5 });
      ev({ t: 158.0, type: 'wingflap', dur: 25.5, rate: 7.5, size: 0.3, x: 0.5, gain: 0.7, room: 'cathedral' });
      ev({ t: 158.0, type: 'whoosh', dur: 1.2, x: 0.3, x_end: 0.7, gain: 0.7 });
      ev({ t: 163.4, type: 'thunder', dist: 0.3, gain: 0.9 });
      ev({ t: 163.8, type: 'rockfall', x: 0.6, gain: 0.9, room: 'cathedral' });
      ev({ t: 165.0, type: 'splash', size: 1.5, x: 0.6, gain: 0.8, room: 'cathedral' });
      ev({ t: 170.0, type: 'gus_on', x: 0.5, gain: 0.8, room: 'cathedral' });
      ev({ t: 176.0, type: 'whoosh', dur: 0.5, x: 0.7, x_end: 0.2, gain: 0.8 });
      ev({ t: 176.3, type: 'stone_scrape', x: 0.5, gain: 0.5, room: 'cathedral' });
      ev({ t: 179.0, type: 'whoosh', dur: 0.6, x: 0.2, x_end: 0.8, gain: 0.7 });
      ev({ t: 180.0, type: 'wind', dur: 5, gain: 0.0, gain_end: 0.6 });
      ev({ t: 183.4, type: 'crack_burst', x: 0.5, gain: 1.0, room: 'cathedral' });
      ev({ t: 152.0, type: 'rain', dur: 33, gain: 0.15 });
    },
    flightS(t) { return ease.inOut(clamp((t - 158) / 25.4, 0, 1)) * 0.995; },
    pipParams(t) {
      if (t < 158) {
        const base = SCENES[4].pipParams(151.9);
        const shout = ramp(t, 152, 152.08) * (1 - ramp(t, 154.2, 154.9));
        const settle = ramp(t, 154.5, 156);
        const leap = ramp(t, 157.2, 158, 'inCubic');
        return Object.assign(base, {
          lean: 0.6 * shout - 0.1 * settle, pose: leap > 0 ? 'fly' : 'perch', flap: (t * 8) % 1, y: base.y - 40 * leap, x: base.x + 60 * leap,
          eyes: { open: 1 - 0.75 * shout, pupil: 0.5 + 0.2 * settle, lookX: 0.6, lookY: settle ? -0.5 : 0 }, brow: 1 - 0.4 * settle,
          mouth: shout > 0 ? { viseme: 'A', open: 1, smile: 0.2 } : (settle ? { viseme: 'rest', open: 0, smile: 0.9 } : mouth('pip', t, 0.6)), ears: 1, breath: 1, glowEyes: 0.6, rot: -0.2 * leap
        });
      }
      const s = this.flightS(t);
      const p = W.along(this.path, s), d = W.alongDir(this.path, s);
      const bank = Math.sin(t * 2.3) * 0.15;
      const dodge = ramp(t, 175.8, 176.2) * (1 - ramp(t, 176.6, 177.4));
      return {
        x: p[0], y: p[1] - 25 * dodge, scale: 0.9, flipX: false, pose: 'fly', flap: (t * 8.5) % 1, lean: 0.3, rot: d + bank - 0.6 * dodge,
        eyes: { open: blink('pip', t, 1 - 0.3 * dodge), pupil: 0.55, lookX: 0.8, lookY: -0.4 }, brow: 0.7, mouth: speaking('pip', t) ? mouth('pip', t, 0.5) : { viseme: ((t * 3.3) % 1) < 0.35 ? 'A' : 'rest', open: 0.7, smile: 0.4 },
        ears: 1, breath: 1, glowEyes: 0.6
      };
    },
    camera(t) {
      if (t < 158) {
        // pull back with the ring
        const z = E.track(t, [[152, 3.2], [152.6, 1.8, 'outCubic'], [158, 0.32, 'inOut']]);
        const c = E.track(t, [[152, [LEDGE.x + 20, LEDGE.y - 50]], [158, [-700, -250], 'in']]);
        return { x: c[0], y: c[1], zoom: z, rot: 0 };
      }
      const s = this.flightS(t);
      const p = W.along(this.path, Math.min(0.999, s + 0.03)), d = W.alongDir(this.path, s);
      const z = E.track(t, [[158, 0.32], [160.5, 1.1, 'inOut'], [175, 1.2], [176, 1.45, 'outCubic'], [178, 1.1], [183, 1.3], [185, 2.6, 'inCubic']]);
      return { x: p[0], y: p[1], zoom: z, rot: -d * 0.25 };
    },
    render(t, frame) {
      const cam = this.camera(t);
      E.shake(cam, t, 10 * ramp(t, 152, 152.05) * (1 - ramp(t, 153.5, 155)) + 2.5 + 4 * ramp(t, 163.4, 163.5) * (1 - ramp(t, 164.5, 165.5)), 10);
      E.begin(t >= 152 ? COL.ambCath : '#000');
      const view = E.viewRect(cam);
      const xE = E.xE; E.applyCam(xE, cam);
      W.drawRoom(xE, ROOMS.cathedral, view, { zoom: cam.zoom });
      drawWater(xE, ROOMS.cathedral, t, floodLevel(t), 24, view);
      // falling rocks
      for (const r of this.rocks) { const a = t - r.t0; if (a < 0 || a > 1.5) continue; const x = r.x + r.vx * a, y = r.y + 1300 * a * a; if (y > floodLevel(t)) continue; xE.save(); xE.translate(x, y); xE.rotate(r.rot + a * 3); xE.fillStyle = '#1a2029'; xE.strokeStyle = '#c6e3f0'; xE.lineWidth = 2; xE.beginPath(); xE.moveTo(-r.r, 0); xE.lineTo(-r.r * 0.3, -r.r); xE.lineTo(r.r * 0.8, -r.r * 0.5); xE.lineTo(r.r, r.r * 0.4); xE.lineTo(0, r.r); xE.closePath(); xE.fill(); xE.stroke(); xE.restore(); }
      for (const r of this.rocks) drawSplash(xE, r.x + r.vx * 1.4, floodLevel(r.t0 + 1.4), r.t0 + 1.35 + W.hash1(r.x) * 0.3, t, 16, 300);
      const pp = this.pipParams(t);
      drawPip(xE, pp);
      const g = gusPos(pp);
      const gusLit = ramp(t, 169.9, 170.3, 'outBack') ;
      drawGus(xE, g[0], g[1], gusParams(t, 0.05 + 0.95 * gusLit, { scale: 0.85, fear: 0.3 * (1 - gusLit), mouth: mouth('gus', t, 0.8), eyes: { open: blink('gus', t), lookX: 0.6, lookY: -0.5 }, wiggle: (t * 2.5) % 1 }));
      // lights
      const xM = E.xM; E.applyCam(xM, cam);
      const ex = ROOMS.cathedral.exitCenter; const ep = W.along(ex, 0.15);
      E.drawGlow(xM, ep[0], ep[1], 520 + 1200 * ramp(t, 178, 185), COL.moon, 0.25 + 0.6 * ramp(t, 178, 185), 0.1);
      if (gusLit > 0) E.drawGlow(xM, g[0], g[1], 280, COL.gusLight, 0.85 * gusLit);
      drawRings(xM, this.rings, t, ROOMS.cathedral, true);
      drawFronts(cam, this.rings, t, 0.55);
      const li = E.lightning(t, 163.4, 0.8);
      E.applyCam(E.xT, cam);
      drawEyes(E.xT, Object.assign({}, pp, { glowEyes: 0.5 }));
      const swept = ramp(t, 152.25, 153.6, 'out') * (t < 158 ? 1 : Math.exp(-(t - 158) / 3.5));
      E.compose({ airGlow: 0.04, bloom: 0.45 + 0.25 * ramp(t, 152, 152.1) * (1 - ramp(t, 153, 156)), flash: Math.max(li.lit, 0.7 * swept), whiteout: li.whiteout });
      const ab = 14 * ramp(t, 152, 152.05) * (1 - ramp(t, 152.6, 153.8));
      E.post(frame, { grain: 0.08, aberration: ab, fade: ramp(t, 183.6, 185, 'in'), fadeColor: '#eef6ff' });
    }
  });

  // =====================================================================================
  // SCENE 6: THE SKY (185–222)
  // =====================================================================================
  scene({
    id: 'sky', start: 185, end: 222,
    build() {
      this.moon = [1500, -1050];
      this.hello = { x: 0, y: 0, t0: line('L34').t, speed: 1700, bright: 1.7, tau: 3.0, width: 120 };
      const p = this.pipParams(this.hello.t0); const m = mouthPos('pip', p); this.hello.x = m[0]; this.hello.y = m[1];
      // 2D rings for the near plane (the HELLO on the cliff) drawn with the engine too
      this.rings = [mkRing('pipBig', this.hello.x, this.hello.y, this.hello.t0, { speed: 1700, life: 9, bright: 0.9, width: 120, clip: false, frontOnly: true })];
      for (const id of ['L31', 'L33', 'L35']) { const L = line(id); for (const o of onsets(L, 0.5)) { const np = this.nanParams(o); const mm = mouthPos('nan', np); this.rings.push(mkRing('nan', mm[0], mm[1], o, { bright: 0.35, life: 2.0, clip: false, speed: 700 })); } }
      ev({ t: 185, type: 'wind', dur: 37, gain: 0.5, gain_end: 0.4 });
      ev({ t: 185, type: 'rain', dur: 6, gain: 0.1 });
      ev({ t: 185.2, type: 'wingflap', dur: 6, rate: 6, size: 0.3, x: 0.4, gain: 0.5, room: 'sky' });
      ev({ t: 187.5, type: 'flock', dur: 12, density: 0.5, x: 0.8, x_end: 0.6, gain: 0.45, room: 'sky' });
      ev({ t: 192.0, type: 'swoosh_wing', x: 0.7, gain: 0.7, room: 'sky' });
      ev({ t: 192.2, type: 'wingflap', dur: 3, rate: 4, size: 1.0, x: 0.65, gain: 0.5, room: 'sky' });
      ev({ t: 204.3, type: 'breath_in', dur: 0.7, gain: 0.6 });
      ev({ t: 205.0, type: 'shout', size: 0.8, x: 0.5, gain: 0.9, room: 'sky' });
      ev({ t: 221.0, type: 'wind', dur: 1.0, gain: 0.3, gain_end: 0.0 });
    },
    pipParams(t) {
      // bursts out of the mouth at (-300,50) heading right and up; tumbles, then glides
      const burst = ramp(t, 185, 188.5, 'outCubic');
      const tumble = Math.sin(t * 5) * 0.5 * (1 - ramp(t, 186.5, 188.5));
      let x = lerp(-280, 700, burst), y = lerp(40, -350, burst);
      // glide loop 188.5–204: slow drift right with gentle bob
      const g = clamp((t - 188.5) / 16, 0, 1);
      x += 500 * g + Math.sin(t * 0.7) * 30; y += -80 * g + Math.sin(t * 1.3) * 25;
      // after HELLO: drift up toward the moon slowly
      const up = ramp(t, 208, 222, 'linear'); x += 700 * up; y -= 400 * up;
      const shout = ramp(t, 205, 205.08) * (1 - ramp(t, 206.5, 207.2));
      const grin = ramp(t, 200.5, 202);
      const awe = ramp(t, 186, 189) * (1 - ramp(t, 199, 201));
      return {
        x, y, scale: 0.9, flipX: false, pose: t < 188.5 ? 'fly' : (speaking('pip', t) || t > 205 && t < 207 ? 'glide' : 'glide'), flap: (t * 6.5) % 1, rot: -0.15 + tumble + 0.1 * Math.sin(t * 0.9) - 0.3 * shout,
        lean: 0.2 + 0.5 * shout,
        eyes: { open: blink('pip', t, 1 - 0.8 * shout), pupil: 0.55 + 0.3 * awe, lookX: t > 192 && t < 200.5 ? 0.85 : (t > 202 && t < 204.8 ? 0.2 : 0.4), lookY: t > 202 && t < 204.8 ? 0.8 : (awe ? -0.6 : -0.1) },
        brow: 0.2 + 0.4 * grin - 0.3 * awe,
        mouth: shout > 0 ? { viseme: 'A', open: 1, smile: 0.4 } : (speaking('pip', t) ? mouth('pip', t, 0.5) : { viseme: awe ? 'O' : 'rest', open: awe * 0.5, smile: 0.3 + 0.7 * grin }),
        ears: 0.8 + 0.2 * grin, breath: 0.5 + 0.5 * Math.sin(t * 2), glowEyes: 0.1
      };
    },
    nanParams(t) {
      const pp = this.pipParams(t);
      const arrive = ramp(t, 190.5, 193.0, 'outCubic');
      const x = lerp(pp.x + 900, pp.x + 230, arrive), y = lerp(pp.y - 500, pp.y - 40, arrive);
      return {
        x, y, scale: 1.15, flipX: false, pose: arrive < 1 ? 'fly' : 'glide', flap: (t * 4.5) % 1, rot: -0.1 + 0.05 * Math.sin(t * 0.8) - 0.3 * (1 - arrive), lean: 0.1,
        eyes: { open: blink('nan', t, 0.75), pupil: 0.5, lookX: -0.8, lookY: 0.2 }, brow: t > 198 && t < 202 ? -0.2 : 0.1, mouth: mouth('nan', t, 0.6), ears: 0.7, breath: 0.5, glowEyes: 0.05
      };
    },
    camera(t) {
      const pp = this.pipParams(t);
      if (t < 192) { const u = ramp(t, 185, 190); return { x: lerp(-100, pp.x + 300, u), y: lerp(-100, pp.y - 150, u), zoom: lerp(1.4, 0.75, u), rot: 0 }; }
      if (t < 202.3) { const np = this.nanParams(t); return { x: (pp.x + np.x) / 2 + 60, y: (pp.y + np.y) / 2 - 20, zoom: 1.25 - 0.05 * ramp(t, 192, 202), rot: 0 }; }
      if (t < 204.6) { const u = ramp(t, 202.3, 204.6); return { x: lerp(pp.x + 120, 1200, u), y: lerp(pp.y, 500, u), zoom: lerp(1.2, 0.42, u), rot: 0 }; }
      if (t < 215.5) return { x: 1200 + 150 * ramp(t, 204.6, 215.5, 'linear'), y: 500, zoom: 0.42 - 0.03 * ramp(t, 204.6, 215.5, 'linear'), rot: 0 };
      const u = ramp(t, 215.5, 217.5); const np = this.nanParams(t);
      return { x: lerp(1350, (pp.x + np.x) / 2 + 100, u), y: lerp(500, (pp.y + np.y) / 2 - 60, u), zoom: lerp(0.39, 0.9, u) - 0.2 * ramp(t, 217.5, 222, 'linear'), rot: 0 };
    },
    render(t, frame) {
      const cam = this.camera(t);
      E.shake(cam, t, 1.5, 5);
      const x = E.ctx;
      // shader sky
      window.SKY.render(t, cam, this.hello, this.moon, 0);
      x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.filter = 'none';
      x.imageSmoothingEnabled = true; x.drawImage(window.SKY.canvas, 0, 0, E.W, E.H);
      // colony wheeling far away around the moon (depth 3)
      E.applyCam(x, cam, 3);
      for (let i = 0; i < 160; i++) { const h = W.hash1(i * 2.1), h2 = W.hash1(i * 4.7); const a = t * (0.25 + h * 0.2) + h2 * 6.28; const rx = 900 + h * 700, ry = 350 + h2 * 300; const bx = 3200 + Math.cos(a) * rx, by = -2200 + Math.sin(a) * ry + Math.sin(t + i) * 30; flockBat(x, bx, by, { scale: 0.5 + h * 0.4, rot: a + Math.PI / 2 + Math.sin(t * 2 + i) * 0.2, flap: (t * (5 + h * 3) + h2) % 1, tint: '#0a0e1a' }); }
      // the cliff and cave mouth (main plane)
      E.applyCam(x, cam);
      x.fillStyle = '#0b0f1a'; x.beginPath(); W.polyPath(x, ROOMS.sky.cliff); x.fill();
      x.strokeStyle = 'rgba(150,175,210,0.45)'; x.lineWidth = 3; x.stroke();
      x.fillStyle = '#02030a'; x.beginPath(); W.polyPath(x, ROOMS.sky.mouth); x.fill();
      // Pip & Nan
      const pp = this.pipParams(t), np = this.nanParams(t);
      if (t > 190.5) drawBat(x, 'nan', np);
      drawPip(x, pp);
      const g = gusPos(pp); drawGus(x, g[0], g[1], gusParams(t, 1, { scale: 0.85, mouth: mouth('gus', t, 0.9), eyes: { open: blink('gus', t), lookX: 0.3, lookY: -0.6 } }));
      // moonlight tint + rings in air on 2D layer (into T via lighter)
      E.xT.setTransform(1, 0, 0, 1, 0, 0); E.xT.clearRect(0, 0, E.W, E.H);
      E.applyCam(E.xT, cam); E.xT.globalCompositeOperation = 'lighter';
      for (const r of this.rings) if (t >= r.t0 && t <= r.t0 + r.life) { if (r.frontOnly) E.drawRingFront(E.xT, r, t, 0.7); else E.drawRing(E.xT, r, t); }
      E.xT.globalCompositeOperation = 'source-over';
      const gl = E.worldToScreen(cam, g[0], g[1]);
      E.xT.setTransform(1, 0, 0, 1, 0, 0); E.xT.globalCompositeOperation = 'lighter'; E.drawGlow(E.xT, gl[0], gl[1], 90 * cam.zoom, COL.gus, 0.5); E.xT.globalCompositeOperation = 'source-over';
      E.composeLit({ bloom: 0.35, bloomRadius: 7 });
      // fade from white at the start, to black at the end
      E.post(frame, { grain: 0.06, vignette: 0.5, fade: Math.max(1 - ramp(t, 185, 187.5, 'out'), ramp(t, 219.5, 222)), fadeColor: t < 200 ? '#eef6ff' : '#000' });
    }
  });

  // =====================================================================================
  // SCENE 7: CREDITS (222–240)
  // =====================================================================================
  scene({
    id: 'credits', start: 222, end: 240,
    build() {
      this.rings = [];
      const R = W.rng(171);
      for (let k = 0; k < 7; k++) this.rings.push(mkRing('pipW', (R() - 0.5) * 1600, (R() - 0.5) * 700, 223 + k * 2.1 + R(), { speed: 260, life: 4, bright: 0.5, width: 30, maxR: 2000, clip: false, color: [COL.pip, COL.nan, COL.gus, COL.drip][k % 4] }));
      ev({ t: 223, type: 'cave_amb', dur: 16, gain: 0.3 });
      for (const r of this.rings) ev({ t: r.t0, type: 'drip', x: 0.5 + r.x / 3000, gain: 0.3, room: 'cathedral', size: 1.4 });
    },
    render(t, frame) {
      E.begin();
      const cam = { x: 0, y: 0, zoom: 1, rot: 0 };
      // a blank "sonar screen" with faint rings
      E.xE.fillStyle = '#0a0d14'; E.xE.fillRect(0, 0, E.W, E.H);
      E.applyCam(E.xM, cam);
      drawRings(E.xM, this.rings, t, null, false);
      drawFronts(cam, this.rings, t, 0.4);
      E.compose({ airGlow: 0.3, bloom: 0.3 });
      const x = E.ctx;
      const items = [
        [222.5, 'PIPSQUEAK', '110px Lilita', 0],
        [225.5, 'written, directed and animated by', '400 30px Nunito', 1],
        [226.0, 'Claude', '700 54px Nunito', 2],
        [229.5, 'voices performed by', '400 30px Nunito', 1],
        [230.0, 'Kokoro TTS  ·  Pip, Nan, Gus, Tobi & Mira', '700 40px Nunito', 2],
        [233.0, 'score composed in Python  ·  performed by FluidSynth', '400 30px Nunito', 1],
        [233.5, 'every frame painted by sound', '700 40px Nunito', 2],
      ];
      for (const it of items) {
        const [t0, str, font, slot] = it;
        const a = ramp(t, t0, t0 + 1.2) * (1 - ramp(t, t0 + (slot === 0 ? 3.2 : 2.6), t0 + (slot === 0 ? 4.0 : 3.4)));
        if (a <= 0) continue;
        const y = slot === 0 ? E.H / 2 : (slot === 1 ? E.H / 2 - 40 : E.H / 2 + 30);
        E.text(x, str, E.W / 2, y, { font, color: '#dbe9f7', alpha: a, glow: '#7fc8ff', glowBlur: slot === 0 ? 40 : 12 });
      }
      E.post(frame, { grain: 0.06, fade: ramp(t, 238.5, 240) });
    }
  });

  // =====================================================================================
  // master
  // =====================================================================================
  let built = false;
  const origInit = S.init;
  S.init = function (data) { buildRooms(); origInit(data); built = true; };
  S.renderFrame = function (i) {
    const t = i / 24;
    let sc = SCENES[SCENES.length - 1];
    for (const s of SCENES) if (t >= s.start && t < s.end) { sc = s; break; }
    sc.render(t, i);
  };
  S.SCENES = SCENES; S.ROOMS = ROOMS;
})();
