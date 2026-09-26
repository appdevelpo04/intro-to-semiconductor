/**
 * flow-particles.js — the electrons themselves.
 *
 * Kinematics only: where each drawn dot is, and which side of the junction it
 * is on. No physics constants, no canvas, no DOM — so `flow-sim-check.js` can
 * run the exact code the browser runs, in plain Node.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * A particle animation is the easiest place in this project to ship a lie. You
 * can draw a lovely stream of dots crossing the junction and have the total
 * charge be pure decoration. So the dots here are BOOKKEEPED:
 *
 *   • every dot is tagged `side` (+1 metal, −1 semiconductor)
 *   • the population obeys the model's transferred sheet density exactly
 *   • a dot that crosses is retagged, never created or destroyed
 *   • netCross = metalCount − semiCount is the observable the tests assert
 *
 * DETERMINISM. Every random number comes from an explicit seeded PRNG
 * (mulberry32), never Math.random(). Two consequences the test suite depends on:
 *   1. the same seed replays the same animation, so render frames are
 *      byte-reproducible and pixel-diff assertions are stable;
 *   2. a flaky-looking failure is always a real regression, never noise.
 * The seed lives in the state object, so reset() with the same seed is a true
 * rewind.
 */
'use strict';

import { chargeFraction, clampT } from './flow-model.js';

/* =====================================================
   1.  SEEDED PRNG  (mulberry32)
   ===================================================== */

/**
 * @param {number} seed uint32
 * @returns {() => number} uniform in [0,1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Side tags. Metal is +1, semiconductor −1, so `netCross` is a plain sum. */
export const SIDE_METAL = 1;
export const SIDE_SEMI = -1;

/* =====================================================
   2.  STATE
   ===================================================== */

/**
 * Create a particle system.
 *
 * @param {object} p  BANDMODEL-style params (needs N_d, T, phi_m, chi_s, …)
 * @param {object} [opts]
 * @param {number} [opts.count=64]      drawn dots
 * @param {number} [opts.seed=20260926] PRNG seed
 * @returns {object} state — pass to advance()/syncTo()
 */
export function createState(p, opts = {}) {
  const count = Math.max(8, Math.floor(opts.count ?? 64));
  const seed = (opts.seed ?? 20260926) >>> 0;
  const s = {
    params: p,
    count,
    seed,
    rand: mulberry32(seed),
    step: 0,                 // integer tick — for the frame counter only
    tPrev: 0,                // last model time, so advance() can measure dt
    /* Per-dot state. `u` is position along its own side, 0 = junction, 1 = far
       edge; `side` is where it currently lives; `q` is this electron's ENERGY
       QUANTILE — a uniform draw that the renderer maps through the real
       inverse CDF (BANDMODEL.sampleTailEnergy for the semiconductor,
       sampleFermiEnergy for the metal). Keeping `q` as a quantile rather than
       an absolute energy is what lets this file stay physics-free: the local
       band edges and kT only exist at draw time, and they change with t. */
    dots: [],
    /* Observables the tests read. */
    crossings: 0,            // total dots that have crossed, both directions
    netCross: 0,             // metal − semiconductor  (the signed net transfer)
    settled: 0,              // dots currently parked in the metal
  };
  for (let i = 0; i < count; i++) {
    s.dots.push({
      id: i,
      side: SIDE_SEMI,
      /* Start scattered through the semiconductor, biased away from the edge. */
      u: Math.pow(s.rand(), 0.6),
      v: s.rand(),            // positional jitter (scatter inside the metal)
      /* Energy quantile in [0,1). NOT cosmetic: the renderer turns this into a
         physical energy, so the drawn dots follow n(E) ∝ e^{−(E−E_F)/kT} in the
         semiconductor and f(E) in the metal instead of being smeared uniformly
         across the panel. Uniform here, physical there — that split is why the
         distribution can be corrected without touching the kinematics. */
      q: s.rand(),
      /* Motion bookkeeping. */
      moving: false,
      carry: 0,               // remaining crossing progress, in t-units
      from: SIDE_SEMI,
      jitter: 0.3 + 0.7 * s.rand(),
      lane: 0.5,              // y-lane inside the crossing band (see assignLanes)
    });
  }
  return s;
}

/** Rewind to the initial state; same seed → identical replay. */
export function reset(s, p) {
  const fresh = createState(p || s.params, { count: s.count, seed: s.seed });
  s.rand = fresh.rand;
  s.dots = fresh.dots;
  s.step = 0;
  s.tPrev = 0;
  s.crossings = 0;
  s.netCross = 0;
  s.settled = 0;
  return s;
}

/* =====================================================
   3.  THE MODEL-DRIVEN POPULATION
   ===================================================== */

