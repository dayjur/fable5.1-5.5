// Renders test_characters.html (sheet 1 and 2) to work/characters_sheet*.png with Playwright.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = 'file://' + path.join(here, 'test_characters.html');
const out = path.join(here, '..', 'work');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.error('PAGE ERROR:', e.message));
page.on('console', m => console.log('console:', m.text()));
for (const [hash, file] of [['1', 'characters_sheet.png'], ['2', 'characters_sheet2.png']]) {
  await page.goto(html + '#' + hash);
  await page.reload();
  await page.waitForFunction(() => window.__done === true, null, { timeout: 10000 });
  await page.screenshot({ path: path.join(out, file) });
  console.log('wrote', file);
}
// performance probe
const perf = await page.evaluate(() => {
  const cv = document.createElement('canvas'); cv.width = 400; cv.height = 400;
  const ctx = cv.getContext('2d');
  const p = { kind: 'pip', pose: 'fly', scale: 1.5, flap: 0.3, eyes: { open: 1, pupil: 0.5 }, mouth: { viseme: 'A', open: 0.7, smile: 0.3 }, glowEyes: 0.5 };
  const N = 300;
  let t0 = performance.now();
  for (let i = 0; i < N; i++) { ctx.save(); ctx.translate(200, 200); p.flap = i / N; CHAR.drawBat(ctx, p); ctx.restore(); }
  const bat = (performance.now() - t0) / N;
  t0 = performance.now();
  for (let i = 0; i < N; i++) { ctx.save(); ctx.translate(200, 200); CHAR.drawBat(ctx, { kind: 'nan', pose: 'hang', scale: 1 }); ctx.restore(); }
  const nan = (performance.now() - t0) / N;
  t0 = performance.now();
  for (let i = 0; i < N; i++) { ctx.save(); ctx.translate(200, 200); CHAR.drawGus(ctx, { scale: 1, lit: 1, wiggle: i / N }); ctx.restore(); }
  const gus = (performance.now() - t0) / N;
  t0 = performance.now();
  for (let i = 0; i < 2000; i++) { ctx.save(); ctx.translate(200, 200); CHAR.drawFlockBat(ctx, { scale: 0.3, flap: i / 100 }); ctx.restore(); }
  const flock = (performance.now() - t0) / 2000;
  t0 = performance.now();
  for (let i = 0; i < N; i++) { ctx.save(); ctx.translate(200, 200); CHAR.drawBatEyesOnly(ctx, { kind: 'pip', pose: 'perch', scale: 1, glowEyes: 1 }); ctx.restore(); }
  const eyes = (performance.now() - t0) / N;
  return { batFlyMs: bat, nanHangMs: nan, gusMs: gus, flockMs: flock, eyesOnlyMs: eyes };
});
console.log('perf (ms per call):', JSON.stringify(perf));
await browser.close();
