// Tropism — application wiring.
// Owns the frame loop, the current world (genome), the revision history of the
// law, the view, the dish tools, the caption controls, and the Extended Data
// gallery. Components are created here and talk to each other only through
// this module.

import { DT } from './sim.js';
import { createSimHost } from './sim-host.js';
import {
  randomGenome, mutateGenome, withSpecies, encodeGenome, decodeGenome,
  cloneGenome, genomesEqual, defaultParams, quantizeAffinity, PARAM_LIMITS, mulberry32,
} from './genome.js';
import { createRenderer } from './render.js';
import { createMatrix } from './matrix.js';
import { createForceCurve, createTraces, createAxes, AXES_MARGIN } from './plots.js';
import { createScrub } from './scrub.js';
import { createSonifier } from './audio.js';
import { PRESETS, decodeThumb } from './presets.js';
import { SPECIES, SPECIES_MIN, SPECIES_MAX, paletteCSS, markerSVG, currentTheme } from './markers.js';

const CAPACITY = 12000;
const TRACK_POINTS = 600;              // 12 s of path at 50 steps/s
const STATS_INTERVAL = 100;            // ms between statistics samples
// Speed is a multiple of real time, so it is the same on a 60 Hz and a 144 Hz display:
// at 1x, one second of simulated time passes per second of wall-clock time (1 / DT steps).
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const REAL_TIME_STEPS = 1 / DT;
// A fresh world starts as a uniform gas; its first WARM_STEPS run fast-forwarded (up to
// WARM_BOOST times the chosen speed, easing out) so bodies condense within a few seconds.
const WARM_STEPS = 250;
const WARM_BOOST = 4;
// The dish is trimmed only when the device cannot keep the chosen speed: the steps it can
// afford per second (the worker can spend its whole thread, the main thread about 60% of a
// frame budget) fall below the requested rate for SLOW_SAMPLES samples (about 2 s).
const STEP_BUDGET_MS = { main: 600, worker: 950 };
const SLOW_SAMPLES = 20;
const MINUS = '−';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- formatting

