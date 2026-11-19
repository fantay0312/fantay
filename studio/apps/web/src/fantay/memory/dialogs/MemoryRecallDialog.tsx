// SPDX-License-Identifier: AGPL-3.0-only
// 试试回忆: ask a question as a given conversation, bot or bot-in-a-group would (or across chosen scopes)
// and see what comes back — the always-carried memories, the hits with plain reasons, which places were
// searched, and, folded away, the exact text handed to the model. The only place retrieval shows itself,
// in plain words.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  MemoryOverviewResponse,
  MemoryRecallContext,
  MemoryRecallHit,
  MemoryRecallRequest,
  MemoryRecallResponse,
  MemoryScopeRef,
} from '@open-design/contracts';
import { memoryScopeKey } from '@open-design/contracts';

import { PaDisclosure } from '../../pa/PaDisclosure';
import {
  Button,
  CheckboxField,
  Chip,
  Field,
  Input,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  cn,
} from '../../ui';
import { memoryApi } from '../api';
import {
  ErrorNotice,
  LoadingBlock,
  Section,
  findScopeOption,
  scopeOptionGroups,
  useMemoryLabels,
  useOverviewFallback,
  useSessionKey,
  type MemoryLabels,
  type ScopeOptionGroup,
} from './dialog-kit';
import { MemoryDialogFrame } from './MemoryDialogFrame';
import frame from './MemoryDialogFrame.module.css';
import { useMemoryDialogT, type MemoryDialogKey, type MemoryDialogT } from './i18n';
import styles from './MemoryRecallDialog.module.css';

export interface MemoryRecallDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  overview: MemoryOverviewResponse | null;
  initialScope?: MemoryScopeRef;
}

type Mode = 'as' | 'scopes';

interface AsOption {
  key: string;
  label: string;
  context: MemoryRecallContext;
}

interface AsGroup {
  id: string;
  label: string;
  options: AsOption[];
}

type RecallState =
  | { status: 'idle' }
  | { status: 'loading'; previous: MemoryRecallResponse | null }
  | { status: 'ready'; data: MemoryRecallResponse }
  | { status: 'error'; error: unknown; previous: MemoryRecallResponse | null };

/** The engine's reasons (fixed Chinese phrases) mapped to this dictionary; anything else shows as given. */
const WHY: Readonly<Record<string, MemoryDialogKey>> = {
  '关键词匹配': 'why.lexical',
  '精确匹配': 'why.literal',
  '语义相近': 'why.vector',
  '同一对话': 'why.sameConversation',
  '置顶': 'why.pinned',
  '模型重排': 'why.rerank',
};

const EXAMPLES: readonly MemoryDialogKey[] = ['recall.example1', 'recall.example2', 'recall.example3'];

function strength(score: number): 'high' | 'mid' | 'low' {
  if (score >= 0.6) return 'high';
  if (score >= 0.35) return 'mid';
  return 'low';
}

/** Who can be asked as: each bot, each bot inside each group it belongs to, each project (a new
 *  conversation there) and each of its conversations. */
function asGroups(overview: MemoryOverviewResponse, t: MemoryDialogT): AsGroup[] {
  const groups: AsGroup[] = [];
  if (overview.bots.length > 0) {
    groups.push({
      id: 'bots',
      label: t('recall.as.bots'),
      options: overview.bots.map((bot) => ({ key: `bot:${bot.scope.id}`, label: bot.label, context: { surface: 'pa', agentId: bot.scope.id } })),
    });
  }
  for (const group of overview.groups) {
    const members = group.members ?? [];
    if (members.length === 0) continue;
    groups.push({
      id: `group:${group.scope.id}`,
      label: t('recall.as.group', { name: group.label }),
      options: members.map((member) => ({
        key: `member:${group.scope.id}:${member.id}`,
        label: t('recall.as.member', { name: member.name, group: group.label }),
        context: { surface: 'pa', agentId: member.id, groupId: group.scope.id },
      })),
    });
  }
  for (const project of overview.projects) {
    groups.push({
      id: `project:${project.scope.id}`,
      label: t('recall.as.project', { name: project.label }),
      options: [
        {
          key: `project:${project.scope.id}`,
          label: t('recall.as.newConversation', { name: project.label }),
          context: { surface: 'studio', projectId: project.scope.id, conversationId: null },
        },
        ...(project.children ?? []).map((child) => ({
          key: `conversation:${child.scope.id}`,
          label: child.label,
          context: { surface: 'studio' as const, projectId: project.scope.id, conversationId: child.scope.id },
        })),
      ],
    });
  }
  return groups;
}

function findAs(groups: readonly AsGroup[], key: string): AsOption | null {
  for (const group of groups) {
    const found = group.options.find((option) => option.key === key);
    if (found) return found;
  }
  return null;
}

/** Where the dialog starts: the page's scope as the reader that scope belongs to, else those scopes. */
function initialChoice(
  overview: MemoryOverviewResponse,
  groups: readonly AsGroup[],
  scope: MemoryScopeRef | undefined,
): { mode: Mode; asKey: string; scopeKeys: string[] } {
  const firstAs = groups[0]?.options[0]?.key ?? '';
  if (!scope) {
    return firstAs
      ? { mode: 'as', asKey: firstAs, scopeKeys: [memoryScopeKey(overview.profile.scope)] }
      : { mode: 'scopes', asKey: '', scopeKeys: [memoryScopeKey(overview.profile.scope)] };
  }
  const keyed = memoryScopeKey(scope);
  const candidates: Record<string, string> = {
    bot: `bot:${scope.id}`,
    project: `project:${scope.id}`,
    conversation: `conversation:${scope.id}`,
  };
  if (scope.kind === 'group') {
    const first = overview.groups.find((group) => group.scope.id === scope.id)?.members?.[0];
    if (first) candidates.group = `member:${scope.id}:${first.id}`;
  }
  const asKey = candidates[scope.kind];
  if (asKey && findAs(groups, asKey)) return { mode: 'as', asKey, scopeKeys: [keyed] };
  return { mode: 'scopes', asKey: firstAs, scopeKeys: [keyed] };
}

export function MemoryRecallDialog(props: MemoryRecallDialogProps) {
  const sessionKey = useSessionKey(props.open, props.initialScope ? memoryScopeKey(props.initialScope) : '');
  return <RecallSession key={sessionKey} {...props} />;
}

function RecallSession({ open, onOpenChange, overview: givenOverview, initialScope }: MemoryRecallDialogProps) {
  const { t } = useMemoryDialogT();
  const labels = useMemoryLabels();
  const ids = { as: useId(), query: useId() };
  const queryRef = useRef<HTMLInputElement | null>(null);
  const fallback = useOverviewFallback(open, givenOverview);
  const overview = fallback.overview;
  const people = useMemo(() => (overview ? asGroups(overview, t) : []), [overview, t]);
  const places = useMemo(() => (overview ? scopeOptionGroups(overview, t, labels) : []), [overview, t, labels]);
  const [scope] = useState(initialScope);
  const [mode, setMode] = useState<Mode>('as');
  const [asKey, setAsKey] = useState('');
  const [scopeKeys, setScopeKeys] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<RecallState>({ status: 'idle' });
  const runId = useRef(0);

  // The starting choice needs the overview, which may arrive after the dialog opened.
  useEffect(() => {
    if (ready || !overview) return;
    const choice = initialChoice(overview, people, scope);
    setMode(choice.mode);
    setAsKey(choice.asKey);
    setScopeKeys(choice.scopeKeys);
    setReady(true);
  }, [overview, people, ready, scope]);

  const asOption = findAs(people, asKey);
  const chosenScopes = scopeKeys
    .map((key) => findScopeOption(places, key)?.scope ?? null)
    .filter((entry): entry is MemoryScopeRef => entry !== null);
  const trimmed = query.trim();

  let blocked: string | null = null;
  if (!trimmed) blocked = t('recall.need.query');
  else if (mode === 'as' && !asOption) blocked = t('recall.need.as');
  else if (mode === 'scopes' && chosenScopes.length === 0) blocked = t('recall.need.scopes');

  const run = async (text = trimmed) => {
    const question = text.trim();
    if (!question || (mode === 'as' && !asOption) || (mode === 'scopes' && chosenScopes.length === 0)) return;
    const request: MemoryRecallRequest =
      mode === 'as' && asOption
        ? { query: question, context: asOption.context, includeChunks: true }
        : { query: question, scopes: chosenScopes.slice(0, 32), includeChunks: true };
    const token = ++runId.current;
    setState((current) => ({
      status: 'loading',
      previous: current.status === 'ready' ? current.data : current.status === 'idle' ? null : current.previous,
    }));
    try {
      const data = await memoryApi.recall(request);
      if (token === runId.current) setState({ status: 'ready', data });
    } catch (error) {
      if (token === runId.current) {
        setState((current) => ({ status: 'error', error, previous: current.status === 'loading' ? current.previous : null }));
      }
    }
  };

  const toggleScope = (key: string, on: boolean) =>
    setScopeKeys((current) => (on ? [...current.filter((entry) => entry !== key), key] : current.filter((entry) => entry !== key)));

  const shown = state.status === 'ready' ? state.data : state.status === 'idle' ? null : state.previous;

  return (
    <MemoryDialogFrame
      open={open}
      onClose={() => onOpenChange(false)}
      size="xl"
      testId="memory-recall-dialog"
      title={t('recall.title')}
      lede={t('recall.lede')}
      initialFocusRef={queryRef}
      onSubmit={() => void run()}
      footer={
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t('common.close')}
        </Button>
      }
    >
      <div className={styles.controls}>
        <Segmented
          className="flex w-full"
          aria-label={t('recall.modeLabel')}
          value={mode}
          onValueChange={(next) => setMode(next as Mode)}
          data-testid="memory-recall-mode"
        >
          <SegmentedItem value="as" className="min-w-0 flex-1" data-testid="memory-recall-mode-as">
            {t('recall.mode.as')}
          </SegmentedItem>
          <SegmentedItem value="scopes" className="min-w-0 flex-1" data-testid="memory-recall-mode-scopes">
            {t('recall.mode.scopes')}
          </SegmentedItem>
        </Segmented>

        {fallback.error && !overview ? (
          <ErrorNotice error={fallback.error} onRetry={fallback.retry} />
        ) : mode === 'as' ? (
          <Field label={t('recall.as.label')} htmlFor={ids.as} labelVariant="form" hint={t('recall.as.hint')}>
            {people.length === 0 && overview ? (
              <p className={frame.quiet}>{t('recall.as.none')}</p>
            ) : (
              <Select value={asKey} onValueChange={setAsKey} disabled={!overview}>
                <SelectTrigger id={ids.as} className="w-full" data-testid="memory-recall-as">
                  <SelectValue placeholder={overview ? t('recall.as.placeholder') : t('common.loading')} />
                </SelectTrigger>
                <SelectContent>
                  {people.map((group) => (
                    <SelectGroup key={group.id}>
                      <SelectLabel>{group.label}</SelectLabel>
                      {group.options.map((option) => (
                        <SelectItem key={option.key} value={option.key}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        ) : (
          <ScopeChecklist groups={places} selected={scopeKeys} loading={!overview} t={t} onToggle={toggleScope} />
        )}

        <div className={styles.queryRow}>
          <Input
            ref={queryRef}
            id={ids.query}
            value={query}
            maxLength={8000}
            autoComplete="off"
            aria-label={t('recall.query')}
            placeholder={t('recall.queryPlaceholder')}
            data-testid="memory-recall-query"
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            loading={state.status === 'loading'}
            disabled={blocked !== null}
            disabledReason={blocked ?? undefined}
            data-testid="memory-recall-run"
          >
            {t('recall.run')}
          </Button>
        </div>
      </div>

      <div className={styles.results} aria-busy={state.status === 'loading' ? true : undefined}>
        {state.status === 'error' ? (
          <ErrorNotice error={state.error} fallback="error.recall" onRetry={() => void run()} testId="memory-recall-error" />
        ) : null}
        {shown ? (
          <div className={cn(frame.reveal, state.status === 'loading' && styles.stale)} key={shown.query}>
            <RecallResult data={shown} labels={labels} t={t} />
          </div>
        ) : state.status === 'loading' ? (
          <LoadingBlock lines={1} rows={3} label={t('recall.running')} testId="memory-recall-loading" />
        ) : state.status === 'idle' ? (
          <div className={styles.idle}>
            <p className={frame.quiet}>{t('recall.idle')}</p>
            <div className={styles.examples}>
              {EXAMPLES.map((key) => (
                <Chip
                  key={key}
                  size="sm"
                  variant="suggestion"
                  onClick={() => {
                    const text = t(key);
                    setQuery(text);
                    void run(text);
                  }}
                >
                  {t(key)}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </MemoryDialogFrame>
  );
}

function ScopeChecklist({
  groups,
  selected,
  loading,
  t,
  onToggle,
}: {
  groups: readonly ScopeOptionGroup[];
  selected: readonly string[];
  loading: boolean;
  t: MemoryDialogT;
  onToggle(key: string, on: boolean): void;
}) {
  return (
    <div className={styles.checklist}>
      <div className={frame.sectionHead}>
        <span className={styles.checklistTitle}>{t('recall.scopes.label')}</span>
        <span className={frame.sectionAside}>{t('recall.scopes.count', { n: selected.length })}</span>
      </div>
      {loading ? (
        <LoadingBlock lines={3} label={t('common.loading')} />
      ) : (
        <div className={cn(frame.group, styles.checklistBox)} role="group" aria-label={t('recall.scopes.label')}>
          {groups.map((group) => (
            <div key={group.id} className={styles.checkGroup}>
              <span className={styles.checkGroupLabel}>{group.label}</span>
              {group.options.map((option) => (
                <CheckboxField
                  key={option.key}
                  className={cn(styles.checkRow, option.nested && styles.checkRowNested)}
                  label={option.label}
                  description={option.sub ?? undefined}
                  checked={selected.includes(option.key)}
                  onChange={(event) => onToggle(option.key, event.target.checked)}
                  data-testid={`memory-recall-scope-${option.key}`}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecallResult({ data, labels, t }: { data: MemoryRecallResponse; labels: MemoryLabels; t: MemoryDialogT }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(data.promptBlock).then(() => setCopied(true), () => undefined);
  };

  // Hits above the cut; the rest are the closest matches, passed along marked as uncertain.
  const sure = data.hits.filter((hit) => !hit.possible).length;

  return (
    <>
      <div className={styles.summary} role="status" data-testid="memory-recall-summary">
        <span className={styles.summaryLead}>
          {sure > 0
            ? t('recall.summary', { n: sure })
            : data.hits.length > 0
              ? t('recall.summaryPossible', { n: data.hits.length })
              : t('recall.summaryNone')}
        </span>
        <span className={frame.meta}>
          <span>{t(`level.${data.level}` as MemoryDialogKey)}</span>
          <span>{t('recall.latency', { ms: Math.max(1, Math.round(data.latencyMs.total)) })}</span>
        </span>
      </div>
      {data.scopes.length > 0 ? (
        <div className={styles.searched}>
          <span className={styles.searchedLabel}>{t('recall.searched')}</span>
          {data.scopes.map((entry) => (
            <span key={memoryScopeKey(entry)} className={frame.tag}>
              {labels.scope(entry, entry.label)}
            </span>
          ))}
        </div>
      ) : null}

      {data.standing.length > 0 ? (
        <Section title={t('recall.standing')} count={data.standing.length} note={t('recall.standingNote')} testId="memory-recall-standing">
          <ul className={frame.group}>
            {data.standing.map((item) => (
              <li key={item.id} className={styles.standingRow}>
                <p className={cn(frame.text, frame.clamp2, styles.hitText)}>{item.content}</p>
                <span className={frame.meta}>
                  <span>{labels.kind(item.kind)}</span>
                  <span>{labels.scope(item.scope, item.scopeLabel)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={t('recall.hits')} count={data.hits.length} testId="memory-recall-hits">
        {data.hits.length === 0 ? (
          <p className={cn(frame.quiet, styles.noHits)} data-testid="memory-recall-empty">
            {data.standing.length > 0 ? t('recall.noHitsStanding') : t('recall.noHits')}
          </p>
        ) : (
          <ol className={frame.group}>
            {data.hits.map((hit, index) => (
              <HitRow key={`${hit.docKind}:${hit.id}`} hit={hit} index={index} labels={labels} t={t} />
            ))}
          </ol>
        )}
      </Section>

      <PaDisclosure label={t('recall.prompt')} className={styles.prompt}>
        {data.promptBlock ? (
          <div className={styles.promptBox}>
            <div className={styles.promptHead}>
              <span className={frame.caption}>{t('recall.promptSize', { used: data.usedChars, budget: data.budgetChars })}</span>
              <Button size="sm" variant="bare" onClick={copy} data-testid="memory-recall-prompt-copy">
                {copied ? t('recall.copied') : t('recall.copy')}
              </Button>
            </div>
            <pre className={styles.promptText} data-testid="memory-recall-prompt">
              {data.promptBlock}
            </pre>
          </div>
        ) : (
          <p className={frame.quiet} data-testid="memory-recall-prompt-empty">
            {t('recall.promptEmpty')}
          </p>
        )}
      </PaDisclosure>
    </>
  );
}

function HitRow({ hit, index, labels, t }: { hit: MemoryRecallHit; index: number; labels: MemoryLabels; t: MemoryDialogT }) {
  const level = strength(hit.score);
  const chunk = hit.docKind === 'chunk' ? hit.chunk : undefined;
  return (
    <li className={styles.hit} data-testid={`memory-recall-hit-${index}`}>
      <div className={styles.hitHead}>
        <span className={styles.strength} data-level={level}>
          <span className={styles.meter} aria-hidden>
            <i />
            <i />
            <i />
          </span>
          {t(`recall.strength.${level}` as MemoryDialogKey)}
        </span>
        <span className={frame.meta}>
          <span>{hit.docKind === 'chunk' ? t('recall.chunk') : hit.item ? labels.kind(hit.item.kind) : t('recall.item')}</span>
          <span>{labels.scope(hit.scope, hit.scopeLabel)}</span>
          {hit.eventAt !== null ? <span>{labels.when(hit.eventAt)}</span> : null}
        </span>
      </div>
      {chunk?.conversationTitle ? (
        <span className={styles.chunkTitle}>{t('recall.fromConversation', { title: chunk.conversationTitle })}</span>
      ) : null}
      <p className={cn(frame.text, frame.clamp4, styles.hitText)}>{hit.content}</p>
      <div className={styles.reasons}>
        {hit.why.map((reason) => {
          const key = WHY[reason];
          return (
            <span key={reason} className={frame.tag}>
              {key ? t(key) : reason}
            </span>
          );
        })}
        {hit.inConflict ? <span className={cn(frame.tag, frame.tagWarm)}>{t('recall.inConflict')}</span> : null}
        {hit.possible ? (
          <span className={frame.tag} title={t('recall.possibleNote')} data-testid="memory-recall-possible">
            {t('recall.possible')}
          </span>
        ) : null}
      </div>
    </li>
  );
}
