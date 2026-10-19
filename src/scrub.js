// Scrubbable numbers for the figure caption.
//
// A number in the caption prose ("velocities halve every 40 ms") becomes a
// control: drag it sideways and it changes, right = more. It stays typeset as
// text in the sentence; the only affordances are a dotted underline and the
// ew-resize cursor. While dragging, the pending value shows only in the number
// itself, never in a tooltip.
//
// The value arithmetic is pure and exported (quantizeValue, scrubValue,
// nudgeValue) so it can be tested in Node without a DOM.

const DEFAULT_PX_PER_STEP = 4;
const DRAG_THRESHOLD_PX = 3;     // horizontal travel that turns a press into a scrub
const FINE_FACTOR = 10;          // Shift: ten times more travel per step
const PAGE_STEPS = 10;           // PageUp / PageDown
const LOG_DETENTS_MIN = 8;       // log mode: bounds on the number of detents across the range
const LOG_DETENTS_MAX = 600;
const MAX_DECIMALS = 12;

const STYLE_ID = 'scrub-style';
const DRAGGING_CLASS = 'scrub-dragging';  // on <html> while any scrub is active

// Injected once per document, before every other stylesheet so the page can
// override any of it. Ink tokens only; the number keeps the prose's own face.
const SCRUB_CSS = `
.scrub {
  display: inline-block;            /* touch-action and min-width do not apply to inline boxes */
  position: relative;
  box-sizing: border-box;
  padding: 0 0.12em;                /* lets the highlight breathe past the glyphs... */
  margin: 0 -0.12em;                /* ...without moving a single word of the sentence */
  line-height: 1.25;
  white-space: nowrap;
  cursor: ew-resize;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  font-variant-numeric: tabular-nums;
  text-decoration-line: underline;
  text-decoration-style: dotted;
  text-decoration-color: currentColor;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.18em;
}
@media (hover: hover) {
  .scrub:hover { background: var(--hilite); }
}
.scrub:focus:not(:focus-visible) { outline: none; }
.scrub:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.scrub.is-active { background: var(--hilite-2); text-decoration-style: solid; }
.scrub[aria-disabled="true"] { cursor: default; text-decoration-line: none; background: none; }
@media (pointer: coarse) {
  .scrub::after { content: ""; position: absolute; inset: -0.45em -0.3em; }
}
.${DRAGGING_CLASS},
.${DRAGGING_CLASS} * {
  cursor: ew-resize !important;
  user-select: none !important;
  -webkit-user-select: none !important;
}
`;

// ---------------------------------------------------------------------------
// Pure value arithmetic
// ---------------------------------------------------------------------------

/** Number of decimal digits in a finite number's shortest representation (1e-7 -> 7). */
export function decimalsOf(x) {
  if (!Number.isFinite(x)) return 0;
  const s = String(Math.abs(x));
  const e = s.indexOf('e');
  const mantissa = e === -1 ? s : s.slice(0, e);
  const exponent = e === -1 ? 0 : parseInt(s.slice(e + 1), 10);
  const dot = mantissa.indexOf('.');
  const fraction = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.min(MAX_DECIMALS, Math.max(0, fraction - exponent));
}

/**
 * Resolve a range once: the decimals and power of ten that clean its floats,
 * and the log detent size, so a drag does no string work per move.
 * Log scaling needs a positive range; otherwise the range is linear.
 */
function resolveScale(opts) {
  const min = Number(opts.min);
  const max = Number(opts.max);
  const step = Number(opts.step);
  const decimals = Math.max(decimalsOf(step), decimalsOf(min), decimalsOf(max));
  let perDetent = 0;
  if (opts.log && min > 0 && max > min) {
    // The range spans as many detents as it has linear steps, bounded so a
    // very fine step still leaves a range that can be crossed in a few drags.
    const detents = Math.min(LOG_DETENTS_MAX, Math.max(LOG_DETENTS_MIN, Math.round((max - min) / step)));
    perDetent = Math.log(max / min) / detents;
  }
  return {
    min, max, step, decimals,
    pow: 10 ** decimals,
    perDetent,                 // natural-log distance per detent; 0 = linear
    pxPerStep: opts.pxPerStep > 0 ? Number(opts.pxPerStep) : DEFAULT_PX_PER_STEP,
  };
}

/** Round away representation noise: 0.30000000000000004 -> 0.3, and -0 -> 0. */
function clean(v, r) {
  const scaled = v * r.pow;
  const c = Math.abs(scaled) < 2 ** 52 ? Math.round(scaled) / r.pow : Number(v.toFixed(r.decimals));
  return c === 0 ? 0 : c;
}

