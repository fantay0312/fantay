// SPDX-License-Identifier: AGPL-3.0-only
// Where the living mascot is drawn. Every mascot on the page shares one WebGL context: a page may hold a dozen of them
// and a browser allows only a handful of contexts, so each mascot is drawn in turn into the shared context and copied
// to its own small canvas. One requestAnimationFrame loop steps and draws them all, and stops when none is on screen.
//
// Two things are drawn. The body (mascot-body.ts) is the spirit itself: pale, round, with its face on the front. The
// cloth over it is drawn as its skin (mascot-skin.ts): the cloth's own surface made finer and smooth, so its outline
// is a curve, blue outside and coral inside, decided per pixel by which way the surface faces. Both are shaded as a
// drawing is, in a few tones, not as a photograph: at the sizes a mascot is seen at, tones read and fine gradients
// turn to mud. The body's tones are flat with hard edges. The cloth's pass into one another gently and it throws no
// glint: with hard edges and a glint it is a shell, not cloth. The face is not geometry: the eyes, their glints and the cheeks are
// painted on the front of the body, so they turn with it and stay sharp at any size. The cloth is a piece of night
// sky: a few small stars are set in it and twinkle, and now and then a run of light crosses them. At the end of its
// hat's tail hangs the spirit's light, a small orb lit from within, soft all the way to its rim, which flares and
// burns low with what the spirit is doing. The
// motes of light it sheds are drawn on its own canvas, behind it or in front: sparks, the hearts of a mascot being
// stroked, and the z of one asleep. Loaded on demand (FantayMascot.tsx), so three.js is never in the first paint.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three';

import { OVERSCAN, TOP_COLOR, UNDERSIDE_COLOR } from './mascot-art';
import { bodyFor } from './mascot-body';
import { MOTE_HEART, MOTE_ZED, arriveFlight, createFlight, resizeFlight, stepFlight, type Flight, type FlightInput, type FlightMood } from './mascot-flight';
import { FACE, ORB, handAt, sheetFor, spacingFor } from './mascot-sheet';
import { drapeSkin, skinFor, skinNormals, type Skin } from './mascot-skin';

/** How far the eye stands from the mascot, in half box widths: far enough that depth only hints. */
const DISTANCE = 7;
/** Device pixels per CSS pixel are followed up to here. */
const MOST_DPR = 2;
/** The longest frame the cloth is ever stepped by, seconds. */
const MOST_FRAME = 0.05;

/** The key light, from the upper left and a little behind the viewer's shoulder. */
const LIGHT = new Vector3(-0.62, 0.62, 0.48).normalize();
/** The gaze works in the artwork's units; the face is in the body's. The eyes go this share of the way the gaze
 *  does: they are large on a small face, and carried further they would leave it. */
const GAZE = 1 / 420;
const EYES_FOLLOW = 0.42;
/** The smallest mascot that sheds motes, CSS px: below it they would be specks. */
const MOTES_FROM = 44;
/** The cheeks: a blush below each eye and a little outside it. How far outside the eye's middle and below it, in the
 *  eye's own radii, and its two radii in the body's units. */
const CHEEK = { out: 1.05, low: 1.0, rx: 0.094, ry: 0.055 } as const;
/** The mouth, between the eyes and below them: a cat's, two small bowls side by side. How far below the eyes' middle,
 *  in the eye's own radii, and each bowl's two radii in the body's units. It comes and goes with the blush: on a few
 *  pixels of face it is a speck. */
const MOUTH = { low: 0.78, rx: 0.039, ry: 0.036 } as const;
/** The light the orb gives off is drawn round it: from how far out of its middle, and how far it reaches, in the
 *  orb's radii; how strong it is at rest; and how it dies away between the two, as shares of its strength at even
 *  steps: fast at first and then slowly, as a glow does, so it has no rim of its own. */
const HALO = { from: 0.5, reach: 3, glow: 0.34, fall: [1, 0.6, 0.32, 0.14, 0.04, 0] } as const;
const ORB_GLOW = '255, 150, 120';
/** The stars set in the cloth: each is where it is on the cloth, as an angle round from the front towards the
 *  mascot's right, in degrees, and a share of the way from the crown down to the hem; and how large it is, in half
 *  box widths. Four on the hat, six round the head, two on the brim. */
const STARS: readonly (readonly [number, number, number])[] = [
  [-18, 0.295, 0.045],
  [16, 0.35, 0.06],
  [-40, 0.38, 0.04],
  [40, 0.396, 0.04],
  [8, 0.47, 0.07],
  [-56, 0.498, 0.05],
  [30, 0.507, 0.045],
  [62, 0.479, 0.04],
  [-30, 0.555, 0.04],
  [-12, 0.583, 0.035],
  [50, 0.722, 0.04],
  [-50, 0.741, 0.045],
];
/** The smallest mascot whose cloth shows its stars, CSS px, and the size from which they show in full. */
const STARS_FROM = 40;
const STARS_FULL = 72;
/** A run of light through the stars crosses the cloth between these, in half box widths; and where it is kept when
 *  there is none, out of every star's reach. */
