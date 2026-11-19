// SPDX-License-Identifier: AGPL-3.0-only
// Fantay's changelog as a manga series. The shelf shows every release as a tankōbon volume on a 3D staircase,
// with the newest in front; opening one turns its cover and reads it as a two-spread comic (story, then contents
// and "to be continued"). Every turn is a real leaf with a front and a back, so pages never swap in place. Paper
// leaves bend as they turn and every turn is heard; past the last page an end card offers the next volume instead of
// dropping the reader back on the shelf.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type WheelEvent,
} from 'react';

import { Button, Dialog } from '@open-design/components';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';
import { InkMascot, Tone } from './MangaArt';
import { CoverArt, MangaPage, PAGE_COUNT, SpineArt, dottedDate, type VolumeContext } from './MangaPages';
import { playTurnSound, setSoundEnabled, soundEnabled, type TurnSound } from './pageSound';
import { MANGA_VOLUMES, cjkNumber, mangaChrome, mangaLocale } from './volumes';
import './manga-fonts.css';
import styles from './FantayChangelog.module.css';

type TurnKind = 'open' | 'close' | 'next' | 'prev';
type Mode = 'shelf' | 'reader';

/** Three spreads: story act I, story act II, then contents beside "to be continued". */
const SPREADS = [
  [0, 1],
  [2, 3],
  [4, 5],
] as const;
/** Covers are board and swing a touch slower than paper. */
const TURN_MS: Record<TurnKind, number> = { open: 980, close: 920, next: 900, prev: 900 };
const TURN_SOUND: Record<TurnKind, TurnSound> = {
  open: 'cover-open',
  close: 'cover-close',
  next: 'page-forward',
  prev: 'page-back',
};
/** Reduced motion lands a turn at once, so its sound is just the flick. */
const INSTANT_TURN_SOUND_MS = 280;
/** Where a turning page bends, as fractions of its width from the spine. Each strip hinges on the edge of the last. */
const LEAF_STRIPS = [0, 0.42, 0.72, 1] as const;
const WHEEL_STEP = 48;
const WHEEL_REST_MS = 260;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Where a volume stands on the staircase. `age` counts volumes back from the one in front: older ones recede up and
 * to the right into the distance, newer ones (while reading back) step down to the left.
 */
function shelfPlacement(age: number): CSSProperties {
  const distance = Math.abs(age);
  const sign = Math.sign(age);
  const reach = distance === 0 ? 0 : 1 + (distance - 1) * 0.8;
  return {
    '--bx': `${sign * reach * 12}vw`,
    '--by': `${-sign * reach * 8}vh`,
    '--bz': `${-distance * 200}px`,
    '--rot': distance === 0 ? '16deg' : '24deg',
    '--dim': String(Math.min(distance * 0.07, 0.35)),
    '--i': String(distance),
    zIndex: 100 - distance,
  } as CSSProperties;
}

