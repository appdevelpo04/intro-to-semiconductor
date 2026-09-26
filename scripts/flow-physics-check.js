/**
 * flow-physics-check.js — asserts the equilibrium + transient physics of the
 * "electron flow on contact" animation (flow-model.js).
 *
 * Pure arithmetic, no DOM, no browser — this runs in CI (see static.yml).
 *
 * Covered:
 *   1  timeline      stages ordered, contiguous, cover [0,1]; t is clamped
 *   2  pre-contact   ΔE_F = V_bi is the fuel; Φ_B is the barrier (NOT the fuel)
 *   3  f(t)          monotone 0→1, exactly 0 in A and exactly 1 in D
 *   4  √f scaling    W, Q, E_max scale as √f; ΔE_F as (1−f)
 *   5  equilibrium   at t=1 every quantity matches BANDMODEL.depletion() exactly
 *   6  band profile  zero bend at the edge, f·V_bi at the interface, flat bulk
 *   7  occupancy     barrier is ~31 kT → metal electrons are blocked
 *   8  flux balance  net > 0 mid-transient, EXACTLY 0 at equilibrium
 *   9  robustness    no NaN anywhere over 1000 samples / out-of-range input
 *
 * Run: bun scripts/flow-physics-check.js
 */
const { BANDMODEL } = await import('../src/assets/js/bandmodel.js');
const F = await import('../src/assets/js/flow-model.js');

let fails = 0;
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? '  → ' + detail : ''));
  if (!cond) fails++;
}
const close = (x, y, tol) => Number.isFinite(x) && Math.abs(x - y) <= tol;
const P = BANDMODEL.DEFAULTS;
const kT = BANDMODEL.THERMAL_V(P.T);
const mEq = BANDMODEL.model(P);
const ND = P.N_d * 1e6;                     // cm⁻³ → m⁻³
const Q_EQ = BANDMODEL.E_CHARGE * ND * mEq.depletion.W;

/** Find t whose chargeFraction is closest to `target` (monotone → linear scan). */
function tForFraction(target) {
  let t = 0;
  for (let i = 0; i <= 20000; i++) { t = i / 20000; if (F.chargeFraction(t) >= target) break; }
  return t;
}

/* ---------- 1. timeline ---------- */
console.log('\n[1] Timeline');
const S = F.FLOW_STAGES;
check('four stages A–D', S.length === 4 && S.map((s) => s.id).join('') === 'ABCD');
check('contiguous, starting at 0', S[0].t0 === 0);
let contig = true, ordered = true;
for (let i = 0; i < S.length; i++) {
  if (S[i].t1 <= S[i].t0) ordered = false;
  if (i > 0 && S[i].t0 !== S[i - 1].t1) contig = false;
}
check('stages ordered and non-empty', ordered);
check('no gaps or overlaps between stages', contig, S.map((s) => `${s.t0}-${s.t1}`).join(' '));
check('timeline ends exactly at 1', S[S.length - 1].t1 === 1);
check('clampT(-5) = 0', F.clampT(-5) === 0);
check('clampT(9) = 1', F.clampT(9) === 1);
check('clampT(NaN) = 0 (a bad scrub cannot poison the model)', F.clampT(NaN) === 0);
check('stageAt(0) = A', F.stageAt(0).id === 'A', F.stageAt(0).id);
check('stageAt(1) = D', F.stageAt(1).id === 'D', F.stageAt(1).id);
check('stageAt(0.5) = C (transient)', F.stageAt(0.5).id === 'C', F.stageAt(0.5).id);
check('stage u stays strictly inside 0..1 at each midpoint', S.every((s) => {
  const mid = F.stageAt((s.t0 + s.t1) / 2);
  return mid.u > 0 && mid.u < 1;
}));

/* ---------- 2. pre-contact driving force vs barrier ---------- */
console.log('\n[2] Pre-contact: ΔE_F is the fuel, Φ_B is the barrier');
const lvA = F.levels(P, 0);
check('ΔE_F at t=0 equals V_bi', close(lvA.dEf, mEq.barrier.Vbi, 1e-9),
  `ΔE_F = ${lvA.dEf.toFixed(4)} eV, V_bi = ${mEq.barrier.Vbi.toFixed(4)} V`);
check('metal E_F pinned at −Φ_m for the whole animation',
  lvA.Ef_m === -P.phi_m && F.levels(P, 1).Ef_m === -P.phi_m, `E_F,m = ${lvA.Ef_m} eV`);
