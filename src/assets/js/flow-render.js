/**
 * flow-render.js — canvas painter for the contact-formation animation.
 *
 * Mirrors render.js's conventions (same fitCanvas/geom helpers, same palette
 * family, CSS-pixel rendering) so the two canvases in the project look like
 * siblings. Pure drawing: every number arrives already computed from
 * flow-model.js, and the electron positions come from flow-particles.js.
 *
 * WHAT IS DRAWN, and why each piece is there:
 *   • the two slabs, which physically APPROACH each other (a real vacuum gap at
 *     t=0) — the position axis is only meaningful if the gap is visible;
 *   • the band edges, bending by exactly what the model says;
 *   • the depletion region, shaded, with exposed donor ions as (+) marks;
 *   • the electrons, as dots whose population tracks the transferred charge;
 *   • the barrier at the interface, and the flux arrows — BIDIRECTIONAL at
 *     equilibrium, because the net current there is exactly zero.
 */
'use strict';

import { stageAt } from './flow-model.js';
import { SIDE_METAL, SIDE_SEMI } from './flow-particles.js';
import { BANDMODEL } from './bandmodel.js';
import { fmt } from './labels.js';

/* ---------- palette (aligned with render.js) ---------- */
const C = {
  bg: '#0e1529', grid: 'rgba(138,151,196,0.10)', gridS: 'rgba(138,151,196,0.22)',
  metalFill: 'rgba(255,215,0,0.16)', metalLine: '#ffd633', metalTxt: '#ffe9a8',
  semiFill: 'rgba(90,170,255,0.07)', semiLine: '#7fb4ff', semiTxt: '#cfe6ff',
  cb: '#5aaaff', vb: '#c084fc', fermi: '#ffb347', barrier: '#ff6b6b',
  vbi: '#3df0c0', vacuum: 'rgba(138,151,196,0.45)',
  depFill: 'rgba(138,151,196,0.13)', depLine: 'rgba(138,151,196,0.42)',
  electron: '#5aaaff', electronHot: '#bfe3ff', donor: '#ffb347',
  fluxFwd: '#00e5b0', fluxRev: 'rgba(255,179,71,0.75)', netZero: '#8a97c4',
  textDim: 'rgba(138,151,196,0.7)', textFaint: 'rgba(138,151,196,0.45)',
};

/* Half-width, in kT, of the energy window the drawn metal electrons are
   sampled over. ±6 kT is where Fermi–Dirac is actually interesting: at 6 kT
   above E_F the occupation is e⁻⁶ = 0.25%, so the window's top edge is already
   effectively empty, while its bottom edge is deep in the filled sea. Wider
   would just bury the cloud further below the line without showing anything
   new; narrower would clip the hot tail the reference figure draws above it. */
const METAL_WINDOW_KT = 6;

/* ---------- canvas sizing (same contract as render.js) ----------
   Backing store only; CSS owns the display box (see .canvas-wrap canvas in
   global.css). Rendered in CSS pixels via the setTransform below, so Retina
   canvases do not draw into the upper-left 1/DPR box.

   NOTE the ROUND (not floor) on the CSS size. `Math.floor` truncated a
   fractional box first and the subsequent round() then lost another 2px at
   DPR 3, leaving the backing store short of CSS×DPR (measured 1170×1173 vs
   1170×1175 on a 390×844 phone) — a sub-pixel unpainted strip along an edge. */
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.parentElement.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(cv.width / w, 0, 0, cv.height / h, 0, 0);
  return { ctx, w, h };
}

function geom(w, h) {
  /* pad.bottom holds the caption row (which word-wraps to at most 2 lines) plus
     the five live readout lines (12px each), all of which used to run off the
     bottom of the canvas. */
  const pad = { left: 74, right: 24, top: 26, bottom: 84 };
  return {
    W: w, H: h, pad,
    innerW: Math.max(1, w - pad.left - pad.right),
    innerH: Math.max(1, h - pad.top - pad.bottom),
  };
}

const MONO = (px, weight) => `${weight || ''} ${px}px "JetBrains Mono", monospace`.trim();

/* ---------- arrow primitive ---------- */
function arrow(ctx, x0, y0, x1, y1, color, width = 1.6, head = 6, dash = null) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.setLineDash([]);
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(a - 0.42), y1 - head * Math.sin(a - 0.42));
  ctx.lineTo(x1 - head * Math.cos(a + 0.42), y1 - head * Math.sin(a + 0.42));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}


/* ---------- crossing progress ---------- */
/**
 * Fraction of its journey a crossing electron has completed, 0 → 1.
 *
 * flow-particles keeps the REMAINING journey in `d.carry`, in t-units. d.u is
 * also rewritten during a crossing, but it is the normalised position inside
 * the ORIGIN side, not the crossing itself — so reading x from d.u is what made
 * crossing electrons slide away from the junction instead of over it. The
 * render derives the fraction from carry and lerps x across the interface.
 */
function progress(d) {
  const total = d.carryTotal || 0;
  if (!(total > 0)) return Math.min(1, Math.max(0, (d.u - 0.02) / 0.98));
  return Math.min(1, Math.max(0, 1 - d.carry / total));
}

/* =====================================================
   1.  MAIN ENTRY
   ===================================================== */

/**
 * Paint one frame.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} model  flowModel(params, t) snapshot
 * @param {object} parts  flow-particles state (dots)
 * @param {object} [opts]
 * @param {boolean} [opts.thermal=true]  draw the idle electron jitter
 * @returns {object} a detached geometry snapshot for the e2e tests
 */
/* What the last frame actually drew. Exported so a test can assert the crossing
   electron is rendered large enough for a person to see, without having to
   infer it from canvas pixels polluted by the curves and the population. */
export const RENDER_STATS = { hotR: 0, residentR: 0 };

export function renderFlow(canvas, model, parts, opts = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  RENDER_STATS.hotR = 0;
  RENDER_STATS.residentR = 0;
  /* ---- two panels: full view (left) + magnified junction (right) ------
     WHY: measured on the single-panel version, the junction was a ~30px zone
     inside a 1500px canvas — 2% of the width — and a 3.4px electron is 23% of
     THAT, so the flow was a few pixels wide and effectively invisible. The
     reference figure solves this by drawing the junction magnified. Splitting
     the canvas gives the interesting physics half the frame while the full
     view keeps the context ("where is this happening?").
     Split only when the canvas is wide enough to afford it; below that the
     single full-width view is more readable than two cramped panels. */
  const SPLIT_MIN_W = 430;                 // per-panel width still worth splitting
  const split = w >= SPLIT_MIN_W * 2 + 24;
  const GUTTER = 24;
  const fullW = split ? Math.floor((w - GUTTER) * 0.5) : w;
  const zoomW = split ? w - GUTTER - fullW : 0;

  const g = geom(fullW, h);
  const p = model.params;
  const lv = model.levels;
  const ct = model.charge;
  const st = stageAt(model.t);
  const thermal = opts.thermal !== false;

  /* Clear the whole BACKING STORE before drawing.
     Two traps this avoids:
       • a translucent fillRect is not a clear — it composites over the previous
         frame, and the page reuses one canvas for the entire animation;
       • ctx already carries the CSS-pixel transform from fitCanvas, so a
         clearRect measured in CSS pixels covers only part of a DPR-scaled
         store. Reset to identity first and clear in device pixels.
     Idempotent: repainting the same frame must not shift a single pixel. */
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  const full = drawFullPanel(ctx, g, model, parts, { thermal, w: fullW, h, originX: 0 });
  let zoom = null;
  if (split) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(fullW + GUTTER, 0, zoomW, h);
    ctx.clip();
    ctx.translate(fullW + GUTTER, 0);
    zoom = drawZoomPanel(ctx, geom(zoomW, h), model, parts, { thermal, w: zoomW, h });
    ctx.restore();
  }

  /* Geometry snapshot for the e2e suite — detached, one completed frame. */
  return {
    t: model.t, stage: st.id, w, h, split,
    fullWidth: fullW,
    zoomWidth: zoomW,
    junctionX: full.junctionX,
    metalBox: full.metalBox, semiBox: full.semiBox,
    depletionW: full.depletionW,
    electronCount: full.electronCount,
    crossing: full.crossing,
    densityPeakX: full.densityPeakX,
    densityPeakVal: full.densityPeakVal,
    zoomElectronCount: zoom ? zoom.electronCount : 0,
    zoomCrossing: zoom ? zoom.crossing : 0,
    zoomDepletionW: zoom ? zoom.depletionW : 0,
    electronBoxes: full.electronBoxes,
    ecBulkY: full.ecBulkY,
    distBox: full.distBox,
    zoomElectronBoxes: zoom ? zoom.electronBoxes : [],
    zoomEcBulkY: zoom ? zoom.ecBulkY : null,
  };
}

