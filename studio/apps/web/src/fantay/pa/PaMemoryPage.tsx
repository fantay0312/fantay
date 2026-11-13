// SPDX-License-Identifier: AGPL-3.0-only
// 记忆 page (spec §11): a heading with the one page action, the recall hint, a full-width scope
// filter and a search, then one hairline group of memories. Create and edit open the memory modal;
// delete confirms first.
import { useMemo, useRef, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useI18n, useT } from '../../i18n';
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
import { formatDay } from './PaTaskModal';
import { usePa } from './pa-context';
import { memoryScopeName } from './pa-model';
import type { PaMemory, PaMemoryFilter } from './pa-types';
import styles from './PaPages.module.css';

const FILTERS: readonly PaMemoryFilter[] = ['all', 'private', 'agent', 'group', 'project'];

export function PaMemoryPage() {
  const { data, index, ui, nav, projects, now } = usePa();
  const t = useT();
  const { locale } = useI18n();
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<PaMemory | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  const filter = ui.memoryFilter;
  const all = useMemo(() => [...index.memories.values()].sort((a, b) => b.updatedAt - a.updatedAt), [index]);
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

  const create = () =>
    nav.openModal(
      filter === 'all' ? { kind: 'memory', memoryId: null } : { kind: 'memory', memoryId: null, preset: { scope: filter, scopeId: null } },
    );

  const confirmDelete = async () => {
    const memory = target;
    if (!memory || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await data.actions.deleteMemory(memory.id);
      toast({ tone: 'success', title: t('pa.memory.deleted') });
    } catch (error) {
      toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) });
    } finally {
      deletingRef.current = false;
      setDeleting(false);
      setTarget(null);
    }
  };

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
          <Button className={cn('fx-page-action', styles.pageAction)} onClick={create}>
            <Icon icon={Plus} size="sm" />
            {t('pa.newMemory')}
          </Button>
        </header>

        {data.snapshot?.memoryCandidates?.length ? (
          <div className={styles.memList} aria-label={t('pa.memory.proposedProcedure')}>
            {data.snapshot.memoryCandidates.map(candidate => (
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
                  <span className={styles.segLabel}>{label(key)}</span>
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
                return (
                  <article key={memory.id} className={styles.memRow} data-testid="pa-memory-row" data-scope={memory.scope}>
                    <div className={styles.memBody}>
                      <div className={styles.memContent}>
                        <PaMarkdown text={memory.content} />
                      </div>
                      {/* The scope is the row's facet, so it reads as a tag ahead of the caption: its own `·`
                          (智能体 · 审阅者) then never runs into the caption's separators. */}
                      <div className={styles.memMeta}>
                        <span className={styles.memScope}>{memoryScopeName(index, memory, projects, t)}</span>
                        <MetaLine className={styles.memCaption}>
                          {memory.source ? (
                            <span className={styles.memSource} title={memory.source}>
                              {memory.source}
                            </span>
                          ) : null}
                          <span className={styles.memFixed}>{t('pa.memory.updated', { date: formatDay(memory.updatedAt, now, locale) })}</span>
                          <span className={styles.memFixed}>{t('pa.memory.revision', { n: memory.revision })}</span>
                          {refs > 0 ? <span className={styles.memFixed}>{t('pa.memory.refCount', { count: refs })}</span> : null}
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
                        <DropdownMenuItem icon={<Icon icon={Pencil} size="sm" />} onSelect={() => nav.openModal({ kind: 'memory', memoryId: memory.id })}>
                          {t('pa.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem tone="danger" icon={<Icon icon={Trash2} size="sm" />} onSelect={() => setTarget(memory)}>
                          {t('pa.delete')}
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
          if (!open && !deletingRef.current) setTarget(null);
        }}
        title={t('pa.memory.deleteTitle')}
        description={t('pa.memory.deleteBody')}
        confirmLabel={t('pa.delete')}
        cancelLabel={t('pa.cancel')}
        destructive
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