check('semiconductor E_F at t=0 = pre-contact value (E_C,bulk − ΔE)',
  close(lvA.Ef_semi, mEq.levels.Ef_s, 1e-9), `E_F,semi = ${lvA.Ef_semi.toFixed(4)} eV`);
check('Φ_B = Φ_m − χ_s (Schottky–Mott)', close(mEq.barrier.Phi_B, P.phi_m - P.chi_s, 1e-9),
  `Φ_B = ${mEq.barrier.Phi_B.toFixed(3)} eV`);
check('Φ_B ≫ V_bi — the barrier is NOT the driving force',
  mEq.barrier.Phi_B > mEq.barrier.Vbi * 1.1,
  `Φ_B = ${(mEq.barrier.Phi_B / kT).toFixed(1)} kT vs ΔE_F = ${(mEq.barrier.Vbi / kT).toFixed(1)} kT`);
check('pre-contact ΔE_F is a large driving force (>10 kT)', lvA.dEf / kT > 10,
  `${(lvA.dEf / kT).toFixed(1)} kT`);
check(`V_bi = Φ_B − ΔE, NOT the image's simplified Φ_m − χ`,
  close(mEq.barrier.Vbi, P.phi_m - P.chi_s - P.dE_s, 1e-9) &&
  Math.abs(mEq.barrier.Vbi - (P.phi_m - P.chi_s)) > 0.1,
  `V_bi = ${mEq.barrier.Vbi.toFixed(3)} V ≠ Φ_m − χ = ${(P.phi_m - P.chi_s).toFixed(3)} V`);

/* ---------- 3. charge fraction f(t) ---------- */
console.log('\n[3] Transferred fraction f(t)');
check('f = 0 throughout stage A', [0, 0.05, 0.119].every((t) => F.chargeFraction(t) === 0));
check('f = exactly 1 throughout stage D', [0.62, 0.8, 1].every((t) => F.chargeFraction(t) === 1));
check('f(1) === 1 exactly (no floating residue)', F.chargeFraction(1) === 1);
let mono = true, prev = -1;
for (let i = 0; i <= 2000; i++) {
  const f = F.chargeFraction(i / 2000);
  if (f < prev - 1e-12) mono = false;
  prev = f;
}
check('f(t) is monotonically non-decreasing (2000 samples)', mono);
check('f stays within [0,1]', [0, 0.13, 0.3, 0.9, 1].every((t) => {
  const f = F.chargeFraction(t);
  return f >= 0 && f <= 1;
}));
const fTouch = F.chargeFraction(S[1].t1 - 1e-9);
check('stage B moves only a tiny fraction (the barrier blocks the rest)',
  fTouch > 0 && fTouch < 0.1, `f(touch) = ${fTouch.toExponential(2)}`);


/* ---------- 4. √f scaling ---------- */
console.log('\n[4] W, Q, E_max ∝ √f   and   ΔE_F ∝ (1−f)');
for (const frac of [0.25, 0.5, 0.75]) {
  const t = tForFraction(frac);
  const ct = F.chargeTransfer(P, t);
  const root = Math.sqrt(frac);
  check(`f≈${frac}: W = W_eq·√f`, close(ct.W / mEq.depletion.W, root, 1e-3),
    `W = ${(ct.W * 1e9).toFixed(1)} nm of ${(mEq.depletion.W * 1e9).toFixed(1)} nm`);
  check(`f≈${frac}: Q = Q_eq·√f`, close(ct.Q / Q_EQ, root, 1e-3));
  check(`f≈${frac}: E_max = E_max,eq·√f`, close(ct.Emax / mEq.depletion.Emax, root, 1e-3),
    `E_max = ${(ct.Emax / 1e5).toFixed(1)} V/cm`);
  check(`f≈${frac}: ΔE_F = V_bi·(1−f)`, close(ct.dEf, mEq.barrier.Vbi * (1 - ct.f), 1e-12),
    `ΔE_F = ${(ct.dEf / kT).toFixed(2)} kT (started at ${(mEq.barrier.Vbi / kT).toFixed(1)} kT)`);
  check(`f≈${frac}: the scan actually reached f ≈ ${frac}`, close(ct.f, frac, 2e-3),
    `f = ${ct.f.toFixed(6)}`);
}

/* ---------- 5. equilibrium agreement with BANDMODEL ---------- */
console.log('\n[5] At t=1 the flow model equals the equilibrium model exactly');
const eq = F.chargeTransfer(P, 1);
check('W matches BANDMODEL.depletion().W', close(eq.W, mEq.depletion.W, 1e-15),
  `${(eq.W * 1e9).toFixed(2)} nm`);
