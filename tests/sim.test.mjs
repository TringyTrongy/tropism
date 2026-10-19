// Tests for src/sim.js: the force law, the grid integrator against a brute-force
// reference, torus wrap, determinism, direct-manipulation bookkeeping and the
// statistics. Run with: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DT, forceLaw, createStats, World } from '../src/sim.js';
import { mulberry32, randomGenome, defaultParams } from '../src/genome.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a} (tol ${tol})`);

/** A plain genome literal; the engine accepts any n (genome limits are the UI's). */
function genome({ S = 3, n = 1000, seed = 1, matrix = null, params = {} } = {}) {
  return {
    v: 1,
    species: S,
    matrix: matrix ?? Array.from({ length: S * S }, (_, k) => ((k * 7) % 9) / 4 - 1),
    params: { ...defaultParams(), n, ...params },
    seed,
  };
}

/** World holding exactly the given particles: [[x, y, species, vx?, vy?], ...]. */
function worldWith(particles, { S = 2, matrix, params = {}, capacity = 64 } = {}) {
  const w = new World(capacity);
  w.reset(genome({ S, n: particles.length, matrix: matrix ?? new Array(S * S).fill(0), params }));
  particles.forEach(([x, y, s, vx = 0, vy = 0], i) => {
    w.x[i] = x; w.y[i] = y; w.species[i] = s; w.vx[i] = vx; w.vy[i] = vy;
  });
  return w;
}

/** O(n^2) minimum-image reference for the velocities one step produces. */
function referenceVelocities(w, dt) {
  const n = w.n, S = w.S, rMax = w.rMax, beta = w.beta;
  const friction = Math.pow(0.5, dt / w.halfLife);
  const vx = new Float64Array(n), vy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let fx = 0, fy = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let dx = w.x[j] - w.x[i]; dx -= Math.round(dx);
      let dy = w.y[j] - w.y[i]; dy -= Math.round(dy);
      const r = Math.hypot(dx, dy);
      if (r >= rMax || r === 0) continue;
      const F = forceLaw(r / rMax, w.matrix[w.species[i] * S + w.species[j]], beta);
      fx += (F * dx) / r;
      fy += (F * dy) / r;
    }
    vx[i] = w.vx[i] * friction + rMax * w.force * fx * dt;
    vy[i] = w.vy[i] * friction + rMax * w.force * fy * dt;
  }
  return { vx, vy };
}

const bytesEqual = (a, b) => Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

// ---------------------------------------------------------------------------
// Force law

test('forceLaw at its key points', () => {
  const beta = 0.3;
  for (const a of [-1, -0.45, 0, 0.6, 1]) {
    close(forceLaw(0, a, beta), -1, 1e-15, 'core floor');
    close(forceLaw(beta / 2, a, beta), -0.5, 1e-15, 'core midpoint');
    close(forceLaw(beta, a, beta), 0, 1e-15, 'core meets hump at zero');
    close(forceLaw((1 + beta) / 2, a, beta), a, 1e-15, 'peak');
    close(forceLaw(1 - 1e-12, a, beta), 0, 1e-9, 'continuous at r = 1');
    assert.equal(forceLaw(1, a, beta), 0);
    assert.equal(forceLaw(1.5, a, beta), 0);
    close(forceLaw(0.9, a, beta), a * (1 - 0.5 / 0.7), 1e-15);
    close(forceLaw(0.4, a, beta), forceLaw(0.9, a, beta), 1e-15, 'hump is symmetric about its peak');
  }
  // continuity on both sides of beta for several betas
  for (const b of [0.05, 0.3, 0.6]) {
    close(forceLaw(b - 1e-9, 1, b), 0, 1e-7);
    close(forceLaw(b + 1e-9, 1, b), 0, 1e-7);
  }
  // the hump is antisymmetric in a, the core is not affected by a
  for (let r = 0; r < 1.1; r += 0.01) {
    if (r >= 0.3) close(forceLaw(r, -0.7, 0.3), -forceLaw(r, 0.7, 0.3), 1e-15);
    else assert.equal(forceLaw(r, -0.7, 0.3), forceLaw(r, 0.7, 0.3));
  }
});

// ---------------------------------------------------------------------------
// Construction, reset, determinism

