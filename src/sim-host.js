// Main-thread side of the simulation.
//
// createSimHost() runs the World in a Web Worker (src/sim-worker.js), so a
// dense world that costs 5-17 ms a step slows the simulation instead of the
// page. The host keeps the latest frame the worker sent as `view` (n, S, x, y,
// species, id, steps, rMax): the renderer draws it and nearest() searches it,
// so a click is answered from what is on screen at once, and the worker is
// then told which particle (by stable id) to follow. Every edit becomes a
// command message, applied by the worker in order.
//
// When a Worker cannot be created, or fails before it is ready, the same
// commands run on a SimDriver on this thread instead (the commands already
// sent are replayed into it, so nothing is lost), stepped from the frame loop
// under the old budget of at most 4 steps and about 14 ms a frame. Either
// way the host offers one interface, documented at the end of createSimHost.
//
// The published single file cannot load src/sim-worker.js, so tools/build.mjs
// bundles the worker and writes its source into INLINE_WORKER_SOURCE; the
// worker then starts from a Blob URL.

import { createStats, nearestIndex } from './sim.js';
import { SimDriver, frameTransfer, unpackStats } from './sim-worker.js';

/** Replaced by tools/build.mjs with the bundled worker script; null when running from src/. */
const INLINE_WORKER_SOURCE = null;

/** Main-thread fallback: at most this many steps, and about this many ms of stepping, per frame. */
const LOCAL_MAX_STEPS = 4;
const LOCAL_BUDGET_MS = 14;

const noop = () => {};

