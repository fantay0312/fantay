// SPDX-License-Identifier: AGPL-3.0-only
// The inspector body of a companion chat (Soul UI spec §5.1–5.4): a portrait hero and three inline tabs on the existing
// glide track — TA (who the character is and where its settings live), 此刻 (story state, interlude and the quick
// selects of this chat) and 记忆 (想记下, 约定, 记得的事). Chrome is ink only: colour stays in the portrait. The panel,
// its head and its resize belong to PaInspector; this component renders everything below the head. Stage 2: in a
// character's own direct chat the hero shows the sprite of the newest stored reply's mood, and TA lists the sprite set
// with the one on screen marked and the mood word the character wrote — never a feeling the reply did not state.
import { PA_EMOTIONS, type PaStateField, type PaStateValue, type StateEffect } from '@open-design/contracts/soul';
import { BookHeart, ChevronRight, MoreHorizontal, Pencil } from 'lucide-react';
import { useRef, useState, type ReactNode, type UIEvent } from 'react';

import { useGlideIndicator } from '../../../hooks/useGlideIndicator';
import { useI18n, useT } from '../../../i18n';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  VisuallyHidden,
  cn,
  toast,
} from '../../ui';
import { paSoulAssetUrl } from '../pa-api';
import { usePa } from '../pa-context';
import { conversationKind, isFantay } from '../pa-model';
import { paMemoryInUse } from '../PaMemoryModal';
import type {
  PaCharacterView,
  PaChatSettingsPatch,
  PaChatView,
  PaConversation,
  PaEmotion,
  PaGroup,
  PaIndex,
  PaInspectorTab,
  PaMemory,
  PaMemoryCandidate,
  PaMemoryInput,
  PaSubject,
  PersonalAgent,
} from '../pa-types';
import { PaGroupAvatar } from '../PaAvatar';
import { PaModelPicker } from '../PaModelPicker';
import { paPendingKey } from '../usePaWorkspace';
import frame from '../PaInspector.module.css';
import {
  characterOf,
  chatOf,
  chatStateOf,
  displayName,
  emotionOfReply,
  promisesFor,
  relationshipFacts,
  replyEffects,
  replyMood,
  resolveChatAppearance,
  shownSprite,
  soulItems,
  type PaSoulItem,
} from './soul-model';
import { soulThemeName } from './soul-theme';
import { SoulAgentPortrait, SoulPortrait } from './SoulPortrait';
import { SoulStateBar, SoulStepper, SoulTag, SoulTagInput } from './SoulPrimitives';
import styles from './SoulInspector.module.css';

type T = ReturnType<typeof useT>;
type SoulTab = Extract<PaInspectorTab, 'soul' | 'scene' | 'memory'>;

const SOUL_TABS: readonly SoulTab[] = ['soul', 'scene', 'memory'];
const DAY = 86_400_000;
const MAX_REMEMBERED = 8;
const FOLLOW = '__follow__';
const HISTORY_BUDGETS = ['short', 'medium', 'long', 'max'] as const;
const STRATEGIES = ['natural', 'list', 'manual'] as const;
const MINUS = '−';
/** Bounds of a number field without its own min or max (the stepper needs both). */
const OPEN_BOUND = 999_999;
/** Size of one sprite in TA's 立绘 set (four to a row at the narrowest inspector). */
const SPRITE_TILE = 52;

/* ── pure helpers (exported for the tests and the work inspector) ──────────────────────────── */

