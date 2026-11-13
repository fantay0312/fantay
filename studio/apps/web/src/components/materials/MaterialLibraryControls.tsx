import { useCallback, useEffect, useRef, useState } from 'react';
import type { MaterialLibrary } from '@open-design/contracts';
import { Button } from '@open-design/components';
import { useT } from '../../i18n';
import { addMaterialLibrary, removeMaterialLibrary, scanMaterialLibrary } from '../../providers/materials';
import { openFolderDialog } from '../../providers/registry';
import { Icon } from '../Icon';
import styles from './MaterialLibraryControls.module.css';
import { MaterialLibraryManager } from './MaterialLibraryManager';
import { Select } from '../Select';

export function useMaterialLibraryScope(key: string) {
  const [libraryId, setLibraryId] = useState(() => {
    try { return typeof window === 'undefined' ? '' : window.localStorage.getItem(key) ?? ''; }
    catch { return ''; }
  });
  useEffect(() => { try { window.localStorage.setItem(key, libraryId); } catch { /* storage is optional */ } }, [key, libraryId]);
  return [libraryId, setLibraryId] as const;
}

export function MaterialLibraryControls({ page = false, libraries = [], libraryId, resolvedLibraryId, onChange, onRefresh }: {
  page?: boolean;
  libraries?: MaterialLibrary[];
  libraryId: string;
  resolvedLibraryId?: string;
  onChange: (id: string) => void;
  onRefresh: () => void;
}) {
  const t = useT();
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const manageRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (resolvedLibraryId === libraryId && libraryId && !libraries.some((library) => library.id === libraryId)) onChange('');
  }, [libraries, libraryId, resolvedLibraryId, onChange]);

  function refreshed() {
    onRefresh();
    window.dispatchEvent(new Event('material-libraries-changed'));
  }

  /** `path` absent = ask the system folder picker. Resolves true once connected. */
  async function add(path?: { root: string; name: string }): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      const selected = path ? path.root : await openFolderDialog({ throwOnError: true });
      if (!selected) return false;
      setScanning(true);
      const library = await addMaterialLibrary(selected, path?.name || undefined);
      onChange(library.id);
      refreshed();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setManaging(true);
      return false;
    } finally { setBusy(false); setScanning(false); }
  }

  const closeManager = useCallback(() => {
    setManaging(false);
    setError('');
    manageRef.current?.focus();
  }, []);

  async function rescan(id: string) {
    setBusy(true); setScanning(true); setError('');
    try { await scanMaterialLibrary(id); refreshed(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); setScanning(false); }
  }

  async function remove(id: string) {
    setBusy(true); setError('');
    try {
      await removeMaterialLibrary(id);
      if (libraryId === id) onChange('');
      refreshed();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const unavailable = libraries.filter((library) => !library.status.enabled).length;
  return (
    <section className={page ? styles.page : styles.root} aria-label={t('materials.libraries.title')}>
      <div className={styles.toolbar}>
        <label className={styles.selector}>
          <Icon name="folder" size={16} />
          <Select aria-label={t('materials.libraries.scope')} value={libraryId}
            onChange={(event) => onChange(event.target.value)} data-testid="materials-library-scope">
            <option value="">{t('materials.libraries.all')}</option>
            {libraries.map((library) => <option key={library.id} value={library.id}>
              {library.name} · {library.status.enabled ? library.total : t('materials.libraries.offline')}
            </option>)}
          </Select>
        </label>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void add()}>
          <Icon name="plus" size={15} />{t(busy ? 'materials.libraries.working' : 'materials.libraries.add')}
        </Button>
        <Button ref={manageRef} variant="secondary" size="sm" aria-haspopup="dialog" aria-expanded={managing}
          onClick={() => setManaging(true)}>
          {t('materials.libraries.manage')}
        </Button>
      </div>
      {scanning && !managing ? <p role="status" className={styles.hint}>{t('materials.libraries.scanning')}</p> : null}
      {unavailable > 0 ? <p className={styles.hint}>{t('materials.libraries.offlineHint', { count: unavailable })}</p> : null}
      {error && !managing ? <p role="alert" className={styles.error}>{error}</p> : null}
      {managing ? <MaterialLibraryManager libraries={libraries} busy={busy} scanning={scanning} error={error}
        onClose={closeManager} onPickFolder={() => void add()} onAddPath={(root, name) => add({ root, name })}
        onRescan={(id) => void rescan(id)} onRemove={(id) => void remove(id)} /> : null}
    </section>
  );
}
