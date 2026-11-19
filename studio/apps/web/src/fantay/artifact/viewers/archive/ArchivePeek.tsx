// SPDX-License-Identifier: AGPL-3.0-only
// The pane beside the archive listing: the selected entry's text, its picture, or its facts with the
// reason there is nothing more to show. One entry can be saved out of the archive from here.
'use client';

import { Download, X } from 'lucide-react';

import { useT } from '../../../../i18n';
import { IconButton, Spinner } from '../../../ui';
import { pickFileIcon } from '../../../workspace/code/file-visual';
import { formatBytes } from '../../use-artifact-source';
import styles from '../ArchiveViewer.module.css';
import { CodePane } from '../parts/CodePane';
import type { PeekSkipReason } from './archive-peek';
import type { ArchiveEntry } from './archive-reader';

/** Why the pane shows facts only: decided from the name, or learnt when unpacking failed. */
export type PeekReason = PeekSkipReason | 'unsupported' | 'failed' | 'timeout';

export type PeekContent =
  | { status: 'pending' }
  | { status: 'text'; text: string }
  | { status: 'image'; url: string }
  | { status: 'facts'; reason: PeekReason };

export interface ArchivePeekProps {
  entry: ArchiveEntry;
  content: PeekContent;
  /** True once unpacking has taken long enough to be worth mentioning. */
  slow: boolean;
  /** Identity of the text shown; a new key starts at the top. */
  docKey: string;
  formatDate(time: number): string;
  /** A sentence about the last save attempt, when it did not work. */
  saveNote: string | null;
  saving: boolean;
  onSave(): void;
  onClose(): void;
  onImageError(): void;
}

const REASON_KEYS = {
  type: 'artifact.archive.peek.reason.type',
  'too-large': 'artifact.archive.peek.reason.tooLarge',
  encrypted: 'artifact.archive.peek.reason.encrypted',
  link: 'artifact.archive.peek.reason.link',
  unsupported: 'artifact.archive.peek.reason.unsupported',
  failed: 'artifact.archive.peek.reason.failed',
  timeout: 'artifact.archive.peek.reason.timeout',
} as const;

export function ArchivePeek({
  entry,
  content,
  slow,
  docKey,
  formatDate,
  saveNote,
  saving,
  onSave,
  onClose,
  onImageError,
}: ArchivePeekProps): JSX.Element {
  const t = useT();
  const name = entry.path.split('/').pop() ?? entry.path;
  const Glyph = pickFileIcon(entry.path);
  const isLink = entry.kind === 'link';
  const savable = entry.kind === 'file' && !entry.encrypted;
  const facts = isLink
    ? t('artifact.archive.entryLink')
    : [formatBytes(entry.size), entry.packedSize !== null ? `${t('artifact.archive.peek.packed')} ${formatBytes(entry.packedSize)}` : null]
        .filter(Boolean)
        .join(' · ');

  return (
    <section className={styles.peek} aria-label={t('artifact.archive.peek.label')} data-archive-peek="">
      <header className={styles.peekHead}>
        <Glyph className={styles.peekGlyph} size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles.peekName} title={entry.path}>
          {name}
        </span>
        <span className={styles.peekFacts}>{facts}</span>
        <span className={styles.peekActions}>
          {savable ? (
            <IconButton
              size="sm"
              aria-label={t('artifact.archive.peek.save')}
              tooltipSide="bottom"
              disabled={saving}
              data-archive-action="save-entry"
              onClick={onSave}
            >
              <Download aria-hidden="true" strokeWidth={1.75} />
            </IconButton>
          ) : null}
          <IconButton size="sm" aria-label={t('common.close')} tooltipSide="bottom" data-archive-action="close-peek" onClick={onClose}>
            <X aria-hidden="true" strokeWidth={1.75} />
          </IconButton>
        </span>
      </header>
      {saveNote ? (
        <p className={styles.peekNote} role="status">
          {saveNote}
        </p>
      ) : null}
      <div className={styles.peekBody}>
        {content.status === 'text' ? (
          <CodePane docKey={docKey} fileName={entry.path} text={content.text} />
        ) : content.status === 'image' ? (
          <div className={styles.peekImage}>
            <img src={content.url} alt={name} draggable={false} decoding="async" onError={onImageError} />
          </div>
        ) : content.status === 'pending' ? (
          slow ? (
            <div className={styles.peekWait} role="status">
              <Spinner size="md" label={t('artifact.archive.peek.reading')} />
              <span>{t('artifact.archive.peek.reading')}</span>
            </div>
          ) : null
        ) : (
          <div className={styles.facts}>
            <span className={styles.factsGlyph}>
              <Glyph aria-hidden="true" size={22} strokeWidth={1.5} />
            </span>
            <p className={styles.factsName}>{name}</p>
            {content.reason !== 'folder' ? <p className={styles.factsReason}>{t(REASON_KEYS[content.reason])}</p> : null}
            <dl className={styles.factsList}>
              {!isLink ? (
                <>
                  <dt>{t('artifact.archive.columnSize')}</dt>
                  <dd>{formatBytes(entry.size)}</dd>
                </>
              ) : null}
              {entry.packedSize !== null ? (
                <>
                  <dt>{t('artifact.archive.peek.packed')}</dt>
                  <dd>{formatBytes(entry.packedSize)}</dd>
                </>
              ) : null}
              {entry.modified ? (
                <>
                  <dt>{t('artifact.archive.columnModified')}</dt>
                  <dd>{formatDate(entry.modified)}</dd>
                </>
              ) : null}
              {entry.linkTarget ? (
                <>
                  <dt>{t('artifact.archive.peek.linkTarget')}</dt>
                  <dd className={styles.factsPath}>{entry.linkTarget}</dd>
                </>
              ) : null}
              <dt>{t('artifact.archive.peek.path')}</dt>
              <dd className={styles.factsPath}>{entry.path}</dd>
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
