// Genome model for Tropism.
//
// A genome is the complete, shareable law of one world: the species count, the
// S x S affinity table, the physical parameters and the seed that places the
// first particles. It is a plain JSON-able object:
//
//   { v: 1, species: S, matrix: number[S*S], params: { n, rMax, halfLife, force, beta }, seed: uint32 }
//
// Every value is quantised (affinities to AFFINITY_STEP, params to their
// PARAM_LIMITS step) so that a genome survives encode -> decode exactly and two
// browsers given the same token build the same world.
//
// Pure module: no DOM, no side effects; runs in Node and the browser.

import { SPECIES_MIN, SPECIES_MAX } from './markers.js';

export const GENOME_VERSION = 1;

/** Inclusive ranges, plus the quantisation step used by encodeGenome(). */
export const PARAM_LIMITS = Object.freeze({
  n:        Object.freeze({ min: 500,   max: 12000, step: 100 }),
  rMax:     Object.freeze({ min: 0.02,  max: 0.12,  step: 0.001 }),
  halfLife: Object.freeze({ min: 0.005, max: 0.200, step: 0.001 }),
  force:    Object.freeze({ min: 1,     max: 30,    step: 0.1 }),
  beta:     Object.freeze({ min: 0.05,  max: 0.60,  step: 0.01 }),
});

/** Matrix values are multiples of this in [-1, 1]. */
export const AFFINITY_STEP = 0.05;

// ---------------------------------------------------------------------------
// Internal constants

const PARAM_KEYS = ['n', 'rMax', 'halfLife', 'force', 'beta'];

/** Decimal places of each param's step, so quantised values print and parse cleanly. */
const PARAM_DECIMALS = Object.freeze({ n: 0, rMax: 3, halfLife: 3, force: 1, beta: 2 });

/** Integer range of each param once divided by its step (what the token stores). */
const PARAM_UNITS = Object.freeze(Object.fromEntries(PARAM_KEYS.map((key) => {
  const { min, max, step } = PARAM_LIMITS[key];
  return [key, Object.freeze({ min: Math.round(min / step), max: Math.round(max / step) })];
})));

/** One character per affinity level / species count. Index 0..40 encodes -1..+1. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
const AFFINITY_LEVELS = Math.round(2 / AFFINITY_STEP) + 1; // 41
const AFFINITY_ZERO = (AFFINITY_LEVELS - 1) / 2;           // index of 0.00

const PREFIX = `t${GENOME_VERSION}`;
const TOKEN_RE = /^[A-Za-z0-9._~-]+$/;
const BASE36_RE = /^[0-9a-z]{1,7}$/;   // 36^7 > 2^32, so any uint32 seed fits
const MAX_TOKEN_LENGTH = 256;          // a full 8-species token is ~110 characters
const MAX_INPUT_LENGTH = 4096;         // before trimming whitespace
const UINT32_MAX = 0xffffffff;

const DEFAULT_PARAMS = Object.freeze({ n: 5000, rMax: 0.055, halfLife: 0.040, force: 10, beta: 0.30 });

// ---------------------------------------------------------------------------
// Randomness and hashing

/**
 * Mulberry32: a tiny, fast, well-distributed 32-bit PRNG.
 * @param {number} seed uint32 (other numbers are coerced with >>> 0)
 * @returns {() => number} generator of floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 32-bit FNV-1a over the UTF-8 bytes of a string, for turning words into seeds.
 * Matches FNV-1a applied to `new TextEncoder().encode(str)` (lone surrogates
 * become U+FFFD, exactly as TextEncoder does).
 * @param {string} str
 * @returns {number} uint32
 */