test('World allocates at capacity and reset seeds a uniform world', () => {
  const w = new World(3000);
  for (const k of ['x', 'y', 'vx', 'vy']) {
    assert.ok(w[k] instanceof Float32Array && w[k].length === 3000, k);
  }
  assert.ok(w.species instanceof Uint8Array && w.species.length === 3000);
  assert.ok(w.id instanceof Uint32Array && w.id.length === 3000);
  assert.ok(w.matrix instanceof Float32Array && w.matrix.length === 64);

  const g = randomGenome(77, { species: 5 });
  w.reset(g);
  assert.equal(w.n, 3000, 'n = min(params.n, capacity)');
  assert.equal(w.S, 5);
  assert.equal(w.steps, 0);
  assert.equal(w.rMax, g.params.rMax);
  assert.equal(w.trackedIndex(), -1);
  for (let k = 0; k < 25; k++) assert.equal(w.matrix[k], Math.fround(g.matrix[k]));
  for (let k = 25; k < 64; k++) assert.equal(w.matrix[k], 0);
  for (let i = 0; i < w.n; i++) {
    assert.ok(w.x[i] >= 0 && w.x[i] < 1 && w.y[i] >= 0 && w.y[i] < 1);
    assert.equal(w.species[i], i % 5);
    assert.equal(w.vx[i], 0);
    assert.equal(w.id[i], i);
  }
  const rng = mulberry32(g.seed);
  assert.equal(w.x[0], Math.fround(rng()));
  assert.equal(w.y[0], Math.fround(rng()));

  const small = new World();
  small.reset(genome({ n: 700 }));
  assert.equal(small.n, 700);
  assert.equal(small.capacity, 12000);
});

test('two worlds reset from the same genome are identical after 200 steps', () => {
  const g = randomGenome(2468, { params: { n: 2000 } });
  const a = new World(4000), b = new World(4000);
  a.reset(g);
  b.reset(g);
  for (let s = 0; s < 200; s++) { a.step(); b.step(); }
  assert.equal(a.steps, 200);
  for (const k of ['x', 'y', 'vx', 'vy', 'species', 'id']) {
    assert.ok(bytesEqual(a[k].subarray(0, a.n), b[k].subarray(0, b.n)), k);
  }
  // and something actually happened
  const c = new World(4000);
  c.reset(g);
  assert.ok(!bytesEqual(a.x.subarray(0, a.n), c.x.subarray(0, c.n)));
  // a reset makes a used world identical to a fresh one
  a.reset(g);
  for (let s = 0; s < 10; s++) { a.step(); c.step(); }
  assert.ok(bytesEqual(a.x.subarray(0, a.n), c.x.subarray(0, c.n)));
});

// ---------------------------------------------------------------------------
// Integration against a brute-force reference

test('grid integration matches an O(n^2) minimum-image reference', () => {
  const cases = [
    { rMax: 0.055, beta: 0.3, S: 4, n: 600 },
    { rMax: 0.12, beta: 0.1, S: 8, n: 500 },
    { rMax: 0.02, beta: 0.6, S: 2, n: 900 },
    { rMax: 0.25, beta: 0.45, S: 3, n: 300 },   // 4 cells per side
    { rMax: 1 / 3, beta: 0.3, S: 5, n: 300 },   // the 3-cell minimum
    { rMax: 0.3, beta: 0.2, S: 3, n: 300 },     // 3 cells wider than rMax
  ];
  for (const [ci, c] of cases.entries()) {
    const w = new World(1000);
    w.reset(randomGenome(100 + ci, { species: c.S, params: { n: 500 } }));
    w.setParams({ rMax: c.rMax, beta: c.beta, force: 12, halfLife: 0.03 });
    w.setCount(0, 0);
    w.setCount(c.n, 900 + ci);
    const rng = mulberry32(ci);
    for (let i = 0; i < w.n; i++) { w.vx[i] = (rng() - 0.5) * 0.2; w.vy[i] = (rng() - 0.5) * 0.2; }
    // put some particles right on the seams and corners
    w.x[0] = 0; w.y[0] = 0.5; w.x[1] = 0.999; w.y[1] = 0.5; w.x[2] = 0.999; w.y[2] = 0.999; w.x[3] = 0.001; w.y[3] = 0.002;
    assert.equal(w.cellsPerSide, Math.max(3, Math.floor(1 / c.rMax)));

    const x0 = w.x.slice(0, w.n), y0 = w.y.slice(0, w.n);
    const ref = referenceVelocities(w, DT);
    w.step();
    let maxV = 0;
    for (let i = 0; i < w.n; i++) {
      close(w.vx[i], ref.vx[i], 1e-7 + 1e-6 * Math.abs(ref.vx[i]), `case ${ci} vx[${i}]`);
      close(w.vy[i], ref.vy[i], 1e-7 + 1e-6 * Math.abs(ref.vy[i]), `case ${ci} vy[${i}]`);
      maxV = Math.max(maxV, Math.abs(ref.vx[i]));
      // second pass: positions advance with the new velocity, wrapped
      let ex = x0[i] + w.vx[i] * DT; ex -= Math.floor(ex);
      let ey = y0[i] + w.vy[i] * DT; ey -= Math.floor(ey);
      let dx = w.x[i] - ex; dx -= Math.round(dx);
      let dy = w.y[i] - ey; dy -= Math.round(dy);
      close(dx, 0, 1e-6, `case ${ci} x[${i}]`);
      close(dy, 0, 1e-6, `case ${ci} y[${i}]`);
      assert.ok(w.x[i] >= 0 && w.x[i] < 1 && w.y[i] >= 0 && w.y[i] < 1);
    }
    assert.ok(maxV > 1e-3, 'forces were exercised');
  }
});

