// SPDX-License-Identifier: AGPL-3.0-only
// How the mascot lives. It is a small spirit wearing a square of magic cloth, and it is never quite still.
//
// THE BODY is a place, a turn and a pose. It hangs in the air breathing: each breath lifts it quickly and lets it sink
// slowly, and because its skirt closes as it rises and spreads as it sinks, it moves the way a jellyfish does. It
// wanders, turns its head to whatever it watches, and has a few things it does for no reason: it raises its hand under
// the cloth and waves, flicks its tail, tilts its head to peer at something, hops, or gives itself a shake. At ease it
// faces the viewer squarely and stands upright: its tail hangs behind it and sways to either side below it.
// Pleased, it crouches and springs up with its eyes shut in a smile; asked to, it goes head over heels.
//
// IT PERFORMS, too, one thing at a time and for no one: it turns right round where it stands with its skirt and its
// hands thrown out, bats at the light on its hat as a cat does at a thing on a string and watches it swing, rocks
// from side to side in a little dance, sneezes, yawns and stretches. Left alone long enough it yawns and nods off,
// its head sunk and a z or two rising from it; a nap ends by itself in a stretch, or at once when someone comes.
// Stroked, it shuts its eyes, flushes and gives off hearts. At work it dips its head at the end of each line it
// reads, and when it stops to think it puts its hand to its cheek until the idea comes, which lights its lamp.
//
// THE CLOTH is not moved by any of this directly. It hangs from the head (mascot-cloth.ts), so every move of the body
// reaches the hem and the tail late and leaves them trailing, and that lateness is what reads as soft. Air keeps it
// alive between moves: slow waves running round the hem and along the tail, pockets of air that cross it now and then,
// and whatever the pointer stirs up as it passes.
//
// THE MAGIC is what leaks out of it: motes of light that rise off the hem, burst from it when it is pleased and circle
// it while it works. The light at the end of its hat flares when something comes of what it does, and now and then
// the stars in its cloth run with light from one side to the other. Everything quick is in the eyes (mascot-gaze.ts);
// the rest of its face is here: its lids, its mouth and its flush. Pure numbers, so it can be stepped without a page.
import { createCloth, fitCloth, setHold, settleCloth, stepCloth, type Cloth } from './mascot-cloth';
import { BLINK_SLOW, BLINK_TWO, blink, createGaze, saccade, stepGaze, widen, type Gaze, type GazeInput } from './mascot-gaze';
import { BODY, FACE, HEAD, ORB, POSE_AT_EASE, poseSheet, type Sheet, type SheetPose } from './mascot-sheet';

export type FlightMood = 'idle' | 'working';

/** How it carries itself per mood. Speeds are body widths per second: the mascot's box is two wide. */
interface Air {
  /** Seconds one breath takes, and how far it lifts the body. */
  breath: number;
  bob: number;
  /** The air's three wave trains: round the hem, down the skirt, and along the tail. */
  waves: readonly [number, number, number];
  /** How fast each runs, turns per second. */
  pace: readonly [number, number, number];
  /** Pockets of air per second, and how hard they press. */
  gusts: number;
  push: number;
  /** How far the body wanders, as a share of its idle wander. */
  wander: number;
  /** A steady lean into its work, radians: head down, as if reading. */
  lean: number;
  /** The tail's wag: how far, radians, and how fast, turns per second. */
  wag: number;
  wagPace: number;
  /** How far the hand is lifted at ease; and, at work, lifts of it per second and the shortest wait between two. */
  hand: number;
  beats: number;
  beatGap: number;
  /** Things done for no reason per second, and the shortest wait between two. */
  whims: number;
  whimGap: number;
  /** Motes that rise off the hem per second. */
  motes: number;
}

const AIR: Record<FlightMood, Air> = {
  idle: { breath: 3.1, bob: 0.052, waves: [0.14, 0.14, 0.3], pace: [0.16, 0.22, 0.3], gusts: 0.2, push: 0.5, wander: 1, lean: 0, wag: 0.3, wagPace: 0.3, hand: 0.02, beats: 0, beatGap: 0, whims: 0.26, whimGap: 2.8, motes: 0.7 },
  working: { breath: 2.2, bob: 0.03, waves: [0.2, 0.2, 0.42], pace: [0.3, 0.42, 0.62], gusts: 0.3, push: 0.45, wander: 0.6, lean: 0.06, wag: 0.36, wagPace: 0.66, hand: 0.04, beats: 0.5, beatGap: 2.2, whims: 0, whimGap: 0, motes: 1.4 },
};

/** How the three wave trains lie on the cloth: waves round the hem, and half-waves down the skirt and along the tail. */
const WAVE_COUNT = [3, 1.6, 2.2] as const;
/** Seconds a wave train takes to swell or fade. */
const WAVE_TIME = 5;
/** Pockets of air at once. */
const GUSTS = 4;

/** The body's wander: reach in body widths and radians, and the seconds it takes to change its mind. */
const DRIFT = [0.05, 0.03, 0.05, 0.06, 0.08, 0.06] as const;
const DRIFT_TIME = 3.2;
/** The share of a breath spent rising: the rest is the slow sink. */
const BREATH_RISE = 0.32;
/** How far it turns to face what it is watching, radians: up and down, and side to side. Only a little: it keeps its
 *  face to the viewer and its eyes do the looking. Turned further, the eyes are carried to the edge of the head. */
const LOOK_PITCH = 0.07;
const LOOK_YAW = 0.12;
/** It is never upright for long: it sways from side to side as a thing afloat does, leaning the way it is going.
 *  How far to either side, body widths; how far it leans, radians; and the seconds one sway takes. */
const SWAY_REACH = 0.045;
const SWAY_LEAN = 0.085;
const SWAY_SECONDS = 5.4;
/** Watching something to one side it tilts its head that way and leans towards it: radians, and body widths. */
const LOOK_TILT = 0.11;
const LOOK_LEAN = 0.035;
/** How far the tail swings to one side or the other while it idles, radians: far enough to be seen past the body. */
const SWISH_IDLE = 0.38;
/** A swing of the tail faster than this, radians per second, shakes a mote off its tip. */
const SWISH_SHEDS = 1.3;
/** How far it leans into a move sideways, radians per body width per second, and the most it leans. */
const LEAN_BY_SPEED = 0.5;
const LEAN_MOST = 0.16;

/** The skirt closes as the body rises and spreads as it sinks: by this much per body width per second. */
const OPEN_BY_RISE = 3.2;
const OPEN_LEAST = -0.38;
const OPEN_MOST = 0.62;
/** Rising it draws itself up, sinking it settles: its stretch per body width per second, its limits, and the spring
 *  it follows, which is loose enough to wobble. */
const STRETCH_BY_RISE = 0.24;
const STRETCH_LEAST = -0.09;
const STRETCH_MOST = 0.13;
const STRETCH_RATE = 15;
const STRETCH_DAMP = 0.36;

/** Height a lift carries it to, the most a run of them can, and the speed it settles at. */
const PULSE_LIFT = 0.17;
const LIFT_TOP = 0.3;
const SETTLE = 0.055;
/** Before it springs up it crouches: for this long, and this squat. */
const CROUCH_SECONDS = 0.11;
const CROUCH = 0.13;
/** Seconds its eyes stay shut in a smile after it is lifted. */
const JOY_SECONDS = 0.85;
/** Seconds a turn head over heels takes, the wind-up before it, how far below the middle of the head it turns about,
 *  and how much firmer the cloth keeps its shape at the height of one. */
const ROLL_SECONDS = 1.7;
const ROLL_DELAY = 0.12;
const ROLL_ABOUT = -0.25;
const ROLL_FIRM = 11;
/** A shake: seconds it lasts, how far it turns to either side, radians, and how many times a second. */
const SHAKE_SECONDS = 0.85;
const SHAKE_TURN = 0.26;
const SHAKE_PACE = 3.4;
/** How far below its place an entrance starts, body widths. */
const ENTER_FROM = 0.55;
/** Seconds the first frame takes to ease into the float. */
const WAKE_SECONDS = 1.2;
/** The hand: the rate it follows what is asked of it, per second; a lift's seconds up, held and down; and a wave's
 *  seconds per waggle and how far each one dips. */
const HAND_RATE = 10;
const BEAT_UP = 0.24;
const BEAT_HOLD = 0.2;
const BEAT_DOWN = 0.62;
const WAGGLE_SECONDS = 0.36;
const WAGGLE = 0.34;
/** Seconds a peer to one side lasts, and how far the head tilts and turns for it, radians. */
const PEEK_SECONDS = 1.9;
const PEEK_TILT = 0.14;
const PEEK_TURN = 0.16;
/** The tail's swing to and fro: its spring, and how hard a flick kicks it. */
const SWISH_RATE = 7;
const SWISH_DAMP = 0.26;
const FLICK = 4.5;
/** Seconds between waves at a pointer that keeps coming back. */
const GREET_GAP = 9;
/** Left alone it grows quiet: full life for this many seconds, then this long to reach the calm it stays at. */
const QUIET_FROM = 45;
const QUIET_OVER = 120;
const QUIET_PACE = 0.3;
const QUIET_REACH = 0.62;
/** Clicks in quick succession that earn a turn right round, and a turn head over heels. */
const CLICK_GAP = 0.8;
const CLICK_TWIRL = 2;
const CLICK_ROLL = 3;
/** Pointer speed across the body, box widths per second, that catches its eye. */
const STARTLE_SPEED = 2.2;
/** How far the cloth stays off the body under it, in half box widths. */
const BODY_ROOM = 0.04;
/** The cloth's own weight: a faint pull, so its skirt hangs and swings when the body turns. */
const WEIGHT = 0.3;

/** A turn right round where it stands: seconds it takes, how far it throws the skirt out and the hands up, and the
 *  seconds it is pleased with itself afterwards. */
const TWIRL_SECONDS = 1.05;
const TWIRL_FLING = 0.3;
const TWIRL_ARMS = 0.45;
const TWIRL_PROUD = 0.45;
/** A nod: seconds each one takes, and how far the head dips, radians. */
const NOD_SECONDS = 0.34;
const NOD_DIP = 0.2;
/** A sneeze. It draws breath for this long, leaning back this far, radians; then it is thrown forward this far, and
 *  takes this long to come up again. */
const SNEEZE_DRAW = 0.85;
const SNEEZE_BACK = 0.17;
const SNEEZE_THROW = 0.3;
const SNEEZE_AFTER = 0.95;
/** A yawn: seconds its mouth takes to open, stays open and takes to close; how far it leans back and draws itself up
 *  for it; and how high its hands go as it stretches. */
const YAWN_OPEN = 0.55;
const YAWN_HOLD = 0.85;
const YAWN_CLOSE = 0.7;
const YAWN_BACK = 0.12;
const YAWN_TALL = 0.1;
const YAWN_ARMS = 0.8;
/** The hat's hanging end swings about the hat's fold on a spring of its own, loose enough to ring on after a knock:
 *  the spring, how far the end may go back up and further over, radians, and how far it droops on a sleeper. It may
 *  not go far over: it hangs just clear of the hat, and swung further it comes down on it. */
