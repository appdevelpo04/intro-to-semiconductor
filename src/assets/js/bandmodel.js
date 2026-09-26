/**
 * bandmodel.js
 * Pure physics layer for the Au | MoS₂ Schottky contact.
 * All energies in eV, referenced to the common vacuum level E_vac = 0.
 * Functions take a params object and return derived quantities.
 * No drawing here — that belongs in render.js.
 */

'use strict';

/* ---------- Physical constants ---------- */
const BANDMODEL = (() => {
  const E_CHARGE = 1.602176634e-19;          // C
  const EV_TO_J = 1.602176634e-19;           // J/eV
  const KB_J = 1.380649e-23;                 // J/K
  const KB_EV = KB_J / EV_TO_J;              // eV/K  ≈ 8.61733e-5
  const EPS0 = 8.854187817e-12;              // F/m
  const EPS_REL_SI = 7.0;                    // MoS₂ static dielectric constant (approx)
  const EPS = EPS0 * EPS_REL_SI;
  const Q = E_CHARGE;
  /* local thermal-voltage helper (also exposed on the public object) */
  const THERMAL_V = (T) => KB_EV * T;

  /* Schottky I–V prefactor (Richardson constant) for MoS₂.
     A* = 8.7e5 A·m⁻²·K⁻² is the value often quoted for MoS₂.
     Area is an abstract "presentation area" so the I–V curve looks reasonable. */
  const RICHARDSON_A_STAR = 8.7e5;           // A·m⁻²·K⁻²

  /* ---------- Parameter defaults (Au | 2H-MoS₂ monolayer) ---------- */
  const DEFAULTS = {
    phi_m: 5.10,          // Au work function [eV]
    chi_s: 4.30,          // MoS₂ electron affinity [eV]
    Eg_s: 1.80,           // MoS₂ band gap [eV] (monolayer, direct)
    dE_s: 0.15,           // E_F − E_C for n-type MoS₂ [eV]
    T: 300,               // temperature [K]
    bias: 0.0,            // applied forward bias (metal positive wrt semiconductor) [V]
    area: 1e-8,           // chosen contact area [m²] (presentation scale)
    N_d: 5e16,            // n-type doping [cm⁻³] → used by depletion width calc
  };

  /* ---------- 1. Energy levels (all referenced to common vacuum E_vac = 0) ---------- */
  function levels(p) {
    const Ef_m = -p.phi_m;              // metal Fermi level vs vacuum
    const Ec_s = -p.chi_s;              // semiconductor conduction-band edge vs vacuum
    const Ev_s = Ec_s - p.Eg_s;         // valence-band edge vs vacuum
    const Ef_s = Ec_s - p.dE_s;         // semiconductor Fermi level (n-type default)
    return { Ef_m, Ec_s, Ev_s, Ef_s };
  }

  /* ---------- 2. Barrier height & contact type ---------- */
  function barrierHeight(p) {
    const { phi_m, chi_s, dE_s } = p;
    const Phi_B = phi_m - chi_s;        // n-type ideal Schottky barrier [eV]
    const Vbi = (Phi_B - dE_s);         // built-in potential [V]; in eV form q cancels
    const isRectifying = Phi_B > 1e-3;
    return { Phi_B, Vbi, isRectifying, contactType: isRectifying ? 'rectifying' : 'ohmic (ideal)' };
  }

  /* ---------- 3. Band bending & depletion (1-D, abrupt junction) ---------- */
  function depletion(p) {
    const bh = barrierHeight(p);
    const N_d_m3 = p.N_d * 1e6;         // cm⁻³ → m⁻³
    const Vbi_eff = Math.max(bh.Vbi, 0.01);
    let W = 0;
    if (N_d_m3 > 0) {
      // W = sqrt( 2*eps*(Vbi - V_applied) / (q*N_d) )
      const Veff = Math.max(Vbi_eff - p.bias, 1e-3);
      W = Math.sqrt(2 * EPS * Veff / (Q * N_d_m3));
    }
    // Uniform doping → electric field at interface E_max = q*N_d*W/eps
    const Emax = (N_d_m3 > 0) ? (Q * N_d_m3 * W / EPS) : 0;
    return { W, Emax, Vbi: Vbi_eff };
  }

  /* ---------- 4. Fermi–Dirac occupation ---------- */
  function fermiDirac(E, Ef, T) {
    const kT = THERMAL_V(T);
    if (kT < 1e-9) return E < Ef ? 1 : (E === Ef ? 0.5 : 0);
    const x = (E - Ef) / kT;
    if (x > 100) return 0;
    if (x < -100) return 1;
    return 1 / (1 + Math.exp(x));
  }

  /* Boltzmann tail in the conduction band — used for the distribution inset */
  function cbElectronDensity(E, Ec, Ef, T) {
    const kT = THERMAL_V(T);
    if (E < Ec) return 0;
    return Math.exp(-(E - Ef) / kT);
  }

  /* ---------- 4b. INVERSE-CDF SAMPLERS — where a DRAWN electron sits ----------
     Both exist because a particle animation picks a random number and maps it
     to a pixel. If that number is uniform and the mapping is a straight line,
     the picture claims electrons are uniform in energy, which is false: the
     whole point of a Fermi level is that occupation is NOT uniform.

     So each sampler is the exact inverse CDF of the physical distribution, and
     `cbElectronDensity`/`fermiDirac` above are the densities being sampled.
     Given a uniform u, they return the energy at which an electron would sit
     with probability u. These are the only two places the drawn dots are
     allowed to get an energy from.

     MODELLING ASSUMPTIONS (both deliberate, both stated rather than hidden):
       1. Semiconductor: cbElectronDensity() is a pure Boltzmann factor with no
          √(E−E_C) density-of-states term. The samplers match it exactly, so the
          curve and the dots can never disagree. Adding √E would be more exact
          for bulk 3D and would make the drawn dots disagree with the one
          documented density function in this codebase.
       2. Metal: a constant DOS over a finite window around E_F. Real metals have
          DOS ∝ √E, but near E_F it is smooth enough that constant is the
          standard local approximation, and the window is only ±windowKt·kT wide
          anyway — the filled sea continues below it and is not what is being
          argued about. */

  /* Tails are clamped so one lucky u cannot throw a shell off the top of the
     panel. 8 kT still covers 1 − e⁻⁸ = 99.966% of the Boltzmann distribution,
     so the clamp is a rendering guard, not a distortion. */
  const TAIL_MAX_KT = 8;

  /**
   * Semiconductor conduction-band electron energy: the Boltzmann tail, E ≥ E_C.
   *
   * With x = (E − E_C)/kT the density ∝ e^{−(E−E_F)/kT} = e^{(E_C−E_F)/kT}·e^{−x},
   * so the E_F dependence cancels and the CDF is exactly 1 − e^{−x}. Inverting:
   *
   *     x = −ln(1 − u)      E = E_C + kT·min(x, TAIL_MAX_KT)
   *
   * The E_C term is what makes this safe: **the result can never be below
   * E_C**, i.e. never inside the band gap, where no conduction-band states
   * exist. That is precisely the defect this replaces.
   *
   * @param {number} u     uniform in [0,1)
   * @param {number} Ec    local conduction-band edge (eV)
   * @param {number} T     temperature (K)
   * @param {number} [maxKt] clamp the tail at this many kT
   * @returns {number} energy ≥ Ec (eV)
   */
  function sampleTailEnergy(u, Ec, T, maxKt = TAIL_MAX_KT) {
    const kT = THERMAL_V(T);
    const uu = Math.min(Math.max(u, 0), 1 - 1e-12);
    const x = -Math.log(1 - uu);
    return Ec + kT * Math.min(x, maxKt);
  }

  /**
   * Metal electron energy near E_F: Fermi–Dirac occupancy, constant DOS.
   *
   * Over [Ef − maxKt·kT, Ef + maxKt·kT] with a constant DOS the density is just
   * f(E) = 1/(1 + e^{x}), x = (E − E_F)/kT. Its antiderivative is closed form
   * and needs no table:
   *
   *     A(x) = −ln(1 + e^{−x}),      ∫_{−a}^{a} f dx = a
   *
   * so with y = u·a the inverse is x = −ln( e^{−y} + e^{a−y} − 1 ).
   * Checks: u → 0 gives x → −a, u → 1 gives x → +a, and u = 0.5 gives
   * x ≈ −2.95 kT for a = 6 — i.e. the MEDIAN electron sits well BELOW E_F,
   * which is the whole meaning of an occupied sea. A uniform sampler would put
   * the median on the line; that is the statistical error this removes.
   *
   * @param {number} u      uniform in [0,1)
   * @param {number} Ef     Fermi level (eV)
   * @param {number} T      temperature (K)
   * @param {number} [maxKt] half-width of the drawn window, in kT
   * @returns {number} energy within [Ef − maxKt·kT, Ef + maxKt·kT] (eV)
   */
  function sampleFermiEnergy(u, Ef, T, maxKt = 6) {
    const kT = THERMAL_V(T);
    const uu = Math.min(Math.max(u, 0), 1 - 1e-12);
    const a = maxKt;
    const y = uu * a;
    /* arg = e^{−y} + e^{a−y} − 1  (algebraically (1+e^a)e^{−y} − 1, rearranged
       so the u→1 case keeps the small e^{−a} term instead of cancelling it). */
    const arg = Math.exp(-y) + Math.exp(a - y) - 1;
    const x = -Math.log(Math.max(arg, 1e-12));
    return Ef + kT * Math.min(Math.max(x, -a), a);
  }

  /**
   * Fraction of the drawn metal window that lies ABOVE E_F, weighted by f(E).
   *
   * Used to decide how many shells to put above the Fermi line in the packed
   * zoom grid. Both integrals are the closed form above, so the drawn split is
   * the real Fermi weight over the real window rather than a number someone
   * eyeballed:
   *
   *     P(above) = [A(xTop) − A(0)] / [A(xTop) − A(xBot)]
   *
   * @param {number} xBot lower edge of the window, in kT relative to E_F
   * @param {number} xTop upper edge of the window, in kT relative to E_F
   * @returns {number} probability mass above E_F, in (0,1)
   */
  function fermiWeightAbove(xBot, xTop) {
    const A = (x) => -Math.log1p(Math.exp(-x));     // antiderivative of f
    const lo = Math.min(xBot, xTop), hi = Math.max(xBot, xTop);
    const total = A(hi) - A(lo);
    if (!(total > 0)) return 0;
    return Math.min(1, Math.max(0, (A(hi) - A(0)) / total));
  }

  /* ---------- 5. Thermionic emission I–V (ideal Schottky diode) ---------- */
  function schottkyCurrent(p) {
    const bh = barrierHeight(p);
    const Phi_B = bh.Phi_B;
    const T = p.T;
    const area = p.area;
    const V = p.bias;
    const kT = THERMAL_V(T);
    // I_s = A* A T^2 exp(-q*Phi_B / kT)
    const Is = RICHARDSON_A_STAR * area * T * T * Math.exp(-Phi_B / kT);
    const Veff = Math.max(V, 0);       // forward bias lowers barrier
    const I_fwd = Is * Math.exp(Veff / kT);
    const I_rev = Is;                  // reverse saturation (ideal, no leakage)
    return { Is, I_fwd, I_rev, kT };
  }

  /* ---------- 6. Full model snapshot (single call for rendering) ---------- */
  function model(p) {
    const lvl = levels(p);
    const bh = barrierHeight(p);
    const dep = depletion(p);
    const iv = schottkyCurrent(p);
    const kT = THERMAL_V(p.T);
    return {
      params: p,
      levels: lvl,
      barrier: bh,
      depletion: dep,
      IV: iv,
      kT,
      // energy of the interface conduction-band corner (depletion-side edge),
      // i.e. where the band starts to bend upwards at x=0+
      E_interface: Math.max(lvl.Ec_s, lvl.Ec_s + bh.Phi_B - bh.Vbi),
    };
  }

  return {
    DEFAULTS,
    THERMAL_V: T => KB_EV * T,
    KB_EV,
    E_CHARGE,
    model,
    levels,
    barrierHeight,
    depletion,
    fermiDirac,
    cbElectronDensity,
    sampleTailEnergy,
    sampleFermiEnergy,
    fermiWeightAbove,
    TAIL_MAX_KT,
    schottkyCurrent,
    RICHARDSON_A_STAR,
  };
})();

/* ---------- Preset comparisons (Phase 2-ready; exposed for UI) ---------- */
const PRESETS = {
  'Au / MoS2 (default)': { phi_m: 5.10, chi_s: 4.30, Eg_s: 1.80, dE_s: 0.15, T: 300, bias: 0, area: 1e-8, N_d: 5e16 },
  'Au / MoS2 (bulk, indirect)': { phi_m: 5.10, chi_s: 4.30, Eg_s: 1.30, dE_s: 0.15, T: 300, bias: 0, area: 1e-8, N_d: 5e16 },
  'Mg / MoS2 (ohmic demo)': { phi_m: 3.70, chi_s: 4.30, Eg_s: 1.80, dE_s: 0.15, T: 300, bias: 0, area: 1e-8, N_d: 5e16 },
  'Low-Φ metal / MoS2': { phi_m: 4.50, chi_s: 4.30, Eg_s: 1.80, dE_s: 0.15, T: 300, bias: 0, area: 1e-8, N_d: 5e16 },
};

export { BANDMODEL, PRESETS };
