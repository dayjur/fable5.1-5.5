// temporary stub used until the real characters.js exists
(function () {
  if (window.CHAR) return;
  const C = {};
  window.CHAR = C;
  C.drawBat = function (ctx, p) { ctx.save(); ctx.scale(p.scale || 1, p.scale || 1); if (p.rot) ctx.rotate(p.rot); ctx.fillStyle = p.kind === 'nan' ? '#6f6358' : '#8c87a8'; ctx.beginPath(); ctx.arc(0, -40, 36, 0, 6.283); ctx.fill(); ctx.beginPath(); ctx.ellipse(0, 10, 28, 36, 0, 0, 6.283); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-12, -45, 8, 0, 6.283); ctx.arc(12, -45, 8, 0, 6.283); ctx.fill(); ctx.restore(); };
  C.drawBatEyesOnly = function (ctx, p) { ctx.save(); ctx.scale(p.scale || 1, p.scale || 1); ctx.fillStyle = '#cfe8ff'; ctx.beginPath(); ctx.arc(-12, -45, 7, 0, 6.283); ctx.arc(12, -45, 7, 0, 6.283); ctx.fill(); ctx.restore(); };
  C.drawGus = function (ctx, p) { ctx.save(); ctx.scale(p.scale || 1, p.scale || 1); ctx.fillStyle = p.lit > 0.5 ? '#8dff6a' : '#3a5a3a'; ctx.beginPath(); ctx.ellipse(0, 0, 18, 8, 0, 0, 6.283); ctx.fill(); ctx.restore(); };
  C.drawFlockBat = function (ctx, p) { ctx.save(); ctx.scale(p.scale || 1, p.scale || 1); ctx.rotate(p.rot || 0); ctx.fillStyle = p.tint || '#2a3340'; const f = Math.sin((p.flap || 0) * 6.283) * 10; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-30, -8 + f); ctx.lineTo(-10, 4); ctx.lineTo(0, 10); ctx.lineTo(10, 4); ctx.lineTo(30, -8 + f); ctx.closePath(); ctx.fill(); ctx.restore(); };
  C.gusAnchor = function (p) { return { x: 6 * (p.scale || 1), y: 12 * (p.scale || 1) }; };
  C.headAnchor = function (p) { const s = p.scale || 1; return { x: 0, y: -40 * s, mouthX: (p.flipX ? -14 : 14) * s, mouthY: -30 * s }; };
})();
