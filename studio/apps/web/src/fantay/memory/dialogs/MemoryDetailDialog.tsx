// SPDX-License-Identifier: AGPL-3.0-only
// 记忆详情: one memory in full — its text, where it came from, every version (each showing what changed
// from the one before), the memories it is linked to, any disagreement it is part of, and what happened
// to it, in plain sentences. Linked memories open in place with a way back. Archive is offered with an
// undo; nothing here deletes. An archived memory's text can be cleared (清除内容) behind a confirm: that
// one step cannot be undone, and the record and its activity stay. A memory in use but outside its validity
// window (paused, a kept promise, not started yet) says so with the reason its history gives, and the owner
// can make a paused one recalled again.
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type {
  MemoryConflict,
  MemoryConflictResolution,
  MemoryEvent,
  MemoryItem,
  MemoryItemHistoryResponse,
  MemoryItemVersion,
} from '@open-design/contracts';

import { PaDisclosure } from '../../pa/PaDisclosure';
import { Button, ConfirmDialog, Icon, ModalSpacer, cn, toast } from '../../ui';
import { memoryApi } from '../api';
import { recallHold } from '../labels';
import {
  ErrorNotice,
  Fact,
  InlineDiff,
  LoadingBlock,
  Section,
  actorLabel,
  describeError,
  firstLine,
  originLabel,
  resolutionKey,
  useLoader,
  useMemoryLabels,
  useSessionKey,
  type MemoryLabels,
} from './dialog-kit';
import { MemoryDialogFrame } from './MemoryDialogFrame';
import frame from './MemoryDialogFrame.module.css';
import { useMemoryDialogT, type MemoryDialogKey, type MemoryDialogT } from './i18n';
import styles from './MemoryDetailDialog.module.css';
import { diffWords } from './text-diff';

export interface MemoryDetailDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  itemId: string | null;
  onEdit(item: MemoryItem): void;
  onChanged(): void;
  onOpenConflict(conflictId: string): void;
}

const VISIBLE_VERSIONS = 3;
const VISIBLE_EVENTS = 6;

type Busy = 'archive' | 'restore' | 'pin' | 'redact' | 'resume' | null;

export function MemoryDetailDialog(props: MemoryDetailDialogProps) {
  const sessionKey = useSessionKey(props.open, props.itemId ?? '');
  return <DetailSession key={sessionKey} {...props} />;
}