test('results do not depend on particle order (two-pass integration)', () => {
  const w = new World(800);
  w.reset(randomGenome(5150, { species: 4, params: { n: 600 } }));
  w.setParams({ rMax: 0.09 });
  for (let s = 0; s < 30; s++) w.step(); // let some structure form first
  const n = w.n;
  const r = new World(800);
  r.reset(randomGenome(5150, { species: 4, params: { n: 600 } }));
  r.setParams({ rMax: 0.09 });
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i;
    r.x[k] = w.x[i]; r.y[k] = w.y[i]; r.vx[k] = w.vx[i]; r.vy[k] = w.vy[i]; r.species[k] = w.species[i];
  }
  w.step();
  r.step();
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i;
    close(r.vx[k], w.vx[i], 1e-7 + 1e-6 * Math.abs(w.vx[i]), `vx ${i}`);
    close(r.vy[k], w.vy[i], 1e-7 + 1e-6 * Math.abs(w.vy[i]), `vy ${i}`);
  }
});

// ---------------------------------------------------------------------------
// Torus wrap and minimum image

test('pairs across the seam attract and repel through the wrap', () => {
  const rMax = 0.055, force = 10, beta = 0.3;
  const friction = Math.pow(0.5, DT / 0.04);
  const expected = (d, a) => rMax * force * forceLaw(d / rMax, a, beta) * DT;

  // attraction at 0.02 apart across x = 0
  let w = worldWith([[0.99, 0.5, 0], [0.01, 0.5, 1]], { matrix: [1, 1, 1, 1] });
  w.step();
  assert.ok(w.vx[0] > 0 && w.vx[1] < 0, 'pulled toward each other through the seam');
  close(w.vx[0], expected(0.02, 1), 1e-6);
  close(w.vx[1], -expected(0.02, 1), 1e-6);
  close(w.vy[0], 0, 1e-12);
  assert.ok(w.x[0] > 0.99 || w.x[0] < 0.01, 'stays near the seam');

  // repulsion (negative affinity) across x = 0
  w = worldWith([[0.99, 0.5, 0], [0.01, 0.5, 1]], { matrix: [-1, -1, -1, -1] });
  w.step();
  assert.ok(w.vx[0] < 0 && w.vx[1] > 0, 'pushed apart through the seam');

  // the core repels regardless of affinity, across y = 0
  w = worldWith([[0.4, 0.995, 0], [0.4, 0.005, 1]], { matrix: [1, 1, 1, 1] });
  w.step();
  assert.ok(w.vy[0] < 0 && w.vy[1] > 0, 'core pushes apart across y seam');
  close(w.vy[0], expected(0.01, 1), 1e-6);
  close(w.vy[1], -expected(0.01, 1), 1e-6);

  // asymmetry: 0 is drawn to 1, 1 flees 0 (a chaser), across the corner
  w = worldWith([[0.99, 0.99, 0], [0.012, 0.012, 1]], { matrix: [0, 1, -1, 0] });
  const d = Math.hypot(0.022, 0.022);
  w.step();
  assert.ok(w.vx[0] > 0 && w.vy[0] > 0, 'chaser moves toward its target across the corner');
  assert.ok(w.vx[1] > 0 && w.vy[1] > 0, 'target moves away, the same way');
  close(w.vx[0], expected(d, 1) * Math.SQRT1_2, 1e-6);
  close(w.vx[1], expected(d, 1) * Math.SQRT1_2, 1e-6);

  // particles beyond rMax by torus distance do not interact, even near the seam
  w = worldWith([[0.97, 0.5, 0], [0.03, 0.5, 1]], { matrix: [1, 1, 1, 1] });
  w.step();
  assert.equal(w.vx[0], 0);
  assert.equal(w.vx[1], 0);

  // velocities persist with friction; positions wrap
  w = worldWith([[0.999, 0.0005, 0, 0.5, -0.5]], { matrix: [0, 0, 0, 0] });
  w.step();
  close(w.vx[0], 0.5 * friction, 1e-7);
  assert.ok(w.x[0] < 0.01, 'wrapped through x = 1');
  assert.ok(w.y[0] > 0.99, 'wrapped through y = 0');
});

