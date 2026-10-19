// Tests for src/scrub.js: the pure value arithmetic, and the control's pointer
// and keyboard behaviour against a minimal fake DOM (Node has no document).
// Run: node --test tests/scrub.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScrub, scrubValue, quantizeValue, nudgeValue, decimalsOf,
} from '../src/scrub.js';

const N = { min: 500, max: 12000, step: 100 };
const UNIT = { min: 0, max: 1, step: 0.1 };
const AFFINITY = { min: -1, max: 1, step: 0.05 };
const HALF_LIFE = { min: 0.005, max: 0.2, step: 0.001, log: true };

// ---------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------

describe('decimalsOf', () => {
  test('counts decimals in plain and exponent notation', () => {
    assert.equal(decimalsOf(1), 0);
    assert.equal(decimalsOf(100), 0);
    assert.equal(decimalsOf(0.05), 2);
    assert.equal(decimalsOf(-0.125), 3);
    assert.equal(decimalsOf(0.001), 3);
    assert.equal(decimalsOf(1e-7), 7);
    assert.equal(decimalsOf(2.5e-7), 8);
    assert.equal(decimalsOf(1e21), 0);
    assert.equal(decimalsOf(NaN), 0);
  });
});

describe('quantizeValue', () => {
  test('returns clean floats on the step grid', () => {
    assert.equal(quantizeValue(0.1 + 0.2, UNIT), 0.3);
    assert.equal(quantizeValue(0.15000000000000002, AFFINITY), 0.15);
    assert.equal(quantizeValue(0.054999999, { min: 0.02, max: 0.12, step: 0.001 }), 0.055);
    for (let k = -40; k <= 40; k++) {
      const q = quantizeValue(k * 0.05, AFFINITY);
      assert.match(String(q), /^-?\d+(\.\d{1,2})?$/, `k=${k} gave ${q}`);
    }
  });

  test('never returns negative zero', () => {
    assert.ok(Object.is(quantizeValue(-0.01, AFFINITY), 0));
    assert.ok(Object.is(quantizeValue(-0, AFFINITY), 0));
    assert.ok(Object.is(quantizeValue(0.05 - 0.05, AFFINITY), 0));
  });

  test('clamps, and keeps both endpoints reachable even off the grid', () => {
    assert.equal(quantizeValue(-5, AFFINITY), -1);
    assert.equal(quantizeValue(5, AFFINITY), 1);
    const offGrid = { min: 0, max: 0.124, step: 0.01 };
    assert.equal(quantizeValue(0.2, offGrid), 0.124);
    assert.equal(quantizeValue(0.123, offGrid), 0.12);
  });

  test('rounds half steps up and maps non-finite input to min', () => {
    assert.equal(quantizeValue(0.35, UNIT), 0.4);
    assert.equal(quantizeValue(NaN, N), 500);
    assert.equal(quantizeValue(Infinity, N), 500);
  });
});

describe('scrubValue (linear)', () => {
  test('moves one step per pxPerStep pixels, right = more', () => {
    assert.equal(scrubValue(5000, 40, { ...N, pxPerStep: 4 }), 6000);
    assert.equal(scrubValue(5000, -40, { ...N, pxPerStep: 4 }), 4000);
    assert.equal(scrubValue(5000, 40, { ...N, pxPerStep: 8 }), 5500);
    assert.equal(scrubValue(5000, 1, { ...N, pxPerStep: 4 }), 5000);
  });

  test('defaults to 4 px per step', () => {
    assert.equal(scrubValue(5000, 40, N), 6000);
  });

  test('responds symmetrically to left and right', () => {
    assert.equal(scrubValue(5000, 2, N), 5100);
    assert.equal(scrubValue(5000, -2, N), 4900);
  });

  test('Shift (fine) needs ten times the travel', () => {
    assert.equal(scrubValue(5000, 40, { ...N, fine: true }), 5100);
    assert.equal(scrubValue(5000, 400, { ...N, fine: true }), 6000);
  });

  test('clamps at both ends', () => {
    assert.equal(scrubValue(5000, 1e6, N), 12000);
    assert.equal(scrubValue(5000, -1e6, N), 500);
  });

  test('produces clean floats', () => {
    assert.equal(scrubValue(0.2, 4, UNIT), 0.3);
    assert.equal(scrubValue(0.1, 4, AFFINITY), 0.15);
    assert.equal(scrubValue(0.055, 4, { min: 0.02, max: 0.12, step: 0.001 }), 0.056);
    assert.ok(Object.is(scrubValue(0.05, -4, AFFINITY), 0));
  });

  test('treats a non-finite dx as no movement', () => {
    assert.equal(scrubValue(5000, NaN, N), 5000);
  });

  test('stays clean across every world-parameter grid', () => {
    const grids = [
      { min: 500, max: 12000, step: 100 },
      { min: 0.02, max: 0.12, step: 0.001 },
      { min: 0.005, max: 0.2, step: 0.001 },
      { min: 1, max: 30, step: 0.1 },
      { min: 0.05, max: 0.6, step: 0.01 },
    ];
    for (const g of grids) {
      const decimals = decimalsOf(g.step);
      for (const log of [false, true]) {
        for (let dx = -900; dx <= 900; dx += 3) {
          const v = scrubValue((g.min + g.max) / 2, dx, { ...g, log });
          assert.equal(v, Number(v.toFixed(decimals)), `${JSON.stringify(g)} log=${log} dx=${dx} gave ${v}`);
          assert.ok(v >= g.min && v <= g.max);
        }
      }
    }
  });
});

