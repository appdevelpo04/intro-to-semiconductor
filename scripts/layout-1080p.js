/**
 * layout-1080p.js — ONE combined layout entry point for BOTH pages at 1080P.
 *
 * Why this exists: `layout-audit.js` only ever measured the Schottky page at `/`.
 * The electron-flow page at `/flow/` had NO layout coverage at all, which is how
 * a broken layout ships green. This treats both pages as first-class and applies
 * the same invariants to each.
 *
 * A "function window" is every interactive region, and each is an entry point
 * that must be reachable, correctly sized and non-overlapping at 1080P: the two
 * panel headers, the canvas (CSS box AND backing store, incl. DPR), the sidebar's
 * scroll container and every control inside it, and the legend/key/status blocks.
 *
 * Asserted per page per viewport:
 *   L1 no horizontal overflow        L6 sidebar scrolls and is fully reachable
 *   L2 backing store = CSS × DPR     L7 every control sized and in-viewport
 *   L3 canvas painted to its edges   L8 the two panels do not overlap
 *   L4 headers share a baseline      L9 no JS errors, no failed requests
 *   L5 canvas never overlaps controls
 *
 * 1080P is checked FIRST (it is the stated target and presentation resolution);
 * the rest are regressions.
 *
 * Run: bun scripts/layout-1080p.js   (starts astro dev on :4321 if needed)
 */
import { chromium } from 'playwright';
import { resolvePageUrl } from './page-url.js';

const OUT = new URL('../screenshots/', import.meta.url).pathname;
const results = [];
const fail = (id, msg) => { results.push([id, false]); console.log('  FAIL', id, '—', msg); };
const pass = (id, msg) => { results.push([id, true]); console.log('  pass', id, '—', msg); };

const { url: BASE, proc: devProc } = await resolvePageUrl();
const origin = BASE.replace(/\/$/, '');

/* 1080P first — it is the stated target. */
const VIEWPORTS = [
  [1920, 1080, 1],
  [1600, 900, 1],
  [1366, 768, 1],
  [1280, 800, 2],        // Retina laptop
  [390, 844, 3],         // phone, 3x
];

/* Both demos are sections of ONE page now (`/`), so `scrollTo` is what puts
   the section under test into the viewport before anything is measured.
   Selectors are scoped by section id because the two sections reuse the same
   class names (.panel-plot, .panel-graph, .panel-header). */
const PAGES = [
  {
    name: 'schottky', path: '/', scrollTo: '#alignment', canvas: 'bandCanvas',
    main: '#alignment .main',
    headL: '#alignment .panel-plot .panel-header', headR: '#alignment .panel-graph .panel-header',
    left: '#alignment .panel-plot', right: '#alignment .panel-graph',
    controls: '#alignment .controls', scroll: '#alignment .panel-graph',
    interactions: ['#alignment #contactToggle', '#alignment .preset-btn',
                   '#alignment #sl-bias', '#alignment #fermiBtn', '#alignment .legend-tab'],
  },
  {
    name: 'flow', path: '/', scrollTo: '#flow', canvas: 'flowCanvas',
    main: '#flow .flow-main',
    headL: '#flow .flow-main .panel-plot .panel-header', headR: '#flow .flow-main .panel-graph .panel-header',
    left: '#flow .flow-main .panel-plot', right: '#flow .flow-main .panel-graph',
    controls: '#flow .flow-side', scroll: '#flow .flow-side',
    interactions: ['#flow #flowPlay', '#flow #flowReplay', '#flow #flowScrub',
                   '#flow .flow-stage-btn', '#flow .flow-key dt'],
  },
];

const browser = await chromium.launch();

