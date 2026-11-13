// fx-governance-allow-raw: the add tile is a dashed card in the file grid, which no button primitive models
'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Creates or edits one 我的素材 asset. A new asset exists on the daemon only after 保存, so its picked files wait here;
// an existing asset uploads and removes files right away.
import { Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { USER_ASSET_LIMITS, type UserAsset, type UserAssetKind } from '@open-design/contracts';

import { useT } from '../../../i18n';
import {
  createUserAsset,
  deleteUserAsset,
  deleteUserAssetFile,
  updateUserAsset,
  uploadUserAssetFile,
} from '../../../providers/user-assets';
import { Button } from '../../ui/button';
import { Modal, ModalActions, ModalTitle } from '../../ui/dialog';
import { Field } from '../../ui/field';
import { IconButton } from '../../ui/icon-button';
import { Input } from '../../ui/input';
import { Textarea } from '../../ui/textarea';
import { toast } from '../../ui/toast';
import type { DictKey } from '../model/types';
import styles from './panels.module.css';

export const CREATE_LABEL: Record<UserAssetKind, DictKey> = {
  character: 'board.assets.createCharacter',
  product: 'board.assets.createProduct',
  custom: 'board.assets.createCustom',
};

export interface AssetEditorDialogProps {
  /** null while closed. */
  target: { kind: UserAssetKind; asset: UserAsset | null } | null;
  onClose(): void;
  onChanged(): void;
}

export function AssetEditorDialog({ target, onClose, onChanged }: AssetEditorDialogProps) {
  const t = useT();
  const id = useId();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [asset, setAsset] = useState<UserAsset | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState<readonly File[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setAsset(target.asset);
    setName(target.asset?.name ?? '');
    setDescription(target.asset?.description ?? '');
    setPending([]);
  }, [target]);

  const guarded = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      toast({ title: t('board.assets.failed', { detail: error instanceof Error ? error.message : String(error) }), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (!target || !name.trim()) return;
    void guarded(async () => {
      if (asset) await updateUserAsset(asset.id, { name, description });
      else {
        const created = await createUserAsset({ kind: target.kind, name, description });
        for (const file of pending) await uploadUserAssetFile(created.id, file);
      }
      onChanged();
      onClose();
    });
  };

  const addFiles = (picked: File[]): void => {
    if (!asset) {
      setPending((current) => [...current, ...picked].slice(0, USER_ASSET_LIMITS.maxFiles));
      return;
    }
    void guarded(async () => {
      for (const file of picked) setAsset(await uploadUserAssetFile(asset.id, file));
      onChanged();
    });
  };

  const fileCount = (asset?.files.length ?? 0) + pending.length;
  return (
    <Modal open={target !== null} onClose={onClose} size="sm" aria-describedby={undefined} data-testid="board-asset-editor">
      <ModalTitle>{asset ? t('board.assets.edit') : target ? t(CREATE_LABEL[target.kind]) : ''}</ModalTitle>
      <form className={styles.editor} onSubmit={save} noValidate>
        <Field label={t('board.assets.name')} htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={USER_ASSET_LIMITS.maxNameLength}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={t('board.assets.description')} hint={t('board.assets.descriptionHint')} htmlFor={`${id}-description`}>
          <Textarea
            id={`${id}-description`}
            rows={4}
            value={description}
            maxLength={USER_ASSET_LIMITS.maxDescriptionLength}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <div className={styles.editorFiles}>
          {asset?.files.map((file) => (
            <div key={file.id} className={styles.editorFile}>
              {file.mime.startsWith('image/') ? <img src={file.url} alt={file.name} draggable={false} /> : <span>{file.name}</span>}
              <IconButton
                size="xs"
                variant="frosted"
                aria-label={t('board.assets.removeFile')}
                disabled={busy}
                onClick={() => void guarded(async () => {
                  setAsset(await deleteUserAssetFile(asset.id, file.id));
                  onChanged();
                })}
              >
                <X strokeWidth={1.5} />
              </IconButton>
            </div>
          ))}
          {pending.map((file, index) => (
            <div key={`${file.name}-${index}`} className={styles.editorFile}>
              <span>{file.name}</span>
              <IconButton
                size="xs"
                variant="frosted"
                aria-label={t('board.assets.removeFile')}
                onClick={() => setPending((current) => current.filter((_, at) => at !== index))}
              >
                <X strokeWidth={1.5} />
              </IconButton>
            </div>
          ))}
          {fileCount < USER_ASSET_LIMITS.maxFiles ? (
            <button type="button" className={styles.editorAdd} disabled={busy} onClick={() => fileInput.current?.click()}>
              <Plus strokeWidth={1.5} />
              {t('board.assets.addFiles')}
            </button>
          ) : null}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden
          accept="image/*,video/*,audio/*,.pdf,.md,.txt"
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (picked.length > 0) addFiles(picked);
          }}
        />
        <ModalActions>
          {asset ? (
            <Button
              type="button"
              variant="bare"
              className={styles.editorDelete}
              disabled={busy}
              onClick={() => void guarded(async () => {
                await deleteUserAsset(asset.id);
                onChanged();
                onClose();
              })}
            >
              {t('board.assets.delete')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="brand" disabled={busy || !name.trim()} data-testid="board-asset-save">{t('board.assets.save')}</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