const SWEEP_FROM = -1;
const SWEEP_TO = 1;
const NO_SWEEP = 9;
/** The smallest mascot that blushes, CSS px, and the size from which it blushes in full: on a few pixels of face a
 *  blush is a smudge. */
const BLUSH_FROM = 30;
const BLUSH_FULL = 60;
/** The body is cut with this many rings where it is seen large, and this many where it is a few pixels. */
const BODY_RINGS = 40;
const BODY_RINGS_SMALL = 20;
/** How far the wisp under the body swings for a radian of the tail's swing, in half box widths. */
const WISP_SWING = 0.32;
const MOTE_WARM = '#fe8b6d';
const MOTE_COOL = '#8f93ff';

const CLOTH_VERTEX = /* glsl */ `
attribute float fall;
attribute vec3 home;
varying vec3 vNormal;
varying vec3 vToEye;
varying float vFall;
varying vec3 vHome;
void main() {
  vec4 seen = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalMatrix * normal;
  vToEye = -seen.xyz;
  vFall = fall;
  vHome = home;
  gl_Position = projectionMatrix * seen;
}
`;

const CLOTH_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uTopDeep;
uniform vec3 uTopLight;
uniform vec3 uUnder;
uniform vec3 uUnderDeep;
uniform vec3 uLight;
uniform float uForm;
uniform vec4 uStars[STAR_COUNT];
uniform vec3 uStar;
uniform float uStarry;
uniform float uTime;
uniform float uSweep;
varying vec3 vNormal;
varying vec3 vToEye;
varying float vFall;
varying vec3 vHome;

// The stars set in the cloth: how brightly one shows at this place on it. Each has four points and its own slow
// twinkle. They are set as the mascot is seen from the front at ease, so from there none is drawn out of shape by
// the curve of the cloth it is on; and only on the side of the cloth each was set on. Now and then a run of light
// crosses the cloth from side to side: each star swells and shines its brightest as the run passes it.
float stars() {
  float lit = 0.0;
  for (int i = 0; i < STAR_COUNT; i += 1) {
    vec3 off = vHome - uStars[i].xyz;
    float pass = (uStars[i].x - uSweep) / 0.3;
    float run = exp(-pass * pass);
    vec2 p = off.xy / (uStars[i].w * (1.0 + 0.8 * run));
    float f = pow(abs(p.x), 0.62) + pow(abs(p.y), 0.62);
    float same = 1.0 - smoothstep(0.12, 0.24, abs(off.z));
    float twinkle = 0.5 + 0.5 * sin(uTime * (1.1 + 0.31 * float(i)) + 2.4 * float(i));
    lit = max(lit, (1.0 - smoothstep(0.82, 1.0, f)) * same * min(1.0, 0.35 + 0.65 * twinkle + run));
  }
  return lit;
}

void main() {
  bool outside = gl_FrontFacing;
  vec3 n = normalize(vNormal);
  if (!outside) n = -n;
  float lit = dot(n, uLight);
  vec3 colour;
  if (outside) {
    // Soft cloth, not a shell: it throws no glint, and its three tones (in shadow, in the light, and where it faces
    // the light squarely) pass into one another gently, as light does across a thing with a nap.
    colour = mix(uTopDeep, uTop, smoothstep(-0.5, 0.12, lit));
    colour = mix(colour, uTopLight, smoothstep(0.1, 1.05, lit) * 0.85);
    // And the nap catches the light where the cloth turns away from the viewer: its edge is paler than its middle,
    // on the side the light comes from.
    float edge = 1.0 - max(0.0, dot(n, normalize(vToEye)));
    colour = mix(colour, uTopLight, edge * edge * edge * 0.55 * smoothstep(-0.25, 0.45, lit));
    colour = mix(uTop, colour, uForm);
    colour = mix(colour, uStar, stars() * uStarry);
  } else {
    // The lining: its own coral where the cloth hangs clear, a deeper one up under the head.
    colour = mix(uUnderDeep, uUnder, smoothstep(0.3, 0.42, vFall));
    colour = mix(uUnder, colour, uForm);
  }
  gl_FragColor = vec4(colour, 1.0);
  #include <colorspace_fragment>
}
`;

const BODY_VERTEX = /* glsl */ `
attribute float wisp;
attribute float limb;
uniform float uSwing;
uniform vec3 uHandRight;
uniform vec3 uHandLeft;
varying vec3 vNormal;
varying vec3 vToEye;
varying vec3 vLocal;
varying float vLimb;
void main() {
  // The wisp under the body swings with the tail, further the nearer its tip; each hand goes as one piece.
  vec3 at = position;
  at.x += uSwing * wisp * wisp;
  if (limb > 0.5) at += uHandRight;
  if (limb < -0.5) at += uHandLeft;
  vLimb = abs(limb);
  vLocal = position;
  vec4 seen = modelViewMatrix * vec4(at, 1.0);
  vNormal = normalMatrix * normal;
  vToEye = -seen.xyz;
  gl_Position = projectionMatrix * seen;
}
`;

const BODY_FRAGMENT = /* glsl */ `
uniform vec3 uSkin;
uniform vec3 uSkinShade;
uniform vec3 uHand;
uniform vec3 uHandShade;
uniform vec3 uEyeDark;
uniform vec3 uEyeMid;
uniform vec3 uEyeLight;
uniform vec3 uBlushTint;
uniform vec3 uLight;
uniform float uForm;
uniform float uBrim;
uniform vec4 uEyeA;
uniform vec4 uEyeB;
uniform vec4 uCheekA;
uniform vec4 uCheekB;
uniform float uBlush;
uniform float uJoy;
uniform float uLid;
uniform float uGape;
uniform float uInk;
uniform vec4 uMouth;
varying vec3 vNormal;
varying vec3 vToEye;
varying vec3 vLocal;
varying float vLimb;

