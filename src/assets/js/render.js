/**
 * render.js — canvas rendering for Au | MoS2 Schottky contact
 * Bundles: band diagram (#bandCanvas) and I-V graph (#graphCanvas).
 * Called by main.js.  Also exported for use in main.js.
 */
'use strict';

import { BANDMODEL } from './bandmodel.js';
import { fmt, fmtSI, LABELS } from './labels.js';

/* ---------- palette ---------- */
const C = {
  bg: '#0e1529', grid: 'rgba(138,151,196,0.10)', gridS: 'rgba(138,151,196,0.22)',
  metalFill: 'rgba(255,215,0,0.10)', metalLine: '#ffd633', metalTxt: '#ffe9a8',
  semiFill: 'rgba(90,170,255,0.07)', semiLine: '#7fb4ff', semiTxt: '#cfe6ff',
  cb: '#5aaaff', vb: '#c084fc', fermi: '#ffb347', barrier: '#ff6b6b',
  vbi: '#3df0c0', vacuum: 'rgba(138,151,196,0.45)', bend: 'rgba(90,170,255,0.70)',
  depFill: 'rgba(90,170,255,0.06)', arrowLine: 'rgba(255,215,0,0.85)',
  arrowHead: '#ffd633', numBg: '#070b17', numFg: '#ffd633',
  graphLine: '#00e5b0', graphNeg: 'rgba(0,229,176,0.45)', axis: '#8a97c4',
  graphFill: 'rgba(0,229,176,0.10)', zero: 'rgba(138,151,196,0.5)', mark: '#ffb347',
  textDim: 'rgba(138,151,196,0.7)', textFaint: 'rgba(138,151,196,0.45)',
};

/* ---------- canvas sizing ---------- */
function fitCanvas(cv){
  const dpr = window.devicePixelRatio || 1;
  const r = cv.parentElement.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  if (cv.width !== Math.round(w*dpr) || cv.height !== Math.round(h*dpr)){
    cv.width = Math.round(w*dpr);
    cv.height = Math.round(h*dpr);
    cv.style.width = w+'px';
    cv.style.height = h+'px';
  }
  return { ctx: cv.getContext('2d'), w, h };
}

/* ---------- energy→y and position→x helpers ---------- */
function makeMappers(g, Emin, Emax){
  const Espan = Emax - Emin;
  const Y = E => g.pad.top + g.innerH * (1 - (E - Emin)/Espan);
  return Y;
}

function geom(w, h){
  return {
    W: w, H: h,
    pad: { left: 74, right: 24, top: 24, bottom: 32 },
    innerW: w - 54 - 24,
    innerH: h - 24 - 32,
  };
}

/* ---- numbered arrows: x = fraction across innerW; y anchored to real energies ----
   move: 'contact' = length animates with the contact animation (ΔE_F shrinks to 0,
   V_bi grows from 0); 0 = always static */
const ARROWS = [
  { id: 'vacuum',  x0: 0.05, x1: 0.32, e0: '0',    e1: '0',    color: C.vacuum,    dash: true  },
  { id: 'phi_m',   x0: 0.11, x1: 0.11, e0: '0',    e1: 'Ef_m', color: C.arrowLine, dash: false },
  { id: 'chi_s',   x0: 0.84, x1: 0.84, e0: '0',    e1: 'Ec_s', color: C.arrowLine, dash: false },
  { id: 'dE',      x0: 0.78, x1: 0.78, e0: 'Ec_bulk', e1: 'Ef_s', color: C.arrowLine, dash: false },
  { id: 'eg',      x0: 0.96, x1: 0.96, e0: 'Ec_s', e1: 'Ev_s', color: C.arrowLine, dash: false },
  // Φ_B: vertical arrow AT the Schottky interface (x=0.40) spanning E_F → CB corner
  { id: 'barrier', x0: 0.40, x1: 0.40, e0: 'Ef_m', e1: 'Ec_i', color: C.barrier, dash: false },
  // V_bi: vertical drop in the depletion zone (interface CB → bulk CB)
  { id: 'vbi',     x0: 0.52, x1: 0.52, e0: 'Ec_i', e1: 'Ec_bulk', color: C.vbi, dash: true, move: 'contact' },
  { id: 'efsep',   x0: 0.28, x1: 0.28, e0: 'Ef_m', e1: 'Ef_s',   color: 'rgba(255,179,71,0.70)', dash: true, move: 'contact' },
];