const TIP_RATE = 6.5;
const TIP_DAMP = 0.15;
const TIP_BACK = -0.75;
const TIP_OVER = 0.28;
const TIP_DROOP = 0.22;
/** At either end of its swing it is turned back with this share of the speed it came with: it is cloth meeting
 *  cloth, and gives; it does not stop dead and it does not bounce. */
const TIP_GIVE = 0.3;
/** It hangs from the hat, so it trails behind the body's own moves: further over as the body rises under it, back up
 *  as the body sinks or goes the way the tip falls. Radians for each body width a second, and the most it trails. */
const TIP_BY_RISE = 0.8;
const TIP_BY_SLIDE = 0.6;
const TIP_TRAIL = 0.16;
/** The end of the tail is the last of it to hear of a swing: it is left behind by a swing that starts and carries on
 *  past one that stops, so a wave runs out along the tail and it never moves as one piece. How far its end curls
 *  against the swing, radians for each radian a second, and the most that asks of it; the spring it follows; and how
 *  far it may curl in the end, away from the hat and towards it: towards it only a little, where the hat is in its
 *  way. */
const CURL_LAG = 0.11;
const CURL_MOST = 0.5;
const CURL_RATE = 11;
const CURL_DAMP = 0.26;
const CURL_OUT = -0.7;
const CURL_IN = 0.35;
/** The orb hangs from the end of the tail as a weight on a thread does, though the thread is no longer than the orb:
 *  it has its own way in the air, so it is left behind when the tail's end moves off, swings past when the end
 *  stops, and settles after a few swings. It hangs the way the tail is going at its end, drawn down from that by
 *  its weight, `ORB_WEIGHT` against the tail's 1; the spring that brings it there; how far out of that line it may
 *  swing, as a cosine, so that it never folds back on the tail; the room it keeps from the middle of the head, in
 *  its own radii beyond the head's, so that it rides round the hat and does not sink into it; and the longest step
 *  it is moved by, seconds. */
const ORB_WEIGHT = 0.6;
const ORB_RATE = 17;
const ORB_DAMP = 0.28;
const ORB_SWING = Math.cos(0.9);
const ORB_ROOM = 0.8;
const ORB_STEP = 1 / 90;
/** The hat is soft and roomy. A head that rises leaves it behind a little, and it sinks on the head and fills out; a
 *  head that drops lets it lift. How far it sinks for each body width a second, the most it does, and the spring it
 *  follows, loose enough that it settles with a wobble. */
const SAG_BY_RISE = 0.4;
const SAG_MOST = 0.1;
const SAG_RATE = 9;
const SAG_DAMP = 0.3;
/** Batting at the light on its hat: seconds it looks up at it first, seconds more until its hand is up, how hard the
 *  hat's tip is then knocked, radians per second, how far it leans its head to the light, radians, and the seconds
 *  it watches the light swing. */
const BAT_LOOK = 0.32;
const BAT_REACH = 0.26;
const BAT_KNOCK = 4.4;
const BAT_TILT = 0.09;
const BAT_WATCH = 1.6;
/** A dance: seconds a beat takes; how many times it rocks to one side and back to the other; and how far each rock
 *  tilts it, radians, carries it aside and lifts it, body widths, and raises the hand on that side. */
const DANCE_BEAT = 0.4;
const DANCE_ROCKS = 3;
const DANCE_TILT = 0.2;
const DANCE_STEP = 0.06;
const DANCE_HOP = 0.045;
const DANCE_ARMS = 0.85;
/** Stopping to think, at work: seconds it lasts, how far its head tilts, radians, and how high its hand comes: to
 *  its cheek. */
const MUSE_SECONDS = 1.25;
const MUSE_TILT = 0.1;
const MUSE_HAND = 0.5;
/** At the end of a line it reads its head dips: this kick to its nod, radians per second. */
const LINE_DIP = 0.5;
/** Sleep. Alone for this many seconds it may yawn and nod off, with this chance per second; a nap lasts between
 *  these; asleep its head sinks and tilts this far, radians, and it gives off a z this often, seconds. */
const DOZE_FROM = 95;
const DOZE_ODDS = 0.2;
const NAP_LEAST = 24;
const NAP_MOST = 40;
const DOZE_NOD = 0.2;
const DOZE_TILT = 0.09;
const ZED_GAP = 1.5;
/** Stroking: the pointer has to be this near and going at least this fast across it, box widths per second; this
 *  many seconds of it and the mascot gives itself up to it; it remembers no more than this many; and a heart comes
 *  off it this often, seconds. */
const PET_NEAR = 0.3;
const PET_SLOW = 0.12;
const PET_AFTER = 0.45;
const PET_MOST = 1;
const HEART_GAP = 0.34;
/** How far its mouth comes open when something makes it jump, 0 to 1, and for how long. */
const GASP = 0.42;
const GASP_SECONDS = 0.4;
/** Seconds the light on its hat takes to flare, and the stars in its cloth take to run with light from side to side. */
const FLASH_SECONDS = 0.35;
const SHIMMER_SECONDS = 0.9;

/** Motes alive at once, how fast those that circle it at work go round, turns per second, and how far out. */
const MOTES = 16;
const ORBITERS = 2;
const ORBIT_PACE = 0.42;
const ORBIT_REACH = 0.95;

/** What a mote is drawn as: a four-pointed spark, a heart, or the z of a sleeper. */
export const MOTE_SPARK = 0;
export const MOTE_HEART = 1;
export const MOTE_ZED = 2;

/** The things it does for no reason, by name. */
export type Whim = 'wave' | 'flick' | 'peek' | 'hop' | 'shake' | 'bat' | 'twirl' | 'dance' | 'shimmer' | 'sneeze' | 'yawn';

/** How often each comes up, against the others. */
const WHIM_ODDS: readonly (readonly [Whim, number])[] = [
  ['wave', 16],
  ['peek', 14],
  ['flick', 12],
  ['bat', 12],
  ['hop', 9],
  ['twirl', 8],
  ['dance', 8],
  ['shimmer', 8],
  ['shake', 6],
  ['sneeze', 4],
  ['yawn', 3],
];

/** A performance: something that takes its whole face and body for a while. It gives one at a time. */
type Act = '' | 'sneeze' | 'yawn' | 'bat' | 'dance' | 'muse';

/** What a performance asks of the body this frame, on top of everything else it is doing. */
interface Asked {
  /** Quick moves, added where the shake is: a nod forwards and a tilt to its right, radians; a step aside and up. */
  nod: number;
  tilt: number;
  aside: number;
  up: number;
  /** The face, each 0 to 1: the lids lowered, the mouth open round, a deeper flush. */
  lid: number;
  gape: number;
  flush: number;
  /** The hands, 0 down to 1 right up; below nothing, a hand is left to whatever else moves it. */
  right: number;
  left: number;
  /** Taller above nothing, squatter below. */
  tall: number;
}

const ASKED: Asked = { nod: 0, tilt: 0, aside: 0, up: 0, lid: 0, gape: 0, flush: 0, right: -1, left: -1, tall: 0 };

export interface FlightInput extends GazeInput {
  /** Air pushed across the body by the pointer this frame, box widths per second. */
  gustX: number;
  gustY: number;
  /** 0 far away, 1 close: a nearby, slow pointer holds its attention. */
  near: number;
  /** Where the pointer is, in half box widths from the centre of the box, y up. */
  atX: number;
  atY: number;
}

interface Gust {
  /** Seconds in, and seconds it lasts: spent when the first reaches the second. */
  age: number;
  life: number;
  /** Where it starts and ends, in the box. */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  width: number;
  /** The air's velocity at its middle. */
  pushX: number;
  pushY: number;
  pushZ: number;
}

/** A mote of light. The stage draws those whose `glow` is above nothing. */
export interface Mote {
  /** Seconds lived, and seconds it lives: spent when the first reaches the second. */
  age: number;
  life: number;
  /** Where it is in the box, and how fast it is going. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** How large, half box widths from its middle to a point, and how bright just now, 0 to 1. */
  size: number;
  glow: number;
  /** Coral, the colour of the cloth's inside; otherwise the blue of its outside. */
  warm: boolean;
  /** What it is drawn as: `MOTE_SPARK`, `MOTE_HEART` or `MOTE_ZED`. */
  kind: number;
  /** Where in its twinkle it began, and how far it is turned, radians. */
  seed: number;
  /** Circling the body rather than drifting: the angle it is at, radians, or below nothing. */
  orbit: number;
}

export interface Flight {
  random: () => number;
  sheet: Sheet;
  cloth: Cloth;
  gaze: Gaze;
  gain: number;
  small: boolean;
  /** Whether it sheds motes: the stage turns them off where they would be smaller than a pixel. */
  sparkle: boolean;
  mood: FlightMood;
  clock: number;
  wake: number;
  awake: number;
  /** The wander: x, y, z, pitch, yaw, roll. Each is noise, then the same noise twice smoothed. */
  drift: Float64Array;
  driftNear: Float64Array;
  driftNow: Float64Array;
  /** Where the body is and how it is turned, and how fast each of those is changing. */
  place: Float64Array;
  placeSpeed: Float64Array;
  /** Its breathing, in breaths. */
  breath: number;
  /** How fast the head is moving, smoothed, and where it was a frame ago. */
  velX: number;
  velY: number;
  lastX: number;
  lastY: number;
  /** Height: where it is making for, the lag on the way, how long it holds. */
  airGoal: number;
  airNear: number;
  air: number;
  hover: number;
  /** A crouch before a spring, seconds left of it, and the lift it is owed at the end. */
  crouch: number;
  owed: number;
  /** A turn head over heels, 0 to 1, and the wait before one. */
  roll: number;
  rollWaiting: number;
  /** A shake: seconds in, negative when there is none. */
  shake: number;
  /** A turn right round where it stands, 0 to 1, and which way it goes. */
  spin: number;
  spinWay: number;
  /** Nods: seconds in, negative when there are none, and how many. */
  nod: number;
  nods: number;
  /** The quick moves of this frame, added where the body is placed: a nod, a turn and a tilt, radians, and a step
   *  aside and up. */
  quick: Float64Array;
  /** The performance it is giving, how many seconds into it, how many of its stages are behind it, and which side
   *  it favours. */
  act: Act;
  actAge: number;
  actStep: number;
  actSide: number;
  /** The yawn it is giving ends in a nap. */
  sleepy: boolean;
  /** Seconds of nap left; how far asleep it is, 0 to 1; the side its head has sunk to; and the time since its last z. */
  nap: number;
  doze: number;
  napSide: number;
  sinceZed: number;
  /** Seconds of stroking it remembers, and the time since its last heart. */
  petted: number;
  sinceHeart: number;
  /** Its face, each 0 to 1: lids lowered, mouth open round, a deeper flush. And seconds left of a gasp. */
  lid: number;
  gape: number;
  flush: number;
  gasp: number;
  /** How far its left hand is raised, 0 to 1: the right one is in the pose, for it lifts the cloth. */
  left: number;
  /** The light on its hat: how far it has flared, 0 to 1, and the seconds it has left to stay so. */
  flare: number;
  flash: number;
  /** A run of light through the stars in its cloth, 0 at one side to 1 at the other, negative when there is none. */
  shimmer: number;
  lastWhim: Whim | '';
  firm: number;
  /** An entrance, 1 far off to 0 arrived. */
  enter: number;
  /** The body's shape just now. */
  pose: SheetPose;
  stretchSpeed: number;
  /** How fast the hat is sinking on the head or lifting off it, as a share of its height per second. */
  sagSpeed: number;
  /** How fast the end of the hat's tail is curling. */
  curlSpeed: number;
  /** The orb at the end of the hat's tail: where its middle is, in the cloth's own space, and how fast it is going. */
  orb: Float64Array;
  orbSpeed: Float64Array;
  /** How fast the hat's hanging end is swinging about the fold, radians per second. */
  tipSpeed: number;
  /** The hand: how fast its lift is changing; a lift of it, seconds in or negative when there is none, how far it
   *  goes and how many waggles it holds for; and the time since the last. */
  handSpeed: number;
  handNoise: number;
  beat: number;
  beatTop: number;
  beatWaves: number;
  sinceBeat: number;
  /** A peer to one side: seconds in, negative when there is none, and which side. */
  peek: number;
  peekSide: number;
  /** Where in its sway it began, radians. */
  swayFrom: number;
  /** The tail: where its wag is, and its swing's noise and speed. */
  wagPhase: number;
  swishNoise: number;
  swishSpeed: number;
  sinceWhim: number;
  sinceGreet: number;
  /** Its eyes shut in a smile: how far, 0 to 1, and the seconds it has left to stay so. */
  joy: number;
  joyHold: number;
  wavePhase: Float64Array;
  waveNoise: Float64Array;
  waveLevel: Float64Array;
  gusts: Gust[];
  sinceGust: number;
  motes: Mote[];
  /** The pointer's air, eased: a pointer can jump, the air cannot. */
  stirX: number;
  stirY: number;
  stirAtX: number;
  stirAtY: number;
  attention: number;
  startled: number;
  clickAt: number;
  clicks: number;
  blinkAt: number;
  /** Per vertex: how freely the air may move it. */
  free: Float32Array;
  /** The body's turn as a matrix, and where the middle of its head lands. */
  turn: Float64Array;
  origin: Float64Array;
  /** For the ground shadow: how far it has moved sideways, and how high it is, body widths. */
  drawX: number;
  drawY: number;
}