const fmtInt = (v) => Math.round(v).toLocaleString('en-US');
const fmtFixed = (d) => (v) => (v < 0 ? MINUS : '') + Math.abs(v).toFixed(d);
const fmtSigned = (v) => (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(v).toFixed(2);
const letter = (s) => SPECIES[s].letter;

function randomSeed() {
  if (window.crypto && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return (Math.random() * 0x100000000) >>> 0;
}

// ---------------------------------------------------------------- state

const state = {
  genome: null,
  history: [],            // [{ genome, label }] revisions that can be undone
  future: [],             // redo stack
  revision: 0,
  revisionNote: 'as generated',
  running: true,
  speedIndex: reducedMotion.matches ? 0 : 1,   // half real time; a quarter under reduced motion
  trails: false,
  tool: 'stir',
  seedSpecies: 0,
  view: { cx: 0.5, cy: 0.5, zoom: 1 },
  highlight: -1,
  hover: { i: -1, j: -1 },
  visible: true,          // is the dish on screen
  presetId: null,
};

// The simulation runs in a worker (src/sim-host.js); `sim.view` is the latest frame it sent,
// and every edit below is a message to it. Without Worker support it runs on this thread.
const sim = createSimHost(CAPACITY, {
  onTrack: appendTrack,
  onTrackLost: clearTracking,
  onCountEdited: syncCountDisplay,
  onSamples(samples) {
    for (const s of samples) pushTraces(s, s.steps * DT);
  },
  onRestart() {
    if (state.genome) applyGenome(state.genome, { reset: true });
    sim.setRunning(state.running);
  },
});
// Panel d plots a damped copy of the statistics (time constant SMOOTH_TAU of simulated time), so
// the traces show trends rather than step-to-step jitter and the readouts sort by settled values.
const SMOOTH_TAU = 0.6;
const smoothed = {
  steps: 0, n: 0, S: 0, aggregationAll: 1, meanSpeedAll: 0,
  count: new Float32Array(8), meanSpeed: new Float32Array(8), aggregation: new Float32Array(8),
};
let smoothedAt = -1;
let traceSteps = -1;         // step count of the last sample pushed to panel d

function pushTraces(stats, t) {
  if (!traces || !stats) return;
  traceSteps = stats.steps;
  const fresh = smoothedAt < 0 || t <= smoothedAt || smoothed.S !== stats.S;
  const k = fresh ? 1 : 1 - Math.exp(-(t - smoothedAt) / SMOOTH_TAU);
  smoothedAt = t;
  smoothed.steps = stats.steps;
  smoothed.n = stats.n;
  smoothed.S = stats.S;
  smoothed.aggregationAll += (stats.aggregationAll - smoothed.aggregationAll) * k;
  smoothed.meanSpeedAll += (stats.meanSpeedAll - smoothed.meanSpeedAll) * k;
  for (let s = 0; s < 8; s++) {
    smoothed.count[s] = stats.count[s];
    smoothed.meanSpeed[s] += (stats.meanSpeed[s] - smoothed.meanSpeed[s]) * k;
    smoothed.aggregation[s] += (stats.aggregation[s] - smoothed.aggregation[s]) * k;
  }
  traces.push(smoothed, t);
}
const track = { path: new Float32Array(TRACK_POINTS * 2), length: 0 };
let renderer = null;
let matrix = null;
let forceCurve = null;
let traces = null;
let axes = null;
let sonifier = null;
const scrubs = {};

// ---------------------------------------------------------------- genome application

/** Apply a genome to the running world. A new seed means a new experiment (reset). */
function applyGenome(next, { reset = false } = {}) {
  const prev = state.genome;
  state.genome = cloneGenome(next);
  const g = state.genome;
  const needsReset = reset || !prev || prev.seed !== g.seed;

  if (needsReset) {
    sim.reset(g);
    clearTracking();
    traces && traces.clear();
    smoothedAt = -1;
    traceSteps = -1;
  } else {
    if (prev.species !== g.species) sim.setSpecies(g.species, g.matrix, g.seed);
    else sim.setMatrix(g.matrix);
    sim.setParams({
      rMax: g.params.rMax, halfLife: g.params.halfLife, force: g.params.force, beta: g.params.beta,
    });
    // A no-op when the dish already holds this many (the engine checks against its own n).
    sim.setCount(liveCount(g), g.seed);
  }

  if (!prev || prev.species !== g.species) {
    traces && traces.setSpecies(g.species);
    buildSeedSpecies();
    if (state.seedSpecies >= g.species) state.seedSpecies = 0;
    if (state.highlight >= g.species) setHighlight(-1);
  }
  matrix && matrix.set(g.species, g.matrix);
  syncHover();
  syncCaption();
  syncWorldCode();
  syncAxes();
}

/** Record the current genome as an undoable revision, then apply `next`. */
function commit(next, label, opts) {
  if (state.genome && genomesEqual(state.genome, next) && !(opts && opts.reset)) return;
  state.history.push({ genome: cloneGenome(state.genome), label, revision: state.revision, note: state.revisionNote });
  if (state.history.length > 200) state.history.shift();
  state.future.length = 0;
  state.revision += 1;
  state.revisionNote = label;
  applyGenome(next, opts);
  syncHistory();
}

/**
 * Some controls change the world live while dragging (onInput) and only record the
 * revision at the end (onCommit). `before` is the genome as it was when the gesture began.
 */
function commitFrom(before, label) {
  if (genomesEqual(before, state.genome)) return;
  state.history.push({ genome: cloneGenome(before), label, revision: state.revision, note: state.revisionNote });
  if (state.history.length > 200) state.history.shift();
  state.future.length = 0;
  state.revision += 1;
  state.revisionNote = label;
  syncHistory();
}

function undo() {
  const entry = state.history.pop();
  if (!entry) return;
  state.future.push({ genome: cloneGenome(state.genome), label: state.revisionNote, revision: state.revision, note: state.revisionNote });
  const undone = state.revisionNote;
  state.revision = entry.revision;
  state.revisionNote = entry.note;
  applyGenome(entry.genome);
  syncHistory();
  announce(`Undid ${undone}.`);
}

function redo() {
  const entry = state.future.pop();
  if (!entry) return;
  state.history.push({ genome: cloneGenome(state.genome), label: entry.label, revision: state.revision, note: state.revisionNote });
  state.revision = entry.revision;
  state.revisionNote = entry.note;
  applyGenome(entry.genome);
  syncHistory();
  announce(`Redid ${entry.label}.`);
}

// ---------------------------------------------------------------- world actions

function newWorld() {
  const g = state.genome;
  const next = randomGenome(randomSeed(), { species: g.species, params: { ...g.params } });
  state.presetId = null;
  commit(next, 'new world', { reset: true });
  syncPresetCurrent();
  announce(`New world with ${g.species} species.`);
}

function mutate() {
  const before = state.genome;
  const next = mutateGenome(before, randomSeed());
  const changed = [];
  for (let k = 0; k < next.matrix.length; k++) {
    if (next.matrix[k] !== before.matrix[k]) {
      const i = Math.floor(k / next.species), j = k % next.species;
      changed.push(`a${letter(i)}${letter(j)}`);
    }
  }
  const label = changed.length ? `mutation of ${changed.join(', ')}` : 'mutation';
  commit(next, label);
  announce(`Mutated ${changed.join(', ') || 'the table'}.`);
}

function loadPreset(preset) {
  const g = decodeGenome(preset.code);
  if (!g) return;
  state.presetId = preset.id;
  commit(g, preset.name, { reset: true });
  syncPresetCurrent();
  resetView();
  announce(`Loaded ${preset.name}.`);
}

// ---------------------------------------------------------------- caption sync

/** The particle count a genome puts in the dish (what applyGenome leaves the world holding). */
const liveCount = (g) => Math.min(g.params.n, CAPACITY);

function syncCaption() {
  const g = state.genome;
  scrubs.n && scrubs.n.set(liveCount(g));
  scrubs.S && scrubs.S.set(g.species);
  scrubs.side && scrubs.side.set(sideOf(g.params.rMax));
  scrubs.beta && scrubs.beta.set(g.params.beta);
  scrubs.half && scrubs.half.set(Math.round(g.params.halfLife * 1000));
  scrubs.k && scrubs.k.set(g.params.force);
}

const sideOf = (rMax) => Math.round((1 / rMax) * 10) / 10;

let codeTimer = 0;
function syncWorldCode() {
  clearTimeout(codeTimer);
  codeTimer = setTimeout(() => {
    const code = encodeGenome(state.genome);
    $('world-code').textContent = code;
    if (window.top === window) {
      try { history.replaceState(null, '', '#' + code); } catch { /* sandboxed */ }
    }
  }, 120);
}

function syncHistory() {
  const undoBtn = $('act-undo');
  const redoBtn = $('act-redo');
  undoBtn.disabled = state.history.length === 0;
  redoBtn.disabled = state.future.length === 0;
  undoBtn.title = state.history.length ? `Undo ${state.revisionNote}` : 'Nothing to undo';
  redoBtn.title = state.future.length ? `Redo ${state.future[state.future.length - 1].label}` : 'Nothing to redo';
  const rev = $('revision');
  rev.textContent = '';
  rev.append(`Revision ${state.revision}, `);
  rev.append(...formatRevisionNote(state.revisionNote));
  rev.append('.');
}

/** Turn "aBD" style tokens in a revision note into proper math. */
function formatRevisionNote(note) {
  const out = [];
  const re = /a([A-H])([A-H])/g;
  let last = 0;
  let m;
  while ((m = re.exec(note))) {
    if (m.index > last) out.push(note.slice(last, m.index));
    const i = document.createElement('i');
    i.textContent = 'a';
    const sub = document.createElement('sub');
    sub.textContent = m[1] + m[2];
    out.push(i, sub);
    last = re.lastIndex;
  }
  if (last < note.length) out.push(note.slice(last));
  return out;
}

let announceTimer = 0;
function announce(text) {
  const el = $('status');
  el.textContent = text;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

// ---------------------------------------------------------------- panels

function syncHover() {
  if (!forceCurve) return;
  const g = state.genome;
  let { i, j } = state.hover;
  if (!(i >= 0 && j >= 0 && i < g.species && j < g.species)) {
    // At rest, show the most lopsided pair: where i's pull toward j differs most from
    // j's toward i. Those pairs make the chasers, so panel c is never a flat line.
    [i, j] = restingPair(g);
  }
  forceCurve.update({ i, j, a: g.matrix[i * g.species + j], beta: g.params.beta });
}

function restingPair(g) {
  const S = g.species;
  const m = g.matrix;
  let best = [0, 1];
  let score = -1;
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < S; j++) {
      if (i === j) continue;
      const a = m[i * S + j];
      const sc = Math.abs(a - m[j * S + i]) * 2 + Math.abs(a);
      if (sc > score) {
        score = sc;
        best = [i, j];
      }
    }
  }
  return best;
}

function syncAxes() {
  if (!axes) return;
  const plate = $('dish-plate');
  axes.update({ view: state.view, rMax: state.genome.params.rMax, sizePx: plate.clientWidth });
}

function buildSeedSpecies() {
  const host = $('seed-species');
  host.textContent = '';
  const S = state.genome.species;
  const theme = currentTheme();
  for (let s = 0; s < S; s++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg__opt';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(s === state.seedSpecies));
    b.tabIndex = s === state.seedSpecies ? 0 : -1;
    b.setAttribute('aria-label', `Species ${letter(s)}`);
    b.dataset.species = String(s);
    b.append(markerSVG(s, 12, theme), letter(s));
    host.append(b);
  }
}

function setSeedSpecies(s) {
  state.seedSpecies = s;
  for (const b of $('seed-species').querySelectorAll('[data-species]')) {
    const on = Number(b.dataset.species) === s;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function setTool(tool) {
  state.tool = tool;
  for (const b of document.querySelectorAll('#tool-group [data-tool]')) {
    const on = b.dataset.tool === tool;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('dish-plate').dataset.tool = tool;
  $('seed-species').hidden = tool !== 'seed';
  updateBrush();
}

// ---------------------------------------------------------------- run controls

function setRunning(on) {
  state.running = on;
  sim.setRunning(on);
  const b = $('act-pause');
  b.textContent = on ? 'Pause' : 'Resume';
  b.setAttribute('aria-pressed', String(!on));
  $('dish-paused').hidden = on;
}

function setHighlight(s) {
  state.highlight = s;
  matrix && matrix.setHighlight && matrix.setHighlight(s);
}

function setTrails(on) {
  state.trails = on;
  $('act-trails').setAttribute('aria-pressed', String(on));
}

function resetView() {
  state.view.cx = 0.5;
  state.view.cy = 0.5;
  state.view.zoom = 1;
  onViewChanged();
}

function onViewChanged() {
  renderer && renderer.setView(state.view);
  $('act-view').disabled = state.view.zoom === 1 && state.view.cx === 0.5 && state.view.cy === 0.5;
  syncAxes();
}

// ---------------------------------------------------------------- tracking

function clearTracking() {
  sim.track(-1);
  track.length = 0;
  $('dish-track').hidden = true;
}

/** Append the tracked particle's positions after each step since the last frame (x, y interleaved). */
function appendTrack(points, count) {
  const p = track.path;
  for (let k = 0; k < count; k++) {
    if (track.length === TRACK_POINTS) {
      p.copyWithin(0, 2);
      track.length -= 1;
    }
    p[track.length * 2] = points[k * 2];
    p[track.length * 2 + 1] = points[k * 2 + 1];
    track.length += 1;
  }
}

const trackLabel = { species: -1, speedNode: null, letterNode: null, markerHost: null, lastText: '' };

function buildTrackLabel() {
  const label = $('dish-track');
  label.textContent = '';
  trackLabel.markerHost = document.createElement('span');
  trackLabel.markerHost.className = 'dish__track-marker';
  trackLabel.letterNode = document.createTextNode('');
  trackLabel.speedNode = document.createTextNode('');
  const i = document.createElement('i');
  i.textContent = 'r';
  const sub = document.createElement('sub');
  sub.textContent = 'max';
  label.append(trackLabel.markerHost, trackLabel.letterNode, ' · ', trackLabel.speedNode, ' ', i, sub, '/s');
  trackLabel.species = -1;
}

function updateTrackLabel() {
  const label = $('dish-track');
  const idx = sim.trackedIndex();
  if (idx < 0 || !renderer) {
    label.hidden = true;
    return;
  }
  const v = sim.view;
  const pos = renderer.worldToScreen(v.x[idx], v.y[idx]);
  if (!pos) {
    label.hidden = true;
    return;
  }
  const s = v.species[idx];
  if (s !== trackLabel.species) {
    trackLabel.species = s;
    trackLabel.markerHost.textContent = '';
    trackLabel.markerHost.append(markerSVG(s, 11));
    trackLabel.letterNode.nodeValue = letter(s);
  }
  const speed = sim.trackedSpeed().toFixed(2);
  if (speed !== trackLabel.lastText) {
    trackLabel.lastText = speed;
    trackLabel.speedNode.nodeValue = speed;
  }
  label.hidden = false;
  label.style.transform = `translate(${Math.round(pos[0] + 12)}px, ${Math.round(pos[1] - 20)}px)`;
}

// ---------------------------------------------------------------- dish pointer interaction

const pointers = new Map();
let gesture = null;

function plateXY(e) {
  const r = $('dish-plate').getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function brushRadiusWorld() {
  const r = state.genome.params.rMax;
  return state.tool === 'erase' ? r * 1.1 : r * 0.7;
}

function updateBrush(px, py) {
  const brush = $('dish-brush');
  const on = (state.tool === 'seed' || state.tool === 'erase') && px !== undefined;
  brush.classList.toggle('is-on', on);
  if (!on || !renderer) return;
  const plate = $('dish-plate');
  const rPx = brushRadiusWorld() * state.view.zoom * plate.clientWidth;
  const c = brush.firstElementChild;
  c.setAttribute('cx', px);
  c.setAttribute('cy', py);
  c.setAttribute('r', Math.max(4, rPx));
}

function initDishPointer() {
  const plate = $('dish-plate');
  const rng = mulberry32(randomSeed());

  plate.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    try { plate.setPointerCapture(e.pointerId); } catch { /* pointer already gone; the gesture still ends on pointerup */ }
    const [px, py] = plateXY(e);
    pointers.set(e.pointerId, { px, py, x0: px, y0: py, t0: performance.now() });
    if (pointers.size === 2) {
      // Two fingers: pinch-zoom and pan, whatever the tool.
      const [a, b] = [...pointers.values()];
      gesture = {
        kind: 'pinch',
        dist: Math.hypot(a.px - b.px, a.py - b.py),
        zoom: state.view.zoom,
        mid: [(a.px + b.px) / 2, (a.py + b.py) / 2],
      };
      return;
    }
    gesture = { kind: state.tool, moved: false, lastT: performance.now() };
    plate.classList.add('is-dragging');
    if (state.tool === 'seed' || state.tool === 'erase') applyBrush(px, py, rng);
  });

  plate.addEventListener('pointermove', (e) => {
    const [px, py] = plateXY(e);
    updateBrush(px, py);
    const p = pointers.get(e.pointerId);
    if (!p || !gesture) return;
    const dxPx = px - p.px;
    const dyPx = py - p.py;
    p.px = px;
    p.py = py;
    if (Math.hypot(px - p.x0, py - p.y0) > 4) gesture.moved = true;

    if (gesture.kind === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.px - b.px, a.py - b.py);
      const mid = [(a.px + b.px) / 2, (a.py + b.py) / 2];
      const size = plate.clientWidth;
      const w = 1 / state.view.zoom;
      state.view.cx -= ((mid[0] - gesture.mid[0]) / size) * w;
      state.view.cy -= ((mid[1] - gesture.mid[1]) / size) * w;
      gesture.mid = mid;
      zoomAt(mid[0], mid[1], Math.max(1, Math.min(12, gesture.zoom * (dist / Math.max(1, gesture.dist)))));
      return;
    }

    const size = plate.clientWidth;
    const w = 1 / state.view.zoom;
    if (gesture.kind === 'pan') {
      state.view.cx = (((state.view.cx - (dxPx / size) * w) % 1) + 1) % 1;
      state.view.cy = (((state.view.cy - (dyPx / size) * w) % 1) + 1) % 1;
      onViewChanged();
    } else if (gesture.kind === 'stir') {
      const now = performance.now();
      const dt = Math.max(8, now - gesture.lastT) / 1000;
      gesture.lastT = now;
      const [wx, wy] = renderer.screenToWorld(px, py);
      // Pointer velocity in world units per second, gently capped.
      let vx = ((dxPx / size) * w) / dt;
      let vy = ((dyPx / size) * w) / dt;
      const vmax = 3;
      const vm = Math.hypot(vx, vy);
      if (vm > vmax) { vx *= vmax / vm; vy *= vmax / vm; }
      sim.stir(wx, wy, state.genome.params.rMax * 1.6, vx * 0.35, vy * 0.35);
    } else if (gesture.kind === 'seed' || gesture.kind === 'erase') {
      applyBrush(px, py, rng);
    }
  });

  const end = (e) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.kind === 'pinch') {
      if (pointers.size === 0) gesture = null;
      return;
    }
    if (p && !gesture.moved && e.type === 'pointerup' && (gesture.kind === 'stir' || gesture.kind === 'pan')) {
      trackAt(p.px, p.py);
    }
    gesture = null;
    plate.classList.remove('is-dragging');
  };
  plate.addEventListener('pointerup', end);
  plate.addEventListener('pointercancel', end);
  plate.addEventListener('pointerleave', () => updateBrush());

  plate.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = plateXY(e);
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    zoomAt(px, py, Math.max(1, Math.min(12, state.view.zoom * factor)));
  }, { passive: false });

  plate.addEventListener('dblclick', (e) => {
    e.preventDefault();
    resetView();
  });
}

