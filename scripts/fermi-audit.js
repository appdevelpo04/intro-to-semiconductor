/**
 * fermi-audit.js — end-to-end audit of the Fermi–Dirac hero modal across
 * viewports, driven by Playwright.
 *
 * Checks, per viewport:
 *   1. the "Magnify f(E)" chip is visible, sits ON the f(E) inset of the band
 *      canvas, and never collides with the legend;
 *   2. the chip opens the modal, and the f(E) inset itself is clickable;
 *   3. the modal fits inside the viewport (no clipped header/footer);
 *   4. the plotted sigmoid has the CORRECT ORIENTATION — energy horizontal,
 *      f(E) vertical, decaying left→right. A transposed plot (f(E) on the
 *      horizontal axis, energy vertical) fails here;
 *   5. no text is clipped in the info cards / formula;
 *   6. click-outside and Escape both dismiss;
 *   7. no uncaught page errors.
 *
 * Run: bun scripts/fermi-audit.js   (starts astro dev on :4321 if needed)
 * Exit 0 = clean · 1 = problems found · 2 = dev server never came up
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 4321);
const ORIGIN = 'http://localhost:' + PORT;
// Astro is configured with base '/intro-to-semiconductor/'. In dev, '/' 404s
// while the real page lives under the base — probe both so the script works
// with or without an explicit PAGE_URL.
const CANDIDATES = [
  process.env.PAGE_URL,
  ORIGIN + '/intro-to-semiconductor/',
  ORIGIN + '/',
].filter(Boolean);

const OUT = new URL('../screenshots/', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;

let devProc = null;
let PAGE_URL = null;
const up = async (url) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; }
  catch { return false; }
};
const probe = async () => {
  for (const u of CANDIDATES){ if (await up(u)) return u; }
  return null;
};

PAGE_URL = await probe();
if (!PAGE_URL){
  console.log('no dev server on :' + PORT + ' — starting astro dev …');
  devProc = spawn('bun', ['x', 'astro', 'dev', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60 && !PAGE_URL; i++){
    PAGE_URL = await probe();
    if (!PAGE_URL) await new Promise((r) => setTimeout(r, 500));
  }
}
if (!PAGE_URL){ console.error('dev server never came up on :' + PORT); process.exit(2); }

/* Desktop-first, then the awkward ones: tablet portrait/landscape and the
   narrowest phones we support, where the modal must scroll rather than clip. */
const VIEWPORTS = [
  ['1920x1080', 1920, 1080], ['1440x900', 1440, 900], ['1280x800', 1280, 800],
  ['1024x768', 1024, 768],   ['834x1112', 834, 1112], ['768x1024', 768, 1024],
  ['430x932', 430, 932],     ['390x844', 390, 844],   ['360x640', 360, 640],
  ['844x390', 844, 390] /* landscape phone */,
];

const issues = [];
console.log('auditing ' + PAGE_URL + ' across ' + VIEWPORTS.length + ' viewports');
const browser = await chromium.launch();

