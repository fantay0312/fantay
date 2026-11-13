// The tumbling mark that rides the open colour card: a CSS 3D cube that folds into a pyramid and back
// as it hops between cards and between the tints of one card. It rests in the free space of whatever is open — the card's own details,
// or an open tint — standing on the rule above the values, so it never covers the tints or the text.
// One rAF loop writes straight to the DOM, so a hop never re-renders React and React never fights the
// tween. Between hops it idles: a slow bob, a blink, eyes that follow the pointer.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { mixRgb, relativeLuminance, type PaletteTier, type Rgb } from '../runtime/studio-palette';
import styles from './StudioColorMark.module.css';

/** `zone` names the open area the mark rests in: `card`, or `step-<percent>` for an open tint. */
export interface StudioColorMarkTarget { name: string; tier: PaletteTier; hex: string | null; zone: string }
interface Spot { x: number; y: number }
/** The size and turn the mark comes to rest in. */
export interface StudioMarkRest { size: number; rx: number; ry: number; rz: number }
export interface StudioMarkReach { left: number; right: number; top: number; bottom: number }
interface Pose extends Spot, StudioMarkRest {
  color: Rgb; lift: number; scale: number; sx: number; sy: number; form: number; opacity: number;
}
interface Aim extends Spot { size: number; visible: boolean }
type Form = { form: number; rx: number; ry: number; rz: number };

// The largest the mark grows per tier; a smaller free space shrinks it to fit, never past MIN_SIZE.
const SIZE: Record<PaletteTier, number> = { foundation: 80, role: 68, detail: 50 };
const MIN_SIZE = 30;
const PERSPECTIVE = 520;
// Kept this far inside the zone's sides, this far below what sits above, and standing this far over the rule.
const INSET = 14;
const AIR = 10;
const SHELF = 4;
// The landing poses it cycles through; form 1 is the pyramid, form 0 the cube.
const FORMS: readonly Form[] = [
  { form: 1, rx: -12, ry: 38, rz: 4 },
  { form: 0, rx: -24, ry: 28, rz: 6 },
  { form: 1, rx: -10, ry: -34, rz: 6 },
  { form: 0, rx: -16, ry: 52, rz: -6 },
  { form: 0, rx: -8, ry: -40, rz: 8 },
];
const CUBE_SHADES = { top: 0.2, front: 0.02, right: -0.14, left: -0.3, bottom: -0.38, back: -0.24 } as const;
const PYRAMID_SHADES = { n: 0.2, e: -0.08, s: -0.24, w: 0.06, base: -0.38 } as const;
const LEAN = { rx: 56, rz: 30 };
// Anticipation, flight and a damped landing: the mark crouches, stretches in the air and squashes as it lands.
const CROUCH = 0.16;
const CROUCH_SQUASH = 0.16;
const STRETCH = 0.08;
const LAND_SQUASH = 0.18;
const HOP = { far: { height: 52, ms: 740 }, near: { height: 26, ms: 560 } } as const;
const REENTRY_MS = 520;
const LAND_MS = 460;
const CHEER_MS = 520;
const FADE_MS = 280;
const RECOLOUR_MS = 320;
// The card keeps growing for 640ms after a click, so the loop keeps tracking it that long.
const LAYOUT_MS = 680;
const MIN_ENTRY_SCALE = 0.72;

