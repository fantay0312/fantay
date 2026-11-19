// SPDX-License-Identifier: AGPL-3.0-only
// Shared Soul building blocks (Soul UI spec §8.7, §4.4, §10.2). Plain props only: no workspace context, no i18n of
// their own (every visible or spoken string arrives as a prop). Transcript pieces paint with `--pa-skin-*`, chrome
// pieces with base tokens. The frames never align themselves: the cluster that holds them puts them at the start or
// the end, so a hover pill beside a bubble stays next to it.
import { Dices, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { PaChatTheme } from '@open-design/contracts';
import { PA_THEME_META } from '@open-design/contracts/soul';

import { Button, Callout, Chip, Icon, IconButton, Input, MinusIcon, PlusIcon, Spinner, VisuallyHidden, XIcon, cn } from '../../ui';
import styles from './SoulPrimitives.module.css';
import scopeStyles from './SoulThemeScope.module.css';

/** The 停止 action beside a typing bubble stays visible for good once the turn has run this long (spec §4.4.11). */
const STOP_PINNED_AFTER_MS = 8000;
/** ASCII and full-width commas both end a tag. */
const TAG_SEPARATOR = /[,，]/;

function flag(on: boolean | undefined): '' | undefined {
  return on ? '' : undefined;
}

function revealDelay(index: number | undefined): CSSProperties {
  return { '--pa-reveal-delay': Math.max(0, Math.floor(index ?? 0)) } as CSSProperties;
}

/* ── SoulTag ─────────────────────────────────────────────────────────────────────────────── */

export interface SoulTagProps {
  children: ReactNode;
  tone?: 'neutral' | 'outline' | 'solid' | 'warn';
  /** Inside a theme scope: hairline / accent tones from `--pa-skin-*`. */
  skin?: boolean;
  icon?: ReactNode;
  className?: string;
}

/** A static label (not focusable): 18 high, caption type, four tones. */
export function SoulTag({ children, tone = 'neutral', skin = false, icon, className }: SoulTagProps) {
  return (
    <span data-slot="soul-tag" data-tone={tone} data-skin={flag(skin)} className={cn(styles.tag, className)}>
      {icon ? (
        <span aria-hidden className={styles.tagIcon}>
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/* ── SoulTagInput ────────────────────────────────────────────────────────────────────────── */

export interface SoulTagInputProps {
  value: string[];
  onChange(next: string[]): void;
  max?: number;
  maxLength?: number;
  placeholder?: string;
  validate?(tag: string): boolean;
  id?: string;
  'aria-label'?: string;
  disabled?: boolean;
}

/** Removable tags plus a bare input. Enter or a comma (ASCII or full-width) adds, Backspace on an empty input removes
 *  the last tag, duplicates are ignored, `max` and `maxLength` hold, a tag failing `validate` shows the danger tone.
 *  A pending draft is added on blur, so a typed keyword is never lost to a save click. */
export function SoulTagInput({
  value,
  onChange,
  max,
  maxLength,
  placeholder,
  validate,
  id,
  'aria-label': ariaLabel,
  disabled = false,
}: SoulTagInputProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const full = max !== undefined && value.length >= max;

  const add = (parts: readonly string[]): void => {
    const next = [...value];
    for (const part of parts) {
      const tag = (maxLength !== undefined ? part.trim().slice(0, maxLength) : part.trim()).trim();
      if (!tag || next.includes(tag)) continue;
      if (max !== undefined && next.length >= max) break;
      next.push(tag);
    }
    if (next.length !== value.length) onChange(next);
  };

  const onDraft = (text: string): void => {
    if (!TAG_SEPARATOR.test(text)) {
      setDraft(text);
      return;
    }
    const parts = text.split(TAG_SEPARATOR);
    const rest = parts.pop() ?? '';
    add(parts);
    setDraft(rest);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && draft.trim() !== '') {
      event.preventDefault();
      if (full) return;
      add([draft]);
      setDraft('');
      return;
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  const onBlur = (): void => {
    if (draft.trim() === '' || full) return;
    add([draft]);
    setDraft('');
  };

  return (
    <div
      data-slot="soul-tag-input"
      data-disabled={flag(disabled)}
      className={styles.tagInput}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget || disabled) return;
        event.preventDefault();
        inputRef.current?.focus();
      }}
    >
      {value.map((tag, index) => {
        const invalid = validate ? !validate(tag) : false;
        return (
          <Chip
            key={`${index}:${tag}`}
            size="sm"
            variant="solid"
            tone={invalid ? 'danger' : 'default'}
            tabIndex={-1}
            data-invalid={flag(invalid)}
            className={cn('h-6', styles.tagChip)}
            onClick={() => inputRef.current?.focus()}
            onRemove={disabled ? undefined : () => onChange(value.filter((_, at) => at !== index))}
          >
            <span className={styles.tagChipText}>{tag}</span>
          </Chip>
        );
      })}
      <Input
        ref={inputRef}
        id={id}
        variant="bare"
        inputSize="auto"
        className={styles.tagField}
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        aria-label={ariaLabel}
        maxLength={maxLength}
        disabled={disabled}
        readOnly={full}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
    </div>
  );
}

/* ── SoulStepper ─────────────────────────────────────────────────────────────────────────── */

export interface SoulStepperProps {
  value: number;
  onChange(next: number): void;
  min: number;
  max: number;
  step?: number;
  format?(value: number): string;
  'aria-label': string;
  disabled?: boolean;
}

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** − · value · +, clamped to [min, max]. The value is a spin button (arrows, Page keys, Home, End); the two buttons
 *  stay out of the tab order, as in the ARIA spin button pattern. */
export function SoulStepper({ value, onChange, min, max, step = 1, format, 'aria-label': ariaLabel, disabled = false }: SoulStepperProps) {
  const set = (next: number): void => {
    const rounded = Number(next.toFixed(decimalsOf(step)));
    const clamped = Math.min(max, Math.max(min, rounded));
    if (clamped !== value) onChange(clamped);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLOutputElement>): void => {
    if (disabled) return;
    const moves: Partial<Record<string, number>> = {
      ArrowUp: value + step,
      ArrowRight: value + step,
      ArrowDown: value - step,
      ArrowLeft: value - step,
      PageUp: value + step * 10,
      PageDown: value - step * 10,
      Home: min,
      End: max,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    set(next);
  };
  const text = format ? format(value) : String(value);
  return (
    <div data-slot="soul-stepper" data-disabled={flag(disabled)} className={styles.stepper}>
      <IconButton
        size="sm"
        aria-label={`${ariaLabel} −`}
        tooltip={false}
        tabIndex={-1}
        disabled={disabled || value <= min}
        onClick={() => set(value - step)}
      >
        <MinusIcon />
      </IconButton>
      <output
        role="spinbutton"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={format ? text : undefined}
        aria-disabled={disabled || undefined}
        className={styles.stepperValue}
        onKeyDown={onKeyDown}
      >
        {text}
      </output>
      <IconButton
        size="sm"
        aria-label={`${ariaLabel} +`}
        tooltip={false}
        tabIndex={-1}
        disabled={disabled || value >= max}
        onClick={() => set(value + step)}
      >
        <PlusIcon />
      </IconButton>
    </div>
  );
}

/* ── tray chips ──────────────────────────────────────────────────────────────────────────── */

/** A suggested reply: fills the composer on click (the caller decides), staggered in by `index`. */
export function SoulChoiceChip({ children, onClick, index }: { children: ReactNode; onClick(): void; index?: number }) {
  return (
    <Chip variant="suggestion" size="sm" className={styles.trayChip} style={revealDelay(index)} onClick={() => onClick()}>
      <span className={styles.chipText}>{children}</span>
    </Chip>
  );
}

/** A story request the character made (roll a die, draw a card): one tap runs it. */
export function SoulPlayChip({ children, onClick, disabled = false, index }: { children: ReactNode; onClick(): void; disabled?: boolean; index?: number }) {
  return (
    <Chip
      variant="solid"
      size="sm"
      icon={<Icon icon={Dices} size={12} />}
      disabled={disabled}
      className={styles.trayChip}
      style={revealDelay(index)}
      onClick={() => onClick()}
    >
      <span className={styles.chipText}>{children}</span>
    </Chip>
  );
}

/* ── state bar and value ─────────────────────────────────────────────────────────────────── */

/** A monochrome meter for a bounded number: 44 × 4 in the strip (`sm`), full width × 6 in the inspector (`md`). The
 *  number itself is always printed next to it, so the bar is decorative. */
export function SoulStateBar({ value, min, max, size = 'sm' }: { value: number; min: number; max: number; size?: 'sm' | 'md' }) {
  const span = max - min;
  const ratio = span > 0 && Number.isFinite(value) ? Math.min(1, Math.max(0, (value - min) / span)) : 0;
  return (
    <span
      aria-hidden
      data-slot="soul-state-bar"
      data-size={size}
      className={styles.bar}
      style={{ '--pa-bar': Math.round(ratio * 10000) / 10000 } as CSSProperties}
    >
      <span className={styles.barFill} />
    </span>
  );
}

/** Label 12 faint + value 12 / 500 tabular. Never ellipsized (owner rule O4): the caller drops whole cells instead. */
export function SoulStateValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span data-slot="soul-state-value" className={styles.stateValue}>
      <span className={styles.stateLabel}>{label}</span>
      <span className={styles.stateText}>{children}</span>
    </span>
  );
}

/* ── transcript frames ───────────────────────────────────────────────────────────────────── */

/** A story item (roll, draw, event): a centred card on the paper, captioned 故事 · …, never attributed to anyone. */
export function SoulStoryFrame({
  kind,
  caption,
  ariaLabel,
  entering = false,
  children,
}: {
  kind: 'roll' | 'draw' | 'event';
  caption: ReactNode;
  ariaLabel: string;
  entering?: boolean;
  children: ReactNode;
}) {
  return (
    <div role="note" aria-label={ariaLabel} data-testid="pa-soul-story" data-kind={kind} data-enter={flag(entering)} className={styles.story}>
      <div className={styles.storyCaption}>{caption}</div>
      {children}
    </div>
  );
}

export interface SoulTypingBubbleProps {
  portrait: ReactNode;
  label: string;
  startedAt?: number;
  trailing?: ReactNode;
  /** Stage 1 prop, kept: one live bubble of plain text. */
  text?: string;
  /** The live bubbles, already rendered, one node per bubble (wins over `text` when not empty). */
  parts?: readonly ReactNode[];
  /** Same index as `parts`: true draws that part as unboxed narration. */
  narration?: readonly boolean[];
  /** 'live' (default): the reply is still being written. 'stopped' / 'failed': the dimmed draft that was not saved. */
  tone?: 'live' | 'stopped' | 'failed';
  /** The line under a stopped or failed draft. */
  footer?: ReactNode;
  /** Optional line above the dots or the live bubbles, e.g. the journal's head line (the transcript's
   *  `.clusterHead`), so the stored entry that replaces the row starts at the same height. */
  head?: ReactNode;
}

type LivePosition = SoulBubbleFrameProps['position'];

/** Positions of the live bubbles: a boxed part joins its boxed neighbours, a narration part breaks the run. */
function livePositions(boxed: readonly boolean[]): Array<LivePosition | null> {
  return boxed.map((isBoxed, at) => {
    if (!isBoxed) return null;
    const prev = at > 0 && boxed[at - 1] === true;
    const next = at < boxed.length - 1 && boxed[at + 1] === true;
    if (prev) return next ? 'middle' : 'last';
    return next ? 'first' : 'single';
  });
}

/** Shown only while a real chat turn of the speaker runs; never a synthesised message. Without text: three dots.
 *  With `parts` (or `text`): the reply as it is being written, in the same bubbles a stored reply uses, the last one
 *  with a quiet caret; a bubble that grows keeps its place, a new one fades in. `tone` 'stopped' / 'failed' draws the
 *  same bubbles dimmed, without caret or dots, as the draft that was not saved, with `footer` under them. The
 *  trailing action pins once the turn has run 8 s, counted from `startedAt` (the turn's start) so a remount (a room's
 *  next speaker, reopening the chat) does not hide it again; without it the count starts at mount. */
export function SoulTypingBubble({
  portrait,
  label,
  text,
  trailing,
  startedAt,
  parts,
  narration,
  tone = 'live',
  footer,
  head,
}: SoulTypingBubbleProps) {
  const [mountedAt] = useState(() => Date.now());
  const start = startedAt ?? mountedAt;
  const [pinned, setPinned] = useState(() => Date.now() - start >= STOP_PINNED_AFTER_MS);
  useEffect(() => {
    const left = start + STOP_PINNED_AFTER_MS - Date.now();
    if (left <= 0) {
      setPinned(true);
      return undefined;
    }
    setPinned(false);
    const timer = window.setTimeout(() => setPinned(true), left);
    return () => window.clearTimeout(timer);
  }, [start]);
  const hasTrailing = trailing !== undefined && trailing !== null && trailing !== false;
  const trailingSlot = hasTrailing ? (
    <span data-pinned={flag(pinned)} className={styles.typingTrailing}>
      {trailing}
    </span>
  ) : null;
  const nodes: readonly ReactNode[] = parts && parts.length > 0 ? parts : text !== undefined && text !== '' ? [text] : [];
  const hasHead = head !== undefined && head !== null && head !== false;

  if (nodes.length === 0 && tone === 'live') {
    const line = (
      <span className={styles.typingLine}>
        <span className={styles.typingBubble}>
          <span aria-hidden data-slot="soul-typing-dots" className={styles.dots}>
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.dot} />
          </span>
        </span>
        {trailingSlot}
      </span>
    );
    return (
      <div role="status" aria-live="polite" aria-label={label} data-testid="pa-soul-typing" className={styles.typing}>
        <span aria-hidden className={styles.typingPortrait}>
          {portrait}
        </span>
        {hasHead ? (
          <div className={styles.liveBody}>
            {head}
            {line}
          </div>
        ) : (
          line
        )}
        <VisuallyHidden>{label}</VisuallyHidden>
      </div>
    );
  }

  const live = tone === 'live';
  const positions = livePositions(nodes.map((_, at) => narration?.[at] !== true));
  return (
    <div role="status" aria-live="polite" aria-label={label} data-testid="pa-soul-typing" data-tone={tone} className={styles.typing}>
      <span aria-hidden className={styles.typingPortrait}>
        {portrait}
      </span>
      <div className={styles.liveBody}>
        {hasHead ? head : null}
        <div aria-live="off" data-testid="pa-soul-live" data-tone={tone} className={styles.live}>
          {nodes.map((node, at) => {
            const last = at === nodes.length - 1;
            const caret = live && last;
            const content = (
              <div data-caret={flag(caret)} className={styles.liveText}>
                {typeof node === 'string' ? (
                  <span className={styles.livePlain}>
                    {node}
                    {caret ? <span aria-hidden data-slot="soul-live-caret" className={styles.caret} /> : null}
                  </span>
                ) : (
                  node
                )}
              </div>
            );
            const position = positions[at];
            return (
              <div key={at} data-slot="soul-live-part" className={styles.livePart}>
                {position ? (
                  <SoulBubbleFrame side="in" position={position}>
                    {content}
                  </SoulBubbleFrame>
                ) : (
                  <SoulNarration side="in">{content}</SoulNarration>
                )}
                {last ? trailingSlot : null}
              </div>
            );
          })}
        </div>
        {footer !== undefined && footer !== null && footer !== false ? <div className={styles.liveFooter}>{footer}</div> : null}
      </div>
      <VisuallyHidden>{label}</VisuallyHidden>
    </div>
  );
}

/* ── voice bar ───────────────────────────────────────────────────────────────────────────── */

export interface SoulVoiceBarLabels {
  play: string;
  pause: string;
  seek: string;
  loading: string;
  error: string;
  retry: string;
  /** Replaces the time while the browser refused to start playback. */
  blocked?: string;
}

export interface SoulVoiceBarProps {
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  /** Seconds. */
  currentTime: number;
  /** Seconds; null while unknown (seeking is off then). */
  duration: number | null;
  onToggle(): void;
  onSeek(ratio: number): void;
  onRetry?(): void;
  /** 'bubble': inside an incoming bubble, under its text; 'paper': on the paper under a message (journal, no box). */
  surface: 'bubble' | 'paper';
  side?: 'in' | 'out';
  labels: SoulVoiceBarLabels;
}

/** ← / → move this many seconds. */
const VOICE_STEP_S = 5;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** m:ss, whole seconds. */
function voiceClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The ratio under a pointer on the track (right to left in an RTL layout). */
function ratioAt(clientX: number, track: HTMLElement): number {
  const rect = track.getBoundingClientRect();
  if (!(rect.width > 0)) return 0;
  const raw = clamp01((clientX - rect.left) / rect.width);
  return getComputedStyle(track).direction === 'rtl' ? 1 - raw : raw;
}

/** The player of a reply's generated audio (stage 2 spec §5.1, §12.2): play / pause, a seekable track and the time.
 *  It only draws the state it is given; the audio store owns playback. 28 high. No waveform: there is none to show. */
export function SoulVoiceBar({ state, currentTime, duration, onToggle, onSeek, onRetry, surface, side = 'in', labels }: SoulVoiceBarProps) {
  const [drag, setDrag] = useState<number | null>(null);
  const known = duration !== null && Number.isFinite(duration) && duration > 0;
  const now = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  const ratio = drag ?? (known && duration ? clamp01(now / duration) : 0);
  const root = { 'data-testid': 'pa-soul-voice-bar', 'data-state': state, 'data-surface': surface, 'data-side': side, className: styles.voice };

  if (state === 'loading') {
    return (
      <div {...root}>
        <span className={styles.voiceLead}>
          <Spinner size="xs" />
        </span>
        <span className={styles.voiceNote}>{labels.loading}</span>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div {...root}>
        <span className={styles.voiceError}>{labels.error}</span>
        {onRetry ? (
          <Button variant="link" size="sm" className={styles.voiceRetry} onClick={() => onRetry()}>
            {labels.retry}
          </Button>
        ) : null}
      </div>
    );
  }

  const seek = (next: number): void => {
    if (known) onSeek(clamp01(next));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!known || !duration) return;
    const step = VOICE_STEP_S / duration;
    const at = clamp01(now / duration);
    const moves: Partial<Record<string, number>> = {
      ArrowRight: at + step,
      ArrowUp: at + step,
      ArrowLeft: at - step,
      ArrowDown: at - step,
      Home: 0,
      End: 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    seek(next);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!known || event.button > 0) return;
    event.preventDefault();
    const track = event.currentTarget;
    try {
      track.setPointerCapture(event.pointerId);
    } catch {
      // No capture (an old engine or a synthetic event): the drag still follows while the pointer stays on the track.
    }
    track.focus();
    const next = ratioAt(event.clientX, track);
    setDrag(next);
    seek(next);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return;
    const next = ratioAt(event.clientX, event.currentTarget);
    setDrag(next);
    seek(next);
  };
  const endDrag = (): void => setDrag(null);

  const playing = state === 'playing';
  const time = known && duration ? `${voiceClock(drag !== null ? drag * duration : now)} / ${voiceClock(duration)}` : `${voiceClock(now)} / —:—`;
  return (
    <div {...root}>
      <IconButton
        size="xs"
        aria-label={playing ? labels.pause : labels.play}
        tooltip={false}
        className={styles.voiceToggle}
        data-testid="pa-soul-voice-toggle"
        onClick={() => onToggle()}
      >
        <Icon icon={playing ? Pause : Play} size={12} fill="currentColor" />
      </IconButton>
      <div
        role="slider"
        tabIndex={0}
        aria-label={labels.seek}
        aria-valuemin={0}
        aria-valuemax={known && duration ? Math.round(duration) : 0}
        aria-valuenow={known && duration ? Math.round(ratio * duration) : 0}
        aria-valuetext={labels.blocked ?? time}
        aria-disabled={known ? undefined : true}
        data-testid="pa-soul-voice-seek"
        data-dragging={flag(drag !== null)}
        className={styles.voiceTrack}
        style={{ '--pa-voice': Math.round(ratio * 10000) / 10000 } as CSSProperties}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <span aria-hidden className={styles.voiceFill} />
        <span aria-hidden className={styles.voiceThumb} />
      </div>
      <span data-blocked={flag(labels.blocked !== undefined)} className={styles.voiceTime}>
        {labels.blocked ?? time}
      </span>
    </div>
  );
}