/**
 * The full-width view: both slabs, the whole energy range, the density strip.
 * Everything here draws in LOCAL coordinates (0,0 = this panel's top-left).
 */
function drawFullPanel(ctx, g, model, parts, o) {
  const p = model.params;
  const lv = model.levels;
  const ct = model.charge;
  const st = stageAt(model.t);
  const thermal = o.thermal;
  const w = o.w, h = o.h;

  /* Panel background. (The backing store is cleared once, in renderFlow.) */
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  /* ---- energy window: FIXED for the whole animation -------------------
     Deliberately not recomputed per frame. A window that tracked the moving
     bands would make the diagram appear to zoom, which reads as the energy
     scale changing rather than the bands bending. One window covers every
     reachable edge, with margin.

     The lower bound MUST include E_V. The lowest point the valence band ever
     reaches is the equilibrium BULK edge:
         E_C,bulk = −Φ_m + ΔE = −5.10 + 0.15 = −4.95 eV
         E_V,bulk = −4.95 − 1.80   = −6.75 eV
     With the original Emin = −6.6 that edge fell OUTSIDE the plot, so its line
     and label were drawn below the axes, on top of the caption and the live
     readouts. Hence −7.0, which leaves margin under −6.75. */
  const Emin = -7.0, Emax = 0.5;
  const Y = (E) => g.pad.top + g.innerH * (1 - (E - Emin) / (Emax - Emin));

  /* ---- horizontal layout: the slabs APPROACH ---------------------------
     At t=0 there is a real vacuum gap; it closes during stage B. The
     semiconductor rides right, so the junction lands at midX once closed. */
  const gapMax = 0.22 * g.innerW;
  const closed = st.key === 'separated' ? 0 : (st.key === 'contact' ? st.u : 1);
  const gap = gapMax * (1 - closed);
  const metalX0 = g.pad.left;
  const metalX1 = g.pad.left + 0.34 * g.innerW;
  const midX = metalX1 + gap;                     // the junction
  const semiX0 = midX;
  const semiX1 = g.pad.left + g.innerW + gap;

  drawGrid(ctx, g, Y, Emin, Emax);

  /* ---- depletion zone, under the bands -------------------------------- */
  /* Width follows W(t) = W_eq·√f, the same f the particles read. */
  const depW = 0.26 * g.innerW * Math.sqrt(Math.max(ct.f, 0));
  if (depW > 0.5) {
    ctx.save();
    ctx.fillStyle = C.depFill;
    ctx.fillRect(semiX0, g.pad.top, depW, g.innerH);
    ctx.strokeStyle = C.depLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(semiX0 + 0.5, g.pad.top + 0.5, depW - 1, g.innerH - 1);
    ctx.restore();
  }

  drawSlabs(ctx, g, { metalX0, metalX1, semiX0, semiX1, Y, lv, p, midX });
  drawBands(ctx, g, { semiX0, semiX1, depW, Y, lv, p, model, midX });
  /* The distribution the electrons are sampled from — drawn over the bands but
     under the electrons, and only where the right-hand gutter is clear of them. */
  const distBox = drawEnergyDist(ctx, g, { semiX0, semiX1, Y, lv, p });
  const electronBoxes = drawElectrons(ctx, g, { parts, midX, metalX0, metalX1, semiX0, semiX1, Y, lv, p, ct, thermal });
  drawDonors(ctx, g, { semiX0, depW, Y, p, ct });
  const density = drawDensity(ctx, g, { model, metalX0, metalX1, semiX0, semiX1, midX, g, ct });
  drawFlux(ctx, g, { model, midX, Y, lv, metalX1 });
  drawAnnotations(ctx, g, { model, parts, midX, Y, lv, p, ct, w, h });

  /* Geometry snapshot for the e2e suite — detached, one completed frame. */
  return {
    t: model.t, stage: st.id, w, h, junctionX: midX,
    metalBox: { x: metalX0, y: g.pad.top, w: metalX1 - metalX0, h: g.innerH },
    semiBox: { x: semiX0, y: g.pad.top, w: semiX1 - semiX0, h: g.innerH },
    depletionW: depW,
    electronCount: electronBoxes.length,
    crossing: electronBoxes.filter((b) => b.moving).length,
    /* Drawn geometry for the physics assertions: every shell's ACTUAL centre,
       plus the pixel row of the conduction-band edge in this panel's own
       energy scale. Tests use these to prove no electron is drawn in the gap —
       a colour probe cannot do that, because C.electron and C.cb are the same
       #5aaaff and the E_C curve itself would read as an electron. */
    electronBoxes,
    ecBulkY: Y(lv.Ec_bulk),
    distBox,
    densityPeakX: density ? density.peakX : null,
    densityPeakVal: density ? density.peakVal : null,
  };
}


/* =====================================================
   1b.  MAGNIFIED JUNCTION PANEL  (the point of the split)
   ===================================================== */

/**
 * The junction, magnified — this is the panel that makes the flow visible.
 *
 * The full view answers "where is this happening?"; this one answers "what
 * actually happens?". At a scale where each element is legible it shows:
 *
 *   • the electron stream crossing the interface, one shell per lane, with a
 *     motion trail so the direction is unmistakable;
 *   • the depletion region visibly EMPTYING — a "+" donor sits exactly where an
 *     electron departed, which is the mechanism behind the whole figure;
 *   • the barrier Φ_B drawn as a hatched wall the electrons must climb;
 *   • the metal's growing electron population on the left.
 *
 * The energy window is TIGHTER than the full view (the E_C region only) so the
 * band bending and barrier are large enough to read, and the shells are ~2×
 * bigger. Nothing here is schematic: every value comes from the same model
 * snapshot the full view uses.
 */
