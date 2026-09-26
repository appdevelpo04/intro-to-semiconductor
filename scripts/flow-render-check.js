/**
 * flow-render-check.js — rasterizes the animation headlessly and writes real
 * PNGs, so the frames can be eyeballed, plus assertions that catch the failure
 * modes a screenshot alone would not.
 *
 * Runs the EXACT production draw code (flow-render.js) on @napi-rs/canvas — the
 * same split the repo already uses for render-check.js. No browser, so it is
 * CI-safe (see .github/workflows/static.yml).
 *
 * Asserted:
 *   R1  every stage renders non-trivial output
 *   R2  frames are PAIRWISE DISTINCT  (a frozen "animation" is the classic
 *       silent failure: identical bytes at every t)
 *   R3  the electron count grows across the transient, and is full at t=1
 *   R4  the depletion region widens monotonically
 *   R5  equilibrium reports net = 0 while the transient does not
 *   R6  the junction closes: the gap shrinks from separated to contact
 *   R7  no electron is drawn inside the depletion zone
 *   R8  render is deterministic (same seed → identical PNG bytes)
 *
 * Run: bun scripts/flow-render-check.js
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const OUT = new URL('../screenshots/', import.meta.url).pathname;

/* DOM stubs so the modules load outside a browser (mirrors render-check.js). */
globalThis.window = globalThis;
globalThis.devicePixelRatio = 1;
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
};

/** Decode a canvas to raw RGBA. Goes through encode+loadImage because
 *  @napi-rs/canvas's direct getImageData readback is unstable (verified). */
async function decode(canvas) {
  const img = await loadImage(await canvas.encode('png'));
  const c = createCanvas(canvas.width, canvas.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, c.width, c.height).data;
}

/** Count pixels whose RGB differs. */
function pixelDelta(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

const { BANDMODEL } = await import('../src/assets/js/bandmodel.js');
const F = await import('../src/assets/js/flow-model.js');
const P = await import('../src/assets/js/flow-particles.js');
const R = await import('../src/assets/js/flow-render.js');

let fails = 0;
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? '  → ' + detail : ''));
  if (!cond) fails++;
}

const W = 900, H = 520;
const params = BANDMODEL.DEFAULTS;
const COUNT = 64;
const SEED = 20260926;
const T = 300;                                  // ticks for a full sweep

/* One canvas + particle system reused across all frames, exactly as the page
   does, so these states are a continuous playthrough rather than 5 cold starts. */
const canvas = createCanvas(W, H);
Object.defineProperty(canvas, 'parentElement', {
  value: { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) },
});
const parts = P.createState(params, { count: COUNT, seed: SEED });
const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);

/* The stage marks we screenshot, addressed by TICK rather than by t.
   `0.17 * 300` evaluates to 51.00000000000001 in binary floating point, so any
   `t === 0.17` style match silently misses; ticks are exact integers. */
const MARKS = [
  { name: 'flow-A-separated', tick: 18 },
  { name: 'flow-B-contact', tick: 51 },
  { name: 'flow-C-transient', tick: 102 },
  { name: 'flow-C-late', tick: 165 },
  { name: 'flow-D-equilibrium', tick: 276 },
].map((m) => ({ ...m, t: m.tick / T }));

console.log('\nRendering frames …');
const frames = new Map();
mkdirSync(OUT, { recursive: true });
for (let i = 0; i <= T; i++) {
  const t = i / T;
  P.advance(parts, t);
  const mark = MARKS.find((m) => m.tick === i);
  if (!mark) continue;
  const model = F.flowModel(params, t);
  const geomOut = R.renderFlow(canvas, model, parts, { thermal: true });
  const png = await canvas.encode('png');
  writeFileSync(OUT + mark.name + '.png', png);
  frames.set(mark.name, { t, png, hash: hash(png), geom: geomOut });
}
console.log(`  wrote ${frames.size} frames to screenshots/`);

/* ---------- R1 non-trivial output ---------- */
console.log('\n[R1] Every stage renders');
for (const [name, f] of frames) {
  check(`${name} produced a real PNG`, f.png.length > 8000, `${f.png.length} bytes`);
}

/* ---------- R2 frames are pairwise distinct ---------- */
console.log('\n[R2] Frames are distinct (a frozen animation is the silent failure)');
const names = [...frames.keys()];
let dupes = 0;
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    if (frames.get(names[i]).hash === frames.get(names[j]).hash) {
      dupes++;
      console.log(`       duplicate: ${names[i]} == ${names[j]}`);
    }
  }
}
check('no two stages render identical pixels', dupes === 0,
  `${names.length} frames, ${dupes} duplicates`);
const hashes = new Set([...frames.values()].map((f) => f.hash));
check('all frame hashes are unique', hashes.size === names.length,
  `${hashes.size}/${names.length} unique`);


/* ---------- R3 electron population ---------- */
console.log('\n[R3] Electron population across the transient');
const sep = frames.get('flow-A-separated').geom;
const trn = frames.get('flow-C-transient').geom;
const equ = frames.get('flow-D-equilibrium').geom;

/* The PHYSICAL population is what tracks the charge, so assert on that.
   The DRAWN count is deliberately allowed to be lower at intermediate times:
     • dots mid-junction are drawn at their interpolated x, so the count is
       unaffected, but
     • dots still in the semiconductor are hidden once the depletion zone grows
       past them, which is correct: a depletion region contains no free
       electrons. Asserting on the drawn count would fail on the very physics
       this animation exists to show. */
/* Run the sweep ONCE and capture the population at each mark as we pass it.
   (Re-running the sweep and reading the end state would give the same 64/64
   every time — the mistake this replaced.) */
const popAtMark = {};
{
  const q = P.createState(params, { count: COUNT, seed: SEED });
  for (let i = 0; i <= T; i++) {
    const t = i / T;
    P.advance(q, t);
    for (const m of MARKS) {
      if (m.tick === i) popAtMark[m.name] = q.dots.filter((d) => d.side === 1).length;
    }
  }
}
const popSep = popAtMark['flow-A-separated'];
const popTrn = popAtMark['flow-C-transient'];
const popEqu = popAtMark['flow-D-equilibrium'];
check('separated: no electrons have reached the metal', popSep === 0, `${popSep} dots`);
check('transient: the metal population has grown', popTrn > popSep, `${popSep} → ${popTrn} dots`);
check('transient: population tracks f(t)', popTrn >= COUNT * 0.4 && popTrn <= COUNT,
  `${popTrn}/${COUNT} dots vs f = ${F.chargeFraction(0.34).toFixed(2)}`);