const ease = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const unit = (value: number) => Math.min(1, Math.max(0, value));
const shade = (base: Rgb, amount: number): Rgb => base.map((channel) => Math.round(amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount))) as unknown as Rgb;
const css = (color: Rgb) => `rgb(${color.map(Math.round).join(' ')})`;
const rgbOf = (hex: string): Rgb => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
function wrapDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}
function reducedMotion(): boolean {
  if (typeof requestAnimationFrame !== 'function') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * How far the resting mark reaches from its anchor on screen, faces in perspective included. It is
 * the hull of the cube's eight corners: the pyramid stands on the cube's base with its apex inside
 * the cube, so the cube bounds both forms. The corners sit where `.cube` places them (-0.72 to 0.28
 * of the size around the anchor) and turn as the rotor turns them: Z first, then Y, then X.
 */
export function studioMarkReach({ size, rx, ry, rz }: StudioMarkRest): StudioMarkReach {
  const turn = (degrees: number) => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)] as const;
  const [cosX, sinX] = turn(rx);
  const [cosY, sinY] = turn(ry);
  const [cosZ, sinZ] = turn(rz);
  const reach: StudioMarkReach = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const x of [-0.5, 0.5]) for (const y of [-0.72, 0.28]) for (const z of [-0.5, 0.5]) {
    const x1 = (cosZ * x - sinZ * y) * size;
    const y1 = (sinZ * x + cosZ * y) * size;
    const x2 = cosY * x1 + sinY * z * size;
    const z2 = -sinY * x1 + cosY * z * size;
    const y3 = cosX * y1 - sinX * z2;
    const z3 = sinX * y1 + cosX * z2;
    const depth = PERSPECTIVE / (PERSPECTIVE - z3);
    reach.left = Math.min(reach.left, x2 * depth);
    reach.right = Math.max(reach.right, x2 * depth);
    reach.top = Math.min(reach.top, y3 * depth);
    reach.bottom = Math.max(reach.bottom, y3 * depth);
  }
  return reach;
}

/**
 * The lowest edge of the text lines inside `lead` that overlap the column [left, right], read from
 * the line boxes themselves; null when none does. Without measurable line boxes the whole block counts.
 */
function textBottom(lead: HTMLElement | null, left: number, right: number): number | null {
  if (!lead) return null;
  const doc = lead.ownerDocument;
  if (typeof doc.createRange !== 'function' || typeof Range === 'undefined' || typeof Range.prototype.getClientRects !== 'function') return lead.getBoundingClientRect().bottom;
  const walker = doc.createTreeWalker(lead, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let lowest: number | null = null;
  let measured = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const line of Array.from(range.getClientRects())) {
      if (line.width <= 0) continue;
      measured = true;
      if (line.right > left && line.left < right) lowest = Math.max(lowest ?? line.bottom, line.bottom);
    }
  }
  // No line box at all means the text could not be measured, not that there is none.
  return measured ? lowest : lead.getBoundingClientRect().bottom;
}

interface MarkEngine { sync(next: StudioColorMarkTarget | null): void; land(): void; cheer(): void; look(x: number, y: number): void; dispose(): void }

