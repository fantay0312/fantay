// SPDX-License-Identifier: AGPL-3.0-only
// Share for a design open in the 文件 root (spec 06 §6.7, plan "share = save as web page"). The brand Share
// button sits where the workspace header's file actions go (`#app-chrome-file-actions`, the slot FileViewer
// portals its share menu into for other files); without that slot it renders in place. A click saves the
// design as `designs/<name>.html` (shareDesignAsWebPage) and opens the existing project-file share panel
// for that page. Upstream panel → wrapped in FxLegacy (amendment B3).
import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Share2 } from 'lucide-react';
import { designNameFromPath, toDesignBridgeError, type WorkspaceCollabContext } from '@open-design/contracts';

import { APP_CHROME_FILE_ACTIONS_ID, APP_CHROME_FILE_ACTIONS_SELECTOR } from '../../components/AppChromeHeader';
import { TokenToSeaSharePanel } from '../../components/share/TokenToSeaSharePanel';
import { useI18n } from '../../i18n';
import { Button, FX, FxLegacy, Icon, Popover, PopoverAnchor, PopoverContent, toast } from '../ui';
import { insertFrameOnBoard } from './design-workspace';
import { describeDesignError } from './DesignEditorHost';
import { shareDesignAsWebPage } from './share';
import type { DesignEditorHandle } from './types';

export interface DesignShareCtaProps {
  projectId: string;
  path: string;
  handle: RefObject<DesignEditorHandle | null>;
  /** The design tab is the visible workspace surface. */
  active: boolean;
  /** The editor finished opening the document. */
  ready: boolean;
  readOnly: boolean;
  runInFlight: boolean;
  workspaceContext: WorkspaceCollabContext | null;
}

function resolveFileActionsHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(APP_CHROME_FILE_ACTIONS_SELECTOR) ?? document.getElementById(APP_CHROME_FILE_ACTIONS_ID);
}

export function DesignShareCta({ projectId, path, handle, active, ready, readOnly, runInFlight, workspaceContext }: DesignShareCtaProps) {
  const { t } = useI18n();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [htmlPath, setHtmlPath] = useState<string | null>(null);

  useEffect(() => {
    setHost(active ? resolveFileActionsHost() : null);
  }, [active]);

  useEffect(() => {
    setOpen(false);
    setHtmlPath(null);
  }, [path, projectId]);

  if (!active) return null;

  const disabledReason = readOnly
    ? t('designEditor.share.readOnly')
    : runInFlight
      ? t('fantayShell.workspace.shareBusy')
      : !ready
        ? t('designEditor.loading')
        : null;

  const share = async () => {
    const editor = handle.current;
    if (!editor) return;
    setBusy(true);
    try {
      const result = await shareDesignAsWebPage(editor, { projectId, path, workspaceContext });
      if (result.created) insertFrameOnBoard(projectId, result.htmlPath, designNameFromPath(result.htmlPath));
      setHtmlPath(result.htmlPath);
      setOpen(true);
    } catch (error) {
      toast({ title: t('designEditor.toast.exportFailed', { reason: describeDesignError(toDesignBridgeError(error), t) }), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const control = (
    <div className={`${FX} flex items-center`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <Button
            variant="brand"
            size="sm"
            data-testid="design-share"
            disabled={disabledReason !== null}
            disabledReason={disabledReason ?? undefined}
            loading={busy}
            onClick={() => void share()}
          >
            <Icon icon={Share2} size="sm" />
            {t('fantayShell.workspace.share')}
          </Button>
        </PopoverAnchor>
        <PopoverContent align="end" width={360} className="p-3" data-testid="design-share-panel">
          {htmlPath ? (
            <FxLegacy>
              <TokenToSeaSharePanel projectId={projectId} fileName={htmlPath} disabled={readOnly || runInFlight} />
            </FxLegacy>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );

  return host ? createPortal(control, host) : control;
}