function applyBrush(px, py, rng) {
  if (!renderer) return;
  const [wx, wy] = renderer.screenToWorld(px, py);
  const r = brushRadiusWorld();
  // A count change comes back through onCountEdited -> syncCountDisplay.
  if (state.tool === 'seed') {
    sim.seed(wx, wy, r, state.seedSpecies, 8, Math.floor(rng() * 0x100000000));
  } else if (state.tool === 'erase') {
    sim.erase(wx, wy, r);
  }
}

let countTimer = 0;
function syncCountDisplay() {
  // Seeding and erasing change n directly in the dish; keep the genome and caption honest.
  clearTimeout(countTimer);
  countTimer = setTimeout(() => {
    const n = sim.view.n;
    state.genome.params.n = Math.max(PARAM_LIMITS.n.min, Math.min(PARAM_LIMITS.n.max, Math.round(n / 100) * 100));
    scrubs.n && scrubs.n.set(n);
    syncWorldCode();
  }, 80);
}

function zoomAt(px, py, newZoom) {
  const plate = $('dish-plate');
  const size = plate.clientWidth;
  const v = state.view;
  // Keep the world point under the pointer fixed while zooming.
  const w0 = 1 / v.zoom;
  const w1 = 1 / newZoom;
  const ux = px / size - 0.5;
  const uy = py / size - 0.5;
  v.cx = ((v.cx + ux * (w0 - w1)) % 1 + 1) % 1;
  v.cy = ((v.cy + uy * (w0 - w1)) % 1 + 1) % 1;
  v.zoom = newZoom;
  if (newZoom === 1) { v.cx = Math.round(v.cx * 1e6) / 1e6; v.cy = Math.round(v.cy * 1e6) / 1e6; }
  onViewChanged();
}

