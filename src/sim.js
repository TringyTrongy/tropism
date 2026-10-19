// Particle-life engine for Tropism.
//
// The world is a unit torus. Each particle of species i feels, from every
// particle of species j within rMax, the force F(r, a_ij) along the unit vector
// toward it (r in units of rMax):
//
//   F(r, a) = r/beta - 1                              r < beta      universal repulsive core
//           = a (1 - |2r - 1 - beta| / (1 - beta))    beta <= r < 1 affinity hump, peak a at (1+beta)/2
//           = 0                                       r >= 1
//
// Integration (fixed dt), two passes so the result never depends on order:
//   1. for every particle, from the current positions:
//        acc = rMax * force * sum F * unit,  v = v * 0.5^(dt/halfLife) + acc * dt
//   2. for every particle: x = wrap(x + v * dt)
//
// Neighbour search uses a uniform grid whose cells are at least rMax wide, so
// every interacting pair lies in a 3 x 3 block of cells. Each step the
// particles are counting-sorted by cell into flat scratch arrays (positions and
// species copied in cell order, so the inner loop streams contiguous memory);
// the public particle arrays are never permuted, which keeps indices, ids and
// the tracked particle stable. Each pair is visited once (a half-shell of the
// 3 x 3 block) and the force is applied to both members with their own
// affinities. Statistics are accumulated inside the same loop.
//
// Pure module: no DOM, no allocation per step; runs in Node and the browser.

import { mulberry32, defaultParams } from './genome.js';
import { SPECIES_MIN, SPECIES_MAX } from './markers.js';

// Simulated seconds per step. Small enough that motion stays smooth when the page plays the
// dish in slow motion (a tenth of real time by default), and the integration is more accurate.
export const DT = 0.004;

/**
 * The force law, F(r, a) for r = distance / rMax.
 * Exported for tests and for panel c.
 */
export function forceLaw(r, a, beta) {
  if (r < beta) return r / beta - 1;
  if (r < 1) return a * (1 - Math.abs(2 * r - 1 - beta) / (1 - beta));
  return 0;
}

/**
 * Index of the point nearest (x, y) by torus distance among the first n
 * entries of xs / ys, within maxDist (inclusive); or -1. An omitted, null or
 * NaN maxDist means no limit; a negative one matches nothing.
 * World#nearest is this over the live particles; the main thread runs it over
 * the latest frame from the simulation worker.
 */
export function nearestIndex(xs, ys, n, x, y, maxDist = Infinity) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  let limit = maxDist == null ? Infinity : Number(maxDist);
  if (Number.isNaN(limit)) limit = Infinity;
  if (limit < 0) return -1;
  let best2 = limit * limit;
  let best = -1;
  const count = Math.min(n | 0, xs.length, ys.length);
  for (let i = 0; i < count; i++) {
    let dx = xs[i] - x; dx -= Math.round(dx);
    let dy = ys[i] - y; dy -= Math.round(dy);
    const d2 = dx * dx + dy * dy;
    if (d2 < best2 || (d2 === best2 && best < 0)) {
      best2 = d2;
      best = i;
    }
  }
  return best;
}

/**
 * A fresh, zeroed stats object of the shape World#stats() fills.
 * For callers that preallocate.
 */
export function createStats() {
  return {
    steps: 0,
    n: 0,
    S: 0,
    count: new Float32Array(SPECIES_MAX),
    meanSpeed: new Float32Array(SPECIES_MAX),
    aggregation: new Float32Array(SPECIES_MAX),
    aggregationAll: 0,
    meanSpeedAll: 0,
  };
}

