// SPDX-License-Identifier: AGPL-3.0-only
// 记忆 page (spec §11): a heading with the one page action, the recall hint, a full-width scope
// filter and a search, then one hairline group of memories. Create and edit open the memory modal;
// archiving confirms first and says where to restore it (a memory is never deleted).
import { useMemo, useRef, useState } from 'react';
import { Archive, ArrowUpRight, CircleCheck, Pencil, Plus } from 'lucide-react';
import { useI18n, useT } from '../../i18n';
import { navigate } from '../../router';
import { FantayMascotStill } from '../brand/FantayMascot';
import {
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Icon,
  IconButton,
  MetaLine,
  MoreHorizontalIcon,
  SearchField,
  Segmented,
  SegmentedItem,
  Skeleton,
  Button,
  cn,
  toast,
} from '../ui';
import { PaMarkdown } from './PaMarkdown';
import { paMemoryInUse, resolveDefaultMemoryScope } from './PaMemoryModal';
import { formatDay } from './PaTaskModal';
import { usePa } from './pa-context';
import { memoryScopeName } from './pa-model';
import type { PaMemory, PaMemoryCandidate, PaMemoryFilter, PaMemoryInput } from './pa-types';
import styles from './PaPages.module.css';
import { displayName } from './soul/soul-model';
import { SoulTag } from './soul/SoulPrimitives';

const FILTERS: readonly PaMemoryFilter[] = ['all', 'private', 'agent', 'group', 'project'];

/** The memory kinds shown as a tag (Soul UI spec 6.4); a memory without one of these kinds shows no tag. */
const KIND_LABEL: Partial<Record<string, 'pa.soul.manage.kind.profile' | 'pa.soul.manage.kind.preference' | 'pa.soul.manage.kind.fact' | 'pa.soul.manage.kind.procedure' | 'pa.soul.manage.kind.promise' | 'pa.soul.manage.kind.moment'>> = {
  profile: 'pa.soul.manage.kind.profile',
  preference: 'pa.soul.manage.kind.preference',
  fact: 'pa.soul.manage.kind.fact',
  procedure: 'pa.soul.manage.kind.procedure',
  promise: 'pa.soul.manage.kind.promise',
  moment: 'pa.soul.manage.kind.moment',
};

/** A 约定 is kept once its `validUntil` has passed. */
function kept(memory: PaMemory, now: number): boolean {
  return typeof memory.validUntil === 'number' && memory.validUntil <= now;
}

