/**
 * labels.js
 * User-facing strings and formatting helpers for the Au | MoS₂ contact demo.
 * Keep render.js and main.js sharing the same wording here.
 */
'use strict';

const LABELS = Object.freeze({

  /* Page + panel titles */
  title: 'Au | MoS₂ Schottky Contact — Band Alignment',
  subtitle: '2H semiconducting phase · ideal n-type contact · Φ_B = Φ_m − χ_s',

  panelPlot: 'Band alignment (energy vs. position)',
  panelGraph: 'I–V characteristic (thermionic emission)',

  /* Slider definitions (mirrored in main.js) — `tex` is the KaTeX form rendered
     into the <label> by main.js; `label` stays the plain-text fallback/aria text */
  sliders: [
    { key: 'phi_m', label: 'Metal work function Φ_m', tex: '\\text{Metal work function }\\Phi_m', unit: 'eV', min: 3.5, max: 6.0, step: 0.01, default: 5.10 },
    { key: 'chi_s', label: 'Electron affinity χ_s',   tex: '\\text{Electron affinity }\\chi_s',   unit: 'eV', min: 3.6, max: 4.8, step: 0.01, default: 4.30 },
    { key: 'Eg_s',  label: 'MoS₂ band gap E_g',       tex: '\\text{MoS}_2\\text{ band gap }E_g',       unit: 'eV', min: 0.3, max: 2.5, step: 0.01, default: 1.80 },
    { key: 'dE_s',  label: 'Doping E_F − E_C',        tex: '\\text{Doping }E_F - E_C',        unit: 'eV', min: 0.0, max: 0.8, step: 0.01, default: 0.15 },
    { key: 'T',     label: 'Temperature T',           tex: '\\text{Temperature }T',           unit: 'K',  min: 10,  max: 800, step: 1,   default: 300 },
    { key: 'bias',  label: 'Applied bias V',          tex: '\\text{Applied bias }V',          unit: 'V',  min: -1.5, max: 1.5, step: 0.01, default: 0.00 },
  ],

  /* Arrow / legend labels — `md` is the markdown+LaTeX form rendered into the
     legend chips (math.js mdHTML); `label` stays the plain-text fallback */
  arrows: {
    phi_m:    { label: 'Φ_m = metal work function', short: 'Φ_m', md: '$\\Phi_m$ = metal work function' },
    chi_s:    { label: 'χ_s = electron affinity',   short: 'χ_s', md: '$\\chi_s$ = electron affinity' },
    dE:       { label: 'E_F − E_C (doping)',         short: 'ΔE',  md: '$E_F - E_C$ (doping)' },
    barrier:  { label: 'Φ_B = Φ_m − χ_s (barrier)', short: 'Φ_B', md: '$\\Phi_B = \\Phi_m - \\chi_s$ (barrier)' },
    vbi:      { label: 'Built-in potential V_bi',   short: 'V_bi', md: 'Built-in potential $V_{bi}$' },
    eg:       { label: 'Band gap E_g',               short: 'E_g', md: 'Band gap $E_g$' },
    efsep:    { label: 'Fermi offset before contact', short: 'ΔE_F', md: 'Fermi offset $\\Delta E_F$ (before contact)' },
    vacuum:   { label: 'vacuum level',               short: '',    md: 'vacuum level $E_{vac}$' },
  },

  tip: "Click any numbered arrow on the band diagram for the formula and value.",

  /* Toggle */
  moS2Form: {
    mono: 'MoS₂ (monolayer, E_g = 1.8 eV, direct)',
    bulk: 'MoS₂ (bulk flake, E_g = 1.3 eV, indirect)',
  },

  /* Presets shown in the UI */
  presets: [
    'Au / MoS₂ (default)',
    'Au / MoS₂ (bulk)',
    'Mg / MoS₂ (ohmic demo)',
    'Lower Φ metal / MoS₂',
  ],
});

/* ---------- formatting helpers ---------- */
function fmt(v) {
  if (v === undefined || v === null) return '—';
  const n = Number(v);
  if (n === 0) return '0.000';
  if (!isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toExponential(3);
  if (Math.abs(n) >= 10) return n.toFixed(3);
  if (Math.abs(n) >= 1) return n.toFixed(3);
  if (Math.abs(n) >= 0.01) return n.toFixed(4);
  return n.toExponential(3);
}
function fmtSI(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(n);
  if (n === 0) return '0';
  const mag = Math.floor(Math.log10(Math.abs(n)));
  if (mag >= 3)  return (n / Math.pow(10, mag)).toFixed(2) + '×10^' + mag;
  if (mag <= -3) return (n * Math.pow(10, -mag)).toFixed(2) + '×10^' + mag;
  return n.toFixed(3);
}

export { LABELS, fmt, fmtSI };
