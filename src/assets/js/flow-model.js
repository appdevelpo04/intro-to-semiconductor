/**
 * flow-model.js — pure physics + timeline for the "electron flow on contact"
 * animation (metal | n-type semiconductor, stages A–D).
 *
 * Scope: CONTACT FORMATION ONLY. There is no applied-bias stage here by design.
 *
 * Zero DOM, zero canvas, zero timing. Everything is a pure function of the
 * timeline scalar t ∈ [0,1] and a params object, which is what makes the whole
 * thing headless-testable in plain Node (see scripts/flow-physics-check.js).
 *
 * Reuses BANDMODEL for the shared physics (W, E_max, Φ_B, V_bi, constants) so
 * this page and the main Schottky page can never disagree about the numbers.
 *
 * THE CENTRAL IDEA
 * ----------------
 * Contact is a charge-transfer problem, and the amount that must move is not
 * free — it is fixed by charge neutrality. The semiconductor hands the metal
 * exactly enough electrons to strip the donors out of a layer W thick:
 *
 *     n_transferred = N_D · W        (electrons per unit area)
 *     Q             = q · N_D · W    (C per unit area)
 *     W             = sqrt(2 ε V_bi / (q N_D))
 *
 * The transient is exponential charge relaxation, Q(t) = Q∞(1 − e^{−t/τ}), so
 * the NET flow rate peaks the instant the surfaces touch and then decays to
 * zero. That is the whole animation, and it is why:
 *
 *   • f (transferred fraction) rises as 1 − e^{−k u}, and
 *   • W, Q, E_max all rise as sqrt(f)  (they all follow W), while
 *   • ΔE_F falls as (1 − f)             (it IS the leftover driving force).
 *
 *   net flux ∝ e^{−k u}  →  net current is zero at equilibrium.
 *
 * HONESTY NOTE — equilibrium is NOT "electrons keep flowing one way". At
 * equilibrium electrons cross in BOTH directions at a large rate and the fluxes
 * balance exactly, so the net current is zero. Most textbook figures (including
 * the reference image this was built from) imply ongoing one-way flow; that is
 * a physics error, and fluxBalance() reports the true balanced case.
 */
'use strict';

import { BANDMODEL } from './bandmodel.js';

/* =====================================================
   1.  TIMELINE
   ===================================================== */

/**
 * Stage boundaries on t ∈ [0,1].
 *
 * The last stage runs to 1.0 rather than stopping at 0.85: equilibrium is the
 * terminal state, so the tail of the timeline is a deliberate HOLD on it. That
 * keeps the scrub range and the clock identical to a single 0→1 sweep, and
 * keeps `t = 1` meaning "fully settled" for tests.
 */
export const FLOW_STAGES = Object.freeze([
  { id: 'A', key: 'separated',   label: 'Separated',   t0: 0.00, t1: 0.12,
    blurb: 'Metal and n-type semiconductor apart. No contact, no charge can move.' },
  { id: 'B', key: 'contact',     label: 'Contact',     t0: 0.12, t1: 0.22,
    blurb: 'Surfaces touch. The first electrons hop the junction.' },
  { id: 'C', key: 'transient',   label: 'Diffusion',   t0: 0.22, t1: 0.62,
    blurb: 'Net flow semi → metal, decaying. Donors exposed, band bends, depletion grows.' },
  { id: 'D', key: 'equilibrium', label: 'Equilibrium', t0: 0.62, t1: 1.00,
    blurb: 'Exchange continues in both directions, but the fluxes balance: net current = 0.' },
]);

/* Fraction of the total charge already moved by the time stage B ends. Small:
 * stage B is "they touch", and the barrier is ~31 kT tall, so almost nothing
 * gets through yet. */
const FRAC_AT_TOUCH = 0.05;

/* e-folds across stage C. Larger = a sharper initial spike then a long tail,
 * which is the real shape of exponential charge relaxation. */
const TRANSIENT_K = 3;

