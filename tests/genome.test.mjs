// Tests for src/genome.js: RNG, hashing, quantisation, genome operations and
// the shareable token encoding. Run with: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GENOME_VERSION, PARAM_LIMITS, AFFINITY_STEP,
  mulberry32, hashString, defaultParams, quantizeAffinity, normalizeGenome,
  randomGenome, mutateGenome, withSpecies, encodeGenome, decodeGenome,
  genomesEqual, cloneGenome,
} from '../src/genome.js';

const TOKEN_RE = /^[A-Za-z0-9._~-]+$/;
const PARAM_KEYS = ['n', 'rMax', 'halfLife', 'force', 'beta'];

/** True if v is exactly the double the two-decimal literal of v parses to. */
function isCleanAffinity(v) {
  return Number.isFinite(v) && v >= -1 && v <= 1 && !Object.is(v, -0) &&
    v === Number(v.toFixed(2)) && Math.abs(Math.round(v * 20) - v * 20) < 1e-9;
}

/** FNV-1a 32 over TextEncoder bytes: the reference hashString must match. */
function fnv1aBytes(str) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(str)) h = Math.imul(h ^ b, 0x01000193);
  return h >>> 0;
}

/** A random quantised genome with random in-range params, for round trips. */
function randomFullGenome(rng, S) {
  const g = randomGenome(Math.floor(rng() * 2 ** 32), { species: S });
  for (const key of PARAM_KEYS) {
    const { min, max, step } = PARAM_LIMITS[key];
    const units = Math.round(min / step) + Math.floor(rng() * (Math.round(max / step) - Math.round(min / step) + 1));
    const decimals = (String(step).split('.')[1] || '').length;
    g.params[key] = Number((units * step).toFixed(decimals));
  }
  return g;
}

// ---------------------------------------------------------------------------

test('mulberry32 is deterministic, in [0, 1) and roughly uniform', () => {
  const a = mulberry32(12345), b = mulberry32(12345), c = mulberry32(12346);
  let sum = 0, differs = false;
  for (let i = 0; i < 20000; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
    if (v !== c()) differs = true;
    sum += v;
  }
  assert.ok(differs, 'neighbouring seeds give different streams');
  assert.ok(Math.abs(sum / 20000 - 0.5) < 0.01);
  // seeds are taken as uint32
  assert.equal(mulberry32(2 ** 32 + 7)(), mulberry32(7)());
});

test('hashString is 32-bit FNV-1a over UTF-8', () => {
  assert.equal(hashString(''), 0x811c9dc5);
  assert.equal(hashString('a'), 0xe40c292c);
  assert.equal(hashString('foobar'), 0xbf9cf968);
  for (const s of ['tropism', 'Grüße', 'chaser 追跡', 'cell \u{1F9EB} dish', 'lone \ud800 surrogate', 'tail \udc00']) {
    assert.equal(hashString(s), fnv1aBytes(s), s);
  }
  const h = hashString('anything');
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
});

test('defaultParams returns the documented defaults as a fresh object', () => {
  const p = defaultParams();
  assert.deepEqual(p, { n: 5000, rMax: 0.055, halfLife: 0.04, force: 10, beta: 0.3 });
  p.n = 1;
  assert.equal(defaultParams().n, 5000);
});

test('quantizeAffinity clamps, rounds to the step and returns clean floats', () => {
  assert.equal(AFFINITY_STEP, 0.05);
  assert.equal(quantizeAffinity(0.1 + 0.2), 0.3);
  assert.equal(quantizeAffinity(0.30000000000000004), 0.3);
  assert.equal(quantizeAffinity(0.44), 0.45);
  assert.equal(quantizeAffinity(-0.44), -0.45);
  assert.equal(quantizeAffinity(0.026), 0.05);
  assert.equal(quantizeAffinity(-0.026), -0.05);
  assert.equal(quantizeAffinity(2), 1);
  assert.equal(quantizeAffinity(-7), -1);
  assert.equal(quantizeAffinity(NaN), 0);
  assert.equal(quantizeAffinity(Infinity), 0);
  for (const v of [-0, -0.001, -0.024, 0.024, -1e-12]) {
    assert.ok(Object.is(quantizeAffinity(v), 0), `${v} -> +0`);
  }
  const rng = mulberry32(99);
  for (let i = 0; i < 20000; i++) {
    const v = (rng() * 2 - 1) * 1.3;
    const q = quantizeAffinity(v);
    assert.ok(isCleanAffinity(q), `${v} -> ${q}`);
    assert.ok(Math.abs(q - Math.max(-1, Math.min(1, v))) <= 0.025 + 1e-12);
    assert.equal(quantizeAffinity(q), q, 'idempotent');
    assert.ok(String(q).replace(/^-/, '').length <= 4, `prints short: ${q}`);
  }
});