describe('scrubValue (log)', () => {
  test('is monotonic and spans the whole range', () => {
    let prev = -Infinity;
    for (let dx = -2000; dx <= 2000; dx += 7) {
      const v = scrubValue(0.04, dx, HALF_LIFE);
      assert.ok(v >= prev, `not monotonic at dx=${dx}`);
      assert.equal(quantizeValue(v, HALF_LIFE), v, `off grid at dx=${dx}`);
      prev = v;
    }
    assert.equal(scrubValue(0.04, 1e5, HALF_LIFE), 0.2);
    assert.equal(scrubValue(0.04, -1e5, HALF_LIFE), 0.005);
  });

  test('moves by ratio: fine at the bottom of the range, quick at the top', () => {
    const low = scrubValue(0.01, 40, HALF_LIFE) - 0.01;
    const high = scrubValue(0.1, 40, HALF_LIFE) - 0.1;
    assert.ok(high > 5 * low, `expected geometric spacing, got ${low} vs ${high}`);
    assert.equal(scrubValue(0.04, 40, HALF_LIFE), 0.048);
  });

  test('a very fine step still leaves a range that can be crossed', () => {
    const wide = { min: 1, max: 1e6, step: 1, log: true };
    assert.equal(scrubValue(1, 600 * 4, wide), 1e6);
    assert.equal(scrubValue(1e6, -600 * 4, wide), 1);
  });

  test('falls back to linear when the range is not positive', () => {
    assert.equal(scrubValue(5, 8, { min: 0, max: 10, step: 1, log: true }), 7);
  });
});

describe('nudgeValue', () => {
  test('steps linearly and clamps', () => {
    const s = { min: 0, max: 10, step: 1 };
    assert.equal(nudgeValue(5, 1, s), 6);
    assert.equal(nudgeValue(5, -10, s), 0);
    assert.equal(nudgeValue(10, 1, s), 10);
    assert.equal(nudgeValue(0.2, 1, UNIT), 0.3);
  });

  test('log ranges always move at least one step, and more near the top', () => {
    assert.equal(nudgeValue(0.005, 1, HALF_LIFE), 0.006);
    assert.equal(nudgeValue(0.19, 1, HALF_LIFE), 0.194);
    assert.equal(nudgeValue(0.2, -1, HALF_LIFE), 0.196);
    assert.equal(nudgeValue(0.2, 1, HALF_LIFE), 0.2);
  });
});

// ---------------------------------------------------------------------------
// A minimal fake DOM: just what createScrub touches.
// ---------------------------------------------------------------------------

class FakeClassList {
  #set = new Set();
  add(...names) { for (const n of names) this.#set.add(n); }
  remove(...names) { for (const n of names) this.#set.delete(n); }
  contains(name) { return this.#set.has(name); }
}

class FakeElement extends EventTarget {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.style = { cursor: '', minWidth: '' };
    this.children = [];
    this.textContent = '';
    this.id = '';
    this.capturedPointer = null;
    this.width = 24;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  insertBefore(child, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: 18 }; }
  setPointerCapture(id) { this.capturedPointer = id; }
  hasPointerCapture(id) { return this.capturedPointer === id; }
  releasePointerCapture(id) { if (this.capturedPointer === id) this.capturedPointer = null; }
}

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.defaultView = new EventTarget();
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.activeElement = this.body;
  }
  createElement(tag) { return new FakeElement(this, tag); }
  getElementById(id) {
    return [...this.head.children, ...this.body.children].find((c) => c.id === id) ?? null;
  }
}

