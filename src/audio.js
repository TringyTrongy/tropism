// Sonification of the dish: an optional, quiet listening mode.
//
// Each species is one soft voice on an A minor pentatonic scale, species 0
// lowest. A voice is two slightly detuned oscillators (sine + triangle) through
// a lowpass filter and a gain. What you hear is the state of the dish:
//
//   loudness   <- aggregation  (well mixed = near silent, clustered = present)
//   brightness <- mean speed   (slow = dark, fast = open filter)
//
// A slow, per-voice tremolo keeps held notes breathing; a generated stereo
// impulse gives them a room; a compressor and a master gain near -18 dBFS keep
// the whole thing polite. Every parameter change goes through setTargetAtTime,
// so nothing ever clicks.

const MAX_VOICES = 8;
const ROOT_MIDI = 45;                         // A2, 110 Hz
const MINOR_PENTATONIC = [0, 3, 5, 7, 10];    // semitones above the root
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

const DETUNE_CENTS = 4;                       // sine -4, triangle +4
const TRIANGLE_MIX = 0.55;                    // triangle level relative to the sine
const FILTER_Q = 0.8;

const AGGREGATION_FULL = 20;                  // aggregation at which a voice is at full level
const SILENT_DB = -36;                        // level of a well-mixed species, re full
const VOICE_PEAK = 0.5;                       // per-voice amplitude at full, divided by sqrt(S)
const SPEED_FULL = 8;                         // r_max per second at which the filter is fully open
const CUTOFF_MIN = 300;                       // Hz
const CUTOFF_MAX = 3000;                      // Hz

const LFO_BASE_HZ = 0.055;                    // slowest tremolo; each voice a little faster
const LFO_SPREAD = 0.37;
const LFO_DEPTH = 0.18;                       // tremolo swings the voice between 0.64 and 1.0
const PAN = [-0.1, 0.1, -0.22, 0.22, -0.34, 0.34, -0.46, 0.46];  // low voices near the centre

const REVERB_SECONDS = 2.8;
const REVERB_PREDELAY = 0.012;                // s
const REVERB_SEND_HIGHPASS = 160;             // Hz: keeps the low voices out of the tail's mud
const DRY = 1;
const WET = 0.35;
const MASTER_GAIN = 0.12;                     // about -18 dBFS

const GAIN_TC = 0.3;                          // s, setTargetAtTime time constants
const CUTOFF_TC = 0.2;
const FADE_IN_TC = 0.25;
const FADE_OUT_TC = 0.09;                     // about -38 dB when the 400 ms fade ends
const FADE_OUT_MS = 400;

function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function voiceMidi(i) {
  return ROOT_MIDI + 12 * Math.floor(i / MINOR_PENTATONIC.length) + MINOR_PENTATONIC[i % MINOR_PENTATONIC.length];
}

/** Fundamental of each species' voice, in Hz (A2, C3, D3, E3, G3, A3, C4, D4). */
export const VOICE_HZ = Object.freeze(Array.from({ length: MAX_VOICES }, (_, i) => midiToHz(voiceMidi(i))));

/** Note name of each species' voice, e.g. 'A2'. */
export const VOICE_NOTES = Object.freeze(Array.from({ length: MAX_VOICES }, (_, i) => {
  const m = voiceMidi(i);
  return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
}));

/** Voice level in [0, 1] for an aggregation ratio: 1 (well mixed) -> 0, 20 and above -> 1. */
export function loudnessFor(aggregation) {
  if (!(aggregation > 1)) return 0;
  return Math.min(1, Math.log(aggregation) / Math.log(AGGREGATION_FULL));
}

/** Lowpass cutoff in Hz for a mean speed in r_max per second (300 Hz .. 3 kHz, exponential). */
export function cutoffFor(meanSpeed) {
  const s = meanSpeed > 0 ? meanSpeed : 0;
  const t = Math.min(1, Math.log1p(s) / Math.log1p(SPEED_FULL));
  return CUTOFF_MIN * Math.pow(CUTOFF_MAX / CUTOFF_MIN, t);
}

