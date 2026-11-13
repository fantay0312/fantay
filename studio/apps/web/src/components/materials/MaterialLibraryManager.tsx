// 素材库管理: a modal over whatever hosts the library controls (the 素材库 page,
// the composer picker dialog, the materials drawer). It used to unfold inline
// under the toolbar and shove the whole grid down; a modal keeps the page
// still and gives the connection list a surface of its own.

import { useEffect, useId, useRef, useState } from 'react';
import type { MaterialLibrary } from '@open-design/contracts';
import { Button, Dialog, DialogDescription, DialogHeader, DialogTitle, Input } from '@open-design/components';
import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { trapTabWithin } from './focus-trap';
import styles from './MaterialLibraryManager.module.css';

export function MaterialLibraryManager({
  libraries,
  busy,
  scanning,
  error,
  onClose,
  onPickFolder,
  onAddPath,
  onRescan,
  onRemove,
}: {
  libraries: MaterialLibrary[];
  busy: boolean;
  scanning: boolean;
  error: string;
  onClose: () => void;
  onPickFolder: () => void;
  /** Resolves true once the library is connected, so the form can clear itself. */
  onAddPath: (root: string, name: string) => Promise<boolean>;
  onRescan: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  const trapRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [root, setRoot] = useState('');
  const [name, setName] = useState('');

  useEffect(() => { closeRef.current?.focus(); }, []);

  // Escape closes only this layer. The picker dialog that can host it listens
  // on `document`; a window capture listener runs first and stops the event
  // there, so one Escape never closes both modals.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  async function submit() {
    if (busy || !root.trim()) return;
    if (await onAddPath(root.trim(), name.trim())) { setRoot(''); setName(''); }
  }

  return (
    <Dialog onClose={onClose} ariaLabelledBy={titleId} ariaDescribedBy={hintId} className={styles.dialog}
      data-testid="materials-library-manager">
      {/* display: contents. Keys stop here: React bubbles portal events up the
          component tree, and a host modal's own Tab trap would pull focus out. */}
      <div ref={trapRef} className={styles.trap}
        onKeyDown={(event) => { trapTabWithin(event, trapRef.current); event.stopPropagation(); }}>
        <DialogHeader className={styles.header}>
          <div className={styles.headingRow}>
            <DialogTitle id={titleId} className={styles.title}>{t('materials.libraries.title')}</DialogTitle>
            <Button ref={closeRef} variant="ghost" size="icon" className={styles.close} onClick={onClose}
              aria-label={t('common.close')}>
              <Icon name="close" size={18} />
            </Button>
          </div>
          <DialogDescription id={hintId} className={styles.hint}>{t('materials.libraries.hint')}</DialogDescription>
        </DialogHeader>

        <div className={styles.body}>
          {libraries.length > 0 ? <ul className={styles.list}>
            {libraries.map((library) => {
              const online = library.status.enabled;
              return <li className={styles.row} key={library.id} data-offline={online ? undefined : ''}>
                <span className={styles.glyph} aria-hidden><Icon name="folder" size={16} /></span>
                <div className={styles.info}>
                  <div className={styles.nameLine}>
                    <strong className={styles.name}>{library.name}</strong>
                    <span className={styles.meta}>
                      {online ? t('materials.resultCount', { count: library.total }) : <>
                        <Icon name="alert-triangle" size={12} />{t('materials.libraries.offline')}
                      </>}
                    </span>
                  </div>
                  <span className={styles.path} title={library.root}>{library.root}</span>
                </div>
                <div className={styles.actions}>
                  {library.kind === 'folder' ? <Button variant="ghost" size="sm" disabled={busy}
                    onClick={() => onRescan(library.id)}>
                    <Icon name="refresh" size={13} />{t('materials.libraries.rescan')}
                  </Button> : null}
                  <Button variant="ghost" size="sm" className={styles.remove} disabled={busy}
                    onClick={() => onRemove(library.id)}
                    aria-label={t('materials.libraries.removeNamed', { name: library.name })}>
                    {t('materials.libraries.remove')}
                  </Button>
                </div>
              </li>;
            })}
          </ul> : null}

          <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <span className={styles.formLabel}>{t('materials.libraries.path')}</span>
            <div className={styles.formRow}>
              <div className={styles.pathField}>
                <Input value={root} onChange={(event) => setRoot(event.target.value)} className={styles.pathInput}
                  placeholder={t('materials.libraries.path')} aria-label={t('materials.libraries.path')}
                  disabled={busy} spellCheck={false} />
                <Button variant="ghost" size="icon" className={styles.browse} disabled={busy}
                  onClick={onPickFolder} aria-label={t('materials.libraries.add')} title={t('materials.libraries.add')}>
                  <Icon name="folder" size={15} />
                </Button>
              </div>
              <Input value={name} onChange={(event) => setName(event.target.value)} className={styles.nameInput}
                placeholder={t('materials.libraries.name')} aria-label={t('materials.libraries.name')}
                maxLength={100} disabled={busy} />
              <Button type="submit" variant="primary" disabled={busy || !root.trim()}>
                {t(busy ? 'materials.libraries.working' : 'materials.libraries.add')}
              </Button>
            </div>
          </form>

          {scanning ? <p role="status" className={styles.status}>{t('materials.libraries.scanning')}</p> : null}
          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        </div>
      </div>
    </Dialog>
  );
}
