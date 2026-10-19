// Headless preset search for Tropism.
//
// For every species count S in 2..8 this script simulates a pool of candidate
// worlds without a browser, measures how "alive" each one looks, and writes
// src/presets.js from the authored PICKS table further down. The search ranks
// and checks; a person chooses the picks from its report and review images and
// writes their names and blurbs.
//
//   node tools/find-presets.mjs                 full search, check the picks, write src/presets.js
//   node tools/find-presets.mjs --no-write      search and report only
//   node tools/find-presets.mjs --picks-only    skip the search: check the picks and write
//   node tools/find-presets.mjs --keys a,b      measure the given candidate keys at both scales
//   node tools/find-presets.mjs --png <dir>     also write PNG contact sheets for review
//   node tools/find-presets.mjs --json <file>   also dump every measurement as JSON
//   node tools/find-presets.mjs --only 3        search one species count
//   node tools/find-presets.mjs --workers 6     worker threads (default: cores - 1, at most 12)
//   node tools/find-presets.mjs --force         write even if a pick fails its check
//
// A full run takes about eight minutes on an 8-core laptop with 12 workers.
//
// Candidates per S (keys in resolveKey): 30 uniform random genomes (seeds from
// hashString('tropism-' + S + '-' + k)), 8 "cohesive" random genomes whose
// diagonal is forced positive (self-attraction is what turns a gas into
// bodies), and hand-designed archetypes from the particle-life repertoire
// (pursuit, coated and onion cells, cycles, predator and prey, worms with
// hunters). The best two per S are refined by one round of four mutations.
//
// Search scale. Candidates run at n = 2500 with r_max scaled by sqrt(5000/2500)
// so the neighbour density n * pi * r_max^2 equals the default world's. In
// units of r_max the dynamics are then identical (the force is proportional to
// r_max), only on a torus with half the area: the same physics at half the
// cost. The best three per S and every pick are re-run at the real defaults
// (n = 5000, r_max = 0.055), where the thumbnails are taken, and the picks once
// more at the phone cap main.js applies (n = 3000) for reference.
//
// Metrics (lengths in r_max, times in simulated seconds), measured over 400
// steps after settling:
//   agg        mean aggregationAll (1 = well mixed)
//   speed      mean meanSpeedAll (r_max / s)
//   drift      mean net displacement of a particle over 100 steps (2 s),
//              integrated from the velocities so wrap-around does not matter;
//              jitter in a frozen crystal has speed but no drift
//   driftMin   the smallest of the per-interval drifts (a world that is
//              freezing over shows it here first)
//   turnover   fraction of a particle's r_max neighbours at t that are no
//              longer its neighbours at t + 2 s (sampled particles)
//   decor      1 - Pearson correlation of the coarse density field
//              (cells of r_max / 2) at t and t + 2 s: bodies that move,
//              merge or split decorrelate it; a frozen pattern does not
//   bodies     connected groups of >= 12 particles linked within 0.5 r_max
//              (grid flood fill), averaged over five snapshots
//   clustered  fraction of particles that belong to such a body
//   largest    fraction of particles in the largest body
//   spread     the largest body's radius of gyration over that of a filled
//              disc of the same area: ~1 for a compact blob, well above for
//              a worm, a ribbon or a network
//   mix        species diversity inside bodies (0 = every body one species)
//
// Score = form x life, both in [0, 1]:
//   form rewards aggregation clearly above 1, a body count in 4..60 (scaled
//   with the torus area), most particles inside bodies, no single compact
//   blob, and (mildly) bodies made of several species;
//   life rewards drift, density decorrelation and neighbour turnover, and
//   gently penalises motion too fast for the eye to follow.
// Frozen crystals fail life, a uniform gas fails form, one blob fails form.

import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { performance } from 'node:perf_hooks';

import { World } from '../src/sim.js';

// The search's step counts (settling, measuring windows) were tuned at this step, so it keeps
// using it whatever the page's DT is.
const SEARCH_DT = 0.02;
import {
  randomGenome, mutateGenome, hashString, mulberry32, quantizeAffinity,
  encodeGenome, decodeGenome, defaultParams, genomesEqual, GENOME_VERSION,
} from '../src/genome.js';
import { SPECIES, SPECIES_MIN, SPECIES_MAX } from '../src/markers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS_PATH = join(ROOT, 'src', 'presets.js');

// ---------------------------------------------------------------------------
// Configuration

const DEFAULTS = defaultParams();

/** Search scale: half the particles, same neighbour density. */
const SEARCH = Object.freeze({
  n: 2500,
  rMax: DEFAULTS.rMax * Math.sqrt(DEFAULTS.n / 2500),
  settle: 1200,
});

/** Validation scale: exactly what a visitor's browser runs. */
const VALIDATE = Object.freeze({ n: DEFAULTS.n, rMax: DEFAULTS.rMax, settle: 1500 });

/** Phone scale: main.js caps n at 3000 on small or low-core devices (informational). */
const PHONE = Object.freeze({ n: 3000, rMax: DEFAULTS.rMax, settle: 1500 });

/** Measuring window after settling: INTERVALS gaps of STRIDE steps (4 x 100 = 400 steps). */
const STRIDE = 100;
const INTERVALS = 4;
/** Read the engine's statistics every this many steps inside the window. */
const STATS_EVERY = 5;

const RANDOM_PER_S = 30;
const COHESIVE_PER_S = 8;
/** Refinement: mutate the best REFINE_PARENTS per S, REFINE_CHILDREN times each. */
const REFINE_PARENTS = 2;
const REFINE_CHILDREN = 4;
/** Re-run the best VALIDATE_PER_S per S (plus every pick) at the real defaults. */
const VALIDATE_PER_S = 3;

/** Body detection: link radius (in r_max) and minimum body size (particles). */
const LINK_RADIUS = 0.5;
const MIN_BODY = 12;
/** Preferred body count on the search torus; scaled by area for other sizes. */
const BODY_RANGE = [4, 60];
const SEARCH_AREA = 1 / (SEARCH.rMax * SEARCH.rMax);

/** Particles sampled for the neighbour-turnover measure. */
const TURNOVER_SAMPLE = 300;
/** Review images: the pale "ghost" shows positions this many steps (1 s) before the snapshot. */
const GHOST_STEPS = 50;
/** Thumbnail: at most this many particles from the settled default-scale run. */
const THUMB_MAX = 1500;

/** Net drift (r_max per 2 s) above which motion is penalised as too fast to follow. */
const PACE_LIMIT = 6;

/** A pick must score at least this at the real defaults (and pass the gates in checkPick). */
const PICK_MIN_SCORE = 0.25;

// ---------------------------------------------------------------------------
// Small helpers

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
const logRamp = (v, lo, hi) => (v <= 0 ? 0 : clamp01(Math.log(v / lo) / Math.log(hi / lo)));
const q = quantizeAffinity;