function createMarkEngine(root: HTMLElement, board: HTMLElement): MarkEngine {
  const rotor = root.querySelector<HTMLElement>('[data-part="rotor"]')!;
  const shadowPos = root.querySelector<HTMLElement>('[data-part="shadow"]')!;
  const cube = root.querySelector<HTMLElement>('[data-part="cube"]')!;
  const pyramid = root.querySelector<HTMLElement>('[data-part="pyramid"]')!;
  const cubeFaces = Array.from(cube.querySelectorAll<HTMLElement>('[data-face]'));
  const pyramidFaces = Array.from(pyramid.querySelectorAll<HTMLElement>('[data-face]'));
  const pose: Pose = { x: 0, y: 0, color: [18, 18, 17], lift: 0, rx: -24, ry: 32, rz: 0, scale: 1, sx: 1, sy: 1, form: 0, size: SIZE.role, opacity: 1 };
  let target: StudioColorMarkTarget | null = null;
  let rest: Form = FORMS[1]!;
  let destination: Rgb = pose.color;
  let frame = 0;
  let flying = false;
  let formIndex = 0;
  let nearIndex = 0;
  let painted = '';
  let placed = false;
  root.hidden = true;

  const schedule = (step: FrameRequestCallback) => { frame = requestAnimationFrame(step); };
  const cancel = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
  const idle = (on: boolean) => { if (on) root.dataset.idle = ''; else delete root.dataset.idle; };

  function cardOf(name: string): HTMLElement | null {
    return Array.from(board.querySelectorAll<HTMLElement>('[data-palette-card]')).find((element) => element.dataset.paletteCard === name) ?? null;
  }
  /**
   * Where the mark stands in its zone, and how big it may be there: on the rule above the values,
   * below whatever is printed above them, right-aligned in a card and centred in a tint. A free space
   * too small for the full size shrinks it; one too small for MIN_SIZE hides it.
   */
  function aim(next: StudioColorMarkTarget, form: Form): Aim | null {
    const card = cardOf(next.name);
    if (!card) return null;
    const zone = Array.from(card.querySelectorAll<HTMLElement>('[data-mark-zone]')).find((element) => element.dataset.markZone === next.zone) ?? card;
    const origin = board.getBoundingClientRect();
    const box = zone.getBoundingClientRect();
    const lead = zone.querySelector<HTMLElement>('[data-mark-ceiling]');
    const floor = zone.querySelector<HTMLElement>('[data-mark-floor]')?.getBoundingClientRect().top ?? box.bottom;
    const bottom = Math.min(box.bottom, floor) - SHELF;
    const centred = next.zone !== 'card';
    const base = SIZE[next.tier];
    // The text above only blocks the column the mark stands in: a short name leaves the right side free.
    // Two passes, since the column narrows as the mark shrinks to fit.
    let size = base;
    let reach = studioMarkReach({ size, ...form });
    let x = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      x = centred ? box.left + box.width / 2 - (reach.left + reach.right) / 2 : box.right - INSET - reach.right;
      const top = Math.max(box.top, textBottom(lead, x + reach.left, x + reach.right) ?? box.top) + AIR;
      const full = studioMarkReach({ size: base, ...form });
      const fit = Math.min(1, (bottom - top) / Math.max(1, full.bottom - full.top), (box.width - INSET * 2) / Math.max(1, full.right - full.left));
      size = Math.max(0, base * fit);
      reach = studioMarkReach({ size, ...form });
    }
    x = centred ? box.left + box.width / 2 - (reach.left + reach.right) / 2 : box.right - INSET - reach.right;
    return { x: x - origin.left, y: bottom - reach.bottom - origin.top, size, visible: size >= MIN_SIZE };
  }

  function paintColour() {
    const key = pose.color.join();
    if (key === painted) return;
    painted = key;
    // A white solid would vanish on its own white tints, so pale colours are cast a little darker.
    const solid = shade(pose.color, -0.16 * unit((relativeLuminance(pose.color) - 0.72) / 0.28));
    for (const face of cubeFaces) face.style.backgroundColor = css(shade(solid, CUBE_SHADES[face.dataset.face as keyof typeof CUBE_SHADES]));
    for (const face of pyramidFaces) face.style.backgroundColor = css(shade(solid, PYRAMID_SHADES[face.dataset.face as keyof typeof PYRAMID_SHADES]));
    root.style.setProperty('--mark-eye', relativeLuminance(pose.color) < 0.15 ? '#f3f1ec' : '#141311');
  }
  function paint() {
    // Squash and stretch happen on screen about the mark's feet, so it presses into the rule it stands on.
    const feet = studioMarkReach(pose).bottom;
    root.style.transform = `translate(${pose.x}px, ${pose.y}px)`;
    root.style.opacity = String(pose.opacity);
    root.style.setProperty('--mark-size', `${pose.size}px`);
    rotor.style.transform = `translateY(${-pose.lift}px) translateY(${feet}px) scale(${pose.sx}, ${pose.sy}) translateY(${-feet}px) rotateX(${pose.rx}deg) rotateY(${pose.ry}deg) rotateZ(${pose.rz}deg) scale(${pose.scale})`;
    const ground = 1 - Math.min(pose.lift / 90, 0.62);
    shadowPos.style.transform = `translate(0px, ${feet - 2}px) scale(${ground * pose.scale * pose.sx}, ${ground * pose.scale})`;
    shadowPos.style.opacity = String((0.92 - Math.min(pose.lift / 80, 0.6)) * pose.scale);
    // Faces fade one by one: opacity on a preserve-3d parent would flatten the solid.
    cube.style.visibility = pose.form > 0.98 ? 'hidden' : 'visible';
    pyramid.style.visibility = pose.form < 0.02 ? 'hidden' : 'visible';
    for (const face of cubeFaces) face.style.opacity = String(1 - pose.form);
    for (const face of pyramidFaces) face.style.opacity = String(pose.form);
    paintColour();
  }
  function settle(next: StudioColorMarkTarget, form: Form) {
    rest = form;
    const spot = aim(next, form);
    Object.assign(pose, form, { lift: 0, scale: 1, sx: 1, sy: 1, color: destination });
    if (spot) Object.assign(pose, { x: spot.x, y: spot.y, size: spot.size, opacity: spot.visible ? 1 : 0 });
    root.hidden = false;
    paint();
    idle(Boolean(spot?.visible) && !reducedMotion());
  }

  /** The landing: a damped squash about the feet while the zone may still be settling. */
  function landing(next: StudioColorMarkTarget, form: Form, hopStart: number) {
    const begun = performance.now();
    const tick = (now: number) => {
      const t = unit((now - begun) / LAND_MS);
      const spring = Math.exp(-6 * t) * Math.cos(2 * Math.PI * 1.7 * t) * (1 - t);
      const spot = aim(next, form);
      if (spot) Object.assign(pose, { x: spot.x, y: spot.y, size: spot.size, opacity: spot.visible ? 1 : 0 });
      pose.lift = 0;
      pose.sy = 1 - LAND_SQUASH * spring;
      pose.sx = 1 + LAND_SQUASH * 0.55 * spring;
      paint();
      if (t < 1 || now - hopStart < LAYOUT_MS) { schedule(tick); return; }
      flying = false;
      frame = 0;
      settle(next, form);
    };
    tick(begun);
  }

  /**
   * A hop between tints of one card changes shape too: it takes the next landing pose of the other
   * form, turned to face away from where it stood, so cube and pyramid trade places tint by tint.
   */
  function nearForm(from: Form): Form {
    const others = FORMS.filter((form) => form.form !== from.form);
    const pick = others[nearIndex % others.length]!;
    nearIndex += 1;
    return { ...pick, ry: Math.sign(pick.ry) === Math.sign(from.ry) ? -pick.ry : pick.ry };
  }

  function hop(next: StudioColorMarkTarget, occupied: boolean, kind: keyof typeof HOP) {
    // A hop across the card morphs into the other form; a hop between cards takes the next pose.
    const form = kind === 'near' ? nearForm(rest) : FORMS[formIndex % FORMS.length]!;
    if (kind === 'far') formIndex += 1;
    // Held from take-off, so a click mid-flight morphs on from where the mark is headed.
    rest = form;
    const wasFlying = flying;
    cancel();
    idle(false);
    if (reducedMotion()) { flying = false; settle(next, form); return; }
    const from = { ...pose };
    const begin = aim(next, form);
    const start = wasFlying || occupied ? { x: pose.x, y: pose.y } : begin ?? pose;
    const entering = pose.scale < 1;
    const entryScale = Math.max(MIN_ENTRY_SCALE, from.scale);
    const duration = entering ? REENTRY_MS : HOP[kind].ms;
    const height = HOP[kind].height;
    const deltaRx = wrapDelta(from.rx, form.rx);
    const deltaRy = wrapDelta(from.ry, form.ry) + (kind === 'far' ? 360 : 0);
    const deltaRz = wrapDelta(from.rz, form.rz);
    const begun = performance.now();
    // A mark already in the air, or arriving, skips the crouch.
    const crouch = wasFlying || entering ? 0 : CROUCH;
    let last: Aim = begin ?? { x: start.x, y: start.y, size: from.size, visible: true };
    flying = true;
    root.hidden = false;
    const tick = (now: number) => {
      const elapsed = Math.max(0, now - begun);
      const t = unit(elapsed / duration);
      const air = crouch ? unit((t - crouch) / (1 - crouch)) : t;
      const travel = easeInOut(air);
      const wave = Math.sin(Math.PI * air);
      const dip = crouch && t < crouch ? Math.sin(Math.PI * t / crouch) : 0;
      last = aim(next, form) ?? last;
      pose.x = start.x + (last.x - start.x) * travel;
      pose.y = start.y + (last.y - start.y) * travel;
      pose.lift = wave * height;
      pose.rx = from.rx + deltaRx * ease(air) + wave * LEAN.rx * (kind === 'far' ? 1 : 0.45);
      pose.ry = from.ry + deltaRy * ease(air);
      pose.rz = from.rz + deltaRz * ease(air) + wave * LEAN.rz * (kind === 'far' ? 1 : 0.45);
      pose.scale = entryScale + (1 - entryScale) * ease(t);
      pose.sy = (1 - dip * CROUCH_SQUASH) * (1 + wave * STRETCH);
      pose.sx = (1 + dip * CROUCH_SQUASH * 0.6) * (1 - wave * STRETCH * 0.5);
      pose.form = from.form + (form.form - from.form) * unit((travel - 0.28) / 0.38);
      pose.color = mixRgb(from.color, destination, unit((travel - 0.34) / 0.4));
      pose.size = from.size + (last.size - from.size) * travel;
      pose.opacity = (entering ? unit(t / 0.2) : 1) * (last.visible ? 1 : 1 - travel);
      paint();
      if (elapsed < duration) { schedule(tick); return; }
      landing(next, form, begun);
    };
    tick(begun);
  }

  function fade(leaving: StudioColorMarkTarget) {
    const wasHidden = root.hidden;
    cancel();
    idle(false);
    if (wasHidden) return;
    if (reducedMotion()) { pose.scale = 0; root.hidden = true; flying = false; return; }
    const begun = performance.now();
    flying = true;
    const tick = (now: number) => {
      const t = unit((now - begun) / FADE_MS);
      const spot = aim(leaving, rest);
      if (spot) { pose.x = spot.x; pose.y = spot.y; }
      pose.lift = 10 * t;
      pose.scale = 1 - ease(t);
      paint();
      if (t < 1) { schedule(tick); return; }
      flying = false;
      frame = 0;
      root.hidden = true;
    };
    tick(begun);
  }

  // A theme change repaints the mark in place; it only tumbles when the open card changes.
  function recolour() {
    if (flying) return;
    cancel();
    if (reducedMotion()) { pose.color = destination; paint(); return; }
    const from = pose.color;
    const begun = performance.now();
    const tick = (now: number) => {
      const t = unit((now - begun) / RECOLOUR_MS);
      pose.color = mixRgb(from, destination, ease(t));
      paint();
      if (t < 1) schedule(tick);
      else frame = 0;
    };
    tick(begun);
  }

  return {
    sync(next) {
      const previous = target;
      target = next;
      if (!next) { placed = true; if (previous) fade(previous); return; }
      if (next.hex) destination = rgbOf(next.hex);
      // The first open card is simply there when the board appears, with no motion at all.
      if (!placed) { placed = true; pose.color = destination; settle(next, FORMS[1]!); return; }
      if (previous?.name === next.name && previous.zone === next.zone) { if (next.hex && next.hex !== previous.hex) recolour(); return; }
      hop(next, previous !== null, previous?.name === next.name ? 'near' : 'far');
    },
    land() {
      if (!target || flying) return;
      const spot = aim(target, rest);
      if (!spot) return;
      Object.assign(pose, { x: spot.x, y: spot.y, size: spot.size, opacity: spot.visible ? 1 : 0 });
      paint();
    },
    /** A small happy hop and a turn in place, for a copied tint. */
    cheer() {
      if (!target || flying || root.hidden || reducedMotion()) return;
      const next = target;
      const form = rest;
      cancel();
      idle(false);
      flying = true;
      const begun = performance.now();
      const tick = (now: number) => {
        const t = unit((now - begun) / CHEER_MS);
        const air = unit((t - 0.18) / 0.82);
        const wave = Math.sin(Math.PI * air);
        const dip = t < 0.18 ? Math.sin(Math.PI * t / 0.18) : 0;
        pose.lift = wave * 16;
        pose.ry = form.ry + 360 * easeInOut(air);
        pose.sy = (1 - dip * 0.14) * (1 + wave * 0.06);
        pose.sx = (1 + dip * 0.08) * (1 - wave * 0.03);
        paint();
        if (t < 1) { schedule(tick); return; }
        pose.ry = form.ry;
        landing(next, form, begun - LAYOUT_MS);
      };
      tick(begun);
    },
    /** Eyes turn toward a point on screen, a pixel or two at most; null centres them. */
    look(x, y) {
      const anchor = root.getBoundingClientRect();
      const dx = x - anchor.left;
      const dy = y - (anchor.top - pose.size * 0.3);
      root.style.setProperty('--look-x', (Math.max(-1, Math.min(1, dx / 140)) * pose.size * 0.035).toFixed(2) + 'px');
      root.style.setProperty('--look-y', (Math.max(-1, Math.min(1, dy / 140)) * pose.size * 0.03).toFixed(2) + 'px');
    },
    dispose() { cancel(); },
  };
}

