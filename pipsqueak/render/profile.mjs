import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve('..');
const script = JSON.parse(fs.readFileSync(path.join(root, 'script.json'), 'utf8'));
const lines = JSON.parse(fs.readFileSync(path.join(root, 'work/voices/lines.json'), 'utf8'));
const browser = await chromium.launch({ args: (process.env.FLAGS || '--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader').split(' ') });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.error('PAGE ERROR', e.message));
await page.goto('file://' + path.resolve('index.html'));
await page.evaluate(d => filmInit(d), { script, lines });
for (const f of process.argv.slice(2).map(Number)) {
  const r = await page.evaluate((i) => { const t0 = performance.now(); filmRender(i); const t1 = performance.now(); filmRender(i); const t2 = performance.now(); filmRender(i+1); const t3 = performance.now(); const d = document.getElementById('film').toDataURL('image/png'); const t4 = performance.now(); return [t1 - t0, t2 - t1, t3 - t2, t4 - t3]; }, f);
  console.log('frame', f, 'first', r[0].toFixed(0), 'second', r[1].toFixed(0), 'next', r[2].toFixed(0), 'png', r[3].toFixed(0));
}
await browser.close();