float disc(vec2 d, float radius, float soft) {
  return 1.0 - smoothstep(radius - soft, radius + soft, length(d));
}

// An eye: its colour, and in alpha how much of this pixel it covers. Dark above and lighter below, a pale crescent
// along its lower rim, and two glints. Pleased, a second oval comes up from below as a cheek does and covers its
// lower part: what is left is an arch. Its lid is the same oval come down from above: half down the eye is heavy,
// and right down what is left is the arch the other way up, the dark curve of an eye shut in sleep.
vec4 eye(vec4 e) {
  vec2 d = (vLocal.xy - e.xy) / e.zw;
  float f = length(d);
  float soft = fwidth(f) * 0.75 + 0.0001;
  float cover = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, f);
  vec2 below = (vLocal.xy - e.xy + vec2(0.0, e.w * (0.62 + 1.7 * (1.0 - uJoy)))) / (e.zw * vec2(1.25, 1.0));
  float g = length(below);
  float softer = fwidth(g) * 0.75 + 0.0001;
  cover *= smoothstep(1.0 - softer, 1.0 + softer, g);
  vec2 above = (vLocal.xy - e.xy - vec2(0.0, e.w * (0.62 + 1.7 * (1.0 - uLid)))) / (e.zw * vec2(1.25, 1.0));
  float h = length(above);
  float softest = fwidth(h) * 0.75 + 0.0001;
  cover *= smoothstep(1.0 - softest, 1.0 + softest, h);
  vec3 colour = mix(uEyeMid, uEyeDark, smoothstep(-0.5, 0.3, d.y));
  colour = mix(colour, uEyeLight, smoothstep(0.42, 0.78, f) * smoothstep(0.05, -0.75, d.y) * 0.85);
  float glint = max(disc(d - vec2(-0.3, 0.36), 0.3, soft), disc(d - vec2(0.36, -0.36), 0.13, soft));
  colour = mix(colour, vec3(1.0), glint * (1.0 - uJoy));
  // Shut, it is one dark line: the pale rim that is all the lid leaves showing would read as an eye still open.
  colour = mix(colour, uEyeDark, smoothstep(0.5, 0.85, uLid));
  return vec4(colour, cover);
}

// A blush: soft all the way to its edge, with no outline.
float cheek(vec4 c) {
  return 1.0 - smoothstep(0.2, 1.0, length((vLocal.xy - c.xy) / c.zw));
}

// The lower half of a small oval's rim: a bowl.
float bowl(vec2 d) {
  float f = length(d);
  float soft = fwidth(f) * 0.75 + 0.0001;
  float under = 1.0 - smoothstep(-soft, soft, d.y);
  return under * (1.0 - smoothstep(1.0 - soft, 1.0 + soft, f)) * smoothstep(0.5 - soft, 0.5 + soft, f);
}

// The mouth: two bowls side by side, a cat's. Pleased, it opens: one wider bowl, filled. Gaping, it is a round hole
// instead, small for a start and large for a yawn, hung from where the mouth is so that it opens downwards.
float mouth(vec4 m) {
  vec2 d = (vLocal.xy - m.xy) / m.zw;
  float smile = max(bowl(d - vec2(-1.0, 0.0)), bowl(d - vec2(1.0, 0.0)));
  vec2 wide = d / vec2(1.7, 1.9);
  float f = length(wide);
  float soft = fwidth(f) * 0.75 + 0.0001;
  float open = (1.0 - smoothstep(-soft, soft, wide.y)) * (1.0 - smoothstep(1.0 - soft, 1.0 + soft, f));
  vec2 size = vec2(2.2, 2.9) * (0.26 + 0.74 * uGape);
  float g = length((d + vec2(0.0, size.y - 0.4)) / size);
  float softer = fwidth(g) * 0.75 + 0.0001;
  float hole = 1.0 - smoothstep(1.0 - softer, 1.0 + softer, g);
  return mix(mix(smile, open, uJoy), hole, smoothstep(0.0, 0.2, uGape));
}