function DetailSession({ open, onOpenChange, itemId, onEdit, onChanged, onOpenConflict }: MemoryDetailDialogProps) {
  const { t } = useMemoryDialogT();
  const labels = useMemoryLabels();
  // The memories opened from 相关的记忆, so 返回 can walk back.
  const [trail, setTrail] = useState<string[]>(() => (itemId ? [itemId] : []));
  const currentId = trail[trail.length - 1] ?? null;
  const history = useLoader<MemoryItemHistoryResponse>(open && currentId ? `history:${currentId}` : null, () =>
    currentId ? memoryApi.history(currentId) : Promise.reject(new Error('no memory')),
  );
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [confirmRedact, setConfirmRedact] = useState(false);
  // The confirm's own click asks it to close; it stays up until the clearing has settled.
  const redactingRef = useRef(false);
  const close = () => onOpenChange(false);
  const data = history.data;
  const item = data?.item ?? null;
  const editable = item ? !item.readOnly && item.backing !== 'studio' : false;

  const act = async (which: Exclude<Busy, null>, run: () => Promise<unknown>, done: () => void) => {
    setBusy(which);
    setActionError(null);
    try {
      await run();
      done();
      history.reload();
      onChanged();
    } catch (caught) {
      setActionError(caught);
      if (describeError(caught, t).stale) history.reload();
    } finally {
      setBusy(null);
    }
  };

  const archive = (target: MemoryItem) =>
    act('archive', () => memoryApi.itemAction(target.id, { action: 'archive', revision: target.revision }), () =>
      toast({
        id: `memory-archived-${target.id}`,
        title: t('detail.toast.archived'),
        description: t('detail.toast.archivedBody'),
        action: {
          label: t('common.undo'),
          onClick: () => {
            void memoryApi.itemAction(target.id, { action: 'restore' }).then(
              () => {
                history.reload();
                onChanged();
              },
              () => toast({ tone: 'danger', title: t('detail.toast.undoFailed') }),
            );
          },
        },
      }),
    );

  const restore = (target: MemoryItem) =>
    act('restore', () => memoryApi.itemAction(target.id, { action: 'restore', revision: target.revision }), () =>
      toast({ id: `memory-restored-${target.id}`, tone: 'success', title: t('detail.toast.restored') }),
    );

  const redact = async (target: MemoryItem) => {
    if (redactingRef.current) return;
    redactingRef.current = true;
    await act('redact', () => memoryApi.itemAction(target.id, { action: 'redact', confirm: true, revision: target.revision }), () =>
      toast({ id: `memory-redacted-${target.id}`, title: t('detail.toast.redacted'), description: t('detail.toast.redactedBody') }),
    );
    redactingRef.current = false;
    setConfirmRedact(false);
  };

  const togglePin = (target: MemoryItem) =>
    act('pin', () => memoryApi.updateItem(target.id, { pinned: !target.pinned, revision: target.revision }), () =>
      toast({
        id: `memory-pinned-${target.id}`,
        tone: 'success',
        title: target.pinned ? t('detail.toast.unpinned') : t('detail.toast.pinned'),
        description: target.pinned ? undefined : t('detail.toast.pinnedBody'),
      }),
    );

  /** Recalled again: the validity window is opened by clearing its end (the owner's own change). */
  const resume = (target: MemoryItem, kept: boolean) =>
    act('resume', () => memoryApi.updateItem(target.id, { validUntil: null, revision: target.revision }), () =>
      toast({
        id: `memory-resumed-${target.id}`,
        tone: 'success',
        title: kept ? t('detail.toast.unkept') : t('detail.toast.resumed'),
        description: t('detail.toast.resumedBody'),
      }),
    );

  const working = busy !== null ? t('common.working') : undefined;
  const footer = item ? (
    <>
      {editable && item.status === 'active' ? (
        <Button
          variant="ghost"
          loading={busy === 'archive'}
          disabled={busy !== null && busy !== 'archive'}
          disabledReason={working}
          onClick={() => void archive(item)}
          data-testid="memory-detail-archive"
        >
          {t('detail.archive')}
        </Button>
      ) : null}
      {editable && item.status === 'archived' ? (
        <Button
          variant="ghost"
          loading={busy === 'restore'}
          disabled={busy !== null && busy !== 'restore'}
          disabledReason={working}
          onClick={() => void restore(item)}
          data-testid="memory-detail-restore"
        >
          {t('detail.restore')}
        </Button>
      ) : null}
      {/* Only an archived memory can be cleared; the confirm carries the solid destructive button. */}
      {editable && item.status === 'archived' && !item.redacted ? (
        <Button
          variant="ghost"
          loading={busy === 'redact'}
          disabled={busy !== null && busy !== 'redact'}
          disabledReason={working}
          onClick={() => setConfirmRedact(true)}
          data-testid="memory-detail-redact"
        >
          {t('detail.redact')}
        </Button>
      ) : null}
      <ModalSpacer />
      {editable && item.status === 'active' ? (
        <Button
          variant="ghost"
          loading={busy === 'pin'}
          disabled={busy !== null && busy !== 'pin'}
          disabledReason={working}
          onClick={() => void togglePin(item)}
          data-testid="memory-detail-pin"
        >
          {item.pinned ? t('detail.unpin') : t('detail.pin')}
        </Button>
      ) : null}
      {editable && !item.redacted && (item.status === 'active' || item.status === 'pending') ? (
        <Button
          variant="primary"
          disabled={busy !== null}
          disabledReason={working}
          onClick={() => onEdit(item)}
          data-testid="memory-detail-edit"
        >
          {t('detail.edit')}
        </Button>
      ) : (
        <Button variant="primary" onClick={close} data-testid="memory-detail-done">
          {t('common.done')}
        </Button>
      )}
    </>
  ) : (
    <Button variant="ghost" onClick={close}>
      {t('common.close')}
    </Button>
  );

  return (
    <MemoryDialogFrame
      open={open}
      onClose={close}
      size="lg"
      testId="memory-detail-dialog"
      title={t('detail.title')}
      lede={
        item
          ? [labels.kind(item.kind), labels.scope(item.scope, item.scopeLabel), item.status === 'active' ? null : labels.status(item.status)]
              .filter(Boolean)
              .join(' · ')
          : t('common.loading')
      }
      footer={footer}
    >
      {trail.length > 1 ? (
        <Button
          variant="bare"
          size="sm"
          className={styles.back}
          onClick={() => setTrail((current) => current.slice(0, -1))}
          data-testid="memory-detail-back"
        >
          <Icon icon={ChevronLeft} size="sm" />
          {t('detail.back')}
        </Button>
      ) : null}
      {actionError ? <ErrorNotice error={actionError} fallback="error.action" /> : null}
      {data && item ? (
        <div className={frame.reveal} key={item.id}>
          <DetailBody
            data={data}
            labels={labels}
            t={t}
            onOpenItem={(id) => setTrail((current) => [...current, id])}
            onOpenConflict={onOpenConflict}
            onResume={editable ? (kept) => void resume(item, kept) : undefined}
            resuming={busy === 'resume'}
            blocked={busy !== null && busy !== 'resume'}
          />
        </div>
      ) : history.error ? (
        <ErrorNotice
          error={history.error}
          fallback="error.load"
          onRetry={describeError(history.error, t).code === 'MEMORY_NOT_FOUND' ? undefined : history.reload}
          testId="memory-detail-error"
        />
      ) : (
        <LoadingBlock lines={4} rows={2} label={t('common.loading')} testId="memory-detail-loading" />
      )}
      <ConfirmDialog
        open={confirmRedact && open}
        onOpenChange={(next) => {
          if (!redactingRef.current) setConfirmRedact(next);
        }}
        title={t('detail.redactTitle')}
        description={t('detail.redactBody')}
        confirmLabel={t('detail.redact')}
        cancelLabel={t('common.cancel')}
        destructive
        busy={busy === 'redact'}
        onConfirm={() => {
          if (item) void redact(item);
        }}
      />
    </MemoryDialogFrame>
  );
}