function drawZoomPanel(ctx, g, model, parts, o) {
  const p = model.params;
  const lv = model.levels;
  const ct = model.charge;
  const st = stageAt(model.t);
  const w = o.w, h = o.h;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  /* Tighter energy window: the conduction band and the barrier only. */
  const Emin = -5.6, Emax = -4.0;
  const Y = (E) => g.pad.top + g.innerH * (1 - (E - Emin) / (Emax - Emin));

  drawGrid(ctx, g, Y, Emin, Emax);

  /* The interface is a mathematical POINT once the gap closes: metalX1 and
     semiX0 both land on midX, so a crossing particle can only travel a few px
     between them. Measured on the single-panel version, that was 12px — which
     is why the flow was invisible no matter how the canvas was split. This panel
     therefore treats the horizontal axis as MAGNIFIED about the interface: the
     crossing lane gets a fixed, generous width so the transfer is watchable,
     and the panel caption says the scale is magnified rather than implying a
     true 1:1 distance. The ENERGY axis, by contrast, stays exact. */
  const CROSS = 0.15 * g.innerW;
  const closed = st.key === 'separated' ? 0 : (st.key === 'contact' ? st.u : 1);
  const gap = 0.10 * g.innerW * (1 - closed);
  const metalX0 = g.pad.left;
  const midX = g.pad.left + 0.5 * g.innerW;          // interface, centred
  const metalX1 = midX - CROSS - gap;                // metal face
  const semiX0 = midX + CROSS;                       // semiconductor face
  const semiX1 = g.pad.left + g.innerW + gap;
  /* The depletion width is a FRACTION OF THIS PANEL'S OWN SLAB, not of the
     canvas. It used to be 0.40·innerW, but the zoom's semiconductor slab is
     only ~0.35·innerW wide, so at high f the shaded region consumed the slab
     and left a ~15px sliver: every resident electron was pushed into that
     sliver and clipped at the panel edge, and the semiconductor read as empty
     at exactly the moment the emptying is the story. */
  const depRaw = 0.55 * (semiX1 - semiX0) * Math.sqrt(Math.max(ct.f, 0));
  const depW = Math.min(depRaw, (semiX1 - semiX0) * 0.72);

  /* --- depletion zone, generous so the emptying is obvious --- */
  if (depW > 0.5) {
    ctx.fillStyle = C.depFill;
    ctx.fillRect(semiX0, g.pad.top, depW, g.innerH);
    ctx.strokeStyle = C.depLine;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(semiX0 + 0.5, g.pad.top + 0.5, depW - 1, g.innerH - 1);
    ctx.setLineDash([]);
  }

  drawSlabs(ctx, g, { metalX0, metalX1, semiX0, semiX1, Y, lv, p, midX });

  /* --- bands, from the model's own profile (same source as the full view) */
  {
    const prof = model.profile;
    const span = Math.min(depW * 1.1 + g.innerW * 0.34, g.innerW);
    const xAt = (dist) => semiX0 + (dist / 1.6) * span;
    const ec = [], ev = [];
    for (const r of prof) {
      const x = xAt(r.dist);
      if (x > semiX1) break;
      ec.push([x, Y(r.Ec)]); ev.push([x, Y(r.Ev)]);
    }
    if (ec.length) { ec.push([semiX1, ec[ec.length - 1][1]]); ev.push([semiX1, ev[ev.length - 1][1]]); }
    const stroke = (pts, color, lw) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    };
    stroke(ev, C.vb, 2.4);
    stroke(ec, C.cb, 2.4);
  }

  /* --- the metal's E_F, flat: a metal's Fermi level never bends.
     It stops just past the interface. Drawn to semiX0 + 0.5·innerW it ran the
     full panel width, so the orange line cut straight through the
     semiconductor slab and read as the semiconductor's Fermi level as well. */
  const yFm = Y(lv.Ef_m);
  ctx.strokeStyle = C.fermi;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(g.pad.left, yFm);
  ctx.lineTo(midX + CROSS * 0.3, yFm);
  ctx.stroke();
  ctx.font = MONO(10, '600');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.fermi;
  ctx.fillText('E_F', g.pad.left + 3, yFm - 6);

  /* --- the barrier Φ_B, as a hatched WALL to climb ---
     Centred ON the interface (midX), which is where the band spike is. It used
     to sit at midX − 26, i.e. inside the metal, so the wall the electrons climb
     was not where the bands actually bend. */
  const yEcI = Y(lv.Ec_interface);
  {
    const bw = 13, bx = midX - bw / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, yEcI, bw, Math.max(2, yFm - yEcI));
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,107,107,0.5)';
    ctx.lineWidth = 1;
    for (let yy = yEcI - bw; yy < yFm + bw; yy += 5) {
      ctx.beginPath(); ctx.moveTo(bx, yy); ctx.lineTo(bx + bw, yy + bw); ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = C.barrier;
    ctx.lineWidth = 1.3;
    ctx.strokeRect(bx + 0.5, yEcI + 0.5, bw, Math.max(2, yFm - yEcI));
    ctx.font = MONO(9.5, '600');
    ctx.textAlign = 'center';
    ctx.fillStyle = C.barrier;
    ctx.fillText('Φ_B', bx + bw / 2, yEcI - 6);
  }

  /* --- electrons, magnified -------------------------------------------
     Same population and the same crossing math as the full view
     (progress() + the same lerp), only ~2× larger. The full view supplies
     context; this is where the transfer is actually countable. */
  /* Shell radius tracks the panel width. Fixed at 6.4 it was 30% too wide for a
     ~500px panel, so the packed grid needed more rows than the metal box had
     height and collapsed into overlapping shells again — the very defect the
     grid exists to remove. */
  const R = Math.max(3.2, Math.min(6.4, g.innerW / 62));
  const yEcB = Y(lv.Ec_bulk + 0.10);
  const kT = BANDMODEL.THERMAL_V(p.T);
  /* Resident electrons, PACKED rather than scattered.
     Scattering them by (u, v) put ~64 shells of radius 6 into a box only ~20px
     tall, i.e. an area barely larger than the shells themselves — they merged
     into a single unreadable caterpillar along E_F. Laying them out on a
     staggered grid of the same total area makes every shell individually
     countable, which is the whole point of the magnified panel. The grid is
     sized from the actual population, so it stays packed at every f. */
  const packGrid = (n, x0, x1, yTop, yBot) => {
    const bw = x1 - x0, bh = yBot - yTop;
    if (!(n > 0) || bw <= 0 || bh <= 0) return [];
    /* CAPACITY-BASED packing: show as many shells as the box can hold at the
       nominal step, never more. The earlier version squeezed all n into the
       box by shrinking the row pitch, which quietly reintroduced the overlap
       the grid exists to prevent once the panel got narrow. Capping the count
       instead guarantees the invariant at every size: no two shells ever
       touch. The zoom is a detail view, and a countable subset beats an
       illegible complete one; the full view always shows the true total. */
    const step = R * 2 + 3;
    const cols = Math.max(1, Math.floor(bw / step));
    const rows = Math.max(1, Math.floor(bh / step));
    const cap = cols * rows;
    const nShow = Math.min(n, cap);
    const out = [];
    for (let i = 0; i < nShow; i++) {
      const c = i % cols, r = (i / cols) | 0;
      const stagger = (r % 2) ? step / 2 : 0;
      /* BOTTOM-UP: row 0 sits against yBot and rows climb from there. A box
         whose floor is E_C — or the bottom of the filled sea — therefore fills
         from the OCCUPIED edge upward, so the block sits ON the band edge
         instead of hanging off into the empty side of the band, which is what
         top-down packing did: it put the fullest row against the empty side,
         i.e. it drew an inverted density.

         What this grid deliberately does NOT show is the distribution's exact
         shape. n(E) is so concentrated that ~74% of the electrons fall within
         the first 1.4 kT — under one row — and no equal-size, non-overlapping
         circles can be both countable and proportional to that. The full view
         carries the true shape (dots sampled per electron, plus the n(E)
         inset); this panel's job is that the transfer is COUNTABLE. Capacity is
         untouched: rows·step ≤ bh still bounds how far r can climb, so no shell
         can cross either edge. */
      out.push([x0 + R + c * step + stagger, yBot - R - r * step]);
    }
    return out;
  };

  const boxes = [];
  const metalDots = parts.dots.filter((d) => d.side === SIDE_METAL);
  const semiDots = parts.dots.filter((d) => d.side === SIDE_SEMI && !d.moving);

  /* --- metal: TWO boxes, split at E_F by the real Fermi weight ------------
     One box straddling E_F and filling top-down put its first row on the EMPTY
     side of the distribution: about 20% of the shells were drawn above the line
     where f(E) over this window allows ~6%, and the row nearest the top was the
     fullest, i.e. an inverted density. So the box is cut at E_F and each half
     fills from its own occupied edge. How many shells go above is not a choice:
     it is fermiWeightAbove() evaluated over the actual pixel window, so the
     drawn split is the integral of f(E) and cannot drift from the curve. */
  const pxPerKt = (g.innerH / (Emax - Emin)) * kT;       // px per kT on this axis
  const xBelowKt = (R * 13) / pxPerKt;                  // deep-sea depth of the box
  const xAboveKt = (R * 3.5) / pxPerKt;                 // how far it pokes above E_F
  const wAbove = BANDMODEL.fermiWeightAbove(-xBelowKt, xAboveKt);
  /* Hottest first, so the shells the upper box cannot fit are the marginal
     ones just above the line — they fall back below rather than the deep,
     unambiguous sea residents being the ones dropped. */
  const byHeat = [...metalDots].sort((a, b) => b.q - a.q);
  const nAboveWant = Math.round(metalDots.length * wAbove);
  const metalAbove = packGrid(nAboveWant, metalX0 + 6, metalX1 - 8, yFm - R * 3.5, yFm);
  const aboveDots = byHeat.slice(0, metalAbove.length);
  const aboveSet = new Set(aboveDots);
  const belowDots = metalDots.filter((d) => !aboveSet.has(d));
  /* The sea is R*13 deep rather than R*11 so that five rows fit at every panel
     width this ships at; without that the split silently cost ~10 shells. */
  const metalBelow = packGrid(belowDots.length, metalX0 + 6, metalX1 - 8, yFm, yFm + R * 13);

  /* Semiconductor residents live IN THE CONDUCTION BAND, so their box is the
     conduction band: from E_C up through TAIL_MAX_KT·kT of Boltzmann tail. The
     old box ran from E_C down to E_F, which in an n-type semiconductor is the
     BAND GAP — the picture claimed a population sitting in forbidden states.
     They start past the depletion edge, because the region itself is empty. */
  const semiGrid = packGrid(semiDots.length,
    semiX0 + depW + 8, semiX1 - 8,
    Y(lv.Ec_bulk + BANDMODEL.TAIL_MAX_KT * kT), Y(lv.Ec_bulk));

  /* Index each resident once, rather than indexOf() per dot (O(n²) and, worse,
     silently wrong if a dot ever appears twice). packGrid is capacity-capped,
     so grid[i] can be undefined for the overflow — those dots have no slot and
     are simply not drawn in the zoom (the full view still shows them all). */
  const slot = new Map();
  aboveDots.forEach((d, i) => { if (metalAbove[i]) slot.set(d, metalAbove[i]); });
  belowDots.forEach((d, i) => { if (metalBelow[i]) slot.set(d, metalBelow[i]); });
  semiDots.forEach((d, i) => { if (semiGrid[i]) slot.set(d, semiGrid[i]); });

  for (const d of parts.dots) {
    const hot = d.moving;
    let x, y;
    if (hot) {
      /* Right → left across the interface, over the MAGNIFIED lane so the
         travel is wide enough to actually watch. Identical rule to the full
         view, which uses its own (unmagnified) faces. */
      const prog = progress(d);
      x = semiX0 + (metalX1 - semiX0) * prog;
      if (prog < 0.5) {
        const f = prog / 0.5;
        /* Start from this electron's own thermal energy in the conduction
           band, exactly as the full view does, so a mover is continuous with
           the resident cloud it just left instead of springing from a fixed
           midpoint that may be below E_C. */
        const yEc = Y(BANDMODEL.sampleTailEnergy(d.q, lv.Ec_bulk, p.T));
        y = yEc * (1 - f) + yEcI * f;
      } else {
        const f = (prog - 0.5) / 0.5;
        y = yEcI * (1 - f) + yFm * f;
      }
    } else {
      const s = slot.get(d);
      if (!s) continue;
      x = s[0]; y = s[1];
    }
    if (!isFinite(x) || !isFinite(y)) continue;
    /* A crossing electron is THE thing this page exists to show, so it is drawn
       as a big bright sphere rather than a bare wireframe. The earlier 1.4x
       wireframe measured 177 pure-white pixels for a lone crossing electron —
       technically drawn, invisible in practice. A filled core gives the eye
       something solid to track and makes the size measurable. */
    const r = hot ? R * 2.6 : R;
    /* Record what the renderer ACTUALLY drew, so a test can assert the crossing
       electron is big enough to see. Measuring this in pixels from the canvas is
       unreliable — the lane also holds the E_C curve, the barrier and the
       semiconductor population, whose combined blob is larger than one electron
       no matter how small the electron is. See scripts/flow-e2e.js E11g. */
    if (hot && r > RENDER_STATS.hotR) RENDER_STATS.hotR = r;
    if (!hot) RENDER_STATS.residentR = r;

    if (hot) {
      /* Long, bright trail: it makes the direction unmistakable and gives the
         eye a large feature to follow between two shells. */
      const len = 72;
      const grad = ctx.createLinearGradient(x, y, x + len, y);
      grad.addColorStop(0, 'rgba(140,200,255,0.85)');
      grad.addColorStop(0.5, 'rgba(91,170,255,0.35)');
      grad.addColorStop(1, 'rgba(91,170,255,0)');
      ctx.save();
      ctx.strokeStyle = grad;
      ctx.lineWidth = r * 0.85;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    if (hot) { ctx.shadowColor = 'rgba(150,210,255,1)'; ctx.shadowBlur = 26; }

    /* filled luminous core — the reason a crossing electron is now obvious */
    if (hot) {
      const core = ctx.createRadialGradient(x, y, 0, x, y, r);
      core.addColorStop(0, 'rgba(255,255,255,0.98)');
      core.addColorStop(0.55, 'rgba(205,232,255,0.72)');
      core.addColorStop(1, 'rgba(120,190,255,0.10)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.strokeStyle = hot ? '#ffffff' : C.electron;
    ctx.lineWidth = hot ? 3.2 : 1.7;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.stroke();
    /* two meridians, so a resident shell still reads as a wireframe sphere */
    ctx.globalAlpha = hot ? 0.9 : 0.55;
    ctx.lineWidth = hot ? 2.2 : 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
    ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
    ctx.stroke();
    ctx.restore();
    boxes.push({ x, y, side: d.side, moving: !!hot });
  }
  ctx.globalAlpha = 1;

  /* --- exposed donors: the (+) the departing electron left behind ------- */
  if (ct.f > 0.005 && depW > 8) {
    const n = 5;
    ctx.font = MONO(17, '600');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.donor;
    for (let i = 0; i < n; i++) {
      const x = semiX0 + depW * (0.14 + 0.72 * (i / (n - 1)));
      ctx.globalAlpha = 0.45 + 0.55 * ct.f;
      ctx.fillText('+', x, yEcB - 26);
    }
    ctx.globalAlpha = 1;
  }

  /* --- the flow callout, mirroring the full view's arrows -------------- */
  const yC = yEcB + (yFm - yEcB) * 0.5;
  ctx.font = MONO(10.5, '700');
  ctx.textBaseline = 'middle';
  if (st.key === 'equilibrium') {
    /* Both directions, equal length: net current is exactly zero here. */
    const L = 54;
    arrow(ctx, midX - 14, yC, midX - 14 - L, yC, C.fluxFwd, 2.4, 9);
    arrow(ctx, midX + 14, yC, midX + 14 + L, yC, C.fluxRev, 2.4, 9);
    /* Caption goes in the EMPTY upper half of the metal slab. Centred on midX
       at the arrow line it was drawn straight across the hatched Φ_B wall. */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.netZero;
    ctx.fillText('equal both ways — net = 0', (metalX0 + metalX1) / 2, yFm - 34);
  } else if (st.key === 'separated') {
    ctx.textAlign = 'center';
    ctx.fillStyle = C.textDim;
    ctx.fillText('surfaces not yet touching', midX, yC);
  } else {
    /* The arrow points the way the electrons go: right → left. The caption is
       anchored in the empty metal half, not at midX — centred there it was
       drawn across the hatched Φ_B wall. */
    const L = 20 + 46 * Math.max(0.15, Math.min(1, model.flux.net));
    arrow(ctx, midX + 20, yC, midX + 20 - L, yC, C.fluxFwd, 2.6, 10);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.fluxFwd;
    ctx.fillText('electrons cross here', (metalX0 + metalX1) / 2, yFm - 34);
  }

  /* --- panel title ------------------------------------------------------
     drawSlabs already writes "Metal" / "n-type semiconductor" at the slab
     tops, so this panel adds only its own heading, and keeps it clear of that
     row (which sits at pad.top). */
  ctx.font = MONO(10.5, '700');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = C.textDim;
  ctx.fillText('JUNCTION — magnified', g.pad.left, 2);
  ctx.font = MONO(8, '600');
  ctx.fillStyle = C.textFaint;
  ctx.fillText('x magnified · energy true to scale', g.pad.left, 14);
  if (depW > 8) {
    /* the emptying, named — but on the BOTTOM row, clear of drawSlabs' slab
       titles and of the band region */
    ctx.font = MONO(8.5, '600');
    ctx.textAlign = 'center';
    ctx.fillStyle = C.textFaint;
    ctx.fillText('depletion — emptied of electrons',
      semiX0 + depW / 2, g.pad.top + g.innerH - 12);
  }

  return {
    electronCount: boxes.length,
    crossing: boxes.filter((b) => b.moving).length,
    depletionW: depW,
    junctionX: midX,
    /* Same contract as the full view, on this panel's own energy scale: the
       drawn centres and the row of E_C, so the packed grid can be checked for
       the same forbidden-states defect the full view had. */
    electronBoxes: boxes,
    ecBulkY: Y(lv.Ec_bulk),
  };
}

/* =====================================================
   2.  GRID + ENERGY AXIS
   ===================================================== */

function drawGrid(ctx, g, Y, Emin, Emax) {
  const span = Emax - Emin;
  const raw = span / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
  ctx.font = MONO(10);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let e = Math.ceil(Emin / step) * step; e <= Emax + 1e-9; e += step) {
    const y = Y(e);
    if (y < g.pad.top || y > g.pad.top + g.innerH) continue;
    const zero = Math.abs(e) < 1e-9;
    ctx.strokeStyle = zero ? C.gridS : C.grid;
    ctx.lineWidth = zero ? 1 : 0.6;
    ctx.beginPath();
    ctx.moveTo(g.pad.left, y);
    ctx.lineTo(g.pad.left + g.innerW, y);
    ctx.stroke();
    ctx.fillStyle = zero ? 'rgba(138,151,196,0.5)' : C.textFaint;
    ctx.fillText(zero ? '0' : (e > 0 ? '+' : '') + e.toFixed(Math.abs(e) < 1 ? 2 : 1),
      g.pad.left - 6, y);
  }
}

/* =====================================================
   3.  SLABS  (the two materials)
   ===================================================== */

function drawSlabs(ctx, g, o) {
  const { metalX0, metalX1, semiX0, semiX1, Y, lv } = o;
  const top = g.pad.top;

  ctx.fillStyle = C.metalFill;
  ctx.fillRect(metalX0, top, metalX1 - metalX0, g.innerH);
  ctx.strokeStyle = C.metalLine;
  ctx.lineWidth = 1;
  ctx.strokeRect(metalX0 + 0.5, top + 0.5, metalX1 - metalX0 - 1, g.innerH - 1);

  ctx.fillStyle = C.semiFill;
  ctx.fillRect(semiX0, top, semiX1 - semiX0, g.innerH);
  ctx.strokeStyle = C.semiLine;
  ctx.strokeRect(semiX0 + 0.5, top + 0.5, semiX1 - semiX0 - 1, g.innerH - 1);

  ctx.font = MONO(11, '600');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = C.metalTxt;
  ctx.fillText('Metal', (metalX0 + metalX1) / 2, top + 4);
  ctx.fillStyle = C.semiTxt;
  /* the slab's right edge parks off-canvas while the gap is open */
  ctx.fillText('n-type semiconductor',
    Math.min(semiX0 + 0.30 * g.innerW, g.pad.left + g.innerW - 60), top + 4);

  /* vacuum level — the common reference that makes Φ_m and χ_s comparable */
  ctx.strokeStyle = C.vacuum;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(g.pad.left, Y(0));
  ctx.lineTo(g.pad.left + g.innerW, Y(0));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = MONO(9.5);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.textFaint;
  ctx.fillText('vacuum level  E_vac = 0', g.pad.left + 4, Y(0) - 5);

  /* Φ_m arrow: metal E_F → vacuum, drawn inside the metal slab */
  const px = metalX0 + 0.16 * (metalX1 - metalX0);
  arrow(ctx, px, Y(lv.Ef_m), px, Y(0), C.metalLine, 1.4, 5);
  ctx.font = MONO(9.5, '600');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.metalTxt;
  /* Right of the arrow, not centred on it: the shaft ran straight through the
     glyphs and made "Φ_m" unreadable. */
  ctx.fillText('Φ_m', px + 5, (Y(lv.Ef_m) + Y(0)) / 2);
}

/* =====================================================
   4.  BANDS  (the bend is the model's, not the artist's)
   ===================================================== */

function drawBands(ctx, g, o) {
  const { semiX0, semiX1, depW, Y, lv, model, midX } = o;
  const prof = model.profile;
  /* Map the model's normalized distance onto pixels. 1.6 is the profile's
     maxDist, so the scale below puts the depletion edge (dist = 1) at ~62% of
     the drawn width, leaving flat bulk visible to the slab edge. */
  const span = Math.min(depW * 1.15 + g.innerW * 0.40, g.innerW);
  const xAt = (dist) => semiX0 + (dist / 1.6) * span;

  const ec = [], ev = [];
  for (const r of prof) {
    const x = xAt(r.dist);
    if (x > semiX1) break;
    ec.push([x, Y(r.Ec)]);
    ev.push([x, Y(r.Ev)]);
  }
  /* Extend the last point to the slab edge: beyond the depletion region the
     bands ARE flat, and stopping them short would imply they continue bending. */
  if (ec.length) { ec[ec.length - 1][0] = semiX1; ev[ev.length - 1][0] = semiX1; }

  const stroke = (pts, color, width) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  };
  stroke(ev, C.vb, 2);
  stroke(ec, C.cb, 2);

  const lastEc = ec[ec.length - 1], lastEv = ev[ev.length - 1];
  ctx.font = MONO(10, '600');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  if (lastEv) { ctx.fillStyle = C.vb; ctx.fillText('E_V', semiX1 - 6, lastEv[1]); }
  if (lastEc) { ctx.fillStyle = C.cb; ctx.fillText('E_C', semiX1 - 6, lastEc[1]); }

  /* ---- the metal's Fermi level, extended toward the interface ---------
     One continuous E_F is the point of the whole picture: a metal has a
     continuum of states, so its Fermi level is flat and never bends. */
  const yFm = Y(lv.Ef_m);
  const efX = semiX0 + g.innerW * 0.40;
  ctx.strokeStyle = C.fermi;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(g.pad.left, yFm);
  ctx.lineTo(efX, yFm);
  ctx.stroke();
  ctx.font = MONO(10, '600');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.fermi;
  ctx.fillText('E_F', g.pad.left + 3, yFm - 6);

  /* ---- the semiconductor's E_F, SLIDING down to meet it ---------------
     Only while the gap is open: before contact the two levels are separate,
     and that separation (ΔE_F = V_bi) is the driving force being spent. */
  if (Math.abs(lv.dEf) > 1e-6) {
    const yFs = Y(lv.Ef_semi);
    ctx.strokeStyle = 'rgba(255,179,71,0.75)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(semiX0, yFs);
    ctx.lineTo(semiX1, yFs);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,179,71,0.85)';
    ctx.textAlign = 'right';
    /* Below the line: at equilibrium E_F,semi sits only ΔE (0.15 eV) under E_C,
       and a label drawn on the line landed on top of the E_C label. */
    ctx.fillText('E_F,semi', semiX1 - 6, yFs + 12);
    const bx = semiX0 + 10;
    arrow(ctx, bx, yFm, bx, yFs, 'rgba(255,179,71,0.85)', 1.4, 5, [3, 3]);
    ctx.textAlign = 'left';
    ctx.fillText('ΔE_F', bx + 4, (yFm + yFs) / 2);
  }

  /* ---- the barrier Φ_B: E_F(metal) → E_C(interface) ------------------
     Dashed, so it reads as a wall the electrons must surmount. */
  const yEcI = Y(lv.Ec_interface);
  const bx = midX - 18;
  arrow(ctx, bx, yFm, bx, yEcI, C.barrier, 1.3, 5, [2, 3]);
  ctx.font = MONO(9.5, '600');
  ctx.textAlign = 'right';
  ctx.fillStyle = C.barrier;
  ctx.fillText('Φ_B', bx - 4, (yFm + yEcI) / 2);

  /* ---- V_bi: the band bend, interface → bulk -------------------------- */
  if (model.charge.f > 0.01 && lastEc) {
    const yEcBulk = Y(lv.Ec_bulk);
    const vx = semiX0 + depW * 0.55 + 10;
    arrow(ctx, vx, yEcI, vx, yEcBulk, C.vbi, 1.4, 5, [4, 3]);
    ctx.font = MONO(9.5, '600');
    ctx.textAlign = 'left';
    ctx.fillStyle = C.vbi;
    ctx.fillText('V_bi', vx + 4, (yEcI + yEcBulk) / 2);
  }
}

