// SPDX-License-Identifier: AGPL-3.0-only
// The welcome page's right column: one request to Fantay, and what comes back. Five tiles on five grounds make one
// picture. The lead tile is the conversation; a sentence is typed and sent, and the other four answer it in turn: the
// team's steps tick, two references are picked from the library, the page lands on the canvas and the film is cut.
// Two requests alternate, so the loop never rewinds: a new request clears the last one, and the thread carries the old
// bubble out as the new one arrives. Fantay itself never leaves: one living mascot, working or answering. The loop
// opens and ends on a finished picture, which is also the reduced-motion poster.
//
// Real strings: the request, the reply, the three team rows, the file name, the timecode, the library's name. The
// imagery is the app's own (community templates, covers, film samples); no image appears in two tiles.
// The tiles are laid out in design pixels; the host fits the stage to the column and it scales as one picture.
import { useMemo, type CSSProperties } from 'react';
import { ArrowUp, Check as Tick, Plus } from 'lucide-react';

import { Collapse, Roll } from '../../vendor/stageshow/motion';
import { Check } from '../../vendor/stageshow/parts';
import { Stage } from '../../vendor/stageshow/stage';
import type { Act } from '../../vendor/stageshow/act';
import { FantayMascot } from '../brand/FantayMascot';
import { PaAvatar } from '../pa/PaAvatar';
import type { PersonalAgent } from '../pa/pa-types';
import { FeatureIcon } from '../ui/feature-icon';
import './look.css';
import './welcome-demo.css';

export interface WelcomeDemoBrief {
  ask: string;
  reply: string;
}

export interface WelcomeDemoMember {
  name: string;
  step: string;
}

export interface WelcomeDemoCopy {
  placeholder: string;
  working: string;
  group: string;
  library: string;
  /** Researcher, Fantay, reviewer: the order their steps run in. */
  team: readonly [WelcomeDemoMember, WelcomeDemoMember, WelcomeDemoMember];
  briefs: readonly [WelcomeDemoBrief, WelcomeDemoBrief];
}

type BriefIndex = 0 | 1;

interface Scene {
  draft: string;
  /** The open turn: 0 is the finished turn the scene opens on, 1 and 2 are the two requests. */
  slot: 0 | 1 | 2;
  /** Characters of the reply written so far; 0 while the team is still working. */
  said: number;
  /** Team steps finished, and the one in progress (-1: none). */
  done: number;
  active: number;
  /** Whose references are ticked in the library (-1: none). */
  picks: -1 | BriefIndex;
  page: BriefIndex;
  film: BriefIndex;
  shot: number;
  /** The playhead is shown, and it travels rather than jumps. */
  head: boolean;
  run: boolean;
}

const ALL = 999;

const INITIAL: Scene = {
  draft: '',
  slot: 0,
  said: ALL,
  done: 3,
  active: -1,
  picks: 1,
  page: 1,
  film: 1,
  shot: 2,
  head: true,
  run: false,
};

/** Which request each turn slot holds. Slot 0 repeats the second, so the loop's last frame is its first. */
const SLOT_BRIEF: readonly BriefIndex[] = [1, 0, 1];

/** The second page's artwork has rounded corners of its own: `trim` draws it a little large so they fall outside. */
const PAGES: readonly { src: string; trim?: boolean }[] = [
  { src: '/community-templates/kanban-board.webp' },
  { src: '/community-templates/open-design-landing.webp', trim: true },
];

const FILMS = [
  ['/mock-covers/cover-7.jpg', '/mock-covers/cover-4.jpg', '/mock-covers/cover-11.jpg', '/mock-covers/cover-6.jpg'],
  ['/mock-covers/cover-0.jpg', '/mock-covers/cover-2.jpg', '/mock-covers/cover-1.jpg', '/mock-covers/cover-3.jpg'],
] as const;

const TIMES = ['00:01', '00:04', '00:07', '00:10'] as const;

/** Three columns; the third and the last row run off the tile, so the picks sit in the first two of each.
 *  The style-catalog boards are three panels side by side: `zoom` shows the middle one alone. */
