// SPDX-License-Identifier: AGPL-3.0-only
// 待处理: what needs the owner. 有分歧的记忆 — one card per pair, opening the compare dialog on top.
// 等你确认 — memories distilled from conversations, each with 不记 / 改一下 / 记下; 改一下 opens a small
// dialog to correct the text, kind or place before accepting. A resolved row folds away before the list
// refreshes, so the rows under it slide up instead of jumping. A failed row action says so in a toast; a failure
// inside 改一下 is shown in that dialog.
import { ChevronRight } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  MemoryConflict,
  MemoryInboxResponse,
  MemoryItem,
  MemoryItemKind,
  MemoryPendingEntry,
  MemoryScopeKind,
  ResolveMemoryPendingRequest,
} from '@open-design/contracts';
import { memoryScopeKey, parseMemoryScopeKey } from '@open-design/contracts';

import { FantayMascotStill } from '../../brand/FantayMascot';
import {
  Button,
  EmptyState,
  Field,
  Icon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cn,
  toast,
} from '../../ui';
import { memoryApi } from '../api';
import { isPutAway } from '../labels';
import {
  ErrorNotice,
  KIND_ORDER,
  LoadingBlock,
  ScopeSelect,
  Section,
  describeError,
  findScopeOption,
  firstLine,
  scopeOptionGroups,
  useLoader,
  useMemoryLabels,
  useOverviewFallback,
  useSessionKey,
  type MemoryLabels,
} from './dialog-kit';
import { MemoryCompareDialog } from './MemoryCompareDialog';
import { MemoryDialogFrame } from './MemoryDialogFrame';
import frame from './MemoryDialogFrame.module.css';
import { useMemoryDialogT, type MemoryDialogKey, type MemoryDialogT } from './i18n';
import styles from './MemoryInboxDialog.module.css';

export interface MemoryInboxDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onChanged(): void;
}

/** Matches the row's fold (--motion-exit) plus a frame, then the list is fetched again. */
const FOLD_MS = 160;

type Extra = Pick<ResolveMemoryPendingRequest, 'content' | 'scope' | 'kind'>;

/** A Personal Agent proposal is accepted only into these places (`paScopeOf` on the service)… */
const PA_PLACES: ReadonlySet<MemoryScopeKind> = new Set(['profile', 'bot', 'group', 'project']);
/** …and keeps only the kinds the Personal Agent has; any other kind would be saved as one of these. */
const PA_KINDS: ReadonlySet<MemoryItemKind> = new Set(['profile', 'preference', 'fact', 'procedure', 'promise', 'moment']);

export function MemoryInboxDialog(props: MemoryInboxDialogProps) {
  const sessionKey = useSessionKey(props.open, 'inbox');
  return <InboxSession key={sessionKey} {...props} />;
}