void main() {
  // The eyes are worked out for every pixel, before anything is decided: fwidth has no meaning inside a branch that
  // some pixels take and their neighbours do not.
  vec4 a = eye(uEyeA);
  vec4 b = eye(uEyeB);
  float smile = mouth(uMouth);
  float front = smoothstep(0.04, 0.12, vLocal.z) * (1.0 - vLimb);
  vec3 n = normalize(vNormal);
  float lit = dot(n, uLight);
  // Two flat tones; and the cloth's brim throws its shadow across the top of the face.
  float shade = 1.0 - smoothstep(-0.47, -0.41, lit);
  shade = max(shade, smoothstep(uBrim - 0.06, uBrim, vLocal.y) * front);
  // The hands are a shade deeper than the body, so they can be told from it and from a pale page.
  vec3 colour = mix(mix(uSkin, uHand, vLimb), mix(uSkinShade, uHandShade, vLimb), shade * uForm);
  colour = mix(colour, uBlushTint, max(cheek(uCheekA), cheek(uCheekB)) * front * uBlush);
  // The mouth is drawn as faintly as the blush, a line on a small face; open round, it is a hole and is dark.
  colour = mix(colour, uEyeDark, smile * front * mix(uBlush, uInk, smoothstep(0.0, 0.2, uGape)));
  colour = mix(colour, a.rgb, a.a * front);
  colour = mix(colour, b.rgb, b.a * front);
  gl_FragColor = vec4(colour, 1.0);
  #include <colorspace_fragment>
}
`;

const ORB_VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vToEye;
void main() {
  vec4 seen = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalMatrix * normal;
  vToEye = -seen.xyz;
  gl_Position = projectionMatrix * seen;
}
`;

const ORB_FRAGMENT = /* glsl */ `
uniform vec3 uOrb;
uniform vec3 uOrbDeep;
uniform vec3 uOrbLight;
uniform vec3 uLight;
uniform float uGlow;
varying vec3 vNormal;
varying vec3 vToEye;
void main() {
  vec3 n = normalize(vNormal);
  vec3 eye = normalize(vToEye);
  // It is a light and not a bead: it is lit from within, so it is palest about its middle, a little to the side the
  // key light is on, and its colour deepens from there to its rim without a step anywhere and with no glint on it.
  float core = dot(n, normalize(eye + 0.45 * uLight));
  vec3 colour = mix(uOrbDeep, uOrb, smoothstep(-0.25, 0.5, core));
  colour = mix(colour, uOrbLight, smoothstep(0.5, 1.0, core) * (0.8 + 0.2 * uGlow));
  // The brighter it glows the paler it is all over.
  colour = mix(colour, uOrbLight, uGlow * 0.4);
  // Its rim is soft: it gives way to the glow round it.
  float rim = smoothstep(0.0, 0.42, max(0.0, dot(n, eye)));
  gl_FragColor = vec4(colour, rim);
  #include <colorspace_fragment>
}
`;

export interface ActorOptions {
  /** The mascot's own canvas, `OVERSCAN` times its box and centred on it. */
  canvas: HTMLCanvasElement;
  /** Width of the mascot's box, CSS px. */
  size: number;
  small: boolean;
  appear: boolean;
  mood: () => FlightMood;
  /** Called before each step to bring the pointer in. */
  read?: (dt: number, input: FlightInput) => void;
  /** Called after each frame is on the canvas. */
  drawn?: (flight: Flight) => void;
  /** Called when it can no longer be drawn live: reduced motion was turned on, or the graphics context was lost. */
  rest?: () => void;
  /** Left out of the shared loop: whoever made it steps it by hand. */
  manual?: boolean;
}

export interface StageActor {
  readonly flight: Flight;
  /** Follows a new box width, CSS px. */
  resize(size: number): void;
  /** Whether it is on screen: off screen it is neither stepped nor drawn. */
  show(on: boolean): void;
  /** Steps it by `dt` seconds and draws it, outside the shared loop. */
  advance(dt: number): void;
  dispose(): void;
}

interface Actor extends StageActor {
  options: ActorOptions;
  geometry: BufferGeometry;
  /** The surface the cloth is drawn as, and where that lies and faces this frame. */
  skin: Skin;
  positions: Float32Array;
  normals: Float32Array;
  /** The body under the cloth. */
  body: BufferGeometry;
  context: CanvasRenderingContext2D;
  pixels: number;
  size: number;
  shown: boolean;
  gone: boolean;
  input: FlightInput;
  eyeA: Vector4;
  eyeB: Vector4;
  cheekA: Vector4;
  cheekB: Vector4;
  /** How much of its blush shows at its size, 0 to 1, and how much of the stars in its cloth. */
  blush: number;
  starry: number;
  /** Where the orb is this frame, in the stage's space, how brightly it glows, and how far it has flared. */
  orb: Vector3;
  glow: number;
  flare: number;
  form: number;
  /** Device pixels per half box width on its own canvas. */
  unit: number;
}

interface Stage {
  renderer: WebGLRenderer;
  canvas: HTMLCanvasElement;
  scene: Scene;
  camera: PerspectiveCamera;
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  body: Mesh<BufferGeometry, ShaderMaterial>;
  orb: Mesh<BufferGeometry, ShaderMaterial>;
  side: number;
  lost: boolean;
}

