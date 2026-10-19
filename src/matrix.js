// Panel b: the affinity table, drawn the way a paper draws a correlation
// matrix (a bubble correlogram), and edited in place.
//
//   filled ink disc  a > 0   the row species is drawn to the column species
//   open ink ring    a < 0   the row species is pushed from it
//   small grey dot   a = 0   indifference
//   bubble area is proportional to |a|; the diagonal (self-affinity) sits on a faint band.
//
// Editing: press a cell and drag vertically (up = more attraction, 0.05 per 6px,
// Shift for 0.05 per 18px), or use the keyboard grid. Every value passes through
// quantizeAffinity() so the table always holds exactly what a genome can encode.

import { quantizeAffinity } from './genome.js';
import { SPECIES, markerPath, currentTheme } from './markers.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MINUS = '\u2212';

// ---- editing ---------------------------------------------------------------
const STEP = 0.05;                 // one quantum of affinity (genome AFFINITY_STEP)
const STEP_BIG = 0.25;             // keyboard step with Shift
const DRAG_PX_PER_STEP = 6;
const DRAG_PX_PER_STEP_FINE = 18;  // with Shift

// ---- geometry (CSS px) -----------------------------------------------------
const CELL_MIN = 22;
const CELL_MAX = 56;
const HEAD_CELLS = 1.4;            // header bands are about 1.4 cells deep ...
const HEAD_MIN = 34;               // ... but never shallower than marker + letter + focus ring need
const HEAD_MAX = 44;               // ... nor deeper than the marker + letter can use
const TITLE_BAND = 18;             // axis titles sit outside the header bands
const BUBBLE_SCALE = 0.46;         // radius at |a| = 1, as a fraction of the cell
const RING_STROKE = 1.5;
const RING_MIN_R = 2;              // keeps the smallest ring visibly open
const ZERO_DOT_R = 1;              // a 2px dot
const MARKER_R = 12 * 0.36;        // a 12px species marker, in markerSVG() proportion
const ROW_TITLE_EST = 118;         // fallback length of the row title before it can be measured

// ---- motion and the live drag value ----------------------------------------
const TWEEN_MS = 120;
const FLAG_W = 46;
const FLAG_H = 20;
const FLAG_GAP = 4;
const TOUCH_LIFT = 28;             // keep the value clear of a fingertip

const KIND_ZERO = 0;
const KIND_POS = 1;
const KIND_NEG = 2;
const KIND_CLASS = ['tm-bubble tm-zero', 'tm-bubble tm-pos', 'tm-bubble tm-neg'];

const ACT_NONE = 0;
const ACT_CELL = 1;
const ACT_HEAD = 2;

const EDIT_UP = Object.freeze({ delta: STEP });
const EDIT_UP_BIG = Object.freeze({ delta: STEP_BIG });
const EDIT_DOWN = Object.freeze({ delta: -STEP });
const EDIT_DOWN_BIG = Object.freeze({ delta: -STEP_BIG });
const EDIT_ZERO = Object.freeze({ set: 0 });

const HELP_TEXT =
  'Each cell is how strongly the row species is drawn to the column species, ' +
  `from ${MINUS}1, pushed away, to +1, drawn in. Arrow keys move between cells. ` +
  'Plus or equals raises the value by 0.05 and minus lowers it; with Shift, by 0.25. ' +
  '0 or Delete sets it to zero. A cell can also be dragged up or right to raise it, down or left to lower it. ' +
  'On a species header, Enter highlights that species in panel a.';

const STYLE_ID = 'tm-style';
const STYLE = `
.tm-root { position: relative; color: var(--ink); }
.tm-probe { display: block; height: 0; overflow: hidden; }
.tm-svg { display: block; max-width: none; overflow: visible; touch-action: pan-y pinch-zoom;
  -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
.tm-svg :focus { outline: none; }
.tm-svg text { pointer-events: none; }
.tm-hit { fill: none; pointer-events: all; }
.tm-diag { fill: var(--hilite); }
.tm-lines { fill: none; stroke: var(--rule); stroke-width: 1; shape-rendering: crispEdges; }
.tm-cell { cursor: ns-resize; }
.tm-cell.is-hover > .tm-hit { fill: var(--hilite); }
.tm-cell.is-drag > .tm-hit { fill: var(--hilite-2, var(--hilite)); }
.tm-bubble { pointer-events: none; }
.tm-pos { fill: var(--ink); stroke: none; }
.tm-neg { fill: none; stroke: var(--ink); stroke-width: ${RING_STROKE}; }
.tm-zero { fill: var(--ink-3); stroke: none; }
.tm-root.has-selection .tm-cell:not(.in-selection):not(.is-hover) .tm-bubble { opacity: 0.28; }
.tm-ring { fill: none; stroke: none; stroke-width: 2; pointer-events: none; shape-rendering: crispEdges; }
.tm-cell:focus-visible > .tm-ring, .tm-head:focus-visible > .tm-ring { stroke: var(--ink); }
.tm-head { cursor: pointer; }
@media (hover: hover) { .tm-head:hover > .tm-hit { fill: var(--hilite); } }
.tm-mark { pointer-events: none; }
.tm-head.is-lit .tm-letter, .tm-head.is-selected .tm-letter { fill: var(--ink); font-weight: 700; }
.tm-bar { fill: var(--ink); visibility: hidden; pointer-events: none; shape-rendering: crispEdges; }
.tm-head.is-selected > .tm-bar { visibility: visible; }
.tm-title .t-math { font-size: 1.12em; }
.tm-flag { visibility: hidden; pointer-events: none; }
.tm-flag.is-on { visibility: visible; }
.tm-flag-box { fill: var(--paper); stroke: var(--ink); stroke-width: 1; shape-rendering: crispEdges; }
.tm-root.is-dragging, .tm-root.is-dragging * { cursor: ns-resize; }
.tm-readout { display: grid; margin-top: var(--gap-2); min-height: 1.5em;
  font: 400 var(--fs-label)/1.5 var(--font-label); font-variant-numeric: tabular-nums; color: var(--ink-2); }
.tm-readout > .tm-key, .tm-readout > .tm-live { grid-area: 1 / 1; min-width: 0; }
.tm-readout.is-idle > .tm-live, .tm-readout:not(.is-idle) > .tm-key { visibility: hidden; }
.tm-key { display: flex; flex-wrap: wrap; column-gap: 1.1em; color: var(--ink-3); }
.tm-k { white-space: nowrap; }
.tm-readout .t-value { color: var(--ink); }
.tm-readout .t-math { font-size: 1.15em; line-height: 1; }
.tm-readout sub { font-size: 0.8em; line-height: 0; vertical-align: -0.28em; margin-left: 0.04em; }
.tm-sep { color: var(--ink-3); padding: 0 0.4em; }
.tm-glyph, .tm-sp { display: inline-block; overflow: visible; vertical-align: -1px; }
.tm-glyph { width: 10px; height: 10px; margin-right: 0.35em; }
.tm-sp { width: 12px; height: 12px; margin-right: 0.18em; vertical-align: -2px; }
.tm-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (forced-colors: active) {
  .tm-pos, .tm-bar { fill: CanvasText; }
  .tm-neg { stroke: CanvasText; }
  .tm-zero { fill: GrayText; }
  .tm-lines { stroke: GrayText; }
  .tm-cell:focus-visible > .tm-ring, .tm-head:focus-visible > .tm-ring { stroke: Highlight; }
  .tm-flag-box { fill: Canvas; stroke: CanvasText; }
}
`;

