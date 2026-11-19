// SPDX-License-Identifier: AGPL-3.0-only
// The slash-command list of the companion composer (Soul UI spec §4.5.2). One registry (`soul-commands.ts`) serves this
// list and the ＋ menu. The list docks above the composer card exactly like the `@` list (same surface, radius and
// motion); the textarea keeps focus and the composer owns the highlight and the keys (↑ ↓ move, Tab completes, Enter
// runs when the argument parses, Esc closes and keeps the text).
import { useEffect, useRef } from 'react';
import type { PaDeck } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { cn, menuContentClass, menuItemVariants } from '../../ui';
import type { TFn } from '../pa-types';
import { matchSlash, parseRollArg, parseSlash, type SoulCommand } from './soul-commands';
import styles from '../PaComposer.module.css';

export const SOUL_SLASH_LISTBOX_ID = 'pa-soul-slash-listbox';
export const soulSlashOptionId = (at: number) => `pa-soul-slash-opt-${at}`;

export type SoulSlashRow =
  | { key: string; kind: 'command'; command: SoulCommand; arg: string; busy: boolean; invalid: boolean }
  | { key: string; kind: 'deck'; deck: PaDeck; busy: boolean };

const HINT_KEY = {
  roll: 'pa.soul.chat.cmd.rollHint',
  draw: 'pa.soul.chat.cmd.drawHint',
  task: 'pa.soul.chat.cmd.taskHint',
} as const;

/** True when the list should be open for this input text: it starts with `/` and has no line break. */
export function soulSlashOpen(text: string): boolean {
  return text.startsWith('/') && !text.includes('\n');
}

function fold(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * The rows for the typed text. `/draw ` with no argument (or a partial deck name) lists the decks; `/roll` with an
 * argument that does not parse is marked invalid, and so is `/continue` in a 我来点名 room (`manual`: the owner picks
 * who speaks). While a chat turn runs every row but `/task` is busy.
 */
export function soulSlashRows(text: string, options: { decks: readonly PaDeck[]; busy: boolean; manual?: boolean }): SoulSlashRow[] {
  const parsed = parseSlash(text);
  const complete = /^\s*\S+\s/.test(text);
  if (parsed?.id === 'draw' && complete) {
    const query = fold(parsed.arg);
    return options.decks
      .filter((deck) => !query || fold(deck.id).startsWith(query) || fold(deck.name).includes(query))
      .map((deck) => ({ key: `deck:${deck.id}`, kind: 'deck' as const, deck, busy: options.busy }));
  }
  return matchSlash(text).map((command) => {
    const arg = parsed?.id === command.id ? parsed.arg : '';
    return {
      key: `cmd:${command.id}`,
      kind: 'command' as const,
      command,
      arg,
      busy: options.busy && command.id !== 'task',
      invalid: (command.id === 'roll' && arg !== '' && parseRollArg(arg) === null) || (command.id === 'continue' && options.manual === true),
    };
  });
}

/** The deck a `/draw` argument names exactly (by id or name). */
export function soulDeckFor(arg: string, decks: readonly PaDeck[]): PaDeck | null {
  const query = fold(arg);
  if (!query) return null;
  return decks.find((deck) => fold(deck.id) === query || fold(deck.name) === query) ?? null;
}

function hintOf(t: TFn, row: SoulSlashRow): string {
  if (row.busy) return t('pa.soul.chat.menu.busy');
  if (row.kind === 'deck') return '';
  if (row.invalid) return row.command.id === 'continue' ? t('pa.soul.chat.tray.who') : t('pa.soul.chat.dice.invalid');
  const key = HINT_KEY[row.command.id as keyof typeof HINT_KEY];
  return key ? t(key) : '';
}

export function SoulSlashList({
  rows,
  active,
  closing,
  onPick,
  onActive,
}: {
  rows: SoulSlashRow[];
  active: number;
  closing: boolean;
  onPick(row: SoulSlashRow): void;
  onActive(at: number): void;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`#${soulSlashOptionId(active)}`);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 6;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 6;
  }, [active]);

  return (
    <div
      ref={listRef}
      id={SOUL_SLASH_LISTBOX_ID}
      role="listbox"
      aria-label={t('pa.soul.chat.cmd.list')}
      data-testid="pa-soul-slash-list"
      data-state={closing ? 'closed' : 'open'}
      className={cn(menuContentClass, styles.mentionList, styles.slashList)}
    >
      {rows.map((row, at) => {
        const disabled = row.busy || (row.kind === 'command' && row.invalid);
        const hint = hintOf(t, row);
        return (
          <div
            key={row.key}
            id={soulSlashOptionId(at)}
            role="option"
            aria-selected={at === active}
            aria-disabled={disabled || undefined}
            data-highlighted={at === active ? '' : undefined}
            data-disabled={row.busy ? '' : undefined}
            data-kind={row.kind}
            className={cn(menuItemVariants(), styles.slashRow)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(row)}
            onPointerMove={(event) => {
              const last = pointer.current;
              pointer.current = { x: event.clientX, y: event.clientY };
              if (last && last.x === event.clientX && last.y === event.clientY) return;
              if (at !== active) onActive(at);
            }}
          >
            {row.kind === 'command' ? (
              <>
                <span className={styles.slashName}>{row.command.slash}</span>
                <span className={styles.slashLabel}>{t(row.command.labelKey)}</span>
              </>
            ) : (
              <>
                <span className={styles.slashName}>{row.deck.id}</span>
                <span className={styles.slashLabel}>{row.deck.name}</span>
              </>
            )}
            {hint ? (
              <span className={styles.slashHint} data-invalid={row.kind === 'command' && row.invalid ? '' : undefined}>
                {hint}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