let stage: Stage | null = null;
const actors = new Set<Actor>();
let frame = 0;
let last = 0;
let motionQuery: MediaQueryList | null = null;
let reducedMotionActive = false;
let visibilityBound = false;

function ensureStageListeners(): void {
  if (typeof window === 'undefined') return;
  if (!motionQuery && typeof window.matchMedia === 'function') {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotionActive = motionQuery.matches;
    motionQuery.addEventListener?.('change', (event) => {
      reducedMotionActive = event.matches;
      if (reducedMotionActive) {
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        last = 0;
        for (const actor of actors) actor.options.rest?.();
      } else {
        wake();
      }
    });
  }
  if (!visibilityBound && typeof document !== 'undefined') {
    visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake();
    });
  }
}

function sizeGain(px: number): number {
  const t = (128 - px) / (128 - 28);
  return 1 + 0.36 * (t < 0 ? 0 : t > 1 ? 1 : t);
}

/** How much of the body's form is shaded in at a size: a few pixels of mascot read best in flat colour. */
function formFor(px: number): number {
  const t = (px - 20) / (72 - 20);
  return 0.5 + 0.5 * (t < 0 ? 0 : t > 1 ? 1 : t);
}

function colour(hex: string): Color {
  return new Color(hex);
}

function openStage(): Stage {
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.setSize(256, 256, false);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  const camera = new PerspectiveCamera((2 * Math.atan(OVERSCAN / DISTANCE) * 180) / Math.PI, 1, 0.5, DISTANCE * 3);
  camera.position.set(0, 0, DISTANCE);
  const material = new ShaderMaterial({
    vertexShader: CLOTH_VERTEX,
    fragmentShader: CLOTH_FRAGMENT,
    side: DoubleSide,
    uniforms: {
      uTop: { value: colour(TOP_COLOR) },
      uTopDeep: { value: colour('#3335b9') },
      uTopLight: { value: colour('#6b6ef2') },
      uUnder: { value: colour(UNDERSIDE_COLOR) },
      uUnderDeep: { value: colour('#e56a52') },
      uLight: { value: LIGHT },
      uForm: { value: 1 },
      uStars: { value: STARS.map(() => new Vector4()) },
      uStar: { value: colour('#eceeff') },
      uStarry: { value: 0 },
      uTime: { value: 0 },
      uSweep: { value: NO_SWEEP },
    },
    defines: { STAR_COUNT: STARS.length },
  });
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.frustumCulled = false;
  const skin = new ShaderMaterial({
    vertexShader: BODY_VERTEX,
    fragmentShader: BODY_FRAGMENT,
    uniforms: {
      uSkin: { value: colour('#f7f6ff') },
      uSkinShade: { value: colour('#cfd1fa') },
      uHand: { value: colour('#e2e3ff') },
      uHandShade: { value: colour('#b3b6f2') },
      uEyeDark: { value: colour('#20215f') },
      uEyeMid: { value: colour('#4447d6') },
      uEyeLight: { value: colour('#9da0ff') },
      uBlushTint: { value: colour('#ff9d8e') },
      uLight: { value: LIGHT },
      uForm: { value: 1 },
      uBrim: { value: -FACE.low + FACE.ry * 0.95 },
      uEyeA: { value: new Vector4() },
      uEyeB: { value: new Vector4() },
      uCheekA: { value: new Vector4() },
      uCheekB: { value: new Vector4() },
      uBlush: { value: 0 },
      uJoy: { value: 0 },
      uLid: { value: 0 },
      uGape: { value: 0 },
      uInk: { value: 0 },
      uSwing: { value: 0 },
      uHandRight: { value: new Vector3() },
      uHandLeft: { value: new Vector3() },
      uMouth: { value: new Vector4(0, -FACE.low - FACE.ry * MOUTH.low, MOUTH.rx, MOUTH.ry) },
    },
  });
  const body = new Mesh(new BufferGeometry(), skin);
  body.frustumCulled = false;
  // It is put in its place by hand each frame, as the head is.
  body.matrixAutoUpdate = false;
  const orb = new Mesh(
    new SphereGeometry(ORB.radius, 24, 16),
    new ShaderMaterial({
      vertexShader: ORB_VERTEX,
      fragmentShader: ORB_FRAGMENT,
      // Drawn after the cloth and the body, so its soft rim lies over whatever is behind it.
      transparent: true,
      uniforms: {
        uOrb: { value: colour(UNDERSIDE_COLOR) },
        uOrbDeep: { value: colour('#f2725a') },
        uOrbLight: { value: colour('#fff1e6') },
        uLight: { value: LIGHT },
        uGlow: { value: 0 },
      },
    }),
  );
  orb.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh, body, orb);
  const made: Stage = { renderer, canvas, scene, camera, mesh, body, orb, side: 256, lost: false };
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    made.lost = true;
    for (const actor of actors) actor.options.rest?.();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    made.lost = false;
    wake();
  });
  return made;
}

const starSets = new WeakMap<Skin, Vector4[]>();

