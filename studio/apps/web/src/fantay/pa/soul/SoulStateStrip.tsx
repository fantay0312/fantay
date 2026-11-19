// SPDX-License-Identifier: AGPL-3.0-only
// The state strip above the companion composer (Soul UI spec §4.6): the interlude countdown, then the story state in
// schema order, then 全部 N 项 ›. One bare button that opens the inspector tab 此刻. Monochrome. Cells never ellipsize
// (owner rule O4): a hidden measuring row tells which whole cells fit, and later smaller cells may still fit. Fields the
// newest reply touched flash once and swap their value.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import { SwapLabel } from '../../../components/chat/SwapLabel';
import { useT } from '../../../i18n';
import { Button, Icon } from '../../ui';
import { usePa } from '../pa-context';
import type { PaConversation, PaGroup, PaIndex } from '../pa-types';
import { SoulStateBar, SoulStateValue, SoulTag } from './SoulPrimitives';
import { chatOf, chatStateOf, replyEffects, soulItems } from './soul-model';
import styles from '../PaComposer.module.css';

/** A text or enum value longer than this many code points is not eligible for the strip. */
const STRIP_TEXT_MAX = 10;
/** The flex gap between cells (CSS `.stripBar` gap). */
const CELL_GAP = 14;

function groupOf(index: PaIndex, conversation: PaConversation): PaGroup | null {
  return index.groupByConversation.get(conversation.id) ?? (conversation.groupId ? index.groups.get(conversation.groupId) ?? null : null);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

interface Cell {
  key: string;
  text: string;
  node: ReactNode;
  touched: boolean;
}

export function SoulStateStrip({ conversation }: { conversation: PaConversation }) {
  const t = useT();
  const { index, nav } = usePa();
  const cid = conversation.id;
  const chat = chatOf(index, cid);
  const room = groupOf(index, conversation);
  const state = chatStateOf(index, conversation);
  const event = chat.activeEvent;
  const fields = room ? [] : state.schema;

  const items = soulItems(index, cid);
  let newestReply = null;
  for (let at = items.length - 1; at >= 0; at -= 1) {
    if (items[at]!.role === 'agent') {
      newestReply = items[at]!;
      break;
    }
  }
  const flashKey = newestReply?.message.id ?? '';
  const firstKey = useRef(flashKey);
  const flashing = flashKey !== firstKey.current;
  const touched = new Set(newestReply && state.active ? replyEffects(index, conversation, newestReply).map((effect) => effect.key) : []);

  const cells: Cell[] = [];
  if (event) {
    const text = t('pa.soul.chat.strip.event', { n: event.remainingTurns });
    cells.push({ key: 'event', text, touched: false, node: <SoulTag>{text}</SoulTag> });
  }
  for (const field of fields) {
    const value = state.values[field.key];
    if (value === undefined) continue;
    if (field.kind === 'number' && typeof value === 'number') {
      const bar = field.min !== undefined && field.max !== undefined && field.render !== 'value';
      const text = bar ? `${formatNumber(value)}/${formatNumber(field.max!)}` : formatNumber(value);
      cells.push({
        key: field.key,
        text: `${field.label}${text}`,
        touched: touched.has(field.key),
        node: (
          <SoulStateValue label={field.label}>
            {bar ? (
              <span className={styles.stripNumber}>
                <SoulStateBar value={value} min={field.min!} max={field.max!} />
                <SwapLabel swapKey={text}>{text}</SwapLabel>
              </span>
            ) : (
              <SwapLabel swapKey={text}>{text}</SwapLabel>
            )}
          </SoulStateValue>
        ),
      });
    } else if (field.kind === 'list' && Array.isArray(value)) {
      const text = t('pa.soul.chat.strip.count', { n: value.length });
      cells.push({
        key: field.key,
        text: `${field.label}${text}`,
        touched: touched.has(field.key),
        node: (
          <SoulStateValue label={field.label}>
            <SwapLabel swapKey={text}>{text}</SwapLabel>
          </SoulStateValue>
        ),
      });
    } else if (typeof value === 'string' && Array.from(value).length <= STRIP_TEXT_MAX) {
      cells.push({
        key: field.key,
        text: `${field.label}${value}`,
        touched: touched.has(field.key),
        node: (
          <SoulStateValue label={field.label}>
            <SwapLabel swapKey={value}>{value}</SwapLabel>
          </SoulStateValue>
        ),
      });
    }
  }
  const end = (
    <span className={styles.stripEnd}>
      {fields.length > 0 ? <span>{t('pa.soul.chat.strip.all', { n: fields.length })}</span> : null}
      <Icon icon={ChevronRight} size={12} />
    </span>
  );

  /* Whole cells only: measure every cell in a hidden row, keep those that fit in order (later smaller ones may). */
  const stripRef = useRef<HTMLButtonElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<ReadonlySet<string> | null>(null);
  const cellsKey = cells.map((cell) => `${cell.key}=${cell.text}`).join('|');
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const measure = measureRef.current;
    if (!strip || !measure) return undefined;
    const compute = () => {
      const style = window.getComputedStyle(strip);
      const available = strip.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
      const widths = [...measure.children].map((node) => (node as HTMLElement).offsetWidth);
      const endWidth = widths[widths.length - 1] ?? 0;
      let used = endWidth;
      const keep = new Set<string>();
      cells.forEach((cell, at) => {
        const width = widths[at] ?? 0;
        if (available <= 0 || used + CELL_GAP + width <= available) {
          keep.add(cell.key);
          used += CELL_GAP + width;
        }
      });
      setFit((previous) => (previous && previous.size === keep.size && [...keep].every((key) => previous.has(key)) ? previous : keep));
    };
    compute();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(compute);
    observer.observe(strip);
    return () => observer.disconnect();
    // `cells` is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellsKey]);

  if (!state.active && !event) return null;
  if (cells.length === 0 && !event) return null;

  return (
    <div className={styles.strip} data-testid="pa-soul-state-strip">
      <Button
        ref={stripRef}
        variant="bare"
        className={styles.stripBar}
        aria-label={t('pa.soul.chat.strip.aria')}
        onClick={() => nav.setInspector(true, 'scene')}
      >
        {cells.map((cell) =>
          fit && !fit.has(cell.key) ? null : (
            <span
              key={cell.touched && flashing ? `${cell.key}:${flashKey}` : cell.key}
              className={styles.stripCell}
              data-flash={cell.touched && flashing ? '' : undefined}
            >
              {cell.node}
            </span>
          ),
        )}
        {end}
      </Button>
      <div ref={measureRef} className={styles.stripMeasure} aria-hidden>
        {cells.map((cell) => (
          <span key={cell.key} className={styles.stripCell}>
            {cell.node}
          </span>
        ))}
        {end}
      </div>
    </div>
  );
}
