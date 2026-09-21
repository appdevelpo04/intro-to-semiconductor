/**
 * main.js — interactive wiring for the Au | MoS₂ Schottky demo.
 *  - builds sliders from LABELS.sliders into #controls
 *  - builds preset buttons
 *  - drives bandCanvas (renderBand) + graphCanvas (renderGraph)
 *  - animates the "Make contact" / "Separate" toggle (animFrac 0↔1)
 *  - click on numbered arrows → detail panel (detail.js)
 *  - writes status bar + legend, handles window resize
 */
'use strict';

import { renderBand, renderGraph, hitTestBand, getArrowTargets } from './render.js';
import { BANDMODEL, PRESETS } from './bandmodel.js';
import { LABELS, fmt, fmtSI } from './labels.js';
import { open as openDetail, close as closeDetail } from './detail.js';

const $ = (id) => document.getElementById(id);
const bandCanvas = $('bandCanvas');
const graphCanvas = $('graphCanvas');
const controls = $('controls');
const statusBar = $('statusBar');
const legend = $('legendItems');
const contactBtn = $('contactToggle');

/* PRESET object insertion order matches LABELS.presets display order */
const PRESET_KEYS = Object.keys(PRESETS);

const params = Object.assign({}, BANDMODEL.DEFAULTS);
let animFrac = 0;              // 0 = materials separated, 1 = in contact (full bending)
let contactState = 0;          // logical state: 0 = separated, 1 = in contact
let lastModel = null;
let animRAF = null;

/* ============================ sliders ============================ */
const sliderEls = {};

function fmtVal(sdef, v) {
  if (sdef.key === 'T') return Math.round(v) + ' K';
  return (+v).toFixed(2) + ' ' + sdef.unit;
}

/* round a value to the nearest slider step (soft bound keeps the model in-range) */
function snapStep(v, step) {
  if (!step || step <= 0) return v;
  return Math.round(v / step) * step;
}

LABELS.sliders.forEach((s) => {
  const row = document.createElement('div');
  row.className = 'ctl-row';

  const lab = document.createElement('label');
  lab.className = 'ctl-label';
  lab.htmlFor = 'sl-' + s.key;
  lab.innerHTML = s.label + ' <span class="unit">[' + s.unit + ']</span>';

  const val = document.createElement('input');
  val.type = 'text';
  val.className = 'ctl-val';
  val.id = 'val-' + s.key;
  val.value = fmtVal(s, params[s.key]);
  val.setAttribute('aria-label', s.label + ' value');

  // Soft-bounded commit: clamp to [min,max], snap to the slider step, and only
  // re-render when the value actually changed (avoids double renders from the
  // change → blur sequence, which is what caused the out-of-bound lag).
  const commit = () => {
    const raw = parseFloat(val.value.replace(',', '.'));
    if (!isFinite(raw)) { syncSliders(); return; }
    const snapped = snapStep(Math.min(s.max, Math.max(s.min, raw)), s.step);
    if (snapped === params[s.key]){
      syncSliders();                 // out of effective range → just fix the text, no render
      return;
    }
    params[s.key] = snapped;
    update();
    syncSliders();
  };
  val.addEventListener('change', commit);
  val.addEventListener('blur', commit);    // covers Enter, click-away, tab
  val.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') val.blur(); });

  const inp = document.createElement('input');
  inp.type = 'range';
  inp.id = 'sl-' + s.key;
  inp.min = s.min;
  inp.max = s.max;
  inp.step = s.step;
  inp.value = params[s.key];
  inp.addEventListener('input', () => {
    params[s.key] = +inp.value;
    val.value = fmtVal(s, params[s.key]);
    // coalesce rapid drags into a single paint per frame; cancel any running
    // contact animation so it doesn't double-draw alongside slider updates
    cancelContactAnim();
    scheduleUpdate();
  });

  row.append(lab, inp, val);
  controls.appendChild(row);
  sliderEls[s.key] = { inp, val, def: s };
});

/* sync slider positions + readouts back from the params object */
function syncSliders() {
  for (const k in sliderEls) {
    const s = sliderEls[k];
    s.inp.value = params[k];
    s.val.value = fmtVal(s.def, params[k]);
  }
}

/* ============================ presets ============================ */
const presetRow = document.createElement('div');
presetRow.className = 'ctl-row ctl-presets';

LABELS.presets.forEach((name, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn-ghost preset-btn';
  b.textContent = name;
  b.addEventListener('click', () => {
    const p = PRESETS[PRESET_KEYS[i]];
    if (!p) return;
    Object.assign(params, p);
    cancelContactAnim();
    animFrac = contactState;              // presets jump to the (requested) stable state
    syncSliders();
    update();
  });
  presetRow.appendChild(b);
});
controls.appendChild(presetRow);