for (const [tag, W, H] of VIEWPORTS){
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  const flag = (id, cond, detail) => {
    if (!cond){ issues.push(tag + ' ' + id); console.log('  ✗ ' + tag + ' ' + id + ' — ' + detail); }
  };

  try {
    await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Array.isArray(window.__SCHOTTKY_TARGETS));
    await page.waitForTimeout(400);

    /* ---------- 1. the chip must be visible and glued to the inset ---------- */
    const chip = await page.evaluate(() => {
      const btn = document.getElementById('fermiBtn');
      const band = document.getElementById('bandCanvas');
      const legend = document.querySelector('.legend');
      if (!btn || !band) return null;
      const b = btn.getBoundingClientRect();
      const c = band.getBoundingClientRect();
      const l = legend ? legend.getBoundingClientRect() : null;
      const i = window.__SCHOTTKY_FERMI_INSET;
      return {
        visible: getComputedStyle(btn).visibility === 'visible' && btn.offsetWidth > 0,
        legendDismissed: !!(legend && legend.classList.contains('dismissible')),
        btn: { top: b.top, left: b.left, right: b.right, bottom: b.bottom, w: b.width, h: b.height },
        band: { top: c.top, left: c.left, right: c.right, bottom: c.bottom },
        legend: l ? { top: l.top, left: l.left, right: l.right, bottom: l.bottom } : null,
        legendDismissed: !!legend && legend.classList.contains('dismissible'),
        inset: i ? {
          top: c.top + i.y, left: c.left + i.x,
          right: c.left + i.x + i.w, bottom: c.top + i.y + i.h,
        } : null,
      };
    });

    flag('chip-missing', !!chip && chip.visible, 'fermiBtn not visible after boot');
    if (chip){
      flag('chip-outside-canvas',
        chip.btn.left >= chip.band.left - 1 && chip.btn.right <= chip.band.right + 1 &&
        chip.btn.top >= chip.band.top - 1 && chip.btn.bottom <= chip.band.bottom + 1,
        `chip ${JSON.stringify(chip.btn)} vs band ${JSON.stringify(chip.band)}`);
      if (chip.inset){
        // The chip is parked just above the inset's top-right corner so it never
        // covers the sigmoid — hence the vertical slop of one chip height.
        flag('chip-not-on-inset',
          chip.btn.right > chip.inset.left && chip.btn.left < chip.inset.right &&
          chip.btn.bottom > chip.inset.top - chip.btn.h - 8 && chip.btn.top < chip.inset.bottom,
          `chip ${JSON.stringify(chip.btn)} vs inset ${JSON.stringify(chip.inset)}`);
        // ...and the inset itself must not be buried under the legend overlay:
        // renderBand lifts it by the legend's live height, so the whole frame has
        // to clear the legend box while the legend is still on screen.
        if (chip.legend && !chip.legendDismissed){
          const buried = chip.inset.top >= chip.legend.top - 1 &&
                         chip.inset.left >= chip.legend.left - 1 &&
                         chip.inset.right <= chip.legend.right + 1;
          flag('inset-hidden-by-legend', !buried,
            `f(E) inset ${JSON.stringify(chip.inset)} sits inside the legend box ` +
            `${JSON.stringify(chip.legend)}`);
        }
      }
      if (chip.legend && !chip.legendDismissed){
        const hit = chip.btn.left < chip.legend.right && chip.btn.right > chip.legend.left &&
                    chip.btn.top < chip.legend.bottom && chip.btn.bottom > chip.legend.top;
        flag('chip-under-legend', !hit, 'magnify chip is hidden behind the legend');
      }
    }

    /* ---------- 2. the chip opens the modal ---------- */
    await page.click('#fermiBtn');
    await page.waitForTimeout(460);                    // let the scale-in settle
    flag('modal-did-not-open',
      await page.evaluate(() => !!document.querySelector('.fermi-overlay.active')),
      'clicking #fermiBtn left the overlay inactive');

    /* ---------- 3. the modal must fit the viewport ---------- */
    const geo = await page.evaluate(() => {
      const modal = document.querySelector('.fermi-modal');
      const cv = document.getElementById('fermiCanvas');
      if (!modal || !cv) return null;
      const m = modal.getBoundingClientRect();
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        modal: { top: m.top, left: m.left, right: m.right, bottom: m.bottom, w: m.width, h: m.height },
        canvas: { w: cv.offsetWidth, h: cv.offsetHeight, bw: cv.width, bh: cv.height },
        dpr: window.devicePixelRatio || 1,
      };
    });
    flag('modal-geometry-missing', !!geo, 'modal/canvas not found');
    if (geo){
      flag('modal-wider-than-viewport', geo.modal.left >= -1 && geo.modal.right <= geo.vw + 1,
        `modal ${geo.modal.left.toFixed(1)}..${geo.modal.right.toFixed(1)} vs vw=${geo.vw}`);
      flag('modal-taller-than-viewport', geo.modal.top >= -1 && geo.modal.bottom <= geo.vh + 1,
        `modal ${geo.modal.top.toFixed(1)}..${geo.modal.bottom.toFixed(1)} vs vh=${geo.vh}`);
      flag('canvas-collapsed', geo.canvas.w > 120 && geo.canvas.h >= 180,
        `plot box is ${geo.canvas.w}x${geo.canvas.h}`);
      // the backing store must cover the CSS box, else the plot renders soft
      flag('canvas-blurry',
        geo.canvas.bw >= Math.round(geo.canvas.w * geo.dpr) - 1 &&
        geo.canvas.bh >= Math.round(geo.canvas.h * geo.dpr) - 1,
        `backing ${geo.canvas.bw}x${geo.canvas.bh} vs css ${geo.canvas.w}x${geo.canvas.h} @${geo.dpr}x`);
    }

    /* ---------- 4. orientation of the plotted sigmoid ----------
       Sample amber curve pixels in the left and right fifths of the plot area.
       The correct plot has f ≈ 1 on the left (high on screen → small y) and
       f ≈ 0 on the right (low on screen → large y), so meanY_left < meanY_right.
       A transposed chart (f(E) along the horizontal axis) puts both means near
       the same y and fails both assertions below. */
    const curve = await page.evaluate(() => {
      const cv = document.getElementById('fermiCanvas');
      if (!cv) return null;
      const ctx = cv.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      // generous insets: stay well inside the axes' padding at every breakpoint
      const x0 = Math.ceil(cv.width * 0.14), x1 = Math.floor(cv.width * 0.94);
      const y0 = Math.ceil(cv.height * 0.06), y1 = Math.floor(cv.height * 0.86);
      const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const isAmber = (i) => img[i] > 185 && img[i + 1] > 105 && img[i + 1] < 230 && img[i + 2] < 160;
      const band = Math.floor((x1 - x0) / 5);
      let nL = 0, sL = 0, nR = 0, sR = 0, total = 0;
      for (let x = x0; x <= x1; x++){
        for (let y = y0; y <= y1; y++){
          const i = (y * cv.width + x) * 4;
          if (!isAmber(i)) continue;
          total++;
          if (x < x0 + band){ nL++; sL += y; }
          else if (x > x1 - band){ nR++; sR += y; }
        }
      }
      return {
        total, plotH: y1 - y0, midY: (y0 + y1) / 2,
        leftMeanY: nL ? sL / nL : null,
        rightMeanY: nR ? sR / nR : null,
      };
    });
    flag('curve-not-drawn', !!curve && curve.total > 200,
      `only ${curve ? curve.total : 0} curve pixels found in the plot area`);
    if (curve && curve.total > 200){
      flag('curve-transposed',
        curve.leftMeanY !== null && curve.rightMeanY !== null &&
        curve.leftMeanY < curve.midY && curve.rightMeanY > curve.midY,
        `f(E) must decay left→right: meanY left=${curve.leftMeanY?.toFixed(1)} ` +
        `right=${curve.rightMeanY?.toFixed(1)} (mid=${curve.midY.toFixed(1)}) — a plot with ` +
        `f(E) on the horizontal axis is the classic transpose bug`);
      flag('curve-flat',
        (curve.rightMeanY ?? 0) - (curve.leftMeanY ?? 0) > curve.plotH * 0.5,
        `vertical travel only ${((curve.rightMeanY ?? 0) - (curve.leftMeanY ?? 0)).toFixed(1)}px ` +
        `of ${curve.plotH.toFixed(1)} — the sigmoid should sweep most of the plot height`);
    }

    /* ---------- 5. text clipping in the info cards / formula ---------- */
    const text = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.fermi-modal .fermi-info-value, .fermi-modal .fermi-info-label, ' +
                               '.fermi-modal .fermi-formula, .fermi-modal .fermi-modal-title')
        .forEach((el) => {
          if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
            bad.push((el.textContent || '').trim().slice(0, 30) || '<empty>');
        });
      const placeholders = [...document.querySelectorAll('.fermi-modal .fermi-info-value')]
        .filter((el) => (el.textContent || '').trim() === '—').length;
      const ov = document.querySelector('.fermi-overlay');
      return { bad, placeholders, ovScrollX: ov.scrollWidth > ov.clientWidth + 1 };
    });
    flag('modal-text-clipped', text.bad.length === 0, 'clipped: ' + JSON.stringify(text.bad));
    flag('info-cards-empty', text.placeholders === 0,
      text.placeholders + ' info card(s) still show the em-dash placeholder');
    flag('overlay-scrolls-horizontally', !text.ovScrollX, 'overlay has horizontal overflow');
    await page.screenshot({ path: OUT + 'fermi-modal-' + tag + '.png' });

    /* ---------- 6. dismissal: click outside, then Escape ---------- */
    const ob = await page.locator('.fermi-overlay').boundingBox();
    await page.mouse.click(ob.x + 6, ob.y + 6);       // inside overlay, outside modal
    await page.waitForTimeout(420);
    flag('click-outside-no-dismiss',
      !(await page.evaluate(() => !!document.querySelector('.fermi-overlay.active'))),
      'clicking the backdrop did not close the modal');

    await page.click('#fermiBtn');
    await page.waitForTimeout(420);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(420);
    flag('escape-no-dismiss',
      !(await page.evaluate(() => !!document.querySelector('.fermi-overlay.active'))),
      'Escape did not close the modal');


    /* ---------- 7. the painted inset is itself a click target ---------- */
    const hit = await page.evaluate(() => {
      const band = document.getElementById('bandCanvas');
      if (!band) return null;
      const c = band.getBoundingClientRect();
      const i = window.__SCHOTTKY_FERMI_INSET;
      if (!i) return null;
      // a point low inside the inset, clear of the chip parked above it
      return { x: c.left + i.x + i.w / 2, y: c.top + i.y + i.h * 0.75 };
    });
    if (hit){
      await page.mouse.click(hit.x, hit.y);
      await page.waitForTimeout(420);
      flag('inset-not-clickable',
        await page.evaluate(() => !!document.querySelector('.fermi-overlay.active')),
        'clicking the f(E) inset did not open the modal — the inset should magnify on click');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(260);
    }

    /* ---------- 8. no uncaught errors ---------- */
    flag('js-errors', errs.length === 0, errs.join(' | '));
  } catch (e){
    issues.push(tag + ' crashed');
    console.log('  ✗ ' + tag + ' crashed — ' + e.message);
  }
  await page.close();
}

await browser.close();
if (devProc) devProc.kill();

console.log('\n=== FERMI AUDIT: ' + (issues.length ? issues.length + ' ISSUE(S)' : 'CLEAN') + ' ===');
if (issues.length){
  for (const i of issues) console.log('  - ' + i);
  process.exit(1);
}
console.log('  chip anchoring · chart orientation · text fit · dismissal all OK');
