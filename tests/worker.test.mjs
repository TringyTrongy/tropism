// Tests for the simulation worker protocol: src/sim-worker.js (SimDriver and
// serve) and src/sim-host.js (the main-thread side). The worker is run
// in-process through a fake Worker that delivers messages asynchronously with
// structuredClone and real transfer lists, so buffers detach exactly as they
// would between threads. Run with: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World, DT, createStats, nearestIndex } from '../src/sim.js';
import { decodeGenome, defaultParams, mulberry32 } from '../src/genome.js';
import { PRESETS } from '../src/presets.js';
import {
  SimDriver, serve, packStats, unpackStats, createFrameBuffers, frameTransfer, STATS_LENGTH, MAX_OWED, TRACK_MAX,
} from '../src/sim-worker.js';
import { createSimHost } from '../src/sim-host.js';

const CAP = 12000;

function genome({ S = 3, n = 1500, seed = 7, params = {} } = {}) {
  return {
    v: 1,
    species: S,
    matrix: Array.from({ length: S * S }, (_, k) => ((k * 7) % 9) / 4 - 1),
    params: { ...defaultParams(), n, ...params },
    seed,
  };
}

function sameParticles(view, world, msg = '') {
  assert.equal(view.n, world.n, `${msg} n`);
  for (let i = 0; i < world.n; i++) {
    if (view.x[i] !== world.x[i] || view.y[i] !== world.y[i] || view.species[i] !== world.species[i]) {
      assert.fail(`${msg} particle ${i} differs: (${view.x[i]}, ${view.y[i]}, ${view.species[i]}) vs (${world.x[i]}, ${world.y[i]}, ${world.species[i]})`);
    }
    if (view.id && view.id[i] !== world.id[i]) assert.fail(`${msg} id ${i} differs`);
  }
}

/** A Worker stand-in running serve() in this process; messages cross with structuredClone + transfer. */
function fakeWorker({ fail = null } = {}) {
  let server = null;
  const scope = {
    onmessage: null,
    postMessage(msg, transfer = []) {
      const data = structuredClone(msg, { transfer });
      setTimeout(() => { if (!main.terminated && main.onmessage) main.onmessage({ data }); });
    },
  };
  const main = {
    onmessage: null,
    onerror: null,
    terminated: false,
    types: [],
    postMessage(msg, transfer = []) {
      const data = structuredClone(msg, { transfer });
      main.types.push(data.type);
      setTimeout(() => {
        if (main.terminated) return;
        if (fail && fail(data)) {
          if (main.onerror) main.onerror({ message: 'boom', preventDefault() {} });
          return;
        }
        if (scope.onmessage) scope.onmessage({ data });
      });
    },
    terminate() {
      main.terminated = true;
      if (server) server.close();
    },
  };
  server = serve(scope);
  return main;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(2);
  }
}

function quiet(fn) {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  return Promise.resolve().then(fn).finally(() => { console.warn = warn; console.error = error; });
}

// ---------------------------------------------------------------- pure pieces

test('nearestIndex matches World#nearest, including limits and wrap', () => {
  const w = new World(400);
  w.reset(genome({ n: 300, seed: 11 }));
  const rng = mulberry32(5);
  for (let k = 0; k < 50; k++) {
    const x = rng(), y = rng();
    for (const d of [undefined, null, NaN, -1, 0, 0.01, 0.05, 1]) {
      assert.equal(nearestIndex(w.x, w.y, w.n, x, y, d), w.nearest(x, y, d));
    }
  }
  assert.equal(nearestIndex(w.x, w.y, w.n, 0.99, 0.5), w.nearest(0.99, 0.5));
  assert.equal(nearestIndex(w.x, w.y, 0, 0.5, 0.5), -1);
});

test('packed statistics round-trip exactly', () => {
  const w = new World(3000);
  w.reset(genome({ S: 5, n: 2000 }));
  for (let k = 0; k < 20; k++) w.step(DT);
  const st = w.stats();
  const buf = new Float64Array(STATS_LENGTH);
  const back = unpackStats(packStats(st, buf), createStats());
  assert.deepEqual(back, st);
});

