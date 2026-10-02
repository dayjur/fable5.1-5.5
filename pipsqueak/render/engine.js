// engine.js — compositor (sound-reveal lighting), camera, post-processing, tween utilities.
(function () {
  'use strict';
  const E = {};
  window.ENGINE = E;
  E.W = 1920; E.H = 1080; E.PIC_Y0 = 60; E.PIC_H = 960; E.FPS = 24;

  // ---------- easing / tracks ----------
  const ease = {
    linear: t => t,
    inOut: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
    inOutCubic: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    out: t => 1 - (1 - t) * (1 - t),
    outCubic: t => 1 - Math.pow(1 - t, 3),
    outQuart: t => 1 - Math.pow(1 - t, 4),
    in: t => t * t,
    inCubic: t => t * t * t,
    outBack: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    outElastic: t => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1,
    smooth: t => t * t * (3 - 2 * t),
  };
  E.ease = ease;
  E.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  E.lerp = (a, b, t) => a + (b - a) * t;
  // map t in [t0,t1] → [0,1] with easing
  E.ramp = (t, t0, t1, fn) => { const u = E.clamp((t - t0) / (t1 - t0), 0, 1); if (typeof fn === 'string') fn = ease[fn]; return (fn || ease.inOut)(u); };
  // keyframe track: keys = [[t, value, easeName?], ...] sorted by t; value number or array
  E.track = function (t, keys, defEase) {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (t >= a[0] && t < b[0]) {
        const fn = ease[b[2] || defEase || 'inOut'] || ease.inOut;
        const u = fn((t - a[0]) / (b[0] - a[0]));
        if (Array.isArray(a[1])) return a[1].map((v, k) => v + (b[1][k] - v) * u);
        return a[1] + (b[1] - a[1]) * u;
      }
    }
    return keys[keys.length - 1][1];
  };
  // step track: returns value of the last key with time <= t
  E.step = function (t, keys) { let v = keys[0][1]; for (const k of keys) { if (t >= k[0]) v = k[1]; else break; } return v; };
  // deterministic noise for camera shake etc.
  E.noise1 = (x, seed) => window.WORLD.fbm(x, seed || 0, 3);
  E.hex2rgb = function (h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  E.rgba = (h, a) => { const c = E.hex2rgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };

  // ---------- canvases ----------
  E.init = function (mainCanvas) {
    E.main = mainCanvas; E.main.width = E.W; E.main.height = E.H;
    E.ctx = E.main.getContext('2d');
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    E.cE = mk(E.W, E.H); E.xE = E.cE.getContext('2d');     // geometry/colour layer
    E.cM = mk(E.W, E.H); E.xM = E.cM.getContext('2d');     // light mask
    E.cT = mk(E.W, E.H); E.xT = E.cT.getContext('2d');     // top layer (eyes, gus, ui)
    E.cS = mk(E.W / 4, E.H / 4); E.xS = E.cS.getContext('2d'); // small for bloom
    E.cS2 = mk(E.W / 4, E.H / 4); E.xS2 = E.cS2.getContext('2d');
    E.cP = mk(E.W, E.H); E.xP = E.cP.getContext('2d');     // post scratch
    // grain tiles
    E.grain = [];
    for (let g = 0; g < 6; g++) {
      const c = mk(512, 512), x = c.getContext('2d'); const img = x.createImageData(512, 512); const d = img.data;
      const R = window.WORLD.rng(1000 + g);
      for (let i = 0; i < 512 * 512; i++) { const v = 128 + (R() - 0.5) * 2 * 70; d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
      x.putImageData(img, 0, 0); E.grain.push(c);
    }
  };

  // ---------- camera ----------
  // cam = {x, y, zoom, rot, shake}
  E.applyCam = function (ctx, cam, depth) {
    depth = depth || 1; // 1 = main plane; 2 = twice as far
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(E.W / 2, E.H / 2 + (cam.oy || 0));
    ctx.rotate(cam.rot || 0);
    const z = cam.zoom / depth;
    ctx.scale(z, z);
    ctx.translate(-cam.x + (cam.sx || 0), -cam.y + (cam.sy || 0));
  };
  E.viewRect = function (cam, depth) {
    depth = depth || 1; const z = cam.zoom / depth;
    const hw = E.W / 2 / z, hh = E.H / 2 / z;
    const diag = Math.hypot(hw, hh) * (cam.rot ? 1 : 0) ;
    return { x0: cam.x - hw - diag, y0: cam.y - hh - diag, x1: cam.x + hw + diag, y1: cam.y + hh + diag };
  };
  E.worldToScreen = function (cam, x, y, depth) {
    depth = depth || 1; const z = cam.zoom / depth;
    let dx = (x - cam.x + (cam.sx || 0)) * z, dy = (y - cam.y + (cam.sy || 0)) * z;
    const r = cam.rot || 0; if (r) { const c = Math.cos(r), s = Math.sin(r); const nx = dx * c - dy * s, ny = dx * s + dy * c; dx = nx; dy = ny; }
    return [E.W / 2 + dx, E.H / 2 + (cam.oy || 0) + dy];
  };
  E.shake = function (cam, t, amp, freq, seed) {
    cam.sx = E.noise1(t * (freq || 9), 3 + (seed || 0)) * 2 * amp;
    cam.sy = E.noise1(t * (freq || 9), 17 + (seed || 0)) * 2 * amp;
    return cam;
  };

  // ---------- lights (drawn into the mask, world transform applied by caller) ----------
  // ring: {x,y, t0, color, speed, life, width, bright, glow, vis (polygon|null), maxR}
  // intensity model: a point at distance d was swept at time d/speed; memory decays with tau; band at the front.
  E.drawRing = function (ctx, ring, t) {
    const age = t - ring.t0; if (age < 0 || age > ring.life) return;
    const r = ring.speed * age; if (r < 1) return;
    const env = Math.exp(-age / (ring.life * 0.45)) * (1 - Math.pow(age / ring.life, 6));
    const B = ring.bright * env;
    const tau = ring.tau || (ring.life * 0.3);
    const w = ring.width;
    const col = ring.color;
    const g = ctx.createRadialGradient(ring.x, ring.y, 0, ring.x, ring.y, r + w);
    const glow = ring.glow == null ? 0.55 : ring.glow;
    // afterglow stops (memory decay from centre to the front)
    const stops = [1, 0.75, 0.5, 0.3, 0.16, 0.07, 0.02];
    for (const k of stops) {
      const d = r * (1 - k); const dt = age - d / ring.speed; const a = B * glow * Math.exp(-dt / tau);
      g.addColorStop(E.clamp(d / (r + w), 0, 1), E.rgba(col, E.clamp(a, 0, 1)));
    }
    g.addColorStop(E.clamp(r / (r + w), 0, 1), E.rgba(col, E.clamp(B, 0, 1)));
    g.addColorStop(E.clamp((r + w * 0.35) / (r + w), 0, 1), E.rgba(col, E.clamp(B * 0.6, 0, 1)));
    g.addColorStop(1, E.rgba(col, 0));
    ctx.save();
    if (ring.vis) { ctx.beginPath(); window.WORLD.polyPath(ctx, ring.vis); ctx.clip(); }
    ctx.fillStyle = g;
    ctx.fillRect(ring.x - r - w, ring.y - r - w, 2 * (r + w), 2 * (r + w));
    ctx.restore();
  };
  // thin wavefront line of a ring (drawn additively on the top layer)
  E.drawRingFront = function (ctx, ring, t, alphaMul) {
    const age = t - ring.t0; if (age < 0 || age > ring.life) return;
    const r = ring.speed * age; if (r < 2) return;
    const env = Math.exp(-age / (ring.life * 0.35));
    const a = E.clamp(ring.bright * env * (alphaMul == null ? 0.5 : alphaMul), 0, 1);
    if (a < 0.01) return;
    ctx.save();
    if (ring.vis) { ctx.beginPath(); window.WORLD.polyPath(ctx, ring.vis); ctx.clip(); }
    ctx.strokeStyle = E.rgba(ring.color, a); ctx.lineWidth = Math.max(1.5, ring.width * 0.12);
    ctx.beginPath(); ctx.arc(ring.x, ring.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  };
  // steady radial light (Gus, fungus, moon leak): {x,y,r,color,a}
  E.drawGlow = function (ctx, x, y, r, color, a, inner) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, E.rgba(color, a)); g.addColorStop(inner || 0.25, E.rgba(color, a * 0.8)); g.addColorStop(0.6, E.rgba(color, a * 0.3)); g.addColorStop(1, E.rgba(color, 0));
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  };
  // thunder flash: full-mask white
  E.flashLevel = function (t, t0, strength) {
    const a = t - t0; if (a < 0) return 0;
    const flick = (a < 0.08) ? 1 : (a < 0.14 ? 0.35 : (a < 0.2 ? 0.8 : 0));
    return strength * (flick + 0.45 * Math.exp(-a / 0.35) * (a > 0.2 ? 1 : 0)) * (a < 2.5 ? 1 : 0);
  };
  // lightning: {whiteout, lit} — 2 frames of white-out, then the geometry lit for ~0.6 s with flicker
  E.lightning = function (t, t0, strength) {
    const a = t - t0; if (a < 0 || a > 3) return { whiteout: 0, lit: 0 };
    const whiteout = a < 0.07 ? 0.9 : (a < 0.1 ? 0.3 : 0);
    const flick = (a < 0.12) ? 1 : (a < 0.17 ? 0.5 : (a < 0.24 ? 1 : 0.8));
    const lit = strength * flick * Math.exp(-Math.max(0, a - 0.24) / 0.45);
    return { whiteout: whiteout * strength, lit };
  };

  // ---------- compositing ----------
  // Clears E/M/T layers for a new frame.
  E.begin = function (ambient) {
    const xE = E.xE, xM = E.xM, xT = E.xT;
    xE.setTransform(1, 0, 0, 1, 0, 0); xE.globalCompositeOperation = 'source-over'; xE.globalAlpha = 1; xE.filter = 'none';
    xE.fillStyle = '#000'; xE.fillRect(0, 0, E.W, E.H);
    xM.setTransform(1, 0, 0, 1, 0, 0); xM.globalCompositeOperation = 'source-over'; xM.globalAlpha = 1; xM.filter = 'none';
    xM.fillStyle = ambient || '#000'; xM.fillRect(0, 0, E.W, E.H);
    xM.globalCompositeOperation = 'lighter';
    xT.setTransform(1, 0, 0, 1, 0, 0); xT.globalCompositeOperation = 'source-over'; xT.globalAlpha = 1; xT.filter = 'none';
    xT.clearRect(0, 0, E.W, E.H);
  };
  // Combine: main = E*M (+ airglow from M) + T, then post.
  E.compose = function (opts) {
    opts = opts || {};
    const x = E.ctx;
    x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.filter = 'none';
    x.fillStyle = '#000'; x.fillRect(0, 0, E.W, E.H);
    x.drawImage(E.cE, 0, 0);
    x.globalCompositeOperation = 'multiply'; x.drawImage(E.cM, 0, 0);
    // lightning flash: adds the geometry layer itself (air stays black), plus a brief white-out
    if (opts.flash > 0) {
      x.globalCompositeOperation = 'lighter'; x.globalAlpha = E.clamp(opts.flash, 0, 1); x.drawImage(E.cE, 0, 0); x.globalAlpha = E.clamp(opts.flash * 0.6, 0, 1); x.drawImage(E.cE, 0, 0); x.globalAlpha = E.clamp(opts.flash * 0.3, 0, 1); x.drawImage(E.cE, 0, 0); x.globalAlpha = 1;
      if (opts.whiteout > 0) { x.globalCompositeOperation = 'source-over'; x.fillStyle = `rgba(235,242,255,${E.clamp(opts.whiteout, 0, 1)})`; x.fillRect(0, 0, E.W, E.H); }
    }
    // air glow: blurred mask added faintly (sound visible in the air like a sonar screen)
    const air = opts.airGlow == null ? 0.1 : opts.airGlow;
    if (air > 0) {
      E.xS.setTransform(1, 0, 0, 1, 0, 0); E.xS.filter = 'none'; E.xS.globalCompositeOperation = 'source-over'; E.xS.globalAlpha = 1;
      E.xS.fillStyle = '#000'; E.xS.fillRect(0, 0, E.cS.width, E.cS.height);
      E.xS.drawImage(E.cM, 0, 0, E.cS.width, E.cS.height);
      E.xS2.setTransform(1, 0, 0, 1, 0, 0); E.xS2.globalCompositeOperation = 'source-over'; E.xS2.globalAlpha = 1;
      E.xS2.fillStyle = '#000'; E.xS2.fillRect(0, 0, E.cS2.width, E.cS2.height);
      E.xS2.filter = 'blur(7px)'; E.xS2.drawImage(E.cS, 0, 0); E.xS2.filter = 'none';
      x.globalCompositeOperation = 'lighter'; x.globalAlpha = air; x.drawImage(E.cS2, 0, 0, E.W, E.H); x.globalAlpha = 1;
    }
    // bloom of the lit image
    const bloom = opts.bloom == null ? 0.45 : opts.bloom;
    if (bloom > 0) {
      E.xS.setTransform(1, 0, 0, 1, 0, 0); E.xS.filter = 'none'; E.xS.globalCompositeOperation = 'source-over'; E.xS.globalAlpha = 1;
      E.xS.fillStyle = '#000'; E.xS.fillRect(0, 0, E.cS.width, E.cS.height);
      E.xS.drawImage(E.main, 0, 0, E.cS.width, E.cS.height);
      E.xS2.setTransform(1, 0, 0, 1, 0, 0); E.xS2.globalCompositeOperation = 'source-over'; E.xS2.globalAlpha = 1;
      E.xS2.fillStyle = '#000'; E.xS2.fillRect(0, 0, E.cS2.width, E.cS2.height);
      E.xS2.filter = `blur(${opts.bloomRadius || 5}px)`; E.xS2.drawImage(E.cS, 0, 0); E.xS2.filter = 'none';
      x.globalCompositeOperation = 'lighter'; x.globalAlpha = bloom; x.drawImage(E.cS2, 0, 0, E.W, E.H); x.globalAlpha = 1;
    }
    x.globalCompositeOperation = 'source-over';
    x.drawImage(E.cT, 0, 0);
  };
  // Lit mode compose (sky scene): main already drawn by the scene; add T and bloom.
  E.composeLit = function (opts) {
    opts = opts || {};
    const x = E.ctx; x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.filter = 'none';
    const bloom = opts.bloom == null ? 0.3 : opts.bloom;
    if (bloom > 0) {
      E.xS.setTransform(1, 0, 0, 1, 0, 0); E.xS.filter = 'none'; E.xS.globalCompositeOperation = 'source-over'; E.xS.globalAlpha = 1;
      E.xS.fillStyle = '#000'; E.xS.fillRect(0, 0, E.cS.width, E.cS.height);
      E.xS.drawImage(E.main, 0, 0, E.cS.width, E.cS.height);
      // threshold-ish: darken then blur
      E.xS.globalCompositeOperation = 'multiply'; E.xS.drawImage(E.cS, 0, 0); E.xS.globalCompositeOperation = 'source-over';
      E.xS2.setTransform(1, 0, 0, 1, 0, 0); E.xS2.globalCompositeOperation = 'source-over'; E.xS2.globalAlpha = 1;
      E.xS2.fillStyle = '#000'; E.xS2.fillRect(0, 0, E.cS2.width, E.cS2.height);
      E.xS2.filter = `blur(${opts.bloomRadius || 6}px)`; E.xS2.drawImage(E.cS, 0, 0); E.xS2.filter = 'none';
      x.globalCompositeOperation = 'lighter'; x.globalAlpha = bloom; x.drawImage(E.cS2, 0, 0, E.W, E.H); x.globalAlpha = 1;
    }
    x.globalCompositeOperation = 'source-over';
    x.drawImage(E.cT, 0, 0);
  };

  // ---------- post ----------
  E.post = function (frame, opts) {
    opts = opts || {};
    const x = E.ctx; x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.filter = 'none';
    // chromatic aberration
    if (opts.aberration > 0) {
      const s = opts.aberration;
      E.xP.setTransform(1, 0, 0, 1, 0, 0); E.xP.globalCompositeOperation = 'source-over'; E.xP.globalAlpha = 1; E.xP.filter = 'none';
      E.xP.drawImage(E.main, 0, 0);
      x.globalCompositeOperation = 'source-over';
      // red shifted right, blue shifted left: approximate by tinted copies in 'lighter' over a darkened base
      x.globalAlpha = 1; x.fillStyle = 'rgba(0,0,0,0.0)';
      x.globalCompositeOperation = 'multiply'; x.fillStyle = '#00ffff'; x.fillRect(0, 0, E.W, E.H); // keep G,B
      x.globalCompositeOperation = 'lighter';
      // red channel copy shifted
      E.xP.globalCompositeOperation = 'multiply'; E.xP.fillStyle = '#ff0000'; E.xP.fillRect(0, 0, E.W, E.H);
      x.drawImage(E.cP, s, 0);
      x.globalCompositeOperation = 'source-over';
    }
    // vignette
    const vig = opts.vignette == null ? 0.55 : opts.vignette;
    if (vig > 0) {
      const g = x.createRadialGradient(E.W / 2, E.H / 2, E.H * 0.35, E.W / 2, E.H / 2, E.H * 0.95);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${vig})`);
      x.globalCompositeOperation = 'source-over'; x.fillStyle = g; x.fillRect(0, 0, E.W, E.H);
    }
    // grain
    const gr = opts.grain == null ? 0.07 : opts.grain;
    if (gr > 0) {
      const tile = E.grain[frame % E.grain.length];
      const ox = -((frame * 97) % 512), oy = -((frame * 57) % 512);
      x.globalCompositeOperation = 'overlay'; x.globalAlpha = gr;
      for (let yy = oy; yy < E.H; yy += 512) for (let xx = ox; xx < E.W; xx += 512) x.drawImage(tile, xx, yy);
      x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
    }
    // fade (to black or white)
    if (opts.fade > 0) { x.fillStyle = opts.fadeColor || '#000'; x.globalAlpha = E.clamp(opts.fade, 0, 1); x.fillRect(0, 0, E.W, E.H); x.globalAlpha = 1; }
    // letterbox
    x.fillStyle = '#000'; x.fillRect(0, 0, E.W, E.PIC_Y0); x.fillRect(0, E.PIC_Y0 + E.PIC_H, E.W, E.H - E.PIC_Y0 - E.PIC_H);
  };

  // ---------- text ----------
  E.text = function (ctx, str, x, y, opts) {
    opts = opts || {};
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = opts.font || '700 48px Nunito';
    ctx.textAlign = opts.align || 'center'; ctx.textBaseline = 'middle';
    ctx.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
    if (opts.spacing) ctx.letterSpacing = opts.spacing;
    if (opts.glow) { ctx.shadowColor = opts.glow; ctx.shadowBlur = opts.glowBlur || 30; }
    ctx.fillStyle = opts.color || '#e8f3ff';
    ctx.fillText(str, x, y);
    ctx.restore();
  };
})();
