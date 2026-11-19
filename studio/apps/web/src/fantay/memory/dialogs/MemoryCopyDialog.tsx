// SPDX-License-Identifier: AGPL-3.0-only
// 复制到…: puts a copy of one memory into another scope. The source is untouched and the copy records
// where it came from; the target list leaves out the memory's own scope.
import { useId, useMemo, useState } from 'react';
import type { MemoryItem, MemoryOverviewResponse } from '@open-design/contracts';
import { memoryScopeKey } from '@open-design/contracts';

import { Button, Field, cn, toast } from '../../ui';
import { memoryApi } from '../api';
import {
  ErrorNotice,
  ScopeSelect,
  findScopeOption,
  scopeOptionGroups,
  useMemoryLabels,
  useOverviewFallback,
  useSessionKey,
} from './dialog-kit';
import { MemoryDialogFrame } from './MemoryDialogFrame';
import frame from './MemoryDialogFrame.module.css';
import { useMemoryDialogT } from './i18n';
import styles from './MemoryCopyDialog.module.css';

export interface MemoryCopyDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  item: MemoryItem | null;
  overview: MemoryOverviewResponse | null;
  onCopied(): void;
}

export function MemoryCopyDialog(props: MemoryCopyDialogProps) {
  const sessionKey = useSessionKey(props.open, props.item?.id ?? '');
  return <CopySession key={sessionKey} {...props} />;
}

function CopySession({ open, onOpenChange, item: givenItem, overview: givenOverview, onCopied }: MemoryCopyDialogProps) {
  const { t } = useMemoryDialogT();
  const labels = useMemoryLabels();
  const targetId = useId();
  const [item] = useState(givenItem);
  const [target, setTarget] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const fallback = useOverviewFallback(open, givenOverview);
  const groups = useMemo(
    () => (fallback.overview && item ? scopeOptionGroups(fallback.overview, t, labels, memoryScopeKey(item.scope)) : []),
    [fallback.overview, item, t, labels],
  );
  const chosen = target ? findScopeOption(groups, target) : null;
  const close = () => onOpenChange(false);

  let blocked: string | null = null;
  if (!item) blocked = t('copy.need.item');
  else if (!chosen) blocked = t('copy.need.target');

  const copy = async () => {
    if (!item || !chosen || saving) return;
    setSaving(true);
    setError(null);
    try {
      await memoryApi.copyItem(item.id, { scope: chosen.scope });
      toast({
        id: 'memory-copied',
        tone: 'success',
        title: t('copy.toast', { scope: chosen.label }),
        description: t('copy.toastBody'),
      });
      onCopied();
      close();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <MemoryDialogFrame
      open={open}
      onClose={close}
      size="md"
      testId="memory-copy-dialog"
      title={t('copy.title')}
      lede={t('copy.lede')}
      onSubmit={() => void copy()}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            disabled={blocked !== null}
            disabledReason={blocked ?? undefined}
            data-testid="memory-copy-submit"
          >
            {t('copy.submit')}
          </Button>
        </>
      }
    >
      {error ? <ErrorNotice error={error} fallback="error.copy" /> : null}
      {item ? (
        <figure className={styles.source}>
          <blockquote className={cn(frame.text, frame.clamp4, styles.quote)}>{item.content}</blockquote>
          <figcaption className={frame.meta}>
            <span>{labels.kind(item.kind)}</span>
            <span>{t('copy.from', { scope: labels.scope(item.scope, item.scopeLabel) })}</span>
          </figcaption>
        </figure>
      ) : null}
      <Field
        label={t('copy.target')}
        htmlFor={targetId}
        labelVariant="form"
        hint={chosen ? labels.readers(chosen.node) : t('copy.targetHint')}
      >
        {fallback.error && !fallback.overview ? (
          <ErrorNotice error={fallback.error} onRetry={fallback.retry} />
        ) : (
          <ScopeSelect
            id={targetId}
            groups={groups}
            value={target}
            disabled={groups.length === 0}
            placeholder={fallback.loading ? t('common.loading') : t('copy.targetPlaceholder')}
            testId="memory-copy-target"
            onChange={setTarget}
          />
        )}
      </Field>
    </MemoryDialogFrame>
  );
}