/* =====================================================
   4b.  n(E) INSET — the distribution the dots are drawn from
   ===================================================== */

/**
 * The conduction-band energy distribution, n(E) ∝ e^{−(E−E_F)/kT}.
 *
 * WHY THIS EXISTS. The reference figure this page is built from puts a bell/tail
 * curve beside each material, and without it a reader cannot tell a Boltzmann
 * population from a uniform smear — at a glance both are "some dots near the
 * band". The dots really are sampled from this curve
 * (BANDMODEL.sampleTailEnergy), so drawing the curve makes the claim checkable
 * by eye: most electrons hug E_C, and the tail thins by e^{-1} every kT.
 *
 * The gap below E_C is drawn as a hard zero, because that is the point: there
 * is no conduction-band population in the gap at all. Seeing the curve flat at
 * zero until it hits E_C, then jumping to its maximum, says the same thing the
 * empty space behind it says — and it is the defect that prompt originated.
 *
 * ITS ENERGY AXIS IS COMPRESSED, exactly as render.js's f(E) inset is: the
 * window is TAIL_MAX_KT + 3 kT wide, spanning the empty gap below E_C and the
 * thermal tail above it. On the panel's own 7.5 eV axis that tail is ~2% of the
 * height — an unreadable squiggle. This inset exists precisely because the
 * honest scale is too small to read, and it is labelled with its own E_C
 * marker so it cannot be mistaken for the panel's axis.
 *
 * @returns {{x:number,y:number,w:number,h:number}|null} the drawn box, or null
 *          when the panel is too narrow to leave a clear gutter
 */