/** A genome with default params (what a preset stores) from a matrix. */
function genomeOf(S, matrix, seed) {
  return { v: GENOME_VERSION, species: S, matrix: matrix.map(q), params: defaultParams(), seed: seed >>> 0 };
}

// ---------------------------------------------------------------------------
// Candidates

/**
 * Hand-designed archetypes. Each builder fills an S x S matrix (row i = how
 * species i responds to each j) from one variant's numbers; every variant of
 * every applicable S becomes one candidate.
 */
const ARCHETYPES = [
  {
    // One species is drawn to the other while the other is pushed away from
    // it: the first chases, the second flees, and bodies run. With both
    // species self-cohesive the pair travels as a two-tone dimer. (The last
    // variant swaps the roles: B chases A.)
    name: 'pursuit',
    sizes: [2],
    variants: [
      { aa: 0.3, ab: 0.8, ba: -0.5, bb: 0.25 },
      { aa: 0.6, ab: 1.0, ba: -0.4, bb: 0.5 },
      { aa: 0.15, ab: 0.6, ba: -0.8, bb: 0.4 },
      { aa: 0.8, ab: 0.45, ba: -0.3, bb: 0.8 },
      { aa: 0.5, ab: 0.9, ba: -0.9, bb: 0.6 },
      { aa: 0.8, ab: -0.5, ba: 0.8, bb: 0.1 },
    ],
    build(S, v) {
      return [v.aa, v.ab, v.ba, v.bb];
    },
  },
  {
    // A self-attracting core; each later species is drawn to the one before
    // it. Where the later species repel their own kind they spread into a coat
    // around it (an onion for S > 2); where they cohere mildly and the pull
    // back is weak, cells link head to tail into chains.
    name: 'coated',
    sizes: [2, 3, 4, 5, 6, 7, 8],
    variants: [
      { core: 0.9, inward: 0.7, outward: -0.15, self: -0.1, far: -0.1 },
      { core: 0.6, inward: 0.9, outward: 0.1, self: 0.2, far: 0 },
      { core: 1.0, inward: 1.0, outward: -0.2, self: -0.5, far: 0 },
    ],
    build(S, v) {
      const m = new Array(S * S).fill(v.far);
      m[0] = v.core;
      for (let k = 1; k < S; k++) {
        m[k * S + k] = v.self;
        m[k * S + (k - 1)] = v.inward;
        m[(k - 1) * S + k] = v.outward;
      }
      return m;
    },
  },
  {
    // Each species is drawn to the next and pushed from (or indifferent to)
    // the previous one: a rock-paper-scissors loop that keeps bodies moving.
    // Self-repulsive variants make mixed cells; self-cohesive ones make
    // single-species bodies that hunt each other round the loop.
    name: 'cycle',
    sizes: [3, 4, 5, 6, 7, 8],
    variants: [
      { self: 0.7, next: 0.4, prev: -0.3, other: -0.2 },
      { self: 0.4, next: 0.9, prev: 0.1, other: -0.3 },
      { self: -0.3, next: 0.9, prev: -0.1, other: -0.1 },
      { self: -0.2, next: 0.8, prev: -0.2, other: 0 },
      { self: -0.2, next: 1.0, prev: -0.3, other: 0 },
    ],
    build(S, v) {
      const m = new Array(S * S).fill(v.other);
      for (let i = 0; i < S; i++) {
        m[i * S + i] = v.self;
        m[i * S + ((i + 1) % S)] = v.next;
        m[i * S + ((i - 1 + S) % S)] = v.prev;
      }
      return m;
    },
  },
  {
    // Prey species form their own colonies and flee the last species, which
    // is drawn to all of them: colonies scatter and re-form around a hunter.
    name: 'predator',
    sizes: [3, 4, 5, 6, 7, 8],
    variants: [
      { preySelf: 0.6, preyPrey: -0.1, flee: -0.7, hunt: 0.8, predSelf: -0.2 },
      { preySelf: 0.9, preyPrey: 0.2, flee: -0.4, hunt: 0.5, predSelf: 0.3 },
    ],
    build(S, v) {
      const P = S - 1;
      const m = new Array(S * S).fill(v.preyPrey);
      for (let i = 0; i < P; i++) {
        m[i * S + i] = v.preySelf;
        m[i * S + P] = v.flee;
        m[P * S + i] = v.hunt;
      }
      m[P * S + P] = v.predSelf;
      return m;
    },
  },
  {
    // A and B attract each other but repel their own kind, so they lock into
    // banded A-B-A-B worms. Left alone the worms freeze; every further species
    // is drawn to the worms and pushes them away, which keeps them writhing.
    name: 'worm-hunter',
    sizes: [3, 4, 5, 6, 7, 8],
    variants: [
      { wormSelf: -0.3, ab: 0.8, ba: 0.8, huntA: 0.7, huntB: 0.7, fleeA: -0.4, fleeB: -0.4, hunterSelf: 0.2, between: -0.1 },
      { wormSelf: -0.3, ab: 0.9, ba: 0.6, huntA: 0.8, huntB: 0, fleeA: -0.5, fleeB: 0, hunterSelf: 0.2, between: 0 },
      { wormSelf: -0.3, ab: 0.8, ba: 0.8, huntA: 0.9, huntB: 0.9, fleeA: -0.7, fleeB: -0.7, hunterSelf: 0.2, between: -0.1 },
    ],
    build(S, v) {
      const m = new Array(S * S).fill(v.between);
      m[0] = v.wormSelf;
      m[S + 1] = v.wormSelf;
      m[1] = v.ab;
      m[S] = v.ba;
      for (let k = 2; k < S; k++) {
        m[k * S + k] = v.hunterSelf;
        m[k * S] = v.huntA;
        m[k * S + 1] = v.huntB;
        m[k] = v.fleeA;
        m[S + k] = v.fleeB;
      }
      return m;
    },
  },
];

/** Every stage-1 candidate for one species count: { key, family, genome }. */
function candidatesFor(S) {
  const out = [];
  for (let k = 0; k < RANDOM_PER_S; k++) {
    const key = `random:${S}:${k}`;
    out.push({ key, family: 'random', genome: resolveKey(key) });
  }
  for (let k = 0; k < COHESIVE_PER_S; k++) {
    const key = `cohesive:${S}:${k}`;
    out.push({ key, family: 'cohesive', genome: resolveKey(key) });
  }
  for (const arch of ARCHETYPES) {
    if (!arch.sizes.includes(S)) continue;
    arch.variants.forEach((_, vi) => {
      const key = `${arch.name}:${S}:${vi}`;
      out.push({ key, family: arch.name, genome: resolveKey(key) });
    });
  }
  return out;
}