/** Where the stars are on a skin: each at the place of the skin's own vertex nearest to where it is set. */
function starsOf(skin: Skin): Vector4[] {
  let set = starSets.get(skin);
  if (!set) {
    set = STARS.map(([round, down, size]) => {
      const column = ((Math.round((round / 360) * skin.cols) % skin.cols) + skin.cols) % skin.cols;
      const row = Math.min(skin.rows, Math.max(1, Math.round(down * skin.rows)));
      const v = 3 * (1 + column * skin.rows + (row - 1));
      return new Vector4(skin.home[v]!, skin.home[v + 1]!, skin.home[v + 2]!, size);
    });
    starSets.set(skin, set);
  }
  return set;
}

const placed = new Matrix4();

function draw(actor: Actor): void {
  const s = stage;
  if (!s || s.lost) return;
  const px = actor.pixels;
  if (px > s.side) {
    while (s.side < px) s.side *= 2;
    s.renderer.setSize(s.side, s.side, false);
  }
  const { geometry, flight } = actor;
  drapeSkin(actor.skin, flight.cloth.pos, actor.positions);
  skinNormals(actor.skin, actor.positions, actor.normals);
  (geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  (geometry.getAttribute('normal') as BufferAttribute).needsUpdate = true;
  // The eyes: where the gaze has them, on the front of the body. The artwork's y runs down, the face's up.
  const { gaze } = flight;
  const large = actor.options.small ? FACE.small : 1;
  const lookX = gaze.drawX * GAZE * EYES_FOLLOW;
  const lookY = -FACE.low - gaze.drawY * GAZE * EYES_FOLLOW;
  const rx = FACE.rx * large * gaze.drawWidth;
  const ry = FACE.ry * large * gaze.drawHeight;
  actor.eyeA.set(lookX - FACE.apart / 2, lookY, rx, ry);
  actor.eyeB.set(lookX + FACE.apart / 2, lookY, rx, ry);
  // The cheeks, below the eyes and outside them: they stay where they are while the eyes look about.
  const cheekX = FACE.apart / 2 + CHEEK.out * FACE.rx * large;
  const cheekY = -FACE.low - CHEEK.low * FACE.ry * large;
  actor.cheekA.set(-cheekX, cheekY, CHEEK.rx, CHEEK.ry);
  actor.cheekB.set(cheekX, cheekY, CHEEK.rx, CHEEK.ry);
  const cloth = s.mesh.material.uniforms;
  cloth.uForm!.value = actor.form;
  cloth.uStarry!.value = actor.starry;
  cloth.uTime!.value = flight.clock;
  cloth.uStars!.value = starsOf(actor.skin);
  cloth.uSweep!.value = flight.shimmer < 0 ? NO_SWEEP : SWEEP_FROM + (SWEEP_TO - SWEEP_FROM) * flight.shimmer;
  // The orb is where the flight has it, hung from the end of the hat's tail. It glows with every breath, more at
  // work, and most when the spirit is pleased or its light flares; asleep it burns low.
  actor.orb.set(flight.orb[0]!, flight.orb[1]!, flight.orb[2]!);
  const lit = 0.22 + 0.12 * Math.sin(Math.PI * 2 * flight.breath) + (flight.mood === 'working' ? 0.3 : 0) + 0.55 * flight.joy + 0.7 * flight.flare - 0.14 * flight.doze;
  actor.glow = Math.min(1, Math.max(0, lit));
  actor.flare = flight.flare;
  s.orb.position.copy(actor.orb);
  s.orb.material.uniforms.uGlow!.value = actor.glow;
  const uniforms = s.body.material.uniforms;
  uniforms.uEyeA!.value = actor.eyeA;
  uniforms.uEyeB!.value = actor.eyeB;
  uniforms.uCheekA!.value = actor.cheekA;
  uniforms.uCheekB!.value = actor.cheekB;
  // Pleased, it flushes deeper; stroked, or after a sneeze, deeper still.
  uniforms.uBlush!.value = actor.blush * Math.min(1, 0.55 + 0.35 * flight.joy + 0.4 * flight.flush);
  uniforms.uJoy!.value = flight.joy;
  uniforms.uLid!.value = flight.lid;
  uniforms.uGape!.value = flight.gape;
  uniforms.uInk!.value = 0.9 * actor.blush;
  uniforms.uForm!.value = actor.form;
  uniforms.uSwing!.value = flight.pose.swish * WISP_SWING;
  // The hands: the right one goes up with the cloth it lifts; the left one where the flight has it.
  const [restX, restY] = handAt(0);
  const [rightX, rightY] = handAt(Math.min(1, Math.max(0, flight.pose.wave)));
  const [leftX, leftY] = handAt(Math.min(1, Math.max(0, flight.left)));
  (uniforms.uHandRight!.value as Vector3).set(rightX - restX, rightY - restY, 0);
  (uniforms.uHandLeft!.value as Vector3).set(restX - leftX, leftY - restY, 0);
  // The body goes where the head is, turned as it is turned and stretched as it is stretched.
  const m = flight.turn;
  const o = flight.origin;
  const tall = 1 + flight.pose.stretch;
  const wide = 1 / Math.sqrt(tall);
  placed.set(
    m[0]! * wide, m[1]! * tall, m[2]! * wide, o[0]!,
    m[3]! * wide, m[4]! * tall, m[5]! * wide, o[1]!,
    m[6]! * wide, m[7]! * tall, m[8]! * wide, o[2]!,
    0, 0, 0, 1,
  );
  s.body.matrix.copy(placed);
  s.body.matrixWorldNeedsUpdate = true;
  s.body.geometry = actor.body;
  s.mesh.geometry = geometry;
  s.renderer.setViewport(0, 0, px, px);
  s.renderer.setScissor(0, 0, px, px);
  s.renderer.setScissorTest(true);
  s.renderer.clear();
  s.renderer.render(s.scene, s.camera);
  // The shared context's picture is only good until the browser next composes the page, so it is copied out at once.
  // Each frame replaces the whole canvas.
  const context = actor.context;
  context.globalCompositeOperation = 'copy';
  context.globalAlpha = 1;
  context.drawImage(s.canvas, 0, s.side - px, px, px, 0, 0, px, px);
  halo(actor);
  motes(actor);
  actor.options.drawn?.(flight);
}

/** The light the orb gives off, drawn behind everything: it shows round the orb where the orb is against the air. */
function halo(actor: Actor): void {
  const { context, orb, unit } = actor;
  if (actor.size < STARS_FROM) return;
  const middle = actor.pixels / 2;
  const near = DISTANCE / (DISTANCE - orb.z);
  const x = middle + orb.x * near * unit;
  const y = middle - orb.y * near * unit;
  // A flare throws its light further.
  const reach = ORB.radius * HALO.reach * (1 + 0.6 * actor.flare) * near * unit;
  const strength = HALO.glow + 0.5 * actor.glow;
  const glow = context.createRadialGradient(x, y, ORB.radius * near * unit * HALO.from, x, y, reach);
  const last = HALO.fall.length - 1;
  for (let k = 0; k <= last; k += 1) glow.addColorStop(k / last, `rgba(${ORB_GLOW}, ${(strength * HALO.fall[k]!).toFixed(3)})`);
  context.globalCompositeOperation = 'destination-over';
  context.globalAlpha = 1;
  context.fillStyle = glow;
  context.fillRect(x - reach, y - reach, 2 * reach, 2 * reach);
}

/** The motes of light: those behind the body are slipped in under it, the rest go on top. Most are four-pointed
 *  stars; one that rises from a mascot being stroked is a heart, and one from a sleeper is a z that grows as it goes. */
function motes(actor: Actor): void {
  const { context, flight, unit } = actor;
  if (!flight.sparkle) return;
  const middle = actor.pixels / 2;
  for (const mote of flight.motes) {
    if (mote.age >= mote.life || mote.glow <= 0.02) continue;
    const near = DISTANCE / (DISTANCE - mote.z);
    const x = middle + mote.x * near * unit;
    const y = middle - mote.y * near * unit;
    const r = mote.size * near * unit * (0.55 + 0.45 * mote.glow);
    context.globalCompositeOperation = mote.z < 0 ? 'destination-over' : 'source-over';
    context.globalAlpha = Math.min(1, mote.glow * 1.15);
    context.fillStyle = mote.warm ? MOTE_WARM : MOTE_COOL;
    context.beginPath();
    if (mote.kind === MOTE_ZED) {
      // Three strokes, leaning a little; it is larger the longer it has risen.
      const half = r * (0.55 + 0.6 * (mote.age / mote.life));
      const lean = mote.seed;
      const ax = Math.cos(lean) * half;
      const ay = Math.sin(lean) * half;
      context.moveTo(x - ax + ay, y - ay - ax);
      context.lineTo(x + ax + ay, y + ay - ax);
      context.lineTo(x - ax - ay, y - ay + ax);
      context.lineTo(x + ax - ay, y + ay + ax);
      context.strokeStyle = MOTE_COOL;
      context.lineWidth = Math.max(1, half * 0.42);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.stroke();
      continue;
    }
    if (mote.kind === MOTE_HEART && r >= 1.4) {
      // Two lobes over a point.
      context.moveTo(x, y + r * 0.95);
      context.bezierCurveTo(x - r * 1.6, y - r * 0.1, x - r * 0.8, y - r * 1.25, x, y - r * 0.4);
      context.bezierCurveTo(x + r * 0.8, y - r * 1.25, x + r * 1.6, y - r * 0.1, x, y + r * 0.95);
      context.fill();
      continue;
    }
    if (r < 1.4) {
      context.arc(x, y, Math.max(0.7, r * 0.7), 0, Math.PI * 2);
    } else {
      // Four points, the sides between them drawn in towards the middle.
      const turn = mote.seed + mote.age * 0.9;
      const waist = r * 0.16;
      context.moveTo(x + Math.cos(turn) * r, y + Math.sin(turn) * r);
      for (let k = 1; k <= 4; k += 1) {
        const tip = turn + (k * Math.PI) / 2;
        const dip = tip - Math.PI / 4;
        context.quadraticCurveTo(x + Math.cos(dip) * waist, y + Math.sin(dip) * waist, x + Math.cos(tip) * r, y + Math.sin(tip) * r);
      }
    }
    context.fill();
  }
  context.globalAlpha = 1;
}

function tick(now: number): void {
  frame = 0;
  ensureStageListeners();
  if (reducedMotionActive) {
    for (const actor of actors) actor.options.rest?.();
    last = 0;
    return;
  }
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    last = 0;
    return;
  }
  const dt = last ? Math.min((now - last) / 1000, MOST_FRAME) : 0;
  last = now;
  let live = false;
  for (const actor of actors) {
    if (!actor.shown || actor.options.manual) continue;
    live = true;
    if (dt > 0) actor.advance(dt);
  }
  if (live && !stage?.lost) frame = requestAnimationFrame(tick);
  else last = 0;
}