function drawEnergyDist(ctx, g, o) {
  const { semiX0, semiX1, Y, lv, p } = o;
  const stripH = 26;
  const baseY = g.pad.top + g.innerH - stripH - 4;
  const iw = 76;
  const ih = Math.min(104, baseY - 6 - (g.pad.top + 10));
  if (ih < 60) return null;
  const kT = BANDMODEL.THERMAL_V(p.T);
  const Ec = lv.Ec_bulk;
  /* WHERE IT GOES — both coordinates needed care.

     x: anchor to the PANEL, not to the slab. The semiconductor slab slides in
     from the right while the surfaces approach, so at t=0 `semiX1` lands
     beyond the canvas: an inset anchored to it measured x=808 on a 767px
     panel and was clipped away completely. Taking the leftmost of the two
     keeps it on screen for the whole animation.

     y: sit directly ABOVE the electron cloud instead of in the panel corner.
     The cloud tops out at E_C + TAIL_MAX_KT·kT by construction, so parking the
     box just over that puts the curve next to the dots it describes, in the
     same energy region — a corner placement left it ~500px away from the
     population it was supposedly explaining. Being above E_C also means it
     covers no band line except empty grid. */
  const yCloudTop = Y(Ec + BANDMODEL.TAIL_MAX_KT * kT);
  const ix = Math.min(semiX1 - iw - 6, g.W - iw - 6);
  const iy0 = Math.max(g.pad.top + 6,
    Math.min(yCloudTop - ih - 6, baseY - 6 - ih));
  /* Bail rather than draw something off-panel, over the metal, or squashed. */
  if (ix < semiX0 + 4 || iy0 + ih > baseY - 6) return null;

  const GAP_KT = 3;                     // how much empty gap to show below E_C
  const eLo = Ec - GAP_KT * kT;
  const eHi = Ec + BANDMODEL.TAIL_MAX_KT * kT;
  /* Energy → y, on the INSET's own axis (not the panel's). */
  const iy = (E) => iy0 + ih * (1 - (E - eLo) / (eHi - eLo));
  /* Normalised density: exactly zero in the gap, 1 at E_C, then e^{-x}. */
  const amp = (E) => (E < Ec ? 0 : Math.exp(-(E - Ec) / kT));
  /* A label column down the left edge keeps 'n(E)', 'E_C' and 'gap' off the
     curve: in the gap the curve is pinned to the baseline, so any text placed
     at the old x = ix+7 would have been printed straight through it. */
  const PAD_L = 27;
  const x0 = ix + PAD_L;                        // the zero-density baseline
  const ex = (E) => x0 + (iw - PAD_L - 6) * amp(E);

  ctx.save();
  /* Opaque plate so the curve stays legible over the grid and the band lines,
     same treatment as render.js's f(E) inset. */
  ctx.fillStyle = 'rgba(7,11,23,0.86)';
  ctx.fillRect(ix, iy0, iw, ih);

  /* area under the curve — the population itself */
  const N = 72;
  const pt = (i) => { const E = eLo + (eHi - eLo) * (i / N); return [ex(E), iy(E)]; };
  ctx.beginPath();
  ctx.moveTo(x0, iy(eLo));
  for (let i = 0; i <= N; i++) { const [x, y] = pt(i); ctx.lineTo(x, y); }
  ctx.lineTo(x0, iy(eHi));
  ctx.closePath();
  ctx.fillStyle = 'rgba(90,170,255,0.20)';
  ctx.fill();

  /* the curve itself */
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const [x, y] = pt(i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.strokeStyle = C.cb;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  /* E_C marker: the step from "no states occupied" to "the whole tail". */
  ctx.strokeStyle = 'rgba(61,240,192,0.75)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x0, iy(Ec)); ctx.lineTo(ix + iw - 2, iy(Ec));
  ctx.stroke();
  ctx.setLineDash([]);

  /* frame + labels */
  ctx.strokeStyle = 'rgba(138,151,196,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(ix + 0.5, iy0 + 0.5, iw - 1, ih - 1);
  ctx.textAlign = 'left';
  ctx.font = MONO(9, '700');
  ctx.fillStyle = C.semiTxt;
  ctx.textBaseline = 'top';
  ctx.fillText('n(E)', ix + 4, iy0 + 4);
  ctx.font = MONO(8.5, '600');
  ctx.fillStyle = C.vbi;
  ctx.textBaseline = 'middle';
  ctx.fillText('E_C', ix + 4, iy(Ec));
  ctx.font = MONO(8, '600');
  ctx.fillStyle = C.textFaint;
  ctx.textBaseline = 'bottom';
  ctx.fillText('gap', ix + 4, iy(eLo) - 3);
  ctx.restore();
  return { x: ix, y: iy0, w: iw, h: ih };
}

/* =====================================================
   5.  ELECTRONS
   ===================================================== */

/**
 * Draw the electrons as WIREFRAME shells.
 *
 * Why wireframe rather than solid discs: a filled dot at 3px radius is opaque,
 * and a cloud of them reads as a static blob — the very thing the animation is
 * supposed to show moving. A hollow ring keeps every electron individually
 * visible even where the population is dense, so a viewer can literally count
 * the ones crossing the junction.
 *
 * Each shell is a circle plus a vertical meridian, the standard wireframe
 * idiom for a sphere. The meridian is what makes the rotation legible: a plain
 * ring looks identical at every angle, so the crossing dots would appear to
 * slide rather than travel.
 *
 * Vertical position is a SAMPLE from the real energy distribution, not a
 * uniform smear across a convenient band:
 *
 *   • semiconductor → Boltzmann tail, E ≥ E_C (BANDMODEL.sampleTailEnergy);
 *   • metal         → Fermi–Dirac around E_F (BANDMODEL.sampleFermiEnergy).
 *
 * The semiconductor case is the one that matters most: conduction-band states
 * exist only AT and ABOVE E_C, so a shell drawn below it is a shell drawn in
 * the gap, where there is nothing to be in. An earlier version interpolated
 * from E_C down toward E_F and put two thirds of the population there.
 *
 * Inside the depletion region there are no electrons at all — that is the
 * definition of the region, and a dot there would contradict the shading
 * behind it. Outside that region E_C is flat at its bulk value, which is why
 * `lv.Ec_bulk` is the correct anchor for every x a dot is allowed to occupy.
 *
 * @returns {Array<{x:number,y:number,side:number,moving:boolean}>} for the tests
 */
function drawElectrons(ctx, g, o) {
  const { parts, midX, metalX0, metalX1, semiX0, semiX1, Y, lv, ct, p } = o;
  if (!parts || !Array.isArray(parts.dots)) return [];
  const boxes = [];
  const R = 3.4;
  const semiSpan = semiX1 - semiX0;
  const metalSpan = metalX1 - metalX0;
  /* The semiconductor occupies only the first ~55% of its slab before the
     bands run out of room; clamp so dots never land on the slab border. */
  const semiUsable = semiSpan * 0.55;
  const depW = 0.26 * g.innerW * Math.sqrt(Math.max(ct.f, 0));

  for (const d of parts.dots) {
    const inMetal = d.side === SIDE_METAL;
    /* Vertical placement — every resident's y comes from its own energy.

       A metal has no band gap: every state below E_F is filled, so the
       electron cloud STRADDLES E_F. The old code interpolated between
       Y(E_C) and Y(E_F) for both materials, but in the metal E_C is E_F, so
       that band had ZERO height and all 64 arrived electrons were drawn on
       one y — directly under the orange E_F line, which then painted over
       them. Only one shell was visible at 1080P.

       The fix that followed THAT put the semiconductor dots in a band running
       from E_C down to E_F. In an n-type semiconductor E_F sits BELOW E_C by
       dE_s, so that band is mostly band gap: measured, 66–100% of the
       population was drawn where no conduction-band state exists. A gap is
       not a container you can fill.

       So the mapping is by SAMPLE, not by interpolation:
         • metal       → sampleFermiEnergy, straddling E_F (occupied sea,
                         thinning on the empty side exactly as f(E) says);
         • semiconductor → sampleTailEnergy, which is E ≥ E_C by construction
                         and decays upward as e^{−(E−E_C)/kT}. */
    const hot = d.moving;
    let x, y;
    let prog = null;
    if (hot) {
      /* A CROSSING electron is the whole point of the animation, so it is
         drawn traversing the interface for real. Previously a moving dot kept
         its origin-side mapping (semi → semiX0+7+u·span), which slid it
         RIGHTWARD, away from the junction, and never crossed the gap at all —
         the flow was literally impossible to see. progress() is the fraction
         travelled; x lerps from the semiconductor interior to the metal
         interior, i.e. right → left, the correct direction. */
      prog = progress(d);
      x = (semiX0 + 7) + ((metalX1 - 7) - (semiX0 + 7)) * prog;
      /* Climbs the barrier en route: starts at ITS OWN thermal energy inside
         the conduction band, rises to E_C at the interface (the barrier top),
         then settles onto E_F in the metal. The climb IS why the transfer
         costs energy, so it is drawn rather than implied. Starting from
         sampleTailEnergy(d.q) rather than a fixed midpoint keeps the mover
         continuous with the resident cloud it just left. */
      const yEc = Y(BANDMODEL.sampleTailEnergy(d.q, lv.Ec_bulk, p.T));
      const yEcI = Y(lv.Ec_interface);
      const yEf = Y(lv.Ef_m);
      if (prog < 0.5) {
        const f = prog / 0.5;
        y = yEc * (1 - f) + yEcI * f;
      } else {
        const f = (prog - 0.5) / 0.5;
        y = yEcI * (1 - f) + yEf * f;
      }
    } else if (inMetal) {
      x = metalX1 - 7 - d.u * (metalSpan * 0.62);
      /* Fermi–Dirac, not a ±7px uniform smear. A metal has a roughly constant
         DOS at E_F, so f(E) alone decides how far from the line a shell sits:
         the median drawn electron lands ~3 kT BELOW E_F and only ~11.5% land
         above it — which is exactly the thin hot layer the reference figure
         boxes in above the Fermi level. The old uniform offset handed out a
         third of the population on the empty side. */
      y = Y(BANDMODEL.sampleFermiEnergy(d.q, lv.Ef_m, p.T, METAL_WINDOW_KT));
    } else {
      x = semiX0 + 7 + d.u * semiUsable;
      if (depW > 1 && x < semiX0 + depW) continue;   // depletion zone is empty
      /* Boltzmann tail, anchored on E_C and going UP. `sampleTailEnergy`
         cannot return a value below E_C, so the gap stays empty by
         construction rather than by a clamp someone can forget to apply. */
      y = Y(BANDMODEL.sampleTailEnergy(d.q, lv.Ec_bulk, p.T));
    }
    if (!isFinite(x) || !isFinite(y)) continue;
    const r = hot ? R + 1.6 : R;

    /* Motion trail for a crossing electron, pointing the way it came (to the
       right) so the semi → metal direction is unambiguous at a glance. */
    if (hot) {
      const len = 22;
      const grad = ctx.createLinearGradient(x, y, x + len, y);
      grad.addColorStop(0, 'rgba(91,170,255,0.5)');
      grad.addColorStop(1, 'rgba(91,170,255,0)');
      ctx.save();
      ctx.strokeStyle = grad;
      ctx.lineWidth = r * 0.9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
      ctx.restore();
    }

    /* Crossing electrons get a bright halo: the queue at the junction is the
       single most important thing to see, and a uniform blue ring would let it
       blend into the resident population. */
    ctx.save();
    if (hot) {
      ctx.shadowColor = 'rgba(91,170,255,0.9)';
      ctx.shadowBlur = 9;
    }
    ctx.strokeStyle = hot ? C.electronHot : C.electron;
    ctx.lineWidth = hot ? 1.5 : 1.1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.stroke();
    /* meridian */
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x, y + r);
    ctx.globalAlpha = hot ? 0.75 : 0.45;
    ctx.lineWidth = hot ? 1.1 : 0.8;
    ctx.stroke();
    ctx.restore();
    boxes.push({ x, y, side: d.side, moving: !!hot, prog });
  }
  ctx.globalAlpha = 1;
  return boxes;
}