/** The first non-empty line of a memory or role, without its markdown marks. */
export function memoryFirstLine(content: string): string {
  const line = content.split('\n').find((part) => part.trim().length > 0) ?? '';
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, '')
    .replace(/[*_`]+/g, '')
    .trim();
}

function startOfLocalDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** 今天 / 明天 / 「11月21日」 / 已过 N 天 — never red, never blaming. */
export function soulDueLabel(t: T, dueAt: number, now: number, locale: string): string {
  const days = Math.round((startOfLocalDay(dueAt) - startOfLocalDay(now)) / DAY);
  if (days === 0) return t('pa.soul.inspector.memory.today');
  if (days === 1) return t('pa.soul.inspector.memory.tomorrow');
  if (days < 0) return t('pa.soul.inspector.memory.overdue', { n: -days });
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(dueAt);
}

const KIND_KEY = {
  preference: 'pa.soul.inspector.kind.preference',
  fact: 'pa.soul.inspector.kind.fact',
  procedure: 'pa.soul.inspector.kind.procedure',
  promise: 'pa.soul.inspector.kind.promise',
  moment: 'pa.soul.inspector.kind.moment',
} as const;

/** The kind tag of a memory row; kinds without a Soul label (e.g. a work-side `profile`) show no tag. */
function kindLabel(t: T, kind: PaMemory['kind'] | PaMemoryCandidate['kind']): string | null {
  return kind && Object.hasOwn(KIND_KEY, kind) ? t(KIND_KEY[kind as keyof typeof KIND_KEY]) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(error: unknown): void {
  toast({ tone: 'danger', title: errorText(error) });
}

/** A save body for an existing memory: its own fields, then the patch. Nothing is spread from the entity. */
function memoryInput(memory: PaMemory, patch: Partial<PaMemoryInput>): PaMemoryInput {
  return {
    content: memory.content,
    source: memory.source,
    scope: memory.scope,
    scopeId: memory.scopeId ?? null,
    ...(memory.kind ? { kind: memory.kind } : {}),
    ...(memory.originKind ? { originKind: memory.originKind } : {}),
    ...(memory.pinned !== undefined ? { pinned: memory.pinned } : {}),
    ...(memory.status ? { status: memory.status } : {}),
    ...(memory.evolves !== undefined ? { evolves: memory.evolves } : {}),
    ...(memory.sourceRefs ? { sourceRefs: memory.sourceRefs } : {}),
    ...(memory.validFrom !== undefined ? { validFrom: memory.validFrom } : {}),
    ...(memory.validUntil !== undefined ? { validUntil: memory.validUntil } : {}),
    ...(memory.dataClass ? { dataClass: memory.dataClass } : {}),
    ...(memory.dueAt !== undefined ? { dueAt: memory.dueAt } : {}),
    ...(memory.sourceMessageId !== undefined ? { sourceMessageId: memory.sourceMessageId } : {}),
    ...patch,
  };
}

function kept(memory: PaMemory, now: number): boolean {
  return typeof memory.validUntil === 'number' && memory.validUntil <= now;
}

function membersOf(index: PaIndex, group: PaGroup): PersonalAgent[] {
  return group.memberIds.map((id) => index.agents.get(id)).filter((agent): agent is PersonalAgent => Boolean(agent));
}

/** Pending 想记下 of this chat: proposed in it, or (direct chats) by its character. */
function chatCandidates(candidates: readonly PaMemoryCandidate[] | undefined, conversation: PaConversation, agentId: string | null) {
  return (candidates ?? []).filter(
    (candidate) =>
      candidate.status === 'pending' &&
      (candidate.conversationId === conversation.id || (agentId !== null && candidate.agentId === agentId)),
  );
}

/** The newest visible agent chat reply (the one a trace exists for). */
export function newestReply(index: PaIndex, conversationId: string): PaSoulItem | null {
  const items = soulItems(index, conversationId);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (!item.hidden && item.role === 'agent' && item.message.soul?.kind === 'chat') return item;
  }
  return null;
}

/** The mood word of the reply `emotionOfReply` reads, while fresh (soul-model owns the window). The inspector never
 *  names a feeling the reply did not state. Re-exported for the tests. */
export { replyMood };

/** Which sprite the header and the hero draw for an emotion (soul-model owns it; the standing picture uses it too).
 *  Re-exported for the tests. */
export { shownSprite };

/** The emotion the portrait of `agentId` follows in this chat: only in the character's own direct chat (rooms, and a
 *  member inspected from a room, keep the portrait), never for Fantay. */
function portraitEmotion(index: PaIndex, conversation: PaConversation, agentId: string, now: number): PaEmotion | null {
  if (conversationKind(conversation) !== 'direct' || conversation.agentId !== agentId || isFantay(index, agentId)) return null;
  return emotionOfReply(index, conversation.id, agentId, now);
}

/** World books in force for this chat: the characters' own, the chat's, and every global book. */
function loreCount(index: PaIndex, chat: PaChatView, characters: readonly (PaCharacterView | null)[]): number {
  const ids = new Set<string>(chat.lorebookIds);
  for (const character of characters) for (const id of character?.lorebookIds ?? []) ids.add(id);
  for (const book of index.lorebooks.values()) if (book.global) ids.add(book.id);
  return [...ids].filter((id) => index.lorebooks.has(id)).length;
}

/** A hairline under the tabs appears once a pane has scrolled, so content never slides under the fixed chrome without
 *  an edge. Written straight to the element: a scroll position is not React state. */
export function markPaneScrolled(event: UIEvent<HTMLDivElement>) {
  const pane = event.currentTarget;
  const scrolled = pane.scrollTop > 0;
  if ((pane.dataset.scrolled === 'true') === scrolled) return;
  if (scrolled) pane.dataset.scrolled = 'true';
  else delete pane.dataset.scrolled;
}

/* ── frame ─────────────────────────────────────────────────────────────────────────────────── */

export function SoulInspector({ conversation, subject }: { conversation: PaConversation; subject: PaSubject }) {
  const t = useT();
  const { data, ui, nav } = usePa();
  const tab: SoulTab = (SOUL_TABS as readonly string[]).includes(ui.inspectorTab) ? (ui.inspectorTab as SoulTab) : 'soul';
  const agentId = subject.kind === 'agent' ? subject.agent.id : null;
  const pendingCount = chatCandidates(data.snapshot?.memoryCandidates, conversation, agentId).length;
  const subjectKey = subject.kind === 'agent' ? `agent:${subject.agent.id}` : `group:${subject.group.id}`;

  const trackRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  useGlideIndicator({
    containerRef: trackRef,
    indicatorRef: chipRef,
    activeSelector: '[role="tab"][aria-selected="true"]',
    activeKey: tab,
    layoutKey: `${pendingCount > 0}-${subjectKey}`,
  });
  const [motion, setMotion] = useState<{ tab: SoulTab; dir: 'next' | 'prev' | null }>({ tab, dir: null });
  if (motion.tab !== tab) setMotion({ tab, dir: SOUL_TABS.indexOf(tab) > SOUL_TABS.indexOf(motion.tab) ? 'next' : 'prev' });

  return (
    <div className={styles.body} data-testid="pa-soul-inspector">
      <SoulHero conversation={conversation} subject={subject} />
      <Tabs value={tab} onValueChange={(value) => nav.setInspector(true, value as PaInspectorTab)} className={frame.tabs}>
        <TabsList ref={trackRef} className={frame.track} aria-label={t('pa.soul.inspector.title')}>
          <span ref={chipRef} className={frame.chip} aria-hidden />
          {SOUL_TABS.map((value) => (
            <TabsTrigger key={value} value={value} className={frame.tab} data-testid={`pa-soul-tab-${value}`}>
              <span className={frame.tabLabel}>{t(`pa.soul.inspector.tabs.${value}`)}</span>
              {value === 'memory' && pendingCount > 0 ? (
                <span className={frame.tabBadge} data-tone="ink">
                  {pendingCount}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="soul" className={frame.pane} data-dir={motion.dir ?? undefined} onScroll={markPaneScrolled}>
          <ProfilePane conversation={conversation} subject={subject} />
        </TabsContent>
        <TabsContent value="scene" className={frame.pane} data-dir={motion.dir ?? undefined} onScroll={markPaneScrolled}>
          <ScenePane conversation={conversation} subject={subject} />
        </TabsContent>
        <TabsContent value="memory" className={frame.pane} data-dir={motion.dir ?? undefined} onScroll={markPaneScrolled}>
          <MemoryPane conversation={conversation} subject={subject} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ── hero ──────────────────────────────────────────────────────────────────────────────────── */

function SoulHero({ conversation, subject }: { conversation: PaConversation; subject: PaSubject }) {
  const t = useT();
  const { index, nav, now } = usePa();

  if (subject.kind === 'group') {
    const group = subject.group;
    const members = membersOf(index, group);
    return (
      <div className={styles.hero} data-testid="pa-soul-hero" data-kind="group">
        <span className={styles.aura} aria-hidden />
        <div className={styles.portrait}>
          <PaGroupAvatar members={members} fantayId={index.fantay?.id ?? null} size={72} />
        </div>
        <h2 className={styles.name}>{group.name || conversation.title}</h2>
        <p className={styles.facts}>{t('pa.soul.inspector.hero.members', { n: members.length })}</p>
      </div>
    );
  }

  const agent = subject.agent;
  const character = characterOf(index, agent.id);
  const facts = relationshipFacts(index, agent.id, now);
  const tagline = character?.tagline.trim() ?? '';
  const emotion = portraitEmotion(index, conversation, agent.id, now);
  // Named for assistive technology only when the picture really is that emotion's own sprite.
  const spriteLabel =
    emotion !== null && emotion !== 'neutral' && shownSprite(character?.sprites, emotion) === emotion
      ? t('pa.soul.inspector.sprite.aria', { name: displayName(index, agent.id), emotion: t(`pa.soul.emotion.${emotion}`) })
      : null;
  return (
    <div className={styles.hero} data-testid="pa-soul-hero" data-kind="agent">
      <span className={styles.aura} aria-hidden />
      <div className={styles.portrait} data-emotion={emotion ?? undefined}>
        <SoulAgentPortrait
          agent={agent}
          character={character}
          fantay={isFantay(index, agent.id)}
          size={96}
          dim={!agent.enabled}
          emotion={emotion}
        />
        {spriteLabel ? <VisuallyHidden data-testid="pa-soul-hero-sprite">{spriteLabel}</VisuallyHidden> : null}
        <span className={styles.badge}>
          <IconButton
            size="xs"
            shape="round"
            className={styles.badgeButton}
            aria-label={t('pa.soul.inspector.hero.edit')}
            onClick={() => nav.openModal({ kind: 'agent', agentId: agent.id })}
          >
            <Icon icon={Pencil} size={12} />
          </IconButton>
        </span>
      </div>
      <h2 className={styles.name}>{displayName(index, agent.id)}</h2>
      {tagline ? <p className={styles.tagline}>{tagline}</p> : null}
      {facts.firstMetAt !== null ? (
        <p className={styles.facts} data-testid="pa-soul-facts">
          {t('pa.soul.inspector.hero.facts', { days: facts.days, messages: facts.messages })}
        </p>
      ) : null}
    </div>
  );
}

/* ── shared rows ───────────────────────────────────────────────────────────────────────────── */

function Block({ title, count, children, testId }: { title?: ReactNode; count?: number; children: ReactNode; testId?: string }) {
  return (
    <section className={styles.block} data-testid={testId}>
      {title ? (
        <h3 className={styles.heading}>
          {title}
          {count !== undefined ? <span className={styles.headingCount}>{count}</span> : null}
        </h3>
      ) : null}
      {children}
    </section>
  );
}

/** A row that opens something: label at the start, an optional value at the end, a chevron. */
function LinkRow({
  label,
  value,
  preview,
  onClick,
  chevron = true,
  testId,
}: {
  label: ReactNode;
  value?: ReactNode;
  /** A two-line preview under the label (本次场景, 便签). */
  preview?: ReactNode;
  onClick?(): void;
  chevron?: boolean;
  testId?: string;
}) {
  const body = (
    <>
      <span className={styles.rowMain}>
        <span className={styles.rowLabel}>{label}</span>
        {preview ? <span className={styles.rowPreview}>{preview}</span> : null}
      </span>
      {value !== undefined && value !== null && value !== '' ? <span className={styles.rowValue}>{value}</span> : null}
      {onClick && chevron ? <Icon icon={ChevronRight} size={14} className={styles.chevron} /> : null}
    </>
  );
  if (!onClick) {
    return (
      <div className={styles.row} data-testid={testId}>
        {body}
      </div>
    );
  }
  return (
    <Button variant="bare" className={styles.rowButton} data-testid={testId} onClick={() => onClick()}>
      {body}
    </Button>
  );
}

/** A label and a control (select, picker) on one row. */
function ControlRow({ label, busy, children }: { label: ReactNode; busy?: boolean; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      {busy ? <Spinner size="xs" className={styles.rowSpinner} /> : null}
      <span className={styles.rowControl}>{children}</span>
    </div>
  );
}

/** label · value rows of 关于: the value wraps at the end. */
function FactRow({ label, children, onClick, testId }: { label: ReactNode; children: ReactNode; onClick?(): void; testId?: string }) {
  const body = (
    <>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{children}</span>
      {onClick ? <Icon icon={ChevronRight} size={14} className={styles.chevron} /> : null}
    </>
  );
  if (!onClick) {
    return (
      <div className={cn(styles.row, styles.factRow)} data-testid={testId}>
        {body}
      </div>
    );
  }
  return (
    <Button variant="bare" className={cn(styles.rowButton, styles.factRow)} data-testid={testId} onClick={() => onClick()}>
      {body}
    </Button>
  );
}

/* ── TA ────────────────────────────────────────────────────────────────────────────────────── */

function sourceText(t: T, character: PaCharacterView | null): string {
  const origin = character?.origin ?? null;
  if (!origin || origin.format === 'native') return t('pa.soul.inspector.soul.sourceOwn');
  if (origin.format === 'starter') return t('pa.soul.inspector.soul.sourceStarter');
  return t('pa.soul.inspector.soul.sourceCard', { n: origin.format.slice(-1), name: origin.name });
}

function ProfilePane({ conversation, subject }: { conversation: PaConversation; subject: PaSubject }) {
  const t = useT();
  const { locale } = useI18n();
  const { index, nav } = usePa();
  const themeName = soulThemeName(resolveChatAppearance(index, conversation).theme, locale.startsWith('zh') ? 'zh' : 'en');
  const settings = () => nav.openModal({ kind: 'chatSettings', conversationId: conversation.id });
  const look = () => nav.openModal({ kind: 'appearance', conversationId: conversation.id });

  if (subject.kind === 'group') {
    const group = subject.group;
    const members = membersOf(index, group);
    return (
      <div className={frame.paneStack} data-gap="soul">
        <Block title={t('pa.soul.inspector.soul.members')} count={members.length}>
          <div className={styles.card}>
            {members.map((member) => {
              const character = characterOf(index, member.id);
              return (
                <Button
                  key={member.id}
                  variant="bare"
                  className={cn(styles.rowButton, styles.memberRow)}
                  data-testid="pa-soul-member"
                  onClick={() => nav.inspectAgent(member.id)}
                >
                  <SoulAgentPortrait agent={member} character={character} fantay={isFantay(index, member.id)} size={28} dim={!member.enabled} />
                  <span className={styles.rowMain}>
                    <span className={styles.memberName}>{displayName(index, member.id)}</span>
                    {character?.tagline ? <span className={styles.memberTagline}>{character.tagline}</span> : null}
                  </span>
                  <Icon icon={ChevronRight} size={14} className={styles.chevron} />
                </Button>
              );
            })}
          </div>
        </Block>
        <div className={styles.card}>
          <LinkRow label={t('pa.soul.inspector.soul.settings')} onClick={settings} />
          <LinkRow label={t('pa.soul.inspector.soul.look')} value={themeName} onClick={look} />
          <LinkRow label={t('pa.soul.inspector.soul.editGroup')} onClick={() => nav.openModal({ kind: 'group', groupId: group.id })} />
        </div>
        <p className={styles.footnote}>{t('pa.soul.inspector.soul.footnoteRoom')}</p>
      </div>
    );
  }

  const agent = subject.agent;
  const character = characterOf(index, agent.id);
  const name = displayName(index, agent.id);
  const tags = character?.tags ?? [];
  const books = (character?.lorebookIds ?? [])
    .map((id) => index.lorebooks.get(id))
    .filter((book): book is NonNullable<typeof book> => Boolean(book));
  const review = character?.needsReview.length ?? 0;

  return (
    <div className={frame.paneStack} data-gap="soul">
      <div className={styles.card} data-testid="pa-soul-profile-links">
        <LinkRow label={t('pa.soul.inspector.soul.edit')} onClick={() => nav.openModal({ kind: 'agent', agentId: agent.id })} />
        <LinkRow label={t('pa.soul.inspector.soul.look')} value={themeName} onClick={look} />
        <LinkRow label={t('pa.soul.inspector.soul.settings')} onClick={settings} />
        <ControlRow label={t('pa.soul.inspector.soul.model')}>
          <PaModelPicker agent={agent} variant="profile" className={styles.picker} />
        </ControlRow>
      </div>

      {character && !isFantay(index, agent.id) ? <SpriteSet conversation={conversation} agent={agent} character={character} /> : null}

      <Block title={t('pa.soul.inspector.soul.about')} testId="pa-soul-about">
        <div className={styles.card}>
          {tags.length > 0 ? <FactRow label={t('pa.soul.inspector.soul.tags')}>{tags.join(' · ')}</FactRow> : null}
          <FactRow label={t('pa.soul.inspector.soul.source')}>{sourceText(t, character)}</FactRow>
          {books.length > 0 ? (
            books.map((book, position) => (
              <FactRow
                key={book.id}
                label={position === 0 ? t('pa.soul.inspector.soul.lore') : ''}
                onClick={() => nav.openModal({ kind: 'lorebook', lorebookId: book.id })}
              >
                {book.name}
              </FactRow>
            ))
          ) : (
            <FactRow label={t('pa.soul.inspector.soul.lore')}>{t('pa.soul.inspector.soul.loreNone')}</FactRow>
          )}
        </div>
      </Block>

      {review > 0 ? (
        <div className={styles.card}>
          <LinkRow
            label={t('pa.soul.inspector.soul.review', { n: review })}
            onClick={() => nav.openModal({ kind: 'agent', agentId: agent.id, section: 'advanced' })}
          />
        </div>
      ) : null}

      <p className={styles.footnote}>{t('pa.soul.inspector.soul.footnote', { name })}</p>
    </div>
  );
}

/** 立绘: the sprites the character has, in emotion order, the one on screen in the header and the hero marked. The row
 *  above opens the profile editor's 立绘 section and carries the mood word of the reply that picked the sprite. Nothing
 *  is drawn for a character without sprites. */
function SpriteSet({ conversation, agent, character }: { conversation: PaConversation; agent: PersonalAgent; character: PaCharacterView }) {
  const t = useT();
  const { index, nav, now } = usePa();
  const sprites = character.sprites;
  const set = PA_EMOTIONS.filter((emotion) => Boolean(sprites?.[emotion]));
  if (set.length === 0) return null;
  const emotion = portraitEmotion(index, conversation, agent.id, now);
  const shown = emotion === null ? null : shownSprite(sprites, emotion);
  const mood = emotion === null ? null : replyMood(index, conversation.id, agent.id, now);
  const name = displayName(index, agent.id);
  const theme = resolveChatAppearance(index, conversation).theme;
  return (
    <div className={styles.card} data-testid="pa-soul-sprites">
      <LinkRow
        label={t('pa.soul.editor.nav.sprites')}
        preview={mood ? <q className={styles.mood} data-testid="pa-soul-sprite-mood">{mood}</q> : undefined}
        value={t('pa.soul.editor.sprites.count', { n: set.length, total: PA_EMOTIONS.length })}
        onClick={() => nav.openModal({ kind: 'agent', agentId: agent.id, section: 'sprites' })}
        testId="pa-soul-sprites-edit"
      />
      <ul className={styles.spriteGrid}>
        {set.map((item) => (
          <li
            key={item}
            className={styles.sprite}
            data-testid="pa-soul-sprite"
            data-emotion={item}
            data-current={shown === item ? '' : undefined}
            aria-current={shown === item ? 'true' : undefined}
          >
            <span className={styles.spriteFace}>
              <SoulPortrait src={paSoulAssetUrl(sprites?.[item])} name={name} size={SPRITE_TILE} frame="squircle" theme={theme} />
            </span>
            <span className={styles.spriteLabel}>{t(`pa.soul.emotion.${item}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── 此刻 ──────────────────────────────────────────────────────────────────────────────────── */

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${MINUS}${Math.abs(n)}`;
}

/** The mark of a state row: the newest reply's change, else a dot when the user has set the field. */
function effectMark(effect: StateEffect | undefined): string | null {
  if (!effect) return null;
  if (typeof effect.delta === 'number' && effect.delta !== 0) return signed(effect.delta);
  const added = effect.added?.length ?? 0;
  const removed = effect.removed?.length ?? 0;
  if (added > 0 && removed === 0) return `+${added}`;
  if (removed > 0 && added === 0) return `${MINUS}${removed}`;
  return null;
}

function hasBar(field: PaStateField): field is Extract<PaStateField, { kind: 'number' }> & { min: number; max: number } {
  return field.kind === 'number' && field.min !== undefined && field.max !== undefined && field.render !== 'value';
}

function valueText(field: PaStateField, value: PaStateValue | undefined): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.join('、');
  if (hasBar(field) && typeof value === 'number') return `${value} / ${field.max}`;
  return String(value);
}

function StateValueView({ field, value }: { field: PaStateField; value: PaStateValue | undefined }) {
  if (field.kind === 'list') {
    const items = Array.isArray(value) ? value : [];
    return (
      <span className={styles.stateTags}>
        {items.length > 0 ? (
          items.map((item) => (
            <SoulTag key={item} tone="neutral">
              {item}
            </SoulTag>
          ))
        ) : (
          <span className={styles.stateEmpty}>—</span>
        )}
      </span>
    );
  }
  if (hasBar(field) && typeof value === 'number') {
    return (
      <span className={styles.stateMeter}>
        <span className={styles.stateBar}>
          <SoulStateBar value={value} min={field.min} max={field.max} size="md" />
        </span>
        <span className={styles.stateNumber}>{valueText(field, value)}</span>
      </span>
    );
  }
  return <span className={field.kind === 'number' ? styles.stateNumber : styles.stateText}>{valueText(field, value)}</span>;
}

function StateEditor({
  field,
  draft,
  onDraft,
}: {
  field: PaStateField;
  draft: PaStateValue;
  onDraft(next: PaStateValue): void;
}) {
  const t = useT();
  if (field.kind === 'number') {
    return (
      <SoulStepper
        value={typeof draft === 'number' ? draft : field.initial}
        min={field.min ?? -OPEN_BOUND}
        max={field.max ?? OPEN_BOUND}
        aria-label={field.label}
        onChange={(next) => onDraft(next)}
      />
    );
  }
  if (field.kind === 'enum') {
    return (
      <Select value={typeof draft === 'string' ? draft : field.initial} onValueChange={(next) => onDraft(next)}>
        <SelectTrigger size="sm" className="w-full" aria-label={field.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (field.kind === 'list') {
    return (
      <SoulTagInput
        value={Array.isArray(draft) ? draft : []}
        onChange={(next) => onDraft(next)}
        maxLength={80}
        max={40}
        placeholder={t('pa.soul.inspector.scene.listAdd')}
        aria-label={field.label}
      />
    );
  }
  return (
    <Input
      value={typeof draft === 'string' ? draft : ''}
      maxLength={400}
      aria-label={field.label}
      autoFocus
      onChange={(event) => onDraft(event.target.value)}
    />
  );
}

function StateRow({
  conversationId,
  field,
  value,
  edited,
  mark,
}: {
  conversationId: string;
  field: PaStateField;
  value: PaStateValue | undefined;
  edited: boolean;
  mark: string | null;
}) {
  const t = useT();
  const { data } = usePa();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PaStateValue>(value ?? field.initial);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    const next =
      field.kind === 'number'
        ? Number(draft)
        : field.kind === 'list'
          ? (Array.isArray(draft) ? draft : [])
          : String(draft).trim().slice(0, 400);
    setSaving(true);
    try {
      await data.actions.applyStateOps(conversationId, [{ key: field.key, op: 'set', value: next }]);
      setOpen(false);
    } catch (error) {
      fail(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(value ?? field.initial);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="bare"
          className={styles.stateRow}
          data-testid="pa-soul-state-row"
          data-kind={field.kind}
          aria-label={`${field.label} ${valueText(field, value)}`.trim()}
        >
          <span className={styles.stateLabel}>{field.label}</span>
          <span className={styles.stateControl}>
            <StateValueView field={field} value={value} />
          </span>
          <span className={styles.stateMark}>
            {mark ? (
              <span className={styles.stateDelta}>{mark}</span>
            ) : edited ? (
              <span className={styles.editedDot} role="img" aria-label={t('pa.soul.inspector.scene.stateEdited')} />
            ) : null}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent width="sm" align="end" className={styles.popover} data-testid="pa-soul-state-editor">
        <form
          className={styles.popoverForm}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className={styles.popoverTitle}>{field.label}</div>
          <StateEditor field={field} draft={draft} onDraft={setDraft} />
          <div className={styles.popoverActions}>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t('pa.cancel')}
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={saving}>
              {t('pa.save')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function StateBlock({ conversation }: { conversation: PaConversation }) {
  const t = useT();
  const { index } = usePa();
  const state = chatStateOf(index, conversation);
  if (!state.active) return null;
  const chat = chatOf(index, conversation.id);
  const userKeys = new Set(chat.userStateOps.map((op) => op.key));
  const reply = newestReply(index, conversation.id);
  const effects = new Map<string, StateEffect>();
  if (reply) for (const effect of replyEffects(index, conversation, reply)) effects.set(effect.key, effect);
  const story = state.schema.some((field) => field.kind === 'number');
  return (
    <Block title={t('pa.soul.inspector.scene.state')} count={state.schema.length} testId="pa-soul-state">
      <div className={styles.card}>
        {story ? <div className={styles.caption}>{t('pa.soul.inspector.scene.storyState')}</div> : null}
        {state.schema.map((field) => (
          <StateRow
            key={field.key}
            conversationId={conversation.id}
            field={field}
            value={state.values[field.key]}
            edited={userKeys.has(field.key)}
            mark={effectMark(effects.get(field.key))}
          />
        ))}
      </div>
    </Block>
  );
}

function EventBlock({ conversation }: { conversation: PaConversation }) {
  const t = useT();
  const { index, data } = usePa();
  const chat = chatOf(index, conversation.id);
  const busy = data.pending.has(paPendingKey.soulPlay(conversation.id));
  const act = (action: 'draw' | 'accept' | 'skip' | 'stop', respond?: boolean) =>
    void data.actions.eventAction(conversation.id, action, respond).catch(fail);

  if (chat.activeEvent) {
    const event = chat.activeEvent;
    return (
      <Block title={t('pa.soul.inspector.scene.event')} testId="pa-soul-event">
        <div className={cn(styles.card, styles.eventCard)}>
          <div className={styles.eventHead}>
            <span className={styles.eventTitle}>{event.title}</span>
            <span className={styles.eventLeft}>{t('pa.soul.inspector.scene.eventLeft', { n: event.remainingTurns })}</span>
          </div>
          {event.summary ? <p className={styles.eventSummary}>{event.summary}</p> : null}
          <div className={styles.eventActions}>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => act('stop')}>
              {t('pa.soul.inspector.scene.eventEnd')}
            </Button>
          </div>
        </div>
      </Block>
    );
  }
  if (chat.candidateEvent) {
    const offer = chat.candidateEvent;
    return (
      <Block title={t('pa.soul.inspector.scene.event')} testId="pa-soul-event">
        <div className={cn(styles.card, styles.eventCard)}>
          <div className={styles.eventHead}>
            <span className={styles.eventTitle}>{offer.title}</span>
          </div>
          {offer.summary ? <p className={styles.eventSummary}>{offer.summary}</p> : null}
          <div className={styles.eventActions}>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => act('skip')}>
              {t('pa.soul.inspector.scene.notNow')}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => act('draw')}>
              {t('pa.soul.inspector.scene.another')}
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => act('accept', true)}>
              {t('pa.soul.inspector.scene.accept')}
            </Button>
          </div>
        </div>
      </Block>
    );
  }
  return null;
}

function ChatBlock({ conversation, subject }: { conversation: PaConversation; subject: PaSubject }) {
  const t = useT();
  const { index, data, nav } = usePa();
  const chat = chatOf(index, conversation.id);
  const pending = data.pending.has(paPendingKey.soulChat(conversation.id));
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const room = subject.kind === 'group';
  const characters = room ? membersOf(index, subject.group).map((member) => characterOf(index, member.id)) : [characterOf(index, subject.agent.id)];
  const settings = () => nav.openModal({ kind: 'chatSettings', conversationId: conversation.id });

  const save = (row: string, patch: PaChatSettingsPatch) => {
    setBusyRow(row);
    void data.actions
      .saveChat(conversation.id, patch)
      .catch(fail)
      .finally(() => setBusyRow((current) => (current === row ? null : current)));
  };
  const busy = (row: string) => pending && busyRow === row;
  const scenario = chat.scenario.trim();
  const note = chat.authorNote?.text.trim() ?? '';

  return (
    <Block title={t('pa.soul.inspector.scene.chat')} testId="pa-soul-chat-block">
      <div className={styles.card}>
        <ControlRow label={t('pa.soul.inspector.scene.persona')} busy={busy('persona')}>
          <Select
            value={chat.personaId ?? FOLLOW}
            onValueChange={(next) => save('persona', { personaId: next === FOLLOW ? null : next })}
          >
            <SelectTrigger size="sm" className={styles.select} aria-label={t('pa.soul.inspector.scene.persona')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={FOLLOW}>{t('pa.soul.inspector.scene.follow')}</SelectItem>
              {[...index.personas.values()].map((persona) => (
                <SelectItem key={persona.id} value={persona.id}>
                  {persona.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ControlRow>
        {room ? null : (
          <ControlRow label={t('pa.soul.inspector.scene.preset')} busy={busy('preset')}>
            <Select
              value={chat.presetId ?? FOLLOW}
              onValueChange={(next) => save('preset', { presetId: next === FOLLOW ? null : next })}
            >
              <SelectTrigger size="sm" className={styles.select} aria-label={t('pa.soul.inspector.scene.preset')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={FOLLOW}>{t('pa.soul.inspector.scene.follow')}</SelectItem>
                {[...index.presets.values()].map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ControlRow>
        )}
        <ControlRow label={t('pa.soul.inspector.scene.history')} busy={busy('history')}>
          <Select value={chat.historyBudget} onValueChange={(next) => save('history', { historyBudget: next as PaChatView['historyBudget'] })}>
            <SelectTrigger size="sm" className={styles.select} aria-label={t('pa.soul.inspector.scene.history')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {HISTORY_BUDGETS.map((budget) => (
                <SelectItem key={budget} value={budget}>
                  {t(`pa.soul.inspector.scene.history.${budget}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ControlRow>
        {room ? (
          <div className={styles.stackRow}>
            <span className={styles.stackRowHead}>
              <span className={styles.rowLabel}>{t('pa.soul.inspector.scene.strategy')}</span>
              {busy('strategy') ? <Spinner size="xs" className={styles.rowSpinner} /> : null}
            </span>
            <Segmented
              size="sm"
              value={chat.groupStrategy}
              onValueChange={(next) => next && save('strategy', { groupStrategy: next as PaChatView['groupStrategy'] })}
              aria-label={t('pa.soul.inspector.scene.strategy')}
              className={cn('flex w-full', styles.segmented)}
            >
              {STRATEGIES.map((strategy) => (
                <SegmentedItem key={strategy} value={strategy} className="min-w-0 flex-1">
                  {t(`pa.soul.inspector.scene.strategy.${strategy}`)}
                </SegmentedItem>
              ))}
            </Segmented>
          </div>
        ) : null}
        <LinkRow
          label={t('pa.soul.inspector.scene.scenario')}
          preview={scenario || t('pa.soul.inspector.scene.scenarioDefault')}
          onClick={settings}
          testId="pa-soul-scenario-row"
        />
        <LinkRow label={t('pa.soul.inspector.scene.note')} preview={note || t('pa.soul.inspector.scene.noteNone')} onClick={settings} />
        <LinkRow
          label={t('pa.soul.inspector.scene.lore')}
          value={t('pa.soul.inspector.scene.loreCount', { n: loreCount(index, chat, characters) })}
          onClick={settings}
        />
      </div>
    </Block>
  );
}