function wake(): void {
  ensureStageListeners();
  if (reducedMotionActive || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
  if (!frame) frame = requestAnimationFrame(tick);
}

function fit(actor: Actor, size: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, MOST_DPR);
  const pixels = Math.max(16, Math.round(size * OVERSCAN * dpr));
  actor.size = size;
  actor.form = formFor(size);
  actor.blush = Math.min(1, Math.max(0, (size - BLUSH_FROM) / (BLUSH_FULL - BLUSH_FROM)));
  actor.starry = Math.min(1, Math.max(0, (size - STARS_FROM) / (STARS_FULL - STARS_FROM)));
  actor.unit = pixels / (2 * OVERSCAN);
  actor.flight.sparkle = size >= MOTES_FROM;
  resizeFlight(actor.flight, sizeGain(size));
  if (pixels === actor.pixels) return;
  actor.pixels = pixels;
  actor.options.canvas.width = pixels;
  actor.options.canvas.height = pixels;
}

const bodies = new Map<number, BufferGeometry>();

/** The body's geometry at a fineness, made once and shared by every mascot drawn at it. */
function bodyGeometry(rings: number): BufferGeometry {
  let geometry = bodies.get(rings);
  if (!geometry) {
    const body = bodyFor(rings);
    geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(body.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(body.normals, 3));
    geometry.setAttribute('wisp', new BufferAttribute(body.wisp, 1));
    geometry.setAttribute('limb', new BufferAttribute(body.limb, 1));
    geometry.setIndex(new BufferAttribute(body.triangles, 1));
    bodies.set(rings, geometry);
  }
  return geometry;
}