/* =====================================================
   6.  EXPOSED DONOR IONS
   ===================================================== */

/**
 * The (+) marks inside the depletion region.
 *
 * These are the whole mechanism: as electrons leave, the ionized donors they
 * left behind are what builds the space charge, and their field is what bends
 * the bands and stops further flow. Without them the depletion shading looks
 * arbitrary.
 */
function drawDonors(ctx, g, o) {
  const { semiX0, depW, Y, p, ct } = o;
  if (ct.f <= 0.005 || depW < 6) return;
  const n = 7;
  ctx.font = MONO(11, '600');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = C.donor;
  for (let i = 0; i < n; i++) {
    /* spread across the depletion width, inset from both edges */
    const x = semiX0 + depW * (0.10 + 0.80 * (i / (n - 1)));
    /* Above the density strip, inside the conduction band: the emptied states
       sit just under E_C, and −5.35 eV was low enough to collide with the
       density bars once that strip was added to the bottom of the plot. */
    const y = Y(-4.55);
    ctx.globalAlpha = 0.55 + 0.35 * ct.f;
    ctx.fillText('+', x, y);
  }
  ctx.globalAlpha = 1;
  /* label the zone once, clear of the density strip */
  ctx.font = MONO(9.5);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = C.textDim;
  ctx.fillText('(+) ionized donors', semiX0 + 5, g.pad.top + 6);
}