let instanceCount = 0;

// ============================================================================
// Pure helpers (no DOM). Exported together as `matrixHelpers` for tests and for
// pages that want to format affinities exactly the way the panel does.
// ============================================================================

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** "+0.45", "−0.45" (true minus), "0.00". Never "-0.00". */
function formatAffinity(v) {
  const hundredths = Math.round(Math.abs(v) * 100);
  if (!Number.isFinite(hundredths) || hundredths === 0) return '0.00';
  return (v > 0 ? '+' : MINUS) + (hundredths / 100).toFixed(2);
}

/** The relation a row species has to a column species, as a verb phrase. */
function relationVerb(v) {
  const hundredths = Math.round(v * 100);
  if (!Number.isFinite(hundredths) || hundredths === 0) return 'ignores';
  return hundredths > 0 ? 'is drawn to' : 'is pushed from';
}

/**
 * Text for the pair (i, j) with value v:
 * { sub: 'BD', value: '+0.45', phrase: 'B is drawn to D', label: 'B toward D, +0.45' }.
 */
function describePair(i, j, v) {
  const a = SPECIES[i].letter;
  const b = SPECIES[j].letter;
  const value = formatAffinity(v);
  return { sub: a + b, value, phrase: `${a} ${relationVerb(v)} ${b}`, label: `${a} toward ${b}, ${value}` };
}

/**
 * Continuous (unquantised) affinity after a vertical pointer move of dyUp px
 * (positive = upward). The result is clamped to [-1, 1] so reversing direction
 * after overshooting an end responds immediately. Quantise for display/output.
 */
function dragAffinity(raw, dyUp, fine) {
  const px = fine ? DRAG_PX_PER_STEP_FINE : DRAG_PX_PER_STEP;
  return clamp(raw + (dyUp / px) * STEP, -1, 1);
}

/**
 * Keyboard edit for KeyboardEvent.key: { delta } or { set }, or null when the
 * key is not an edit. Shift selects the large step (so on a US layout "=" is
 * +0.05 and "+" is +0.25, symmetric with "-" and "_").
 */
function keyEdit(key, shiftKey) {
  switch (key) {
    case '+': case '=': case 'PageUp': case 'Add':
      return shiftKey ? EDIT_UP_BIG : EDIT_UP;
    case '-': case '_': case MINUS: case 'PageDown': case 'Subtract':
      return shiftKey ? EDIT_DOWN_BIG : EDIT_DOWN;
    case '0': case 'Delete': case 'Backspace':
      return EDIT_ZERO;
    default:
      return null;
  }
}

function headFor(cell) {
  return clamp(Math.round(cell * HEAD_CELLS), HEAD_MIN, HEAD_MAX);
}

/**
 * Integer layout for a container `width` px wide holding S species. Cells are
 * square, CELL_MIN..CELL_MAX px; the grid origin (x0, y0) and the cell size are
 * whole pixels so every 1px hairline lands on a half pixel.
 */
function computeLayout(width, S) {
  const s = Math.max(1, S | 0);
  const avail = Math.max(0, (Number(width) || 0) - TITLE_BAND - 2);
  // First estimate with headers at 1.4 cells, then give the grid whatever a
  // clamped header band leaves over.
  let cell = Math.floor(avail / (s + HEAD_CELLS));
  let head = headFor(cell);
  cell = clamp(Math.floor((avail - head) / s), CELL_MIN, CELL_MAX);
  head = headFor(cell);
  while (cell > CELL_MIN && TITLE_BAND + head + s * cell + 1 > width) {
    cell -= 1;
    head = headFor(cell);
  }
  const x0 = TITLE_BAND + head;
  const y0 = TITLE_BAND + head;
  return { cell, head, title: TITLE_BAND, x0, y0, width: x0 + s * cell + 1, height: y0 + s * cell + 1 };
}

/** Bubble kind for a (possibly mid-tween) value. */
function bubbleKind(v) {
  if (Math.abs(v) < 1e-6) return KIND_ZERO;
  return v > 0 ? KIND_POS : KIND_NEG;
}

/**
 * SVG radius for value v in a cell px wide: area ∝ |a|. A ring's radius is its
 * stroke centre, so it is drawn half a stroke inside the area-true radius.
 */
function bubbleRadius(v, cell) {
  const m = Math.abs(v);
  if (m < 1e-6) return ZERO_DOT_R;
  const r = Math.sqrt(Math.min(1, m)) * BUBBLE_SCALE * cell;
  return v > 0 ? r : Math.max(RING_MIN_R, r - RING_STROKE / 2);
}

export const matrixHelpers = Object.freeze({
  formatAffinity,
  relationVerb,
  describePair,
  dragAffinity,
  keyEdit,
  computeLayout,
  bubbleKind,
  bubbleRadius,
  KIND_ZERO,
  KIND_POS,
  KIND_NEG,
});

// ============================================================================
// DOM helpers
// ============================================================================

function noop() {}

