// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/NotebookPreview.tsx @ c5e6b24f (MIT): cells in
// saved order, each followed by its outputs; cells mounted in batches so a long notebook opens at
// once; saved outputs only, never executed. Changed here: a reading column instead of bordered
// cards (Markdown is prose on the paper, code sits on one tone, the prompt hangs in the margin);
// outputs drawn by kind (printed text, value, picture, table, error with its traceback); HTML
// outputs sanitised and drawn in place, not in frames; long outputs folded with "show all"; the
// reader's place and what they unfolded are kept per file; code highlighted by Shiki; formulas
// typeset by KaTeX (`math.ts`).
'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useT } from '../../../../i18n';
import { Button } from '../../../ui';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../../use-view-state';
import { countLines } from '../text/text-format';
import { highlightCell, peekHighlightedCell } from './highlight';
import { typesetLatexOutput, useMathEngine } from './math';
import { renderNotebookMarkdown, sanitizeOutputHtml } from './notebook-html';
import styles from './NotebookPage.module.css';
import type { Notebook, NotebookCell, NotebookOutput } from './parse-notebook';

/** Cells mounted at first, and added each time the reader nears the end. */
const CELL_BATCH = 40;
/** A printed output longer than this is folded to its first lines. */
const FOLD_OVER_LINES = 40;
const FOLDED_LINES = 24;
/** Highlighting a cell longer than this costs more than it gives. */
const MAX_HIGHLIGHT_CHARS = 60_000;

/** Where the reader is: the first cell on screen and how far into it. Survives a remount. */
interface Place {
  cell: number;
  offset: number;
}

function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function useIsDarkTheme(): boolean {
  return useSyncExternalStore(
    subscribeToTheme,
    () => document.documentElement.getAttribute('data-theme') === 'dark',
    () => false,
  );
}

/** Kernel language names that differ from the highlighter's. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ipython: 'python',
  ipython3: 'python',
  python3: 'python',
  'c++': 'cpp',
  node: 'javascript',
  nodejs: 'javascript',
};

const MAGIC_LANGUAGES: Readonly<Record<string, string>> = {
  bash: 'bash',
  sh: 'bash',
  script: 'bash',
  sql: 'sql',
  html: 'html',
  javascript: 'javascript',
  js: 'javascript',
  markdown: 'markdown',
  ruby: 'ruby',
};

/** A cell that starts with a cell magic (`%%bash`, `%%sql`) is written in that language. */
export function cellLanguage(source: string, notebookLanguage: string): string {
  const magic = /^%%(\w+)/.exec(source);
  const magicLanguage = magic ? MAGIC_LANGUAGES[(magic[1] ?? '').toLowerCase()] : undefined;
  return magicLanguage ?? LANGUAGE_ALIASES[notebookLanguage] ?? notebookLanguage;
}