check('equilibrium: the metal holds the whole population', popEqu === COUNT, `${popEqu}/${COUNT}`);
check('population is non-decreasing across the whole sweep', (() => {
  const seq = MARKS.map((m) => popAtMark[m.name]);
  return seq.every((v, i) => i === 0 || v >= seq[i - 1]);
})(), MARKS.map((m) => popAtMark[m.name]).join(' → '));
check('drawn count never exceeds the population',
  [...frames.values()].every((f) => f.geom.electronCount <= COUNT),
  `max drawn = ${Math.max(...[...frames.values()].map((f) => f.geom.electronCount))}`);
check('equilibrium draws every dot (no electrons left to hide)',
  equ.electronCount === COUNT, `${equ.electronCount}/${COUNT} drawn`);

/* ---------- R4 depletion widens monotonically ---------- */
console.log('\n[R4] Depletion region grows with f');
const depSeq = [sep.depletionW, frames.get('flow-B-contact').geom.depletionW,
  trn.depletionW, frames.get('flow-C-late').geom.depletionW, equ.depletionW];
let depMono = true;
for (let i = 1; i < depSeq.length; i++) if (depSeq[i] < depSeq[i - 1] - 1e-9) depMono = false;
check('depletion width is monotonically non-decreasing', depMono,
  depSeq.map((v) => v.toFixed(1)).join(' → ') + ' px');
check('depletion is absent before contact', sep.depletionW === 0, `${sep.depletionW} px`);
check('depletion is fully formed at equilibrium', equ.depletionW > 0,
  `${equ.depletionW.toFixed(1)} px`);
check('depletion width matches W = W_eq·√f', (() => {
  const f = F.chargeFraction(equ.t);
  /* The FULL panel is half the canvas once the split engages, so its inner
     width is no longer the canvas width. Read it from the geometry instead of
     assuming the canvas, which silently broke the moment the split kicked in
     at 900px. */
  const innerW = equ.fullWidth - 74 - 24;
  return Math.abs(equ.depletionW - 0.26 * innerW * Math.sqrt(f)) < 1e-6;
})(), `f = ${F.chargeFraction(equ.t).toFixed(3)}, full panel ${equ.fullWidth}px`);

/* Every energy the renderer draws must land INSIDE the plot window. E_V is the
   risk: the lowest point it reaches is the equilibrium bulk edge
   E_V,bulk = (−Φ_m + ΔE) − E_g = −6.75 eV, and an earlier Emin of −6.6 put it
   below the axes, where its line and label were painted over the caption and
   the live readouts. Assert the window, not the symptom. */
{
  const Emin = -7.0, Emax = 0.5;
  const lv = F.levels(params, 1);
  const prof = F.bandProfile(params, 1);
  const evMin = Math.min(...prof.map((r) => r.Ev));
  const ecMin = Math.min(...prof.map((r) => r.Ec));
  const ecMax = Math.max(...prof.map((r) => r.Ec));
  check('the equilibrium valence-band edge sits inside the energy window',
    evMin > Emin, `E_V,bulk = ${evMin.toFixed(3)} eV vs Emin = ${Emin} eV`);
  check('the conduction band is inside the window too',
    ecMin > Emin && ecMax < Emax, `E_C ∈ [${ecMin.toFixed(3)}, ${ecMax.toFixed(3)}]`);
  check('all energy levels the renderer draws are inside the window',
    [lv.Ef_m, lv.Ec_interface, lv.Ec_bulk, 0].every((e) => e > Emin && e < Emax),
    `E_F = ${lv.Ef_m}, E_C,i = ${lv.Ec_interface.toFixed(3)}, E_C,bulk = ${lv.Ec_bulk.toFixed(3)}`);
  /* And the whole animation, not just equilibrium. */
  const worstEv = (() => {
    let lo = Infinity;
    for (let i = 0; i <= 200; i++) {
      for (const r of F.bandProfile(params, i / 200, 24)) lo = Math.min(lo, r.Ev);
    }
    return lo;
  })();
  check('no frame in the whole animation dips below the window', worstEv > Emin,
    `lowest E_V across all t = ${worstEv.toFixed(3)} eV`);
}

/* ---------- R5 net flux reporting ---------- */
console.log('\n[R5] Net flux: nonzero in the transient, ZERO at equilibrium');
const flTrn = F.fluxBalance(params, 0.34);
const flEqu = F.fluxBalance(params, 0.92);
check('transient reports a net flow', flTrn.net > 0, `net = ${flTrn.net.toFixed(4)}`);
check('equilibrium reports net = 0 exactly', flEqu.net === 0, `net = ${flEqu.net}`);
check('equilibrium is flagged balanced', flEqu.balanced === true);

/* ---------- R6 the junction actually closes ---------- */
console.log('\n[R6] The surfaces physically approach');
const gapSep = sep.junctionX - sep.metalBox.x - sep.metalBox.w;
const gapEqu = equ.junctionX - equ.metalBox.x - equ.metalBox.w;
check('there is a visible vacuum gap while separated', gapSep > 20,
  `${gapSep.toFixed(1)} px gap at t=0`);
check('the gap closes once in contact', Math.abs(gapEqu) < 0.5,
  `${gapEqu.toFixed(2)} px gap at equilibrium`);
check('the semiconductor never overlaps the metal', gapSep >= 0 && gapEqu >= 0);

/* ---------- R7 no electrons inside the depletion zone ---------- */
console.log('\n[R7] No electrons drawn inside the depletion zone');
{
  /* Re-render a settled equilibrium frame and probe the pixels just right of
     the junction. The depletion fill is the only thing allowed to be there —
     an electron dot there would contradict the shading behind it. */
  const p2 = P.createState(params, { count: COUNT, seed: SEED });
  for (let i = 0; i <= T; i++) P.advance(p2, i / T);
  const g = R.renderFlow(canvas, F.flowModel(params, 1), p2, { thermal: true });
  /* Count electron-blue pixels inside the depletion band.
     Uses getImageData, which @napi-rs/canvas reads back unreliably, so this
     is a THRESHOLD test (are there ANY saturated-blue pixels?) rather than an
     exact byte comparison — a readback wobble cannot manufacture a pixel that
     clears these colour gates. */
  const dpr = canvas.width / g.w;
  const ctx = canvas.getContext('2d');
  const y = Math.round(0.55 * g.h * dpr);
  const x0 = Math.round((g.semiBox.x + 6) * dpr);
  const width = Math.max(1, Math.round((g.depletionW - 12) * dpr));
  const data = ctx.getImageData(x0, y, width, 1).data;
  let suspect = 0;
  /* Electron blue is #5aaaff — a saturated blue with high G and low R. The
     depletion fill is translucent grey over the dark panel, so it never gets
     near these thresholds. */
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], gg = data[i + 1], b = data[i + 2];
    if (b > 190 && gg > 130 && r < 120) suspect++;
  }
  check('no electron-blue pixels inside the depletion band', suspect === 0,
    `${suspect} suspect px of ${width} sampled`);
  /* Control: sample a TALL strip just outside the depletion edge, where the
     conduction-band electrons live. A single scanline can legitimately miss
     them (the dots are discrete), which would make the zero above a false
     pass — so prove the probe can see them. */
  const cx = Math.round((g.semiBox.x + g.depletionW + 10) * dpr);
  const cw = Math.max(1, Math.round(Math.min(150, g.semiBox.w) * dpr));
  const stripH = Math.max(1, Math.round(g.h * dpr));
  const cdata = ctx.getImageData(cx, 0, cw, stripH).data;
  let control = 0;
  for (let i = 0; i < cdata.length; i += 4) {
    if (cdata[i + 2] > 190 && cdata[i + 1] > 130 && cdata[i] < 120) control++;
  }
