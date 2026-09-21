/**
 * validate-live.js — loads http://localhost:4321/ in headless Chromium,
 * captures console/page errors, checks canvases actually painted,
 * then exercises the interactive parts and screenshots the result.
 * Run: bun scripts/validate-live.js
 */
import { chromium } from 'playwright';

const PAGE_URL = process.env.PAGE_URL || 'http://localhost:4321/';
const OUT = new URL('../screenshots/', import.meta.url).pathname;

const consoleErrs = [];
const pageErrs = [];
const failedReqs = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
page.on('pageerror', (e) => pageErrs.push(String(e)));
page.on('requestfailed', (r) => failedReqs.push(r.url() + ' → ' + r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.url() + ' → HTTP ' + r.status()); });

await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// ---- static checks ----
const canvasInfo = await page.evaluate(() => {
  const get = (id) => {
    const cv = document.getElementById(id);
    if (!cv) return { exists: false };
    const ctx = cv.getContext('2d');
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let nonBg = 0;
    for (let i = 0; i < px.length; i += 40) {          // sparse sample
      if (px[i] !== 14 || px[i + 1] !== 21 || px[i + 2] !== 41) nonBg++;  // bg = #0e1529
    }
    return { exists: true, w: cv.width, h: cv.height, cssW: cv.clientWidth, cssH: cv.clientHeight, nonBgSamples: nonBg };
  };
  return {
    band: get('bandCanvas'),
    graph: get('graphCanvas'),
    sliders: document.querySelectorAll('#controls input[type=range]').length,
    presets: document.querySelectorAll('.preset-btn').length,
    legendItems: document.querySelectorAll('.legend-item').length,
    statusText: document.getElementById('statusBar')?.textContent.slice(0, 120) || '(empty)',
  };
});

console.log('--- static state after load ---');
console.log(JSON.stringify(canvasInfo, null, 1));

await page.screenshot({ path: OUT + 'live-1-initial.png', fullPage: false });

// ---- interaction 1: click "Make contact" ----
const contactBtn = page.locator('#contactToggle');
await contactBtn.click();
await page.waitForTimeout(1000);   // 700ms animation + margin
const contactState = await page.evaluate(() => ({
  btnText: document.getElementById('contactToggle').textContent.trim(),
}));
await page.screenshot({ path: OUT + 'live-2-contact.png' });
console.log('--- after contact click ---', JSON.stringify(contactState));

// ---- interaction 2: drag bias slider to +0.8 V ----
await page.locator('#sl-bias').fill('0.8');
await page.waitForTimeout(300);
const biasVal = await page.evaluate(() => document.getElementById('val-bias').value); // editable field → .value, not textContent
await page.screenshot({ path: OUT + 'live-3-bias0p8.png' });
console.log('--- after bias=0.8 ---', biasVal);

// ---- interaction 3: click a real arrow badge (from the live hit targets) ----
const badge = await page.evaluate(() => {
  const cv = document.getElementById('bandCanvas');
  const r = cv.getBoundingClientRect();
  const ts = window.__SCHOTTKY_TARGETS || [];
  const t = ts.find(t => t.id === 'phi_m') || ts[0];
  return t ? { x: r.left + t.x, y: r.top + t.y, id: t.id } : null;
});
if (badge) {
  await page.mouse.click(badge.x, badge.y);
  await page.waitForTimeout(400);
}
const detail = await page.evaluate(() => ({
  visible: document.getElementById('detailPanel').classList.contains('visible'),
  title: document.getElementById('detailTitle').textContent,
  body: document.getElementById('detailBody').textContent.slice(0, 80),
}));
await page.screenshot({ path: OUT + 'live-4-detail.png' });
console.log('--- after arrow click (' + (badge ? badge.id : 'no badge') + ') ---', JSON.stringify(detail));

// ---- interaction 4: type a value into the T text field ----
await page.locator('#val-T').fill('600');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const tCheck = await page.evaluate(() => ({
  textVal: document.getElementById('val-T').value,
  sliderVal: document.getElementById('sl-T').value,
  statusKT: (document.getElementById('statusBar').textContent.match(/kT = [\d.]+/) || [''])[0],
}));
await page.screenshot({ path: OUT + 'live-5-textfield.png' });
console.log('--- after typing T=600 ---', JSON.stringify(tCheck));

