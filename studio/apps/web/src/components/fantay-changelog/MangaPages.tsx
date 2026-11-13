// SPDX-License-Identifier: AGPL-3.0-only
// What is printed on each volume: its cover, its spine, and the four pages inside (two story pages, contents, a
// "to be continued" page). Pages are pure functions of the volume, so the reader can place any page on either side
// of the spread, or on either face of the leaf being turned.
import type { ReactNode } from 'react';

import { Bubble, Caption, FocusLines, InkMascot, Sfx, SpeedLines, Starburst, Tone, type InkMascotMood, type InkMascotStyle } from './MangaArt';
import type { MangaChrome, MangaCover, MangaVolume, MangaVolumeCopy } from './volumes';
import styles from './FantayChangelog.module.css';

export interface VolumeContext {
  volume: MangaVolume;
  copy: MangaVolumeCopy;
  /** Zero-based position in the series. */
  index: number;
  total: number;
  /** Copy of the following volume, or null on the newest one. */
  next: MangaVolumeCopy | null;
  chrome: MangaChrome;
}

export type PageSide = 'left' | 'right';
export const PAGE_COUNT = 4;

const COVER_LOOK: Record<MangaCover, InkMascotStyle> = {
  blue: 'paper',
  coral: 'color',
  paper: 'color',
  ink: 'color',
  green: 'color',
};
const COVER_MOOD: readonly InkMascotMood[] = ['calm', 'happy', 'wink', 'shock'];

