/**
 * flow-sim-check.js — proves the DRAWN electrons are the real ones.
 *
 * A particle animation can look perfect and still be a lie: the dots could be
 * decorative, appearing at a rate unrelated to the charge that physically must
 * move. This suite runs the exact browser code (flow-particles.js, no DOM) and
 * checks the bookkeeping against flow-model.js.
 *
 * Covered:
 *   S1  determinism    same seed → identical trajectory; different seed → differs
 *   S2  conservation   dot count never changes (nothing created or destroyed)
 *   S3  model tracking  metal population == round(f·count) at every t
 *   S4  THE BIG ONE    charge from dots == q·N_D·W within 1%
 *   S5  equilibrium    net transfer stops; the picture is static once settled
 *   S6  scrub          syncTo() is idempotent and jumps both directions
 *   S7  no NaN         positions and counters stay finite under abuse
 *
 * Run: bun scripts/flow-sim-check.js
 */
const { BANDMODEL } = await import('../src/assets/js/bandmodel.js');
const F = await import('../src/assets/js/flow-model.js');
const P = await import('../src/assets/js/flow-particles.js');

let fails = 0;
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? '  → ' + detail : ''));
  if (!cond) fails++;
}
const close = (x, y, tol) => Number.isFinite(x) && Math.abs(x - y) <= tol;
const params = BANDMODEL.DEFAULTS;
const E_CHARGE = 1.602176634e-19;
const COUNT = 64;
const Q_EQ = E_CHARGE * params.N_d * 1e6 * BANDMODEL.model(params).depletion.W;   // C/m²

/** Run a full 0→1 sweep, `ticks` frames. Returns the finished state. */
function sweep(ticks = 60, opts = {}) {
  const s = P.createState(params, { count: COUNT, seed: 12345, ...opts });
  for (let i = 0; i <= ticks; i++) P.advance(s, i / ticks, opts);
  return s;
}
const sig = (s) => s.dots.map((d) => `${d.side.toFixed(6)}:${d.u.toFixed(9)}:${d.v.toFixed(9)}`).join('|')
  + `#${s.crossings}#${s.step}`;
const metalN = (s) => s.dots.filter((d) => d.side === 1).length;

/* ---------- S1. determinism ---------- */
console.log('\n[S1] Determinism');
{
  const a = sweep(60), b = sweep(60);
  check('same seed → byte-identical trajectory', sig(a) === sig(b),
    `${a.step} ticks, ${a.crossings} crossings, identical`);
  const c = P.createState(params, { count: COUNT, seed: 999 });
  const d = P.createState(params, { count: COUNT, seed: 12345 });
  for (let i = 0; i <= 60; i++) { P.advance(c, i / 60); P.advance(d, i / 60); }
  const pos = (s) => s.dots.map((x) => x.u.toFixed(9)).join('|');
  check('a different seed gives different jitter', pos(c) !== pos(d));
  const re = P.reset(a, params);
  check('reset() rewinds to step 0 with 0 crossings', re.step === 0 && re.crossings === 0);
  check('reset() is a true rewind (replays identically)', sig(P.reset(sweep(60), params)) === sig(a));
}

/* ---------- S2. conservation ---------- */
console.log('\n[S2] Conservation — nothing is created or destroyed');
{
  const s = P.createState(params, { count: COUNT, seed: 777 });
  const n0 = s.dots.length;
  let popOK = true, sideOK = true;
  for (let i = 0; i <= 400; i++) {
    P.advance(s, i / 400);
    if (s.dots.length !== n0) popOK = false;
    for (const d of s.dots) if (d.side !== 1 && d.side !== -1) sideOK = false;
  }
  check(`dot population is constant across 400 ticks (${n0})`, popOK);
  check('every dot has a valid side tag (+1 / −1)', sideOK);
  const q = P.snapshot(s, 1);
  check('metal + semiconductor == count, always', q.metal + q.semi === q.count,
    `${q.metal} + ${q.semi} = ${COUNT}`);
  check('netCross === metal − semiconductor', q.netCross === q.metal - q.semi);
  check('in-flight dots never exceed the population', q.inFlight <= q.count);
}

