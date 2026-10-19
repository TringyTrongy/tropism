// Simulation worker for Tropism.
//
// The particle-life World runs here, off the main thread, so a dense world
// that costs 5-17 ms a step slows the simulation and never the page. The main
// thread (src/sim-host.js) turns every edit into a command; this side applies
// the commands in order, steps when the display has asked for steps, and
// answers with frames.
//
// Protocol
//   main -> worker  { type: 'init', capacity }                      first message
//                   { type, seq, ... }                               commands, see SimDriver#apply
//                   { type: 'release', buf }                         a frame buffer set handed back
//   worker -> main  { type: 'ready' }
//                   { type: 'frame', buf, n, S, steps, rMax, ack, ... }   see SimDriver#writeFrame
//                   { type: 'reply', seq, result }                   for advance, bench and sync
//
// Every command carries a sequence number and every frame reports `ack`, the
// last one applied, so the host can tell which of its commands a frame
// already shows. Frames ping-pong between two transferable buffer sets (x, y,
// species, id, the tracked particle's per-step positions, packed statistics):
// the worker fills a free set and transfers it, and the host hands its
// previous set back as soon as a newer one arrives. No SharedArrayBuffer: the
// published page is not cross-origin isolated.
//
// SimDriver holds all of the command logic. It is DOM-free, and the host also
// runs it on the main thread when a Worker cannot be created, so the world is
// the same either way. Imported anywhere but a worker, this module only exports.

import { World, DT, createStats } from './sim.js';
import { mulberry32 } from './genome.js';
import { SPECIES_MAX } from './markers.js';

/** Tracked-particle positions one frame can carry: one per step since the last frame. */
export const TRACK_MAX = 600;
/** Floats in packed statistics: steps, n, S, aggregationAll, meanSpeedAll, then count, meanSpeed, aggregation per species. */
export const STATS_LENGTH = 5 + 3 * SPECIES_MAX;
/** Whole steps the driver may owe the display; credit beyond this is dropped, so a slow world never spirals. */
export const MAX_OWED = 4;
/** Longest run of steps the worker takes before it reads its messages again, in ms. */
const SLICE_MS = 8;
/** Statistics ride on at most one frame in this many ms (about 10 Hz). */
const STATS_INTERVAL = 100;

/** Write a stats object (World#stats) into a Float64Array of STATS_LENGTH. */
export function packStats(st, out) {
  out[0] = st.steps;
  out[1] = st.n;
  out[2] = st.S;
  out[3] = st.aggregationAll;
  out[4] = st.meanSpeedAll;
  for (let s = 0; s < SPECIES_MAX; s++) {
    out[5 + s] = st.count[s];
    out[5 + SPECIES_MAX + s] = st.meanSpeed[s];
    out[5 + 2 * SPECIES_MAX + s] = st.aggregation[s];
  }
  return out;
}

/** Read packed statistics back into a stats object (reused if passed). Exact: every value survives the round trip. */
export function unpackStats(buf, out) {
  const st = out || createStats();
  st.steps = buf[0];
  st.n = buf[1];
  st.S = buf[2];
  st.aggregationAll = buf[3];
  st.meanSpeedAll = buf[4];
  for (let s = 0; s < SPECIES_MAX; s++) {
    st.count[s] = buf[5 + s];
    st.meanSpeed[s] = buf[5 + SPECIES_MAX + s];
    st.aggregation[s] = buf[5 + 2 * SPECIES_MAX + s];
  }
  return st;
}

/** One frame buffer set, sized for `capacity` particles. */
export function createFrameBuffers(capacity) {
  return {
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    species: new Uint8Array(capacity),
    id: new Uint32Array(capacity),
    track: new Float32Array(TRACK_MAX * 2),
    stats: new Float64Array(STATS_LENGTH),
  };
}

/** The transfer list for a frame buffer set. */
export function frameTransfer(buf) {
  return [buf.x.buffer, buf.y.buffer, buf.species.buffer, buf.id.buffer, buf.track.buffer, buf.stats.buffer];
}

function copyStats(st) {
  return {
    ...st,
    count: Float32Array.from(st.count),
    meanSpeed: Float32Array.from(st.meanSpeed),
    aggregation: Float32Array.from(st.aggregation),
  };
}

/**
 * A World plus the bookkeeping both sides of the protocol need: step credit,
 * tracking by stable id, the tracked particle's path since the last frame,
 * and what changed since then.
 */
export class SimDriver {
  /** @param {number} [capacity=12000] maximum particle count */
  constructor(capacity = 12000) {
    this.world = new World(capacity);
    /** While false, step credit is refused and any backlog is dropped. */
    this.running = true;
    /** Whole steps owed to the display (from tick commands), at most MAX_OWED. */
    this.owed = 0;
    /** Sequence number of the last command applied. */
    this.ack = 0;
    /** Smoothed wall-clock cost of one step, in ms. */
    this.stepCost = 4;
    /** Stable id of the tracked particle, or -1. */
    this.trackedId = -1;
    /** The tracked particle's position after each step since the last frame (x, y interleaved). */
    this.track = new Float32Array(TRACK_MAX * 2);
    this.trackCount = 0;
    /** A seed or erase changed the particle count since the last frame. */
    this.countEdited = false;
    /** Something a frame shows changed since the last frame. */
    this.changed = true;
    /** Statistics sampled by advance() since the last frame, or null. */
    this.samples = null;
    this.stats = createStats();
  }