export function dottedDate(date: string): string {
  return date.split('-').join('.');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** A per-volume seed, so every volume's lines fall differently but always the same way. */
function seedOf(ctx: VolumeContext): number {
  return (ctx.index + 1) * 97;
}

export function CoverArt({ ctx }: { ctx: VolumeContext }) {
  const { volume, copy, index, chrome } = ctx;
  return (
    <span className={styles.cover} data-cover={volume.cover}>
      <span className={styles.coverTop}>
        <span className={styles.coverLogo}>Fantay</span>
        <span className={styles.coverLogoSub} aria-hidden>
          <span>漫画</span>
          <span>COMICS</span>
        </span>
        <span className={styles.coverBadge} aria-hidden>
          {index + 1}
        </span>
      </span>
      <span className={styles.coverArt}>
        <Tone fade="radial" className={styles.coverTone} />
        <InkMascot look={COVER_LOOK[volume.cover]} mood={COVER_MOOD[index % COVER_MOOD.length]} className={styles.coverMascot} />
        <Sfx className={styles.coverSfx}>{volume.sfx[0]}</Sfx>
      </span>
      <span className={styles.coverFoot}>
        <span className={styles.coverVol}>{chrome.volume(index + 1)}</span>
        <span className={styles.coverTitle}>{copy.title}</span>
        <span className={styles.coverMeta}>
          <span>{dottedDate(volume.date)}</span>
          <span className={styles.coverBarcode} aria-hidden />
        </span>
      </span>
    </span>
  );
}

export function SpineArt({ ctx }: { ctx: VolumeContext }) {
  return (
    <span className={styles.spineArt} data-cover={ctx.volume.cover} aria-hidden>
      <span className={styles.spineNo}>{ctx.index + 1}</span>
      <span className={styles.spineTitle}>{ctx.copy.title}</span>
      <span className={styles.spineSeries}>Fantay</span>
    </span>
  );
}

function StoryLeft({ ctx }: { ctx: VolumeContext }) {
  const { volume, copy } = ctx;
  const seed = seedOf(ctx);
  const first = copy.chapters[0];
  return (
    <div className={styles.storyLeft}>
      <section className={`${styles.panel} ${styles.p1}`}>
        <Tone fade="down" />
        <SpeedLines angle={-14} seed={seed + 1} className={styles.faint} />
        <Starburst className={styles.p1Burst} seed={seed}>
          {copy.tagline}
        </Starburst>
        <InkMascot mood="happy" className={styles.p1Mascot} mirrored />
        <Sfx className={styles.p1Sfx}>{volume.sfx[0]}</Sfx>
      </section>
      <section className={`${styles.panel} ${styles.p2}`}>
        <FocusLines x={52} y={74} inner={34} seed={seed + 2} className={styles.faint} />
        {first ? (
          <Bubble tail="left" className={styles.p2Bubble}>
            {first.head}
          </Bubble>
        ) : null}
        <InkMascot className={styles.p2Mascot} />
      </section>
      <section className={`${styles.panel} ${styles.panelInk} ${styles.p3}`}>
        <InkMascot look="inverse" mood="shock" className={styles.p3Mascot} mirrored />
        <span className={styles.p3Mark} aria-hidden>
          …！
        </span>
      </section>
      <section className={`${styles.panel} ${styles.p4}`}>
        <span className={styles.hatch} aria-hidden />
        {first ? <Caption className={styles.p4Caption}>{first.text}</Caption> : null}
        <InkMascot mood="wink" className={styles.p4Mascot} />
      </section>
    </div>
  );
}

function StoryRight({ ctx }: { ctx: VolumeContext }) {
  const { volume, copy, next, chrome } = ctx;
  const seed = seedOf(ctx);
  const second = copy.chapters[1];
  const third = copy.chapters[2];
  return (
    <div className={styles.storyRight}>
      <section className={`${styles.panel} ${styles.p5}`}>
        <Tone fade="left" />
        <InkMascot className={styles.p5Mascot} />
        {second ? (
          <>
            <Bubble tail="left" className={styles.p5Bubble}>
              {second.head}
            </Bubble>
            <Caption dark className={styles.p5Caption}>
              {second.text}
            </Caption>
          </>
        ) : null}
      </section>
      <section className={`${styles.panel} ${styles.p6a}`}>
        <FocusLines x={50} y={96} inner={30} count={56} seed={seed + 3} />
        <InkMascot mood="shock" className={styles.p6Mascot} />
        <Sfx className={styles.p6Sfx}>{volume.sfx[1]}</Sfx>
      </section>
      <section className={`${styles.panel} ${styles.p6b}`}>
        <Tone fade="up" />
        {third ? (
          <>
            <Bubble tail="right" className={styles.p6Bubble}>
              {third.head}
            </Bubble>
            <Caption className={styles.p6Caption}>{third.text}</Caption>
          </>
        ) : null}
      </section>
      <section className={`${styles.panel} ${styles.panelInk} ${styles.p7}`}>
        <SpeedLines angle={-8} seed={seed + 4} className={styles.p7Lines} />
        <p className={styles.p7Kicker}>
          <span>{chrome.nextChapter}</span>
          {chrome.echo ? <span aria-hidden>NEXT</span> : null}
        </p>
        <p className={styles.p7Title}>{next ? next.title : chrome.toBeContinued}</p>
        <InkMascot look="inverse" mood="happy" className={styles.p7Mascot} />
        <Sfx className={styles.p7Sfx}>{volume.sfx[2]}</Sfx>
      </section>
    </div>
  );
}

function Contents({ ctx }: { ctx: VolumeContext }) {
  const { volume, copy, index, chrome } = ctx;
  return (
    <div className={styles.contents}>
      <header className={styles.contentsHead}>
        <span className={styles.contentsTitle}>{chrome.contents}</span>
        {chrome.echo ? (
          <span className={styles.contentsEn} aria-hidden>
            CONTENTS
          </span>
        ) : null}
        <span className={styles.contentsVol}>{chrome.volume(index + 1)}</span>
      </header>
      <ol className={styles.contentsList}>
        {copy.chapters.map((chapter, i) => (
          <li key={chapter.head} className={styles.contentsItem}>
            <span className={styles.contentsNo}>{pad(i + 1)}</span>
            <span className={styles.contentsBody}>
              <strong>{chapter.head}</strong>
              <span>{chapter.text}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className={styles.contentsQuote}>{chrome.quote(copy.tagline)}</p>
      <footer className={styles.colophon}>
        <InkMascot mood="wink" className={styles.colophonMascot} />
        <span className={styles.colophonText}>
          <span>{copy.title}</span>
          <span>
            {chrome.published} Fantay · {dottedDate(volume.date)} · {chrome.volume(index + 1)}
          </span>
        </span>
      </footer>
    </div>
  );
}

function Continued({ ctx }: { ctx: VolumeContext }) {
  const { index, next, chrome } = ctx;
  return (
    <div className={styles.continued}>
      <section className={`${styles.panel} ${styles.continuedPanel}`}>
        <p className={styles.continuedTitle}>{chrome.toBeContinued}</p>
        <p className={styles.continuedSub} aria-hidden>
          to be continued
        </p>
        <span className={styles.continuedHalo} aria-hidden>
          <FocusLines x={50} y={50} inner={30} count={80} seed={seedOf(ctx) + 5} />
          <Tone fade="radial" dense />
        </span>
        <InkMascot mood="calm" className={styles.continuedMascot} />
        <p className={styles.continuedBand}>
          {next ? chrome.nextVolume(index + 2, next.title) : chrome.comingSoon(index + 2)}
        </p>
      </section>
    </div>
  );
}

const PAGES: ReadonlyArray<(props: { ctx: VolumeContext }) => ReactNode> = [StoryLeft, StoryRight, Contents, Continued];

/** One printed page, dressed for the side of the spread it lands on. */
export function MangaPage({ ctx, page, side }: { ctx: VolumeContext; page: number; side: PageSide }) {
  const Content = PAGES[page];
  return (
    <div className={styles.page} data-side={side}>
      <div className={styles.pageBody}>{Content ? <Content ctx={ctx} /> : null}</div>
      <footer className={styles.folio} aria-hidden>
        <span>{side === 'left' ? page + 1 : ''}</span>
        <span>
          Fantay · {ctx.chrome.volume(ctx.index + 1)} · {dottedDate(ctx.volume.date)}
        </span>
        <span>{side === 'right' ? page + 1 : ''}</span>
      </footer>
    </div>
  );
}