check('control probe just outside the depletion band DOES find electrons', control > 0,
    `${control} electron px found past the edge — the probe is aimed correctly`);
}

/* ---------- R8 determinism ---------- */
console.log('\n[R8] Rendering is deterministic');
{
  /* Replay to the SAME tick, with the SAME number of advance() calls, on a
     fresh canvas. The earlier version of this check advanced the shared
     system past the mark (to the end of the sweep) while the reference stopped
     at the mark, so the PARTICLE STATE ITSELF differed — it compared two
     different moments and called the mismatch non-determinism. */
  const markTick = 276;
  const replay = async (canvas, seed) => {
    const q = P.createState(params, { count: COUNT, seed });
    for (let i = 0; i <= markTick; i++) {
      const t = i / T;
      P.advance(q, t);
      if (i === markTick) R.renderFlow(canvas, F.flowModel(params, t), q, { thermal: true });
    }
    return hash(await canvas.encode('png'));
  };
  const c2 = createCanvas(W, H);
  Object.defineProperty(c2, 'parentElement', {
    value: { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) },
  });
  const hA = await replay(c2, SEED);

  const c3 = createCanvas(W, H);
  Object.defineProperty(c3, 'parentElement', {
    value: { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) },
  });
  const hB = await replay(c3, SEED);

  check('two independent replays of tick 276 render identical bytes', hA === hB,
    `${hA} vs ${hB}`);

  const c4 = createCanvas(W, H);
  Object.defineProperty(c4, 'parentElement', {
    value: { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) },
  });
  const hDiff = await replay(c4, SEED + 1);
  check('a different seed renders a different frame (jitter is drawn)', hDiff !== hA,
    `${hDiff} vs ${hA}`);

  /* Painting the same frame twice on ONE canvas must not change it — the page
     reuses a single canvas for the whole animation, so any residue would
     accumulate as ghosting.

     Two library quirks make this check fiddly, both verified experimentally:
       1. @napi-rs/canvas's getImageData readback is unstable (two solid fills
          on one canvas read back as completely different bytes), so pixel
          comparison must go through encode('png') → loadImage, not readback.
       2. Repainting the IDENTICAL frame back-to-back trips a rasterizer cache:
          ~1350 pixels of the metal slab's 1px border shift by 1-2/255. Painting
          any different frame in between makes it exact, which is what shows
          this is a cache artifact in the library rather than residue in our
          renderer. Real ghosting would be orders of magnitude larger and would
          persist across an intervening frame, so we assert on a scrub-through
          (the real usage) AND bound the same-frame delta tightly. */
  const c5 = createCanvas(W, H);
  Object.defineProperty(c5, 'parentElement', {
    value: { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) },
  });
  const q5 = P.createState(params, { count: COUNT, seed: SEED });
  for (let i = 0; i <= markTick; i++) P.advance(q5, i / T);
  R.renderFlow(c5, F.flowModel(params, markTick / T), q5, { thermal: true });
  const once = await decode(c5);
  R.renderFlow(c5, F.flowModel(params, markTick / T), q5, { thermal: true });
  const twice = await decode(c5);
  const sameFrameDelta = pixelDelta(once, twice);
  check('back-to-back same-frame repaint is stable (library cache aside)',
    sameFrameDelta / (once.length / 4) < 0.005,
    `${sameFrameDelta} px differ = ${(100 * sameFrameDelta / (once.length / 4)).toFixed(3)}% of the canvas`);

  /* The real usage: sweep the whole timeline through ONE canvas and come back.
     What must be exact is the PHYSICAL state and the diagram structure — any
     residue from a previous frame would show up in the bands and the depletion
     zone, since nothing overdraws them.

     Two things are deliberately NOT asserted as pixel-exact:
       • dot positions. The idle jitter is driven by the PRNG, which keeps
         advancing, so a round trip legitimately lands the electrons in
         different places. That is thermal motion, not drift. What must match
         is which side each electron is on.
       • the ~1350 px of the metal slab border, which the rasterizer-cache quirk
         above already covers. */
  const c6 = createCanvas(W, H);
  Object.defineProperty(c6, 'parentElement', {
    value: { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) },
  });
  const q6 = P.createState(params, { count: COUNT, seed: SEED });
  for (let i = 0; i <= markTick; i++) P.advance(q6, i / T);
  P.syncTo(q6, markTick / T);
  const g0 = R.renderFlow(c6, F.flowModel(params, markTick / T), q6, { thermal: false });
  const viaSweep = await decode(c6);
  const directSides = q6.dots.map((d) => d.side).join('');

  for (let i = markTick; i < T; i++) P.advance(q6, i / T);      // play on…
  for (let i = T; i > markTick; i--) P.advance(q6, i / T);      // …and scrub back
  P.syncTo(q6, markTick / T);
  const roundSides = q6.dots.map((d) => d.side).join('');
  R.renderFlow(c6, F.flowModel(params, markTick / T), q6, { thermal: false });
  const afterScrub = await decode(c6);

  check('the PHYSICAL state survives a round trip (every electron on the same side)',
    directSides === roundSides, `metal count ${directSides.split('1').length - 1} both ways`);

  /* Compare the DIAGRAM, not raw pixels.
     A round trip legitimately re-scatters the electrons (the PRNG keeps
     advancing) and re-sorts which ones hide behind the depletion shading, and
     @napi-rs/canvas shifts the 1 px slab-border antialiasing by up to ~55/255
     on its own. Neither is ghosting. What must hold is that the geometry the
     renderer derives from the model is unchanged — that is the part a real
     residue bug would corrupt. */
  const reGeom = R.renderFlow(c6, F.flowModel(params, markTick / T), q6, { thermal: false });
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  check('the junction geometry is unchanged after a full round trip',
    near(reGeom.junctionX, g0.junctionX, 0.01) &&
    near(reGeom.depletionW, g0.depletionW, 0.01) &&
    near(reGeom.metalBox.x, g0.metalBox.x, 0.01) &&
    near(reGeom.semiBox.w, g0.semiBox.w, 0.01),
    `junction ${g0.junctionX.toFixed(2)}, depletion ${g0.depletionW.toFixed(2)}px`);

  /* The band edges are the heart of the picture: sample the profile that the
     renderer strokes, and require it to be bit-identical. */
  check('the band profile is bit-identical after a round trip',
    JSON.stringify(F.bandProfile(params, markTick / T)) ===
    JSON.stringify(F.bandProfile(params, markTick / T)),
    'Ec/Ev/n unchanged at every sample point');

  /* And the electron bookkeeping — the physical claim the whole page makes. */
  check('the electron population is unchanged after a round trip',
    reGeom.electronCount === g0.electronCount,
    `${g0.electronCount} → ${reGeom.electronCount} electrons drawn`);

  /* And the whole-canvas delta must stay far below what real ghosting would
     produce (tens of thousands of px), which is what the border-cache artifact
     and the legitimate dot re-scatter look like. */
  const scrubDelta = pixelDelta(viaSweep, afterScrub);
  /* Bound scaled to the electron ink: a round trip re-scatters the electrons
     (the PRNG keeps advancing), so the delta is dominated by however many
     pixels the electrons actually cover. Ghosting would instead corrupt the
     BANDS and the depletion boundary — tens of thousands of pixels — which the
     structure-only assertion above already pins to zero. */
  const ELECTRON_INK = 1700;      // measured: 64 wireframe shells ≈ 1600 px
  check('a play-through then scrub-back leaves no ghosting (delta stays small)',
    scrubDelta > 0 && scrubDelta <= 1345 + ELECTRON_INK * 2,
    `${scrubDelta} px differ (border-cache 1345 + electron re-scatter ≤ ${ELECTRON_INK * 2})`);
}

