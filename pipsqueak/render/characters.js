/* PIPSQUEAK — character drawing library (HTML5 Canvas 2D).
 * Plain browser script. Defines window.CHAR with pure drawing functions:
 *   CHAR.drawBat(ctx, p), CHAR.drawBatEyesOnly(ctx, p), CHAR.drawGus(ctx, p),
 *   CHAR.drawFlockBat(ctx, p), CHAR.gusAnchor(p), CHAR.headAnchor(p)
 * No per-frame state: every frame is a pure function of the parameters.
 *
 * Coordinate conventions (ctx already translated so (0,0) is the character anchor):
 *   perch / crouch : anchor = feet (ground contact), body rises in -y.
 *   hang           : anchor = feet (gripping point), body hangs down in +y, face upside-down.
 *   fly / glide    : anchor = centre of the body (chest).
 *   The character faces +x (screen right) unless flipX. `rot` rotates the whole character,
 *   `scale` scales it (1 = Pip ~90 px tall incl. head; Nan is ~1.6x bigger at the same scale).
 */
(function () {
  'use strict';
  var TAU = Math.PI * 2;

  // ---------------------------------------------------------------- helpers
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function hex(h) {
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb(c) { return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'; }
  function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; }
  function mixc(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  var INK = hex('#1b1826');
  function outlineOf(h) { return rgb(mixc(hex(h), INK, 0.52)); }
  function darker(h, t) { return rgb(mixc(hex(h), INK, t)); }

  // 2D affine matrices, canvas layout [a,b,c,d,e,f]
  function mmul(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
            m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function mrot(a) { var c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; }
  function mscale(x, y) { return [x, 0, 0, y, 0, 0]; }
  function mtrans(x, y) { return [1, 0, 0, 1, x, y]; }
  function mapply(m, x, y) { return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; }

  function ell(ctx, x, y, rx, ry) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); }
  function paint(ctx, fill, stroke, lw) {
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  }

  // ---------------------------------------------------------------- kinds
  function makeKind(o) {
    o.furC = hex(o.fur); o.bellyC = hex(o.belly); o.wingC = hex(o.wing); o.irisC = hex(o.iris);
    o.outline = outlineOf(o.fur);
    o.bellyOutline = rgb(mixc(hex(o.belly), INK, 0.42));
    o.wingOutline = outlineOf(o.wing);
    o.wingBone = rgb(mixc(hex(o.wing), INK, 0.68));
    o.earInOutline = rgb(mixc(hex(o.earIn), INK, 0.4));
    o.furShade = rgba(mixc(hex(o.fur), INK, 0.5), 0.28);
    o.bellyShade = rgba(mixc(hex(o.belly), INK, 0.5), 0.22);
    o.irisDark = rgb(mixc(hex(o.iris), INK, 0.45));
    return o;
  }
  var KINDS = {
    pip: makeKind({
      fur: '#8c87a8', belly: '#e7dccb', earIn: '#f0a8b8', wing: '#6e6690', iris: '#a9d6ff', nose: '#c98aa0',
      bodyRx: 19, bodyRy: 23, headR: 24, headFwd: 3, headOverlap: 10,
      earH: 27, earW: 11.5, earTilt: 0.32, eyeR: 9.6, eyeSep: 0.44, lidRest: 1.0,
      wingLen: 3.6, browStyle: 'plain', tuft: false, notch: false, bentEar: false,
      doubleChin: false, tattered: false, wry: 0, grin: 0, fangs: true
    }),
    nan: makeKind({
      fur: '#6f6358', belly: '#c9b9a3', earIn: '#b48a84', wing: '#4f463f', iris: '#e3c17c', nose: '#4a3a3a',
      bodyRx: 33, bodyRy: 38, headR: 31, headFwd: 4, headOverlap: 14,
      earH: 31, earW: 13.5, earTilt: 0.36, eyeR: 10.5, eyeSep: 0.42, lidRest: 0.72,
      wingLen: 3.3, browStyle: 'tuft', tuft: false, notch: true, bentEar: false,
      doubleChin: true, tattered: true, wry: 1, grin: 0.15, fangs: false
    }),
    tobi: makeKind({
      fur: '#c9733a', belly: '#f3d6a6', earIn: '#f6b79c', wing: '#8d4c24', iris: '#ffd27a', nose: '#5a2e1e',
      bodyRx: 20, bodyRy: 23, headR: 24, headFwd: 3, headOverlap: 10,
      earH: 22, earW: 10.5, earTilt: 0.34, eyeR: 9, eyeSep: 0.44, lidRest: 1.0,
      wingLen: 3.6, browStyle: 'plain', tuft: true, notch: false, bentEar: false,
      doubleChin: false, tattered: false, wry: 0, grin: 1, fangs: true
    }),
    mira: makeKind({
      fur: '#b58aa6', belly: '#ecd7e2', earIn: '#f6bccd', wing: '#7d5a76', iris: '#f3a6d8', nose: '#6a3a58',
      bodyRx: 17, bodyRy: 24, headR: 23, headFwd: 3, headOverlap: 10,
      earH: 27, earW: 10.5, earTilt: 0.26, eyeR: 9.2, eyeSep: 0.44, lidRest: 0.62,
      wingLen: 3.7, browStyle: 'plain', tuft: false, notch: false, bentEar: true,
      doubleChin: false, tattered: false, wry: 0.5, grin: 0.2, fangs: true
    }),
    generic: makeKind({
      fur: '#4d5668', belly: '#6b7488', earIn: '#6d5f70', wing: '#3a4150', iris: '#9fb6cc', nose: '#2a2e3a',
      bodyRx: 19, bodyRy: 23, headR: 24, headFwd: 3, headOverlap: 10,
      earH: 25, earW: 11, earTilt: 0.32, eyeR: 9, eyeSep: 0.44, lidRest: 0.9,
      wingLen: 3.6, browStyle: 'plain', tuft: false, notch: false, bentEar: false,
      doubleChin: false, tattered: false, wry: 0, grin: 0, fangs: false
    })
  };

  // ---------------------------------------------------------------- parameters
  function norm(p) {
    p = p || {};
    var k = KINDS[p.kind] || KINDS.generic;
    var eyes = p.eyes || {}, mouth = p.mouth || {};
    var pose = p.pose || 'perch';
    var q = {
      k: k, kind: p.kind || 'generic', pose: pose,
      scale: num(p.scale, 1), rot: num(p.rot, 0), flipX: !!p.flipX,
      flap: num(p.flap, 0), lean: clamp(num(p.lean, 0), -1, 1), squash: clamp(num(p.squash, 0), 0, 1),
      eyeOpen: clamp(num(eyes.open, 1), 0, 1), pupil: clamp(num(eyes.pupil, 0.5), 0, 1),
      lookX: clamp(num(eyes.lookX, 0), -1, 1), lookY: clamp(num(eyes.lookY, 0), -1, 1),
      brow: clamp(num(p.brow, 0), -1, 1),
      viseme: mouth.viseme || 'rest', mOpen: clamp(num(mouth.open, 0), 0, 1), smile: clamp(num(mouth.smile, 0), -1, 1),
      ears: clamp(num(p.ears, 1), 0, 1), earWiggle: clamp(num(p.earWiggle, 0), -1, 1),
      breath: clamp(num(p.breath, 0), 0, 1), glow: clamp(num(p.glowEyes, 0), 0, 1),
      alpha: clamp(num(p.alpha, 1), 0, 1)
    };
    if (pose === 'crouch') {
      q.squash = Math.max(q.squash, 0.45);
      q.ears = Math.min(q.ears, 0.25);
    }
    return q;
  }

  // Layout in "feet space": feet at (0,0), body rises in -y, faces +x.
  function layout(q) {
    var k = q.k;
    var br = 1 + 0.05 * q.breath;
    var bodyRx = k.bodyRx * (1 + 0.02 * q.breath), bodyRy = k.bodyRy * br;
    var bcY = -bodyRy + 2;
    var headDrop = q.pose === 'crouch' ? k.headR * 0.28 : 0;
    var hx = k.headFwd, hy = bcY - bodyRy - k.headR + k.headOverlap + headDrop - 1.5 * q.breath;
    var fx = hx + k.headR * 0.12;
    var eyeY = hy - k.headR * 0.02;
    var eyeR = k.eyeR;
    var L = {
      bodyRx: bodyRx, bodyRy: bodyRy, bcY: bcY, bcX: 0,
      hx: hx, hy: hy, headR: k.headR, fx: fx,
      eyeL: { x: fx - k.headR * k.eyeSep, y: eyeY }, eyeR: { x: fx + k.headR * k.eyeSep, y: eyeY }, eyeRad: eyeR,
      nose: { x: fx + 1, y: hy + k.headR * 0.33 },
      mouth: { x: fx + 1, y: hy + k.headR * 0.60 },
      earL: { x: hx - k.headR * 0.58, y: hy - k.headR * 0.74 }, earR: { x: hx + k.headR * 0.58, y: hy - k.headR * 0.74 },
      shL: { x: -bodyRx * 0.72, y: bcY - bodyRy * 0.62 }, shR: { x: bodyRx * 0.72, y: bcY - bodyRy * 0.62 },
      wingLen: bodyRx * k.wingLen,
      gus: { x: bodyRx * 0.12 + 1, y: bcY - bodyRy * 0.22 }
    };
    return L;
  }

  function poseMatrix(q, L) {
    var m = mrot(q.rot);
    m = mmul(m, mscale(q.scale * (q.flipX ? -1 : 1), q.scale));
    var flying = q.pose === 'fly' || q.pose === 'glide';
    if (q.pose === 'hang') m = mmul(m, mrot(Math.PI));
    if (flying) {
      var bob = q.pose === 'fly' ? 3.5 * Math.sin(q.flap * TAU) : 0;
      m = mmul(m, mtrans(0, bob));
      m = mmul(m, mrot(0.35 * q.lean + (q.pose === 'glide' ? 0.08 : 0.05)));
      m = mmul(m, mtrans(0, -L.bcY));
    } else {
      m = mmul(m, mrot(0.22 * q.lean));
      m = mmul(m, mscale(1 + 0.35 * q.squash, 1 - 0.35 * q.squash));
    }
    return m;
  }

  function lineWidthFor(scale) { return 2.5 / Math.pow(Math.max(scale, 0.05), 0.3); }

  // ---------------------------------------------------------------- parts
  function drawEar(ctx, q, L, side, lw) {
    var k = q.k;
    var e = side < 0 ? L.earL : L.earR;
    var perk = q.ears;
    var tilt = side * lerp(1.35, k.earTilt, perk) + side * q.earWiggle * 0.18;
    if (q.pose === 'hang') tilt *= 0.3; // gravity pulls the ears toward the body's "up" when hanging
    var H = k.earH * lerp(0.92, 1, perk), W = k.earW;
    var bent = k.bentEar && side > 0;
    var notch = k.notch && side > 0;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(tilt);
    var h = bent ? H * 0.62 : H;
    function earPath(w, hh, notched) {
      ctx.beginPath();
      ctx.moveTo(-w, 0);
      ctx.quadraticCurveTo(-w * 1.25, -hh * 0.6, 0, -hh);
      if (notched) {
        ctx.quadraticCurveTo(w * 0.9, -hh * 0.82, w * 0.95, -hh * 0.6);
        ctx.lineTo(w * 0.45, -hh * 0.5);
        ctx.lineTo(w * 1.08, -hh * 0.36);
        ctx.quadraticCurveTo(w * 1.12, -hh * 0.15, w, 0);
      } else {
        ctx.quadraticCurveTo(w * 1.25, -hh * 0.6, w, 0);
      }
      ctx.closePath();
    }
    earPath(W, h, notch);
    paint(ctx, k.fur, k.outline, lw);
    ctx.save(); ctx.translate(0, 1.5); ctx.scale(0.6, 0.66);
    earPath(W, h, notch);
    ctx.restore();
    paint(ctx, k.earIn, null, 0);
    if (bent) {
      // folded tip flopping outward
      ctx.save();
      ctx.translate(0, -h + 2);
      ctx.rotate(1.25);
      ell(ctx, W * 0.55, 0, W * 0.75, W * 0.5);
      paint(ctx, k.fur, k.outline, lw);
      ell(ctx, W * 0.55, 0, W * 0.45, W * 0.26);
      paint(ctx, k.earIn, null, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function scallops(ctx, from, to, n, depth, tattered) {
    // draws n concave scallops (or tattered zig-zags) from `from` to `to`
    var dx = to.x - from.x, dy = to.y - from.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len; // normal (pulls scallop inward when depth<0)
    if (tattered) {
      var m = n * 2;
      for (var i = 1; i <= m; i++) {
        var t = i / m, jag = (i % 2 ? depth * 0.9 : -depth * 0.25);
        if (i === m) jag = 0;
        ctx.lineTo(from.x + dx * t + nx * jag, from.y + dy * t + ny * jag);
      }
    } else {
      for (var j = 1; j <= n; j++) {
        var t0 = (j - 0.5) / n, t1 = j / n;
        ctx.quadraticCurveTo(from.x + dx * t0 + nx * depth, from.y + dy * t0 + ny * depth,
                             from.x + dx * t1, from.y + dy * t1);
      }
    }
  }

  // Spread wing (fly/glide). Wing-local: origin at shoulder, +x outward, +y down.
  function drawSpreadWing(ctx, q, L, side, angle, bend, lw, far) {
    var k = q.k, Lw = L.wingLen;
    var sh = side < 0 ? L.shL : L.shR;
    ctx.save();
    ctx.translate(sh.x, sh.y);
    ctx.scale(side, 1);
    if (far) ctx.scale(0.92, 1);
    ctx.rotate(angle);
    var elbow = { x: 0.40 * Lw, y: -0.12 * Lw };
    var wrist = { x: 0.66 * Lw, y: -0.10 * Lw };
    var lag = bend * Lw;
    // finger tips (follow-through lags the tips behind the stroke, more at the long finger)
    var T1 = { x: wrist.x + 0.44 * Lw, y: wrist.y + 0.06 * Lw + lag * 0.6 };
    var T2 = { x: wrist.x + 0.30 * Lw, y: wrist.y + 0.40 * Lw + lag * 0.45 };
    var T3 = { x: wrist.x + 0.07 * Lw, y: wrist.y + 0.58 * Lw + lag * 0.3 };
    var hip = { x: 0.08 * Lw, y: 0.36 * Lw };
    var tail = { x: -0.02 * Lw, y: 0.26 * Lw };
    var sc = -0.11 * Lw;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(0.2 * Lw, -0.15 * Lw, elbow.x, elbow.y);
    ctx.quadraticCurveTo(0.53 * Lw, -0.13 * Lw, wrist.x, wrist.y);
    ctx.quadraticCurveTo((wrist.x + T1.x) / 2, (wrist.y + T1.y) / 2 - 0.04 * Lw, T1.x, T1.y);
    scallops(ctx, T1, T2, 1, sc, k.tattered);
    scallops(ctx, T2, T3, 1, sc, k.tattered);
    scallops(ctx, T3, hip, 1, sc * 1.1, k.tattered);
    ctx.quadraticCurveTo(0.03 * Lw, 0.34 * Lw, tail.x, tail.y);
    ctx.closePath();
    ctx.globalAlpha *= 0.86;
    paint(ctx, k.wing, k.wingOutline, lw);
    ctx.globalAlpha /= 0.86;
    // finger bones with follow-through bend
    ctx.strokeStyle = k.wingBone; ctx.lineWidth = lw * 1.0; ctx.lineCap = 'round';
    var tips = [T1, T2, T3];
    ctx.beginPath();
    for (var i = 0; i < 3; i++) {
      var t = tips[i];
      ctx.moveTo(wrist.x, wrist.y);
      ctx.quadraticCurveTo((wrist.x + t.x) / 2, (wrist.y + t.y) / 2 - lag * 0.35, t.x, t.y);
    }
    // arm bone
    ctx.moveTo(0, 0); ctx.quadraticCurveTo(0.2 * Lw, -0.15 * Lw, elbow.x, elbow.y);
    ctx.quadraticCurveTo(0.53 * Lw, -0.13 * Lw, wrist.x, wrist.y);
    ctx.stroke();
    // thumb claw
    ctx.beginPath();
    ctx.moveTo(wrist.x, wrist.y);
    ctx.quadraticCurveTo(wrist.x + 0.05 * Lw, wrist.y - 0.07 * Lw, wrist.x + 0.02 * Lw, wrist.y - 0.11 * Lw);
    ctx.lineWidth = lw * 0.9; ctx.stroke();
    ctx.restore();
  }

  // Folded wing (perch/hang/crouch): a cloak panel hugging the body side.
  function drawCloakWing(ctx, q, L, side, lw, ruffle) {
    var k = q.k, rx = L.bodyRx, ry = L.bodyRy;
    var sh = side < 0 ? L.shL : L.shR;
    ctx.save();
    ctx.translate(sh.x, sh.y);
    ctx.scale(side, 1);
    var out = rx * (0.5 + 0.03 * ruffle), tight = q.pose === 'crouch' ? 0.85 : 1;
    out *= tight;
    var top = { x: -rx * 0.12, y: -ry * 0.12 };
    var bot = { x: -rx * 0.42, y: ry * 1.42 };
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.quadraticCurveTo(out * 1.15, ry * 0.05, out * 0.95, ry * 0.75);
    ctx.quadraticCurveTo(out * 0.85, ry * 1.3, out * 0.35, ry * 1.5);
    scallops(ctx, { x: out * 0.35, y: ry * 1.5 }, bot, 2, -ry * 0.1, k.tattered);
    ctx.quadraticCurveTo(-rx * 0.5, ry * 0.6, top.x, top.y);
    ctx.closePath();
    ctx.globalAlpha *= 0.9;
    paint(ctx, k.wing, k.wingOutline, lw);
    ctx.globalAlpha /= 0.9;
    // finger bone creases
    ctx.strokeStyle = k.wingBone; ctx.lineWidth = lw * 0.8; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(top.x + 2, top.y + 3);
    ctx.quadraticCurveTo(out * 0.55, ry * 0.5, out * 0.3, ry * 1.42);
    ctx.moveTo(top.x + 2, top.y + 3);
    ctx.quadraticCurveTo(out * 0.1, ry * 0.5, -rx * 0.12, ry * 1.4);
    ctx.stroke();
    // thumb hook at the shoulder
    ctx.beginPath();
    ctx.moveTo(top.x, top.y + 1);
    ctx.quadraticCurveTo(top.x - 2, top.y - 5, top.x + 2.5, top.y - 6);
    ctx.lineWidth = lw * 0.9; ctx.stroke();
    ctx.restore();
  }

  function drawFeet(ctx, q, L, lw, x, y, hanging) {
    var k = q.k;
    ctx.strokeStyle = k.outline; ctx.lineWidth = lw * 0.9; ctx.lineCap = 'round';
    for (var s = -1; s <= 1; s += 2) {
      var fx = x + s * L.bodyRx * 0.32;
      ctx.beginPath();
      ctx.moveTo(fx, y - 3);
      ctx.lineTo(fx, y);
      ctx.moveTo(fx - 2.5, y + 1.5); ctx.lineTo(fx, y); ctx.lineTo(fx + 2.5, y + 1.5);
      ctx.moveTo(fx, y); ctx.lineTo(fx, y + 2.5);
      ctx.stroke();
    }
  }

  // Eye. side: -1 left eye, +1 right eye (screen). Returns nothing.
  function drawEye(ctx, q, cx, cy, r, side, lw, eyesOnly) {
    var k = q.k;
    var open = q.eyeOpen * k.lidRest;
    // fear (tiny pupils + worried brow) pops the eyes wide open
    if (q.eyeOpen > 0.05 && q.brow < 0 && q.pupil < 0.35) open = Math.min(1, open + 0.15 * (1 - q.pupil / 0.35));
    var innerDir = -side;
    var ry = r * 1.08;
    var lidY = cy - ry - r * 0.05 + (1 - open) * (2 * ry + r * 0.2);
    var tiltInner = q.brow * r * 0.28 * (q.eyeOpen > 0.05 ? 1 : 0);
    var yInner = lidY + tiltInner, yOuter = lidY - tiltInner * 0.4;
    var xInner = cx + innerDir * r * 1.05, xOuter = cx - innerDir * r * 1.05;
    var lowLift = Math.max(0, q.smile) * r * 0.42 * (q.eyeOpen > 0.05 ? 1 : 0);
    var lowY = cy + r - lowLift;

    ctx.save();
    // visible region: eye ellipse, minus lids
    ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 1.08, 0, 0, TAU); ctx.clip();
    var px = cx + q.lookX * r * 0.34, py = cy + q.lookY * r * 0.30;
    var irisR = r * 0.68, pupR = irisR * (0.34 + 0.5 * q.pupil);
    if (eyesOnly) {
      // in the dark: only the glossy eye itself, no lids (they're invisible)
      ctx.beginPath();
      ctx.moveTo(xOuter, cy - r * 1.2); ctx.lineTo(xOuter, yOuter);
      ctx.quadraticCurveTo(cx, lidY + r * 0.12, xInner, yInner);
      ctx.lineTo(xInner, cy + r * 1.2);
      ctx.lineTo(xInner, lowY); ctx.quadraticCurveTo(cx, lowY - r * 0.1, xOuter, lowY);
      ctx.lineTo(xOuter, cy + r * 1.2);
      ctx.closePath();
      // region between lids
      ctx.beginPath();
      ctx.moveTo(xOuter, yOuter);
      ctx.quadraticCurveTo(cx, lidY + r * 0.12, xInner, yInner);
      ctx.lineTo(xInner, lowY);
      ctx.quadraticCurveTo(cx, lowY - r * 0.1, xOuter, lowY);
      ctx.closePath();
      ctx.clip();
    }
    // sclera
    ell(ctx, cx, cy, r, r * 1.08);
    ctx.fillStyle = eyesOnly ? rgba(k.irisC, 0.35) : '#f7f4fb'; ctx.fill();
    // iris
    ell(ctx, px, py, irisR, irisR);
    ctx.fillStyle = rgb(k.irisC); ctx.fill();
    ctx.strokeStyle = k.irisDark; ctx.lineWidth = lw * 0.35; ctx.stroke();
    // pupil
    ell(ctx, px, py, pupR, pupR);
    ctx.fillStyle = '#17121c'; ctx.fill();
    // catchlights
    ctx.fillStyle = '#ffffff';
    ell(ctx, px - irisR * 0.32, py - irisR * 0.34, irisR * 0.24, irisR * 0.24); ctx.fill();
    ell(ctx, px + irisR * 0.3, py + irisR * 0.34, irisR * 0.1, irisR * 0.1); ctx.fill();
    if (!eyesOnly) {
      // upper lid
      ctx.beginPath();
      ctx.moveTo(xOuter, cy - r * 1.3); ctx.lineTo(xOuter, yOuter);
      ctx.quadraticCurveTo(cx, lidY + r * 0.12, xInner, yInner);
      ctx.lineTo(xInner, cy - r * 1.3);
      ctx.closePath();
      ctx.fillStyle = k.fur; ctx.fill();
      // lower lid (happy squint)
      if (lowLift > 0.2) {
        ctx.beginPath();
        ctx.moveTo(xOuter, cy + r * 1.3); ctx.lineTo(xOuter, lowY);
        ctx.quadraticCurveTo(cx, lowY - r * 0.1, xInner, lowY);
        ctx.lineTo(xInner, cy + r * 1.3);
        ctx.closePath();
        ctx.fillStyle = k.fur; ctx.fill();
      }
      // shadow under the upper lid for gloss
      ctx.beginPath();
      ctx.moveTo(xOuter, yOuter);
      ctx.quadraticCurveTo(cx, lidY + r * 0.12, xInner, yInner);
      ctx.lineTo(xInner, yInner + r * 0.25);
      ctx.quadraticCurveTo(cx, lidY + r * 0.37, xOuter, yOuter + r * 0.25);
      ctx.closePath();
      ctx.fillStyle = 'rgba(30,20,50,0.18)'; ctx.fill();
    }
    ctx.restore();
    if (!eyesOnly) {
      // lid edge line and eye outline
      ctx.save();
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 1.08, 0, 0, TAU); ctx.clip();
      ctx.strokeStyle = k.outline; ctx.lineWidth = lw * 1.1; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(xOuter, yOuter);
      ctx.quadraticCurveTo(cx, lidY + r * 0.12, xInner, yInner);
      ctx.stroke();
      if (lowLift > 0.2) {
        ctx.beginPath();
        ctx.moveTo(xOuter, lowY); ctx.quadraticCurveTo(cx, lowY - r * 0.1, xInner, lowY);
        ctx.lineWidth = lw * 0.8; ctx.stroke();
      }
      ctx.restore();
      if (q.eyeOpen > 0.05) {
        ell(ctx, cx, cy, r, r * 1.08);
        ctx.strokeStyle = k.outline; ctx.lineWidth = lw * 0.9; ctx.stroke();
      }
    }
  }

  function drawBrow(ctx, q, cx, cy, r, side, lw) {
    var k = q.k, b = q.brow;
    var innerDir = -side;
    var by = cy - r * 1.5 - Math.max(0, b) * r * 0.32 + Math.max(0, -b) * r * 0.1;
    var xi = cx + innerDir * r * 0.75, xo = cx - innerDir * r * 0.95;
    var yi = by + b * r * 0.42, yo = by - b * r * 0.18;
    var yc = by - r * 0.2 * (1 - Math.abs(b)) + (b < 0 ? -b * r * 0.1 : 0);
    if (k.browStyle === 'tuft') {
      // bushy white eyebrow tufts
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(xi, yi + r * 0.22);
      ctx.quadraticCurveTo(xi + innerDir * r * 0.1, yi - r * 0.35, cx - innerDir * r * 0.2, yc - r * 0.42);
      ctx.lineTo(cx - innerDir * r * 0.05, yc - r * 0.2);
      ctx.lineTo(cx - innerDir * r * 0.45, yc - r * 0.55);
      ctx.lineTo(cx - innerDir * r * 0.5, yc - r * 0.25);
      ctx.lineTo(xo - innerDir * r * 0.15, yo - r * 0.5);
      ctx.quadraticCurveTo(xo - innerDir * r * 0.3, yo + r * 0.05, xo, yo + r * 0.25);
      ctx.quadraticCurveTo(cx, yc + r * 0.32, xi, yi + r * 0.22);
      ctx.closePath();
      paint(ctx, '#f1ebe0', outlineOf('#c9b9a3'), lw * 0.9);
      ctx.restore();
    } else {
      ctx.strokeStyle = k.outline; ctx.lineWidth = lw * 1.9; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(xi, yi);
      ctx.quadraticCurveTo(cx, yc, xo, yo);
      ctx.stroke();
    }
  }

  var VIS = {
    rest: { w: 1.0, h: 0.0, round: 0 },
    A: { w: 1.0, h: 1.0, round: 0.2 },
    E: { w: 1.5, h: 0.45, round: 0 },
    O: { w: 0.6, h: 0.75, round: 1 },
    M: { w: 1.0, h: 0.0, round: 0 },
    F: { w: 1.15, h: 0.3, round: 0 },
    L: { w: 1.0, h: 0.85, round: 0.2 }
  };

  function drawMouth(ctx, q, L, lw) {
    var k = q.k, v = VIS[q.viseme] || VIS.rest;
    var mx = L.mouth.x, my = L.mouth.y, R = L.headR;
    var baseW = R * 0.27, baseH = R * 0.36;
    var w = baseW * v.w;
    var openAmt = q.mOpen;
    if (q.viseme === 'rest' || q.viseme === 'M') openAmt *= 0.55;
    var h = baseH * (v.h * Math.max(openAmt, v.h > 0 ? 0.25 : 0) + (v.h === 0 ? openAmt * 0.6 : 0));
    var smile = q.smile + k.grin * 0.35;
    var asymR = -k.wry * R * 0.07; // wry: right corner (toward face front) a bit higher
    var cornerDy = -smile * R * 0.13;
    var ctrlDy = smile * R * 0.16;
    var yl = my + cornerDy, yr = my + cornerDy + asymR;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    var mouthOutline = darker(k.fur, 0.6);
    if (h < 1.2) {
      // closed mouth line
      ctx.strokeStyle = mouthOutline; ctx.lineWidth = lw * (q.viseme === 'M' ? 1.5 : 1.1);
      ctx.beginPath();
      ctx.moveTo(mx - w, yl);
      ctx.quadraticCurveTo(mx, my + ctrlDy + h, mx + w, yr);
      ctx.stroke();
      if (q.viseme === 'M') {
        ctx.strokeStyle = rgba(k.bellyC, 0.5); ctx.lineWidth = lw * 0.7;
        ctx.beginPath(); ctx.moveTo(mx - w * 0.7, yl - lw * 1.4); ctx.quadraticCurveTo(mx, my + ctrlDy - lw * 1.2, mx + w * 0.7, yr - lw * 1.4); ctx.stroke();
      }
      if (smile > 0.35) {
        // smile corner dimples
        ctx.strokeStyle = mouthOutline; ctx.lineWidth = lw * 0.9;
        ctx.beginPath();
        ctx.moveTo(mx - w, yl); ctx.lineTo(mx - w - R * 0.04, yl + R * 0.07);
        ctx.moveTo(mx + w, yr); ctx.lineTo(mx + w + R * 0.04, yr + R * 0.07);
        ctx.stroke();
      }
      return;
    }
    // open mouth
    var ww = w * (v.round ? lerp(1, 0.75, v.round) : 1);
    var topBulge = v.round ? -h * 0.3 : h * 0.05;
    ctx.beginPath();
    ctx.moveTo(mx - ww, yl);
    ctx.quadraticCurveTo(mx, my + ctrlDy * 0.6 + topBulge, mx + ww, yr);
    ctx.quadraticCurveTo(mx + ww * (v.round ? 1.1 : 0.9), my + h * 1.05, mx, my + h * (v.round ? 1.3 : 1.15));
    ctx.quadraticCurveTo(mx - ww * (v.round ? 1.1 : 0.9), my + h * 1.05, mx - ww, yl);
    ctx.closePath();
    ctx.save();
    paint(ctx, '#3b1a2c', mouthOutline, lw * 1.05);
    ctx.clip();
    // tongue
    if (q.viseme === 'L' || h > baseH * 0.6) {
      var tr = ww * 0.65;
      ell(ctx, mx + (q.viseme === 'L' ? ww * 0.1 : 0), my + h * (q.viseme === 'L' ? 0.55 : 0.95), tr, tr * 0.7);
      paint(ctx, '#d9647e', darker('#d9647e', 0.35), lw * 0.7);
    }
    // teeth / lip tuck for F
    if (q.viseme === 'F') {
      ctx.fillStyle = '#f5f0f0';
      ctx.beginPath(); ctx.rect(mx - ww, yl - 2, ww * 2, h * 0.5 + 2); ctx.fill();
    }
    // fangs
    if (k.fangs && h > 2.2) {
      var fl = Math.min(h * 0.6, R * 0.16);
      ctx.fillStyle = '#fbf8f4';
      for (var s = -1; s <= 1; s += 2) {
        var fx = mx + s * ww * 0.58, fy = (s < 0 ? yl : yr) + lerp(0, 0.1 * h, 0.5);
        ctx.beginPath();
        ctx.moveTo(fx - R * 0.045, fy - 1); ctx.lineTo(fx + R * 0.045, fy - 1); ctx.lineTo(fx, fy + fl);
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
    if (q.viseme === 'F') {
      // lower lip tucked under the teeth: a lip line
      ctx.strokeStyle = mouthOutline; ctx.lineWidth = lw * 0.9;
      ctx.beginPath(); ctx.moveTo(mx - ww * 0.9, my + h * 0.75); ctx.quadraticCurveTo(mx, my + h * 1.0, mx + ww * 0.9, my + h * 0.75); ctx.stroke();
    }
  }

  function drawNose(ctx, q, L, lw) {
    var k = q.k, n = L.nose, R = L.headR;
    var w = R * 0.11, h = R * 0.09;
    ctx.beginPath();
    ctx.moveTo(n.x - w, n.y - h * 0.6);
    ctx.quadraticCurveTo(n.x, n.y - h * 1.4, n.x + w, n.y - h * 0.6);
    ctx.quadraticCurveTo(n.x + w * 0.9, n.y + h * 0.6, n.x, n.y + h * 1.1);
    ctx.quadraticCurveTo(n.x - w * 0.9, n.y + h * 0.6, n.x - w, n.y - h * 0.6);
    ctx.closePath();
    paint(ctx, k.nose, darker(k.nose, 0.45), lw * 0.7);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ell(ctx, n.x - w * 0.3, n.y - h * 0.4, w * 0.3, h * 0.25); ctx.fill();
  }

  function drawHead(ctx, q, L, lw) {
    var k = q.k, R = L.headR, hx = L.hx, hy = L.hy;
    // ears behind the head
    drawEar(ctx, q, L, -1, lw);
    drawEar(ctx, q, L, 1, lw);
    // tuft (Tobi)
    if (k.tuft) {
      ctx.beginPath();
      var tx = hx + R * 0.05, ty = hy - R * 0.86;
      ctx.moveTo(tx - R * 0.35, ty + R * 0.1);
      ctx.lineTo(tx - R * 0.33, ty - R * 0.3);
      ctx.lineTo(tx - R * 0.12, ty - R * 0.05);
      ctx.lineTo(tx + R * 0.02, ty - R * 0.45);
      ctx.lineTo(tx + R * 0.14, ty - R * 0.05);
      ctx.lineTo(tx + R * 0.4, ty - R * 0.28);
      ctx.lineTo(tx + R * 0.38, ty + R * 0.12);
      ctx.closePath();
      paint(ctx, k.fur, k.outline, lw);
    }
    // head
    ell(ctx, hx, hy, R, R * 0.96);
    paint(ctx, k.fur, k.outline, lw);
    // double chin bulge (Nan)
    if (k.doubleChin) {
      ctx.save();
      ell(ctx, hx, hy, R, R * 0.96); ctx.clip();
      ell(ctx, hx + R * 0.1, hy + R * 0.95, R * 0.72, R * 0.3);
      paint(ctx, darker(k.belly, 0.12), k.bellyOutline, lw * 0.9);
      ctx.restore();
    }
    // face / muzzle patch
    ctx.save();
    ell(ctx, hx, hy, R - lw * 0.5, R * 0.96 - lw * 0.5); ctx.clip();
    var fx = L.fx + R * 0.02, fy = hy + R * 0.42;
    var pw = R * 0.70, ph = R * (k.doubleChin ? 0.36 : 0.42);
    ctx.beginPath();
    ctx.moveTo(fx - pw, fy + ph * 0.1);
    ctx.quadraticCurveTo(fx - pw * 0.9, fy - ph * 1.3, fx, fy - ph * 0.8);
    ctx.quadraticCurveTo(fx + pw * 0.9, fy - ph * 1.3, fx + pw, fy + ph * 0.1);
    ctx.quadraticCurveTo(fx + pw * 0.8, fy + ph * 1.6, fx, fy + ph * 1.6);
    ctx.quadraticCurveTo(fx - pw * 0.8, fy + ph * 1.6, fx - pw, fy + ph * 0.1);
    ctx.closePath();
    paint(ctx, k.belly, null, 0);
    // head shading crescent (lower edge)
    ell(ctx, hx, hy + R * 0.18, R * 1.05, R * 0.96);
    ctx.fillStyle = k.furShade;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(hx, hy, R * 1.2, R * 1.2, 0, 0, TAU); ctx.ellipse(hx, hy - R * 0.14, R * 1.0, R * 0.96, 0, 0, TAU, true); ctx.fill();
    ctx.restore();
    ctx.restore();
    // chin fold line for Nan
    if (k.doubleChin) {
      ctx.strokeStyle = k.outline; ctx.lineWidth = lw * 0.8; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(hx - R * 0.45, hy + R * 0.72);
      ctx.quadraticCurveTo(hx + R * 0.1, hy + R * 0.9, hx + R * 0.6, hy + R * 0.7);
      ctx.stroke();
    }
    // eyes
    var r = L.eyeRad;
    drawEye(ctx, q, L.eyeL.x, L.eyeL.y, r, -1, lw, false);
    drawEye(ctx, q, L.eyeR.x, L.eyeR.y, r, 1, lw, false);
    drawBrow(ctx, q, L.eyeL.x, L.eyeL.y, r, -1, lw);
    drawBrow(ctx, q, L.eyeR.x, L.eyeR.y, r, 1, lw);
    drawNose(ctx, q, L, lw);
    drawMouth(ctx, q, L, lw);
    // eye glow halo on top (soft), only when asked
    if (q.glow > 0.01) drawEyeGlow(ctx, q, L, lw);
  }

  function drawEyeGlow(ctx, q, L, lw) {
    var k = q.k, r = L.eyeRad;
    var g = q.glow * (0.15 + 0.85 * q.eyeOpen);
    if (g <= 0.01) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var eyesArr = [L.eyeL, L.eyeR];
    for (var i = 0; i < 2; i++) {
      var e = eyesArr[i];
      var px = e.x + q.lookX * r * 0.34, py = e.y + q.lookY * r * 0.3;
      var rad = r * 2.4;
      var grd = ctx.createRadialGradient(px, py, r * 0.3, px, py, rad);
      grd.addColorStop(0, rgba(k.irisC, 0.55 * g));
      grd.addColorStop(0.45, rgba(k.irisC, 0.18 * g));
      grd.addColorStop(1, rgba(k.irisC, 0));
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(px, py, rad, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function drawBody(ctx, q, L, lw) {
    var k = q.k, rx = L.bodyRx, ry = L.bodyRy, cy = L.bcY;
    ell(ctx, 0, cy, rx, ry);
    paint(ctx, k.fur, k.outline, lw);
    // belly patch
    ctx.save();
    ell(ctx, 0, cy, rx - lw * 0.5, ry - lw * 0.5); ctx.clip();
    var bx = rx * 0.12, by = cy + ry * 0.08;
    ell(ctx, bx, by, rx * 0.62, ry * 0.74);
    paint(ctx, k.belly, null, 0);
    // belly shading crescent along its lower edge
    ctx.save();
    ell(ctx, bx, by, rx * 0.62, ry * 0.74); ctx.clip();
    ctx.beginPath();
    ctx.ellipse(bx, by, rx * 0.8, ry * 0.9, 0, 0, TAU);
    ctx.ellipse(bx, by - ry * 0.16, rx * 0.66, ry * 0.76, 0, 0, TAU, true);
    ctx.fillStyle = k.bellyShade; ctx.fill();
    ctx.restore();
    // body shading crescent
    ctx.beginPath();
    ctx.ellipse(0, cy, rx * 1.3, ry * 1.3, 0, 0, TAU);
    ctx.ellipse(0, cy - ry * 0.14, rx * 0.98, ry * 0.97, 0, 0, TAU, true);
    ctx.fillStyle = k.furShade; ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- public: bats
  function drawBat(ctx, p) {
    var q = norm(p), k = q.k, L = layout(q);
    var m = poseMatrix(q, L);
    var lw = lineWidthFor(q.scale);
    ctx.save();
    ctx.globalAlpha *= q.alpha;
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    var flying = q.pose === 'fly' || q.pose === 'glide';
    if (flying) {
      var ph = q.flap;
      var ang, bend;
      if (q.pose === 'fly') {
        var c = Math.cos(ph * TAU);
        // ease: linger slightly at the top of the stroke
        ang = lerp(-0.85, 0.62, (1 - c) / 2);
        bend = -Math.sin(ph * TAU) * 0.13;
      } else { ang = -0.12; bend = 0.02; }
      drawSpreadWing(ctx, q, L, -1, ang, bend, lw, true);
      drawSpreadWing(ctx, q, L, 1, ang, bend, lw, false);
      drawBody(ctx, q, L, lw);
      drawFeet(ctx, q, L, lw, 0, 0, false);
      drawHead(ctx, q, L, lw);
    } else {
      var ruffle = Math.sin(q.flap * TAU);
      drawBody(ctx, q, L, lw);
      drawCloakWing(ctx, q, L, -1, lw, ruffle);
      drawCloakWing(ctx, q, L, 1, lw, -ruffle);
      drawFeet(ctx, q, L, lw, 0, 0, q.pose === 'hang');
      drawHead(ctx, q, L, lw);
    }
    ctx.restore();
  }

  function drawBatEyesOnly(ctx, p) {
    var q = norm(p), L = layout(q);
    var m = poseMatrix(q, L);
    var lw = lineWidthFor(q.scale);
    ctx.save();
    ctx.globalAlpha *= q.alpha;
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    var g = Math.max(q.glow, 0.6);
    var qq = {}; for (var key in q) qq[key] = q[key]; qq.glow = g;
    drawEyeGlow(ctx, qq, L, lw);
    if (q.eyeOpen > 0.02) {
      var r = L.eyeRad;
      ctx.save();
      ctx.shadowColor = rgba(q.k.irisC, 0.8); ctx.shadowBlur = 6 * q.scale;
      drawEye(ctx, q, L.eyeL.x, L.eyeL.y, r, -1, lw, true);
      drawEye(ctx, q, L.eyeR.x, L.eyeR.y, r, 1, lw, true);
      ctx.restore();
    }
    ctx.restore();
  }

  function gusAnchor(p) {
    var q = norm(p), L = layout(q), m = poseMatrix(q, L);
    return mapply(m, L.gus.x, L.gus.y);
  }
  function headAnchor(p) {
    var q = norm(p), L = layout(q), m = poseMatrix(q, L);
    var h = mapply(m, L.hx, L.hy), mo = mapply(m, L.mouth.x, L.mouth.y);
    var e1 = mapply(m, L.eyeL.x, L.eyeL.y), e2 = mapply(m, L.eyeR.x, L.eyeR.y);
    return { x: h.x, y: h.y, mouthX: mo.x, mouthY: mo.y, radius: L.headR * q.scale,
             eyeLX: e1.x, eyeLY: e1.y, eyeRX: e2.x, eyeRY: e2.y };
  }

  // ---------------------------------------------------------------- Gus
  var GUS_LIT = hex('#8dff6a'), GUS_UNLIT = hex('#5c6e58'), GUS_CORE = hex('#eaffd6');
  function drawGus(ctx, p) {
    p = p || {};
    var scale = num(p.scale, 1), rot = num(p.rot, 0), lit = clamp(num(p.lit, 1), 0, 1);
    var eyes = p.eyes || {}, mouth = p.mouth || {};
    var open = clamp(num(eyes.open, 1), 0, 1), lookX = clamp(num(eyes.lookX, 0), -1, 1), lookY = clamp(num(eyes.lookY, 0), -1, 1);
    var vis = VIS[mouth.viseme] || VIS.rest, mOpen = clamp(num(mouth.open, 0), 0, 1), smile = clamp(num(mouth.smile, 0.3), -1, 1);
    var wig = num(p.wiggle, 0), fear = clamp(num(p.fear, 0), 0, 1), alpha = clamp(num(p.alpha, 1), 0, 1);
    var lw = lineWidthFor(scale) * 0.8;
    var body = rgb(mixc(GUS_UNLIT, GUS_LIT, lit));
    var outline = rgb(mixc(mixc(GUS_UNLIT, GUS_LIT, lit), INK, 0.55));
    var shake = fear * 1.4 * Math.sin(wig * TAU * 9);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.rotate(rot); ctx.scale(scale, scale);
    ctx.translate(shake, fear * 0.8 * Math.cos(wig * TAU * 11));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // inner glow
    if (lit > 0.02) {
      var grd = ctx.createRadialGradient(2, 0, 2, 2, 0, 26);
      grd.addColorStop(0, rgba(GUS_LIT, 0.55 * lit));
      grd.addColorStop(0.5, rgba(GUS_LIT, 0.18 * lit));
      grd.addColorStop(1, rgba(GUS_LIT, 0));
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(2, 0, 26, 0, TAU); ctx.fill();
    }
    // segments, tail → head
    var n = 5, segs = [];
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      var x = -19 + 23 * t;
      var y = 2.6 * Math.sin(wig * TAU - i * 0.95) * (1 - 0.3 * fear);
      var r = lerp(3.2, 5.6, t);
      segs.push({ x: x, y: y, r: r });
    }
    var hx = 10 + 1.2, hy = 2.4 * Math.sin(wig * TAU - n * 0.95), hr = 7.2 * (1 + 0.12 * fear);
    for (var j = 0; j < n; j++) {
      var s = segs[j];
      ell(ctx, s.x, s.y, s.r, s.r * 0.95);
      paint(ctx, body, outline, lw);
      // tiny legs
      ctx.strokeStyle = outline; ctx.lineWidth = lw * 0.8;
      ctx.beginPath(); ctx.moveTo(s.x - 1, s.y + s.r * 0.8); ctx.lineTo(s.x - 1.8, s.y + s.r + 2); ctx.moveTo(s.x + 1.2, s.y + s.r * 0.8); ctx.lineTo(s.x + 2, s.y + s.r + 2); ctx.stroke();
      // lit core
      if (lit > 0.02) {
        ell(ctx, s.x, s.y - s.r * 0.1, s.r * 0.5, s.r * 0.42);
        ctx.fillStyle = rgba(GUS_CORE, 0.75 * lit); ctx.fill();
      } else {
        ell(ctx, s.x, s.y + s.r * 0.35, s.r * 0.6, s.r * 0.3);
        ctx.fillStyle = 'rgba(20,30,20,0.25)'; ctx.fill();
      }
    }
    // antennae
    ctx.strokeStyle = outline; ctx.lineWidth = lw * 0.8;
    ctx.beginPath();
    ctx.moveTo(hx + 1, hy - hr * 0.8); ctx.quadraticCurveTo(hx + 3, hy - hr * 1.6, hx + 6, hy - hr * 1.7);
    ctx.moveTo(hx - 2, hy - hr * 0.85); ctx.quadraticCurveTo(hx - 3, hy - hr * 1.7, hx - 1, hy - hr * 1.9);
    ctx.stroke();
    ctx.fillStyle = lit > 0.5 ? rgb(GUS_CORE) : body;
    ell(ctx, hx + 6, hy - hr * 1.7, 1.3, 1.3); paint(ctx, ctx.fillStyle, outline, lw * 0.6);
    ell(ctx, hx - 1, hy - hr * 1.9, 1.3, 1.3); paint(ctx, ctx.fillStyle, outline, lw * 0.6);
    // head (puffed cheeks under fear)
    ell(ctx, hx, hy, hr * (1 + 0.1 * fear), hr * 0.92);
    paint(ctx, body, outline, lw);
    if (lit > 0.02) { ell(ctx, hx - 1, hy - 1, hr * 0.45, hr * 0.35); ctx.fillStyle = rgba(GUS_CORE, 0.5 * lit); ctx.fill(); }
    // eyes: two big ones
    var er = 2.7 * (1 + 0.15 * fear), ex = hx + 2.2, eyY = hy - 1.6;
    var eo = open;
    for (var s2 = -1; s2 <= 1; s2 += 2) {
      var cx = ex + s2 * 3.1, cy = eyY;
      ctx.save();
      ell(ctx, cx, cy, er, er * 1.1); ctx.clip();
      ctx.fillStyle = '#ffffff'; ctx.fillRect(cx - er, cy - er * 1.2, er * 2, er * 2.4);
      var pr = er * (fear > 0.5 ? 0.35 : 0.55);
      ell(ctx, cx + lookX * er * 0.4, cy + lookY * er * 0.4, pr, pr); ctx.fillStyle = '#17121c'; ctx.fill();
      ell(ctx, cx + lookX * er * 0.4 - pr * 0.35, cy + lookY * er * 0.4 - pr * 0.4, pr * 0.3, pr * 0.3); ctx.fillStyle = '#fff'; ctx.fill();
      // lid
      ctx.fillStyle = body;
      ctx.fillRect(cx - er - 1, cy - er * 1.2 - 1, er * 2 + 2, (1 - eo) * er * 2.3 + 1);
      ctx.restore();
      ell(ctx, cx, cy, er, er * 1.1); ctx.strokeStyle = outline; ctx.lineWidth = lw * 0.8; ctx.stroke();
      // cheeky brows (worried under fear)
      ctx.strokeStyle = outline; ctx.lineWidth = lw;
      ctx.beginPath();
      var bi = fear * 1.6;
      ctx.moveTo(cx - s2 * er * 0.9, cy - er * 1.35 - (s2 > 0 ? -bi : bi) * 0.5);
      ctx.lineTo(cx + s2 * er * 0.9, cy - er * 1.45 + (s2 > 0 ? -bi : bi) * 0.5);
      ctx.stroke();
    }
    // wide mouth
    var mx = hx + 1.5, my = hy + 2.6, mw = hr * 0.75 * vis.w * (1 - 0.3 * fear), mh = 4.5 * (vis.h * Math.max(mOpen, vis.h > 0 ? 0.25 : 0) + (vis.h === 0 ? mOpen * 0.5 : 0));
    var cdy = -smile * 1.6;
    if (mh < 0.8) {
      ctx.strokeStyle = outline; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(mx - mw, my + cdy); ctx.quadraticCurveTo(mx, my + smile * 2.2, mx + mw, my + cdy); ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(mx - mw, my + cdy);
      ctx.quadraticCurveTo(mx, my + smile * 1.2 - (vis.round ? mh * 0.3 : 0), mx + mw, my + cdy);
      ctx.quadraticCurveTo(mx + mw, my + mh * 1.1, mx, my + mh * 1.2);
      ctx.quadraticCurveTo(mx - mw, my + mh * 1.1, mx - mw, my + cdy);
      ctx.closePath();
      ctx.save(); paint(ctx, '#3b1a2c', outline, lw); ctx.clip();
      ell(ctx, mx, my + mh * 1.0, mw * 0.6, mh * 0.5); paint(ctx, '#d9647e', null, 0);
      if (vis !== VIS.O) { ctx.fillStyle = '#f5f0f0'; ctx.fillRect(mx - mw, my - 1, mw * 2, 1.6 + mh * 0.15); }
      ctx.restore();
    }
    // puffed cheek line + sweat drop under fear
    if (fear > 0.3) {
      ctx.strokeStyle = outline; ctx.lineWidth = lw * 0.7;
      ctx.beginPath();
      ctx.moveTo(hx - hr * 0.9, hy + 1); ctx.quadraticCurveTo(hx - hr * 1.15, hy + 3, hx - hr * 0.85, hy + 5);
      ctx.stroke();
      var dx = hx + hr * 1.05, dy = hy - hr * 0.9 + 1.5 * Math.sin(wig * TAU * 3);
      ctx.beginPath();
      ctx.moveTo(dx, dy - 2.6);
      ctx.quadraticCurveTo(dx + 1.9, dy + 0.4, dx, dy + 1.4);
      ctx.quadraticCurveTo(dx - 1.9, dy + 0.4, dx, dy - 2.6);
      ctx.closePath();
      paint(ctx, 'rgba(170,220,255,' + (0.9 * fear) + ')', 'rgba(40,70,110,' + (0.9 * fear) + ')', lw * 0.5);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- flock silhouette
  function drawFlockBat(ctx, p) {
    p = p || {};
    var s = num(p.scale, 1), rot = num(p.rot, 0), flap = num(p.flap, 0);
    var tint = p.tint || '#2a3340';
    var f = clamp(num(p.folded, 0), 0, 1);           // 1 = wings wrapped (hanging/roosting teardrop)
    var c = Math.cos(flap * TAU);
    var u = (1 - c) / 2;
    // scale 1 ~ 150 px wingspan (matches a generic bat at drawBat scale ~1 gliding)
    var tx = lerp(75, 15, f), ty = lerp(lerp(-40, 28, u), 34, f);     // wing tip
    var sx = lerp(31, 18, f), sy = lerp(lerp(-14, 14, u) + 7, 42, f); // scallop point
    var cx = lerp(44, 20, f), cy = lerp(lerp(-14, 14, u) + 4, 44, f); // scallop control
    var lx = lerp(44, 22, f), ly = lerp(lerp(-40, 28, u) - 18, 10, f); // leading-edge control
    var hx = lerp(9, 7, f), hy = lerp(18, 46, f);                      // hip
    var tl = lerp(24, 52, f);                                          // tail control y
    ctx.save();
    ctx.rotate(rot); ctx.scale(s, s);
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.moveTo(-6, -18);                                   // 1  left ear tip
    ctx.lineTo(0, -10);                                    // 2  between ears
    ctx.lineTo(6, -18);                                    // 3  right ear tip
    ctx.quadraticCurveTo(13, -11, 13, -4);                 // 4  cheek to shoulder
    ctx.quadraticCurveTo(lx, ly, tx, ty);                  // 5  leading edge to tip
    ctx.quadraticCurveTo(cx, cy, sx, sy);                  // 6  scallop
    ctx.quadraticCurveTo(18, hy - 4, hx, hy);              // 7  to hip
    ctx.quadraticCurveTo(0, tl, -hx, hy);                  // 8  tail
    ctx.quadraticCurveTo(-18, hy - 4, -sx, sy);            // 9
    ctx.quadraticCurveTo(-cx, cy, -tx, ty);                // 10
    ctx.quadraticCurveTo(-lx, ly, -13, -4);                // 11
    ctx.quadraticCurveTo(-13, -11, -6, -18);               // 12
    ctx.fill();
    ctx.restore();
  }

  window.CHAR = {
    drawBat: drawBat,
    drawBatEyesOnly: drawBatEyesOnly,
    drawGus: drawGus,
    drawFlockBat: drawFlockBat,
    gusAnchor: gusAnchor,
    headAnchor: headAnchor,
    KINDS: KINDS,
    VISEMES: Object.keys(VIS)
  };
})();