/** Puts a mascot on the stage, or returns null where WebGL is not to be had. */
export function createActor(options: ActorOptions): StageActor | null {
  const context = options.canvas.getContext('2d');
  if (!context) return null;
  try {
    stage ??= openStage();
  } catch {
    return null;
  }
  const sheet = sheetFor(spacingFor(options.size));
  const flight = createFlight(sheet, sizeGain(options.size), options.small);
  if (options.appear) arriveFlight(flight);
  const skin = skinFor(sheet);
  const positions = new Float32Array(3 * skin.count);
  const normals = new Float32Array(3 * skin.count);
  const geometry = new BufferGeometry();
  const position = new BufferAttribute(positions, 3);
  const normal = new BufferAttribute(normals, 3);
  position.setUsage(DynamicDrawUsage);
  normal.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  // How far down the skirt each vertex is: the lining is deeper up under the head.
  geometry.setAttribute('fall', new BufferAttribute(skin.fall, 1));
  // Where each vertex lies at ease: the stars in the cloth are set by it.
  geometry.setAttribute('home', new BufferAttribute(skin.home, 3));
  geometry.setIndex(new BufferAttribute(skin.triangles, 1));
  const body = bodyGeometry(options.size >= 56 ? BODY_RINGS : BODY_RINGS_SMALL);

  const actor: Actor = {
    options,
    flight,
    geometry,
    skin,
    positions,
    normals,
    body,
    context,
    pixels: 0,
    size: options.size,
    shown: false,
    gone: false,
    input: { lookX: 0, lookY: 0, look: 0, gustX: 0, gustY: 0, near: 0, atX: 0, atY: 0 },
    eyeA: new Vector4(),
    eyeB: new Vector4(),
    cheekA: new Vector4(),
    cheekB: new Vector4(),
    blush: 0,
    starry: 0,
    orb: new Vector3(),
    glow: 0,
    flare: 0,
    form: 1,
    unit: 1,
    resize(size) {
      if (!actor.gone && size > 0) fit(actor, size);
    },
    show(on) {
      if (actor.gone || actor.shown === on) return;
      actor.shown = on;
      if (on) wake();
    },
    advance(dt) {
      if (actor.gone) return;
      options.read?.(dt, actor.input);
      stepFlight(flight, dt, options.mood(), actor.input);
      draw(actor);
    },
    dispose() {
      actor.gone = true;
      actor.shown = false;
      actors.delete(actor);
      geometry.dispose();
    },
  };
  fit(actor, options.size);
  actors.add(actor);
  // The first picture is there before anyone looks: an entrance starts off-pose and must not be seen jumping to it.
  stepFlight(flight, 0, options.mood(), actor.input);
  draw(actor);
  return actor;
}
