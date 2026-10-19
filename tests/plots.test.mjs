// Tests for src/plots.js: the pure helpers (nice ticks, torus and log ticks,
// range hysteresis, label culling and spreading, the trace ring buffer), and
// smoke tests that drive the three SVG components against a minimal fake DOM
// (Node has no document) with a manual clock, ResizeObserver and rAF queue.
// Run: node --test tests/plots.test.mjs

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapHalf, formatNumber, formatSigned, decimalsFor, ceilNice, LINEAR_LADDER,
  tickStepFor, minorStepFor, torusTicks, logTicks, hysteresisTop, linearTickStep,
  scaleBarUnits, cullLabels, spreadLabels, smoothToward, TraceBuffer,
  createForceCurve, createTraces, createAxes, AXES_MARGIN,
} from '../src/plots.js';
import { forceLaw } from '../src/sim.js';
import { markerPath } from '../src/markers.js';

const MINUS = '−';
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('snapHalf', () => {
  test('lands on half-pixel centres', () => {
    for (const v of [0, 3.2, 10, 10.4, 10.6, 99.99, -2.3]) {
      const s = snapHalf(v);
      assert.ok(close(s - Math.floor(s), 0.5), `${v} -> ${s}`);
      assert.ok(Math.abs(s - v) <= 0.5 + 1e-9, `${v} -> ${s}`);
    }
  });
});

describe('number formatting', () => {
  test('formatNumber uses U+2212 and never prints a negative zero', () => {
    assert.equal(formatNumber(-1), `${MINUS}1`);
    assert.equal(formatNumber(-20, 0), `${MINUS}20`);
    assert.equal(formatNumber(-0.001, 2), '0.00');
    assert.equal(formatNumber(-0, 1), '0.0');
    assert.equal(formatNumber(2.5, 1), '2.5');
    assert.equal(formatNumber(0.30000000000000004, 1), '0.3');
    assert.equal(formatNumber(NaN), '');
    assert.equal(formatNumber(Infinity), '');
    assert.ok(!formatNumber(-3.5, 1).includes('-'), 'hyphen-minus must not appear');
  });

  test('formatSigned marks the sign of affinities', () => {
    assert.equal(formatSigned(0.45), '+0.45');
    assert.equal(formatSigned(-0.45), `${MINUS}0.45`);
    assert.equal(formatSigned(0), '0.00');
    assert.equal(formatSigned(-0.001), '0.00');
    assert.equal(formatSigned(1, 2), '+1.00');
  });

  test('decimalsFor counts the decimals a step needs', () => {
    assert.equal(decimalsFor(1), 0);
    assert.equal(decimalsFor(20), 0);
    assert.equal(decimalsFor(0.5), 1);
    assert.equal(decimalsFor(0.2), 1);
    assert.equal(decimalsFor(2.5), 1);
    assert.equal(decimalsFor(0.05), 2);
    assert.equal(decimalsFor(0.1 * 3), 1);
    assert.equal(decimalsFor(0), 0);
  });
});

describe('nice tick selection', () => {
  test('ceilNice returns the smallest 1-2-5 value at or above x', () => {
    assert.equal(ceilNice(1.27), 2);
    assert.equal(ceilNice(2), 2);
    assert.equal(ceilNice(2.0000001), 5);
    assert.equal(ceilNice(5.1), 10);
    assert.equal(ceilNice(0.398), 0.5);
    assert.equal(ceilNice(0.03), 0.05);
    assert.equal(ceilNice(0.1), 0.1);
    assert.equal(ceilNice(1000), 1000);
    assert.equal(ceilNice(999.5), 1000);
  });

  test('ceilNice with the linear ladder', () => {
    assert.equal(ceilNice(1.365, LINEAR_LADDER), 1.5);
    assert.equal(ceilNice(8.1, LINEAR_LADDER), 10);
    assert.equal(ceilNice(0.21, LINEAR_LADDER), 0.25);
    assert.equal(ceilNice(3, LINEAR_LADDER), 3);
  });

  test('tickStepFor keeps labelled ticks >= 56px apart with the smallest such step', () => {
    const ladder = [];
    for (let e = -3; e <= 3; e++) for (const m of [1, 2, 5]) ladder.push(Number((m * 10 ** e).toPrecision(12)));
    for (let ppu = 0.5; ppu < 5000; ppu *= 1.17) {
      const step = tickStepFor(ppu, 56);
      assert.ok(ladder.includes(step), `step ${step} is on the 1-2-5 ladder`);
      assert.ok(step * ppu >= 56 - 1e-6, `ppu=${ppu}: ${step} gives ${step * ppu}px`);
      const smaller = ladder.filter((v) => v < step).pop();
      if (smaller !== undefined) assert.ok(smaller * ppu < 56, `ppu=${ppu}: ${smaller} would also fit`);
    }
  });

  test('dish defaults pick steps of 2 at 800px and 5 at 400px', () => {
    const rMax = 0.055;
    assert.equal(tickStepFor(800 * rMax, 56), 2);
    assert.equal(tickStepFor(400 * rMax, 56), 5);
    // zoomed far in, steps drop below one r_max and labels gain decimals
    assert.equal(tickStepFor(640 * 16 * rMax, 56), 0.1);
    assert.equal(decimalsFor(tickStepFor(640 * 16 * rMax, 56)), 1);
  });

  test('minorStepFor subdivides 1-2-5 majors or declines when crowded', () => {
    assert.equal(minorStepFor(1, 100), 0.2);
    assert.equal(minorStepFor(2, 40), 0.5);
    assert.equal(minorStepFor(5, 40), 1);
    assert.equal(minorStepFor(1, 20), 0.5);   // fifths would be 4px apart
    assert.equal(minorStepFor(5, 6), 0);      // nothing fits
  });

  test('linearTickStep spaces linear ticks by at least the gap', () => {
    assert.equal(linearTickStep(2.5, 95, 26), 1);
    assert.equal(linearTickStep(0.5, 95, 26), 0.2);
    assert.ok(linearTickStep(8, 60, 26) * (60 / 8) >= 26);
  });
});