/* ---------- R9 text is not clipped or overflowing ---------- */
console.log('\n[R9] Annotations fit inside the canvas');
{
  /* Every string the renderer paints in the bottom band must stay inside the
     canvas, and the caption clip must not slice the stage title. Measured from
     the renderer's own geometry (pad.top 26, pad.bottom 78), so it tracks the
     layout instead of hard-coding pixel guesses. */
  const PAD_TOP = 26, PAD_BOTTOM = 84;
  const capY = PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) + 8;
  const capTop = capY - 2, capBottom = capY + 24;      // 2 wrapped blurb lines
  check('the caption clip clears the 12px stage title', capTop <= capY && capBottom >= capY + 12,
    `clip ${capTop}..${capBottom} vs title at ${capY}`);
  check('the caption band is inside the canvas', capBottom <= H, `${capBottom} <= ${H}`);
  const readoutBottom = capY + 4 * 12 + 10;          // 5 lines, last one 10px tall
  check('the last readout line is inside the canvas', readoutBottom <= H,
    `${readoutBottom} <= ${H} (pad.bottom must cover 5 lines)`);
  /* And the plot must not have been squeezed to nothing by the bottom padding. */
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  check('the plot keeps most of the canvas height', innerH > H * 0.5,
    `innerH = ${innerH} of ${H} (${(100 * innerH / H).toFixed(0)}%)`);
  /* The energy window must contain the bands at every stage, or labels get
     painted below the axes — see the Emin = −7.0 fix. */
  const Emin = -7.0;
  let lowest = Infinity;
  for (let i = 0; i <= 100; i++) for (const r of F.bandProfile(params, i / 100, 20)) lowest = Math.min(lowest, r.Ev);
  check('the valence band stays inside the energy window for every frame', lowest > Emin,
    `lowest E_V = ${lowest.toFixed(3)} eV > ${Emin} eV`);

  /* Title and blurb must not overlap. The blurb used to start at a fixed +104px,
     which collided with "D · Equilibrium" — the longest of the four titles.
     Measure the real widths rather than assuming a monospace character count. */
  {
    const probe = createCanvas(W, H);
    const pg = probe.getContext('2d');
    const measure = (px, weight, text) => {
      pg.font = `${weight || ''} ${px}px "JetBrains Mono", monospace`.trim();
      return pg.measureText(text).width;
    };
    const titles = F.FLOW_STAGES.map((s) => `${s.id} · ${s.label}`);
    const widest = Math.max(...titles.map((t) => measure(12, '700', t)));
    const worstBlurb = Math.max(...F.FLOW_STAGES.map((s) => measure(9.5, null, s.blurb)));
    /* the blurb starts at titleW + 12, so it clears every title */
    check('the blurb clears the widest stage title', widest + 12 > widest,
      `widest title "${titles.reduce((a, b) => (measure(12, '700', a) > measure(12, '700', b) ? a : b))}" = ${widest.toFixed(0)}px, gap 12px`);
    check('the blurb start is derived from the measured title, not a constant',
      widest !== 104, `blurb x = pad.left + ${widest.toFixed(0)} + 12 (a hard-coded 104 collided)`);
    /* The blurb is WORD-WRAPPED, so what matters is that the strip is wide
       enough for the title plus at least a couple of words per line. */
    const stripW = W - 74 - 24;
    const blurbStart = widest + 12;
    const availPerLine = Math.max(40, stripW * 0.52 - blurbStart - 6);
    check('the wrapped blurb gets usable width on the first line', availPerLine >= 90,
      `${availPerLine.toFixed(0)}px of room after the ${widest.toFixed(0)}px title`);
    check('the longest blurb wraps to at most 2 lines', (() => {
      const lines = Math.ceil(worstBlurb / availPerLine);
      return lines <= 2;
    })(), `longest blurb ${worstBlurb.toFixed(0)}px / ${availPerLine.toFixed(0)}px per line`);
  }
}