/** Rolling digits: each column holds 0–9 and slides to its digit. */
function Odometer({ value }: { value: string }) {
  return (
    <span className={styles.odometer} aria-hidden>
      {value.split('').map((char, i) =>
        /\d/.test(char) ? (
          <span key={i} className={styles.odoCol} style={{ '--digit': Number(char), '--delay': `${i * 70}ms` } as CSSProperties}>
            <span className={styles.odoReel}>
              {Array.from({ length: 10 }, (_, d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={i} className={styles.odoDot}>
            {char}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * One strip of a turning paper page, carrying the next strip on its outer edge. Both faces show the whole page,
 * shifted so this strip shows its own slice: the front from the spine outwards, the back mirrored onto the left page.
 */
function LeafStrip({ index, front, back }: { index: number; front: ReactNode; back: ReactNode }) {
  const from = LEAF_STRIPS[index]!;
  const to = LEAF_STRIPS[index + 1]!;
  return (
    <div className={styles.strip} data-strip={index} style={{ '--span': to - from } as CSSProperties}>
      <div className={styles.stripFace} data-face="front">
        <div className={styles.stripPage} style={{ '--shift': -from } as CSSProperties}>
          {front}
        </div>
      </div>
      <div className={styles.stripFace} data-face="back">
        <div className={styles.stripPage} style={{ '--shift': to - 1 } as CSSProperties}>
          {back}
        </div>
      </div>
      {index + 2 < LEAF_STRIPS.length ? <LeafStrip index={index + 1} front={front} back={back} /> : null}
    </div>
  );
}

function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 5 6 9H2v6h4l5 4z" />
      {on ? (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      ) : (
        <>
          <path d="m22 9-6 6" />
          <path d="m16 9 6 6" />
        </>
      )}
    </svg>
  );
}

export function FantayChangelog({ onClose }: { onClose: () => void }) {
  const { locale, t } = useI18n();
  const lang = mangaLocale(locale);
  const chrome = mangaChrome(lang);
  const total = MANGA_VOLUMES.length;

  const [active, setActive] = useState(total - 1);
  const [mode, setMode] = useState<Mode>('shelf');
  const [spread, setSpread] = useState(0);
  const [turn, setTurn] = useState<TurnKind | null>(null);
  const [turnTarget, setTurnTarget] = useState<number | null>(null);
  /** The last page has been turned: the end card is up. */
  const [finished, setFinished] = useState(false);
  const [sound, setSound] = useState(soundEnabled);

  const bookRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const finaleAction = useRef<HTMLButtonElement | null>(null);
  const turnTimer = useRef<number | null>(null);
  const wheel = useRef({ sum: 0, at: 0 });
  const focusBook = useRef(false);

  const contexts = useMemo<VolumeContext[]>(
    () =>
      MANGA_VOLUMES.map((volume, index) => ({
        volume,
        copy: volume.copy[lang],
        index,
        total,
        next: MANGA_VOLUMES[index + 1]?.copy[lang] ?? null,
        chrome,
      })),
    [chrome, lang, total],
  );
  const current = contexts[active] ?? contexts[contexts.length - 1]!;
  const upNext = contexts[active + 1] ?? null;

  useEffect(
    () => () => {
      if (turnTimer.current != null) window.clearTimeout(turnTimer.current);
    },
    [],
  );

  // Keyboard browsing moves focus with the volume in front, so Enter always opens what the eye is on.
  useEffect(() => {
    if (!focusBook.current || mode !== 'shelf') return;
    focusBook.current = false;
    bookRefs.current[active]?.focus({ preventScroll: true });
  }, [active, mode]);

  const browse = useCallback(
    (step: number) => setActive((index) => Math.max(0, Math.min(total - 1, index + step))),
    [total],
  );

  // The end card takes focus, so Enter reads on and Tab stays inside the choices.
  useEffect(() => {
    if (finished) finaleAction.current?.focus({ preventScroll: true });
  }, [finished]);

  /** Runs a page turn with its sound; state lands when the leaf does. Under reduced motion it lands at once. */
  const runTurn = useCallback((kind: TurnKind, land: () => void, target: number | null = null) => {
    if (reducedMotion()) {
      playTurnSound(TURN_SOUND[kind], INSTANT_TURN_SOUND_MS);
      land();
      return;
    }
    playTurnSound(TURN_SOUND[kind], TURN_MS[kind]);
    setTurnTarget(target);
    setTurn(kind);
    turnTimer.current = window.setTimeout(() => {
      turnTimer.current = null;
      setTurn(null);
      setTurnTarget(null);
      land();
    }, TURN_MS[kind]);
  }, []);

  const openBook = useCallback(() => {
    if (turn) return;
    setFinished(false);
    setSpread(0);
    setMode('reader');
    runTurn('open', () => undefined);
  }, [runTurn, turn]);

  const closeBook = useCallback(() => {
    if (turn) return;
    setFinished(false);
    runTurn('close', () => {
      setMode('shelf');
      setSpread(0);
      focusBook.current = true;
    });
  }, [runTurn, turn]);

  const nextPage = useCallback(() => {
    if (turn || finished) return;
    if (spread >= SPREADS.length - 1) {
      setFinished(true);
      return;
    }
    runTurn('next', () => setSpread((s) => s + 1));
  }, [finished, runTurn, spread, turn]);

  const prevPage = useCallback(() => {
    if (turn) return;
    if (finished) {
      setFinished(false);
      return;
    }
    if (spread === 0) return;
    runTurn('prev', () => setSpread((s) => s - 1));
  }, [finished, runTurn, spread, turn]);

  /** Closes this volume and opens the next one in its place, without leaving the reader. */
  const readNext = useCallback(() => {
    if (turn || active >= total - 1) return;
    setFinished(false);
    runTurn('close', () => {
      setActive((index) => Math.min(total - 1, index + 1));
      setSpread(0);
      runTurn('open', () => undefined);
    });
  }, [active, runTurn, total, turn]);

  const readAgain = useCallback(() => {
    if (turn) return;
    setFinished(false);
    if (spread === 0) return;
    runTurn('prev', () => setSpread(0), 0);
  }, [runTurn, spread, turn]);

  const toggleSound = useCallback(() => {
    const next = !soundEnabled();
    setSoundEnabled(next);
    setSound(next);
  }, []);

  useEffect(() => {
    // Captured on window and stopped there: while the series is open it owns the keyboard, so Escape steps back one
    // level (book → shelf → closed) instead of also closing the Settings or Update dialog underneath.
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key;
      const onButton = event.target instanceof HTMLElement && event.target.closest('button') != null;
      const take = (action: () => void) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      };
      if (mode === 'reader' && finished) {
        // The end card is one more level: Escape or ← puts the book back on its last spread, → reads on.
        if (key === 'Escape' || key === 'ArrowLeft' || key === 'PageUp') take(() => setFinished(false));
        else if (key === 'ArrowRight' || key === 'PageDown') take(upNext ? readNext : readAgain);
        return;
      }
      if (key === 'Escape') {
        take(mode === 'reader' ? closeBook : onClose);
        return;
      }
      if (mode === 'reader') {
        if (key === 'ArrowRight' || key === 'PageDown' || (key === ' ' && !onButton)) take(nextPage);
        else if (key === 'ArrowLeft' || key === 'PageUp') take(prevPage);
        return;
      }
      const jump = (to: (index: number) => number) =>
        take(() => {
          focusBook.current = true;
          setActive((index) => Math.max(0, Math.min(total - 1, to(index))));
        });
      // Older volumes stand up and to the right, so → and ↑ walk back in time.
      if (key === 'ArrowRight' || key === 'ArrowUp') jump((i) => i - 1);
      else if (key === 'ArrowLeft' || key === 'ArrowDown') jump((i) => i + 1);
      else if (key === 'Home') jump(() => total - 1);
      else if (key === 'End') jump(() => 0);
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [closeBook, finished, mode, nextPage, onClose, prevPage, readAgain, readNext, total, upNext]);

  const onShelfWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      const now = performance.now();
      const state = wheel.current;
      if (now - state.at > WHEEL_REST_MS) state.sum = 0;
      state.at = now;
      state.sum += Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (Math.abs(state.sum) < WHEEL_STEP) return;
      // Scrolling down walks into the distance, toward older volumes.
      browse(state.sum > 0 ? -1 : 1);
      state.sum = 0;
    },
    [browse],
  );

  // What each slot of the open book shows while a leaf is (or is not) in the air.
  const [restLeft, restRight] = SPREADS[spread] ?? SPREADS[0];
  let left: number | null = restLeft;
  let right: number | null = restRight;
  let leaf: { front: 'cover' | number; back: number } | null = null;
  if (turn === 'open') {
    left = null;
    right = SPREADS[0][1];
    leaf = { front: 'cover', back: SPREADS[0][0] };
  } else if (turn === 'close') {
    left = null;
    leaf = { front: 'cover', back: restLeft };
  } else if (turn === 'next') {
    const to = SPREADS[spread + 1] ?? SPREADS[spread]!;
    right = to[1];
    leaf = { front: restRight, back: to[0] };
  } else if (turn === 'prev') {
    const to = SPREADS[turnTarget ?? spread - 1] ?? SPREADS[0];
    left = to[0];
    leaf = { front: to[1], back: restLeft };
  }

  const dateKey = current.volume.date.slice(5).replace('-', '.');
  const year = current.volume.date.slice(0, 4);

  return (
    <Dialog
      onClose={onClose}
      closeOnBackdrop={false}
      includeChromeClassName={false}
      ariaLabel={chrome.dialogLabel}
      className={styles.root}
      backdropClassName={styles.backdrop}
      data-mode={mode}
      data-testid="fantay-changelog"
    >
      <Tone fade="radial" className={styles.cornerTone} />
      {/* ── Shelf ─────────────────────────────────────────────── */}
      <div className={styles.shelf} aria-hidden={mode !== 'shelf'}>
        <aside className={styles.meta} aria-live="polite">
          <p className={styles.metaKicker}>
            <span className={styles.metaVol}>{chrome.volume(active + 1)}</span>
            <span aria-hidden>·</span>
            <span>
              VOLUME {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
            </span>
          </p>
          <p className={styles.metaDate}>
            <span className={styles.metaYear} aria-hidden>
              {year}
            </span>
            <Odometer value={dateKey} />
          </p>
          <p key={current.volume.id} className={styles.metaTitle}>
            <span>{current.copy.title}</span>
            <span className={styles.metaTagline}>{current.copy.tagline}</span>
          </p>
          <dl className={styles.metaTable}>
            {current.volume.version ? <div><dt><span>{locale.startsWith('zh') ? '版本' : 'VERSION'}</span></dt><dd>{current.volume.version}</dd></div> : null}
            {(
              [
                [chrome.released, 'RELEASED', dottedDate(current.volume.date)],
                [chrome.chapters, 'CHAPTERS', chrome.chapterCount(current.copy.chapters.length)],
                [chrome.seriesRow, 'SERIES', chrome.seriesCount(total)],
              ] as const
            ).map(([label, echo, value]) => (
              <div key={echo}>
                <dt>
                  <span>{label}</span>
                  {chrome.echo ? <span aria-hidden>{echo}</span> : null}
                </dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </aside>

        <section className={styles.stage} onWheel={mode === 'shelf' ? onShelfWheel : undefined}>
          <div className={styles.track}>
            {contexts.map((ctx, i) => {
              const offset = i - active;
              return (
                <button
                  key={ctx.volume.id}
                  ref={(node) => {
                    bookRefs.current[i] = node;
                  }}
                  type="button"
                  className={styles.book}
                  data-front={offset === 0 ? '' : undefined}
                  style={shelfPlacement(-offset)}
                  tabIndex={offset === 0 && mode === 'shelf' ? 0 : -1}
                  aria-label={chrome.openVolume(i + 1, ctx.copy.title, dottedDate(ctx.volume.date))}
                  aria-current={offset === 0 ? 'true' : undefined}
                  onClick={() => (offset === 0 ? openBook() : setActive(i))}
                >
                  <span className={styles.bookBody}>
                    <span className={styles.bookSpine}>
                      <SpineArt ctx={ctx} />
                    </span>
                    <span className={styles.bookTop} aria-hidden />
                    <span className={styles.bookFront}>
                      <CoverArt ctx={ctx} />
                    </span>
                  </span>
                  <span className={styles.bookShadow} aria-hidden />
                </button>
              );
            })}
          </div>
        </section>

        <aside className={styles.brand} aria-hidden>
          <span className={styles.tategaki}>
            <span className={styles.tategakiMain}>漫画　全{cjkNumber(total)}卷</span>
            <span className={styles.tategakiSub}>{cjkNumber(Number(year), true)}年　秋</span>
            <span className={styles.tategakiLatin}>Fantay · Changelog</span>
          </span>
        </aside>

        <p className={styles.hint}>{chrome.hint}</p>
      </div>

      {/* ── Reader ────────────────────────────────────────────── */}
      {mode === 'reader' ? (
        <div className={styles.reader}>
          <header className={styles.readerBar}>
            <Button variant="ghost" size="sm" className={styles.barButton} onClick={closeBook} disabled={turn != null}>
              <Icon name="arrow-left" size={14} />
              <span>{chrome.shelf}</span>
            </Button>
            <p className={styles.readerTitle}>
              {chrome.series} · {chrome.volume(active + 1)} · {current.copy.title}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className={`${styles.barButton} ${styles.soundToggle}`}
              aria-label={sound ? chrome.soundOn : chrome.soundOff}
              title={sound ? chrome.soundOn : chrome.soundOff}
              onClick={toggleSound}
            >
              <SoundIcon on={sound} />
            </Button>
          </header>

          <div
            className={styles.spread}
            data-turn={turn ?? undefined}
            style={turn ? ({ '--m-turn-ms': `${TURN_MS[turn]}ms` } as CSSProperties) : undefined}
          >
            <div className={styles.slot} data-side="left" onClick={prevPage}>
              {left != null ? <MangaPage ctx={current} page={left} side="left" /> : null}
            </div>
            <div className={styles.slot} data-side="right" onClick={nextPage}>
              {right != null ? <MangaPage ctx={current} page={right} side="right" /> : null}
            </div>
            {leaf ? (
              <div className={styles.leaf} data-turn={turn ?? undefined} aria-hidden>
                {leaf.front === 'cover' ? (
                  <>
                    <div className={styles.leafFront}>
                      <span className={styles.leafCover}>
                        <CoverArt ctx={current} />
                      </span>
                    </div>
                    <div className={styles.leafBack}>
                      <MangaPage ctx={current} page={leaf.back} side="left" />
                    </div>
                  </>
                ) : (
                  <LeafStrip
                    index={0}
                    front={<MangaPage ctx={current} page={leaf.front} side="right" />}
                    back={<MangaPage ctx={current} page={leaf.back} side="left" />}
                  />
                )}
              </div>
            ) : null}
          </div>

          <footer className={styles.readerFoot}>
            <Button
              variant="ghost"
              size="icon"
              className={styles.barButton}
              aria-label={chrome.prevPage}
              disabled={turn != null || spread === 0}
              onClick={prevPage}
            >
              <Icon name="chevron-left" size={16} />
            </Button>
            <span className={styles.pageOf}>{chrome.pageOf(restLeft + 1, restRight + 1, PAGE_COUNT)}</span>
            <Button
              variant="ghost"
              size="icon"
              className={styles.barButton}
              aria-label={chrome.nextPage}
              disabled={turn != null}
              onClick={nextPage}
            >
              <Icon name="chevron-right" size={16} />
            </Button>
            <span className={styles.readHint}>{chrome.readHint}</span>
          </footer>

          {finished ? (
            <div className={styles.finale} onClick={() => setFinished(false)}>
              <section
                className={styles.finaleCard}
                role="dialog"
                aria-label={chrome.volumeEnd(active + 1)}
                onClick={(event) => event.stopPropagation()}
              >
                <Tone fade="radial" className={styles.finaleTone} />
                {upNext ? (
                  <span className={styles.finaleCover} aria-hidden>
                    <CoverArt ctx={upNext} />
                  </span>
                ) : (
                  <InkMascot look="color" mood="wink" pose="wave" className={styles.finaleMascot} />
                )}
                <div className={styles.finaleBody}>
                  <p className={styles.finaleKicker}>{chrome.volumeEnd(active + 1)}</p>
                  {upNext ? (
                    <>
                      <p className={styles.finaleLabel}>
                        <span>{chrome.nextChapter}</span>
                        {chrome.echo ? <span aria-hidden>NEXT</span> : null}
                      </p>
                      <p className={styles.finaleTitle}>
                        <span>{chrome.volume(upNext.index + 1)}</span>
                        <strong>{upNext.copy.title}</strong>
                      </p>
                      <p className={styles.finaleText}>{upNext.copy.tagline}</p>
                    </>
                  ) : (
                    <>
                      <p className={styles.finaleTitle}>
                        <strong>{chrome.latestTitle}</strong>
                      </p>
                      <p className={styles.finaleText}>{chrome.latestBody}</p>
                    </>
                  )}
                  <div className={styles.finaleActions}>
                    <Button
                      ref={finaleAction}
                      variant="primary"
                      className={styles.finalePrimary}
                      onClick={upNext ? readNext : readAgain}
                    >
                      <span>{upNext ? chrome.readNext : chrome.readAgain}</span>
                      {upNext ? <Icon name="arrow-right" size={14} /> : null}
                    </Button>
                    <Button variant="ghost" className={styles.finaleSecondary} onClick={closeBook}>
                      {chrome.backToShelf}
                    </Button>
                  </div>
                </div>
              </section>
            </div>
          ) : null}
        </div>
      ) : null}

      <Button variant="ghost" size="icon" className={styles.close} aria-label={t('common.close')} onClick={onClose}>
        <Icon name="close" size={16} />
      </Button>
    </Dialog>
  );
}
