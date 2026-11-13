// The first screen of a design system, after Claude Design's overview: the cover, then the brand book.
// The cover is drawn from the system's own resolved tokens (see StudioCover); the brand book is
// DESIGN.md printed whole as prose, the way Claude Design prints a system's README.
import type { CSSProperties, ReactNode } from 'react';
import type { StudioDocument, StudioToken } from '@open-design/contracts';
import { Button } from '../fantay/ui';
import { renderMarkdown } from '../runtime/markdown';
import { Icon } from './Icon';
import type { StudioChapterId } from './StudioChapterNav';
import { StudioCover } from './StudioCover';
import styles from './StudioOverview.module.css';

export type StudioJumpTarget = { chapter: StudioChapterId; section?: string; token?: string };
export interface StudioOverviewLayer {
  id: 'principles' | 'foundations' | 'components' | 'patterns' | 'templates';
  label: string;
  done: boolean;
  target: StudioJumpTarget;
}
export interface StudioOverviewProps {
  name: string;
  intro: string;
  /** DESIGN.md as the brand book: front matter, H1 and the generated handbook already removed. */
  book?: string;
  blocks: { title: string; body: string }[];
  placeholderBlocks: boolean;
  tokens: StudioToken[];
  scope: string;
  document: StudioDocument;
  chinese: boolean;
  starter: boolean;
  canEdit: boolean;
  busy: boolean;
  layers: StudioOverviewLayer[];
  version: string;
  onJump: (target: StudioJumpTarget) => void;
  /** Edits DESIGN.md. */
  onEditDocument?: () => void;
  /** Create copy, add theme, build starter, upgrade: under the starter's title, else beside the edit button. */
  actions?: ReactNode;
  /** Getting-started sources, rendered last and only when given. */
  start?: ReactNode;
}

const COPY = {
  zh: { layers: '内容层级', ready: '已有内容', missing: '尚未填写', notes: '尚未填写的说明', edit: '编辑手册' },
  en: { layers: 'Content layers', ready: 'has content', missing: 'not written yet', notes: 'Notes still to write', edit: 'Edit brand book' },
};

/** Most presets title their DESIGN.md "Design System Inspired by X"; the cover names X, as the list does. */
export const studioDisplayName = (name: string) => name.replace(/^Design System (Inspired by|for)\s+/i, '').trim() || name;

/** The starter's one calm paragraph: block markup and inline marks are read through. */
function plainIntro(text: string): string {
  const paragraph = text.split(/\n\s*\n/).find((part) => part.trim()) ?? '';
  return paragraph.split('\n').map((line) => line.replace(/^\s*>\s?/, '').trim()).filter(Boolean).join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|\*|`/g, '').trim();
}

export function StudioOverview({ name, intro, book = '', blocks, placeholderBlocks, tokens, scope, document, chinese, starter, canEdit, busy, layers, version, onJump, onEditDocument, actions, start }: StudioOverviewProps) {
  const copy = chinese ? COPY.zh : COPY.en;
  const display = studioDisplayName(name);
  let order = 0;
  const rise = () => ({ '--i': order++ }) as CSSProperties;

  if (starter) return <div className={styles.overview} data-testid="studio-overview">
    <header className={styles.starterHead + ' ' + styles.rise} style={rise()}>
      <h1>{display}</h1>
      {plainIntro(intro) && <p>{plainIntro(intro)}</p>}
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
    {start && <div className={styles.start + ' ' + styles.rise} style={rise()}>{start}</div>}
  </div>;

  const text = book.trim() || intro.trim();
  const shownBlocks = blocks.filter((block) => block.body.trim());
  const hints = placeholderBlocks && !book.trim() && shownBlocks.length > 0;
  // The meter is a to-do list for the author: a preset cannot act on it, and a complete system has nothing left on it.
  const showMeter = canEdit && layers.some((layer) => !layer.done);
  const edit = canEdit && onEditDocument
    ? <Button variant="ghost" size="sm" disabled={busy} onClick={onEditDocument}><Icon name="edit" size={14} />{copy.edit}</Button>
    : null;
  const versionLabel = version ? (/^v/i.test(version) ? version : 'v' + version) : '';

  return <div className={styles.overview} data-testid="studio-overview">
    <h1 className={styles.srOnly}>{display}</h1>
    <div className={styles.rise} style={rise()}>
      <StudioCover name={display} intro={intro} tokens={tokens} scope={scope} notes={document.tokenNotes} chinese={chinese} />
    </div>
    <div className={styles.body}>
      {(showMeter || edit || versionLabel || actions) && <div className={styles.bookHead + ' ' + styles.rise} style={rise()}>
        {showMeter ? <div className={styles.meter} role="group" aria-label={copy.layers}>
          {layers.map((layer) => { const label = layer.label + ' · ' + (layer.done ? copy.ready : copy.missing); return <button key={layer.id} type="button" className={styles.layer} data-done={layer.done ? 'true' : undefined} aria-label={label} title={label} onClick={() => onJump(layer.target)}><span className={styles.layerDot} aria-hidden="true" />{layer.label}</button>; })}
        </div> : <span className={styles.version}>{versionLabel}</span>}
        <div className={styles.actions}>{showMeter && versionLabel && <span className={styles.version}>{versionLabel}</span>}{edit}{actions}</div>
      </div>}
      {text && <article data-section="principles" className={styles.book + ' ' + styles.rise} style={rise()}>{renderMarkdown(text, { syntaxHighlight: false })}</article>}
      {hints && <section className={styles.hints + ' ' + styles.rise} style={rise()}>
        <h2 className={styles.hintsHead}>{copy.notes}</h2>
        <dl className={styles.hintList}>{shownBlocks.map((block, index) => <div key={index}><dt>{block.title}</dt><dd>{block.body}</dd></div>)}</dl>
      </section>}
      {start && <div className={styles.start + ' ' + styles.rise} style={rise()}>{start}</div>}
    </div>
  </div>;
}
