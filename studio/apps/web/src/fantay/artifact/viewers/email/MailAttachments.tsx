// fx-governance-allow-raw: an attachment tile (picture, name, type and size) saves its file when pressed; no kit primitive models a tile like it
// SPDX-License-Identifier: AGPL-3.0-only
// The files sent with a message, as a quiet grid under the header: a type glyph (a small picture for
// an image), the decoded name with its extension always in view, the type and the size. Pressing a
// tile saves that file to disk as a download; nothing is ever opened or run from here. "Save all"
// puts every file in one ZIP, so a single download carries them, whatever the system thinks of many
// downloads at once. A part the file was cut in the middle of says it is incomplete.
'use client';

import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '../../../../i18n';
import { Button } from '../../../ui';
import { pickFileIcon } from '../../../workspace/code/file-visual';
import { formatBytes } from '../../use-artifact-source';
import styles from '../EmailViewer.module.css';
import { pictureType, splitExtension } from './mail-format';
import type { MailAttachment } from './mail-types';

/** Pictures larger than this get the type glyph instead of a thumbnail. */
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

export interface ShownAttachment {
  attachment: MailAttachment;
  /** Cleaned name to show and to save under. */
  name: string;
}

export interface MailAttachmentsProps {
  items: readonly ShownAttachment[];
  onSave(item: ShownAttachment): void;
  onSaveAll(): void;
  savingAll: boolean;
}

/** Object addresses for the pictures among the files, released when the list changes or goes. */
function useThumbnails(items: readonly ShownAttachment[]): Map<MailAttachment, string> {
  const [thumbnails, setThumbnails] = useState<Map<MailAttachment, string>>(() => new Map());
  useEffect(() => {
    const made = new Map<MailAttachment, string>();
    for (const { attachment } of items) {
      if (attachment.incomplete || attachment.content.byteLength > MAX_THUMBNAIL_BYTES) continue;
      const type = pictureType(attachment);
      if (type) made.set(attachment, URL.createObjectURL(new Blob([attachment.content], { type })));
    }
    setThumbnails(made);
    return () => {
      for (const address of made.values()) URL.revokeObjectURL(address);
    };
  }, [items]);
  return thumbnails;
}

function Tile({ item, thumbnail, onSave }: { item: ShownAttachment; thumbnail: string | undefined; onSave(): void }): JSX.Element {
  const t = useT();
  const [broken, setBroken] = useState(false);
  const Glyph = pickFileIcon(item.name, item.attachment.mimeType);
  const [base, extension] = splitExtension(item.name);
  const type = extension ? extension.slice(1).toUpperCase() : item.attachment.mimeType.split('/')[1]?.toUpperCase() ?? '';
  return (
    <li className={styles.attachmentItem}>
      <button
        type="button"
        className={styles.tile}
        onClick={onSave}
        aria-label={t('artifact.email.saveAttachment', { name: item.name })}
        data-mail-attachment={item.name}
      >
        <span className={styles.tileGlyph} aria-hidden="true">
          {thumbnail && !broken ? (
            <img className={styles.tileThumb} src={thumbnail} alt="" draggable={false} onError={() => setBroken(true)} />
          ) : (
            <Glyph size={18} strokeWidth={1.75} />
          )}
        </span>
        <span className={styles.tileText}>
          <span className={styles.tileName} title={item.name}>
            <span className={styles.tileBase}>{base}</span>
            {extension ? <span className={styles.tileExtension}>{extension}</span> : null}
          </span>
          <span className={styles.tileFacts}>
            {[type, formatBytes(item.attachment.content.byteLength)].filter(Boolean).join(' · ')}
            {item.attachment.incomplete ? (
              <>
                {' · '}
                <span className={styles.tileIncomplete}>{t('artifact.email.incomplete')}</span>
              </>
            ) : null}
          </span>
        </span>
        <Download className={styles.tileSave} size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </li>
  );
}

export function MailAttachments({ items, onSave, onSaveAll, savingAll }: MailAttachmentsProps): JSX.Element {
  const t = useT();
  const thumbnails = useThumbnails(items);
  const total = items.reduce((sum, item) => sum + item.attachment.content.byteLength, 0);
  const count = items.length === 1 ? t('artifact.email.attachmentsOne') : t('artifact.email.attachments', { count: items.length });
  return (
    <section className={styles.attachments} aria-label={t('artifact.email.attachmentsLabel')} data-mail-attachments="">
      <div className={styles.attachmentsHead}>
        <span className={styles.attachmentsCount}>
          {count} · {formatBytes(total)}
        </span>
        {items.length > 1 ? (
          <Button variant="link" size="sm" className={styles.saveAll} loading={savingAll} onClick={onSaveAll}>
            {t('artifact.email.saveAll')}
          </Button>
        ) : null}
      </div>
      <ul className={styles.attachmentGrid}>
        {items.map((item) => (
          <Tile key={item.attachment.index} item={item} thumbnail={thumbnails.get(item.attachment)} onSave={() => onSave(item)} />
        ))}
      </ul>
    </section>
  );
}
