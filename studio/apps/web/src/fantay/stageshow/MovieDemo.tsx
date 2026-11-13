// SPDX-License-Identifier: AGPL-3.0-only
// The empty film library, shown the path from one sentence to a finished film. The brief is sent, the storyboard
// resolves shot by shot, the shots are approved, and the playhead runs the film from seed to flower until it is
// delivered. The frames are real: they come from the sample film the app ships. It plays once and holds the flower.
//
// Real strings: the brief, the approve button, the delivered status, the shot durations.
import { useMemo } from 'react';
import { ArrowUp, Check } from 'lucide-react';

import type { Act } from '../../vendor/stageshow/act';
import { States } from '../../vendor/stageshow/motion';
import { Stage } from '../../vendor/stageshow/stage';
import './look.css';
import './movie-demo.css';

export interface MovieDemoCopy {
  brief: string;
  placeholder: string;
  approve: string;
  delivered: string;
}

interface Scene {
  draft: string;
  sent: boolean;
  /** Storyboard shots resolved so far. */
  shots: number;
  /** The shot on the big frame; -1 before there is one. */
  frame: number;
  /** The shot the playhead is on while the film runs; -1 otherwise. */
  active: number;
  run: boolean;
  status: 'send' | 'approve' | 'delivered';
}

const SHOTS = [
  { src: '/stageshow/garden-1.jpg', seconds: 3 },
  { src: '/stageshow/garden-2.jpg', seconds: 3 },
  { src: '/stageshow/garden-3.jpg', seconds: 3 },
  { src: '/stageshow/garden-4.jpg', seconds: 3 },
] as const;

const INITIAL: Scene = { draft: '', sent: false, shots: 0, frame: -1, active: -1, run: false, status: 'send' };
const POSTER: Scene = { draft: '', sent: true, shots: 4, frame: 3, active: -1, run: true, status: 'delivered' };
const RUN_MS = 2800;

function script(brief: string) {
  return async (a: Act<Scene>) => {
    await a.wait(500);
    a.mark('type');
    await a.type('draft', brief, { interval: Math.round(Math.min(60, 1200 / brief.length)) });
    await a.wait(300);
    a.mark('send');
    await a.click({ at: 'send', x: 0.6, y: 0.6 });
    a.put({ sent: true });
    await a.wait(500);
    a.mark('storyboard');
    for (let shot = 1; shot <= SHOTS.length; shot += 1) {
      a.put({ shots: shot, frame: shot - 1 });
      await a.wait(420);
    }
    a.put({ status: 'approve' });
    await a.wait(900);
    a.mark('approve');
    await a.click({ at: 'approve', x: 0.97, y: 0.84 });
    a.put({ run: true, frame: 0, active: 0 });
    void a.move({ x: 470, y: 150 }, { duration: 700 });
    for (let shot = 1; shot < SHOTS.length; shot += 1) {
      await a.wait(RUN_MS / SHOTS.length);
      a.put({ frame: shot, active: shot });
    }
    await a.wait(RUN_MS / SHOTS.length);
    a.mark('delivered');
    a.put({ active: -1, status: 'delivered' });
    await a.wait(2600);
  };
}

export interface MovieDemoProps {
  copy: MovieDemoCopy;
  theme: 'light' | 'dark';
}

export function MovieDemo({ copy, theme }: MovieDemoProps) {
  const run = useMemo(() => script(copy.brief), [copy.brief]);
  return (
    <Stage<Scene>
      width={504}
      height={296}
      initial={INITIAL}
      poster={POSTER}
      script={run}
      play="once"
      theme={theme}
      unframed
      cursor={{ at: { x: 488, y: 64 } }}
      className="fd-demo md"
    >
      {(s) => (
        <>
          <div className="md-field">
            <span className="md-field__text" data-typing>
              {s.sent ? copy.brief : s.draft}
              {!s.sent ? <span className="md-caret" /> : null}
              {!s.sent && !s.draft ? <span className="md-field__hint">{copy.placeholder}</span> : null}
            </span>
            <States
              className="md-field__action"
              align="end"
              value={s.status === 'delivered' ? 'delivered' : s.status === 'approve' ? 'approve' : s.sent ? 'none' : 'send'}
              states={{
                none: <span />,
                send: (
                  <span className="md-send" data-target="send" data-ready={s.draft.length > 0 || undefined}>
                    <ArrowUp size={14} strokeWidth={2} aria-hidden />
                  </span>
                ),
                approve: (
                  <span className="md-approve" data-target="approve">
                    {copy.approve}
                  </span>
                ),
                delivered: (
                  <span className="md-delivered">
                    <Check size={14} strokeWidth={2} aria-hidden />
                    {copy.delivered}
                  </span>
                ),
              }}
            />
          </div>

          <div className="md-frame">
            {SHOTS.map((shot, index) => (
              <img key={shot.src} src={shot.src} alt="" draggable={false} data-on={s.frame === index || undefined} />
            ))}
          </div>

          <div className="md-strip">
            {SHOTS.map((shot, index) => (
              <div
                key={shot.src}
                className="md-shot"
                data-ready={s.shots > index || undefined}
                data-active={s.active === index || undefined}
              >
                <img src={shot.src} alt="" draggable={false} />
                <span className="md-shot__n">{index + 1}</span>
                <span className="md-shot__s">{shot.seconds}s</span>
              </div>
            ))}
            <span
              className="md-playhead"
              data-on={s.shots === SHOTS.length || undefined}
              data-run={s.run || undefined}
              data-gone={s.status === 'delivered' || undefined}
            />
          </div>
        </>
      )}
    </Stage>
  );
}