/* ---------- S3. the population tracks the model ---------- */
console.log('\n[S3] Metal population tracks f(t) = chargeFraction(t)');
{
  const s = P.createState(params, { count: COUNT, seed: 4242 });
  let worst = 0, worstT = 0;
  const total = 600;
  for (let i = 0; i <= total; i++) {
    const t = i / total;
    P.advance(s, t);
    /* In-flight dots are legitimately mid-junction, so allow a small lag. */
    const err = Math.abs(P.expectedMetalCount(s, t) - metalN(s));
    if (err > worst) { worst = err; worstT = t; }
  }
  /* A bounded queue mid-transient is BY DESIGN (see MAX_IN_FLIGHT in
     flow-particles.js): up to that many dots are legitimately mid-junction and
     count toward the target. What must hold is that the lag never exceeds the
     cap at ANY frame rate, and that it converges to zero by equilibrium. */
  const CAP = 10;
  check(`population tracks the model to within the ${CAP}-dot in-flight cap`, worst <= CAP,
    `worst lag = ${worst} dot(s) near t=${worstT.toFixed(3)} (cap ${CAP})`);
  check('the lag vanishes by equilibrium (queue fully drained)', metalN(s) === COUNT,
    `${metalN(s)}/${COUNT} in the metal, ${s.dots.filter((d) => d.moving).length} in flight`);
  /* Frame-rate independence: the SAME assertion at a much coarser tick rate.
     A tick-based crossing duration failed exactly here. */
  const coarse = P.createState(params, { count: COUNT, seed: 4242 });
  let worstCoarse = 0;
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    P.advance(coarse, t);
    worstCoarse = Math.max(worstCoarse,
      Math.abs(P.expectedMetalCount(coarse, t) - metalN(coarse)));
  }
  check('same bound holds at a 10× coarser frame rate (60 ticks)', worstCoarse <= CAP,
    `worst lag = ${worstCoarse} dot(s) at 60 ticks`);
  check('a coarse sweep still completes the transfer', metalN(coarse) === COUNT,
    `${metalN(coarse)}/${COUNT} arrived`);
  /* And it must not depend on the seed. */
  const seeds = [1, 99, 424242];
  const allOK = seeds.every((sd) => {
    const q = P.createState(params, { count: COUNT, seed: sd });
    for (let i = 0; i <= 300; i++) P.advance(q, i / 300);
    return metalN(q) === COUNT;
  });
  check('completion is seed-independent', allOK, `seeds ${seeds.join(', ')} all reached 64/64`);
  const s2 = P.createState(params, { count: COUNT, seed: 4242 });
  for (let i = 0; i <= 300; i++) P.advance(s2, 1);
  check('at t=1 the metal holds exactly `count` dots', metalN(s2) === COUNT,
    `${metalN(s2)} of ${COUNT}`);
  const s3 = P.createState(params, { count: COUNT, seed: 1 });
  for (let i = 0; i <= 100; i++) P.advance(s3, 0);
  check('at t=0 nothing crosses (stage A has no flux)', s3.crossings === 0);
  /* The population must be a MONOTONE function of t, or electrons would
     appear to migrate back out of the metal while charge is still flowing in. */
  let popMono = true, prevMetal = -1;
  const s4 = P.createState(params, { count: COUNT, seed: 2024 });
  for (let i = 0; i <= 600; i++) {
    P.advance(s4, i / 600);
    if (metalN(s4) < prevMetal) popMono = false;
    prevMetal = metalN(s4);
  }
  check('metal population never shrinks during a forward sweep', popMono,
    `ended at ${metalN(s4)}/${COUNT}`);
  check('the sweep ends with the metal full', metalN(s4) === COUNT);
}
console.log('\n[S4] Charge from the dots == q·N_D·W  (the anti-lie test)');
{
  const s = P.createState(params, { count: COUNT, seed: 31337 });
  for (let i = 0; i <= 300; i++) P.advance(s, 1);
  const model = F.flowModel(params, 1);
  const scale = P.dotScale(s, model);
  /* 64 dots stand in for the whole sheet, so rounding costs ≤ 1/64 ≈ 1.6%.
     C/m² → µC/cm² is a factor of 1e6 (1 m² = 1e4 cm², 1 C = 1e6 µC). */
  const uC_cm2 = (c_per_m2) => c_per_m2 * 1e6;
  check('charge delivered matches the physics within 1%',
    Math.abs(scale.movedC_cm2 * 1e4 - Q_EQ) / Q_EQ < 0.01,
    `dots say ${uC_cm2(scale.movedC_cm2 * 1e4).toFixed(2)} µC/cm², physics ${uC_cm2(Q_EQ).toFixed(2)} µC/cm²`);
  const want = model.charge.sheet / 1e4;                 // cm⁻²
  const got = scale.moved * scale.perDot_cm2;
  check('electron count matches N_D·W within 1%', Math.abs(got - want) / want < 0.01,
    `${got.toExponential(3)} vs ${want.toExponential(3)} cm⁻²`);
  check('each dot is worth a sane number of real electrons',
    scale.perDot_cm2 > 1e8 && scale.perDot_cm2 < 1e11,
    `1 dot ≈ ${scale.perDot_cm2.toExponential(2)} real electrons/cm²`);
  /* A different dot count must yield the SAME physical charge. That only holds
     if the dots sample a fixed sheet density rather than being a fixed number
     of electrons — the difference between a sampling and a decoration. */
  const s2 = P.createState(params, { count: 200, seed: 31337 });
  for (let i = 0; i <= 300; i++) P.advance(s2, 1);
  const sc2 = P.dotScale(s2, F.flowModel(params, 1));
  const c200 = sc2.moved * sc2.perDot_cm2;
  check('total charge is independent of how many dots are drawn',
    Math.abs(got - c200) / c200 < 0.01,
    `64 dots → ${got.toExponential(3)}, 200 dots → ${c200.toExponential(3)} cm⁻²`);
}