function DetailBody({
  data,
  labels,
  t,
  onOpenItem,
  onOpenConflict,
  onResume,
  resuming,
  blocked,
}: {
  data: MemoryItemHistoryResponse;
  labels: MemoryLabels;
  t: MemoryDialogT;
  onOpenItem(id: string): void;
  onOpenConflict(id: string): void;
  /** Absent when this memory cannot be changed here. */
  onResume: ((kept: boolean) => void) | undefined;
  resuming: boolean;
  blocked: boolean;
}) {
  const { item } = data;
  const openConflicts = data.conflicts.filter((conflict) => conflict.status === 'open');
  const related = useMemo(() => relatedRows(data), [data]);
  const versions = useMemo(() => [...data.versions].sort((a, b) => b.version - a.version), [data.versions]);
  const events = useMemo(() => [...data.events].sort((a, b) => b.seq - a.seq), [data.events]);

  return (
    <>
      <StatusBanner
        item={item}
        events={data.events}
        openConflicts={openConflicts}
        labels={labels}
        t={t}
        onOpenConflict={onOpenConflict}
        onOpenItem={onOpenItem}
        onResume={onResume}
        resuming={resuming}
        blocked={blocked}
      />

      <div className={styles.lead}>
        {item.redacted ? (
          <p className={frame.quiet} data-testid="memory-detail-text">
            {t('detail.redactedText')}
          </p>
        ) : (
          <p className={cn(frame.text, styles.text)} data-testid="memory-detail-text">
            {item.content}
          </p>
        )}
        <div className={frame.meta}>
          {item.pinned ? <span className={frame.tag}>{t('detail.pinnedTag')}</span> : null}
          {item.versionCount > 1 ? <span>{t('detail.versionN', { n: item.versionCount })}</span> : null}
          <span>{t('detail.updated', { when: labels.when(item.updatedAt) })}</span>
        </div>
      </div>

      <Section title={t('detail.provenance')} testId="memory-detail-provenance">
        <div className={frame.group}>
          <Fact label={t('detail.fact.origin')}>
            {item.source ? `${originLabel(item.origin, t)} · ${item.source}` : originLabel(item.origin, t)}
          </Fact>
          <Fact label={t('detail.fact.recorded')}>{labels.when(item.createdAt)}</Fact>
          {item.eventAt !== null ? <Fact label={t('detail.fact.happened')}>{labels.when(item.eventAt)}</Fact> : null}
          {item.dueAt !== null ? <Fact label={t('detail.fact.due')}>{labels.day(item.dueAt)}</Fact> : null}
          {item.via?.groupId ? (
            <Fact label={t('detail.fact.group')}>{t('detail.viaGroup', { name: item.via.groupName ?? t('detail.unnamedGroup') })}</Fact>
          ) : null}
          {item.via?.conversationTitle ? <Fact label={t('detail.fact.conversation')}>{item.via.conversationTitle}</Fact> : null}
          {item.via?.projectName ? <Fact label={t('detail.fact.project')}>{item.via.projectName}</Fact> : null}
          {item.dataClass === 'local_only' ? <Fact label={t('detail.fact.privacy')}>{t('detail.localOnly')}</Fact> : null}
        </div>
      </Section>

      {/* Clearing empties every version, so a cleared memory has no texts to compare. */}
      {versions.length > 1 && !item.redacted ? (
        <Section title={t('detail.versions')} count={versions.length} note={t('detail.versionsNote')} testId="memory-detail-versions">
          <VersionList versions={versions.slice(0, VISIBLE_VERSIONS)} all={versions} labels={labels} t={t} />
          {versions.length > VISIBLE_VERSIONS ? (
            <PaDisclosure label={t('detail.olderVersions')} count={versions.length - VISIBLE_VERSIONS}>
              <VersionList versions={versions.slice(VISIBLE_VERSIONS)} all={versions} labels={labels} t={t} />
            </PaDisclosure>
          ) : null}
        </Section>
      ) : null}

      {related.length > 0 ? (
        <Section title={t('detail.related')} count={related.length} testId="memory-detail-related">
          <div className={frame.group}>
            {related.map((row) => (
              <Button
                key={row.item.id}
                variant="bare"
                className={styles.relatedRow}
                onClick={() => onOpenItem(row.item.id)}
                data-testid={`memory-detail-related-${row.item.id}`}
              >
                <span className={styles.relatedBody}>
                  <span className={styles.relation}>{t(row.relation)}</span>
                  <span className={cn(styles.relatedText, frame.clamp2)}>
                    {row.item.redacted ? t('detail.redactedShort') : firstLine(row.item.content)}
                  </span>
                  <span className={frame.meta}>
                    <span>{labels.scope(row.item.scope, row.item.scopeLabel)}</span>
                    <span>{labels.status(row.item.status)}</span>
                  </span>
                </span>
                <Icon icon={ChevronRight} size="sm" className={styles.chevron} />
              </Button>
            ))}
          </div>
        </Section>
      ) : null}

      {data.conflicts.length > 0 ? (
        <Section title={t('detail.conflicts')} count={data.conflicts.length} testId="memory-detail-conflicts">
          <div className={frame.group}>
            {data.conflicts.map((conflict) => (
              <ConflictRow key={conflict.id} conflict={conflict} itemId={item.id} labels={labels} t={t} onOpen={onOpenConflict} />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t('detail.activity')} count={events.length} testId="memory-detail-activity">
        {events.length === 0 ? (
          <p className={frame.quiet}>{t('detail.noActivity')}</p>
        ) : (
          <>
            <EventList events={events.slice(0, VISIBLE_EVENTS)} labels={labels} t={t} />
            {events.length > VISIBLE_EVENTS ? (
              <PaDisclosure label={t('detail.olderActivity')} count={events.length - VISIBLE_EVENTS}>
                <EventList events={events.slice(VISIBLE_EVENTS)} labels={labels} t={t} />
              </PaDisclosure>
            ) : null}
          </>
        )}
      </Section>
    </>
  );
}

/** The note of the latest change to the validity window, e.g. why the system paused this memory. */
export function validityNote(events: readonly MemoryEvent[]): string | null {
  let latest: MemoryEvent | null = null;
  for (const event of events) {
    if (event.type !== 'meta_changed') continue;
    const changes = event.data.changes;
    if (!changes || typeof changes !== 'object' || !('validUntil' in changes || 'validFrom' in changes)) continue;
    if (!latest || event.seq > latest.seq) latest = event;
  }
  const note = latest && typeof latest.data.note === 'string' ? latest.data.note.trim() : '';
  return note || null;
}

function StatusBanner({
  item,
  events,
  openConflicts,
  labels,
  t,
  onOpenConflict,
  onOpenItem,
  onResume,
  resuming,
  blocked,
}: {
  item: MemoryItem;
  events: readonly MemoryEvent[];
  openConflicts: MemoryConflict[];
  labels: MemoryLabels;
  t: MemoryDialogT;
  onOpenConflict(id: string): void;
  onOpenItem(id: string): void;
  onResume: ((kept: boolean) => void) | undefined;
  resuming: boolean;
  blocked: boolean;
}) {
  const firstConflict = openConflicts[0];
  if (firstConflict) {
    return (
      <div className={cn(frame.banner, frame.bannerWarm)} role="status">
        <span className={frame.bannerText}>{t('detail.banner.conflict')}</span>
        <Button size="sm" variant="ghost" onClick={() => onOpenConflict(firstConflict.id)} data-testid="memory-detail-open-conflict">
          {t('detail.compare')}
        </Button>
      </div>
    );
  }
  const banner = (
    text: string,
    action?: { label: string; onClick(): void; testId?: string; loading?: boolean },
    testId?: string,
  ) => (
    <div className={frame.banner} role="status" data-testid={testId}>
      <span className={frame.bannerText}>{text}</span>
      {action ? (
        <Button
          size="sm"
          variant="ghost"
          loading={action.loading}
          disabled={blocked}
          disabledReason={blocked ? t('common.working') : undefined}
          onClick={action.onClick}
          data-testid={action.testId}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
  const plain = (key: MemoryDialogKey, action?: { label: string; onClick(): void }) => banner(t(key), action);
  if (item.backing === 'studio' || item.readOnly) return plain('detail.banner.studio');
  if (item.status === 'superseded') {
    const by = item.supersededBy;
    return plain('detail.banner.superseded', by ? { label: t('detail.seeReplacement'), onClick: () => onOpenItem(by) } : undefined);
  }
  if (item.status === 'rejected') return plain('detail.banner.rejected');
  if (item.status === 'archived') return plain('detail.banner.archived');
  if (item.status === 'pending') return plain('detail.banner.pending');
  // In use, but recall reads only memories inside their validity window.
  const hold = recallHold(item, Date.now());
  if (hold === 'notYet' && item.validFrom !== null) {
    return banner(t('detail.banner.notYet', { date: labels.day(item.validFrom) }), undefined, 'memory-detail-hold');
  }
  if (hold === 'paused' || hold === 'kept') {
    const reason = validityNote(events);
    const kept = hold === 'kept' && reason === null;
    const text = reason ? t('detail.banner.pausedWhy', { reason }) : t(kept ? 'detail.banner.kept' : 'detail.banner.paused');
    return banner(
      text,
      onResume
        ? { label: t(kept ? 'detail.unkeep' : 'detail.resume'), onClick: () => onResume(kept), testId: 'memory-detail-resume', loading: resuming }
        : undefined,
      'memory-detail-hold',
    );
  }
  return null;
}

function VersionList({
  versions,
  all,
  labels,
  t,
}: {
  versions: MemoryItemVersion[];
  /** Every version, newest first, so each one finds the version before it. */
  all: MemoryItemVersion[];
  labels: MemoryLabels;
  t: MemoryDialogT;
}) {
  const newest = all[0]?.version;
  return (
    <ol className={styles.timeline}>
      {versions.map((version) => {
        const previous = all.find((entry) => entry.version < version.version);
        return (
          <li key={version.version} className={styles.version} data-current={version.version === newest ? '' : undefined}>
            <span className={frame.meta}>
              <span className={styles.versionName}>{t('detail.versionLabel', { n: version.version })}</span>
              {version.version === newest ? <span className={frame.tag}>{t('detail.current')}</span> : null}
              <span>{actorLabel(version.actor, t)}</span>
              <span>{labels.when(version.createdAt)}</span>
            </span>
            {previous ? (
              <VersionDiff before={previous.content} after={version.content} />
            ) : (
              <p className={cn(frame.text, styles.versionText)}>{version.content}</p>
            )}
            {version.note ? <p className={frame.caption}>{version.note}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

function VersionDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  return <InlineDiff parts={parts} className={styles.versionText} />;
}

function ConflictRow({
  conflict,
  itemId,
  labels,
  t,
  onOpen,
}: {
  conflict: MemoryConflict;
  itemId: string;
  labels: MemoryLabels;
  t: MemoryDialogT;
  onOpen(id: string): void;
}) {
  const other = conflict.incoming.id === itemId ? conflict.existing : conflict.incoming;
  const open = conflict.status === 'open';
  return (
    <div className={styles.conflictRow}>
      <div className={styles.conflictBody}>
        <span className={cn(styles.relatedText, frame.clamp2)}>
          {t(conflict.kind === 'duplicate' ? 'detail.conflictWithDuplicate' : 'detail.conflictWith', { text: firstLine(other.content) })}
        </span>
        <span className={frame.meta}>
          {open ? <span className={cn(frame.tag, frame.tagWarm)}>{t('detail.needsYou')}</span> : null}
          {!open && conflict.resolution ? <span>{t(resolutionKey(conflict.resolution))}</span> : null}
          <span>{labels.when(conflict.resolvedAt ?? conflict.createdAt)}</span>
        </span>
      </div>
      <Button size="sm" variant={open ? 'default' : 'ghost'} onClick={() => onOpen(conflict.id)} data-testid={`memory-detail-conflict-${conflict.id}`}>
        {open ? t('detail.compare') : t('detail.view')}
      </Button>
    </div>
  );
}

function EventList({ events, labels, t }: { events: MemoryEvent[]; labels: MemoryLabels; t: MemoryDialogT }) {
  return (
    <ol className={styles.events}>
      {events.map((event) => (
        <li key={event.seq} className={styles.event}>
          <span className={styles.eventText}>{eventSentence(event, t)}</span>
          <span className={frame.meta}>
            <span>{actorLabel(event.actor, t)}</span>
            <span>{labels.when(event.at)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One plain sentence per event type; a resolved disagreement also says how it was resolved. */
function eventSentence(event: MemoryEvent, t: MemoryDialogT): string {
  const sentence = t(`event.${event.type}` as MemoryDialogKey);
  const resolution = event.data.resolution;
  if (event.type === 'conflict_resolved' && typeof resolution === 'string' && ['keep_new', 'keep_old', 'merge', 'keep_both'].includes(resolution)) {
    return `${sentence} · ${t(resolutionKey(resolution as MemoryConflictResolution))}`;
  }
  // A change the system made on its own says why (for example: its source memory was archived).
  const note = typeof event.data.note === 'string' ? event.data.note.trim() : '';
  return note ? `${sentence} · ${note}` : sentence;
}

interface RelatedRow {
  relation: MemoryDialogKey;
  item: MemoryItem;
}

/** Linked memories in plain relations, each memory once (a merge source is both 合并成了 and 被取代;
 *  the link wins). */
function relatedRows(data: MemoryItemHistoryResponse): RelatedRow[] {
  const byId = new Map(data.related.map((entry) => [entry.id, entry]));
  const rows: RelatedRow[] = [];
  const seen = new Set<string>([data.item.id]);
  const add = (otherId: string, relation: MemoryDialogKey) => {
    const other = byId.get(otherId);
    if (!other || seen.has(otherId)) return;
    seen.add(otherId);
    rows.push({ relation, item: other });
  };
  for (const link of data.links) {
    const outgoing = link.fromId === data.item.id;
    const otherId = outgoing ? link.toId : link.fromId;
    if (link.relation === 'merged_from') add(otherId, outgoing ? 'detail.rel.mergedFrom' : 'detail.rel.mergedInto');
    else if (link.relation === 'supersedes') add(otherId, outgoing ? 'detail.rel.replaced' : 'detail.rel.replacedBy');
    else if (link.relation === 'derived_from') add(otherId, outgoing ? 'detail.rel.copiedFrom' : 'detail.rel.copiedTo');
    else add(otherId, 'detail.rel.related');
  }
  if (data.item.supersededBy) add(data.item.supersededBy, 'detail.rel.replacedBy');
  return rows;
}