check('E_max matches BANDMODEL.depletion().Emax', close(eq.Emax, mEq.depletion.Emax, 1e-6),
  `${(eq.Emax / 1e5).toFixed(1)} V/cm`);
check('ΔE_F = 0 at equilibrium (the E_F levels coincide)', eq.dEf === 0, `ΔE_F = ${eq.dEf}`);
check('net flux = 0 at equilibrium', eq.netFlux === 0);
check('sheet density = N_D·W (charge neutrality)', close(eq.sheet, ND * eq.W, 1e-6),
  `${eq.sheet.toExponential(3)} m⁻² = ${(eq.sheet / 1e4).toExponential(3)} cm⁻²`);
check('Q = q·N_D·W', close(eq.Q, Q_EQ, 1e-18), `${(eq.Q * 1e4).toFixed(2)} µC/cm²`);
check('the two Fermi levels are equal at equilibrium',
  F.levels(P, 1).Ef_semi === F.levels(P, 1).Ef_m,
  `E_F = ${F.levels(P, 1).Ef_m.toFixed(3)} eV`);
check('Q grows monotonically with f', (() => {
  let p = -1;
  for (let i = 0; i <= 1000; i++) { const q = F.chargeTransfer(P, i / 1000).Q; if (q < p - 1e-24) return false; p = q; }
  return true;
})());


/* ---------- 6. band profile shape ---------- */
console.log('\n[6] Band profile');
const bIface = F.bandEnergyAt(0, P, 1);
const bEdge = F.bandEnergyAt(1, P, 1);
const bBulk = F.bandEnergyAt(1.5, P, 1);
check('bend = f·V_bi at the interface (t=1)', close(bIface.bend, mEq.barrier.Vbi, 1e-6),
  `qV_bi = ${bIface.bend.toFixed(4)} eV`);
check('bend = 0 at the depletion edge', close(bEdge.bend, 0, 1e-12), `${bEdge.bend.toExponential(2)} eV`);
check('bulk is flat beyond the edge', close(bBulk.Ec, bEdge.Ec, 1e-12));
check('E_g is preserved through the bend', close(bIface.Ec - bIface.Ev, P.Eg_s, 1e-12),
  `E_g = ${(bIface.Ec - bIface.Ev).toFixed(3)} eV`);
check('no bend before contact (f=0)', F.bandEnergyAt(0, P, 0).bend === 0);
check('interface sits ABOVE the bulk (depletion, rectifying n-type)',
  bIface.Ec > bBulk.Ec, `ΔEc = ${(bIface.Ec - bBulk.Ec).toFixed(4)} eV`);
const prof = F.bandProfile(P, 1);
check('profile is finite everywhere',
  prof.every((r) => Number.isFinite(r.Ec) && Number.isFinite(r.Ev) && Number.isFinite(r.n)));
check('electron density dips at the interface vs the bulk', prof[0].n < prof[prof.length - 1].n,
  `n(interface)/n(bulk) = ${prof[0].n.toExponential(2)}`);
check('density normalized to 1 in the bulk', close(prof[prof.length - 1].n, 1, 1e-9));
/* The density is NORMALIZED to its bulk value, so the interface dip is the
   RATIO  exp(−Φ_B/kT) / exp(−ΔE/kT)  =  exp(−V_bi/kT)  — not exp(−Φ_B/kT).
   The un-normalized exp(−Φ_B/kT) is asserted separately in [7] as the absolute
   Fermi–Dirac occupancy of the interface conduction edge. */
check('normalized interface dip = exp(−V_bi/kT)', close(prof[0].n, Math.exp(-mEq.barrier.Vbi / kT), 1e-15),
  `${prof[0].n.toExponential(3)} vs e^(−V_bi/kT) = ${Math.exp(-mEq.barrier.Vbi / kT).toExponential(3)}`);
check('bulk is flat all the way out (no unphysical bump past the edge)', (() => {
  const edge = F.bandEnergyAt(1, P, 1).Ec;
  return [1.1, 1.3, 1.5, 1.6].every((d) => close(F.bandEnergyAt(d, P, 1).Ec, edge, 1e-12));
})());
check('interface E_C is pinned at −χ_s (vacuum continuity)', close(bIface.Ec, -P.chi_s, 1e-12),
  `E_C,i = ${bIface.Ec.toFixed(4)} eV = −χ_s`);
check('bulk E_C = E_F + ΔE at equilibrium', close(bEdge.Ec, F.levels(P, 1).Ef_m + P.dE_s, 1e-12),
  `E_C,bulk = ${bEdge.Ec.toFixed(4)} eV`);