/**
 * Rebuild a candidate genome from its key, deterministically:
 *   random:S:k     randomGenome(hashString('tropism-S-k'), { species: S })
 *   cohesive:S:k   the same stream, then a diagonal drawn from [0.3, 1]
 *   <arch>:S:v     archetype builder, seed hashString('tropism-S-<arch>-v')
 *   <key>~mK       mutateGenome(<key>, hashString('<key>~mK'))
 *   <key>@e:AB=a[;CD=a]     explicit edits on top of <key> (hand retuning):
 *                  the affinity of row species A toward column species B
 */
function resolveKey(key) {
  const at = key.lastIndexOf('@e:');
  if (at >= 0) {
    const g = resolveKey(key.slice(0, at));
    for (const edit of key.slice(at + 3).split(';')) {
      const m = /^([A-H])([A-H])=(-?\d*\.?\d+)$/.exec(edit);
      if (!m) throw new Error(`bad edit "${edit}" in ${key} (expected e.g. AB=-0.3)`);
      const i = m[1].charCodeAt(0) - 65, j = m[2].charCodeAt(0) - 65;
      if (i >= g.species || j >= g.species) throw new Error(`edit out of range in ${key}`);
      g.matrix[i * g.species + j] = q(Number(m[3]));
    }
    return g;
  }
  const tilde = key.lastIndexOf('~m');
  if (tilde >= 0) {
    return mutateGenome(resolveKey(key.slice(0, tilde)), hashString(key));
  }
  const [family, sText, kText] = key.split(':');
  const S = Number(sText), k = Number(kText);
  if (!(S >= SPECIES_MIN && S <= SPECIES_MAX) || !Number.isInteger(k) || k < 0) throw new Error(`bad key ${key}`);
  if (family === 'random') {
    return randomGenome(hashString(`tropism-${S}-${k}`), { species: S, params: defaultParams() });
  }
  if (family === 'cohesive') {
    const seed = hashString(`tropism-${S}-cohesive-${k}`);
    const g = randomGenome(seed, { species: S, params: defaultParams() });
    const rng = mulberry32(seed ^ 0x5bd1e995);
    for (let i = 0; i < S; i++) g.matrix[i * S + i] = q(0.3 + 0.7 * rng());
    return g;
  }
  const arch = ARCHETYPES.find((a) => a.name === family);
  if (!arch || !arch.sizes.includes(S) || k >= arch.variants.length) throw new Error(`unknown candidate ${key}`);
  return genomeOf(S, arch.build(S, arch.variants[k]), hashString(`tropism-${S}-${family}-${k}`));
}

// ---------------------------------------------------------------------------
// Measurement (runs inside the worker threads)

/**
 * Simulate one world and measure it. `job`: { genome, n, rMax, settle,
 * thumb?: boolean, snapshot?: boolean }. Returns { metrics, thumb?, snapshot? }.
 */
function measureWorld(job) {
  const t0 = performance.now();
  const { genome, n, rMax, settle } = job;
  const world = new World(n);
  world.reset({ ...genome, params: { ...genome.params, n, rMax } });
  for (let s = 0; s < settle; s++) world.step(SEARCH_DT);

  const S = world.S;
  const stats = world.stats();
  const ux = new Float64Array(n), uy = new Float64Array(n);
  const sample = new Int32Array(TURNOVER_SAMPLE);
  for (let k = 0; k < TURNOVER_SAMPLE; k++) sample[k] = Math.floor((k * n) / TURNOVER_SAMPLE);
  const bodyScratch = createBodyScratch(n);
  const gridSide = Math.max(4, Math.floor(2 / rMax));
  let density = densityField(world, gridSide);
  let neighbours = neighbourLists(world, sample, rMax);

  // For review images: where every particle was GHOST_STEPS before the end.
  const ghost = job.snapshot ? { x: new Float32Array(n), y: new Float32Array(n) } : null;
  let agg = 0, speed = 0, statsCount = 0;
  const aggS = new Float64Array(S);
  let drift = 0, driftMin = Infinity, turnover = 0, decor = 0;
  let bodies = 0, clustered = 0, largest = 0, spread = 0, mix = 0, snapshots = 0;

  const takeBodies = () => {
    const b = findBodies(world, LINK_RADIUS * rMax, MIN_BODY, bodyScratch);
    bodies += b.count;
    clustered += b.clustered;
    largest += b.largest;
    spread += b.spread;
    mix += b.mix;
    snapshots++;
  };
  takeBodies();

  for (let interval = 0; interval < INTERVALS; interval++) {
    ux.fill(0);
    uy.fill(0);
    for (let s = 0; s < STRIDE; s++) {
      if (ghost && interval === INTERVALS - 1 && s === STRIDE - GHOST_STEPS) {
        ghost.x.set(world.x.subarray(0, n));
        ghost.y.set(world.y.subarray(0, n));
      }
      world.step(SEARCH_DT);
      const VX = world.vx, VY = world.vy;
      for (let i = 0; i < n; i++) {
        ux[i] += VX[i] * SEARCH_DT;
        uy[i] += VY[i] * SEARCH_DT;
      }
      if ((s + 1) % STATS_EVERY === 0) {
        world.stats(stats);
        agg += stats.aggregationAll;
        speed += stats.meanSpeedAll;
        for (let k = 0; k < S; k++) aggS[k] += stats.aggregation[k];
        statsCount++;
      }
    }
    let d = 0;
    for (let i = 0; i < n; i++) d += Math.sqrt(ux[i] * ux[i] + uy[i] * uy[i]);
    d /= n * rMax;
    drift += d;
    if (d < driftMin) driftMin = d;

    turnover += neighbourTurnover(world, sample, neighbours, rMax);
    neighbours = neighbourLists(world, sample, rMax);
    const next = densityField(world, gridSide);
    decor += 1 - pearson(density, next);
    density = next;
    takeBodies();
  }

  const metrics = {
    agg: agg / statsCount,
    aggS: Array.from(aggS, (v) => v / statsCount),
    speed: speed / statsCount,
    drift: drift / INTERVALS,
    driftMin,
    turnover: turnover / INTERVALS,
    decor: decor / INTERVALS,
    bodies: bodies / snapshots,
    clustered: clustered / snapshots,
    largest: largest / snapshots,
    spread: spread / snapshots,
    mix: mix / snapshots,
    n,
    rMax,
    ms: performance.now() - t0,
  };

  const result = { metrics };
  if (job.thumb) result.thumb = encodeThumb(world, THUMB_MAX, hashString(`thumb-${encodeGenome(genome)}`));
  if (job.snapshot) {
    result.snapshot = {
      S,
      x: world.x.slice(0, n),
      y: world.y.slice(0, n),
      species: world.species.slice(0, n),
      ghostX: ghost.x,
      ghostY: ghost.y,
    };
  }
  return result;
}

