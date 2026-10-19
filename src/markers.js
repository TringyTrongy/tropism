// Species identity: a colour-blind-safe categorical palette (after Okabe & Ito)
// paired with a drawn plot marker, so a species never depends on hue alone.
// Light values sit on white figure paper; dark values on the inverse print.

export const SPECIES_MAX = 8;
export const SPECIES_MIN = 2;

export const SPECIES = [
  { letter: 'A', marker: 'circle',   light: '#0072B2', dark: '#3AA0E8' }, // blue
  { letter: 'B', marker: 'square',   light: '#E69F00', dark: '#F2B33D' }, // orange
  { letter: 'C', marker: 'triangle', light: '#009E73', dark: '#2BC596' }, // bluish green
  { letter: 'D', marker: 'diamond',  light: '#CC79A7', dark: '#E296C0' }, // reddish purple
  { letter: 'E', marker: 'down',     light: '#D55E00', dark: '#FF7A2E' }, // vermillion
  { letter: 'F', marker: 'plus',     light: '#56B4E9', dark: '#8FD0F5' }, // sky blue
  { letter: 'G', marker: 'cross',    light: '#9C8A00', dark: '#F0E442' }, // yellow (darkened for paper)
  { letter: 'H', marker: 'star',     light: '#6F7378', dark: '#C4C7CC' }, // grey
];

// Marker kind index, shared with the renderer's fragment shader.
export const MARKER_INDEX = {
  circle: 0, square: 1, triangle: 2, diamond: 3, down: 4, plus: 5, cross: 6, star: 7,
};

/** Current theme: 'light' or 'dark', read from the document. */
export function currentTheme() {
  const root = document.documentElement;
  const forced = root.getAttribute('data-theme');
  if (forced === 'dark' || forced === 'light') return forced;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** CSS colour strings for the first `count` species in the given theme. */
export function paletteCSS(count, theme = currentTheme()) {
  return SPECIES.slice(0, count).map((s) => s[theme]);
}

/** Same palette as linear-ish 0..1 RGB triples (sRGB values / 255) for WebGL. */
export function paletteRGB(count, theme = currentTheme()) {
  return paletteCSS(count, theme).map(hexToRGB);
}

export function hexToRGB(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * SVG path data for a marker centred on (0, 0) with the given radius.
 * Every marker has roughly equal visual area so no species looks heavier.
 * Filled markers use `fill`; 'plus' and 'cross' are drawn as thick filled bars.
 */
export function markerPath(kind, r) {
  const f = (n) => +n.toFixed(2);
  switch (kind) {
    case 'circle':
      return `M${f(-r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
    case 'square': {
      const s = r * 0.88;
      return `M${f(-s)} ${f(-s)}H${f(s)}V${f(s)}H${f(-s)}Z`;
    }
    case 'triangle': {
      const s = r * 1.18;
      return `M0 ${f(-s)}L${f(s * 0.92)} ${f(s * 0.62)}H${f(-s * 0.92)}Z`;
    }
    case 'down': {
      const s = r * 1.18;
      return `M0 ${f(s)}L${f(s * 0.92)} ${f(-s * 0.62)}H${f(-s * 0.92)}Z`;
    }
    case 'diamond': {
      const s = r * 1.2;
      return `M0 ${f(-s)}L${f(s)} 0L0 ${f(s)}L${f(-s)} 0Z`;
    }
    case 'plus': {
      const a = r * 1.12, b = r * 0.36;
      return `M${f(-b)} ${f(-a)}H${f(b)}V${f(-b)}H${f(a)}V${f(b)}H${f(b)}V${f(a)}H${f(-b)}V${f(b)}H${f(-a)}V${f(-b)}H${f(-b)}Z`;
    }
    case 'cross': {
      // A plus rotated 45 degrees.
      const a = r * 1.12, b = r * 0.36;
      const pts = [[-b, -a], [b, -a], [b, -b], [a, -b], [a, b], [b, b], [b, a], [-b, a], [-b, b], [-a, b], [-a, -b], [-b, -b]];
      const c = Math.SQRT1_2;
      return 'M' + pts.map(([x, y]) => `${f((x - y) * c)} ${f((x + y) * c)}`).join('L') + 'Z';
    }
    case 'star': {
      const outer = r * 1.25, inner = outer * 0.45;
      let d = '';
      for (let k = 0; k < 10; k++) {
        const rad = k % 2 === 0 ? outer : inner;
        const t = -Math.PI / 2 + (k * Math.PI) / 5;
        d += (k === 0 ? 'M' : 'L') + f(Math.cos(t) * rad) + ' ' + f(Math.sin(t) * rad);
      }
      return d + 'Z';
    }
    default:
      return markerPath('circle', r);
  }
}

/** Convenience: an <svg> element holding one species marker, for legends and headers. */
export function markerSVG(speciesIndex, size = 12, theme = currentTheme()) {
  const sp = SPECIES[speciesIndex];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('marker');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', markerPath(sp.marker, size * 0.36));
  p.setAttribute('fill', sp[theme]);
  p.dataset.species = String(speciesIndex);
  svg.appendChild(p);
  return svg;
}