function trackAt(px, py) {
  if (!renderer) return;
  const [wx, wy] = renderer.screenToWorld(px, py);
  const maxDist = (2.5 / state.view.zoom) * state.genome.params.rMax;
  // Answered at once from the positions on screen; the simulation is then told which particle,
  // by its stable id, to follow.
  const v = sim.view;
  const idx = sim.nearest(wx, wy, Math.max(maxDist, state.genome.params.rMax * 0.6));
  const id = idx >= 0 ? v.id[idx] : -1;
  const species = idx >= 0 ? v.species[idx] : -1;
  clearTracking();
  if (id >= 0) {
    sim.track(id);
    announce(`Tracking a particle of species ${letter(species)}. Press Escape to stop.`);
  }
}

// ---------------------------------------------------------------- caption controls

function initScrubs() {
  let before = null;
  const begin = () => { if (!before) before = cloneGenome(state.genome); };
  const end = (label) => () => {
    if (before) commitFrom(before, label);
    before = null;
  };

  scrubs.n = createScrub($('s-n'), {
    value: liveCount(state.genome), min: PARAM_LIMITS.n.min, max: Math.min(PARAM_LIMITS.n.max, CAPACITY), step: 100,
    format: fmtInt, label: 'Number of particles', pxPerStep: 3,
    onInput(v) {
      begin();
      state.genome.params.n = v;
      sim.setCount(v, state.genome.seed);
      syncWorldCode();
    },
    onCommit: end('particle count'),
  });

  scrubs.S = createScrub($('s-S'), {
    value: state.genome.species, min: SPECIES_MIN, max: SPECIES_MAX, step: 1,
    format: (v) => String(v), label: 'Number of species', pxPerStep: 18,
    onInput(v) {
      begin();
      const next = withSpecies(state.genome, v, randomSeed());
      applyGenome(next);
    },
    onCommit: end('species count'),
  });

  scrubs.side = createScrub($('s-side'), {
    value: sideOf(state.genome.params.rMax),
    min: Math.ceil(10 / PARAM_LIMITS.rMax.max) / 10, max: Math.floor(10 / PARAM_LIMITS.rMax.min) / 10, step: 0.1,
    format: fmtFixed(1), label: 'Side of the square in interaction radii', pxPerStep: 2,
    onInput(v) {
      begin();
      const rMax = Math.min(PARAM_LIMITS.rMax.max, Math.max(PARAM_LIMITS.rMax.min, Math.round((1 / v) * 1000) / 1000));
      state.genome.params.rMax = rMax;
      sim.setParams({ rMax });
      syncWorldCode();
      syncAxes();
    },
    onCommit: end('square size'),
  });

  scrubs.beta = createScrub($('s-beta'), {
    value: state.genome.params.beta, min: PARAM_LIMITS.beta.min, max: PARAM_LIMITS.beta.max, step: 0.01,
    format: fmtFixed(2), label: 'Core radius beta, in interaction radii', pxPerStep: 4,
    onInput(v) {
      begin();
      state.genome.params.beta = v;
      sim.setParams({ beta: v });
      syncHover();
      syncWorldCode();
    },
    onCommit: end('core radius'),
  });

  scrubs.half = createScrub($('s-half'), {
    value: Math.round(state.genome.params.halfLife * 1000),
    min: Math.round(PARAM_LIMITS.halfLife.min * 1000), max: Math.round(PARAM_LIMITS.halfLife.max * 1000), step: 1,
    format: fmtInt, label: 'Velocity half-life in milliseconds', unit: 'ms', pxPerStep: 3, log: true,
    onInput(v) {
      begin();
      state.genome.params.halfLife = v / 1000;
      sim.setParams({ halfLife: v / 1000 });
      syncWorldCode();
    },
    onCommit: end('velocity half-life'),
  });

  scrubs.k = createScrub($('s-k'), {
    value: state.genome.params.force, min: PARAM_LIMITS.force.min, max: PARAM_LIMITS.force.max, step: 0.5,
    format: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)), label: 'Force scale k', pxPerStep: 5,
    onInput(v) {
      begin();
      state.genome.params.force = v;
      sim.setParams({ force: v });
      syncWorldCode();
    },
    onCommit: end('force scale'),
  });

  const speedEl = $('s-speed');
  scrubs.speed = createScrub(speedEl, {
    value: state.speedIndex, min: 0, max: SPEEDS.length - 1, step: 1,
    format: (v) => {
      const s = SPEEDS[v];
      return s === 0.25 ? '¼' : s === 0.5 ? '½' : String(s);   // multiples of real time
    },
    label: 'Simulation speed', pxPerStep: 16,
    onInput(v) { state.speedIndex = v; },
    onCommit() {},
  });
}