/** For each sampled particle, the indices of every particle within rMax (flat lists). */
function neighbourLists(world, sample, rMax) {
  const X = world.x, Y = world.y, n = world.n;
  const r2 = rMax * rMax;
  const start = new Int32Array(sample.length + 1);
  const list = [];
  for (let k = 0; k < sample.length; k++) {
    const i = sample[k];
    const xi = X[i], yi = Y[i];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let dx = X[j] - xi; dx -= Math.round(dx);
      let dy = Y[j] - yi; dy -= Math.round(dy);
      if (dx * dx + dy * dy < r2) list.push(j);
    }
    start[k + 1] = list.length;
  }
  return { start, list: Int32Array.from(list) };
}

/** Fraction of the earlier neighbour pairs that are no longer within rMax. */
function neighbourTurnover(world, sample, before, rMax) {
  const X = world.x, Y = world.y;
  const r2 = rMax * rMax;
  const { start, list } = before;
  if (list.length === 0) return 1;
  let kept = 0;
  for (let k = 0; k < sample.length; k++) {
    const i = sample[k];
    for (let p = start[k]; p < start[k + 1]; p++) {
      const j = list[p];
      let dx = X[j] - X[i]; dx -= Math.round(dx);
      let dy = Y[j] - Y[i]; dy -= Math.round(dy);
      if (dx * dx + dy * dy < r2) kept++;
    }
  }
  return 1 - kept / list.length;
}

/** Particle counts on a side x side grid over the torus. */
function densityField(world, side) {
  const field = new Float64Array(side * side);
  const X = world.x, Y = world.y;
  for (let i = 0; i < world.n; i++) {
    const cx = Math.min(side - 1, (X[i] * side) | 0);
    const cy = Math.min(side - 1, (Y[i] * side) | 0);
    field[cy * side + cx]++;
  }
  return field;
}

