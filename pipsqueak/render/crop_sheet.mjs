// Usage: node crop_sheet.mjs <sheet 1|2> <x> <y> <w> <h> <out.png>   (renders at 2x device scale)
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const [sheet, x, y, w, h, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
page.on('pageerror', e => console.error('PAGE ERROR:', e.message));
await page.goto('file://' + path.join(here, 'test_characters.html') + '#' + sheet);
await page.reload();
await page.waitForFunction(() => window.__done === true, null, { timeout: 10000 });
await page.screenshot({ path: path.join(here, '..', 'work', out), clip: { x: +x, y: +y, width: +w, height: +h } });
await browser.close();
console.log('wrote', out);
