/**
 * flow-e2e.js — drives the real page in headless Chromium and asserts the
 * interactive contract. Local-only (Playwright is deliberately kept out of CI,
 * per commit dc05d49); the pure-Node suites cover the physics and the pixels.
 *
 * Covered:
 *   E1  boot        stage A, canvas painted, 4 stage chips
 *   E2  playback    t advances and the metal population grows
 *   E3  equilibrium net flux is reported as 0 and `balanced`
 *   E4  pause/play  the button and the state agree, both ways
 *   E5  scrub       dragging jumps the timeline and pauses
 *   E6  stage chips clicking jumps to that stage's start
 *   E7  keyboard    Space toggles, arrows step, digits jump
 *   E8  no stuck    replay always restarts from 0
 *   E9  responsive  the canvas is visible and non-zero at 3 viewports
 *   E10 clean       no console errors, no page errors, no failed requests
 *
 * Run: bun scripts/flow-e2e.js   (starts astro dev on :4321 if needed)
 */
import { chromium } from 'playwright';
import { resolvePageUrl } from './page-url.js';

const OUT = new URL('../screenshots/', import.meta.url).pathname;
const results = [];
const fail = (id, msg) => { results.push([id, false]); console.log('  FAIL', id, '—', msg); };
const pass = (id, msg) => { results.push([id, true]); console.log('  pass', id, '—', msg); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const { url: BASE, proc: devProc } = await resolvePageUrl();
/* The flow demo is a section of `/` now, not its own route (see src/pages/
   index.astro). The old /flow/ URL is a redirect. Load the page and scroll the
   flow section into view before touching the canvas — the canvas is laid out at
   full size either way, but this matches what a user actually sees. */
const PAGE_URL = BASE.replace(/\/$/, '') + '/';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrs = [], pageErrs = [], failedReqs = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
page.on('pageerror', (e) => pageErrs.push(String(e)));
page.on('requestfailed', (r) => failedReqs.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.url() + ' HTTP ' + r.status()); });

await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  const app = document.querySelector('.app');
  const el = document.getElementById('flow');
  if (app && el) {
    app.scrollTop = el.getBoundingClientRect().top - app.getBoundingClientRect().top + app.scrollTop;
  }
});
await page.waitForFunction(() => typeof window.__FLOW_GET_STATE === 'function', { timeout: 15000 });

const state = () => page.evaluate(() => window.__FLOW_GET_STATE());
const seek = (t) => page.evaluate((v) => window.__FLOW_SEEK(v), t);
const pause = () => page.evaluate(() => window.__FLOW_PAUSE());
const play = () => page.evaluate(() => window.__FLOW_PLAY());
const painted = () => page.evaluate(() => {
  const cv = document.getElementById('flowCanvas');
  if (!cv) return { exists: false };
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 40) if (d[i] !== 14 || d[i + 1] !== 21 || d[i + 2] !== 41) n++;
  return { exists: true, w: cv.width, h: cv.height, nonBg: n };
});

/* ---------- E1 boot ---------- */
{
  const s = await state();
  const p = await painted();
  (s && s.stage === 'A' && p.exists && p.nonBg > 100)
    ? pass('E1 boot', `stage ${s.stage}, canvas ${p.w}×${p.h}, ${p.nonBg} non-bg samples`)
    : fail('E1 boot', JSON.stringify({ s, p }));
  const chips = await page.locator('.flow-stage-btn').count();
  chips === 4 ? pass('E1 stage chips', '4 chips rendered') : fail('E1 stage chips', chips + ' chips');
}

/* ---------- E2 playback: t advances, electrons accumulate ---------- */
{
  await seek(0);
  await play();
  /* Wait for the TRANSIENT, not a fixed delay: at 1.5 s of a 9 s timeline we
     are only at t≈0.17 (stage B), where the barrier is still blocking and no
     electron has completed its crossing. Asserting on a wall-clock delay here
     tested the wrong moment — wait for the state the claim is about. */
  await page.waitForFunction(
    () => { const s = window.__FLOW_GET_STATE(); return s.t > 0.35; },
    { timeout: 15000 });
  const s = await state();
  (s.t > 0.35 && s.metal > 0 && s.frac > 0)
    ? pass('E2 playback', `t = ${s.t.toFixed(3)} (stage ${s.stage}), ${s.metal}/${s.count} electrons arrived, f = ${s.frac.toFixed(3)}`)
    : fail('E2 playback', JSON.stringify(s));
  (s.netFlux > 0 && s.balanced === false)
    ? pass('E2 net flux during the transient', `net flux = ${s.netFlux.toFixed(3)} — one-way flow, as it must be`)
    : fail('E2 net flux during the transient', JSON.stringify(s));
  await page.screenshot({ path: OUT + 'flow-live-playing.png' });
}