function svgEl(doc, name, attrs, parent) {
  const el = doc.createElementNS(SVG_NS, name);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}

function htmlEl(doc, name, className, parent) {
  const el = doc.createElement(name);
  if (className) el.className = className;
  if (parent) parent.appendChild(el);
  return el;
}

function text(doc, parent, str) {
  const node = doc.createTextNode(str);
  parent.appendChild(node);
  return node;
}

function setText(node, str) {
  if (node.data !== str) node.data = str;
}

function setRect(el, x, y, w, h) {
  el.setAttribute('x', x);
  el.setAttribute('y', y);
  el.setAttribute('width', Math.max(0, w));
  el.setAttribute('height', Math.max(0, h));
}

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head || doc.documentElement).appendChild(style);
}

function axisTitle(doc, parent, before, math, after) {
  const t = svgEl(doc, 'text', { class: 't-axis tm-title', 'text-anchor': 'middle' }, parent);
  text(doc, t, before);
  const m = svgEl(doc, 'tspan', { class: 't-math' }, t);
  text(doc, m, math);
  if (after) text(doc, t, after);
  return t;
}

/** A 12px species marker inline in HTML text (colour = species, i.e. data). */
function inlineMarker(doc, parent) {
  const svg = svgEl(doc, 'svg', {
    class: 'tm-sp', width: 12, height: 12, viewBox: '-6 -6 12 12', 'aria-hidden': 'true', focusable: 'false',
  }, parent);
  const path = svgEl(doc, 'path', null, svg);
  return { svg, path, s: -1, theme: '' };
}

function paintInlineMarker(m, s, theme) {
  if (m.s !== s) {
    m.s = s;
    m.theme = '';
    m.path.setAttribute('d', markerPath(SPECIES[s].marker, MARKER_R));
  }
  if (m.theme !== theme) {
    m.theme = theme;
    m.path.setAttribute('fill', SPECIES[s][theme]);
  }
}

/** A 10px legend glyph (ink): the filled disc or the open ring. */
function legendGlyph(doc, parent, kind) {
  const svg = svgEl(doc, 'svg', {
    class: 'tm-glyph', width: 10, height: 10, viewBox: '-5 -5 10 10', 'aria-hidden': 'true', focusable: 'false',
  }, parent);
  svgEl(doc, 'circle', { class: KIND_CLASS[kind], r: kind === KIND_POS ? 4 : 4 - RING_STROKE / 2 }, svg);
  return svg;
}

// ============================================================================
// createMatrix
// ============================================================================

/**
 * @param {HTMLElement} container  the panel body; the matrix fills its width
 * @param {{ onHover?(i:number, j:number):void, onChange?(i:number, j:number, value:number):void,
 *           onCommit?(i:number, j:number, before:number, after:number):void,
 *           onHighlight?(s:number):void }} handlers
 *        onHover(-1, -1) when no cell is hovered or focused; onHighlight(-1) clears.
 */
