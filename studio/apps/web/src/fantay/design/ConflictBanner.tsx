// SPDX-License-Identifier: AGPL-3.0-only
// The save-conflict strip under the design header (spec 06 §5.3, §6.1): the file changed elsewhere (an
// agent, the CLI, another window), so autosave stopped. Three ways out, none of which loses data:
// load the latest version, save mine as a copy, or overwrite with mine.
import { useI18n } from '../../i18n';
import { AlertTriangleIcon, Button, FX, cn } from '../ui';

export type ConflictAction = 'reload' | 'saveCopy' | 'overwrite';

export interface ConflictBannerProps {
  /** sha256 now on disk; null when the file was deleted or renamed. */
  currentSha256: string | null;
  /** The action in flight (its button shows a spinner, the others wait). */
  busy?: ConflictAction | null;
  onReload(): void;
  onSaveCopy(): void;
  onOverwrite(): void;
  className?: string;
}

export function ConflictBanner({ currentSha256, busy = null, onReload, onSaveCopy, onOverwrite, className }: ConflictBannerProps) {
  const { t } = useI18n();
  const missing = currentSha256 === null;
  const locked = busy !== null;
  return (
    <div
      role="alert"
      data-testid="design-conflict-banner"
      className={cn(
        FX,
        'flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-0 border-b border-solid border-warning/35 bg-warning/10 px-3 py-2 font-ui',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <AlertTriangleIcon size="sm" className="mt-0.5 flex-none text-warning-ink" />
        <div className="min-w-0">
          <p className="m-0 text-body font-medium text-ink">{t('designEditor.conflict.title')}</p>
          <p className="m-0 mt-0.5 text-label text-ink-soft">
            {t('designEditor.conflict.body')}
            {missing ? ` ${t('designEditor.conflict.missing')}` : ''}
          </p>
        </div>
      </div>
      <div className="flex max-w-full flex-none flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="default"
          disabled={missing || (locked && busy !== 'reload')}
          disabledReason={missing ? t('designEditor.conflict.missing') : undefined}
          loading={busy === 'reload'}
          onClick={onReload}
        >
          {t('designEditor.conflict.reload')}
        </Button>
        <Button size="sm" variant="default" disabled={locked && busy !== 'saveCopy'} loading={busy === 'saveCopy'} onClick={onSaveCopy}>
          {t('designEditor.conflict.saveCopy')}
        </Button>
        <Button size="sm" variant="danger" disabled={locked && busy !== 'overwrite'} loading={busy === 'overwrite'} onClick={onOverwrite}>
          {t('designEditor.conflict.overwrite')}
        </Button>
      </div>
    </div>
  );
}