check('band is continuous across the C→D boundary (no visible jump)', (() => {
  const b = S[3].t0;
  return close(F.bandEnergyAt(0, P, b - 1e-6).Ec, F.bandEnergyAt(0, P, b + 1e-6).Ec, 1e-4);
})());


/* ---------- 7. occupancy / barrier in kT ---------- */
console.log('\n[7] Barrier occupancy');
const occ = F.barrierOccupancy(P);
check('Φ_B = 30.9 kT at 300 K (thermionically a wall)', close(occ.barrier_kT, 30.94, 0.1),
  `${occ.barrier_kT.toFixed(2)} kT`);
check('metal electrons above E_C are negligible', occ.metalAbove < 1e-12,
  `f = ${occ.metalAbove.toExponential(2)} → the metal cannot feed the current`);
check('that equals e^(−Φ_B/kT)', close(occ.metalAbove, Math.exp(-occ.Phi_B / kT), 1e-15));
check('semiconductor E_C occupancy is the actual supplier',
  occ.semiAtEc > 1e-3 && occ.semiAtEc < 1e-2,
  `f(E_C) = ${occ.semiAtEc.toExponential(2)} = e^(−${occ.dE_kT.toFixed(1)} kT)`);

/* ---------- 8. flux balance ---------- */
console.log('\n[8] Flux balance — equilibrium is net ZERO');
const fC = F.fluxBalance(P, 0.4);
const fD = F.fluxBalance(P, 0.9);
const fA = F.fluxBalance(P, 0);
check('stage A: no flux at all (surfaces apart)', fA.net === 0 && fA.forward === 0);
check('mid-transient: NET flow semi → metal', fC.net > 0 && fC.direction === 1,
  `net = ${fC.net.toFixed(4)}, direction = ${fC.direction}`);
check('equilibrium: forward = reverse (both large)',
  fD.forward > 0 && close(fD.forward, fD.reverse, 1e-12), `fwd = ${fD.forward} , rev = ${fD.reverse}`);
check('equilibrium: net is EXACTLY zero', fD.net === 0, `net = ${fD.net}`);
check('equilibrium: flagged balanced', fD.balanced === true);
check('equilibrium: direction 0 (not "still flowing right")', fD.direction === 0);
let netDecay = true, prevNet = Infinity;
for (let i = 0; i <= 100; i++) {
  const n = F.fluxBalance(P, 0.22 + (i / 100) * 0.4).net;   // across stage C
  if (n > prevNet + 1e-12) netDecay = false;
  prevNet = n;
}
check('net flux decays monotonically through the transient', netDecay);

/* ---------- 9. robustness ---------- */
console.log('\n[9] Robustness — no NaN, no crash');
check('every public entry point survives bad t', [NaN, -1, 2, 0.5, 1, 1e9, -1e9].every((t) => {
  try {
    const m = F.flowModel(P, t);
    return Number.isFinite(m.t) && m.t >= 0 && m.t <= 1 &&
           Number.isFinite(m.charge.W) && Number.isFinite(m.charge.Q) &&
           Number.isFinite(m.levels.Ef_semi) && m.profile.every((r) => Number.isFinite(r.Ec));
  } catch { return false; }
}));
check('1000-sample sweep is finite across the whole model', (() => {
  for (let i = 0; i <= 1000; i++) {
    const m = F.flowModel(P, i / 1000);
    if (!Number.isFinite(m.charge.f + m.charge.W + m.charge.Emax + m.charge.Q + m.flux.net)) return false;
  }
  return true;
})());
check('sweep never exceeds the equilibrium charge', (() => {
  for (let i = 0; i <= 500; i++) {
    if (F.chargeTransfer(P, i / 500).Q > Q_EQ + 1e-24) return false;
  }
  return true;
})());
check('flowModel snapshot is self-consistent (levels ↔ charge agree)', (() => {
  const m = F.flowModel(P, 0.4);
  return close(m.charge.dEf, m.levels.dEf, 1e-12) && close(m.charge.f, m.levels.frac, 1e-12);
})());
const ts = F.timeScales(P);
check('transit is picoseconds and the slow-motion factor is huge',
  ts.transit_ps > 0.1 && ts.transit_ps < 100 && ts.slowMotion > 1e9,
  `${ts.transit_ps.toFixed(2)} ps → slowed ${ts.slowMotion.toExponential(2)}×`);

console.log('\n' + (fails === 0
  ? 'FLOW_PHYSICS_CHECK_OK — all assertions passed'
  : 'FLOW_PHYSICS_CHECK_FAIL — ' + fails + ' assertion(s) failed'));
process.exit(fails === 0 ? 0 : 1);