/** The state changes of a reply, joined with ` · `. With `onClick` the whole line is one link-styled button. */
export function SoulDeltaRow({ children, onClick, ariaLabel }: { children: ReactNode; onClick?(): void; ariaLabel?: string }) {
  return (
    <div data-testid="pa-soul-delta" className={styles.metaLine}>
      {onClick ? (
        <Button variant="link" size="sm" aria-label={ariaLabel} className={styles.deltaButton} onClick={() => onClick()}>
          {children}
        </Button>
      ) : (
        <>
          <span aria-hidden={ariaLabel ? true : undefined}>{children}</span>
          {ariaLabel ? <VisuallyHidden>{ariaLabel}</VisuallyHidden> : null}
        </>
      )}
    </div>
  );
}

/** A line under a reply or an owner bubble (想记下, 没有收到回复, 已编辑…). `failed` adds the 6 px failure dot. */
export function SoulMetaLine({ children, align = 'start', tone = 'meta' }: { children: ReactNode; align?: 'start' | 'end'; tone?: 'meta' | 'failed' }) {
  return (
    <div data-slot="soul-meta-line" data-align={align} data-tone={tone} className={styles.metaLine}>
      {children}
    </div>
  );
}

/** The care card's frame: a neutral callout on app tokens (never the theme), end-aligned, with an optional dismiss. */
export function SoulCareFrame({ children, dismissLabel, onDismiss }: { children: ReactNode; dismissLabel: string; onDismiss?(): void }) {
  return (
    <Callout tone="neutral" role="note" data-testid="pa-soul-care" className={styles.care}>
      <div className={styles.careBody}>{children}</div>
      {onDismiss ? (
        <IconButton size="xs" aria-label={dismissLabel} onClick={() => onDismiss()}>
          <XIcon />
        </IconButton>
      ) : null}
    </Callout>
  );
}