test('randomGenome is deterministic and well formed', () => {
  const seen = new Set();
  for (let seed = 0; seed < 300; seed++) {
    const g = randomGenome(seed);
    assert.deepEqual(g, randomGenome(seed));
    assert.equal(g.v, GENOME_VERSION);
    assert.ok(g.species >= 3 && g.species <= 7);
    seen.add(g.species);
    assert.equal(g.matrix.length, g.species * g.species);
    assert.ok(g.matrix.every(isCleanAffinity));
    assert.deepEqual(g.params, defaultParams());
    assert.equal(g.seed, seed);
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6, 7], 'default species spans 3..7');

  for (let S = 2; S <= 8; S++) {
    const g = randomGenome(77, { species: S });
    assert.equal(g.species, S);
    assert.equal(g.matrix.length, S * S);
  }
  // fixing S to the drawn value changes nothing
  const free = randomGenome(4242);
  assert.ok(genomesEqual(free, randomGenome(4242, { species: free.species })));
  // the matrix uses every level, including both ends
  const levels = new Set();
  for (let seed = 0; seed < 200; seed++) for (const a of randomGenome(seed).matrix) levels.add(a);
  assert.equal(levels.size, 41);
  assert.ok(levels.has(-1) && levels.has(1) && levels.has(0));
});

test('randomGenome params overrides are clamped and quantised', () => {
  const g = randomGenome(5, { params: { n: 777, rMax: 0.0553, beta: 5, force: 0 } });
  assert.equal(g.params.n, 800);
  assert.equal(g.params.rMax, 0.055);
  assert.equal(g.params.beta, PARAM_LIMITS.beta.max);
  assert.equal(g.params.force, PARAM_LIMITS.force.min);
  assert.equal(g.params.halfLife, 0.04);
  assert.equal(randomGenome(5, { species: 99 }).species, 8);
  assert.equal(randomGenome(5, { species: 1 }).species, 2);
  // optional options objects may be omitted or null
  assert.deepEqual(randomGenome(5, null), randomGenome(5));
  const base = randomGenome(6);
  assert.deepEqual(mutateGenome(base, 3, null), mutateGenome(base, 3));
});

test('encode/decode round-trips 500 random genomes across every species count', () => {
  const rng = mulberry32(2024);
  for (let k = 0; k < 500; k++) {
    const S = 2 + (k % 7);
    const g = randomFullGenome(rng, S);
    if (k === 0) g.seed = 0;
    if (k === 1) g.seed = 0xffffffff;
    const token = encodeGenome(g);
    assert.match(token, TOKEN_RE);
    assert.ok(token.startsWith('t1.'));
    const back = decodeGenome(token);
    assert.ok(back, `decodes ${token}`);
    assert.ok(genomesEqual(back, g), `round trip ${token}`);
    assert.deepEqual(back, g);
    assert.equal(encodeGenome(back), token, 'encoding is canonical');
  }
});

test('encoding has the documented layout', () => {
  const g = { v: 1, species: 2, matrix: [-1, 0, 1, 0.05], params: defaultParams(), seed: 35 };
  // S = '2'; -1 -> '0', 0 -> 'K', +1 -> 'e', 0.05 -> 'L'; params in steps, base36
  assert.equal(encodeGenome(g), 't1.20KeL.1e.1j.14.2s.u.z');
});

test('decode tolerates whitespace and a leading #', () => {
  const g = randomGenome(31337);
  const token = encodeGenome(g);
  for (const s of [`  ${token}\n`, `#${token}`, ` #${token} `, `\t# ${token}`]) {
    assert.ok(genomesEqual(decodeGenome(s), g), JSON.stringify(s));
  }
});

