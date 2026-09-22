/**
 * detail.js
 * Click-to-detail system for the band diagram arrows.
 * Exports open(id, model) and close().
 */

import { BANDMODEL } from './bandmodel.js';
import { mdHTML, texHTML } from './math.js';

const DOM = {
  panel: document.getElementById('detailPanel'),
  title: document.getElementById('detailTitle'),
  body: document.getElementById('detailBody'),
  close: document.getElementById('detailClose'),
};

let currentId = null;

export function open(id, model) {
  if (!DOM.panel || !DOM.title || !DOM.body) return;
  currentId = id;
  if (DOM.panel) {
    DOM.panel.style.left = '14px';
    DOM.panel.style.top = '12px';
  }
  const m = model || (window && window.__SCHOTTKY_MODEL);
  if (!m) {
    DOM.title.textContent = 'Parameter';
    DOM.body.textContent = 'No model data available yet.';
    DOM.panel.classList.add('visible');
    return;
  }
  DOM.title.textContent = arrowLabel(id);
  DOM.body.innerHTML = detailText(id, m);
  DOM.panel.classList.add('visible');
}

export function close() {
  if (!DOM.panel) return;
  DOM.panel.classList.remove('visible');
  currentId = null;
}

function arrowLabel(id) {
  const map = {
    phi_m: 'Metal work function Φ_m',
    chi_s: 'Electron affinity χ_s',
    dE: 'Doping ΔE = E_F − E_C',
    barrier: 'Schottky barrier Φ_B',
    vbi: 'Built-in potential V_bi',
    eg: 'Band gap E_g',
    efsep: 'Fermi-level offset (before contact)',
    bias: 'Applied bias V',
    vacuum: 'Vacuum level',
  };
  return map[id] || 'Parameter';
}

function e(v) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toExponential(3);
  if (Math.abs(n) >= 10) return n.toFixed(3);
  if (Math.abs(n) >= 1) return n.toFixed(3);
  if (Math.abs(n) >= 0.01) return n.toFixed(4);
  return n.toExponential(3);
}

function detailText(id, m) {
  const p = m.params, bh = m.barrier, lvl = m.levels, iv = m.IV, kT = m.kT;

  /* Sections are MARKDOWN with inline LaTeX ($…$ → KaTeX via math.js).
     The live numeric value leads each card inside .d-val. */
  const v = (s) => '<span class="d-val">' + s + '</span>';

  switch (id) {
    case 'phi_m': return v(texHTML('\\Phi_m = ' + e(p.phi_m) + '\\,\\mathrm{eV}')) + mdHTML(
      '$\\Phi_m$ — **metal work function**: energy to lift an electron from the metal Fermi level to vacuum.\n\n' +
      '$\\chi_s = ' + e(p.chi_s) + '\\,\\mathrm{eV}$ · $\\Phi_B = \\Phi_m - \\chi_s = ' + e(bh.Phi_B) + '\\,\\mathrm{eV}$\n\n' +
      'Raising $\\Phi_m$ increases the barrier for electrons entering the semiconductor. When $\\Phi_m < \\chi_s$ the contact becomes ideal-ohmic.'
    );

    case 'chi_s': return v(texHTML('\\chi_s = ' + e(p.chi_s) + '\\,\\mathrm{eV}')) + mdHTML(
      '$\\chi_s$ — **electron affinity**: energy from the conduction-band edge $E_C$ to vacuum.\n\n' +
      '$\\Phi_m = ' + e(p.phi_m) + '\\,\\mathrm{eV}$ · $\\Phi_B = ' + e(bh.Phi_B) + '\\,\\mathrm{eV}$\n\n' +
      'MoS₂ is typically quoted around $4.0\\text{–}4.3\\,\\mathrm{eV}$.'
    );

    case 'dE': return v(texHTML('\\Delta E = ' + e(p.dE_s) + '\\,\\mathrm{eV}')) + mdHTML(
      '$\\Delta E = E_F - E_C$ — **doping offset** of the n-type semiconductor.\n\n' +
      '$E_C = -\\chi_s = ' + e(lvl.Ec_s) + '\\,\\mathrm{eV}$ · $E_F^{\\mathrm{semi}} = ' + e(lvl.Ef_s) + '\\,\\mathrm{eV}$\n\n' +
      '$\\Delta E$ encodes the doping: it changes $V_{bi}$ and the depletion width $W$, but **not** the ideal barrier height $\\Phi_B$.'
    );

    case 'eg': return v(texHTML('E_g = ' + e(p.Eg_s) + '\\,\\mathrm{eV}')) + mdHTML(
      '$E_g = E_C - E_V$ — **band gap** of the semiconductor.\n\n' +
      '$E_C = ' + e(lvl.Ec_s) + '\\,\\mathrm{eV}$ · $E_V = ' + e(lvl.Ev_s) + '\\,\\mathrm{eV}$\n\n' +
      '2H-MoS₂ monolayer: $E_g \\approx 1.8\\text{–}1.9\\,\\mathrm{eV}$ (direct). Bulk/thin-flake 2H: $E_g \\approx 1.2\\text{–}1.3\\,\\mathrm{eV}$ (indirect).'
    );

    case 'vbi': return v(texHTML('V_{bi} \\approx ' + e(bh.Vbi) + '\\,\\mathrm{V}')) + mdHTML(
      '$V_{bi} = \\Phi_B - \\Delta E$ — **built-in potential** dropped across the depleted semiconductor at equilibrium.\n\n' +
      '$= (' + e(p.phi_m) + ' - ' + e(p.chi_s) + ' - ' + e(p.dE_s) + ')\\,\\mathrm{eV}/q$\n\n' +
      'Bands bend by exactly $qV_{bi}$ from interface to bulk.'
    );

    case 'barrier': return v(texHTML('\\Phi_B = ' + e(bh.Phi_B) + '\\,\\mathrm{eV}')) + mdHTML(
      '**Schottky–Mott rule** (ideal n-type): $\\Phi_B = \\Phi_m - \\chi_s = ' + e(p.phi_m) + ' - ' + e(p.chi_s) + '$\n\n' +
      `Contact type: **${bh.contactType}**\n\n` +
      'For an ideal n-type contact $\\Phi_B$ is set by the materials alone — independent of doping.'
    );

    case 'efsep': return v(texHTML('\\Delta E_F = ' + e(Math.abs(lvl.Ef_m - lvl.Ef_s)) + '\\,\\mathrm{eV}')) + mdHTML(
      '$\\Delta E_F$ — **Fermi-level offset** *before* contact: $|E_F^{\\mathrm{metal}} - E_F^{\\mathrm{semi}}|$.\n\n' +
      '$E_F^{\\mathrm{metal}} = ' + e(lvl.Ef_m) + '\\,\\mathrm{eV}$ · $E_F^{\\mathrm{semi}} = ' + e(lvl.Ef_s) + '\\,\\mathrm{eV}$\n\n' +
      'Contact equalizes them: electrons flow until one common $E_F$ exists — that flow *is* the built-in field.'
    );

    case 'vacuum': return mdHTML(
      '**Vacuum level** $E_{vac} = 0\\,\\mathrm{eV}$ — the reference for every energy here.\n\n' +
      'Before contact both materials share one vacuum level but have different $E_F$. After contact the vacuum levels stay aligned outside the junction while the bands bend to bring $E_F$ into equilibrium.'
    );

    default: return '<p>No detail available for this element.</p>';
  }
}
