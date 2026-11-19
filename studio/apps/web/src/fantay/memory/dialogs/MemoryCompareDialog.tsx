// SPDX-License-Identifier: AGPL-3.0-only
// 对比: two memories that disagree (or repeat each other), side by side, with the words that differ washed
// on both sides. Above them, why they were paired and — only as text — the system's hint; nothing is
// preselected. Four choices sit in the footer, each with its consequence written under it. 合并… turns the
// body into an editor prefilled from the merge draft while both originals stay visible above it. After a
// choice a toast says what happened and that both memories stay on record. A side that was already put away
// (archived, replaced, declined) shows its state; the service never brings it back, so the choice that would
// keep it is disabled with the reason, and the other choices say it stays as it is.
import { ArrowLeft, Lightbulb } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MemoryConflict, MemoryConflictResolution, MemoryItem, ResolveMemoryConflictRequest } from '@open-design/contracts';

import { Button, Callout, Field, Icon, ModalSpacer, Spinner, Textarea, toast } from '../../ui';
import { MemoryApiError, memoryApi } from '../api';
import { isPutAway } from '../labels';
import {
  DiffText,
  ErrorNotice,
  LoadingBlock,
  describeError,
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
import styles from './MemoryCompareDialog.module.css';
import { sideBySide, type SideBySideDiff } from './text-diff';

export interface MemoryCompareDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  conflictId: string | null;
  onResolved(): void;
}

/** The footer order: the older side first, as the columns read. */
const CHOICES: readonly MemoryConflictResolution[] = ['keep_old', 'keep_new', 'merge', 'keep_both'];

const CHOICE_TEST_ID: Record<MemoryConflictResolution, string> = {
  keep_old: 'memory-compare-keep-old',
  keep_new: 'memory-compare-keep-new',
  merge: 'memory-compare-merge',
  keep_both: 'memory-compare-keep-both',
};

type Step = 'compare' | 'merge';

interface MergeDraft {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  /** `model` wrote it, the service `joined` the two, or the dialog joined them after the draft failed. */
  source: 'model' | 'joined' | 'local';
  content: string;
}

const choiceKey = (choice: MemoryConflictResolution, part: 'choice' | 'help' | 'suggest' | 'toast' | 'toastBody') =>
  `compare.${part}.${choice}` as MemoryDialogKey;

type SideName = 'existing' | 'incoming';

/** The side each choice keeps in use; merge and keep-both keep neither by force. */
const KEEPS: Partial<Record<MemoryConflictResolution, SideName>> = { keep_old: 'existing', keep_new: 'incoming' };

interface ChoiceCopy {
  /** The consequence written under the button. */
  help: string;
  /** Set when the service would refuse this choice: the side it keeps was already put away. */
  blocked: string | null;
}

/** What each choice does to this pair as it is now. Mirrors `engine.resolveConflict`: a put-away side keeps
 *  its state whatever is chosen, and cannot be the side kept. */
export function compareChoiceCopy(
  conflict: Pick<MemoryConflict, 'existing' | 'incoming'>,
  choice: MemoryConflictResolution,
  t: MemoryDialogT,
  gap: string,
): ChoiceCopy {
  const away = { existing: isPutAway(conflict.existing.status), incoming: isPutAway(conflict.incoming.status) };
  if (!away.existing && !away.incoming) return { help: t(choiceKey(choice, 'help')), blocked: null };
  const kept = KEEPS[choice];
  if (kept && away[kept]) {
    const reason = t(`compare.blocked.${conflict[kept].status}` as MemoryDialogKey);
    return { help: reason, blocked: reason };
  }
  const both = away.existing && away.incoming;
  const lead =
    choice === 'merge'
      ? t(both ? 'compare.helpAway.mergeAll' : 'compare.helpAway.merge')
      : choice === 'keep_both'
        ? t(both ? 'compare.helpAway.keep_bothAll' : 'compare.helpAway.keep_both')
        : t(`compare.helpAway.${choice}` as MemoryDialogKey);
  const stays = (['existing', 'incoming'] as const)
    .filter((side) => away[side])
    .map((side) =>
      t(`compare.stays.${conflict[side].status}` as MemoryDialogKey, {
        side: t(side === 'existing' ? 'compare.side.old' : 'compare.side.new'),
      }),
    );
  return { help: [lead, ...stays].join(gap), blocked: null };
}

/** The service refused to keep a side that was put away meanwhile (409 MEMORY_SIDE_PUT_AWAY). */
function keptSidePutAway(error: unknown): boolean {
  return error instanceof MemoryApiError && error.status === 409 && error.code === 'MEMORY_SIDE_PUT_AWAY';
}

