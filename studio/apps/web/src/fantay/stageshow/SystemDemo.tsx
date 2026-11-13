// SPDX-License-Identifier: AGPL-3.0-only
// The project's design-system tab before one is chosen, shown what the choice does. A pick in the real chooser sends
// the agent back to the file, and only when its rewrite lands does the page take the system's type, shape and colour.
// Choosing never restyles a page by itself, so the demo keeps the tool row between the click and the change. It plays
// once and holds the second system. The two systems and their colours are real catalogue entries.
//
// The real chooser button sits right under this scene, so the scene shows only its open menu.
//
// Real strings: the catalogue names, the tool row, the page's name, headline and button.
import { Check, PenLine } from 'lucide-react';

import type { Act } from '../../vendor/stageshow/act';
import { Collapse, States } from '../../vendor/stageshow/motion';
import { Spinner } from '../../vendor/stageshow/parts';
import { Stage, type StageProps } from '../../vendor/stageshow/stage';
import { Bar } from '../../vendor/stageshow/window';
import './look.css';
import './system-demo.css';

export interface SystemDemoCopy {
  edit: string;
  brand: string;
  headline: string;
  cta: string;
}

type Look = 'plain' | 'editorial' | 'brutal';

interface Scene {
  picked: number;
  look: Look;
  tool: 'hidden' | 'pending' | 'done';
}

const SYSTEMS = [
  { id: 'editorial', name: 'Warm Editorial', swatches: ['ed-paper', 'ed-accent', 'ed-forest'] },
  { id: 'brutal', name: 'Neobrutalism', swatches: ['nb-primary', 'nb-secondary', 'nb-text'] },
  { id: 'kami', name: 'Kami', swatches: ['ka-paper', 'ka-ink', 'ka-text'] },
] as const;

const FILE = 'index.html';
const INITIAL: Scene = { picked: -1, look: 'plain', tool: 'hidden' };
const POSTER: Scene = { picked: 1, look: 'brutal', tool: 'done' };
const COMPACT: StageProps<Scene>['compact'] = { below: 470, width: 344, height: 364 };

async function script(a: Act<Scene>) {
  await a.wait(900);
  a.mark('first');
  await a.click({ at: 'row-0', x: 0.7, y: 0.62 });
  a.put({ picked: 0, tool: 'pending' });
  await a.wait(900);
  a.put({ tool: 'done', look: 'editorial' });
  await a.wait(1700);
  a.mark('second');
  await a.click({ at: 'row-1', x: 0.7, y: 0.62 });
  a.put({ picked: 1, tool: 'pending' });
  await a.wait(900);
  a.mark('landed');
  a.put({ tool: 'done', look: 'brutal' });
  await a.wait(300);
  await a.move(a.layout === 'wide' ? { x: 470, y: 258 } : { x: 320, y: 352 }, { duration: 650 });
  await a.wait(2400);
}

function Headline({ look, text }: { look: Look; text: string }) {
  return (
    <States
      className="sd-headline"
      align="start"
      value={look}
      states={{
        plain: <span data-face="plain">{text}</span>,
        editorial: <span data-face="editorial">{text}</span>,
        brutal: <span data-face="brutal">{text}</span>,
      }}
    />
  );
}

export interface SystemDemoProps {
  copy: SystemDemoCopy;
  theme: 'light' | 'dark';
}

export function SystemDemo({ copy, theme }: SystemDemoProps) {
  return (
    <Stage<Scene>
      width={504}
      height={290}
      compact={COMPACT}
      initial={INITIAL}
      poster={POSTER}
      script={script}
      play="once"
      theme={theme}
      unframed
      cursor={{ at: { wide: { x: 470, y: 232 }, compact: { x: 320, y: 352 } } }}
      className="fd-demo sd"
    >
      {(s) => (
        <>
          <div className="sd-label">{FILE}</div>
          <div className="sd-page" data-look={s.look}>
            <div className="sd-nav">
              <span className="sd-brand">{copy.brand}</span>
              <span className="sd-links">
                <Bar w={24} h={5} r={2.5} tone={3} />
                <Bar w={20} h={5} r={2.5} tone={3} />
              </span>
            </div>
            <div className="sd-hero">
              <Headline look={s.look} text={copy.headline} />
              <Bar w={148} h={6} r={3} tone={3} />
              <span className="sd-cta">{copy.cta}</span>
            </div>
            <div className="sd-cards">
              {[52, 44, 58].map((width) => (
                <span key={width} className="sd-card">
                  <Bar w={width} h={6} r={3} tone={4} />
                  <Bar w={width - 14} h={5} r={2.5} tone={3} />
                </span>
              ))}
            </div>
          </div>

          <div className="sd-side">
            <div className="sd-menu">
              {SYSTEMS.map((system, index) => (
                <div key={system.id} className="sd-row" data-target={`row-${index}`} data-on={s.picked === index || undefined}>
                  <span className="sd-tick">
                    <Check size={14} strokeWidth={2} aria-hidden />
                  </span>
                  <span className="sd-name">{system.name}</span>
                  <span className="sd-swatches">
                    {system.swatches.map((swatch) => (
                      <i key={swatch} data-c={swatch} />
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <Collapse open={s.tool !== 'hidden'} reveal="drop">
              <div className="sd-tool">
                <PenLine size={14} strokeWidth={1.75} aria-hidden />
                <span>{copy.edit}</span>
                <code>{FILE}</code>
                <States
                  className="sd-tool__stat"
                  align="end"
                  value={s.tool === 'done' ? 'done' : 'pending'}
                  states={{
                    pending: <Spinner size={12} />,
                    done: <span className="sd-tool__diff">{s.look === 'brutal' ? '+41' : '+38'}</span>,
                  }}
                />
              </div>
            </Collapse>
          </div>
        </>
      )}
    </Stage>
  );
}