/** Linear amplitude for a level in [0, 1]: a decibel ramp from SILENT_DB to 0 dB. */
function amplitudeFor(level) {
  return Math.pow(10, (SILENT_DB * (1 - level)) / 20);
}

/**
 * A stereo impulse response: decaying noise that darkens as it ages (a one-pole
 * lowpass closing over the tail), -60 dB at `seconds`, after a short predelay.
 * Deterministic (xorshift32), decorrelated between the two channels.
 */
function makeImpulse(ctx, seconds) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.round(seconds * rate));
  const buffer = ctx.createBuffer(2, length, rate);
  const predelay = Math.round(REVERB_PREDELAY * rate);
  const attack = Math.max(1, Math.round(0.004 * rate));
  const decay = Math.log(1000) / seconds;     // -60 dB at the end
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let state = ch === 0 ? 0x9e3779b9 | 0 : 0x7f4a7c15 | 0;
    let y = 0;
    for (let k = 0; k < length; k++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const white = (state >>> 0) / 4294967296 * 2 - 1;
      y += (0.85 - 0.7 * (k / length)) * (white - y);
      if (k < predelay) {
        data[k] = 0;
      } else {
        const env = Math.exp((-decay * k) / rate) * Math.min(1, (k - predelay) / attack);
        data[k] = y * env;
      }
    }
  }
  return buffer;
}

function createVoice(ctx, i, output) {
  const hz = VOICE_HZ[i];
  const sine = ctx.createOscillator();
  sine.type = 'sine';
  sine.frequency.value = hz;
  sine.detune.value = -DETUNE_CENTS;

  const triangle = ctx.createOscillator();
  triangle.type = 'triangle';
  triangle.frequency.value = hz;
  triangle.detune.value = DETUNE_CENTS;
  const triangleMix = ctx.createGain();
  triangleMix.gain.value = TRIANGLE_MIX;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = CUTOFF_MIN;
  filter.Q.value = FILTER_Q;

  const amp = ctx.createGain();               // follows aggregation
  amp.gain.value = 0;

  // Tremolo: the LFO swings this gain around 1 - depth by +-depth, so it can
  // only ever breathe a sounding voice, never wake a silent one.
  const breath = ctx.createGain();
  breath.gain.value = 1 - LFO_DEPTH;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = LFO_BASE_HZ * (1 + LFO_SPREAD * i);
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = LFO_DEPTH;

  sine.connect(filter);
  triangle.connect(triangleMix);
  triangleMix.connect(filter);
  filter.connect(amp);
  amp.connect(breath);
  lfo.connect(lfoDepth);
  lfoDepth.connect(breath.gain);

  if (typeof ctx.createStereoPanner === 'function') {
    const pan = ctx.createStereoPanner();
    pan.pan.value = PAN[i];
    breath.connect(pan);
    pan.connect(output);
  } else {
    breath.connect(output);
  }

  const t = ctx.currentTime;
  sine.start(t);
  triangle.start(t);
  lfo.start(t);
  return { amp, filter };
}

function buildGraph(ctx) {
  const master = ctx.createGain();
  master.gain.value = 0;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -20;
  compressor.knee.value = 18;
  compressor.ratio.value = 3.5;
  compressor.attack.value = 0.015;
  compressor.release.value = 0.35;

  const bus = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = DRY;
  const send = ctx.createBiquadFilter();
  send.type = 'highpass';
  send.frequency.value = REVERB_SEND_HIGHPASS;
  send.Q.value = 0.7;
  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx, REVERB_SECONDS);
  const wet = ctx.createGain();
  wet.gain.value = WET;

  bus.connect(dry);
  dry.connect(compressor);
  bus.connect(send);
  send.connect(reverb);
  reverb.connect(wet);
  wet.connect(compressor);
  compressor.connect(master);
  master.connect(ctx.destination);

  const voices = [];
  for (let i = 0; i < MAX_VOICES; i++) voices.push(createVoice(ctx, i, bus));
  return { master, voices };
}

function audioContextClass() {
  const g = globalThis;
  const AC = g.AudioContext || g.webkitAudioContext;
  return typeof AC === 'function' ? AC : null;
}

