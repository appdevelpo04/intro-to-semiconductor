/**
 * detail.js
 * Click-to-detail system for the band diagram arrows.
 * Exports open(id, model) and close().
 */

import { BANDMODEL } from './bandmodel.js';

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

  switch (id) {
    case 'phi_m': return [
      `Φ<sub>m</sub> = <b>${e(p.phi_m)} eV</b>`,
      `χ<sub>s</sub> = ${e(p.chi_s)} eV`,
      `Φ<sub>B</sub> = Φ<sub>m</sub> − χ<sub>s</sub> = ${e(bh.Phi_B)} eV`,
      '',
      'Raising Φ_m increases the barrier for electrons entering the',
      'semiconductor. When Φ_m < χ_s the contact becomes ideal-ohmic.',
    ].join('\n');

    case 'chi_s': return [
      `χ<sub>s</sub> = <b>${e(p.chi_s)} eV</b>`,
      `Φ<sub>m</sub> = ${e(p.phi_m)} eV`,
      `Φ<sub>B</sub> = ${e(bh.Phi_B)} eV`,
      '',
      'Electron affinity: energy from the semiconductor CB edge to vacuum.',
      'MoS₂ is typically quoted around 4.0–4.4 eV.',
    ].join('\n');

    case 'dE': return [
      `ΔE = E<sub>F</sub> − E<sub>C</sub> = <b>${e(p.dE_s)} eV</b>`,
      `E<sub>C</sub> = −χ<sub>s</sub> = ${e(lvl.Ec_s)} eV`,
      `E<sub>F</sub> (semi) = ${e(lvl.Ef_s)} eV`,
      '',
      'ΔE encodes the n-type doping. It changes V_bi and the depletion',
      'width but does NOT change the ideal barrier height Φ_B.',
    ].join('\n');

    case 'eg': return [
      `E<sub>g</sub> = <b>${e(p.Eg_s)} eV</b>`,
      `E<sub>C</sub> = ${e(lvl.Ec_s)} eV`,
      `E<sub>V</sub> = ${e(lvl.Ev_s)} eV`,
      '',
      '2H-MoS₂ monolayer: E_g ≈ 1.8–1.9 eV (direct).',
      'Bulk/thin-flake 2H: E_g ≈ 1.2–1.3 eV (indirect).',
    ].join('\n');

    case 'vbi': return [
      `V<sub>bi</sub> ≈ <b>${e(bh.Vbi)} V</b>`,
      `V<sub>bi</sub> = (Φ_m − χ_s − ΔE) / e`,
      `   = (${e(p.phi_m)} − ${e(p.chi_s)} − ${e(p.dE_s)}) / e`,
      '',
      'Built-in potential: electrostatic potential drop across the',
      'depleted semiconductor at equilibrium.',
    ].join('\n');

    case 'barrier': return [
      `Φ<sub>B</sub> = <b>${e(bh.Phi_B)} eV</b>`,
      `Φ<sub>B</sub> = Φ_m − χ_s = ${e(p.phi_m)} − ${e(p.chi_s)}`,
      '',
      `Contact type: <b>${bh.contactType}</b>`,
      '',
      'For an ideal n-type Schottky contact the barrier height is set by',
      'Φ_m − χ_s, independent of doping.',
    ].join('\n');

    case 'efsep': return [
      `ΔE<sub>F</sub> (before contact) = <b>${e(Math.abs(lvl.Ef_m - lvl.Ef_s))} eV</b>`,
      '',
      'Before contact the metal and semiconductor Fermi levels are',
      'misaligned. On contact they equilibrate to one common E_F;',
      'electrons flow until E_F is flat across the junction — that flow',
      'produces the band bending you see at the interface.',
    ].join('\n');

    case 'bias': return [
      `Applied bias V = <b>${e(p.bias)} V</b>`,
      `I<sub>s</sub> ≈ ${e(iv.Is)} A  (reverse saturation)`,
      `kT = ${e(kT)} eV`,
      '',
      'Forward bias (V > 0, metal positive) lowers the effective barrier',
      'for thermionic emission:  I ≈ I_s · exp(V / kT).',
      'Reverse bias widens the depletion region and current saturates',
      'near I_s in this ideal model.',
    ].join('\n');

    case 'vacuum': return [
      'Vacuum level E<sub>vac</sub> = 0 eV (reference).',
      '',
      'All energies are drawn relative to a common vacuum level. Before',
      'contact the two materials share one vacuum level but have different',
      'Fermi levels. After contact the vacuum levels stay aligned while',
      'the bands bend to bring E_F into equilibrium.',
    ].join('\n');

    default: return 'No detail available for this element.';
  }
}
