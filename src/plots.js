/**
 * src/plots.js: panel c (the force law of the hovered pair), panel d (live
 * traces of aggregation and speed) and the tick frame drawn around panel a's
 * dish.
 *
 * Everything is SVG drawn in CSS-pixel user units (no viewBox scaling), so a
 * 1px stroke can sit on a half-pixel centre and stay crisp. Chrome is ink
 * only, read through CSS custom properties, so light and dark prints both
 * work without redrawing. Hue appears only as species colour, and always next
 * to that species' drawn marker.
 *
 * The pure helpers below (tick selection, torus and log ticks, range
 * hysteresis, label spreading, the trace ring buffer) are exported as optional
 * extras so tests/plots.test.mjs can exercise them in Node.
 */

import { forceLaw } from './sim.js';
import { SPECIES, SPECIES_MAX, markerPath, currentTheme } from './markers.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MINUS = '−';

const NICE_125 = Object.freeze([1, 2, 5]);
/** Finer "nice" ladder for the top of a linear axis that starts at zero. */
export const LINEAR_LADDER = Object.freeze([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8]);

const TICK = 4;          // outward major tick, px
const MINOR_TICK = 2;    // outward minor tick, px
const TICK_GAP = 3;      // tick end to label edge, px
const SUB_SHIFT = 3;     // subscript baseline drop, px
const TICK_FONT = 11;    // .t-tick size, for width estimates
const LABEL_FONT = 12.5; // .t-label / .t-value size
/** A species marker set beside a label: the 12px marker of markerSVG() and panel b's headers. */
const LEGEND_MARK_R = 12 * 0.36;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Nearest half-pixel coordinate: where a 1px hairline must be centred to be crisp. */
export function snapHalf(v) {
  return Math.round(v - 0.5) + 0.5;
}

