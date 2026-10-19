// Engine benchmark: time World#step() at the default parameters.
//
//   node tests/bench.mjs                  primary run + a sweep over random genomes
//   node tests/bench.mjs --presets        also time every preset once it has settled (~2 min)
//   node tests/bench.mjs --n 8000         a different particle count
//   node tests/bench.mjs --sweep 0        skip the random sweep
//   node tests/bench.mjs --strict         exit 1 if the primary run misses the target
//
// The cost of a step depends on the world's state, not just n: it is
// proportional to the number of interacting pairs, so a clustered world costs
// several times more than a well-mixed one, and a world gets more expensive as
// its bodies form. The primary run ('bench' genome, a few hundred steps from a
// uniform start) is the reference measurement. It is not a worst
// case: the authored presets settle to aggregation between about 2 and 17,
// and after 1500 steps the densest cost two to three times as much per step;
// --presets reports them so that the figure's real workload is visible too.

import { performance } from 'node:perf_hooks';
import { World } from '../src/sim.js';
import { randomGenome, hashString, defaultParams, decodeGenome } from '../src/genome.js';
import { PRESETS } from '../src/presets.js';

const TARGET_MS = 6;
const WARMUP_STEPS = 60;
const TIMED_STEPS = 300;
/** Steps a preset runs before it is timed (30 s of simulated time). */
const PRESET_SETTLE_STEPS = 1500;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const k = args.indexOf(name);
  return k >= 0 && k + 1 < args.length ? Number(args[k + 1]) : fallback;
};
const n = option('--n', defaultParams().n);
const sweepCount = option('--sweep', 8);

/** Time TIMED_STEPS steps after `warmup` untimed ones; returns per-step statistics in ms. */
function run(genome, warmup = WARMUP_STEPS) {
  const world = new World(Math.max(12000, n));
  world.reset({ ...genome, params: { ...genome.params, n } });
  for (let s = 0; s < warmup; s++) world.step();
  const times = new Float64Array(TIMED_STEPS);
  const t0 = performance.now();
  for (let s = 0; s < TIMED_STEPS; s++) {
    const a = performance.now();
    world.step();
    times[s] = performance.now() - a;
  }
  const total = performance.now() - t0;
  const sorted = Array.from(times).sort((a, b) => a - b);
  const stats = world.stats();
  return {
    mean: total / TIMED_STEPS,
    p50: sorted[Math.floor(0.5 * (TIMED_STEPS - 1))],
    p95: sorted[Math.floor(0.95 * (TIMED_STEPS - 1))],
    last50: times.subarray(TIMED_STEPS - 50).reduce((x, y) => x + y, 0) / 50,
    aggregation: stats.aggregationAll,
    speed: stats.meanSpeedAll,
    S: world.S,
  };
}

const fmt = (v) => v.toFixed(2).padStart(6);
const row = (label, r) =>
  `${label.padEnd(17)} S=${r.S}  mean ${fmt(r.mean)}  p50 ${fmt(r.p50)}  p95 ${fmt(r.p95)}  last-50 ${fmt(r.last50)} ms/step` +
  `   aggregation ${r.aggregation.toFixed(2)}  speed ${r.speed.toFixed(2)} r_max/s`;

console.log(`Tropism engine benchmark: n = ${n}, defaults ${JSON.stringify(defaultParams())}`);
console.log(`node ${process.version}, ${WARMUP_STEPS} warm-up + ${TIMED_STEPS} timed steps per world\n`);

const primary = run(randomGenome(hashString('bench')));
console.log(row("'bench'", primary));

if (sweepCount > 0) {
  const means = [];
  for (let seed = 1; seed <= sweepCount; seed++) {
    const r = run(randomGenome(seed));
    means.push(r.mean);
    console.log(row(`seed ${seed}`, r));
  }
  means.sort((a, b) => a - b);
  const avg = means.reduce((x, y) => x + y, 0) / means.length;
  console.log(`\nsweep: mean of means ${avg.toFixed(2)} ms/step, worst ${means[means.length - 1].toFixed(2)} ms/step`);
}

if (flag('--presets')) {
  console.log(`\nPresets after ${PRESET_SETTLE_STEPS} settling steps (the figure's real workload):`);
  const means = [];
  for (const preset of PRESETS) {
    const r = run(decodeGenome(preset.code), PRESET_SETTLE_STEPS);
    means.push(r.mean);
    console.log(row(preset.id, r));
  }
  const avg = means.reduce((x, y) => x + y, 0) / means.length;
  console.log(`presets: mean of means ${avg.toFixed(2)} ms/step, worst ${Math.max(...means).toFixed(2)} ms/step`);
}

const ok = primary.mean <= TARGET_MS;
console.log(`\nprimary: ${primary.mean.toFixed(2)} ms/step against a target of ${TARGET_MS} ms/step: ${ok ? 'PASS' : 'OVER TARGET'}`);
if (!ok && flag('--strict')) process.exitCode = 1;