/* ---------- E3 equilibrium: net flux exactly 0 ---------- */
{
  await pause();
  await seek(1);
  await page.waitForTimeout(120);
  const s = await state();
  (s.netFlux === 0 && s.balanced === true && near(s.frac, 1, 1e-9) && s.metal === s.count)
    ? pass('E3 equilibrium', `f = ${s.frac}, net flux = ${s.netFlux}, balanced, ${s.metal}/${s.count} transferred`)
    : fail('E3 equilibrium', JSON.stringify(s));
  await page.screenshot({ path: OUT + 'flow-live-equilibrium.png' });
}

/* ---------- E4 pause / play agreement ---------- */
{
  await seek(0.3);
  await play();
  await page.waitForTimeout(200);
  const running = await state();
  const labelRunning = (await page.locator('#flowPlay').textContent()).trim();
  await pause();
  const stopped = await state();
  const labelStopped = (await page.locator('#flowPlay').textContent()).trim();
  await page.waitForTimeout(250);
  const stillStopped = await state();
  (running.playing && labelRunning === 'Pause' &&
   !stopped.playing && labelStopped === 'Play' && stillStopped.t === stopped.t)
    ? pass('E4 pause/play', `"${labelRunning}" while running, "${labelStopped}" when paused, t frozen at ${stopped.t.toFixed(3)}`)
    : fail('E4 pause/play', JSON.stringify({ running, stopped, stillStopped, labelRunning, labelStopped }));
}

/* ---------- E5 scrub ---------- */
{
  await page.locator('#flowScrub').fill('800');
  await page.waitForTimeout(200);
  const s = await state();
  (near(s.t, 0.8, 0.02) && !s.playing && s.metal > 0)
    ? pass('E5 scrub', `scrub to 800 → t = ${s.t.toFixed(3)}, paused, ${s.metal} electrons transferred`)
    : fail('E5 scrub', JSON.stringify(s));
}


/* ---------- E6 stage chips ---------- */
{
  await page.locator('.flow-stage-btn[data-stage="C"]').click();
  await page.waitForTimeout(180);
  const s = await state();
  (s.stage === 'C' && near(s.t, 0.22, 0.01))
    ? pass('E6 stage chip', `clicked C → stage ${s.stage}, t = ${s.t.toFixed(3)} (expected 0.22)`)
    : fail('E6 stage chip', JSON.stringify(s));
  await page.locator('.flow-stage-btn[data-stage="A"]').click();
  await page.waitForTimeout(150);
  const back = await state();
  (back.stage === 'A' && back.t === 0 && back.metal === 0)
    ? pass('E6 back to A', `t = ${back.t}, ${back.metal} electrons in the metal`)
    : fail('E6 back to A', JSON.stringify(back));
}

/* ---------- E7 keyboard ---------- */
{
  await page.locator('body').click({ position: { x: 5, y: 5 } });   // focus, not a control
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  const afterSpace = await state();
  await page.keyboard.press('Space');
  await page.waitForTimeout(120);
  const afterSpace2 = await state();
  (afterSpace.playing === true && afterSpace2.playing === false)
    ? pass('E7 Space toggles', 'Space started it, Space stopped it')
    : fail('E7 Space toggles', JSON.stringify({ first: afterSpace.playing, second: afterSpace2.playing }));

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(140);
  const right = await state();
  await page.keyboard.press('4');
  await page.waitForTimeout(140);
  const jump = await state();
  (right.stage === 'B' && jump.stage === 'D')
    ? pass('E7 arrows/digits', `ArrowRight → ${right.stage}, "4" → ${jump.stage}`)
    : fail('E7 arrows/digits', JSON.stringify({ right: right.stage, jump: jump.stage }));
}

/* ---------- E8 replay restarts ---------- */
{
  await seek(1);
  await page.locator('#flowReplay').click();
  await page.waitForTimeout(250);
  const s = await state();
  (s.t < 0.2 && s.playing)
    ? pass('E8 replay', `replay from t=1 → t = ${s.t.toFixed(3)}, playing`)
    : fail('E8 replay', JSON.stringify(s));
  await pause();
}

