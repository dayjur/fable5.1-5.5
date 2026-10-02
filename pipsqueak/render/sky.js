// sky.js — WebGL2 fragment-shader night sky, clouds, moon, mountains and a valley that can be
// revealed by a sound ring (the "HELLO" moment). Rendered at half resolution and upscaled.
(function () {
  'use strict';
  const S = {};
  window.SKY = S;
  const VS = `#version 300 es
  in vec2 p; out vec2 uv; void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.0,1.0); }`;
  const FS = `#version 300 es
  precision highp float;
  in vec2 uv; out vec4 o;
  uniform vec2 res; uniform float time; uniform vec2 cam; uniform float zoom;
  uniform vec4 ring;   // cx, cy, age, speed
  uniform vec3 ringP;  // bright, tau, width
  uniform vec2 moon;   // world pos of the moon
  uniform float valley; // 0..1 how much landscape detail to render (always 1 here)
  uniform float dawn;   // 0..1 extra warmth

  float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
    return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
  float fbm(vec2 p){ float v=0.0, a=0.5; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<5;i++){ v+=a*noise(p); p=m*p; a*=0.5;} return v; }
  float ridge(float x, float seed){ return fbm(vec2(x*0.0011+seed, seed*3.0))*1.6 + fbm(vec2(x*0.004+seed*7.0, seed))*0.35; }

  // ring reveal: returns light 0..1 at world point w
  float ringLight(vec2 w){
    float age = ring.z; if (age <= 0.0) return 0.0;
    float d = distance(w, ring.xy);
    float r = ring.w * age;
    float env = exp(-age/(ringP.y*2.6));
    if (d > r + ringP.z) return 0.0;
    float front = smoothstep(r + ringP.z, r, d) * smoothstep(r - ringP.z*1.6, r, d);
    float dt = age - d/ring.w;
    float mem = exp(-dt/ringP.y) * step(d, r);
    return ringP.x * env * (front*2.2 + mem*0.6);
  }

  void main(){
    vec2 px = (uv - 0.5) * res;           // screen px from centre (y up)
    px.y = -px.y;                          // y down like canvas
    vec2 w = cam + px / zoom;              // world pos on the main plane (depth 1)
    // ---- sky ----
    float sy = clamp((w.y + 1200.0) / 2600.0, 0.0, 1.0); // 0 top .. 1 horizon-ish
    vec3 top = vec3(0.016, 0.028, 0.085), hor = vec3(0.13, 0.14, 0.26);
    hor = mix(hor, vec3(0.30, 0.20, 0.22), dawn);
    vec3 col = mix(top, hor, pow(sy, 1.4));
    // stars (depth 40: almost fixed)
    vec2 sw = cam/40.0 + px/zoom;
    vec2 sg = floor(sw/14.0); vec2 sf = fract(sw/14.0);
    float h = hash(sg);
    if (h > 0.955) { vec2 sp = vec2(hash(sg+1.7), hash(sg+3.1)); float dd = length(sf - sp)*14.0; float tw = 0.6+0.4*sin(time*3.0 + h*100.0);
      float s = smoothstep(1.6, 0.0, dd) * (0.35 + 0.65*hash(sg+9.0)) * tw; col += vec3(0.9,0.95,1.0) * s * (1.0 - sy*0.8); }
    // milky way band
    float mw = fbm(sw*0.0025 + 3.0) * smoothstep(0.35, 0.0, abs((sw.y*0.6 + sw.x*0.35)*0.0006 + 0.25));
    col += vec3(0.25,0.3,0.45) * mw * 0.35 * (1.0 - sy);
    // ---- moon (depth 30) ----
    vec2 mscr = (moon - cam/30.0) ; // moon world pos relative, parallax-fixed
    vec2 mpos = (moon - cam*0.03) * 1.0;
    vec2 dm = (w - moon);
    float md = length(dm);
    float moonR = 120.0;
    float glow = exp(-md/600.0) * 0.55 + exp(-md/180.0)*0.5;
    col += vec3(0.85, 0.88, 1.0) * glow * 0.55;
    float disc = smoothstep(moonR+2.0, moonR-2.0, md);
    float craters = 0.85 + 0.15*fbm(dm*0.03);
    col = mix(col, vec3(0.93, 0.94, 0.90)*craters, disc);
    // ---- clouds (two parallax layers) ----
    for (int L = 0; L < 2; L++) {
      float depth = (L == 0) ? 6.0 : 2.6;
      vec2 cw = cam/depth + px/zoom;
      float drift = time * (L == 0 ? 18.0 : 42.0);
      float band = smoothstep(-900.0, 300.0, cw.y) * smoothstep(1800.0, 600.0, cw.y);
      float c = fbm(vec2(cw.x + drift, cw.y*1.6) * 0.0016 + float(L)*5.0);
      c = smoothstep(0.48, 0.78, c) * band * (L == 0 ? 0.55 : 0.8);
      vec3 cc = mix(vec3(0.10, 0.11, 0.18), vec3(0.55, 0.58, 0.72), exp(-distance(cw, moon)/900.0));
      col = mix(col, cc, c * 0.85);
    }
    // ---- landscape ----
    // far mountains (depth 4)
    { vec2 mwp = cam/4.0 + px/zoom; float hgt = 300.0 - ridge(mwp.x, 1.3)*520.0; float haze = smoothstep(hgt-400.0, hgt+600.0, mwp.y);
      vec3 mc = mix(vec3(0.07,0.09,0.17), vec3(0.03,0.04,0.09), haze);
      float rl = ringLight(mwp * 1.6); float rock = fbm(mwp*0.03)*0.5+0.5;
      mc += vec3(0.30,0.42,0.48) * rl * 0.6 * rock;
      float m = step(hgt, mwp.y); col = mix(col, mc, m); }
    // mid hills (depth 2.2) — forest texture revealed by ring
    { vec2 hw = cam/2.2 + px/zoom; float hgt = 650.0 - ridge(hw.x+4000.0, 2.7)*380.0; float m = step(hgt, hw.y);
      float forest = fbm(hw*0.02)*0.45 + fbm(hw*0.09)*0.3 + fbm(hw*0.35)*0.25; float slope = ridge(hw.x+4002.0, 2.7) - ridge(hw.x+3998.0, 2.7);
      float trees = smoothstep(0.35, 0.75, fbm(hw*vec2(0.25, 0.6) + 7.0));
      float depthFade = smoothstep(hgt, hgt + 900.0, hw.y);
      vec3 dark = vec3(0.025,0.035,0.06); vec3 lit = mix(vec3(0.10,0.28,0.28), vec3(0.46,0.72,0.64), forest) * (0.55 + 0.45*trees);
      float moonlit = 0.07 + 0.10*clamp(-slope*40.0, 0.0, 1.0);
      float rl = ringLight(hw);
      vec3 hc = dark + lit * (moonlit + rl*1.4) * (1.0 - 0.35*depthFade);
      col = mix(col, hc, m); }
    // valley floor with river (depth 1.4)
    { vec2 vw = cam/1.4 + px/zoom; float hgt = 1050.0 - ridge(vw.x+9000.0, 4.1)*160.0; float m = step(hgt, vw.y);
      float f = fbm(vw*0.015)*0.6 + fbm(vw*0.08)*0.25 + fbm(vw*0.3)*0.15; float riverC = 1500.0 + sin(vw.x*0.0012)*500.0 + fbm(vec2(vw.x*0.002, 2.0))*700.0;
      float river = smoothstep(90.0, 30.0, abs(vw.y - riverC - 350.0*sin(vw.x*0.0007+1.0)));
      float meadow = smoothstep(0.4, 0.7, fbm(vw*0.004 + 3.0));
      vec3 dark = vec3(0.02,0.03,0.05); vec3 lit = mix(mix(vec3(0.12,0.28,0.20), vec3(0.40,0.56,0.34), f), vec3(0.55,0.60,0.40)*f, meadow*0.6);
      vec3 water = vec3(0.35,0.5,0.75) * (0.6 + 0.4*sin(vw.x*0.1 + time*2.0 + vw.y*0.05));
      float rl = ringLight(vw);
      vec3 vc = dark + lit * (0.07 + rl*1.3);
      vc = mix(vc, water * (0.15 + rl*1.2), river);
      col = mix(col, vc, m); }
    // ring in the air (faint)
    { float d = distance(w, ring.xy); float r = ring.w*ring.z; float a = ring.z > 0.0 ? smoothstep(ringP.z*1.5, 0.0, abs(d - r)) * ringP.x * exp(-ring.z/(ringP.y*2.0)) * 0.25 : 0.0; col += vec3(0.75,0.9,1.0)*a; }
    o = vec4(col, 1.0);
  }`;

  S.init = function () {
    const c = document.createElement('canvas'); c.width = 960; c.height = 540; S.canvas = c;
    const gl = c.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true }); S.gl = gl;
    if (!gl) { console.error('no webgl2'); return; }
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(x)); return x; };
    const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog); S.prog = prog;
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    S.u = {}; for (const n of ['res', 'time', 'cam', 'zoom', 'ring', 'ringP', 'moon', 'valley', 'dawn']) S.u[n] = gl.getUniformLocation(prog, n);
    gl.viewport(0, 0, c.width, c.height);
  };
  // render the sky for camera cam at time t; ring = {x,y,t0,speed,bright,tau,width} or null
  S.render = function (t, cam, ring, moon, dawn) {
    const gl = S.gl; if (!gl) return;
    gl.useProgram(S.prog);
    gl.uniform2f(S.u.res, 1920, 1080); // in main-canvas px units (scaled)
    gl.uniform1f(S.u.time, t);
    gl.uniform2f(S.u.cam, cam.x + (cam.sx || 0), cam.y + (cam.sy || 0));
    gl.uniform1f(S.u.zoom, cam.zoom);
    if (ring && t >= ring.t0) { gl.uniform4f(S.u.ring, ring.x, ring.y, t - ring.t0, ring.speed); gl.uniform3f(S.u.ringP, ring.bright, ring.tau, ring.width); }
    else { gl.uniform4f(S.u.ring, 0, 0, 0, 1); gl.uniform3f(S.u.ringP, 0, 1, 1); }
    gl.uniform2f(S.u.moon, moon[0], moon[1]);
    gl.uniform1f(S.u.valley, 1); gl.uniform1f(S.u.dawn, dawn || 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish();
  };
})();