/** Strip binary noise from a product such as 3 * 0.1. */
function cleanFloat(v) {
  return Number(v.toPrecision(12));
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function positiveOr(v, fallback) {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Fixed-decimal number with a true minus sign and no "−0.0". */
export function formatNumber(v, decimals = 0) {
  if (!Number.isFinite(v)) return '';
  const s = Math.abs(v).toFixed(decimals);
  return v < 0 && Number(s) !== 0 ? MINUS + s : s;
}

/** Signed value for affinities: "+0.45", "−0.45", and plain "0.00" for zero. */
export function formatSigned(v, decimals = 2) {
  if (!Number.isFinite(v)) return '';
  const s = Math.abs(v).toFixed(decimals);
  if (Number(s) === 0) return s;
  return (v < 0 ? MINUS : '+') + s;
}

/** Decimals needed to print every multiple of `step` exactly (0.5 -> 1, 0.05 -> 2, 2 -> 0). */
export function decimalsFor(step) {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  for (let d = 0; d <= 10; d++) {
    const m = step * 10 ** d;
    if (Math.abs(m - Math.round(m)) < 1e-6 * Math.max(1, m)) return d;
  }
  return 10;
}

/** Smallest value of the form mantissa x 10^k that is >= x (1-2-5 by default). */
export function ceilNice(x, mantissas = NICE_125) {
  if (!(x > 0) || !Number.isFinite(x)) return mantissas[0];
  const e = Math.floor(Math.log10(x));
  for (let k = e; k <= e + 1; k++) {
    const base = 10 ** k;
    for (let m = 0; m < mantissas.length; m++) {
      const v = cleanFloat(mantissas[m] * base);
      if (v >= x * (1 - 1e-9)) return v;
    }
  }
  return cleanFloat(mantissas[0] * 10 ** (e + 2));
}

/**
 * Labelled tick spacing, in data units, from the 1-2-5 sequence (1, 2, 5, 10,
 * 20 ... and 0.5, 0.2, 0.1 when zoomed far in) so that neighbouring labelled
 * ticks are at least `minPx` apart.
 */
export function tickStepFor(pxPerUnit, minPx = 56) {
  return ceilNice(minPx / pxPerUnit);
}

const MINOR_DIV_1 = Object.freeze([5, 2]);
const MINOR_DIV_2 = Object.freeze([4, 2]);
const MINOR_DIV_5 = Object.freeze([5]);

/** Unlabelled minor spacing for a 1-2-5 major step, or 0 when minors would crowd. */
export function minorStepFor(step, pxPerUnit, minPx = 7) {
  if (!(step > 0) || !(pxPerUnit > 0)) return 0;
  const e = Math.floor(Math.log10(step) + 1e-9);
  const mantissa = Math.round(step / 10 ** e);
  const divisors = mantissa === 2 ? MINOR_DIV_2 : mantissa === 5 ? MINOR_DIV_5 : MINOR_DIV_1;
  for (let k = 0; k < divisors.length; k++) {
    const minor = step / divisors[k];
    if (minor * pxPerUnit >= minPx) return cleanFloat(minor);
  }
  return 0;
}

/**
 * Ticks on a periodic axis. The visible interval is [start, start + span) in
 * unwrapped data units; the axis repeats every `period`. Ticks sit at torus
 * coordinates k * step (0 <= k * step < period), so where the view crosses
 * the seam the labels run "... 16, 18, 0, 2 ...". That seam is honest.
 *
 * Writes the position of each tick as a fraction of the span (ascending) into
 * outFrac and its torus coordinate into outValue; returns the count.
 */
export function torusTicks(start, span, period, step, outFrac, outValue) {
  if (!(span > 0) || !(period > 0) || !(step > 0)) return 0;
  const cap = Math.min(outFrac.length, outValue.length);
  const end = start + span;
  const lastK = Math.ceil(period / step - 1e-9) - 1; // largest k with k * step < period
  let n = 0;
  for (let p = Math.floor(start / period); p * period < end; p++) {
    const base = p * period;
    const lo = Math.max(start, base);
    const hi = Math.min(end, base + period);
    for (let k = Math.max(0, Math.ceil((lo - base) / step - 1e-9)); k <= lastK; k++) {
      const x = base + k * step;
      if (x >= hi) break;
      if (n >= cap) return n;
      outFrac[n] = Math.max(0, (x - start) / span);
      outValue[n] = k * step;
      n++;
    }
  }
  return n;
}

/**
 * Ticks for a log axis on [min, max]: every 1-2-5 value in the range. If
 * neighbouring labels would sit closer than `minGapPx`, only decades are
 * labelled (every one, or every second, ...) plus the top tick when it has
 * room, and the rest become minor ticks.
 * Writes values and labelled flags (1/0); returns the count.
 */
export function logTicks(min, max, pxPerDecade, minGapPx, outValues, outLabelled) {
  if (!(min > 0) || !(max > min)) return 0;
  const cap = Math.min(outValues.length, outLabelled.length);
  const e0 = Math.floor(Math.log10(min) + 1e-9);
  const e1 = Math.floor(Math.log10(max) + 1e-9);
  // The tightest neighbours in a 1-2-5 ladder (1 to 2, 5 to 10) are log10(2) apart.
  const allFit = Math.LOG10E * Math.LN2 * pxPerDecade >= minGapPx;
  let every = 1;
  if (!allFit) while (every * pxPerDecade < minGapPx && every < 8) every++;
  let n = 0;
  let lastLabelled = -1;
  for (let e = e0; e <= e1 && n < cap; e++) {
    for (let m = 0; m < NICE_125.length && n < cap; m++) {
      const v = cleanFloat(NICE_125[m] * 10 ** e);
      if (v < min * (1 - 1e-9) || v > max * (1 + 1e-9)) continue;
      outValues[n] = v;
      outLabelled[n] = allFit || (NICE_125[m] === 1 && ((e % every) + every) % every === 0) ? 1 : 0;
      if (outLabelled[n]) lastLabelled = n;
      n++;
    }
  }
  // In decade mode, still name the top of the axis when it clears the last label.
  const top = n - 1;
  if (top > lastLabelled && lastLabelled >= 0 &&
      Math.log10(outValues[top] / outValues[lastLabelled]) * pxPerDecade >= minGapPx) {
    outLabelled[top] = 1;
  }
  return n;
}

/**
 * Axis top with hysteresis. Grows at once to ceilFn(dataMax) when the data
 * exceed the current top; shrinks only when the data would still fit with a
 * margin (dataMax <= shrinkFraction * newTop), so a value hovering near a
 * ladder step never makes the axis flicker.
 */
export function hysteresisTop(current, dataMax, ceilFn, shrinkFraction = 0.7) {
  if (!(dataMax > 0) || !Number.isFinite(dataMax)) return current;
  const needed = ceilFn(dataMax);
  if (!(current > 0) || needed > current) return needed;
  const relaxed = ceilFn(dataMax / shrinkFraction);
  return relaxed < current ? relaxed : current;
}

/** Linear tick step for an axis [0, top] drawn over `px` pixels. */
export function linearTickStep(top, px, minGapPx) {
  return ceilNice((top * minGapPx) / Math.max(1, px));
}

/**
 * Scale bar length in data units: 1, 2 or 5 x 10^k, preferring 15-25% of the
 * visible width and otherwise the candidate closest to 20%.
 */
export function scaleBarUnits(viewUnits, lo = 0.15, hi = 0.25, target = 0.2) {
  if (!(viewUnits > 0) || !Number.isFinite(viewUnits)) return 0;
  const e = Math.floor(Math.log10(viewUnits * target));
  let best = 0;
  let bestScore = Infinity;
  for (let k = e - 1; k <= e + 1; k++) {
    for (let m = 0; m < NICE_125.length; m++) {
      const v = cleanFloat(NICE_125[m] * 10 ** k);
      const f = v / viewUnits;
      const score = Math.abs(Math.log(f / target)) + (f >= lo && f <= hi ? 0 : 10);
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
  }
  return best;
}

/**
 * Greedy label culling along one axis. Centres must be ascending. A label
 * that would overlap the last kept one is dropped, unless its priority is
 * higher, in which case the kept one goes instead. Writes 1/0 into `keep`.
 * Pass a reusable Int32Array as `stack` to avoid allocating per call.
 */
export function cullLabels(centers, halfWidths, priority, n, gap, keep, stack = new Int32Array(n)) {
  let top = 0;
  for (let k = 0; k < n; k++) {
    keep[k] = 1;
    while (top > 0) {
      const last = stack[top - 1];
      if (centers[last] + halfWidths[last] + gap <= centers[k] - halfWidths[k]) break;
      if (priority[k] > priority[last]) {
        keep[last] = 0;
        top--;
      } else {
        keep[k] = 0;
        break;
      }
    }
    if (keep[k]) stack[top++] = k;
  }
}

const SPREAD_CAP = 16;
const spreadScratch = {
  order: new Int32Array(SPREAD_CAP),
  start: new Int32Array(SPREAD_CAP),
  count: new Int32Array(SPREAD_CAP),
  sum: new Float64Array(SPREAD_CAP),
  top: new Float64Array(SPREAD_CAP),
};

/** Top slot of cluster c: centred on its members' mean, kept inside [lo, hi]. */
function clusterTop(sum, count, c, gap, lo, hi) {
  return clamp(sum[c] / count[c], lo, Math.max(lo, hi - (count[c] - 1) * gap));
}

/**
 * Spread label centres apart by at least `gap`, inside [lo, hi], moving each
 * as little as possible from its desired position (clusters of colliding
 * labels are centred on the mean of their desired positions). Input order is
 * preserved in the output arrays; ordering along the axis follows `desired`.
 * Runs every animation frame for the panel d readouts, so it allocates
 * nothing for up to SPREAD_CAP labels.
 */
export function spreadLabels(desired, n, gap, lo, hi, out) {
  if (n <= 0) return;
  const s = n <= SPREAD_CAP ? spreadScratch : {
    order: new Int32Array(n), start: new Int32Array(n), count: new Int32Array(n),
    sum: new Float64Array(n), top: new Float64Array(n),
  };
  const { order, start, count, sum, top } = s;
  for (let k = 0; k < n; k++) order[k] = k;
  for (let k = 1; k < n; k++) { // insertion sort: n is at most a handful
    const idx = order[k];
    let m = k - 1;
    while (m >= 0 && desired[order[m]] > desired[idx]) {
      order[m + 1] = order[m];
      m--;
    }
    order[m + 1] = idx;
  }
  let c = 0;
  for (let k = 0; k < n; k++) {
    start[c] = k;
    count[c] = 1;
    sum[c] = desired[order[k]];
    top[c] = clusterTop(sum, count, c, gap, lo, hi);
    c++;
    while (c > 1 && top[c - 2] + count[c - 2] * gap > top[c - 1]) {
      const a = c - 2;
      const b = c - 1;
      sum[a] += sum[b] - count[b] * count[a] * gap; // b's members move count[a] slots down
      count[a] += count[b];
      top[a] = clusterTop(sum, count, a, gap, lo, hi);
      c--;
    }
  }
  for (let k = 0; k < c; k++) {
    for (let m = 0; m < count[k]; m++) out[order[start[k] + m]] = top[k] + m * gap;
  }
}

/** Exponential smoothing of `current` toward `target` over time constant `tau` (s). */
export function smoothToward(current, target, dt, tau) {
  if (!(tau > 0) || !Number.isFinite(current)) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** Rough width of a run of label text, used only where exact metrics are not needed. */
export function estimateTextWidth(str, fontPx) {
  return String(str).length * fontPx * 0.56;
}

/**
 * Fixed-capacity ring buffer of per-species samples: time, species count,
 * aggregation and mean speed per species. No allocation after construction.
 *
 * With `minSpacing` > 0, while the newest sample sits closer than that to
 * the one before it, the next sample replaces it instead of appending.
 * Stored samples then stay at least minSpacing apart, so the buffer spans
 * capacity * minSpacing of time even when samples arrive faster than planned
 * (a simulation running slower than real time), and the newest sample is
 * always the latest value.
 */
export class TraceBuffer {
  constructor(capacity, channels = SPECIES_MAX, minSpacing = 0) {
    this.capacity = Math.max(2, capacity | 0);
    this.channels = channels;
    this.minSpacing = minSpacing > 0 ? minSpacing : 0;
    this.time = new Float64Array(this.capacity);
    this.species = new Uint8Array(this.capacity);
    this.aggregation = new Float32Array(this.capacity * channels);
    this.speed = new Float32Array(this.capacity * channels);
    this.head = 0;   // next slot to write
    this.length = 0; // live samples
  }

  clear() {
    this.head = 0;
    this.length = 0;
  }

  push(t, S, aggregation, speed) {
    const cap = this.capacity;
    // The newest sample is provisional while it sits closer than minSpacing to
    // the one before it: replace it rather than append after it.
    const replace = this.minSpacing > 0 && this.length >= 2 &&
      this.time[this.slot(this.length - 1)] - this.time[this.slot(this.length - 2)] < this.minSpacing;
    const k = replace ? (this.head - 1 + cap) % cap : this.head;
    const ch = this.channels;
    const live = clamp(S | 0, 0, ch);
    this.time[k] = t;
    this.species[k] = live;
    const o = k * ch;
    for (let s = 0; s < ch; s++) {
      this.aggregation[o + s] = s < live && aggregation ? +aggregation[s] : NaN;
      this.speed[o + s] = s < live && speed ? +speed[s] : NaN;
    }
    if (replace) return;
    this.head = (k + 1) % cap;
    if (this.length < cap) this.length++;
  }

  /** Physical slot of the n-th oldest live sample (0 = oldest). */
  slot(n) {
    return (this.head - this.length + n + this.capacity * 2) % this.capacity;
  }

  lastTime() {
    return this.length ? this.time[this.slot(this.length - 1)] : NaN;
  }
}

// ---------------------------------------------------------------------------
// DOM plumbing (only reached from the create* functions)
// ---------------------------------------------------------------------------

const STYLE_ID = 'tropism-plots-css';
const PLOTS_CSS = `
.plots-frame { position: relative; width: 100%; height: 100%; min-width: 0; }
.plots-sizer { max-height: 100%; overflow: hidden; }
.plots-spacer { width: 100%; }
.plots-frame > svg.plots-svg { position: absolute; left: 0; top: 0; }
svg.plots-svg { display: block; overflow: visible; }
svg.plots-axes { position: absolute; left: 0; top: 0; pointer-events: none; }
svg.plots-svg .pl-ink { fill: none; stroke: var(--ink); stroke-width: 1px; shape-rendering: crispEdges; }
svg.plots-svg .pl-rule { fill: none; stroke: var(--rule); stroke-width: 1px; shape-rendering: crispEdges; }
svg.plots-svg .pl-band { fill: var(--hilite); stroke: none; }
svg.plots-svg .pl-curve { fill: none; stroke: var(--ink); stroke-width: 1.5px; stroke-linejoin: round; stroke-linecap: round; }
svg.plots-svg .pl-trace { fill: none; stroke-width: 1.25px; stroke-linejoin: round; stroke-linecap: round; }
svg.plots-svg .pl-mark { stroke: var(--paper); stroke-width: 1.5px; stroke-linejoin: round; paint-order: stroke; }
svg.plots-svg .pl-halo { stroke: var(--paper); stroke-width: 2px; stroke-linejoin: round; paint-order: stroke; }
svg.plots-svg .pl-ink-text { fill: var(--ink); }
svg.plots-svg .pl-bar { fill: var(--ink); stroke: var(--paper); stroke-width: 2px; paint-order: stroke; shape-rendering: crispEdges; }
svg.plots-svg .pl-sub { font-family: var(--font-label); font-style: normal; font-weight: 500; font-size: 0.72em; }
`;

const ids = { next: 0 };

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = PLOTS_CSS;
  (document.head || document.documentElement).appendChild(style);
}

function svgEl(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) if (attrs[k] != null) node.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(node);
  return node;
}

function textEl(parent, cls, anchor, dy, content) {
  const t = svgEl('text', { class: cls, 'text-anchor': anchor, dy }, parent);
  if (content != null) t.textContent = content;
  return t;
}

/**
 * Fill a <text> with typeset runs. A run is a plain string, or an object:
 * { t } text, { m } math italic, { sub } upright subscript; any of them may
 * carry { cls } for an extra class and { dx } for a leading gap in px (SVG
 * collapses repeated spaces). Subscripts use dy (Firefox ignores
 * baseline-shift), and the baseline is restored for the run after.
 * Returns the created tspans so callers can update one run in place.
 */
function setRuns(text, runs) {
  text.textContent = '';
  const spans = [];
  let shift = 0;
  for (const run of runs) {
    const span = svgEl('tspan', null, text);
    const r = typeof run === 'string' ? { t: run } : run;
    const classes = [];
    let want = 0;
    if (r.m != null) {
      classes.push('t-math');
      span.textContent = r.m;
    } else if (r.sub != null) {
      classes.push('pl-sub');
      span.textContent = r.sub;
      want = SUB_SHIFT;
    } else {
      span.textContent = r.t;
    }
    if (r.cls) classes.push(r.cls);
    if (classes.length) span.setAttribute('class', classes.join(' '));
    if (r.dx) span.setAttribute('dx', String(r.dx));
    if (want !== shift) {
      span.setAttribute('dy', String(want - shift));
      shift = want;
    }
    spans.push(span);
  }
  return spans;
}

function setVisible(node, on) {
  if (on) node.removeAttribute('visibility');
  else node.setAttribute('visibility', 'hidden');
}

function motionQuery() {
  if (typeof matchMedia !== 'function') return { matches: false };
  return matchMedia('(prefers-reduced-motion: reduce)');
}

function observeSize(target, onSize) {
  if (typeof ResizeObserver !== 'function') return { disconnect() {} };
  const ro = new ResizeObserver((entries) => {
    const box = entries[entries.length - 1].contentRect;
    onSize(Math.floor(box.width), Math.floor(box.height));
  });
  ro.observe(target);
  return ro;
}

/** Call `cb` whenever web fonts finish loading (metrics change). Returns an unsubscribe. */
function onFontsLoaded(cb) {
  const fonts = typeof document !== 'undefined' ? document.fonts : null;
  if (!fonts || typeof fonts.addEventListener !== 'function') return () => {};
  fonts.addEventListener('loadingdone', cb);
  return () => fonts.removeEventListener('loadingdone', cb);
}

const widthCache = new Map();

/** Measured advance width of a text node, cached by key; estimated when unmeasurable. */
function textWidth(node, key, fontPx) {
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  let w = 0;
  try {
    w = node.getComputedTextLength();
  } catch {
    w = 0;
  }
  if (!(w > 0)) return estimateTextWidth(node.textContent, fontPx);
  widthCache.set(key, w);
  return w;
}

/**
 * Mount the sizing frame used by panels c and d: a relative box holding an
 * in-flow spacer and an absolutely positioned SVG. In an auto-height
 * container the spacer gives the panel its height, clamp(width / aspect,
 * minHeight, maxHeight), entirely in CSS (aspect-ratio plus min/max-height);
 * in a container with a definite height the frame fills it and the sizer
 * clips the spacer. Because the height follows from the width in layout, the
 * resize callback never writes anything that changes the observed box, so a
 * width change settles in one pass (no "ResizeObserver loop" error, no frame
 * drawn at a stale height). Call observe(onSize) once every element exists;
 * it returns the observer.
 */
function mountFrame(container, sizing) {
  const frame = document.createElement('div');
  frame.className = 'plots-frame';
  const sizer = document.createElement('div');
  sizer.className = 'plots-sizer';
  sizer.setAttribute('aria-hidden', 'true');
  const spacer = document.createElement('div');
  spacer.className = 'plots-spacer';
  spacer.style.aspectRatio = String(sizing.aspect);
  spacer.style.minHeight = `${sizing.minHeight}px`;
  spacer.style.maxHeight = `${sizing.maxHeight}px`;
  sizer.appendChild(spacer);
  const svg = svgEl('svg', { class: 'plots-svg', width: 0, height: 0 });
  frame.append(sizer, svg);
  container.appendChild(frame);

  // Only the absolutely positioned SVG is written here; it is out of flow.
  const observe = (onSize) => observeSize(frame, (w, h) => {
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    onSize(w, h);
  });
  return { frame, svg, observe };
}

function speciesColor(s, theme) {
  return SPECIES[s][theme];
}

// ---------------------------------------------------------------------------
// Panel c: the force law of the hovered pair
// ---------------------------------------------------------------------------

const FC_R_MAX = 1.1;   // x domain is r / r_max in [0, 1.1]
const FC_Y_PAD = 1.08;  // y domain [-1.08, 1.08] so a curve at +-1 clears the axes
const FC_MARGIN = Object.freeze({ left: 34, right: 10, top: 26, bottom: 36 });
const FC_TWEEN_MS = 150;
const FC_MARK_R = LEGEND_MARK_R; // relation markers, the same size as panel b's headers
const FC_MARK_SLOT = 5.5;

/**
 * createForceCurve(container, opts?) -> { update({ i, j, a, beta }), refreshTheme(), destroy() }
 * opts (optional extra): { aspect = 1.6, minHeight = 150, maxHeight = 250 } for auto-height containers.
 */
export function createForceCurve(container, opts = {}) {
  ensureStyles();
  const sizing = {
    aspect: positiveOr(opts.aspect, 1.6),
    minHeight: positiveOr(opts.minHeight, 150),
    maxHeight: positiveOr(opts.maxHeight, 250),
  };
  const reduce = motionQuery();

  let W = 0;
  let H = 0;
  let geo = null; // { x0, x1, yTop, yBot } once laid out
  const target = { i: -1, j: -1, a: 0, beta: 0.3 };
  const shown = { a: 0, beta: 0.3 };
  const from = { a: 0, beta: 0.3 };
  let hasTarget = false;
  let tweenStart = 0;
  let raf = 0;

  const { frame, svg, observe } = mountFrame(container, sizing);
  svg.setAttribute('role', 'img');

  // Back to front: core band, zero line, axes, curve, labels.
  const band = svgEl('rect', { class: 'pl-band' }, svg);
  const bandLabel = textEl(svg, 't-tick', 'middle', '0.71em', 'core');
  const zero = svgEl('path', { class: 'pl-rule' }, svg);
  const axes = svgEl('path', { class: 'pl-ink' }, svg);
  const betaTick = svgEl('path', { class: 'pl-ink' }, svg);
  const curve = svgEl('path', { class: 'pl-curve' }, svg);

  const xZero = textEl(svg, 't-tick', 'middle', '0.71em', '0');
  const xHalf = textEl(svg, 't-tick', 'middle', '0.71em', '0.5');
  const xOne = textEl(svg, 't-tick', 'middle', '0.71em', '1');
  const xBeta = textEl(svg, 't-tick', 'middle', '0.71em');
  setRuns(xBeta, [{ m: 'β', cls: 'pl-ink-text' }]);
  const yLabels = [
    [1, textEl(svg, 't-tick', 'end', '0.35em', '1')],
    [0, textEl(svg, 't-tick', 'end', '0.35em', '0')],
    [-1, textEl(svg, 't-tick', 'end', '0.35em', formatNumber(-1))],
  ];
  const xTitle = textEl(svg, 't-axis', 'middle', null);
  setRuns(xTitle, [{ m: 'r' }, ' / ', { m: 'r' }, { sub: 'max' }]);
  const yTitle = textEl(svg, 't-axis', 'start', '0.35em');
  setRuns(yTitle, [{ m: 'F' }]);
  const noteAttract = textEl(svg, 't-tick', 'end', '0.35em', 'attract');
  const noteRepel = textEl(svg, 't-tick', 'end', '0.35em', 'repel');

  // Relation readout, top right: [marker] A toward [marker] B   a = +0.45
  const rel = svgEl('g', null, svg);
  const mkI = svgEl('path', null, rel);
  const tI = textEl(rel, 't-label', 'start', '0.35em');
  const tWord = textEl(rel, 't-tick', 'start', '0.35em', 'toward');
  const mkJ = svgEl('path', null, rel);
  const tJ = textEl(rel, 't-label', 'start', '0.35em');
  const tVal = textEl(rel, 't-value', 'start', '0.35em');
  const valSpans = setRuns(tVal, [{ m: 'a' }, ' = ', '0.00']);
  const coarse = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
  const hint = textEl(svg, 't-tick', 'end', '0.35em', coarse ? 'tap a bubble in b' : 'hover a bubble in b');

  const xv = (r) => geo.x0 + (r / FC_R_MAX) * (geo.x1 - geo.x0);
  const yv = (F) => geo.yBot - ((F + FC_Y_PAD) / (2 * FC_Y_PAD)) * (geo.yBot - geo.yTop);

  function layout() {
    const x0 = snapHalf(FC_MARGIN.left);
    const x1 = snapHalf(W - FC_MARGIN.right);
    const yTop = snapHalf(FC_MARGIN.top);
    const yBot = snapHalf(H - FC_MARGIN.bottom);
    if (x1 - x0 < 60 || yBot - yTop < 40) {
      geo = null;
      setVisible(svg, false);
      return;
    }
    setVisible(svg, true);
    geo = { x0, x1, yTop, yBot };

    // Left and bottom axes with outward ticks at F = -1, 0, 1 and r = 0, 0.5, 1.
    let d = `M${x0} ${yTop}V${yBot + 0.5}M${x0 - 0.5} ${yBot}H${x1}`;
    for (const [F, label] of yLabels) {
      const py = snapHalf(yv(F));
      d += `M${x0} ${py}H${x0 - 0.5 - TICK}`;
      label.setAttribute('x', String(x0 - 0.5 - TICK - TICK_GAP));
      label.setAttribute('y', String(py));
    }
    const labelY = String(yBot + 0.5 + TICK + TICK_GAP);
    for (const [r, label] of [[0, xZero], [0.5, xHalf], [1, xOne]]) {
      const px = snapHalf(xv(r));
      d += `M${px} ${yBot}V${yBot + 0.5 + TICK}`;
      label.setAttribute('x', String(px));
      label.setAttribute('y', labelY);
    }
    axes.setAttribute('d', d);
    xBeta.setAttribute('y', labelY);

    const z = snapHalf(yv(0));
    zero.setAttribute('d', `M${x0 + 0.5} ${z}H${x1}`);

    xTitle.setAttribute('x', String((x0 + x1) / 2));
    xTitle.setAttribute('y', String(yBot + 30));
    yTitle.setAttribute('x', '2');
    yTitle.setAttribute('y', String((yTop + yBot) / 2));

    noteAttract.setAttribute('x', String(x1 - 1));
    noteAttract.setAttribute('y', String(yv(0.74)));
    noteRepel.setAttribute('x', String(x1 - 1));
    noteRepel.setAttribute('y', String(yv(-0.74)));

    hint.setAttribute('x', String(x1));
    hint.setAttribute('y', '11');

    drawCurve();
    layoutRelation();
  }

  /** Everything that depends on a and beta: the curve, the core band and the beta tick. */
  function drawCurve() {
    if (!geo) return;
    const { x0, x1, yTop, yBot } = geo;
    const a = shown.a;
    const beta = shown.beta;
    const bx = xv(beta);

    band.setAttribute('x', String(x0 + 0.5));
    band.setAttribute('y', String(yTop));
    band.setAttribute('width', String(Math.max(0, bx - x0 - 0.5)));
    band.setAttribute('height', String(yBot - 0.5 - yTop));
    const bandFits = bx - x0 >= 34;
    setVisible(bandLabel, bandFits);
    if (bandFits) {
      bandLabel.setAttribute('x', String((x0 + bx) / 2));
      bandLabel.setAttribute('y', String(yTop + 4));
    }

    const px = snapHalf(bx);
    betaTick.setAttribute('d', `M${px} ${yBot}V${yBot + 0.5 + TICK}`);
    xBeta.setAttribute('x', String(px));
    // beta is the label that matters; numeric neighbours give way to it.
    setVisible(xZero, bx - x0 >= 16);
    setVisible(xHalf, Math.abs(bx - xv(0.5)) >= 24);
    setVisible(xOne, Math.abs(bx - xv(1)) >= 16);

    // Sample the law on a regular grid plus its kinks, so the polyline is exact.
    const n = clamp(Math.round((x1 - x0) / 3), 32, 180);
    const k1 = beta;
    const k2 = (1 + beta) / 2;
    const k3 = 1;
    let next = 0; // index of the next kink to emit
    let path = '';
    const emit = (r) => {
      const F = clamp(forceLaw(r, a, beta), -FC_Y_PAD, FC_Y_PAD);
      path += (path ? 'L' : 'M') + xv(r).toFixed(2) + ' ' + yv(F).toFixed(2);
    };
    const kink = (k) => (k === 0 ? k1 : k === 1 ? k2 : k3);
    for (let k = 0; k <= n; k++) {
      const r = (FC_R_MAX * k) / n;
      while (next < 3 && kink(next) < r - 1e-9) emit(kink(next++));
      if (next < 3 && Math.abs(kink(next) - r) <= 1e-9) next++;
      emit(r);
    }
    curve.setAttribute('d', path);
  }

  /** The relation readout, laid out right to left from measured text widths. */
  function layoutRelation() {
    const pair = target.i >= 0;
    setVisible(rel, pair);
    setVisible(hint, !pair);
    if (!pair || !geo) return;
    const spI = SPECIES[target.i];
    const spJ = SPECIES[target.j];
    const value = formatSigned(target.a, 2);
    // Writes first, then one batch of reads, then position writes.
    tI.textContent = spI.letter;
    tJ.textContent = spJ.letter;
    valSpans[2].textContent = value;
    const wVal = textWidth(tVal, 'fc-val|' + value, LABEL_FONT);
    const wJ = textWidth(tJ, 'fc-l|' + spJ.letter, LABEL_FONT);
    const wI = textWidth(tI, 'fc-l|' + spI.letter, LABEL_FONT);
    const wWord = textWidth(tWord, 'fc-word', TICK_FONT);

    const y = 11;
    const place = (withWord) => {
      let x = geo.x1 - wVal;
      const pos = { val: x };
      x -= 12 + wJ;
      pos.j = x;
      x -= 3 + FC_MARK_SLOT;
      pos.mkJ = x;
      x -= FC_MARK_SLOT + (withWord ? 6 + wWord : 0);
      pos.word = x;
      x -= (withWord ? 6 : 8) + wI;
      pos.i = x;
      x -= 3 + FC_MARK_SLOT;
      pos.mkI = x;
      return pos;
    };
    let pos = place(true);
    const withWord = pos.mkI - FC_MARK_SLOT >= 0;
    if (!withWord) pos = place(false);
    setVisible(tWord, withWord);
    tVal.setAttribute('x', pos.val.toFixed(1));
    tJ.setAttribute('x', pos.j.toFixed(1));
    tWord.setAttribute('x', pos.word.toFixed(1));
    tI.setAttribute('x', pos.i.toFixed(1));
    for (const t of [tVal, tJ, tWord, tI]) t.setAttribute('y', String(y));
    mkI.setAttribute('transform', `translate(${pos.mkI.toFixed(1)} ${y})`);
    mkJ.setAttribute('transform', `translate(${pos.mkJ.toFixed(1)} ${y})`);
  }

  function paintMarkers() {
    if (target.i < 0) return;
    const theme = currentTheme();
    mkI.setAttribute('d', markerPath(SPECIES[target.i].marker, FC_MARK_R));
    mkI.setAttribute('fill', speciesColor(target.i, theme));
    mkJ.setAttribute('d', markerPath(SPECIES[target.j].marker, FC_MARK_R));
    mkJ.setAttribute('fill', speciesColor(target.j, theme));
  }

  function describe() {
    const beta = target.beta.toFixed(2);
    if (target.i < 0) {
      svg.setAttribute('aria-label', `Force law with no pair selected: a = 0, β = ${beta}. Hover a bubble in panel b to see its pair.`);
      return;
    }
    const A = SPECIES[target.i].letter;
    const B = SPECIES[target.j].letter;
    const sense = target.a > 0 ? `pulls ${A} toward ${B}` : target.a < 0 ? `pushes ${A} away from ${B}` : `has no effect beyond the core`;
    svg.setAttribute('aria-label', `Force law of ${A} toward ${B}: a = ${formatSigned(target.a, 2)}, β = ${beta}. Beyond the core it ${sense}.`);
  }

  function stepTween(now) {
    raf = 0;
    const p = clamp((now - tweenStart) / FC_TWEEN_MS, 0, 1);
    const e = 1 - (1 - p) ** 3; // ease-out cubic
    shown.a = from.a + (target.a - from.a) * e;
    shown.beta = from.beta + (target.beta - from.beta) * e;
    drawCurve();
    if (p < 1) raf = requestAnimationFrame(stepTween);
  }

  function snapToTarget() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    shown.a = target.a;
    shown.beta = target.beta;
    drawCurve();
  }

  const unsubscribeFonts = onFontsLoaded(() => {
    widthCache.clear();
    layoutRelation();
  });

  describe();
  const ro = observe((w, h) => {
    W = w;
    H = h;
    layout();
  });

  return {
    update({ i = -1, j = -1, a = 0, beta } = {}) {
      const pair = Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < SPECIES.length && j < SPECIES.length;
      const nextA = pair && Number.isFinite(a) ? clamp(a, -1, 1) : 0;
      const nextBeta = Number.isFinite(beta) ? clamp(beta, 0.01, 0.99) : target.beta;
      const pairChanged = (pair ? i : -1) !== target.i || (pair ? j : -1) !== target.j;
      const lawChanged = nextA !== target.a || nextBeta !== target.beta;
      target.i = pair ? i : -1;
      target.j = pair ? j : -1;
      target.a = nextA;
      target.beta = nextBeta;

      if (pairChanged) paintMarkers();
      layoutRelation();
      describe();

      if (!hasTarget || !geo || reduce.matches) {
        hasTarget = true;
        snapToTarget();
        return;
      }
      if (!lawChanged) return;
      from.a = shown.a;
      from.beta = shown.beta;
      tweenStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!raf) raf = requestAnimationFrame(stepTween);
    },

    refreshTheme() {
      paintMarkers();
    },

    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      unsubscribeFonts();
      frame.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Panel d: live traces of aggregation (log) and speed (linear)
// ---------------------------------------------------------------------------

const TR_MARGIN = Object.freeze({ left: 34, right: 56, titleH: 19, gap: 12, bottom: 24 });
const AGG_MIN = 0.5;
const AGG = 0;
const SPEED = 1;
const VALUE_TAU = 0.25;   // s, easing of the readout values
const LABEL_GAP = 14;     // px between stacked readout centres
const END_MARK_R = 3.4;   // ~7px endpoint marker
const COL_MARK_R = LEGEND_MARK_R; // readout markers beside the values
const GAP_SECONDS = 1;    // a longer hole between samples breaks the line

const aggCeil = (x) => Math.max(2, ceilNice(x));
const speedCeil = (x) => Math.max(0.1, ceilNice(x * 1.05, LINEAR_LADDER));

/**
 * createTraces(container, opts) -> { setSpecies(S), push(stats, timeSeconds), clear(), refreshTheme(), destroy() }
 * opts: { seconds = 20 } plus optional extras { aspect = 1.3, minHeight = 210, maxHeight = 300 }.
 */
export function createTraces(container, opts = {}) {
  ensureStyles();
  const seconds = positiveOr(opts.seconds, 20);
  const sizing = {
    aspect: positiveOr(opts.aspect, 1.3),
    minHeight: positiveOr(opts.minHeight, 210),
    maxHeight: positiveOr(opts.maxHeight, 300),
  };
  // Sized for seconds * 12 samples (pushes come at about 10 Hz); thinning by
  // time keeps the whole window covered if sim time runs slower than that.
  const capacity = Math.ceil(seconds * 12);
  const buffer = new TraceBuffer(capacity, SPECIES_MAX, seconds / (capacity - 2));
  const reduce = motionQuery();
  const uid = `plots-tr-${++ids.next}`;

  let W = 0;
  let H = 0;
  let x0 = 0;
  let x1 = 0;
  let laidOut = false;
  let displayS = 0;
  let dirty = true;
  let raf = 0;
  let lastFrame = 0;

  const { frame, svg, observe } = mountFrame(container, sizing);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label',
    `Live traces of the last ${formatNumber(seconds)} seconds: aggregation of each species on a log scale, where 1 is well mixed, and mean speed of each species in r max per second.`);
  const defs = svgEl('defs', null, svg);

  // Time axis: majors labelled at the bottom only, minors in between.
  const tStep = ceilNice(seconds / 2.5);
  const tMinor = tStep / 2;

  const rows = [makeRow(AGG), makeRow(SPEED)];
  const timeLabels = [];

  function makeRow(kind) {
    const id = `${uid}-${kind}`;
    const clip = svgEl('clipPath', { id }, defs);
    const clipRect = svgEl('rect', null, clip);
    const g = svgEl('g', null, svg);
    const title = svgEl('text', { class: 't-axis' }, g);
    if (kind === AGG) {
      setRuns(title, ['aggregation', { t: 'log scale, 1 = well mixed', cls: 't-tick', dx: 8 }]);
    } else {
      setRuns(title, ['speed (', { m: 'r' }, { sub: 'max' }, '/s)']);
    }
    const ref = svgEl('path', { class: 'pl-rule' }, g);
    const axis = svgEl('path', { class: 'pl-ink' }, g);
    const lines = svgEl('g', { 'clip-path': `url(#${id})` }, g);
    const paths = [];
    const ends = [];
    const colMarks = [];
    const colTexts = [];
    for (let s = 0; s < SPECIES_MAX; s++) {
      paths.push(svgEl('path', { class: 'pl-trace', visibility: 'hidden' }, lines));
    }
    for (let s = 0; s < SPECIES_MAX; s++) {
      ends.push(svgEl('path', { class: 'pl-mark', d: markerPath(SPECIES[s].marker, END_MARK_R), visibility: 'hidden' }, g));
    }
    for (let s = 0; s < SPECIES_MAX; s++) {
      colMarks.push(svgEl('path', { d: markerPath(SPECIES[s].marker, COL_MARK_R), visibility: 'hidden' }, g));
      colTexts.push(textEl(g, 't-label', 'end', '0.35em'));
      setVisible(colTexts[s], false);
    }
    return {
      kind, clipRect, title, ref, axis, paths, ends, colMarks, colTexts,
      yLabels: [],
      top: kind === AGG ? 2 : 0.5,
      drawnTop: NaN,
      plotTop: 0,
      plotBot: 0,
      decimals: 1,
      shown: new Float64Array(SPECIES_MAX),
      target: new Float64Array(SPECIES_MAX),
      has: new Uint8Array(SPECIES_MAX),
      labelY: new Float64Array(SPECIES_MAX),
      labelPlaced: new Uint8Array(SPECIES_MAX),
      desired: new Float64Array(SPECIES_MAX),
      spread: new Float64Array(SPECIES_MAX),
      members: new Int32Array(SPECIES_MAX),
      visible: new Uint8Array(SPECIES_MAX),
      tickValues: new Float64Array(32),
      tickLabelled: new Uint8Array(32),
      textCache: new Array(SPECIES_MAX).fill(''),
      classCache: new Array(SPECIES_MAX).fill('t-label'),
      leader: -1,
    };
  }

  /** y position of value v in a row (log for aggregation, linear for speed). */
  function yOf(row, v) {
    const h = row.plotBot - row.plotTop;
    if (row.kind === AGG) {
      const lv = Math.log(Math.max(v, AGG_MIN));
      return row.plotBot - ((lv - Math.log(AGG_MIN)) / (Math.log(row.top) - Math.log(AGG_MIN))) * h;
    }
    return row.plotBot - (Math.max(0, v) / row.top) * h;
  }

  const xOfAge = (age) => x1 - (age / seconds) * (x1 - x0);

  function layout() {
    x0 = snapHalf(TR_MARGIN.left);
    x1 = snapHalf(W - TR_MARGIN.right);
    const h = Math.floor((H - 2 * TR_MARGIN.titleH - TR_MARGIN.gap - TR_MARGIN.bottom) / 2);
    laidOut = x1 - x0 >= 60 && h >= 36;
    setVisible(svg, laidOut);
    if (!laidOut) return;
    const top0 = snapHalf(TR_MARGIN.titleH);
    rows[0].plotTop = top0;
    rows[0].plotBot = top0 + h;
    rows[1].plotTop = rows[0].plotBot + TR_MARGIN.gap + TR_MARGIN.titleH;
    rows[1].plotBot = rows[1].plotTop + h;
    for (const row of rows) {
      row.title.setAttribute('x', '0');
      // Baseline high enough that descenders clear the top tick label.
      row.title.setAttribute('y', String(row.plotTop - 10));
      row.clipRect.setAttribute('x', String(x0));
      row.clipRect.setAttribute('y', String(row.plotTop - 2));
      row.clipRect.setAttribute('width', String(x1 - x0 + 1));
      row.clipRect.setAttribute('height', String(row.plotBot - row.plotTop + 3));
      row.drawnTop = NaN; // force the y axis to redraw at the new size
      row.labelPlaced.fill(0);
    }
    drawTimeLabels();
  }

  function drawTimeLabels() {
    const y = String(rows[1].plotBot + 0.5 + TICK + TICK_GAP);
    let k = 0;
    for (let age = 0; age <= seconds + 1e-9; age += tStep, k++) {
      let label = timeLabels[k];
      if (!label) {
        label = textEl(svg, 't-tick', 'middle', '0.71em');
        timeLabels.push(label);
      }
      label.textContent = age === 0 ? 'now' : `${formatNumber(-age, decimalsFor(tStep))} s`;
      label.setAttribute('x', String(snapHalf(xOfAge(age))));
      label.setAttribute('y', y);
    }
  }

  /** Axis lines, time ticks and y ticks of one row, for its current top. */
  function drawRowAxis(row) {
    const yT = row.plotTop;
    const yB = row.plotBot;
    const h = yB - yT;
    let d = `M${x0} ${yT}V${yB + 0.5}M${x0 - 0.5} ${yB}H${x1}`;
    // A hairline at "now", shared by both rows, where the endpoint markers sit.
    const nowLine = `M${x1} ${yT}V${yB}`;
    const ratio = Math.round(tStep / tMinor);
    for (let k = 0; k * tMinor <= seconds + 1e-9; k++) {
      const px = snapHalf(xOfAge(k * tMinor));
      d += `M${px} ${yB}V${yB + 0.5 + (k % ratio === 0 ? TICK : MINOR_TICK)}`;
    }

    let used = 0;
    const label = (py, text) => {
      let t = row.yLabels[used];
      if (!t) {
        t = textEl(svg, 't-tick', 'end', '0.35em');
        row.yLabels.push(t);
      }
      setVisible(t, true);
      if (t.textContent !== text) t.textContent = text;
      t.setAttribute('x', String(x0 - 0.5 - TICK - TICK_GAP));
      t.setAttribute('y', String(py));
      used++;
    };

    if (row.kind === AGG) {
      const decades = Math.log10(row.top / AGG_MIN);
      const values = row.tickValues;
      const labelled = row.tickLabelled;
      const n = logTicks(AGG_MIN, row.top, h / decades, 18, values, labelled);
      for (let k = 0; k < n; k++) {
        const v = values[k];
        const py = snapHalf(yOf(row, v));
        d += `M${x0} ${py}H${x0 - 0.5 - (labelled[k] ? TICK : MINOR_TICK)}`;
        if (labelled[k]) label(py, formatNumber(v, v < 1 ? 1 : 0));
      }
      const yRef = snapHalf(yOf(row, 1));
      row.ref.setAttribute('d', `M${x0 + 0.5} ${yRef}H${x1}${nowLine}`);
    } else {
      const step = linearTickStep(row.top, h, 26);
      const dec = decimalsFor(step);
      for (let k = 0; k * step <= row.top * (1 + 1e-9); k++) {
        const v = cleanFloat(k * step);
        const py = snapHalf(yOf(row, v));
        d += `M${x0} ${py}H${x0 - 0.5 - TICK}`;
        label(py, formatNumber(v, dec));
      }
      row.ref.setAttribute('d', nowLine);
    }
    for (let k = used; k < row.yLabels.length; k++) setVisible(row.yLabels[k], false);
    row.axis.setAttribute('d', d);
    row.drawnTop = row.top;
  }

  function speciesCount() {
    if (displayS > 0) return displayS;
    return buffer.length ? buffer.species[buffer.slot(buffer.length - 1)] : 0;
  }

  /** Rebuild ranges, axes and lines from the ring buffer (at most once per frame). */
  function drawData() {
    if (!laidOut) return;
    const n = buffer.length;
    const S = speciesCount();
    const ch = buffer.channels;
    const tNow = n ? buffer.lastTime() : 0;
    const tMin = tNow - seconds;

    // First sample inside the window, then one before it so lines enter from the left edge.
    let kStart = 0;
    while (kStart < n && buffer.time[buffer.slot(kStart)] < tMin) kStart++;
    const kFirstVisible = kStart;
    if (kStart > 0) kStart--;

    let aggMax = 0;
    let speedMax = 0;
    for (let k = kFirstVisible; k < n; k++) {
      const slot = buffer.slot(k);
      const live = Math.min(S, buffer.species[slot]);
      const o = slot * ch;
      for (let s = 0; s < live; s++) {
        const a = buffer.aggregation[o + s];
        const v = buffer.speed[o + s];
        if (a > aggMax) aggMax = a;
        if (v > speedMax) speedMax = v;
      }
    }
    rows[AGG].top = hysteresisTop(rows[AGG].top, aggMax, aggCeil);
    rows[SPEED].top = hysteresisTop(rows[SPEED].top, speedMax, speedCeil);

    const lastSlot = n ? buffer.slot(n - 1) : 0;
    for (const row of rows) {
      if (row.top !== row.drawnTop) drawRowAxis(row);
      const series = row.kind === AGG ? buffer.aggregation : buffer.speed;
      for (let s = 0; s < SPECIES_MAX; s++) {
        const path = row.paths[s];
        const end = row.ends[s];
        if (s >= S || n === 0) {
          setVisible(path, false);
          setVisible(end, false);
          row.has[s] = 0;
          continue;
        }
        let d = '';
        let pen = false;
        let prevT = 0;
        for (let k = kStart; k < n; k++) {
          const slot = buffer.slot(k);
          const t = buffer.time[slot];
          const v = series[slot * ch + s];
          const valid = buffer.species[slot] > s && Number.isFinite(v);
          if (!valid) {
            pen = false;
            continue;
          }
          if (pen && t - prevT > GAP_SECONDS) pen = false;
          d += (pen ? 'L' : 'M') + xOfAge(tNow - t).toFixed(1) + ' ' + yOf(row, v).toFixed(1);
          pen = true;
          prevT = t;
        }
        path.setAttribute('d', d);
        setVisible(path, d.length > 0);

        const latest = series[lastSlot * ch + s];
        const live = buffer.species[lastSlot] > s && Number.isFinite(latest);
        setVisible(end, live);
        if (live) {
          end.setAttribute('transform', `translate(${x1} ${yOf(row, latest).toFixed(1)})`);
          if (!row.has[s]) row.shown[s] = latest; // a new readout starts where it is
          row.target[s] = latest;
        }
        row.has[s] = live ? 1 : 0;
      }
    }
  }

  /** Ease readout values and positions; returns true while anything is still moving. */
  function animateReadouts(dt) {
    if (!laidOut) return false;
    const S = speciesCount();
    const snap = reduce.matches;
    let moving = false;
    for (const row of rows) {
      // One precision per column, chosen from the values themselves so the
      // digits line up: aggregation 1.2 / 14, speed 0.85 / 12.4.
      let maxTarget = 0;
      for (let s = 0; s < Math.min(S, SPECIES_MAX); s++) {
        if (row.has[s] && row.target[s] > maxTarget) maxTarget = row.target[s];
      }
      row.decimals = row.kind === AGG ? (maxTarget < 9.95 ? 1 : 0) : (maxTarget < 9.995 ? 2 : maxTarget < 99.95 ? 1 : 0);
      const eps = 0.5 * 10 ** -(row.decimals + 1);
      let count = 0;
      let leader = -1;
      for (let s = 0; s < Math.min(S, SPECIES_MAX); s++) {
        if (!row.has[s]) continue;
        const next = snap ? row.target[s] : smoothToward(row.shown[s], row.target[s], dt, VALUE_TAU);
        row.shown[s] = Math.abs(next - row.target[s]) < eps ? row.target[s] : next;
        if (row.shown[s] !== row.target[s]) moving = true;
        if (leader < 0 || row.target[s] > row.target[leader]) leader = s;
        row.members[count++] = s;
      }
      // The strongest species keeps the lead until another beats it by 2%.
      if (row.leader >= 0 && row.leader < S && row.has[row.leader] && leader >= 0 &&
          row.target[leader] <= row.target[row.leader] * 1.02) {
        leader = row.leader;
      }
      row.leader = leader;

      const lo = row.plotTop + 4;
      const hi = row.plotBot;
      const fitsAll = count > 0 && (count - 1) * LABEL_GAP <= hi - lo;
      const shownCount = fitsAll ? count : leader >= 0 ? 1 : 0;
      if (!fitsAll && leader >= 0) row.members[0] = leader;
      for (let k = 0; k < shownCount; k++) {
        row.desired[k] = clamp(yOf(row, row.shown[row.members[k]]), lo, hi);
      }
      spreadLabels(row.desired, shownCount, LABEL_GAP, lo, hi, row.spread);

      const markX = x1 + 14;
      const textX = W - 1;
      const visible = row.visible;
      visible.fill(0);
      // Labels sit exactly at their solved slots. The values they follow are already damped,
      // so slots move smoothly; easing positions on top of that let labels lag out of value
      // order, and re-spreading eased positions could lock two labels in the wrong order.
      for (let k = 0; k < shownCount; k++) {
        const s = row.members[k];
        visible[s] = 1;
        const y = row.spread[k];
        row.labelY[s] = y;
        row.labelPlaced[s] = 1;
        const mark = row.colMarks[s];
        const text = row.colTexts[s];
        setVisible(mark, true);
        setVisible(text, true);
        mark.setAttribute('transform', `translate(${markX} ${y.toFixed(1)})`);
        text.setAttribute('x', String(textX));
        text.setAttribute('y', y.toFixed(1));
        const str = formatNumber(row.shown[s], row.decimals);
        if (row.textCache[s] !== str) {
          text.textContent = str;
          row.textCache[s] = str;
        }
        const cls = s === leader ? 't-value' : 't-label';
        if (row.classCache[s] !== cls) {
          text.setAttribute('class', cls);
          row.classCache[s] = cls;
        }
      }
      for (let s = 0; s < SPECIES_MAX; s++) {
        if (visible[s]) continue;
        setVisible(row.colMarks[s], false);
        setVisible(row.colTexts[s], false);
        row.labelPlaced[s] = 0;
      }
    }
    return moving;
  }

  function onFrame(now) {
    raf = 0;
    const dt = lastFrame ? clamp((now - lastFrame) / 1000, 0, 0.1) : 1 / 60;
    lastFrame = now;
    if (dirty) {
      dirty = false;
      drawData();
    }
    if (animateReadouts(dt)) schedule();
    else lastFrame = 0;
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(onFrame);
  }

  function paint() {
    const theme = currentTheme();
    for (const row of rows) {
      for (let s = 0; s < SPECIES_MAX; s++) {
        const c = speciesColor(s, theme);
        row.paths[s].setAttribute('stroke', c);
        row.ends[s].setAttribute('fill', c);
        row.colMarks[s].setAttribute('fill', c);
      }
    }
  }

  function resetData() {
    buffer.clear();
    for (const row of rows) {
      row.top = row.kind === AGG ? 2 : 0.5;
      row.has.fill(0);
      row.labelPlaced.fill(0);
      row.leader = -1;
    }
  }

  paint();
  const ro = observe((w, h) => {
    W = w;
    H = h;
    layout();
    dirty = true;
    schedule();
  });

  return {
    setSpecies(S) {
      const next = clamp(Math.round(Number(S)) || 0, 0, SPECIES_MAX);
      if (next === displayS) return;
      displayS = next;
      dirty = true;
      schedule();
    },

    push(stats, timeSeconds) {
      if (!stats) return;
      const t = Number(timeSeconds);
      if (!Number.isFinite(t)) return;
      if (buffer.length) {
        const last = buffer.lastTime();
        if (t < last) resetData();      // time ran backwards: a new run
        else if (t === last) return;    // duplicate sample
      }
      buffer.push(t, stats.S, stats.aggregation, stats.meanSpeed);
      dirty = true;
      schedule();
    },

    clear() {
      resetData();
      dirty = true;
      schedule();
    },

    refreshTheme() {
      paint();
    },

    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      frame.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Axes around panel a's dish
// ---------------------------------------------------------------------------

/**
 * Space, in CSS px, the axes need around the dish square. The dish occupies
 * [left, left + sizePx] x [top, top + sizePx] inside the axes SVG, whose
 * size is (left + sizePx + right) x (top + sizePx + bottom).
 */
export const AXES_MARGIN = Object.freeze({ left: 54, bottom: 38, top: 8, right: 8 });

const AX_LABEL_MIN_PX = 56;
const AX_CAP = 512;
const SCALE_INSET = 12;

/**
 * createAxes(svgOrContainer) -> { update({ view: { cx, cy, zoom }, rMax, sizePx }), refreshTheme(), destroy() }
 * Pass an <svg> to draw into it, or a positioned container to get one placed at its top-left.
 */
export function createAxes(svgOrContainer) {
  ensureStyles();
  const given = svgOrContainer && svgOrContainer.namespaceURI === SVG_NS &&
    String(svgOrContainer.tagName).toLowerCase() === 'svg';
  const svg = given ? svgOrContainer : svgEl('svg', null, svgOrContainer);
  svg.classList.add('plots-svg', 'plots-axes');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const root = svgEl('g', null, svg);
  const frameLines = svgEl('path', { class: 'pl-ink' }, root);
  const majors = svgEl('path', { class: 'pl-ink' }, root);
  const minors = svgEl('path', { class: 'pl-ink' }, root);
  const xTitle = textEl(root, 't-axis', 'middle', null);
  setRuns(xTitle, [{ m: 'x' }, ' / ', { m: 'r' }, { sub: 'max' }]);
  const yTitle = textEl(root, 't-axis', 'middle', null);
  yTitle.setAttribute('transform', 'rotate(-90)');
  setRuns(yTitle, [{ m: 'y' }, ' / ', { m: 'r' }, { sub: 'max' }]);
  const bar = svgEl('rect', { class: 'pl-bar', height: 2 }, root);
  const barLabel = textEl(root, 't-label pl-ink-text pl-halo', 'middle', null);
  const barSpans = setRuns(barLabel, ['5', ' ', { m: 'r' }, { sub: 'max' }]);

  const xPool = [];
  const yPool = [];
  const frac = new Float64Array(AX_CAP);
  const vals = new Float64Array(AX_CAP);
  const centers = new Float64Array(AX_CAP);
  const halves = new Float64Array(AX_CAP);
  const prio = new Uint8Array(AX_CAP);
  const keep = new Uint8Array(AX_CAP);
  const stack = new Int32Array(AX_CAP);
  const paths = { major: '', minor: '' };
  const last = { cx: NaN, cy: NaN, zoom: NaN, rMax: NaN, size: NaN };

  // In container mode, the container's own size is the fallback when sizePx is omitted.
  let measured = 0;
  const ro = given ? { disconnect() {} } : observeSize(svgOrContainer, (w, h) => {
    measured = Math.max(0, Math.min(w - AXES_MARGIN.left - AXES_MARGIN.right, h - AXES_MARGIN.top - AXES_MARGIN.bottom));
  });

  /** Tick label k of a pool, created on first use; `text` caches its content. */
  function poolLabel(pool, k, anchor, dy) {
    let label = pool[k];
    if (!label) {
      label = { node: textEl(root, 't-tick', anchor, dy), text: '' };
      pool.push(label);
    }
    return label;
  }

  /**
   * Ticks and labels of one axis. `horizontal` is the bottom axis. Appends
   * the major and minor tick path data to `paths`.
   */
  function axisTicks(horizontal, startU, spanU, period, step, minor, size, pool) {
    const L = AXES_MARGIN.left;
    const T = AXES_MARGIN.top;
    const edge = Math.round(size);
    let dMajor = '';
    let dMinor = '';

    if (minor > 0) {
      const n = torusTicks(startU, spanU, period, minor, frac, vals);
      for (let k = 0; k < n; k++) {
        const q = vals[k] / step;
        if (Math.abs(q - Math.round(q)) < 1e-6) continue; // a major sits here
        if (horizontal) {
          const px = Math.floor(L + frac[k] * size) + 0.5;
          dMinor += `M${px} ${T + edge}V${T + edge + 1 + MINOR_TICK}`;
        } else {
          const py = Math.floor(T + frac[k] * size) + 0.5;
          dMinor += `M${L} ${py}H${L - 1 - MINOR_TICK}`;
        }
      }
    }

    const n = torusTicks(startU, spanU, period, step, frac, vals);
    const decimals = decimalsFor(step);
    for (let k = 0; k < n; k++) {
      const pos = horizontal ? Math.floor(L + frac[k] * size) + 0.5 : Math.floor(T + frac[k] * size) + 0.5;
      if (horizontal) dMajor += `M${pos} ${T + edge}V${T + edge + 1 + TICK}`;
      else dMajor += `M${L} ${pos}H${L - 1 - TICK}`;
      const text = formatNumber(vals[k], decimals);
      centers[k] = pos;
      halves[k] = horizontal ? estimateTextWidth(text, TICK_FONT) / 2 : TICK_FONT / 2;
      prio[k] = vals[k] === 0 ? 1 : 0; // across the seam, "0" wins
      const label = poolLabel(pool, k, horizontal ? 'middle' : 'end', horizontal ? '0.71em' : '0.35em');
      if (label.text !== text) {
        label.node.textContent = text;
        label.text = text;
      }
      if (horizontal) {
        label.node.setAttribute('x', String(pos));
        label.node.setAttribute('y', String(T + edge + 1 + TICK + TICK_GAP));
      } else {
        label.node.setAttribute('x', String(L - 1 - TICK - TICK_GAP));
        label.node.setAttribute('y', String(pos));
      }
    }
    cullLabels(centers, halves, prio, n, horizontal ? 9 : 3, keep, stack);
    for (let k = 0; k < n; k++) {
      let show = keep[k] === 1;
      // Labels must not run past the right margin.
      if (show && horizontal && centers[k] + halves[k] > L + size + AXES_MARGIN.right) show = false;
      setVisible(pool[k].node, show);
    }
    for (let k = n; k < pool.length; k++) setVisible(pool[k].node, false);
    paths.major += dMajor;
    paths.minor += dMinor;
  }

  function draw(view, rMax, size) {
    const L = AXES_MARGIN.left;
    const T = AXES_MARGIN.top;
    const W = L + size + AXES_MARGIN.right;
    const H = T + size + AXES_MARGIN.bottom;
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    setVisible(root, true);

    // Frame: one pixel outside the dish on every side, corners closed.
    const edge = Math.round(size);
    const xl = L - 0.5;
    const xr = L + edge + 0.5;
    const yt = T - 0.5;
    const yb = T + edge + 0.5;
    frameLines.setAttribute('d',
      `M${xl} ${yt - 0.5}V${yb + 0.5}M${xl - 0.5} ${yb}H${xr + 0.5}M${xr} ${yb + 0.5}V${yt - 0.5}M${xr + 0.5} ${yt}H${xl - 0.5}`);

    const zoom = Math.max(1, view.zoom);
    const w = 1 / zoom;                   // visible world width
    const period = 1 / rMax;              // torus side in r_max units
    const spanU = w / rMax;
    const ppu = size / spanU;             // px per r_max
    const step = tickStepFor(ppu, AX_LABEL_MIN_PX);
    const minor = minorStepFor(step, ppu, 7);
    const startX = (view.cx - w / 2) / rMax;
    const startY = (view.cy - w / 2) / rMax;

    paths.major = '';
    paths.minor = '';
    axisTicks(true, startX, spanU, period, step, minor, size, xPool);
    axisTicks(false, startY, spanU, period, step, minor, size, yPool);
    majors.setAttribute('d', paths.major);
    minors.setAttribute('d', paths.minor);

    xTitle.setAttribute('x', String(L + size / 2));
    xTitle.setAttribute('y', String(T + edge + 31));
    yTitle.setAttribute('x', String(-(T + size / 2)));
    yTitle.setAttribute('y', '12');

    // Scale bar, inside the dish at bottom right, with a paper halo over the particles.
    const units = scaleBarUnits(spanU);
    const len = Math.round(units * ppu);
    const showBar = size >= 120 && len >= 8;
    setVisible(bar, showBar);
    setVisible(barLabel, showBar);
    if (showBar) {
      const right = L + edge - SCALE_INSET;
      const yBar = T + edge - SCALE_INSET - 2;
      bar.setAttribute('x', String(right - len));
      bar.setAttribute('y', String(yBar));
      bar.setAttribute('width', String(len));
      barSpans[0].textContent = formatNumber(units, decimalsFor(units));
      barLabel.setAttribute('x', String(right - len / 2));
      barLabel.setAttribute('y', String(yBar - 5));
    }
  }

  return {
    update({ view, rMax, sizePx } = {}) {
      const size = Number.isFinite(sizePx) && sizePx > 0 ? sizePx : measured;
      const v = view || {};
      const cx = Number.isFinite(v.cx) ? v.cx : 0.5;
      const cy = Number.isFinite(v.cy) ? v.cy : 0.5;
      const zoom = Number.isFinite(v.zoom) ? v.zoom : 1;
      if (!(size > 0) || !(rMax > 0) || !Number.isFinite(rMax)) {
        setVisible(root, false);
        // Forget what was drawn, so the next valid update redraws (and shows
        // the axes again) even when its view equals the one before the hide.
        last.size = NaN;
        return;
      }
      if (cx === last.cx && cy === last.cy && zoom === last.zoom && rMax === last.rMax && size === last.size) return;
      last.cx = cx;
      last.cy = cy;
      last.zoom = zoom;
      last.rMax = rMax;
      last.size = size;
      draw({ cx, cy, zoom }, rMax, size);
    },

    refreshTheme() {
      // Every stroke and fill here is an ink custom property; nothing to re-read.
    },

    destroy() {
      ro.disconnect();
      root.remove();
      if (given) svg.classList.remove('plots-svg', 'plots-axes');
      else svg.remove();
    },
  };
}