function ScenePane({ conversation, subject }: { conversation: PaConversation; subject: PaSubject }) {
  const t = useT();
  const { index, nav } = usePa();
  const reply = newestReply(index, conversation.id);
  const speakerId =
    reply?.message.senderId ?? (subject.kind === 'agent' ? subject.agent.id : subject.group.moderatorId);
  const name = index.agents.has(speakerId) ? displayName(index, speakerId) : '';
  return (
    <div className={frame.paneStack} data-gap="soul">
      {subject.kind === 'agent' ? <StateBlock conversation={conversation} /> : null}
      <EventBlock conversation={conversation} />
      <ChatBlock conversation={conversation} subject={subject} />
      <Button
        variant="ghost"
        block
        data-testid="pa-soul-context-open"
        onClick={() => nav.openModal({ kind: 'context', conversationId: conversation.id, messageId: reply?.message.id ?? null })}
      >
        {t('pa.soul.inspector.scene.context', { name })}
      </Button>
    </div>
  );
}

/* ── 记忆 ──────────────────────────────────────────────────────────────────────────────────── */

function CandidateRow({ candidate }: { candidate: PaMemoryCandidate }) {
  const t = useT();
  const { locale } = useI18n();
  const { data, now } = usePa();
  const [busy, setBusy] = useState(false);
  const kind = kindLabel(t, candidate.kind);
  const resolve = (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    void data.actions
      .resolveMemoryCandidate(candidate.id, candidate.revision, accept)
      .catch((error: unknown) => {
        fail(error);
        setBusy(false);
      });
  };
  return (
    <div className={styles.memoryRow} data-testid="pa-soul-candidate-row">
      <div className={styles.memoryText}>
        <span className={styles.memoryMeta}>
          {kind ? <SoulTag tone="neutral">{kind}</SoulTag> : null}
          {candidate.kind === 'promise' && typeof candidate.dueAt === 'number' ? (
            <span className={styles.due}>{soulDueLabel(t, candidate.dueAt, now, locale)}</span>
          ) : null}
        </span>
        <span className={styles.memoryContent}>{candidate.content}</span>
      </div>
      <div className={styles.memoryActions}>
        <Button size="sm" disabled={busy} onClick={() => resolve(true)}>
          {t('pa.soul.inspector.memory.save')}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => resolve(false)}>
          {t('pa.soul.inspector.memory.dismiss')}
        </Button>
      </div>
    </div>
  );
}

