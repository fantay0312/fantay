// SPDX-License-Identifier: AGPL-3.0-only
// The empty board, shown what it is for. A sentence is sent in the chat, the agent's tool rows arrive, a line runs from
// the file it wrote to the board, and the page builds in place inside its node; a click selects it and the context bar
// offers the three ways to keep working. It plays once and holds the result: this sits beside a running agent, so it
// never loops. Everything is drawn on the real dotted canvas, so nodes float on it as real nodes do (`unframed`).
// In a narrow workspace the chat card sits over the node and starts from the sent message: the real chat is beside it.
//
// Real strings: the prompt, the tool rows, the page's name, headline and button, the three modes. Everything else in
// the page is filler. Files keep their names in every language.
import { useMemo } from 'react';
import { ArrowUp, Crop, Eye, FilePlus2, MousePointerClick, Plus, SquarePen } from 'lucide-react';

import { Collapse, Connector } from '../../vendor/stageshow/motion';
import { Bar } from '../../vendor/stageshow/window';
import { Stage, type StageProps } from '../../vendor/stageshow/stage';
import type { Act } from '../../vendor/stageshow/act';
import { Spinner } from '../../vendor/stageshow/parts';
import './look.css';
import './board-demo.css';

export interface BoardDemoCopy {
  prompt: string;
  placeholder: string;
  read: string;
  create: string;
  brand: string;
  headline: string;
  cta: string;
  navigate: string;
  edit: string;
  capture: string;
}

interface Scene {
  draft: string;
  /** The composer text left for the thread. */
  sent: boolean;
  readRow: boolean;
  createRow: boolean;
  /** The agent finished writing the file: the diff shows, the row stops spinning. */
  written: boolean;
  linked: boolean;
  /** 0: only the dashed slot. 1: the node, as skeleton. 2: the page, resolved. */
  node: 0 | 1 | 2;
  hovered: boolean;
  selected: boolean;
}

const INITIAL: Scene = {
  draft: '',
  sent: false,
  readRow: false,
  createRow: false,
  written: false,
  linked: false,
  node: 0,
  hovered: false,
  selected: false,
};

const POSTER: Scene = {
  ...INITIAL,
  sent: true,
  readRow: true,
  createRow: true,
  written: true,
  linked: true,
  node: 2,
  selected: true,
};

const FILE = 'index.html';
const ADDED = '+214';

function script(prompt: string) {
  return async (a: Act<Scene>) => {
    await a.wait(500);
    if (a.layout === 'wide') {
      a.mark('type');
      await a.type('draft', prompt, { interval: Math.round(Math.min(60, 1200 / prompt.length)) });
      await a.wait(300);
      a.mark('send');
      await a.click({ at: 'send', x: 0.6, y: 0.6 });
    }
    a.put({ sent: true, draft: '' });
    await a.wait(520);
    a.put({ readRow: true });
    await a.wait(620);
    a.mark('write');
    a.put({ createRow: true });
    await a.wait(900);
    a.put({ written: true });
    await a.wait(260);
    a.mark('link');
    a.put({ node: 1 });
    await a.wait(160);
    a.put({ linked: true });
    await a.wait(800);
    a.mark('resolve');
    a.put({ node: 2 });
    await a.wait(1300);
    a.mark('select');
    await a.move({ at: 'slot', x: 0.66, y: 0.36 });
    a.put({ hovered: true });
    await a.wait(260);
    await a.click();
    a.put({ selected: true, hovered: false });
    await a.wait(2600);
  };
}

function Page({ copy, state }: { copy: BoardDemoCopy; state: 0 | 1 | 2 }) {
  const ready = state === 2 || undefined;
  return (
    <div className="bd-page" data-ready={ready}>
      <div className="bd-page__nav">
        <span className="bd-slot" data-delay="0">
          <Bar w={46} h={7} r={3.5} tone={2} className="bd-sk" />
          <span className="bd-real bd-page__brand">{copy.brand}</span>
        </span>
        <span className="bd-page__links">
          <Bar w={26} h={5} r={2.5} tone={2} />
          <Bar w={22} h={5} r={2.5} tone={2} />
          <Bar w={28} h={5} r={2.5} tone={2} />
        </span>
      </div>
      <div className="bd-page__art bd-slot" data-delay="1" data-crop>
        <Bar w="100%" h={128} r={0} tone={1} className="bd-sk" />
        <img className="bd-real" src="/stageshow/garden-4.jpg" alt="" draggable={false} />
      </div>
      <div className="bd-page__copy">
        <div className="bd-slot bd-page__headline-slot" data-delay="2">
          <Bar w={132} h={13} r={4} tone={2} className="bd-sk" />
          <div className="bd-real bd-page__headline">{copy.headline}</div>
        </div>
        <div className="bd-slot bd-page__cta-slot" data-delay="3">
          <Bar w={72} h={24} r={12} tone={2} className="bd-sk" />
          <span className="bd-real bd-page__cta">{copy.cta}</span>
        </div>
      </div>
    </div>
  );
}