function lag(value: number, goal: number, seconds: number, dt: number): number {
  return goal + (value - goal) * Math.exp(-dt / seconds);
}

function between(low: number, high: number, t: number): number {
  return low + (high - low) * t;
}

function clamp(low: number, high: number, v: number): number {
  return v < low ? low : v > high ? high : v;
}

function smoothstep(w: number): number {
  const t = w <= 0 ? 0 : w >= 1 ? 1 : w;
  return t * t * (3 - 2 * t);
}

/** A small mascot's lifts take a third of its size gain: at full gain a large one leaves its row. */
function liftGain(gain: number): number {
  return 1 + (gain - 1) * 0.35;
}

function newGust(): Gust {
  return { age: 0, life: 0, fromX: 0, fromY: 0, toX: 0, toY: 0, width: 0.3, pushX: 0, pushY: 0, pushZ: 0 };
}

function newMote(): Mote {
  return { age: 0, life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0, glow: 0, warm: true, kind: MOTE_SPARK, seed: 0, orbit: -1 };
}

export function createFlight(sheet: Sheet, gain: number, small: boolean, random: () => number = Math.random): Flight {
  const cloth = createCloth(sheet);
  cloth.gravity = [0, -WEIGHT, 0];
  const n = sheet.count;
  const free = new Float32Array(n);
  for (let v = 0; v < n; v += 1) free[v] = 1 - sheet.hold[v]!;
  const flight: Flight = {
    random,
    sheet,
    cloth,
    gaze: createGaze(random, small),
    gain,
    small,
    sparkle: !small,
    mood: 'idle',
    clock: 0,
    wake: 0,
    awake: 0,
    drift: new Float64Array(6),
    driftNear: new Float64Array(6),
    driftNow: new Float64Array(6),
    place: new Float64Array(6),
    placeSpeed: new Float64Array(6),
    breath: random(),
    velX: 0,
    velY: 0,
    lastX: 0,
    lastY: 0,
    airGoal: 0,
    airNear: 0,
    air: 0,
    hover: 0,
    crouch: 0,
    owed: 0,
    roll: 0,
    rollWaiting: -1,
    shake: -1,
    spin: 0,
    spinWay: 1,
    nod: -1,
    nods: 1,
    quick: new Float64Array(5),
    act: '',
    actAge: 0,
    actStep: 0,
    actSide: 1,
    sleepy: false,
    nap: 0,
    doze: 0,
    napSide: 1,
    sinceZed: 0,
    petted: 0,
    sinceHeart: 0,
    lid: 0,
    gape: 0,
    flush: 0,
    gasp: 0,
    left: 0,
    flare: 0,
    flash: 0,
    shimmer: -1,
    lastWhim: '',
    firm: 1,
    enter: 0,
    pose: { ...POSE_AT_EASE },
    stretchSpeed: 0,
    sagSpeed: 0,
    curlSpeed: 0,
    orb: new Float64Array(3),
    orbSpeed: new Float64Array(3),
    tipSpeed: 0,
    handSpeed: 0,
    handNoise: random() - 0.5,
    beat: -1,
    beatTop: 1,
    beatWaves: 0,
    sinceBeat: random() * 2,
    peek: -1,
    peekSide: 1,
    swayFrom: random() * 6.283,
    wagPhase: random() * 6.283,
    swishNoise: random() - 0.5,
    swishSpeed: 0,
    sinceWhim: random() * 3,
    sinceGreet: GREET_GAP,
    joy: 0,
    joyHold: 0,
    wavePhase: Float64Array.from([random() * 6.283, random() * 6.283, random() * 6.283]),
    waveNoise: Float64Array.from([random() - 0.5, random() - 0.5, random() - 0.5]),
    waveLevel: Float64Array.from([0.6, 0.6, 0.6]),
    gusts: Array.from({ length: GUSTS }, newGust),
    sinceGust: 0,
    motes: Array.from({ length: MOTES }, newMote),
    stirX: 0,
    stirY: 0,
    stirAtX: 0,
    stirAtY: 0,
    attention: 0,
    startled: 0,
    clickAt: -10,
    clicks: 0,
    blinkAt: Infinity,
    free,
    turn: new Float64Array(9),
    origin: new Float64Array(3),
    drawX: 0,
    drawY: 0,
  };
  place(flight);
  settleCloth(cloth);
  settleOrb(flight);
  return flight;
}

/** Something has its attention: it is not left alone any more. Asleep, it wakes: with a start when what woke it is
 *  `sharp`, and otherwise as one does who was only dozing. */
function rouse(f: Flight, sharp = true): void {
  f.awake = 0;
  f.sleepy = false;
  if (f.nap <= 0) return;
  f.nap = 0;
  saccade(f.gaze, 0, 0);
  f.blinkAt = f.clock + 0.55;
  if (!sharp) return;
  f.doze *= 0.3;
  f.gasp = GASP_SECONDS;
  f.stretchSpeed += 1.6;
  f.tipSpeed -= 2.4;
  widen(f.gaze, 1.25);
}

/** Starts a performance: whatever it was giving is dropped. */
function begin(f: Flight, act: Act): void {
  f.act = act;
  f.actAge = 0;
  f.actStep = 0;
  f.actSide = f.random() < 0.5 ? -1 : 1;
  f.sleepy = false;
}

/** Where the body would have every point of the cloth: its pose, turned and put in its place. */
function place(f: Flight): void {
  const cloth = f.cloth;
  poseSheet(f.sheet, f.pose, cloth.shape);
  fitCloth(cloth);
  const [x, y, z, pitch, yaw, roll] = f.place as unknown as number[];
  const lift = f.air;
  // An entrance comes up from below, leaning back a little: its skirt and its tail trail under it.
  const far = f.enter * f.enter;
  // A shake turns it quickly to one side and the other: faster than the body's own turns, so it is added here.
  const around = f.shake >= 0 ? SHAKE_TURN * Math.sin(Math.PI * 2 * SHAKE_PACE * f.shake) * Math.sin((Math.PI * f.shake) / SHAKE_SECONDS) : 0;
  // So are the quick moves of whatever it is performing: a nod, a turn right round, a tilt, a step aside and up.
  const quick = f.quick;
  const cp = Math.cos(pitch! + quick[0]! - far * 0.22);
  const sp = Math.sin(pitch! + quick[0]! - far * 0.22);
  const cy = Math.cos(yaw! + around + quick[1]!);
  const sy = Math.sin(yaw! + around + quick[1]!);
  const cr = Math.cos(roll! - quick[2]! - far * 0.12);
  const sr = Math.sin(roll! - quick[2]! - far * 0.12);
  // The tilt about the view, then the turn to the side, then the nod: Rz * Ry * Rx.
  const o00 = cr * cy;
  const o01 = cr * sy * sp - sr * cp;
  const o02 = cr * sy * cp + sr * sp;
  const o10 = sr * cy;
  const o11 = sr * sy * sp + cr * cp;
  const o12 = sr * sy * cp - cr * sp;
  const o20 = -sy;
  const o21 = cy * sp;
  const o22 = cy * cp;
  // Head over heels: a turn backwards about the body's own side-to-side line, so its inside comes round first.
  const angle = f.roll > 0 ? -Math.PI * 2 * smoothstep(smoothstep(f.roll)) : 0;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const m = f.turn;
  m[0] = o00;
  m[1] = o01 * c + o02 * s;
  m[2] = o02 * c - o01 * s;
  m[3] = o10;
  m[4] = o11 * c + o12 * s;
  m[5] = o12 * c - o11 * s;
  m[6] = o20;
  m[7] = o21 * c + o22 * s;
  m[8] = o22 * c - o21 * s;
  // It goes over about a point in its middle, not about its head: the head swings round that.
  const py = ROLL_ABOUT;
  const ox = HEAD.x + x! + quick[3]! - far * 0.06 + (o01 - m[1]!) * py;
  const oy = HEAD.y + y! + quick[4]! + lift - far * ENTER_FROM + (o11 - m[4]!) * py;
  const oz = z! + lift * 0.2 + (o21 - m[7]!) * py;
  f.origin[0] = ox;
  f.origin[1] = oy;
  f.origin[2] = oz;
  const spine = cloth.spine;
  spine[0] = ox;
  spine[1] = oy;
  spine[2] = oz;
  spine[3] = m[1]!;
  spine[4] = m[4]!;
  spine[5] = m[7]!;
  // The body under the cloth, where it is now: below the middle of the head along the body's own line, and
  // stretched as the body is.
  const tall = 1 + f.pose.stretch;
  const down = -BODY.low * tall;
  const body = cloth.body;
  body[0] = ox + m[1]! * down;
  body[1] = oy + m[4]! * down;
  body[2] = oz + m[7]! * down;
  body[3] = BODY.radius / Math.sqrt(tall) + BODY_ROOM;
  const shape = cloth.shape;
  const target = cloth.target;
  for (let i = 0; i < shape.length; i += 3) {
    const rx = shape[i]!;
    const ry = shape[i + 1]!;
    const rz = shape[i + 2]!;
    target[i] = ox + m[0]! * rx + m[1]! * ry + m[2]! * rz;
    target[i + 1] = oy + m[3]! * rx + m[4]! * ry + m[5]! * rz;
    target[i + 2] = oz + m[6]! * rx + m[7]! * ry + m[8]! * rz;
  }
}

