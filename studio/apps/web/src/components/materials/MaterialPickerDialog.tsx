// "从素材库添加 / Add from materials": the project composer's material picker.
// Search + kind filter + an infinite grid with multi-select (the shared `MaterialBrowser`, on the same
// fetchers as the Materials view). The caller decides what confirming means:
// `attach` copies files into the project (websites become a reference packet),
// `packet` inserts one reference packet for everything selected.

import { useCallback, useId, useRef, useState } from 'react';
import { MATERIAL_CONTEXT_MAX_IDS, type MaterialSummaryItem } from '@open-design/contracts';
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-design/components';
import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { MaterialBrowser } from './MaterialBrowser';
import { isWebsiteMaterial } from './material-model';
import styles from './MaterialPickerDialog.module.css';
import { trapTabWithin } from './focus-trap';

export type MaterialPickMode = 'attach' | 'packet';

interface Props {
  onClose: () => void;
  /** May be async; the dialog stays busy until it settles, then closes. */
  onConfirm: (items: MaterialSummaryItem[], mode: MaterialPickMode) => void | Promise<void>;
  /** The caller only takes copies: no "insert packet" action. */
  attachOnly?: boolean;
}

export function MaterialPickerDialog({ onClose, onConfirm, attachOnly = false }: Props) {
  const t = useT();
  const titleId = useId();
  // Insertion-ordered, so the picks reach the composer in the order chosen,
  // and kept across filter changes.
  const [selected, setSelected] = useState<Map<string, MaterialSummaryItem>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [limitHit, setLimitHit] = useState(false);
  const trapRef = useRef<HTMLDivElement | null>(null);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const toggle = useCallback((item: MaterialSummaryItem) => {
    const prev = selectedRef.current;
    const next = new Map(prev);
    if (next.has(item.id)) {
      next.delete(item.id);
      setLimitHit(false);
    } else if (next.size >= MATERIAL_CONTEXT_MAX_IDS) {
      setLimitHit(true);
      return;
    } else {
      next.set(item.id, item);
    }
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  async function confirm(mode: MaterialPickMode) {
    const picked = Array.from(selected.values());
    if (picked.length === 0 || busy) return;
    setBusy(true);
    try {
      await onConfirm(picked, mode);
    } finally {
      onClose();
    }
  }

  const count = selected.size;
  const websiteCount = Array.from(selected.values()).filter(isWebsiteMaterial).length;

  return (
    <Dialog
      onClose={close}
      closeOnEscape
      closeOnBackdrop={!busy}
      ariaLabelledBy={titleId}
      className={styles.dialog}
      data-testid="material-picker"
    >
      {/* display: contents — only here to keep Tab inside the modal. */}
      <div ref={trapRef} className={styles.trap} onKeyDown={(event) => trapTabWithin(event, trapRef.current)}>
        <DialogHeader className={styles.header}>
          <div className={styles.headingRow}>
            <DialogTitle id={titleId} className={styles.title}>
              {t('materials.picker.title')}
            </DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              className={styles.close}
              onClick={close}
              disabled={busy}
              aria-label={t('common.close')}
            >
              <Icon name="close" size={18} />
            </Button>
          </div>
        </DialogHeader>

        <DialogBody className={styles.body}>
          <MaterialBrowser
            mode="pick"
            enabled
            testIdPrefix="material-picker"
            autoFocusSearch
            selected={selected}
            onToggle={toggle}
          />
        </DialogBody>

        <DialogFooter className={styles.footer}>
          <div className={styles.selection} aria-live="polite">
            <span className={styles.selectionCount} data-testid="material-picker-selected">
              {t('materials.picker.selectedCount', { count })}
            </span>
            {limitHit ? (
              <span className={styles.selectionHint}>
                {t('materials.picker.limitReached', { max: MATERIAL_CONTEXT_MAX_IDS })}
              </span>
            ) : websiteCount > 0 ? (
              <span className={styles.selectionHint}>{t('materials.picker.websiteHint')}</span>
            ) : null}
          </div>
          <div className={styles.actions}>
            <Button onClick={close} disabled={busy}>
              {t('common.cancel')}
            </Button>
            {attachOnly ? null : (
              <Button
                variant="secondary"
                onClick={() => void confirm('packet')}
                disabled={count === 0 || busy}
                data-testid="material-picker-packet"
              >
                {t('materials.picker.insertPacket')}
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => void confirm('attach')}
              disabled={count === 0 || busy}
              aria-busy={busy || undefined}
              data-testid="material-picker-confirm"
            >
              {busy
                ? t('materials.picker.adding')
                : count > 0
                  ? t('materials.picker.addCount', { count })
                  : t('materials.picker.add')}
            </Button>
          </div>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