  /**
   * Apply one command. Returns the reply for advance, bench and sync;
   * undefined for every other command.
   *
   *   reset { genome }                 World#reset; tracking stops
   *   matrix { matrix }                World#setMatrix
   *   params { params }                World#setParams
   *   count { n, seed }                World#setCount
   *   species { S, matrix, seed }      World#setSpecies
   *   stir { x, y, radius, dvx, dvy }  World#stir
   *   seed { x, y, radius, species, count, rng }   World#seed with mulberry32(rng)
   *   erase { x, y, radius }           World#erase
   *   track { id }                     follow the particle with this stable id; -1 stops
   *   run { on }                       pause (drops owed steps) or resume
   *   tick { steps }                   step credit from one display frame
   *   advance { steps, every }         step now, sampling statistics every `every` steps
   *   bench { steps }                  time `steps` steps
   *   sync {}                          no-op that answers once applied
   */
  apply(msg) {
    const w = this.world;
    let result;
    let visible = true;
    switch (msg.type) {
      case 'reset':
        w.reset(msg.genome);
        this.trackedId = -1;
        this.trackCount = 0;
        break;
      case 'matrix': w.setMatrix(msg.matrix); break;
      case 'params': w.setParams(msg.params); break;
      case 'count':
        w.setCount(msg.n, msg.seed);
        this.#checkTracked();
        break;
      case 'species': w.setSpecies(msg.S, msg.matrix, msg.seed); break;
      case 'stir': w.stir(msg.x, msg.y, msg.radius, msg.dvx, msg.dvy); break;
      case 'seed':
        if (w.seed(msg.x, msg.y, msg.radius, msg.species, msg.count, mulberry32(Number(msg.rng) >>> 0)) > 0) {
          this.countEdited = true;
        }
        break;
      case 'erase':
        if (w.erase(msg.x, msg.y, msg.radius) > 0) {
          this.countEdited = true;
          this.#checkTracked();
        }
        break;
      case 'track': this.#track(msg.id); break;
      case 'run':
        this.running = Boolean(msg.on);
        if (!this.running) this.owed = 0;
        visible = false;
        break;
      case 'tick': {
        const k = Math.floor(Number(msg.steps));
        if (this.running && k > 0) this.owed = Math.min(MAX_OWED, this.owed + k);
        visible = false;
        break;
      }
      case 'advance': result = this.advance(msg.steps, msg.every); break;
      case 'bench': result = this.bench(msg.steps); break;
      case 'sync': result = { steps: w.steps }; break;
      default: return undefined;
    }
    if (msg.seq > this.ack) this.ack = msg.seq;
    if (visible) this.changed = true;
    return result;
  }

  /** One integration step; records the tracked particle's new position. */
  stepOnce() {
    const w = this.world;
    w.step(DT);
    const ti = w.trackedIndex();
    if (ti >= 0) this.#pushTrack(w.x[ti], w.y[ti]);
    this.changed = true;
  }

  /** Take owed steps for up to sliceMs (always at least one when any is owed). Returns the steps taken. */
  pump(sliceMs = SLICE_MS) {
    if (!this.running || this.owed < 1) return 0;
    const t0 = performance.now();
    let steps = 0;
    while (this.owed >= 1 && (steps === 0 || performance.now() - t0 < sliceMs)) {
      this.stepOnce();
      this.owed -= 1;
      steps += 1;
    }
    this.stepCost = this.stepCost * 0.95 + ((performance.now() - t0) / steps) * 0.05;
    return steps;
  }

  /** Step `steps` times now, sampling statistics every `every` steps (as the live loop samples them). */
  advance(steps, every = 5) {
    const w = this.world;
    const count = Math.max(0, Math.floor(Number(steps)) || 0);
    const k = Math.max(0, Math.floor(Number(every)) || 0);
    for (let s = 0; s < count; s++) {
      this.stepOnce();
      if (k > 0 && w.steps % k === 0) (this.samples || (this.samples = [])).push(copyStats(w.stats(this.stats)));
    }
    const st = w.stats(this.stats);
    return { steps: w.steps, agg: st.aggregationAll, speed: st.meanSpeedAll };
  }

  /** Time `steps` steps of the live world. */
  bench(steps = 120) {
    const w = this.world;
    const count = Math.max(1, Math.floor(Number(steps)) || 1);
    const t0 = performance.now();
    for (let s = 0; s < count; s++) w.step(DT);
    this.changed = true;
    return { msPerStep: (performance.now() - t0) / count, n: w.n };
  }

