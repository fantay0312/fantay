// SPDX-License-Identifier: AGPL-3.0-only
// 触发测试 (Soul UI spec §7.3): paste some dialogue, see which entries of the unsaved draft would come to mind and
// why. Every non-empty line is one message; lines are sent newest first (the last line is the newest), as the
// activation engine expects. The test runs through `actions.testLorebook` 300 ms after the last change of the text
// or of the draft, never persists anything, and drops answers that arrive after a newer run started.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PaLoreEntry, PaLorebookDoc, PaLorebookInput, PaSoulTraceLore } from '@open-design/contracts';
import { SOUL_LIMITS } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import { Button, Textarea, VisuallyHidden, cn } from '../../ui';
import { usePa } from '../pa-context';
import type { TFn } from '../pa-types';
import modalStyles from '../PaModals.module.css';
import { loreReasonText } from './SoulContextModal';
import { loreNumber } from './SoulLoreEntryForm';
import { SoulTag } from './SoulPrimitives';
import styles from './SoulLorebookModal.module.css';

const L = SOUL_LIMITS;
const DEBOUNCE_MS = 300;
const MAX_LINES = 20;
const MAX_LINE = 4000;
type Key = Parameters<TFn>[0];

export interface SoulLoreTestState {
  status: 'idle' | 'running' | 'ready' | 'error';
  trace: PaSoulTraceLore[];
  used: number;
  limit: number;
}

const IDLE: SoulLoreTestState = { status: 'idle', trace: [], used: 0, limit: 0 };

/** One message per non-empty line, newest (last) first, at most 20 lines of 4000 characters. */
export function loreTestMessages(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(-MAX_LINES).reverse().map((line) => line.slice(0, MAX_LINE));
}

/** The draft as a body the test route accepts: a name is required and text fields are held to their limits, so a
 *  half-finished draft (no name yet, an over-long entry) can still be tried. */
function testInput(draft: PaLorebookDoc): PaLorebookInput {
  return {
    ...draft,
    name: draft.name.trim().slice(0, L.lorebookName) || 'draft',
    description: draft.description.slice(0, L.lorebookDescription),
    entries: draft.entries.map((entry: PaLoreEntry) => ({
      ...entry,
      title: entry.title.slice(0, L.loreTitle),
      content: entry.content.slice(0, L.loreContent),
    })),
  };
}

/** Runs the trigger test for `draft` against `text`. Lives in the editor (not the bench) so the list keeps its
 *  firing marks while the narrow layout shows the entry form instead of the bench. */
