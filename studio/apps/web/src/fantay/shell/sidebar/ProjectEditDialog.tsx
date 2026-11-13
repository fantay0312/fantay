// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { pickAndReplaceHostProjectWorkingDir } from '@open-design/host';
import type { Project } from '../../../types';
import { getProjectDetail } from '../../../state/projects';
import { useT } from '../../../i18n';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Modal, ModalActions, ModalTitle } from '../../ui/dialog';

export function ProjectEditDialog({
  project,
  context,
  onSave,
  onClose,
}: {
  project: Project;
  context: WorkspaceCollabContext | null;
  onSave(name: string): void | Promise<void>;
  onClose(): void;
}) {
  const t = useT();
  const [name, setName] = useState(project.name);
  const [directory, setDirectory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let canceled = false;
    void getProjectDetail(project.id, undefined, context).then((detail) => {
      if (!canceled) setDirectory(detail?.resolvedDir ?? null);
    });
    return () => {
      canceled = true;
    };
  }, [project.id, context]);
  const changeDirectory = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await pickAndReplaceHostProjectWorkingDir(project.id);
      if (result.ok) setDirectory(result.baseDir);
      else if (!('canceled' in result)) setError(result.reason);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(name.trim());
      onClose();
    } catch {
      setError(t('ds.actionFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      aria-describedby={undefined}
      size="sm"
    >
      <ModalTitle>{t('fantayShell.sidebar.editProject')}</ModalTitle>
      <Input
        autoFocus
        className="mt-4"
        value={name}
        disabled={busy}
        aria-label={t('designs.menuRename')}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <div className="mt-4 text-copy">
        <span className="font-medium">{t('homeWorkingDir.trigger')}</span>
        <p className="break-all text-ink-soft">{directory ?? t('common.loading')}</p>
        <Button size="sm" disabled={busy} onClick={() => void changeDirectory()}>
          {t('homeWorkingDir.replace')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
      <ModalActions>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button loading={busy} disabled={!name.trim()} onClick={() => void save()}>
          {t('common.save')}
        </Button>
      </ModalActions>
    </Modal>
  );
}