describe('torusTicks', () => {
  const frac = new Float64Array(256);
  const vals = new Float64Array(256);

  test('one full period at zoom 1', () => {
    const P = 1 / 0.055;
    const n = torusTicks(0, P, P, 2, frac, vals);
    assert.equal(n, 10);
    assert.deepEqual(Array.from(vals.subarray(0, n)), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    for (let k = 1; k < n; k++) assert.ok(frac[k] > frac[k - 1]);
    assert.ok(frac[n - 1] < 1);
  });

  test('labels wrap across the seam: 16, 18, 0, 2', () => {
    const P = 1 / 0.055;
    const n = torusTicks(15, 6, P, 2, frac, vals);
    assert.deepEqual(Array.from(vals.subarray(0, n)), [16, 18, 0, 2]);
    assert.ok(close(frac[2], (P - 15) / 6, 1e-12));
    assert.ok(close(frac[3], (P + 2 - 15) / 6, 1e-12));
  });

  test('negative starts wrap the same way', () => {
    const P = 1 / 0.055;
    const n = torusTicks(-3, 6, P, 2, frac, vals);
    assert.deepEqual(Array.from(vals.subarray(0, n)), [16, 18, 0, 2]);
    for (let k = 0; k < n; k++) assert.ok(frac[k] >= 0 && frac[k] < 1);
  });

  test('a period that is a multiple of the step has no duplicate at the seam', () => {
    let n = torusTicks(0, 20, 20, 2, frac, vals);
    assert.equal(n, 10);
    n = torusTicks(10, 20, 20, 2, frac, vals);
    assert.deepEqual(Array.from(vals.subarray(0, n)), [10, 12, 14, 16, 18, 0, 2, 4, 6, 8]);
  });

  test('respects output capacity and degenerate input', () => {
    const small = new Float64Array(3);
    assert.equal(torusTicks(0, 100, 100, 1, small, new Float64Array(3)), 3);
    assert.equal(torusTicks(0, 0, 10, 1, frac, vals), 0);
    assert.equal(torusTicks(0, 10, 10, 0, frac, vals), 0);
  });
});

describe('logTicks', () => {
  const v = new Float64Array(32);
  const lab = new Uint8Array(32);

  test('labels every 1-2-5 value when there is room', () => {
    const n = logTicks(0.5, 2, 200, 16, v, lab);
    assert.deepEqual(Array.from(v.subarray(0, n)), [0.5, 1, 2]);
    assert.deepEqual(Array.from(lab.subarray(0, n)), [1, 1, 1]);
  });

  test('falls back to decades when cramped, keeping the rest as minor ticks', () => {
    const n = logTicks(0.5, 50, 40, 16, v, lab);
    assert.deepEqual(Array.from(v.subarray(0, n)), [0.5, 1, 2, 5, 10, 20, 50]);
    // 50 sits 0.7 decades (28px) above 10, so the axis top keeps its label
    assert.deepEqual(Array.from(lab.subarray(0, n)), [0, 1, 0, 0, 1, 0, 1]);
  });

  test('names the top in decade mode only when it clears the last decade', () => {
    const n = logTicks(0.5, 20, 40, 16, v, lab);
    assert.deepEqual(Array.from(v.subarray(0, n)), [0.5, 1, 2, 5, 10, 20]);
    assert.deepEqual(Array.from(lab.subarray(0, n)), [0, 1, 0, 0, 1, 0]); // 20 is 12px above 10
  });

  test('labels every second decade when even decades crowd', () => {
    const n = logTicks(1, 1e4, 10, 16, v, lab);
    const labelled = Array.from(v.subarray(0, n)).filter((_, k) => lab[k]);
    assert.deepEqual(labelled, [1, 100, 10000]);
  });

  test('values are clean floats', () => {
    const n = logTicks(0.5, 500, 200, 16, v, lab);
    for (let k = 0; k < n; k++) assert.match(String(v[k]), /^\d+(\.\d)?$/);
  });
});

describe('hysteresisTop', () => {
  const aggCeil = (x) => Math.max(2, ceilNice(x));

  test('grows at once when the data exceed the top', () => {
    assert.equal(hysteresisTop(2, 3.1, aggCeil), 5);
    assert.equal(hysteresisTop(5, 41, aggCeil), 50);
  });

  test('does not shrink for small dips near a ladder step', () => {
    let top = hysteresisTop(2, 5.2, aggCeil);
    assert.equal(top, 10);
    for (const m of [4.9, 5.1, 4.8, 5.3, 4.7, 6.9]) {
      top = hysteresisTop(top, m, aggCeil);
      assert.equal(top, 10, `dataMax ${m}`);
    }
  });

  test('shrinks once the data fit comfortably under a lower step', () => {
    assert.equal(hysteresisTop(50, 3, aggCeil), 5);
    assert.equal(hysteresisTop(10, 3.4, aggCeil), 5);
    assert.equal(hysteresisTop(10, 3.6, aggCeil), 10);
  });

  test('is stable: applying the same max twice changes nothing', () => {
    for (const m of [0.7, 1.9, 2.1, 7, 33, 120]) {
      const once = hysteresisTop(2, m, aggCeil);
      assert.equal(hysteresisTop(once, m, aggCeil), once);
      assert.ok(once >= m);
    }
  });

  test('keeps the current top when there is no data', () => {
    assert.equal(hysteresisTop(5, 0, aggCeil), 5);
    assert.equal(hysteresisTop(5, NaN, aggCeil), 5);
  });
});

describe('scaleBarUnits', () => {
  test('is a 1-2-5 value, inside 15-25% of the view when one exists', () => {
    for (let units = 0.05; units < 500; units *= 1.13) {
      const bar = scaleBarUnits(units);
      const e = Math.floor(Math.log10(bar) + 1e-9);
      assert.ok([1, 2, 5].includes(Math.round(bar / 10 ** e)), `bar ${bar}`);
      const candidates = [];
      for (let k = e - 3; k <= e + 3; k++) for (const m of [1, 2, 5]) candidates.push(m * 10 ** k);
      const anyInBand = candidates.some((c) => c / units >= 0.15 && c / units <= 0.25);
      const f = bar / units;
      if (anyInBand) assert.ok(f >= 0.15 && f <= 0.25, `units ${units}: ${bar} is ${f}`);
      else assert.ok(f > 0.1 && f < 0.35, `units ${units}: ${bar} is ${f}`);
    }
  });

  test('the default torus at zoom 1 gets a 5 r_max bar', () => {
    assert.equal(scaleBarUnits(1 / 0.055), 5);
  });
});

describe('cullLabels', () => {
  test('drops the pre-seam label in favour of 0', () => {
    const centers = Float64Array.from([10, 70, 130, 140, 200]);
    const halves = Float64Array.from([6, 6, 6, 6, 6]);
    const prio = Uint8Array.from([0, 0, 0, 1, 0]);
    const keep = new Uint8Array(5);
    cullLabels(centers, halves, prio, 5, 6, keep);
    assert.deepEqual(Array.from(keep), [1, 1, 0, 1, 1]);
  });

  test('keeps the earlier label when priorities tie', () => {
    const keep = new Uint8Array(3);
    cullLabels(Float64Array.from([0, 5, 60]), Float64Array.from([6, 6, 6]), new Uint8Array(3), 3, 6, keep, new Int32Array(3));
    assert.deepEqual(Array.from(keep), [1, 0, 1]);
  });
});

describe('spreadLabels', () => {
  const out = new Float64Array(8);

  test('leaves separated labels where they are', () => {
    spreadLabels(Float64Array.from([10, 40, 80]), 3, 14, 0, 100, out);
    assert.deepEqual(Array.from(out.subarray(0, 3)), [10, 40, 80]);
  });

  test('centres a colliding pair on its mean', () => {
    spreadLabels(Float64Array.from([50, 50]), 2, 14, 0, 100, out);
    assert.ok(close(out[0], 43) && close(out[1], 57), `${out[0]}, ${out[1]}`);
  });

  test('keeps the gap, the bounds and the input order', () => {
    const desired = Float64Array.from([95, 20, 96, 21, 97, 99]);
    spreadLabels(desired, 6, 14, 4, 100, out);
    const placed = Array.from(out.subarray(0, 6));
    const sorted = [...placed].sort((a, b) => a - b);
    for (let k = 1; k < sorted.length; k++) assert.ok(sorted[k] - sorted[k - 1] >= 14 - 1e-9, placed.join());
    for (const y of placed) assert.ok(y >= 4 - 1e-9 && y <= 100 + 1e-9, placed.join());
    // relative order follows desired order
    assert.ok(out[1] < out[3] && out[3] < out[0] && out[0] < out[2] && out[2] < out[4] && out[4] < out[5]);
  });

  test('a cluster at the bound is pushed inward', () => {
    spreadLabels(Float64Array.from([100, 100, 100]), 3, 14, 0, 100, out);
    assert.deepEqual(Array.from(out.subarray(0, 3)), [72, 86, 100]);
  });
});

describe('smoothToward', () => {
  test('moves 63% of the way in one time constant', () => {
    assert.ok(close(smoothToward(0, 1, 0.25, 0.25), 1 - Math.exp(-1)));
    assert.equal(smoothToward(0, 1, 0.1, 0), 1);
    assert.equal(smoothToward(NaN, 3, 0.1, 0.25), 3);
  });
});

describe('TraceBuffer', () => {
  test('wraps at capacity and iterates oldest first', () => {
    const b = new TraceBuffer(4, 8);
    const agg = new Float32Array(8);
    const spd = new Float32Array(8);
    for (let k = 0; k < 6; k++) {
      agg[0] = k;
      spd[0] = k * 10;
      b.push(k * 0.1, 3, agg, spd);
    }
    assert.equal(b.length, 4);
    assert.ok(close(b.lastTime(), 0.5, 1e-12));
    const times = [];
    for (let n = 0; n < b.length; n++) times.push(Number(b.time[b.slot(n)].toFixed(1)));
    assert.deepEqual(times, [0.2, 0.3, 0.4, 0.5]);
    assert.equal(b.aggregation[b.slot(0) * 8], 2);
    assert.equal(b.speed[b.slot(3) * 8], 50);
  });

  test('channels beyond the live species count are NaN', () => {
    const b = new TraceBuffer(4, 8);
    b.push(0, 2, [1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(b.aggregation[1], 2);
    assert.ok(Number.isNaN(b.aggregation[2]));
    assert.ok(Number.isNaN(b.speed[7]));
  });

  test('thins by time so the window stays covered when samples come fast', () => {
    const seconds = 20;
    const cap = seconds * 12;
    const b = new TraceBuffer(cap, 8, seconds / (cap - 2));
    const agg = new Float32Array(8);
    for (let k = 0; k <= 1500; k++) { // sim at 0.4x real time: 0.04 s per push
      agg[0] = k;
      b.push(k * 0.04, 1, agg, agg);
    }
    const oldest = b.time[b.slot(0)];
    const newest = b.lastTime();
    assert.ok(close(newest, 60, 1e-9), 'the newest sample is always the latest push');
    assert.equal(b.aggregation[b.slot(b.length - 1) * 8], 1500);
    assert.ok(newest - oldest >= seconds, `span ${newest - oldest}`);
    for (let n = 1; n < b.length - 1; n++) {
      assert.ok(b.time[b.slot(n)] - b.time[b.slot(n - 1)] >= seconds / (cap - 2) - 1e-9);
    }
  });

  test('does not thin samples that already arrive slowly enough', () => {
    const b = new TraceBuffer(240, 8, 20 / 238);
    for (let k = 0; k < 100; k++) b.push(k * 0.1, 2, [1, 1], [1, 1]);
    assert.equal(b.length, 100);
  });

  test('clear empties it', () => {
    const b = new TraceBuffer(4);
    b.push(1, 2, [1, 1], [1, 1]);
    b.clear();
    assert.equal(b.length, 0);
    assert.ok(Number.isNaN(b.lastTime()));
  });
});

// ---------------------------------------------------------------------------
// Fake DOM: just enough of document, SVG elements, ResizeObserver and rAF
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

class FakeClassList {
  constructor(el) { this.el = el; }
  list() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  add(...names) { const s = new Set(this.list()); names.forEach((n) => s.add(n)); this.el.setAttribute('class', [...s].join(' ')); }
  remove(...names) { this.el.setAttribute('class', this.list().filter((n) => !names.includes(n)).join(' ')); }
  contains(name) { return this.list().includes(name); }
}

class FakeStyle {
  setProperty(k, v) { this[k] = v; }
  removeProperty(k) { delete this[k]; }
}

class FakeElement {
  constructor(tag, ns) {
    this.namespaceURI = ns;
    this.tagName = ns === SVG_NS ? tag : tag.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this.ownText = '';
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get children() { return this.childNodes; }
  get textContent() { return this.ownText + this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.ownText = String(v);
  }
  getComputedTextLength() { return this.textContent.length * 6.5; }
}

function walk(node, fn) {
  fn(node);
  for (const c of node.childNodes) walk(c, fn);
}

function findAll(node, pred) {
  const out = [];
  walk(node, (n) => { if (pred(n)) out.push(n); });
  return out;
}

/** True when neither the node nor an ancestor is hidden. */
function isShown(node) {
  for (let n = node; n; n = n.parentNode) if (n.getAttribute && n.getAttribute('visibility') === 'hidden') return false;
  return true;
}

const env = {
  clock: 0,
  reducedMotion: false,
  theme: 'light',
  rafQueue: new Map(),
  rafId: 0,
  observers: new Set(),
};

function installDom() {
  const documentElement = new FakeElement('html', HTML_NS);
  const head = new FakeElement('head', HTML_NS);
  const body = new FakeElement('body', HTML_NS);
  documentElement.append(head, body);
  globalThis.document = {
    documentElement,
    head,
    body,
    createElement: (tag) => new FakeElement(tag, HTML_NS),
    createElementNS: (ns, tag) => new FakeElement(tag, ns),
    getElementById(id) {
      let found = null;
      walk(documentElement, (n) => { if (!found && n.id === id) found = n; });
      return found;
    },
    fonts: { addEventListener() {}, removeEventListener() {} },
  };
  globalThis.window = globalThis;
  globalThis.matchMedia = (q) => ({
    media: q,
    get matches() {
      if (q.includes('reduced-motion')) return env.reducedMotion;
      if (q.includes('color-scheme: dark')) return env.theme === 'dark';
      return false;
    },
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.targets = []; env.observers.add(this); }
    observe(t) { this.targets.push(t); }
    disconnect() { env.observers.delete(this); this.targets = []; }
  };
  globalThis.requestAnimationFrame = (cb) => {
    const id = ++env.rafId;
    env.rafQueue.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => { env.rafQueue.delete(id); };
  Object.defineProperty(globalThis, 'performance', { value: { now: () => env.clock }, configurable: true, writable: true });
}

function resize(target, width, height) {
  for (const ro of [...env.observers]) {
    if (ro.targets.includes(target)) ro.cb([{ target, contentRect: { width, height } }]);
  }
}

function flushFrames(count = 1, ms = 16) {
  for (let f = 0; f < count; f++) {
    env.clock += ms;
    const q = env.rafQueue;
    env.rafQueue = new Map();
    for (const cb of q.values()) cb(env.clock);
  }
}

function assertClean(root) {
  walk(root, (n) => {
    if (!n.attrs) return;
    for (const [k, v] of n.attrs) {
      assert.ok(!/NaN|undefined|Infinity/.test(v), `<${n.tagName} ${k}="${v}">`);
    }
  });
}

/** Parse "M1 2L3 4..." into [[x, y], ...] (absolute M/L only). */
function points(d) {
  const out = [];
  const re = /[ML](-?[\d.]+) (-?[\d.]+)/g;
  let m;
  while ((m = re.exec(d))) out.push([Number(m[1]), Number(m[2])]);
  return out;
}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function resetEnv() {
  env.clock = 1000;
  env.reducedMotion = false;
  env.theme = 'light';
  env.rafQueue = new Map();
  env.observers = new Set();
  installDom();
}

// ---------------------------------------------------------------------------
// Component smoke tests
// ---------------------------------------------------------------------------

describe('createForceCurve', () => {
  beforeEach(resetEnv);

  function mount(w = 320, h = 200) {
    const host = makeContainer();
    const fc = createForceCurve(host);
    const frame = host.childNodes[0];
    resize(frame, w, h);
    const svg = frame.childNodes.find((n) => n.tagName === 'svg');
    return { host, fc, frame, svg };
  }

  const curvePath = (svg) => findAll(svg, (n) => n.getAttribute('class') === 'pl-curve')[0];
  const textOf = (svg, str) => findAll(svg, (n) => n.tagName === 'text' && n.textContent === str)[0];

  test('injects its stylesheet once and sizes its spacer from the width in CSS', () => {
    const a = mount();
    mount();
    assert.equal(findAll(document.head, (n) => n.id === 'tropism-plots-css').length, 1);
    const sizer = a.frame.childNodes[0];
    assert.equal(sizer.getAttribute('class'), 'plots-sizer');
    const spacer = sizer.childNodes[0];
    // height = clamp(width / 1.6, 150, 250), resolved by layout, not by script
    assert.equal(spacer.style.aspectRatio, '1.6');
    assert.equal(spacer.style.minHeight, '150px');
    assert.equal(spacer.style.maxHeight, '250px');
    assert.equal(spacer.style.height, undefined);
    assert.equal(a.svg.getAttribute('width'), '320');
    assert.equal(a.svg.getAttribute('height'), '200');
  });

  test('a resize writes nothing that changes the observed box (no ResizeObserver loop)', () => {
    const { frame, svg } = mount(320, 200);
    const sizer = frame.childNodes[0];
    const spacer = sizer.childNodes[0];
    const before = JSON.stringify({ ...spacer.style });
    resize(frame, 480, 300);
    assert.equal(JSON.stringify({ ...spacer.style }), before, 'the in-flow spacer is untouched');
    assert.equal(svg.getAttribute('width'), '480');
    assert.equal(svg.getAttribute('height'), '300');
    resize(frame, 0, 0); // hidden: no throw, nothing drawn
    assert.equal(svg.getAttribute('visibility'), 'hidden');
    resize(frame, 320, 200);
    assert.equal(svg.getAttribute('visibility'), null);
  });

  test('relation markers match the 12px species markers of panel b', () => {
    const { fc, svg } = mount();
    fc.update({ i: 0, j: 0, a: 0.5, beta: 0.3 });
    const mark = findAll(svg, (n) => n.tagName === 'path' && /^#/.test(n.getAttribute('fill') || ''))[0];
    assert.equal(mark.getAttribute('d'), markerPath('circle', 12 * 0.36));
  });

  test('draws the law exactly, including its peak at (1 + beta) / 2', () => {
    const { fc, svg } = mount();
    fc.update({ i: 0, j: 1, a: 0.45, beta: 0.3 });
    const pts = points(curvePath(svg).getAttribute('d'));
    assert.ok(pts.length > 30);
    // map back: x0 = 34.5, x1 = 310.5 ; yTop = 26.5, yBot = 164.5
    const x0 = 34.5, x1 = 310.5, yTop = 26.5, yBot = 164.5;
    const rOf = (x) => ((x - x0) / (x1 - x0)) * 1.1;
    const fOf = (y) => ((yBot - y) / (yBot - yTop)) * 2.16 - 1.08;
    for (const [x, y] of pts) {
      const r = rOf(x);
      assert.ok(Math.abs(fOf(y) - forceLaw(r, 0.45, 0.3)) < 0.02, `r=${r.toFixed(3)} F=${fOf(y)}`);
    }
    const peak = pts.reduce((best, p) => (p[1] < best[1] ? p : best));
    assert.ok(Math.abs(rOf(peak[0]) - 0.65) < 1e-3);
    assert.ok(Math.abs(fOf(peak[1]) - 0.45) < 1e-3);
    assertClean(svg);
  });

  test('shows the pair readout with markers and a signed value', () => {
    const { fc, svg } = mount();
    fc.update({ i: 1, j: 3, a: -0.45, beta: 0.3 });
    assert.ok(isShown(textOf(svg, 'B')));
    assert.ok(isShown(textOf(svg, 'D')));
    assert.ok(isShown(textOf(svg, 'toward')));
    const val = findAll(svg, (n) => n.getAttribute('class') === 't-value')[0];
    assert.equal(val.textContent, `a = ${MINUS}0.45`);
    assert.ok(!isShown(textOf(svg, 'hover a bubble in b')));
    assert.match(svg.getAttribute('aria-label'), /B toward D/);
    assert.match(svg.getAttribute('aria-label'), /pushes B away from D/);
    const markers = findAll(svg, (n) => n.tagName === 'path' && /^#[0-9A-F]{6}$/i.test(n.getAttribute('fill') || ''));
    assert.equal(markers.length, 2);
    assertClean(svg);
  });

  test('with no pair it draws a = 0 and the hint', () => {
    const { fc, svg } = mount();
    fc.update({ i: -1, j: -1, a: 0.9, beta: 0.3 });
    const hint = textOf(svg, 'hover a bubble in b');
    assert.ok(isShown(hint));
    assert.equal(hint.getAttribute('class'), 't-tick');
    const ys = points(curvePath(svg).getAttribute('d')).map((p) => p[1]);
    const zeroY = Math.max(...ys.slice(-5));
    // beyond the core everything lies on the zero line
    assert.ok(ys.slice(Math.floor(ys.length * 0.4)).every((y) => Math.abs(y - zeroY) < 0.01));
  });

  test('tweens within 150ms, and not at all under reduced motion', () => {
    const { fc, svg } = mount();
    fc.update({ i: 0, j: 0, a: 1, beta: 0.3 });
    const path = curvePath(svg);
    const before = path.getAttribute('d');
    fc.update({ i: 0, j: 0, a: -1, beta: 0.3 });
    assert.equal(path.getAttribute('d'), before, 'waits for the first frame');
    flushFrames(3);
    const mid = path.getAttribute('d');
    assert.notEqual(mid, before);
    flushFrames(10);
    const done = path.getAttribute('d');
    assert.equal(env.rafQueue.size, 0, 'tween stops once settled');
    const minY = Math.max(...points(done).map((p) => p[1]));
    assert.ok(minY > 150, 'trough reaches toward F = -1');

    env.reducedMotion = true;
    fc.update({ i: 0, j: 0, a: 0.5, beta: 0.5 });
    assert.equal(env.rafQueue.size, 0);
    assert.notEqual(path.getAttribute('d'), done);
  });

  test('labels beta on the axis and lets it win against 0.5', () => {
    const { fc, svg } = mount();
    fc.update({ i: 0, j: 1, a: 0.2, beta: 0.5 });
    const beta = findAll(svg, (n) => n.tagName === 'text' && n.textContent === 'β')[0];
    assert.ok(isShown(beta));
    assert.ok(!isShown(textOf(svg, '0.5')));
    fc.update({ i: 0, j: 1, a: 0.2, beta: 0.2 });
    flushFrames(12);
    assert.ok(isShown(textOf(svg, '0.5')));
    assert.ok(isShown(textOf(svg, `${MINUS}1`)));
  });

  test('refreshTheme repaints markers and destroy cleans up', () => {
    const { host, fc, svg } = mount();
    fc.update({ i: 0, j: 1, a: 0.2, beta: 0.3 });
    env.theme = 'dark';
    fc.refreshTheme();
    const fills = findAll(svg, (n) => n.tagName === 'path' && /^#/.test(n.getAttribute('fill') || '')).map((n) => n.getAttribute('fill'));
    assert.deepEqual(fills, ['#3AA0E8', '#F2B33D']);
    fc.update({ i: 0, j: 1, a: -0.2, beta: 0.3 });
    fc.destroy();
    assert.equal(host.childNodes.length, 0);
    assert.equal(env.rafQueue.size, 0);
    assert.equal(env.observers.size, 0);
  });
});

describe('createTraces', () => {
  beforeEach(resetEnv);

  function mount(w = 360, h = 277, opts = { seconds: 20 }) {
    const host = makeContainer();
    const tr = createTraces(host, opts);
    const frame = host.childNodes[0];
    resize(frame, w, h);
    const svg = frame.childNodes.find((n) => n.tagName === 'svg');
    return { host, tr, frame, svg };
  }

  function fakeStats(S, t, spike = -1, spikeValue = 40) {
    const aggregation = new Float32Array(8);
    const meanSpeed = new Float32Array(8);
    for (let s = 0; s < S; s++) {
      aggregation[s] = 1 + s * 0.6 + 0.2 * Math.sin(t + s);
      meanSpeed[s] = 0.4 + s * 0.15 + 0.05 * Math.cos(t * 1.3 + s);
    }
    if (spike >= 0) aggregation[spike] = spikeValue;
    return { S, aggregation, meanSpeed, aggregationAll: 1, meanSpeedAll: 1 };
  }

  const traces = (svg) => findAll(svg, (n) => n.getAttribute('class') === 'pl-trace');
  const visibleTexts = (svg) => findAll(svg, (n) => n.tagName === 'text' && isShown(n)).map((n) => n.textContent);

  test('coalesces pushes into one frame', () => {
    const { tr } = mount();
    tr.setSpecies(6);
    flushFrames(30);
    for (let k = 0; k < 5; k++) tr.push(fakeStats(6, k * 0.1), k * 0.1);
    assert.equal(env.rafQueue.size, 1);
  });

  test('draws one line and endpoint marker per live species', () => {
    const { tr, svg } = mount();
    tr.setSpecies(6);
    for (let k = 0; k <= 300; k++) {
      tr.push(fakeStats(6, k * 0.1), k * 0.1);
      if (k % 3 === 0) flushFrames(1);
    }
    flushFrames(60);
    const lines = traces(svg);
    assert.equal(lines.length, 16); // 8 per row, two rows
    const shown = lines.filter(isShown);
    assert.equal(shown.length, 12);
    for (const p of shown) {
      const pts = points(p.getAttribute('d'));
      assert.ok(pts.length >= 200 && pts.length <= 202, `${pts.length} points`);
      assert.ok(/^#[0-9A-F]{6}$/i.test(p.getAttribute('stroke')));
    }
    const ends = findAll(svg, (n) => n.getAttribute('class') === 'pl-mark' && isShown(n));
    assert.equal(ends.length, 12);
    assertClean(svg);
  });

  test('labels the shared time axis at the bottom only, with true minus signs', () => {
    const { tr, svg } = mount();
    tr.setSpecies(3);
    tr.push(fakeStats(3, 0), 0);
    flushFrames(2);
    const texts = visibleTexts(svg);
    for (const label of [`${MINUS}20 s`, `${MINUS}10 s`, 'now']) {
      assert.equal(texts.filter((t) => t === label).length, 1, label);
    }
    assert.ok(texts.some((t) => t.startsWith('aggregation')));
    assert.ok(texts.some((t) => t.startsWith('speed (')));
    assert.ok(texts.includes('0.5') && texts.includes('1') && texts.includes('2'));
  });

  test('shows a value per species when the column fits, else the strongest only', () => {
    const roomy = mount(360, 300);
    roomy.tr.setSpecies(6);
    for (let k = 0; k < 40; k++) roomy.tr.push(fakeStats(6, k * 0.1), k * 0.1);
    flushFrames(120);
    const values = findAll(roomy.svg, (n) => n.tagName === 'text' && isShown(n) &&
      /^(t-label|t-value)$/.test(n.getAttribute('class')) && /^\d/.test(n.textContent));
    assert.equal(values.length, 12);
    assert.equal(values.filter((n) => n.getAttribute('class') === 't-value').length, 2);
    // one precision per column: aggregation x.x, speed x.xx (values here are below 10)
    const texts = values.map((n) => n.textContent);
    assert.equal(texts.filter((x) => /^\d\.\d$/.test(x)).length, 6, texts.join(' '));
    assert.equal(texts.filter((x) => /^\d\.\d\d$/.test(x)).length, 6, texts.join(' '));

    const tight = mount(360, 210);
    tight.tr.setSpecies(8);
    for (let k = 0; k < 40; k++) tight.tr.push(fakeStats(8, k * 0.1), k * 0.1);
    flushFrames(120);
    const few = findAll(tight.svg, (n) => n.tagName === 'text' && isShown(n) && n.getAttribute('class') === 't-value');
    assert.equal(few.length, 2, 'one per row');
    const others = findAll(tight.svg, (n) => n.tagName === 'text' && isShown(n) && n.getAttribute('class') === 't-label');
    assert.equal(others.length, 0);
  });

  test('eases readouts toward the latest value, and snaps under reduced motion', () => {
    const { tr, svg } = mount();
    tr.setSpecies(2);
    const stats = fakeStats(2, 0);
    stats.meanSpeed[0] = 1;
    tr.push(stats, 0);
    flushFrames(2);
    stats.meanSpeed[0] = 2;
    tr.push(stats, 0.1);
    flushFrames(2);
    const readout = () => findAll(svg, (n) => n.tagName === 'text' && isShown(n) && /^(t-label|t-value)$/.test(n.getAttribute('class')))
      .map((n) => Number(n.textContent));
    assert.ok(readout().some((v) => v > 1 && v < 2), `mid-ease: ${readout()}`);
    flushFrames(200);
    assert.ok(readout().includes(2), `settled: ${readout()}`);
    assert.equal(env.rafQueue.size, 0, 'the loop sleeps when settled');

    env.reducedMotion = true;
    stats.meanSpeed[0] = 1.5;
    tr.push(stats, 0.2);
    flushFrames(1);
    assert.ok(readout().includes(1.5), `snapped: ${readout()}`);
  });

  test('aggregation axis grows to the next nice value and shrinks with hysteresis', () => {
    const { tr, svg } = mount();
    tr.setSpecies(3);
    let t = 0;
    const run = (seconds, spike, value) => {
      for (let k = 0; k < seconds * 10; k++, t += 0.1) {
        tr.push(fakeStats(3, t, spike, value), t);
        flushFrames(1);
      }
    };
    // Plot height here is 101px. Top 5 spans 1 decade, so 0.5, 1, 2, 5 are all labelled;
    // top 50 spans 2 decades, too tight for 1-2-5, so only the decades 1 and 10 are.
    const ticks = () => findAll(svg, (n) => n.tagName === 'text' && n.getAttribute('class') === 't-tick' &&
      n.getAttribute('text-anchor') === 'end' && isShown(n)).map((n) => n.textContent);
    run(3, -1);
    assert.deepEqual(ticks().slice(0, 4), ['0.5', '1', '2', '5'], 'max 2.4 -> top 5');
    run(1, 0, 40);
    let agg = ticks();
    assert.ok(agg.includes('10') && agg.includes('50') && !agg.includes('2') && !agg.includes('5'), `grew to 50: ${agg.join(' ')}`);
    run(5, 0, 7);
    agg = ticks();
    assert.ok(agg.includes('10') && !agg.includes('2'), `holds while the spike is in the window: ${agg.join(' ')}`);
    run(25, -1);
    agg = ticks();
    assert.deepEqual(agg.slice(0, 4), ['0.5', '1', '2', '5'], `shrank back: ${agg.join(' ')}`);
    assert.ok(!agg.includes('10'));
    assertClean(svg);
  });

  test('a slow simulation still fills the whole 20 s window', () => {
    const { tr, svg } = mount();
    tr.setSpecies(2);
    for (let k = 0; k <= 800; k++) { // 0.03 sim-seconds per push
      tr.push(fakeStats(2, k * 0.03), k * 0.03);
      if (k % 4 === 0) flushFrames(1);
    }
    flushFrames(2);
    const p = traces(svg).filter(isShown)[0];
    const xs = points(p.getAttribute('d')).map((q) => q[0]);
    const x0 = 34.5;
    assert.ok(Math.min(...xs) <= x0 + 1, `line starts at ${Math.min(...xs)}`);
    assert.ok(xs.length <= 240);
  });

  test('time running backwards starts a new run; clear empties the plot', () => {
    const { tr, svg } = mount();
    tr.setSpecies(2);
    for (let k = 0; k < 50; k++) tr.push(fakeStats(2, k), 10 + k * 0.1);
    flushFrames(2);
    tr.push(fakeStats(2, 0), 0);
    flushFrames(2);
    const p = traces(svg).filter(isShown)[0];
    assert.equal(points(p.getAttribute('d')).length, 1);
    tr.clear();
    flushFrames(2);
    assert.equal(traces(svg).filter(isShown).length, 0);
    tr.destroy();
    assert.equal(env.observers.size, 0);
  });
});

describe('createAxes', () => {
  beforeEach(resetEnv);

  const labelTexts = (svg) => findAll(svg, (n) => n.tagName === 'text' && n.getAttribute('class') === 't-tick' && isShown(n))
    .map((n) => n.textContent);

  test('exports a margin the page can lay out against', () => {
    assert.deepEqual(Object.keys(AXES_MARGIN).sort(), ['bottom', 'left', 'right', 'top']);
    assert.ok(Object.isFrozen(AXES_MARGIN));
  });

  test('zoom 1: integer torus labels every 2 r_max and a 5 r_max bar', () => {
    const host = makeContainer();
    const axes = createAxes(host);
    axes.update({ view: { cx: 0.5, cy: 0.5, zoom: 1 }, rMax: 0.055, sizePx: 640 });
    const svg = host.childNodes[0];
    assert.equal(svg.getAttribute('width'), String(AXES_MARGIN.left + 640 + AXES_MARGIN.right));
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    const labels = labelTexts(svg);
    for (const v of ['0', '2', '10', '18']) assert.equal(labels.filter((t) => t === v).length, 2, v);
    const bar = findAll(svg, (n) => n.getAttribute('class') === 'pl-bar')[0];
    assert.equal(Number(bar.getAttribute('width')), Math.round(5 * 640 * 0.055));
    const barLabel = findAll(svg, (n) => n.tagName === 'text' && /pl-halo/.test(n.getAttribute('class') || ''))[0];
    assert.equal(barLabel.textContent, '5 rmax');
    assertClean(svg);
  });

  test('ticks are outward, crisp and 56px apart or more', () => {
    const host = makeContainer();
    const axes = createAxes(host);
    axes.update({ view: { cx: 0.5, cy: 0.5, zoom: 1 }, rMax: 0.055, sizePx: 640 });
    const svg = host.childNodes[0];
    const [frame, majors] = findAll(svg, (n) => n.getAttribute('class') === 'pl-ink');
    assert.ok(frame.getAttribute('d').length > 0);
    const segs = majors.getAttribute('d').match(/M[\d.]+ [\d.]+[VH][\d.]+/g);
    const bottom = segs.filter((s) => s.includes('V')).map((s) => s.match(/M([\d.]+) ([\d.]+)V([\d.]+)/).slice(1).map(Number));
    for (const [x, y0, y1] of bottom) {
      assert.ok(close(x % 1, 0.5), `x=${x}`);
      assert.equal(y1 - y0, 1 + 4, 'axis pixel plus 4px outward');
      assert.equal(y0, AXES_MARGIN.top + 640);
    }
    const xs = bottom.map((b) => b[0]).sort((a, b) => a - b);
    for (let k = 1; k < xs.length; k++) assert.ok(xs[k] - xs[k - 1] >= 56 - 1, `${xs[k] - xs[k - 1]}px`);
  });

  test('across the seam "0" wins over the label just before it', () => {
    const host = makeContainer();
    const axes = createAxes(host);
    // zoom 4: step 0.5 r_max, the seam sits 0.18 r_max (25px) after 18.0
    axes.update({ view: { cx: 0.0, cy: 0.5, zoom: 4 }, rMax: 0.055, sizePx: 640 });
    const svg = host.childNodes[0];
    const labels = labelTexts(svg);
    assert.ok(labels.includes('0.0') && labels.includes('17.5'), labels.join(' '));
    assert.ok(!labels.includes('18.0'), 'pre-seam label culled');
    assert.ok(labels.every((t) => /^\d+\.\d$/.test(t)), 'one decimal at this zoom');
    assertClean(svg);
  });

  test('far zoom uses decimals and skips redundant updates', () => {
    const host = makeContainer();
    const axes = createAxes(host);
    axes.update({ view: { cx: 0.3, cy: 0.7, zoom: 40 }, rMax: 0.055, sizePx: 640 });
    const svg = host.childNodes[0];
    const labels = labelTexts(svg);
    assert.ok(labels.length >= 6);
    assert.ok(labels.every((t) => /^\d+\.\d{2}$/.test(t)), labels.join(' '));
    const majors = findAll(svg, (n) => n.getAttribute('class') === 'pl-ink')[1];
    majors.setAttribute('d', 'sentinel');
    axes.update({ view: { cx: 0.3, cy: 0.7, zoom: 40 }, rMax: 0.055, sizePx: 640 });
    assert.equal(majors.getAttribute('d'), 'sentinel');
    axes.update({ view: { cx: 0.31, cy: 0.7, zoom: 40 }, rMax: 0.055, sizePx: 640 });
    assert.notEqual(majors.getAttribute('d'), 'sentinel');
  });

  test('draws into a given <svg> and leaves it in place on destroy', () => {
    const host = makeContainer();
    const own = document.createElementNS(SVG_NS, 'svg');
    host.appendChild(own);
    const axes = createAxes(own);
    axes.update({ view: { cx: 0.5, cy: 0.5, zoom: 2 }, rMax: 0.08, sizePx: 300 });
    assert.ok(own.childNodes.length > 0);
    assertClean(own);
    axes.destroy();
    assert.equal(own.parentNode, host);
    assert.equal(own.childNodes.length, 0);
  });

  test('comes back after being hidden, even with the same view as before', () => {
    const host = makeContainer();
    const axes = createAxes(host);
    const view = { cx: 0.5, cy: 0.5, zoom: 1 };
    axes.update({ view, rMax: 0.055, sizePx: 640 });
    const svg = host.childNodes[0];
    const root = svg.childNodes[0];
    assert.equal(root.getAttribute('visibility'), null);
    axes.update({ view, rMax: 0.055, sizePx: 0 });        // e.g. the dish collapsed
    assert.equal(root.getAttribute('visibility'), 'hidden');
    axes.update({ view, rMax: 0.055, sizePx: 640 });      // identical to the last draw
    assert.equal(root.getAttribute('visibility'), null);
    axes.update({ view, rMax: Infinity, sizePx: 640 });
    assert.equal(root.getAttribute('visibility'), 'hidden');
    assertClean(svg);
  });

  test('hides itself until it has a size and rMax', () => {
    const host = makeContainer();
    const axes = createAxes(host);
    axes.update({ view: { cx: 0.5, cy: 0.5, zoom: 1 }, rMax: 0.055 });
    const svg = host.childNodes[0];
    assert.equal(svg.childNodes[0].getAttribute('visibility'), 'hidden');
    resize(host, AXES_MARGIN.left + 400 + AXES_MARGIN.right, AXES_MARGIN.top + 400 + AXES_MARGIN.bottom);
    axes.update({ view: { cx: 0.5, cy: 0.5, zoom: 1 }, rMax: 0.055 });
    assert.equal(svg.getAttribute('width'), String(AXES_MARGIN.left + 400 + AXES_MARGIN.right));
  });
});