export function MemoryCompareDialog(props: MemoryCompareDialogProps) {
  const sessionKey = useSessionKey(props.open, props.conflictId ?? '');
  return <CompareSession key={sessionKey} {...props} />;
}

function CompareSession({ open, onOpenChange, conflictId, onResolved }: MemoryCompareDialogProps) {
  const { t, lang } = useMemoryDialogT();
  const gap = lang === 'en' ? ' ' : '';
  const labels = useMemoryLabels();
  const helpId = useId();
  const mergeFieldId = useId();
  const [id] = useState(conflictId);
  const loaded = useLoader<MemoryConflict>(open && id ? `conflict:${id}` : null, async () => {
    if (!id) throw new Error('no conflict');
    return (await memoryApi.getConflict(id)).conflict;
  });
  const conflict = loaded.data;
  const [step, setStep] = useState<Step>('compare');
  const [busy, setBusy] = useState<MemoryConflictResolution | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<MergeDraft>({ status: 'idle', source: 'joined', content: '' });
  const mergeFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const mergeChoiceRef = useRef<HTMLButtonElement | null>(null);
  const leftMerge = useRef(false);

  const diff = useMemo(
    () => (conflict ? sideBySide(conflict.existing.content, conflict.incoming.content) : null),
    [conflict],
  );
  const close = () => onOpenChange(false);
  const resolved = conflict?.status === 'resolved';
  const copies = useMemo(
    () =>
      conflict
        ? (Object.fromEntries(CHOICES.map((choice) => [choice, compareChoiceCopy(conflict, choice, t, gap)])) as Record<
            MemoryConflictResolution,
            ChoiceCopy
          >)
        : null,
    [conflict, t, gap],
  );
  const anyPutAway = conflict ? isPutAway(conflict.existing.status) || isPutAway(conflict.incoming.status) : false;

  // Moving between the two steps keeps focus on what the step is about.
  useEffect(() => {
    if (step === 'merge') {
      mergeFieldRef.current?.focus();
      leftMerge.current = true;
    } else if (leftMerge.current) {
      mergeChoiceRef.current?.focus();
    }
  }, [step]);

  const requestDraft = () => {
    if (!conflict) return;
    const joined = `${conflict.existing.content}\n${conflict.incoming.content}`;
    setDraft({ status: 'loading', source: 'joined', content: '' });
    memoryApi.mergeDraft(conflict.id).then(
      (result) =>
        setDraft((current) =>
          current.status === 'loading' ? { status: 'ready', source: result.source, content: result.content } : current,
        ),
      () =>
        setDraft((current) => (current.status === 'loading' ? { status: 'failed', source: 'local', content: joined } : current)),
    );
  };

  const startMerge = () => {
    setError(null);
    setStep('merge');
    if (draft.status === 'idle') requestDraft();
  };

  const resolve = async (resolution: MemoryConflictResolution) => {
    if (!conflict || busy || copies?.[resolution].blocked) return;
    const mergedContent = draft.content.trim();
    const body: ResolveMemoryConflictRequest =
      resolution === 'merge' ? { resolution, mergedContent } : { resolution };
    setBusy(resolution);
    setError(null);
    try {
      await memoryApi.resolveConflict(conflict.id, body);
      toast({
        id: `memory-conflict-${conflict.id}`,
        tone: 'success',
        title: t(choiceKey(resolution, 'toast')),
        // With a side put away the usual sentence ("the old one is marked replaced") would not be true.
        description: anyPutAway && copies ? copies[resolution].help : t(choiceKey(resolution, 'toastBody')),
      });
      onResolved();
      close();
    } catch (caught) {
      setError(caught);
      if (describeError(caught, t).stale) {
        // Back to the pair as it is now, so a side put away meanwhile shows it and its choice is disabled.
        if (keptSidePutAway(caught)) setStep('compare');
        loaded.reload();
      }
    } finally {
      setBusy(null);
    }
  };

  const working = busy !== null ? t('common.working') : undefined;
  let mergeBlocked: string | null = null;
  if (draft.status === 'loading') mergeBlocked = t('compare.merge.waitDraft');
  else if (!draft.content.trim()) mergeBlocked = t('compare.merge.needContent');

  let footer;
  let footerClassName: string | undefined;
  if (!conflict || resolved) {
    footer = (
      <Button variant={resolved ? 'primary' : 'ghost'} onClick={close} data-testid="memory-compare-close">
        {resolved ? t('common.done') : t('common.close')}
      </Button>
    );
  } else if (step === 'merge') {
    footer = (
      <>
        <Button variant="ghost" onClick={() => setStep('compare')} disabled={busy !== null} disabledReason={working} data-testid="memory-compare-merge-back">
          <Icon icon={ArrowLeft} size="sm" />
          {t('compare.merge.back')}
        </Button>
        <ModalSpacer />
        <Button
          variant="primary"
          loading={busy === 'merge'}
          disabled={mergeBlocked !== null}
          disabledReason={mergeBlocked ?? undefined}
          onClick={() => void resolve('merge')}
          data-testid="memory-compare-merge-save"
        >
          {t('compare.merge.save')}
        </Button>
      </>
    );
  } else {
    footerClassName = styles.choiceFooter;
    footer = (
      <div className={styles.choices} role="group" aria-label={t('compare.choicesLabel')}>
        {CHOICES.map((choice) => {
          const copy = copies?.[choice];
          const blocked = copy?.blocked ?? null;
          return (
            <div key={choice} className={styles.choice}>
              <Button
                ref={choice === 'merge' ? mergeChoiceRef : undefined}
                block
                loading={busy === choice}
                disabled={blocked !== null || (busy !== null && busy !== choice)}
                disabledReason={blocked ?? working}
                aria-describedby={`${helpId}-${choice}`}
                onClick={() => (choice === 'merge' ? startMerge() : void resolve(choice))}
                data-testid={CHOICE_TEST_ID[choice]}
              >
                {t(choiceKey(choice, 'choice'))}
              </Button>
              <p id={`${helpId}-${choice}`} className={styles.choiceHelp} data-testid={`${CHOICE_TEST_ID[choice]}-help`}>
                {copy?.help ?? t(choiceKey(choice, 'help'))}
              </p>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <MemoryDialogFrame
      open={open}
      onClose={close}
      size="xl"
      testId="memory-compare-dialog"
      title={
        conflict
          ? t(conflict.kind === 'duplicate' ? 'compare.titleDuplicate' : 'compare.titleConflict')
          : t('compare.title')
      }
      lede={
        conflict
          ? t('compare.lede', { scope: labels.scope(conflict.scope, conflict.scopeLabel), when: labels.when(conflict.createdAt) })
          : t('common.loading')
      }
      footer={footer}
      footerClassName={footerClassName}
    >
      {error && keptSidePutAway(error) ? (
        <Callout tone="neutral" role="alert" className={frame.notice} data-testid="memory-compare-put-away">
          <span className={frame.noticeText}>{t('compare.error.putAway')}</span>
        </Callout>
      ) : error ? (
        <ErrorNotice error={error} fallback="error.resolve" />
      ) : null}
      {conflict && diff ? (
        step === 'merge' && !resolved ? (
          <div className={frame.reveal} key="merge">
            <Columns conflict={conflict} diff={diff} labels={labels} t={t} compact />
            <Field
              label={t('compare.merge.label')}
              htmlFor={mergeFieldId}
              labelVariant="form"
              hint={<DraftNote draft={draft} t={t} onRetry={requestDraft} />}
            >
              <Textarea
                ref={mergeFieldRef}
                id={mergeFieldId}
                rows={6}
                value={draft.content}
                readOnly={draft.status === 'loading'}
                aria-busy={draft.status === 'loading' ? true : undefined}
                placeholder={draft.status === 'loading' ? t('compare.merge.drafting') : t('compare.merge.placeholder')}
                maxLength={16000}
                className={styles.mergeField}
                data-testid="memory-compare-merge-content"
                onChange={(event) => {
                  const content = event.target.value;
                  setDraft((current) => ({ ...current, content }));
                }}
              />
            </Field>
            <p className={frame.caption}>
              {anyPutAway && copies ? copies.merge.help : t('compare.merge.consequence')}
            </p>
          </div>
        ) : (
          <div className={frame.reveal} key="compare">
            {resolved && conflict.resolution ? (
              <div className={frame.banner} role="status" data-testid="memory-compare-resolved">
                <span className={frame.bannerText}>
                  {t('compare.resolvedBanner', {
                    choice: t(resolutionKey(conflict.resolution)),
                    when: labels.when(conflict.resolvedAt ?? conflict.createdAt),
                  })}
                </span>
              </div>
            ) : null}
            <div className={styles.why} data-testid="memory-compare-reason">
              <span className={styles.whyLabel}>{t('compare.why')}</span>
              <p className={styles.whyText}>
                {conflict.reason || t(conflict.kind === 'duplicate' ? 'compare.reasonDuplicate' : 'compare.reasonConflict')}
              </p>
              {/* A hint toward a choice the pair no longer allows is left out. */}
              {!resolved && conflict.suggestion && !copies?.[conflict.suggestion].blocked ? (
                <p className={styles.hint} data-testid="memory-compare-hint">
                  <Icon icon={Lightbulb} size="sm" className={styles.hintIcon} />
                  <span>{t('compare.hint', { choice: t(choiceKey(conflict.suggestion, 'suggest')) })}</span>
                  <span className={styles.hintNote}>{t('compare.hintNote')}</span>
                </p>
              ) : null}
            </div>
            <Columns conflict={conflict} diff={diff} labels={labels} t={t} compact={false} />
            <div className={styles.legendRow}>
              {diff.identical ? (
                <span className={frame.legend}>{t('compare.identical')}</span>
              ) : (
                <span className={frame.legend}>
                  <span className={frame.legendSwatch} aria-hidden />
                  {t('compare.legend')}
                </span>
              )}
              {resolved ? null : <span className={frame.legend}>{t('compare.safe')}</span>}
            </div>
          </div>
        )
      ) : loaded.error ? (
        <ErrorNotice
          error={loaded.error}
          fallback="error.load"
          onRetry={describeError(loaded.error, t).code === 'MEMORY_NOT_FOUND' ? undefined : loaded.reload}
          testId="memory-compare-error"
        />
      ) : (
        <div className={styles.loading}>
          <LoadingBlock lines={1} label={t('common.loading')} />
          <div className={styles.loadingColumns} aria-hidden>
            <LoadingBlock lines={4} label={t('common.loading')} />
            <LoadingBlock lines={4} label={t('common.loading')} />
          </div>
        </div>
      )}
    </MemoryDialogFrame>
  );
}

function Columns({
  conflict,
  diff,
  labels,
  t,
  compact,
}: {
  conflict: MemoryConflict;
  diff: SideBySideDiff;
  labels: MemoryLabels;
  t: MemoryDialogT;
  compact: boolean;
}) {
  return (
    <div className={styles.columns} data-compact={compact ? '' : undefined}>
      <Side heading={t('compare.existing')} item={conflict.existing} spans={diff.before} labels={labels} t={t} compact={compact} testId="memory-compare-existing" />
      <Side heading={t('compare.incoming')} item={conflict.incoming} spans={diff.after} labels={labels} t={t} compact={compact} testId="memory-compare-incoming" />
    </div>
  );
}

function Side({
  heading,
  item,
  spans,
  labels,
  t,
  compact,
  testId,
}: {
  heading: string;
  item: MemoryItem;
  spans: SideBySideDiff['before'];
  labels: MemoryLabels;
  t: MemoryDialogT;
  compact: boolean;
  testId: string;
}) {
  const headingId = useId();
  return (
    <section className={styles.side} aria-labelledby={headingId} data-testid={testId} data-status={item.status}>
      <header className={styles.sideHead}>
        <span className={styles.sideTitleRow}>
          <h3 id={headingId} className={styles.sideTitle}>
            {heading}
          </h3>
          {item.status !== 'active' ? (
            <span className={frame.tag} data-testid={`${testId}-state`}>
              {labels.status(item.status)}
            </span>
          ) : null}
        </span>
        <span className={styles.sideWhen}>{t('compare.recorded', { when: labels.when(item.createdAt) })}</span>
      </header>
      <div className={styles.sideText}>
        {item.redacted ? <p className={frame.quiet}>{t('detail.redactedText')}</p> : <DiffText spans={spans} />}
      </div>
      {compact ? null : (
        <div className={styles.sideMeta}>
          <span className={frame.meta}>
            <span>{labels.kind(item.kind)}</span>
            <span>{originLabel(item.origin, t)}</span>
            {item.pinned ? <span className={frame.tag}>{t('detail.pinnedTag')}</span> : null}
          </span>
          {item.source ? <span className={frame.meta}>{t('compare.source', { source: item.source })}</span> : null}
          {item.via?.groupId ? (
            <span className={frame.meta}>{t('detail.viaGroup', { name: item.via.groupName ?? t('detail.unnamedGroup') })}</span>
          ) : null}
        </div>
      )}
    </section>
  );
}

function DraftNote({ draft, t, onRetry }: { draft: MergeDraft; t: MemoryDialogT; onRetry(): void }) {
  if (draft.status === 'loading') {
    return (
      <span className={styles.draftNote}>
        <Spinner size="xs" />
        {t('compare.merge.drafting')}
      </span>
    );
  }
  if (draft.status === 'failed') {
    return (
      <span className={styles.draftNote}>
        {t('compare.merge.draftFailed')}
        <Button variant="link" size="sm" onClick={onRetry} data-testid="memory-compare-merge-retry">
          {t('compare.merge.retryDraft')}
        </Button>
      </span>
    );
  }
  return <span className={styles.draftNote}>{t(draft.source === 'model' ? 'compare.merge.fromModel' : 'compare.merge.joined')}</span>;
}