const SHELF: readonly { src: string; zoom?: boolean }[] = [
  { src: '/mock-covers/cover-8.jpg' },
  { src: '/onboarding/onboarding-cloud-art.webp' },
  { src: '/mock-covers/cover-5.jpg' },
  { src: '/mock-covers/cover-9.jpg' },
  { src: '/community-templates/wireframe-greybox.webp' },
  { src: '/mock-covers/cover-10.jpg' },
  { src: '/style-catalog/v1/thumbnails/image-risograph-print-v1.webp', zoom: true },
  { src: '/style-catalog/v1/thumbnails/image-chrome-3d-v1.webp', zoom: true },
  { src: '/style-catalog/v1/thumbnails/image-poster-retro-pop-v1.webp', zoom: true },
  { src: '/style-catalog/v1/thumbnails/image-image-surreal-collage-v1.webp', zoom: true },
  { src: '/style-catalog/v1/thumbnails/image-watercolor-v1.webp', zoom: true },
  { src: '/style-catalog/v1/thumbnails/image-image-clay-3d-v1.webp', zoom: true },
];

const PICKS: readonly (readonly number[])[] = [
  [0, 3],
  [1, 4],
];

function member(id: string, name: string, avatar: string): PersonalAgent {
  return { id, name, avatar } as PersonalAgent;
}

function script(copy: WelcomeDemoCopy) {
  return async (a: Act<Scene>) => {
    await a.wait(1100);
    for (const brief of [0, 1] as const) {
      const { ask, reply } = copy.briefs[brief];
      a.mark(`ask-${brief}`);
      await a.type('draft', ask, { interval: Math.round(Math.min(64, 1300 / ask.length)) });
      await a.wait(380);
      // The new request clears the last one's marks as one thing; its turn leaves as this one arrives.
      a.put({ draft: '', slot: brief === 0 ? 1 : 2, said: 0, done: 0, active: -1, picks: -1 });
      await a.wait(1100);
      a.mark(`team-${brief}`);
      a.put({ active: 0 });
      await a.wait(780);
      a.put({ picks: brief });
      await a.wait(640);
      a.put({ done: 1, active: 1 });
      await a.wait(620);
      a.mark(`page-${brief}`);
      a.put({ page: brief });
      await a.wait(1150);
      a.mark(`film-${brief}`);
      // The playhead leaves, the new film starts at its first shot, and the playhead comes back to run it.
      a.put({ head: false, run: false });
      await a.wait(200);
      a.put({ film: brief, shot: 0 });
      await a.wait(360);
      a.put({ head: true });
      await a.wait(240);
      a.put({ run: true, shot: 1 });
      await a.wait(720);
      a.put({ shot: 2 });
      await a.wait(760);
      a.put({ done: 2, active: 2, run: false });
      await a.wait(980);
      a.put({ done: 3, active: -1 });
      await a.wait(300);
      a.mark(`reply-${brief}`);
      const letters = Array.from(reply).length;
      for (let i = 1; i <= letters; i += 1) {
        a.put({ said: i });
        await a.wait(24);
      }
      a.put({ said: ALL });
      await a.wait(2400);
    }
  };
}

/** One request's bubble. Three slots share the thread: the one arriving opens under the one leaving. */
function Ask({ copy, slot, s }: { copy: WelcomeDemoCopy; slot: 0 | 1 | 2; s: Scene }) {
  return (
    <Collapse open={s.slot === slot} reveal="drop" from="below">
      <p className="wd-ask">{copy.briefs[SLOT_BRIEF[slot] ?? 0].ask}</p>
    </Collapse>
  );
}

export interface WelcomeDemoProps {
  copy: WelcomeDemoCopy;
  theme: 'light' | 'dark';
  /** The stage's design size: the host derives it from the column's shape. */
  width: number;
  height: number;
}