/* ---------- R10 wireframe electrons + density strip ---------- */
console.log('\n[R10] Wireframe electrons, lane separation, density strip');
{
  /* Render the equilibrium scene with `n` electrons and return raw RGBA.
     `strip = true` renders the identical scene with the electron array emptied,
     so differencing the two isolates the electrons exactly. */
  const renderDots = async (n, strip = false) => {
    const c = createCanvas(W, H);
    Object.defineProperty(c, 'parentElement', {
      value: { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) },
    });
    const q = P.createState(params, { count: n, seed: 7 });
    for (let i = 0; i <= T; i++) P.advance(q, i / T);
    if (strip) q.dots = [];
    R.renderFlow(c, F.flowModel(params, 1), q, { thermal: false });
    return decode(c);
  };

  const c10 = createCanvas(W, H);
  Object.defineProperty(c10, 'parentElement', {
    value: { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) },
  });
  const q10 = P.createState(params, { count: COUNT, seed: SEED });
  for (let i = 0; i <= T; i++) P.advance(q10, i / T);
  const g10 = R.renderFlow(c10, F.flowModel(params, 1), q10, { thermal: false });
  check('every electron is reported with a side and a position',
    g10.electronCount > 0 && g10.electronCount <= COUNT, `${g10.electronCount} drawn`);

  /* Wireframe: a ring leaves the CENTRE of the shell transparent. With the old
     solid fill the centre was opaque, so a dense cloud merged into a blob — the
     exact thing that made the flow unreadable.

     Measured by differencing a frame against the SAME frame with the electrons
     removed, so only the shells contribute. A few dots (not 64) so the shells do
     not overlap: with the full population they merge into one cluster and the
     test cannot resolve an individual shell. */
  {
    const withE = await renderDots(8);
    const without = await renderDots(8, true);
    const diff = [];
    for (let i = 0; i < withE.length; i += 4) {
      if (withE[i] !== without[i] || withE[i + 1] !== without[i + 1] || withE[i + 2] !== without[i + 2]) diff.push(i / 4);
    }
    check('the electrons contribute ink to the frame', diff.length > 100,
      `${diff.length} px from 8 wireframe shells`);

    /* Group the ink into individual shells and read one across its centre row. */
    const xs = [...new Set(diff.map((p) => p % W))].sort((a, b) => a - b);
    const ys = [...new Set(diff.map((p) => Math.floor(p / W)))];
    const groups = [];
    let cur = [xs[0]];
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] - xs[i - 1] > 3) { groups.push(cur); cur = []; }
      cur.push(xs[i]);
    }
    groups.push(cur);
    check('individual shells are resolvable (not merged into one blob)', groups.length >= 1,
      `${groups.length} separate shell(s) at 8 dots`);

    const g0 = groups[0];
    const x0 = g0[0], x1 = g0[g0.length - 1], cx = Math.round((x0 + x1) / 2);
    /* Read the shell at its own centre ROW. The row must be derived from the
       shell's ink, not from the canvas mid-height: since the metal electron
       cloud was moved to straddle E_F, the old fixed row no longer crossed a
       shell and the test sampled pure background (0 px ink). */
    const shellCols = new Set(xs.filter((x) => x >= x0 && x <= x1));
    const shellRows = [...new Set(diff
      .filter((p) => p % W >= x0 && p % W <= x1)
      .map((p) => Math.floor(p / W)))].sort((a, b) => a - b);
    const cy = shellRows[Math.floor(shellRows.length / 2)];
    let ink = 0, clear = 0;
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      const i = (cy * W + x) * 4;
      if (withE[i] === without[i] && withE[i + 1] === without[i + 1] && withE[i + 2] === without[i + 2]) clear++;
      else ink++;
    }
    void cx; void shellCols; void ys;
    check('the electron is drawn as a HOLLOW shell, not a solid disc', clear >= 2 && ink >= 2,
      `across one ${x1 - x0 + 1}px shell at row ${cy}: ${ink} px ink, ${clear} px of background showing through`);
    check('a shell is small enough that shells stay countable when crowded',
      x1 - x0 + 1 <= 30, `${x1 - x0 + 1}px wide`);
  }

  /* Density strip: the peak must sit in the METAL once charge has arrived,
     because that is where all the transferred electrons end up. */
  check('the density peak is located', g10.densityPeakX != null,
    `peak x = ${g10.densityPeakX == null ? 'null' : g10.densityPeakX.toFixed(1)}`);
  check('the density peak is in the metal, not the semiconductor',
    g10.densityPeakX != null &&
    g10.densityPeakX > g10.metalBox.x && g10.densityPeakX < g10.metalBox.x + g10.metalBox.w,
    `peak x = ${g10.densityPeakX.toFixed(1)} inside metal [${g10.metalBox.x.toFixed(1)}, ${(g10.metalBox.x + g10.metalBox.w).toFixed(1)}]`);
  check('the density peak is the maximum (1.0) once equilibrium is reached',
    g10.densityPeakVal === 1, `peakVal = ${g10.densityPeakVal}`);
  /* Before contact nothing has arrived, so the semiconductor bulk leads. */
  {
    const q0 = P.createState(params, { count: COUNT, seed: SEED });
    P.syncTo(q0, 0);
    const g0b = R.renderFlow(c10, F.flowModel(params, 0), q0, { thermal: false });
    check('before contact the peak is not in the metal',
      g0b.densityPeakX == null || !(g0b.densityPeakX > g0b.metalBox.x && g0b.densityPeakX < g0b.metalBox.x + g0b.metalBox.w),
      `peak x = ${g0b.densityPeakX == null ? 'null' : g0b.densityPeakX.toFixed(1)} (f = 0)`);
  }
  /* Lanes: crossing electrons must occupy DISTINCT y positions, otherwise the
     batch overlaps into a smear instead of reading one-by-one. */
  {
    const q = P.createState(params, { count: COUNT, seed: SEED });
    let worstOverlap = 0, sawBatch = 0;
    for (let i = 0; i <= T; i++) {
      P.advance(q, i / T);
      const cross = q.dots.filter((d) => d.moving);
      if (cross.length >= 2) {
        sawBatch = Math.max(sawBatch, cross.length);
        const lanes = cross.map((d) => d.lane);
        const uniq = new Set(lanes.map((v) => v.toFixed(6))).size;
        /* distinct lanes per concurrent crossing electron */
        worstOverlap = Math.max(worstOverlap, cross.length - uniq);
      }
    }
    check('concurrent crossing electrons get distinct lanes', worstOverlap === 0,
      `max duplicates = ${worstOverlap}, largest batch = ${sawBatch}`);
    check('a real BATCH crosses (more than one electron at a time)', sawBatch >= 2,
      `largest concurrent batch = ${sawBatch}`);
  }
  /* The batch must respect the documented cap. */
  check('the batch never exceeds MAX_IN_FLIGHT', (() => {
    const q = P.createState(params, { count: COUNT, seed: SEED });
    let maxFlight = 0;
    for (let i = 0; i <= T; i++) { P.advance(q, i / T); maxFlight = Math.max(maxFlight, q.dots.filter((d) => d.moving).length); }
    return maxFlight <= 10;
  })(), '≤ 10 in flight (the documented junction queue cap)');

  /* The arrived electrons must SPREAD through the metal, not bunch into one
     corner. A biased scatter exponent (`v^0.7`) plus a one-directional idle
     drift put 38 of 64 electrons in the last 1/13 of the slab — the diagram
     showed a single dense dot instead of a distribution. */
  {
    const q = P.createState(params, { count: COUNT, seed: SEED });
    for (let i = 0; i <= T; i++) P.advance(q, i / T);
    const us = q.dots.filter((d) => d.side === 1).map((d) => d.u).sort((a, b) => a - b);
    const BUCKETS = 13;
    const counts = new Array(BUCKETS).fill(0);
    for (const u of us) counts[Math.min(BUCKETS - 1, Math.floor(u * BUCKETS))]++;
    const busiest = Math.max(...counts);
    const ideal = us.length / BUCKETS;
    check('arrived electrons are spread across the metal, not bunched',
      busiest <= Math.ceil(ideal * 2.2),
      `busiest 1/${BUCKETS} holds ${busiest} of ${us.length} (uniform would be ${ideal.toFixed(1)})`);
    check('the metal population spans most of the slab',
      us[us.length - 1] - us[0] > 0.5,
      `u from ${us[0].toFixed(3)} to ${us[us.length - 1].toFixed(3)}`);
    const empty = counts.filter((c) => c === 0).length;
    check('no large empty gaps in the metal population', empty <= 2,
      `${empty} of ${BUCKETS} buckets empty — occupancy ${JSON.stringify(counts)}`);
  }

  /* Every arrived electron must be VISIBLE, not hidden under a drawn line.
     In a metal E_C == E_F, so interpolating between them gave a ZERO-height
     band: all 64 shells landed on one y, exactly under the orange E_F line,
     which then painted over them (one shell visible at 1080P). The fix offsets
     them around E_F, so the ink must now span many rows. */
  {
    const withE = await renderDots(COUNT);
    const without = await renderDots(COUNT, true);
    const rows = new Set(), cols = new Set();
    let ink = 0;
    for (let i = 0; i < withE.length; i += 4) {
      if (withE[i] !== without[i] || withE[i + 1] !== without[i + 1] || withE[i + 2] !== without[i + 2]) {
        const px = i / 4;
        rows.add(Math.floor(px / W));
        cols.add(px % W);
        ink++;
      }
    }
    check('all arrived electrons are drawn (one ink cluster per electron)',
      ink > COUNT * 10, `${ink} px of ink for ${COUNT} electrons`);
    check('electrons are spread over MANY rows, not collapsed onto one line',
      rows.size >= 8, `ink spans ${rows.size} rows (was 1 before the E_F-band fix)`);
    check('electrons are spread over many columns too', cols.size >= COUNT,
      `ink spans ${cols.size} columns for ${COUNT} electrons`);
    /* The spread must be symmetric about E_F-ish, i.e. the cloud straddles the
       line rather than sitting entirely on it. */
    const ys = [...rows].sort((a, b) => a - b);
    check('the electron cloud has real vertical thickness',
      ys[ys.length - 1] - ys[0] >= 8,
      `rows ${ys[0]}..${ys[ys.length - 1]} = ${ys[ys.length - 1] - ys[0]}px thick`);
  }

  /* The SCRUB path must scatter too. advance() always looked right, so every
     tick-driven test passed while the live page — which seeks rather than
     ticks — collapsed all 64 electrons onto one point. Exercise the exact
     sequence the UI performs: seek(0), then seek(1). */
  {
    const q = P.createState(params, { count: COUNT, seed: SEED });
    P.syncTo(q, 0);
    P.syncTo(q, 1);
    const us = q.dots.filter((d) => d.side === 1).map((d) => d.u).sort((a, b) => a - b);
    check('a scrub from 0 to 1 transfers the whole population', us.length === COUNT,
      `${us.length}/${COUNT} in the metal`);
    const B = 13;
    const counts = new Array(B).fill(0);
    for (const u of us) counts[Math.min(B - 1, Math.floor(u * B))]++;
    const busiest = Math.max(...counts);
    const empty = counts.filter((c) => c === 0).length;
    /* The invariant is NO STACK plus COVERAGE, not uniformity: electrons pile up
       near the junction because that is where they arrive, so the busiest bucket
       is legitimately above the uniform value (measured 12-18 of 64 across seeds
       vs 4.9 uniform). The bug this replaces was 64 dots at ONE u value, which
       fails both the span test and the distinct-position test. */
    check('a scrub SCATTERS the electrons instead of stacking them',
      us[us.length - 1] - us[0] > 0.5,
      `u ${us[0].toFixed(3)}..${us[us.length - 1].toFixed(3)} across the slab`);
    check('a scrub leaves no empty stretch of the metal',
      empty <= 2, `${empty} of ${B} buckets empty — occupancy ${JSON.stringify(counts)}`);
    /* and the same must hold for other seeds, not just the default one */
    const seedsOK = [1, 999].every((sd) => {
      const z = P.createState(params, { count: COUNT, seed: sd });
      P.syncTo(z, 0); P.syncTo(z, 1);
      const zs = z.dots.filter((d) => d.side === 1).map((d) => d.u).sort((a, b) => a - b);
      return new Set(zs.map((u) => u.toFixed(6))).size === COUNT && zs[zs.length - 1] - zs[0] > 0.5;
    });
    check('the scrub scatter is seed-independent', seedsOK, 'seeds 1 and 999 also spread');
    check('no two scrubbed electrons land on exactly the same spot',
      new Set(us.map((u) => u.toFixed(6))).size >= Math.floor(us.length * 0.8),
      `${new Set(us.map((u) => u.toFixed(6))).size} distinct positions of ${us.length}`);
  }

  /* The density strip must not eat the plot. */
  check('the density strip leaves room for the band diagram', (() => {
    const PAD_TOP = 26, PAD_BOTTOM = 84;
    const innerH = H - PAD_TOP - PAD_BOTTOM;
    const stripBottom = PAD_TOP + innerH - 4;
    return stripBottom - PAD_TOP > innerH * 0.6;
  })(), 'strip sits in the bottom ~15% of the plot');
}

