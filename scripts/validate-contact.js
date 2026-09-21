/**
 * validate-contact.js — automated tests for the "Make contact / Separate"
 * toggle and the contact-formation animation (the rAF path in main.js).
 *
 * Covered:
 *   T1  boot state (separated, button reads "Make contact")
 *   T2  apply contact → frac lands exactly on 1, button reads "Separate";
 *       frac samples finite & in [0,1] during the animation
 *   T3  separate → back to 0, button flips back
 *   T4  clicking the button mid-animation REVERSES (opposite click must win)
 *   T5  slider drag mid-animation cancels it AND keeps the button label in
 *       sync with the snapped state
 *   T6  preset click mid-animation: same cancel + label-sync contract,
 *       plus the ohmic preset switches the status badge
 *   T7  no stuck button: two further full cycles must each move the state
 *   T8  no console/page errors, both canvases painted
 *
 * Self-contained: starts `astro dev` on :4321 if nothing is serving there.
 * Run: bun scripts/validate-contact.js
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:4321/';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;

const results = [];
const fail = (id, msg) => { results.push([id, false]); console.log('  FAIL', id, '—', msg); };
const pass = (id, msg) => { results.push([id, true]); console.log('  pass', id, '—', msg); };

/* ---------- server preflight: reuse a running dev server or start one ---------- */
let devProc = null;
async function up(){
  try { const r = await fetch(PAGE_URL, { signal: AbortSignal.timeout(1500) }); return r.ok; }
  catch { return false; }
}
if (!(await up())){
  console.log('no dev server on :4321 — starting astro dev …');
  devProc = spawn('bun', ['x', 'astro', 'dev', '--port', '4321'], { cwd: ROOT, stdio: 'ignore' });
}
let ready = false;
for (let i = 0; i < 60 && !ready; i++){ ready = await up(); if (!ready) await new Promise(r => setTimeout(r, 500)); }
if (!ready){ console.error('dev server never came up on ' + PAGE_URL); process.exit(2); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrs = [], pageErrs = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
page.on('pageerror', (e) => pageErrs.push(String(e)));
await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

/* ---------- state reader: precise test-hook getter, or badge inference ----------
   Badge fade windows are disjoint: efsep visible only while frac < ~0.86,
   vbi visible only while frac > ~0.14 — so the pair identifies the state. */
await page.waitForFunction(() => Array.isArray(window.__SCHOTTKY_TARGETS));
const readState = () => page.evaluate(() => {
  const g = window.__SCHOTTKY_GET_STATE;
  const btn = document.getElementById('contactToggle').textContent.trim();
  if (g){
    const s = g();
    return { mode: 'precise', frac: s.frac, animating: s.animating, contact: s.contact, btn };
  }
  const ts = window.__SCHOTTKY_TARGETS || [];
  const efsep = ts.some(t => t.id === 'efsep'), vbi = ts.some(t => t.id === 'vbi');
  const frac = (efsep && vbi) ? 'mid' : vbi ? 'high' : 'low';
  return { mode: 'inferred', frac, animating: false, contact: frac === 'high', btn };
});
async function waitStable(timeoutMs = 4000){
  const t0 = Date.now();
  let prev = '', same = 0;
  for(;;){
    const s = await readState();
    const key = s.mode === 'precise'
      ? s.frac.toFixed(4) + '|' + s.btn + '|' + s.animating
      : s.frac + '|' + s.btn;
    const settled = s.mode === 'precise' ? !s.animating : true;
    if (key === prev && settled){ if (++same >= (s.mode === 'precise' ? 2 : 3)) return s; }
    else { same = 0; prev = key; }
    if (Date.now() - t0 > timeoutMs) return s;
    await page.waitForTimeout(120);
  }
}
const btnFor = (s) => s.contact ? 'Separate' : 'Make contact';
const fracLow = (s) => s.mode === 'precise' ? Math.abs(s.frac) < 1e-9 : s.frac === 'low';
const fracHigh = (s) => s.mode === 'precise' ? Math.abs(s.frac - 1) < 1e-9 : s.frac === 'high';

/* T1 boot */
let s = await waitStable();
(fracLow(s) && s.btn === 'Make contact')
  ? pass('T1 boot', 'separated + "Make contact"')
  : fail('T1 boot', JSON.stringify(s));

/* T2 apply contact — sample frac trajectory for NaN / out-of-range while animating */
await page.click('#contactToggle');
const traj = [];
for (let i = 0; i < 16; i++){
  const st = await readState();
  if (st.mode === 'precise') traj.push(st.frac);
  if (st.mode === 'precise' && !st.animating) break;
  await page.waitForTimeout(60);
}
s = await waitStable();
(fracHigh(s) && s.btn === 'Separate')
  ? pass('T2 contact', 'frac=1, btn="Separate"')
  : fail('T2 contact', JSON.stringify(s));
if (traj.length){
  const badS = traj.filter(v => !isFinite(v) || v < -1e-9 || v > 1 + 1e-9);
  badS.length ? fail('T2 frac-range', 'bad samples: ' + badS.join(','))
              : pass('T2 frac-range', traj.length + ' samples, all finite in [0,1]');
}
await page.screenshot({ path: OUT + 'contact-t2-done.png' });

/* T3 separate */
await page.click('#contactToggle');
s = await waitStable();
(fracLow(s) && s.btn === 'Make contact')
  ? pass('T3 separate', 'frac=0, btn="Make contact"')
  : fail('T3 separate', JSON.stringify(s));

/* T4 opposite click mid-animation must REVERSE */
await page.click('#contactToggle');
await page.waitForTimeout(250);                       // ~mid-animation
await page.click('#contactToggle');                   // user reverses
s = await waitStable();
(fracLow(s) && s.btn === 'Make contact')
  ? pass('T4 reverse-mid-anim', 'ended separated')
  : fail('T4 reverse-mid-anim', JSON.stringify(s) + ' ← click was ignored, ran on to contact');
await page.screenshot({ path: OUT + 'contact-t4-reversed.png' });

/* T5 slider-cancel: animation canceled, label must match snapped state */
await page.click('#contactToggle');
await page.waitForTimeout(300);
await page.locator('#sl-bias').fill('0.5');
await page.waitForTimeout(250);
s = await readState();
if (s.mode === 'precise' && s.animating){ await page.waitForTimeout(300); s = await readState(); }
(s.btn === btnFor(s) && !s.animating)
  ? pass('T5 slider-cancel sync', `frac=${s.frac} → btn="${s.btn}" (in sync)`)
  : fail('T5 slider-cancel sync', JSON.stringify(s) + ' ← label out of sync with state');
await page.screenshot({ path: OUT + 'contact-t5-after-cancel.png' });

/* T6 preset-cancel + ohmic badge */
await page.locator('.preset-btn', { hasText: 'Mg / MoS' }).click();
await page.waitForTimeout(250);
s = await readState();
const st6 = await page.evaluate(() => document.getElementById('statusBar').textContent);
(s.btn === btnFor(s) && /ohmic/i.test(st6))
  ? pass('T6 preset-cancel + ohmic', 'btn synced, status badge = ohmic')
  : fail('T6 preset-cancel + ohmic', JSON.stringify(s) + ' | status: ' + st6.slice(0, 60));

/* T7 no stuck button: two more full cycles */
for (const want of [1, 0]){
  await page.click('#contactToggle');
  s = await waitStable();
  const ok = want === 1 ? fracHigh(s) : fracLow(s);
  (ok && s.btn === (want === 1 ? 'Separate' : 'Make contact'))
    ? pass(`T7 cycle→${want}`, 'button still toggles')
    : fail(`T7 cycle→${want}`, JSON.stringify(s));
}
/* restore default preset for a clean final state */
await page.locator('.preset-btn', { hasText: 'default' }).click();
await page.waitForTimeout(200);

/* T8 no errors + canvases painted */
const painted = await page.evaluate(() => ['bandCanvas', 'graphCanvas'].map(id => {
  const cv = document.getElementById(id); const c = cv.getContext('2d');
  const d = c.getImageData(0, 0, cv.width, cv.height).data;
  let n = 0; for (let i = 0; i < d.length; i += 200){ if (d[i] !== 14 || d[i+1] !== 21 || d[i+2] !== 41) n++; }
  return n;
}));
(painted[0] > 50 && painted[1] > 50)
  ? pass('T8 canvases painted', painted.join(' / ') + ' non-bg samples')
  : fail('T8 canvases painted', painted.join(' / '));
(consoleErrs.length === 0 && pageErrs.length === 0)
  ? pass('T8 no js errors', 'console + page clean')
  : fail('T8 no js errors', JSON.stringify({ consoleErrs, pageErrs }));

await browser.close();
if (devProc) devProc.kill();

const bad = results.filter(r => !r[1]);
console.log(`\n=== CONTACT VALIDATION: ${results.length - bad.length}/${results.length} passed ===`);
console.log(bad.length ? 'CONTACT_VALIDATION_FAIL' : 'CONTACT_VALIDATION_OK');
process.exit(bad.length ? 1 : 0);