/**
 * returns { start() -> Promise<boolean>, stop(), running, update(stats) }
 *
 * start() must be called from a user gesture (it creates or resumes the
 * AudioContext synchronously, before its first await) and resolves false when
 * Web Audio is unavailable. update(stats) is a no-op while not running.
 */
export function createSonifier() {
  let ctx = null;
  let graph = null;
  let running = false;
  let generation = 0;           // bumps on every start/stop, so a stale start cannot win
  let suspendTimer = 0;
  // Last scheduled targets, so steady stats do not pile up automation events.
  const lastGain = new Float32Array(MAX_VOICES);
  const lastCutoff = new Float32Array(MAX_VOICES).fill(CUTOFF_MIN);

  function clearSuspend() {
    if (suspendTimer) {
      clearTimeout(suspendTimer);
      suspendTimer = 0;
    }
  }

  function ensureContext() {
    if (ctx && ctx.state !== 'closed') return true;
    const AC = audioContextClass();
    if (!AC) return false;
    try {
      ctx = new AC({ latencyHint: 'playback' });
    } catch {
      try {
        ctx = new AC();
      } catch {
        ctx = null;
        return false;
      }
    }
    try {
      graph = buildGraph(ctx);
    } catch {
      try { ctx.close(); } catch { /* already unusable */ }
      ctx = null;
      graph = null;
      return false;
    }
    lastGain.fill(0);
    lastCutoff.fill(CUTOFF_MIN);
    return true;
  }

  async function start() {
    const gen = ++generation;
    clearSuspend();
    if (!ensureContext()) return false;

    // Synchronous with the gesture: resume() must be called before any await.
    // It is called even when the context reports 'running': a suspend() issued
    // by an earlier stop() may still be in flight (state only changes once it
    // completes), and control messages run in order, so resuming after it is
    // the only way to be sure the context ends up running.
    let resuming;
    try {
      resuming = ctx.resume();
    } catch {
      return false;
    }
    graph.master.gain.setTargetAtTime(MASTER_GAIN, ctx.currentTime, FADE_IN_TC);
    running = true;

    try {
      await resuming;
    } catch {
      if (gen === generation) running = false;
      return false;
    }
    return gen === generation && running;
  }

  function stop() {
    if (!ctx || !running) return;
    generation++;
    running = false;
    graph.master.gain.setTargetAtTime(0, ctx.currentTime, FADE_OUT_TC);
    clearSuspend();
    suspendTimer = setTimeout(() => {
      suspendTimer = 0;
      if (running || !ctx || ctx.state !== 'running') return;
      ctx.suspend().catch(() => { /* the context may have been closed meanwhile */ });
    }, FADE_OUT_MS);
  }

  function update(stats) {
    if (!running || !ctx || !graph || !stats) return;
    const now = ctx.currentTime;
    const S = Math.max(0, Math.min(MAX_VOICES, stats.S | 0));
    const peak = VOICE_PEAK / Math.sqrt(Math.max(1, S));
    const { count, aggregation, meanSpeed } = stats;
    for (let i = 0; i < MAX_VOICES; i++) {
      const voice = graph.voices[i];
      const present = i < S && (!count || count[i] > 0);
      // Voices beyond S fade out and keep their last brightness.
      const gain = present ? peak * amplitudeFor(loudnessFor(aggregation ? aggregation[i] : 1)) : 0;
      const cutoff = present ? cutoffFor(meanSpeed ? meanSpeed[i] : 0) : lastCutoff[i];

      if (Math.abs(gain - lastGain[i]) > 1e-4 || (gain === 0 && lastGain[i] !== 0)) {
        voice.amp.gain.setTargetAtTime(gain, now, GAIN_TC);
        lastGain[i] = gain;
      }
      if (Math.abs(cutoff - lastCutoff[i]) > lastCutoff[i] * 0.005) {
        voice.filter.frequency.setTargetAtTime(cutoff, now, CUTOFF_TC);
        lastCutoff[i] = cutoff;
      }
    }
  }

  return {
    start,
    stop,
    update,
    get running() {
      return running;
    },
  };
}