/** Remove ~1e-12 noise from a ratio so that 2.4999999999999996 rounds as 2.5. */
function settle(ratio) {
  return Math.abs(ratio) < 1e6 ? Math.round(ratio * 1e9) / 1e9 : ratio;
}

/** Round half away from zero, so a drag left and a drag right respond alike. */
function roundSymmetric(t) {
  return t < 0 ? -Math.round(-t) : Math.round(t);
}

function quantizeResolved(v, r) {
  if (!Number.isFinite(v) || v <= r.min) return clean(r.min, r);
  if (v >= r.max) return clean(r.max, r);
  const k = Math.round(settle((v - r.min) / r.step));
  const q = clean(r.min + k * r.step, r);
  return q > r.max ? r.max : q < r.min ? r.min : q;
}

function scrubResolved(start, dx, r, fine) {
  const t = (Number.isFinite(dx) ? dx : 0) / (r.pxPerStep * (fine ? FINE_FACTOR : 1));
  const from = quantizeResolved(start, r);
  if (r.perDetent > 0) return quantizeResolved(Math.exp(Math.log(from) + t * r.perDetent), r);
  return quantizeResolved(from + roundSymmetric(t) * r.step, r);
}

function nudgeResolved(v, steps, r) {
  const from = quantizeResolved(v, r);
  const linear = quantizeResolved(from + steps * r.step, r);
  if (r.perDetent <= 0 || steps === 0) return linear;
  const geometric = quantizeResolved(Math.exp(Math.log(from) + steps * r.perDetent), r);
  return steps > 0 ? Math.max(linear, geometric) : Math.min(linear, geometric);
}

/**
 * Clamp to [min, max] and snap to the grid min + k * step, returning a clean
 * float. The endpoints are always reachable exactly, even when max is not on
 * the grid. Non-finite input yields min.
 * opts: { min, max, step }
 */
export function quantizeValue(v, opts) {
  return quantizeResolved(v, resolveScale(opts));
}

/**
 * The value after dragging `dx` CSS pixels from a drag that started at `start`.
 * opts: { min, max, step, pxPerStep = 4, fine = false, log = false }.
 *
 * Linear: start + round(dx / pxPerStep) * step. Log: the same travel moves a
 * constant ratio instead of a constant amount (continuous in dx, then snapped
 * to the step grid), so a wide range is fine at the bottom and quick at the
 * top. `fine` (Shift) needs ten times the travel per step.
 */
export function scrubValue(start, dx, opts) {
  return scrubResolved(start, dx, resolveScale(opts), Boolean(opts.fine));
}

/**
 * The value after `steps` keyboard steps (negative = down). Linear ranges move
 * by steps * step. Log ranges move by the same number of detents, but never by
 * less than the linear amount, so every key press visibly changes the value.
 * opts: { min, max, step, log = false }
 */
export function nudgeValue(v, steps, opts) {
  return nudgeResolved(v, steps, resolveScale(opts));
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

function injectStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = SCRUB_CSS;
  const host = doc.head || doc.documentElement;
  host.insertBefore(style, host.firstChild);
}

/** Default text for a value: fixed decimals, a true minus sign, never "−0". */
function defaultFormat(decimals) {
  return (v) => {
    const s = Math.abs(v).toFixed(decimals);
    return v < 0 && Number(s) !== 0 ? `−${s}` : s;
  };
}

function preventDefault(e) {
  e.preventDefault();
}

const IDLE = 0;      // no gesture
const PENDING = 1;   // pressed, not yet moved past the threshold (still a click)
const ACTIVE = 2;    // scrubbing

/**
 * Turn an inline element of the caption into a scrubbable number.
 *
 * opts: { value, min, max, step, format(v) -> string, label, unit?,
 *         pxPerStep = 4, onInput(v), onCommit(before, after), log? }
 * returns { set(v), get(), enable(on), destroy() }
 */