test('the driver applies commands exactly as direct World calls do', () => {
  const g = genome({ S: 4, n: 2000, seed: 99 });
  const d = new SimDriver(CAP);
  const w = new World(CAP);
  d.apply({ type: 'reset', genome: g, seq: 1 });
  w.reset(g);
  sameParticles(d.world, w, 'after reset');
  for (let k = 0; k < 10; k++) { d.stepOnce(); w.step(DT); }
  d.apply({ type: 'stir', x: 0.3, y: 0.4, radius: 0.08, dvx: 0.5, dvy: -0.2 });
  w.stir(0.3, 0.4, 0.08, 0.5, -0.2);
  d.apply({ type: 'seed', x: 0.7, y: 0.2, radius: 0.04, species: 2, count: 8, rng: 1234 });
  w.seed(0.7, 0.2, 0.04, 2, 8, mulberry32(1234));
  d.apply({ type: 'erase', x: 0.5, y: 0.5, radius: 0.06 });
  w.erase(0.5, 0.5, 0.06);
  d.apply({ type: 'params', params: { beta: 0.4, rMax: 0.06 } });
  w.setParams({ beta: 0.4, rMax: 0.06 });
  d.apply({ type: 'species', S: 5, matrix: genome({ S: 5 }).matrix, seed: 3 });
  w.setSpecies(5, genome({ S: 5 }).matrix, 3);
  d.apply({ type: 'count', n: 2500, seed: 99 });
  w.setCount(2500, 99);
  for (let k = 0; k < 10; k++) { d.stepOnce(); w.step(DT); }
  sameParticles(d.world, w, 'after edits');
  for (let i = 0; i < w.n; i++) assert.equal(d.world.vx[i], w.vx[i]);
  assert.equal(d.countEdited, true);
});

test('the driver tracks by stable id across swaps and forgets an erased particle', () => {
  const d = new SimDriver(64);
  d.apply({ type: 'reset', genome: genome({ S: 2, n: 4 }) });
  const w = d.world;
  // Put the last particle somewhere erasing particle 0 will not touch.
  w.x[0] = 0.1; w.y[0] = 0.1;
  w.x[3] = 0.8; w.y[3] = 0.8;
  w.x[1] = 0.5; w.y[1] = 0.5; w.x[2] = 0.6; w.y[2] = 0.3;
  const id3 = w.id[3];
  d.apply({ type: 'track', id: id3 });
  assert.equal(d.trackedId, id3);
  assert.equal(w.trackedIndex(), 3);
  d.apply({ type: 'erase', x: 0.1, y: 0.1, radius: 0.01 });
  assert.equal(w.trackedIndex(), 0, 'the tracked particle moved into the hole');
  assert.equal(w.id[0], id3);
  assert.equal(d.trackedId, id3);
  d.apply({ type: 'erase', x: 0.8, y: 0.8, radius: 0.01 });
  assert.equal(d.trackedId, -1);
  d.apply({ type: 'track', id: 123456 });
  assert.equal(d.trackedId, -1, 'an unknown id tracks nothing');
});

test('step credit is capped and dropped by a pause', () => {
  const d = new SimDriver(1000);
  d.apply({ type: 'reset', genome: genome({ n: 500 }) });
  d.apply({ type: 'tick', steps: 10 });
  assert.equal(d.owed, MAX_OWED);
  assert.equal(d.pump(1e9), MAX_OWED);
  assert.equal(d.world.steps, MAX_OWED);
  d.apply({ type: 'tick', steps: 2 });
  d.apply({ type: 'run', on: false });
  assert.equal(d.owed, 0);
  d.apply({ type: 'tick', steps: 2 });
  assert.equal(d.owed, 0, 'no credit while paused');
  assert.equal(d.pump(), 0);
});