export function hashString(str) {
  const s = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    }
    if (c < 0x80) {
      h = Math.imul(h ^ c, 0x01000193);
    } else if (c < 0x800) {
      h = Math.imul(h ^ (0xc0 | (c >> 6)), 0x01000193);
      h = Math.imul(h ^ (0x80 | (c & 63)), 0x01000193);
    } else if (c < 0x10000) {
      h = Math.imul(h ^ (0xe0 | (c >> 12)), 0x01000193);
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), 0x01000193);
      h = Math.imul(h ^ (0x80 | (c & 63)), 0x01000193);
    } else {
      h = Math.imul(h ^ (0xf0 | (c >> 18)), 0x01000193);
      h = Math.imul(h ^ (0x80 | ((c >> 12) & 63)), 0x01000193);
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), 0x01000193);
      h = Math.imul(h ^ (0x80 | (c & 63)), 0x01000193);
    }
  }
  return h >>> 0;
}

/**
 * Derive an independent sub-seed (murmur3 finaliser over seed ^ salt), so a
 * genome's matrix stream is not the same stream that later places its particles.
 */
function deriveSeed(seed, salt) {
  let h = (seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function toUint32(seed) {
  const v = Number(seed);
  return Number.isFinite(v) ? v >>> 0 : 0;
}

// ---------------------------------------------------------------------------
// Quantisation

/**
 * Clamp to [-1, 1] and round to a multiple of AFFINITY_STEP, returning a clean
 * float: the same double as the two-decimal literal (0.3, never
 * 0.30000000000000004) and never -0. Non-finite input becomes 0.
 */
export function quantizeAffinity(v) {
  let x = Number(v);
  if (!Number.isFinite(x)) return 0;
  if (x > 1) x = 1;
  else if (x < -1) x = -1;
  const q = Number((Math.round(x / AFFINITY_STEP) * AFFINITY_STEP).toFixed(2));
  return q === 0 ? 0 : q;
}

/** Clamp a parameter to its limits and round to its step (clean float). */
function quantizeParam(key, v) {
  const lim = PARAM_LIMITS[key];
  let x = Number(v);
  if (!Number.isFinite(x)) x = DEFAULT_PARAMS[key];
  if (x < lim.min) x = lim.min;
  else if (x > lim.max) x = lim.max;
  return unitsToParam(key, Math.round(x / lim.step));
}

/** Integer number of steps for an already quantised parameter value. */
function paramToUnits(key, v) {
  return Math.round(v / PARAM_LIMITS[key].step);
}

function unitsToParam(key, k) {
  const q = Number((k * PARAM_LIMITS[key].step).toFixed(PARAM_DECIMALS[key]));
  return q === 0 ? 0 : q;
}

function clampSpecies(S) {
  const v = Math.round(Number(S));
  if (!Number.isFinite(v)) throw new TypeError(`species must be a number, got ${S}`);
  return Math.min(SPECIES_MAX, Math.max(SPECIES_MIN, v));
}

/** One affinity drawn uniformly from the 41 quantised levels -1, -0.95, ..., +1. */
function randomAffinity(rng) {
  const k = Math.min(AFFINITY_LEVELS - 1, Math.floor(rng() * AFFINITY_LEVELS));
  return quantizeAffinity((k - AFFINITY_ZERO) * AFFINITY_STEP);
}

function normalizeParams(params) {
  const src = params && typeof params === 'object' ? params : {};
  const out = {};
  for (const key of PARAM_KEYS) out[key] = quantizeParam(key, key in src ? src[key] : DEFAULT_PARAMS[key]);
  return out;
}

// ---------------------------------------------------------------------------
// Genome construction

/** The default physical parameters: { n, rMax, halfLife, force, beta }. */
export function defaultParams() {
  return { ...DEFAULT_PARAMS };
}

/**
 * A canonical copy of any genome-like object: species clamped to 2..8, the
 * matrix trimmed or zero-padded to S*S and quantised, params clamped and
 * quantised (missing ones take defaults), seed coerced to uint32.
 * encodeGenome() uses it.
 * @throws {TypeError} if `g` is not an object or has no usable species count
 */
export function normalizeGenome(g) {
  if (!g || typeof g !== 'object') throw new TypeError('genome must be an object');
  const S = clampSpecies(g.species);
  const src = g.matrix;
  const matrix = new Array(S * S);
  for (let k = 0; k < S * S; k++) matrix[k] = quantizeAffinity(src && k < src.length ? src[k] : 0);
  return { v: GENOME_VERSION, species: S, matrix, params: normalizeParams(g.params), seed: toUint32(g.seed) };
}

/**
 * A random world.
 * @param {number} seed uint32; also becomes the genome's seed (initial positions)
 * @param {{ species?: number, params?: object }} [opts] species 2..8 (default:
 *   chosen from the seed in 3..7); params: a partial override of the defaults
 */
export function randomGenome(seed, opts) {
  opts = opts || {};
  const s = toUint32(seed);
  const rng = mulberry32(deriveSeed(s, 1));
  // Always draw the species count so the matrix stream does not depend on
  // whether the caller fixed S: the same seed gives the same top-left block.
  const drawn = 3 + Math.min(4, Math.floor(rng() * 5));
  const S = opts.species == null ? drawn : clampSpecies(opts.species);
  const matrix = new Array(S * S);
  for (let k = 0; k < S * S; k++) matrix[k] = randomAffinity(rng);
  return {
    v: GENOME_VERSION,
    species: S,
    matrix,
    params: normalizeParams({ ...DEFAULT_PARAMS, ...(opts.params || {}) }),
    seed: s,
  };
}

/**
 * A NEW genome with 1-3 matrix entries nudged by +/-(0.1 .. scale). Params and
 * seed are kept. Every chosen entry is guaranteed to change: if the nudge would
 * be swallowed by the [-1, 1] clamp it is applied in the other direction.
 * @param {object} genome
 * @param {number} seed uint32 seed for this mutation
 * @param {{ entries?: number, scale?: number }} [opts] entries 1..3 (default: random), scale default 0.35
 */
export function mutateGenome(genome, seed, opts) {
  opts = opts || {};
  const g = cloneGenome(genome);
  const rng = mulberry32(toUint32(seed));
  const total = g.species * g.species;
  const drawn = 1 + Math.min(2, Math.floor(rng() * 3));
  const wanted = opts.entries == null ? drawn : Math.min(3, Math.max(1, Math.round(Number(opts.entries)) || 1));
  const count = Math.min(wanted, total);
  let scale = opts.scale == null ? 0.35 : Number(opts.scale);
  if (!Number.isFinite(scale)) scale = 0.35;
  scale = Math.min(2, Math.max(AFFINITY_STEP, scale));
  const lo = Math.min(0.1, scale);

  // Partial Fisher-Yates: the first `count` slots become distinct random entries.
  const idx = new Array(total);
  for (let k = 0; k < total; k++) idx[k] = k;
  for (let k = 0; k < count; k++) {
    const pick = k + Math.min(total - k - 1, Math.floor(rng() * (total - k)));
    const tmp = idx[k]; idx[k] = idx[pick]; idx[pick] = tmp;
    const e = idx[k];
    const mag = lo + rng() * (scale - lo);
    const sign = rng() < 0.5 ? -1 : 1;
    const before = g.matrix[e];
    let after = quantizeAffinity(before + sign * mag);
    if (after === before) after = quantizeAffinity(before - sign * mag);
    g.matrix[e] = after;
  }
  return g;
}

/**
 * A NEW genome with S species. The overlapping top-left block of the matrix is
 * kept; new rows and columns are filled with random quantised affinities drawn
 * row-major from `seed`. Params and genome seed are kept.
 */
export function withSpecies(genome, S, seed) {
  const g = cloneGenome(genome);
  const S0 = g.species;
  const S1 = clampSpecies(S);
  if (S1 === S0) return g;
  const rng = mulberry32(toUint32(seed));
  const matrix = new Array(S1 * S1);
  for (let i = 0; i < S1; i++) {
    for (let j = 0; j < S1; j++) {
      matrix[i * S1 + j] = i < S0 && j < S0 ? g.matrix[i * S0 + j] : randomAffinity(rng);
    }
  }
  g.species = S1;
  g.matrix = matrix;
  return g;
}

/** A deep copy (the matrix becomes a plain array even if a typed array was passed). */
export function cloneGenome(g) {
  return {
    v: g.v,
    species: g.species,
    matrix: Array.from(g.matrix),
    params: { ...g.params },
    seed: g.seed,
  };
}

/** Structural equality: version, species, every matrix entry, every param, seed. */
export function genomesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a.v !== b.v || a.species !== b.species || a.seed !== b.seed) return false;
  const ma = a.matrix, mb = b.matrix;
  if (!ma || !mb || ma.length !== mb.length) return false;
  for (let k = 0; k < ma.length; k++) if (ma[k] !== mb[k]) return false;
  const pa = a.params, pb = b.params;
  if (!pa || !pb) return false;
  for (const key of PARAM_KEYS) if (pa[key] !== pb[key]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Encoding
//
// Token: `t1.` + one char for S + one char per matrix entry (alphabet index
// 0..40 for -1..+1) + `.` + n, rMax, halfLife, force, beta (each as an integer
// count of its PARAM_LIMITS step) and the seed, all base36, joined by `.`.
//   e.g. t1.3b2QIO1A8E.1e.1j.14.2s.u.1tgb0b  (3 species, default params)

/**
 * Encode a genome as a URL-fragment-safe token matching /^[A-Za-z0-9._~-]+$/.
 * The genome is normalised first, so the token always decodes; the round trip
 * is exact for any genome that is already quantised.
 */
export function encodeGenome(genome) {
  const g = normalizeGenome(genome);
  let body = ALPHABET[g.species];
  for (let k = 0; k < g.matrix.length; k++) {
    body += ALPHABET[Math.round(g.matrix[k] / AFFINITY_STEP) + AFFINITY_ZERO];
  }
  const fields = [PREFIX, body];
  for (const key of PARAM_KEYS) fields.push(paramToUnits(key, g.params[key]).toString(36));
  fields.push(g.seed.toString(36));
  return fields.join('.');
}

/**
 * Decode a token produced by encodeGenome(). Tolerates surrounding whitespace
 * and a leading `#`. Returns null (never throws) for anything malformed, of
 * another version, or with any field out of range.
 */
export function decodeGenome(str) {
  try {
    if (typeof str !== 'string' || str.length > MAX_INPUT_LENGTH) return null;
    let s = str.trim();
    if (s.charCodeAt(0) === 35 /* # */) s = s.slice(1).trim();
    if (s.length === 0 || s.length > MAX_TOKEN_LENGTH || !TOKEN_RE.test(s)) return null;

    const parts = s.split('.');
    if (parts.length !== 2 + PARAM_KEYS.length + 1 || parts[0] !== PREFIX) return null;

    const body = parts[1];
    const S = ALPHABET.indexOf(body.charAt(0));
    if (S < SPECIES_MIN || S > SPECIES_MAX || body.length !== 1 + S * S) return null;
    const matrix = new Array(S * S);
    for (let k = 0; k < S * S; k++) {
      const level = ALPHABET.indexOf(body.charAt(k + 1));
      if (level < 0 || level >= AFFINITY_LEVELS) return null;
      matrix[k] = quantizeAffinity((level - AFFINITY_ZERO) * AFFINITY_STEP);
    }

    const params = {};
    for (let p = 0; p < PARAM_KEYS.length; p++) {
      const key = PARAM_KEYS[p];
      const units = parseBase36(parts[2 + p]);
      if (units < PARAM_UNITS[key].min || units > PARAM_UNITS[key].max) return null;
      params[key] = unitsToParam(key, units);
    }

    const seed = parseBase36(parts[2 + PARAM_KEYS.length]);
    if (seed < 0 || seed > UINT32_MAX) return null;

    return { v: GENOME_VERSION, species: S, matrix, params, seed };
  } catch {
    return null;
  }
}

/** Strict lowercase base36 integer of 1..7 digits, or -1. */
function parseBase36(s) {
  if (typeof s !== 'string' || !BASE36_RE.test(s)) return -1;
  return parseInt(s, 36);
}
