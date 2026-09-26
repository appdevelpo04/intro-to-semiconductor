/**
 * flow-main.js — page wiring for the electron-flow animation.
 *
 * Responsibilities (mirroring main.js for the Schottky page):
 *   - own the timeline clock and drive renderFlow + advance together
 *   - play / pause / replay, scrub, stage chips, keyboard
 *   - respect prefers-reduced-motion by defaulting to paused
 *   - publish test hooks (window.__FLOW_*) for scripts/flow-e2e.js
 *   - handle resize / ResizeObserver
 *
 * The clock advances `t` and calls advance() with the SAME t, so the particles
 * and the model can never disagree: there is no second source of time.
 */
'use strict';

import 'katex/dist/katex.min.css';   // KaTeX fonts (bundled by Vite)
import { renderFlow, RENDER_STATS } from './flow-render.js';
import { flowModel, stageAt, clampT, FLOW_STAGES, stageStart, BANDMODEL } from './flow-model.js';
import { createState, advance, syncTo, snapshot } from './flow-particles.js';
import { renderMathIn } from './math.js';

const $ = (id) => document.getElementById(id);
const canvas = $('flowCanvas');
const wrap = $('flowWrap');
const playBtn = $('flowPlay');
const replayBtn = $('flowReplay');
const scrub = $('flowScrub');
const tval = $('flowTval');
const stageList = $('flowStages');

const params = { ...BANDMODEL.DEFAULTS };

/* ---------- clock state ---------- */
/* Total wall time for one full playthrough. The transient (stage C) is only
   40% of the timeline, so at 9 s the peak electron flow lasts ~3.6 s — long
   enough to read, short enough not to bore. */
const DURATION_MS = 9000;
const SCRUB_MAX = 1000;

let t = 0;                 // model time 0..1
let playing = false;
let rafId = null;
let lastTs = 0;
let lastModel = null;
let lastGeom = null;

/* Seeded, so a replay is identical every time — the same guarantee the
   headless render check relies on. */
const SEED = 20260926;
const parts = createState(params, { count: 64, seed: SEED });

const prefersReduced =
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/* ==================== stage chips ==================== */
const stageButtons = [];
if (stageList) {
  FLOW_STAGES.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'flow-stage';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flow-stage-btn';
    btn.dataset.stage = s.id;
    const id = document.createElement('span');
    id.className = 'flow-stage-id';
    id.textContent = s.id;
    const label = document.createElement('span');
    label.className = 'flow-stage-label';
    label.textContent = s.label;
    const blurb = document.createElement('span');
    blurb.className = 'flow-stage-blurb';
    blurb.textContent = s.blurb;
    btn.append(id, label, blurb);
    btn.addEventListener('click', () => { pause(); seek(stageStart(s.id)); });
    li.appendChild(btn);
    stageList.appendChild(li);
    stageButtons.push(btn);
  });
}

function syncStages() {
  const st = stageAt(t);
  stageButtons.forEach((b, i) => {
    const active = i === st.index;
    b.classList.toggle('active', active);
    b.setAttribute('aria-current', active ? 'step' : 'false');
  });
}


/* ==================== paint ==================== */
function paint() {
  if (!canvas) return;
  lastModel = flowModel(params, t);
  lastGeom = renderFlow(canvas, lastModel, parts, { thermal: true });
  if (scrub && document.activeElement !== scrub) scrub.value = String(Math.round(t * SCRUB_MAX));
  if (tval) tval.textContent = 't = ' + t.toFixed(2);
  syncStages();
  /* Published AFTER the paint, so a test can never read a half-updated frame. */
  window.__FLOW_GEOM = lastGeom;
  window.__FLOW_MODEL = lastModel;
  window.__FLOW_SNAP = snapshot(parts, t);
}

/* ==================== clock ==================== */
function loop(ts) {
  if (!playing) { rafId = null; return; }
  if (!lastTs) lastTs = ts;
  const dt = Math.min(ts - lastTs, 120);      // clamp: a backgrounded tab must not jump
  lastTs = ts;
  t = clampT(t + dt / DURATION_MS);
  advance(parts, t);            // same t as the model — one clock, no drift
  paint();
  if (t >= 1) { pause(); return; }
  rafId = requestAnimationFrame(loop);
}

function play() {
  if (t >= 1) seek(0);          // at the end, play restarts from the top
  playing = true;
  lastTs = 0;
  if (playBtn) {
    playBtn.textContent = 'Pause';
    playBtn.setAttribute('aria-label', 'Pause the animation');
  }
  if (rafId == null) rafId = requestAnimationFrame(loop);
}