/** Clamp t into [0,1]. NaN → 0 so a bad scrub can never poison the model. */
export function clampT(t) {
  const n = Number(t);
  if (!isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Which stage is t in?
 * @returns {{index:number,id:string,key:string,label:string,blurb:string,u:number}}
 *   `u` is progress WITHIN that stage, 0..1.
 */
export function stageAt(t) {
  const tt = clampT(t);
  let i = 0;
  for (let k = 0; k < FLOW_STAGES.length; k++) {
    if (tt >= FLOW_STAGES[k].t0) i = k;
  }
  const s = FLOW_STAGES[i];
  const span = s.t1 - s.t0;
  const u = span > 0 ? (tt - s.t0) / span : 0;
  return { index: i, id: s.id, key: s.key, label: s.label, blurb: s.blurb, u };
}

/** Start t of a stage by id ('A'..'D'), or 0 when unknown. */
export function stageStart(id) {
  const s = FLOW_STAGES.find((x) => x.id === id);
  return s ? s.t0 : 0;
}

/** Smooth 0→1 with zero slope at both ends (no visual snap at stage joins). */
export function easeInOut(u) {
  const x = Math.max(0, Math.min(1, u));
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/**
 * Exponential relaxation progress inside stage C, normalized so f(0)=0, f(1)=1.
 * Monotone, and its DERIVATIVE is strictly decreasing — that is the decaying
 * net flux, and it is the reason the transient must not use a linear ramp.
 */
function transientProgress(u) {
  const x = Math.max(0, Math.min(1, u));
  const denom = 1 - Math.exp(-TRANSIENT_K);      // > 0
  return (1 - Math.exp(-TRANSIENT_K * x)) / denom;
}

/** Normalized net flow rate, 1 at the start of stage C → 0 at equilibrium. */
function transientFlux(u) {
  const x = Math.max(0, Math.min(1, u));
  return Math.exp(-TRANSIENT_K * x);
}

/**
 * Fraction of the TOTAL charge that has moved by time t.
 * 0 in A → FRAC_AT_TOUCH in B → 1 in C → 1 in D.
 */
export function chargeFraction(t) {
  const st = stageAt(t);
  switch (st.key) {
    case 'separated':   return 0;
    case 'contact':     return FRAC_AT_TOUCH * easeInOut(st.u);
    case 'transient':   return FRAC_AT_TOUCH + (1 - FRAC_AT_TOUCH) * transientProgress(st.u);
    case 'equilibrium': return 1;
    default:            return 0;
  }
}


/* =====================================================
   2.  ENERGY LEVELS (reused from BANDMODEL, animated)
   ===================================================== */

/**
 * Energies for time t, all referenced to the common vacuum level E_vac = 0.
 *
 * The metal pins E_F at −Φ_m for the entire animation (it has a continuum of
 * states; the semiconductor's finite DOS is what moves). So the SEMICONDUCTOR
 * Fermi level slides down to meet it, and the leftover gap is the driving force:
 *
 *     E_F^semi(t) = −Φ_m + ΔE_F(t),   ΔE_F(t) = V_bi · (1 − f(t))
 *
 * At f=0 that is exactly the pre-contact value (E_F^semi = E_C,bulk − ΔE);
 * at f=1 the two levels coincide. The band edges bend by q·V_bi·f.
 */
export function levels(p, t) {
  const q = BANDMODEL.model(p);                 // shared source of truth
  const f = chargeFraction(t);
  const Ef_m = q.levels.Ef_m;                   // −Φ_m, fixed
  const Ec_interface = q.levels.Ec_s;           // −χ, pinned by vacuum continuity
  const dEf = q.barrier.Vbi * (1 - f);          // leftover driving force
  const Ef_semi = Ef_m + dEf;
  /* E_C sits ABOVE E_F by the doping offset ΔE, so Ec = Ef + ΔE. (The sign
     here is load-bearing: with the inverted form the whole band diagram sits
     2ΔE = 0.30 eV too low and the interface misses −χ_s entirely.) */
  const Ec_bulk = Ef_semi + p.dE_s;             // bulk keeps its doping offset ΔE
  return {
    Ef_m, Ec_interface, Ec_bulk, Ef_semi,
    Ec_bulk_eq: Ef_m + p.dE_s,                  // equilibrium bulk edge (constant)
    dEf,                                        // ΔE_F(t)
    Vbi: q.barrier.Vbi,
    Phi_B: q.barrier.Phi_B,
    kT: BANDMODEL.THERMAL_V(p.T),
    frac: f,
  };
}

/* =====================================================
   3.  CHARGE TRANSFER  (the heart of the animation)
   ===================================================== */

/**
 * How much charge has moved, and what the diagram shows as a result.
 *
 * Everything follows from f, and everything scales as sqrt(f) except the
 * driving force, which scales as (1 − f). At f = 1 the whole set is exactly the
 * equilibrium values that BANDMODEL.depletion() already computes, which is
 * asserted in flow-physics-check.js.
 *
 * @returns {{
 *   f:number,            transferred fraction, 0..1
 *   W:number,            depletion width [m]
 *   Emax:number,         peak field at the interface [V/m]
 *   Q:number,            charge moved [C/m²]
 *   sheet:number,        electrons moved [per m²]
 *   dEf:number,          remaining Fermi offset [eV]
 *   netFlux:number,      normalized net flow rate, 1 at touch → 0 at equilibrium
 *   direction:number,    +1 semi→metal, −1 metal→semi, 0 balanced
 * }}
 */
export function chargeTransfer(p, t) {
  const st = stageAt(t);
  const f = chargeFraction(t);
  const eq = BANDMODEL.depletion(p);            // W_eq, E_max_eq
  const Vbi = BANDMODEL.barrierHeight(p).Vbi;
  const ND_m3 = p.N_d * 1e6;                    // cm⁻³ → m⁻³

  const root = Math.sqrt(Math.max(f, 0));
  const W = eq.W * root;
  const sheet = ND_m3 * W;                      // charge neutrality
  const Q = BANDMODEL.E_CHARGE * sheet;
  const Emax = eq.Emax * root;                  // E_max ∝ W

  // Net flow only exists while there is a driving force to spend.
  const netFlux = st.key === 'transient' ? transientFlux(st.u)
                 : st.key === 'contact'   ? 0.25 * (1 - st.u) * transientFlux(0)
                 : 0;
  const direction = netFlux > 1e-6 ? 1 : 0;    // always semi→metal for n-type + high-Φ_m

  return { f, W, Emax, Q, sheet, dEf: Vbi * (1 - f), netFlux, direction };
}

/* =====================================================
   4.  BAND PROFILE  (spatial shape of the bend)
   ===================================================== */
/* =====================================================
   4.  BAND PROFILE  (spatial shape of the bend)
   ===================================================== */

/** ε of the semiconductor — mirrors the constant BANDMODEL uses internally so
 *  there is still only one source of truth for the material. */
export const EPS_REL = 7.0;                     // MoS2
const EPS0 = 8.854187817e-12;                   // F/m
export const EPS = EPS0 * EPS_REL;

/**
 * Conduction/valence band edges at distance `dist` from the junction, measured
 * INTO the semiconductor and normalized by the equilibrium depletion width
 * (dist = 1 → W_eq).
 *
 * The bend is the depletion-approximation potential for uniform ionized donors:
 *
 *     V(x) = q N_D (W − x)² / (2 ε)
 *     E_C(x) = E_C,bulk + q V(x)
 *
 * zero at the depletion edge, rising to q·V_bi·f at the interface. Because
 * W(f) = W_eq√f, the amplitude comes out at exactly f·V_bi, so the profile stays
 * self-consistent for every intermediate f and is continuous as W grows.
 *
 * @param {number} dist 0..1 (0 = interface). Values > 1 land in the flat bulk.
 */
export function bandEnergyAt(dist, p, t) {
  const lv = levels(p, t);
  const ct = chargeTransfer(p, t);
  const x = Math.max(0, Number(dist) || 0) * ct.W;     // metres from interface
  const inDep = ct.W > 0 && x < ct.W;

  /* Clamp x to the depletion region. Beyond the edge (W − x) goes NEGATIVE and
     squaring it would bend the band back UPWARDS outside the depletion zone —
     an unphysical bump that also made the "bulk is flat" assertion fail. */
  const xc = ct.W > 0 ? Math.min(x, ct.W) : 0;

  // Factoured so that f = 0 (W = 0) gives exactly 0, with no 0/0 and no
  // division by a quantity that vanishes mid-animation.
  const ND_m3 = p.N_d * 1e6;
  const V = ct.W > 0 ? (BANDMODEL.E_CHARGE * ND_m3 * Math.pow(ct.W - xc, 2)) / (2 * EPS) : 0;
  const bend = Math.min(V, lv.Vbi * ct.f);             // never overshoot f·V_bi

  const Ec = lv.Ec_bulk + bend;
  const Ev = Ec - p.Eg_s;
  return { Ec, Ev, bend, inDepletion: inDep, Vbi: lv.Vbi, frac: ct.f };
}

/**
 * Sampled band profile for plotting, from the interface out to `maxDist`
 * (default 1.6 → a little past the depletion edge so the flat bulk shows).
 * @returns {{dist:number,Ec:number,Ev:number,n:number,inDepletion:boolean}[]}
 *   `n` is the conduction-band electron density normalized to its BULK value
 *   (Boltzmann tail), so the depletion dip at the interface is visible.
 */
export function bandProfile(p, t, samples = 160, maxDist = 1.6) {
  const lv = levels(p, t);
  const nBulk = Math.exp(-(lv.Ec_bulk_eq - lv.Ef_m) / lv.kT);
  const out = [];
  for (let i = 0; i <= samples; i++) {
    const dist = (i / samples) * maxDist;
    const b = bandEnergyAt(dist, p, t);
    const nB = Math.exp(-(b.Ec - lv.Ef_m) / lv.kT);
    out.push({
      dist, Ec: b.Ec, Ev: b.Ev, inDepletion: b.inDepletion,
      n: nBulk > 0 ? Math.max(0, Math.min(1, nB / nBulk)) : 0,
    });
  }
  return out;
}

/* =====================================================
   5.  FLUX BALANCE  (equilibrium is net-zero)
   ===================================================== */

/**
 * Normalized (arbitrary-unit) magnitude of the two-way thermal exchange at
 * equilibrium. The absolute rate is enormous and deliberately NOT claimed to be
 * physical here; only the RATIO forward : reverse is asserted by the tests.
 */
export const EXCHANGE_RATE = 1;

/**
 * Electron flux across the junction.
 *
 * @returns {{
 *   forward:number,  semi → metal
 *   reverse:number,  metal → semi
 *   net:number,      forward − reverse
 *   direction:number,+1 / 0 / −1
 *   balanced:boolean,
 *   barrier_kT:number,
 *   note:string,
 * }}
 *
 * During the transient there IS a net one-way flow (forward only). At
 * equilibrium the two fluxes are equal: electrons keep crossing, but in both
 * directions, so `net` is exactly 0. This is the correction the reference image
 * needs — it draws one-way arrows at what it labels equilibrium.
 */
export function fluxBalance(p, t) {
  const st = stageAt(t);
  const ct = chargeTransfer(p, t);
  const PhiB = BANDMODEL.barrierHeight(p).Phi_B;
  const kT = BANDMODEL.THERMAL_V(p.T);

  let forward = 0, reverse = 0;
  let note = 'No contact — the surfaces are apart, so no charge can cross.';

  if (st.key === 'contact') {
    forward = 0.25 * (1 - st.u);
    note = 'First electrons are crossing. The barrier is only just being surmounted.';
  } else if (st.key === 'transient') {
    forward = ct.netFlux;
    note = 'Net flow semiconductor → metal. The Fermi offset ΔE_F is being spent.';
  } else if (st.key === 'equilibrium') {
    forward = EXCHANGE_RATE;
    reverse = EXCHANGE_RATE;
    note = 'Two-way exchange continues, but the fluxes balance: net current = 0.';
  }

  const net = forward - reverse;
  return {
    forward, reverse, net,
    direction: Math.abs(net) < 1e-9 ? 0 : Math.sign(net),
    balanced: Math.abs(net) < 1e-9,
    // Why the flow stops: the barrier is n kT tall, so metal electrons are
    // exponentially unlikely to escape back over it.
    barrier_kT: kT > 0 ? PhiB / kT : 0,
    note,
  };
}

/* =====================================================
   6.  OCCUPANCY  (how hard it is to get over the barrier)
   ===================================================== */

/**
 * Numbers that make the barrier legible in kT units.
 *  - `metalAbove`: metal electrons energetic enough to reach E_C(interface).
 *    Tiny — the barrier is ~31 kT, so the metal cannot feed the current.
 *  - `semiAtEc`: conduction-band-edge occupancy that DOES supply the flow.
 */
export function barrierOccupancy(p) {
  const q = BANDMODEL.model(p);
  const kT = q.kT;
  const lv = levels(p, 1);                        // equilibrium levels
  return {
    Phi_B: q.barrier.Phi_B,
    barrier_kT: kT > 0 ? q.barrier.Phi_B / kT : 0,
    dE_kT: kT > 0 ? p.dE_s / kT : 0,
    metalAbove: BANDMODEL.fermiDirac(lv.Ec_interface, lv.Ef_m, p.T),
    semiAtEc: BANDMODEL.fermiDirac(lv.Ec_bulk_eq, lv.Ef_m, p.T),
  };
}

/* =====================================================
   7.  TIME SCALES  (stated in the UI, never hidden)
   ===================================================== */

const M_E = 9.1093837015e-31;                    // kg
const K_B_J = 1.380649e-23;                      // J/K

/**
 * Real crossing time and the slow-motion factor the animation runs at.
 *
 * The UI must show this. A viewer who watches electrons dawdle across the
 * junction for a second would otherwise conclude the physics is slow. It is not:
 * they cross in ~1 ps, so the animation is slowed by roughly 1e12×.
 */
export function timeScales(p) {
  const eq = BANDMODEL.depletion(p);
  const vTh = Math.sqrt((K_B_J * p.T) / M_E);     // m/s
  const transit = eq.W / vTh;                    // s
  return {
    vTh,                                          // m/s
    transit_s: transit,
    transit_ps: transit * 1e12,
    slowMotion: transit > 0 ? 1 / transit : 0,    // × to make it 1 s on screen
  };
}

/* =====================================================
   8.  FULL SNAPSHOT  (one call per frame)
   ===================================================== */

export function flowModel(p, t) {
  const tt = clampT(t);
  return {
    params: p,
    t: tt,
    stage: stageAt(tt),
    levels: levels(p, tt),
    charge: chargeTransfer(p, tt),
    flux: fluxBalance(p, tt),
    occupancy: barrierOccupancy(p),
    time: timeScales(p),
    profile: bandProfile(p, tt),
  };
}

export { BANDMODEL };
