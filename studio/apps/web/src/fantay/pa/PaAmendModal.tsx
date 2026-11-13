// SPDX-License-Identifier: AGPL-3.0-only
// Amend modal (spec §14.4): one addition to a task's requirements, applied when the next stage starts.
import { useState } from 'react';
import { useT } from '../../i18n';
import { Button, Field, Textarea } from '../ui';
import { usePa } from './pa-context';
import { PaModalFrame, usePaModalReset, usePaSubmit } from './PaAgentModal';

export function PaAmendModal({ open, onClose, taskId }: { open: boolean; onClose(): void; taskId: string }) {
  const t = useT();
  const { data, index } = usePa();
  const task = index.tasks.get(taskId) ?? null;
  const [content, setContent] = useState('');
  const submit = usePaSubmit();
  usePaModalReset(open, taskId, () => {
    setContent('');
    submit.clear();
  });

  const valid = !!task && content.trim().length > 0;
  const save = () => {
    if (!valid || submit.busy) return;
    // The action reads the task's current revision from the snapshot; on a conflict the text is kept.
    void submit.run(() => data.actions.amendTask(taskId, content.trim())).then((ok) => {
      if (ok) onClose();
    });
  };

  return (
    <PaModalFrame
      open={open}
      onClose={onClose}
      size="sm"
      title={t('pa.amend')}
      lede={task?.goal}
      ledeClamp
      conflict={submit.conflict}
      error={submit.error}
      onSubmit={save}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('pa.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={submit.busy}>
            {t('pa.amendForm.submit')}
          </Button>
        </>
      }
    >
      <Field hint={t('pa.amendHint')}>
        <Textarea
          aria-label={t('pa.amend')}
          value={content}
          rows={4}
          maxLength={16000}
          autoFocus
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault();
              save();
            }
          }}
        />
      </Field>
    </PaModalFrame>
  );
}