/* ============================ status bar ============================ */
function writeStatus(m) {
  if (!statusBar) return;
  const bh = m.barrier, dep = m.depletion, iv = m.IV, p = m.params;
  const badge = bh.isRectifying
    ? '<span class="badge rectifying">rectifying</span>'
    : '<span class="badge ohmic">ohmic (ideal)</span>';
  statusBar.innerHTML =
    badge +
    [
      '<b>Φ_B</b> = ' + fmt(bh.Phi_B) + ' eV',
      '<b>V_bi</b> = ' + fmt(bh.Vbi) + ' V',
      '<b>W</b> = ' + fmtSI(dep.W) + ' m',
      '<b>kT</b> = ' + fmt(m.kT) + ' eV',
      '<b>I_s</b> = ' + fmtSI(iv.Is) + ' A',
      '<b>I(V=' + fmt(p.bias) + ')</b> = ' + fmtSI(p.bias >= 0 ? iv.I_fwd : iv.I_rev) + ' A',
    ].map((s) => '<span class="stat-i">' + s + '</span>').join('<span class="stat-i sep">·</span>');
}

/* ============================ legend ============================ */
function buildLegend() {
  if (!legend) return;
  Object.entries(LABELS.arrows).forEach(([id, a]) => {
    const li = document.createElement('span');
    li.className = 'legend-item';
    li.dataset.id = id;
    li.innerHTML = a.label;
    li.addEventListener('click', () => { if (lastModel) openDetail(id, lastModel); });
    legend.appendChild(li);
  });
  const tip = document.createElement('div');
  tip.className = 'legend-tip';
  tip.textContent = LABELS.tip;
  legend.appendChild(tip);
}
buildLegend();

/* ============================ update ============================ */
window.__SCHOTTKY_UPDATE_COUNT = 0;
let pendingUpdate = null;                 // coalesces back-to-back updates into 1/frame
function update() {
  window.__SCHOTTKY_UPDATE_COUNT++;   // instrumentation for end-to-end tests
  lastModel = BANDMODEL.model(params);
  window.__SCHOTTKY_MODEL = lastModel;     // fallback for detail.js
  window.__SCHOTTKY_TARGETS = getArrowTargets();  // clickable arrow hit targets
  // Status FIRST: writing it can change the flex column's free space (status
  // grows from empty at boot), and the canvases below measure their wrapper
  // during fit — painting before the status settles made the graph canvas
  // keep a stale (too tall) inline size and spill over the slider rows.
  writeStatus(lastModel);
  renderBand(bandCanvas, lastModel, animFrac);
  renderGraph(graphCanvas, lastModel);
}
/* rAF-coalesced update: rapid slider drags collapse into a single paint per
   animation frame, avoiding the cumulative draw-load that froze the tab. */
function scheduleUpdate(){
  if (pendingUpdate) return;             // one already queued for this frame
  pendingUpdate = requestAnimationFrame(() => { pendingUpdate = null; update(); });
}

/* ==================== contact / separate toggle ==================== */
/* Freeze a running contact animation at the nearest stable endpoint and keep
   the button label + logical state in sync with the frozen picture. Used by
   the slider and preset handlers, which repaint with their own update(). */
function cancelContactAnim(){
  if (!animRAF) return;
  cancelAnimationFrame(animRAF);
  animRAF = null;
  contactState = animFrac >= 0.5 ? 1 : 0;
  syncContactLabel();
}
function syncContactLabel(){
  contactBtn.textContent = contactState ? 'Separate' : 'Make contact';
}
/* test hook: precise animation state for scripts/validate-contact.js */
window.__SCHOTTKY_GET_STATE = () => ({
  frac: animFrac,
  animating: animRAF != null,
  contact: contactState === 1,
});

contactBtn.addEventListener('click', () => {
  // Target derives from the LOGICAL contact state, not the fractional anim
  // value: a click mid-animation must always reverse the last requested
  // direction. (The old `animFrac >= 1 ? 0 : 1` ignored clicks made while
  // the animation was in flight — e.g. a second click during the opening
  // animation never reversed, and the label could desync from the picture.)
  const target = contactState ? 0 : 1;
  contactState = target;                 // requested state, not the animated one
  contactBtn.textContent = target === 1 ? 'Separate' : 'Make contact';
  const from = animFrac;
  const dur = 700;
  const t0 = performance.now();
  if (animRAF) cancelAnimationFrame(animRAF);

  const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
  const step = (now) => {
    const u = Math.min(1, (now - t0) / dur);
    animFrac = from + (target - from) * easeInOut(u);
    if (lastModel) renderBand(bandCanvas, lastModel, animFrac);
    if (u < 1) animRAF = requestAnimationFrame(step);
    else { animRAF = null; animFrac = target; }   // land EXACTLY on 0 or 1
  };
  animRAF = requestAnimationFrame(step);
});

/* ==================== arrow click → detail panel ==================== */
bandCanvas.addEventListener('click', (ev) => {
  if (!lastModel) return;
  const id = hitTestBand(ev.offsetX, ev.offsetY);
  if (id) openDetail(id, lastModel);
});
$('detailClose').addEventListener('click', closeDetail);

/* ============================ resize ============================ */
let rsT = null;
window.addEventListener('resize', () => {
  clearTimeout(rsT);
  rsT = setTimeout(update, 120);
});

/* ============================ boot ============================ */
contactBtn.textContent = 'Make contact';
update();