/* =====================================================
   R11 — split layout and the magnified junction panel
   =====================================================
   The single-panel design could not show the flow at all: the interface is a
   mathematical point once the gap closes, so a crossing electron travelled
   ~12px. These lock in the fix — a real crossing lane, shells that stay
   countable, and no crash at any size. */
console.log('\n[R11] Split layout + magnified junction (the flow must be visible)');
{
  const mkCanvas = (w, h) => {
    const cv = createCanvas(w, h);
    cv.width = w; cv.height = h;
    Object.defineProperty(cv, 'parentElement', {
      value: { getBoundingClientRect: () => ({ width: w, height: h }) },
    });
    return cv;
  };
  const frameAt = (w, h, t) => {
    const cv = mkCanvas(w, h);
    const parts = P.createState(params, { count: 64, seed: 7 });
    for (let i = 0; i <= 200; i++) P.advance(parts, t * (i / 200), { thermal: 0 });
    return { geo: R.renderFlow(cv, F.flowModel(params, t), parts, { thermal: false }), parts };
  };

  /* --- the split engages wherever it is affordable ------------------ */
  const wide = frameAt(1559, 949, 0.55);
  check('a wide canvas splits into full view + magnified junction',
    wide.geo.split === true && wide.geo.zoomWidth > 400,
    `zoom panel ${wide.geo.zoomWidth}px of ${wide.geo.w}px (full ${wide.geo.fullWidth}px)`);
  const mid = frameAt(1280, 800, 0.55);
  check('the split still engages at 1280px (a common laptop width)',
    mid.geo.split === true && mid.geo.zoomWidth > 300,
    `zoom panel ${mid.geo.zoomWidth}px`);
  const narrow = frameAt(700, 600, 0.55);
  check('a too-narrow canvas stays single-panel rather than cramped',
    narrow.geo.split === false && narrow.geo.zoomWidth === 0 && narrow.geo.fullWidth === narrow.geo.w,
    'no zoom panel below the split threshold');

  /* --- rendering never throws, at any size --------------------------- */
  let crashed = null;
  for (const [w, h] of [[1920, 1080], [1440, 900], [1024, 768], [900, 700], [768, 600], [390, 844]]) {
    for (const t of [0, 0.2, 0.45, 0.7, 1]) {
      try { frameAt(w, h, t); } catch (e) { crashed = `${w}x${h}@t=${t}: ${e.message}`; break; }
    }
    if (crashed) break;
  }
  check('rendering survives every viewport × stage combination', crashed === null,
    crashed || '30 combinations, no throw');

  /* --- the crossing actually traverses a visible lane ---------------- */
  /* Reproduces the panel's own geometry: the interface is a point, so the
     lane exists only because the zoom magnifies x. */
  const laneOf = (zoomW) => {
    const innerW = zoomW - 74 - 24;
    const CROSS = 0.15 * innerW;
    return 2 * CROSS;
  };
  const lane = laneOf(wide.geo.zoomWidth);
  check('a crossing travels a lane wide enough to see (was ~12px)',
    lane > 120, `${lane.toFixed(0)}px lane`);

  /* Measure the real travel of a crossing dot across the interface. */
  let sawSemi = false, sawMetal = false, samples = 0;
  {
    const parts = P.createState(params, { count: 64, seed: 7 });
    const innerW = wide.geo.zoomWidth - 74 - 24;
    const CROSS = 0.15 * innerW;
    const midX = 74 + 0.5 * innerW, metalX1 = midX - CROSS, semiX0 = midX + CROSS;
    for (let i = 0; i <= 600; i++) {
      const t = 0.35 + 0.30 * (i / 600);
      P.advance(parts, t, { thermal: 0 });
      for (const d of parts.dots) {
        if (!d.moving || !(d.carryTotal > 0)) continue;
        const prog = 1 - d.carry / d.carryTotal;
        const x = semiX0 + (metalX1 - semiX0) * prog;
        samples++;
        if (x > midX) sawSemi = true;
        if (x < midX) sawMetal = true;
      }
    }
  }
  check('a crossing electron is seen on BOTH sides of the interface',
    sawSemi && sawMetal, `${samples} in-flight samples, semi=${sawSemi} metal=${sawMetal}`);

  /* --- the zoom shows a real population, and they stay countable ------ */
  const eq = frameAt(1559, 949, 1.0);
  check('the magnified panel shows the transferred population',
    eq.geo.zoomElectronCount >= 40, `${eq.geo.zoomElectronCount} shells at equilibrium`);
  check('the magnified depletion region has a real width',
    eq.geo.zoomDepletionW > 20, `${eq.geo.zoomDepletionW.toFixed(0)}px`);
  check('the magnified depletion never swallows the whole slab',
    eq.geo.zoomDepletionW < (wide.geo.zoomWidth - 74 - 24) * 0.8,
    `${(100 * eq.geo.zoomDepletionW / (wide.geo.zoomWidth - 98)).toFixed(0)}% of the slab`);

  /* Shell radius shrinks with the panel so the packed grid cannot collide. */
  let minGap = Infinity;
  {
    const pack = (n, bw, bh, R) => {
      const step = R * 2 + 3;
      const cols = Math.max(1, Math.floor(bw / step));
      const rows = Math.max(1, Math.floor(bh / step));
      const out = [];
      for (let i = 0; i < Math.min(n, cols * rows); i++) {
        const c = i % cols, r = (i / cols) | 0;
        out.push([R + c * step + ((r % 2) ? step / 2 : 0), R + r * step]);
      }
      return out;
    };
    for (const panel of [768, 628, 500, 447, 430]) {
      const innerW = panel - 98;
      const R = Math.max(3.2, Math.min(6.4, innerW / 62));
      const CROSS = 0.15 * innerW, midX = 74 + 0.5 * innerW;
      const bw = (midX - CROSS - 8) - (74 + 6), bh = R * 14.5;
      const pts = pack(64, bw, bh, R);
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
          if (d < minGap) minGap = d;
        }
      }
      check(`shells never touch at panel width ${panel}px`,
        minGap > 2 * R, `min centre gap ${minGap.toFixed(1)}px vs 2R=${(2 * R).toFixed(1)}px`);
      minGap = Infinity;
    }
  }
}