/* =====================================================
   7.  ELECTRON DENSITY  (where do they pile up?)
   ===================================================== */

/**
 * A density strip along the bottom of the plot, answering the question the
 * band diagram alone leaves open: WHERE is the electron population largest?
 *
 * The answer is not uniform and not obvious, which is the point:
 *   • the METAL surface is the pile-up — every transferred electron stops there,
 *     so it holds the peak;
 *   • the DEPLETION region is a HOLE — density falls to essentially zero, and
 *     that empty band is what builds the barrier;
 *   • the semiconductor bulk is the moderate reference.
 *
 * Bars are drawn from the model's own bandProfile (normalized n) plus the
 * metal's accumulated sheet density, so the shape is the physics rather than an
 * artist's impression. The peak is labelled with a marker, because "show me the
 * most" deserves an explicit pointer.
 */
function drawDensity(ctx, g, o) {
  const { model, metalX0, metalX1, semiX0, semiX1, midX, ct } = o;
  /* The bar must stay under the label row, so the strip needs a little more
     clearance: the caption now sits above the frame and the peak caret reaches
     6px past its top edge. */
  const stripH = 26;
  const baseY = g.pad.top + g.innerH - stripH - 4;
  if (baseY < g.pad.top + 34) return null;          // too short to be legible

  const x0 = metalX0, x1 = semiX1;
  const prof = model.profile;
  const depW = 0.26 * g.innerW * Math.sqrt(Math.max(ct.f, 0));

  ctx.save();
  /* frame */
  ctx.fillStyle = 'rgba(7,11,23,0.55)';
  ctx.fillRect(x0, baseY, x1 - x0, stripH);
  ctx.strokeStyle = 'rgba(138,151,196,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, baseY + 0.5, x1 - x0 - 1, stripH - 1);

  const depX = semiX0 + depW;
  let peakX = null, peakVal = -1;

  /* --- semiconductor: n(x) from the model profile ------------------- */
  const semiLeft = semiX0;
  const semiRight = semiX0 + Math.max(depW * 1.15, (semiX1 - semiX0) * 0.55);
  const usable = semiRight - semiLeft;
  if (usable > 2) {
    for (let i = 0; i < prof.length; i++) {
      const r = prof[i];
      const px = semiLeft + (r.dist / 1.6) * usable;
      if (px > semiRight) break;
      const h = Math.max(0, r.n) * (stripH - 8);
      ctx.fillStyle = C.cb;
      ctx.globalAlpha = 0.30 + 0.55 * Math.max(0, r.n);
      ctx.fillRect(px, baseY + stripH - 4 - h, Math.max(1, usable / prof.length), h);
      if (r.n > peakVal) { peakVal = r.n; peakX = px; }
    }
  }
  /* --- metal: the pile-up ------------------------------------------- */
  const metalW = (metalX1 - metalX0) * 0.62;
  const metalH = (stripH - 8) * Math.min(1, Math.max(0, ct.f));
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = C.fermi;                            // gold: the metal electrons
  ctx.fillRect(metalX1 - metalW, baseY + stripH - 4 - metalH, metalW, metalH);
  ctx.globalAlpha = 1;
  /* The metal's bar is the peak whenever anything has arrived. */
  if (ct.f > 0.01) { peakVal = 1; peakX = metalX1 - metalW * 0.5; }

  /* --- depletion marker: the hole ----------------------------------- */
  if (depW > 2) {
    ctx.strokeStyle = C.barrier;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(semiX0 + 0.5, baseY + 1.5, depW - 1, stripH - 3);
    ctx.setLineDash([]);
  }

  /* --- peak marker -------------------------------------------------- */
  if (peakX != null) {
    ctx.strokeStyle = C.vbi;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(peakX, baseY - 3);
    ctx.lineTo(peakX, baseY + stripH);
    ctx.stroke();
    ctx.fillStyle = C.vbi;
    ctx.beginPath();                                  // small caret at the top
    ctx.moveTo(peakX, baseY - 6);
    ctx.lineTo(peakX - 3.5, baseY - 1);
    ctx.lineTo(peakX + 3.5, baseY - 1);
    ctx.closePath();
    ctx.fill();
  }

  /* --- labels --------------------------------------------------------
     These sit on the strip's own baseline row, and the "electron density n(x)"
     caption goes ABOVE the frame. Drawn at baseY + 3 it ran straight through
     the metal's gold population bar — which occupies the metal end of the
     strip — so the two things the strip exists to show fought each other. The
     in-strip captions use the bottom row, where the bars are shortest. */
  ctx.font = MONO(8.5);
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillStyle = C.textDim;
  ctx.fillText('electron density n(x)', x0 + 2, baseY - 7);
  if (depW > 2) {
    ctx.fillStyle = C.barrier;
    ctx.textAlign = 'center';
    ctx.fillText('depleted', semiX0 + depW / 2, baseY + stripH + 10);
  }
  if (peakX != null && ct.f > 0.01) {
    /* Below the strip. On the strip's own bottom row it was drawn over the
       metal's gold population bar, which is the tallest thing in there. */
    ctx.fillStyle = C.vbi;
    ctx.textAlign = 'right';
    ctx.fillText('peak: metal surface', Math.min(peakX + 6, x1 - 4), baseY + stripH + 10);
  }
  ctx.restore();
  return { peakX, peakVal, baseY, stripH, depW };
}