test('exactly coincident particles are pushed apart', () => {
  const w = worldWith([[0.5, 0.5, 0], [0.5, 0.5, 1]], { matrix: [1, 1, 1, 1] });
  w.step();
  assert.ok(w.vx[0] !== 0 && Math.sign(w.vx[0]) === -Math.sign(w.vx[1]));
  close(Math.abs(w.vx[0]), 0.055 * 10 * DT, 1e-7);
  for (let s = 0; s < 3; s++) w.step();
  assert.ok(Number.isFinite(w.x[0]) && Number.isFinite(w.x[1]));
  assert.notEqual(w.x[0], w.x[1]);
});

// ---------------------------------------------------------------------------
// Live configuration

test('setParams resizes the grid and clamps to physically valid ranges', () => {
  const w = new World(100);
  w.reset(genome({ n: 50 }));
  assert.equal(w.cellsPerSide, 18);
  for (const [r, C] of [[0.12, 8], [0.02, 50], [0.05, 20], [0.3, 3], [0.1, 10]]) {
    w.setParams({ rMax: r });
    assert.equal(w.rMax, r);
    assert.equal(w.cellsPerSide, C, `rMax ${r}`);
    assert.ok(1 / w.cellsPerSide >= w.rMax);
  }
  w.setParams({ rMax: 0.9, beta: 1.5, halfLife: -1, force: Infinity });
  assert.equal(w.rMax, 1 / 3);
  assert.equal(w.cellsPerSide, 3);
  assert.ok(w.beta < 1);
  assert.ok(w.halfLife > 0);
  assert.equal(w.force, 10, 'non-finite values are ignored');
  w.setParams({ halfLife: 0.08, force: 3 });
  assert.equal(w.halfLife, 0.08);
  assert.equal(w.force, 3);
  w.setParams(null);
  w.setParams({ unknown: 1 });
  w.step();
});

test('setMatrix takes effect on the next step', () => {
  const pair = [[0.5, 0.5, 0], [0.53, 0.5, 1]];
  const w = worldWith(pair, { matrix: [0, 0, 0, 0] });
  w.step();
  assert.equal(w.vx[0], 0);
  w.setMatrix([0, 1, 0, 0]);
  assert.equal(w.matrix[1], 1);
  w.x[0] = 0.5; w.x[1] = 0.53; w.vx[0] = 0; w.vx[1] = 0;
  w.step();
  assert.ok(w.vx[0] > 0, '0 now drawn to 1');
  assert.equal(w.vx[1], 0, '1 indifferent to 0');
});

test('setSpecies shrinks by i % S and grows into the new species', () => {
  const w = new World(6000);
  w.reset(genome({ S: 6, n: 6000 }));
  const before = w.species.slice(0, w.n);
  w.setSpecies(3, new Array(9).fill(0.5), 1);
  assert.equal(w.S, 3);
  for (let i = 0; i < w.n; i++) {
    assert.ok(w.species[i] < 3);
    if (before[i] < 3) assert.equal(w.species[i], before[i]);
    else assert.equal(w.species[i], i % 3);
  }
  assert.equal(w.matrix[8], 0.5);
  assert.equal(w.matrix[9], 0);

  const kept = w.species.slice(0, w.n);
  w.setSpecies(5, new Array(25).fill(-0.25), 42);
  const counts = new Array(5).fill(0);
  for (let i = 0; i < w.n; i++) {
    counts[w.species[i]]++;
    if (w.species[i] < 3) assert.equal(w.species[i], kept[i], 'old members either stay or move to a new species');
  }
  for (const c of counts) close(c, w.n / 5, w.n * 0.03, 'fair share per species');

  const twin = new World(6000);
  twin.reset(genome({ S: 6, n: 6000 }));
  twin.setSpecies(3, new Array(9).fill(0.5), 1);
  twin.setSpecies(5, new Array(25).fill(-0.25), 42);
  assert.ok(bytesEqual(twin.species.subarray(0, twin.n), w.species.subarray(0, w.n)), 'deterministic');
  const s = w.stats();
  assert.equal(s.S, 5);
  assert.deepEqual(Array.from(s.count.subarray(0, 5)), counts);
});