// ---------------------------------------------------------------- copy / paste

async function copyCode() {
  const code = encodeGenome(state.genome);
  const text = window.top === window ? location.href.split('#')[0] + '#' + code : code;
  try {
    await navigator.clipboard.writeText(text);
    announceVisible(window.top === window ? 'Copied a link to this world.' : 'Copied the world code.');
  } catch {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents($('world-code'));
    sel.removeAllRanges();
    sel.addRange(range);
    announceVisible('Selected the world code. Press Ctrl+C or Cmd+C to copy it.');
  }
}

let flashTimer = 0;
function announceVisible(text) {
  const btn = $('act-copy');
  btn.textContent = text.startsWith('Copied') ? 'Copied' : 'Selected';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { btn.textContent = 'Copy world code'; }, 1600);
  announce(text);
}

function initPaste() {
  const form = $('paste-form');
  const input = $('paste-input');
  const error = $('paste-error');
  const toggle = $('act-paste');
  const open = (on) => {
    form.hidden = !on;
    toggle.setAttribute('aria-expanded', String(on));
    error.textContent = '';
    if (on) input.focus();
    else toggle.focus();
  };
  toggle.addEventListener('click', () => open(form.hidden));
  $('paste-cancel').addEventListener('click', () => open(false));
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); open(false); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) {
      error.textContent = 'Paste a world code first. Codes start with t1.';
      return;
    }
    const g = decodeGenome(raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw);
    if (!g) {
      error.textContent = 'That is not a Tropism world code. Codes start with t1 and come from Copy world code.';
      return;
    }
    state.presetId = null;
    commit(g, 'loaded code', { reset: true });
    syncPresetCurrent();
    input.value = '';
    open(false);
    announce('Loaded the world from its code.');
  });
}