function InboxSession({ open, onOpenChange, onChanged }: MemoryInboxDialogProps) {
  const { t } = useMemoryDialogT();
  const labels = useMemoryLabels();
  const inbox = useLoader<MemoryInboxResponse>(open ? 'inbox' : null, () => memoryApi.inbox());
  const [compareId, setCompareId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryPendingEntry | null>(null);
  const [busy, setBusy] = useState<{ id: string; accept: boolean } | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const [editError, setEditError] = useState<unknown>(null);
  const timers = useRef<number[]>([]);
  const close = () => onOpenChange(false);

  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  // A fresh list decides what is shown; a row that is somehow still there comes back.
  useEffect(() => setLeaving(new Set()), [inbox.data]);

  const fold = (id: string) => {
    setLeaving((current) => new Set(current).add(id));
    timers.current.push(window.setTimeout(() => inbox.reload(), FOLD_MS));
  };

  const resolveEntry = async (
    entry: MemoryPendingEntry,
    accept: boolean,
    extra: Extra = {},
    from: 'row' | 'edit' = 'row',
  ): Promise<boolean> => {
    if (busy) return false;
    // The list may have been read again since the row or the edit dialog opened: answer the latest revision.
    const latest = inbox.data?.pending.find((current) => current.id === entry.id) ?? entry;
    // 改一下 showed the text it opened with: if the proposal was reworded since, that text is what is accepted.
    const sent: Extra =
      accept && extra.content === undefined && latest.content !== entry.content ? { ...extra, content: entry.content.trim() } : extra;
    setBusy({ id: entry.id, accept });
    setEditError(null);
    try {
      const result = await memoryApi.resolvePending(entry.id, { accept, revision: latest.revision, ...sent });
      const where = extra.scope
        ? labels.scope({ kind: extra.scope.kind, id: extra.scope.id ?? '' })
        : labels.scope(entry.scope, entry.scopeLabel);
      toast({
        id: `memory-pending-${entry.id}`,
        tone: 'success',
        title: accept ? t('inbox.toast.accepted') : t('inbox.toast.rejected'),
        description: accept
          ? result.conflicts.length > 0
            ? t('inbox.toast.acceptedConflict')
            : t('inbox.toast.acceptedWhere', { scope: result.item?.scopeLabel ?? where })
          : t('inbox.toast.rejectedBody'),
      });
      fold(entry.id);
      onChanged();
      return true;
    } catch (caught) {
      const copy = describeError(caught, t, 'error.action');
      if (from === 'edit') setEditError(caught);
      // The inbox list can be long; a toast is seen wherever the row sits.
      else toast({ id: `memory-pending-failed-${entry.id}`, tone: 'danger', title: copy.lead, description: copy.detail ?? undefined });
      if (copy.stale) inbox.reload();
      return false;
    } finally {
      setBusy(null);
    }
  };

  const data = inbox.data;
  const empty = data !== null && data.conflicts.length === 0 && data.pending.length === 0;
  const working = busy ? t('common.working') : undefined;

  return (
    <>
      <MemoryDialogFrame
        open={open}
        onClose={close}
        size="lg"
        testId="memory-inbox-dialog"
        title={t('inbox.title')}
        lede={t('inbox.lede')}
        footer={
          <Button variant="primary" onClick={close} data-testid="memory-inbox-done">
            {t('common.done')}
          </Button>
        }
      >
        {data ? (
          empty ? (
            <EmptyState
              variant="dashed"
              className={cn(frame.reveal, styles.empty)}
              illustration={<FantayMascotStill size={48} />}
              title={t('inbox.emptyTitle')}
              description={t('inbox.emptyBody')}
              data-testid="memory-inbox-empty"
            />
          ) : (
            <div className={frame.reveal}>
              <Section
                title={t('inbox.conflicts')}
                count={data.conflicts.length}
                note={data.conflicts.length > 0 ? t('inbox.conflictsNote') : undefined}
                testId="memory-inbox-conflicts"
              >
                {data.conflicts.length === 0 ? (
                  <p className={frame.quiet}>{t('inbox.noConflicts')}</p>
                ) : (
                  <ul className={frame.group}>
                    {data.conflicts.map((conflict) => (
                      <li key={conflict.id}>
                        <ConflictCard conflict={conflict} labels={labels} t={t} onOpen={() => setCompareId(conflict.id)} />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
              <Section
                title={t('inbox.pending')}
                count={data.pending.length}
                note={data.pending.length > 0 ? t('inbox.pendingNote') : undefined}
                testId="memory-inbox-pending"
              >
                {data.pending.length === 0 ? (
                  <p className={frame.quiet}>{t('inbox.noPending')}</p>
                ) : (
                  <ul className={frame.group}>
                    {data.pending.map((entry) => (
                      <li
                        key={entry.id}
                        className={styles.fold}
                        data-leaving={leaving.has(entry.id) ? '' : undefined}
                        data-testid={`memory-inbox-pending-${entry.id}`}
                      >
                        <div className={styles.foldInner}>
                          <PendingRow
                            entry={entry}
                            labels={labels}
                            t={t}
                            busy={busy}
                            working={working}
                            onReject={() => void resolveEntry(entry, false)}
                            onAccept={() => void resolveEntry(entry, true)}
                            onEdit={() => {
                              setEditError(null);
                              setEditing(entry);
                            }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          )
        ) : inbox.error ? (
          <ErrorNotice error={inbox.error} fallback="error.load" onRetry={inbox.reload} testId="memory-inbox-error" />
        ) : (
          <LoadingBlock lines={1} rows={3} label={t('common.loading')} testId="memory-inbox-loading" />
        )}
      </MemoryDialogFrame>

      <MemoryCompareDialog
        open={compareId !== null}
        onOpenChange={(next) => {
          if (!next) setCompareId(null);
        }}
        conflictId={compareId}
        onResolved={() => {
          inbox.reload();
          onChanged();
        }}
      />

      <PendingEditDialog
        entry={editing}
        busy={busy !== null}
        error={editError}
        onClose={() => setEditing(null)}
        onAccept={async (entry, extra) => {
          const ok = await resolveEntry(entry, true, extra, 'edit');
          if (ok) setEditing(null);
        }}
      />
    </>
  );
}

function ConflictCard({
  conflict,
  labels,
  t,
  onOpen,
}: {
  conflict: MemoryConflict;
  labels: MemoryLabels;
  t: MemoryDialogT;
  onOpen(): void;
}) {
  return (
    <Button variant="bare" className={styles.card} onClick={onOpen} data-testid={`memory-inbox-conflict-${conflict.id}`}>
      <span className={styles.cardBody}>
        <span className={frame.meta}>
          <span className={cn(frame.tag, frame.tagWarm)}>
            {conflict.kind === 'duplicate' ? t('inbox.duplicate') : t('inbox.disagree')}
          </span>
          <span>{labels.scope(conflict.scope, conflict.scopeLabel)}</span>
          <span>{labels.when(conflict.createdAt)}</span>
        </span>
        <span className={styles.pair}>
          <span className={styles.pairLabel}>{t('inbox.existing')}</span>
          <PairText item={conflict.existing} labels={labels} />
          <span className={styles.pairLabel}>{t('inbox.incoming')}</span>
          <PairText item={conflict.incoming} labels={labels} />
        </span>
      </span>
      <span className={styles.cardAction}>
        {t('inbox.compare')}
        <Icon icon={ChevronRight} size="sm" />
      </span>
    </Button>
  );
}

/** One side's first line; a side already put away leads with its state, as in the compare dialog. */
function PairText({ item, labels }: { item: MemoryItem; labels: MemoryLabels }) {
  return (
    <span className={styles.pairText} data-status={item.status}>
      {isPutAway(item.status) ? <span className={cn(frame.tag, styles.pairState)}>{labels.status(item.status)}</span> : null}
      {firstLine(item.content)}
    </span>
  );
}

function PendingRow({
  entry,
  labels,
  t,
  busy,
  working,
  onReject,
  onAccept,
  onEdit,
}: {
  entry: MemoryPendingEntry;
  labels: MemoryLabels;
  t: MemoryDialogT;
  busy: { id: string; accept: boolean } | null;
  working: string | undefined;
  onReject(): void;
  onAccept(): void;
  onEdit(): void;
}) {
  const mine = busy?.id === entry.id;
  return (
    <div className={styles.pendingRow}>
      <p className={cn(frame.text, frame.clamp3, styles.pendingText)}>{entry.content}</p>
      <div className={styles.pendingFoot}>
        <span className={frame.meta}>
          <span>{labels.kind(entry.kind)}</span>
          <span>{t('inbox.into', { scope: labels.scope(entry.scope, entry.scopeLabel) })}</span>
          {entry.via?.groupId ? (
            <span>{t('detail.viaGroup', { name: entry.via.groupName ?? t('detail.unnamedGroup') })}</span>
          ) : entry.sourceLabel ? (
            <span>{entry.sourceLabel}</span>
          ) : null}
          <span>{labels.when(entry.createdAt)}</span>
        </span>
        <span className={styles.pendingActions}>
          <Button
            size="sm"
            variant="bare"
            loading={mine && busy?.accept === false}
            disabled={busy !== null && !(mine && busy.accept === false)}
            disabledReason={working}
            onClick={onReject}
            data-testid={`memory-inbox-reject-${entry.id}`}
          >
            {t('inbox.reject')}
          </Button>
          <Button
            size="sm"
            variant="bare"
            disabled={busy !== null}
            disabledReason={working}
            onClick={onEdit}
            data-testid={`memory-inbox-edit-${entry.id}`}
          >
            {t('inbox.edit')}
          </Button>
          <Button
            size="sm"
            loading={mine && busy?.accept === true}
            disabled={busy !== null && !(mine && busy.accept === true)}
            disabledReason={working}
            onClick={onAccept}
            data-testid={`memory-inbox-accept-${entry.id}`}
          >
            {t('inbox.accept')}
          </Button>
        </span>
      </div>
    </div>
  );
}

/* ── 改一下再记下 ──────────────────────────────────────────────────────────────────────── */

interface PendingEditProps {
  entry: MemoryPendingEntry | null;
  busy: boolean;
  /** The last failed accept from this dialog; shown here, not in the inbox underneath. */
  error: unknown;
  onClose(): void;
  onAccept(entry: MemoryPendingEntry, extra: Extra): Promise<void>;
}

function PendingEditDialog(props: PendingEditProps) {
  const sessionKey = useSessionKey(props.entry !== null, props.entry?.id ?? '');
  return <PendingEditSession key={sessionKey} {...props} />;
}

function PendingEditSession({ entry: givenEntry, busy, error, onClose, onAccept }: PendingEditProps) {
  const { t } = useMemoryDialogT();
  const labels = useMemoryLabels();
  const open = givenEntry !== null;
  const [entry] = useState(givenEntry);
  const ids = { content: useId(), scope: useId(), kind: useId() };
  const contentRef = useRef<HTMLTextAreaElement | null>(null);
  const [content, setContent] = useState(entry?.content ?? '');
  const [kind, setKind] = useState<MemoryItemKind>(entry?.kind ?? 'fact');
  const [scopeKey, setScopeKey] = useState(entry ? memoryScopeKey(entry.scope) : '');
  const fallback = useOverviewFallback(open, null);
  const fromCharacter = entry?.source === 'pa_candidate';
  const groups = useMemo(() => {
    if (!fallback.overview) return [];
    const all = scopeOptionGroups(fallback.overview, t, labels);
    if (!fromCharacter) return all;
    return all
      .map((group) => ({ ...group, options: group.options.filter((option) => PA_PLACES.has(option.scope.kind)) }))
      .filter((group) => group.options.length > 0);
  }, [fallback.overview, t, labels, fromCharacter]);
  const kinds = useMemo(
    () => KIND_ORDER.filter((entryKind) => !fromCharacter || PA_KINDS.has(entryKind) || entryKind === entry?.kind),
    [fromCharacter, entry?.kind],
  );
  const chosen = findScopeOption(groups, scopeKey);
  const trimmed = content.trim();

  const submit = () => {
    if (!entry || !trimmed || busy) return;
    const extra: Extra = {};
    if (trimmed !== entry.content.trim()) extra.content = trimmed;
    if (kind !== entry.kind) extra.kind = kind;
    const scope = parseMemoryScopeKey(scopeKey);
    if (scope && scopeKey !== memoryScopeKey(entry.scope)) extra.scope = scope;
    void onAccept(entry, extra);
  };

  return (
    <MemoryDialogFrame
      open={open}
      onClose={onClose}
      size="md"
      testId="memory-pending-edit-dialog"
      title={t('inbox.editTitle')}
      lede={entry ? t('inbox.editLede', { source: entry.sourceLabel || t('inbox.editSourceUnknown') }) : undefined}
      initialFocusRef={contentRef}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!trimmed}
            disabledReason={t('editor.need.content')}
            data-testid="memory-pending-edit-submit"
          >
            {t('inbox.accept')}
          </Button>
        </>
      }
    >
      {error ? <ErrorNotice error={error} fallback="error.action" testId="memory-pending-edit-error" /> : null}
      <Field label={t('editor.content')} htmlFor={ids.content} labelVariant="form">
        <Textarea
          ref={contentRef}
          id={ids.content}
          rows={5}
          maxLength={16000}
          value={content}
          className={styles.editContent}
          data-testid="memory-pending-edit-content"
          onChange={(event) => setContent(event.target.value)}
        />
      </Field>
      <div className={frame.fieldGrid}>
        <Field
          label={t('editor.scope')}
          htmlFor={ids.scope}
          labelVariant="form"
          hint={chosen ? labels.readers(chosen.node) : undefined}
        >
          {groups.length > 0 && chosen ? (
            <ScopeSelect
              id={ids.scope}
              groups={groups}
              value={scopeKey}
              placeholder={t('editor.scopePlaceholder')}
              testId="memory-pending-edit-scope"
              onChange={setScopeKey}
            />
          ) : (
            <p className={frame.fixedField}>
              {entry ? labels.scope(entry.scope, entry.scopeLabel) : ''}
            </p>
          )}
        </Field>
        <Field label={t('editor.kind')} htmlFor={ids.kind} labelVariant="form" hint={t(`kindHint.${kind}` as MemoryDialogKey)}>
          <Select value={kind} onValueChange={(next) => setKind(next as MemoryItemKind)}>
            <SelectTrigger id={ids.kind} className="w-full" data-testid="memory-pending-edit-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kinds.map((entryKind) => (
                <SelectItem key={entryKind} value={entryKind}>
                  {labels.kind(entryKind)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {fromCharacter ? <p className={frame.caption}>{t('inbox.editPaPlaces')}</p> : null}
    </MemoryDialogFrame>
  );
}