/** Starts a pocket of air, or does nothing when all of them are busy. */
function gust(f: Flight, g: Partial<Gust> & { life: number }): void {
  const free = f.gusts.find((x) => x.age >= x.life);
  if (!free) return;
  Object.assign(free, newGust(), g);
}

/** A pocket of air crosses the skirt from one side to the other, carrying the cloth with it. */
function crossing(f: Flight, c: Air, strength: number): void {
  const r = f.random;
  const way = r() < 0.5 ? 1 : -1;
  const height = HEAD.y + between(-0.9, -0.35, r());
  gust(f, {
    life: between(2, 3, r()),
    fromX: HEAD.x - way * 1.15,
    fromY: height,
    toX: HEAD.x + way * 1.15,
    toY: height + between(-0.1, 0.2, r()),
    width: between(0.28, 0.42, r()),
    pushX: way * c.push * strength,
    pushY: between(-0.1, 0.25, r()) * c.push * strength,
    pushZ: between(-0.5, 0.5, r()) * c.push * strength,
  });
}

/** Air comes up under the skirt and the tail, and lets go slowly: the hem lifts and shows its lining. */
function updraught(f: Flight, c: Air, strength: number): void {
  const r = f.random;
  const at = HEAD.x + between(-0.42, 0.42, r());
  gust(f, {
    life: between(2.2, 3.2, r()),
    fromX: at,
    fromY: HEAD.y - 1.2,
    toX: at + between(-0.1, 0.1, r()),
    toY: HEAD.y - 0.62,
    width: between(0.26, 0.36, r()),
    pushX: 0,
    pushY: c.push * 1.1 * strength,
    pushZ: between(0, 0.5, r()) * c.push * strength,
  });
}

function weather(f: Flight, c: Air, dt: number, pace: number, reach: number): void {
  f.sinceGust += dt;
  if (f.sinceGust < 1.1) return;
  const chance = (c.gusts + 0.012 * f.sinceGust * f.sinceGust) * pace * (1 - 0.4 * f.attention);
  if (f.random() >= chance * dt) return;
  // Heavy-tailed: mostly middling, sometimes large, and a long calm earns a larger one.
  const calm = f.sinceGust;
  const strength = Math.min(1.5, (0.6 * (1 + Math.min(0.5, calm * 0.05))) / Math.sqrt(Math.max(f.random(), 0.05)));
  f.sinceGust = 0;
  if (f.random() < 0.55) crossing(f, c, Math.max(0.5, strength) * reach);
  else updraught(f, c, Math.max(0.5, strength) * reach);
}

/** Works out the air at every point of the cloth: the wave trains, the pockets, and the pointer's passing. */
function blow(f: Flight, c: Air, dt: number, presence: number): void {
  const { free, cloth, sheet } = f;
  const { wind, pos, normal } = cloth;
  const { around, skirt, tail } = sheet;
  for (let k = 0; k < 3; k += 1) {
    f.waveNoise[k] = f.waveNoise[k]! - (f.waveNoise[k]! / WAVE_TIME) * dt + (f.random() - 0.5) * 2.4 * Math.sqrt(dt / WAVE_TIME);
    f.waveLevel[k] = lag(f.waveLevel[k]!, 0.62 + 0.75 * Math.tanh(f.waveNoise[k]! * 1.6), 1.2, dt);
    f.wavePhase[k] = f.wavePhase[k]! + c.pace[k]! * Math.PI * 2 * dt;
  }
  const scale = presence * f.gain;
  const a0 = c.waves[0] * f.waveLevel[0]! * scale;
  const a1 = c.waves[1] * f.waveLevel[1]! * scale;
  const a2 = c.waves[2] * f.waveLevel[2]! * scale;
  const k1 = WAVE_COUNT[1] * Math.PI;
  const k2 = WAVE_COUNT[2] * Math.PI;
  const p0 = f.wavePhase[0]!;
  const p1 = f.wavePhase[1]!;
  const p2 = f.wavePhase[2]!;

  for (const g of f.gusts) {
    if (g.age < g.life) g.age += dt;
  }
  // The pointer's air: it drags the cloth the way it travels, and presses it in where it passes.
  const stir = Math.hypot(f.stirX, f.stirY);
  for (let v = 0, i = 0; v < sheet.count; v += 1, i += 3) {
    const loose = free[v]!;
    if (loose <= 0) {
      wind[i] = 0;
      wind[i + 1] = 0;
      wind[i + 2] = 0;
      continue;
    }
    const s = skirt[v]!;
    // Through the cloth: it billows in and out as the waves pass.
    const through = (a0 * Math.sin(WAVE_COUNT[0] * around[v]! - p0) * s + a1 * Math.sin(k1 * s - p1) * s + a2 * tail[v]! * Math.sin(k2 * s - p2)) * loose;
    let wx = normal[i]! * through;
    let wy = normal[i + 1]! * through;
    let wz = normal[i + 2]! * through;
    for (const g of f.gusts) {
      if (g.age <= 0 || g.age >= g.life) continue;
      const u = g.age / g.life;
      const travel = 0.5 * (u + smoothstep(u));
      const dx = pos[i]! - (g.fromX + (g.toX - g.fromX) * travel);
      const dy = pos[i + 1]! - (g.fromY + (g.toY - g.fromY) * travel);
      const d = (dx * dx + dy * dy) / (g.width * g.width);
      if (d > 9) continue;
      const press = scale * smoothstep(u / 0.3) * smoothstep((1 - u) / 0.45) * Math.exp(-d) * loose;
      wx += g.pushX * press;
      wy += g.pushY * press;
      wz += g.pushZ * press;
    }
    if (stir > 0.01) {
      const dx = pos[i]! - f.stirAtX;
      const dy = pos[i + 1]! - f.stirAtY;
      const d = (dx * dx + dy * dy) / 0.2;
      if (d < 9) {
        const reach = Math.exp(-d) * loose;
        wx += f.stirX * 0.55 * reach;
        wy += f.stirY * 0.55 * reach;
        wz -= stir * 0.4 * reach;
      }
    }
    wind[i] = wx;
    wind[i + 1] = wy;
    wind[i + 2] = wz;
  }
}

/** A mote that has burnt out, to be lit again; or none, when all of them are alight. */
function spare(f: Flight): Mote | null {
  if (!f.sparkle) return null;
  for (const m of f.motes) if (m.age >= m.life) return m;
  return null;
}

/** A mote rises off the hem at one side of the body or the other, and drifts out from it: beside the body it is a
 *  spark in the air, where one that rose across its front would be a mark on its face. */
function shed(f: Flight): void {
  const m = spare(f);
  if (!m) return;
  const r = f.random;
  const { cols, domeRows, skirtRows, around } = f.sheet;
  const rows = domeRows + skirtRows;
  let c = Math.floor(r() * cols);
  for (let tries = 0; tries < 6 && Math.abs(Math.sin(around[1 + c * rows]!)) < 0.8; tries += 1) c = Math.floor(r() * cols);
  const v = 3 * (1 + c * rows + rows - 1);
  const pos = f.cloth.pos;
  const side = pos[v]! < f.origin[0]! ? -1 : 1;
  Object.assign(m, newMote(), {
    life: between(1.4, 2.3, r()),
    x: pos[v]! + side * between(0.02, 0.08, r()),
    y: pos[v + 1]! + between(-0.04, 0.04, r()),
    z: -0.05,
    vx: side * between(0.03, 0.12, r()),
    vy: between(0.04, 0.12, r()),
    vz: 0,
    size: between(0.034, 0.066, r()),
    warm: r() < 0.7,
    seed: r() * 6.283,
  });
}

/** A mote comes off the tip of the tail and is left behind in the air. */
function shedFromTail(f: Flight): void {
  const m = spare(f);
  if (!m) return;
  const r = f.random;
  const { cols, domeRows, skirtRows } = f.sheet;
  const rows = domeRows + skirtRows;
  const v = 3 * (1 + (cols / 2) * rows + rows - 1);
  const pos = f.cloth.pos;
  Object.assign(m, newMote(), {
    life: between(0.8, 1.4, r()),
    x: pos[v]!,
    y: pos[v + 1]!,
    z: -0.05,
    vx: between(-0.05, 0.05, r()),
    vy: between(-0.02, 0.06, r()),
    vz: 0,
    size: between(0.028, 0.05, r()),
    warm: r() < 0.6,
    seed: r() * 6.283,
  });
}

/** Motes fly out from round the body: it is pleased. */
function burst(f: Flight, count: number, speed: number): void {
  const r = f.random;
  for (let k = 0; k < count; k += 1) {
    const m = spare(f);
    if (!m) return;
    const angle = ((k + r() * 0.8) / count) * Math.PI * 2;
    const out = between(0.7, 0.86, r());
    const fast = speed * between(0.55, 1.1, r());
    Object.assign(m, newMote(), {
      life: between(0.65, 1.15, r()),
      x: f.origin[0]! + Math.cos(angle) * out,
      y: f.origin[1]! - 0.15 + Math.sin(angle) * out * 0.9,
      z: between(-0.3, -0.02, r()),
      vx: Math.cos(angle) * fast,
      vy: Math.sin(angle) * fast + 0.2,
      vz: between(-0.2, 0.2, r()),
      size: between(0.04, 0.085, r()),
      warm: r() < 0.65,
      seed: r() * 6.283,
    });
  }
}

/** Motes are thrown out from its face, forwards and down: it has sneezed. */
function spray(f: Flight): void {
  const r = f.random;
  for (let k = 0; k < 7; k += 1) {
    const m = spare(f);
    if (!m) return;
    // Towards the viewer is outwards on the page: a fan below the face.
    const angle = -Math.PI * between(0.12, 0.88, (k + r()) / 7);
    const fast = between(0.7, 1.5, r());
    Object.assign(m, newMote(), {
      life: between(0.5, 0.95, r()),
      x: f.origin[0]! + Math.cos(angle) * 0.12,
      y: f.origin[1]! - FACE.low - 0.12 + Math.sin(angle) * 0.08,
      z: 0.35,
      vx: Math.cos(angle) * fast,
      vy: Math.sin(angle) * fast * 0.7,
      vz: 0,
      size: between(0.03, 0.06, r()),
      warm: r() < 0.5,
      seed: r() * 6.283,
    });
  }
}

/** Sparks come off the light at the end of its hat. */
function glint(f: Flight, count: number): void {
  const r = f.random;
  const orb = f.orb;
  for (let k = 0; k < count; k += 1) {
    const m = spare(f);
    if (!m) return;
    const angle = r() * Math.PI * 2;
    const fast = between(0.25, 0.6, r());
    Object.assign(m, newMote(), {
      life: between(0.6, 1.05, r()),
      x: orb[0]! + Math.cos(angle) * 0.08,
      y: orb[1]! + Math.sin(angle) * 0.08,
      z: 0.3,
      vx: Math.cos(angle) * fast,
      vy: Math.sin(angle) * fast + 0.1,
      vz: 0,
      size: between(0.035, 0.065, r()),
      warm: r() < 0.75,
      seed: r() * 6.283,
    });
  }
}