const COMPACT: StageProps<Scene>['compact'] = { below: 500, width: 344, height: 418 };

export interface BoardDemoProps {
  copy: BoardDemoCopy;
  theme: 'light' | 'dark';
}

export function BoardDemo({ copy, theme }: BoardDemoProps) {
  const run = useMemo(() => script(copy.prompt), [copy.prompt]);
  return (
    <Stage<Scene>
      width={540}
      height={336}
      compact={COMPACT}
      initial={INITIAL}
      poster={POSTER}
      script={run}
      play="once"
      theme={theme}
      unframed
      cursor={{ at: { wide: { x: 232, y: 300 }, compact: { x: 300, y: 400 } } }}
      className="fd-demo bd"
    >
      {(s, rect) => {
        const file = rect('file');
        const chat = rect('chat');
        const slot = rect('slot');
        const from = { x: chat.x + chat.width, y: file.y + file.height / 2 };
        const to = { x: slot.x - 7, y: slot.y + slot.height / 2 };
        return (
          <>
            <div className="bd-slotframe" data-target="slot" data-gone={s.node > 0 || undefined} />
            <div className="bd-label" data-on={s.node > 0 || undefined} data-selected={s.selected || undefined}>
              {FILE}
            </div>
            <div
              className="bd-node"
              data-target="node"
              data-on={s.node > 0 || undefined}
              data-hover={s.hovered || undefined}
              data-selected={s.selected || undefined}
            >
              <Page copy={copy} state={s.node} />
              <span className="bd-handles" aria-hidden>
                <i data-c="tl" />
                <i data-c="tr" />
                <i data-c="bl" />
                <i data-c="br" />
              </span>
            </div>

            <Connector from={from} to={to} show={s.linked} route="curve" className="bd-link" />

            <div className="bd-chat" data-target="chat" data-sent={s.sent || undefined}>
              <Collapse open={s.sent} reveal="drop" from="below">
                <div className="bd-bubble">{copy.prompt}</div>
              </Collapse>
              <Collapse open={s.readRow} className="bd-readrow">
                <div className="bd-tool">
                  <Eye size={14} strokeWidth={1.75} aria-hidden />
                  <span>{copy.read}</span>
                  <code>layout.css</code>
                </div>
              </Collapse>
              <Collapse open={s.createRow}>
                <div className="bd-tool">
                  <FilePlus2 size={14} strokeWidth={1.75} aria-hidden />
                  <span>{copy.create}</span>
                  <code className="bd-tool__file" data-target="file">
                    {FILE}
                  </code>
                  <span className="bd-tool__stat">
                    <span className="bd-tool__pending" data-on={!s.written || undefined}>
                      <Spinner size={12} />
                    </span>
                    <span className="bd-tool__diff" data-on={s.written || undefined}>
                      {ADDED}
                    </span>
                  </span>
                </div>
              </Collapse>
              <div className="bd-composer" data-focus={!s.sent || undefined}>
                <div className="bd-composer__text" data-typing>
                  {s.draft}
                  {!s.sent ? <span className="bd-caret" /> : null}
                  {s.draft ? null : <span className="bd-composer__hint">{copy.placeholder}</span>}
                </div>
                <div className="bd-composer__foot">
                  <span className="bd-disc" data-kind="ghost">
                    <Plus size={13} strokeWidth={1.75} aria-hidden />
                  </span>
                  <span className="bd-disc" data-kind="send" data-target="send" data-ready={s.draft.length > 0 || undefined}>
                    <ArrowUp size={13} strokeWidth={2} aria-hidden />
                  </span>
                </div>
              </div>
            </div>

            <div className="bd-dock">
              <div className="bd-bar" data-on={s.selected || undefined}>
                <span>
                  <MousePointerClick size={14} strokeWidth={1.75} aria-hidden />
                  {copy.navigate}
                </span>
                <span>
                  <SquarePen size={14} strokeWidth={1.75} aria-hidden />
                  {copy.edit}
                </span>
                <span>
                  <Crop size={14} strokeWidth={1.75} aria-hidden />
                  {copy.capture}
                </span>
              </div>
            </div>
          </>
        );
      }}
    </Stage>
  );
}
