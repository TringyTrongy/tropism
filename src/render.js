// Tropism dish renderer (panel a).
//
// Draws the live particles of a World onto a <canvas> as species markers, on figure
// paper, through a view onto the torus:
//
//   visible width  w = 1 / zoom
//   left = cx - w/2, top = cy - w/2
//   u = fract(x - left) / w,  v = fract(y - top) / w      (u, v in [0, 1] are on the dish)
//
// The dish is the largest centred square of the canvas; screen y grows downward, so
// world y grows downward on screen too (v = 0 is the top edge of the dish).
//
// Two backends share one public API and one mapping:
//   - WebGL2: instanced quads, a signed-distance marker per species with ~1px
//     antialiasing, premultiplied alpha, optional ping-pong trail buffers.
//   - Canvas2D: fillRect dots batched by species (true marker shapes once they are
//     large enough to read), the same trails, path and ring.
// The WebGL2 path is chosen whenever a WebGL2 context can be created and its programs
// compile; otherwise the Canvas2D path is used.
//
// Hot paths allocate nothing: particle data is packed into a persistent Float32Array of
// the world's capacity and uploaded with bufferSubData for the live count only, and the
// path's segment buffer only ever grows.

import { SPECIES, SPECIES_MAX, MARKER_INDEX, currentTheme, paletteCSS, paletteRGB, markerPath } from './markers.js';

// ---------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------

/** Marker radius in device px is max(RADIUS_MIN_PX, RADIUS_PER_DISH * zoom * dishPx). */
const RADIUS_MIN_PX = 1.35;
const RADIUS_PER_DISH = 0.0026;
/** Upper bound so a pathological zoom cannot ask for screen-sized quads. */
const RADIUS_MAX_PX = 96;
/** Farthest marker vertex from its centre, in units of r (the triangle's base corners: 1.309 r). */
const MARKER_EXTENT = 1.32;
/** Below SHAPE_FROM px radius every species is an equal-area disc; above SHAPE_TO, its full marker. */
const SHAPE_FROM_PX = 2.4;
const SHAPE_TO_PX = 4.2;
/**
 * Radius of the disc with the same area as each marker, in units of r, indexed by MARKER_INDEX
 * (computed from the markerPath polygons), so a species keeps its ink weight while it morphs
 * from dot to marker as the view zooms in.
 */
const DISC_EQUAL_AREA = [1.0, 0.99297, 0.81275, 0.95746, 0.81275, 0.92829, 0.92829, 0.81103];

/**
 * Particle opacity. Both themes composite ink over paper (premultiplied "over"), so dense bodies keep
 * their species hue: an additive or screen blend would saturate them to white on the inverse print.
 */
const ALPHA_LIGHT = 0.9;
const ALPHA_DARK = 0.9;
/** Opacity of the species that are not highlighted. */
const ALPHA_DIMMED = 0.18;

/** Fraction of the way back to paper the trail buffer moves every frame. */
const TRAIL_FADE = 0.07;
/**
 * Trails are long-exposure tracer tracks, as in a particle-tracking figure: only one particle in
 * TRAIL_STRIDE deposits into the trail buffer, as a thin dot (TRAIL_RADIUS of the marker), and the
 * live particles are drawn at full size on top. A dense body therefore leaves a few hairline
 * trajectories rather than a body-wide smear.
 */
const TRAIL_STRIDE = 8;
const TRAIL_RADIUS = 0.34;
const TRAIL_ALPHA = 0.8;
/**
 * The smallest per-frame step toward paper, in 8-bit levels. Without it an 8-bit buffer stalls a
 * few levels short of paper (0.12 x 4 levels rounds to nothing) and old trails never fully clear.
 */
const TRAIL_MIN_STEP = 1.5 / 255;
/** The Canvas2D fallback's equivalent: an exact, clamped step of this many 8-bit levels. */
const TRAIL_STEP_2D = 2;
const TRAIL_STEP_2D_CSS = `rgb(${TRAIL_STEP_2D}, ${TRAIL_STEP_2D}, ${TRAIL_STEP_2D})`;

/** Tracked-path styling, in CSS px. */
const PATH_WIDTH_CSS = 1;
const RING_RADIUS_CSS = 7;
const RING_STROKE_CSS = 1;           // a hairline, like every other ink line in the figure
/** Opacity of the oldest point of the path; the newest is fully opaque, so time reads as ink. */
const PATH_ALPHA_OLDEST = 0.3;
/** Canvas2D strokes the path in this many opacity steps (one stroke call each). */
const PATH_BUCKETS_2D = 8;

const ZOOM_MAX = 64;

const GL_ATTRIBUTES = {
  alpha: false,
  antialias: false,           // markers antialias themselves in the fragment shader
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: true,   // a software GL is slower than the Canvas2D path
};

const THEME_DEFAULTS = {
  light: { paper: [1, 1, 1], ink: [17 / 255, 19 / 255, 22 / 255] },
  dark: { paper: [12 / 255, 13 / 255, 15 / 255], ink: [236 / 255, 238 / 255, 240 / 255] },
};

// ---------------------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------------------

/** v mod 1 in [0, 1). Guards the float edge case where v - floor(v) rounds up to exactly 1. */
function wrap01(v) {
  const r = v - Math.floor(v);
  return r >= 1 ? 0 : r;
}