test('growing the species count one at a time with one seed keeps fair shares', () => {
  // What the caption's species scrub does: setSpecies(S, matrix, genome.seed) per step.
  const w = new World(8000);
  w.reset(genome({ S: 3, n: 8000, seed: 5 }));
  for (let S = 4; S <= 8; S++) w.setSpecies(S, new Array(S * S).fill(0), 5);
  const s = w.stats();
  for (let k = 0; k < 8; k++) close(s.count[k], w.n / 8, w.n * 0.02, `species ${k}`);
  // shrinking and growing back repeats the same draw, so every particle returns to its species
  const before = w.species.slice(0, w.n);
  w.setSpecies(7, new Array(49).fill(0), 5);
  w.setSpecies(8, new Array(64).fill(0), 5);
  assert.ok(bytesEqual(before, w.species.subarray(0, w.n)));
});

test('setCount grows deterministically and shrinks from the end', () => {
  const w = new World(500);
  w.reset(genome({ S: 3, n: 100 }));
  w.setCount(250, 7);
  assert.equal(w.n, 250);
  const ids = new Set();
  for (let i = 0; i < w.n; i++) {
    ids.add(w.id[i]);
    if (i >= 100) {
      assert.equal(w.species[i], i % 3);
      assert.equal(w.vx[i], 0);
    }
  }
  assert.equal(ids.size, 250, 'ids unique');
  const twin = new World(500);
  twin.reset(genome({ S: 3, n: 100 }));
  twin.setCount(250, 7);
  assert.ok(bytesEqual(twin.x.subarray(0, 250), w.x.subarray(0, 250)));

  w.track(200);
  w.setCount(150, 0);
  assert.equal(w.n, 150);
  assert.equal(w.trackedIndex(), -1, 'tracked particle removed with the tail');
  w.setCount(1e9, 1);
  assert.equal(w.n, 500, 'clamped to capacity');
  w.setCount(NaN, 1);
  assert.equal(w.n, 500, 'invalid counts are ignored');
  w.setCount(0, 1);
  assert.equal(w.n, 0);
  w.step();
  assert.equal(w.stats().n, 0);
});

test('repeated growth with one seed never stacks a batch on an earlier one', () => {
  // What a caption scrub does while it is dragged: setCount(v, genome.seed)
  // once per step of 100, often while the dish is paused.
  const g = genome({ S: 4, n: 2000, seed: 77 });
  const w = new World(4000);
  w.reset(g);
  for (let n = 2100; n <= 3000; n += 100) w.setCount(n, g.seed);
  assert.equal(w.n, 3000);
  const at = new Set();
  for (let i = 0; i < w.n; i++) {
    const key = `${w.x[i]},${w.y[i]}`;
    assert.ok(!at.has(key), `particle ${i} lands exactly on another`);
    at.add(key);
  }
  // still deterministic for the same sequence of calls
  const twin = new World(4000);
  twin.reset(g);
  for (let n = 2100; n <= 3000; n += 100) twin.setCount(n, g.seed);
  assert.ok(bytesEqual(twin.x.subarray(0, 3000), w.x.subarray(0, 3000)));
  assert.ok(bytesEqual(twin.y.subarray(0, 3000), w.y.subarray(0, 3000)));
});

test('reset depends on the genome only, not on the previous world', () => {
  const w = new World(500);
  w.reset(genome({ n: 100, params: { rMax: 0.1, beta: 0.5, force: 3, halfLife: 0.1 } }));
  // a genome whose params are missing or invalid takes the defaults
  w.reset({ v: 1, species: 3, matrix: new Array(9).fill(0), params: { n: 50, rMax: undefined, beta: null, force: 'x' }, seed: 1 });
  const d = defaultParams();
  assert.equal(w.n, 50);
  assert.equal(w.rMax, d.rMax);
  assert.equal(w.beta, d.beta);
  assert.equal(w.force, d.force);
  assert.equal(w.halfLife, d.halfLife);
  assert.equal(w.cellsPerSide, Math.floor(1 / d.rMax));
  w.reset({ v: 1, species: 2, matrix: [0, 0, 0, 0], seed: 2 });
  assert.equal(w.n, Math.min(d.n, w.capacity));
});