export interface SoulBubbleFrameProps {
  side: 'in' | 'out';
  position: 'single' | 'first' | 'middle' | 'last';
  pending?: boolean;
  hidden?: boolean;
  editing?: boolean;
  dimmed?: boolean;
  rich?: boolean;
  entering?: boolean;
  messageId?: string;
  children: ReactNode;
}

/** One bubble: flat (1 px border, no shadow), the theme's fill and ink, radius by position in the cluster. */
export function SoulBubbleFrame({
  side,
  position,
  pending = false,
  hidden = false,
  editing = false,
  dimmed = false,
  rich = false,
  entering = false,
  messageId,
  children,
}: SoulBubbleFrameProps) {
  return (
    <div
      data-testid="pa-soul-bubble"
      data-side={side}
      data-position={position}
      data-message-id={messageId}
      data-pending={flag(pending)}
      data-hidden={flag(hidden)}
      data-editing={flag(editing)}
      data-dimmed={flag(dimmed)}
      data-rich={flag(rich)}
      data-enter={flag(entering)}
      className={styles.bubble}
    >
      {children}
    </div>
  );
}

/** A split bubble that is only narration: unboxed, softer, a half pixel smaller. */
export function SoulNarration({ side, children }: { side: 'in' | 'out'; children: ReactNode }) {
  return (
    <div data-testid="pa-soul-narration" data-side={side} className={styles.narration}>
      {children}
    </div>
  );
}