// ---------------------------------------------------------------- Extended Data

function drawThumb(canvas, preset) {
  const data = decodeThumb(preset.thumb);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = Math.max(120, Math.round(canvas.clientWidth || 220));
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  const styles = getComputedStyle(document.documentElement);
  ctx.fillStyle = styles.getPropertyValue('--paper').trim() || '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const colors = paletteCSS(data.S);
  const r = Math.max(1, 1.15 * dpr * (size / 220));
  ctx.globalAlpha = 0.9;
  for (let s = 0; s < data.S; s++) {
    ctx.fillStyle = colors[s];
    ctx.beginPath();
    for (let k = 0; k < data.n; k++) {
      if (data.species[k] !== s) continue;
      const x = data.x[k] * canvas.width;
      const y = data.y[k] * canvas.height;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function buildGallery() {
  const grid = $('ed-grid');
  grid.textContent = '';
  PRESETS.forEach((preset, k) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ed__item';
    btn.dataset.preset = preset.id;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    const cap = document.createElement('span');
    cap.className = 'ed__cap';
    const title = document.createElement('b');
    title.textContent = `Extended Data Fig. ${k + 1} | ${preset.name}.`;
    const meta = document.createElement('span');
    meta.className = 'ed__meta';
    meta.textContent = `${preset.species} species · open in Fig. 1`;
    cap.append(title, ' ', preset.blurb, meta);
    btn.append(canvas, cap);
    btn.addEventListener('click', () => {
      loadPreset(preset);
      const fig = $('fig1');
      fig.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
    });
    li.append(btn);
    grid.append(li);
  });
  requestAnimationFrame(redrawThumbs);
  syncPresetCurrent();
}

function redrawThumbs() {
  for (const btn of document.querySelectorAll('.ed__item')) {
    const preset = PRESETS.find((p) => p.id === btn.dataset.preset);
    if (preset) drawThumb(btn.querySelector('canvas'), preset);
  }
}

function syncPresetCurrent() {
  for (const btn of document.querySelectorAll('.ed__item')) {
    const current = btn.dataset.preset === state.presetId;
    if (current) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
    const meta = btn.querySelector('.ed__meta');
    const preset = PRESETS.find((p) => p.id === btn.dataset.preset);
    if (meta && preset) meta.textContent = `${preset.species} species · ${current ? 'running in Fig. 1 now' : 'open in Fig. 1'}`;
  }
}

// ---------------------------------------------------------------- keyboard

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t && t.isContentEditable);
    if (typing) return;
    // No shortcuts mid-gesture: an undo or new world during a drag would commit against a stale base.
    if (gesture || document.documentElement.classList.contains('scrub-dragging') || document.querySelector('.tm-root.is-dragging')) return;
    // Let focused sliders and the matrix grid keep their own keys.
    const ownsKeys = t && t.closest && t.closest('[role="slider"], [role="grid"], [role="gridcell"]');
    const mod = e.ctrlKey || e.metaKey;

    if ((e.key === 'z' || e.key === 'Z') && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    if (ownsKeys && !['Escape', 'n', 'N', 'm', 'M', 't', 'T'].includes(e.key)) return;

    switch (e.key) {
      case ' ':
        if (t && (t.tagName === 'BUTTON' || t.tagName === 'A')) return;
        e.preventDefault();
        setRunning(!state.running);
        break;
      case 'n': case 'N': newWorld(); break;
      case 'm': case 'M': mutate(); break;
      case 't': case 'T': setTrails(!state.trails); break;
      case '0': resetView(); break;
      case '1': setTool('stir'); break;
      case '2': setTool('seed'); break;
      case '3': setTool('erase'); break;
      case '4': setTool('pan'); break;
      case 'Escape':
        if (sim.tracking) { clearTracking(); announce('Stopped tracking.'); }
        if (state.highlight >= 0) setHighlight(-1);
        break;
      default: return;
    }
  });
}

// ---------------------------------------------------------------- theme

function refreshTheme() {
  renderer && renderer.refreshTheme();
  matrix && matrix.refreshTheme();
  forceCurve && forceCurve.refreshTheme();
  traces && traces.refreshTheme();
  axes && axes.refreshTheme();
  if (state.genome) {
    matrix && matrix.set(state.genome.species, state.genome.matrix);
    buildSeedSpecies();
  }
  redrawThumbs();
}

function initTheme() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => requestAnimationFrame(refreshTheme);
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  new MutationObserver(onChange).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// ---------------------------------------------------------------- layout

function initLayout() {
  const fig = $('fig1');
  if (AXES_MARGIN) {
    fig.style.setProperty('--ax-l', AXES_MARGIN.left + 'px');
    fig.style.setProperty('--ax-r', AXES_MARGIN.right + 'px');
    fig.style.setProperty('--ax-t', AXES_MARGIN.top + 'px');
    // The x-axis title (with its subscript) hangs just below the plotted margin; reserve its band.
    fig.style.setProperty('--ax-b', (AXES_MARGIN.bottom + 10) + 'px');
  }
  const plate = $('dish-plate');
  const canvas = $('dish-canvas');
  const resize = () => {
    const w = plate.clientWidth;
    const h = plate.clientHeight;
    if (!w || !h) return;
    renderer && renderer.resize(w, h, Math.min(2, window.devicePixelRatio || 1));
    syncAxes();
  };
  new ResizeObserver(resize).observe(plate);
  resize();

  // Stop stepping while the dish is scrolled out of view; the figure resumes where it was.
  new IntersectionObserver((entries) => {
    for (const en of entries) state.visible = en.isIntersecting;
  }, { threshold: 0 }).observe(canvas);

  let thumbW = 0;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (Math.abs(w - thumbW) > 20) { thumbW = w; redrawThumbs(); }
  }).observe($('ed-grid'));
}

