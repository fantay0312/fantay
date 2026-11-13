// Free-form New Project form.
//
// The form asks only for what a project is — a name, where it starts (a folder
// on this computer, a Claude Design ZIP, or one of the user's saved templates),
// and an optional design system — and never for a project type. The project is
// bound to the hidden default router (od-default), the same route a free-form
// Home prompt takes: once the user describes the work in the project chat, the
// agent decides whether to build a prototype, a deck, media, or nothing visible
// at all, and the workspace opens only for what it produces.
//
// The modal closes itself when the create completes, or when the user clicks
// the backdrop / presses Esc.

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronDown,
  Folder,
  FolderPlus,
  LayoutTemplate,
  Lightbulb,
  Palette,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID } from '@open-design/contracts';
import { isOpenDesignHostAvailable, pickHostWorkingDir } from '@open-design/host';
import { useAnalytics } from '../analytics/provider';
import { modalOverlay, modalContent } from '../motion';
import { useT } from '../i18n';
import { openFolderDialog } from '../providers/registry';
import type { DesignSystemSummary, ProjectTemplate } from '../types';
import { Button } from '../fantay/ui/button';
import { IconButton } from '../fantay/ui/icon-button';
import { Icon } from '../fantay/ui/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../fantay/ui/dropdown-menu';
import {
  defaultDesignSystemSelection,
  type CreateInput,
  type ImportClaudeDesignOutcome,
} from './new-project-types';
import { Toast } from './Toast';
import styles from './NewProjectModal.module.css';

/** Where the form opens: blank, or with the first saved template already picked (Home's 从模板 entry). */
export type NewProjectStart = 'blank' | 'template';

interface Props {
  open: boolean;
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  templates: ProjectTemplate[];
  onDeleteTemplate?: (id: string) => Promise<boolean>;
  onCreate: (input: CreateInput & { requestId?: string }) => Promise<boolean> | boolean | void;
  onImportClaudeDesign?: (
    file: File,
  ) => Promise<ImportClaudeDesignOutcome | void> | ImportClaudeDesignOutcome | void;
  onClose: () => void;
  start?: NewProjectStart;
}

type Notice = { message: string; details?: string };

const NO_DESIGN_SYSTEM = '__none__';

// The `open` flag stays the public API, but the close animation has to play
// before the modal leaves the DOM, so the body renders inside AnimatePresence
// and its mount effects (focus, scroll lock, Esc) fire exactly when it appears.
export function NewProjectModal({ open, ...rest }: Props) {
  return (
    <AnimatePresence>
      {open ? <NewProjectModalBody {...rest} /> : null}
    </AnimatePresence>
  );
}

function folderPickerErrorDetails(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const message = err.message.trim();
  if (!message) return undefined;
  return message.replace(/^Could not open folder picker:\s*/i, '').trim() || message;
}

function displayFolderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function NewProjectModalBody({
  designSystems,
  defaultDesignSystemId,
  templates,
  onDeleteTemplate,
  onCreate,
  onImportClaudeDesign,
  onClose,
  start = 'blank',
}: Omit<Props, 'open'>) {
  const t = useT();
  const analytics = useAnalytics();
  const title = t('newproj.titleOther');
  const nameRef = useRef<HTMLInputElement | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const [workingDirToken, setWorkingDirToken] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(
    () => (start === 'template' ? templates[0]?.id ?? null : null),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const template = templateId ? templates.find((tpl) => tpl.id === templateId) ?? null : null;

  const selectableDesignSystems = designSystems.filter((d) => d.status !== 'draft');
  const [designSystemId, setDesignSystemId] = useState<string | null>(
    () => defaultDesignSystemSelection(defaultDesignSystemId, designSystems)[0] ?? null,
  );
  // The default may arrive after the first render; follow it until the user picks.
  const dsTouchedRef = useRef(false);
  useEffect(() => {
    if (dsTouchedRef.current) return;
    setDesignSystemId(defaultDesignSystemSelection(defaultDesignSystemId, designSystems)[0] ?? null);
  }, [defaultDesignSystemId, designSystems]);
  const selectedDesignSystem = designSystemId
    ? selectableDesignSystems.find((d) => d.id === designSystemId) ?? null
    : null;

  const busy = creating || picking || importing || deleting;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !creating) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [creating, onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function pickTemplate(id: string) {
    setTemplateId(id);
    setWorkingDir(null);
    setWorkingDirToken(null);
    setConfirmDelete(false);
    setDeleteFailed(false);
  }

  function clearTemplate() {
    setTemplateId(null);
    setConfirmDelete(false);
    setDeleteFailed(false);
  }

  async function handlePickFolder() {
    if (busy) return;
    setPicking(true);
    setNotice(null);
    try {
      if (isOpenDesignHostAvailable()) {
        const result = await pickHostWorkingDir();
        if (result.ok) {
          setWorkingDir(result.baseDir);
          setWorkingDirToken(result.token);
          clearTemplate();
          return;
        }
        if ('canceled' in result && result.canceled) return;
        setNotice({
          message: t('chat.linkedFolderPickError'),
          details: 'reason' in result ? result.reason : t('workingDirPicker.unavailable'),
        });
        return;
      }
      const picked = await openFolderDialog({ throwOnError: true });
      if (picked) {
        setWorkingDir(picked);
        setWorkingDirToken(null);
        clearTemplate();
      }
    } catch (err) {
      setNotice({ message: t('chat.linkedFolderPickError'), details: folderPickerErrorDetails(err) });
    } finally {
      setPicking(false);
    }
  }

  function clearFolder() {
    setWorkingDir(null);
    setWorkingDirToken(null);
  }

  async function handleZipPicked(ev: ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file || !onImportClaudeDesign) return;
    setImporting(true);
    setNotice(null);
    try {
      const result = await onImportClaudeDesign(file);
      if (result?.ok === false) {
        setNotice({
          message: result.message ? `Import failed: ${result.message}` : 'Import failed',
          details: result.details,
        });
        return;
      }
      onClose();
    } catch (err) {
      setNotice({ message: err instanceof Error ? `Import failed: ${err.message}` : 'Import failed' });
    } finally {
      setImporting(false);
    }
  }

  async function handleDeleteTemplate() {
    if (!template || !onDeleteTemplate || deleting) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      const ok = await onDeleteTemplate(template.id);
      if (!ok) {
        setDeleteFailed(true);
        return;
      }
      clearTemplate();
    } catch {
      setDeleteFailed(true);
    } finally {
      setDeleting(false);
    }
  }

  async function handleCreate() {
    if (busy) return;
    const trimmed = name.trim();
    setCreating(true);
    setCreateError(null);
    try {
      const result = await onCreate({
        name: trimmed || template?.name || t('common.untitled'),
        skillId: null,
        designSystemId: selectedDesignSystem?.id ?? null,
        pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
        metadata: template
          ? {
              kind: 'template',
              templateId: template.id,
              templateLabel: template.name,
              nameSource: trimmed ? 'user' : 'generated',
            }
          : {
              kind: 'other',
              // `generated` keeps the project eligible for an automatic rename from the first prompt.
              nameSource: trimmed ? 'user' : 'generated',
              ...(workingDir ? { userWorkingDir: workingDir } : {}),
            },
        ...(!template && workingDirToken ? { userWorkingDirToken: workingDirToken } : {}),
        requestId: analytics.newRequestId(),
      });
      if (result === false) {
        setCreateError('Could not create project. Please try again.');
        return;
      }
      onClose();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create project. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  // One menu for every "where does it start" choice; the trigger differs between the empty card and a picked one.
  function sourceMenu(trigger: ReactNode, align: 'center' | 'end') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} width="lg">
          <DropdownMenuItem icon={<Icon icon={FolderPlus} size="sm" />} onSelect={() => void handlePickFolder()}>
            {t('newproj.sourceFolderEmpty')}
          </DropdownMenuItem>
          {onImportClaudeDesign ? (
            <DropdownMenuItem icon={<Icon icon={Upload} size="sm" />} onSelect={() => zipInputRef.current?.click()}>
              {t('newproj.importClaudeZip')}
            </DropdownMenuItem>
          ) : null}
          {templates.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t('newproj.savedTemplate')}</DropdownMenuLabel>
              {templates.map((tpl) => (
                <DropdownMenuItem
                  key={tpl.id}
                  icon={<Icon icon={LayoutTemplate} size="sm" />}
                  onSelect={() => pickTemplate(tpl.id)}
                  data-testid={`new-project-template-${tpl.id}`}
                >
                  {tpl.name}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const changeTrigger = (
    <Button variant="bare" size="sm" disabled={busy} data-testid="new-project-source-change">
      {picking ? t('workingDirPicker.processing') : t('newproj.changeSourceFolder')}
    </Button>
  );

  let source: ReactNode;
  if (template) {
    source = confirmDelete ? (
      <div className={styles.picked} role="alertdialog" aria-label={t('newproj.deleteTemplateTitle')}>
        <span className={styles.pickedText}>
          <span className={styles.confirmText}>{t('newproj.deleteTemplateConfirm', { name: template.name })}</span>
          {deleteFailed ? <span className={styles.confirmError}>{t('newproj.deleteTemplateError')}</span> : null}
        </span>
        <span className={styles.pickedActions}>
          <Button variant="bare" size="sm" disabled={deleting} onClick={() => setConfirmDelete(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" size="sm" loading={deleting} onClick={() => void handleDeleteTemplate()}>
            {t('newproj.deleteTemplateConfirmCta')}
          </Button>
        </span>
      </div>
    ) : (
      <div className={styles.picked} role="status" data-testid="new-project-template">
        <span className={styles.pickedTile} aria-hidden>
          <Icon icon={LayoutTemplate} size="md" />
        </span>
        <span className={styles.pickedText}>
          <span className={styles.pickedName}>{template.name}</span>
          <span className={styles.pickedPath}>
            {template.description?.trim() ||
              `${t('newproj.savedTemplate')} · ${template.files.length} ${
                template.files.length === 1 ? t('newproj.fileSingular') : t('newproj.filePlural')
              }`}
          </span>
        </span>
        <span className={styles.pickedActions}>
          {sourceMenu(changeTrigger, 'end')}
          {onDeleteTemplate ? (
            <IconButton
              size="sm"
              aria-label={t('newproj.deleteTemplateTitle')}
              tooltip={false}
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Icon icon={Trash2} size="sm" />
            </IconButton>
          ) : null}
          <IconButton size="sm" aria-label={t('workingDirPicker.clearAria')} tooltip={false} disabled={busy} onClick={clearTemplate}>
            <Icon icon={X} size="sm" />
          </IconButton>
        </span>
      </div>
    );
  } else if (workingDir) {
    source = (
      <div className={styles.picked} role="status">
        <span className={styles.pickedTile} aria-hidden>
          <Icon icon={Folder} size="md" />
        </span>
        <span className={styles.pickedText}>
          <span className={styles.pickedName}>{displayFolderName(workingDir)}</span>
          <span className={styles.pickedPath} title={workingDir} data-testid="new-project-source-folder-path">
            {workingDir}
          </span>
        </span>
        <span className={styles.pickedActions}>
          {sourceMenu(changeTrigger, 'end')}
          <IconButton size="sm" aria-label={t('workingDirPicker.clearAria')} tooltip={false} disabled={busy} onClick={clearFolder}>
            <Icon icon={X} size="sm" />
          </IconButton>
        </span>
      </div>
    );
  } else {
    source = (
      <div className={styles.source} aria-busy={picking || importing}>
        {sourceMenu(
          <button type="button" className={styles.sourceMenuTrigger} disabled={busy} data-testid="new-project-source-menu">
            {t('newproj.sourceFolderEmpty')}
            <Icon icon={ChevronDown} size="sm" />
          </button>,
          'center',
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void handlePickFolder()}
          data-testid="new-project-source-folder-pick"
        >
          <Icon icon={FolderPlus} size="sm" />
          {picking
            ? t('workingDirPicker.processing')
            : importing
              ? t('newproj.importingClaudeZip')
              : t('newproj.addSourceFolder')}
        </Button>
        {start === 'template' && templates.length === 0 ? (
          <p className={styles.sourceHint}>
            <strong>{t('newproj.noTemplatesTitle')}</strong> {t('newproj.noTemplatesBody')}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <motion.div
      className="new-project-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="new-project-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !creating) onClose();
      }}
      variants={modalOverlay}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <motion.div
        className={`new-project-modal ${styles.modal}`}
        variants={modalContent}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <div className={`fx ${styles.form}`} data-testid="new-project-panel">
          <header className={styles.head}>
            <h2 className={styles.title}>{title}</h2>
            <IconButton size="sm" aria-label="Close" tooltip={false} onClick={onClose} disabled={creating}>
              <Icon icon={X} size="sm" />
            </IconButton>
          </header>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="new-project-name">
              {t('newproj.namePlaceholder')}
            </label>
            <div className={styles.nameBox}>
              <Icon icon={Folder} size="md" />
              <input
                ref={nameRef}
                id="new-project-name"
                className={styles.nameInput}
                data-testid="new-project-name"
                placeholder={template?.name || t('newproj.free.namePlaceholder')}
                value={name}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
              />
            </div>
          </div>

          <div className={styles.field} data-testid="new-project-source-folder">
            <span className={styles.label}>
              {template ? t('newproj.templateLabel') : t('newproj.sourceFolder')}
            </span>
            {source}
            {onImportClaudeDesign ? (
              <input
                ref={zipInputRef}
                type="file"
                accept=".zip,application/zip"
                hidden
                data-testid="new-project-zip-input"
                onChange={(ev) => void handleZipPicked(ev)}
              />
            ) : null}
          </div>

          <p className={styles.tip}>
            <Icon icon={Lightbulb} size="lg" className={styles.tipIcon} />
            <span>{t('newproj.free.tip')}</span>
          </p>

          {creating || createError ? (
            <p className={styles.status} role={createError ? 'alert' : 'status'} data-tone={createError ? 'error' : undefined}>
              {createError ?? 'Creating project…'}
            </p>
          ) : null}

          <footer className={styles.footer}>
            {selectableDesignSystems.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={styles.dsTrigger}
                    disabled={creating}
                    data-testid="new-project-design-system"
                    aria-label={t('newproj.designSystem')}
                  >
                    <Icon icon={Palette} size="sm" />
                    <span>{t('newproj.designSystem')}</span>
                    <span className={styles.dsName}>
                      {selectedDesignSystem ? selectedDesignSystem.title : t('newproj.dsNoneFreeform')}
                    </span>
                    <Icon icon={ChevronDown} size="sm" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" width="lg">
                  <DropdownMenuRadioGroup
                    value={designSystemId ?? NO_DESIGN_SYSTEM}
                    onValueChange={(value) => {
                      dsTouchedRef.current = true;
                      setDesignSystemId(value === NO_DESIGN_SYSTEM ? null : value);
                    }}
                  >
                    <DropdownMenuRadioItem value={NO_DESIGN_SYSTEM} description={t('newproj.dsNoneSub')}>
                      {t('newproj.dsNoneFreeform')}
                    </DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                    {selectableDesignSystems.map((system) => (
                      <DropdownMenuRadioItem key={system.id} value={system.id} data-testid={`new-project-ds-${system.id}`}>
                        {system.title}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span />
            )}
            <Button
              variant="primary"
              size="lg"
              className={styles.create}
              loading={creating}
              disabled={picking || importing || deleting}
              onClick={() => void handleCreate()}
              data-testid="create-project"
            >
              {t('newproj.free.create')}
            </Button>
          </footer>
        </div>
        {notice ? (
          <Toast
            message={notice.message}
            details={notice.details ?? null}
            ttlMs={6000}
            onDismiss={() => setNotice(null)}
          />
        ) : null}
      </motion.div>
    </motion.div>
  );
}