/** Start the simulation worker: from the inlined source when built, else as a module next to this file. */
function spawnWorker() {
  if (typeof Worker !== 'function') return null;
  if (INLINE_WORKER_SOURCE) {
    const url = URL.createObjectURL(new Blob([INLINE_WORKER_SOURCE], { type: 'text/javascript' }));
    try {
      return { worker: new Worker(url), url };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }
  return { worker: new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' }), url: '' };
}

/**
 * @param {number} capacity maximum particle count
 * @param {object} [handlers]
 *   onTrack(path, count)   positions of the tracked particle after each step since the last call
 *                          (x, y interleaved; read them before returning)
 *   onTrackLost()          the tracked particle was erased or removed
 *   onCountEdited()        a seed or erase changed the particle count
 *   onSamples(samples)     statistics sampled during advance(), oldest first
 *   onRestart()            the worker failed after it started; the world is empty and must be reset
 * @param {object} [opts]   { createWorker() -> { worker, url } | null } replaces the Worker
 *                          constructor (tests). Optional extra.
 */
export function createSimHost(capacity, handlers = {}, opts = {}) {
  const on = {
    track: handlers.onTrack || noop,
    trackLost: handlers.onTrackLost || noop,
    countEdited: handlers.onCountEdited || noop,
    samples: handlers.onSamples || noop,
    restart: handlers.onRestart || noop,
  };

  let worker = null;
  let blobUrl = '';
  let driver = null;
  let ready = false;
  /** Commands sent before the worker said it was ready, replayed on this thread if it fails. */
  const backlog = [];
  /** seq -> { resolve, done, result }: requests waiting for their reply and for a frame that shows them. */
  const waiting = new Map();
  let seq = 0;
  let ack = 0;
  let stepAcc = 0;
  let stepCost = 4;
  const latest = createStats();
  let haveStats = false;

  // Tracking, by stable id. A frame says which particle it follows only once
  // it reflects the track command (ack >= trackSeq); until then it may still
  // show the previous one.
  let trackId = -1;
  let trackSeq = 0;
  let trackIndex = -1;
  let trackVx = 0;
  let trackVy = 0;

  /** The latest frame from the worker. Its arrays belong to this thread until a newer frame arrives. */
  const view = {
    n: 0,
    S: 2,
    x: new Float32Array(0),
    y: new Float32Array(0),
    species: new Uint8Array(0),
    id: new Uint32Array(0),
    steps: 0,
    rMax: 0,
  };
  let frameBuf = null;

  try {
    const spawned = (opts.createWorker || spawnWorker)();
    if (spawned) {
      worker = spawned.worker;
      blobUrl = spawned.url || '';
    }
  } catch (err) {
    worker = null;
    console.warn(`Tropism: no simulation worker (${err && err.message ? err.message : err}); simulating on the main thread.`);
  }
  if (worker) {
    worker.onmessage = (e) => receive(e.data);
    worker.onerror = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      fallBack(e);
    };
    worker.postMessage({ type: 'init', capacity });
  } else {
    driver = new SimDriver(capacity);
  }

  function revokeUrl() {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = '';
    }
  }

  function receive(m) {
    if (!m || !worker) return;
    if (m.type === 'frame') {
      onFrame(m);
    } else if (m.type === 'reply') {
      const w = waiting.get(m.seq);
      if (w) {
        w.done = true;
        w.result = m.result;
      }
      settle();
    } else if (m.type === 'ready') {
      ready = true;
      backlog.length = 0;
      revokeUrl();
    }
  }

  function onFrame(m) {
    // Keep the newest set and hand the previous one straight back.
    const prev = frameBuf;
    frameBuf = m.buf;
    if (prev) worker.postMessage({ type: 'release', buf: prev }, frameTransfer(prev));
    view.n = m.n;
    view.S = m.S;
    view.steps = m.steps;
    view.rMax = m.rMax;
    view.x = frameBuf.x;
    view.y = frameBuf.y;
    view.species = frameBuf.species;
    view.id = frameBuf.id;
    ack = m.ack;
    stepCost = m.stepCost;
    if (m.hasStats) {
      unpackStats(frameBuf.stats, latest);
      haveStats = true;
    }
    if (m.samples) on.samples(m.samples);

    trackIndex = -1;
    if (trackId >= 0 && ack >= trackSeq) {
      if (m.trackedId !== trackId) {
        trackId = -1;
        on.trackLost();
      } else {
        trackIndex = m.trackedIndex;
        trackVx = m.trackVx;
        trackVy = m.trackVy;
        if (m.trackCount > 0) on.track(frameBuf.track, m.trackCount);
      }
    }
    if (m.countEdited) on.countEdited();
    settle();
  }

  function settle() {
    for (const [s, w] of waiting) {
      if (w.done && ack >= s) {
        waiting.delete(s);
        w.resolve(w.result);
      }
    }
  }

  /** Deliver what the main-thread driver produced, as onFrame does for the worker's frames. */
  function afterLocal() {
    if (trackId >= 0 && driver.trackedId !== trackId) {
      trackId = -1;
      driver.trackCount = 0;
      on.trackLost();
    } else if (trackId >= 0 && driver.trackCount > 0) {
      on.track(driver.track, driver.trackCount);
    }
    driver.trackCount = 0;
    if (driver.countEdited) {
      driver.countEdited = false;
      on.countEdited();
    }
    if (driver.samples) {
      const s = driver.samples;
      driver.samples = null;
      on.samples(s);
    }
    driver.changed = false;
  }

  function fallBack(reason) {
    if (!worker) return;
    const replay = ready ? null : backlog.splice(0);
    try { worker.terminate(); } catch { /* already gone */ }
    worker = null;
    revokeUrl();
    frameBuf = null;
    driver = new SimDriver(capacity);
    stepAcc = 0;
    stepCost = 4;
    trackIndex = -1;
    const why = reason && reason.message ? ` (${reason.message})` : '';
    if (replay) {
      console.warn(`Tropism: the simulation worker did not start${why}; simulating on the main thread.`);
      for (const cmd of replay) {
        const result = driver.apply(cmd);
        const w = waiting.get(cmd.seq);
        if (w) {
          waiting.delete(cmd.seq);
          w.resolve(result);
        }
      }
      afterLocal();
    } else {
      console.error(`Tropism: the simulation worker stopped${why}; restarting the world on the main thread.`);
      for (const w of waiting.values()) w.resolve(null);
      waiting.clear();
      trackId = -1;
      afterLocal();
      on.restart();
    }
  }

  function send(msg) {
    seq += 1;
    msg.seq = seq;
    if (worker) {
      worker.postMessage(msg);
      if (!ready && msg.type !== 'tick') backlog.push(msg);
      return undefined;
    }
    const result = driver.apply(msg);
    afterLocal();
    return result;
  }

  /** Send a command that has a reply; resolves once the dish shows its effect. */
  function request(msg) {
    if (!worker) return Promise.resolve(send(msg));
    return new Promise((resolve) => {
      send(msg);
      waiting.set(msg.seq, { resolve, done: false, result: undefined });
    });
  }

  function tick(credit) {
    const c = Number(credit);
    if (!(c > 0)) return;
    stepAcc += c;
    if (worker) {
      const whole = Math.floor(stepAcc);
      if (whole >= 1) {
        stepAcc -= whole;
        send({ type: 'tick', steps: whole });
      }
      return;
    }
    // The frame loop as it was before the worker: never spend more than ~14 ms
    // of a frame on physics, so a dense world slows down instead of stuttering.
    let steps = 0;
    const t0 = performance.now();
    while (stepAcc >= 1 && steps < LOCAL_MAX_STEPS && (steps === 0 || performance.now() - t0 < LOCAL_BUDGET_MS)) {
      driver.stepOnce();
      stepAcc -= 1;
      steps += 1;
    }
    if (stepAcc > LOCAL_MAX_STEPS) stepAcc = 0;
    if (steps) {
      stepCost = stepCost * 0.95 + ((performance.now() - t0) / steps) * 0.05;
      afterLocal();
    }
  }

  return {
    /** 'worker' while the worker runs the world, 'main' on the fallback. */
    get kind() { return worker ? 'worker' : 'main'; },
    /** The particles to draw: { n, S, x, y, species, id, steps, rMax } (renderer.draw takes it as the world). */
    get view() { return worker ? view : driver.world; },
    /** Smoothed cost of one simulation step, in ms. */
    get stepCost() { return stepCost; },
    /** True from track(id) until tracking stops or the particle is lost. */
    get tracking() { return trackId >= 0; },

    reset(genome) { send({ type: 'reset', genome }); },
    setMatrix(matrix) { send({ type: 'matrix', matrix }); },
    setParams(params) { send({ type: 'params', params }); },
    setCount(n, seed) { send({ type: 'count', n, seed }); },
    setSpecies(S, matrix, seed) { send({ type: 'species', S, matrix, seed }); },
    stir(x, y, radius, dvx, dvy) { send({ type: 'stir', x, y, radius, dvx, dvy }); },
    /** Seed up to `count` particles in a disc; positions from mulberry32(rngSeed). */
    seed(x, y, radius, speciesIndex, count, rngSeed) {
      send({ type: 'seed', x, y, radius, species: speciesIndex, count, rng: rngSeed >>> 0 });
    },
    erase(x, y, radius) { send({ type: 'erase', x, y, radius }); },

    /** Index into `view` of the particle nearest (x, y), as World#nearest; answered on this thread. */
    nearest(x, y, maxDist) {
      const v = this.view;
      return nearestIndex(v.x, v.y, v.n, x, y, maxDist);
    },
    /** Follow the particle with this stable id (view.id[i]); -1 stops. */
    track(id) {
      trackId = Number.isInteger(id) && id >= 0 ? id : -1;
      trackIndex = -1;
      send({ type: 'track', id: trackId });
      trackSeq = seq;
    },
    /** Index into `view` of the tracked particle, or -1 (also until the worker has confirmed it). */
    trackedIndex() {
      if (!worker) return driver.world.trackedIndex();
      return trackId >= 0 ? trackIndex : -1;
    },
    /** Speed of the tracked particle in r_max per second, as of `view`. */
    trackedSpeed() {
      if (!worker) {
        const w = driver.world;
        const i = w.trackedIndex();
        return i >= 0 && w.rMax > 0 ? Math.hypot(w.vx[i], w.vy[i]) / w.rMax : 0;
      }
      return trackIndex >= 0 && view.rMax > 0 ? Math.hypot(trackVx, trackVy) / view.rMax : 0;
    },

    setRunning(running) { send({ type: 'run', on: Boolean(running) }); },
    /** Step credit for one display frame (fractional; steps per frame at the current speed). */
    tick,
    /** The latest statistics (a reused object), or null before the first arrive. */
    stats() {
      if (!worker) return driver.world.stats(latest);
      return haveStats ? latest : null;
    },

    /** Step now, sampling statistics every `every` steps (onSamples). Resolves to { steps, agg, speed }. */
    advance(steps, every = 5) { return request({ type: 'advance', steps, every }); },
    /** Time `steps` steps of the live world. Resolves to { msPerStep, n }. */
    bench(steps = 120) { return request({ type: 'bench', steps }); },
    /** Resolves once the view reflects every command sent so far. */
    synced() { return request({ type: 'sync' }); },

    dispose() {
      if (worker) {
        try { worker.terminate(); } catch { /* already gone */ }
        worker = null;
        revokeUrl();
      }
      for (const w of waiting.values()) w.resolve(null);
      waiting.clear();
      if (!driver) driver = new SimDriver(1);
    },
  };
}
