// SPDX-License-Identifier: AGPL-3.0-only
// The deck as words: each slide's number, title, body text with its list levels, tables, the names
// in its charts, and the speaker notes. It is real text, so it can be selected, searched by the
// browser and copied; it is also what a reader falls back on when a slide does not draw perfectly.
// The outline and the run of slides share one "current slide", so switching views keeps the place.
'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';

import { useT } from '../../../../i18n';
import { VisuallyHidden } from '../../../ui';
import { readArtifactViewState, writeArtifactViewState } from '../../use-view-state';
import styles from './Outline.module.css';
import type { DeckInfo, OutlineBlock } from './protocol';

const SCROLL_SLOT = 'slides.outline';
/** A slide counts as "the one being read" once its heading is within this distance of the top. */
const READ_LINE = 28;

interface StoredScroll {
  top: number;
  /** The slide that position belonged to; a jump made in the other view wins over an old position. */
  page: number;
}

export interface OutlineHandle {
  scrollToSlide(index: number): void;
}

export interface OutlineProps {
  projectId: string;
  fileName: string;
  deck: DeckInfo;
  /** The current slide, 0-based. */
  page: number;
  onPage(index: number): void;
  /** Shown above the outline, e.g. why this deck has no pictures. */
  lead?: string;
}

function Block({ block, chartLabel, separator }: { block: OutlineBlock; chartLabel: string; separator: string }): JSX.Element {
  if (block.kind === 'text') {
    return (
      <div className={styles.text}>
        {block.paragraphs.map((paragraph, index) => (
          <p key={index} className={styles.paragraph} data-level={Math.min(4, paragraph.level) || undefined}>
            {paragraph.text}
          </p>
        ))}
      </div>
    );
  }
  if (block.kind === 'table') {
    return (
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <p className={styles.chart}>
      <span className={styles.tag}>{chartLabel}</span>
      {block.series.length > 0 ? <span>{block.series.join(separator)}</span> : null}
      {block.categories.length > 0 ? <span className={styles.chartAxis}>{block.categories.join(separator)}</span> : null}
    </p>
  );
}

export const Outline = forwardRef<OutlineHandle, OutlineProps>(function Outline({ projectId, fileName, deck, page, onPage, lead }, ref): JSX.Element {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const entriesRef = useRef<Array<HTMLLIElement | null>>([]);
  const frameRef = useRef(0);
  const ownScrollRef = useRef<number | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const count = deck.slides.length;

  const scrollToSlide = useCallback((index: number) => {
    const element = scrollerRef.current;
    const entry = entriesRef.current[index];
    if (!element || !entry) return;
    // The first slide starts at the very top, lead line included.
    element.scrollTop = index === 0 ? 0 : Math.max(0, entry.offsetTop - 12);
    ownScrollRef.current = element.scrollTop;
    writeArtifactViewState(projectId, fileName, SCROLL_SLOT, { top: element.scrollTop, page: index } satisfies StoredScroll);
  }, [fileName, projectId]);

  useImperativeHandle(ref, () => ({ scrollToSlide }), [scrollToSlide]);

  // Opening the outline: back to the exact place when the reader last left it on this slide,
  // otherwise to the slide they were on in the other view.
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const stored = readArtifactViewState<StoredScroll>(projectId, fileName, SCROLL_SLOT);
    if (stored && stored.page === pageRef.current) {
      element.scrollTop = stored.top;
      ownScrollRef.current = element.scrollTop;
    } else {
      scrollToSlide(pageRef.current);
    }
  }, [count, fileName, projectId, scrollToSlide]);

  const onScroll = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const element = scrollerRef.current;
      if (!element) return;
      const top = element.scrollTop;
      const own = ownScrollRef.current !== null && Math.abs(top - ownScrollRef.current) < 1;
      if (own) return;
      ownScrollRef.current = null;
      let current = 0;
      for (let index = 0; index < count; index += 1) {
        const entry = entriesRef.current[index];
        if (!entry || entry.offsetTop > top + READ_LINE) break;
        current = index;
      }
      // At the very end the last slides may never reach the top: the last one is the current one.
      if (top > 0 && top + element.clientHeight >= element.scrollHeight - 1) current = count - 1;
      writeArtifactViewState(projectId, fileName, SCROLL_SLOT, { top, page: current } satisfies StoredScroll);
      if (current !== pageRef.current) onPage(current);
    });
  }, [count, fileName, onPage, projectId]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const chartLabel = t('artifact.slides.chart');
  const separator = t('artifact.slides.listSeparator');

  return (
    <div ref={scrollerRef} className={styles.outline} tabIndex={0} role="group" aria-label={t('artifact.slides.viewOutline')} data-slide-outline="" onScroll={onScroll}>
      <div className={styles.column}>
        {lead ? <p className={styles.lead}>{lead}</p> : null}
        <ol className={styles.list}>
          {deck.slides.map((slide, index) => (
            <li
              key={index}
              ref={(element) => {
                entriesRef.current[index] = element;
              }}
              className={styles.entry}
              data-slide={index + 1}
            >
              <span className={styles.number} aria-hidden="true">
                {index + 1}
              </span>
              <div className={styles.body}>
                <h3 className={styles.title} data-untitled={slide.title ? undefined : ''}>
                  <VisuallyHidden>{t('artifact.slides.slideLabel', { index: index + 1 })} </VisuallyHidden>
                  {slide.title || t('artifact.slides.untitled')}
                  {slide.hidden ? <span className={styles.tag}>{t('artifact.slides.hiddenTag')}</span> : null}
                </h3>
                {slide.blocks.map((block, blockIndex) => (
                  <Block key={blockIndex} block={block} chartLabel={chartLabel} separator={separator} />
                ))}
                {slide.blocks.length === 0 && !slide.title ? <p className={styles.none}>{t('artifact.slides.noText')}</p> : null}
                {slide.notes ? (
                  <div className={styles.notes}>
                    <span className={styles.notesLabel}>{t('artifact.slides.notes')}</span>
                    <p className={styles.notesText}>{slide.notes}</p>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {deck.outlineCut ? <p className={styles.lead}>{t('artifact.slides.outlineCut')}</p> : null}
      </div>
    </div>
  );
});