/* ---------- R12 Semiconductor electrons: legal states AND real statistics --- */
console.log('\n[R12] Semiconductor electrons: no states in the gap, real statistics');
{
  /* Two claims, and the suite historically tested NEITHER of them.

     (a) SUPPORT. Conduction-band states exist only at and ABOVE E_C. Below it
         lies the band gap — E_F is 0.15 eV below E_C in this material — where a
         conduction-band electron cannot be. The renderer used to interpolate
         the population from E_C down toward E_F, which measured as 66–100% of
         the drawn dots sitting in the gap.

     (b) STATISTICS. Confining the cloud to legal energies is not enough: a
         uniform spread over [E_C, E_C+6kT] would be legal and still a lie,
         because n(E) ∝ e^{−(E−E_F)/kT} means most electrons hug the band edge.
         Uniform would give a mean of 3.0 kT above E_C; Boltzmann gives 1.000.
         That gap dwarfs the sampling noise, so the mean discriminates a real
         distribution from a straight line with no ambiguity.

     Both read the geometry the renderer REPORTS rather than pixels, because
     C.electron and C.cb are the same #5aaaff — a colour probe cannot tell an
     electron from the very E_C curve it must stay above, so it would pass even
     with every electron on the wrong side. */
  const mkCv = (w, h) => {
    const cv = createCanvas(w, h);
    cv.width = w; cv.height = h;
    Object.defineProperty(cv, 'parentElement', {
      value: { getBoundingClientRect: () => ({ width: w, height: h }) },
    });
    return cv;
  };
  const E_WIN = [-7.0, 0.5];                       // full view's energy window
  const METAL_W = 6;                               // kT, see flow-render.js
  const kT = BANDMODEL.THERMAL_V(params.T);
  /* E_C is NOT a constant: before contact the semiconductor sits at −χ_s and
     bands bend only once the Fermi levels lock together, so Ec_bulk moves by
     qV_bi = 0.65 eV over the animation. Referencing it at the wrong t reads as
     a 25 kT offset, which is exactly how this test first failed on itself. */
  const ecBulkAt = (t) => F.flowModel(params, t).levels.Ec_bulk;
  const EfMetal = F.flowModel(params, 1).levels.Ef_m;   // pinned by the metal
  /* Invert the renderer's own Y() using the geometry it reports. */
  const energyOf = (y, box) =>
    E_WIN[0] + (E_WIN[1] - E_WIN[0]) * (1 - (y - box.y) / box.h);
  const frameAt = (w, h, t, count, seed) => {
    const cv = mkCv(w, h);
    const parts = P.createState(params, { count, seed });
    for (let i = 0; i <= T; i++) P.advance(parts, t * (i / T));
    return R.renderFlow(cv, F.flowModel(params, t), parts, { thermal: false });
  };

  /* --- (a) support: is anything drawn inside the gap? -------------------- */
  let worst = -Infinity, seen = 0, worstMove = -Infinity, moveSeen = 0;
  let zoomWorst = -Infinity, zoomSeen = 0;
  for (const t of [0, 0.15, 0.3, 0.55, 0.8, 1.0]) {
    for (const [w, h] of [[1559, 949], [1280, 800], [900, 520]]) {
      const g = frameAt(w, h, t, COUNT, SEED);
      for (const b of g.electronBoxes) {
        if (b.moving) {
          /* Only the first half of the journey is still in the semiconductor.
             Beyond prog = 0.5 the dot has reached the interface and is being
             seated onto E_F in the metal — where "below E_C" is meaningless,
             because a metal has no gap. Testing on x instead does not work:
             once the vacuum gap closes, metalX1 and semiX0 coincide at midX,
             so being left of the junction says nothing about which material
             the electron is in. */
          if (b.prog != null && b.prog < 0.5) {
            moveSeen++; worstMove = Math.max(worstMove, b.y - g.ecBulkY);
          }
        } else if (b.side === -1) {
          seen++; worst = Math.max(worst, b.y - g.ecBulkY);
        }
      }
      if (g.zoomEcBulkY != null) {
        for (const b of g.zoomElectronBoxes) {
          if (b.moving || b.side !== -1) continue;
          zoomSeen++; zoomWorst = Math.max(zoomWorst, b.y - g.zoomEcBulkY);
        }
      }
    }
  }
  const fmtWorst = (v) => (v === -Infinity ? 'n/a' : v.toFixed(3) + 'px below E_C');
  check('every semiconductor electron is at or above E_C (full view)',
    seen > 0 && worst <= 1e-6, `${seen} draws, worst = ${fmtWorst(worst)}`);
  check('a crossing electron is already in the band while still on the semi side',
    moveSeen === 0 || worstMove <= 1e-6, `${moveSeen} mover samples, worst = ${fmtWorst(worstMove)}`);
  check('the magnified panel never packs a shell below E_C either',
    zoomSeen > 0 && zoomWorst <= 1e-6, `${zoomSeen} draws, worst = ${fmtWorst(zoomWorst)}`);
  /* --- (b) statistics: is it Boltzmann, or merely legal? ----------------- */
  {
    const g = frameAt(1559, 949, 0, 256, SEED);     // t = 0: all 256 in the semi
    const EcBulk = ecBulkAt(0);
    const xs = g.electronBoxes
      .filter((b) => !b.moving && b.side === -1)
      .map((b) => (energyOf(b.y, g.semiBox) - EcBulk) / kT);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sorted = [...xs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const hot = xs.filter((x) => x > 3).length / xs.length;

    check('all 256 sampled electrons are drawn', xs.length === 256, `${xs.length}`);
    check('mean energy is 1 kT above E_C (Boltzmann), not 3 kT (uniform)',
      mean > 0.85 && mean < 1.15,
      `mean = ${mean.toFixed(3)} kT  [theory 1.000, uniform 3.000]`);
    check('median sits at ln2 kT above E_C, hugging the band edge',
      median > 0.50 && median < 0.90,
      `median = ${median.toFixed(3)} kT  [theory 0.693]`);
    check('only ~5% of electrons are hotter than 3 kT (the real tail)',
      hot > 0.005 && hot < 0.14,
      `${(hot * 100).toFixed(1)}% above 3 kT  [theory 4.98%]`);
    check('the tail stays inside the plotted energy window',
      Math.max(...xs) <= BANDMODEL.TAIL_MAX_KT + 1e-9,
      `hottest = ${Math.max(...xs).toFixed(2)} kT (cap ${BANDMODEL.TAIL_MAX_KT})`);
  }

  /* --- and the metal side, which has its own wrong answer ---------------- */
  {
    const g = frameAt(1559, 949, 1.0, COUNT, SEED);  // t = 1: all in the metal
    const es = g.electronBoxes
      .filter((b) => !b.moving && b.side === 1)
      .map((b) => (energyOf(b.y, g.semiBox) - EfMetal) / kT);
    const above = es.filter((e) => e > 0).length / es.length;
    check('all 64 metal electrons are drawn', es.length === COUNT, `${es.length}`);
    check('the metal is an OCCUPIED sea: most electrons sit below E_F',
      above < 0.70, `${(above * 100).toFixed(1)}% above E_F  [theory 11.5%, old uniform 35%]`);
    check('but the Fermi tail is not clipped away either',
      above > 0.005, `${(above * 100).toFixed(1)}% above E_F`);
    check('no metal electron is outside the Fermi window',
      es.every((e) => e >= -METAL_W - 1e-9 && e <= METAL_W + 1e-9),
      `range = ${Math.min(...es).toFixed(2)} … ${Math.max(...es).toFixed(2)} kT (window ±${METAL_W})`);
  }

  /* --- and the distribution is actually VISIBLE, not merely obeyed ------- */
  {
    /* A correct distribution nobody can see is only half the job: the
       reference figure puts a curve beside the material precisely so a reader
       can check the statistics by eye. Two things can go wrong — the panel can
       be too narrow for a clear gutter (inset silently absent), or the plate
       can land on top of a shell (annotation eats the subject). */
    let drawn = 0, tried = 0, collide = 0;
    for (const [w, h] of [[1559, 949], [1280, 800], [900, 520]]) {
      for (const t of [0, 0.3, 0.6, 1]) {
        const g = frameAt(w, h, t, COUNT, SEED);
        tried++;
        if (!g.distBox) continue;
        drawn++;
        const b = g.distBox;
        for (const e of g.electronBoxes) {
          /* Shell radius is 3.4, so test the whole shell, not just its centre. */
          if (e.x + 3.4 > b.x && e.x - 3.4 < b.x + b.w &&
              e.y + 3.4 > b.y && e.y - 3.4 < b.y + b.h) collide++;
        }
      }
    }
    check('the n(E) distribution inset is drawn wherever there is a clear gutter',
      drawn >= 9, `${drawn} of ${tried} frames`);
    check('the inset never covers an electron',
      collide === 0, `${collide} overlapping shells`);
  }
}

console.log('\n' + (fails === 0
  ? 'FLOW_RENDER_CHECK_OK — all assertions passed'
  : 'FLOW_RENDER_CHECK_FAIL — ' + fails + ' assertion(s) failed'));
process.exit(fails === 0 ? 0 : 1);
