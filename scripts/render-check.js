/**
 * render-check.js — rasterizes renderBand + renderGraph to real PNGs
 * so the plots can be visually verified. Run: bun scripts/render-check.js
 */
import { createCanvas } from '@napi-rs/canvas';

const OUT = new URL('../screenshots/', import.meta.url).pathname;

// DOM stubs so the modules load outside a browser
const mkEl = () => ({
  style: {},
  classList: { add() {}, remove() {} },
  append() {},
  appendChild() {},
  addEventListener() {},
  dataset: {},
  innerHTML: '',
  textContent: '',
});

const rect = () => ({ left: 0, top: 0, width: 900, height: 460 });

globalThis.document = {
  getElementById: () => mkEl(),
  createElement: () => mkEl(),
};
globalThis.window = globalThis;

async function makeModel(params, animFrac) {
  const { BANDMODEL } = await import('../src/assets/js/bandmodel.js');
  return BANDMODEL.model(params ?? BANDMODEL.DEFAULTS);
}

async function main() {
  const { renderBand, renderGraph } = await import('../src/assets/js/render.js');
  const { BANDMODEL, PRESETS } = await import('../src/assets/js/bandmodel.js');

  const W = 900, H = 460;
  const canvas = createCanvas(W, H);
  // make the canvas look like it's inside the page (parentElement sizing)
  const wrapper = { getBoundingClientRect: rect };
  Object.defineProperty(canvas, 'parentElement', { value: wrapper });

  const states = [
    { name: 'band-contact-default', fn: renderBand, model: BANDMODEL.model(BANDMODEL.DEFAULTS), anim: 1 },
    { name: 'band-separated-default', fn: renderBand, model: BANDMODEL.model(BANDMODEL.DEFAULTS), anim: 0 },
    { name: 'band-contact-mg-ohmic', fn: renderBand, model: BANDMODEL.model(PRESETS['Mg / MoS2 (ohmic demo)']), anim: 1 },
    { name: 'graph-default', fn: renderGraph, model: BANDMODEL.model(BANDMODEL.DEFAULTS) },
    { name: 'graph-forward-0p8V', fn: renderGraph, model: BANDMODEL.model({ ...BANDMODEL.DEFAULTS, bias: 0.8 }) },
    { name: 'graph-reverse-0p8V', fn: renderGraph, model: BANDMODEL.model({ ...BANDMODEL.DEFAULTS, bias: -0.8 }) },
  ];

  for (const s of states) {
    if (s.fn === renderBand) s.fn(canvas, s.model, s.anim);
    else s.fn(canvas, s.model);
    const png = await canvas.encode('png');
    const fs = await import('node:fs');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(OUT + s.name + '.png', png);
    console.log('wrote', s.name + '.png', png.length, 'bytes');
  }
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });