// SPDX-License-Identifier: AGPL-3.0-only
// 上下文 (modal kind `context`, Soul UI spec §5.5): what a reply saw, read-only. Two equal segments switch between the
// stored trace of one reply (`loadTrace`) and a preview of the next turn (`previewTurn` with the composer draft). The
// body lists how it was sent, how much history it carried, the token budget by block group, world-book hits with
// their reasons, the memories used, warnings, and the persona / style / turn-record summary. Token numbers are allowed
// here (one of the three technical views, owner rule O12).
import type { PaLoreReason, PaSoulTrace, PaSoulTraceLore, PaSoulWarning } from '@open-design/contracts';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { useI18n, useT } from '../../../i18n';
import {
  Button,
  Callout,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Segmented,
  SegmentedItem,
  Skeleton,
  cn,
  toast,
} from '../../ui';
import { usePa } from '../pa-context';
import { PaModalFrame } from '../PaAgentModal';
import type { PaIndex } from '../pa-types';
import { chatOf, displayName } from './soul-model';
import { SoulTag } from './SoulPrimitives';
import styles from './SoulContextModal.module.css';

export interface SoulContextModalProps {
  open: boolean;
  onClose(): void;
  conversationId: string;
  /** null: preview the next turn. */
  messageId: string | null;
}

type T = ReturnType<typeof useT>;
type Mode = 'reply' | 'preview';
type Load = { status: 'loading' } | { status: 'ready'; trace: PaSoulTrace } | { status: 'none' } | { status: 'error'; message: string };

/** Block ids of a trace by legend group, in legend order (spec §5.5). Unknown ids count as 文风与规则. */
export const SOUL_CONTEXT_GROUPS = [
  { id: 'style', blocks: ['frame', 'main', 'style', 'post', 'directive', 'reminder', 'nudge', 'care'] },
  { id: 'persona', blocks: ['persona'] },
  { id: 'character', blocks: ['character', 'cast'] },
  { id: 'lore', blocks: ['lore-before', 'lore-after', 'lore-triggered'] },
  { id: 'memory', blocks: ['memory'] },
  { id: 'state', blocks: ['contract', 'state', 'event', 'now'] },
  { id: 'examples', blocks: ['examples'] },
  { id: 'history', blocks: ['history'] },
] as const;
type GroupId = (typeof SOUL_CONTEXT_GROUPS)[number]['id'];

const GROUP_OF = new Map<string, GroupId>(SOUL_CONTEXT_GROUPS.flatMap((group) => group.blocks.map((block) => [block, group.id] as const)));

/** Legend rows: tokens per group, groups with 0 tokens omitted. */
export function contextGroups(trace: Pick<PaSoulTrace, 'blocks'>): Array<{ id: GroupId; tokens: number }> {
  const totals = new Map<GroupId, number>();
  for (const block of trace.blocks) {
    const group = GROUP_OF.get(block.id) ?? 'style';
    totals.set(group, (totals.get(group) ?? 0) + Math.max(0, block.tokens));
  }
  return SOUL_CONTEXT_GROUPS.map((group) => ({ id: group.id, tokens: totals.get(group.id) ?? 0 })).filter((row) => row.tokens > 0);
}

const WARNING_KEY = {
  'lore-constant-cut': 'pa.soul.inspector.context.warn.loreConstantCut',
  'examples-dropped': 'pa.soul.inspector.context.warn.examplesDropped',
  'history-floor': 'pa.soul.inspector.context.warn.historyFloor',
  'over-window': 'pa.soul.inspector.context.warn.overWindow',
  'volatile-macro-in-system': 'pa.soul.inspector.context.warn.volatileMacro',
  'footer-missing': 'pa.soul.inspector.context.warn.footerMissing',
  'regex-timeout': 'pa.soul.inspector.context.warn.regexTimeout',
  'prompt-shrunk': 'pa.soul.inspector.context.warn.promptShrunk',
} as const satisfies Record<PaSoulWarning['code'], string>;

const REASON_KEY = {
  constant: 'pa.soul.inspector.context.reason.constant',
  sticky: 'pa.soul.inspector.context.reason.sticky',
  key: 'pa.soul.inspector.context.reason.key',
  'no-key': 'pa.soul.inspector.context.reason.noKey',
  'over-budget': 'pa.soul.inspector.context.reason.overBudget',
  cooldown: 'pa.soul.inspector.context.reason.cooldown',
  delay: 'pa.soul.inspector.context.reason.delay',
  probability: 'pa.soul.inspector.context.reason.probability',
  group: 'pa.soul.inspector.context.reason.group',
  disabled: 'pa.soul.inspector.context.reason.disabled',
  empty: 'pa.soul.inspector.context.reason.empty',
  'recursion-only': 'pa.soul.inspector.context.reason.recursionOnly',
  'regex-rejected': 'pa.soul.inspector.context.reason.regexRejected',
  'regex-timeout': 'pa.soul.inspector.context.reason.regexTimeout',
  'regex-needs-daemon': 'pa.soul.inspector.context.reason.regexNeedsDaemon',
} as const satisfies Record<PaLoreReason['code'], string>;

/** Status tags of the rows a trace lists (stored traces never hold `inactive` entries; previews drop them here). */
const STATUS_KEY = {
  included: 'pa.soul.inspector.context.status.included',
  budget: 'pa.soul.inspector.context.status.budget',
  disabled: 'pa.soul.inspector.context.status.disabled',
  cooldown: 'pa.soul.inspector.context.status.cooldown',
  probability: 'pa.soul.inspector.context.status.probability',
  group: 'pa.soul.inspector.context.status.group',
} as const satisfies Record<Exclude<PaSoulTraceLore['status'], 'inactive'>, string>;

type ListedLore = PaSoulTraceLore & { status: keyof typeof STATUS_KEY };

function isListed(row: PaSoulTraceLore): row is ListedLore {
  return row.status !== 'inactive';
}

/** A world-book reason in words (spec §5.5): the one reason table, shared with the lorebook editor's 触发测试
 *  (`SoulLoreTestBench`), which passes its own number format. */
export function loreReasonText(t: T, reason: PaLoreReason, number: (value: number) => string | number = (value) => value): string {
  const key = REASON_KEY[reason.code] ?? REASON_KEY['no-key'];
  if (reason.code === 'key') return t(key, { key: reason.key ?? '' });
  if (reason.code === 'over-budget') return t(key, { need: number(reason.need ?? 0), left: number(reason.left ?? 0) });
  return t(key);
}

function loreEntryKey(row: Pick<PaSoulTraceLore, 'lorebookId' | 'entryId'>): string {
  return `${row.lorebookId}:${row.entryId}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Who the modal is about before a trace arrives: the reply's speaker, else the chat's character or moderator. */
function fallbackName(index: PaIndex, conversationId: string, messageId: string | null): string {
  const sender = messageId ? index.messages.get(messageId)?.senderId : undefined;
  if (sender && index.agents.has(sender)) return displayName(index, sender);
  const conversation = index.conversations.get(conversationId);
  const group = conversation ? index.groupByConversation.get(conversation.id) : undefined;
  const agentId = conversation?.agentId ?? group?.moderatorId ?? null;
  return agentId && index.agents.has(agentId) ? displayName(index, agentId) : '';
}

export function SoulContextModal({ open, onClose, conversationId, messageId }: SoulContextModalProps) {
  const t = useT();
  const { locale } = useI18n();
  const { data, index, drafts, nav } = usePa();
  const [mode, setMode] = useState<Mode>(messageId ? 'reply' : 'preview');
  const [loads, setLoads] = useState<Record<Mode, Load | null>>({ reply: null, preview: null });
  // One read per segment; 重试 and 刷新预览 bump that segment's counter to read it again.
  const [refresh, setRefresh] = useState<Record<Mode, number>>({ reply: 0, preview: 0 });
  const fetched = useRef<Record<Mode, number | null>>({ reply: null, preview: null });
  const reread = () => setRefresh((current) => ({ ...current, [mode]: current[mode] + 1 }));
  const actions = useRef(data.actions);
  actions.current = data.actions;

  const round = refresh[mode];
  useEffect(() => {
    if (!open || fetched.current[mode] === round) return undefined;
    fetched.current[mode] = round;
    let live = true;
    let settled = false;
    setLoads((current) => ({ ...current, [mode]: { status: 'loading' } }));
    const work =
      mode === 'reply' && messageId
        ? actions.current.loadTrace(messageId)
        : actions.current.previewTurn(conversationId, drafts.get(conversationId).text.trim() || undefined);
    Promise.resolve(work)
      .then((trace) => {
        settled = true;
        if (live) setLoads((current) => ({ ...current, [mode]: trace ? { status: 'ready', trace } : { status: 'none' } }));
      })
      .catch((error: unknown) => {
        settled = true;
        if (live) setLoads((current) => ({ ...current, [mode]: { status: 'error', message: errorText(error) } }));
      });
    return () => {
      live = false;
      // A read cut short (segment switch, close) runs again next time.
      if (!settled) fetched.current[mode] = null;
    };
  }, [open, mode, round, messageId, conversationId, drafts]);

  const load = loads[mode] ?? { status: 'loading' };
  const trace = load.status === 'ready' ? load.trace : null;
  const name = trace?.speaker.name || fallbackName(index, conversationId, messageId);
  const message = messageId ? index.messages.get(messageId) : undefined;
  const replyAt = trace?.at ?? message?.createdAt ?? null;
  const time =
    replyAt !== null
      ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(replyAt)
      : '';
  const lede = mode === 'reply' ? t('pa.soul.inspector.context.ledeReply', { time }) : t('pa.soul.inspector.context.ledePreview', { name });

  const footer =
    mode === 'preview' ? (
      <>
        <Button variant="secondary" disabled={load.status === 'loading'} onClick={reread}>
          {t('pa.soul.inspector.context.refresh')}
        </Button>
        <Button onClick={onClose}>{t('fantay.ui.close')}</Button>
      </>
    ) : (
      <Button onClick={onClose}>{t('fantay.ui.close')}</Button>
    );

  return (
    <PaModalFrame
      open={open}
      onClose={onClose}
      size="lg"
      title={t('pa.soul.inspector.context.title', { name })}
      lede={lede}
      footer={footer}
      testId="pa-context-modal"
    >
      <Segmented
        size="md"
        value={mode}
        onValueChange={(next) => {
          if (next === 'reply' || next === 'preview') setMode(next);
        }}
        aria-label={t('pa.soul.inspector.context.title', { name })}
        className="flex w-full"
      >
        <SegmentedItem value="reply" className="min-w-0 flex-1" disabled={!messageId}>
          {t('pa.soul.inspector.context.segReply')}
        </SegmentedItem>
        <SegmentedItem value="preview" className="min-w-0 flex-1">
          {t('pa.soul.inspector.context.segPreview')}
        </SegmentedItem>
      </Segmented>

      {load.status === 'loading' ? (
        <div className={styles.loading} data-testid="pa-context-loading" role="status" aria-busy="true">
          <Skeleton shape="row" index={0} />
          <Skeleton shape="row" index={1} />
          <Skeleton shape="row" index={2} />
        </div>
      ) : load.status === 'error' ? (
        <Callout tone="error" role="alert" className={styles.errorCallout}>
          <span className={styles.errorText}>
            <span className={styles.errorLead}>{t('pa.soul.inspector.context.error')}</span>
            {load.message ? <span className={styles.errorDetail}>{load.message}</span> : null}
          </span>
          <Button variant="link" size="sm" onClick={reread}>
            {t('pa.state.retry')}
          </Button>
        </Callout>
      ) : load.status === 'none' ? (
        <p className={styles.quiet} data-testid="pa-context-none">
          {mode === 'reply' ? t('pa.soul.inspector.context.gone') : t('pa.soul.inspector.context.error')}
        </p>
      ) : trace ? (
        <TraceBody
          trace={trace}
          mode={mode}
          name={name}
          conversationId={conversationId}
          onOpenEntry={(row) => nav.openModal({ kind: 'lorebook', lorebookId: row.lorebookId, entryId: row.entryId })}
          onOpenMemory={(memoryId) => nav.openModal({ kind: 'memory', memoryId })}
        />
      ) : null}
    </PaModalFrame>
  );
}

function TraceBody({
  trace,
  mode,
  name,
  conversationId,
  onOpenEntry,
  onOpenMemory,
}: {
  trace: PaSoulTrace;
  mode: Mode;
  name: string;
  conversationId: string;
  onOpenEntry(row: PaSoulTraceLore): void;
  onOpenMemory(memoryId: string): void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const { index, data } = usePa();
  const number = (value: number) => value.toLocaleString(locale);
  const chat = chatOf(index, conversationId);
  const disabled = new Set(chat.disabledLoreEntryIds);

  const { included, total, hidden } = trace.history;
  const older = Math.max(0, total - included - hidden);
  let history = t('pa.soul.inspector.context.historyValue', { included: number(included), total: number(total) });
  if (older > 0) history += ` · ${t('pa.soul.inspector.context.historyOlder', { n: number(older) })}`;
  if (hidden > 0) history += ` · ${t('pa.soul.inspector.context.historyHidden', { n: number(hidden), name })}`;

  const groups = contextGroups(trace);
  const sum = groups.reduce((acc, group) => acc + group.tokens, 0);
  const percent = (tokens: number) => (sum > 0 ? Math.max(1, Math.round((tokens / sum) * 100)) : 0);

  const loreRows = trace.lore.filter(isListed);
  const inactive = Math.max(trace.loreInactive, trace.lore.length - loreRows.length);
  const warnings = [...new Set(trace.warnings.map((warning) => warning.code))].filter((code) => WARNING_KEY[code]);

  const toggleEntry = (row: PaSoulTraceLore) => {
    const key = loreEntryKey(row);
    const current = chatOf(index, conversationId).disabledLoreEntryIds;
    const next = current.includes(key) ? current.filter((id) => id !== key) : [...current, key];
    void data.actions.saveChat(conversationId, { disabledLoreEntryIds: next }).catch((error: unknown) => {
      toast({ tone: 'danger', title: errorText(error) });
    });
  };

  let summary = t('pa.soul.inspector.context.summary', { persona: trace.persona.name, preset: trace.preset.name });
  if (mode === 'reply' && trace.footer) {
    summary += ` · ${t('pa.soul.inspector.context.footer', { status: t(`pa.soul.inspector.context.footer.${trace.footer}`) })}`;
  }

  return (
    <div className={styles.trace} data-testid="pa-context-trace">
      <div className={styles.group} data-testid="pa-context-facts">
        <div className={styles.factRow}>
          <span className={styles.factLabel}>{t('pa.soul.inspector.context.wire')}</span>
          <span className={styles.factValue}>
            {trace.wire === 'flat' ? t('pa.soul.inspector.context.wireFlat') : t('pa.soul.inspector.context.wireStructured')}
          </span>
        </div>
        <div className={styles.factRow}>
          <span className={styles.factLabel}>{t('pa.soul.inspector.context.history')}</span>
          <span className={styles.factValue}>{history}</span>
        </div>
        <div className={styles.factRow}>
          <span className={styles.factLabel}>{t('pa.soul.inspector.context.loreBudget')}</span>
          <span className={styles.factValue}>
            {number(trace.loreBudget.used)} / {number(trace.loreBudget.limit)}
          </span>
        </div>
      </div>

      <div className={styles.budget} data-testid="pa-context-budget">
        <div className={styles.barRow}>
          <span className={styles.bar} aria-hidden>
            {groups.map((group) => (
              <span key={group.id} className={styles.segment} data-group={group.id} style={{ flexGrow: group.tokens } as CSSProperties} />
            ))}
          </span>
          <span className={styles.total}>
            {t('pa.soul.inspector.context.total', { used: number(trace.totalTokens), limit: number(trace.contextTokens) })}
          </span>
        </div>
        <ul className={styles.legend}>
          {groups.map((group) => (
            <li key={group.id} className={styles.legendRow} data-testid="pa-context-legend-row">
              <span className={styles.swatch} data-group={group.id} aria-hidden />
              <span className={styles.legendLabel}>{t(`pa.soul.inspector.context.block.${group.id}`)}</span>
              <span className={styles.legendTokens}>{number(group.tokens)}</span>
              <span className={styles.legendPercent}>{percent(group.tokens)}%</span>
            </li>
          ))}
        </ul>
      </div>

      {loreRows.length > 0 || inactive > 0 ? (
        <section className={styles.section} data-testid="pa-context-lore">
          <h3 className={styles.sectionTitle}>{t('pa.soul.inspector.context.lore')}</h3>
          {loreRows.length > 0 ? (
            <div className={styles.group}>
              {loreRows.map((row) => {
                const off = disabled.has(loreEntryKey(row));
                return (
                  <div key={loreEntryKey(row)} className={styles.loreRow} data-testid="pa-context-lore-row" data-status={row.status}>
                    <div className={styles.loreHead}>
                      <SoulTag tone={row.status === 'included' ? 'solid' : 'outline'}>
                        {t(STATUS_KEY[row.status])}
                      </SoulTag>
                      <span className={styles.loreTitle}>{row.title || t('pa.soul.inspector.context.loreUntitled')}</span>
                      <span className={styles.loreTokens}>{number(row.tokens)}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton size="xs" variant="quiet" aria-label={t('pa.roster.rowMenu')} className={styles.loreMenu}>
                            <Icon icon={MoreHorizontal} size={14} />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent width="md" align="end">
                          <DropdownMenuItem onSelect={() => onOpenEntry(row)}>{t('pa.soul.inspector.context.loreOpen')}</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => toggleEntry(row)}>
                            {off ? t('pa.soul.inspector.context.loreOn') : t('pa.soul.inspector.context.loreOff')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className={styles.loreSub}>
                      {row.lorebookName} · {loreReasonText(t, row.reason)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          {inactive > 0 ? <p className={styles.note}>{t('pa.soul.inspector.context.loreInactive', { n: number(inactive) })}</p> : null}
        </section>
      ) : null}

      {trace.memories.length > 0 ? (
        <section className={styles.section} data-testid="pa-context-memories">
          <h3 className={styles.sectionTitle}>{t('pa.soul.inspector.context.memories')}</h3>
          <div className={styles.group}>
            {trace.memories.map((memory) => (
              <Button key={memory.id} variant="bare" className={styles.memoryRow} onClick={() => onOpenMemory(memory.id)}>
                <span className={styles.memoryTitle}>{memory.title}</span>
                <Icon icon={ChevronRight} size={14} className={styles.chevron} />
              </Button>
            ))}
          </div>
        </section>
      ) : null}

      {warnings.length > 0 ? (
        <Callout tone="neutral" className={styles.notices} data-testid="pa-context-warnings">
          <ul className={styles.noticeList}>
            {warnings.map((code) => (
              <li key={code}>{t(WARNING_KEY[code])}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <p className={cn(styles.summary)} data-testid="pa-context-summary">
        {summary}
      </p>
    </div>
  );
}