function pause() {
  playing = false;
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  if (playBtn) {
    playBtn.textContent = 'Play';
    playBtn.setAttribute('aria-label', 'Play the animation');
  }
}

/* A seek is a teleport, not a transition: resync the particles instead of
   animating them there, so scrubbing never fabricates crossings the user never
   watched (asserted in flow-sim-check.js S6). */
function seek(target) {
  t = clampT(target);
  syncTo(parts, t);
  paint();
}

playBtn?.addEventListener('click', () => (playing ? pause() : play()));
replayBtn?.addEventListener('click', () => { seek(0); play(); });

scrub?.addEventListener('input', () => {
  pause();
  seek(Number(scrub.value) / SCRUB_MAX);
});

/* ==================== keyboard ==================== */
document.addEventListener('keydown', (ev) => {
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;   // don't hijack the scrub
  if (ev.key === ' ' || ev.code === 'Space') {
    ev.preventDefault();
    playing ? pause() : play();
  } else if (ev.key === 'ArrowRight') {
    ev.preventDefault();
    pause();
    const i = stageAt(t).index;
    seek(i >= FLOW_STAGES.length - 1 ? 1 : stageStart(FLOW_STAGES[i + 1].id));
  } else if (ev.key === 'ArrowLeft') {
    ev.preventDefault();
    pause();
    const i = stageAt(t).index;
    /* Step to the START of this stage, or the previous one if already there. */
    seek(i === 0 ? 0 : (t - stageStart(FLOW_STAGES[i].id) < 1e-6
      ? stageStart(FLOW_STAGES[i - 1].id) : stageStart(FLOW_STAGES[i].id)));
  } else if (ev.key >= '1' && ev.key <= '4') {
    ev.preventDefault();
    pause();
    seek(stageStart(FLOW_STAGES[Number(ev.key) - 1].id));
  }
});

/* ==================== resize ==================== */
let rsT = null;
window.addEventListener('resize', () => {
  clearTimeout(rsT);
  rsT = setTimeout(paint, 120);
});
/* The canvas is absolutely positioned, so it contributes no layout: a change in
   the wrapper's box (scrollbar, font metrics) would otherwise leave a stale
   backing store. Observe the real box and repaint. */
if ('ResizeObserver' in window && wrap) {
  const ro = new ResizeObserver(() => paint());
  ro.observe(wrap);
}

/* ==================== test hooks ==================== */
/* lastGeom is the geometry snapshot renderFlow already returns. Exposing it
   lets a test ask "where on the canvas is the metal?" instead of hardcoding
   pixel rectangles, which silently rot whenever the layout changes. */
window.__FLOW_GET_STATE = () => ({
  t, playing, stage: stageAt(t).id,
  frac: lastModel ? lastModel.charge.f : 0,
  netFlux: lastModel ? lastModel.flux.net : 0,
  balanced: lastModel ? lastModel.flux.balanced : false,
  metal: parts.settled, count: parts.count, crossings: parts.crossings,
  inFlight: parts.dots.filter((d) => d.moving).length,
  /* what the last frame drew: the radius of a crossing electron vs a resident one */
  hotR: RENDER_STATS.hotR, residentR: RENDER_STATS.residentR,
  geo: lastGeom,
});
window.__FLOW_SEEK = seek;
window.__FLOW_PLAY = play;
window.__FLOW_PAUSE = pause;

/* ==================== boot ==================== */
renderMathIn(document);

/* Reduced motion: start PAUSED (never autoplay), but on the COMPLETED state,
   not on t = 0.

   The old boot did seek(0) then pause(), which froze the page on stage A —
   "Separated" — where the metal is still completely empty, no charge has moved
   and nothing is flowing. For a reduced-motion visitor that static frame was
   the ONLY thing they ever saw, and it reads as a broken or blank diagram
   rather than a deliberate still. Showing the equilibrium frame instead is just
   as motionless, and it is the frame that actually answers the question the
   page exists to answer ("what does the finished contact look like?"): the
   metal is populated, the depletion region is formed, and the flux is balanced.
   Stage A is still one keypress away via the 1–4 jump buttons and the
   scrubber, so nothing becomes unreachable. */
if (prefersReduced) {
  seek(1);
  pause();
} else {
  seek(0);
  play();
}