/**
 * How many dots SHOULD be in the metal at time t.
 *
 * The transferred sheet density is N_D·W, and the number of dots standing in
 * for it is a fixed count, so the population the metal shows is simply
 * round(f · count) — the same f that drives the depletion width and the band
 * bend. That is what ties the particle picture to the band picture: they cannot
 * drift apart, because both read the same f.
 */
export function expectedMetalCount(s, t) {
  return Math.round(chargeFraction(t) * s.count);
}

/** Recompute the cached observables from the dots. */
export function recount(s) {
  let metal = 0;
  for (const d of s.dots) if (d.side === SIDE_METAL) metal++;
  s.settled = metal;
  s.netCross = metal * 2 - s.count;          // metal(+1) − semi(−1)
  return s;
}

/**
 * Reconcile dot positions with the model at time t WITHOUT animating anyone
 * across the junction.
 *
 * Used when the user scrubs: a scrub is a seek, so the population must jump to
 * the right value rather than animate there, and the crossing bookkeeping must
 * follow the model instead of inventing crossings the user never watched.
 *
 * Dots move by RE-TAGGING, never created or destroyed — total population is a
 * hard invariant the sim test checks.
 */
export function syncTo(s, t) {
  const want = expectedMetalCount(s, t);
  let metal = 0;
  for (const d of s.dots) if (d.side === SIDE_METAL) metal++;
  const delta = want - metal;
  /* Where a dot is PLACED when the population jumps.
     These used to be a literal `u = 0.02` for every moved dot, so a scrub put
     all 64 electrons at exactly one point — a single dense bar at the junction
     instead of a distribution. The advance() path scatters properly, which is
     why tick-driven tests never saw it; only a scrub (the live page) did.
     Use the same scatter the crossing path uses. */
  const place = (d) => { d.u = 0.02 + 0.98 * Math.pow(d.v, 1.8); };
  if (delta > 0) {
    /* Nearest-the-junction dots move first, so the interface looks right. */
    const movers = s.dots.filter((d) => d.side === SIDE_SEMI).sort((a, b) => b.u - a.u);
    for (let i = 0; i < delta && i < movers.length; i++) {
      movers[i].side = SIDE_METAL;
      place(movers[i]);
      movers[i].moving = false;
      movers[i].carry = 0;
    }
  } else if (delta < 0) {
    const movers = s.dots.filter((d) => d.side === SIDE_METAL).sort((a, b) => a.u - b.u);
    for (let i = 0; i < -delta && i < movers.length; i++) {
      movers[i].side = SIDE_SEMI;
      movers[i].u = 0.02;
      movers[i].moving = false;
      movers[i].carry = 0;
    }
  }
  /* The scrub IS the new timeline position — reset the dt reference so the
     next advance() measures one frame of motion, not the whole jump. */
  s.tPrev = clampT(t);
  return recount(s);
}

/**
 * Give the electrons currently crossing the junction distinct visual lanes.
 *
 * The request was for a BATCH that flows through "one by one". With every
 * crossing electron on the same y it read as a smear: several shells overlapped
 * and the viewer could not count them, which is the opposite of the point.
 * Each in-flight electron therefore gets a different y-lane, ordered by how far
 * along its journey it is — so the queue is a legible, countable stream rather
 * than a blob.
 *
 * Lanes are recomputed only when the set of crossing electrons changes, so a
 * shell does not flicker between positions frame to frame.
 */
function assignLanes(s) {
  const crossing = s.dots
    .filter((d) => d.moving)
    .sort((a, b) => a.carry - b.carry);          // most advanced first
  const n = crossing.length;
  crossing.forEach((d, i) => {
    /* Spread evenly over the band; n===0 cannot happen here. */
    d.lane = n <= 1 ? 0.5 : (i + 0.5) / n;
  });
}

/* =====================================================
   4.  ADVANCE  (the animation step)
   ===================================================== */

/* How long a dot spends mid-junction, as a FRACTION OF THE TIMELINE (not a
   number of ticks). Frame-rate invariance is the whole point:

     throughput per tick  =  MAX_IN_FLIGHT / (CROSS_T_FRAC · n_ticks)
     crossings available  =  that × (transient fraction · n_ticks)
                          =  MAX_IN_FLIGHT · 0.4 / CROSS_T_FRAC      (t-independent)

   With a tick-based duration the available crossings scaled with 1/frame-rate,
   so a slow machine simply never finished the transfer (27 of 64 dots had
   arrived by t=1 at 60 ticks). Measuring progress in t makes the arithmetic
   above constant, and the model is honoured at any frame rate.

   0.03 × an 8 s timeline ≈ 0.24 s per crossing at 60 fps — long enough to
   read as a crossing, short enough to keep the junction from clogging. */
const CROSS_T_FRAC = 0.03;