/** Nearest torus image of v relative to centre c, as an offset in [-0.5, 0.5). */
function centred(v, c) {
  return wrap01(v - c + 0.5) - 0.5;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Fold the sliver of the torus just before the view's leading edge to negative coordinates, so
 * a marker centred there still overlaps the dish; every other point keeps its [0, 1) image.
 * `f` is fract(x - left), `span` the visible width, `margin` the marker reach (world units).
 * Mirrored exactly by foldAxis() in the particle vertex shader.
 */
function foldAxis(f, span, margin) {
  return f > 1 - margin && f > span + margin ? f - 1 : f;
}

function nextCapacity(needed, current) {
  let c = Math.max(64, current);
  while (c < needed) c *= 2;
  return c;
}

// ---------------------------------------------------------------------------------------
// View and dish geometry (shared by both backends)
// ---------------------------------------------------------------------------------------

function createGeometry() {
  return {
    cssW: 0, cssH: 0, dpr: 1,
    devW: 1, devH: 1,                    // canvas.width / canvas.height
    dishX: 0, dishY: 0, dishSize: 0,     // the dish square in device px (y down), pixel-aligned
    offX: 0, offY: 0, sideX: 0, sideY: 0, // the same square in CSS px, relative to the canvas box
    cx: 0.5, cy: 0.5, zoom: 1,
    span: 1, left: 0, top: 0,            // visible width and the view's top-left corner (world)
  };
}

/**
 * Fits the dish (the largest centred square) into the canvas. The square is placed on whole
 * device pixels so marker edges and the scissor stay crisp, and its CSS rectangle is derived
 * from those device pixels rather than computed separately: the browser stretches the drawing
 * buffer over the CSS box at cssW / devW (x) and cssH / devH (y) CSS px per device px, which is
 * only approximately 1 / dpr once the buffer size is rounded. Deriving it this way keeps
 * screenToWorld() and worldToScreen() exact inverses of what is on screen.
 */
function fitDish(geo, cssW, cssH, dpr, devW, devH) {
  geo.cssW = cssW;
  geo.cssH = cssH;
  geo.dpr = dpr;
  geo.devW = devW;
  geo.devH = devH;
  const side = Math.max(0, Math.min(cssW, cssH));
  geo.dishSize = Math.max(0, Math.min(devW, devH, Math.round(side * dpr)));
  geo.dishX = Math.round((devW - geo.dishSize) / 2);
  geo.dishY = Math.round((devH - geo.dishSize) / 2);
  const kx = cssW > 0 ? cssW / devW : 1 / dpr;
  const ky = cssH > 0 ? cssH / devH : 1 / dpr;
  geo.offX = geo.dishX * kx;
  geo.offY = geo.dishY * ky;
  geo.sideX = geo.dishSize * kx;
  geo.sideY = geo.dishSize * ky;
}

/** Applies a partial view; returns true when anything changed. */
function applyView(geo, view) {
  const zoom = Number.isFinite(view.zoom) ? clamp(view.zoom, 1, ZOOM_MAX) : geo.zoom;
  const cx = Number.isFinite(view.cx) ? wrap01(view.cx) : geo.cx;
  const cy = Number.isFinite(view.cy) ? wrap01(view.cy) : geo.cy;
  if (zoom === geo.zoom && cx === geo.cx && cy === geo.cy) return false;
  geo.zoom = zoom;
  geo.cx = cx;
  geo.cy = cy;
  geo.span = 1 / zoom;
  geo.left = cx - geo.span / 2;
  geo.top = cy - geo.span / 2;
  return true;
}

function markerRadius(geo) {
  return clamp(RADIUS_PER_DISH * geo.zoom * geo.dishSize, RADIUS_MIN_PX, RADIUS_MAX_PX);
}

// ---------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------

function createTheme() {
  return {
    name: 'light',
    dark: false,
    paper: new Float32Array(THEME_DEFAULTS.light.paper),
    ink: new Float32Array(THEME_DEFAULTS.light.ink),
    paperCSS: 'rgb(255, 255, 255)',
    inkCSS: 'rgb(17, 19, 22)',
    paperIsWhite: true,
    paperMin: 1,                                     // darkest paper channel, 0..1
    paletteRGB: new Float32Array(SPECIES_MAX * 3),   // all eight species, for the shader
    paletteCSS: new Array(SPECIES_MAX).fill('#000000'),
  };
}

let colorProbe = null;   // a detached 2D context used to normalise colour syntaxes we do not parse

/** Parses a CSS colour into [r, g, b] in 0..1, or null. Handles hex, rgb()/rgba() and anything a canvas understands. */
function parseColor(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/i.exec(s);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const p = parts[k];
      const v = p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p);
      if (!Number.isFinite(v)) return null;
      out[k] = clamp(v, 0, 255) / 255;
    }
    return out;
  }
  if (typeof document === 'undefined') return null;
  if (!colorProbe) {
    const probe = document.createElement('canvas');
    colorProbe = probe.getContext ? probe.getContext('2d') : null;
    if (!colorProbe) return null;
  }
  // The getter serialises any colour the context accepts back to #rrggbb or rgba().
  colorProbe.fillStyle = '#010203';
  colorProbe.fillStyle = s;
  const normalised = String(colorProbe.fillStyle);
  if (normalised === '#010203' && s.toLowerCase() !== '#010203') return null;
  return normalised.startsWith('#') || /^rgba?\(/i.test(normalised) ? parseColor(normalised) : null;
}

function cssFromRGB(rgb) {
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}

/** Re-reads --paper, --ink and the species palette for the document's current theme. */
function readTheme(theme) {
  const name = currentTheme();
  const defaults = THEME_DEFAULTS[name] || THEME_DEFAULTS.light;
  let paper = null;
  let ink = null;
  if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
    const style = getComputedStyle(document.documentElement);
    paper = parseColor(style.getPropertyValue('--paper'));
    ink = parseColor(style.getPropertyValue('--ink'));
  }
  paper = paper || defaults.paper;
  ink = ink || defaults.ink;
  theme.name = name;
  theme.dark = name === 'dark';
  theme.paper.set(paper);
  theme.ink.set(ink);
  theme.paperCSS = cssFromRGB(paper);
  theme.inkCSS = cssFromRGB(ink);
  theme.paperIsWhite = paper[0] >= 1 && paper[1] >= 1 && paper[2] >= 1;
  theme.paperMin = Math.min(paper[0], paper[1], paper[2]);
  const rgb = paletteRGB(SPECIES_MAX, name);
  const css = paletteCSS(SPECIES_MAX, name);
  for (let s = 0; s < SPECIES_MAX; s++) {
    theme.paletteRGB[s * 3] = rgb[s][0];
    theme.paletteRGB[s * 3 + 1] = rgb[s][1];
    theme.paletteRGB[s * 3 + 2] = rgb[s][2];
    theme.paletteCSS[s] = css[s];
  }
}

/** Fills `out` (length 8) with the opacity of every species for this frame. */
function fillAlphas(out, dark, highlight, S) {
  const base = dark ? ALPHA_DARK : ALPHA_LIGHT;
  const focused = Number.isInteger(highlight) && highlight >= 0 && highlight < S;
  for (let s = 0; s < SPECIES_MAX; s++) out[s] = !focused || s === highlight ? base : ALPHA_DIMMED;
}

function liveCount(world) {
  const n = world.n | 0;
  return Math.max(0, Math.min(n, world.x.length, world.y.length, world.species.length));
}

function speciesCount(world) {
  return clamp(world.S | 0, 1, SPECIES_MAX);
}

/** Normalises draw options without allocating. */
function readDrawOptions(opts, state) {
  state.trails = !!(opts && opts.trails);
  state.highlight = opts && Number.isInteger(opts.highlight) ? opts.highlight : -1;
  const path = opts && opts.path && typeof opts.path.length === 'number' ? opts.path : null;
  state.path = path;
  state.pathLength = path ? clamp(Math.floor(Number(opts.pathLength) || 0), 0, path.length >> 1) : 0;
  return state;
}