/** A day or gap label between two 24 px hairlines, in the theme's display face. */
export function SoulSeparator({ children }: { children: ReactNode }) {
  return (
    <div data-slot="soul-separator" className={styles.separator}>
      {children}
    </div>
  );
}

/** 70 × 44: the theme's paper (and its own pattern) with one incoming and one outgoing mini bubble. Decorative: the
 *  picker prints the theme name under it. */
export function SoulThemeSwatch({ theme }: { theme: PaChatTheme }) {
  return (
    <span
      aria-hidden
      data-slot="soul-theme-swatch"
      data-pa-skin={theme}
      data-pa-pattern={PA_THEME_META[theme]?.pattern ?? 'none'}
      className={cn(scopeStyles.paper, styles.swatch)}
    >
      <span className={styles.swatchIn} />
      <span className={styles.swatchOut} />
    </span>
  );
}

export interface SoulPreviewChatLabels {
  date: string;
  incoming: string;
  narration: string;
  outgoing: string;
  rollCaption: string;
  rollLabel: string;
  delta: string;
  /** The journal layout's head line over the incoming entry (name · time); shown only in the journal. */
  name?: string;
  time?: string;
}

/* The sample roll of the preview (dice notation is data, not copy). */
const PREVIEW_ROLL = { notation: 'd20+2', die: 12, modifier: '+2', total: 14 } as const;