/* Cap on dots simultaneously mid-junction. Two jobs: it keeps the junction
   readable (a queue, not a crowd), and it bounds the visible lag between the
   picture and f(t) to at most this many dots. Sized so the capacity above
   (MAX_IN_FLIGHT · 0.4 / CROSS_T_FRAC) comfortably exceeds `count`. */
const MAX_IN_FLIGHT = 10;

/* Minimum t-progress a dot gets per tick, so a PAUSED timeline (t frozen) still
   drains its in-flight dots instead of freezing them mid-junction forever. */
const MIN_T_STEP = 0.002;

/**
 * Move every dot forward by one tick at model time `t`.
 *
 * Rate control: the number of NEW crossings started this tick is
 * round(expectedMetalCount(t) − metalCount), so the population tracks the model
 * exactly regardless of frame rate. If the model wants more electrons in the
 * metal, that many start crossing now; if fewer (scrubbing backwards), surplus
 * dots are sent home.
 *
 * @param {object} s       state from createState()
 * @param {number} t       model time 0..1
 * @param {object} [opts]
 * @param {number} [opts.thermal=1]  scale the idle jitter (0 = frozen dots)
 * @returns {object} s     (mutated, for chaining)
 */
export function advance(s, t, opts = {}) {
  const thermal = opts.thermal ?? 1;
  const tt = clampT(t);
  /* dt in TIMELINE units. A backwards scrub (dt < 0) is treated as no motion:
     the crossing is driven by syncTo(), not by integrating a negative step. */
  const rawDt = tt - s.tPrev;
  const dt = rawDt > 0 ? rawDt : 0;
  s.tPrev = tt;
  s.step++;

  const want = expectedMetalCount(s, tt);

  /* --- spawn / recall to match the model ------------------------------- */
  const metal = s.dots.filter((d) => d.side === SIDE_METAL).length;
  /* In-flight dots COUNT toward the target. Without this the deficit is
     overstated for the whole crossing, so a fresh batch spawns every tick: the
     population overshoots and the surplus piles up in flight. That showed up
     as a 38-dot disagreement between the picture and the model.

     The spawn is CAPPED at MAX_IN_FLIGHT so the junction stays readable; the
     t-based crossing duration (see CROSS_T_FRAC) guarantees the queue always
     drains well before equilibrium. */
  const inFlight = s.dots.filter((d) => d.moving && d.from === SIDE_SEMI).length;
  const room = Math.max(0, MAX_IN_FLIGHT - inFlight);
  const deficit = Math.min(want - metal - inFlight, room);
  if (deficit > 0) {
    /* WHO crosses, first: the HOTTEST electrons, not the nearest ones.
       `q` is the energy quantile and sampleTailEnergy() is monotone in it, so
       sorting by q descending picks the top of the Boltzmann tail — which is
       exactly what thermionic emission is, and what the reference figure's
       "Diffusion" box marks out at the TOP of the distribution rather than
       along the interface. The previous sort was by u (distance from the
       junction, farthest first), which made the crossing order a statement
       about geometry and said nothing about energy. The model still decides
       HOW MANY cross; this only decides WHICH. */
    const ready = s.dots.filter((d) => !d.moving && d.side === SIDE_SEMI)
      .sort((a, b) => b.q - a.q).slice(0, deficit);
    for (const d of ready) {
      d.moving = true;
      d.from = SIDE_SEMI;
      d.carry = CROSS_T_FRAC;      // t-units of journey remaining
      /* Snapshot the FULL journey so the renderer can recover progress =
         1 − carry/total. Without it, carry alone is a countdown whose scale is
         unknown per frame, and the crossing position has to be guessed from
         d.u — which is a position inside the ORIGIN side, not a fraction
         travelled, and is why crossings appeared to slide away from the
         junction instead of over it. */
      d.carryTotal = CROSS_T_FRAC;
    }
    /* RE-THERMALIZE the survivors. Emitting the hottest electrons is correct,
       but the ones left behind must NOT stay the cold leftovers: measured, the
       semiconductor band shrank from 12px to 2px by t=0.3 once the tail had
       gone, i.e. the cloud visibly cooled. Real scattering re-establishes the
       Boltzmann distribution in far less time than the transfer takes, so the
       population is re-sampled every time a batch departs and stays Boltzmann
       while its top is being removed. Without this the picture would show a
       distribution that no physical system would produce. */
    for (const d of s.dots) {
      if (!d.moving && d.side === SIDE_SEMI) d.q = s.rand();
    }
    /* Give the new arrivals distinct LANES (see the block below). */
    assignLanes(s);
  } else if (deficit < 0 && s.crossings === 0) {
    /* Scrubbing backwards with nothing in flight: send surplus home at once.
       Guarded by crossings === 0 so a dot is never yanked out mid-crossing,
       which would make the junction look like it flickers. */
    const surplus = s.dots.filter((d) => !d.moving && d.side === SIDE_METAL)
      .sort((a, b) => a.u - b.u).slice(0, -deficit);
    for (const d of surplus) {
      d.side = SIDE_SEMI;
      d.u = 0.02;
    }
  }

  /* --- integrate -------------------------------------------------------- */
  for (const d of s.dots) {
    if (d.moving) {
      /* Consume the journey in t-units, with a floor so a PAUSED timeline
         (dt = 0) still drains the queue instead of stranding dots forever. */
      d.carry -= Math.max(dt, MIN_T_STEP);
      const prog = 1 - d.carry / CROSS_T_FRAC;      // 0 at junction → 1 far side
      if (d.carry <= 0) {
        /* Arrived. Flip the side tag — the ONE place a dot changes allegiance,
           and exactly what netCross counts. */
        d.side = d.from === SIDE_SEMI ? SIDE_METAL : SIDE_SEMI;
        /* Scatter into the metal.
           The old form was `0.02 + 0.98 * v^0.7`, and v^0.7 biases HARD toward
           1 (v=0.5 → 0.61, v=0.9 → 0.93): combined with the idle drift below,
           38 of 64 electrons ended up inside the last 1/13 of the metal, all
           bunched at u≈0.997 — one dense dot in the corner instead of a
           distribution. An exponent ABOVE 1 is needed to push samples away
           from the far edge instead. */
        d.u = 0.02 + 0.98 * Math.pow(d.v, 1.8);
        /* THERMALIZE ON ARRIVAL. A dot crosses as a member of the high-energy
           tail — that is why it was selected — but carrying that q into the
           metal would load the metal with hot electrons forever: measured,
           17.2% landed above E_F against the 11.5% f(E) allows. In a real
           metal the arriving electron gives up its excess energy to the
           electron gas almost at once, so it re-enters the Fermi distribution.
           Re-drawing q here is that thermalization, and it is what makes the
           drawn metal population converge on f(E) instead of on the emitter's
           temperature. */
        d.q = s.rand();
        d.moving = false;
        d.carry = 0;
        s.crossings++;
      } else {
        d.u = Math.min(1, 0.02 + Math.max(0, prog) * 0.98);
      }
      continue;
    }
    /* Idle diffusion: a random walk in u with a small outward drift, reflected
       at both ends. Fully driven by the seeded PRNG, so replays are exact.
       The drift is now OUTWARD-symmetric (it used to always push +u, which
       swept the whole population toward the far edge over the 0.4-wide
       transient). */
    if (thermal > 0) {
      const stepAmt = (s.rand() - 0.5) * 0.06 * d.jitter * thermal;
      let u = d.u + stepAmt + 0.004 * (0.5 - d.u) * d.jitter * thermal;  // relax to centre
      if (u < 0) u = -u;                            // reflect at the junction
      if (u > 1) u = 1 - (u - 1);                   // reflect at the far edge
      d.u = Math.max(0, Math.min(1, u));
    }
  }
  return recount(s);
}