function MemoryMenu({ memory, onDelete }: { memory: PaMemory; onDelete(memory: PaMemory): void }) {
  const t = useT();
  const { nav } = usePa();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="xs" variant="quiet" aria-label={t('pa.roster.rowMenu')} className={styles.rowMenu}>
          <Icon icon={MoreHorizontal} size={14} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent width="sm" align="end">
        <DropdownMenuItem onSelect={() => nav.openModal({ kind: 'memory', memoryId: memory.id })}>{t('pa.edit')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onDelete(memory)}>{t('pa.memory.archive')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PromiseRow({ memory, onDelete }: { memory: PaMemory; onDelete(memory: PaMemory): void }) {
  const t = useT();
  const { locale } = useI18n();
  const { data, now } = usePa();
  const [saving, setSaving] = useState(false);
  const done = kept(memory, now);
  const toggle = (checked: boolean) => {
    if (saving) return;
    setSaving(true);
    void data.actions
      // `now` is the workspace clock the 已兑现 test reads, so the row flips at once.
      .saveMemory(memoryInput(memory, { validUntil: checked ? now : null }), memory)
      .catch(fail)
      .finally(() => setSaving(false));
  };
  return (
    <div className={styles.promiseRow} data-testid="pa-soul-promise" data-kept={done ? 'true' : undefined}>
      <label className={styles.check}>
        <Checkbox
          checked={done}
          disabled={saving}
          aria-label={t('pa.soul.inspector.memory.markKept')}
          onChange={(event) => toggle(event.currentTarget.checked)}
        />
      </label>
      <div className={styles.memoryText}>
        <span className={styles.memoryContent}>{memory.content.trim()}</span>
        {done ? (
          <span className={styles.memoryMeta}>
            <SoulTag tone="outline">{t('pa.soul.inspector.memory.kept')}</SoulTag>
          </span>
        ) : typeof memory.dueAt === 'number' ? (
          <span className={styles.memoryMeta}>
            <span className={styles.due}>{soulDueLabel(t, memory.dueAt, now, locale)}</span>
          </span>
        ) : null}
      </div>
      <MemoryMenu memory={memory} onDelete={onDelete} />
    </div>
  );
}

function RememberedRow({ memory, onDelete }: { memory: PaMemory; onDelete(memory: PaMemory): void }) {
  const t = useT();
  const { nav } = usePa();
  const kind = kindLabel(t, memory.kind);
  return (
    <div className={styles.rememberedRow} data-testid="pa-soul-memory">
      <Button variant="bare" className={styles.rememberedOpen} onClick={() => nav.openModal({ kind: 'memory', memoryId: memory.id })}>
        {kind ? <SoulTag tone="neutral">{kind}</SoulTag> : null}
        <span className={styles.rememberedText}>{memoryFirstLine(memory.content)}</span>
      </Button>
      <MemoryMenu memory={memory} onDelete={onDelete} />
    </div>
  );
}

function MemoryPane({ conversation, subject }: { conversation: PaConversation; subject: PaSubject }) {
  const t = useT();
  const { index, data, nav, now } = usePa();
  const [target, setTarget] = useState<PaMemory | null>(null);
  const [deleting, setDeleting] = useState(false);
  const agentId = subject.kind === 'agent' ? subject.agent.id : null;
  const candidates = chatCandidates(data.snapshot?.memoryCandidates, conversation, agentId);

  const remove = async () => {
    const memory = target;
    if (!memory || deleting) return;
    setDeleting(true);
    try {
      // `deleteMemory` keeps its route name; the service archives the memory.
      await data.actions.deleteMemory(memory.id);
      toast({ tone: 'success', title: t('pa.memory.archived'), description: t('pa.memory.archivedBody') });
    } catch (error) {
      fail(error);
    } finally {
      setDeleting(false);
      setTarget(null);
    }
  };
  const confirm = (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) setTarget(null);
      }}
      title={t('pa.memory.archiveTitle')}
      description={t('pa.memory.archiveBody')}
      confirmLabel={t('pa.memory.archive')}
      cancelLabel={t('pa.cancel')}
      busy={deleting}
      onConfirm={() => void remove()}
    />
  );
  const pendingBlock =
    candidates.length > 0 ? (
      <Block title={t('pa.soul.inspector.memory.pending')} count={candidates.length} testId="pa-soul-pending">
        <div className={styles.card}>
          {candidates.map((candidate) => (
            <CandidateRow key={candidate.id} candidate={candidate} />
          ))}
        </div>
      </Block>
    ) : null;

  if (subject.kind === 'group') {
    const members = membersOf(index, subject.group);
    return (
      <div className={frame.paneStack} data-gap="soul">
        {pendingBlock}
        <div className={styles.card}>
          {members.map((member) => (
            <LinkRow
              key={member.id}
              label={t('pa.soul.inspector.memory.memberLink', { name: displayName(index, member.id) })}
              onClick={() => nav.inspectAgent(member.id, { tab: 'memory' })}
            />
          ))}
        </div>
        <Button
          variant="secondary"
          block
          onClick={() => nav.openModal({ kind: 'memory', memoryId: null, preset: { scope: 'group', scopeId: subject.group.id } })}
        >
          {t('pa.soul.inspector.memory.add')}
        </Button>
      </div>
    );
  }

  const agent = subject.agent;
  // Only memories in use; archived and replaced ones stay in the Memory Center, so archiving takes the row away.
  const promises = promisesFor(index, agent.id, now).filter(paMemoryInUse);
  const remembered = [...index.memories.values()]
    .filter((memory) => memory.scope === 'agent' && memory.scopeId === agent.id && memory.kind !== 'promise' && paMemoryInUse(memory))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const empty = candidates.length === 0 && promises.length === 0 && remembered.length === 0;

  return (
    <div className={frame.paneStack} data-gap="soul">
      {pendingBlock}
      {promises.length > 0 ? (
        <Block title={t('pa.soul.inspector.memory.promises')} count={promises.length} testId="pa-soul-promises">
          <div className={styles.card}>
            {promises.map((memory) => (
              <PromiseRow key={memory.id} memory={memory} onDelete={setTarget} />
            ))}
          </div>
        </Block>
      ) : null}
      {remembered.length > 0 ? (
        <Block title={t('pa.soul.inspector.memory.remembered')} count={remembered.length} testId="pa-soul-remembered">
          <div className={styles.card}>
            {remembered.slice(0, MAX_REMEMBERED).map((memory) => (
              <RememberedRow key={memory.id} memory={memory} onDelete={setTarget} />
            ))}
            {remembered.length > MAX_REMEMBERED ? (
              <LinkRow
                label={t('pa.soul.inspector.memory.seeAll', { n: remembered.length })}
                onClick={() => nav.openPlace('memory', { memoryFilter: 'agent' })}
              />
            ) : null}
          </div>
        </Block>
      ) : null}
      {empty ? (
        <div className={styles.quiet} data-testid="pa-soul-memory-empty">
          <span className={styles.quietDisc} aria-hidden>
            <Icon icon={BookHeart} size={20} />
          </span>
          <p className={styles.quietText}>{t('pa.soul.inspector.memory.empty')}</p>
        </div>
      ) : null}
      <Button
        variant="secondary"
        block
        data-testid="pa-soul-memory-add"
        onClick={() => nav.openModal({ kind: 'memory', memoryId: null, preset: { scope: 'agent', scopeId: agent.id } })}
      >
        {t('pa.soul.inspector.memory.add')}
      </Button>
      {confirm}
    </div>
  );
}