/* ---------- E9 responsive ---------- */
{
  const viewports = [[1920, 1080], [1280, 700], [390, 844]];
  for (const [W, H] of viewports) {
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(350);
    const p = await painted();
    const box = await page.locator('#flowCanvas').boundingBox();
    const visible = box && box.width > 100 && box.height > 100;
    (p.exists && p.nonBg > 100 && visible)
      ? pass(`E9 ${W}×${H}`, `canvas ${Math.round(box.width)}×${Math.round(box.height)}, ${p.nonBg} samples`)
      : fail(`E9 ${W}×${H}`, JSON.stringify({ p, box }));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/* ---------- E10 clean ---------- */
{
  (consoleErrs.length === 0 && pageErrs.length === 0)
    ? pass('E10 no JS errors', 'console + page clean')
    : fail('E10 no JS errors', JSON.stringify({ consoleErrs, pageErrs }));
  (failedReqs.length === 0)
    ? pass('E10 no failed requests', 'all assets loaded')
    : fail('E10 no failed requests', JSON.stringify(failedReqs));
}

/* =====================================================
   E11 — the electrons are ACTUALLY PAINTED, and the page
         actually MOVES. The absence of these is how a
         completely empty diagram shipped as "17/17 passed".
   ===================================================== */

/* Count bright blue-dominant pixels inside a rect of the LIVE canvas. Reading
   real pixels is the only check that cannot be satisfied by a diagram whose
   geometry is all correct but whose electrons were never drawn. */
const countElectronPixels = (x0, y0, x1, y1) => page.evaluate(
  ([a, b, c, d]) => {
    const cv = document.getElementById('flowCanvas');
    const g = cv.getContext('2d');
    const img = g.getImageData(a, b, c - a, d - b).data;
    let n = 0;
    for (let i = 0; i < img.length; i += 4) {
      const r = img[i], gg = img[i + 1], bl = img[i + 2];
      /* electron strokes are #5aaaff / #eaf4ff: blue-dominant and bright */
      if (bl > 150 && bl > r + 30 && gg > r) n++;
    }
    return n;
  }, [x0, y0, x1, y1]);

const metalRect = async () => {
  const b = (await state()).geo.metalBox;
  return [Math.round(b.x), Math.round(b.y),
          Math.round(b.x + b.w), Math.round(b.y + b.h)];
};
const countInMetal = async () => countElectronPixels(...await metalRect());

{
  /* Freeze the clock before any pixel read. Sampling while the timeline is
     running let t drift between the seek and the getImageData. */
  await pause();
  await seek(0.5);
  await page.waitForTimeout(250);
  /* Read the geometry AFTER the seek, not before. `fullWidth` is the width of
     the unsplit full panel and it depends on t — at t=0 the canvas is not yet
     split, so a rectangle captured before the seek pointed at the wrong part of
     the magnified panel and read ~81px of it instead of thousands. It only
     passed by luck of whatever t the preceding tests happened to leave behind. */
  const g1 = (await state()).geo;
  const n = await countInMetal();
  n > 200
    ? pass('E11 electrons are painted in the metal at t=0.5', `${n} electron px`)
    : fail('E11 electrons are painted in the metal at t=0.5', `only ${n} electron px — the metal is EMPTY`);

  const zn = await countElectronPixels(Math.round(g1.fullWidth + 24), 0, g1.w, g1.h);
  zn > 200
    ? pass('E11b the magnified panel paints electrons too', `${zn} electron px`)
    : fail('E11b the magnified panel paints electrons too', `only ${zn} electron px`);

  /* The metal must be empty at t=0 and full at t=1. If both read the same,
     the "transferred charge" is cosmetic and nothing was ever drawn. */
  await seek(0);
  await page.waitForTimeout(200);
  const at0 = await countInMetal();
  await seek(1);
  await page.waitForTimeout(200);
  const at1 = await countInMetal();
  at1 > at0 * 3 && at1 > 200
    ? pass('E11c the metal fills up over the animation', `${at0}px at t=0 → ${at1}px at t=1`)
    : fail('E11c the metal fills up over the animation', `t=0 ${at0}px, t=1 ${at1}px — the transfer is not drawn`);

  /* --- the page must MOVE ON ITS OWN ---------------------------------- */
  await seek(0);
  await play();
  const t0 = (await state()).t;
  await page.waitForTimeout(1200);
  const t1 = (await state()).t;
  t1 > t0
    ? pass('E11d the timeline advances on its own', `t ${t0.toFixed(2)} → ${t1.toFixed(2)}`)
    : fail('E11d the timeline advances on its own', `stuck at t=${t0.toFixed(2)}`);
  await pause();
}

/* --- the crossing electron must be VISIBLE, not merely present ------------
   Every assertion above passed while the in-flight shells were drawn at only
   1.4x the resident radius: ~13px wireframe dots in a 1559px canvas — drawn
   correctly, asserted by the suite, and effectively invisible to a person
   watching. These assert the size the renderer actually drew, so "technically
   present but too small to see" becomes a failure. */
{
  await seek(0);
  await play();
  const sample = await page.evaluate(() => new Promise((res) => {
    let bestHot = 0, resident = 0, soloHot = 0, withAny = 0, total = 0;
    const t0 = performance.now();
    (function tick() {
      const s = window.__FLOW_GET_STATE();
      total++;
      if (s.hotR > 0) withAny++;
      if (s.hotR > bestHot) bestHot = s.hotR;
      if (s.residentR > 0) resident = s.residentR;
      if (s.inFlight === 1) soloHot = Math.max(soloHot, s.hotR);
      if (performance.now() - t0 < 6000) requestAnimationFrame(tick);
      else res({ bestHot, soloHot, resident, withAny, total });
    })();
  }));
  await pause();

  /* Why this is measured here and NOT from canvas pixels: the crossing lane also
     contains the E_C curve, the barrier wall, the labels and the semiconductor
     population. Their combined lit blob measured 2900px whether the crossing
     electron was a 17px filled sphere or an 9px invisible wireframe, so a pixel
     count there cannot tell a visible electron from an invisible one. The drawn
     radius is the thing the eye actually reacts to, and it is unambiguous. */
  const dia = (sample.soloHot * 2).toFixed(1);
  sample.soloHot > 0 && sample.soloHot >= sample.resident * 2
    ? pass('E11g a crossing electron is drawn far larger than a resident one',
        `Ø${dia}px vs Ø${(sample.resident * 2).toFixed(1)}px resident`)
    : fail('E11g a crossing electron is drawn far larger than a resident one',
        `Ø${dia}px vs Ø${(sample.resident * 2).toFixed(1)}px — too small to notice`);

  /* and big enough in absolute terms to be seen at a glance on a 1080p screen */
  sample.soloHot * 2 >= 20
    ? pass('E11h a crossing electron is at least 20px across',
        `Ø${dia}px`)
    : fail('E11h a crossing electron is at least 20px across', `Ø${dia}px`);

  const share = sample.withAny / sample.total;
  share > 0.2
    ? pass('E11i a crossing electron is on screen during the transient',
        `${sample.withAny}/${sample.total} frames = ${(share * 100).toFixed(0)}%`)
    : fail('E11i a crossing electron is on screen during the transient',
        `only ${(share * 100).toFixed(0)}% of frames show a crossing`);
}

/* --- reduced motion must not park the page on an empty diagram ----------
   The old boot did seek(0) + pause(), so a reduced-motion visitor's only view
   was stage A: metal empty, nothing transferred. Assert the still frame is
   informative instead. */
{
  const ctx2 = await browser.newContext({
    viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce',
  });
  const p2 = await ctx2.newPage();
  await p2.goto(PAGE_URL, { waitUntil: 'networkidle' });
  await p2.waitForFunction(() => typeof window.__FLOW_GET_STATE === 'function', { timeout: 15000 });
  await p2.waitForTimeout(700);
  const s2 = await p2.evaluate(() => window.__FLOW_GET_STATE());
  s2.t > 0.5
    ? pass('E11e reduced motion shows the COMPLETED state, not an empty t=0',
        `boots at t=${s2.t.toFixed(2)}, playing=${s2.playing}`)
    : fail('E11e reduced motion shows the COMPLETED state, not an empty t=0',
        `boots at t=${s2.t.toFixed(2)} — the metal is empty and nothing flows`);
  s2.playing === false
    ? pass('E11f reduced motion does not autoplay', 'paused on load')
    : fail('E11f reduced motion does not autoplay', 'it is animating');
  await ctx2.close();
}

/* ---------- E12 the section nav: the flow demo must be reachable ----------
   The whole reason the flow animation was invisible: /flow/ shipped as a
   separate route with no link to or from it, so the page that shows electrons
   moving had no entry point anywhere in the UI. It is now a section of `/`
   with a nav. These lock that in — a regression here is silent otherwise. */
{
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p3 = await ctx3.newPage();
  await p3.goto(PAGE_URL, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(1200);

  const both = await p3.evaluate(() => ({
    hasAlignment: !!document.getElementById('alignment'),
    hasFlow: !!document.getElementById('flow'),
    band: !!document.getElementById('bandCanvas'),
    flow: !!document.getElementById('flowCanvas'),
  }));
  (both.hasAlignment && both.hasFlow && both.band && both.flow)
    ? pass('E12a both demos are on ONE page', '#alignment and #flow, both canvases present')
    : fail('E12a both demos are on ONE page', JSON.stringify(both));

  const nav = await p3.evaluate(() => {
    const links = [...document.querySelectorAll('.secnav-link')];
    return { n: links.length, hrefs: links.map((a) => a.getAttribute('href')) };
  });
  nav.n === 2 && nav.hrefs.includes('#alignment') && nav.hrefs.includes('#flow')
    ? pass('E12b the page has a two-link section nav', nav.hrefs.join(' + '))
    : fail('E12b the page has a two-link section nav', `${nav.n} links: ${nav.hrefs.join(', ')}`);

  /* clicking the entry point must actually move the flow section into view.
     Guarded: if the nav is gone entirely the click throws, and we want a
     reported FAIL for each check rather than an unhandled exception that
     hides the rest of the suite. */
  let jumpedOk = false;
  try { await p3.click('.secnav-link[href="#flow"]'); jumpedOk = true; } catch { /* nav missing */ }
  await p3.waitForTimeout(1200);
  const jumped = await p3.evaluate(() => {
    const app = document.querySelector('.app');
    const cv = document.getElementById('flowCanvas');
    if (!cv) return { top: 9999, h: 0, vh: innerHeight, scrolled: 0 };
    const r = cv.getBoundingClientRect();
    return { top: Math.round(r.top), h: Math.round(r.height), vh: innerHeight,
             scrolled: app ? Math.round(app.scrollTop) : 0 };
  });
  (jumpedOk && jumped.top >= 0 && jumped.top < 260 && jumped.scrolled > 0)
    ? pass('E12c clicking "Electron flow" brings it into view',
        `flowCanvas.top=${jumped.top} (viewport ${jumped.vh}), scrolled ${jumped.scrolled}px`)
    : fail('E12c clicking "Electron flow" brings it into view', JSON.stringify(jumped));

  /* the active chip must follow the scroll, not sit on the server-rendered one */
  const spy = await p3.evaluate(() => {
    const act = document.querySelector('.secnav-link.active');
    return { active: act ? act.dataset.section : null,
             current: act ? act.getAttribute('aria-current') : null };
  });
  spy.active === 'flow' && spy.current === 'true'
    ? pass('E12d the active nav chip follows the scroll', 'now marking "flow"')
    : fail('E12d the active nav chip follows the scroll', JSON.stringify(spy));

  /* and the way back out again */
  let backOk = false;
  try { await p3.click('.secnav-link[href="#alignment"]'); backOk = true; } catch { /* nav missing */ }
  await p3.waitForTimeout(1200);
  const back = await p3.evaluate(() => {
    const act = document.querySelector('.secnav-link.active');
    const cv = document.getElementById('bandCanvas');
    return { active: act ? act.dataset.section : null,
             bandTop: cv ? Math.round(cv.getBoundingClientRect().top) : 9999 };
  });
  (backOk && back.active === 'alignment' && back.bandTop >= 0 && back.bandTop < 260)
    ? pass('E12e and back to band alignment', `bandCanvas.top=${back.bandTop}`)
    : fail('E12e and back to band alignment', JSON.stringify(back));

  await ctx3.close();
}

/* the old deep link must still work — it redirects to the merged page */
{
  const ctx4 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p4 = await ctx4.newPage();
  await p4.goto(PAGE_URL.replace(/\/$/, '/') + 'flow/', { waitUntil: 'networkidle' });
  await p4.waitForTimeout(1200);
  const r = await p4.evaluate(() => ({
    hash: location.hash,
    hasFlow: !!document.getElementById('flow'),
    top: Math.round(document.getElementById('flowCanvas')?.getBoundingClientRect().top ?? 9999),
  }));
  (r.hasFlow && r.hash === '#flow' && r.top < 260)
    ? pass('E12f the old /flow/ link still lands on the flow section', `→ ${r.hash}, top=${r.top}`)
    : fail('E12f the old /flow/ link still lands on the flow section', JSON.stringify(r));
  await ctx4.close();
}

await browser.close();
if (devProc) devProc.kill();

const bad = results.filter((r) => !r[1]);
console.log(`\n=== FLOW E2E: ${results.length - bad.length}/${results.length} passed ===`);
console.log(bad.length ? 'FLOW_E2E_FAIL' : 'FLOW_E2E_OK');
process.exit(bad.length ? 1 : 0);