// ---------------------------------------------------------------------------------------
// Tracked path: map points to the view and decide where the line breaks
// ---------------------------------------------------------------------------------------

/**
 * Writes the view-centred torus offset (in [-0.5, 0.5) world units) of each path point into
 * `out`. Using the nearest image relative to the view centre makes the world's own seam
 * vanish wherever it falls inside a panned view; the only remaining discontinuity is the
 * antipode of the view centre, which is at or beyond the dish edge.
 */
function mapPathPoints(geo, path, count, out) {
  for (let k = 0; k < count; k++) {
    out[2 * k] = centred(path[2 * k], geo.cx);
    out[2 * k + 1] = centred(path[2 * k + 1], geo.cy);
  }
}

/**
 * True when the step from point a to point b must not be drawn: consecutive points more than
 * half the torus apart (a wrap of the data, or the view antipode), or both ends off the same
 * side of the dish. `reach` is the line's half extent in dish units.
 */
function segmentHidden(geo, mapped, a, b, reach) {
  const ax = mapped[2 * a], ay = mapped[2 * a + 1];
  const bx = mapped[2 * b], by = mapped[2 * b + 1];
  if (Math.abs(bx - ax) > 0.5 || Math.abs(by - ay) > 0.5) return true;
  const inv = 1 / geo.span;
  const au = ax * inv + 0.5, av = ay * inv + 0.5;
  const bu = bx * inv + 0.5, bv = by * inv + 0.5;
  const lo = -reach, hi = 1 + reach;
  return (au < lo && bu < lo) || (au > hi && bu > hi) || (av < lo && bv < lo) || (av > hi && bv > hi);
}

function pathAlpha(k, count) {
  return count > 1 ? PATH_ALPHA_OLDEST + (1 - PATH_ALPHA_OLDEST) * (k / (count - 1)) : 1;
}

// ---------------------------------------------------------------------------------------
// WebGL2 shaders
// ---------------------------------------------------------------------------------------

const PARTICLE_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 a_corner;     // unit quad corner in [-1, 1]^2 (y down)
layout(location = 1) in vec3 a_particle;   // world x, world y, species index

uniform vec2 u_origin;      // world coordinates of the view's top-left corner
uniform float u_span;       // visible width of the view in world units (1 / zoom)
uniform float u_margin;     // marker reach in world units
uniform vec3 u_dish;        // dish left, top, size in device px (y down)
uniform vec2 u_target;      // canvas size in device px
uniform float u_extent;     // quad half-size in device px
uniform vec3 u_color[8];
uniform float u_alpha[8];
uniform int u_kind[8];
uniform int u_stride;        // draw only every u_stride-th particle (trail tracers); 1 = all

out vec2 v_local;           // fragment offset from the marker centre, device px (y down)
flat out vec4 v_color;      // premultiplied
flat out int v_kind;

float foldAxis(float f) {
  return (f > 1.0 - u_margin && f > u_span + u_margin) ? f - 1.0 : f;
}

void main() {
  vec2 f = fract(a_particle.xy - u_origin);
  vec2 uv = vec2(foldAxis(f.x), foldAxis(f.y)) / u_span;
  float m = u_margin / u_span;
  v_local = vec2(0.0);
  v_color = vec4(0.0);
  v_kind = 0;
  if (u_stride > 1 && gl_InstanceID % u_stride != 0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (any(lessThan(uv, vec2(-m))) || any(greaterThan(uv, vec2(1.0 + m)))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // outside the clip volume: the instance vanishes
    return;
  }
  int s = clamp(int(a_particle.z + 0.5), 0, 7);
  vec2 local = a_corner * u_extent;
  vec2 pos = u_dish.xy + uv * u_dish.z + local;
  v_local = local;
  v_kind = u_kind[s];
  float a = u_alpha[s];
  v_color = vec4(u_color[s] * a, a);
  gl_Position = vec4(pos.x / u_target.x * 2.0 - 1.0, 1.0 - pos.y / u_target.y * 2.0, 0.0, 1.0);
}
`;

// Marker geometry mirrors markerPath() in markers.js, in the same y-down coordinates.
const PARTICLE_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_local;
flat in vec4 v_color;
flat in int v_kind;

uniform float u_radius;     // marker radius r in device px
uniform float u_shape;      // 0: equal-area disc ... 1: full marker

out vec4 o_color;

const float DISC[8] = float[8](${DISC_EQUAL_AREA.map((v) => v.toFixed(5)).join(', ')});
const float SQRT_HALF = 0.70710678;

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0);
}

float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0;
  vec2 e1 = p2 - p1;
  vec2 e2 = p0 - p2;
  vec2 v0 = p - p0;
  vec2 v1 = p - p1;
  vec2 v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

float sdPlus(vec2 p, float r) {
  float a = 1.12 * r;
  float b = 0.36 * r;
  return min(sdBox(p, vec2(b, a)), sdBox(p, vec2(a, b)));
}

// Five-pointed star, tip toward +y, outer radius r, inner radius r * rf.
float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-0.809016994375, -0.587785252292);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

float sdMarker(int kind, vec2 p, float r) {
  float t = 1.18 * r;
  if (kind == 1) return sdBox(p, vec2(0.88 * r));
  if (kind == 2) return sdTriangle(p, vec2(0.0, -t), vec2(0.92 * t, 0.62 * t), vec2(-0.92 * t, 0.62 * t));
  if (kind == 3) return (abs(p.x) + abs(p.y) - 1.2 * r) * SQRT_HALF;
  if (kind == 4) return sdTriangle(p, vec2(0.0, t), vec2(0.92 * t, -0.62 * t), vec2(-0.92 * t, -0.62 * t));
  if (kind == 5) return sdPlus(p, r);
  if (kind == 6) return sdPlus(vec2(p.x + p.y, p.y - p.x) * SQRT_HALF, r);
  if (kind == 7) return sdStar5(vec2(p.x, -p.y), 1.25 * r, 0.45);
  return length(p) - r;
}

void main() {
  float d = length(v_local) - u_radius * DISC[v_kind];
  if (u_shape > 0.0) d = mix(d, sdMarker(v_kind, v_local, u_radius), u_shape);
  float coverage = clamp(0.5 - d, 0.0, 1.0);   // distances are in device px: a 1px ramp
  if (coverage <= 0.0) discard;
  o_color = v_color * coverage;
}
`;

// A single oversized triangle that covers the whole target; no vertex buffer needed.
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

// Moves the previous trail image a fixed fraction of the way back to paper, but always by at
// least TRAIL_MIN_STEP (and never past paper), so the buffer returns exactly to paper.
const FADE_FS = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_prev;
uniform vec3 u_paper;
uniform float u_fade;

out vec4 o_color;

void main() {
  vec3 prev = texelFetch(u_prev, ivec2(gl_FragCoord.xy), 0).rgb;
  vec3 delta = u_paper - prev;
  vec3 size = abs(delta);
  vec3 stepSize = min(size, max(size * u_fade, vec3(${TRAIL_MIN_STEP.toFixed(6)})));
  o_color = vec4(prev + sign(delta) * stepSize, 1.0);
}
`;

const COPY_FS = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_source;

out vec4 o_color;

void main() {
  o_color = vec4(texelFetch(u_source, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
}
`;

// Path segments as screen-space quads: butt ends, a 1px antialiasing ramp across the line.
const SEGMENT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_corner;    // x: -1 start / +1 end, y: -1 / +1 side
layout(location = 1) in vec4 a_ends;      // x0, y0, x1, y1 in device px (y down)
layout(location = 2) in vec2 a_fade;      // opacity at the start and at the end

uniform vec2 u_target;
uniform float u_halfWidth;

out float v_across;
out float v_alpha;

void main() {
  vec2 p0 = a_ends.xy;
  vec2 p1 = a_ends.zw;
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 t = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float along = a_corner.x * 0.5 + 0.5;
  float reach = u_halfWidth + 1.0;
  vec2 pos = mix(p0, p1, along) + n * (a_corner.y * reach);
  v_across = a_corner.y * reach;
  v_alpha = mix(a_fade.x, a_fade.y, along);
  gl_Position = vec4(pos.x / u_target.x * 2.0 - 1.0, 1.0 - pos.y / u_target.y * 2.0, 0.0, 1.0);
}
`;

const SEGMENT_FS = `#version 300 es
precision highp float;

in float v_across;
in float v_alpha;

uniform float u_halfWidth;
uniform vec3 u_ink;

out vec4 o_color;

void main() {
  float coverage = clamp(u_halfWidth + 0.5 - abs(v_across), 0.0, 1.0) * v_alpha;
  if (coverage <= 0.0) discard;
  o_color = vec4(u_ink * coverage, coverage);
}
`;

const RING_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_corner;

uniform vec2 u_target;
uniform vec2 u_centre;      // device px (y down)
uniform float u_reach;      // quad half-size in device px

out vec2 v_local;

void main() {
  v_local = a_corner * u_reach;
  vec2 pos = u_centre + v_local;
  gl_Position = vec4(pos.x / u_target.x * 2.0 - 1.0, 1.0 - pos.y / u_target.y * 2.0, 0.0, 1.0);
}
`;

const RING_FS = `#version 300 es
precision highp float;

in vec2 v_local;

uniform float u_radius;
uniform float u_halfStroke;
uniform vec3 u_ink;

out vec4 o_color;

void main() {
  float d = abs(length(v_local) - u_radius) - u_halfStroke;
  float coverage = clamp(0.5 - d, 0.0, 1.0);
  if (coverage <= 0.0) discard;
  o_color = vec4(u_ink * coverage, coverage);
}
`;

/** Floats per path segment instance: x0, y0, x1, y1, alpha0, alpha1. */
const SEGMENT_FLOATS = 6;

// ---------------------------------------------------------------------------------------
// WebGL2 resources
// ---------------------------------------------------------------------------------------

function compileShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'no log (context lost?)';
    gl.deleteShader(shader);
    throw new Error(`Tropism renderer: ${label} ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader failed to compile: ${log}`);
  }
  return shader;
}