export function PaMemoryPage() {
  const { data, index, ui, nav, projects, now } = usePa();
  const t = useT();
  const { locale } = useI18n();
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<PaMemory | null>(null);
  const [archiving, setArchiving] = useState(false);
  const archivingRef = useRef(false);

  const filter = ui.memoryFilter;
  // Only memories in use: archived and replaced ones are kept in the Memory Center (已归档), so archiving here
  // takes the row away.
  const all = useMemo(
    () => [...index.memories.values()].filter(paMemoryInUse).sort((a, b) => b.updatedAt - a.updatedAt),
    [index],
  );
  const needle = query.trim().toLocaleLowerCase(locale);
  const shown = useMemo(
    () =>
      all.filter(
        (memory) =>
          (filter === 'all' || memory.scope === filter) &&
          (!needle ||
            memory.content.toLocaleLowerCase(locale).includes(needle) ||
            memory.source.toLocaleLowerCase(locale).includes(needle)),
      ),
    [all, filter, needle, locale],
  );

  const counts = useMemo(() => {
    const out: Record<PaMemoryFilter, number> = { all: all.length, private: 0, agent: 0, group: 0, project: 0 };
    for (const memory of all) out[memory.scope] += 1;
    return out;
  }, [all]);

  const label = (key: PaMemoryFilter): string =>
    key === 'all'
      ? t('pa.memory.filterAll')
      : key === 'private'
        ? t('pa.memory.filterPrivate')
        : key === 'agent'
          ? t('pa.memory.filterAgent')
          : key === 'group'
            ? t('pa.memory.filterGroup')
            : t('pa.memory.filterProject');

  const create = () => {
    const preset = resolveDefaultMemoryScope(
      filter === 'all' ? undefined : { scope: filter },
      index,
      projects,
      ui,
    );
    nav.openModal({ kind: 'memory', memoryId: null, preset });
  };

  // `deleteMemory` keeps its route name; the service archives the memory.
  const confirmArchive = async () => {
    const memory = target;
    if (!memory || archivingRef.current) return;
    archivingRef.current = true;
    setArchiving(true);
    try {
      await data.actions.deleteMemory(memory.id);
      toast({ tone: 'success', title: t('pa.memory.archived'), description: t('pa.memory.archivedBody') });
    } catch (error) {
      toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) });
    } finally {
      archivingRef.current = false;
      setArchiving(false);
      setTarget(null);
    }
  };

  /** 标为已兑现: the memory's own input with `validUntil = now`. */
  const markKept = (memory: PaMemory) => {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, revision: _revision, principalId: _principal, ...input } = memory;
    const next: PaMemoryInput = { ...input, validUntil: Date.now() };
    void data.actions
      .saveMemory(next, memory)
      .catch((error) => toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) }));
  };
  const resolveCandidate = (candidate: PaMemoryCandidate, accept: boolean) =>
    void data.actions
      .resolveMemoryCandidate(candidate.id, candidate.revision, accept)
      .catch((error) => toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) }));
  const candidates = (data.snapshot?.memoryCandidates ?? []).filter((candidate) => candidate.status === 'pending');

  const loading = data.load === 'loading' && !data.snapshot;
  // With nothing stored yet the scope filter and the search have nothing to act on; the empty state stands alone.
  const empty = !loading && all.length === 0;

  return (
    <div className={styles.page} data-testid="pa-memory-page">
      <div className={cn(styles.inner, styles.narrow)}>
        <header className={styles.head}>
          <div className={styles.headText}>
            <h1 className={styles.title}>{t('pa.memories')}</h1>
            <p className={styles.hint}>{t('pa.memoryHint')}</p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="pa-open-memory-center"
              onClick={() => navigate({ kind: 'home', view: 'memory' })}
            >
              {t('pa.memory.openCenter')}
              <Icon icon={ArrowUpRight} size="sm" />
            </Button>
            <Button className={cn('fx-page-action', styles.pageAction)} onClick={create}>
              <Icon icon={Plus} size="sm" />
              {t('pa.newMemory')}
            </Button>
          </div>
        </header>

        {candidates.length ? (
          <div className={styles.memList} aria-label={t('pa.memory.proposedProcedure')}>
            {candidates.map(candidate => candidate.sourceMessageId ? (
              // A chat candidate (想记下): the kind, who wants to remember it, the text and its date, 记下 · 忽略.
              <article key={candidate.id} className={styles.memRow} data-testid="pa-memory-candidate">
                <div className={styles.memBody}>
                  <div className={styles.memContent}>{candidate.content}</div>
                  <div className={styles.memMeta}>
                    {candidate.kind && KIND_LABEL[candidate.kind] ? <SoulTag tone="outline">{t(KIND_LABEL[candidate.kind]!)}</SoulTag> : null}
                    <MetaLine className={styles.memCaption}>
                      {candidate.agentId ? (
                        <span className={styles.memFixed}>{t('pa.soul.manage.memory.wants', { name: displayName(index, candidate.agentId) })}</span>
                      ) : null}
                      {typeof candidate.dueAt === 'number' ? (
                        <span className={styles.memFixed}>{t('pa.soul.manage.memory.dueOn', { date: formatDay(candidate.dueAt, now, locale) })}</span>
                      ) : null}
                    </MetaLine>
                  </div>
                </div>
                <div className="flex flex-none items-center gap-1.5">
                  <Button size="sm" onClick={() => resolveCandidate(candidate, true)}>{t('pa.soul.manage.memory.save')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => resolveCandidate(candidate, false)}>{t('pa.soul.manage.memory.dismiss')}</Button>
                </div>
              </article>
            ) : (
              <article key={candidate.id} className={styles.memRow}>
                <div className={styles.memBody}>
                  <div className={styles.memScope}>{t('pa.memory.proposedProcedure')}</div>
                  <PaMarkdown text={candidate.content} />
                  <Button size="sm" onClick={() => void data.actions.resolveMemoryCandidate(candidate.id, candidate.revision, true).catch(error =>
                    toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) }))}>{t('pa.save')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void data.actions.resolveMemoryCandidate(candidate.id, candidate.revision, false).catch(error =>
                    toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) }))}>{t('pa.memory.dismissProcedure')}</Button>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {empty ? null : (
          <div className={styles.controls}>
            <Segmented
              size="md"
              className="flex w-full"
              value={filter}
              onValueChange={(value) => nav.setMemoryFilter(value as PaMemoryFilter)}
              aria-label={t('pa.memory.filter')}
            >
              {FILTERS.map((key) => (
                <SegmentedItem key={key} value={key} className="min-w-0 flex-1" data-testid={`pa-memory-filter-${key}`}>
                  <span className={styles.segLabel} title={label(key)}>{label(key)}</span>
                  {counts[key] > 0 ? <span className={styles.segCount}>{counts[key]}</span> : null}
                </SegmentedItem>
              ))}
            </Segmented>
            <SearchField
              variant="ring"
              value={query}
              placeholder={t('pa.memory.search')}
              aria-label={t('pa.memory.search')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}

        <div className={styles.content}>
          {loading ? (
            <div className={styles.skeletonStack}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} shape="row" index={i} />
              ))}
            </div>
          ) : all.length === 0 ? (
            <EmptyState
              variant="dashed"
              className={styles.empty}
              illustration={<FantayMascotStill size={48} />}
              title={t('pa.memory.emptyTitle')}
              description={t('pa.memory.empty')}
            />
          ) : shown.length === 0 ? (
            <p className={styles.noMatch}>{t('pa.memory.noMatch')}</p>
          ) : (
            <div className={styles.memList}>
              {shown.map((memory) => {
                const refs = index.memoryRefCount.get(memory.id) ?? 0;
                const kindLabel = memory.kind ? KIND_LABEL[memory.kind] : undefined;
                const promise = memory.kind === 'promise';
                const done = promise && kept(memory, now);
                const sourceConversation = memory.sourceMessageId ? index.messages.get(memory.sourceMessageId)?.conversationId : undefined;
                return (
                  <article key={memory.id} className={styles.memRow} data-testid="pa-memory-row" data-scope={memory.scope}>
                    <div className={styles.memBody}>
                      <div className={styles.memContent}>
                        <PaMarkdown text={memory.content} />
                      </div>
                      {/* The scope is the row's facet, so it reads as a tag ahead of the caption: its own `·`
                          (智能体 · 审阅者) then never runs into the caption's separators. */}
                      <div className={styles.memMeta}>
                        {kindLabel ? <SoulTag tone="outline">{t(kindLabel)}</SoulTag> : null}
                        <span className={styles.memScope}>{memoryScopeName(index, memory, projects, t)}</span>
                        <MetaLine className={styles.memCaption}>
                          {done ? <span className={styles.memFixed}>{t('pa.soul.manage.memory.kept')}</span> : null}
                          {promise && !done && typeof memory.dueAt === 'number' ? (
                            <span className={styles.memFixed}>{t('pa.soul.manage.memory.dueOn', { date: formatDay(memory.dueAt, now, locale) })}</span>
                          ) : null}
                          {memory.source ? (
                            <span className={styles.memSource} title={memory.source}>
                              {memory.source}
                            </span>
                          ) : null}
                          <span className={styles.memFixed}>{t('pa.memory.updated', { date: formatDay(memory.updatedAt, now, locale) })}</span>
                          <span className={styles.memFixed}>{t('pa.memory.revision', { n: memory.revision })}</span>
                          {refs > 0 ? <span className={styles.memFixed}>{t('pa.memory.refCount', { count: refs })}</span> : null}
                          {sourceConversation ? (
                            <Button
                              variant="link"
                              size="sm"
                              className={cn(styles.memFixed, 'font-medium text-ink-soft')}
                              onClick={() => nav.openConversation(sourceConversation)}
                            >
                              {t('pa.soul.manage.memory.source')}
                            </Button>
                          ) : null}
                        </MetaLine>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton size="xs" variant="quiet" className={styles.memMenu} aria-label={t('pa.memory.actions')}>
                          <MoreHorizontalIcon size="sm" />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent width="sm">
                        {promise && !done ? (
                          <DropdownMenuItem icon={<Icon icon={CircleCheck} size="sm" />} onSelect={() => markKept(memory)}>
                            {t('pa.soul.manage.memory.markKept')}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem icon={<Icon icon={Pencil} size="sm" />} onSelect={() => nav.openModal({ kind: 'memory', memoryId: memory.id })}>
                          {t('pa.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem icon={<Icon icon={Archive} size="sm" />} onSelect={() => setTarget(memory)}>
                          {t('pa.memory.archive')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !archivingRef.current) setTarget(null);
        }}
        title={t('pa.memory.archiveTitle')}
        description={t('pa.memory.archiveBody')}
        confirmLabel={t('pa.memory.archive')}
        cancelLabel={t('pa.cancel')}
        busy={archiving}
        onConfirm={() => void confirmArchive()}
      />
    </div>
  );
}