/* =====================================================
   8.  FLUX ARROWS  (the honesty-critical part)
   ===================================================== */

/**
 * Draw the electron flux across the junction.
 *
 * THE KEY CORRECTION relative to the reference figure: at equilibrium the net
 * current is ZERO. Electrons still cross in both directions, in large numbers,
 * but the fluxes balance. Drawing a single one-way arrow at equilibrium — as
 * the source image does — teaches that a diode passes current with no bias,
 * which is wrong.
 *
 * So:
 *   • transient → ONE arrow, semi → metal, length ∝ the decaying net flux;
 *   • equilibrium → TWO arrows of equal length, plus an explicit "net = 0".
 */
function drawFlux(ctx, g, o) {
  const { model, midX, Y, lv, metalX1 } = o;
  const fl = model.flux;
  const st = model.stage;
  const yC = Y(lv.Ec_bulk + 0.35);          // inside the conduction band
  const gap = 30;
  const L0 = 46;

  if (st.key === 'separated') {
    /* No contact: show the INTENT, not motion — a dashed arrow that stops at
       the gap, plus the reason. */
    arrow(ctx, midX + 34, yC, midX + 8, yC, 'rgba(0,229,176,0.45)', 1.4, 5, [4, 4]);
    ctx.font = MONO(9.5, '600');
    ctx.textAlign = 'left';
    ctx.fillStyle = C.textDim;
    ctx.fillText('E_F,semi > E_F,metal → flow is ready', midX + 40, yC);
    return;
  }

  if (st.key === 'equilibrium') {
    /* Two-way exchange. Equal and opposite, and LABELLED as balanced.
       The two lines are anchored over the METAL slab, well above the arrow
       line. They used to sit at yC − 8 / yC − 20 starting just left of the
       arrows, which is the semiconductor side: there they landed on the donor
       row and the E_C band edge, so the caption obscured the very depletion it
       was describing. The metal interior above E_F is empty at every stage. */
    const lx = midX - 10 - L0 - 6;
    const ly = Y(lv.Ef_m) - 26;
    arrow(ctx, midX - 10, yC, midX - 10 - L0, yC, C.fluxFwd, 2, 7);
    arrow(ctx, midX + 10, yC, midX + 10 + L0, yC, C.fluxRev, 2, 7);
    ctx.font = MONO(9.5, '600');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.netZero;
    ctx.fillText('two-way exchange', lx, ly);
    ctx.fillStyle = C.vbi;
    ctx.fillText('fluxes balance → net = 0', lx, ly - 13);
    return;
  }

  /* Transient / contact: one net arrow, shrinking as the driving force is
     spent. Length ∝ netFlux, floored so it never vanishes mid-stage. */
  const mag = Math.max(0.18, Math.min(1, fl.net));
  const L = L0 * mag;
  arrow(ctx, midX + gap, yC, midX + gap - L, yC, C.fluxFwd, 1.4 + 1.6 * mag, 6);
  ctx.font = MONO(9.5, '600');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.fluxFwd;
  /* Anchored in the EMPTY metal interior above E_F, like the equilibrium
     caption. Beside the arrow (yC − 9) it sat on the donor row and the E_C
     edge; the metal above E_F is clear at every stage, and it is the direction
     the arrow is pointing anyway. */
  ctx.fillText('net flow  semi → metal', metalX1 - 4 - ctx.measureText('net flow  semi → metal').width, Y(lv.Ef_m) - 26);
}

/* =====================================================
   9.  ANNOTATIONS  (state caption + the honesty readouts)
   ===================================================== */

function drawAnnotations(ctx, g, o) {
  const { model, midX, Y, lv, p, ct, w, h } = o;
  const st = model.stage;
  const fl = model.flux;

  /* ---- stage caption, bottom-left --------------------------------------
     The blurb is CLIPPED to the space left of the readout block. Unclipped it
     ran under the right-aligned numbers on a wide canvas, which made both
     unreadable (this is a projector demo; overlapping text is not acceptable). */
  const capY = g.pad.top + g.innerH + 8;
  const maxBlurbW = Math.max(60, g.innerW * 0.52);

  ctx.save();
  ctx.beginPath();
  /* The clip box must clear the 12px caption glyphs: it used to start at
     capY − 12 with a 16px height, which sliced the stage title in half. */
  ctx.rect(g.pad.left, capY - 2, maxBlurbW, 18);
  ctx.clip();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = MONO(12, '700');
  ctx.fillStyle = st.key === 'equilibrium' ? C.vbi
    : st.key === 'transient' ? '#ffffff'
    : st.key === 'contact' ? C.fluxFwd : C.fermi;
  const title = `${st.id} · ${st.label}`;
  ctx.fillText(title, g.pad.left, capY);
  /* Blurb starts AFTER the MEASURED title, not at a guessed x: a fixed +104px
     collided with "D · Equilibrium", which measures 108px. */
  const blurbX = g.pad.left + ctx.measureText(title).width + 12;
  /* …and it is WORD-WRAPPED to whatever room is left. Unwrapped, the longest
     blurb needed 570px of a ~520px strip and ran under the readouts. */
  ctx.font = MONO(9.5);
  ctx.fillStyle = C.textFaint;
  const avail = Math.max(40, maxBlurbW - (blurbX - g.pad.left) - 6);
  const words = st.blurb.split(' ');
  let line = '', lineNo = 0;
  const emit = () => {
    if (line) { ctx.fillText(line, blurbX, capY + 3 + lineNo * 11); lineNo++; }
    line = '';
  };
  for (const word of words) {
    const probeLine = line ? line + ' ' + word : word;
    if (ctx.measureText(probeLine).width > avail && line) { emit(); line = word; }
    else line = probeLine;
  }
  emit();
  ctx.restore();

  /* ---- the honesty readouts, bottom-right -----------------------------
     These are not decoration. Without them the animation invites three wrong
     conclusions: that 64 electrons moved, that the motion is slow, and that
     equilibrium still conducts. */
  const lines = [
    `transferred   ${(ct.sheet / 1e4).toExponential(2)} cm⁻²   (f = ${(ct.f * 100).toFixed(0)}%)`,
    `ΔE_F left     ${(ct.dEf).toFixed(3)} eV = ${(ct.dEf / model.levels.kT).toFixed(1)} kT`,
    `W             ${(ct.W * 1e9).toFixed(1)} nm   E_max ${(ct.Emax / 1e5).toFixed(0)} V/cm`,
    `net flux      ${fl.net === 0 ? '0  (balanced)' : fl.net.toFixed(3)}`,
    `slow motion   ${model.time.slowMotion.toExponential(1)}×  (crossing ${model.time.transit_ps.toFixed(2)} ps)`,
  ];
  ctx.font = MONO(9.5);
  ctx.textAlign = 'right';
  let y = g.pad.top + g.innerH + 8;
  for (const ln of lines) {
    ctx.fillStyle = ln.startsWith('net flux') && fl.net === 0 ? C.vbi : C.textDim;
    ctx.fillText(ln, g.pad.left + g.innerW, y);
    y += 12;
  }
}