/** A heart rises from its head, about where it is being stroked. */
function heart(f: Flight, at: number): void {
  const m = spare(f);
  if (!m) return;
  const r = f.random;
  Object.assign(m, newMote(), {
    kind: MOTE_HEART,
    life: between(1.1, 1.5, r()),
    x: f.origin[0]! + clamp(-0.45, 0.45, at - f.origin[0]!) + between(-0.12, 0.12, r()),
    y: f.origin[1]! + between(0.5, 0.7, r()),
    z: 0.35,
    vx: between(-0.08, 0.08, r()),
    vy: between(0.22, 0.32, r()),
    vz: 0,
    size: between(0.06, 0.085, r()),
    seed: r() * 6.283,
  });
}

/** A z rises from a sleeper, up and away from the side its hat does not fall to. */
function zed(f: Flight): void {
  const m = spare(f);
  if (!m) return;
  const r = f.random;
  Object.assign(m, newMote(), {
    kind: MOTE_ZED,
    life: between(2.1, 2.6, r()),
    x: f.origin[0]! - between(0.4, 0.5, r()),
    y: f.origin[1]! + between(0.48, 0.58, r()),
    z: 0.35,
    vx: -between(0.1, 0.15, r()),
    vy: between(0.15, 0.2, r()),
    vz: 0,
    size: between(0.07, 0.09, r()),
    warm: false,
    seed: between(-0.3, 0.1, r()),
  });
}

/** Moves the motes on, lights new ones, and at work keeps a couple circling the body. */
function sparkle(f: Flight, c: Air, dt: number, pace: number): void {
  if (!f.sparkle) return;
  const working = f.mood === 'working';
  let circling = 0;
  for (const m of f.motes) {
    if (m.age >= m.life) continue;
    m.age += dt;
    const spark = m.kind === MOTE_SPARK;
    if (m.orbit >= 0) {
      circling += 1;
      // Its work done, a circling mote goes out.
      if (!working && m.life > m.age + 0.5) m.life = m.age + 0.5;
      m.orbit += dt * ORBIT_PACE * Math.PI * 2;
      m.x = f.origin[0]! + Math.cos(m.orbit) * ORBIT_REACH;
      m.y = f.origin[1]! - 0.62 + Math.sin(m.orbit + 0.9) * 0.1;
      m.z = Math.sin(m.orbit) * ORBIT_REACH * 0.8;
    } else {
      // A spark slows in the air and floats up. A heart or a z is not thrown: it rises steadily, swaying as it goes.
      const slow = Math.exp(-dt * (spark ? 2.2 : 0.5));
      m.vx *= slow;
      m.vy = m.vy * slow + (spark ? 0.2 : 0.06) * dt;
      m.vz *= slow;
      m.x += m.vx * dt + (spark ? 0 : Math.sin(m.age * 3.1 + m.seed * 9) * 0.05 * dt);
      m.y += m.vy * dt;
      m.z += m.vz * dt;
    }
    const left = m.life - m.age;
    const twinkle = spark ? 0.74 + 0.26 * Math.sin(m.age * 8.5 + m.seed) : 1;
    m.glow = left > 0 ? smoothstep(m.age / 0.2) * smoothstep(left / Math.min(0.6, m.life * 0.55)) * twinkle : 0;
  }
  if (working && circling < ORBITERS) {
    const m = spare(f);
    if (m) {
      Object.assign(m, newMote(), {
        life: 1e9,
        size: circling ? 0.05 : 0.062,
        warm: circling === 0,
        seed: f.random() * 6.283,
        orbit: circling * Math.PI + f.random(),
      });
    }
  }
  if (f.roll === 0 && f.random() < c.motes * pace * dt) shed(f);
}

/** Air comes up under it. It keeps the higher of what it was doing and what this asks for. */
function puff(f: Flight, amount: number, hold: number): void {
  f.airGoal = Math.min(LIFT_TOP * liftGain(f.gain), f.airGoal + amount);
  f.hover = Math.max(f.hover, hold);
}

/** It crouches, and at the end of the crouch springs up by `amount`. */
function spring(f: Flight, amount: number): void {
  if (f.crouch <= 0) f.crouch = CROUCH_SECONDS;
  f.owed = Math.max(f.owed, amount);
}

/** One lift of the hand, up to `top`, held for `waves` waggles. One already under way carries on to the higher. */
function liftHand(f: Flight, top: number, waves: number): void {
  f.beatTop = f.beat >= 0 ? Math.max(f.beatTop, top) : top;
  f.beatWaves = f.beat >= 0 ? Math.max(f.beatWaves, waves) : waves;
  if (f.beat < 0 || f.beat > BEAT_UP) f.beat = f.beat < 0 ? 0 : BEAT_UP;
  f.sinceBeat = 0;
}

/** It nods, `times` over. */
function nod(f: Flight, times: number): void {
  if (f.nod >= 0) return;
  f.nod = 0;
  f.nods = times;
}

/** The stars in its cloth run with light, from one side to the other. */
function shimmer(f: Flight): void {
  if (f.shimmer < 0) f.shimmer = 0;
}

/** It turns once right round where it stands, springing up as it goes. Not while it is going head over heels. */
function twirl(f: Flight): void {
  if (f.spin > 0 || f.roll > 0 || f.rollWaiting >= 0) return;
  f.act = '';
  f.spin = 1e-4;
  f.spinWay = f.random() < 0.5 ? -1 : 1;
  spring(f, 0.06 * liftGain(f.gain));
}

/** The hat's tip is knocked from below: it is sent swinging back up, the light on it flares, and sparks come off it. */
function knock(f: Flight): void {
  f.tipSpeed -= BAT_KNOCK;
  f.flash = FLASH_SECONDS;
  glint(f, 3);
  widen(f.gaze, 1.12);
}

/** Its eyes go to the light on its hat, wherever that has swung to. */
function watchLight(f: Flight): void {
  const orb = f.orb;
  f.gaze.aimX = clamp(-1, 1, (orb[0]! - f.origin[0]!) * 1.5);
  f.gaze.aimY = clamp(-1, 1, -(orb[1]! - f.origin[1]! + FACE.low) * 1.2);
  f.gaze.sinceSaccade = 0;
}

/** The idea it stopped to think of has come: its light flares, its stars run, it lifts a little and nods. */
function idea(f: Flight): void {
  f.flash = FLASH_SECONDS;
  shimmer(f);
  glint(f, 2);
  puff(f, 0.06 * liftGain(f.gain), 0.3);
  nod(f, 1);
}

/** Advances the performance it is giving, if any, and writes what that asks of the body this frame to `a`. Its eyes
 *  are its own to direct only while nothing else has them: `eyesFree`. */
function perform(f: Flight, dt: number, a: Asked, eyesFree: boolean): void {
  a.nod = 0;
  a.tilt = 0;
  a.aside = 0;
  a.up = 0;
  a.lid = 0;
  a.gape = 0;
  a.flush = 0;
  a.right = -1;
  a.left = -1;
  a.tall = 0;
  if (f.act === '') return;
  f.actAge += dt;
  const t = f.actAge;
  if (f.act === 'sneeze') {
    if (t < SNEEZE_DRAW) {
      // Two breaths in, each drawing it further back and up, its eyes narrowing and its mouth coming open.
      const u = t / SNEEZE_DRAW;
      const drawn = 0.45 * smoothstep(u / 0.4) + 0.55 * smoothstep((u - 0.5) / 0.4);
      a.nod = -SNEEZE_BACK * drawn;
      a.tall = 0.08 * drawn;
      a.lid = 0.6 * drawn;
      a.gape = 0.3 + 0.3 * drawn;
      a.right = 0.3 * drawn;
      return;
    }
    if (f.actStep === 0) {
      // And out: its tail and the tip of its hat are flung, and a spray of motes goes forward.
      f.actStep = 1;
      spray(f);
      f.swishSpeed += f.actSide * FLICK * 0.7;
      f.tipSpeed -= 3;
    }
    // It is thrown forward at once with its eyes shut, comes up again slowly, flushed, and blinks.
    const u = (t - SNEEZE_DRAW) / SNEEZE_AFTER;
    const snap = smoothstep(u / 0.07);
    const thrown = snap * (1 - smoothstep((u - 0.15) / 0.85));
    a.nod = -SNEEZE_BACK * (1 - snap) + SNEEZE_THROW * thrown;
    a.tall = -0.11 * thrown;
    a.lid = 1 - smoothstep((u - 0.45) / 0.25);
    a.flush = 1 - smoothstep((u - 0.5) / 0.5);
    if (u >= 1) {
      f.act = '';
      blink(f.gaze, BLINK_TWO);
    }
  } else if (f.act === 'yawn') {
    const total = YAWN_OPEN + YAWN_HOLD + YAWN_CLOSE;
    const wide = t < YAWN_OPEN ? smoothstep(t / YAWN_OPEN) : 1 - smoothstep((t - YAWN_OPEN - YAWN_HOLD) / YAWN_CLOSE);
    // Its mouth opens round, its eyes close, it leans back and draws itself up; its hands go up a moment after its
    // mouth opens and come down last: a stretch.
    const arms = smoothstep((t - 0.25) / 0.5) * (1 - smoothstep((t - total + 0.45) / 0.45));
    a.gape = wide;
    a.lid = 0.92 * wide;
    a.nod = -YAWN_BACK * wide;
    a.tall = YAWN_TALL * wide;
    a.right = YAWN_ARMS * arms;
    a.left = YAWN_ARMS * arms;
    if (t >= total) {
      f.act = '';
      if (f.sleepy) {
        // And nods off: its eyes go down, and its head sinks to one side.
        f.sleepy = false;
        f.nap = between(NAP_LEAST, NAP_MOST, f.random());
        f.napSide = f.actSide;
        f.sinceZed = 0;
        saccade(f.gaze, 0, 0.5, Infinity);
      } else {
        f.blinkAt = f.clock + 0.3;
      }
    }
  } else if (f.act === 'bat') {
    // It looks up at the light, reaches for it, and its hand sends it swinging; then it watches it swing.
    const reached = BAT_LOOK + BAT_REACH;
    if (f.actStep === 0 && t >= BAT_LOOK) {
      f.actStep = 1;
      liftHand(f, 1, 0);
    }
    if (f.actStep === 1 && t >= reached) {
      f.actStep = 2;
      knock(f);
    }
    a.tilt = BAT_TILT * smoothstep(t / 0.3) * smoothstep((reached + BAT_WATCH - t) / 0.4);
    if (eyesFree) watchLight(f);
    if (t >= reached + BAT_WATCH) {
      f.act = '';
      saccade(f.gaze, 0, 0);
    }
  } else if (f.act === 'dance') {
    // It rocks to one side and the other, hopping onto each, with the hand on that side in the air and its eyes
    // shut in a smile; its tail and the tip of its hat are flung the other way each time, and a mote comes off its
    // hem.
    const total = 2 * DANCE_BEAT * DANCE_ROCKS;
    const full = smoothstep(t / 0.22) * smoothstep((total - t) / 0.3);
    const swing = Math.sin((Math.PI * t) / DANCE_BEAT) * f.actSide;
    a.tilt = DANCE_TILT * swing * full;
    a.aside = DANCE_STEP * swing * full;
    a.up = DANCE_HOP * swing * swing * full;
    a.right = DANCE_ARMS * Math.max(0, swing) * full;
    a.left = DANCE_ARMS * Math.max(0, -swing) * full;
    f.joyHold = Math.max(f.joyHold, 0.12);
    const sides = Math.floor(t / DANCE_BEAT + 0.5);
    if (sides > f.actStep && t < total) {
      f.actStep = sides;
      f.swishSpeed -= (swing < 0 ? -1 : 1) * FLICK * 0.5;
      f.tipSpeed -= (swing < 0 ? -1 : 1) * 1.5;
      shed(f);
    }
    if (t >= total) f.act = '';
  } else {
    // Musing: its head to one side and its hand at its cheek, until the idea comes.
    const full = smoothstep(t / 0.3) * smoothstep((MUSE_SECONDS - t) / 0.3);
    a.tilt = MUSE_TILT * f.actSide * full;
    a.right = MUSE_HAND * full;
    if (t >= MUSE_SECONDS) {
      f.act = '';
      idea(f);
    }
  }
}

