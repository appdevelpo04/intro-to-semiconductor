/**
 * layout-audit.js — loads the page in headless Chromium at several viewport
 * sizes, measures the REAL geometry of every major UI region and reports
 * misalignments: uneven panel headers, graph canvas painting over the slider
 * rows, ragged slider/value columns, legend ↔ arrow-badge collisions, bad
 * status-bar wrapping, unreachable status bar.
 *
 * Run: bun scripts/layout-audit.js   (starts astro dev on :4321 if needed)
 * Exit 0 = layout clean · 1 = misalignments found
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:4321/';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;

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
const VIEWPORTS = [[1440, 900], [1280, 700], [1920, 1080]];
const issues = [];
const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect();
  return { top: b.top, left: b.left, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };

for (const [W, H] of VIEWPORTS){
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Array.isArray(window.__SCHOTTKY_TARGETS));
  await page.waitForTimeout(400);

  const m = await page.evaluate(() => {
    const R = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: b.top, left: b.left, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };
    const sub = (e) => { if (!e) return null; const b = e.getBoundingClientRect();
      return { top: b.top, left: b.left, right: b.right, bottom: b.bottom }; };
    const rows = [...document.querySelectorAll('.ctl-row')]
      .filter((r) => r.querySelector('input[type=range]'))
      .map((r) => ({
        label: ((r.querySelector('.ctl-label') || {}).textContent || '').trim(),
        labelR: sub(r.querySelector('.ctl-label')),
        valR: sub(r.querySelector('.ctl-val')),
        sliderR: sub(r.querySelector('input[type=range]')),
      }));
    const bandBox = document.getElementById('bandCanvas').getBoundingClientRect();
    const targets = (window.__SCHOTTKY_TARGETS || []).map((t) => ({ id: t.id, x: bandBox.left + t.x, y: bandBox.top + t.y }));
    return {
      vh: window.innerHeight,
      headL: R('.panel-plot .panel-header'), headR: R('.panel-graph .panel-header'),
      band: R('#bandCanvas'), graph: R('#graphCanvas'),
      controls: R('.controls'), legend: R('.legend'), status: R('#statusBar'),
      rows, targets,
    };
  });

  /* then scroll the scrollable regions to the bottom and re-check reachability */
  const m2 = await page.evaluate(() => {
    const pg = document.querySelector('.panel-graph');
    const main = document.querySelector('.main');
    if (pg) pg.scrollTop = pg.scrollHeight;
    if (main) main.scrollTop = main.scrollHeight;
    const b = document.getElementById('statusBar').getBoundingClientRect();
    return { bottom: b.bottom, vh: window.innerHeight };
  });

  const tag = W + 'x' + H;
  const flag = (id, cond, detail) => {
    if (!cond){ issues.push(tag + ' ' + id); console.log('  ✗ ' + tag + ' ' + id + ' — ' + detail); }
  };
  await page.screenshot({ path: OUT + 'layout-' + tag + '.png' });

  /* ---------- alignment assertions ---------- */
  // 1. panel headers share one baseline (same top edge, same height)
  flag('headers-misaligned',
    m.headL && m.headR && Math.abs(m.headL.top - m.headR.top) < 0.5 && Math.abs(m.headL.h - m.headR.h) < 2,
    `L(top=${m.headL?.top.toFixed(1)},h=${m.headL?.h.toFixed(1)}) vs R(top=${m.headR?.top.toFixed(1)},h=${m.headR?.h.toFixed(1)})`);

  // 2. graph canvas must NOT overlap the controls block (graph painted over sliders)
  const graphBottom = m.graph?.bottom ?? 0, controlsTop = m.controls?.top ?? 1e9;
  flag('graph-overlaps-controls', graphBottom <= controlsTop + 0.5,
    `graph.bottom=${graphBottom.toFixed(1)} > controls.top=${controlsTop.toFixed(1)} (Δ=${(graphBottom - controlsTop).toFixed(1)}px)`);

  // 3. value cells right-aligned with each other and with slider right edge
  const vr = m.rows.map((r) => r.valR.right);
  const sr = m.rows.map((r) => r.sliderR.right);
  const maxDev = (a) => Math.max(...a.map((v) => Math.abs(v - a[0])));
  flag('value-cells-not-aligned', maxDev(vr) < 1,
    'value right edges vary by ' + maxDev(vr).toFixed(1) + 'px: ' + vr.map((v) => v.toFixed(0)).join(','));
  flag('sliders-not-full-width', maxDev(sr) < 1 && Math.abs(sr[0] - vr[0]) < 3,
    `slider/value right-edge gap ${Math.abs(sr[0] - vr[0]).toFixed(1)}px, spread ${maxDev(sr).toFixed(1)}px`);

  // 4. status bar reachable after scrolling to the bottom
  flag('status-unreachable', m2.bottom <= m2.vh + 1,
    `status.bottom=${m2.bottom.toFixed(1)} vs viewport=${m2.vh}`);

  // 5. status fragments: each "name = value" pair must wrap as a UNIT — no
  //    line may start with an orphan separator ("= 0.65 V", "· W = …")
  const orphan = await page.evaluate(() => {
    const parts = [...document.querySelectorAll('#statusBar .stat-i:not(.sep)')];
    return parts.filter((el) => /^[=·]/.test((el.textContent || '').trim())).map((el) => el.textContent.slice(0, 24));
  });
  const wrapLines = await page.evaluate(() => {
    const st = document.getElementById('statusBar');
    const fs = parseFloat(getComputedStyle(st).fontSize);
    return Math.round(st.getBoundingClientRect().height / (fs * 1.45));
  });
  flag('status-orphan-fragments', orphan.length === 0, 'orphan fragments: ' + JSON.stringify(orphan));
  flag('status-too-tall', wrapLines <= 6, `status bar wraps to ${wrapLines} lines`);

  // 6. legend must not collide with any arrow badge (band canvas is left panel)
  const col = m.targets.filter((t) => m.legend &&
    t.x > m.legend.left - 13 && t.x < m.legend.right + 13 &&
    t.y > m.legend.top - 13 && t.y < m.legend.bottom + 13);
  flag('legend-hides-arrow-badge', col.length === 0,
    'badges under legend: ' + col.map((t) => t.id).join(','));

  // 7. no page errors during the audit
  flag('js-errors', errs.length === 0, errs.join(' | '));

  await page.close();
}

await browser.close();
if (devProc) devProc.kill();

console.log('\\n=== LAYOUT AUDIT: ' + (issues.length ? issues.length + ' ISSUE(S)' : 'CLEAN') + ' ===');
if (issues.length){ issues.forEach((i) => console.log('  - ' + i)); process.exit(1); }
process.exit(0);