for (const spec of PAGES) {
  console.log(`\n### ${spec.path}`);
  for (const [W, H, DPR] of VIEWPORTS) {
    const tag = `${spec.name} ${W}x${H}@${DPR}x`;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
    const errs = [], failed = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (msg) => { if (msg.type() === 'error') errs.push(msg.text()); });
    page.on('requestfailed', (r) => failed.push(r.url()));
    page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.url()} HTTP ${r.status()}`); });

    await page.goto(origin + spec.path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    /* The page scrolls between sections, so bring the section under test into
       view first — otherwise its controls sit a viewport below the fold and
       L7 "every control is in-viewport" fails on a perfectly good layout. */
    await page.evaluate((sel) => {
      const app = document.querySelector('.app');
      const el = document.querySelector(sel);
      if (app && el) {
        app.scrollTop = el.getBoundingClientRect().top - app.getBoundingClientRect().top + app.scrollTop;
      }
    }, spec.scrollTo);
    /* Settle the animation first: measuring a moving frame makes the numbers
       unreproducible and can read a transient overlap as a real one. */
    await page.evaluate(() => {
      if (window.__FLOW_PAUSE) window.__FLOW_PAUSE();
      if (window.__FLOW_SEEK) window.__FLOW_SEEK(1);
    });
    await page.waitForTimeout(250);

    const m = await page.evaluate((spec) => {
      const R = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { top: b.top, left: b.left, right: b.right, bottom: b.bottom, w: b.width, h: b.height };
      };
      const cv = document.getElementById(spec.canvas);
      const cb = cv.getBoundingClientRect();
      const g2 = cv.getContext('2d');
      const alphaAt = (fx, fy) => g2.getImageData(
        Math.max(0, Math.min(cv.width - 1, Math.round(cv.width * fx))),
        Math.max(0, Math.min(cv.height - 1, Math.round(cv.height * fy))),
        1, 1).data[3];
      const main = document.querySelector(spec.main);
      const interact = [...document.querySelectorAll(spec.interactions.join(','))].map((e) => {
        const b = e.getBoundingClientRect();
        return { w: b.width, h: b.height, visible: b.width > 0 && b.height > 0,
                 inViewport: b.left >= -1 && b.top >= -1 &&
                             b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1,
                 horizontallyContained: b.left >= -1 && b.right <= innerWidth + 1 };
      });
      const scroller = document.querySelector(spec.scroll);
      return {
        vw: innerWidth, vh: innerHeight,
        canvas: { cssW: cb.width, cssH: cb.height, bw: cv.width, bh: cv.height, dpr: devicePixelRatio,
                  left: cb.left, top: cb.top, right: cb.right, bottom: cb.bottom },
        alphas: [alphaAt(0.02, 0.5), alphaAt(0.5, 0.02), alphaAt(0.98, 0.5), alphaAt(0.5, 0.98)],
        headL: R(spec.headL), headR: R(spec.headR),
        left: R(spec.left), right: R(spec.right), controls: R(spec.controls),
        stacked: getComputedStyle(main).gridTemplateColumns.split(' ').length === 1,
        overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
                 - document.documentElement.clientWidth,
        scrollable: scroller ? { h: scroller.clientHeight, sh: scroller.scrollHeight } : null,
        interact,
      };
    }, spec);

    /* L1 horizontal overflow */
    (m.overflowX <= 1)
      ? pass(`${tag} L1 no h-overflow`, `content fits ${m.vw}px`)
      : fail(`${tag} L1 no h-overflow`, `exceeds viewport by ${m.overflowX.toFixed(1)}px`);

    /* L2 backing store = CSS x DPR */
    {
      const ew = Math.round(m.canvas.cssW * m.canvas.dpr), eh = Math.round(m.canvas.cssH * m.canvas.dpr);
      (Math.abs(m.canvas.bw - ew) <= 1 && Math.abs(m.canvas.bh - eh) <= 1)
        ? pass(`${tag} L2 backing size`, `${m.canvas.bw}x${m.canvas.bh} = CSS ${m.canvas.cssW.toFixed(0)}x${m.canvas.cssH.toFixed(0)} @${m.canvas.dpr}x`)
        : fail(`${tag} L2 backing size`, `${m.canvas.bw}x${m.canvas.bh} vs expected ${ew}x${eh}`);
    }

    /* L3 painted to the edges (catches a DPR canvas drawing into only 1/dpr) */
    (m.alphas.every((a) => a === 255))
      ? pass(`${tag} L3 painted edges`, `corner alpha ${m.alphas.join(',')}`)
      : fail(`${tag} L3 painted edges`, `corner alpha ${m.alphas.join(',')} — <255 means an unpainted edge`);

    /* L4 headers aligned */
    {
      const ok = m.stacked
        ? Math.abs(m.headL.left - m.headR.left) < 0.5 && Math.abs(m.headL.w - m.headR.w) < 1
        : Math.abs(m.headL.top - m.headR.top) < 0.5 && Math.abs(m.headL.h - m.headR.h) < 2;
      ok
        ? pass(`${tag} L4 headers aligned`, m.stacked ? 'stacked, equal widths' : `both y=${m.headL.top.toFixed(0)} h=${m.headL.h.toFixed(0)}`)
        : fail(`${tag} L4 headers aligned`, JSON.stringify({ l: m.headL, r: m.headR, stacked: m.stacked }));
    }

    /* L5 the canvas must not overlap the controls block — but ONLY where they
       actually share horizontal space. On desktop the canvas and the controls
       sit in different grid COLUMNS, so comparing their vertical extents is
       meaningless and produced a bogus 450px "overlap" on the pre-existing page. */
    if (m.controls) {
      const sharesColumn = m.canvas.left < m.controls.right - 0.5 && m.controls.left < m.canvas.right - 0.5;
      if (!sharesColumn) {
        pass(`${tag} L5 canvas/controls`, 'separate columns — no shared space to overlap');
      } else {
        (m.canvas.bottom <= m.controls.top + 0.5)
          ? pass(`${tag} L5 canvas/controls`, `canvas.bottom ${m.canvas.bottom.toFixed(1)} <= controls.top ${m.controls.top.toFixed(1)}`)
          : fail(`${tag} L5 canvas/controls`, `overlap ${(m.canvas.bottom - m.controls.top).toFixed(1)}px`);
      }
    }

    /* L6 sidebar scrolls internally and its content is reachable */
    if (m.scrollable) {
      const { h, sh } = m.scrollable;
      const overflows = sh > h + 1;
      console.log(`  info ${tag} L6 sidebar — content ${sh}px in a ${h}px box${overflows ? ' (scrolls)' : ' (fits)'}`);
      /* The invariant is REACHABILITY, not fitting: a sidebar taller than its
         box is fine as long as it scrolls internally. What must never happen is
         content that overflows with no way to scroll to it. */
      const reached = await page.evaluate((sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        e.scrollTop = e.scrollHeight;
        const r = e.getBoundingClientRect();
        const last = e.lastElementChild ? e.lastElementChild.getBoundingClientRect() : null;
        return { scrolled: e.scrollTop, maxScroll: e.scrollHeight - e.clientHeight,
                 bottom: r.bottom, innerH: innerHeight,
                 lastBottom: last ? last.bottom : null };
      }, spec.scroll);
      if (reached) {
        const fullyScrolled = !overflows || reached.scrolled >= reached.maxScroll - 1;
        const lastVisible = reached.lastBottom == null || reached.lastBottom <= reached.bottom + 1;
        (fullyScrolled && lastVisible)
          ? pass(`${tag} L6 sidebar reachable`,
              overflows ? `scrolled ${reached.scrolled}/${reached.maxScroll}px, last element visible`
                        : 'fits without scrolling')
          : fail(`${tag} L6 sidebar reachable`,
              `scrollTop ${reached.scrolled}/${reached.maxScroll}px, last element bottom ${reached.lastBottom} vs box ${reached.bottom}`);
      }
    }

    /* L7 every interactive control is sized and reachable */
    {
      /* Off-screen VERTICALLY is normal for a scrolling sidebar, and off-screen
         HORIZONTALLY is the real defect (a control pushed out of the layout).
         Measure horizontal containment separately. */
      const zero = m.interact.filter((i) => !i.visible);
      const offX = m.interact.filter((i) => i.visible && !i.horizontallyContained);
      (zero.length === 0 && offX.length === 0)
        ? pass(`${tag} L7 controls visible`, `${m.interact.length} controls all sized and within the viewport width`)
        : fail(`${tag} L7 controls visible`, `${m.interact.length} found: ${zero.length} zero-sized, ${offX.length} pushed outside horizontally`);
    }

    /* L8 the two panels do not overlap */
    if (m.left && m.right && !m.stacked) {
      (m.left.right <= m.right.left + 0.5)
        ? pass(`${tag} L8 panels side by side`, `left ends ${m.left.right.toFixed(0)}, right starts ${m.right.left.toFixed(0)}`)
        : fail(`${tag} L8 panels side by side`, `overlap ${(m.left.right - m.right.left).toFixed(1)}px`);
    }

    /* L9 clean console + assets */
    (errs.length === 0 && failed.length === 0)
      ? pass(`${tag} L9 no errors`, 'console clean, all assets loaded')
      : fail(`${tag} L9 no errors`, JSON.stringify({ errs, failed }));

    if (W === 1920 && H === 1080) {
      await page.screenshot({ path: OUT + `layout-1080p-${spec.name}.png` });
    }
    await page.close();
  }
}

await browser.close();
if (devProc) devProc.kill();

const bad = results.filter((r) => !r[1]);
console.log(`\n=== LAYOUT 1080P: ${results.length - bad.length}/${results.length} passed ===`);
if (bad.length) { console.log('failures:'); bad.forEach(([id]) => console.log('  - ' + id)); }
console.log(bad.length ? 'LAYOUT_1080P_FAIL' : 'LAYOUT_1080P_OK');
process.exit(bad.length ? 1 : 0);