/* =====================================================
   5.  READOUTS
   ===================================================== */

/* Held by value so this module stays a pure kinematics file: it owns no
   physical constants — flow-model.js is the single source of those. */
const E_CHARGE = 1.602176634e-19;             // C

/**
 * Interpret the population back into physical units.
 *
 * The UI must show this. A viewer counting dots would otherwise think ~60
 * electrons moved, when the real figure is ~5×10^11 per cm². The dots are a
 * SAMPLING, and saying so is the difference between a demo and a lie.
 *
 * @param {object} s      particle state
 * @param {object} model  flowModel() snapshot (reads charge.sheet)
 */
export function dotScale(s, model) {
  const sheet = model.charge.sheet;            // electrons per m²
  const perDot_m2 = s.count > 0 ? sheet / s.count : 0;
  return {
    perDot_cm2: perDot_m2 / 1e4,               // per cm²
    perDot_m2,
    moved: s.settled,                           // dots currently in the metal
    /* Charge actually delivered, per cm², from the dot bookkeeping alone —
       this is the quantity the sim test checks against q·N_D·W. */
    movedC_cm2: s.settled * perDot_m2 / 1e4 * E_CHARGE,
  };
}

/**
 * Test / e2e hook: a detached snapshot of one completed frame's bookkeeping, so
 * automation can never observe a half-updated state.
 */
export function snapshot(s, t) {
  return {
    step: s.step,
    t,
    count: s.count,
    metal: s.dots.filter((d) => d.side === SIDE_METAL).length,
    semi: s.dots.filter((d) => d.side === SIDE_SEMI).length,
    inFlight: s.dots.filter((d) => d.moving).length,
    crossings: s.crossings,
    netCross: s.netCross,
  };
}