function linkProgram(gl, label, vsSource, fsSource, uniformNames) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource, label);
  let fs;
  try {
    fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource, label);
  } catch (err) {
    gl.deleteShader(vs);
    throw err;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  const log = linked ? '' : gl.getProgramInfoLog(program) || 'no log (context lost?)';
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!linked) {
    gl.deleteProgram(program);
    throw new Error(`Tropism renderer: ${label} program failed to link: ${log}`);
  }
  const u = {};
  for (const name of uniformNames) u[name] = gl.getUniformLocation(program, name);
  return { program, u };
}

/** Creates every program, buffer and vertex array the GL backend needs. Throws on failure. */
function buildGLResources(gl) {
  const res = { programs: [], buffers: [], vaos: [] };
  try {
    const particles = linkProgram(gl, 'particle', PARTICLE_VS, PARTICLE_FS, [
      'u_origin', 'u_span', 'u_margin', 'u_dish', 'u_target', 'u_extent',
      'u_color', 'u_alpha', 'u_kind', 'u_radius', 'u_shape', 'u_stride',
    ]);
    res.programs.push(particles);
    const fade = linkProgram(gl, 'trail fade', FULLSCREEN_VS, FADE_FS, ['u_prev', 'u_paper', 'u_fade']);
    res.programs.push(fade);
    const copy = linkProgram(gl, 'trail composite', FULLSCREEN_VS, COPY_FS, ['u_source']);
    res.programs.push(copy);
    const segments = linkProgram(gl, 'path', SEGMENT_VS, SEGMENT_FS, ['u_target', 'u_halfWidth', 'u_ink']);
    res.programs.push(segments);
    const ring = linkProgram(gl, 'ring', RING_VS, RING_FS, ['u_target', 'u_centre', 'u_reach', 'u_radius', 'u_halfStroke', 'u_ink']);
    res.programs.push(ring);

    // Constant uniforms: marker kind per species, texture unit 0 for both samplers.
    const kinds = new Int32Array(SPECIES_MAX);
    for (let s = 0; s < SPECIES_MAX; s++) kinds[s] = MARKER_INDEX[SPECIES[s].marker] ?? 0;
    gl.useProgram(particles.program);
    gl.uniform1iv(particles.u.u_kind, kinds);
    gl.useProgram(fade.program);
    gl.uniform1i(fade.u.u_prev, 0);
    gl.useProgram(copy.program);
    gl.uniform1i(copy.u.u_source, 0);
    gl.useProgram(null);

    const corners = gl.createBuffer();
    res.buffers.push(corners);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const instanceBuffer = gl.createBuffer();
    res.buffers.push(instanceBuffer);
    const segmentBuffer = gl.createBuffer();
    res.buffers.push(segmentBuffer);

    const bindCorners = () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    };

    const particleVAO = gl.createVertexArray();
    res.vaos.push(particleVAO);
    gl.bindVertexArray(particleVAO);
    bindCorners();
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 0);
    gl.vertexAttribDivisor(1, 1);

    const segmentVAO = gl.createVertexArray();
    res.vaos.push(segmentVAO);
    gl.bindVertexArray(segmentVAO);
    bindCorners();
    gl.bindBuffer(gl.ARRAY_BUFFER, segmentBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SEGMENT_FLOATS * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, SEGMENT_FLOATS * 4, 16);
    gl.vertexAttribDivisor(2, 1);

    const ringVAO = gl.createVertexArray();
    res.vaos.push(ringVAO);
    gl.bindVertexArray(ringVAO);
    bindCorners();

    const fullscreenVAO = gl.createVertexArray();   // no attributes: gl_VertexID drives it
    res.vaos.push(fullscreenVAO);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    Object.assign(res, {
      particles, fade, copy, segments, ring,
      instanceBuffer, segmentBuffer,
      particleVAO, segmentVAO, ringVAO, fullscreenVAO,
    });
    return res;
  } catch (err) {
    deleteGLResources(gl, res);
    throw err;
  }
}