/** Has it do one of the things it does for no reason, by name. */
export function whimFlight(f: Flight, kind: Whim): void {
  f.sinceWhim = 0;
  f.lastWhim = kind;
  if (kind === 'wave') {
    liftHand(f, 1, 2);
  } else if (kind === 'flick') {
    f.swishSpeed += (f.random() < 0.5 ? -1 : 1) * FLICK;
  } else if (kind === 'peek') {
    f.peek = 0;
    f.peekSide = f.random() < 0.5 ? -1 : 1;
    saccade(f.gaze, f.peekSide * 0.75, 0.1);
  } else if (kind === 'hop') {
    spring(f, 0.07 * liftGain(f.gain));
  } else if (kind === 'shake') {
    f.shake = 0;
  } else if (kind === 'twirl') {
    twirl(f);
  } else if (kind === 'shimmer') {
    // Its light flares and its stars run, and it looks up to see.
    f.flash = FLASH_SECONDS;
    shimmer(f);
    saccade(f.gaze, 0.3, -0.8);
  } else {
    begin(f, kind);
    if (kind === 'bat') saccade(f.gaze, 0.7, -0.9);
    else if (kind === 'sneeze') saccade(f.gaze, 0, 0.15);
  }
}

/** Something it does for no reason but that it is alive: never the same thing twice running. The quieter it has
 *  grown the likelier a yawn; watched, it neither yawns nor shakes itself. */
function whim(f: Flight, quiet: number): void {
  const watched = f.attention > 0.2;
  const odds = (kind: Whim, share: number): number => {
    if (kind === f.lastWhim || (watched && (kind === 'yawn' || kind === 'shake'))) return 0;
    return kind === 'yawn' ? share * (1 + 5 * quiet) : share;
  };
  let all = 0;
  for (const [kind, share] of WHIM_ODDS) all += odds(kind, share);
  let pick = f.random() * all;
  for (const [kind, share] of WHIM_ODDS) {
    pick -= odds(kind, share);
    if (pick < 0) {
      whimFlight(f, kind);
      return;
    }
  }
}

/** Lift it once: it crouches, springs up with its skirt drawn in and its eyes shut in a smile, sheds a burst of motes,
 *  hangs a moment and settles. Whatever it was performing is dropped for it. */
export function pulseFlight(f: Flight): void {
  rouse(f);
  f.act = '';
  spring(f, PULSE_LIFT * liftGain(f.gain));
  f.tipSpeed -= 1.8;
  f.joyHold = JOY_SECONDS;
  liftHand(f, 0.9, 0);
  burst(f, 8, 1.1);
  shimmer(f);
  saccade(f.gaze, f.gaze.aimX * 0.4, -0.3);
  f.sinceGust = 0;
  f.sinceWhim = 0;
  f.blinkAt = f.clock + JOY_SECONDS + 0.5;
}

/** Someone clicked it, which lifts it through `pulse`: two quick ones also turn it right round, and a third sends
 *  it head over heels. */
export function clickFlight(f: Flight): void {
  f.clicks = f.clock - f.clickAt < CLICK_GAP ? f.clicks + 1 : 1;
  f.clickAt = f.clock;
  if (f.clicks === CLICK_TWIRL) twirlFlight(f);
  if (f.clicks === CLICK_ROLL) flipFlight(f);
}

/** Turn it once right round where it stands. */
export function twirlFlight(f: Flight): void {
  rouse(f);
  twirl(f);
  f.sinceGust = 0;
  f.sinceWhim = 0;
}

/** Send it head over heels, backwards, so the coral inside of its cloth comes round to the viewer. One asked for
 *  while it is turning right round waits until that is done. */
export function flipFlight(f: Flight): void {
  rouse(f);
  f.act = '';
  if (f.rollWaiting < 0 && f.roll === 0) f.rollWaiting = ROLL_DELAY + (f.spin > 0 ? (1 - f.spin) * TWIRL_SECONDS : 0);
  puff(f, PULSE_LIFT * 0.8 * liftGain(f.gain), 0.6);
  burst(f, 6, 0.8);
  saccade(f.gaze, 0, -0.3);
  f.sinceGust = 0;
  f.sinceWhim = 0;
}

/** A touch of air under its skirt, from the pointer arriving. */
export function stirFlight(f: Flight, amount: number): void {
  rouse(f);
  updraught(f, AIR[f.mood], 0.5 * amount + 0.4);
}

/** Starts it below its place and leaning back, unseen; it floats up with its skirt drawn in, settles, and waves. */
export function arriveFlight(f: Flight): void {
  f.enter = 1;
  f.wake = WAKE_SECONDS * 0.5;
  f.breath = BREATH_RISE;
  f.pose.open = OPEN_LEAST;
  f.lastY = f.place[1]! - ENTER_FROM;
  place(f);
  settleCloth(f.cloth);
  settleOrb(f);
  f.beat = -0.7;
  f.beatTop = 1;
  f.beatWaves = 2;
  f.sinceGreet = 0;
  saccade(f.gaze, 0, 0);
}

/** Follows a resized box, for a mascot that fills it. */
export function resizeFlight(f: Flight, gain: number): void {
  f.gain = gain;
}

/** Where the orb hangs from and which way, as the cloth is now: [x, y, z] of the end of the hat's tail, then the way
 *  the orb would hang from it with nothing moving it, a unit. That is the way the tail is going at its end, from the
 *  middle of its last ring to its end, drawn down by the orb's weight. */
const HUNG = new Float64Array(6);

function hangOrb(f: Flight): void {
  const { pos } = f.cloth;
  const { cols, domeRows, skirtRows } = f.sheet;
  const rows = domeRows + skirtRows;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let c = 0, v = 3; c < cols; c += 1, v += 3 * rows) {
    x += pos[v]!;
    y += pos[v + 1]!;
    z += pos[v + 2]!;
  }
  let dx = pos[0]! - x / cols;
  let dy = pos[1]! - y / cols;
  let dz = pos[2]! - z / cols;
  const along = Math.hypot(dx, dy, dz) || 1;
  dx /= along;
  dy = dy / along - ORB_WEIGHT;
  dz /= along;
  const length = Math.hypot(dx, dy, dz) || 1;
  HUNG[0] = pos[0]!;
  HUNG[1] = pos[1]!;
  HUNG[2] = pos[2]!;
  HUNG[3] = dx / length;
  HUNG[4] = dy / length;
  HUNG[5] = dz / length;
}

/** Puts the orb where it hangs at rest, still. */
function settleOrb(f: Flight): void {
  hangOrb(f);
  const reach = ORB.radius * ORB.hang;
  for (let a = 0; a < 3; a += 1) {
    f.orb[a] = HUNG[a]! + HUNG[3 + a]! * reach;
    f.orbSpeed[a] = 0;
  }
}

/** Moves the orb on: drawn to where it hangs at rest, carried on by its own way, kept out of the hat, and held at
 *  its thread's length from the end of the tail whatever else is asked of it. */
function swingOrb(f: Flight, dt: number): void {
  hangOrb(f);
  const { orb, orbSpeed, origin } = f;
  const reach = ORB.radius * ORB.hang;
  const room = HEAD.radius + ORB.radius * ORB_ROOM;
  const steps = Math.max(1, Math.ceil(dt / ORB_STEP));
  const h = dt / steps;
  for (let k = 0; k < steps; k += 1) {
    const fromX = orb[0]!;
    const fromY = orb[1]!;
    const fromZ = orb[2]!;
    for (let a = 0; a < 3; a += 1) {
      const rest = HUNG[a]! + HUNG[3 + a]! * reach;
      orbSpeed[a] = orbSpeed[a]! + (ORB_RATE * ORB_RATE * (rest - orb[a]!) - 2 * ORB_DAMP * ORB_RATE * orbSpeed[a]!) * h;
      orb[a] = orb[a]! + orbSpeed[a]! * h;
    }
    // Out of the hat: no nearer the middle of the head than the head and most of itself.
    let ox = orb[0]! - origin[0]!;
    let oy = orb[1]! - origin[1]!;
    let oz = orb[2]! - origin[2]!;
    const far = Math.hypot(ox, oy, oz);
    if (far < room && far > 1e-6) {
      const out = room / far;
      orb[0] = origin[0]! + ox * out;
      orb[1] = origin[1]! + oy * out;
      orb[2] = origin[2]! + oz * out;
    }
    // On its thread: at the thread's length from the end of the tail, and not folded back on the tail.
    ox = orb[0]! - HUNG[0]!;
    oy = orb[1]! - HUNG[1]!;
    oz = orb[2]! - HUNG[2]!;
    let length = Math.hypot(ox, oy, oz);
    if (length < 1e-6) {
      ox = HUNG[3]!;
      oy = HUNG[4]!;
      oz = HUNG[5]!;
      length = 1;
    }
    ox /= length;
    oy /= length;
    oz /= length;
    const along = ox * HUNG[3]! + oy * HUNG[4]! + oz * HUNG[5]!;
    if (along < ORB_SWING) {
      // Brought back to the most it may swing: what of it is across the line it hangs on is kept, and its share
      // along the line made up.
      let ax = ox - along * HUNG[3]!;
      let ay = oy - along * HUNG[4]!;
      let az = oz - along * HUNG[5]!;
      const across = Math.hypot(ax, ay, az);
      if (across > 1e-6) {
        const side = Math.sqrt(1 - ORB_SWING * ORB_SWING) / across;
        ax *= side;
        ay *= side;
        az *= side;
      } else {
        ax = 0;
        ay = 0;
        az = 0;
      }
      ox = ORB_SWING * HUNG[3]! + ax;
      oy = ORB_SWING * HUNG[4]! + ay;
      oz = ORB_SWING * HUNG[5]! + az;
      const again = Math.hypot(ox, oy, oz) || 1;
      ox /= again;
      oy /= again;
      oz /= again;
    }
    orb[0] = HUNG[0]! + ox * reach;
    orb[1] = HUNG[1]! + oy * reach;
    orb[2] = HUNG[2]! + oz * reach;
    // Its way is whatever it has just been moved by, the pull of its thread included: that is what carries it on.
    if (h > 0) {
      orbSpeed[0] = (orb[0]! - fromX) / h;
      orbSpeed[1] = (orb[1]! - fromY) / h;
      orbSpeed[2] = (orb[2]! - fromZ) / h;
    }
  }
}