/** The static sample conversation of the appearance modal, built from the transcript's own pieces: a separator, an
 *  incoming cluster (one bubble, one narration line), an outgoing bubble, a roll card and a delta line. Place it in a
 *  SoulThemeScope; it follows the app's light or dark mode, and the scope's layout, frame, pattern and accent (the
 *  journal draws the same pieces as entries on the paper, plus the head line when `labels.name` is given). */
export function SoulPreviewChat({ portrait, labels }: { portrait: ReactNode; labels: SoulPreviewChatLabels }) {
  return (
    <div aria-hidden data-slot="soul-preview-chat" className={styles.preview}>
      <div className={styles.previewWide}>
        <SoulSeparator>{labels.date}</SoulSeparator>
      </div>
      <span className={styles.previewPortrait}>{portrait}</span>
      <div className={styles.previewIncoming}>
        {labels.name ? (
          <span data-slot="soul-preview-head" className={styles.previewHead}>
            <span className={styles.previewHeadName}>{labels.name}</span>
            {labels.time ? <span className={styles.previewHeadTime}>{labels.time}</span> : null}
          </span>
        ) : null}
        <SoulBubbleFrame side="in" position="single">
          {labels.incoming}
        </SoulBubbleFrame>
        <SoulNarration side="in">
          <em className={styles.previewAction}>{labels.narration}</em>
        </SoulNarration>
      </div>
      <div className={styles.previewOutgoing}>
        <SoulBubbleFrame side="out" position="single">
          {labels.outgoing}
        </SoulBubbleFrame>
      </div>
      <div className={styles.previewWide}>
        <SoulStoryFrame kind="roll" caption={labels.rollCaption} ariaLabel={labels.rollCaption}>
          <div className={styles.rollHead}>
            <span className={styles.rollLabel}>{labels.rollLabel}</span>
            <span className={styles.rollNotation}>{PREVIEW_ROLL.notation}</span>
          </div>
          <div className={styles.rollBody}>
            <span className={styles.die}>{PREVIEW_ROLL.die}</span>
            <span className={styles.rollModifier}>{PREVIEW_ROLL.modifier}</span>
            <span className={styles.rollTotal}>
              =<span className={styles.rollTotalValue}>{PREVIEW_ROLL.total}</span>
            </span>
          </div>
        </SoulStoryFrame>
      </div>
      <div className={styles.previewDelta}>
        <SoulDeltaRow>{labels.delta}</SoulDeltaRow>
      </div>
    </div>
  );
}