test('the friction factor is rounded to float32 (engine-independent)', () => {
  const w = worldWith([[0.3, 0.3, 0, 0.37, -0.21]], { params: { halfLife: 0.037 } });
  const f = Math.fround(Math.pow(0.5, DT / 0.037));
  w.step();
  assert.equal(w.vx[0], Math.fround(Math.fround(0.37) * f));
  assert.equal(w.vy[0], Math.fround(Math.fround(-0.21) * f));
});

test('a non-finite position stays inert instead of spreading to its neighbours', () => {
  // A NaN coordinate bins into column 0, so its neighbours sit there too.
  const w = worldWith([[0.5, 0.5, 0], [0.01, 0.5, 1], [0.01, 0.52, 0]], { matrix: [1, 1, 1, 1] });
  w.x[0] = NaN;
  for (let s = 0; s < 5; s++) w.step();
  for (let i = 1; i < 3; i++) {
    assert.ok(Number.isFinite(w.x[i]) && Number.isFinite(w.y[i]), `particle ${i} position`);
    assert.ok(Number.isFinite(w.vx[i]) && Number.isFinite(w.vy[i]), `particle ${i} velocity`);
  }
  assert.ok(w.vy[1] > 0 && w.vy[2] < 0, 'the two finite particles still attract each other');
  assert.ok(Number.isFinite(w.stats().meanSpeedAll));
});

// ---------------------------------------------------------------------------
// Direct manipulation

test('seed adds particles inside a wrapped disc and stops at capacity', () => {
  const w = new World(1000);
  w.reset(genome({ S: 4, n: 900 }));
  const rng = mulberry32(3);
  const added = w.seed(0.99, 0.01, 0.03, 2, 60, rng);
  assert.equal(added, 60);
  assert.equal(w.n, 960);
  const ids = new Set();
  for (let i = 0; i < w.n; i++) ids.add(w.id[i]);
  assert.equal(ids.size, 960);
  for (let i = 900; i < 960; i++) {
    let dx = w.x[i] - 0.99; dx -= Math.round(dx);
    let dy = w.y[i] - 0.01; dy -= Math.round(dy);
    assert.ok(Math.hypot(dx, dy) <= 0.03 + 1e-6);
    assert.ok(w.x[i] >= 0 && w.x[i] < 1 && w.y[i] >= 0 && w.y[i] < 1);
    assert.equal(w.species[i], 2);
    assert.equal(w.vx[i], 0);
    assert.ok(w.id[i] >= 900);
  }
  // round-robin species when no valid species is given
  assert.equal(w.seed(0.5, 0.5, 0.05, -1, 8, rng), 8);
  for (let i = 960; i < 968; i++) assert.equal(w.species[i], i % 4);
  // capacity
  assert.equal(w.seed(0.5, 0.5, 0.05, 0, 500, rng), 32);
  assert.equal(w.n, 1000);
  assert.equal(w.seed(0.5, 0.5, 0.05, 0, 10, rng), 0);
  // deterministic given the rng
  const a = new World(100), b = new World(100);
  a.reset(genome({ n: 10 })); b.reset(genome({ n: 10 }));
  a.seed(0.2, 0.3, 0.1, 1, 20, mulberry32(9));
  b.seed(0.2, 0.3, 0.1, 1, 20, mulberry32(9));
  assert.ok(bytesEqual(a.x.subarray(0, 30), b.x.subarray(0, 30)));
});