/* =====================================================
   1.  BAND DIAGRAM  (energy vs position)
   ===================================================== */
export function renderBand(canvas, model, animFrac){
  const { ctx, w, h } = fitCanvas(canvas);
  const g = geom(w, h);
  const p = model.params;
  const lvl = model.levels;
  const bh = model.barrier;
  const dep = model.depletion;

  const a = (animFrac == null) ? 1 : Math.max(0, Math.min(1, animFrac));

  // Equilibrium (Schottky–Mott rule): the metal pins the common Fermi level at
  // E_F = −Φ_m. The interface CB stays pinned at −χ_s (vacuum continuity) and the
  // bulk CB settles at E_F + ΔE so the bulk doping offset ΔE is preserved.
  //   rectifying (Φ_B = Φ_m − χ_s > 0): interface CB ABOVE bulk → depletion bend
  //   ohmic (Φ_B ≤ 0):                  interface CB BELOW bulk → accumulation dip
  const Ef_semi = lvl.Ef_s + (lvl.Ef_m - lvl.Ef_s) * a;   // semi E_F slides to −Φ_m
  const EcBulkT = lvl.Ef_m + p.dE_s;                      // equilibrium bulk CB edge
  const EcBulk  = lvl.Ec_s + (EcBulkT - lvl.Ec_s) * a;    // animated bulk CB edge
  const vacBulk = EcBulk + p.chi_s;                       // local vacuum level in bulk

  // Y range must cover both bend directions (no rescaling during the animation)
  const Emax = Math.max(0.8, (EcBulkT + p.chi_s) + 0.15);
  const Emin = Math.min(lvl.Ev_s - 0.4, EcBulkT - p.Eg_s - 0.4, lvl.Ef_m - 0.5);
  const Y = E => g.pad.top + g.innerH * (1 - (E - Emin) / (Emax - Emin));

  // clear background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  // grid + energy tick labels
  drawEnergyGrid(ctx, g, Emin, Emax, Y);

  // region x-bands
  const metalX0 = g.pad.left;
  const metalX1 = g.pad.left + 0.40 * g.innerW;
  const depX1  = metalX1 + 0.18 * g.innerW;
  const semiX0 = depX1;
  const semiX1 = g.pad.left + g.innerW;
  const midX   = metalX1;  // Schottky interface

  // metal region fill + border
  ctx.fillStyle = C.metalFill;
  ctx.fillRect(metalX0, g.pad.top, metalX1 - metalX0, g.innerH);
  ctx.strokeStyle = C.metalLine;
  ctx.lineWidth = 1;
  ctx.strokeRect(metalX0 + 0.5, g.pad.top + 0.5, metalX1 - metalX0 - 1, g.innerH - 1);

  // depletion shading
  ctx.fillStyle = C.depFill;
  ctx.fillRect(metalX1, g.pad.top, depX1 - metalX1, g.innerH);

  // semi region fill + border
  ctx.fillStyle = C.semiFill;
  ctx.fillRect(semiX0, g.pad.top, semiX1 - semiX0, g.innerH);
  ctx.strokeStyle = C.semiLine;
  ctx.strokeRect(semiX0 + 0.5, g.pad.top + 0.5, semiX1 - semiX0 - 1, g.innerH - 1);

  // vertical separators (dashed)
  ctx.strokeStyle = 'rgba(138,151,196,0.22)';
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(metalX1, g.pad.top); ctx.lineTo(metalX1, g.pad.top + g.innerH); ctx.stroke();
  ctx.moveTo(semiX0, g.pad.top); ctx.lineTo(semiX0, g.pad.top + g.innerH); ctx.stroke();
  ctx.setLineDash([]);

  // region captions
  ctx.fillStyle = C.metalTxt;
  ctx.font = '600 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('Au (metal)', (metalX0 + metalX1) / 2, g.pad.top + 4);
  ctx.fillStyle = C.semiTxt;
  ctx.fillText('2H-MoS\u2082 (n-type)', (semiX0 + semiX1) / 2, g.pad.top + 4);

  // band bending: interface pinned at −χ_s; bulk animated between the flat
  // pre-contact level and the equilibrium level (depletion: down / accumulation: up)
  const tDep0 = 0.40, tDep1 = 0.69;                    // depletion zone in t-coords
  const bendDrop = (t) => (t <= tDep0) ? 0 :
    (t >= tDep1) ? 1 :
    (1 - Math.exp(-3.2 * (t - tDep0) / (tDep1 - tDep0))) / (1 - Math.exp(-3.2));
  function bentEc(t){ return lvl.Ec_s + (EcBulk - lvl.Ec_s) * bendDrop(t); }
  function bentEv(t){ return bentEc(t) - p.Eg_s; }

  // draw CB (starts at the Schottky interface, t = 0.40)
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.strokeStyle = C.cb;
  for (let i = 0; i <= 360; i++){
    const t = 0.40 + (i / 360) * 0.60;
    const x = g.pad.left + t * g.innerW;
    const y = Y(bentEc(t));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // draw VB
  ctx.beginPath(); ctx.strokeStyle = C.vb;
  for (let i = 0; i <= 360; i++){
    const t = 0.40 + (i / 360) * 0.60;
    const x = g.pad.left + t * g.innerW;
    const y = Y(bentEv(t));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // band-gap fill (subtle purple) — path between CB and VB, actually filled
  ctx.fillStyle = 'rgba(192,132,252,0.06)';
  ctx.beginPath();
  for (let i = 0; i <= 360; i++){
    const t = 0.40 + (i / 360) * 0.60;
    const x = g.pad.left + t * g.innerW;
    if (i === 0) ctx.moveTo(x, Y(bentEc(t))); else ctx.lineTo(x, Y(bentEc(t)));
  }
  for (let i = 360; i >= 0; i--){
    const t = 0.40 + (i / 360) * 0.60;
    const x = g.pad.left + t * g.innerW;
    ctx.lineTo(x, Y(bentEv(t)));
  }
  ctx.closePath();
  ctx.fill();
  // ---- Fermi level(s) ----
  // Before contact: two separate E_F lines. At equilibrium they merge into ONE
  // common E_F = −Φ_m (flat across the junction) — the definition of equilibrium.
  const yFm = Y(lvl.Ef_m);
  const yFs = Y(Ef_semi);
  const merged = Math.abs(yFm - yFs) < 1.5;
  ctx.strokeStyle = C.fermi; ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(metalX0, yFm); ctx.lineTo(merged ? semiX1 : metalX1, yFm); ctx.stroke();
  if (!merged){
    ctx.beginPath(); ctx.moveTo(semiX0, yFs); ctx.lineTo(semiX1, yFs); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = C.fermi;
  ctx.font = '600 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('E_F (Au)', metalX0 + 5, yFm - 2);
  if (!merged){
    ctx.fillText('E_F (MoS\u2082)', semiX0 + 5, yFs - 2);
  } else {
    ctx.fillText('E_F (common) = ' + fmt(lvl.Ef_m) + ' eV', semiX0 + 5, yFs - 2);
  }

  // vacuum level (dashed; flat over metal, tilts DOWN across the depletion zone
  // to the lowered bulk, mirroring the band bending — electrostatic potential drop)
  ctx.strokeStyle = C.vacuum; ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.beginPath(); ctx.moveTo(metalX0, Y(0)); ctx.lineTo(metalX1, Y(0));
  for (let i = 0; i <= 60; i++){
    const t = tDep0 + (i / 60) * (tDep1 - tDep0);
    const x = g.pad.left + t * g.innerW;
    ctx.lineTo(x, Y(vacBulk * bendDrop(t)));
  }
  ctx.lineTo(semiX1, Y(vacBulk)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(138,151,196,0.6)';
  ctx.font = '10.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('E_vac = 0', metalX0 + 4, Y(0) + 3);

  // metal filled states: Fermi–Dirac occupation f(E)=1/(1+exp((E−Ef)/kT)),
  // drawn per-row so the edge is a smooth sigmoid (Boltzmann tail), not a step.
  // QUANTIZED to an 8-level palette so this hot loop issues a handful of
  // fillStyle/fillRect calls per frame instead of ~700 (removes render lag).
  const fx0 = metalX0 + 4, fx1 = metalX1 - 4;
  const yBot = g.pad.top + g.innerH - 2;
  const kT = BANDMODEL.THERMAL_V(p.T);
  const ALPHA = Math.max(0, Math.min(1, (lvl.Ef_m - Y(0)) < 0 ? 0.5 : 1.2)); // hide when E_F off-scale
  const palette = [0.02, 0.05, 0.09, 0.13, 0.16, 0.13, 0.09, 0.05, 0.02].map(a => `rgba(255,220,60,${(a * ALPHA).toFixed(3)})`);
  const levels = 8;
  ctx.fillStyle = palette[0];
  ctx.fillRect(fx0, yBot, fx1 - fx0, 1); // zero row < E_F - 8kT
  for (let y = yBot; y >= g.pad.top + 2; y--){
    const E = Emin + (1 - (y - g.pad.top) / g.innerH) * (Emax - Emin);
    const x = (E - lvl.Ef_m) / kT;                 // (E - E_F)/kT
    let L;
    if (x < -8) L = levels;                        // densely filled far below E_F
    else if (x > 4) L = -1;                        // empty tail
    else L = Math.round((1 / (1 + Math.exp(x))) * (levels - 1) + 1) - 1;
    if (L <= 0) break;                             // nothing left above this row
    const idx = Math.min(levels - 1, L - 1);
    ctx.fillStyle = palette[idx];
    ctx.fillRect(fx0, y, fx1 - fx0, 1);
  }

  // ---- f(E) inset: Fermi–Dirac sigmoid with exponential tail (bottom-left) ----
  {
    const iw = 150, ih = 64, ix = metalX0 + 10, iy0 = yBot - ih - 8;
    // window: ±10 kT around E_F
    const dE = 10 * kT;
    const fy = E => iy0 + ih * (1 - BANDMODEL.fermiDirac(E, lvl.Ef_m, p.T));
    const fxE = E => ix + ((E - (lvl.Ef_m - dE)) / (2 * dE)) * iw;
    // frame
    ctx.strokeStyle = 'rgba(138,151,196,0.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(ix, iy0, iw, ih);
    // sigmoid curve
    ctx.strokeStyle = C.fermi; ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i <= 80; i++){
      const E = lvl.Ef_m - dE + (i / 80) * 2 * dE;
      const x = fxE(E), y = Math.max(iy0 + 1, Math.min(iy0 + ih - 1, fy(E)));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // T=0 step function (ghost) for contrast
    ctx.strokeStyle = 'rgba(138,151,196,0.45)'; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(ix, iy0); ctx.lineTo(fxE(lvl.Ef_m), iy0);
    ctx.lineTo(fxE(lvl.Ef_m), iy0 + ih); ctx.lineTo(ix + iw, iy0 + ih);
    ctx.stroke();
    ctx.setLineDash([]);
    // labels
    ctx.fillStyle = C.textDim;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('f(E)  kT = ' + fmt(kT) + ' eV', ix + 4, iy0 + 3);
    ctx.textBaseline = 'bottom';
    ctx.fillText('E_F', fxE(lvl.Ef_m) + 3, iy0 + ih - 2);
  }

  // depletion hatching
  ctx.strokeStyle = 'rgba(90,170,255,0.20)'; ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++){
    const x = metalX1 + (i + 0.5) * (depX1 - metalX1) / 12;
    ctx.beginPath(); ctx.moveTo(x, g.pad.top); ctx.lineTo(x, g.pad.top + g.innerH); ctx.stroke();
  }

  // interface marker
  ctx.strokeStyle = 'rgba(255,107,107,0.45)'; ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(midX, g.pad.top); ctx.lineTo(midX, g.pad.top + g.innerH); ctx.stroke();
  ctx.setLineDash([]);

  // axis labels
  ctx.fillStyle = 'rgba(138,151,196,0.7)';
  ctx.font = '11px "Inter", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('Position  \u2192', g.pad.left + g.innerW / 2, g.pad.top + g.innerH + 8);
  ctx.save();
  ctx.translate(13, g.pad.top + g.innerH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Energy  (eV, relative to E_vac = 0)', 0, 0);
  ctx.restore();

  // contact-state caption (bottom-right so it never collides with region captions)
  const state = a < 0.05 ? 'Separated (before contact)' :
                a > 0.95 ? 'In contact (equilibrium)' :
                `Forming contact\u2026 ${Math.round(a * 100)}%`;
  ctx.fillStyle = a > 0.95 ? 'rgba(61,240,192,0.85)' :
                 a < 0.05 ? 'rgba(255,179,71,0.85)' : 'rgba(255,255,255,0.8)';
  ctx.font = '600 12px "JetBrains Mono", monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(state, w - g.pad.right, g.pad.top + g.innerH + 8);

  // NUMBERED ARROWS (clickable)
  _targets.length = 0;
  drawNumberedArrows(ctx, g, Y, lvl, bh, p, midX, metalX1, semiX0, semiX1, yFm, yFs, {
    Ef_semi, EcBulk, a,
  });
}
let _targets = [];

/* =====================================================
   2.1  drawEnergyGrid  — horizontal eV gridlines + labels
   ===================================================== */
function drawEnergyGrid(ctx, g, Emin, Emax, Y){
  const step = niceStep(Emax - Emin);
  ctx.strokeStyle = C.grid;
  ctx.fillStyle = C.textFaint;
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const first = Math.ceil(Emin / step) * step;
  for (let e = first; e <= Emax + 1e-6; e += step){
    const y = Y(e);
    if (y < g.pad.top || y > g.pad.top + g.innerH) continue;
    const emph = (Math.abs(e) < 1e-6);
    ctx.strokeStyle = emph ? C.gridS : C.grid;
    ctx.lineWidth = emph ? 1 : 0.6;
    ctx.beginPath();
    ctx.moveTo(g.pad.left, y);
    ctx.lineTo(g.pad.left + g.innerW, y);
    ctx.stroke();
    if (emph){
      ctx.fillStyle = C.zero;
      ctx.font = '600 10px "JetBrains Mono", monospace';
    } else {
      ctx.fillStyle = C.textFaint;
      ctx.font = '10px "JetBrains Mono", monospace';
    }
    ctx.fillText((Math.abs(e) < 1e-6 ? '0' : (e > 0 ? '+' : '') + e.toFixed(e < 1 && e > -1 ? 2 : 1)), g.pad.left - 6, y);
  }
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.fillStyle = C.textFaint;
}

/* (niceStep defined with the other axis-tick helpers below) */

/* =====================================================
   3.  I–V CHARACTERISTIC  (thermionic emission)
   ===================================================== */
export function renderGraph(canvas, model){
  const { ctx, w, h } = fitCanvas(canvas);
  const g = geom(w, h);
  const p = model.params;
  const bh = model.barrier;
  const iv = model.IV;
  const kB = BANDMODEL.THERMAL_V(p.T);
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  // ---- sample BOTH branches over the full sweep first, then scale the axis ----
  // Forward sweep is capped near the knee (~0.45 V) so the exponential rise is
  // visible; the axis auto-widens only when the user biases beyond the cap.
  const Vbound = Math.max(bh.Vbi + 0.5, 1.2);
  const Vmax = Math.max(Math.min(Vbound, 0.45), p.bias > 0 ? p.bias * 1.05 : 0);
  const Vmin = -Vbound * 0.7;

  const Nf = 120;
  const fwdPts = [];
  for (let i = 0; i <= Nf; i++){
    const v = (i / Nf) * Vmax;
    fwdPts.push({ v, i: BANDMODEL.schottkyCurrent({ ...p, bias: v }).I_fwd });
  }
  const Nr = 60;
  const revPts = [{ v: 0, i: -iv.Is }];       // reverse branch: current is NEGATIVE
  for (let i = 1; i <= Nr; i++){
    const v = -(i / Nr) * Vbound * 0.7;
    revPts.push({ v, i: -BANDMODEL.schottkyCurrent({ ...p, bias: v }).I_rev });
  }

  const Ipeak = fwdPts.reduce((m, pt) => Math.max(m, pt.i), iv.Is);
  // Guard the axis so it never collapses (current can underflow to 0 for
  // large Φ_B + low T, or overflow for ohmic + high T). Force a readable span.
  let Imax = smoothCeil(Ipeak * 1.15);
  if (!(Imax > 1e-12)) Imax = 1e-11;               // near-zero curve → keep a minimal window
  let Imin = -Math.max(Imax * 0.08, 2 * Math.max(iv.Is, 1e-11));
  if (Imin >= 0) Imin = -Imax * 0.2;
  if (!(Imax > Imin)) { Imax = 1e-11; Imin = -1e-12; }

  const X = v => g.pad.left + (v - Vmin) / (Vmax - Vmin) * g.innerW;
  const Yv = i => g.pad.top + g.innerH * (1 - (i - Imin) / (Imax - Imin));
  const clampY = y => Math.max(g.pad.top + 1, Math.min(g.pad.top + g.innerH - 1, y));

  // grid — voltage
  ctx.strokeStyle = C.grid;
  ctx.fillStyle = C.textFaint;
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.lineWidth = 0.6;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const vStep = niceStepV(Vmax - Vmin);
  for (let v = -vStep; v >= Vmin - 1e-6; v -= vStep){
    const x = X(v);
    if (x < g.pad.left || x > g.pad.left + g.innerW) continue;
    ctx.strokeStyle = (Math.abs(v) < 1e-6) ? C.gridS : C.grid;
    ctx.beginPath(); ctx.moveTo(x, g.pad.top); ctx.lineTo(x, g.pad.top + g.innerH); ctx.stroke();
    ctx.fillStyle = (Math.abs(v) < 1e-6) ? C.zero : C.textFaint;
    ctx.fillText((v > 0 ? '+' : '') + v.toFixed(1), x, g.pad.top + g.innerH + 4);
  }
  for (let v = vStep; v <= Vmax + 1e-6; v += vStep){
    const x = X(v);
    if (x < g.pad.left || x > g.pad.left + g.innerW) continue;
    ctx.strokeStyle = (Math.abs(v) < 1e-6) ? C.gridS : C.grid;
    ctx.beginPath(); ctx.moveTo(x, g.pad.top); ctx.lineTo(x, g.pad.top + g.innerH); ctx.stroke();
    ctx.fillStyle = (Math.abs(v) < 1e-6) ? C.zero : C.textFaint;
    ctx.fillText((v > 0 ? '+' : '') + v.toFixed(1), x, g.pad.top + g.innerH + 4);
  }

  // grid — current
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const iStep = niceStepI(Imax - Imin);
  for (let i = -iStep; i >= Imin - 1e-6; i -= iStep){
    const y = Yv(i);
    if (y < g.pad.top || y > g.pad.top + g.innerH) continue;
    ctx.strokeStyle = C.grid;
    ctx.beginPath(); ctx.moveTo(g.pad.left, y); ctx.lineTo(g.pad.left + g.innerW, y); ctx.stroke();
    ctx.fillStyle = (Math.abs(i) < 1e-12) ? C.zero : C.textFaint;
    ctx.fillText(fmtSI(i), g.pad.left - 6, y);
  }
  for (let i = iStep; i <= Imax + 1e-6; i += iStep){
    const y = Yv(i);
    if (y < g.pad.top || y > g.pad.top + g.innerH) continue;
    ctx.strokeStyle = C.grid;
    ctx.beginPath(); ctx.moveTo(g.pad.left, y); ctx.lineTo(g.pad.left + g.innerW, y); ctx.stroke();
    ctx.fillStyle = (Math.abs(i) < 1e-12) ? C.zero : C.textFaint;
    ctx.fillText(fmtSI(i), g.pad.left - 6, y);
  }

  // axes + zero line
  ctx.strokeStyle = C.axis; ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(g.pad.left, g.pad.top);
  ctx.lineTo(g.pad.left, g.pad.top + g.innerH);
  ctx.lineTo(g.pad.left + g.innerW, g.pad.top + g.innerH);
  ctx.stroke();
  ctx.strokeStyle = C.zero; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(g.pad.left, Yv(0));
  ctx.lineTo(g.pad.left + g.innerW, Yv(0));
  ctx.stroke();
  ctx.setLineDash([]);

  // axis titles
  ctx.fillStyle = C.axis; ctx.font = '11px "Inter", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('Bias V (V)', g.pad.left + g.innerW / 2, g.pad.top + g.innerH + 22);
  ctx.save();
  ctx.translate(13, g.pad.top + g.innerH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Current I (A)', 0, 0);
  ctx.restore();

  // headline annotation (short version on narrow canvases so it can't hit the badge)
  ctx.fillStyle = C.textDim; ctx.font = '10.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const headline = (g.innerW < 520)
    ? `I_s ≈ ${fmtSI(iv.Is)} A`
    : `I_s ≈ ${fmtSI(iv.Is)} A    Φ_B = ${fmt(bh.Phi_B)} eV    kT = ${fmt(kB)} eV at ${p.T} K`;
  ctx.fillText(headline, g.pad.left + 6, g.pad.top + 4);

  // contact badge
  const ct = bh.contactType;
  ctx.fillStyle = ct.startsWith('ohmic') ? 'rgba(61,240,192,0.85)' : 'rgba(255,179,71,0.85)';
  ctx.font = '600 10.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(ct.toUpperCase(), g.pad.left + g.innerW - 6, g.pad.top + 4);
  // ---- curves, fill and marker (clipped to the plot area) ----
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.pad.left, g.pad.top, g.innerW, g.innerH);
  ctx.clip();

  // fill under forward curve
  ctx.beginPath();
  ctx.moveTo(X(0), Yv(0));
  for (const pt of fwdPts) ctx.lineTo(X(pt.v), clampY(Yv(pt.i)));
  ctx.lineTo(X(fwdPts[fwdPts.length - 1].v), Yv(0));
  ctx.closePath();
  ctx.fillStyle = C.graphFill;
  ctx.fill();

  // reverse branch (faint, negative current)
  ctx.strokeStyle = C.graphNeg;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < revPts.length; i++){
    const pt = revPts[i];
    if (i === 0) ctx.moveTo(X(pt.v), Yv(pt.i)); else ctx.lineTo(X(pt.v), Yv(pt.i));
  }
  ctx.stroke();

  // forward curve (bright)
  ctx.strokeStyle = C.graphLine;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < fwdPts.length; i++){
    const pt = fwdPts[i];
    if (i === 0) ctx.moveTo(X(pt.v), Yv(pt.i)); else ctx.lineTo(X(pt.v), clampY(Yv(pt.i)));
  }
  ctx.stroke();

  // ---- live bias marker (correct branch, clamped inside the plot) ----
  const vx = X(p.bias);
  const ivHere = BANDMODEL.schottkyCurrent(p);
  const iHere = p.bias >= 0 ? ivHere.I_fwd : -ivHere.I_rev;
  const iy = clampY(Yv(iHere));
  ctx.strokeStyle = 'rgba(255,179,71,0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(vx, g.pad.top);
  ctx.lineTo(vx, g.pad.top + g.innerH);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = C.mark;
  ctx.beginPath();
  ctx.arc(vx, iy, 5, 0, 2 * Math.PI);
  ctx.fill();
  ctx.strokeStyle = '#0e1529';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // annotation near dot (unclipped so it stays readable)
  ctx.fillStyle = '#ffe9a8';
  ctx.font = '600 11px "JetBrains Mono", monospace';
  const rightHalf = vx > g.pad.left + g.innerW * 0.6;
  ctx.textAlign = rightHalf ? 'right' : 'left';
  ctx.textBaseline = 'bottom';
  const dx2 = rightHalf ? -10 : 10;
  ctx.fillText(`V = ${fmt(p.bias)} V  ·  I ≈ ${fmtSI(iHere)} A`, vx + dx2, clampY(iy - 7));

}

function drawNumberedArrows(ctx, g, Y, lvl, bh, p, midX, metalX1, semiX0, semiX1, yFm, yFs, extra){
  // resolve symbolic energy anchors (eV, vacuum = 0). 'extra' carries the
  // animated levels so arrows follow the contact/separate motion and sliders.
  const x = extra || {};
  const Emap = {
    '0': 0,
    Ef_m: lvl.Ef_m,                 // metal Fermi (fixed, = −Φ_m)
    Ef_s: x.Ef_semi,                // semiconductor E_F (slides to −Φ_m on contact)
    Ef_s_nc: lvl.Ef_s,              // pre-contact semiconductor E_F (for ΔE_F)
    Ec_s: lvl.Ec_s, Ev_s: lvl.Ev_s,
    Ec_i: lvl.Ec_s,                 // interface CB (pinned at −χ_s)
    Ec_bulk: x.EcBulk,              // bulk CB edge (animated: drops or rises to equilibrium)
  };
  const ex0 = g.pad.left, iw = g.innerW;
  const Xf = f => ex0 + f * iw;

  let n = 0;
  for (const ar of ARROWS){
    n++;
    let x0 = Xf(ar.x0), x1 = Xf(ar.x1);
    let y0 = Y(Emap[ar.e0]), y1 = Y(Emap[ar.e1]);
    // barrier arrow: point its head at the UPPER of the two levels (higher energy)
    if (ar.id === 'barrier' && y1 > y0){ [y0, y1] = [y1, y0]; }
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;

    // contact-animated arrows fade with their own length so the shrink/grow
    // of ΔE_F (→0) and V_bi (from 0) is visible during the animation
    let alpha = 1;
    if (ar.move === 'contact' && extra && extra.a != null){
      // length ∝ animation progress: ΔE_F shrinks (1−a), V_bi grows (a)
      const shrinker = ar.e0 === 'Ef_m';       // efsep shrinks, vbi grows
      const frac = shrinker ? (1 - extra.a) : extra.a;
      alpha = Math.max(0.12, Math.min(1, frac * 2.2));   // visible until nearly gone
    }
    if (alpha < 1){
      ctx.globalAlpha = alpha;
    }
    const ux = dx / len, uy = dy / len;

    // shaft
    ctx.strokeStyle = ar.color;
    ctx.lineWidth = ar.dash ? 1.1 : 1.6;
    ctx.setLineDash(ar.dash ? [4, 3] : []);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.setLineDash([]);

    // arrowhead
    const hx = x1 - ux * 5, hy = y1 - uy * 5;
    ctx.fillStyle = ar.color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(hx - uy * 3.4, hy + ux * 3.4);
    ctx.lineTo(hx + uy * 3.4, hy - ux * 3.4);
    ctx.closePath();
    ctx.fill();

    // number badge at the shaft midpoint, nudged perpendicular off the line
    // (hidden along with the arrow when it has fully shrunk)
    if (alpha > 0.3){
      const badgeR = 9;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const nx = -uy, ny = ux;
      const bx = cx + nx * (badgeR + 3);
      const by = cy + ny * (badgeR + 3);
      ctx.fillStyle = C.numBg;
      ctx.strokeStyle = C.numFg;
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(bx, by, badgeR, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.numFg;
      ctx.font = '700 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n), bx, by + 0.5);

      // hit target (radius ~13 for easy clicking)
      _targets.push({ id: ar.id, num: n, x: bx, y: by, r: 13 });
    }
    if (ctx.globalAlpha !== 1) ctx.globalAlpha = 1;
  }
}
/* ---------- helpers for I–V axis ticks ----------
   Guaranteed to return a POSITIVE finite step. If the span is <= 0, NaN or
   infinite, falls back to 1e-9 — avoids infinite for-loop ticks (freezes UI). */
const SAFE_STEP = 1e-9;
function niceSpan(span){
  if (typeof span !== 'number' || !isFinite(span) || span <= 0) return null;
  const raw = span / 5;
  if (!(raw > 0)) return null;
  return Math.pow(10, Math.floor(Math.log10(raw)));
}
function quantStep(mag, n, lo, hi1, hi2, loMult, hiMult){
  let s;
  if (n < lo) s = loMult; else if (n < hi1) s = 5; else if (n < hi2) s = 10; else s = hiMult;
  return s * (mag || SAFE_STEP);
}
function smoothCeil(x){
  if (typeof x !== 'number' || !isFinite(x) || x <= 0) return SAFE_STEP;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / mag;
  let s;
  if (n < 1.5) s = 2; else if (n < 3.5) s = 5; else if (n < 7.5) s = 10; else s = 20;
  return s * mag;
}
function niceStep(span){ const mag = niceSpan(span); if (mag == null) return SAFE_STEP; const n = (span/5)/mag; return quantStep(mag, n, 1.5, 3.5, 7.5, 1, 10); }
function niceStepV(span){ const mag = niceSpan(span); if (mag == null) return SAFE_STEP; const n = (span/5)/mag; return quantStep(mag, n, 1.5, 3.5, 7.5, 1, 10); }
function niceStepI(span){ const mag = niceSpan(span); if (mag == null) return SAFE_STEP; const n = (span/5)/mag; return quantStep(mag, n, 1.5, 3.5, 7.5, 2, 20); }

/* =====================================================
   4.  HIT TEST  (band canvas clicks → arrow id)
   ===================================================== */
export function hitTestBand(mx, my){
  for (let i = _targets.length - 1; i >= 0; i--){
    const t = _targets[i];
    const dx = mx - t.x, dy = my - t.y;
    if (dx * dx + dy * dy <= t.r * t.r) return t.id;
  }
  return null;
}

/* =====================================================
   5.  RESIZE  (no-op; main.js handles the real path)
   ===================================================== */
export function resizeAll(){ /* re-render is triggered by main.js */ }

/* current clickable arrow hit-targets (CSS-pixel coords within the band canvas) */
export function getArrowTargets(){ return _targets; }

/* =====================================================
   EXPORTS
   ===================================================== */
export { ARROWS };

