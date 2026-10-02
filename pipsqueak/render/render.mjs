// render.mjs — drives headless Chromium to render frames, piping PNGs into ffmpeg segments.
// usage: node render.mjs [--start 0] [--end 5760] [--workers 4] [--out ../out] [--crf 16]
//        node render.mjs --sheet --every 48           (contact sheet of every 48th frame)
//        node render.mjs --frames 100,200,300          (single PNG frames to out/frames/)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true] : []).filter(x => x.length));

const script = JSON.parse(fs.readFileSync(path.join(root, 'script.json'), 'utf8'));
const linesPath = path.join(root, 'work/voices/lines.json');
const lines = fs.existsSync(linesPath) ? JSON.parse(fs.readFileSync(linesPath, 'utf8')) : { fps: 24, lines: [] };
const FPS = script.fps, TOTAL = Math.round(script.duration * FPS);
const start = parseInt(args.start || 0), end = Math.min(TOTAL, parseInt(args.end || TOTAL));
const workers = parseInt(args.workers || 4);
const outDir = path.resolve(root, args.out || 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => console.error('PAGE ERROR', e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.error('console:', m.text()); });
  await page.goto('file://' + path.join(here, 'index.html'));
  await page.evaluate(d => filmInit(d), { script, lines });
  return page;
}

const browser = await chromium.launch({ args: ['--disable-accelerated-2d-canvas', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });

if (args.events) {
  const page = await openPage(browser);
  const ev = await page.evaluate(() => filmEvents());
  fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(ev));
  console.log('events:', ev.events.length);
  await browser.close(); process.exit(0);
}

if (args.frames) {
  const page = await openPage(browser);
  for (const f of String(args.frames).split(',').map(Number)) {
    const t0 = Date.now();
    const data = await page.evaluate(i => filmFrameData(i), f);
    fs.writeFileSync(path.join(outDir, 'frames', `f${String(f).padStart(5, '0')}.png`), Buffer.from(data.split(',')[1], 'base64'));
    console.log('frame', f, (Date.now() - t0) + 'ms');
  }
  await browser.close(); process.exit(0);
}

if (args.sheet) {
  const every = parseInt(args.every || 48);
  const page = await openPage(browser);
  const list = []; for (let f = start; f < end; f += every) list.push(f);
  const cols = 6, cw = 480, ch = 270;
  const rows = Math.ceil(list.length / cols);
  // build sheet in-page
  await page.evaluate(({ list, cols, cw, ch }) => {
    const sheet = document.createElement('canvas'); sheet.width = cols * cw; sheet.height = Math.ceil(list.length / cols) * ch; sheet.id = 'sheet';
    const x = sheet.getContext('2d');
    list.forEach((f, k) => {
      filmRender(f);
      x.drawImage(document.getElementById('film'), (k % cols) * cw, Math.floor(k / cols) * ch, cw, ch);
      x.fillStyle = '#ff0'; x.font = '16px monospace'; x.fillText(`${f} (${(f / 24).toFixed(1)}s)`, (k % cols) * cw + 6, Math.floor(k / cols) * ch + 18);
    });
    document.body.appendChild(sheet);
  }, { list, cols, cw, ch });
  const data = await page.evaluate(() => document.getElementById('sheet').toDataURL('image/png'));
  const name = args.sheetName || `sheet_${start}_${end}_${every}.png`;
  fs.writeFileSync(path.join(outDir, name), Buffer.from(data.split(',')[1], 'base64'));
  console.log('sheet written', name, list.length, 'frames', rows, 'rows');
  await browser.close(); process.exit(0);
}

// ---- full render: contiguous ranges per worker, each piped into its own ffmpeg ----
const per = Math.ceil((end - start) / workers);
const crf = args.crf || '16';
const jobs = [];
for (let w = 0; w < workers; w++) {
  const a = start + w * per, b = Math.min(end, a + per);
  if (a >= b) continue;
  jobs.push((async () => {
    const page = await openPage(browser);
    const seg = path.join(outDir, `seg_${String(a).padStart(5, '0')}.mp4`);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p', '-tune', 'animation', seg], { stdio: ['pipe', 'inherit', 'inherit'] });
    let t0 = Date.now();
    for (let f = a; f < b; f++) {
      const data = await page.evaluate(i => filmFrameData(i), f);
      const buf = Buffer.from(data.split(',')[1], 'base64');
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if ((f - a) % 120 === 0) { console.log(`worker ${w}: frame ${f}/${b} (${((Date.now() - t0) / 1000).toFixed(0)}s)`); }
    }
    ff.stdin.end();
    await new Promise(r => ff.on('close', r));
    console.log(`worker ${w} done: ${seg} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return seg;
  })());
}
const segs = await Promise.all(jobs);
await browser.close();
fs.writeFileSync(path.join(outDir, 'segs.txt'), segs.map(s => `file '${s}'`).join('\n'));
console.log('segments:', segs.join(' '));