function CodeBlock({ code, language, dark }: { code: string; language: string; dark: boolean }): JSX.Element {
  const [highlighted, setHighlighted] = useState<{ code: string; html: string } | null>(() => {
    const html = peekHighlightedCell(code, language, dark);
    return html === null ? null : { code, html };
  });

  useEffect(() => {
    if (language === '' || code.length > MAX_HIGHLIGHT_CHARS) return;
    let current = true;
    // The plain source shows first and is coloured in when the highlighter has loaded.
    highlightCell(code, language, dark).then(
      (html) => {
        if (current && html) setHighlighted({ code, html });
      },
      () => {
        // Without the highlighter the source is still the source.
      },
    );
    return () => {
      current = false;
    };
  }, [code, language, dark]);

  // The previous colours stay while the theme's colours are on their way.
  if (highlighted?.code === code) {
    return <div className={styles.code} dangerouslySetInnerHTML={{ __html: highlighted.html }} />;
  }
  return (
    <div className={styles.code}>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function firstLines(text: string, count: number): string {
  let at = -1;
  for (let line = 0; line < count; line += 1) {
    at = text.indexOf('\n', at + 1);
    if (at === -1) return text;
  }
  return text.slice(0, at);
}

interface FoldableTextProps {
  text: string;
  /** The parser cut the text at its cap. */
  clipped: boolean;
  open: boolean;
  onToggle(): void;
  className?: string;
}

/** Printed text: all of it when it is short, its first lines and a "show all" when it is long. */
function FoldableText({ text, clipped, open, onToggle, className }: FoldableTextProps): JSX.Element {
  const t = useT();
  const lines = useMemo(() => countLines(text), [text]);
  const foldable = lines > FOLD_OVER_LINES;
  const shown = foldable && !open ? firstLines(text, FOLDED_LINES) : text;
  return (
    <div className={styles.foldable} data-folded={(foldable && !open) || undefined}>
      <pre className={className}>{shown}</pre>
      {clipped && (open || !foldable) ? <p className={styles.clipped}>{t('artifact.notebook.outputClipped')}</p> : null}
      {foldable ? (
        <div className={styles.foldControl}>
          <Button size="sm" variant="bare" aria-expanded={open} onClick={onToggle}>
            {open ? t('artifact.notebook.showLess') : t('artifact.notebook.showAllLines', { count: lines.toLocaleString() })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface OutputProps {
  output: NotebookOutput;
  cellNumber: number;
  open: boolean;
  onToggle(): void;
}

function Output({ output, cellNumber, open, onToggle }: OutputProps): JSX.Element | null {
  const t = useT();
  const mathReady = useMathEngine(output.kind === 'latex' || (output.kind === 'markdown' && output.source.includes('$')));
  const html = useMemo(() => {
    if (output.kind === 'html') return sanitizeOutputHtml(output.html);
    if (output.kind === 'markdown') return renderNotebookMarkdown(output.source);
    if (output.kind === 'latex') return mathReady ? typesetLatexOutput(output.source) : '';
    return '';
    // `mathReady` is a dependency for Markdown too: its formulas are typeset once the engine is in.
  }, [output, mathReady]);

  switch (output.kind) {
    case 'stream':
      return (
        <FoldableText
          text={output.text}
          clipped={output.clipped}
          open={open}
          onToggle={onToggle}
          className={output.name === 'stderr' ? styles.stderr : styles.printed}
        />
      );
    case 'text':
      return <FoldableText text={output.text} clipped={output.clipped} open={open} onToggle={onToggle} className={styles.printed} />;
    case 'image':
      return (
        <div className={styles.figure}>
          <img
            className={styles.image}
            src={output.src}
            alt={t('artifact.notebook.outputImage', { index: cellNumber })}
            style={output.width ? { width: output.width } : undefined}
            decoding="async"
            draggable={false}
          />
        </div>
      );
    case 'html':
      // Markup that sanitised to nothing (a chart drawn by a script) falls back to its plain text.
      return html !== '' ? (
        <div className={styles.rich} dangerouslySetInnerHTML={{ __html: html }} />
      ) : output.fallback.trim() !== '' ? (
        <FoldableText text={output.fallback} clipped={false} open={open} onToggle={onToggle} className={styles.printed} />
      ) : null;
    case 'markdown':
      return html !== '' ? <div className={styles.prose} dangerouslySetInnerHTML={{ __html: html }} /> : null;
    case 'latex': {
      if (html !== '') return <div className={styles.formula} dangerouslySetInnerHTML={{ __html: html }} />;
      // Until the formula is typeset, and when it cannot be, its plain form stands in. A plain form
      // that only names the object (`<IPython.core.display.Latex object>`) says less than the TeX.
      const plain = output.fallback.trim();
      const text = plain !== '' && !/^<[\w.]+ object(?: at 0x[\da-f]+)?>$/i.test(plain) ? output.fallback : output.source;
      return <FoldableText text={text} clipped={false} open={open} onToggle={onToggle} className={styles.printed} />;
    }
    case 'error':
      return (
        <div className={styles.error} role="group">
          <p className={styles.errorTitle}>
            {output.name}
            {output.name && output.message ? ': ' : ''}
            {output.message}
          </p>
          {output.traceback !== '' ? (
            <FoldableText text={output.traceback} clipped={output.clipped} open={open} onToggle={onToggle} className={styles.traceback} />
          ) : null}
        </div>
      );
  }
}

interface CellProps {
  cell: NotebookCell;
  index: number;
  language: string;
  dark: boolean;
  expanded: readonly string[];
  onToggle(key: string): void;
}

function Cell({ cell, index, language, dark, expanded, onToggle }: CellProps): JSX.Element | null {
  const t = useT();
  const number = index + 1;
  const mathReady = useMathEngine(cell.kind === 'markdown' && cell.source.includes('$'));
  const markdown = useMemo(
    () => (cell.kind === 'markdown' ? renderNotebookMarkdown(cell.source, cell.attachments) : ''),
    // `mathReady`: the cell is rendered again once its formulas can be typeset.
    [cell, mathReady],
  );

  if (cell.kind === 'markdown') {
    // An empty Markdown cell is a blank line someone left; it takes no room.
    if (markdown === '') return null;
    return (
      <section className={styles.cell} data-cell={index} data-kind="markdown" aria-label={t('artifact.notebook.textCell', { index: number })}>
        <div className={styles.prose} dangerouslySetInnerHTML={{ __html: markdown }} />
      </section>
    );
  }

  if (cell.kind === 'raw') {
    if (cell.source.trim() === '') return null;
    return (
      <section className={styles.cell} data-cell={index} data-kind="raw" aria-label={t('artifact.notebook.textCell', { index: number })}>
        <pre className={styles.raw}>{cell.source}</pre>
      </section>
    );
  }

  const count = cell.executionCount === null ? ' ' : String(cell.executionCount);
  const hasSource = cell.source.trim() !== '';
  if (!hasSource && cell.outputs.length === 0) return null;
  return (
    <section className={styles.cell} data-cell={index} data-kind="code" aria-label={t('artifact.notebook.codeCell', { index: number })}>
      {hasSource ? (
        <div className={styles.row}>
          <span className={styles.prompt} aria-hidden="true">
            In [{count}]
          </span>
          <CodeBlock code={cell.source} language={cellLanguage(cell.source, language)} dark={dark} />
          {cell.clipped ? <p className={styles.clipped}>{t('artifact.notebook.outputClipped')}</p> : null}
        </div>
      ) : null}
      {cell.outputs.map((output, outputIndex) => {
        const key = `${index}:${outputIndex}`;
        const isResult = output.kind !== 'stream' && output.kind !== 'error' && output.result;
        return (
          // Outputs keep their saved order and never move, so the position is the identity.
          <div key={outputIndex} className={styles.row} data-output={output.kind}>
            {isResult ? (
              <span className={styles.prompt} aria-hidden="true">
                Out [{count}]
              </span>
            ) : null}
            <Output output={output} cellNumber={number} open={expanded.includes(key)} onToggle={() => onToggle(key)} />
          </div>
        );
      })}
    </section>
  );
}

export interface NotebookPageProps {
  projectId: string;
  fileName: string;
  notebook: Notebook;
}

export function NotebookPage({ projectId, fileName, notebook }: NotebookPageProps): JSX.Element {
  const t = useT();
  const dark = useIsDarkTheme();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const total = notebook.cells.length;

  // How many cells are mounted, and which long outputs the reader unfolded: both outlive the viewer.
  const [mounted, setMounted] = useArtifactViewState<number>(projectId, fileName, 'cells', CELL_BATCH);
  const [expanded, setExpanded] = useArtifactViewState<readonly string[]>(projectId, fileName, 'expanded', []);
  const visible = Math.min(total, Math.max(CELL_BATCH, mounted));
  const remaining = total - visible;

  const toggle = useCallback(
    (key: string) => setExpanded((keys) => (keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key])),
    [setExpanded],
  );
  const showMore = useCallback(() => setMounted((count) => Math.max(CELL_BATCH, count) + CELL_BATCH), [setMounted]);

  // More cells arrive as the reader nears the end; the button under the last cell does the same by hand.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const sentinel = sentinelRef.current;
    if (!scroller || !sentinel || remaining <= 0 || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore();
      },
      { root: scroller, rootMargin: '600px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [remaining, showMore]);

  // Put the reader back at the cell they were reading. Pictures above it are still decoding and have
  // no height yet, so the place is set again as each one arrives, until the reader takes over.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const place = readArtifactViewState<Place>(projectId, fileName, 'place');
    if (!scroller || !place) return;
    const apply = (): void => {
      const cell = scroller.querySelector<HTMLElement>(`[data-cell="${place.cell}"]`);
      if (cell) scroller.scrollTop = cell.offsetTop + place.offset;
    };
    apply();

    const takeOver = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
    const release = (): void => {
      window.clearTimeout(timer);
      // `load` does not bubble; it is caught on the way down.
      scroller.removeEventListener('load', apply, true);
      for (const type of takeOver) scroller.removeEventListener(type, release);
    };
    const timer = window.setTimeout(release, 2000);
    scroller.addEventListener('load', apply, true);
    for (const type of takeOver) scroller.addEventListener(type, release, { passive: true });
    return release;
    // Only on mount and for another file: a later render must not pull the reader back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileName]);

  const frameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );
  const onScroll = (): void => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const scroller = scrollerRef.current;
      if (!scroller || scroller.clientHeight === 0) return;
      const top = scroller.scrollTop;
      for (const cell of Array.from(scroller.querySelectorAll<HTMLElement>('[data-cell]'))) {
        if (cell.offsetTop + cell.offsetHeight > top) {
          writeArtifactViewState(projectId, fileName, 'place', {
            cell: Number(cell.dataset.cell),
            offset: top - cell.offsetTop,
          } satisfies Place);
          return;
        }
      }
    });
  };

  return (
    <div ref={scrollerRef} className={styles.scroller} tabIndex={0} role="document" aria-label={fileName} onScroll={onScroll}>
      <div className={styles.column}>
        {notebook.cells.slice(0, visible).map((cell, index) => (
          // Cells keep their saved order; the position is the identity.
          <Cell key={index} cell={cell} index={index} language={notebook.language} dark={dark} expanded={expanded} onToggle={toggle} />
        ))}
        {remaining > 0 ? (
          <div ref={sentinelRef} className={styles.more}>
            <Button size="sm" variant="ghost" onClick={showMore}>
              {t('artifact.notebook.moreCells', { count: Math.min(CELL_BATCH, remaining).toLocaleString() })}
            </Button>
          </div>
        ) : null}
        <p className={styles.footnote}>{t('artifact.notebook.savedOutputs')}</p>
      </div>
    </div>
  );
}