test('a frame carries the live particles, the path since the last frame and the tracked particle', () => {
  const d = new SimDriver(1000);
  d.apply({ type: 'reset', genome: genome({ n: 600 }), seq: 1 });
  d.apply({ type: 'track', id: 17, seq: 2 });
  const path = [];
  for (let k = 0; k < 3; k++) {
    d.stepOnce();
    const i = d.world.trackedIndex();
    path.push(d.world.x[i], d.world.y[i]);
  }
  const buf = createFrameBuffers(1000);
  const f = d.writeFrame(buf, true);
  sameParticles({ ...f, x: buf.x, y: buf.y, species: buf.species, id: buf.id }, d.world);
  assert.equal(f.ack, 2);
  assert.equal(f.trackedId, 17);
  assert.equal(f.trackCount, 3);
  assert.deepEqual(Array.from(buf.track.subarray(0, 6)), path.map(Math.fround));
  assert.equal(f.trackVx, d.world.vx[f.trackedIndex]);
  assert.equal(unpackStats(buf.stats).steps, 3);
  assert.equal(d.writeFrame(buf, false).trackCount, 0, 'the path is sent once');
  assert.equal(frameTransfer(buf).length, 6);
  assert.ok(TRACK_MAX >= 600);
});

// ---------------------------------------------------------------- host + worker

test('Node has no Worker, so the host simulates on the main thread', async () => {
  const host = createSimHost(CAP);
  assert.equal(host.kind, 'main');
  const g = genome({ n: 1000 });
  host.reset(g);
  const w = new World(CAP);
  w.reset(g);
  sameParticles(host.view, w);
  host.tick(2.5);
  w.step(DT); w.step(DT);
  sameParticles(host.view, w, 'after two whole steps');
  host.dispose();
});

test('a world code gives the same dish in the worker as in a World', async () => {
  const preset = PRESETS.find((p) => p.id === 'bead-trains') || PRESETS[PRESETS.length - 1];
  const g = decodeGenome(preset.code);
  const host = createSimHost(CAP, {}, { createWorker: () => ({ worker: fakeWorker(), url: '' }) });
  assert.equal(host.kind, 'worker');
  host.reset(g);
  await host.synced();
  const w = new World(CAP);
  w.reset(g);
  sameParticles(host.view, w, 'initial state');
  const r = await host.advance(25, 5);
  for (let k = 0; k < 25; k++) w.step(DT);
  assert.equal(r.steps, 25);
  sameParticles(host.view, w, 'after 25 steps');
  assert.equal(host.view.steps, 25);
  host.dispose();
});

test('frames ping-pong two buffer sets, and statistics arrive', async () => {
  const fw = fakeWorker();
  const host = createSimHost(CAP, {}, { createWorker: () => ({ worker: fw, url: '' }) });
  assert.equal(host.stats(), null, 'nothing before the first frame');
  host.reset(genome({ n: 2000 }));
  await host.synced();
  const st = host.stats();
  assert.ok(st, 'statistics came with the first frame');
  assert.equal(st.n, 2000);
  for (let k = 0; k < 6; k++) {
    const previous = host.view.x;
    assert.equal(previous.byteLength, CAP * 4, 'the current set is owned here');
    await host.advance(1, 0);
    assert.notEqual(host.view.x, previous);
    assert.equal(previous.byteLength, 0, 'the previous set was transferred back');
  }
  // (One more is possible: a frame sent only to carry statistics.)
  assert.ok(fw.types.filter((t) => t === 'release').length >= 6);
  host.dispose();
});

test('tick credit steps the worker and a pause stops it', async () => {
  const host = createSimHost(CAP, {}, { createWorker: () => ({ worker: fakeWorker(), url: '' }) });
  host.reset(genome({ n: 800 }));
  host.setRunning(true);
  host.tick(0.5);
  host.tick(0.5);
  await until(() => host.view.steps === 1);
  host.tick(10);
  await until(() => host.view.steps === 1 + MAX_OWED);
  host.setRunning(false);
  host.tick(3);
  await sleep(30);
  await host.synced();
  assert.equal(host.view.steps, 1 + MAX_OWED, 'paused: credit refused');
  host.dispose();
});