// Physical validity ranges enforced by the engine (wider than the UI limits in
// genome.js PARAM_LIMITS). rMax <= 1/3 keeps at least three cells per side so
// the 3 x 3 neighbourhood never visits a cell twice; beta stays inside (0, 1)
// so neither branch of the force law divides by zero; force and halfLife are
// bounded so no finite input can overflow a velocity.
const RMAX_MIN = 0.005;
const RMAX_MAX = 1 / 3;
const BETA_MIN = 0.01;
const BETA_MAX = 0.99;
const HALFLIFE_MIN = 1e-4;
const HALFLIFE_MAX = 1e3;
const FORCE_MIN = 0;
const FORCE_MAX = 1e3;
const SEED_RADIUS_MIN = 1e-4;
const MATRIX_SLOTS = SPECIES_MAX * SPECIES_MAX;
/** Slot ranges per cell in the half-shell: own cell (+ east), wrapped east, two runs in the next row. */
const MAX_RANGES = 4;

/** Wrap a coordinate into [0, 1) as it will be stored in a Float32Array. */
function wrapUnit(v) {
  let w = v - Math.floor(v);
  w = Math.fround(w);
  // A double just below 1 can round up to 1.0 in float32; that point is on the seam.
  return w >= 1 ? 0 : w;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampSpecies(S) {
  const v = Math.round(Number(S));
  return Number.isFinite(v) ? clamp(v, SPECIES_MIN, SPECIES_MAX) : SPECIES_MIN;
}

/**
 * murmur3's 32-bit finaliser over seed ^ (salt + 1) * golden ratio: a uint32
 * sub-seed that is decorrelated from `seed` itself and from every other salt.
 */
function mixSeed(seed, salt) {
  let h = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export class World {
  // --- scratch for the grid and the step loop (allocated once) -------------
  /** cell index of each particle (by particle index) */
  #cellOf;
  /** particle index at each sorted slot */
  #order;
  /** positions and species copied in cell order */
  #sx; #sy; #ss;
  /** force sums per sorted slot (pairs write to both members) */
  #sfx; #sfy;
  /** first sorted slot of each cell; length >= cells + 1, [cells] = n */
  #cellStart;
  /** neighbour ranges of the current cell: sorted slot bounds and image offsets */
  #rq0; #rq1; #rox; #roy;
  /** per step copies of the S*S tables the pair loop reads: a_ij, a_ji, [i == j] */
  #aff = new Float64Array(MATRIX_SLOTS);
  #affT = new Float64Array(MATRIX_SLOTS);
  #sameTable = new Float64Array(MATRIX_SLOTS);

  // --- statistics accumulated by the last measurement -----------------------
  #countS = new Float64Array(SPECIES_MAX);
  #speedS = new Float64Array(SPECIES_MAX);
  #sameS = new Float64Array(SPECIES_MAX);
  #allNeighbours = 0;
  #speedAll = 0;
  #measuredN = 0;
  #measuredRMax = 0;
  /** set by anything that changes the particle set or rMax; stats() re-measures */
  #statsDirty = true;

  #nextId = 0;
  #tracked = -1;
  #fallbackSeed = 0x2545f491;

  /**
   * @param {number} [capacity=12000] maximum particle count; every typed array
   *   is allocated once at this size
   */
  constructor(capacity = 12000) {
    const cap = Math.max(1, Math.floor(Number(capacity)) || 1);
    /** Maximum particle count (read-only). */
    this.capacity = cap;

    this.n = 0;
    this.S = SPECIES_MIN;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.species = new Uint8Array(cap);
    this.id = new Uint32Array(cap);
    this.steps = 0;

    const d = defaultParams();
    this.rMax = d.rMax;
    this.halfLife = d.halfLife;
    this.force = d.force;
    this.beta = d.beta;
    this.matrix = new Float32Array(MATRIX_SLOTS);
    /** Grid cells per side for the current rMax (read-only). Optional extra. */
    this.cellsPerSide = 0;

    this.#cellOf = new Int32Array(cap);
    this.#order = new Int32Array(cap);
    this.#sx = new Float64Array(cap);
    this.#sy = new Float64Array(cap);
    this.#ss = new Uint8Array(cap);
    this.#sfx = new Float64Array(cap);
    this.#sfy = new Float64Array(cap);
    this.#cellStart = new Int32Array(1);
    this.#rq0 = new Int32Array(MAX_RANGES);
    this.#rq1 = new Int32Array(MAX_RANGES);
    this.#rox = new Float64Array(MAX_RANGES);
    this.#roy = new Float64Array(MAX_RANGES);

    this.#sizeGrid();
  }

  // -------------------------------------------------------------------------
  // Configuration

  /**
   * Rebuild the world from a genome: uniform positions from
   * mulberry32(genome.seed) (x then y per particle), species i % S, zero
   * velocity, n = min(genome.params.n, capacity), steps = 0, tracking off.
   * A missing or non-numeric parameter takes its default, never the value
   * left over from the previous world, so a reset depends on the genome only.
   */
  reset(genome) {
    const S = clampSpecies(genome.species);
    const src = genome.params && typeof genome.params === 'object' ? genome.params : {};
    const params = defaultParams();
    for (const key of Object.keys(params)) {
      const v = src[key] == null ? NaN : Number(src[key]);
      if (Number.isFinite(v)) params[key] = v;
    }
    this.S = S;
    this.#loadMatrix(genome.matrix, S);
    this.#applyParams(params);

    const n = clamp(Math.floor(Number(params.n)) || 0, 0, this.capacity);
    const rng = mulberry32(Number(genome.seed) >>> 0);
    const X = this.x, Y = this.y, VX = this.vx, VY = this.vy, SP = this.species, ID = this.id;
    for (let i = 0; i < n; i++) {
      X[i] = wrapUnit(rng());
      Y[i] = wrapUnit(rng());
      VX[i] = 0;
      VY[i] = 0;
      SP[i] = i % S;
      ID[i] = i;
    }
    this.n = n;
    this.#nextId = n;
    this.steps = 0;
    this.#tracked = -1;
    this.#statsDirty = true;
  }

  /** Replace the affinity table live (row-major S*S, current S). */
  setMatrix(matrixArray) {
    this.#loadMatrix(matrixArray, this.S);
  }

  /** Change rMax / halfLife / force / beta live. Unknown keys are ignored. */
  setParams(partial) {
    if (partial) this.#applyParams(partial);
  }

  /**
   * Grow or shrink the population live. New particles get uniform positions,
   * species i % S and zero velocity; shrinking removes from the end (a
   * tracked particle removed this way stops being tracked).
   *
   * Positions are deterministic from `seed` and the first new index: the
   * stream is mulberry32(mixSeed(seed, n0)), so repeated growth with the same
   * seed (a caption scrub dragged 5000 -> 5100 -> 5200) places every batch
   * somewhere new instead of stacking each batch exactly on the last one, and
   * no batch replays the stream reset() used for the initial layout.
   */
  setCount(n, seed) {
    const want = Number(n);
    if (!Number.isFinite(want)) return;
    const target = clamp(Math.floor(want), 0, this.capacity);
    const n0 = this.n;
    if (target > n0) {
      const rng = mulberry32(mixSeed(Number(seed) >>> 0, n0));
      const S = this.S;
      for (let i = n0; i < target; i++) {
        this.x[i] = wrapUnit(rng());
        this.y[i] = wrapUnit(rng());
        this.vx[i] = 0;
        this.vy[i] = 0;
        this.species[i] = i % S;
        this.id[i] = this.#nextId++;
      }
    } else if (target < n0 && this.#tracked >= target) {
      this.#tracked = -1;
    }
    if (target !== n0) {
      this.n = target;
      this.#statsDirty = true;
    }
  }

  /**
   * Change the species count live and load the new S*S matrix.
   * Shrinking: particles whose species is >= S become species i % S.
   * Growing: each particle independently joins one of the new species with
   * probability (S - S_old) / S, so the newcomers start inside the existing
   * structures at their fair share. The draws are deterministic from `seed`
   * and the transition (S_old -> S): growing 3 -> 4 -> 5 with one seed gives
   * every species a fair share, where one shared stream would make the 4 -> 5
   * step take its recruits almost only from the species the 3 -> 4 step made.
   */
  setSpecies(S, matrixArray, seed) {
    const S1 = clampSpecies(S);
    const S0 = this.S;
    const SP = this.species;
    const n = this.n;
    if (S1 < S0) {
      for (let i = 0; i < n; i++) if (SP[i] >= S1) SP[i] = i % S1;
    } else if (S1 > S0) {
      const rng = mulberry32(mixSeed(Number(seed) >>> 0, 0x10000 + S0 * 16 + S1));
      for (let i = 0; i < n; i++) {
        const k = Math.min(S1 - 1, Math.floor(rng() * S1));
        if (k >= S0) SP[i] = k;
      }
    }
    this.S = S1;
    this.#loadMatrix(matrixArray, S1);
    this.#statsDirty = true;
  }

  // -------------------------------------------------------------------------
  // Integration

  /** Advance one step: grid, forces and velocities, then positions. */
  step(dt = DT) {
    let h = Number(dt);
    if (!Number.isFinite(h) || h < 0) h = DT;
    this.#interact(h, true);
    this.#advance(h);
    this.steps++;
  }

  // -------------------------------------------------------------------------
  // Direct manipulation (world units, wrap-aware)

  /**
   * Add up to `count` particles uniformly inside a disc, with zero velocity.
   * `speciesIndex` in [0, S) gives them that species; any other value (e.g. -1)
   * deals species round-robin by index (i % S). Positions come from `rng`
   * (() => float in [0, 1)). Stops at capacity. Returns the number added.
   */
  seed(x, y, radius, speciesIndex, count, rng) {
    const want = Math.min(this.capacity - this.n, Math.max(0, Math.floor(Number(count)) || 0));
    if (want <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const rad = Math.max(SEED_RADIUS_MIN, Number.isFinite(radius) ? Math.abs(radius) : 0);
    let random = rng;
    if (typeof random !== 'function') {
      this.#fallbackSeed = (this.#fallbackSeed + 0x9e3779b9) >>> 0;
      random = mulberry32(this.#fallbackSeed ^ this.steps);
    }
    const S = this.S;
    const fixed = Number.isInteger(speciesIndex) && speciesIndex >= 0 && speciesIndex < S;
    const n0 = this.n;
    for (let k = 0; k < want; k++) {
      const i = n0 + k;
      // sqrt of a uniform radius fraction gives uniform density over the disc
      const rr = rad * Math.sqrt(random());
      const th = 2 * Math.PI * random();
      this.x[i] = wrapUnit(x + rr * Math.cos(th));
      this.y[i] = wrapUnit(y + rr * Math.sin(th));
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.species[i] = fixed ? speciesIndex : i % S;
      this.id[i] = this.#nextId++;
    }
    this.n = n0 + want;
    this.#statsDirty = true;
    return want;
  }

  /**
   * Remove every particle strictly inside the disc. Each removal moves the
   * last live particle into the hole (ids travel with their particle); the
   * tracked index follows a moved particle and becomes -1 if it is removed.
   * Returns the number removed.
   */
  erase(x, y, radius) {
    if (!(radius > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const r2 = radius * radius;
    const X = this.x, Y = this.y, VX = this.vx, VY = this.vy, SP = this.species, ID = this.id;
    let n = this.n;
    let removed = 0;
    // Walking downward means every particle above i has already been tested
    // and kept, so the one swapped into slot i never needs re-testing.
    for (let i = n - 1; i >= 0; i--) {
      let dx = X[i] - x; dx -= Math.round(dx);
      let dy = Y[i] - y; dy -= Math.round(dy);
      if (dx * dx + dy * dy >= r2) continue;
      const last = n - 1;
      if (this.#tracked === i) this.#tracked = -1;
      else if (this.#tracked === last) this.#tracked = i;
      if (i !== last) {
        X[i] = X[last]; Y[i] = Y[last];
        VX[i] = VX[last]; VY[i] = VY[last];
        SP[i] = SP[last]; ID[i] = ID[last];
      }
      n--;
      removed++;
    }
    if (removed > 0) {
      this.n = n;
      this.#statsDirty = true;
    }
    return removed;
  }

  /**
   * Add a velocity impulse (dvx, dvy) to particles inside the disc, weighted
   * by the smooth falloff (1 - d/radius)^2: full at the centre, zero at the rim.
   */
  stir(x, y, radius, dvx, dvy) {
    if (!(radius > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!Number.isFinite(dvx) || !Number.isFinite(dvy)) return;
    const r2 = radius * radius;
    const inv = 1 / radius;
    const X = this.x, Y = this.y, VX = this.vx, VY = this.vy;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      let dx = X[i] - x; dx -= Math.round(dx);
      let dy = Y[i] - y; dy -= Math.round(dy);
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      let w = 1 - Math.sqrt(d2) * inv;
      w *= w;
      VX[i] += dvx * w;
      VY[i] += dvy * w;
    }
  }

  /**
   * Index of the particle nearest (x, y) by torus distance, within maxDist
   * (inclusive); or -1. An omitted, null or NaN maxDist means no limit; a
   * negative one matches nothing.
   */
  nearest(x, y, maxDist = Infinity) {
    return nearestIndex(this.x, this.y, this.n, x, y, maxDist);
  }

  /** Start tracking the particle at `index`; -1 (or any invalid index) stops. */
  track(index) {
    this.#tracked = Number.isInteger(index) && index >= 0 && index < this.n ? index : -1;
  }

  /** Current index of the tracked particle, or -1 if none or it was removed. */
  trackedIndex() {
    return this.#tracked;
  }

  // -------------------------------------------------------------------------
  // Statistics

  /**
   * Fill `out` (or a new object) with statistics from the most recent step.
   * If the particle set or rMax changed since then (seed, erase, reset, ...),
   * the neighbour statistics are re-measured from the current positions first,
   * without advancing the simulation.
   *
   * count[s]        particles of species s
   * meanSpeed[s]    mean |v| of species s, in rMax per second
   * aggregation[s]  mean same-species neighbours within rMax divided by the
   *                 uniform-gas expectation (count_s - 1) * pi * rMax^2;
   *                 1 = well mixed, > 1 = clustered, 0 when count_s < 2
   * aggregationAll, meanSpeedAll: the same over all particles
   */
  stats(out) {
    if (this.#statsDirty) this.#interact(0, false);
    const o = out || createStats();
    o.steps = this.steps;
    o.n = this.n;
    o.S = this.S;
    const rMax = this.#measuredRMax;
    const disc = Math.PI * rMax * rMax;
    const invR = rMax > 0 ? 1 / rMax : 0;
    for (let s = 0; s < SPECIES_MAX; s++) {
      const c = this.#countS[s];
      o.count[s] = c;
      o.meanSpeed[s] = c > 0 ? (this.#speedS[s] / c) * invR : 0;
      o.aggregation[s] = c > 1 ? this.#sameS[s] / c / ((c - 1) * disc) : 0;
    }
    const n = this.#measuredN;
    o.meanSpeedAll = n > 0 ? (this.#speedAll / n) * invR : 0;
    o.aggregationAll = n > 1 ? this.#allNeighbours / n / ((n - 1) * disc) : 0;
    return o;
  }

  // -------------------------------------------------------------------------
  // Internals

  #loadMatrix(src, S) {
    const M = this.matrix;
    M.fill(0);
    if (!src) return;
    const len = Math.min(S * S, src.length);
    for (let k = 0; k < len; k++) {
      const v = Number(src[k]);
      M[k] = Number.isFinite(v) ? v : 0;
    }
  }

  #applyParams(p) {
    if ('rMax' in p && Number.isFinite(Number(p.rMax))) {
      const r = clamp(Number(p.rMax), RMAX_MIN, RMAX_MAX);
      if (r !== this.rMax) {
        this.rMax = r;
        this.#sizeGrid();
        this.#statsDirty = true;
      }
    }
    if ('halfLife' in p && Number.isFinite(Number(p.halfLife))) {
      this.halfLife = clamp(Number(p.halfLife), HALFLIFE_MIN, HALFLIFE_MAX);
    }
    if ('force' in p && Number.isFinite(Number(p.force))) {
      this.force = clamp(Number(p.force), FORCE_MIN, FORCE_MAX);
    }
    if ('beta' in p && Number.isFinite(Number(p.beta))) {
      this.beta = clamp(Number(p.beta), BETA_MIN, BETA_MAX);
    }
  }

  /** cellsPerSide = max(3, floor(1/rMax)), backed off if rounding made cells narrower than rMax. */
  #sizeGrid() {
    let C = Math.max(3, Math.floor(1 / this.rMax));
    while (C > 3 && 1 / C < this.rMax) C--;
    this.cellsPerSide = C;
    if (this.#cellStart.length < C * C + 1) this.#cellStart = new Int32Array(C * C + 1);
  }

  /**
   * Bin particles into the grid, then visit every interacting pair once and
   * apply the force law in both directions: distance is symmetric even though
   * affinities are not, so each pair costs one distance test and at most one
   * square root. Velocities are updated afterwards (if `integrate`), and the
   * neighbour and speed statistics are accumulated along the way.
   * With integrate = false nothing in the simulation changes (a pure measurement).
   */
  #interact(dt, integrate) {
    const n = this.n;
    const countS = this.#countS, speedS = this.#speedS, sameS = this.#sameS;
    countS.fill(0);
    speedS.fill(0);
    sameS.fill(0);
    this.#measuredN = n;
    this.#measuredRMax = this.rMax;
    this.#statsDirty = false;
    if (n === 0) {
      this.#allNeighbours = 0;
      this.#speedAll = 0;
      return;
    }

    const X = this.x, Y = this.y, VX = this.vx, VY = this.vy, SP = this.species;
    const S = this.S;
    // Row-major tables indexed by si * S + sj, rebuilt from the public matrix
    // each call (S*S <= 64 entries) so they can never fall out of sync.
    const A = this.#aff, AT = this.#affT, SAME = this.#sameTable;
    const M = this.matrix;
    A.fill(0);
    AT.fill(0);
    SAME.fill(0);
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < S; j++) {
        A[i * S + j] = M[i * S + j];
        AT[i * S + j] = M[j * S + i];
        SAME[i * S + j] = i === j ? 1 : 0;
      }
    }
    const C = this.cellsPerSide;
    const cells = C * C;
    const cellOf = this.#cellOf, order = this.#order;
    const sx = this.#sx, sy = this.#sy, ss = this.#ss, sfx = this.#sfx, sfy = this.#sfy;
    const start = this.#cellStart;
    const rq0 = this.#rq0, rq1 = this.#rq1, rox = this.#rox, roy = this.#roy;

    // --- 1. counting sort by cell -------------------------------------------
    // Count into start[c], prefix-sum so start[c] is the END of cell c, then
    // place particles walking backward while decrementing: afterwards start[c]
    // is the beginning of cell c (a stable sort) and start[cells] = n.
    start.fill(0, 0, cells + 1);
    for (let i = 0; i < n; i++) {
      let cx = (X[i] * C) | 0;
      let cy = (Y[i] * C) | 0;
      if (cx >= C) cx = C - 1; else if (cx < 0) cx = 0;
      if (cy >= C) cy = C - 1; else if (cy < 0) cy = 0;
      const c = cy * C + cx;
      cellOf[i] = c;
      start[c]++;
    }
    for (let c = 1; c < cells; c++) start[c] += start[c - 1];
    start[cells] = n;
    for (let i = n - 1; i >= 0; i--) {
      const p = --start[cellOf[i]];
      order[p] = i;
      sx[p] = X[i];
      sy[p] = Y[i];
      ss[p] = SP[i];
      sfx[p] = 0;
      sfy[p] = 0;
    }

    // --- 2. pair forces over a half-shell neighbourhood ----------------------
    // Each cell meets itself and four forward neighbours (E, then SW, S, SE in
    // the next row); the other four are met from their side, so every pair of
    // particles is visited exactly once. C >= 3 makes the eight neighbours
    // distinct cells. Each range carries the image shift (-1, 0, +1) that
    // turns its coordinates into the minimum image relative to this cell.
    //
    // The force law is evaluated without data-dependent branches, which the
    // CPU cannot predict in a dense cluster. With rn = r / rMax,
    // ramp = rn/beta - 1 and tent = 1 - |2rn - 1 - beta| / (1 - beta):
    //   core = min(ramp, 0) = (ramp - |ramp|) / 2   (ramp below beta, exactly 0 above)
    //   hump = max(tent, 0) = (tent + |tent|) / 2   (exactly 0 below beta, tent above)
    //   F    = core + a * hump                      (forceLaw for r < 1, to rounding)
    // Math.abs compiles to a sign-bit mask; Math.min/max would not (they must
    // handle NaN and -0) and measured twice as slow here. The constant factors
    // are folded: ramp and tent are taken straight from r in world units, and
    // the two halvings ride on the one division that turns F into F / r.
    const rMax = this.rMax;
    const rMax2 = rMax * rMax;
    const beta = this.beta;
    const rampSlope = 1 / (rMax * beta);              // ramp = r * rampSlope - 1
    const tentSlope = 2 / (rMax * (1 - beta));        // tent = 1 - |r * tentSlope - tentPeak|
    const tentPeak = (1 + beta) / (1 - beta);
    let allNeighbours = 0;

    for (let cy = 0; cy < C; cy++) {
      let ny = cy + 1, oy = 0;
      if (ny === C) { ny = 0; oy = 1; }
      const row = ny * C;
      for (let cx = 0; cx < C; cx++) {
        const c = cy * C + cx;
        const p0 = start[c], p1 = start[c + 1];
        if (p0 === p1) continue;

        // Range 0 is this cell from p + 1 (set per particle). Without a wrap
        // the east cell is the next run of slots, so the two ranges merge.
        let nr = 1;
        rox[0] = 0; roy[0] = 0;
        if (cx === C - 1) {
          rq1[0] = p1;
          rq0[1] = start[c + 1 - C]; rq1[1] = start[c + 2 - C]; rox[1] = 1; roy[1] = 0;
          nr = 2;
        } else {
          rq1[0] = start[c + 2];
        }
        if (cx === 0) {
          rq0[nr] = start[row + C - 1]; rq1[nr] = start[row + C]; rox[nr] = -1; roy[nr] = oy; nr++;
          rq0[nr] = start[row]; rq1[nr] = start[row + 2]; rox[nr] = 0; roy[nr] = oy; nr++;
        } else if (cx === C - 1) {
          rq0[nr] = start[row + C - 2]; rq1[nr] = start[row + C]; rox[nr] = 0; roy[nr] = oy; nr++;
          rq0[nr] = start[row]; rq1[nr] = start[row + 1]; rox[nr] = 1; roy[nr] = oy; nr++;
        } else {
          rq0[nr] = start[row + cx - 1]; rq1[nr] = start[row + cx + 2]; rox[nr] = 0; roy[nr] = oy; nr++;
        }

        for (let p = p0; p < p1; p++) {
          rq0[0] = p + 1;
          const xi = sx[p], yi = sy[p];
          const si = ss[p];
          const rowI = si * S;
          let fxi = 0, fyi = 0;
          let pairs = 0, same = 0;

          for (let k = 0; k < nr; k++) {
            // dx = (x_j + shift) - x_i, folded into one subtraction per pair
            const bx = xi - rox[k], by = yi - roy[k];
            const q1 = rq1[k];
            for (let q = rq0[k]; q < q1; q++) {
              const dx = sx[q] - bx;
              const dy = sy[q] - by;
              const r2 = dx * dx + dy * dy;
              // (written so that a NaN distance is skipped, never spread to a neighbour)
              if (!(r2 < rMax2)) continue;
              const ij = rowI + ss[q];
              pairs++;
              same += SAME[ij];
              if (r2 === 0) {
                // Exactly coincident (same cell, so q > p): no direction
                // exists, so push the two apart along x at full core strength.
                fxi -= 1;
                sfx[q] += 1;
                continue;
              }
              const r = Math.sqrt(r2);
              const halfInvR = 0.5 / r;
              const ramp = r * rampSlope - 1;
              const tent = 1 - Math.abs(r * tentSlope - tentPeak);
              const core2 = ramp - Math.abs(ramp);    // 2 * core
              const hump2 = tent + Math.abs(tent);    // 2 * hump
              // F / r, so that F * unit = (F / r) * d
              const fi = (core2 + A[ij] * hump2) * halfInvR;
              const fj = (core2 + AT[ij] * hump2) * halfInvR;
              fxi += fi * dx;
              fyi += fi * dy;
              sfx[q] -= fj * dx;
              sfy[q] -= fj * dy;
            }
          }

          sfx[p] += fxi;
          sfy[p] += fyi;
          // every pair is a neighbour of both its members (of one species if same)
          allNeighbours += 2 * pairs;
          sameS[si] += 2 * same;
        }
      }
    }

    // --- 3. velocities and speed statistics ----------------------------------
    // The friction factor is rounded to float32 so that it is the same number
    // in every JavaScript engine: Math.pow is not required to be correctly
    // rounded, and one differing last bit would let two browsers given the
    // same genome drift apart. Everything else in a step is exactly rounded
    // IEEE arithmetic (+, -, *, /, sqrt, abs), so a shared world reproduces.
    const friction = integrate ? Math.fround(Math.pow(0.5, dt / this.halfLife)) : 1;
    const accScale = rMax * this.force * dt;
    let speedAll = 0;
    for (let p = 0; p < n; p++) {
      const i = order[p];
      let vxi = VX[i], vyi = VY[i];
      if (integrate) {
        vxi = vxi * friction + sfx[p] * accScale;
        vyi = vyi * friction + sfy[p] * accScale;
        VX[i] = vxi;
        VY[i] = vyi;
      }
      const speed = Math.sqrt(vxi * vxi + vyi * vyi);
      const s = ss[p];
      countS[s]++;
      speedS[s] += speed;
      speedAll += speed;
    }

    this.#allNeighbours = allNeighbours;
    this.#speedAll = speedAll;
  }

  /** Second pass: move every particle along its new velocity and wrap. */
  #advance(dt) {
    const n = this.n;
    const X = this.x, Y = this.y, VX = this.vx, VY = this.vy;
    for (let i = 0; i < n; i++) {
      let px = X[i] + VX[i] * dt;
      let py = Y[i] + VY[i] * dt;
      if (px < 0 || px >= 1) px -= Math.floor(px);
      if (py < 0 || py >= 1) py -= Math.floor(py);
      X[i] = px;
      Y[i] = py;
      // float32 storage can round a value just below 1 up to 1.0: that is the seam
      if (X[i] >= 1) X[i] = 0;
      if (Y[i] >= 1) Y[i] = 0;
    }
  }
}