  /**
   * Copy the live particles into a frame buffer set and return the frame's
   * header; statistics are packed into buf.stats when `withStats`. Clears the
   * per-frame state (path since the last frame, countEdited, samples).
   *
   * header: { n, S, steps, rMax, ack, stepCost, trackedId, trackedIndex,
   *           trackVx, trackVy, trackCount, countEdited, hasStats, samples }
   */
  writeFrame(buf, withStats) {
    const w = this.world;
    const n = w.n;
    buf.x.set(w.x.subarray(0, n));
    buf.y.set(w.y.subarray(0, n));
    buf.species.set(w.species.subarray(0, n));
    buf.id.set(w.id.subarray(0, n));
    const tc = this.trackCount;
    if (tc > 0) buf.track.set(this.track.subarray(0, tc * 2));
    if (withStats) packStats(w.stats(this.stats), buf.stats);
    const ti = w.trackedIndex();
    const header = {
      n,
      S: w.S,
      steps: w.steps,
      rMax: w.rMax,
      ack: this.ack,
      stepCost: this.stepCost,
      trackedId: this.trackedId,
      trackedIndex: ti,
      trackVx: ti >= 0 ? w.vx[ti] : 0,
      trackVy: ti >= 0 ? w.vy[ti] : 0,
      trackCount: tc,
      countEdited: this.countEdited,
      hasStats: Boolean(withStats),
      samples: this.samples,
    };
    this.trackCount = 0;
    this.countEdited = false;
    this.samples = null;
    this.changed = false;
    return header;
  }

  #track(id) {
    const w = this.world;
    let idx = -1;
    if (Number.isInteger(id) && id >= 0) {
      const ids = w.id;
      for (let i = 0, n = w.n; i < n; i++) {
        if (ids[i] === id) { idx = i; break; }
      }
    }
    w.track(idx);
    this.trackedId = idx >= 0 ? id : -1;
    this.trackCount = 0;
  }

  /** After a removal: forget the tracked particle if it went. */
  #checkTracked() {
    if (this.trackedId >= 0 && this.world.trackedIndex() < 0) {
      this.trackedId = -1;
      this.trackCount = 0;
    }
  }

  #pushTrack(x, y) {
    const t = this.track;
    if (this.trackCount === TRACK_MAX) {
      t.copyWithin(0, 2);
      this.trackCount -= 1;
    }
    t[this.trackCount * 2] = x;
    t[this.trackCount * 2 + 1] = y;
    this.trackCount += 1;
  }
}

/**
 * Answer the protocol on `scope` (the worker's global scope, or any object
 * with postMessage and an onmessage slot). Returns { close() }.
 */
export function serve(scope) {
  let driver = null;
  const pool = [];
  let statsAt = -Infinity;
  let statsOwed = true;
  let statsTimer = 0;
  // Yield between slices through a MessageChannel: unlike a chain of
  // setTimeout(0), it is never clamped to 4 ms.
  const wake = new MessageChannel();
  // Under Node (tests) an open port would keep the process alive; browsers have no unref.
  if (typeof wake.port1.unref === 'function') wake.port1.unref();
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    wake.port2.postMessage(0);
  };

  function flush() {
    if (!driver || !driver.changed) return;
    statsOwed = true;
    if (pool.length === 0) return; // the host holds both sets; its release flushes again
    const now = performance.now();
    const withStats = now - statsAt >= STATS_INTERVAL;
    const buf = pool.pop();
    const frame = driver.writeFrame(buf, withStats);
    if (withStats) {
      statsAt = now;
      statsOwed = false;
    }
    frame.type = 'frame';
    frame.buf = buf;
    scope.postMessage(frame, frameTransfer(buf));
    // A paused dish may not send another frame for a while: make sure the
    // statistics of this change still arrive.
    if (statsOwed && !statsTimer) {
      statsTimer = setTimeout(() => {
        statsTimer = 0;
        if (driver && statsOwed) {
          driver.changed = true;
          flush();
        }
      }, Math.max(0, STATS_INTERVAL - (now - statsAt)));
    }
  }

  scope.onmessage = (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'init') {
      driver = new SimDriver(msg.capacity);
      pool.length = 0;
      pool.push(createFrameBuffers(driver.world.capacity), createFrameBuffers(driver.world.capacity));
      scope.postMessage({ type: 'ready' });
      return;
    }
    if (!driver) return;
    if (msg.type === 'release') {
      if (msg.buf && msg.buf.x && msg.buf.x.length === driver.world.capacity && pool.length < 2) pool.push(msg.buf);
      flush();
      return;
    }
    const result = driver.apply(msg);
    if (result !== undefined) {
      flush();
      scope.postMessage({ type: 'reply', seq: msg.seq, result });
    }
    schedule();
  };

  wake.port1.onmessage = () => {
    scheduled = false;
    if (!driver) return;
    driver.pump(SLICE_MS);
    flush();
    if (driver.running && driver.owed >= 1) schedule();
  };

  return {
    close() {
      clearTimeout(statsTimer);
      wake.port1.onmessage = null;
      wake.port1.close();
      wake.port2.close();
      scope.onmessage = null;
    },
  };
}

if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  serve(self);
}