export function createScrub(el, opts = {}) {
  if (!el || typeof el.addEventListener !== 'function' || !el.ownerDocument) {
    throw new TypeError('createScrub: el must be an element in a document');
  }
  const min = Number(opts.min);
  const max = Number(opts.max);
  const step = Number(opts.step);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new RangeError(`createScrub: invalid range [${opts.min}, ${opts.max}]`);
  }
  if (!(step > 0) || !Number.isFinite(step)) {
    throw new RangeError(`createScrub: step must be a positive number, got ${opts.step}`);
  }

  const doc = el.ownerDocument;
  const win = doc.defaultView;
  // Resolved once, so pointermove does arithmetic only.
  const scale = resolveScale({ min, max, step, log: opts.log, pxPerStep: opts.pxPerStep });
  const format = typeof opts.format === 'function' ? opts.format : defaultFormat(scale.decimals);
  const onInput = typeof opts.onInput === 'function' ? opts.onInput : null;
  const onCommit = typeof opts.onCommit === 'function' ? opts.onCommit : null;
  const unit = opts.unit ? String(opts.unit) : '';

  let value = quantizeResolved(opts.value === undefined ? min : Number(opts.value), scale);
  let enabled = true;
  let destroyed = false;
  let renderedText = null;
  let renderedNow = null;

  // Gesture state.
  let phase = IDLE;
  let pointerId = -1;
  let originX = 0;        // where the press landed
  let anchorX = 0;        // x that corresponds to anchorValue
  let anchorValue = 0;
  let lastX = 0;
  let fine = false;       // Shift held: ten times finer
  let before = 0;         // value when the drag began (for onCommit / Escape)
  let widthLock = 0;      // the number's box never shrinks mid-drag, so the prose holds still
  let widthDirty = false;
  let prevBodyCursor = '';
  let suppressClick = false;
  let inputDuringDrag = false; // an onInput fired during this drag, so one onCommit must close it

  injectStyles(doc);
  el.classList.add('scrub');
  el.setAttribute('role', 'slider');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-orientation', 'horizontal');
  el.setAttribute('aria-valuemin', String(min));
  el.setAttribute('aria-valuemax', String(max));
  if (opts.label) el.setAttribute('aria-label', String(opts.label));
  render();

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('lostpointercapture', onLostCapture);
  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('click', onClick, true);
  el.addEventListener('contextmenu', onContextMenu);

  function render() {
    const text = String(format(value));
    if (text !== renderedText) {
      el.textContent = text;
      el.setAttribute('aria-valuetext', unit ? `${text} ${unit}` : text);
      renderedText = text;
      widthDirty = true;
    }
    if (value !== renderedNow) {
      el.setAttribute('aria-valuenow', String(value));
      renderedNow = value;
    }
  }

  function change(next) {
    if (next === value) return false;
    value = next;
    render();
    if (phase === ACTIVE) inputDuringDrag = true;
    if (onInput) onInput(value);
    return true;
  }

  // -- pointer -------------------------------------------------------------

  function onPointerDown(e) {
    if (!enabled || phase !== IDLE || e.isPrimary === false) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    phase = PENDING;
    pointerId = e.pointerId;
    originX = lastX = e.clientX;
    before = value;
    fine = Boolean(e.shiftKey);
    suppressClick = false;
    // Listen on the window: a quick flick can leave the number before the
    // first move arrives, and captured events bubble here as well.
    win.addEventListener('pointermove', onPointerMove);
    win.addEventListener('pointerup', onPointerUp);
    win.addEventListener('pointercancel', onPointerCancel);
    // Capture phase on the window runs before any page-level shortcut handler,
    // so Escape ends the scrub and nothing else.
    win.addEventListener('keydown', onWindowKeyDown, true);
    doc.addEventListener('selectstart', preventDefault);
  }

  function onPointerMove(e) {
    if (e.pointerId !== pointerId) return;
    // A mouse released outside the window never sends pointerup.
    if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
      end(true);
      return;
    }
    const x = e.clientX;
    if (phase === PENDING) {
      const dx = x - originX;
      if (Math.abs(dx) <= DRAG_THRESHOLD_PX) return;
      // The dead zone is not counted, so the value does not jump on pickup.
      activate(originX + Math.sign(dx) * DRAG_THRESHOLD_PX);
    }

    // Reads first: grow the width lock if the last write widened the number.
    if (widthDirty) {
      const w = el.getBoundingClientRect().width;
      widthDirty = false;
      if (w > widthLock) {
        widthLock = w;
        el.style.minWidth = `${w}px`;
      }
    }

    // Shift pressed or released mid-drag: continue from here at the new rate.
    const shift = Boolean(e.shiftKey);
    if (shift !== fine) {
      anchorValue = value;
      anchorX = lastX;
      fine = shift;
    }
    lastX = x;
    change(scrubResolved(anchorValue, x - anchorX, scale, fine));
  }

  function activate(anchor) {
    phase = ACTIVE;
    inputDuringDrag = false;
    anchorX = lastX = anchor;
    anchorValue = before = value;
    widthLock = el.getBoundingClientRect().width;
    widthDirty = false;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // The pointer may already have been released; pointerup will end the drag.
    }
    el.classList.add('is-active');
    el.style.minWidth = `${widthLock}px`;
    doc.documentElement.classList.add(DRAGGING_CLASS);
    prevBodyCursor = doc.body.style.cursor;
    doc.body.style.cursor = 'ew-resize';
  }

  /**
   * Finish the gesture. commit: keep what happened; otherwise revert (Escape).
   * Every drag that fired onInput ends with exactly one onCommit(before, after),
   * even when it came back to where it started or was reverted (after === before),
   * so an owner that opens an undo step on the first onInput can always close it.
   */
  function end(commit) {
    if (phase === IDLE) return;
    const wasActive = phase === ACTIVE;
    const id = pointerId;
    phase = IDLE;
    pointerId = -1;
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerup', onPointerUp);
    win.removeEventListener('pointercancel', onPointerCancel);
    win.removeEventListener('keydown', onWindowKeyDown, true);
    doc.removeEventListener('selectstart', preventDefault);
    if (!wasActive) return;

    el.classList.remove('is-active');
    el.style.minWidth = '';
    doc.documentElement.classList.remove(DRAGGING_CLASS);
    doc.body.style.cursor = prevBodyCursor;
    try {
      if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch {
      // Capture already gone.
    }
    suppressClick = true;
    if (!commit && change(before)) inputDuringDrag = true;
    const settle = inputDuringDrag || value !== before;
    inputDuringDrag = false;
    if (settle && onCommit) onCommit(before, value);
  }

  function onPointerUp(e) {
    if (e.pointerId !== pointerId) return;
    if (phase === PENDING) {
      // A click without movement never changes the value; it only focuses.
      if (enabled && doc.activeElement !== el) el.focus({ preventScroll: true });
    }
    end(true);
  }

  function onPointerCancel(e) {
    // The browser took the pointer (e.g. a vertical pan): keep what happened.
    if (e.pointerId === pointerId) end(true);
  }

  function onLostCapture(e) {
    if (phase === ACTIVE && e.pointerId === pointerId) end(true);
  }

  function onClick(e) {
    // The click that follows a drag is not a click on whatever holds the number.
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }

  function onContextMenu(e) {
    if (phase !== IDLE) e.preventDefault();
  }

  // -- keyboard ------------------------------------------------------------

  function onWindowKeyDown(e) {
    if (e.key === 'Escape' && phase === ACTIVE) {
      e.preventDefault();
      e.stopPropagation();
      end(false);
    }
  }

  function onKeyDown(e) {
    if (!enabled || e.altKey || e.ctrlKey || e.metaKey) return;
    let next;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown': next = nudgeResolved(value, -1, scale); break;
      case 'ArrowRight':
      case 'ArrowUp': next = nudgeResolved(value, 1, scale); break;
      case 'PageUp': next = nudgeResolved(value, PAGE_STEPS, scale); break;
      case 'PageDown': next = nudgeResolved(value, -PAGE_STEPS, scale); break;
      case 'Home': next = quantizeResolved(min, scale); break;
      case 'End': next = quantizeResolved(max, scale); break;
      default: return;
    }
    e.preventDefault();
    if (phase !== IDLE) return;  // the pointer owns the value until it lets go
    const prev = value;
    if (change(next) && onCommit) onCommit(prev, value);
  }

  // -- public --------------------------------------------------------------

  return {
    /** Show a new value without firing onInput or onCommit. */
    set(v) {
      const n = Number(v);
      if (destroyed || !Number.isFinite(n)) return;
      const q = quantizeResolved(n, scale);
      if (q === value) return;
      value = q;
      render();
      if (phase === ACTIVE) {
        // Keep dragging relative to the new value from where the pointer is.
        anchorValue = value;
        anchorX = lastX;
      }
    },

    get() {
      return value;
    },

    enable(on) {
      const next = Boolean(on);
      if (destroyed || next === enabled) return;
      enabled = next;
      if (!enabled) end(true);
      el.setAttribute('tabindex', enabled ? '0' : '-1');
      if (enabled) el.removeAttribute('aria-disabled');
      else el.setAttribute('aria-disabled', 'true');
    },

    destroy() {
      if (destroyed) return;
      end(true);
      destroyed = true;
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('lostpointercapture', onLostCapture);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('contextmenu', onContextMenu);
      el.classList.remove('scrub', 'is-active');
      for (const name of ['role', 'tabindex', 'aria-orientation', 'aria-valuemin', 'aria-valuemax',
        'aria-valuenow', 'aria-valuetext', 'aria-disabled']) {
        el.removeAttribute(name);
      }
      if (opts.label) el.removeAttribute('aria-label');
    },
  };
}
