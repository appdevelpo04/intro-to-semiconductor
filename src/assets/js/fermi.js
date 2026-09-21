/**
 * fermi.js — Fermi-Dirac distribution hero modal
 * Renders an interactive, magnified view of the Fermi-Dirac occupation
 * probability f(E) = 1 / (1 + exp((E - E_F) / kT)) near the lower-left
 * of the band diagram.
 */
'use strict';

import { BANDMODEL } from './bandmodel.js';
import { fmt, fmtSI } from './labels.js';

const $ = (id) => document.getElementById(id);

let fermiModal = null;
let fermiCanvas = null;
let fermiOverlay = null;
let fermiBtn = null;
let fermiClose = null;
let fermiModel = null;

/* ---------- open / close ---------- */
export function openFermi(model) {
  fermiModel = model || BANDMODEL.model({});
  if (!fermiOverlay) return;
  // Activate BEFORE rendering: the closed modal carries scale(0.95), and painting
  // during that transform would size the backing store 5% small and smear the
  // plot once the scale animates to 1. Same frame, so no flash.
  fermiOverlay.classList.add('active');
  renderFermiCanvas();
  document.body.style.overflow = 'hidden';
  setTimeout(() => fermiClose?.focus(), 380);   // after the scale-in settles
}

export function closeFermi() {
  if (!fermiOverlay) return;
  fermiOverlay.classList.remove('active');
  document.body.style.overflow = '';
  fermiBtn?.focus();
}