export function createMatrix(container, handlers = {}) {
  if (!container || !container.ownerDocument) throw new TypeError('createMatrix: container must be an element');
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const fire = {
    hover: typeof handlers.onHover === 'function' ? handlers.onHover : noop,
    change: typeof handlers.onChange === 'function' ? handlers.onChange : noop,
    commit: typeof handlers.onCommit === 'function' ? handlers.onCommit : noop,
    highlight: typeof handlers.onHighlight === 'function' ? handlers.onHighlight : noop,
  };
  ensureStyle(doc);
  const uid = ++instanceCount;
  const helpId = `tm-help-${uid}`;

  // ---------------------------------------------------------------- static DOM
  const root = htmlEl(doc, 'div', 'tm-root');
  // A zero-height block as wide as the container. Resizes are observed on it,
  // not on the container: a relayout changes the SVG's height, and with it the
  // container's, so observing the container would report a size change caused
  // by our own callback ("ResizeObserver loop completed with undelivered
  // notifications"). The probe's box changes only when the width does.
  const probe = htmlEl(doc, 'div', 'tm-probe', root);
  probe.setAttribute('aria-hidden', 'true');

  const svg = svgEl(doc, 'svg', { class: 'tm-svg', focusable: 'false' }, root);
  const backLayer = svgEl(doc, 'g', { 'aria-hidden': 'true' }, svg);
  const diagPath = svgEl(doc, 'path', { class: 'tm-diag' }, backLayer);
  const grid = svgEl(doc, 'g', { role: 'grid', 'aria-describedby': helpId }, svg);
  const frontLayer = svgEl(doc, 'g', { 'aria-hidden': 'true' }, svg);
  const linesPath = svgEl(doc, 'path', { class: 'tm-lines' }, frontLayer);
  const colTitle = axisTitle(doc, frontLayer, 'column ', 'j', '');
  const rowTitle = axisTitle(doc, frontLayer, 'row ', 'i', ' \u00B7 is drawn to');
  const flag = svgEl(doc, 'g', { class: 'tm-flag' }, frontLayer);
  svgEl(doc, 'rect', { class: 'tm-flag-box', x: 0.5, y: 0.5, width: FLAG_W - 1, height: FLAG_H - 1 }, flag);
  const flagLabel = svgEl(doc, 'text', {
    class: 't-value', x: FLAG_W / 2, y: FLAG_H / 2, dy: '0.35em', 'text-anchor': 'middle',
  }, flag);
  const flagValue = text(doc, flagLabel, '');

  // Readout line: a key to the encoding while idle; the hovered pair otherwise.
  const readout = htmlEl(doc, 'div', 'tm-readout is-idle', root);
  const key = htmlEl(doc, 'span', 'tm-key', readout);
  key.setAttribute('aria-hidden', 'true');
  {
    const k1 = htmlEl(doc, 'span', 'tm-k', key);
    legendGlyph(doc, k1, KIND_POS);
    text(doc, k1, 'drawn to');
    const k2 = htmlEl(doc, 'span', 'tm-k', key);
    legendGlyph(doc, k2, KIND_NEG);
    text(doc, k2, 'pushed from');
    const k3 = htmlEl(doc, 'span', 'tm-k', key);
    text(doc, k3, 'area \u221D |');
    text(doc, htmlEl(doc, 'span', 't-math', k3), 'a');
    text(doc, k3, '|');
  }
  const live = htmlEl(doc, 'div', 'tm-live', readout);
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');

  const cellLine = htmlEl(doc, 'span', 'tm-line', live);
  text(doc, htmlEl(doc, 'span', 't-math', cellLine), 'a');
  const subText = text(doc, htmlEl(doc, 'sub', '', cellLine), '');
  text(doc, cellLine, ' = ');
  const valueText = text(doc, htmlEl(doc, 'span', 't-value', cellLine), '');
  const sep1 = htmlEl(doc, 'span', 'tm-sep', cellLine);
  sep1.setAttribute('aria-hidden', 'true');
  text(doc, sep1, '\u00B7');
  text(doc, htmlEl(doc, 'span', 'tm-sr', cellLine), ', ');
  const markI = inlineMarker(doc, cellLine);
  const letterI = text(doc, cellLine, '');
  const verbText = text(doc, cellLine, '');
  const markJ = inlineMarker(doc, cellLine);
  const letterJ = text(doc, cellLine, '');

  const headLine = htmlEl(doc, 'span', 'tm-line', live);
  const markH = inlineMarker(doc, headLine);
  const letterH = text(doc, headLine, '');
  const headSep = htmlEl(doc, 'span', 'tm-sep', headLine);
  headSep.setAttribute('aria-hidden', 'true');
  text(doc, headSep, '\u00B7');
  const headText = text(doc, headLine, '');
  cellLine.hidden = true;
  headLine.hidden = true;

  const help = htmlEl(doc, 'p', 'tm-sr', root);
  help.id = helpId;
  help.textContent = HELP_TEXT;

  container.appendChild(root);

  // --------------------------------------------------------------------- state
  let S = 0;
  let widthPx = container.clientWidth || 320;
  let L = computeLayout(widthPx, 2);
  const values = new Float64Array(SPECIES.length * SPECIES.length);
  const carry = new Float64Array(SPECIES.length * SPECIES.length);
  let cells = [];
  let colHeads = [];
  let rowHeads = [];
  let rows = [];
  let theme = currentTheme();
  const motionQuery = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduceMotion = !!(motionQuery && motionQuery.matches);
  let highlight = -1;
  let rowTitleLen = 0;
  let rowTitleMeasured = false;      // false while only the estimate is known (hidden, or no layout yet)

  let dragActive = false;
  let dragK = -1;
  let dragId = -1;
  let dragBefore = 0;
  let dragRaw = 0;
  let dragLastY = 0;
  let dragLastX = 0;
  let dragTouch = false;
  // A touch on a cell only becomes an edit once the finger moves sideways, so vertical
  // swipes over the table still scroll the page on phones.
  let touchPending = null;           // { k, id, x0, y0 } while deciding

  let pointerCell = -1;
  let pointerHead = -1;
  let focusR = 0;
  let focusC = 0;
  let hasFocus = false;
  let rovingEl = null;

  let activeKind = ACT_NONE;
  let activeIdx = -1;
  let hoverI = -1;
  let hoverJ = -1;

  let rafId = 0;
  let destroyed = false;

  // -------------------------------------------------------------- build / layout
  function makeCell(row, i, j) {
    const k = i * S + j;
    const g = svgEl(doc, 'g', { class: 'tm-cell', role: 'gridcell', tabindex: '-1', 'data-k': k }, row);
    const hit = svgEl(doc, 'rect', { class: 'tm-hit' }, g);
    const bubble = svgEl(doc, 'circle', { class: KIND_CLASS[KIND_ZERO], r: ZERO_DOT_R }, g);
    const ring = svgEl(doc, 'rect', { class: 'tm-ring' }, g);
    return { i, j, k, g, hit, bubble, ring, shown: 0, from: 0, t0: 0, tweening: false, kind: KIND_ZERO, rs: '', label: '' };
  }

  function makeHead(parent, s, axis) {
    const sp = SPECIES[s];
    const g = svgEl(doc, 'g', {
      class: 'tm-head',
      role: axis === 'col' ? 'columnheader' : 'rowheader',
      tabindex: '-1',
      'data-s': s,
      'data-axis': axis,
      'aria-label': `Species ${sp.letter}`,
      'aria-selected': 'false',
    }, parent);
    const hit = svgEl(doc, 'rect', { class: 'tm-hit' }, g);
    const bar = svgEl(doc, 'rect', { class: 'tm-bar' }, g);
    const mark = svgEl(doc, 'path', { class: 'tm-mark', d: markerPath(sp.marker, MARKER_R), fill: sp[theme] }, g);
    const letter = svgEl(doc, 'text', { class: 't-label tm-letter', 'text-anchor': 'middle' }, g);
    if (axis === 'row') letter.setAttribute('dy', '0.35em');
    text(doc, letter, sp.letter);
    const ring = svgEl(doc, 'rect', { class: 'tm-ring' }, g);
    return { s, axis, g, hit, bar, mark, letter, ring };
  }

  function build() {
    for (const r of rows) r.remove();
    rows = [];
    cells = [];
    colHeads = [];
    rowHeads = [];
    rovingEl = null;
    activeKind = ACT_NONE;
    activeIdx = -1;
    pointerCell = -1;
    pointerHead = -1;

    const headRow = svgEl(doc, 'g', { role: 'row' }, grid);
    rows.push(headRow);
    svgEl(doc, 'g', { role: 'columnheader', 'aria-label': 'Row species, toward column species' }, headRow);
    for (let j = 0; j < S; j++) colHeads.push(makeHead(headRow, j, 'col'));
    for (let i = 0; i < S; i++) {
      const row = svgEl(doc, 'g', { role: 'row' }, grid);
      rows.push(row);
      rowHeads.push(makeHead(row, i, 'row'));
      for (let j = 0; j < S; j++) cells.push(makeCell(row, i, j));
    }
    grid.setAttribute('aria-label',
      `Affinity table of ${S} species: how strongly each row species is drawn to each column species`);

    focusR = clamp(focusR, -1, S - 1);
    focusC = clamp(focusC, -1, S - 1);
    if (focusR < 0 && focusC < 0) focusR = focusC = 0;
    updateRoving();
  }

  function measureRowTitle() {
    let len = 0;
    try {
      len = rowTitle.getComputedTextLength();
    } catch (_) {
      len = 0;
    }
    // An unrendered title (display: none ancestor) measures 0: keep the
    // estimate and try again at the next layout.
    rowTitleMeasured = len > 0;
    rowTitleLen = rowTitleMeasured ? len : ROW_TITLE_EST;
  }

  function placeRowTitle() {
    const span = S * L.cell;
    // Centre on the grid; when the grid is shorter than the title (S = 2), sit
    // its end on the grid's bottom edge and let it run up beside the headers.
    let cy = L.y0 + span / 2;
    if (rowTitleLen > span) cy = L.y0 + span - rowTitleLen / 2;
    cy = Math.max(cy, rowTitleLen / 2 + 1);
    rowTitle.setAttribute('transform', `translate(${L.title - 5} ${cy.toFixed(1)}) rotate(-90)`);
  }

  function applyGeometry() {
    const { cell, x0, y0, title, head, width, height } = L;
    const span = S * cell;
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    let d = '';
    for (let i = 0; i < S; i++) d += `M${x0 + i * cell} ${y0 + i * cell}h${cell}v${cell}h${-cell}Z`;
    diagPath.setAttribute('d', d);

    d = '';
    for (let k = 0; k <= S; k++) {
      const p = k * cell + 0.5;
      d += `M${x0 + p} ${y0}V${y0 + span + 1}M${x0} ${y0 + p}H${x0 + span + 1}`;
    }
    linesPath.setAttribute('d', d);

    const mid = (cell + 1) / 2; // centre of a cell's interior, past its left/top hairline
    for (const c of cells) {
      const x = x0 + c.j * cell;
      const y = y0 + c.i * cell;
      setRect(c.hit, x, y, cell, cell);
      c.bubble.setAttribute('cx', x + mid);
      c.bubble.setAttribute('cy', y + mid);
      setRect(c.ring, x + 3, y + 3, cell - 5, cell - 5);
      c.rs = '';
      renderBubble(c);
    }
    for (const hd of colHeads) {
      const x = x0 + hd.s * cell;
      setRect(hd.hit, x, title, cell, head - 1);
      setRect(hd.bar, x + 1, y0 - 3, cell - 1, 2);
      setRect(hd.ring, x + 3, title + 2, cell - 5, head - 6);
      hd.mark.setAttribute('transform', `translate(${x + mid} ${y0 - 25})`);
      hd.letter.setAttribute('x', x + mid);
      hd.letter.setAttribute('y', y0 - 8);
    }
    for (const hd of rowHeads) {
      const y = y0 + hd.s * cell;
      setRect(hd.hit, title, y, head - 1, cell);
      setRect(hd.bar, x0 - 3, y + 1, 2, cell - 1);
      setRect(hd.ring, title + 2, y + 3, head - 6, cell - 5);
      hd.mark.setAttribute('transform', `translate(${x0 - 26} ${y + mid})`);
      hd.letter.setAttribute('x', x0 - 11);
      hd.letter.setAttribute('y', y + mid);
    }
    colTitle.setAttribute('x', x0 + span / 2);
    colTitle.setAttribute('y', title - 5);
    if (!rowTitleMeasured) measureRowTitle();
    placeRowTitle();
    if (dragActive) placeFlag(cells[dragK]);
  }

  function relayout() {
    if (!S) return;
    const next = computeLayout(widthPx, S);
    if (next.cell === L.cell && next.head === L.head) return;
    L = next;
    applyGeometry();
  }

  // ------------------------------------------------------------------- bubbles
  function renderBubble(c) {
    const v = c.shown;
    const kind = bubbleKind(v);
    if (kind !== c.kind) {
      c.kind = kind;
      c.bubble.setAttribute('class', KIND_CLASS[kind]);
    }
    const rs = bubbleRadius(v, L.cell).toFixed(2);
    if (rs !== c.rs) {
      c.rs = rs;
      c.bubble.setAttribute('r', rs);
    }
  }

  function labelCell(c) {
    const label = describePair(c.i, c.j, values[c.k]).label;
    if (label !== c.label) {
      c.label = label;
      c.g.setAttribute('aria-label', label);
    }
  }

  function tick(now) {
    rafId = 0;
    if (destroyed) return;
    let running = false;
    for (let n = 0; n < cells.length; n++) {
      const c = cells[n];
      if (!c.tweening) continue;
      const t = clamp((now - c.t0) / TWEEN_MS, 0, 1);
      const e = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out cubic
      const target = values[c.k];
      if (t >= 1) {
        c.shown = target;
        c.tweening = false;
      } else {
        c.shown = c.from + (target - c.from) * e;
        running = true;
      }
      renderBubble(c);
    }
    if (running) rafId = win.requestAnimationFrame(tick);
  }

  /** Ease the bubble from what is on screen now to values[c.k]. */
  function startTween(c) {
    const target = values[c.k];
    if (reduceMotion || typeof win.requestAnimationFrame !== 'function' || c.shown === target) {
      c.tweening = false;
      c.shown = target;
      renderBubble(c);
      return;
    }
    c.from = c.shown;
    c.t0 = win.performance ? win.performance.now() : Date.now();
    c.tweening = true;
    if (!rafId) rafId = win.requestAnimationFrame(tick);
  }

  function snap(c) {
    c.tweening = false;
    c.shown = values[c.k];
    renderBubble(c);
  }

  /** Programmatic or keyboard value change for cell k (already quantised). */
  function setCell(k, v, animate) {
    values[k] = v;
    const c = cells[k];
    if (dragActive && dragK === k) {
      // The owner rewrote the cell under the pointer: continue the drag from there.
      dragRaw = v;
      snap(c);
      setText(flagValue, formatAffinity(v));
    } else if (animate) {
      startTween(c);
    } else {
      snap(c);
    }
    labelCell(c);
    if (activeKind === ACT_CELL && activeIdx === k) updateReadout();
  }

  // --------------------------------------------------------- active pair, readout
  function setLit(on) {
    if (activeKind === ACT_CELL) {
      const c = cells[activeIdx];
      if (!c) return;
      c.g.classList.toggle('is-hover', on);
      rowHeads[c.i].g.classList.toggle('is-lit', on);
      colHeads[c.j].g.classList.toggle('is-lit', on);
    } else if (activeKind === ACT_HEAD) {
      if (rowHeads[activeIdx]) rowHeads[activeIdx].g.classList.toggle('is-lit', on);
      if (colHeads[activeIdx]) colHeads[activeIdx].g.classList.toggle('is-lit', on);
    }
  }

  /** Drag beats pointer, pointer beats keyboard focus. */
  function refreshActive() {
    let kind = ACT_NONE;
    let idx = -1;
    if (dragActive) {
      kind = ACT_CELL;
      idx = dragK;
    } else if (pointerCell >= 0) {
      kind = ACT_CELL;
      idx = pointerCell;
    } else if (pointerHead >= 0) {
      kind = ACT_HEAD;
      idx = pointerHead;
    } else if (hasFocus && S) {
      if (focusR >= 0 && focusC >= 0) {
        kind = ACT_CELL;
        idx = focusR * S + focusC;
      } else {
        kind = ACT_HEAD;
        idx = focusR < 0 ? focusC : focusR;
      }
    }
    if (kind === activeKind && idx === activeIdx) return;
    setLit(false);
    activeKind = kind;
    activeIdx = idx;
    setLit(true);
    updateReadout();
    const hi = kind === ACT_CELL ? cells[idx].i : -1;
    const hj = kind === ACT_CELL ? cells[idx].j : -1;
    if (hi !== hoverI || hj !== hoverJ) {
      hoverI = hi;
      hoverJ = hj;
      fire.hover(hi, hj);
    }
  }

  function updateReadout() {
    if (activeKind === ACT_NONE) {
      readout.classList.add('is-idle');
      cellLine.hidden = true;
      headLine.hidden = true;
      return;
    }
    readout.classList.remove('is-idle');
    if (activeKind === ACT_CELL) {
      const c = cells[activeIdx];
      const v = values[c.k];
      const a = SPECIES[c.i].letter;
      const b = SPECIES[c.j].letter;
      setText(subText, a + b);
      setText(valueText, formatAffinity(v));
      paintInlineMarker(markI, c.i, theme);
      setText(letterI, a);
      setText(verbText, ` ${relationVerb(v)} `);
      paintInlineMarker(markJ, c.j, theme);
      setText(letterJ, b);
      cellLine.hidden = false;
      headLine.hidden = true;
    } else {
      const s = activeIdx;
      paintInlineMarker(markH, s, theme);
      setText(letterH, SPECIES[s].letter);
      const selected = highlight === s;
      headSep.hidden = selected;
      setText(headText, selected
        ? ' is highlighted in panel a \u00B7 select again to clear'
        : 'select to highlight in panel a');
      headLine.hidden = false;
      cellLine.hidden = true;
    }
  }

  // ----------------------------------------------------------------- highlight
  function applyHighlight(s) {
    highlight = s;
    const mark = (hd) => {
      const on = hd.s === s;
      hd.g.classList.toggle('is-selected', on);
      hd.g.setAttribute('aria-selected', on ? 'true' : 'false');
    };
    colHeads.forEach(mark);
    rowHeads.forEach(mark);
    root.classList.toggle('has-selection', s >= 0);
    for (const c of cells) c.g.classList.toggle('in-selection', s >= 0 && (c.i === s || c.j === s));
    if (activeKind === ACT_HEAD) updateReadout();
  }

  function toggleHighlight(s) {
    const next = highlight === s ? -1 : s;
    applyHighlight(next);
    fire.highlight(next);
  }

  // --------------------------------------------------------------- focus model
  function elementAt(r, c) {
    if (r >= 0 && c >= 0) return cells[r * S + c] ? cells[r * S + c].g : null;
    if (r < 0 && c >= 0) return colHeads[c] ? colHeads[c].g : null;
    if (c < 0 && r >= 0) return rowHeads[r] ? rowHeads[r].g : null;
    return null;
  }

  /** [row, col] of a cell or header element (-1 = header row/column), or null. */
  function positionOf(target) {
    if (!target || typeof target.closest !== 'function') return null;
    const cellEl = target.closest('.tm-cell');
    if (cellEl && svg.contains(cellEl)) {
      const k = +cellEl.getAttribute('data-k');
      return [Math.floor(k / S), k % S];
    }
    const headEl = target.closest('.tm-head');
    if (headEl && svg.contains(headEl)) {
      const s = +headEl.getAttribute('data-s');
      return headEl.getAttribute('data-axis') === 'col' ? [-1, s] : [s, -1];
    }
    return null;
  }

  function updateRoving() {
    const el = elementAt(focusR, focusC);
    if (el === rovingEl) return;
    if (rovingEl) rovingEl.setAttribute('tabindex', '-1');
    if (el) el.setAttribute('tabindex', '0');
    rovingEl = el;
  }

  function moveFocus(r, c, preventScroll) {
    focusR = r;
    focusC = c;
    updateRoving();
    if (rovingEl) rovingEl.focus({ preventScroll: !!preventScroll });
  }

  function onFocusIn(e) {
    const pos = positionOf(e.target);
    if (!pos) return;
    focusR = pos[0];
    focusC = pos[1];
    updateRoving();
    hasFocus = true;
    refreshActive();
  }

  function onFocusOut(e) {
    if (e.relatedTarget && svg.contains(e.relatedTarget)) return;
    hasFocus = false;
    refreshActive();
  }

  // ------------------------------------------------------------------ keyboard
  function keyboardEdit(k, edit) {
    const c = cells[k];
    const before = values[k];
    const after = edit.set !== undefined ? quantizeAffinity(edit.set) : quantizeAffinity(before + edit.delta);
    if (after === before) return;
    setCell(k, after, true);
    fire.change(c.i, c.j, after);
    fire.commit(c.i, c.j, before, after);
  }

  function onKeyDown(e) {
    if (dragActive) {
      if (e.key === 'Escape') {
        e.preventDefault();
        revertDrag();
      }
      return;
    }
    if (e.altKey || e.metaKey || !S) return;
    const pos = positionOf(e.target);
    if (!pos) return;
    const r = pos[0];
    const c = pos[1];
    let nr = r;
    let nc = c;
    let nav = true;
    switch (e.key) {
      case 'ArrowRight': nc = Math.min(S - 1, c + 1); break;
      case 'ArrowLeft': nc = Math.max(r < 0 ? 0 : -1, c - 1); break;
      case 'ArrowDown': nr = Math.min(S - 1, r + 1); break;
      case 'ArrowUp': nr = Math.max(c < 0 ? 0 : -1, r - 1); break;
      case 'Home': if (e.ctrlKey) { nr = 0; nc = 0; } else nc = 0; break;
      case 'End': if (e.ctrlKey) { nr = S - 1; nc = S - 1; } else nc = S - 1; break;
      default: nav = false;
    }
    if (nav) {
      e.preventDefault();
      if (nr !== r || nc !== c) moveFocus(nr, nc, false);
      return;
    }
    if (e.ctrlKey) return;
    if (r >= 0 && c >= 0) {
      const edit = keyEdit(e.key, e.shiftKey);
      if (edit) {
        e.preventDefault();
        keyboardEdit(r * S + c, edit);
      }
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (!e.repeat) toggleHighlight(r < 0 ? c : r);
    }
  }

  // ------------------------------------------------------------------- pointer
  function setPointerTarget(cell, head) {
    if (cell === pointerCell && head === pointerHead) return;
    pointerCell = cell;
    pointerHead = head;
    refreshActive();
  }

  function pointerTargetFrom(target) {
    const pos = positionOf(target);
    if (!pos) return setPointerTarget(-1, -1);
    if (pos[0] >= 0 && pos[1] >= 0) return setPointerTarget(pos[0] * S + pos[1], -1);
    return setPointerTarget(-1, pos[0] < 0 ? pos[1] : pos[0]);
  }

  function onPointerOver(e) {
    if (!dragActive) pointerTargetFrom(e.target);
  }

  function onPointerLeave() {
    if (!dragActive) setPointerTarget(-1, -1);
  }

  function placeFlag(c) {
    const { cell, x0, y0, width } = L;
    const cx = x0 + c.j * cell + (cell + 1) / 2;
    const fx = clamp(Math.round(cx - FLAG_W / 2), 0, Math.max(0, width - FLAG_W));
    const fy = Math.max(0, Math.round(y0 + c.i * cell - FLAG_GAP - FLAG_H - (dragTouch ? TOUCH_LIFT : 0)));
    flag.setAttribute('transform', `translate(${fx} ${fy})`);
  }

  function onPointerDown(e) {
    if (dragActive || touchPending || e.isPrimary === false) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pos = positionOf(e.target);
    if (!pos || pos[0] < 0 || pos[1] < 0) return; // headers act on click
    const k = pos[0] * S + pos[1];
    if (e.pointerType === 'touch') {
      touchPending = { k, id: e.pointerId, x0: e.clientX, y0: e.clientY };
      return;
    }
    e.preventDefault(); // no text selection; focus is moved explicitly below
    beginDrag(k, e);
  }

  function beginDrag(k, e) {
    const c = cells[k];
    if (!c) return;
    moveFocus(c.i, c.j, true);
    snap(c);
    dragActive = true;
    dragK = k;
    dragId = e.pointerId;
    dragBefore = values[k];
    dragRaw = values[k];
    dragLastY = e.clientY;
    dragLastX = e.clientX;
    dragTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    try {
      svg.setPointerCapture(e.pointerId);
    } catch (_) {
      // capture can fail for a pointer that is already gone; the drag still ends on pointerup
    }
    root.classList.add('is-dragging');
    c.g.classList.add('is-drag');
    setText(flagValue, formatAffinity(values[k]));
    placeFlag(c);
    flag.classList.add('is-on');
    live.setAttribute('aria-busy', 'true');
    pointerCell = k;
    pointerHead = -1;
    refreshActive();
  }

  function applyDragValue(q) {
    const c = cells[dragK];
    values[dragK] = q;
    snap(c);
    labelCell(c);
    setText(flagValue, formatAffinity(q));
    updateReadout();
    fire.change(c.i, c.j, q);
  }

  function onPointerMove(e) {
    if (touchPending && e.pointerId === touchPending.id) {
      const dx = e.clientX - touchPending.x0;
      const dy = e.clientY - touchPending.y0;
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        const k = touchPending.k;
        touchPending = null;
        beginDrag(k, e);
      } else if (Math.abs(dy) > 10) {
        touchPending = null; // a scroll; the browser owns it
      }
      return;
    }
    if (!dragActive || e.pointerId !== dragId) return;
    // Up or right attracts more; down or left repels. Touch edits sideways only,
    // because vertical touch movement scrolls the page.
    const up = dragTouch && e.pointerType === 'touch' ? 0 : dragLastY - e.clientY;
    const right = e.clientX - dragLastX;
    dragLastY = e.clientY;
    dragLastX = e.clientX;
    const dy = up + right;
    if (dy === 0) return;
    dragRaw = dragAffinity(dragRaw, dy, e.shiftKey);
    const q = quantizeAffinity(dragRaw);
    if (q !== values[dragK]) applyDragValue(q);
  }

  function endDrag(commit) {
    if (!dragActive) return;
    dragActive = false;
    const c = cells[dragK];
    const before = dragBefore;
    const after = values[dragK];
    try {
      if (svg.hasPointerCapture && svg.hasPointerCapture(dragId)) svg.releasePointerCapture(dragId);
    } catch (_) {
      // already released by the browser
    }
    root.classList.remove('is-dragging');
    flag.classList.remove('is-on');
    live.removeAttribute('aria-busy');
    if (c) {
      c.g.classList.remove('is-drag');
      if (commit && after !== before) fire.commit(c.i, c.j, before, after);
    }
  }

  function revertDrag() {
    if (values[dragK] !== dragBefore) applyDragValue(dragBefore);
    endDrag(false);
    refreshActive();
  }

  function onPointerUp(e) {
    if (touchPending && e.pointerId === touchPending.id) {
      // A tap: select the cell so its readout and force curve show.
      const c = cells[touchPending.k];
      touchPending = null;
      if (c) {
        moveFocus(c.i, c.j, true);
        refreshActive();
      }
      return;
    }
    if (!dragActive || e.pointerId !== dragId) return;
    endDrag(true);
    // A mouse or pen stays where it was released; a finger lifts away.
    if (e.pointerType !== 'touch' && typeof doc.elementFromPoint === 'function') {
      pointerTargetFrom(doc.elementFromPoint(e.clientX, e.clientY));
    } else {
      pointerCell = -1;
      pointerHead = -1;
    }
    refreshActive();
  }

  function onPointerCancel(e) {
    if (touchPending && e.pointerId === touchPending.id) {
      touchPending = null;
      return;
    }
    if (!dragActive || e.pointerId !== dragId) return;
    endDrag(true); // the world already runs on the dragged value; keep history in step
    pointerCell = -1;
    pointerHead = -1;
    refreshActive();
  }

  function onClick(e) {
    const pos = positionOf(e.target);
    if (!pos || (pos[0] >= 0 && pos[1] >= 0)) return;
    toggleHighlight(pos[0] < 0 ? pos[1] : pos[0]);
  }

  // ------------------------------------------------------- environment changes
  function onMotionChange(e) {
    reduceMotion = !!e.matches;
    if (reduceMotion) for (const c of cells) if (c.tweening) snap(c);
  }

  function onFontsChanged() {
    if (destroyed || !S) return;
    measureRowTitle();
    placeRowTitle();
  }

  /** A new container width: re-grid if the cells change, and measure the row title if it never could be. */
  function onWidth(w) {
    if (!(w > 0)) return; // hidden: keep the last layout
    if (w !== widthPx) {
      widthPx = w;
      relayout();
    }
    // Shown for the first time after being created hidden: the title has a length now.
    if (!rowTitleMeasured && S) {
      measureRowTitle();
      placeRowTitle();
    }
  }

  function onWindowResize() {
    onWidth(container.clientWidth);
  }

  svg.addEventListener('pointerover', onPointerOver);
  svg.addEventListener('pointerleave', onPointerLeave);
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerCancel);
  svg.addEventListener('lostpointercapture', onPointerCancel);
  svg.addEventListener('click', onClick);
  svg.addEventListener('keydown', onKeyDown);
  svg.addEventListener('focusin', onFocusIn);
  svg.addEventListener('focusout', onFocusOut);

  if (motionQuery && typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', onMotionChange);
  }
  const fonts = doc.fonts;
  if (fonts && typeof fonts.addEventListener === 'function') {
    fonts.addEventListener('loadingdone', onFontsChanged);
    if (fonts.ready && typeof fonts.ready.then === 'function') fonts.ready.then(onFontsChanged, noop);
  }

  let resizeObserver = null;
  if (typeof win.ResizeObserver === 'function') {
    resizeObserver = new win.ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const box = entry.contentBoxSize && entry.contentBoxSize[0];
      onWidth(box ? box.inlineSize : entry.contentRect.width);
    });
    resizeObserver.observe(probe);
  } else if (typeof win.addEventListener === 'function') {
    win.addEventListener('resize', onWindowResize);
  }

  // ------------------------------------------------------------------- public
  function set(nextS, matrix) {
    if (destroyed) return;
    const s = clamp(Math.round(Number(nextS)) || 1, 1, SPECIES.length);
    const src = matrix || [];
    if (s !== S) {
      const oldS = S;
      const restoreFocus = hasFocus || (doc.activeElement && svg.contains(doc.activeElement));
      for (let k = 0; k < cells.length; k++) carry[k] = cells[k].shown;
      if (dragActive) endDrag(false); // the table was replaced under the pointer
      S = s;
      L = computeLayout(widthPx, S);
      build();
      applyGeometry();
      for (let i = 0; i < S; i++) {
        for (let j = 0; j < S; j++) {
          const c = cells[i * S + j];
          values[c.k] = quantizeAffinity(Number(src[c.k]) || 0);
          labelCell(c);
          if (oldS === 0) {
            snap(c);
          } else {
            // Kept entries ease from where they were; new rows and columns grow in.
            c.shown = i < oldS && j < oldS ? carry[i * oldS + j] : 0;
            renderBubble(c);
            startTween(c);
          }
        }
      }
      applyHighlight(highlight < S ? highlight : -1);
      if (restoreFocus) moveFocus(focusR, focusC, true);
      refreshActive();
      return;
    }
    for (let k = 0; k < S * S; k++) {
      const v = quantizeAffinity(Number(src[k]) || 0);
      if (v !== values[k]) setCell(k, v, true);
    }
  }

  function setValue(i, j, value) {
    if (destroyed || !(i >= 0 && i < S && j >= 0 && j < S)) return;
    const k = (i | 0) * S + (j | 0);
    const v = quantizeAffinity(Number(value) || 0);
    if (v !== values[k]) setCell(k, v, true);
  }

  function refreshTheme() {
    if (destroyed) return;
    theme = currentTheme();
    for (const hd of colHeads) hd.mark.setAttribute('fill', SPECIES[hd.s][theme]);
    for (const hd of rowHeads) hd.mark.setAttribute('fill', SPECIES[hd.s][theme]);
    for (const m of [markI, markJ, markH]) if (m.s >= 0) paintInlineMarker(m, m.s, theme);
  }

  function focusCell(i, j) {
    if (destroyed || !S) return;
    moveFocus(clamp(i | 0, 0, S - 1), clamp(j | 0, 0, S - 1), false);
  }

  /** Mirror a highlight set elsewhere; fires nothing. */
  function setHighlight(s) {
    if (destroyed) return;
    const next = Number.isInteger(s) && s >= 0 && s < S ? s : -1;
    if (next !== highlight) applyHighlight(next);
  }

  function destroy() {
    if (destroyed) return;
    if (dragActive) endDrag(false);
    destroyed = true;
    if (rafId) win.cancelAnimationFrame(rafId);
    rafId = 0;
    if (resizeObserver) resizeObserver.disconnect();
    else if (typeof win.removeEventListener === 'function') win.removeEventListener('resize', onWindowResize);
    if (motionQuery && typeof motionQuery.removeEventListener === 'function') {
      motionQuery.removeEventListener('change', onMotionChange);
    }
    if (fonts && typeof fonts.removeEventListener === 'function') fonts.removeEventListener('loadingdone', onFontsChanged);
    root.remove();
    cells = [];
    colHeads = [];
    rowHeads = [];
    rows = [];
  }

  return { set, setValue, refreshTheme, focusCell, setHighlight, destroy };
}