export function useSoulLoreTest(draft: PaLorebookDoc, text: string, enabled: boolean): SoulLoreTestState {
  const { data } = usePa();
  const actions = useRef(data.actions);
  actions.current = data.actions;
  const [state, setState] = useState<SoulLoreTestState>(IDLE);
  const sequence = useRef(0);
  const messages = useMemo(() => loreTestMessages(text), [text]);
  const signature = messages.join('\n');

  useEffect(() => {
    sequence.current += 1;
    const run = sequence.current;
    if (!enabled || messages.length === 0) {
      setState(IDLE);
      return undefined;
    }
    const timer = setTimeout(() => {
      setState((current) => (current.status === 'idle' || current.status === 'error' ? current : { ...current, status: 'running' }));
      actions.current.testLorebook({ lorebook: testInput(draft), messages }).then(
        (result) => {
          if (sequence.current !== run) return;
          setState({ status: 'ready', trace: result.trace, used: result.used, limit: result.limit });
        },
        () => {
          if (sequence.current !== run) return;
          setState({ ...IDLE, status: 'error' });
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `messages` is keyed by its text (`signature`); the draft object changes on every edit and is the other trigger.
  }, [draft, signature, enabled]);

  return state;
}

const STATUS_KEY: Record<PaSoulTraceLore['status'], Key> = {
  included: 'pa.soul.lore.status.included',
  budget: 'pa.soul.lore.status.budget',
  inactive: 'pa.soul.lore.status.inactive',
  disabled: 'pa.soul.lore.status.disabled',
  cooldown: 'pa.soul.lore.status.cooldown',
  probability: 'pa.soul.lore.status.probability',
  group: 'pa.soul.lore.status.group',
};

/** The reason in words: the 上下文 modal's table (`loreReasonText`), except `disabled`, which in the editor can only
 *  mean the entry itself is off (the bench has no chat to switch it off in). */
function reasonText(reason: PaSoulTraceLore['reason'], t: TFn): string {
  return reason.code === 'disabled' ? t('pa.soul.lore.reason.disabled') : loreReasonText(t, reason, loreNumber);
}

/** Carried first, then the ones that fired but lost (budget, cooldown, chance, group, off), then the rest. */
const RANK: Record<PaSoulTraceLore['status'], number> = {
  included: 0,
  budget: 1,
  group: 2,
  probability: 2,
  cooldown: 2,
  disabled: 3,
  inactive: 4,
};

export interface SoulLoreTestBenchProps {
  text: string;
  onTextChange(text: string): void;
  state: SoulLoreTestState;
  /** Entry titles of the draft by id (results may name an entry renamed since the run). */
  titles: ReadonlyMap<string, string>;
  selectedId: string | null;
  onSelect(entryId: string): void;
}

export function SoulLoreTestBench({ text, onTextChange, state, titles, selectedId, onSelect }: SoulLoreTestBenchProps) {
  const t = useT();
  const titleId = useId();
  const rows = useMemo(
    () => state.trace.map((row, index) => ({ row, index })).sort((a, b) => RANK[a.row.status] - RANK[b.row.status] || a.index - b.index),
    [state.trace],
  );
  const empty = text.trim() === '';
  const shown = !empty && (state.status === 'ready' || (state.status === 'running' && state.trace.length > 0));
  const carried = state.trace.filter((row) => row.status === 'included').length;
  const skipped = state.trace.filter((row) => row.status === 'budget').length;
  const summary = t('pa.soul.lore.test.summary', {
    a: carried,
    b: skipped,
    used: loreNumber(state.used),
    limit: loreNumber(state.limit),
  }).split(' · ');
  const fired = rows.filter(({ row }) => row.status !== 'inactive');
  const quiet = rows.filter(({ row }) => row.status === 'inactive');

  const renderRows = (items: typeof rows) => (
    <ul className={cn(modalStyles.group, styles.results)} data-running={state.status === 'running' ? '' : undefined}>
      {items.map(({ row }) => (
        <li key={`${row.lorebookId}:${row.entryId}`}>
          <Button
            variant="bare"
            className={styles.result}
            data-status={row.status}
            data-selected={row.entryId === selectedId ? '' : undefined}
            data-testid="pa-lore-test-row"
            onClick={() => onSelect(row.entryId)}
          >
            <span className={styles.resultHead}>
              <SoulTag tone={row.status === 'included' ? 'solid' : 'outline'}>{t(STATUS_KEY[row.status])}</SoulTag>
              <span className={styles.resultTitle}>{(titles.get(row.entryId) ?? row.title).trim() || t('pa.soul.lore.untitled')}</span>
              <span className={styles.resultTokens}>{loreNumber(row.tokens)}</span>
            </span>
            <span className={styles.resultReason}>{reasonText(row.reason, t)}</span>
          </Button>
        </li>
      ))}
    </ul>
  );

  return (
    <section className={styles.bench} aria-labelledby={titleId} data-testid="pa-lore-test">
      <h3 id={titleId} className={styles.benchTitle}>
        {t('pa.soul.lore.test.title')}
      </h3>
      <Textarea
        rows={6}
        className={styles.benchInput}
        value={text}
        placeholder={t('pa.soul.lore.test.placeholder')}
        aria-labelledby={titleId}
        onChange={(event) => onTextChange(event.target.value)}
      />
      {empty ? <p className={styles.benchHint}>{t('pa.soul.lore.test.hint')}</p> : null}
      {!empty && state.status === 'error' ? (
        <p className={styles.benchError} role="status">
          {t('pa.soul.lore.test.error')}
        </p>
      ) : null}
      {shown ? (
        <>
          <p className={styles.summary} role="status" data-testid="pa-lore-test-summary">
            <VisuallyHidden>{summary.join(' · ')}</VisuallyHidden>
            <span aria-hidden className={styles.summaryParts}>
              {summary.map((part, index) => (
                <span key={index} className={styles.summaryPart}>
                  {part}
                </span>
              ))}
            </span>
          </p>
          {fired.length > 0 ? renderRows(fired) : null}
          {quiet.length > 0 ? renderRows(quiet) : null}
        </>
      ) : null}
    </section>
  );
}
