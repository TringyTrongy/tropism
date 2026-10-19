// Tests for src/matrix.js (panel b).
//
//   node --test tests/matrix.test.mjs
//
// Part 1 covers the pure helpers (formatting, drag mapping, keyboard mapping,
// layout, bubble geometry). Part 2 drives the real component through a small
// in-file DOM stand-in (no dependencies), exercising keyboard editing, pointer
// drags, Escape revert, header highlight, tweening and rebuilds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

// When src/genome.js is not available, stand in a copy of quantizeAffinity so
// this module can be tested on its own.
const genomePath = fileURLToPath(new URL('../src/genome.js', import.meta.url));
const usingGenomeStub = !existsSync(genomePath);
if (usingGenomeStub) {
  const stub = `
    export function quantizeAffinity(v) {
      const c = Math.min(1, Math.max(-1, Number(v) || 0));
      const q = Math.round(c * 20) / 20;
      return +q.toFixed(2) + 0;
    }`;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './genome.js' && context.parentURL && context.parentURL.endsWith('/src/matrix.js')) {
        return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

// Importing must not touch the DOM: no globals are installed yet.
const { createMatrix, matrixHelpers: H } = await import('../src/matrix.js');
const { quantizeAffinity } = await import(usingGenomeStub ? 'data:text/javascript,' + encodeURIComponent(
  'export function quantizeAffinity(v){const c=Math.min(1,Math.max(-1,Number(v)||0));return +(Math.round(c*20)/20).toFixed(2)+0;}',
) : '../src/genome.js');

const MINUS = '\u2212';

// ============================================================================
// Part 1: pure helpers
// ============================================================================

test('formatAffinity: explicit sign, true minus, two decimals, no negative zero', () => {
  assert.equal(H.formatAffinity(0.45), '+0.45');
  assert.equal(H.formatAffinity(-0.45), MINUS + '0.45');
  assert.equal(H.formatAffinity(1), '+1.00');
  assert.equal(H.formatAffinity(-1), MINUS + '1.00');
  assert.equal(H.formatAffinity(0.05), '+0.05');
  assert.equal(H.formatAffinity(0), '0.00');
  assert.equal(H.formatAffinity(-0), '0.00');
  assert.equal(H.formatAffinity(-0.001), '0.00');
  assert.equal(H.formatAffinity(NaN), '0.00');
  assert.ok(!H.formatAffinity(-0.3).includes('-'), 'hyphen-minus must never be displayed');
});

test('describePair: species letters, verb by sign, aria label', () => {
  assert.deepEqual(H.describePair(1, 3, 0.45), {
    sub: 'BD', value: '+0.45', phrase: 'B is drawn to D', label: 'B toward D, +0.45',
  });
  assert.equal(H.describePair(1, 3, -0.2).phrase, 'B is pushed from D');
  assert.equal(H.describePair(1, 3, -0.2).label, `B toward D, ${MINUS}0.20`);
  assert.equal(H.describePair(1, 3, 0).phrase, 'B ignores D');
  assert.equal(H.describePair(0, 0, 0.3).phrase, 'A is drawn to A');
  assert.equal(H.describePair(7, 6, 1).sub, 'HG');
  assert.equal(H.relationVerb(NaN), 'ignores');
});

test('dragAffinity: 0.05 per 6px, Shift 0.05 per 18px, up is attraction', () => {
  const q = (raw) => quantizeAffinity(raw);
  assert.equal(q(H.dragAffinity(0, 6, false)), 0.05);
  assert.equal(q(H.dragAffinity(0, -6, false)), -0.05);
  assert.equal(q(H.dragAffinity(0, 60, false)), 0.5);
  assert.equal(q(H.dragAffinity(0, 18, true)), 0.05);
  assert.equal(q(H.dragAffinity(0, 6, true)), 0, 'fine drag needs three times the travel');
  // Rounding: the first step lands at half a step of travel.
  assert.equal(q(H.dragAffinity(0, 2.9, false)), 0);
  assert.equal(q(H.dragAffinity(0, 3.1, false)), 0.05);
});

test('dragAffinity: clamps at the ends so reversing responds at once', () => {
  let raw = 0.9;
  raw = H.dragAffinity(raw, 300, false); // far past +1
  assert.equal(raw, 1);
  raw = H.dragAffinity(raw, -6, false);
  assert.equal(quantizeAffinity(raw), 0.95);
  raw = H.dragAffinity(-0.95, -600, true);
  assert.equal(raw, -1);
});

test('dragAffinity: a long drag in many small moves equals one move of the same length', () => {
  let raw = 0.2;
  for (let n = 0; n < 40; n++) raw = H.dragAffinity(raw, 1.5, false); // 60px in 1.5px moves
  assert.equal(quantizeAffinity(raw), quantizeAffinity(H.dragAffinity(0.2, 60, false)));
  assert.equal(quantizeAffinity(raw), 0.7);
});

test('keyEdit: raise / lower / zero keys and the Shift step', () => {
  assert.deepEqual(H.keyEdit('=', false), { delta: 0.05 });
  assert.deepEqual(H.keyEdit('+', false), { delta: 0.05 }); // layouts where + is unshifted
  assert.deepEqual(H.keyEdit('+', true), { delta: 0.25 });
  assert.deepEqual(H.keyEdit('PageUp', false), { delta: 0.05 });
  assert.deepEqual(H.keyEdit('PageUp', true), { delta: 0.25 });
  assert.deepEqual(H.keyEdit('-', false), { delta: -0.05 });
  assert.deepEqual(H.keyEdit('_', true), { delta: -0.25 });
  assert.deepEqual(H.keyEdit('PageDown', true), { delta: -0.25 });
  assert.deepEqual(H.keyEdit('0', false), { set: 0 });
  assert.deepEqual(H.keyEdit('Delete', false), { set: 0 });
  assert.deepEqual(H.keyEdit('Backspace', true), { set: 0 });
  assert.equal(H.keyEdit('ArrowUp', false), null);
  assert.equal(H.keyEdit('a', false), null);
});

test('computeLayout: integer cells within 22..56px, half-pixel hairlines, fits the container', () => {
  for (const width of [200, 240, 300, 360, 420, 480, 640, 1000]) {
    for (let S = 2; S <= 8; S++) {
      const L = H.computeLayout(width, S);
      assert.ok(Number.isInteger(L.cell) && L.cell >= 22 && L.cell <= 56, `cell ${L.cell} at ${width}/${S}`);
      assert.ok(Number.isInteger(L.x0) && Number.isInteger(L.y0), 'grid origin on whole pixels');
      assert.equal(L.x0, L.title + L.head);
      assert.equal(L.width, L.x0 + S * L.cell + 1);
      assert.equal(L.height, L.y0 + S * L.cell + 1);
      assert.ok(L.head >= 34 && L.head <= 44);
      if (L.cell > 22) assert.ok(L.width <= width, `overflow: ${L.width} > ${width} at S=${S}`);
      // Every grid line x0 + k*cell + 0.5 is a half pixel.
      for (let k = 0; k <= S; k++) assert.equal((L.x0 + k * L.cell + 0.5) % 1, 0.5);
    }
  }
});

test('computeLayout: headers track 1.4 cells in the small range, cells use the room', () => {
  const small = H.computeLayout(240, 8);
  assert.equal(small.cell, 23);
  assert.equal(small.head, 34);
  const mid = H.computeLayout(360, 6);
  assert.equal(mid.head, 44);
  assert.ok(mid.cell >= 48);
  const capped = H.computeLayout(480, 2);
  assert.equal(capped.cell, 56, 'two species at 480px hit the 56px ceiling');
  const tooNarrow = H.computeLayout(150, 8);
  assert.equal(tooNarrow.cell, 22, 'never below the floor');
});

test('bubbleRadius: area proportional to |a|, ring drawn inside, zero is a 2px dot', () => {
  const cell = 40;
  const r1 = H.bubbleRadius(1, cell);
  assert.ok(Math.abs(r1 - 0.46 * cell) < 1e-9);
  const rq = H.bubbleRadius(0.25, cell);
  assert.ok(Math.abs((rq * rq) / (r1 * r1) - 0.25) < 1e-9, 'area ratio equals value ratio');
  assert.ok(Math.abs(H.bubbleRadius(-1, cell) - (0.46 * cell - 0.75)) < 1e-9);
  assert.equal(H.bubbleRadius(-0.05, 22), 2, 'smallest ring stays open');
  assert.equal(H.bubbleRadius(0, cell), 1);
  assert.equal(H.bubbleKind(0.3), H.KIND_POS);
  assert.equal(H.bubbleKind(-0.3), H.KIND_NEG);
  assert.equal(H.bubbleKind(0), H.KIND_ZERO);
  assert.ok(H.bubbleRadius(1, 22) < (22 - 1) / 2, 'a full bubble never touches the hairlines');
});

// ============================================================================
// Part 2: the component, through a minimal DOM stand-in
// ============================================================================

class FakeText {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

class FakeClassList {
  constructor(el) { this.el = el; }
  _get() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _set(list) { this.el.setAttribute('class', list.join(' ')); }
  contains(c) { return this._get().includes(c); }
  add(...cs) { const l = this._get(); for (const c of cs) if (!l.includes(c)) l.push(c); this._set(l); }
  remove(...cs) { this._set(this._get().filter((c) => !cs.includes(c))); }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : !!force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

class FakeElement {
  constructor(doc, tag, ns) {
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.tagName = tag;
    this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.captured = new Set();
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  /** Text as assistive tech would read it: skips [hidden] subtrees. */
  get visibleText() { return this.childNodes.map((n) => (n.nodeType === 3 ? n.data : n.hidden ? '' : n.visibleText)).join(''); }
  set textContent(v) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = [new FakeText(v)]; this.childNodes[0].parentNode = this; }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n) { this.childNodes = this.childNodes.filter((c) => c !== n); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
  closest(sel) {
    if (!/^\.[\w-]+$/.test(sel)) throw new Error('fake closest supports .class only');
    const c = sel.slice(1);
    for (let p = this; p && p.nodeType === 1; p = p.parentNode) if (p.classList.contains(c)) return p;
    return null;
  }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { const l = this.listeners.get(type); if (l) this.listeners.set(type, l.filter((f) => f !== fn)); }
  focus() { this.ownerDocument._focus(this); }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  querySelectorAll(sel) {
    const c = sel.slice(1);
    const out = [];
    const walk = (n) => { for (const ch of n.childNodes) if (ch.nodeType === 1) { if (ch.classList.contains(c)) out.push(ch); walk(ch); } };
    walk(this);
    return out;
  }
}

function dispatch(target, type, props = {}, bubbles = true) {
  const ev = {
    type, target, defaultPrevented: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    repeat: false, isPrimary: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0,
    relatedTarget: null, ...props,
    preventDefault() { this.defaultPrevented = true; },
  };
  for (let n = target; n; n = bubbles ? n.parentNode : null) {
    const l = n.listeners && n.listeners.get(type);
    if (l) for (const fn of l.slice()) fn(ev);
    if (!bubbles) break;
  }
  return ev;
}

function makeDom() {
  const rafQueue = [];
  let now = 0;
  const observers = [];
  const win = {
    matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => { rafQueue.length = 0; },
    performance: { now: () => now },
    ResizeObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe(el) { this.el = el; }
      disconnect() { this.el = null; }
    },
  };
  const doc = {
    defaultView: win,
    activeElement: null,
    elementFromPointResult: null,
    createElement(tag) { return new FakeElement(doc, tag); },
    createElementNS(ns, tag) { return new FakeElement(doc, tag, ns); },
    createTextNode(t) { return new FakeText(t); },
    getElementById(id) {
      const walk = (n) => {
        for (const ch of n.childNodes) if (ch.nodeType === 1) { if (ch.id === id) return ch; const f = walk(ch); if (f) return f; }
        return null;
      };
      return walk(doc.documentElement);
    },
    elementFromPoint() { return doc.elementFromPointResult; },
    _focus(el) {
      const old = doc.activeElement;
      if (old === el) return;
      if (old) dispatch(old, 'focusout', { relatedTarget: el });
      doc.activeElement = el;
      dispatch(el, 'focusin', { relatedTarget: old });
    },
  };
  doc.documentElement = new FakeElement(doc, 'html');
  doc.head = doc.documentElement.appendChild(new FakeElement(doc, 'head'));
  doc.body = doc.documentElement.appendChild(new FakeElement(doc, 'body'));
  globalThis.document = doc;
  globalThis.window = win;
  return {
    doc,
    win,
    observers,
    flushFrames(ms = 16, frames = 20) {
      for (let f = 0; f < frames && rafQueue.length; f++) {
        now += ms;
        const batch = rafQueue.splice(0);
        for (const fn of batch) fn(now);
      }
    },
    resize(width) {
      for (const o of observers) if (o.el) o.cb([{ contentRect: { width }, contentBoxSize: [{ inlineSize: width }] }]);
    },
  };
}

function setup(S = 3, matrix = null, width = 360) {
  const dom = makeDom();
  const container = dom.doc.body.appendChild(new FakeElement(dom.doc, 'div'));
  container.clientWidth = width;
  const log = [];
  const api = createMatrix(container, {
    onHover: (i, j) => log.push(['hover', i, j]),
    onChange: (i, j, v) => log.push(['change', i, j, v]),
    onCommit: (i, j, b, a) => log.push(['commit', i, j, b, a]),
    onHighlight: (s) => log.push(['highlight', s]),
  });
  const m = matrix || Array.from({ length: S * S }, (_, k) => [0.45, -0.3, 0, 0.1, 1, -1, 0.25, 0, -0.05][k % 9]);
  api.set(S, m);
  const svg = container.querySelectorAll('.tm-svg')[0];
  const cell = (i, j) => svg.querySelectorAll('.tm-cell').find((g) => +g.getAttribute('data-k') === i * S + j);
  const head = (axis, s) => svg.querySelectorAll('.tm-head').find((g) => g.getAttribute('data-axis') === axis && +g.getAttribute('data-s') === s);
  const hit = (g) => g.childNodes.find((n) => n.classList && n.classList.contains('tm-hit'));
  const bubble = (g) => g.childNodes.find((n) => n.tagName === 'circle');
  const live = container.querySelectorAll('.tm-live')[0];
  const readout = container.querySelectorAll('.tm-readout')[0];
  const flag = svg.querySelectorAll('.tm-flag')[0];
  return { dom, container, api, log, svg, cell, head, hit, bubble, live, readout, flag, S };
}

test('component: builds an ARIA grid with roving tabindex, labels and the encoding', () => {
  const t = setup(3);
  const cells = t.svg.querySelectorAll('.tm-cell');
  assert.equal(cells.length, 9);
  assert.equal(t.svg.querySelectorAll('.tm-head').length, 6);
  const grid = t.svg.childNodes.find((n) => n.getAttribute('role') === 'grid');
  assert.ok(grid.getAttribute('aria-label').includes('3 species'));
  assert.ok(t.dom.doc.getElementById(grid.getAttribute('aria-describedby')), 'help text exists');
  const focusable = t.svg.querySelectorAll('.tm-cell').concat(t.svg.querySelectorAll('.tm-head'))
    .filter((g) => g.getAttribute('tabindex') === '0');
  assert.equal(focusable.length, 1, 'exactly one tab stop');
  assert.equal(focusable[0], t.cell(0, 0));
  assert.equal(t.cell(0, 0).getAttribute('aria-label'), 'A toward A, +0.45');
  assert.equal(t.cell(0, 1).getAttribute('aria-label'), `A toward B, ${MINUS}0.30`);
  assert.equal(t.bubble(t.cell(0, 0)).getAttribute('class'), 'tm-bubble tm-pos');
  assert.equal(t.bubble(t.cell(0, 1)).getAttribute('class'), 'tm-bubble tm-neg');
  assert.equal(t.bubble(t.cell(0, 2)).getAttribute('class'), 'tm-bubble tm-zero');
  assert.equal(t.bubble(t.cell(0, 2)).getAttribute('r'), '1.00');
  const L = H.computeLayout(360, 3);
  assert.equal(t.svg.getAttribute('width'), String(L.width));
  assert.equal(t.bubble(t.cell(1, 1)).getAttribute('r'), (0.46 * L.cell).toFixed(2), 'a = +1 fills 0.46 cell');
  assert.ok(t.readout.classList.contains('is-idle'), 'idle readout shows the key');
  assert.equal(t.dom.doc.head.childNodes.filter((n) => n.id === 'tm-style').length, 1);
  // Header markers carry the species colour (data); nothing else gets a fill attribute colour.
  const mark = t.head('col', 1).childNodes.find((n) => n.classList.contains('tm-mark'));
  assert.equal(mark.getAttribute('fill'), '#E69F00');
});

test('component: hover reports the pair and writes the readout line', () => {
  const t = setup(4);
  dispatch(t.hit(t.cell(1, 3)), 'pointerover');
  assert.deepEqual(t.log.at(-1), ['hover', 1, 3]);
  assert.ok(!t.readout.classList.contains('is-idle'));
  assert.equal(t.live.getAttribute('aria-live'), 'polite');
  const v = [0.45, -0.3, 0, 0.1, 1, -1, 0.25, 0, -0.05][7 % 9]; // k = 1*4+3 = 7 -> 0
  assert.equal(v, 0);
  assert.match(t.live.visibleText, /^aBD = 0\.00/);
  assert.ok(t.live.visibleText.endsWith('B ignores D'), t.live.visibleText);
  assert.ok(t.cell(1, 3).classList.contains('is-hover'));
  assert.ok(t.head('row', 1).classList.contains('is-lit'));
  assert.ok(t.head('col', 3).classList.contains('is-lit'));
  dispatch(t.hit(t.cell(1, 1)), 'pointerover'); // k = 5 -> -1
  assert.ok(t.live.visibleText.includes(`${MINUS}1.00`));
  assert.ok(t.live.visibleText.endsWith('B is pushed from B'));
  assert.ok(!t.cell(1, 3).classList.contains('is-hover'));
  dispatch(t.svg, 'pointerleave', {}, false);
  assert.deepEqual(t.log.at(-1), ['hover', -1, -1]);
  assert.ok(t.readout.classList.contains('is-idle'));
});

test('component: keyboard edits fire onChange then onCommit, quantised, clamped', () => {
  const t = setup(3);
  t.api.focusCell(0, 0);
  assert.equal(t.dom.doc.activeElement, t.cell(0, 0));
  assert.deepEqual(t.log.at(-1), ['hover', 0, 0], 'focus reports the pair');
  t.log.length = 0;
  dispatch(t.cell(0, 0), 'keydown', { key: '=' });
  assert.deepEqual(t.log, [['change', 0, 0, 0.5], ['commit', 0, 0, 0.45, 0.5]]);
  t.log.length = 0;
  dispatch(t.cell(0, 0), 'keydown', { key: '+', shiftKey: true });
  assert.deepEqual(t.log, [['change', 0, 0, 0.75], ['commit', 0, 0, 0.5, 0.75]]);
  t.log.length = 0;
  dispatch(t.cell(0, 0), 'keydown', { key: 'PageUp', shiftKey: true });
  dispatch(t.cell(0, 0), 'keydown', { key: 'PageUp' }); // already at +1: no event
  assert.deepEqual(t.log, [['change', 0, 0, 1], ['commit', 0, 0, 0.75, 1]]);
  t.log.length = 0;
  dispatch(t.cell(0, 0), 'keydown', { key: '0' });
  assert.deepEqual(t.log, [['change', 0, 0, 0], ['commit', 0, 0, 1, 0]]);
  t.log.length = 0;
  dispatch(t.cell(0, 0), 'keydown', { key: '-' });
  dispatch(t.cell(0, 0), 'keydown', { key: 'Delete' });
  assert.deepEqual(t.log, [['change', 0, 0, -0.05], ['commit', 0, 0, 0, -0.05], ['change', 0, 0, 0], ['commit', 0, 0, -0.05, 0]]);
  assert.equal(t.cell(0, 0).getAttribute('aria-label'), 'A toward A, 0.00');
  const ev = dispatch(t.cell(0, 0), 'keydown', { key: 'z', ctrlKey: true });
  assert.equal(ev.defaultPrevented, false, 'application shortcuts pass through');
});

test('component: arrow keys move the roving focus through cells and headers', () => {
  const t = setup(3);
  t.api.focusCell(0, 0);
  dispatch(t.cell(0, 0), 'keydown', { key: 'ArrowRight' });
  assert.equal(t.dom.doc.activeElement, t.cell(0, 1));
  assert.equal(t.cell(0, 1).getAttribute('tabindex'), '0');
  assert.equal(t.cell(0, 0).getAttribute('tabindex'), '-1');
  assert.deepEqual(t.log.at(-1), ['hover', 0, 1]);
  dispatch(t.cell(0, 1), 'keydown', { key: 'ArrowUp' });
  assert.equal(t.dom.doc.activeElement, t.head('col', 1));
  assert.deepEqual(t.log.at(-1), ['hover', -1, -1], 'headers are not pairs');
  assert.ok(t.live.visibleText.includes('select to highlight in panel a'));
  dispatch(t.head('col', 1), 'keydown', { key: 'ArrowLeft' });
  dispatch(t.head('col', 0), 'keydown', { key: 'ArrowLeft' }); // the corner is not a stop
  assert.equal(t.dom.doc.activeElement, t.head('col', 0));
  dispatch(t.head('col', 0), 'keydown', { key: 'End', ctrlKey: true });
  assert.equal(t.dom.doc.activeElement, t.cell(2, 2));
  dispatch(t.cell(2, 2), 'keydown', { key: 'Home' });
  assert.equal(t.dom.doc.activeElement, t.cell(2, 0));
  dispatch(t.cell(2, 0), 'keydown', { key: 'ArrowLeft' });
  assert.equal(t.dom.doc.activeElement, t.head('row', 2));
  dispatch(t.head('row', 2), 'keydown', { key: 'Enter' });
  assert.deepEqual(t.log.at(-1), ['highlight', 2]);
  assert.ok(t.live.visibleText.includes('is highlighted in panel a'));
  dispatch(t.head('row', 2), 'keydown', { key: ' ' });
  assert.deepEqual(t.log.at(-1), ['highlight', -1]);
});

test('component: vertical drag edits live, commits once on release', () => {
  const t = setup(3);
  const target = t.hit(t.cell(1, 2)); // k = 5 -> -1
  dispatch(target, 'pointerover');
  t.log.length = 0;
  const down = dispatch(target, 'pointerdown', { clientY: 200 });
  assert.ok(down.defaultPrevented);
  assert.equal(t.dom.doc.activeElement, t.cell(1, 2));
  assert.ok(t.flag.classList.contains('is-on'), 'live value shown beside the cell');
  assert.ok(t.svg.hasPointerCapture(1));
  assert.equal(t.live.getAttribute('aria-busy'), 'true');
  dispatch(t.svg, 'pointermove', { clientY: 194 });
  dispatch(t.svg, 'pointermove', { clientY: 188 });
  dispatch(t.svg, 'pointermove', { clientY: 187 }); // 13px: still two steps
  assert.deepEqual(t.log, [['change', 1, 2, -0.95], ['change', 1, 2, -0.9]]);
  assert.equal(t.flag.textContent, `${MINUS}0.90`);
  dispatch(t.svg, 'pointermove', { clientY: 187 - 18, shiftKey: true }); // fine: one step
  assert.deepEqual(t.log.at(-1), ['change', 1, 2, -0.85]);
  // Pointer drifts over another cell while captured: the pair under edit stays reported.
  dispatch(t.hit(t.cell(0, 0)), 'pointerover');
  t.dom.doc.elementFromPointResult = t.hit(t.cell(1, 2));
  dispatch(t.svg, 'pointerup', { clientY: 169 });
  assert.deepEqual(t.log.at(-1), ['commit', 1, 2, -1, -0.85]);
  assert.equal(t.log.filter((e) => e[0] === 'commit').length, 1);
  assert.equal(t.log.filter((e) => e[0] === 'hover').length, 0, 'no hover churn during the drag');
  assert.ok(!t.flag.classList.contains('is-on'));
  assert.equal(t.live.getAttribute('aria-busy'), null);
  assert.ok(!t.svg.hasPointerCapture(1));
  dispatch(t.svg, 'lostpointercapture', {});
  assert.equal(t.log.filter((e) => e[0] === 'commit').length, 1, 'late capture loss does not recommit');
});

test('component: a press without movement edits nothing; Escape reverts a drag', () => {
  const t = setup(3);
  const target = t.hit(t.cell(0, 1)); // -0.3
  dispatch(target, 'pointerdown', { clientY: 50 });
  dispatch(t.svg, 'pointermove', { clientY: 49 });
  dispatch(t.svg, 'pointerup', { clientY: 49 });
  assert.equal(t.log.filter((e) => e[0] === 'change' || e[0] === 'commit').length, 0);
  t.log.length = 0;
  dispatch(target, 'pointerdown', { clientY: 50 });
  dispatch(t.svg, 'pointermove', { clientY: 26 }); // +0.2
  dispatch(t.cell(0, 1), 'keydown', { key: 'Escape' });
  assert.deepEqual(t.log.filter((e) => e[0] !== 'hover'), [['change', 0, 1, -0.1], ['change', 0, 1, -0.3]]);
  assert.equal(t.cell(0, 1).getAttribute('aria-label'), `A toward B, ${MINUS}0.30`);
  dispatch(t.svg, 'pointerup', { clientY: 26 });
  assert.equal(t.log.filter((e) => e[0] === 'commit').length, 0);
});

test('component: secondary buttons and headers do not start drags; header click toggles highlight', () => {
  const t = setup(3);
  dispatch(t.hit(t.cell(0, 0)), 'pointerdown', { button: 2, clientY: 10 });
  dispatch(t.svg, 'pointermove', { clientY: 0 });
  assert.equal(t.log.filter((e) => e[0] === 'change').length, 0);
  const h = t.hit(t.head('row', 1));
  dispatch(h, 'pointerover');
  assert.ok(t.live.visibleText.includes('select to highlight in panel a'));
  dispatch(h, 'pointerdown', { clientY: 10 });
  dispatch(t.svg, 'pointermove', { clientY: 0 });
  assert.equal(t.log.filter((e) => e[0] === 'change').length, 0);
  dispatch(h, 'click');
  assert.deepEqual(t.log.at(-1), ['highlight', 1]);
  assert.equal(t.head('row', 1).getAttribute('aria-selected'), 'true');
  assert.equal(t.head('col', 1).getAttribute('aria-selected'), 'true');
  assert.ok(t.container.querySelectorAll('.tm-root')[0].classList.contains('has-selection'));
  assert.ok(t.cell(1, 0).classList.contains('in-selection'));
  assert.ok(t.cell(0, 1).classList.contains('in-selection'));
  assert.ok(!t.cell(0, 0).classList.contains('in-selection'));
  dispatch(t.hit(t.head('col', 1)), 'click');
  assert.deepEqual(t.log.at(-1), ['highlight', -1]);
  assert.equal(t.head('row', 1).getAttribute('aria-selected'), 'false');
  t.api.setHighlight(2);
  assert.equal(t.head('col', 2).getAttribute('aria-selected'), 'true');
  assert.deepEqual(t.log.at(-1), ['highlight', -1], 'setHighlight fires nothing');
});

test('component: set() and setValue() tween to quantised values without events', () => {
  const t = setup(3);
  const L = H.computeLayout(360, 3);
  const before = t.log.length;
  t.api.setValue(2, 2, 0.33); // -> 0.35 (was -0.05)
  assert.equal(t.cell(2, 2).getAttribute('aria-label'), 'C toward C, +0.35');
  t.dom.flushFrames(16, 1);
  const mid = t.bubble(t.cell(2, 2));
  assert.equal(mid.getAttribute('class'), 'tm-bubble tm-pos', 'sign flips through zero');
  const midR = +mid.getAttribute('r');
  t.dom.flushFrames(16, 20);
  const end = +t.bubble(t.cell(2, 2)).getAttribute('r');
  assert.ok(midR < end, 'tween grows toward the target');
  assert.equal(end.toFixed(2), H.bubbleRadius(0.35, L.cell).toFixed(2));
  t.api.set(3, Array(9).fill(-0.5));
  t.dom.flushFrames(16, 20);
  for (const g of t.svg.querySelectorAll('.tm-cell')) {
    assert.equal(t.bubble(g).getAttribute('class'), 'tm-bubble tm-neg');
    assert.equal(t.bubble(g).getAttribute('r'), H.bubbleRadius(-0.5, L.cell).toFixed(2));
  }
  assert.equal(t.log.length, before, 'programmatic updates fire no handlers');
  t.api.setValue(9, 9, 1); // out of range: ignored
  t.api.setValue(0, 0, NaN); // garbage -> 0
  assert.equal(t.cell(0, 0).getAttribute('aria-label'), 'A toward A, 0.00');
});

test('component: changing S rebuilds, keeps focus and highlight, then follows resizes', () => {
  const t = setup(3);
  t.api.setHighlight(1);
  t.api.focusCell(2, 1);
  t.api.set(5, Array(25).fill(0.2));
  const cells = t.svg.querySelectorAll('.tm-cell');
  assert.equal(cells.length, 25);
  const focused = t.dom.doc.activeElement;
  assert.equal(+focused.getAttribute('data-k'), 2 * 5 + 1, 'focus restored to the same pair');
  assert.equal(focused.getAttribute('tabindex'), '0');
  const head1 = t.svg.querySelectorAll('.tm-head').find((g) => g.getAttribute('data-axis') === 'col' && g.getAttribute('data-s') === '1');
  assert.equal(head1.getAttribute('aria-selected'), 'true');
  t.dom.flushFrames(16, 20);
  t.dom.resize(240);
  const L = H.computeLayout(240, 5);
  assert.notEqual(L.cell, H.computeLayout(360, 5).cell, 'the resize changes the cell size');
  assert.equal(t.svg.getAttribute('width'), String(L.width));
  assert.equal(t.svg.getAttribute('viewBox'), `0 0 ${L.width} ${L.height}`);
  t.api.set(2, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(t.svg.querySelectorAll('.tm-cell').length, 4);
  assert.equal(t.svg.querySelectorAll('.tm-head').filter((g) => g.getAttribute('aria-selected') === 'true').length, 2);
  t.api.set(2, [0.1, 0.2, 0.3, 0.4]);
  t.api.setHighlight(5); // out of range for S = 2: clears
  assert.equal(t.svg.querySelectorAll('.tm-head').filter((g) => g.getAttribute('aria-selected') === 'true').length, 0);
});

test('component: resizes are observed on a zero-height probe, never on the box its layout changes', () => {
  const t = setup(3);
  const probe = t.container.querySelectorAll('.tm-probe')[0];
  assert.ok(probe, 'the probe exists inside the panel');
  assert.equal(probe.getAttribute('aria-hidden'), 'true');
  const root = t.container.querySelectorAll('.tm-root')[0];
  assert.equal(root.childNodes[0], probe, 'it sits above the table, out of the way');
  // The only observed element is the probe: the SVG's own height changes on
  // relayout and would otherwise trigger a ResizeObserver loop error.
  assert.deepEqual(t.dom.observers.map((o) => o.el), [probe]);
  const style = t.dom.doc.getElementById('tm-style');
  assert.match(style.textContent, /\.tm-probe \{[^}]*height: 0/);
  const before = t.svg.getAttribute('width');
  t.dom.resize(0); // hidden: ignored, the last layout stays
  assert.equal(t.svg.getAttribute('width'), before);
  t.dom.resize(240);
  assert.equal(t.svg.getAttribute('width'), String(H.computeLayout(240, 3).width));
});

test('component: a row title first laid out while hidden is measured once it is shown', () => {
  const t = setup(2);
  const rowTitle = t.svg.querySelectorAll('.tm-title').find((n) => n.textContent.startsWith('row'));
  const placed = () => rowTitle.getAttribute('transform');
  const estimated = placed();             // the fake cannot measure text: the estimate was used
  rowTitle.getComputedTextLength = () => 140;
  t.dom.resize(360);                      // same width as before: no relayout, but a measurement
  assert.notEqual(placed(), estimated, 'the measured length re-centres the title');
  const measured = placed();
  rowTitle.getComputedTextLength = () => 20;
  t.dom.resize(360);
  assert.equal(placed(), measured, 'measured once; fonts loading is what triggers later re-measures');
});

test('component: refreshTheme recolours species markers; destroy removes everything', () => {
  const t = setup(3);
  t.dom.doc.documentElement.setAttribute('data-theme', 'dark');
  t.api.refreshTheme();
  const mark = t.head('row', 0).childNodes.find((n) => n.classList.contains('tm-mark'));
  assert.equal(mark.getAttribute('fill'), '#3AA0E8');
  t.api.destroy();
  assert.equal(t.container.childNodes.length, 0);
  t.api.set(3, Array(9).fill(0)); // no-ops after destroy
  t.api.destroy();
});
