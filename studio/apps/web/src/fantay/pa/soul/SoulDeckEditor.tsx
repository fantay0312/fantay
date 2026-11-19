// SPDX-License-Identifier: AGPL-3.0-only
// 状态与玩法 ▸ 牌堆 of the profile editor (STAGE2 11): master–detail inside the section, the pattern of 状态栏, never a
// nested modal. The character's own decks (selectable) and the built-in decks (read-only) in one hairline list; the
// selected deck's name, its cards as rows (牌面 · 说明 · 只给 TA 看的内容, with a 顺序 stepper), 加一张, 批量粘贴
// (one card per line through the engine's parseDeckLines) and 删除牌堆 (confirmed first). A new deck's id is
// `deckIdFor` at creation and never changes. Nothing is written until the editor's 保存; the validation is exported so
// the editor can mark 状态与玩法 and hold 保存.
import { Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { PA_BUILTIN_DECKS, SOUL_LIMITS, deckIdFor, parseDeckLines } from '@open-design/contracts/soul';
import type { PaDeck } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import { Button, ConfirmDialog, Icon, IconButton, Input, PlusIcon, Textarea, VisuallyHidden } from '../../ui';
import modalStyles from '../PaModals.module.css';
import { SoulStepper, SoulTag } from './SoulPrimitives';
import { SoulField } from './SoulProfileModal';
import styles from './SoulProfileModal.module.css';

const L = SOUL_LIMITS;
type Card = PaDeck['cards'][number];

export interface DeckIssue {
  deckId: string;
  kind: 'name' | 'few' | 'title';
}

/** What holds 保存: a deck without a name, with fewer than two cards, or with a card without a title. */
export function deckIssues(decks: readonly PaDeck[]): DeckIssue[] {
  const issues: DeckIssue[] = [];
  for (const deck of decks) {
    if (deck.name.trim() === '') issues.push({ deckId: deck.id, kind: 'name' });
    if (deck.cards.length < 2) issues.push({ deckId: deck.id, kind: 'few' });
    if (deck.cards.some((card) => card.title.trim() === '')) issues.push({ deckId: deck.id, kind: 'title' });
  }
  return issues;
}

function deckOver(deck: PaDeck): boolean {
  return (
    deck.name.length > L.deckName ||
    deck.cards.length > L.deckCards ||
    deck.cards.some((card) => card.title.length > L.cardTitle || card.text.length > L.cardText || card.secret.length > L.cardSecret)
  );
}

/** A deck field over its SOUL_LIMITS bound (the daemon would refuse the save): also holds 保存. */
export function deckOverLimit(decks: readonly PaDeck[]): boolean {
  return decks.length > L.decks || decks.some(deckOver);
}

const ISSUE_TEXT = {
  name: 'pa.soul.editor.deck.error.name',
  few: 'pa.soul.editor.deck.error.few',
  title: 'pa.soul.editor.deck.error.title',
} as const;

function blankCard(): Card {
  return { title: '', text: '', secret: '' };
}

function filled(card: Card): boolean {
  return card.title.trim() !== '' || card.text.trim() !== '' || card.secret.trim() !== '';
}

function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

export interface SoulDeckEditorProps {
  value: PaDeck[];
  onChange(next: PaDeck[]): void;
  /** The character's display name, for the English "Only {name} sees this". */
  name: string;
}

export function SoulDeckEditor({ value, onChange, name }: SoulDeckEditorProps) {
  const t = useT();
  const decks = value ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(decks[0]?.id ?? null);
  const deck = decks.find((item) => item.id === selectedId) ?? decks[0] ?? null;
  const deckAt = deck ? decks.indexOf(deck) : -1;
  const issues = useMemo(() => deckIssues(decks), [decks]);
  const own = useMemo(() => new Set(decks.map((item) => item.id)), [decks]);
  const builtins = PA_BUILTIN_DECKS.filter((item) => !own.has(item.id));
  const [paste, setPaste] = useState('');
  const [pasted, setPasted] = useState<{ deckId: string; added: number; skipped: number } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PaDeck | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusName = useRef(false);
  // Stable React keys for the card rows of each deck, so a moved card keeps its row (and the focus).
  const cardKeys = useRef(new Map<string, number[]>());
  const nextKey = useRef(1);
  const uid = useId();
  const ids = { name: `${uid}-name`, paste: `${uid}-paste` };

  useEffect(() => {
    if (!focusName.current) return;
    focusName.current = false;
    nameRef.current?.focus();
  });

  const keysOf = (item: PaDeck): number[] => {
    let keys = cardKeys.current.get(item.id);
    if (!keys || keys.length !== item.cards.length) {
      keys = item.cards.map(() => nextKey.current++);
      cardKeys.current.set(item.id, keys);
    }
    return keys;
  };
  const setKeys = (item: PaDeck, keys: number[]) => cardKeys.current.set(item.id, keys);

  const replaceDeck = (next: PaDeck) => onChange(decks.map((item) => (item.id === next.id ? next : item)));
  const select = (id: string) => {
    setSelectedId(id);
    setPaste('');
    setPasted(null);
  };

  const addDeck = () => {
    if (decks.length >= L.decks) return;
    const names = new Set(decks.map((item) => item.name.trim()));
    let n = decks.length + 1;
    while (names.has(t('pa.soul.editor.deck.newName', { n }))) n += 1;
    const deckName = t('pa.soul.editor.deck.newName', { n });
    const id = deckIdFor(deckName, own);
    onChange([...decks, { id, name: deckName, cards: [blankCard(), blankCard()] }]);
    select(id);
    focusName.current = true;
  };

  const removeDeck = (target: PaDeck) => {
    const at = decks.indexOf(target);
    const rest = decks.filter((item) => item.id !== target.id);
    cardKeys.current.delete(target.id);
    onChange(rest);
    const neighbour = rest[Math.min(Math.max(0, at), rest.length - 1)];
    select(neighbour?.id ?? '');
  };

  const moveDeck = (to: number) => {
    if (!deck || to < 0 || to >= decks.length || to === deckAt) return;
    onChange(moved(decks, deckAt, to));
  };

  const setCards = (item: PaDeck, cards: Card[], keys: number[]) => {
    setKeys({ ...item, cards }, keys);
    replaceDeck({ ...item, cards });
  };

  const patchCard = (item: PaDeck, index: number, patch: Partial<Card>) =>
    replaceDeck({ ...item, cards: item.cards.map((card, i) => (i === index ? { ...card, ...patch } : card)) });

  const addCard = (item: PaDeck) => {
    if (item.cards.length >= L.deckCards) return;
    setCards(item, [...item.cards, blankCard()], [...keysOf(item), nextKey.current++]);
  };

  const removeCard = (item: PaDeck, index: number) =>
    setCards(
      item,
      item.cards.filter((_, i) => i !== index),
      keysOf(item).filter((_, i) => i !== index),
    );

  const moveCard = (item: PaDeck, from: number, to: number) => {
    if (to < 0 || to >= item.cards.length || to === from) return;
    setCards(item, moved(item.cards, from, to), moved(keysOf(item), from, to));
  };

  /** Appends the pasted cards; a card left completely empty (a new deck's two blanks) gives its place to them. */
  const runPaste = (item: PaDeck) => {
    const keys = keysOf(item);
    const keptAt = item.cards.flatMap((card, i) => (filled(card) ? [i] : []));
    const kept = keptAt.map((i) => item.cards[i] as Card);
    const result = parseDeckLines(paste, L.deckCards - kept.length);
    setPasted({ deckId: item.id, added: result.cards.length, skipped: result.skipped });
    if (result.cards.length === 0) return;
    setCards(item, [...kept, ...result.cards], [...keptAt.map((i) => keys[i] ?? nextKey.current++), ...result.cards.map(() => nextKey.current++)]);
    setPaste('');
  };

  const flagged = (item: PaDeck) => issues.some((issue) => issue.deckId === item.id) || deckOver(item);
  const deckProblems = deck ? issues.filter((issue) => issue.deckId === deck.id) : [];
  const full = deck ? deck.cards.length >= L.deckCards : false;
  const countText = (item: PaDeck) => t('pa.soul.editor.deck.count', { n: item.cards.length, max: L.deckCards });
  const secretLabel = t('pa.soul.editor.deck.cardSecret', { name });

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="pa-profile-decks">
      <div className={modalStyles.group} role="list" aria-label={t('pa.soul.editor.play.decks')}>
        {decks.length === 0 ? <p className={styles.stateEmpty}>{t('pa.soul.editor.deck.empty')}</p> : null}
        {decks.map((item) => (
          <div
            key={item.id}
            role="listitem"
            className={styles.pickRow}
            data-tall=""
            data-selected={item.id === deck?.id ? '' : undefined}
            data-testid="pa-deck-row"
            data-deck-id={item.id}
          >
            <Button variant="bare" className={styles.pickButton} aria-pressed={item.id === deck?.id} onClick={() => select(item.id)}>
              <span className={styles.deckName} data-empty={item.name.trim() ? undefined : ''}>
                {item.name.trim() || '—'}
              </span>
              <span className={styles.pickMeta}>{countText(item)}</span>
              {flagged(item) ? (
                <>
                  <span aria-hidden className={styles.navDot} />
                  <VisuallyHidden>{t('pa.soul.editor.nav.error')}</VisuallyHidden>
                </>
              ) : null}
            </Button>
          </div>
        ))}
        {builtins.map((item) => (
          <div key={item.id} role="listitem" className={modalStyles.listRow} data-testid="pa-deck-builtin" data-deck-id={item.id}>
            <span className={modalStyles.listName}>{item.name}</span>
            <span className={modalStyles.listMeta}>{t('pa.soul.editor.play.deckCards', { n: item.cards.length })}</span>
            <SoulTag tone="outline">{t('pa.soul.editor.play.deckBuiltin')}</SoulTag>
          </div>
        ))}
      </div>

      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          disabled={decks.length >= L.decks}
          disabledReason={t('pa.soul.editor.deck.limit', { n: L.decks })}
          data-testid="pa-deck-add"
          onClick={addDeck}
        >
          <PlusIcon size="sm" />
          {t('pa.soul.editor.deck.add')}
        </Button>
        <span className={modalStyles.fieldHint}>{t('pa.soul.editor.deck.builtinNote')}</span>
      </div>

      {deck ? (
        <div className={modalStyles.group} data-testid="pa-deck-form" data-deck-id={deck.id}>
          <div className={styles.deckHead}>
            <SoulField
              id={ids.name}
              label={t('pa.soul.editor.deck.name')}
              text={deck.name}
              max={L.deckName}
              error={deckProblems.some((issue) => issue.kind === 'name') ? t(ISSUE_TEXT.name) : undefined}
              className={styles.deckNameField}
            >
              <Input
                ref={nameRef}
                id={ids.name}
                value={deck.name}
                autoComplete="off"
                aria-invalid={deck.name.trim() === '' || deck.name.length > L.deckName || undefined}
                onChange={(event) => replaceDeck({ ...deck, name: event.target.value })}
              />
            </SoulField>
            {decks.length > 1 ? (
              <div className={styles.deckOrder}>
                <span className={styles.deckOrderLabel}>{t('pa.soul.lore.entry.order')}</span>
                <SoulStepper
                  value={deckAt + 1}
                  min={1}
                  max={decks.length}
                  aria-label={t('pa.soul.lore.entry.order')}
                  onChange={(position) => moveDeck(position - 1)}
                />
              </div>
            ) : null}
          </div>

          <div className={styles.cards}>
            <div className={styles.cardGrid} data-head="">
              <span className={styles.cardHeadCell}>{t('pa.soul.lore.entry.order')}</span>
              <span className={styles.cardHeadCell}>{t('pa.soul.editor.deck.cardTitle')}</span>
              <span className={styles.cardHeadCell}>{t('pa.soul.editor.deck.cardText')}</span>
              <span className={styles.cardHeadCell}>
                {secretLabel}
                <span className={styles.cardHeadHint}>{t('pa.soul.editor.deck.cardSecretHint')}</span>
              </span>
              <span aria-hidden />
            </div>
            {deck.cards.map((card, index) => {
              const key = keysOf(deck)[index] ?? index;
              const n = index + 1;
              return (
                <div key={key} className={styles.cardGrid} data-testid="pa-card-row">
                  <SoulStepper
                    value={n}
                    min={1}
                    max={deck.cards.length}
                    aria-label={`${t('pa.soul.lore.entry.order')} ${n}`}
                    onChange={(position) => moveCard(deck, index, position - 1)}
                  />
                  <SoulField text={card.title} max={L.cardTitle}>
                    <Input
                      value={card.title}
                      autoComplete="off"
                      aria-label={`${t('pa.soul.editor.deck.cardTitle')} ${n}`}
                      // A blank card is not marked (the line under the cards says why 保存 waits); a card with text
                      // but no title is.
                      aria-invalid={(card.title.trim() === '' && filled(card)) || card.title.length > L.cardTitle || undefined}
                      onChange={(event) => patchCard(deck, index, { title: event.target.value })}
                    />
                  </SoulField>
                  <SoulField text={card.text} max={L.cardText}>
                    <Textarea
                      rows={2}
                      value={card.text}
                      aria-label={`${t('pa.soul.editor.deck.cardText')} ${n}`}
                      aria-invalid={card.text.length > L.cardText || undefined}
                      onChange={(event) => patchCard(deck, index, { text: event.target.value })}
                    />
                  </SoulField>
                  <SoulField text={card.secret} max={L.cardSecret}>
                    <Textarea
                      rows={2}
                      value={card.secret}
                      aria-label={`${secretLabel} ${n}`}
                      aria-invalid={card.secret.length > L.cardSecret || undefined}
                      onChange={(event) => patchCard(deck, index, { secret: event.target.value })}
                    />
                  </SoulField>
                  <IconButton size="xs" aria-label={t('pa.soul.editor.deck.removeCard')} onClick={() => removeCard(deck, index)}>
                    <Icon icon={Trash2} size="sm" />
                  </IconButton>
                </div>
              );
            })}
          </div>

          <div className={styles.deckFoot}>
            <Button variant="secondary" size="sm" disabled={full} disabledReason={countText(deck)} onClick={() => addCard(deck)}>
              <PlusIcon size="sm" />
              {t('pa.soul.editor.deck.addCard')}
            </Button>
            <span className={styles.deckCount}>{countText(deck)}</span>
            {deckProblems
              .filter((issue) => issue.kind !== 'name')
              .map((issue) => (
                <span key={issue.kind} className={styles.deckIssue}>
                  {t(ISSUE_TEXT[issue.kind])}
                </span>
              ))}
          </div>

          <div className={modalStyles.groupPad}>
            <SoulField id={ids.paste} label={t('pa.soul.editor.deck.paste')} hint={t('pa.soul.editor.deck.pasteHint')} text={paste} max={L.deckPasteChars}>
              <Textarea
                id={ids.paste}
                rows={5}
                value={paste}
                spellCheck={false}
                data-testid="pa-deck-paste"
                onChange={(event) => {
                  setPaste(event.target.value);
                  setPasted(null);
                }}
              />
            </SoulField>
            <div className={styles.actions}>
              <Button
                variant="secondary"
                size="sm"
                disabled={paste.trim() === '' || full}
                disabledReason={full ? countText(deck) : undefined}
                data-testid="pa-deck-paste-add"
                onClick={() => runPaste(deck)}
              >
                {t('pa.soul.editor.deck.pasteAdd')}
              </Button>
              {pasted && pasted.deckId === deck.id ? (
                <span role="status" className={styles.pasteResult}>
                  <span>{t('pa.soul.editor.deck.pasteResult', { n: pasted.added })}</span>
                  {pasted.skipped > 0 ? (
                    <span className={styles.pasteSkipped}>{t('pa.soul.editor.deck.pasteSkipped', { n: pasted.skipped, max: L.deckCards })}</span>
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>

          <div className={styles.deckEnd}>
            <Button variant="ghost" size="sm" className={modalStyles.dangerQuiet} onClick={() => setConfirmRemove(deck)}>
              {t('pa.soul.editor.deck.remove')}
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmRemove(null);
        }}
        title={t('pa.soul.editor.deck.remove')}
        description={confirmRemove ? `${confirmRemove.name.trim() || '—'} · ${countText(confirmRemove)}` : undefined}
        confirmLabel={t('pa.delete')}
        cancelLabel={t('pa.cancel')}
        destructive
        onConfirm={() => {
          if (confirmRemove) removeDeck(confirmRemove);
          setConfirmRemove(null);
        }}
      />
    </div>
  );
}