/**
 * Sits directly inside the board and follows the open card; `layoutKey` re-lands it after the rows
 * reflow, and each change of `cheer` makes it hop for joy. It reads the board from its own parent
 * because a parent's ref is not attached yet when a child's layout effect first runs.
 */
export function StudioColorMark({ target, layoutKey, cheer = 0 }: { target: StudioColorMarkTarget | null; layoutKey: string; cheer?: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MarkEngine | null>(null);
  const name = target?.name ?? null;
  const tier = target?.tier ?? 'role';
  const hex = target?.hex ?? null;
  const zone = target?.zone ?? 'card';

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root?.parentElement) return;
    const engine = createMarkEngine(root, root.parentElement);
    engineRef.current = engine;
    return () => { engine.dispose(); engineRef.current = null; };
  }, []);
  useLayoutEffect(() => { engineRef.current?.sync(name ? { name, tier, hex, zone } : null); }, [name, tier, hex, zone]);
  useLayoutEffect(() => { engineRef.current?.land(); }, [layoutKey]);
  const cheered = useRef(cheer);
  useEffect(() => { if (cheer !== cheered.current) { cheered.current = cheer; engineRef.current?.cheer(); } }, [cheer]);

  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;
    const land = () => engineRef.current?.land();
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName === 'flex-grow' || event.propertyName === 'flex-basis') land();
    };
    let pending = 0;
    let point: { x: number; y: number } | null = null;
    const look = () => {
      pending = 0;
      if (point) { engineRef.current?.look(point.x, point.y); return; }
      rootRef.current?.style.setProperty('--look-x', '0px');
      rootRef.current?.style.setProperty('--look-y', '0px');
    };
    const onMove = (event: PointerEvent) => { point = { x: event.clientX, y: event.clientY }; if (!pending) pending = requestAnimationFrame(look); };
    const onLeave = () => { point = null; if (!pending) pending = requestAnimationFrame(look); };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(land) : null;
    observer?.observe(host);
    host.addEventListener('transitionend', onTransitionEnd);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', land);
    return () => {
      if (pending) cancelAnimationFrame(pending);
      observer?.disconnect();
      host.removeEventListener('transitionend', onTransitionEnd);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', land);
    };
  }, []);

  return (
    // The perspective is set here, beside the geometry that keeps the mark inside its zone.
    <div ref={rootRef} className={styles.mark} style={{ perspective: PERSPECTIVE }} aria-hidden="true">
      <div data-part="shadow" className={styles.shadowPos}><div className={styles.shadow} /></div>
      <div className={styles.idle}>
        <div data-part="rotor" className={styles.rotor}>
          <div data-part="cube" className={styles.cube}>
            <div data-face="front" className={`${styles.face} ${styles.front}`}><span className={`${styles.eye} ${styles.eyeLeft}`} /><span className={`${styles.eye} ${styles.eyeRight}`} /></div>
            <div data-face="back" className={`${styles.face} ${styles.back}`} />
            <div data-face="right" className={`${styles.face} ${styles.right}`} />
            <div data-face="left" className={`${styles.face} ${styles.left}`} />
            <div data-face="top" className={`${styles.face} ${styles.top}`} />
            <div data-face="bottom" className={`${styles.face} ${styles.bottom}`} />
          </div>
          <div data-part="pyramid" className={styles.pyramid}>
            <i data-face="n" className={`${styles.side} ${styles.north}`} />
            <i data-face="e" className={`${styles.side} ${styles.east}`}><span className={`${styles.sideEye} ${styles.sideEyeLeft}`} /><span className={`${styles.sideEye} ${styles.sideEyeRight}`} /></i>
            <i data-face="s" className={`${styles.side} ${styles.south}`} />
            <i data-face="w" className={`${styles.side} ${styles.west}`} />
            <i className={styles.baseWrap}><i data-face="base" className={`${styles.side} ${styles.base}`} /></i>
          </div>
        </div>
      </div>
    </div>
  );
}