// ---------------------------------------------------------------- frame loop

let lastStats = 0;
let lastFrame = 0;

/** Steps owed for `wall` seconds at the chosen speed, fast-forwarded while a fresh world condenses. */
function stepsDue(wall) {
  let rate = REAL_TIME_STEPS * SPEEDS[state.speedIndex];
  const steps = sim.view ? sim.view.steps : WARM_STEPS;
  if (!reducedMotion.matches && steps < WARM_STEPS) {
    const left = 1 - steps / WARM_STEPS;
    rate *= 1 + (WARM_BOOST - 1) * left * left;
  }
  return rate * wall;
}
let slowSamples = 0;
let adaptations = 0;
let adaptSteps = -1;     // step count at the last device check

function drawDish() {
  renderer.draw(sim.view, {
    trails: state.trails,
    highlight: state.highlight,
    path: track.length > 1 ? track.path : null,
    pathLength: track.length,
  });
  updateTrackLabel();
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!state.genome) return;

  // This frame's share of steps. The worker takes them on its own thread (as fast as it can
  // when a dense world falls behind); the main-thread fallback spends at most ~14 ms here.
  const wall = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  if (state.running && state.visible && wall > 0) sim.tick(stepsDue(wall));

  // The dish is drawn every frame from the latest positions, whether or not the world moved.
  if (renderer && state.visible) drawDish();

  if (now - lastStats >= STATS_INTERVAL) {
    lastStats = now;
    const stats = sim.stats();
    if (stats) {
      const t = stats.steps * DT;
      if (state.running && state.visible) {
        if (stats.steps !== traceSteps) pushTraces(stats, t);
        adaptToDevice(stats.steps);
      }
      sonifier && sonifier.running && sonifier.update(stats);
      $('clock-t').textContent = t.toFixed(1);
      $('live-t').textContent = t.toFixed(1);
      const agg = stats.aggregationAll;
      $('live-agg').textContent = Number.isFinite(agg) ? agg.toFixed(1) : '1.0';
    }
  }
}

/** If this device cannot keep up, quietly lower the particle count (at most three times). */
function adaptToDevice(steps) {
  if (adaptations >= 3 || steps === adaptSteps) return;
  adaptSteps = steps;
  // Dense worlds cost more per step than sparse ones, so this watches the actual cost:
  // a sustained shortfall against the chosen speed trims a quarter of the particles.
  const affordable = STEP_BUDGET_MS[sim.kind] / Math.max(0.1, sim.stepCost);   // steps per second
  if (affordable < REAL_TIME_STEPS * SPEEDS[state.speedIndex]) slowSamples += 1;
  else slowSamples = Math.max(0, slowSamples - 2);
  const n0 = sim.view.n;
  if (slowSamples > SLOW_SAMPLES && n0 > 2000) {
    adaptations += 1;
    slowSamples = 0;
    const n = Math.max(2000, Math.round((n0 * 0.75) / 100) * 100);
    state.genome.params.n = n;
    sim.setCount(n, state.genome.seed);
    scrubs.n && scrubs.n.set(n);
    syncWorldCode();
    announce(`Reduced the dish to ${fmtInt(n)} particles so it keeps up on this device.`);
  }
}

// ---------------------------------------------------------------- boot