test('click-to-track: nearest on this thread, then the worker follows the id', async () => {
  const points = [];
  let lost = 0;
  const host = createSimHost(CAP, {
    onTrack(p, count) { for (let k = 0; k < count * 2; k++) points.push(p[k]); },
    onTrackLost() { lost += 1; },
  }, { createWorker: () => ({ worker: fakeWorker(), url: '' }) });
  const g = genome({ n: 1500, seed: 3 });
  host.reset(g);
  await host.synced();
  const idx = host.nearest(0.5, 0.5, 0.2);
  assert.ok(idx >= 0);
  const id = host.view.id[idx];
  host.track(id);
  assert.equal(host.tracking, true);
  assert.equal(host.trackedIndex(), -1, 'not confirmed until a frame shows it');
  await host.advance(12, 0);
  const ti = host.trackedIndex();
  assert.ok(ti >= 0);
  assert.equal(host.view.id[ti], id);
  assert.equal(points.length, 24, 'one point per step');
  // The same path from a World.
  const w = new World(CAP);
  w.reset(g);
  w.track(idx);
  const ref = [];
  for (let k = 0; k < 12; k++) { w.step(DT); ref.push(w.x[w.trackedIndex()], w.y[w.trackedIndex()]); }
  assert.deepEqual(points, ref);
  assert.ok(host.trackedSpeed() > 0);
  // Erase it: the host reports the loss once.
  host.erase(host.view.x[ti], host.view.y[ti], 0.002);
  await host.synced();
  assert.equal(lost, 1);
  assert.equal(host.tracking, false);
  assert.equal(host.trackedIndex(), -1);
  host.dispose();
});

test('seed and erase report a count change; advance delivers samples', async () => {
  let edits = 0;
  const samples = [];
  const host = createSimHost(CAP, {
    onCountEdited() { edits += 1; },
    onSamples(s) { samples.push(...s); },
  }, { createWorker: () => ({ worker: fakeWorker(), url: '' }) });
  host.reset(genome({ n: 1000 }));
  host.seed(0.5, 0.5, 0.05, 1, 8, 42);
  await host.synced();
  assert.equal(host.view.n, 1008);
  assert.equal(edits, 1);
  host.erase(0.5, 0.5, 0.05);
  await host.synced();
  assert.ok(host.view.n < 1008);
  assert.equal(edits, 2);
  await host.advance(20, 5);
  assert.deepEqual(samples.map((s) => s.steps), [5, 10, 15, 20]);
  host.dispose();
});

test('a worker that fails before it is ready falls back with every command replayed', async () => {
  await quiet(async () => {
    const g = genome({ n: 1200, seed: 21 });
    const host = createSimHost(CAP, {}, {
      createWorker: () => ({ worker: fakeWorker({ fail: (m) => m.type === 'init' }), url: '' }),
    });
    host.reset(g);
    host.seed(0.2, 0.2, 0.03, 0, 8, 9);
    const r = await host.advance(10, 0);
    assert.equal(host.kind, 'main');
    assert.equal(r.steps, 10);
    const w = new World(CAP);
    w.reset(g);
    w.seed(0.2, 0.2, 0.03, 0, 8, mulberry32(9));
    for (let k = 0; k < 10; k++) w.step(DT);
    sameParticles(host.view, w, 'replayed');
    host.dispose();
  });
});

test('a worker that crashes after starting restarts the world on the main thread', async () => {
  await quiet(async () => {
    let restarts = 0;
    let host = null;
    const g = genome({ n: 900 });
    host = createSimHost(CAP, {
      onRestart() { restarts += 1; host.reset(g); },
    }, { createWorker: () => ({ worker: fakeWorker({ fail: (m) => m.type === 'erase' }), url: '' }) });
    host.reset(g);
    await host.synced();
    assert.equal(host.kind, 'worker');
    host.erase(0.5, 0.5, 0.1);
    await until(() => host.kind === 'main');
    assert.equal(restarts, 1);
    assert.equal(host.view.n, 900);
    host.dispose();
  });
});