/* ---------- S5. equilibrium: flow stops ---------- */
console.log('\n[S5] Equilibrium — the transfer stops');
{
  const s = P.createState(params, { count: COUNT, seed: 555 });
  for (let i = 0; i <= 300; i++) P.advance(s, 1);
  const settledCrossings = s.crossings, settledNet = s.netCross;
  for (let i = 0; i < 200; i++) P.advance(s, 1);
  check('no further crossings once at equilibrium', s.crossings === settledCrossings,
    `${settledCrossings} crossings, unchanged after 200 more ticks`);
  check('net transfer is frozen', s.netCross === settledNet, `netCross = ${s.netCross}`);
  check('nothing is left in flight at equilibrium', s.dots.filter((d) => d.moving).length === 0);
  check('model also reports zero net flux at t=1', F.fluxBalance(params, 1).net === 0);
  /* And the transient must have been BUSY, or the demo would prove nothing. */
  const busy = P.createState(params, { count: COUNT, seed: 555 });
  let peak = 0;
  for (let i = 0; i <= 300; i++) { P.advance(busy, i / 300); peak = Math.max(peak, busy.crossings); }
  check('the transient really moved electrons (not a static picture)', peak > COUNT / 2,
    `${peak} crossings during the sweep`);
}

/* ---------- S6. scrubbing ---------- */
console.log('\n[S6] Scrubbing is a seek, not an animation');
{
  const s = P.createState(params, { count: COUNT, seed: 8 });
  P.syncTo(s, 0);
  check('scrub to t=0 → no dots in the metal', s.settled === 0);
  P.syncTo(s, 1);
  check('scrub to t=1 → all dots in the metal', s.settled === COUNT);
  P.syncTo(s, 1);
  check('scrub is idempotent', s.settled === COUNT);
  P.syncTo(s, 0);
  check('scrubbing back to t=0 empties the metal', s.settled === 0);
  P.syncTo(s, 1);
  check('scrubbing forward again refills it', s.settled === COUNT);
  const before = s.crossings;
  P.syncTo(s, 0.5);
  check('syncTo does not fabricate crossings', s.crossings === before,
    `crossings stayed ${before} — a seek is not a physical event`);
  check('population is still intact after scrubbing about', s.dots.length === COUNT);
  check('mid-scrub population matches the model', s.settled === P.expectedMetalCount(s, 0.5),
    `${s.settled} == round(0.5·${COUNT})`);
}

/* ---------- S7. robustness ---------- */
console.log('\n[S7] Robustness — no NaN, no crash');
{
  const s = P.createState(params, { count: COUNT, seed: 11 });
  let finite = true, inRange = true;
  for (const t of [0, 0.13, 0.22, 0.4, 0.62, 0.9, 1, NaN, -3, 7]) {
    P.advance(s, t);
    for (const d of s.dots) {
      if (!Number.isFinite(d.u) || !Number.isFinite(d.v) || !Number.isFinite(d.side)) finite = false;
      if (d.u < 0 || d.u > 1) inRange = false;
    }
  }
  check('all positions stay finite under abusive t values', finite);
  check('all u positions stay within [0,1]', inRange);
  check('thermal:0 freezes the jitter (respects prefers-reduced-motion)', (() => {
    const f = P.createState(params, { count: 32, seed: 3 });
    for (const d of f.dots) { d.u = 0.5; d.side = -1; }
    P.advance(f, 0, { thermal: 0 });
    return f.dots.every((d) => d.u === 0.5);
  })());
  check('count is floored at a sane minimum', P.createState(params, { count: 1 }).count >= 8);
  check('snapshot() is detached (mutating it cannot corrupt the state)', (() => {
    const q = P.snapshot(s, 1);
    const before = s.dots.length;
    q.metal = 999; q.count = -1;
    return s.dots.length === before;
  })());
}

console.log('\n' + (fails === 0
  ? 'FLOW_SIM_CHECK_OK — all assertions passed'
  : 'FLOW_SIM_CHECK_FAIL — ' + fails + ' assertion(s) failed'));
process.exit(fails === 0 ? 0 : 1);
