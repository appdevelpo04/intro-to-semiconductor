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

import { resolvePageUrl } from './page-url.js';

const OUT = new URL('../screenshots/', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;

const { url: PAGE_URL, proc: devProc } = await resolvePageUrl();

const browser = await chromium.launch();
/* Shipped resolution profiles. Phones use their real DPR classes so this
   catches backing-store/CSS transform regressions, not just CSS reflow. */
const VIEWPORTS = [
  [1440, 900, 1], [1280, 700, 1],
  [1920, 1080, 1],                       /* 1080p */
  [2560, 1440, 1],                       /* 2K   */
  [390, 844, 2],                         /* phone portrait, Retina/2x */
  [430, 932, 3],                         /* large phone portrait, 3x */
];
const issues = [];
const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect();
  return { top: b.top, left: b.left, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };

const readArrowSnapshot = (page) => page.evaluate(() => {
  const cv = document.getElementById('bandCanvas');
  const b = cv.getBoundingClientRect();
  return {
    band: { left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height },
    inset: window.__SCHOTTKY_FERMI_INSET || null,
    targets: (window.__SCHOTTKY_TARGETS || []).map((t) => ({
      id: t.id, num: t.num, r: t.r,
      x: b.left + t.x, y: b.top + t.y,
      localX: t.x, localY: t.y,
      anchorX: t.anchorX, anchorY: t.anchorY,
      x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1,
    })),
  };
});

for (const [W, H, DPR] of VIEWPORTS){
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: DPR,
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Array.isArray(window.__SCHOTTKY_TARGETS));
  await page.waitForTimeout(400);

  const m = await page.evaluate(() => {
    /* BOTH demos now live on `/`, and the flow section reuses the same class
       names (.ctl-row, .panel-graph, .main …) for its own sidebar. Every
       selector here must therefore be scoped to #alignment, or it silently
       starts measuring the flow page's markup. */
    const SEC = '#alignment ';
    const R = (sel) => { const e = document.querySelector(SEC + sel.replace(/^#/, '#')); if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: b.top, left: b.left, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };
    const sub = (e) => { if (!e) return null; const b = e.getBoundingClientRect();
      return { top: b.top, left: b.left, right: b.right, bottom: b.bottom }; };
    const rows = [...document.querySelectorAll(SEC + '.ctl-row')]
      .filter((r) => r.querySelector('input[type=range]'))
      .map((r) => ({
        label: ((r.querySelector('.ctl-label') || {}).textContent || '').trim(),
        labelR: sub(r.querySelector('.ctl-label')),
        valR: sub(r.querySelector('.ctl-val')),
        sliderR: sub(r.querySelector('input[type=range]')),
      }));
    const canvas = (id) => {
      const cv = document.getElementById(id);
      const b = cv.getBoundingClientRect();
      const data = cv.getContext('2d');
      const farAlpha = [
        [Math.max(0, Math.floor(cv.width * 0.02)), Math.floor(cv.height / 2)],
        [Math.floor(cv.width / 2), Math.max(0, Math.floor(cv.height * 0.02))],
        [Math.min(cv.width - 1, Math.ceil(cv.width * 0.98) - 1), Math.floor(cv.height / 2)],
        [Math.floor(cv.width / 2), Math.min(cv.height - 1, Math.ceil(cv.height * 0.98) - 1)],
      ].map(([x, y]) => data.getImageData(x, y, 1, 1).data[3]);
      return {
        cssW: b.width, cssH: b.height, bw: cv.width, bh: cv.height,
        dpr: window.devicePixelRatio, farAlpha,
      };
    };
    const bandBox = document.getElementById('bandCanvas').getBoundingClientRect();
    const targets = (window.__SCHOTTKY_TARGETS || []).map((t) => ({
      id: t.id, num: t.num, r: t.r,
      x: bandBox.left + t.x, y: bandBox.top + t.y,
      localX: t.x, localY: t.y,
      anchorX: t.anchorX, anchorY: t.anchorY,
      x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1,
    }));
    const main = document.querySelector('#alignment .main');
    const legend = document.getElementById('legendItems');
    const legendStyle = getComputedStyle(legend);
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      headL: R('.panel-plot .panel-header'), headR: R('.panel-graph .panel-header'),
      band: R('#bandCanvas'), graph: R('#graphCanvas'),
      controls: R('.controls'), legend: R('.legend'), status: R('#statusBar'),
      rows, targets, inset: window.__SCHOTTKY_FERMI_INSET || null,
      stacked: getComputedStyle(main).gridTemplateColumns.split(' ').length === 1,
      legendVisible: +legendStyle.opacity > 0.05 && legendStyle.pointerEvents !== 'none',
      horizontalOverflow: Math.max(
        document.documentElement.scrollWidth, document.body.scrollWidth, main.scrollWidth,
      ) - document.documentElement.clientWidth,
      canvases: { band: canvas('bandCanvas'), graph: canvas('graphCanvas') },
    };
  });

  /* then scroll the scrollable regions to the bottom and re-check reachability */
  const m2 = await page.evaluate(() => {
    const pg = document.querySelector('#alignment .panel-graph');
    const main = document.querySelector('#alignment .main');
    if (pg) pg.scrollTop = pg.scrollHeight;
    if (main) main.scrollTop = main.scrollHeight;
    const b = document.getElementById('statusBar').getBoundingClientRect();
    return { bottom: b.bottom, vh: window.innerHeight };
  });

  const tag = W + 'x' + H;
  const flag = (id, cond, detail) => {
    if (!cond){ issues.push(tag + ' ' + id); console.log('  ✗ ' + tag + ' ' + id + ' — ' + detail); }
  };

  /* Arrow audit: targets must describe a real shaft attachment, not merely sit
     somewhere inside the canvas. Coordinates here are CSS pixels within the
     band canvas, matching the canvas transform and pointer offset space. */
  const checkArrowGeometry = (state, snapshot) => {
    flag(state + '-arrow-targets-present', snapshot.targets.length > 0,
      state + ' exposed no visible arrow targets');
    for (const t of snapshot.targets){
      const dx = t.x1 - t.x0, dy = t.y1 - t.y0;
      const len2 = dx * dx + dy * dy;
      const len = Math.sqrt(len2);
      const finite = [t.localX, t.localY, t.anchorX, t.anchorY, t.x0, t.y0, t.x1, t.y1]
        .every(Number.isFinite);
      if (!finite || len < 0.001){
        issues.push(tag + ' ' + state + '-arrow-geometry-invalid');
        console.log('  ✗ ' + tag + ' ' + state + '-arrow-geometry-invalid — ' + JSON.stringify(t));
        continue;
      }
      const u = ((t.anchorX - t.x0) * dx + (t.anchorY - t.y0) * dy) / len2;
      const sx = t.x0 + u * dx, sy = t.y0 + u * dy;
      const anchorDist = Math.hypot(t.anchorX - sx, t.anchorY - sy);
      const ox = t.localX - t.anchorX, oy = t.localY - t.anchorY;
      const along = Math.abs((ox * dx + oy * dy) / len);
      const perpendicular = Math.abs((ox * -dy + oy * dx) / len);
      const attached = u >= -0.001 && u <= 1.001 && anchorDist <= 0.5 && along <= 0.5 &&
        Math.abs(perpendicular - 12) <= 0.75;
      if (!attached){
        issues.push(tag + ' ' + state + '-arrow-detached-' + t.id);
        console.log('  ✗ ' + tag + ' ' + state + '-arrow-detached-' + t.id +
          ' — u=' + u.toFixed(3) + ', anchorDist=' + anchorDist.toFixed(2) +
          ', along=' + along.toFixed(2) + ', perpendicular=' + perpendicular.toFixed(2));
      }
      const inCanvas = t.localX - t.r >= 0 && t.localX + t.r <= snapshot.band.w &&
        t.localY - t.r >= 0 && t.localY + t.r <= snapshot.band.h;
      if (!inCanvas){
        issues.push(tag + ' ' + state + '-arrow-target-clipped-' + t.id);
        console.log('  ✗ ' + tag + ' ' + state + '-arrow-target-clipped-' + t.id);
      }
      const inset = snapshot.inset;
      if (inset && t.localX >= inset.x && t.localX <= inset.x + inset.w &&
          t.localY >= inset.y && t.localY <= inset.y + inset.h){
        issues.push(tag + ' ' + state + '-arrow-under-fermi-inset-' + t.id);
        console.log('  ✗ ' + tag + ' ' + state + '-arrow-under-fermi-inset-' + t.id);
      }
    }
  };
  const clickArrowTargets = async (state, snapshot) => {
    for (const t of snapshot.targets){
      await page.mouse.click(t.x, t.y);
      await page.waitForTimeout(40);
      const selected = await page.evaluate(() => document.getElementById('detailPanel')?.dataset.targetId || null);
      if (selected !== t.id){
        issues.push(tag + ' ' + state + '-arrow-wrong-detail-' + t.id);
        console.log('  ✗ ' + tag + ' ' + state + '-arrow-wrong-detail-' + t.id +
          ' — selected=' + selected);
      }
      await page.evaluate(() => document.getElementById('detailClose')?.click());
    }
  };

  // Refresh after the scroll-to-bottom probe so click coordinates are current.
  // The stacked phone layout scrolls the main column; keep the canvas in the
  // viewport before using page.mouse coordinates for a real pointer click.
  await page.locator('#bandCanvas').scrollIntoViewIfNeeded();
  await page.waitForTimeout(80);
  const separatedArrows = await readArrowSnapshot(page);
  checkArrowGeometry('separated', separatedArrows);
  await clickArrowTargets('separated', separatedArrows);

  await page.click('#contactToggle');
  await page.waitForFunction(() => {
    const state = window.__SCHOTTKY_GET_STATE?.();
    return state && state.contact && !state.animating;
  });
  const equilibriumArrows = await readArrowSnapshot(page);
  checkArrowGeometry('equilibrium', equilibriumArrows);
  await clickArrowTargets('equilibrium', equilibriumArrows);

  await page.screenshot({ path: OUT + 'layout-' + tag + '.png' });

  /* ---------- alignment assertions ---------- */
  // 1. side-by-side headers share a baseline; stacked phone panels flow
  // vertically with matching viewport width.
  const headersAligned = m.stacked
    ? Math.abs(m.headL.left - m.headR.left) < 0.5 &&
      Math.abs(m.headL.w - m.headR.w) < 1 &&
      m.headR.top >= m.headL.bottom - 1
    : Math.abs(m.headL.top - m.headR.top) < 0.5 && Math.abs(m.headL.h - m.headR.h) < 2;
  flag('headers-misaligned', headersAligned,
    `${m.stacked ? 'stacked' : 'side-by-side'}: ` +
    `L(${m.headL?.top.toFixed(1)}..${m.headL?.bottom.toFixed(1)},w=${m.headL?.w.toFixed(1)}) ` +
    `R(${m.headR?.top.toFixed(1)}..${m.headR?.bottom.toFixed(1)},w=${m.headR?.w.toFixed(1)})`);

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

  // 6. a visible legend must not cover arrow badges, and every target's full
  // touch circle must remain inside the band canvas.
  const col = m.legendVisible ? m.targets.filter((t) =>
    t.x > m.legend.left - 13 && t.x < m.legend.right + 13 &&
    t.y > m.legend.top - 13 && t.y < m.legend.bottom + 13) : [];
  flag('legend-hides-arrow-badge', col.length === 0,
    'badges under visible legend: ' + col.map((t) => t.id).join(','));
  const outside = m.targets.filter((t) => !m.band || t.x < m.band.left + 13 || t.x > m.band.right - 13 ||
    t.y < m.band.top + 13 || t.y > m.band.bottom - 13);
  flag('arrow-target-outside-canvas', outside.length === 0,
    'clipped targets: ' + outside.map((t) => t.id).join(','));

  // 7. responsive width and true high-DPI raster coverage
  flag('horizontal-overflow', m.horizontalOverflow <= 1,
    `content exceeds viewport by ${m.horizontalOverflow.toFixed(1)}px`);
  for (const [name, c] of Object.entries(m.canvases)){
    const expectedW = Math.round(c.cssW * c.dpr);
    const expectedH = Math.round(c.cssH * c.dpr);
    flag(name + '-backing-size', Math.abs(c.bw - expectedW) <= 1 && Math.abs(c.bh - expectedH) <= 1,
      `backing ${c.bw}x${c.bh} vs CSS ${c.cssW.toFixed(1)}x${c.cssH.toFixed(1)} @${c.dpr}x`);
    flag(name + '-unpainted-edges', c.farAlpha.every((a) => a === 255),
      `edge alpha samples ${c.farAlpha.join(',')}; DPR-scaled drawing may cover only 1/${c.dpr}`);
  }

  // 8. no page errors during the audit
  flag('js-errors', errs.length === 0, errs.join(' | '));

  await page.close();
}

await browser.close();
if (devProc) devProc.kill();

console.log('\n=== LAYOUT AUDIT: ' + (issues.length ? issues.length + ' ISSUE(S)' : 'CLEAN') + ' ===');
if (issues.length){ issues.forEach((i) => console.log('  - ' + i)); process.exit(1); }
process.exit(0);