test('erase removes the disc by swap-with-last and preserves identities', () => {
  const w = new World(4000);
  w.reset(genome({ S: 3, n: 4000 }));
  for (let s = 0; s < 5; s++) w.step();
  const byId = new Map();
  for (let i = 0; i < w.n; i++) byId.set(w.id[i], [w.x[i], w.y[i], w.vx[i], w.species[i]]);
  const inside = (x, y, cx, cy, r) => {
    let dx = x - cx; dx -= Math.round(dx);
    let dy = y - cy; dy -= Math.round(dy);
    return dx * dx + dy * dy < r * r;
  };
  const expectRemoved = [...byId.entries()].filter(([, [x, y]]) => inside(x, y, 0.02, 0.98, 0.1)).map(([id]) => id);
  const removed = w.erase(0.02, 0.98, 0.1);
  assert.equal(removed, expectRemoved.length);
  assert.ok(removed > 50, 'the disc straddles both seams');
  assert.equal(w.n, 4000 - removed);
  const gone = new Set(expectRemoved);
  const seen = new Set();
  for (let i = 0; i < w.n; i++) {
    const id = w.id[i];
    assert.ok(!gone.has(id), 'removed ids are gone');
    assert.ok(!seen.has(id), 'no duplicates');
    seen.add(id);
    assert.deepEqual([w.x[i], w.y[i], w.vx[i], w.species[i]], byId.get(id), 'state travels with its id');
    assert.ok(!inside(w.x[i], w.y[i], 0.02, 0.98, 0.1));
  }
  assert.equal(seen.size + removed, 4000);
  assert.equal(w.erase(0.5, 0.5, 0), 0);
  const left = w.n;
  assert.equal(w.erase(0.5, 0.5, 2), left, 'a disc wider than the torus takes everything');
  assert.equal(w.n, 0);
});

test('a tracked particle survives other erasures and is lost to its own', () => {
  const w = new World(3000);
  w.reset(genome({ S: 3, n: 3000 }));
  const t = w.nearest(0.5, 0.5);
  w.track(t);
  const id = w.id[t];
  const rng = mulberry32(17);
  let erased = 0;
  for (let k = 0; k < 40; k++) {
    // erase discs that avoid the tracked particle
    let cx, cy;
    do { cx = rng(); cy = rng(); } while (Math.hypot(cx - 0.5, cy - 0.5) < 0.2);
    erased += w.erase(cx, cy, 0.06);
    const i = w.trackedIndex();
    assert.ok(i >= 0 && i < w.n);
    assert.equal(w.id[i], id, `still the same particle after ${k + 1} erasures`);
    if (k % 10 === 0) w.step();
  }
  assert.ok(erased > 300);
  // erase the tracked particle itself
  const ti = w.trackedIndex();
  w.erase(w.x[ti], w.y[ti], 0.01);
  assert.equal(w.trackedIndex(), -1);
  for (let k = 0; k < w.n; k++) assert.notEqual(w.id[k], id);

  w.track(5);
  assert.equal(w.trackedIndex(), 5);
  w.track(-1);
  assert.equal(w.trackedIndex(), -1);
  w.track(w.n);
  assert.equal(w.trackedIndex(), -1);
  w.track(1.5);
  assert.equal(w.trackedIndex(), -1);
  w.track(3);
  w.reset(genome({ n: 10 }));
  assert.equal(w.trackedIndex(), -1, 'reset stops tracking');
});

test('tracking follows the last particle when it is swapped into a hole', () => {
  const w = worldWith([[0.1, 0.1, 0], [0.5, 0.5, 1], [0.9, 0.9, 0]], { capacity: 8 });
  w.track(2);
  const id = w.id[2];
  assert.equal(w.erase(0.1, 0.1, 0.01), 1);
  assert.equal(w.trackedIndex(), 0);
  assert.equal(w.id[0], id);
  assert.equal(w.x[0], Math.fround(0.9));
});

test('stir adds an impulse with a smooth (1 - d/r)^2 falloff, wrap-aware', () => {
  const w = worldWith([[0.5, 0.5, 0], [0.525, 0.5, 0], [0.6, 0.5, 0], [0.001, 0.2, 1], [0.97, 0.2, 1]], { capacity: 8 });
  w.stir(0.5, 0.5, 0.05, 1, -2);
  close(w.vx[0], 1, 1e-7);
  close(w.vy[0], -2, 1e-7);
  close(w.vx[1], 0.25, 1e-6, 'half radius gets a quarter');
  close(w.vy[1], -0.5, 1e-6);
  assert.equal(w.vx[2], 0, 'outside untouched');
  w.stir(0.991, 0.2, 0.02, 3, 0);
  close(w.vx[3], 3 * (1 - 0.01 / 0.02) ** 2, 1e-5, 'across the seam');
  assert.equal(w.vx[4], 0);
  w.stir(0.5, 0.5, 0.05, NaN, 0);
  close(w.vx[0], 1, 1e-7, 'non-finite impulses ignored');
});