function makeEvent(type, props) {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v, enumerable: true });
  return e;
}

const MOUSE = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, shiftKey: false };

/** A scrub in a fresh fake document, with its events recorded. */
function setup(opts = {}) {
  const doc = new FakeDocument();
  const win = doc.defaultView;
  const el = doc.createElement('span');
  doc.body.appendChild(el);
  const inputs = [];
  const commits = [];
  const scrub = createScrub(el, {
    value: 5000, ...N, format: String, label: 'Particle count', unit: 'particles',
    onInput: (v) => inputs.push(v),
    onCommit: (a, b) => commits.push([a, b]),
    ...opts,
  });
  const pointer = {
    down: (x, extra = {}) => el.dispatchEvent(makeEvent('pointerdown', { ...MOUSE, clientX: x, clientY: 0, ...extra })),
    move: (x, extra = {}) => win.dispatchEvent(makeEvent('pointermove', { ...MOUSE, clientX: x, clientY: 0, ...extra })),
    up: (x, extra = {}) => win.dispatchEvent(makeEvent('pointerup', { ...MOUSE, buttons: 0, clientX: x, clientY: 0, ...extra })),
    cancel: (extra = {}) => win.dispatchEvent(makeEvent('pointercancel', { ...MOUSE, buttons: 0, clientX: 0, clientY: 0, ...extra })),
  };
  const key = (k, extra = {}, target = el) => {
    const e = makeEvent('keydown', { key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...extra });
    target.dispatchEvent(e);
    return e;
  };
  return { doc, win, el, scrub, inputs, commits, pointer, key };
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

describe('createScrub: setup', () => {
  test('renders the formatted value and exposes a labelled slider', () => {
    const { el } = setup({ value: 0.3, min: 0.05, max: 0.6, step: 0.01, format: (v) => v.toFixed(2), label: 'Core radius', unit: 'r_max' });
    assert.equal(el.textContent, '0.30');
    assert.ok(el.classList.contains('scrub'));
    assert.equal(el.getAttribute('role'), 'slider');
    assert.equal(el.getAttribute('tabindex'), '0');
    assert.equal(el.getAttribute('aria-label'), 'Core radius');
    assert.equal(el.getAttribute('aria-valuemin'), '0.05');
    assert.equal(el.getAttribute('aria-valuemax'), '0.6');
    assert.equal(el.getAttribute('aria-valuenow'), '0.3');
    assert.equal(el.getAttribute('aria-valuetext'), '0.30 r_max');
  });

  test('quantises the initial value and defaults the format to the step decimals', () => {
    const { el, scrub } = setup({ value: 0.30000000000000004, min: 0, max: 1, step: 0.05, format: undefined });
    assert.equal(scrub.get(), 0.3);
    assert.equal(el.textContent, '0.30');
  });

  test('the default format prints a true minus sign and never a negative zero', () => {
    const { el, scrub } = setup({ value: -0.45, ...AFFINITY, format: undefined });
    assert.equal(el.textContent, '−0.45');
    assert.ok(!el.textContent.includes('-'));
    scrub.set(-0.0001);
    assert.equal(el.textContent, '0.00');
  });

  test('injects its stylesheet once per document, ahead of page styles', () => {
    const { doc } = setup();
    const pageSheet = doc.createElement('link');
    doc.head.appendChild(pageSheet);
    createScrub(doc.createElement('span'), { value: 1, min: 0, max: 2, step: 1 });
    const sheets = doc.head.children.filter((c) => c.id === 'scrub-style');
    assert.equal(sheets.length, 1);
    assert.equal(doc.head.children[0], sheets[0]);
    assert.match(sheets[0].textContent, /touch-action: pan-y/);
    assert.match(sheets[0].textContent, /cursor: ew-resize/);
  });

  test('rejects an unusable range', () => {
    const doc = new FakeDocument();
    assert.throws(() => createScrub(doc.createElement('span'), { min: 1, max: 0, step: 1 }), RangeError);
    assert.throws(() => createScrub(doc.createElement('span'), { min: 0, max: 1, step: 0 }), RangeError);
    assert.throws(() => createScrub(null, { min: 0, max: 1, step: 1 }), TypeError);
  });
});

describe('createScrub: pointer', () => {
  test('a click without movement only focuses', () => {
    const { doc, el, scrub, inputs, commits, pointer } = setup();
    pointer.down(100);
    pointer.move(102);
    pointer.up(102);
    assert.equal(scrub.get(), 5000);
    assert.deepEqual(inputs, []);
    assert.deepEqual(commits, []);
    assert.equal(doc.activeElement, el);
    assert.equal(el.capturedPointer, null);
    assert.ok(!el.classList.contains('is-active'));
  });

  test('vertical wobble is not a scrub', () => {
    const { scrub, inputs, pointer } = setup();
    pointer.down(100, { clientY: 0 });
    pointer.move(101, { clientY: 40 });
    pointer.up(101, { clientY: 40 });
    assert.equal(scrub.get(), 5000);
    assert.deepEqual(inputs, []);
  });

  test('a drag past 3px scrubs live, without a jump on pickup, and commits once', () => {
    const { doc, el, scrub, inputs, commits, pointer } = setup();
    pointer.down(100);
    pointer.move(104);
    // Activated: the 3px dead zone is not counted, so nothing changed yet.
    assert.deepEqual(inputs, []);
    assert.ok(el.classList.contains('is-active'));
    assert.equal(el.capturedPointer, 1);
    assert.equal(doc.body.style.cursor, 'ew-resize');
    assert.ok(doc.documentElement.classList.contains('scrub-dragging'));
    assert.equal(el.style.minWidth, '24px');

    pointer.move(111);
    pointer.move(123);
    assert.deepEqual(inputs, [5200, 5500]);
    assert.equal(el.textContent, '5500');
    assert.equal(el.getAttribute('aria-valuenow'), '5500');
    assert.deepEqual(commits, []);

    pointer.up(123);
    assert.deepEqual(commits, [[5000, 5500]]);
    assert.equal(scrub.get(), 5500);
    assert.ok(!el.classList.contains('is-active'));
    assert.ok(!doc.documentElement.classList.contains('scrub-dragging'));
    assert.equal(doc.body.style.cursor, '');
    assert.equal(el.style.minWidth, '');
    assert.equal(el.capturedPointer, null);
  });

  test('the width lock only grows while dragging', () => {
    const { el, pointer } = setup();
    pointer.down(0);
    pointer.move(4);
    el.width = 30;            // the number got wider after a change
    pointer.move(60);         // value changes, marking the width dirty
    pointer.move(64);         // reads the new width before writing
    assert.equal(el.style.minWidth, '30px');
    el.width = 20;            // narrower again: the box must not shrink
    pointer.move(-40);
    pointer.move(-44);
    assert.equal(el.style.minWidth, '30px');
    pointer.up(-44);
    assert.equal(el.style.minWidth, '');
  });

  test('the click that ends a drag is swallowed, later clicks are not', () => {
    const { el, pointer } = setup();
    pointer.down(0);
    pointer.move(20);
    pointer.up(20);
    const first = makeEvent('click', {});
    el.dispatchEvent(first);
    assert.ok(first.defaultPrevented);
    const second = makeEvent('click', {});
    el.dispatchEvent(second);
    assert.ok(!second.defaultPrevented);
  });

  test('Shift makes the drag ten times finer and re-anchors without a jump', () => {
    const { scrub, inputs, commits, pointer } = setup();
    pointer.down(0);
    pointer.move(4);                       // activate, anchor at x = 3
    pointer.move(43);                      // 40px -> +10 steps
    assert.equal(scrub.get(), 6000);
    pointer.move(43, { shiftKey: true });  // Shift pressed: no movement, no change
    assert.equal(scrub.get(), 6000);
    pointer.move(83, { shiftKey: true });  // 40px fine -> +1 step
    assert.equal(scrub.get(), 6100);
    pointer.up(83, { shiftKey: true });
    assert.deepEqual(inputs, [6000, 6100]);
    assert.deepEqual(commits, [[5000, 6100]]);
  });

  test('pointercancel keeps and commits what happened', () => {
    const { scrub, commits, pointer } = setup();
    pointer.down(0);
    pointer.move(4);
    pointer.move(20);
    pointer.cancel();
    assert.equal(scrub.get(), 5400);
    assert.deepEqual(commits, [[5000, 5400]]);
  });

  test('Escape abandons a drag, restores the value and closes it with a no-change commit', () => {
    const { win, el, scrub, inputs, commits, pointer, key } = setup();
    pointer.down(0);
    pointer.move(4);
    pointer.move(43);
    const esc = key('Escape', {}, win);
    assert.ok(esc.defaultPrevented);
    assert.equal(scrub.get(), 5000);
    assert.equal(el.textContent, '5000');
    assert.deepEqual(inputs, [6000, 5000]);
    // The owner saw onInput, so the gesture is closed with before === after.
    assert.deepEqual(commits, [[5000, 5000]]);
    assert.ok(!el.classList.contains('is-active'));
    pointer.move(80);   // the gesture is over: further moves do nothing
    assert.equal(scrub.get(), 5000);
  });

  test('Escape is taken in the capture phase on the window, and only while scrubbing', () => {
    const { win, pointer, key } = setup();
    const added = [];
    const removed = [];
    const add = win.addEventListener.bind(win);
    const remove = win.removeEventListener.bind(win);
    win.addEventListener = (type, fn, opts) => { added.push([type, opts]); add(type, fn, opts); };
    win.removeEventListener = (type, fn, opts) => { removed.push([type, opts]); remove(type, fn, opts); };
    pointer.down(0);
    pointer.move(4);
    pointer.move(20);
    assert.deepEqual(added.find(([type]) => type === 'keydown'), ['keydown', true],
      'runs before document-level shortcut handlers');
    pointer.up(20);
    assert.deepEqual(removed.find(([type]) => type === 'keydown'), ['keydown', true]);
    const late = key('Escape', {}, win);
    assert.ok(!late.defaultPrevented, 'Escape belongs to the page again after the drag');
  });

  test('a drag that returns to its start still commits once, with before === after', () => {
    const { scrub, inputs, commits, pointer } = setup();
    pointer.down(0);
    pointer.move(4);
    pointer.move(11);   // +2 steps
    pointer.move(3);    // back to the anchor
    pointer.up(3);
    assert.equal(scrub.get(), 5000);
    assert.deepEqual(inputs, [5200, 5000]);
    assert.deepEqual(commits, [[5000, 5000]]);
  });

  test('a drag too short to change anything fires no events at all', () => {
    const { inputs, commits, pointer } = setup();
    pointer.down(0);
    pointer.move(4);    // activates
    pointer.move(4.5);  // well under a step
    pointer.up(4.5);
    assert.deepEqual(inputs, []);
    assert.deepEqual(commits, []);
  });

  test('a mouse released outside the window ends the drag on the next move', () => {
    const { scrub, commits, pointer } = setup();
    pointer.down(0);
    pointer.move(4);
    pointer.move(43);
    pointer.move(300, { buttons: 0 });
    assert.equal(scrub.get(), 6000);
    assert.deepEqual(commits, [[5000, 6000]]);
  });

  test('ignores secondary buttons and other pointers', () => {
    const { el, scrub, pointer } = setup();
    pointer.down(0, { button: 2 });
    pointer.move(40);
    assert.equal(scrub.get(), 5000);

    pointer.down(0);
    pointer.move(4);
    el.dispatchEvent(makeEvent('pointerdown', { ...MOUSE, pointerId: 2, clientX: 0, clientY: 0 }));
    pointer.move(400, { pointerId: 2 });
    assert.equal(scrub.get(), 5000);
    pointer.move(43);
    pointer.up(43);
    assert.equal(scrub.get(), 6000);
  });

  test('a log-scaled scrub moves by ratio', () => {
    const { scrub, inputs, pointer } = setup({ value: 0.04, ...HALF_LIFE, format: (v) => (v * 1000).toFixed(0) });
    pointer.down(0);
    pointer.move(4);
    pointer.move(43);
    pointer.up(43);
    assert.equal(scrub.get(), 0.048);
    assert.deepEqual(inputs, [0.048]);
  });
});

describe('createScrub: keyboard', () => {
  const S = { value: 6, min: 2, max: 8, step: 1 };

  test('arrows step and every press commits', () => {
    const { scrub, inputs, commits, key } = setup(S);
    assert.ok(key('ArrowRight').defaultPrevented);
    key('ArrowUp');
    assert.equal(scrub.get(), 8);
    assert.deepEqual(inputs, [7, 8]);
    assert.deepEqual(commits, [[6, 7], [7, 8]]);
    key('ArrowLeft');
    key('ArrowDown');
    assert.equal(scrub.get(), 6);
  });

  test('a press at a bound is quiet but still handled', () => {
    const { inputs, commits, key } = setup({ ...S, value: 8 });
    assert.ok(key('ArrowUp').defaultPrevented);
    assert.deepEqual(inputs, []);
    assert.deepEqual(commits, []);
  });

  test('PageUp/PageDown move ten steps, Home/End go to the bounds', () => {
    const { scrub, commits, key } = setup({ value: 5000, ...N });
    key('PageUp');
    assert.equal(scrub.get(), 6000);
    key('PageDown');
    key('PageDown');
    assert.equal(scrub.get(), 4000);
    key('End');
    assert.equal(scrub.get(), 12000);
    key('Home');
    assert.equal(scrub.get(), 500);
    assert.deepEqual(commits.at(-1), [12000, 500]);
  });

  test('ignores unrelated keys and modified presses', () => {
    const { scrub, key } = setup(S);
    assert.ok(!key('a').defaultPrevented);
    assert.ok(!key('ArrowRight', { ctrlKey: true }).defaultPrevented);
    assert.equal(scrub.get(), 6);
  });

  test('value keys wait while a pointer holds the number', () => {
    const { scrub, pointer, key } = setup(S);
    pointer.down(0);
    key('ArrowRight');
    assert.equal(scrub.get(), 6);
    pointer.up(0);
    key('ArrowRight');
    assert.equal(scrub.get(), 7);
  });
});

describe('createScrub: API', () => {
  test('set() updates the text and ARIA without firing events', () => {
    const { el, scrub, inputs, commits } = setup();
    scrub.set(7000);
    assert.equal(scrub.get(), 7000);
    assert.equal(el.textContent, '7000');
    assert.equal(el.getAttribute('aria-valuenow'), '7000');
    assert.equal(el.getAttribute('aria-valuetext'), '7000 particles');
    scrub.set(12345);
    assert.equal(scrub.get(), 12000);
    scrub.set(7049);
    assert.equal(scrub.get(), 7000);
    scrub.set('not a number');
    assert.equal(scrub.get(), 7000);
    assert.deepEqual(inputs, []);
    assert.deepEqual(commits, []);
  });

  test('set() mid-drag continues the drag from the new value', () => {
    const { scrub, commits, pointer } = setup();
    pointer.down(0);
    pointer.move(4);
    pointer.move(43);             // 6000
    scrub.set(3000);              // e.g. an undo arrives mid-drag
    pointer.move(47);             // +4px from the re-anchor -> +1 step
    assert.equal(scrub.get(), 3100);
    pointer.up(47);
    assert.deepEqual(commits, [[5000, 3100]]);
  });

  test('enable(false) makes it inert; enable(true) restores it', () => {
    const { el, scrub, inputs, pointer, key } = setup();
    scrub.enable(false);
    assert.equal(el.getAttribute('tabindex'), '-1');
    assert.equal(el.getAttribute('aria-disabled'), 'true');
    pointer.down(0);
    pointer.move(40);
    pointer.up(40);
    key('ArrowRight');
    assert.equal(scrub.get(), 5000);
    assert.deepEqual(inputs, []);

    scrub.enable(true);
    assert.equal(el.getAttribute('tabindex'), '0');
    assert.equal(el.getAttribute('aria-disabled'), null);
    key('ArrowRight');
    assert.equal(scrub.get(), 5100);
  });

  test('disabling mid-drag ends it and commits what happened', () => {
    const { el, scrub, commits, pointer } = setup();
    pointer.down(0);
    pointer.move(4);
    pointer.move(43);
    scrub.enable(false);
    assert.deepEqual(commits, [[5000, 6000]]);
    assert.ok(!el.classList.contains('is-active'));
    pointer.move(100);
    assert.equal(scrub.get(), 6000);
  });

  test('destroy() removes behaviour and attributes but keeps the text', () => {
    const { el, scrub, inputs, pointer, key } = setup();
    scrub.destroy();
    assert.equal(el.getAttribute('role'), null);
    assert.equal(el.getAttribute('tabindex'), null);
    assert.equal(el.getAttribute('aria-valuenow'), null);
    assert.equal(el.getAttribute('aria-label'), null);
    assert.ok(!el.classList.contains('scrub'));
    assert.equal(el.textContent, '5000');
    pointer.down(0);
    pointer.move(40);
    pointer.up(40);
    key('ArrowRight');
    assert.deepEqual(inputs, []);
    scrub.set(9000);
    assert.equal(scrub.get(), 5000);
  });
});
