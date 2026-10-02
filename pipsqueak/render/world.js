// world.js — procedural cave geometry, sound-shadow visibility polygons, rock rendering.
// Everything is deterministic (seeded PRNG) and stateless per frame.
(function () {
  'use strict';
  const W = {};
  window.WORLD = W;

  // ---------- deterministic randomness ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  W.rng = mulberry32;
  // hash → 0..1
  function hash1(n) { let x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  W.hash1 = hash1;
  // smooth 1D value noise
  function vnoise(x, seed) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return hash1(i + seed * 1000) * (1 - u) + hash1(i + 1 + seed * 1000) * u;
  }
  function fbm(x, seed, oct) {
    let a = 0, amp = 0.5, fr = 1, s = 0;
    for (let o = 0; o < (oct || 4); o++) { a += amp * (vnoise(x * fr, seed + o * 7.3) - 0.5); s += amp; amp *= 0.5; fr *= 2.1; }
    return a / s;
  }
  W.fbm = fbm; W.vnoise = vnoise;

  // ---------- polygon helpers ----------
  function catmull(points, closed, subdiv) {
    // Catmull-Rom spline through points, returns dense polyline
    const out = [], n = points.length;
    const get = (i) => closed ? points[((i % n) + n) % n] : points[Math.max(0, Math.min(n - 1, i))];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      for (let k = 0; k < subdiv; k++) {
        const t = k / subdiv, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
        ]);
      }
    }
    if (!closed) out.push(points[n - 1].slice());
    return out;
  }
  W.catmull = catmull;

  // add fractal roughness to a polyline (displace along normals)
  function roughen(poly, amp, seed, closed, freq) {
    const n = poly.length, out = [];
    freq = freq || 0.02;
    for (let i = 0; i < n; i++) {
      const a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const d = fbm(i * freq * 10, seed, 4) * 2 * amp + fbm(i * freq * 60, seed + 3, 2) * amp * 0.5;
      out.push([poly[i][0] + (-dy) * d, poly[i][1] + dx * d]);
    }
    return out;
  }
  W.roughen = roughen;

  function polyPath(ctx, poly) {
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
  }
  W.polyPath = polyPath;

  function segsOf(poly, closed) {
    const s = [], n = poly.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      s.push([a[0], a[1], b[0], b[1]]);
    }
    return s;
  }
  W.segsOf = segsOf;

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  W.pointInPoly = pointInPoly;

  // ---------- visibility polygon (sound shadows) ----------
  function raySeg(px, py, dx, dy, s) {
    const x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3];
    const ex = x2 - x1, ey = y2 - y1;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) return Infinity;
    const t = ((x1 - px) * ey - (y1 - py) * ex) / den;
    const u = ((x1 - px) * dy - (y1 - py) * dx) / den;
    if (t > 1e-6 && u >= 0 && u <= 1) return t;
    return Infinity;
  }
  W.visibility = function (px, py, segs, maxR) {
    const near = [];
    for (const s of segs) {
      const minx = Math.min(s[0], s[2]) - px, maxx = Math.max(s[0], s[2]) - px;
      const miny = Math.min(s[1], s[3]) - py, maxy = Math.max(s[1], s[3]) - py;
      if (maxx < -maxR || minx > maxR || maxy < -maxR || miny > maxR) continue;
      near.push(s);
    }
    const angles = [];
    for (const s of near) {
      const a1 = Math.atan2(s[1] - py, s[0] - px), a2 = Math.atan2(s[3] - py, s[2] - px);
      angles.push(a1 - 1e-4, a1, a1 + 1e-4, a2 - 1e-4, a2, a2 + 1e-4);
    }
    const N = 240;
    for (let i = 0; i < N; i++) angles.push(-Math.PI + i * 2 * Math.PI / N);
    angles.sort((a, b) => a - b);
    const pts = [];
    for (const a of angles) {
      const dx = Math.cos(a), dy = Math.sin(a);
      let best = maxR;
      for (const s of near) { const t = raySeg(px, py, dx, dy, s); if (t < best) best = t; }
      pts.push([px + dx * best, py + dy * best]);
    }
    return pts;
  };

  // ---------- cave construction ----------
  // A room = { bounds, airs:[poly], solids:[poly], segs:[], decor:{...}, ... }
  function finalize(room) {
    room.segs = [];
    for (const a of room.airs) room.segs.push(...segsOf(a, true));
    for (const s of room.solids) room.segs.push(...segsOf(s, true));
    // detail strokes (etched hatching along edges, into the rock)
    const R = mulberry32(room.seed * 77 + 5);
    room.hatch = [];
    const addHatch = (poly, inward) => {
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        if (R() > 0.35) continue;
        const a = poly[i], b = poly[(i + 1) % n];
        let dx = b[0] - a[0], dy = b[1] - a[1];
        const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        const nx = -dy * inward, ny = dx * inward; // normal pointing into rock
        const t = R();
        const sx = a[0] + dx * L * t, sy = a[1] + dy * L * t;
        const len = 6 + R() * 26;
        const off = 4 + R() * 10;
        room.hatch.push([sx + nx * off, sy + ny * off, sx + nx * (off + len) + dx * (R() - 0.5) * 8, sy + ny * (off + len) + dy * (R() - 0.5) * 8, 0.25 + R() * 0.5]);
      }
    };
    for (const a of room.airs) addHatch(a, signedArea(a) > 0 ? -1 : 1);
    for (const s of room.solids) addHatch(s, signedArea(s) > 0 ? 1 : -1);
    // pebbles & rubble near floors (decor list given by builder) — nothing else to do
    return room;
  }
  function signedArea(p) { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] * p[i][1] - p[i][0] * p[j][1]); return a / 2; }
  W.signedArea = signedArea;

  // stalactite polygon hanging from (x,y) with length L, width w; dir = +1 down (stalactite), -1 up (stalagmite)
  function spike(x, y, L, w, dir, R) {
    const pts = [];
    const n = 7;
    for (let i = 0; i <= n; i++) { const t = i / n; const ww = w * (1 - t) * (0.8 + 0.4 * R()) + 1.5; const yy = y + dir * L * t; pts.push([x - ww / 2 + (R() - 0.5) * w * 0.15, yy]); }
    for (let i = n; i >= 0; i--) { const t = i / n; const ww = w * (1 - t) * (0.8 + 0.4 * R()) + 1.5; const yy = y + dir * L * t; pts.push([x + ww / 2 + (R() - 0.5) * w * 0.15, yy]); }
    return pts;
  }

  // Build a chamber: a noisy closed air polygon from control points, with stalactites along the ceiling.
  W.chamber = function (opts) {
    const R = mulberry32(opts.seed);
    const ctrl = opts.control; // array of [x,y] around the chamber (clockwise)
    let air = catmull(ctrl, true, 14);
    air = roughen(air, opts.rough || 40, opts.seed, true, 0.02);
    const room = { seed: opts.seed, airs: [air], solids: [], bounds: opts.bounds, decor: { fungus: [], pebbles: [], puddles: [] }, name: opts.name };
    // stalactites: sample ceiling points (edges whose normal points downward into air)
    const n = air.length;
    for (let i = 0; i < n; i++) {
      const a = air[i], b = air[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      // orientation: control is clockwise in screen coords (y down) → air to the right of the edge
      const ceiling = dx > 0 && Math.abs(dy) < Math.abs(dx) * 0.9; // upper edge going right
      const floor = dx < 0 && Math.abs(dy) < Math.abs(dx) * 0.9;
      if (ceiling && R() < (opts.stalDensity || 0.5)) {
        const t = R();
        const x = a[0] + dx * t, y = a[1] + dy * t;
        const L = 30 + R() * R() * (opts.stalLen || 260), w = 18 + R() * 40;
        room.solids.push(spike(x, y + 2, L, w, 1, R));
        if (R() < 0.35) room.solids.push(spike(x + (R() - 0.5) * 30, y + 2, L * 0.4, w * 0.6, 1, R));
      }
      if (floor && R() < (opts.stalagDensity || 0.25)) {
        const t = R();
        const x = a[0] + dx * t, y = a[1] + dy * t;
        const L = 20 + R() * R() * (opts.stalLen || 260) * 0.6, w = 24 + R() * 50;
        room.solids.push(spike(x, y - 2, L, w, -1, R));
      }
      if (floor && R() < 0.5) {
        const t = R();
        room.decor.pebbles.push([a[0] + dx * t, a[1] + dy * t - 3, 3 + R() * 7]);
      }
      if (floor && R() < (opts.fungusDensity || 0)) {
        const t = R();
        room.decor.fungus.push([a[0] + dx * t, a[1] + dy * t, 40 + R() * 90, R()]);
      }
    }
    // free-standing columns / boulders
    for (const c of (opts.columns || [])) {
      const pts = [];
      const m = 18;
      for (let i = 0; i < m; i++) { const ang = i / m * Math.PI * 2; const r = c.r * (0.8 + 0.4 * R()); pts.push([c.x + Math.cos(ang) * r * (c.sx || 1), c.y + Math.sin(ang) * r * (c.sy || 1)]); }
      room.solids.push(roughen(catmull(pts, true, 4), c.r * 0.08, opts.seed + c.x, true, 0.1));
    }
    return finalize(room);
  };

  // Build a tunnel: centerline spline with varying half-width.
  W.tunnel = function (opts) {
    const R = mulberry32(opts.seed);
    const center = catmull(opts.path, false, 12);
    const left = [], right = [];
    const n = center.length;
    for (let i = 0; i < n; i++) {
      const a = center[Math.max(0, i - 1)], b = center[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const t = i / (n - 1);
      const hw = (typeof opts.halfWidth === 'function' ? opts.halfWidth(t) : opts.halfWidth) * (1 + fbm(i * 0.08, opts.seed, 3) * (opts.wobble || 0.6));
      const hw2 = (typeof opts.halfWidth === 'function' ? opts.halfWidth(t) : opts.halfWidth) * (1 + fbm(i * 0.08, opts.seed + 11, 3) * (opts.wobble || 0.6));
      left.push([center[i][0] - dy * hw, center[i][1] + dx * hw]);
      right.push([center[i][0] + dy * hw2, center[i][1] - dx * hw2]);
    }
    // close: right (reversed) then left → clockwise-ish polygon
    let air = right.reverse().concat(left);
    air = roughen(air, opts.rough || 14, opts.seed + 2, true, 0.05);
    const room = { seed: opts.seed, airs: [air], solids: [], bounds: opts.bounds, decor: { fungus: [], pebbles: [], puddles: [] }, name: opts.name, center: center };
    // spikes along the walls
    for (let i = 0; i < center.length; i += 2) {
      if (R() < (opts.spikeDensity || 0.25)) {
        const side = R() < 0.5 ? left : right;
        const p = side[Math.min(i, side.length - 1)];
        const q = side[Math.min(i + 1, side.length - 1)];
        const dx = q[0] - p[0], dy = q[1] - p[1];
        const L = Math.hypot(dx, dy) || 1;
        // inward normal
        const sgn = side === left ? -1 : 1;
        const nx = sgn * dy / L, ny = -sgn * dx / L;
        const len = 10 + R() * (opts.spikeLen || 60);
        const w = 8 + R() * 18;
        const pts = [[p[0] + dy / L * w / 2 * 0, p[1]], [p[0] + nx * len, p[1] + ny * len], [q[0], q[1]]];
        room.solids.push([[p[0], p[1]], [p[0] - nx * 4, p[1] - ny * 4], [q[0] - nx * 4, q[1] - ny * 4], [q[0], q[1]], [(p[0] + q[0]) / 2 + nx * len, (p[1] + q[1]) / 2 + ny * len]]);
      }
      if (R() < 0.3) { const c = center[i]; room.decor.pebbles.push([c[0] + (R() - 0.5) * 40, c[1] + (R() - 0.5) * 40, 2 + R() * 5]); }
    }
    return finalize(room);
  };

  // sample a point along a tunnel centerline (0..1)
  W.along = function (center, t) {
    const n = center.length; const f = Math.max(0, Math.min(1, t)) * (n - 1); const i = Math.floor(f); const u = f - i;
    const a = center[i], b = center[Math.min(n - 1, i + 1)];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  W.alongDir = function (center, t) {
    const a = W.along(center, Math.max(0, t - 0.005)), b = W.along(center, Math.min(1, t + 0.005));
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };

  // ---------- rock texture pattern ----------
  let rockPattern = null, rockTile = null;
  W.getRockTile = function () {
    if (rockTile) return rockTile;
    const S = 256; const c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d');
    const img = x.createImageData(S, S); const d = img.data;
    const R = mulberry32(99);
    // tileable value noise via summed cosines
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      let v = 0;
      for (let o = 1; o <= 4; o++) { const f = o * 2; v += (Math.sin((i / S) * f * Math.PI * 2 + o) * Math.cos((j / S) * f * Math.PI * 2 * 1.3 + o * 2.1) + Math.sin(((i + j) / S) * f * Math.PI * 2 * 0.7 + o * 0.5)) / o; }
      v = v * 0.25 + (R() - 0.5) * 0.5;
      const g = 128 + v * 60;
      const k = (j * S + i) * 4; d[k] = g; d[k + 1] = g; d[k + 2] = g; d[k + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    rockTile = c; return c;
  };
  W.getRockPattern = function (ctx) {
    if (rockPattern) return rockPattern;
    rockPattern = ctx.createPattern(W.getRockTile(), 'repeat');
    return rockPattern;
  };

  // ---------- drawing ----------
  // Draw the room's rock into ctx (already in world transform). viewRect = {x0,y0,x1,y1} in world coords (for culling & fills).
  W.drawRoom = function (ctx, room, view, style) {
    style = style || {};
    const edge = style.edge || '#c6e3f0';
    const edgeSoft = style.edgeSoft || 'rgba(120,170,195,0.45)';
    const rock = style.rock || '#222a35';
    const rockLight = style.rockLight || '#3a4757';
    const airColor = style.air || '#000000';
    const zs = 1 / Math.pow(Math.max(0.25, Math.min(3, style.zoom || 1)), 0.75); // widths scale with the shot: wide shots get broader edge light
    const pad = 200;
    const x0 = view.x0 - pad, y0 = view.y0 - pad, x1 = view.x1 + pad, y1 = view.y1 + pad;
    // 1. rock everywhere
    ctx.fillStyle = rock; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    // noise texture overlay
    ctx.save(); ctx.globalAlpha = style.texAlpha == null ? 0.22 : style.texAlpha; ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = W.getRockPattern(ctx); ctx.fillRect(x0, y0, x1 - x0, y1 - y0); ctx.restore();
    // 2. wide soft light on rock near air edges
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const air of room.airs) {
      ctx.beginPath(); polyPath(ctx, air);
      ctx.strokeStyle = rockLight; ctx.lineWidth = 110 * zs; ctx.stroke();
      ctx.strokeStyle = style.edgeGlow || '#4d6274'; ctx.lineWidth = 36 * zs; ctx.stroke();
    }
    // 3. cut out the air
    ctx.fillStyle = airColor;
    for (const air of room.airs) { ctx.beginPath(); polyPath(ctx, air); ctx.fill(); }
    // 4. solids (stalactites, columns) with inner light near their edges
    for (const s of room.solids) {
      // cull
      let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
      for (const p of s) { if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1]; }
      if (mxx < x0 || mnx > x1 || mxy < y0 || mny > y1) continue;
      ctx.beginPath(); polyPath(ctx, s);
      ctx.fillStyle = rock; ctx.fill();
      ctx.save(); ctx.clip();
      ctx.globalAlpha = 0.22; ctx.globalCompositeOperation = 'overlay'; ctx.fillStyle = W.getRockPattern(ctx); ctx.fillRect(mnx, mny, mxx - mnx, mxy - mny);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = style.edgeGlow || '#4d6274'; ctx.lineWidth = 22 * zs; ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = edgeSoft; ctx.lineWidth = 7 * zs; ctx.stroke();
      ctx.strokeStyle = edge; ctx.lineWidth = 2.2 * zs; ctx.stroke();
    }
    // 5. bright edges of the air outline
    for (const air of room.airs) {
      ctx.beginPath(); polyPath(ctx, air);
      ctx.strokeStyle = edgeSoft; ctx.lineWidth = 8 * zs; ctx.stroke();
      ctx.strokeStyle = edge; ctx.lineWidth = 2.4 * zs; ctx.stroke();
    }
    // 6. hatching
    ctx.strokeStyle = style.hatch || 'rgba(170,200,215,0.55)'; ctx.lineWidth = 1.4 * zs;
    ctx.beginPath();
    for (const h of room.hatch) {
      if (h[0] < x0 || h[0] > x1 || h[1] < y0 || h[1] > y1) continue;
      ctx.moveTo(h[0], h[1]); ctx.lineTo(h[2], h[3]);
    }
    ctx.stroke();
    // 7. pebbles
    ctx.fillStyle = '#242c36'; ctx.strokeStyle = edgeSoft; ctx.lineWidth = 1.5;
    for (const p of room.decor.pebbles) {
      if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
      ctx.beginPath(); ctx.ellipse(p[0], p[1], p[2], p[2] * 0.7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  };

  // fungus patches: drawn into the E layer as textured blobs (their light goes into the mask separately)
  W.drawFungus = function (ctx, room, t) {
    for (const f of room.decor.fungus) {
      const [x, y, r, ph] = f;
      const pulse = 0.85 + 0.15 * Math.sin(t * 1.3 + ph * 6.28);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 0.5);
      g.addColorStop(0, `rgba(120,255,210,${0.55 * pulse})`); g.addColorStop(1, 'rgba(60,200,160,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, r * 0.5, r * 0.25, 0, 0, Math.PI * 2); ctx.fill();
      // little mushrooms
      const R = mulberry32(Math.floor(x * 3 + y));
      for (let i = 0; i < 6; i++) {
        const mx = x + (R() - 0.5) * r * 0.8, my = y - R() * 6, mr = 2 + R() * 5;
        ctx.fillStyle = `rgba(150,255,220,${0.6 * pulse})`;
        ctx.beginPath(); ctx.arc(mx, my - mr, mr, Math.PI, 0); ctx.fill();
        ctx.fillStyle = 'rgba(90,200,170,0.8)'; ctx.fillRect(mx - 1, my - mr, 2, mr);
      }
    }
  };
})();