test('nearest is wrap-aware and honours maxDist', () => {
  const w = worldWith([[0.5, 0.5, 0], [0.999, 0.999, 1], [0.2, 0.8, 0]], { capacity: 8 });
  assert.equal(w.nearest(0.001, 0.001), 1, 'across the corner');
  assert.equal(w.nearest(0.49, 0.52), 0);
  assert.equal(w.nearest(0.21, 0.79, 0.02), 2);
  assert.equal(w.nearest(0.3, 0.3, 0.05), -1);
  assert.equal(w.nearest(0.3, 0.3, -1), -1);
  assert.equal(w.nearest(NaN, 0.3), -1);
  // no limit when maxDist is omitted, null or NaN; the limit itself is inclusive
  assert.equal(w.nearest(0.3, 0.3, null), 0);
  assert.equal(w.nearest(0.3, 0.3, NaN), 0);
  assert.equal(w.nearest(0.5, 0.5, 0), 0, 'distance 0 is within maxDist 0');
  const empty = new World(4);
  empty.reset(genome({ n: 0 }));
  assert.equal(empty.nearest(0.5, 0.5), -1);
});

// ---------------------------------------------------------------------------
// Statistics

test('a uniform gas has aggregation near 1', () => {
  const w = new World(12000);
  w.reset(genome({ S: 3, n: 9000, matrix: new Array(9).fill(0), seed: 4242 }));
  const s = w.stats();
  assert.equal(s.steps, 0);
  assert.equal(s.n, 9000);
  assert.equal(s.S, 3);
  for (let k = 0; k < 3; k++) {
    assert.equal(s.count[k], 3000);
    close(s.aggregation[k], 1, 0.05, `species ${k}`);
    assert.equal(s.meanSpeed[k], 0);
  }
  for (let k = 3; k < 8; k++) {
    assert.equal(s.count[k], 0);
    assert.equal(s.aggregation[k], 0);
  }
  close(s.aggregationAll, 1, 0.03);
  assert.equal(s.meanSpeedAll, 0);

  w.step();
  const t = w.stats(s);
  assert.equal(t, s, 'out is reused');
  assert.equal(t.steps, 1);
  close(t.aggregationAll, 1, 0.03, 'still mixed after one step');
  assert.ok(t.meanSpeedAll > 0, 'the core set things moving');
});

test('a tight blob has aggregation far above 1', () => {
  const w = new World(8000);
  w.reset(genome({ S: 2, n: 3000, matrix: [0, 0, 0, 0], seed: 9 }));
  w.seed(0.3, 0.7, 0.02, 0, 1500, mulberry32(1));
  const s = w.stats(createStats());
  assert.equal(s.count[0], 3000);
  assert.equal(s.count[1], 1500);
  assert.ok(s.aggregation[0] > 10, `blob species aggregation ${s.aggregation[0]}`);
  close(s.aggregation[1], 1, 0.1, 'the uniform species stays near 1');
  assert.ok(s.aggregationAll > 2);

  // erase the blob: stats re-measure without a step
  w.erase(0.3, 0.7, 0.021);
  const t = w.stats();
  assert.ok(t.aggregation[0] < 2, `after erasing the blob ${t.aggregation[0]}`);
  assert.equal(t.n, w.n);
});

test('meanSpeed is |v| in rMax per second', () => {
  const friction = Math.pow(0.5, DT / 0.04);
  const w = worldWith([[0.25, 0.25, 0, 0.11, 0], [0.75, 0.75, 1, 0, -0.055], [0.25, 0.75, 1, 0.033, 0.044]]);
  w.step();
  const s = w.stats();
  close(s.meanSpeed[0], 2 * friction, 1e-5);
  close(s.meanSpeed[1], ((1 + 1) / 2) * friction, 1e-5);
  close(s.meanSpeedAll, ((2 + 1 + 1) / 3) * friction, 1e-5);
  assert.equal(s.aggregation[0], 0, 'fewer than two particles');
  assert.equal(s.aggregation[1], 0, 'two particles, no neighbours');
});

test('step accepts dt and keeps the step counter', () => {
  const w = new World(200);
  w.reset(genome({ n: 200 }));
  const x0 = w.x.slice(0, 200);
  w.step(0);
  assert.ok(bytesEqual(w.x.subarray(0, 200), x0), 'dt = 0 moves nothing');
  w.step(DT / 2);
  w.step();
  assert.equal(w.steps, 3);
  assert.equal(w.stats().steps, 3);
});