function renderFermiCanvas() {
  if (!fermiCanvas || !fermiModel) return;
  // Measure first, then resize only the BACKING STORE. Display size stays under
  // CSS control (width:100%; height:340px) — writing an inline px width here used
  // to freeze the element, so every later resize measured the frozen rect and the
  // plot never reflowed. offsetWidth/Height are layout sizes, so they ignore the
  // modal's scale() transform; getBoundingClientRect would report the scaled box.
  const w = Math.max(1, fermiCanvas.offsetWidth || Math.floor(fermiCanvas.getBoundingClientRect().width));
  const h = Math.max(1, fermiCanvas.offsetHeight || Math.floor(fermiCanvas.getBoundingClientRect().height));
  const dpr = window.devicePixelRatio || 1;
  if (fermiCanvas.width !== Math.round(w * dpr) || fermiCanvas.height !== Math.round(h * dpr)) {
    fermiCanvas.width = Math.round(w * dpr);
    fermiCanvas.height = Math.round(h * dpr);
  }
  const ctx = fermiCanvas.getContext('2d');
  const W = fermiCanvas.width;
  const H = fermiCanvas.height;

  const p = fermiModel.params;
  const lvl = fermiModel.levels;
  const kT = BANDMODEL.THERMAL_V(p.T);
  const Ef = lvl.Ef_m;                 // metal-side E_F = reference level for f(E)
  const Ec = lvl.Ec_s;
  const Ev = lvl.Ev_s;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#070b17';
  ctx.fillRect(0, 0, W, H);

  const pad = { left: 52 * dpr, right: 22 * dpr, top: 20 * dpr, bottom: 46 * dpr };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  /* ---------- scales ----------
     Energy runs left→right (E_F centred, window ±10 kT, same as the band inset)
     and f(E) runs 0→1 bottom→top: the conventional orientation of a Fermi–Dirac
     plot, i.e. a sigmoid decaying from 1 to 0 as energy rises. */
  const dE = 10 * kT;
  const Emin = Ef - dE, Emax = Ef + dE;
  const xE = (E) => pad.left + ((E - Emin) / (Emax - Emin)) * innerW;
  const yF = (f) => pad.top + (1 - f) * innerH;    // f = 1 → top, f = 0 → bottom

  const label = (size, weight) =>
    `${weight ? weight + ' ' : ''}${size * dpr}px "JetBrains Mono", monospace`;

  /* ---------- f(E) gridlines at 0 / .25 / .5 / .75 / 1 ---------- */
  ctx.lineWidth = 1 * dpr;
  ctx.font = label(10);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const f = i / 4;
    const y = yF(f);
    ctx.strokeStyle = f === 0.5 ? 'rgba(0,229,176,0.22)' : 'rgba(138,151,196,0.10)';
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + innerW, y); ctx.stroke();
    ctx.fillStyle = f === 0.5 ? 'rgba(0,229,176,0.75)' : 'rgba(138,151,196,0.55)';
    ctx.fillText(f.toFixed(f === 0 || f === 1 ? 0 : 2), pad.left - 8 * dpr, y);
  }

  /* ---------- energy ticks: kT offsets from E_F, with E_F itself called out ---- */
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let n = -10; n <= 10; n += 2) {
    const x = xE(Ef + n * kT);
    ctx.strokeStyle = n === 0 ? 'rgba(0,229,176,0.85)' : 'rgba(138,151,196,0.35)';
    ctx.beginPath();
    ctx.moveTo(x, pad.top + innerH);
    ctx.lineTo(x, pad.top + innerH + (n === 0 ? 7 : 4) * dpr);
    ctx.stroke();
    if (n % 4 === 0) {
      ctx.fillStyle = n === 0 ? 'rgba(0,229,176,0.9)' : 'rgba(138,151,196,0.55)';
      ctx.font = label(10, n === 0 ? '600' : null);
      ctx.fillText(n === 0 ? 'E_F' : (n > 0 ? '+' : '−') + Math.abs(n) + 'kT',
                   x, pad.top + innerH + 10 * dpr);
    }
  }

  /* ---------- axes ---------- */
  ctx.strokeStyle = 'rgba(138,151,196,0.65)';
  ctx.lineWidth = 1.2 * dpr;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + innerH);
  ctx.lineTo(pad.left + innerW, pad.top + innerH);
  ctx.stroke();

  ctx.fillStyle = 'rgba(138,151,196,0.75)';
  ctx.font = label(11);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Energy E →', pad.left + innerW / 2, pad.top + innerH + 42 * dpr);
  ctx.save();
  ctx.translate(14 * dpr, pad.top + innerH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'middle';
  ctx.fillText('f(E)', 0, 0);
  ctx.restore();

  /* ---------- plot area clip ---------- */
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left, pad.top, innerW, innerH);
  ctx.clip();

  /* T = 0 step function, ghosted behind — the sharp edge that kT rounds off */
  ctx.strokeStyle = 'rgba(138,151,196,0.40)';
  ctx.lineWidth = 1.2 * dpr;
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath();
  ctx.moveTo(xE(Emin), yF(1));
  ctx.lineTo(xE(Ef), yF(1));
  ctx.lineTo(xE(Ef), yF(0));
  ctx.lineTo(xE(Emax), yF(0));
  ctx.stroke();
  ctx.setLineDash([]);

  /* ---------- the Fermi–Dirac sigmoid ---------- */
  const N = 240;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const E = Emin + (i / N) * (Emax - Emin);
    pts.push({ x: xE(E), y: yF(BANDMODEL.fermiDirac(E, Ef, p.T)) });
  }
  // gradient fill dropped from the curve down to f = 0
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pad.top + innerH);
  for (const pt of pts) ctx.lineTo(pt.x, pt.y);
  ctx.lineTo(pts[N].x, pad.top + innerH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + innerH);
  grad.addColorStop(0, 'rgba(255,179,71,0.26)');
  grad.addColorStop(0.55, 'rgba(255,179,71,0.09)');
  grad.addColorStop(1, 'rgba(255,179,71,0.02)');
  ctx.fillStyle = grad;
  ctx.fill();

  // curve + soft glow
  ctx.save();
  ctx.shadowColor = 'rgba(255,179,71,0.55)';
  ctx.shadowBlur = 12 * dpr;
  ctx.strokeStyle = '#ffb347';
  ctx.lineWidth = 2.6 * dpr;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
  ctx.stroke();
  ctx.restore();

  /* ---------- f(E_F) = 0.5 marker ---------- */
  const xEf = xE(Ef), yHalf = yF(0.5);
  ctx.strokeStyle = 'rgba(0,229,176,0.75)';
  ctx.lineWidth = 1.4 * dpr;
  ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.beginPath();
  ctx.moveTo(xEf, pad.top + innerH);
  ctx.lineTo(xEf, yHalf);
  ctx.lineTo(pad.left, yHalf);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#00e5b0';
  ctx.beginPath();
  ctx.arc(xEf, yHalf, 4 * dpr, 0, 2 * Math.PI);
  ctx.fill();
  ctx.strokeStyle = '#070b17';
  ctx.lineWidth = 1.6 * dpr;
  ctx.stroke();

  /* ---------- ±2 kT: the thermal width of the transition ---------- */
  for (const s of [-1, 1]) {
    const x = xE(Ef + s * 2 * kT);
    ctx.strokeStyle = 'rgba(192,132,252,0.5)';
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + innerH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(192,132,252,0.8)';
    ctx.font = label(9);
    ctx.textAlign = s < 0 ? 'right' : 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('f = ' + BANDMODEL.fermiDirac(Ef + s * 2 * kT, Ef, p.T).toFixed(2),
                 x + s * 4 * dpr, pad.top + 14 * dpr);
  }

  /* ---------- band edges, only when they fall inside the window ---------- */
  const edge = (E, color, name, val) => {
    if (E < Emin || E > Emax) return;
    const x = xE(E);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2 * dpr;
    ctx.setLineDash([5 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + innerH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = label(9.5);
    const right = x > pad.left + innerW * 0.7;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${name} = ${fmt(val)} eV`, x + (right ? -5 : 5) * dpr,
                 pad.top + innerH - 6 * dpr);
  };
  edge(Ec, 'rgba(90,170,255,0.85)', 'E_C', Ec);
  edge(Ev, 'rgba(192,132,252,0.85)', 'E_V', Ev);

  ctx.restore();     // release the plot-area clip

  /* ---------- corner readout, mirroring the band-diagram inset ---------- */
  ctx.font = label(11, '600');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffb347';
  const cornerX = pad.left + 8 * dpr, cornerY = pad.top + 6 * dpr;
  ctx.fillText('f(E)', cornerX, cornerY);
  ctx.fillStyle = 'rgba(138,151,196,0.85)';
  ctx.font = label(10.5);
  ctx.fillText(`kT = ${fmt(kT)} eV  ·  T = ${p.T} K`,
               cornerX + ctx.measureText('f(E)').width + 14 * dpr, cornerY);

  ctx.setTransform(1, 0, 0, 1, 0, 0);

  /* ---------- info cards ---------- */
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('fermiEf', `${fmt(Ef)} eV`);
  set('fermiKt', `${fmt(kT)} eV`);
  set('fermiEc', `${fmt(Ec)} eV`);
  set('fermiEv', `${fmt(Ev)} eV`);
  set('fermiEcOffset', `${fmt(Ec - Ef)} eV`);
  set('fermiOccEc', BANDMODEL.fermiDirac(Ec, Ef, p.T).toExponential(2));
}

/* ---------- inject overlay HTML ---------- */
export function initFermiOverlay() {
  if (fermiOverlay) return;

  fermiOverlay = document.createElement('div');
  fermiOverlay.className = 'fermi-overlay';
  fermiOverlay.setAttribute('role', 'dialog');
  fermiOverlay.setAttribute('aria-label', 'Fermi-Dirac distribution');
  fermiOverlay.innerHTML = `
    <div class="fermi-modal">
      <div class="fermi-modal-header">
        <h3 class="fermi-modal-title">Fermi-Dirac Distribution</h3>
        <button class="fermi-modal-close" type="button" aria-label="Close Fermi-Dirac view">×</button>
      </div>
      <div class="fermi-modal-body">
        <div class="fermi-canvas-wrap">
          <canvas id="fermiCanvas" aria-label="Fermi-Dirac occupation probability versus energy"></canvas>
        </div>
        <div class="fermi-info">
          <div class="fermi-info-item">
            <div class="fermi-info-label">Fermi level E_F</div>
            <div class="fermi-info-value accent" id="fermiEf">—</div>
          </div>
          <div class="fermi-info-item">
            <div class="fermi-info-label">Thermal energy kT</div>
            <div class="fermi-info-value" id="fermiKt">—</div>
          </div>
          <div class="fermi-info-item">
            <div class="fermi-info-label">Conduction edge E_C</div>
            <div class="fermi-info-value" id="fermiEc">—</div>
          </div>
          <div class="fermi-info-item">
            <div class="fermi-info-label">Valence edge E_V</div>
            <div class="fermi-info-value" id="fermiEv">—</div>
          </div>
          <div class="fermi-info-item">
            <div class="fermi-info-label">E_C − E_F separation</div>
            <div class="fermi-info-value" id="fermiEcOffset">—</div>
          </div>
          <div class="fermi-info-item">
            <div class="fermi-info-label">f(E_C) band occupancy</div>
            <div class="fermi-info-value" id="fermiOccEc">—</div>
          </div>
        </div>
        <div class="fermi-formula">
          f(E) = 1 / (1 + exp((E − E_F) / kT))
        </div>
      </div>
      <div class="fermi-modal-footer">
        Click outside or press Esc to close
      </div>
    </div>
  `;
  document.body.appendChild(fermiOverlay);

  fermiCanvas = $('fermiCanvas');
  fermiClose = $('fermiModalClose') || fermiOverlay.querySelector('.fermi-modal-close');

  // event listeners
  fermiOverlay.addEventListener('click', (e) => {
    if (e.target === fermiOverlay) closeFermi();
  });
  fermiClose.addEventListener('click', closeFermi);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fermiOverlay?.classList.contains('active')) {
      closeFermi();
    }
  });
  window.addEventListener('resize', () => {
    if (fermiOverlay?.classList.contains('active')) {
      renderFermiCanvas();
    }
  });

  // The trigger button lives in Schottky.astro and is driven by main.js (it has to
  // be positioned onto the canvas inset); we only resolve it here so closeFermi can
  // return focus to it.
  fermiBtn = $('fermiBtn');
}

/* ---------- update model reference when params change ---------- */
export function updateFermiModel(model) {
  fermiModel = model;
}