export function WelcomeDemo({ copy, theme, width, height }: WelcomeDemoProps) {
  const run = useMemo(() => script(copy), [copy]);
  const cast = useMemo(
    () => [member('ag-researcher', copy.team[0].name, ''), member('ag-fantay', copy.team[1].name, 'fantay'), member('ag-reviewer', copy.team[2].name, '')],
    [copy],
  );
  return (
    <Stage<Scene> width={width} height={height} fill initial={INITIAL} poster={INITIAL} script={run} play="loop" theme={theme} className="fd-demo wd">
      {(s) => (
        <div className="wd-grid">
          <div className="wd-tile wd-talk">
            <div className="wd-thread">
              <Ask copy={copy} slot={0} s={s} />
              <Ask copy={copy} slot={1} s={s} />
              <Ask copy={copy} slot={2} s={s} />
            </div>
            {/* Fantay stays: one living mascot, and one line that is either the work in hand or the reply. */}
            <div className="wd-answer">
              <span className="wd-face">
                <FantayMascot size={64} mood={s.said === 0 ? 'working' : 'idle'} />
              </span>
              <span className="wd-say">
                <span className="wd-working" data-on={s.said === 0 || undefined}>
                  {copy.working}
                </span>
                {copy.briefs.map((brief, i) => {
                  const on = s.said > 0 && SLOT_BRIEF[s.slot] === i;
                  return (
                    <span key={i} className="wd-reply" data-on={on || undefined}>
                      {Array.from(brief.reply).map((letter, at) => (
                        <span key={at} data-on={(on && at < s.said) || undefined}>
                          {letter}
                        </span>
                      ))}
                    </span>
                  );
                })}
              </span>
            </div>
            <div className="wd-composer">
              <span className="wd-disc" data-kind="ghost">
                <Plus size={18} strokeWidth={2} aria-hidden />
              </span>
              <span className="wd-input">
                {s.draft ? (
                  <>
                    {s.draft}
                    <i className="wd-caret" />
                  </>
                ) : (
                  <span className="wd-hint">{copy.placeholder}</span>
                )}
              </span>
              <span className="wd-disc" data-kind="send" data-ready={s.draft ? '' : undefined}>
                <ArrowUp size={18} strokeWidth={2.4} aria-hidden />
              </span>
            </div>
          </div>

          <div className="wd-tile wd-board">
            <span className="wd-label">index.html</span>
            <div className="wd-node">
              {PAGES.map(({ src, trim }, i) => (
                <img key={src} src={src} alt="" draggable={false} decoding="async" data-on={s.page === i || undefined} data-trim={trim || undefined} />
              ))}
            </div>
            <span className="wd-select" aria-hidden>
              <i data-c="tl" />
              <i data-c="tr" />
            </span>
          </div>

          <div className="wd-tile wd-team">
            <div className="wd-team__name">{copy.group}</div>
            {copy.team.map((row, i) => (
              <div key={row.name} className="wd-member" data-state={i < s.done ? 'done' : i === s.active ? 'busy' : 'idle'}>
                <PaAvatar agent={cast[i] ?? null} size={36} fantay={i === 1} disc={i === 1} />
                <span className="wd-member__copy">
                  <strong>{row.name}</strong>
                  <span>{row.step}</span>
                </span>
                <Check on={i < s.done} pending={i === s.active} size={20} />
              </div>
            ))}
          </div>

          <div className="wd-tile wd-film">
            <div className="wd-frame">
              {FILMS.flatMap((shots, film) =>
                shots.map((src, shot) => (
                  <img key={src} src={src} alt="" draggable={false} decoding="async" data-on={(s.film === film && s.shot === shot) || undefined} />
                )),
              )}
              <span className="wd-time">
                <Roll>{TIMES[s.shot] ?? TIMES[0]}</Roll>
                <i>/ 00:12</i>
              </span>
            </div>
            <div className="wd-strip" style={{ '--wd-p': (s.shot + 0.5) / 4 } as CSSProperties}>
              {[0, 1, 2, 3].map((shot) => (
                <span key={shot} className="wd-shot" data-active={shot === s.shot || undefined}>
                  {FILMS.map((shots, film) => (
                    <img key={film} src={shots[shot]} alt="" draggable={false} decoding="async" data-on={s.film === film || undefined} />
                  ))}
                </span>
              ))}
              <i className="wd-head" data-on={s.head || undefined} data-run={s.run || undefined} />
            </div>
          </div>

          <div className="wd-tile wd-shelf">
            <div className="wd-shelf__name">
              <FeatureIcon name="materials" size={22} />
              <span>{copy.library}</span>
            </div>
            <div className="wd-thumbs">
              {SHELF.map(({ src, zoom }, i) => {
                const owner = PICKS.findIndex((picks) => picks.includes(i));
                const order = owner < 0 ? 0 : (PICKS[owner] ?? []).indexOf(i);
                return (
                  <span key={src} className="wd-thumb" data-picked={(owner >= 0 && owner === s.picks) || undefined} style={{ '--wd-i': order } as CSSProperties}>
                    <img src={src} alt="" draggable={false} decoding="async" data-zoom={zoom || undefined} />
                    <i className="wd-pick">
                      <Tick size={12} strokeWidth={3} aria-hidden />
                    </i>
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Stage>
  );
}