function deleteGLResources(gl, res) {
  if (!res) return;
  for (const vao of res.vaos) gl.deleteVertexArray(vao);
  for (const buffer of res.buffers) gl.deleteBuffer(buffer);
  for (const p of res.programs) gl.deleteProgram(p.program);
  res.vaos.length = 0;
  res.buffers.length = 0;
  res.programs.length = 0;
}

/**
 * Compiles every program on a throwaway 1x1 canvas first. Once a WebGL2 context exists on the
 * real canvas it can never become a 2D canvas, so the fallback decision is made here.
 */
function probeWebGL2() {
  if (typeof document === 'undefined' || typeof WebGL2RenderingContext === 'undefined') return false;
  let gl = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    gl = canvas.getContext('webgl2', GL_ATTRIBUTES);
    if (!gl) return false;
    deleteGLResources(gl, buildGLResources(gl));
    return true;
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('Tropism renderer: WebGL2 unavailable, using Canvas2D.', err);
    return false;
  } finally {
    const lose = gl && gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }
}

// ---------------------------------------------------------------------------------------
// WebGL2 backend
// ---------------------------------------------------------------------------------------

function createGLBackend(canvas, gl, geo, theme) {
  // A context can be handed out already lost (GPU reset, too many contexts). Every GL call
  // would then fail, so wait for the restored event instead of treating it as a compile error.
  let lost = gl.isContextLost();
  let res = lost ? null : buildGLResources(gl);
  let disposed = false;

  let instances = null;            // Float32Array(capacity * 3): x, y, species per particle
  let gpuInstanceFloats = 0;       // size of the GPU instance buffer's storage, in floats
  let segments = new Float32Array(SEGMENT_FLOATS * 256);
  let gpuSegmentFloats = 0;
  let mapped = new Float32Array(2 * 256);

  let trail = null;                // { tex: [a, b], fbo: [a, b], w, h, cur }
  let trailsDirty = true;          // the trail buffers must be reset to paper before use
  let trailUnsupported = false;    // an RGBA8 colour target was incomplete: draw trails-free

  const alphas = new Float32Array(SPECIES_MAX);
  const trailAlphas = new Float32Array(SPECIES_MAX);
  const frame = { trails: false, highlight: -1, path: null, pathLength: 0 };
  const metrics = { kind: 'webgl2', radiusPx: 0, dishPx: 0, dpr: 1, zoom: 1, contextLost: false };

  function onContextLost(event) {
    event.preventDefault();      // tell the browser we intend to restore
    lost = true;
    res = null;                  // every GL object died with the context
    trail = null;
    gpuInstanceFloats = 0;
    gpuSegmentFloats = 0;
  }

  function onContextRestored() {
    if (disposed || !lost) return;   // only rebuild what a loss destroyed; never leak a live set
    try {
      res = buildGLResources(gl);
      lost = false;
      trailsDirty = true;
      trailUnsupported = false;
    } catch (err) {
      if (typeof console !== 'undefined') console.error('Tropism renderer: could not rebuild after context restore.', err);
    }
  }

  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  function releaseTrail() {
    if (!trail) return;
    if (!lost) {
      for (const f of trail.fbo) gl.deleteFramebuffer(f);
      for (const t of trail.tex) gl.deleteTexture(t);
    }
    trail = null;
  }

  /** (Re)creates the two trail targets at the drawing-buffer size; null when unsupported. */
  function ensureTrail(w, h) {
    if (trail && trail.w === w && trail.h === h) return trail;
    releaseTrail();
    if (trailUnsupported) return null;
    const tex = [];
    const fbo = [];
    let complete = true;
    for (let k = 0; k < 2; k++) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      complete = complete && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      tex.push(t);
      fbo.push(f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    trail = { tex, fbo, w, h, cur: 0 };
    if (!complete) {
      releaseTrail();
      trailUnsupported = true;
      if (typeof console !== 'undefined') console.warn('Tropism renderer: trail framebuffer incomplete; trails disabled.');
      return null;
    }
    trailsDirty = true;
    return trail;
  }

  function clearTrail() {
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(theme.paper[0], theme.paper[1], theme.paper[2], 1);
    for (const f of trail.fbo) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    trailsDirty = false;
  }

  function uploadInstances(world, n) {
    const capacity = Math.max(world.x.length, n);
    if (!instances || instances.length < capacity * 3) instances = new Float32Array(capacity * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.instanceBuffer);
    if (gpuInstanceFloats < instances.length) {
      gl.bufferData(gl.ARRAY_BUFFER, instances.byteLength, gl.DYNAMIC_DRAW);
      gpuInstanceFloats = instances.length;
    }
    if (n === 0) return;
    const xs = world.x, ys = world.y, sp = world.species, inst = instances;
    for (let i = 0, k = 0; i < n; i++, k += 3) {
      inst[k] = xs[i];
      inst[k + 1] = ys[i];
      inst[k + 2] = sp[i];
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, n * 3);
  }

  /** Scissor to the dish, in drawing-buffer px (origin bottom-left). */
  function scissorDish(sx, sy) {
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      Math.round(geo.dishX * sx),
      Math.round((geo.devH - geo.dishY - geo.dishSize) * sy),
      Math.round(geo.dishSize * sx),
      Math.round(geo.dishSize * sy),
    );
  }

  function drawParticles(n, radius, sx, sy, alphaSet = alphas, stride = 1) {
    if (n === 0 || geo.dishSize <= 0) return;
    const p = res.particles;
    const extent = radius * MARKER_EXTENT + 1;
    gl.useProgram(p.program);
    gl.uniform2f(p.u.u_origin, geo.left, geo.top);
    gl.uniform1f(p.u.u_span, geo.span);
    gl.uniform1f(p.u.u_margin, (extent / geo.dishSize) * geo.span);
    gl.uniform3f(p.u.u_dish, geo.dishX, geo.dishY, geo.dishSize);
    gl.uniform2f(p.u.u_target, geo.devW, geo.devH);
    gl.uniform1f(p.u.u_extent, extent);
    gl.uniform3fv(p.u.u_color, theme.paletteRGB);
    gl.uniform1fv(p.u.u_alpha, alphaSet);
    gl.uniform1i(p.u.u_stride, stride);
    gl.uniform1f(p.u.u_radius, radius);
    gl.uniform1f(p.u.u_shape, smoothstep(SHAPE_FROM_PX, SHAPE_TO_PX, radius));
    scissorDish(sx, sy);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(res.particleVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  }

  function drawPath(path, count, sx, sy) {
    if (count <= 0 || geo.dishSize <= 0) return;
    if (mapped.length < count * 2) mapped = new Float32Array(nextCapacity(count * 2, mapped.length));
    mapPathPoints(geo, path, count, mapped);

    const dpr = geo.dpr;
    const size = geo.dishSize;
    const inv = 1 / geo.span;
    const halfWidth = (PATH_WIDTH_CSS * dpr) / 2;
    const lineReach = (halfWidth + 1) / size;

    if (segments.length < (count - 1) * SEGMENT_FLOATS) {
      segments = new Float32Array(nextCapacity((count - 1) * SEGMENT_FLOATS, segments.length));
    }
    let used = 0;
    for (let k = 1; k < count; k++) {
      if (segmentHidden(geo, mapped, k - 1, k, lineReach)) continue;
      const o = used * SEGMENT_FLOATS;
      segments[o] = geo.dishX + (mapped[2 * k - 2] * inv + 0.5) * size;
      segments[o + 1] = geo.dishY + (mapped[2 * k - 1] * inv + 0.5) * size;
      segments[o + 2] = geo.dishX + (mapped[2 * k] * inv + 0.5) * size;
      segments[o + 3] = geo.dishY + (mapped[2 * k + 1] * inv + 0.5) * size;
      segments[o + 4] = pathAlpha(k - 1, count);
      segments[o + 5] = pathAlpha(k, count);
      used++;
    }

    scissorDish(sx, sy);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (used > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, res.segmentBuffer);
      if (gpuSegmentFloats < segments.length) {
        gl.bufferData(gl.ARRAY_BUFFER, segments.byteLength, gl.DYNAMIC_DRAW);
        gpuSegmentFloats = segments.length;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, segments, 0, used * SEGMENT_FLOATS);
      const p = res.segments;
      gl.useProgram(p.program);
      gl.uniform2f(p.u.u_target, geo.devW, geo.devH);
      gl.uniform1f(p.u.u_halfWidth, halfWidth);
      gl.uniform3fv(p.u.u_ink, theme.ink);
      gl.bindVertexArray(res.segmentVAO);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, used);
    }

    // Ring around the current (newest) position.
    const radius = RING_RADIUS_CSS * dpr;
    const halfStroke = (RING_STROKE_CSS * dpr) / 2;
    const reach = radius + halfStroke + 1;
    const u = mapped[2 * count - 2] * inv + 0.5;
    const v = mapped[2 * count - 1] * inv + 0.5;
    const m = reach / size;
    if (u < -m || u > 1 + m || v < -m || v > 1 + m) return;
    const r = res.ring;
    gl.useProgram(r.program);
    gl.uniform2f(r.u.u_target, geo.devW, geo.devH);
    gl.uniform2f(r.u.u_centre, geo.dishX + u * size, geo.dishY + v * size);
    gl.uniform1f(r.u.u_reach, reach);
    gl.uniform1f(r.u.u_radius, radius);
    gl.uniform1f(r.u.u_halfStroke, halfStroke);
    gl.uniform3fv(r.u.u_ink, theme.ink);
    gl.bindVertexArray(res.ringVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function draw(world, opts) {
    if (disposed || lost || !res || !world) return;
    if (gl.isContextLost()) return;
    const f = readDrawOptions(opts, frame);
    const n = liveCount(world);
    const S = speciesCount(world);
    fillAlphas(alphas, theme.dark, f.highlight, S);
    uploadInstances(world, n);

    const dbW = gl.drawingBufferWidth;
    const dbH = gl.drawingBufferHeight;
    const sx = dbW / geo.devW;
    const sy = dbH / geo.devH;
    const radius = markerRadius(geo);
    gl.viewport(0, 0, dbW, dbH);

    const target = f.trails ? ensureTrail(dbW, dbH) : null;
    if (!f.trails) releaseTrail();

    if (target) {
      if (trailsDirty) clearTrail();
      const prev = target.cur;
      const next = prev ^ 1;
      // 1. fade the previous image toward paper into the other target
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo[next]);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(res.fade.program);
      gl.uniform3fv(res.fade.u.u_paper, theme.paper);
      gl.uniform1f(res.fade.u.u_fade, TRAIL_FADE);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.tex[prev]);
      gl.bindVertexArray(res.fullscreenVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // 2. one particle in TRAIL_STRIDE, as a thin dot: the tracers whose exposures build the tracks
      for (let k = 0; k < alphas.length; k++) trailAlphas[k] = alphas[k] * TRAIL_ALPHA;
      drawParticles(n, Math.max(0.9, radius * TRAIL_RADIUS), sx, sy, trailAlphas, TRAIL_STRIDE);
      // 3. composite to the screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(res.copy.program);
      gl.bindTexture(gl.TEXTURE_2D, target.tex[next]);
      gl.bindVertexArray(res.fullscreenVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, null);
      target.cur = next;
      // 4. the live particles at full size over their tracks
      drawParticles(n, radius, sx, sy);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(theme.paper[0], theme.paper[1], theme.paper[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawParticles(n, radius, sx, sy);
    }

    // The path is chrome: drawn on the screen after compositing so it never smears into trails.
    drawPath(f.path, f.pathLength, sx, sy);

    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
  }

  return {
    kind: 'webgl2',
    draw,
    onResize() {
      releaseTrail();          // recreated at the new size on the next trails frame
      trailsDirty = true;
      trailUnsupported = false; // an incomplete target may have been size-related: retry once
    },
    onViewChange() {
      trailsDirty = true;      // screen-space trails are meaningless after the view moves
    },
    onThemeChange() {
      trailsDirty = true;
    },
    metrics() {
      metrics.radiusPx = markerRadius(geo);
      metrics.dishPx = geo.dishSize;
      metrics.dpr = geo.dpr;
      metrics.zoom = geo.zoom;
      metrics.contextLost = lost;
      return metrics;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      canvas.removeEventListener('webglcontextrestored', onContextRestored, false);
      if (!lost && !gl.isContextLost()) {
        releaseTrail();
        deleteGLResources(gl, res);
      }
      trail = null;
      res = null;
      instances = null;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Canvas2D backend
// ---------------------------------------------------------------------------------------

/** Marker paths are built once at this radius and scaled per particle with setTransform. */
const PATH2D_UNIT = 10;

function createCanvas2DBackend(canvas, geo, theme) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Tropism renderer: neither WebGL2 nor Canvas2D is available on this canvas');

  const markerPaths = typeof Path2D === 'function'
    ? SPECIES.map((sp) => new Path2D(markerPath(sp.marker, PATH2D_UNIT)))
    : null;
  const discScale = SPECIES.map((sp) => DISC_EQUAL_AREA[MARKER_INDEX[sp.marker] ?? 0]);

  let trailCanvas = null;          // offscreen accumulation buffer for trails
  let trailCtx = null;
  let trailsDirty = true;
  let mapped = new Float32Array(2 * 256);
  let disposed = false;

  const alphas = new Float32Array(SPECIES_MAX);
  const frame = { trails: false, highlight: -1, path: null, pathLength: 0 };
  const metrics = { kind: 'canvas2d', radiusPx: 0, dishPx: 0, dpr: 1, zoom: 1, contextLost: false };

  function ensureTrail() {
    if (typeof document === 'undefined') return null;
    if (!trailCanvas) {
      trailCanvas = document.createElement('canvas');
      trailCtx = trailCanvas.getContext('2d', { alpha: false });
      if (!trailCtx) {
        trailCanvas = null;
        return null;
      }
      trailsDirty = true;
    }
    if (trailCanvas.width !== geo.devW || trailCanvas.height !== geo.devH) {
      trailCanvas.width = geo.devW;
      trailCanvas.height = geo.devH;
      trailsDirty = true;
    }
    return trailCtx;
  }

  function releaseTrail() {
    if (trailCanvas) {
      trailCanvas.width = 0;    // frees the backing store promptly
      trailCanvas.height = 0;
    }
    trailCanvas = null;
    trailCtx = null;
  }

  function fillPaper(c, alpha) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = alpha;
    c.fillStyle = theme.paperCSS;
    c.fillRect(0, 0, geo.devW, geo.devH);
    c.globalAlpha = 1;
  }

  /**
   * Moves the trail image TRAIL_FADE of the way back to paper, then one more exact, clamped
   * step of TRAIL_STEP_2D levels, which clears the residue an 8-bit fade leaves a few levels
   * short of paper (0.12 x 4 levels rounds to nothing). Only the dish is faded: nothing is ever
   * drawn outside it, so the rest of the buffer stays paper from the last clear.
   *   light theme (ink only darkens paper):     v -> min(paper, v + step)  'lighter', 'darken'
   *   dark theme (screen only brightens paper): v -> max(paper, v - step)  'difference', 'lighten'
   */
  function fadeTrail(c) {
    const x = geo.dishX, y = geo.dishY, s = geo.dishSize;
    if (s <= 0) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = TRAIL_FADE;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = theme.paperCSS;
    c.fillRect(x, y, s, s);
    c.globalAlpha = 1;
    if (!theme.dark) {
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = TRAIL_STEP_2D_CSS;
      c.fillRect(x, y, s, s);
      if (!theme.paperIsWhite) {        // white paper already saturates at paper
        c.globalCompositeOperation = 'darken';
        c.fillStyle = theme.paperCSS;
        c.fillRect(x, y, s, s);
      }
    } else if (theme.paperMin * 255 >= TRAIL_STEP_2D) {
      // |v - step| equals v - step only while v >= step, which holds because v >= paper.
      c.globalCompositeOperation = 'difference';
      c.fillStyle = TRAIL_STEP_2D_CSS;
      c.fillRect(x, y, s, s);
      c.globalCompositeOperation = 'lighten';
      c.fillStyle = theme.paperCSS;
      c.fillRect(x, y, s, s);
    }
    c.globalCompositeOperation = 'source-over';
  }

  function drawParticles(c, world, n, S, radius, alphaScale = 1, stride = 1) {
    const size = geo.dishSize;
    if (n === 0 || size <= 0) return;
    const span = geo.span, left = geo.left, top = geo.top;
    const reach = radius * MARKER_EXTENT + 1;
    const margin = (reach / size) * span;
    const mu = margin / span;
    const lo = -mu, hi = 1 + mu;
    const x0 = geo.dishX, y0 = geo.dishY;
    const xs = world.x, ys = world.y, sp = world.species;
    const shapes = markerPaths !== null && radius >= SHAPE_TO_PX;
    const scale = radius / PATH2D_UNIT;

    c.save();
    c.beginPath();
    c.rect(geo.dishX, geo.dishY, size, size);
    c.clip();
    c.globalCompositeOperation = 'source-over';
    for (let s = 0; s < S; s++) {
      c.fillStyle = theme.paletteCSS[s];
      c.globalAlpha = alphas[s] * alphaScale;
      const half = radius * discScale[s] * 0.8862;   // the square with the disc's area
      const side = 2 * half;
      const path = shapes ? markerPaths[s] : null;
      for (let i = 0; i < n; i += stride) {
        if (sp[i] !== s) continue;
        const u = foldAxis(wrap01(xs[i] - left), span, margin) / span;
        if (u < lo || u > hi) continue;
        const v = foldAxis(wrap01(ys[i] - top), span, margin) / span;
        if (v < lo || v > hi) continue;
        const px = x0 + u * size;
        const py = y0 + v * size;
        if (path) {
          c.setTransform(scale, 0, 0, scale, px, py);
          c.fill(path);
        } else {
          c.fillRect(px - half, py - half, side, side);
        }
      }
      if (path) c.setTransform(1, 0, 0, 1, 0, 0);
    }
    c.restore();
  }

  function drawPath(c, path, count) {
    const size = geo.dishSize;
    if (count <= 0 || size <= 0) return;
    if (mapped.length < count * 2) mapped = new Float32Array(nextCapacity(count * 2, mapped.length));
    mapPathPoints(geo, path, count, mapped);
    const dpr = geo.dpr;
    const inv = 1 / geo.span;
    const x0 = geo.dishX, y0 = geo.dishY;
    const lineReach = ((PATH_WIDTH_CSS * dpr) / 2 + 1) / size;

    c.save();
    c.beginPath();
    c.rect(geo.dishX, geo.dishY, size, size);
    c.clip();
    c.globalCompositeOperation = 'source-over';
    c.strokeStyle = theme.inkCSS;
    c.lineCap = 'butt';
    c.lineJoin = 'round';
    c.lineWidth = PATH_WIDTH_CSS * dpr;

    const segmentsTotal = count - 1;
    const buckets = Math.min(PATH_BUCKETS_2D, segmentsTotal);
    for (let b = 0; b < buckets; b++) {
      // Segments k (from point k-1 to point k) for k in (k0, k1].
      const k0 = Math.floor((b * segmentsTotal) / buckets);
      const k1 = Math.floor(((b + 1) * segmentsTotal) / buckets);
      c.globalAlpha = pathAlpha((k0 + k1) / 2, count);
      c.beginPath();
      let pen = false;
      for (let k = k0 + 1; k <= k1; k++) {
        if (segmentHidden(geo, mapped, k - 1, k, lineReach)) {
          pen = false;
          continue;
        }
        if (!pen) c.moveTo(x0 + (mapped[2 * k - 2] * inv + 0.5) * size, y0 + (mapped[2 * k - 1] * inv + 0.5) * size);
        c.lineTo(x0 + (mapped[2 * k] * inv + 0.5) * size, y0 + (mapped[2 * k + 1] * inv + 0.5) * size);
        pen = true;
      }
      c.stroke();
    }

    const radius = RING_RADIUS_CSS * dpr;
    const reach = (radius + (RING_STROKE_CSS * dpr) / 2 + 1) / size;
    const u = mapped[2 * count - 2] * inv + 0.5;
    const v = mapped[2 * count - 1] * inv + 0.5;
    if (u >= -reach && u <= 1 + reach && v >= -reach && v <= 1 + reach) {
      c.globalAlpha = 1;
      c.lineWidth = RING_STROKE_CSS * dpr;
      c.beginPath();
      c.arc(x0 + u * size, y0 + v * size, radius, 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  function draw(world, opts) {
    if (disposed || !world) return;
    const f = readDrawOptions(opts, frame);
    const n = liveCount(world);
    const S = speciesCount(world);
    fillAlphas(alphas, theme.dark, f.highlight, S);
    const radius = markerRadius(geo);

    const tc = f.trails ? ensureTrail() : null;
    if (!f.trails) releaseTrail();

    if (tc) {
      if (trailsDirty) fillPaper(tc, 1);
      else fadeTrail(tc);
      trailsDirty = false;
      drawParticles(tc, world, n, S, Math.max(0.9, radius * TRAIL_RADIUS), TRAIL_ALPHA, TRAIL_STRIDE);
      // The trail canvas is opaque and covers the whole canvas, so a plain draw replaces it.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(trailCanvas, 0, 0);
      drawParticles(ctx, world, n, S, radius);
    } else {
      fillPaper(ctx, 1);
      drawParticles(ctx, world, n, S, radius);
    }
    drawPath(ctx, f.path, f.pathLength);
  }

  return {
    kind: 'canvas2d',
    draw,
    onResize() {
      trailsDirty = true;
    },
    onViewChange() {
      trailsDirty = true;
    },
    onThemeChange() {
      trailsDirty = true;
    },
    metrics() {
      metrics.radiusPx = markerRadius(geo);
      metrics.dishPx = geo.dishSize;
      metrics.dpr = geo.dpr;
      metrics.zoom = geo.zoom;
      return metrics;
    },
    dispose() {
      disposed = true;
      releaseTrail();
    },
  };
}

// ---------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------

/**
 * Creates the dish renderer for `canvas`.
 *
 * @param {HTMLCanvasElement} canvas  sized by CSS; resize() sets its drawing-buffer size
 * @param {{ prefer?: 'webgl2' | 'canvas2d' }} [options]  optional extra: `prefer: 'canvas2d'`
 *        skips WebGL2 (used by the visual harness to inspect the fallback)
 */
export function createRenderer(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('createRenderer: expected a <canvas> element');
  }
  const geo = createGeometry();
  const theme = createTheme();
  readTheme(theme);
  // Until resize() is called, treat the current drawing buffer as CSS px at dpr 1.
  fitDish(geo, canvas.width, canvas.height, 1, canvas.width, canvas.height);

  let backend = null;
  const prefer = options && options.prefer;
  if (prefer !== 'canvas2d' && probeWebGL2()) {
    const gl = canvas.getContext('webgl2', GL_ATTRIBUTES);
    if (gl) backend = createGLBackend(canvas, gl, geo, theme);
  }
  if (!backend) backend = createCanvas2DBackend(canvas, geo, theme);

  return {
    kind: backend.kind,

    /** Sizes the drawing buffer to the CSS box at the given device pixel ratio and refits the dish. */
    resize(cssWidth, cssHeight, dpr) {
      const ratio = Number.isFinite(dpr) && dpr > 0
        ? dpr
        : (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const cssW = Math.max(0, Number(cssWidth) || 0);
      const cssH = Math.max(0, Number(cssHeight) || 0);
      const devW = Math.max(1, Math.round(cssW * ratio));
      const devH = Math.max(1, Math.round(cssH * ratio));
      const unchanged = canvas.width === devW && canvas.height === devH
        && geo.devW === devW && geo.devH === devH
        && geo.cssW === cssW && geo.cssH === cssH && geo.dpr === ratio;
      if (unchanged) return;   // a repeated call must not throw away the trails
      if (canvas.width !== devW) canvas.width = devW;
      if (canvas.height !== devH) canvas.height = devH;
      fitDish(geo, cssW, cssH, ratio, devW, devH);
      backend.onResize();
    },

    /** Re-reads --paper, --ink and the species palette for the current theme. */
    refreshTheme() {
      readTheme(theme);
      backend.onThemeChange();
    },

    /** cx, cy: world coordinates of the view centre (wrapped); zoom >= 1, 1 = the whole torus. */
    setView(view) {
      if (view && applyView(geo, view)) backend.onViewChange();
    },

    /**
     * Draws one frame.
     * opts: { trails, highlight (-1 | species), path (Float32Array, x/y interleaved, oldest first),
     *         pathLength (points) }
     */
    draw(world, opts) {
      backend.draw(world, opts);
    },

    /** CSS px relative to the canvas -> wrapped world coordinates. */
    screenToWorld(px, py) {
      const u = (px - geo.offX) / (geo.sideX > 0 ? geo.sideX : 1);
      const v = (py - geo.offY) / (geo.sideY > 0 ? geo.sideY : 1);
      return [wrap01(geo.left + u * geo.span), wrap01(geo.top + v * geo.span)];
    },

    /** World coordinates -> CSS px relative to the canvas, or null when outside the view. */
    worldToScreen(x, y) {
      const u = centred(x, geo.cx) / geo.span + 0.5;
      const v = centred(y, geo.cy) / geo.span + 0.5;
      if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
      return [geo.offX + u * geo.sideX, geo.offY + v * geo.sideY];
    },

    /**
     * Live renderer figures for diagnostics, as a reused
     * object { kind, radiusPx (device px), dishPx (device px), dpr, zoom, contextLost }.
     */
    metrics() {
      return backend.metrics();
    },

    dispose() {
      backend.dispose();
    },
  };
}
