// SPDX-License-Identifier: AGPL-3.0-only
// The file card: what a file wears when nothing can draw its content. It still says what the file
// is (name, type, size) and offers the one useful thing to do with it, so it never reads as an error.
'use client';

import { useT } from '../../../i18n';
import { Button } from '../../ui';
import { pickFileIcon } from '../../workspace/code/file-visual';
import { ArtifactShell } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { formatBytes } from '../use-artifact-source';
import type { ArtifactViewerProps } from '../viewer-types';
import styles from './UnknownViewer.module.css';

export interface FileCardProps extends ArtifactViewerProps {
  /** Why there is no preview, when the reason is more specific than "unknown type". */
  reason?: string;
}

export function FileCard({ projectId, file, family, reason }: FileCardProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const Glyph = pickFileIcon(file.name, file.mime);
  const baseName = file.name.split('/').pop() ?? file.name;
  const typeLabel = family.extension ? family.extension.toUpperCase() : t('artifact.unknown.typeFallback');

  return (
    <ArtifactShell viewer="unknown" path={file.name} stage="canvas" menu={fileActions.menu} menuLabel={t('nextStep.more')}>
      <div className={styles.wrap}>
        <div className={styles.card} data-testid="artifact-file-card">
          <span className={styles.glyph}>
            <Glyph aria-hidden="true" size={26} strokeWidth={1.5} />
          </span>
          <p className={styles.name} title={file.name}>
            {baseName}
          </p>
          <p className={styles.facts}>
            {typeLabel} · {formatBytes(file.size)}
          </p>
          <p className={styles.reason}>{reason ?? t('artifact.unknown.reason')}</p>
          <div className={styles.buttons}>
            <Button size="sm" variant="primary" onClick={fileActions.downloadFile}>
              {t('fileViewer.download')}
            </Button>
          </div>
        </div>
      </div>
    </ArtifactShell>
  );
}

export default function UnknownViewer(props: ArtifactViewerProps): JSX.Element {
  return <FileCard {...props} />;
}
