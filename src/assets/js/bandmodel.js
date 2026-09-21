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
