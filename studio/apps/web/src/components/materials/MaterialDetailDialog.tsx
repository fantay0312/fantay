// Detail dialog for one material record. Shows the summary fields at once and
// fills in the full record (file list, notes) from `GET /api/materials/items/:id`.
// Escape and the close button dismiss it; the caller returns focus to the card.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { MaterialDetail, MaterialFileRef, MaterialSummaryItem } from '@open-design/contracts';
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  VisuallyHidden,
} from '@open-design/components';
import { useT } from '../../i18n';
import { copyToClipboard } from '../../lib/copy-to-clipboard';
import {
  fetchMaterialContext,
  fetchMaterialDetail,
  isAbortError,
} from '../../providers/materials';
import { Icon } from '../Icon';
import { MaterialCover } from './MaterialCover';
import {
  isSafeCssColor,
  materialKindLabel,
  safeMaterialSourceUrl,
} from './material-model';
import styles from './MaterialDetailDialog.module.css';
import { trapTabWithin } from './focus-trap';

interface Props {
  item: MaterialSummaryItem;
  onClose: () => void;
}

type CopyFeedback = { key: string; ok: boolean } | null;

export function MaterialDetailDialog({ item, onClose }: Props) {
  const t = useT();
  const titleId = useId();
  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [packetBusy, setPacketBusy] = useState(false);
  const [feedback, setFeedback] = useState<CopyFeedback>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const trapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setDetailError(null);
    fetchMaterialDetail(item.id, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setDetail(res.item);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setDetailError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [item.id]);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 2400);
    return () => clearTimeout(timer);
  }, [feedback]);

  const record: MaterialSummaryItem & Partial<MaterialDetail> = detail ?? item;
  const sourceUrl = safeMaterialSourceUrl(record.source);
  const palette = record.palette.filter((color) => isSafeCssColor(color.value));
  const meta = [materialKindLabel(record.kind, t), record.category, record.collection]
    .filter(Boolean)
    .join(' · ');

  async function copyPath(key: string, path: string) {
    const ok = await copyToClipboard(path);
    setFeedback({ key, ok });
  }

  async function copyPacket() {
    if (packetBusy) return;
    setPacketBusy(true);
    try {
      const res = await fetchMaterialContext({ ids: [record.id] });
      const ok = await copyToClipboard(res.markdown);
      setFeedback({ key: 'packet', ok });
    } catch {
      setFeedback({ key: 'packet', ok: false });
    } finally {
      setPacketBusy(false);
    }
  }

  // Keep Tab inside the dialog: it is modal, and the grid behind it stays
  // mounted.
  function trapTab(event: KeyboardEvent<HTMLDivElement>) {
    trapTabWithin(event, trapRef.current);
  }

  const feedbackText = feedback
    ? feedback.ok
      ? feedback.key === 'packet'
        ? t('materials.detail.packetCopied')
        : t('materials.detail.pathCopied')
      : t('materials.detail.copyFailed')
    : '';

  return (
    <Dialog
      onClose={onClose}
      closeOnEscape
      ariaLabelledBy={titleId}
      className={styles.dialog}
      data-testid="material-detail"
    >
      <div ref={trapRef} className={styles.frame} onKeyDown={trapTab}>
        <DialogHeader className={styles.header}>
          <div className={styles.headingRow}>
            <div className={styles.heading}>
              {meta ? <p className={styles.eyebrow}>{meta}</p> : null}
              <DialogTitle id={titleId} className={styles.title} dir="auto">
                {record.title}
              </DialogTitle>
              {record.subtitle ? <p className={styles.subtitle} dir="auto">{record.subtitle}</p> : null}
            </div>
            <Button
              ref={closeRef}
              variant="ghost"
              size="icon"
              className={styles.close}
              onClick={onClose}
              aria-label={t('common.close')}
              data-testid="material-detail-close"
            >
              <Icon name="close" size={18} />
            </Button>
          </div>
        </DialogHeader>

        <DialogBody className={styles.body}>
          <div className={styles.media}>
            <MaterialCover item={record} size="large" />
            {palette.length > 0 ? (
              <section className={styles.block} aria-label={t('materials.detail.palette')}>
                <h3 className={styles.blockTitle}>{t('materials.detail.palette')}</h3>
                <ul className={styles.swatches}>
                  {palette.map((color) => (
                    <li key={`${color.name}-${color.value}`} className={styles.swatch}>
                      <span className={styles.swatchChip} style={{ background: color.value }} aria-hidden />
                      <span className={styles.swatchName}>{color.name}</span>
                      <code className={styles.swatchValue}>{color.value}</code>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <div className={styles.facts}>
            {record.description ? (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>{t('materials.detail.description')}</h3>
                <p className={styles.text} dir="auto">{record.description}</p>
              </section>
            ) : null}

            {record.status || record.useStatus ? (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>{t('materials.detail.status')}</h3>
                {record.status ? <p className={styles.text}>{record.status}</p> : null}
                {record.useStatus ? (
                  <p className={styles.text}>
                    {t('materials.detail.useStatus', { status: record.useStatus })}
                  </p>
                ) : null}
              </section>
            ) : null}

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>{t('materials.detail.license')}</h3>
              <blockquote className={styles.evidence}>
                {record.license || t('materials.detail.licenseMissing')}
              </blockquote>
              <p className={styles.note}>{t('materials.detail.licenseNote')}</p>
            </section>

            {record.source ? (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>{t('materials.detail.source')}</h3>
                {sourceUrl ? (
                  <a
                    className={styles.sourceLink}
                    href={sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="material-detail-source"
                  >
                    <span>{record.source}</span>
                    <Icon name="external-link" size={13} />
                  </a>
                ) : (
                  <p className={styles.mono}>{record.source}</p>
                )}
              </section>
            ) : null}

            {record.previewNote ? (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>{t('materials.detail.previewNote')}</h3>
                <p className={styles.text}>{record.previewNote}</p>
              </section>
            ) : null}

            {record.notes ? (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>{t('materials.detail.notes')}</h3>
                <p className={styles.text} dir="auto">{record.notes}</p>
              </section>
            ) : null}

            {record.tags.length > 0 ? (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>{t('materials.detail.tags')}</h3>
                <ul className={styles.tags}>
                  {record.tags.map((tag) => (
                    <li key={tag} className={styles.tag}>
                      {tag}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>{t('materials.detail.files')}</h3>
              {detail ? (
                <FileList
                  files={detail.files}
                  onCopy={(file) => void copyPath(`file:${file.field}:${file.relativePath}`, file.absolutePath)}
                />
              ) : detailError ? (
                <p className={styles.note} role="status">
                  {t('materials.detail.loadFailed', { detail: detailError })}
                </p>
              ) : (
                <p className={styles.note}>{t('materials.detail.loading')}</p>
              )}
            </section>
          </div>
        </DialogBody>

        <DialogFooter className={styles.footer}>
          <p className={styles.notice}>{t('materials.notice')}</p>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={() => {
                if (detail) void copyPath('entry', detail.absolutePath);
              }}
              disabled={!detail}
              data-testid="material-detail-copy-entry"
            >
              <Icon name="copy" size={14} />
              {t('materials.detail.copyEntryPath')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void copyPacket()}
              disabled={packetBusy}
              aria-busy={packetBusy || undefined}
              data-testid="material-detail-copy-packet"
            >
              <Icon name={packetBusy ? 'spinner' : 'file-text'} size={14} />
              {t('materials.detail.copyPacket')}
            </Button>
          </div>
          <VisuallyHidden role="status" aria-live="polite">
            {feedbackText}
          </VisuallyHidden>
          {feedback ? (
            <span
              className={`${styles.toast}${feedback.ok ? '' : ` ${styles.toastError}`}`}
              aria-hidden
            >
              {feedbackText}
            </span>
          ) : null}
        </DialogFooter>
      </div>
    </Dialog>
  );
}

function FileList({
  files,
  onCopy,
}: {
  files: MaterialFileRef[];
  onCopy: (file: MaterialFileRef) => void;
}) {
  const t = useT();
  if (files.length === 0) {
    return <p className={styles.note}>{t('materials.detail.noFiles')}</p>;
  }
  return (
    <ul className={styles.files} data-testid="material-detail-files">
      {files.map((file) => (
        <li key={`${file.field}:${file.relativePath}`} className={styles.file}>
          <span className={styles.fileField}>{file.field}</span>
          <span className={styles.filePath} title={file.absolutePath}>
            {file.relativePath}
          </span>
          {file.exists ? null : (
            <span className={styles.fileMissing}>{t('materials.detail.fileMissing')}</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={styles.fileCopy}
            onClick={() => onCopy(file)}
            aria-label={t('materials.detail.copyPathFor', { path: file.relativePath })}
          >
            <Icon name="copy" size={13} />
            {t('materials.detail.copyPath')}
          </Button>
        </li>
      ))}
    </ul>
  );
}