test('decode rejects malformed and out-of-range tokens without throwing', () => {
  const good = encodeGenome({ v: 1, species: 3, matrix: [0, 0.5, -0.5, 1, -1, 0.25, 0.1, 0, 0.95], params: defaultParams(), seed: 123456 });
  assert.ok(decodeGenome(good));
  const parts = good.split('.');
  const withPart = (i, v) => parts.map((p, k) => (k === i ? v : p)).join('.');
  const bad = [
    '', '#', '   ', 't1', 't1.', 'hello', good + '.', '.' + good, good + '.0', good.replace('t1.', 't2.'),
    good.replace('t1.', 'T1.'), withPart(1, '1K'), withPart(1, '9' + 'K'.repeat(81)),
    withPart(1, parts[1].slice(0, -1)), withPart(1, parts[1] + 'K'),
    withPart(1, '3' + 'f'.repeat(9)),          // level 41 is out of range
    withPart(1, '3' + '-'.repeat(9)),          // alphabet tail is not an affinity
    withPart(1, '3KKKK~KKKK'),                 // URL-safe but not in the alphabet
    withPart(2, '4'), withPart(2, '3d'),       // n of 400 and 12100
    withPart(3, 'j'), withPart(3, '3d'),       // rMax 0.019 and 0.121
    withPart(4, '4'), withPart(4, '5l'),       // halfLife 0.004 and 0.201
    withPart(5, '9'), withPart(5, '8d'),       // force 0.9 and 30.1
    withPart(6, '4'), withPart(6, '1p'),       // beta 0.04 and 0.61
    withPart(2, '1E'), withPart(2, ''), withPart(2, '-1'), withPart(2, '1.5'),
    withPart(7, '1z141z4'),                    // 2^32
    withPart(7, '00000000'),                   // too many digits
    good.replace(/\./g, '..'), good + '!', good.replace('.', ' '), `${good} ${good}`,
    ' '.repeat(5000) + good,
  ];
  // the inclusive limits themselves are accepted
  assert.ok(decodeGenome(withPart(2, '5')) && decodeGenome(withPart(2, '3c')));
  assert.ok(decodeGenome(withPart(3, 'k')) && decodeGenome(withPart(3, '3c')));
  assert.ok(decodeGenome(withPart(4, '5')) && decodeGenome(withPart(4, '5k')));
  assert.ok(decodeGenome(withPart(5, 'a')) && decodeGenome(withPart(5, '8c')));
  assert.ok(decodeGenome(withPart(6, '5')) && decodeGenome(withPart(6, '1o')));
  assert.ok(decodeGenome(withPart(7, '0')) && decodeGenome(withPart(7, '1z141z3')));
  for (const s of bad) {
    assert.equal(decodeGenome(s), null, `rejects ${JSON.stringify(s.slice(0, 60))}`);
  }
  for (const v of [null, undefined, 42, {}, [], true, Symbol('x'), () => good, new String(good)]) {
    assert.equal(decodeGenome(v), null);
  }
  // random junk never throws and almost never decodes
  const rng = mulberry32(7);
  const chars = 'tT1.0123456789abcdefKLe_-~#xyz ';
  for (let k = 0; k < 5000; k++) {
    let s = '';
    const len = Math.floor(rng() * 40);
    for (let i = 0; i < len; i++) s += chars[Math.floor(rng() * chars.length)];
    const out = decodeGenome(s);
    if (out !== null) assert.equal(encodeGenome(out), s.trim().replace(/^#\s*/, ''));
  }
});

test('encode normalises unquantised genomes to the nearest valid one', () => {
  const messy = { species: 2, matrix: [0.33, -0.071, 3, NaN], params: { n: 4999, rMax: 0.5, halfLife: 0.0404, force: 10.04, beta: 0.333 }, seed: -1 };
  const back = decodeGenome(encodeGenome(messy));
  assert.deepEqual(back, {
    v: 1, species: 2, matrix: [0.35, -0.05, 1, 0],
    params: { n: 5000, rMax: 0.12, halfLife: 0.04, force: 10, beta: 0.33 }, seed: 0xffffffff,
  });
  assert.deepEqual(normalizeGenome(messy), back);
  assert.throws(() => encodeGenome(null), TypeError);
  assert.throws(() => encodeGenome({ species: 'many' }), TypeError);
});

test('mutateGenome nudges 1-3 entries and keeps everything else', () => {
  for (let seed = 0; seed < 400; seed++) {
    const g = randomGenome(seed * 7 + 1);
    const before = cloneGenome(g);
    const m = mutateGenome(g, seed);
    assert.ok(genomesEqual(g, before), 'input untouched');
    assert.notEqual(m, g);
    assert.notEqual(m.matrix, g.matrix);
    assert.equal(m.species, g.species);
    assert.deepEqual(m.params, g.params);
    assert.equal(m.seed, g.seed);
    assert.ok(m.matrix.every(isCleanAffinity));
    let changed = 0;
    for (let k = 0; k < g.matrix.length; k++) {
      const d = Math.abs(m.matrix[k] - g.matrix[k]);
      if (d > 0) {
        changed++;
        assert.ok(d >= 0.05 - 1e-9 && d <= 0.35 + 1e-9, `delta ${d}`);
      }
    }
    assert.ok(changed >= 1 && changed <= 3, `changed ${changed}`);
    assert.ok(genomesEqual(m, mutateGenome(g, seed)), 'deterministic');
  }
  const g = randomGenome(9, { species: 4 });
  for (const entries of [1, 2, 3]) {
    const m = mutateGenome(g, 1234, { entries });
    assert.equal(m.matrix.filter((a, k) => a !== g.matrix[k]).length, entries);
  }
  // saturated entries still change (the nudge flips direction at the clamp)
  const full = { v: 1, species: 2, matrix: [1, 1, 1, 1], params: defaultParams(), seed: 1 };
  for (let seed = 0; seed < 50; seed++) {
    const m = mutateGenome(full, seed, { entries: 3 });
    assert.equal(m.matrix.filter((a) => a !== 1).length, 3);
  }
  // scale bounds the nudge
  for (let seed = 0; seed < 100; seed++) {
    const m = mutateGenome(g, seed, { scale: 0.1 });
    for (let k = 0; k < g.matrix.length; k++) {
      const d = Math.abs(m.matrix[k] - g.matrix[k]);
      assert.ok(d === 0 || (d >= 0.05 - 1e-9 && d <= 0.1 + 1e-9));
    }
  }
});

test('withSpecies keeps the overlapping block and fills the rest', () => {
  const g = randomGenome(321, { species: 4 });
  const up = withSpecies(g, 7, 99);
  assert.equal(up.species, 7);
  assert.equal(up.matrix.length, 49);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) assert.equal(up.matrix[i * 7 + j], g.matrix[i * 4 + j]);
  assert.ok(up.matrix.every(isCleanAffinity));
  assert.deepEqual(up.params, g.params);
  assert.equal(up.seed, g.seed);
  assert.ok(genomesEqual(up, withSpecies(g, 7, 99)), 'deterministic');

  const down = withSpecies(up, 3, 5);
  assert.equal(down.species, 3);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.equal(down.matrix[i * 3 + j], g.matrix[i * 4 + j]);

  const same = withSpecies(g, 4, 1);
  assert.ok(genomesEqual(same, g));
  assert.notEqual(same, g);
  assert.equal(withSpecies(g, 12, 1).species, 8);
});

test('genomesEqual and cloneGenome', () => {
  const g = randomGenome(55);
  const c = cloneGenome(g);
  assert.ok(genomesEqual(g, c));
  c.matrix[0] = c.matrix[0] === 1 ? 0.95 : 1;
  assert.ok(!genomesEqual(g, c), 'clone is deep');
  const d = cloneGenome(g);
  d.params.rMax = 0.056;
  assert.ok(!genomesEqual(g, d));
  assert.equal(g.params.rMax, 0.055);
  assert.ok(!genomesEqual(g, { ...cloneGenome(g), seed: g.seed + 1 }));
  assert.ok(!genomesEqual(g, null));
  assert.ok(!genomesEqual(undefined, g));
  // typed-array matrices clone to plain arrays
  const t = cloneGenome({ ...g, matrix: Float32Array.from(g.matrix) });
  assert.ok(Array.isArray(t.matrix));
});

test('PARAM_LIMITS describe the documented ranges and are frozen', () => {
  assert.deepEqual(PARAM_LIMITS.n, { min: 500, max: 12000, step: 100 });
  assert.deepEqual(PARAM_LIMITS.rMax, { min: 0.02, max: 0.12, step: 0.001 });
  assert.deepEqual(PARAM_LIMITS.halfLife, { min: 0.005, max: 0.2, step: 0.001 });
  assert.deepEqual(PARAM_LIMITS.force, { min: 1, max: 30, step: 0.1 });
  assert.deepEqual(PARAM_LIMITS.beta, { min: 0.05, max: 0.6, step: 0.01 });
  assert.ok(Object.isFrozen(PARAM_LIMITS) && Object.isFrozen(PARAM_LIMITS.n));
});