function initialGenome() {
  const hash = (location.hash || '').replace(/^#/, '');
  if (hash) {
    const g = decodeGenome(hash);
    if (g) return { genome: g, presetId: null };
  }
  // The opening world: many multi-coloured bodies, with hunters already at work.
  const lead = PRESETS.find((p) => p.id === 'hunted-colonies') || PRESETS.find((p) => p.species >= 5) || PRESETS[0];
  if (lead) {
    const g = decodeGenome(lead.code);
    if (g) return { genome: g, presetId: lead.id };
  }
  return { genome: randomGenome(randomSeed(), { species: 6, params: defaultParams() }), presetId: null };
}

function boot() {
  const { genome, presetId } = initialGenome();
  if (window.matchMedia('(max-width: 640px)').matches || (navigator.hardwareConcurrency || 8) <= 4) {
    genome.params.n = Math.min(genome.params.n, 3000);
  }
  state.presetId = presetId;

  try {
    renderer = createRenderer($('dish-canvas'));
  } catch (err) {
    console.error(err);
    renderer = null;
    $('dish-fallback').hidden = false;
  }

  axes = createAxes($('dish-axes'));
  forceCurve = createForceCurve($('force'), { aspect: 1.3, minHeight: 170, maxHeight: 260 });
  traces = createTraces($('traces'), { seconds: 20, aspect: 2.5, minHeight: 200, maxHeight: 240 });
  matrix = createMatrix($('matrix'), {
    onHover(i, j) {
      state.hover = { i, j };
      syncHover();
    },
    onChange(i, j, value) {
      const g = state.genome;
      g.matrix[i * g.species + j] = quantizeAffinity(value);
      sim.setMatrix(g.matrix);
      if (state.hover.i === i && state.hover.j === j) syncHover();
      syncWorldCode();
    },
    onCommit(i, j, before, after) {
      // The revision is the current genome with this one cell put back, so an edit can
      // never be recorded against a stale snapshot.
      const base = cloneGenome(state.genome);
      base.matrix[i * base.species + j] = quantizeAffinity(before);
      commitFrom(base, `a${letter(i)}${letter(j)} ${fmtSigned(before)} → ${fmtSigned(after)}`);
      state.presetId = null;
      syncPresetCurrent();
    },
    onHighlight(s) {
      state.highlight = s;
      announce(s >= 0 ? `Showing species ${letter(s)} only.` : 'Showing all species.');
    },
  });
  sonifier = createSonifier();

  buildTrackLabel();
  applyGenome(genome, { reset: true });
  initScrubs();
  syncCaption();
  syncHistory();
  initLayout();
  renderer && renderer.setView(state.view);
  onViewChanged();
  initDishPointer();
  initPaste();
  initKeyboard();
  initTheme();
  buildGallery();
  setTool('stir');
  setRunning(true);

  for (const b of document.querySelectorAll('#tool-group [data-tool]')) {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  }
  $('tool-group').addEventListener('keydown', radioKeys('#tool-group [data-tool]', (b) => setTool(b.dataset.tool)));
  $('seed-species').addEventListener('click', (e) => {
    const b = e.target.closest('[data-species]');
    if (b) setSeedSpecies(Number(b.dataset.species));
  });
  $('seed-species').addEventListener('keydown', radioKeys('#seed-species [data-species]', (b) => setSeedSpecies(Number(b.dataset.species))));
  $('act-pause').addEventListener('click', () => setRunning(!state.running));
  $('act-trails').addEventListener('click', () => setTrails(!state.trails));
  $('act-view').addEventListener('click', resetView);
  $('act-new').addEventListener('click', newWorld);
  $('act-mutate').addEventListener('click', mutate);
  $('act-undo').addEventListener('click', undo);
  $('act-redo').addEventListener('click', redo);
  $('act-copy').addEventListener('click', copyCode);
  $('act-sound').addEventListener('click', toggleSound);

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      matrix.set(state.genome.species, state.genome.matrix);
      syncAxes();
      syncHover();
    });
  }

  requestAnimationFrame(frame);

  // Development hook: ?debug exposes a way to advance the dish without relying on
  // animation frames (which background tabs throttle). Never present in shared links.
  // The simulation runs in a worker, so advance() and bench() return promises, and
  // `ready` resolves once the ?debug steps below have reached the dish (tools/capture.mjs waits for it).
  const debugParams = new URLSearchParams(location.search);
  if (debugParams.has('debug')) {
    window.__tropism = {
      state, sim,
      get world() { return sim.view; },
      async advance(steps = 300) {
        // Statistics are sampled every 5 steps (0.1 s of simulated time), as the live loop would,
        // and reach panel d through onSamples.
        const r = await sim.advance(steps, 5);
        if (renderer) drawDish();
        $('clock-t').textContent = (sim.view.steps * DT).toFixed(1);
        return r;
      },
      async bench(steps = 120) {
        const r = await sim.bench(steps);
        const t1 = performance.now();
        for (let k = 0; k < 30; k++) renderer.draw(sim.view, { trails: state.trails, highlight: -1, path: null, pathLength: 0 });
        const t2 = performance.now();
        return { msPerStep: r.msPerStep, msPerDraw: (t2 - t1) / 30, n: r.n, renderer: renderer && renderer.kind, sim: sim.kind };
      },
      ready: null,
    };
    // ?debug=600 pre-advances the dish (for headless captures); &theme=dark forces a theme;
    // &pause stops the clock after pre-advancing; &scroll=<id> scrolls an element into view.
    const pre = Number(debugParams.get('debug'));
    if (debugParams.get('theme')) document.documentElement.setAttribute('data-theme', debugParams.get('theme'));
    if (debugParams.has('trails')) setTrails(true);
    if (debugParams.get('zoom')) {
      state.view.zoom = Math.max(1, Math.min(12, Number(debugParams.get('zoom')) || 1));
      onViewChanged();
    }
    // Pause before pre-advancing, so the dish holds exactly the pre-advanced state rather than
    // whatever the worker stepped on its own meanwhile.
    if (debugParams.has('pause')) setRunning(false);
    let ready = Promise.resolve();
    if (pre > 0) {
      ready = ready.then(async () => {
        for (let k = 0; k < pre; k += 50) await window.__tropism.advance(Math.min(50, pre - k));
      });
    }
    if (debugParams.has('track')) {
      // Track the particle nearest the view centre once the world has formed.
      ready = ready.then(() => {
        const idx = sim.nearest(state.view.cx, state.view.cy, 0.5);
        if (idx >= 0) sim.track(sim.view.id[idx]);
        return window.__tropism.advance(Number(debugParams.get('track')) || 200);
      });
    }
    window.__tropism.ready = ready
      .then(() => sim.synced())
      .then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))
      .catch((err) => {
        console.error(err);
        return false;
      });
    if (debugParams.get('hover')) {
      const [i, j] = debugParams.get('hover').split(',').map(Number);
      state.hover = { i, j };
      syncHover();
    }
    if (debugParams.get('scroll')) {
      const target = document.getElementById(debugParams.get('scroll'));
      if (target) setTimeout(() => target.scrollIntoView({ block: 'start' }), 50);
    }
  }
}

async function toggleSound() {
  const b = $('act-sound');
  if (sonifier.running) {
    sonifier.stop();
    b.setAttribute('aria-pressed', 'false');
    b.textContent = 'Sonify';
    announce('Sound off.');
  } else {
    const ok = await sonifier.start();
    if (ok) {
      b.setAttribute('aria-pressed', 'true');
      b.textContent = 'Sound on';
      announce('Sound on. Each species is one voice.');
    } else if (!('AudioContext' in window || 'webkitAudioContext' in window)) {
      announce('This browser cannot play generated sound.');
    }
  }
}

/** Arrow-key navigation for a role="radiogroup" of buttons. */
function radioKeys(selector, choose) {
  return (e) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const items = [...document.querySelectorAll(selector)];
    let k = items.indexOf(document.activeElement);
    if (k < 0) return;
    e.preventDefault();
    if (e.key === 'Home') k = 0;
    else if (e.key === 'End') k = items.length - 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') k = (k - 1 + items.length) % items.length;
    else k = (k + 1) % items.length;
    items[k].focus();
    choose(items[k]);
  };
}

boot();