function pearson(a, b) {
  const len = a.length;
  let ma = 0, mb = 0;
  for (let k = 0; k < len; k++) { ma += a[k]; mb += b[k]; }
  ma /= len; mb /= len;
  let sab = 0, saa = 0, sbb = 0;
  for (let k = 0; k < len; k++) {
    const da = a[k] - ma, db = b[k] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

function createBodyScratch(n) {
  return {
    label: new Int32Array(n), stack: new Int32Array(n), cellOf: new Int32Array(n), order: new Int32Array(n),
    ux: new Float64Array(n), uy: new Float64Array(n), kinds: new Float64Array(SPECIES_MAX), start: null, cellMark: null,
  };
}

/**
 * Connected groups of particles linked within `link` (torus minimum image),
 * by a flood fill over a uniform grid with cells at least `link` wide.
 * Returns { count, clustered, largest, spread, mix }: bodies of at least
 * `minSize` particles, the fraction of particles inside them, the largest
 * body's fraction and its shape, and the particle-weighted species diversity
 * of the bodies (Gini-Simpson index normalised by its maximum 1 - 1/S: 0 =
 * every body is one species, 1 = every body holds all species equally).
 *
 * spread = the largest body's radius of gyration (from coordinates unwrapped
 * along the flood fill) divided by that of a filled disc with the same area,
 * the area being the grid cells it occupies. A compact blob scores ~1; a worm,
 * a ribbon or a torus-spanning network scores well above, which separates one
 * collapsed blob from one long structure.
 */
function findBodies(world, link, minSize, scratch) {
  const n = world.n, X = world.x, Y = world.y, SP = world.species;
  const S = world.S;
  let C = Math.max(3, Math.floor(1 / link));
  while (C > 3 && 1 / C < link) C--;
  const cells = C * C;
  if (!scratch.start || scratch.start.length < cells + 1) scratch.start = new Int32Array(cells + 1);
  if (!scratch.cellMark || scratch.cellMark.length < cells) scratch.cellMark = new Int32Array(cells);
  const { label, stack, cellOf, order, start, kinds, ux, uy, cellMark } = scratch;
  start.fill(0, 0, cells + 1);
  for (let i = 0; i < n; i++) {
    const cx = Math.min(C - 1, (X[i] * C) | 0);
    const cy = Math.min(C - 1, (Y[i] * C) | 0);
    const c = cy * C + cx;
    cellOf[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const fill = start.slice(0, cells);
  for (let i = 0; i < n; i++) order[fill[cellOf[i]]++] = i;

  label.fill(-1, 0, n);
  cellMark.fill(-1, 0, cells);
  const link2 = link * link;
  let count = 0, inBodies = 0, largest = 0, nextLabel = 0, mixed = 0, spread = 0;
  for (let seed = 0; seed < n; seed++) {
    if (label[seed] >= 0) continue;
    const id = nextLabel++;
    let top = 0, size = 0, sx = 0, sy = 0, sxx = 0, area = 0;
    kinds.fill(0);
    stack[top++] = seed;
    label[seed] = id;
    ux[seed] = 0;
    uy[seed] = 0;
    while (top > 0) {
      const i = stack[--top];
      size++;
      kinds[SP[i]]++;
      sx += ux[i];
      sy += uy[i];
      sxx += ux[i] * ux[i] + uy[i] * uy[i];
      const ci = cellOf[i];
      if (cellMark[ci] !== id) {
        cellMark[ci] = id;
        area++;
      }
      const cx = ci % C, cy = (ci / C) | 0;
      for (let oy = -1; oy <= 1; oy++) {
        const ny = (cy + oy + C) % C;
        for (let ox = -1; ox <= 1; ox++) {
          const nc = ny * C + ((cx + ox + C) % C);
          for (let p = start[nc]; p < start[nc + 1]; p++) {
            const j = order[p];
            if (label[j] >= 0) continue;
            let dx = X[j] - X[i]; dx -= Math.round(dx);
            let dy = Y[j] - Y[i]; dy -= Math.round(dy);
            if (dx * dx + dy * dy < link2) {
              label[j] = id;
              ux[j] = ux[i] + dx;
              uy[j] = uy[i] + dy;
              stack[top++] = j;
            }
          }
        }
      }
    }
    if (size >= minSize) {
      count++;
      inBodies += size;
      let same = 0;
      for (let s = 0; s < S; s++) same += (kinds[s] / size) * (kinds[s] / size);
      mixed += size * (1 - same);
    }
    if (size > largest) {
      largest = size;
      const rg2 = sxx / size - (sx / size) * (sx / size) - (sy / size) * (sy / size);
      // filled disc of `area` cells (each 1/C wide): R_g = R / sqrt(2), R = sqrt(area / pi) / C
      spread = Math.sqrt(Math.max(0, rg2)) / (Math.sqrt(area / (2 * Math.PI)) / C);
    }
  }
  const mix = inBodies > 0 ? mixed / inBodies / (1 - 1 / S) : 0;
  return { count, clustered: inBodies / n, largest: largest / n, spread, mix };
}

/**
 * Thumbnail bytes (the format decodeThumb in src/presets.js reads), base64:
 *   [S, n_hi, n_lo, then per particle x (0..255), y (0..255), species]
 * from up to `max` particles chosen without replacement (seeded).
 */
function encodeThumb(world, max, seed) {
  const n = world.n;
  const m = Math.min(max, n);
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const rng = mulberry32(seed);
  for (let k = 0; k < m; k++) {
    const pick = k + Math.min(n - k - 1, Math.floor(rng() * (n - k)));
    const t = idx[k]; idx[k] = idx[pick]; idx[pick] = t;
  }
  const bytes = new Uint8Array(3 + 3 * m);
  bytes[0] = world.S;
  bytes[1] = (m >> 8) & 255;
  bytes[2] = m & 255;
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    bytes[3 + 3 * k] = Math.min(255, Math.floor(world.x[i] * 256));
    bytes[4 + 3 * k] = Math.min(255, Math.floor(world.y[i] * 256));
    bytes[5 + 3 * k] = world.species[i];
  }
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// Scoring

/**
 * Score one measurement. The preferred body count scales with the torus area
 * in units of r_max^2 (from m.rMax), so a search-scale run and a default-scale
 * run of the same world score alike. Returns { score, form, life }.
 */
function scoreMetrics(m) {
  const areaRatio = 1 / (m.rMax * m.rMax) / SEARCH_AREA;
  const lo = BODY_RANGE[0] * areaRatio, hi = BODY_RANGE[1] * areaRatio;
  const gAgg = logRamp(m.agg, 1.25, 2.5);
  const c = m.bodies;
  const gCount = c <= 0 ? 0 : c < lo ? Math.pow(c / lo, 1.5) : c > hi ? hi / c : 1;
  // One body holding most particles is penalised only when it is compact (a
  // collapsed blob); a long worm or ribbon holding as many is a structure.
  const crowding = m.largest <= 0.35 ? 0 : Math.min(0.85, ((m.largest - 0.35) / 0.65) * 0.85);
  const gBlob = 1 - crowding * (1 - ramp(m.spread, 1.0, 1.5));
  const gFrac = ramp(m.clustered, 0.25, 0.65);
  // Bodies made of several species (coated cells, banded worms, chasing
  // pairs) read as organisms; single-species dots read as dust.
  const gMix = 0.6 + 0.4 * ramp(m.mix, 0.1, 0.6);
  const form = gAgg * gCount * gBlob * (0.5 + 0.5 * gFrac) * gMix;

  const gMove = logRamp(m.driftMin, 0.15, 1.5);
  const gChange = ramp(m.decor, 0.03, 0.35);
  const gTurn = ramp(m.turnover, 0.05, 0.4);
  // Past ~3 r_max/s of net drift the dish turns to a blur the eye cannot follow.
  const gPace = m.drift <= PACE_LIMIT ? 1 : Math.sqrt(PACE_LIMIT / m.drift);
  const life = ((gMove + gChange + gTurn) / 3) * gPace;
  return { score: form * life, form, life };
}

// ---------------------------------------------------------------------------
// Worker pool

function workerLoop() {
  parentPort.on('message', ({ id, job }) => {
    try {
      const result = measureWorld(job);
      const snap = result.snapshot;
      const transfer = snap ? [snap.x.buffer, snap.y.buffer, snap.species.buffer, snap.ghostX.buffer, snap.ghostY.buffer] : [];
      parentPort.postMessage({ id, result }, transfer);
    } catch (err) {
      parentPort.postMessage({ id, error: String(err && err.stack ? err.stack : err) });
    }
  });
}

/** Run every job across `count` worker threads; resolves to results in job order. */
async function runPool(jobs, count, label) {
  if (jobs.length === 0) return [];
  const size = Math.max(1, Math.min(count, jobs.length));
  const workers = Array.from({ length: size }, () => new Worker(fileURLToPath(import.meta.url)));
  const results = new Array(jobs.length);
  let next = 0, done = 0;
  const t0 = performance.now();
  const step = Math.max(1, Math.round(jobs.length / 10));
  try {
    await Promise.all(workers.map((worker) => new Promise((resolveWorker, rejectWorker) => {
      const feed = () => {
        if (next >= jobs.length) { resolveWorker(); return; }
        const id = next++;
        worker.postMessage({ id, job: jobs[id] });
      };
      worker.on('message', ({ id, result, error }) => {
        if (error) { rejectWorker(new Error(`job ${id} failed: ${error}`)); return; }
        results[id] = result;
        done++;
        if (done % step === 0 || done === jobs.length) {
          const s = ((performance.now() - t0) / 1000).toFixed(0);
          process.stderr.write(`  ${label}: ${done}/${jobs.length} (${s} s)\n`);
        }
        feed();
      });
      worker.on('error', rejectWorker);
      feed();
    })));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Review images (PNG contact sheets, light theme colours)

function writePNG(path, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return writeFile(path, png);
}

/**
 * Tiles of snapshots in reading order, `cols` per row, `tile` px square, 4 px
 * gutters. Each particle is drawn in its species colour over a pale copy of
 * where it was GHOST_STEPS earlier, so motion shows as a short offset.
 */
function contactSheet(snapshots, cols, tile) {
  const gap = 4;
  const rows = Math.ceil(snapshots.length / cols);
  const width = cols * tile + (cols + 1) * gap, height = rows * tile + (rows + 1) * gap;
  const rgb = Buffer.alloc(width * height * 3, 255);
  const colours = SPECIES.map((s) => [1, 3, 5].map((o) => parseInt(s.light.slice(o, o + 2), 16)));
  snapshots.forEach((snap, k) => {
    const ox = gap + (k % cols) * (tile + gap), oy = gap + Math.floor(k / cols) * (tile + gap);
    for (let px = 0; px < tile; px++) {
      for (const [x, y] of [[px, 0], [px, tile - 1], [0, px], [tile - 1, px]]) {
        const o = ((oy + y) * width + ox + x) * 3;
        rgb[o] = rgb[o + 1] = rgb[o + 2] = 180;
      }
    }
    const dot = Math.max(1, Math.round(tile * 0.006 * Math.sqrt(2500 / snap.x.length)));
    const plot = (X, Y, pale) => {
      for (let i = 0; i < X.length; i++) {
        const c = colours[snap.species[i]];
        const bx = ox + Math.min(tile - dot, Math.floor(X[i] * tile));
        const by = oy + Math.min(tile - dot, Math.floor(Y[i] * tile));
        for (let dy = 0; dy < dot; dy++) {
          for (let dx = 0; dx < dot; dx++) {
            const o = ((by + dy) * width + bx + dx) * 3;
            for (let ch = 0; ch < 3; ch++) rgb[o + ch] = pale ? Math.min(rgb[o + ch], 255 - (255 - c[ch]) * 0.3) : c[ch];
          }
        }
      }
    };
    if (snap.ghostX) plot(snap.ghostX, snap.ghostY, true);
    plot(snap.x, snap.y, false);
  });
  return { width, height, rgb };
}

// ---------------------------------------------------------------------------
// Reporting

const f2 = (v) => v.toFixed(2).padStart(6);
const HEADER = `${'key'.padEnd(30)} ${'score'.padStart(6)} ${'form'.padStart(6)} ${'life'.padStart(6)} ` +
  `${'agg'.padStart(6)} ${'speed'.padStart(6)} ${'drift'.padStart(6)} ${'dmin'.padStart(6)} ${'turn'.padStart(6)} ` +
  `${'decor'.padStart(6)} ${'bodies'.padStart(6)} ${'clust'.padStart(6)} ${'large'.padStart(6)} ${'spread'.padStart(6)} ${'mix'.padStart(6)}`;

function row(key, m, s) {
  return `${key.padEnd(30)} ${f2(s.score)} ${f2(s.form)} ${f2(s.life)} ${f2(m.agg)} ${f2(m.speed)} ${f2(m.drift)} ` +
    `${f2(m.driftMin)} ${f2(m.turnover)} ${f2(m.decor)} ${m.bodies.toFixed(1).padStart(6)} ${f2(m.clustered)} ${f2(m.largest)} ` +
    `${f2(m.spread)} ${f2(m.mix)}`;
}

// ---------------------------------------------------------------------------
// Authored picks
//
// The worlds that ship, chosen by a person from the search report. `from` is
// a candidate key (see resolveKey), so every pick is reproducible from this
// file alone. Names are short and descriptive; blurbs say what to watch for
// and which affinity causes it. These are illustrative, authored worlds, not
// discovered species or scientific results. `lead: true` (optional, at most
// one) marks the world the page opens with when the URL carries no genome.

const PICKS = [
  {
    id: 'swimming-cells',
    name: 'Swimming cells',
    from: 'coated:2:0',
    blurb: 'A (blue) clings to itself and B (orange) is drawn to A, but A is pushed slightly away from B, ' +
      'so every blue cell wears an orange crescent that it keeps fleeing, and the cells swim.',
  },
  {
    id: 'banded-worms',
    name: 'Banded worms',
    from: 'worm-hunter:3:0',
    blurb: 'A and B attract each other but repel their own kind, so over the first few seconds they link into ' +
      'striped worms; C (green) is drawn to the worms while they push it away, and that tug keeps them writhing.',
  },
  {
    id: 'cycle-cells',
    name: 'Cycle cells',
    from: 'cycle:3:2',
    blurb: 'Each species is drawn to the next in a loop (A to B, B to C, C to A) and repels its own kind, ' +
      'so the three mix into cells that keep rolling along, because every pull is answered with a slight push.',
  },
  {
    id: 'two-tone-cells',
    name: 'Two-tone cells',
    from: 'random:4:21',
    blurb: 'Kept from the random search: C (green) and D (pink) hold together as two-tone cells inside a loose gas ' +
      'of A and B; the gas is drawn to D while the cells back away from it, so the cells dart through a slower haze.',
  },
  {
    id: 'onion-cells',
    name: 'Onion cells',
    from: 'coated:5:2',
    blurb: 'A clings to itself and each later species is drawn to the one before it but repels its own kind, ' +
      'so cells build up in rough layers with A at the core; the layers take several seconds to settle.',
  },
  {
    id: 'hunted-colonies',
    name: 'Hunted colonies',
    from: 'predator:5:1',
    lead: true,
    blurb: 'A to D each clump together and stick loosely to one another, building colonies of coloured patches; ' +
      'E (vermilion) is drawn to every colony and they all flee it, so hunters latch on and drive colonies across the dish.',
  },
  {
    id: 'bead-trains',
    name: 'Bead trains',
    from: 'coated:6:1',
    blurb: 'Each species is drawn hard to the one before it (B to A, C to B, and on to F) but only faintly back, ' +
      'so cells link head to tail into trains, and the one-sided pulls keep the trains running.',
  },
  {
    id: 'ring-of-pursuit',
    name: 'Ring of pursuit',
    from: 'cycle:7:1',
    blurb: 'Each of the seven species holds together and is drawn hard to the next around a loop (A to B, on to G to A) ' +
      'while avoiding the rest, so single-colour clumps chase the next colour and are chased by the one before.',
  },
  {
    id: 'alliances',
    name: 'Alliances',
    from: 'cohesive:8:0',
    blurb: 'Kept from the random search among tables where every species clumps on its own: mutual pulls sort the eight ' +
      'into alliances (A, D and H; B and F; E and G) whose mixed bodies move at different speeds and keep colliding.',
  },
];

/** Gates a pick must pass at the real defaults, beyond the minimum score. */
function checkPick(m, s) {
  const problems = [];
  if (s.score < PICK_MIN_SCORE) problems.push(`score ${s.score.toFixed(2)} < ${PICK_MIN_SCORE}`);
  if (m.agg < 1.5) problems.push(`aggregation ${m.agg.toFixed(2)} looks like a gas`);
  if (m.driftMin < 0.15) problems.push(`drift ${m.driftMin.toFixed(2)} r_max per 2 s looks frozen`);
  if (m.largest > 0.8 && m.spread < 1) problems.push(`one compact body holds ${(m.largest * 100).toFixed(0)}% (a single blob)`);
  return problems;
}

// ---------------------------------------------------------------------------
// Writing src/presets.js

/** A single-quoted JavaScript string literal (the codebase's quote style). */
function jsString(text) {
  const body = String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  return `'${body}'`;
}

function presetsSource(entries) {
  const lines = [];
  lines.push(
    '// Authored preset worlds for Tropism (the Extended Data gallery and the opening world).',
    '//',
    '// GENERATED by tools/find-presets.mjs: edit the PICKS table there and re-run',
    '// `node tools/find-presets.mjs` instead of editing this file by hand.',
    '//',
    '// Each world was picked by hand from a seeded headless search that scores how',
    '// alive a world looks (distinct bodies that keep moving), then re-checked at the',
    '// default parameters (n = 5000, r_max = 0.055). They are illustrative worlds',
    '// authored for this figure, not discovered species or scientific results.',
    '//',
    '// thumb: base64 of bytes [S, n_hi, n_lo, then per particle x, y (0..255 across the',
    '// torus), species], a sample of a settled default-scale snapshot.',
    '//',
    '// Measured at the defaults when generated (window of 400 steps after settling):',
  );
  for (const e of entries) {
    const m = e.metrics, s = e.score;
    lines.push(`//   ${e.id.padEnd(16)} score ${s.score.toFixed(2)}  aggregation ${m.agg.toFixed(2)}  ` +
      `speed ${m.speed.toFixed(2)}  drift ${m.drift.toFixed(2)}  bodies ${m.bodies.toFixed(0)}`);
  }
  lines.push('', 'export const PRESETS = Object.freeze([');
  for (const e of entries) {
    lines.push('  Object.freeze({');
    lines.push(`    id: ${jsString(e.id)},`);
    lines.push(`    name: ${jsString(e.name)},`);
    lines.push(`    species: ${e.species},`);
    lines.push(`    code: ${jsString(e.code)},`);
    lines.push(`    blurb: ${jsString(e.blurb)},`);
    if (e.lead) lines.push('    lead: true,');
    lines.push(`    thumb: ${jsString(e.thumb)},`);
    lines.push('  }),');
  }
  lines.push(']);', '');
  lines.push(DECODER_SOURCE);
  return lines.join('\n');
}

const DECODER_SOURCE = `const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Character code -> 6-bit value (also accepts the URL-safe '-' and '_'); -1 = not base64. */
const BASE64_INDEX = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let k = 0; k < 64; k++) table[BASE64.charCodeAt(k)] = k;
  table[45] = 62; // '-'
  table[95] = 63; // '_'
  return table;
})();

/** Decode base64 to bytes, skipping whitespace and padding; stops at any other character. */
function decodeBase64(text) {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0, bits = 0, len = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c === 61 || c === 32 || c === 10 || c === 13 || c === 9) continue; // '=' and whitespace
    const v = c < 128 ? BASE64_INDEX[c] : -1;
    if (v < 0) break;
    acc = ((acc << 6) | v) & 0xffffff; // only the low 14 bits are ever read
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[len++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, len);
}

/**
 * Unpack a preset thumbnail: { n, S, x, y, species } with x, y in [0, 1)
 * (cell centres of the 256-step grid). Malformed or truncated input yields
 * as many whole particles as are present (possibly none); never throws.
 */
export function decodeThumb(thumb) {
  const bytes = decodeBase64(typeof thumb === 'string' ? thumb : '');
  const S = bytes.length >= 3 ? bytes[0] : 0;
  const declared = bytes.length >= 3 ? (bytes[1] << 8) | bytes[2] : 0;
  const n = S > 0 ? Math.min(declared, Math.floor((bytes.length - 3) / 3)) : 0;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const species = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const o = 3 + 3 * k;
    x[k] = (bytes[o] + 0.5) / 256;
    y[k] = (bytes[o + 1] + 0.5) / 256;
    species[k] = Math.min(bytes[o + 2], S - 1);
  }
  return { n, S, x, y, species };
}
`;

// ---------------------------------------------------------------------------
// Main

function parseArgs(argv) {
  const opt = {
    write: true, picksOnly: false, png: null, json: null, only: null, keys: null, force: false,
    workers: Math.max(1, Math.min(12, availableParallelism() - 1)),
  };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    const value = () => {
      if (k + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++k];
    };
    if (a === '--no-write') opt.write = false;
    else if (a === '--picks-only') opt.picksOnly = true;
    else if (a === '--force') opt.force = true;
    else if (a === '--png') opt.png = value();
    else if (a === '--json') opt.json = value();
    else if (a === '--keys') opt.keys = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--only') {
      opt.only = Number(value());
      if (!(opt.only >= SPECIES_MIN && opt.only <= SPECIES_MAX)) throw new Error(`--only takes ${SPECIES_MIN}..${SPECIES_MAX}`);
    } else if (a === '--workers') opt.workers = Math.max(1, Math.floor(Number(value())) || 1);
    else throw new Error(`unknown argument ${a}`);
  }
  return opt;
}

const searchJob = (genome, extra = {}) => ({ genome, n: SEARCH.n, rMax: SEARCH.rMax, settle: SEARCH.settle, ...extra });
const validateJob = (genome, extra = {}) => ({ genome, n: VALIDATE.n, rMax: VALIDATE.rMax, settle: VALIDATE.settle, ...extra });
const phoneJob = (genome) => ({ genome, n: PHONE.n, rMax: PHONE.rMax, settle: PHONE.settle });
const byScore = (a, b) => b.score.score - a.score.score;

/** The authored picks, resolved and checked against the preset rules before any simulation. */
function resolvePicks() {
  const picks = PICKS.map((p) => ({ ...p, genome: resolveKey(p.from) }))
    .sort((a, b) => a.genome.species - b.genome.species); // stable: authored order within one S
  const ids = new Set();
  for (const p of picks) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.id) || ids.has(p.id)) throw new Error(`pick id "${p.id}" is malformed or repeated`);
    ids.add(p.id);
    const words = p.name.trim().split(/\s+/).length;
    if (words < 1 || words > 3) throw new Error(`pick name "${p.name}" should be one to three words`);
    if (typeof p.blurb !== 'string' || p.blurb.length < 40) throw new Error(`pick ${p.id} needs a one-sentence blurb`);
  }
  if (picks.length < 8 || picks.length > 12) throw new Error(`the gallery needs 8 to 12 worlds, PICKS has ${picks.length}`);
  for (let S = SPECIES_MIN; S <= SPECIES_MAX; S++) {
    if (!picks.some((p) => p.genome.species === S)) throw new Error(`no pick has ${S} species`);
  }
  if (picks.filter((p) => p.lead).length > 1) throw new Error('at most one pick may be the lead');
  return picks;
}

async function sheetPNG(dir, name, snapshots, cols, tile, labels) {
  const sheet = contactSheet(snapshots, cols, tile);
  await writePNG(join(dir, name), sheet.width, sheet.height, sheet.rgb);
  console.log(`\n${name}, reading order: ${labels.join('  ')}`);
}

/** --keys: measure the given candidates at search scale and at the defaults (exploration). */
async function exploreKeys(opt) {
  const items = opt.keys.map((key) => ({ key, genome: resolveKey(key) }));
  const snap = { snapshot: !!opt.png };
  const res = await runPool([
    ...items.map((c) => searchJob(c.genome, snap)),
    ...items.map((c) => validateJob(c.genome, snap)),
  ], opt.workers, 'keys');
  const k0 = items.length;
  console.log(`\nAt search scale (n = ${SEARCH.n}), then at the defaults (n = ${VALIDATE.n})`);
  console.log(HEADER);
  items.forEach((c, k) => {
    console.log(row(c.key, res[k].metrics, scoreMetrics(res[k].metrics)));
    console.log(row('  (defaults)', res[k0 + k].metrics, scoreMetrics(res[k0 + k].metrics)) + `  ${encodeGenome(c.genome)}`);
  });
  if (opt.png) {
    const order = items.flatMap((_, k) => [res[k].snapshot, res[k0 + k].snapshot]);
    await sheetPNG(opt.png, 'keys.png', order, 2, 360, items.flatMap((c) => [c.key, `${c.key} (defaults)`]));
  }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const t0 = performance.now();
  console.log(`Tropism preset search: ${opt.workers} workers; search n = ${SEARCH.n}, r_max = ${SEARCH.rMax.toFixed(4)}, ` +
    `settle ${SEARCH.settle} + ${INTERVALS} x ${STRIDE} steps; validation n = ${VALIDATE.n}, r_max = ${VALIDATE.rMax}`);
  if (opt.png) await mkdir(opt.png, { recursive: true });
  if (opt.keys) {
    await exploreKeys(opt);
    console.log(`\nDone in ${((performance.now() - t0) / 1000).toFixed(0)} s.`);
    return;
  }

  const picks = resolvePicks();
  const sizes = [];
  for (let S = SPECIES_MIN; S <= SPECIES_MAX; S++) if (opt.only == null || opt.only === S) sizes.push(S);
  const dump = { search: [], validation: [], picks: [] };
  const scored = [];
  const finalists = [];
  const snap = { snapshot: !!opt.png };

  if (!opt.picksOnly) {
    // --- stage 1: every candidate at search scale -------------------------
    const pool = sizes.flatMap(candidatesFor);
    const res1 = await runPool(pool.map((c) => searchJob(c.genome, snap)), opt.workers, 'stage 1');
    pool.forEach((c, k) => scored.push({ ...c, metrics: res1[k].metrics, score: scoreMetrics(res1[k].metrics), snapshot: res1[k].snapshot }));

    // --- stage 2: mutate the best few per S -------------------------------
    const children = [];
    for (const S of sizes) {
      const top = scored.filter((c) => c.genome.species === S).sort(byScore).slice(0, REFINE_PARENTS);
      for (const parent of top) {
        for (let k = 0; k < REFINE_CHILDREN; k++) {
          const key = `${parent.key}~m${k}`;
          children.push({ key, family: parent.family, genome: resolveKey(key) });
        }
      }
    }
    const res2 = await runPool(children.map((c) => searchJob(c.genome, snap)), opt.workers, 'stage 2');
    children.forEach((c, k) => scored.push({ ...c, metrics: res2[k].metrics, score: scoreMetrics(res2[k].metrics), snapshot: res2[k].snapshot }));

    // --- search report ------------------------------------------------------
    for (const S of sizes) {
      const list = scored.filter((c) => c.genome.species === S).sort(byScore);
      const shown = list.slice(0, 12);
      for (const fam of new Set(list.map((c) => c.family))) {
        const best = list.find((c) => c.family === fam);
        if (!shown.includes(best)) shown.push(best);
      }
      console.log(`\nS = ${S}: ${list.length} candidates at search scale (top 12, then the best of each other family)`);
      console.log(HEADER);
      for (const c of shown) console.log(row(c.key, c.metrics, c.score));
      finalists.push(...list.slice(0, VALIDATE_PER_S));
      if (opt.png) {
        const sheet = list.slice(0, 16);
        for (const c of shown) if (!sheet.includes(c)) sheet.push(c);
        await sheetPNG(opt.png, `search-S${S}.png`, sheet.map((c) => c.snapshot), 4, 256, sheet.map((c) => c.key));
      }
    }
    for (const c of scored) dump.search.push({ key: c.key, code: encodeGenome(c.genome), metrics: c.metrics, score: c.score });
  }

  // --- stage 3: finalists, picks and the phone check in one pool --------------
  // (a single pool keeps every worker busy through the tail of the run)
  const jobs = [
    ...finalists.map((c) => validateJob(c.genome, snap)),
    ...picks.map((p) => validateJob(p.genome, { ...snap, thumb: true })),
    ...picks.map((p) => phoneJob(p.genome)),
  ];
  const res3 = await runPool(jobs, opt.workers, 'stage 3');
  const resF = res3.slice(0, finalists.length);
  const resV = res3.slice(finalists.length, finalists.length + picks.length);
  const resP = res3.slice(finalists.length + picks.length);

  if (finalists.length) {
    console.log(`\nSearch finalists re-run at the defaults (n = ${VALIDATE.n}, r_max = ${VALIDATE.rMax}, settle ${VALIDATE.settle})`);
    console.log(HEADER);
    finalists.forEach((c, k) => {
      const m = resF[k].metrics, s = scoreMetrics(m);
      dump.validation.push({ key: c.key, code: encodeGenome(c.genome), metrics: m, score: s });
      console.log(row(c.key, m, s));
    });
    if (opt.png) await sheetPNG(opt.png, 'validation.png', resF.map((r) => r.snapshot), VALIDATE_PER_S, 320, finalists.map((c) => c.key));
  }

  console.log(`\nPicks at the defaults (n = ${VALIDATE.n}), then at phone scale (n = ${PHONE.n}, for reference), ` +
    'then their search-scale rank among candidates with the same S');
  console.log(HEADER);
  let failed = 0;
  const entries = picks.map((p, k) => {
    const m = resV[k].metrics, s = scoreMetrics(m);
    const mp = resP[k].metrics, sp = scoreMetrics(mp);
    const problems = checkPick(m, s);
    if (problems.length) failed++;
    console.log(row(p.id, m, s) + (problems.length ? `   FAIL: ${problems.join('; ')}` : ''));
    console.log(row(`  (phone n = ${PHONE.n})`, mp, sp));
    const list = scored.filter((c) => c.genome.species === p.genome.species).sort(byScore);
    const rank = list.findIndex((c) => genomesEqual(c.genome, p.genome));
    if (rank >= 0) console.log(`  ${p.from}: search score ${list[rank].score.score.toFixed(2)}, rank ${rank + 1} of ${list.length}`);
    const code = encodeGenome(p.genome);
    if (!genomesEqual(decodeGenome(code), p.genome)) throw new Error(`genome of ${p.id} does not round-trip`);
    dump.picks.push({ id: p.id, from: p.from, code, metrics: m, score: s, phone: { metrics: mp, score: sp } });
    return { id: p.id, name: p.name, species: p.genome.species, code, blurb: p.blurb, lead: !!p.lead, thumb: resV[k].thumb, metrics: m, score: s };
  });
  if (opt.png) await sheetPNG(opt.png, 'picks.png', resV.map((r) => r.snapshot), 3, 420, picks.map((p) => p.id));

  if (opt.write) {
    if (failed && !opt.force) {
      console.log(`\n${failed} pick(s) failed the check at the defaults; src/presets.js was not written (use --force to override).`);
      process.exitCode = 1;
    } else {
      await writeFile(PRESETS_PATH, presetsSource(entries));
      console.log(`\nWrote ${entries.length} presets to ${PRESETS_PATH}`);
    }
  }
  if (opt.json) {
    await mkdir(dirname(resolve(opt.json)), { recursive: true });
    await writeFile(opt.json, JSON.stringify(dump, null, 1));
  }
  console.log(`\nDone in ${((performance.now() - t0) / 1000).toFixed(0)} s.`);
}

// The same file is the CLI, the worker entry and a small library: run as a
// script it searches; loaded as a worker it measures; imported, it only exports.
const isEntry = isMainThread && process.argv[1] != null &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (!isMainThread) {
  workerLoop();
} else if (isEntry) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export {
  ARCHETYPES, candidatesFor, resolveKey, measureWorld, scoreMetrics, runPool, findBodies, createBodyScratch,
  contactSheet, writePNG, row, HEADER, SEARCH, VALIDATE, PHONE,
};
