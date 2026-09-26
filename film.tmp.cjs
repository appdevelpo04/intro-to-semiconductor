const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://localhost:4321/intro-to-semiconductor/', { waitUntil: 'networkidle' });
  await p.evaluate(() => { const a=document.querySelector('.app'),e=document.getElementById('flow');
    a.scrollTop = e.getBoundingClientRect().top - a.getBoundingClientRect().top + a.scrollTop; });
  await p.waitForFunction(() => typeof window.__FLOW_GET_STATE === 'function', { timeout: 15000 });
  const cv = p.locator('#flowCanvas');
  await p.evaluate(() => { window.__FLOW_SEEK(0.20); window.__FLOW_PLAY(); });
  const ts = [];
  for (let i = 0; i < 8; i++) {
    ts.push(await p.evaluate(() => window.__FLOW_GET_STATE().t.toFixed(3)));
    await cv.screenshot({ path: `f-${i}.png` });
    await p.waitForTimeout(220);
  }
  console.log('t =', ts.join(' '));
  await b.close();
})();