// ---- interaction 4b: OUT-OF-BOUND value — must clamp to max with a single render,
//        no doubled update() calls (the lag we're fixing) ----
await page.evaluate(() => { window.__SCHOTTKY_UPDATE_COUNT = 0; });
await page.locator('#val-phi_m').fill('99');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const obCheck = await page.evaluate(() => ({
  textVal: document.getElementById('val-phi_m').value,
  sliderVal: document.getElementById('sl-phi_m').value,
  updateCalls: window.__SCHOTTKY_UPDATE_COUNT,     // must be exactly 1 (clamped, single render)
  statusPhi: (document.getElementById('statusBar').textContent.match(/Φ_B = [\d.]+/) || [''])[0],
}));
console.log('--- after out-of-bound Φ_m=99 ---', JSON.stringify(obCheck));

// ---- interaction 5: capture an animation frame mid-contact (arrows moving) ----
const contactBtn2 = page.locator('#contactToggle');
await contactBtn2.click();                       // Separate → animFrac runs 1→0
await page.waitForTimeout(350);                  // ~mid-animation
await page.screenshot({ path: OUT + 'live-6-mid-anim.png' });
await page.waitForTimeout(600);                  // animation done

// ---- interaction 6: FREEZE-REGRESSION — drag to the current-underflow params
//        (Φ_m=max, T=min) that previously infinite-looped and froze the UI ----
await page.evaluate(() => { window.__SCHOTTKY_UPDATE_COUNT = 0; });
await page.locator('#sl-bias').fill('0');
await page.locator('#sl-T').fill('10');
await page.locator('#sl-phi_m').fill('6');
await page.waitForTimeout(500);
const freezeCheck = await page.evaluate(() => ({
  status: document.getElementById('statusBar').textContent.slice(0, 80),
  graphPainted: (function(){ const cv=document.getElementById('graphCanvas'); const c=cv.getContext('2d'); let n=0; const d=c.getImageData(0,0,cv.width,cv.height).data; for(let i=0;i<d.length;i+=200){ if(d[i]!==14||d[i+1]!==21||d[i+2]!==41) n++; } return n; })(),
}));
await page.screenshot({ path: OUT + 'live-7-underflow.png' });
console.log('--- after underflow params (was freeze) ---', JSON.stringify(freezeCheck));

// restore reasonable defaults for the ok-check
await page.locator('#sl-T').fill('300');
await page.locator('#sl-phi_m').fill('5.1');
await page.waitForTimeout(300);

// ---- layout / scroll check: is content being cut off? ----
const layout = await page.evaluate(() => {
  const m = document.querySelector('.main');
  const rg = document.querySelector('.panel-graph');
  const body = document.body;
  const vh = window.innerHeight;
  return {
    bodyScrollH: body.scrollHeight,
    viewport: vh,
    mainScrollH: m?.scrollHeight, mainClientH: m?.clientHeight,
    graphScrollH: rg?.scrollHeight, graphClientH: rg?.clientHeight,
    statusVisible: (() => { const r = document.getElementById('statusBar').getBoundingClientRect(); return r.bottom <= vh + 1; })(),
  };
});
console.log('--- layout/scroll ---', JSON.stringify(layout, null, 1));

// ---- summary ----
console.log('\n=== VALIDATION SUMMARY ===');
console.log('console errors:', consoleErrs.length ? consoleErrs : 'none');
console.log('page errors:', pageErrs.length ? pageErrs : 'none');
console.log('failed requests:', failedReqs.length ? failedReqs : 'none');
console.log('sliders built:', canvasInfo.sliders, '| presets:', canvasInfo.presets, '| legend:', canvasInfo.legendItems);

const ok = consoleErrs.length === 0 && pageErrs.length === 0 && failedReqs.length === 0 &&
  canvasInfo.band?.w > 0 && canvasInfo.graph?.w > 0 &&
  canvasInfo.band?.nonBgSamples > 50 && canvasInfo.graph?.nonBgSamples > 50 &&
  canvasInfo.sliders === 6 && detail.visible &&
  tCheck.textVal === '600 K' && tCheck.sliderVal === '600' && tCheck.statusKT.includes('0.0517') &&
  obCheck.textVal === '6.00 eV' && obCheck.sliderVal === '6' && obCheck.updateCalls === 1 &&
  obCheck.statusPhi.includes('1.70') &&
  freezeCheck.graphPainted > 0;
console.log(ok ? '\nLIVE_VALIDATION_OK' : '\nLIVE_VALIDATION_FAIL');

await browser.close();
process.exit(ok ? 0 : 1);