/** A value follows its goal without ever overshooting: critically damped, exact for any step. */
function follow(f: Flight, k: number, goal: number, rate: number, dt: number): void {
  const e = Math.exp(-rate * dt);
  const d = f.place[k]! - goal;
  const c = f.placeSpeed[k]! + rate * d;
  const q = d + c * dt;
  f.place[k] = goal + q * e;
  f.placeSpeed[k] = (c - rate * q) * e;
}

const QUIET_INPUT: FlightInput = { lookX: 0, lookY: 0, look: 0, gustX: 0, gustY: 0, near: 0, atX: 0, atY: 0 };

/** Advances the flight. What it draws is the cloth, the motes, `gaze`, the face (`joy`, `lid`, `gape`, `flush`), the
 *  left hand, the light (`flare`, `doze`, `shimmer`) and the `draw*` fields. */
export function stepFlight(f: Flight, dt: number, mood: FlightMood, input: FlightInput = QUIET_INPUT): void {
  const c = AIR[mood];
  const gain = f.gain;
  const lift = liftGain(gain);
  const pose = f.pose;
  f.clock += dt;
  f.wake = Math.min(WAKE_SECONDS, f.wake + dt);
  const wake = smoothstep(f.wake / WAKE_SECONDS);

  if (mood !== f.mood) {
    f.mood = mood;
    rouse(f);
    f.gaze.step = 0;
    f.gaze.dwell = 0.05;
    f.gaze.lineEnded = false;
    if (mood === 'idle') saccade(f.gaze, 0, 0);
    // Taking work up, it nods and lifts its hand to it; setting it down, the stars in its cloth run with light. Its
    // light flares either way. Not on its first frame: a mascot at work from the start is simply at work.
    if (f.clock > 0) {
      f.act = '';
      f.flash = FLASH_SECONDS;
      if (mood === 'working') {
        nod(f, 1);
        liftHand(f, 0.85, 0);
      } else {
        shimmer(f);
      }
    }
  }
  // A pointer that only moves somewhere on the page wakes a sleeper gently; one that comes close makes it start.
  if (input.look > 0 || input.near > 0) rouse(f, input.near > PET_NEAR);
  f.awake += dt;
  const turning = f.roll > 0 || f.spin > 0;
  const quiet = mood === 'working' ? 0 : smoothstep((f.awake - QUIET_FROM) / QUIET_OVER);
  const pace = turning ? 0 : between(1, QUIET_PACE, quiet);
  const reach = between(1, QUIET_REACH, quiet);

  // Sleep: a nap runs out by itself, and it wakes from one with a yawn and a stretch.
  if (f.nap > 0) {
    f.nap -= dt;
    if (f.nap <= 0) {
      f.nap = 0;
      f.awake = 0;
      begin(f, 'yawn');
    }
  }
  f.doze = f.nap > 0 ? lag(f.doze, 1, 1.2, dt) : f.doze > 0.003 ? lag(f.doze, 0, 0.2, dt) : 0;
  const asleep = f.doze;

  stepGaze(f.gaze, dt, mood === 'working', input, pace * (1 - asleep), wake);
  if (f.gaze.lineEnded) {
    // At the end of each line it reads its head dips a little, as a reader's does.
    f.gaze.lineEnded = false;
    f.placeSpeed[3] = f.placeSpeed[3]! + LINE_DIP;
  }
  if (f.gaze.thought) {
    f.gaze.thought = false;
    // It stops to think: hand to its cheek, until the idea comes. Busy with something else, the thought only lifts it.
    if (mood === 'working') {
      if (f.act === '' && !turning) begin(f, 'muse');
      else puff(f, 0.06 * lift, 0.3);
    }
  }
  if (f.clock >= f.blinkAt) {
    f.blinkAt = Infinity;
    blink(f.gaze, BLINK_SLOW);
  }

  // The pointer: its air, and whether it has the mascot's attention. A pointer that comes close is waved at.
  const settle = Math.exp(-dt * 3);
  f.stirX = clamp(-2.2, 2.2, f.stirX * settle + input.gustX * dt * 6);
  f.stirY = clamp(-2.2, 2.2, f.stirY * settle - input.gustY * dt * 6);
  f.stirAtX = input.atX;
  f.stirAtY = input.atY;
  f.sinceGreet += dt;
  if (input.near > 0.5 && f.attention < 0.25 && f.sinceGreet > GREET_GAP && !turning) {
    f.sinceGreet = 0;
    liftHand(f, 1, 2);
  }
  f.attention = lag(f.attention, input.near, 0.6, dt);
  f.startled = Math.max(0, f.startled - dt);
  const speed = Math.hypot(input.gustX, input.gustY);
  if (speed > STARTLE_SPEED && f.startled === 0) {
    // Something went by fast: its eyes go wide, its mouth comes open, and it jumps a little in its skin.
    f.startled = 4;
    widen(f.gaze, 1.18);
    f.gasp = GASP_SECONDS;
    f.stretchSpeed += 1.2;
    f.tipSpeed -= 2;
    f.swishSpeed += (f.random() < 0.5 ? -1 : 1) * FLICK * 0.6;
  }
  // Stroked: a pointer that goes to and fro across it, not too fast. It remembers a stroke for a moment, so a
  // pointer that turns round on it has not stopped. Given up to it, it shuts its eyes in a smile, flushes, settles
  // under the hand, and gives off hearts.
  const stroked = !turning && input.near > PET_NEAR && speed > PET_SLOW && speed < STARTLE_SPEED && Math.abs(input.atX) < 0.9 && input.atY > -0.75 && input.atY < 1.15;
  f.petted = clamp(0, PET_MOST, f.petted + (stroked ? dt : -0.5 * dt));
  const bliss = smoothstep((f.petted - PET_AFTER) / 0.3);
  f.sinceHeart += dt;
  if (bliss > 0.5) {
    f.joyHold = Math.max(f.joyHold, 0.25);
    if (f.sinceHeart > HEART_GAP) {
      f.sinceHeart = 0;
      heart(f, input.atX);
    }
  }

  // Height: a crouch, then quick up, a hover, and a slow settle.
  if (f.crouch > 0) {
    f.crouch -= dt;
    if (f.crouch <= 0) {
      puff(f, f.owed, 0.45);
      f.owed = 0;
    }
  }
  if (f.hover > 0) f.hover -= dt;
  else if (f.airGoal > 0) f.airGoal = Math.max(0, f.airGoal - SETTLE * lift * Math.min(1, 0.3 + f.airGoal / (0.07 * lift)) * dt);
  f.airNear = lag(f.airNear, f.airGoal, 0.1, dt);
  f.air = lag(f.air, f.airNear, 0.13, dt);

  // Head over heels: a wind-up, then the turn. The cloth keeps its shape more firmly while it goes round, and all
  // through an entrance.
  if (f.rollWaiting >= 0) {
    f.rollWaiting -= dt;
    if (f.rollWaiting < 0) f.roll = 1e-4;
  } else if (f.roll > 0) {
    f.roll += dt / ROLL_SECONDS;
    if (f.roll >= 1) f.roll = 0;
  }
  if (f.shake >= 0) {
    f.shake += dt;
    if (f.shake >= SHAKE_SECONDS) f.shake = -1;
  }
  // A turn right round: motes fly off its hem as it goes, and it ends with both hands up, pleased with itself.
  if (f.spin > 0) {
    f.spin += dt / TWIRL_SECONDS;
    if (f.random() < 6 * dt) shed(f);
    if (f.spin >= 1) {
      f.spin = 0;
      f.joyHold = Math.max(f.joyHold, TWIRL_PROUD);
      liftHand(f, 0.9, 0);
    }
  }
  if (f.nod >= 0) {
    f.nod += dt;
    if (f.nod >= NOD_SECONDS * f.nods) f.nod = -1;
  }
  if (f.shimmer >= 0) {
    f.shimmer += dt / SHIMMER_SECONDS;
    if (f.shimmer >= 1) f.shimmer = -1;
  }
  const round = Math.max(f.roll > 0 ? Math.sin(Math.PI * f.roll) : 0, f.spin > 0 ? Math.sin(Math.PI * f.spin) : 0);
  const firm = 1 + (ROLL_FIRM - 1) * round ** 0.6 + 7 * f.enter;
  if (Math.abs(firm - f.firm) > 0.02) {
    f.firm = firm;
    setHold(f.cloth, firm);
  }
  f.enter = f.enter > 0.001 ? lag(f.enter, 0, 0.42, dt) : 0;

  // The slow wander of the whole body, its breathing, a peer to one side, and the turn towards what it is watching.
  const spread = c.wander * reach * wake;
  for (let k = 0; k < 6; k += 1) {
    f.drift[k] = f.drift[k]! - (f.drift[k]! / DRIFT_TIME) * dt + (f.random() - 0.5) * 2.4 * Math.sqrt(dt / DRIFT_TIME);
    f.driftNear[k] = lag(f.driftNear[k]!, f.drift[k]! * DRIFT[k]! * spread * (k < 3 ? gain : 1), 1.1, dt);
    f.driftNow[k] = lag(f.driftNow[k]!, f.driftNear[k]!, 1.1, dt);
  }
  // What it is performing, if anything, and the quick moves that come of it.
  const asked = ASKED;
  perform(f, dt, asked, input.look === 0);
  const quick = f.quick;
  quick[0] = asked.nod + (f.nod >= 0 ? NOD_DIP * (0.5 - 0.5 * Math.cos((Math.PI * 2 * f.nod) / NOD_SECONDS)) : 0);
  quick[1] = f.spin > 0 ? Math.PI * 2 * f.spinWay * smoothstep(f.spin) : 0;
  quick[2] = asked.tilt;
  quick[3] = asked.aside * gain;
  quick[4] = asked.up * lift;

  // Asleep it breathes slower and deeper, and hardly sways.
  f.breath += (dt / c.breath) * between(1, 0.75, quiet) * (1 - 0.4 * asleep);
  const phase = f.breath % 1;
  const risen = phase < BREATH_RISE ? smoothstep(phase / BREATH_RISE) : 1 - smoothstep((phase - BREATH_RISE) / (1 - BREATH_RISE));
  let peer = 0;
  if (f.peek >= 0) {
    f.peek += dt;
    peer = f.peekSide * smoothstep(f.peek / 0.35) * smoothstep((PEEK_SECONDS - f.peek) / 0.5);
    if (f.peek >= PEEK_SECONDS) {
      f.peek = -1;
      saccade(f.gaze, 0, 0);
    }
  }
  const look = input.look > 0 ? 1 : 0;
  const leaning = clamp(-LEAN_MOST, LEAN_MOST, f.velX * LEAN_BY_SPEED);
  // The sway: to one side and back, leaning into the way it is going.
  const swayAt = (Math.PI * 2 * f.clock) / SWAY_SECONDS + f.swayFrom;
  const sway = reach * wake * (1 - 0.5 * f.attention) * (1 - 0.7 * asleep);
  follow(f, 0, f.driftNow[0]! + (SWAY_REACH * Math.sin(swayAt) * sway + look * input.lookX * LOOK_LEAN) * gain, 6, dt);
  follow(f, 1, f.driftNow[1]! + c.bob * gain * reach * wake * (1 + 0.5 * asleep) * (2 * risen - 1), 7, dt);
  follow(f, 2, f.driftNow[2]!, 6, dt);
  // Asleep, its head sinks forward and to one side.
  follow(f, 3, f.driftNow[3]! + look * input.lookY * LOOK_PITCH + c.lean * wake + DOZE_NOD * asleep, 5, dt);
  follow(f, 4, f.driftNow[4]! + look * input.lookX * LOOK_YAW + peer * PEEK_TURN, 5, dt);
  follow(f, 5, f.driftNow[5]! - peer * PEEK_TILT - leaning - SWAY_LEAN * Math.cos(swayAt) * sway - look * input.lookX * LOOK_TILT - DOZE_TILT * f.napSide * asleep, 5, dt);

  // How fast the head is going, an entrance's rise included: the rest of the body answers to it.
  const headX = f.place[0]!;
  const headY = f.place[1]! + f.air - f.enter * f.enter * ENTER_FROM;
  if (dt > 0) {
    f.velX = lag(f.velX, (headX - f.lastX) / dt, 0.1, dt);
    f.velY = lag(f.velY, (headY - f.lastY) / dt, 0.1, dt);
  }
  f.lastX = headX;
  f.lastY = headY;

  // Rising, the skirt is drawn in and the body drawn up; sinking, the skirt spreads and the body settles. Going head
  // over heels throws the skirt out, and so does turning right round.
  const flung = f.roll > 0 ? 0.25 * Math.sin(Math.PI * f.roll) : f.spin > 0 ? TWIRL_FLING * Math.sin(Math.PI * f.spin) : 0;
  const openGoal = clamp(OPEN_LEAST, OPEN_MOST, -OPEN_BY_RISE * f.velY + flung + 0.12 * f.attention);
  pose.open = lag(pose.open, openGoal * wake, 0.14, dt);
  const stretchGoal = f.crouch > 0 ? -CROUCH : clamp(STRETCH_LEAST, STRETCH_MOST, STRETCH_BY_RISE * f.velY) + asked.tall - 0.05 * bliss;
  f.stretchSpeed += (-STRETCH_RATE * STRETCH_RATE * (pose.stretch - stretchGoal) - 2 * STRETCH_DAMP * STRETCH_RATE * f.stretchSpeed) * dt;
  pose.stretch = clamp(-0.2, 0.2, pose.stretch + f.stretchSpeed * dt);
  // The hat sinks on a head that rises under it and lifts off one that drops, and settles with a wobble.
  const sagGoal = clamp(-SAG_MOST, SAG_MOST, SAG_BY_RISE * f.velY);
  f.sagSpeed += (-SAG_RATE * SAG_RATE * (pose.sag - sagGoal) - 2 * SAG_DAMP * SAG_RATE * f.sagSpeed) * dt;
  pose.sag = clamp(-1.6 * SAG_MOST, 1.6 * SAG_MOST, pose.sag + f.sagSpeed * dt);
  // The hat's tip trails behind the body's moves, rings on its own spring after whatever knocked it, and droops on a
  // sleeper.
  const trail = clamp(-TIP_TRAIL, TIP_TRAIL, TIP_BY_RISE * f.velY - TIP_BY_SLIDE * f.velX) * (1 - asleep);
  f.tipSpeed += (-TIP_RATE * TIP_RATE * (pose.tip - TIP_DROOP * asleep - trail) - 2 * TIP_DAMP * TIP_RATE * f.tipSpeed) * dt;
  pose.tip += f.tipSpeed * dt;
  if (pose.tip > TIP_OVER || pose.tip < TIP_BACK) {
    const outwards = pose.tip > TIP_OVER ? f.tipSpeed > 0 : f.tipSpeed < 0;
    pose.tip = clamp(TIP_BACK, TIP_OVER, pose.tip);
    if (outwards) f.tipSpeed *= -TIP_GIVE;
  }
  // And the end of the tail follows the rest of it late: curled back against a swing that is gathering, and on past
  // one that is spent.
  const curlGoal = clamp(-CURL_MOST, CURL_MOST, -CURL_LAG * f.tipSpeed);
  f.curlSpeed += (-CURL_RATE * CURL_RATE * (pose.curl - curlGoal) - 2 * CURL_DAMP * CURL_RATE * f.curlSpeed) * dt;
  pose.curl = clamp(CURL_OUT, CURL_IN, pose.curl + f.curlSpeed * dt);

  // The hand hangs with the skirt, stirring a little. A lift carries it right up, and a wave waggles it there; at
  // work it lifts now and then as if casting something, and a mote comes off it.
  f.handNoise = f.handNoise - (f.handNoise / 4.5) * dt + (f.random() - 0.5) * 2.4 * Math.sqrt(dt / 4.5);
  f.sinceBeat += dt;
  if (c.beats > 0 && f.beat < 0 && !turning && f.sinceBeat > c.beatGap && f.random() < c.beats * dt) {
    liftHand(f, 0.85, 0);
    shed(f);
  }
  let handGoal = (c.hand + 0.1 * Math.tanh(f.handNoise * 1.6) * reach + 0.1 * f.attention) * (1 - asleep);
  if (f.beat >= 0) {
    f.beat += dt;
    const held = BEAT_HOLD + f.beatWaves * WAGGLE_SECONDS;
    const down = f.beat - BEAT_UP - held;
    const up = down < 0 ? smoothstep(f.beat / BEAT_UP) : 1 - smoothstep(down / BEAT_DOWN);
    let top = f.beatTop;
    if (f.beatWaves > 0 && f.beat > BEAT_UP && down < 0) top -= WAGGLE * (0.5 - 0.5 * Math.cos((Math.PI * 2 * (f.beat - BEAT_UP)) / WAGGLE_SECONDS));
    handGoal += (top - handGoal) * up;
    if (down >= BEAT_DOWN) f.beat = -1;
  } else if (f.beat > -1) {
    // A lift that is owed: it starts when the wait is over.
    f.beat = Math.min(0, f.beat + dt);
  }
  if (asked.right >= 0) handGoal = Math.max(handGoal, asked.right);
  // Going head over heels its hands are in; turning right round they are thrown out, both of them.
  const thrown = f.spin > 0 ? TWIRL_ARMS * Math.sin(Math.PI * f.spin) : 0;
  if (turning) handGoal = Math.max(0.05, thrown);
  {
    const e = Math.exp(-HAND_RATE * dt);
    const d = pose.wave - handGoal;
    const k = f.handSpeed + HAND_RATE * d;
    const q = d + k * dt;
    pose.wave = handGoal + q * e;
    f.handSpeed = (k - HAND_RATE * q) * e;
  }
  // The left hand lifts no cloth and has less to do: it goes up when the spirit is pleased, unless that is the
  // pleasure of being stroked, and wherever a performance wants it.
  f.left = lag(f.left, turning ? thrown : asked.left >= 0 ? asked.left : 0.7 * f.joy * (1 - bliss), 0.07, dt);

  // Its face, beyond what its eyes do: lids that come down for a yawn, a sneeze and for sleep; a mouth that comes
  // open round for a yawn or a start; a flush; and the light on its hat, which flares and dies down.
  f.gasp = Math.max(0, f.gasp - dt);
  f.flash = Math.max(0, f.flash - dt);
  f.lid = lag(f.lid, Math.max(asked.lid, asleep), 0.06, dt);
  f.gape = lag(f.gape, Math.max(asked.gape, f.gasp > 0 ? GASP : 0), 0.05, dt);
  f.flush = lag(f.flush, Math.max(asked.flush, bliss), 0.2, dt);
  f.flare = lag(f.flare, f.flash > 0 ? 1 : 0, f.flash > 0 ? 0.05 : 0.4, dt);

  // The tail: a slow wave runs along it from side to side, and it swings to either side of the body on a loose spring,
  // so a flick rings on a little.
  f.wagPhase += Math.PI * 2 * c.wagPace * pace * dt;
  const wag = c.wag * reach * wake * (1 + 0.4 * f.attention) * (1 - 0.6 * asleep);
  pose.wagA = wag * Math.cos(f.wagPhase);
  pose.wagB = wag * Math.sin(f.wagPhase);
  f.swishNoise = f.swishNoise - (f.swishNoise / 3.5) * dt + (f.random() - 0.5) * 2.4 * Math.sqrt(dt / 3.5);
  const swishGoal = SWISH_IDLE * Math.tanh(f.swishNoise * 1.6) * reach * wake * (1 - 0.6 * asleep);
  f.swishSpeed += (-SWISH_RATE * SWISH_RATE * (pose.swish - swishGoal) - 2 * SWISH_DAMP * SWISH_RATE * f.swishSpeed) * dt;
  pose.swish = clamp(-0.9, 0.9, pose.swish + f.swishSpeed * dt);
  // A quick swing shakes a mote of light off its tip.
  if (Math.abs(f.swishSpeed) > SWISH_SHEDS && f.random() < 5 * dt) shedFromTail(f);

  // Its eyes shut in a smile while it is pleased.
  f.joyHold = Math.max(0, f.joyHold - dt);
  f.joy = lag(f.joy, f.joyHold > 0 ? 1 : 0, f.joyHold > 0 ? 0.05 : 0.14, dt);

  // Left to itself it does things for no reason; left alone for long, it yawns and nods off instead. Only where its
  // face can be read: at a few pixels a sleeper's shut eyes are no eyes at all.
  f.sinceWhim += dt;
  const free = !turning && f.act === '' && f.beat === -1 && f.peek < 0 && f.shake < 0 && f.nod < 0 && f.crouch <= 0 && f.airGoal === 0 && f.enter === 0 && f.nap <= 0 && asleep < 0.05 && f.petted < 0.1;
  if (c.whims > 0 && free && f.sinceWhim > c.whimGap) {
    if (!f.small && f.awake > DOZE_FROM && f.attention < 0.05 && f.random() < DOZE_ODDS * dt) {
      begin(f, 'yawn');
      f.sleepy = true;
      f.sinceWhim = 0;
    } else if (f.random() < c.whims * pace * dt) {
      whim(f, quiet);
    }
  }
  if (asleep > 0.7) {
    f.sinceZed += dt;
    if (f.sinceZed > ZED_GAP) {
      f.sinceZed = 0;
      zed(f);
    }
  }

  place(f);
  if (!turning) weather(f, c, dt, pace, reach);
  blow(f, c, dt, wake * between(1, 0.7, quiet) * (1 - 0.3 * f.attention));
  sparkle(f, c, dt, between(1, 0.5, quiet) * (1 - 0.8 * asleep));
  stepCloth(f.cloth, dt);
  swingOrb(f, dt);

  f.drawX = f.origin[0]! - HEAD.x;
  f.drawY = f.place[1]! + f.air;
}
