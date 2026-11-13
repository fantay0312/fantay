// SPDX-License-Identifier: AGPL-3.0-only
// Page-turn sounds for the manga reader, synthesised with Web Audio so nothing is bundled: the crinkle of paper
// lifting, a swish that travels across the stereo field with the leaf, and the soft slap of it landing. Covers are
// board, so they swing lower and land with a thud. Every turn draws fresh noise and filter offsets, so a run of
// turns never sounds like one sample on repeat.

export type TurnSound = 'page-forward' | 'page-back' | 'cover-open' | 'cover-close';

const SOUND_KEY = 'fantay.changelog.sound';
const MASTER = 0.6;

let context: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let enabled: boolean | null = null;

export function soundEnabled(): boolean {
  if (enabled == null) {
    try {
      enabled = window.localStorage.getItem(SOUND_KEY) !== 'off';
    } catch {
      enabled = true;
    }
  }
  return enabled;
}

export function setSoundEnabled(next: boolean): void {
  enabled = next;
  try {
    window.localStorage.setItem(SOUND_KEY, next ? 'on' : 'off');
  } catch {
    // Storage can be unavailable; the choice still holds for this session.
  }
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context ??= new Ctor();
  } catch {
    return null;
  }
  if (context.state === 'suspended') void context.resume().catch(() => undefined);
  return context;
}

/** Two seconds of paper-coloured noise: white hiss over a little low body, so it never sounds like static. */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  const length = Math.floor(ctx.sampleRate * 2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let body = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    body = 0.9 * body + 0.1 * white;
    data[i] = white * 0.42 + body * 1.4;
  }
  noise = buffer;
  return buffer;
}

interface Burst {
  /** Seconds after the turn starts. */
  at: number;
  length: number;
  peak: number;
  attack: number;
  filter: BiquadFilterType;
  from: number;
  to?: number;
  q?: number;
  pan?: [number, number];
}

function burst(ctx: AudioContext, out: AudioNode, start: number, b: Burst): void {
  const t0 = start + b.at;
  const end = t0 + b.length;
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx);
  source.playbackRate.value = 0.92 + Math.random() * 0.16;
  const filter = ctx.createBiquadFilter();
  filter.type = b.filter;
  filter.Q.value = b.q ?? 0.8;
  filter.frequency.setValueAtTime(b.from, t0);
  if (b.to) filter.frequency.exponentialRampToValueAtTime(b.to, end);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(b.peak, t0 + b.attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  source.connect(filter).connect(gain);
  let tail: AudioNode = gain;
  if (b.pan && typeof ctx.createStereoPanner === 'function') {
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(b.pan[0], t0);
    pan.pan.linearRampToValueAtTime(b.pan[1], end);
    gain.connect(pan);
    tail = pan;
  }
  tail.connect(out);
  source.onended = () => tail.disconnect();
  source.start(t0, Math.random() * 1.2, b.length + 0.05);
}

/** The low knock of board meeting board. */
function thud(ctx: AudioContext, out: AudioNode, at: number, peak: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(92, at);
  osc.frequency.exponentialRampToValueAtTime(52, at + 0.18);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
  osc.connect(gain).connect(out);
  osc.onended = () => gain.disconnect();
  osc.start(at);
  osc.stop(at + 0.24);
}

/** Plays one turn, timed to a leaf that takes `durationMs` to cross the spread. */
export function playTurnSound(kind: TurnSound, durationMs: number): void {
  if (!soundEnabled()) return;
  const ctx = audio();
  if (!ctx) return;
  const out = ctx.createGain();
  out.gain.value = MASTER;
  out.connect(ctx.destination);
  const start = ctx.currentTime + 0.01;
  const d = Math.max(durationMs, 260) / 1000;
  window.setTimeout(() => out.disconnect(), (d + 0.6) * 1000);
  const vary = () => 0.88 + Math.random() * 0.24;
  // A forward turn carries the leaf from the right page to the left one, a backward turn the other way.
  const side = kind === 'page-back' || kind === 'cover-close' ? -1 : 1;
  const from = 0.45 * side;
  const to = -0.45 * side;

  if (kind === 'page-forward' || kind === 'page-back') {
    burst(ctx, out, start, { at: 0, length: 0.11, peak: 0.1, attack: 0.006, filter: 'highpass', from: 2600 * vary(), pan: [from, from] });
    burst(ctx, out, start, { at: 0.045, length: 0.07, peak: 0.05, attack: 0.004, filter: 'bandpass', from: 4300 * vary(), q: 1.3, pan: [from, from] });
    burst(ctx, out, start, {
      at: 0.06 * d,
      length: 0.66 * d,
      peak: 0.17,
      attack: 0.27 * d,
      filter: 'bandpass',
      from: 650 * vary(),
      to: 2900 * vary(),
      q: 0.7,
      pan: [from, to],
    });
    burst(ctx, out, start, { at: 0.16 * d, length: 0.5 * d, peak: 0.06, attack: 0.2 * d, filter: 'lowpass', from: 520, pan: [from * 0.5, to * 0.5] });
    burst(ctx, out, start, { at: 0.83 * d, length: 0.12, peak: 0.13, attack: 0.005, filter: 'lowpass', from: 1500 * vary(), pan: [to, to] });
    burst(ctx, out, start, { at: 0.85 * d, length: 0.05, peak: 0.045, attack: 0.003, filter: 'highpass', from: 3200, pan: [to, to] });
    return;
  }

  burst(ctx, out, start, { at: 0, length: 0.18, peak: 0.07, attack: 0.02, filter: 'bandpass', from: 1150 * vary(), q: 2.2, pan: [from, from] });
  burst(ctx, out, start, {
    at: 0.08 * d,
    length: 0.62 * d,
    peak: 0.15,
    attack: 0.3 * d,
    filter: 'bandpass',
    from: 380 * vary(),
    to: 1400 * vary(),
    q: 0.6,
    pan: [from, to],
  });
  burst(ctx, out, start, { at: 0.86 * d, length: 0.16, peak: 0.24, attack: 0.004, filter: 'lowpass', from: 420, pan: [to * 0.6, to * 0.6] });
  thud(ctx, out, start + 0.86 * d, 0.22);
}
