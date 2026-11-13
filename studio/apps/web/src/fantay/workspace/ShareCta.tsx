// SPDX-License-Identifier: AGPL-3.0-only
// Board header Share (spec 02 §7.5; amendment B20): the one brand-filled action of the header. Target = the HTML frame
// the board reports as selected, else `defaultBoardShareTarget(files)`. The popover embeds the upstream
// TokenToSea share panel unchanged (wrapped in FxLegacy, amendment B3). On the 文件 root FileViewer
// portals its own share/export menu, so only one Share is ever visible.
import { Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { TokenToSeaSharePanel } from '../../components/share/TokenToSeaSharePanel';
import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import type { ProjectFile } from '../../types';
import { Button, FxLegacy, Icon, Popover, PopoverContent, PopoverTrigger, Tooltip, cn } from '../ui';
import { defaultBoardShareTarget } from './share-target';

export type ShareCtaBlocker = 'readOnly' | 'busy' | 'noTarget';

const COMPACT_HEADER_WIDTH = 520;

const BLOCKER_KEYS: Record<ShareCtaBlocker, keyof Dict> = {
  readOnly: 'fantayShell.workspace.shareReadOnly',
  busy: 'fantayShell.workspace.shareBusy',
  noTarget: 'fantayShell.workspace.shareNoTarget',
};

/** Why Share is disabled, in the spec's order (viewer-only, then a run, then no page), or null. */
export function shareCtaBlocker(input: { viewerOnly: boolean; streaming: boolean; target: string | null }): ShareCtaBlocker | null {
  if (input.viewerOnly) return 'readOnly';
  if (input.streaming) return 'busy';
  if (!input.target) return 'noTarget';
  return null;
}

export interface ShareCtaProps {
  projectId: string;
  files: readonly ProjectFile[];
  /** The board's selected single HTML frame (null = fall back to the default target). */
  shareTarget: string | null;
  viewerOnly: boolean;
  /** FileWorkspace `streaming`: composer actions disabled (a run, or a read-only viewer). */
  streaming: boolean;
}

export function ShareCta({ projectId, files, shareTarget, viewerOnly, streaming }: ShareCtaProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = buttonRef.current;
    const targetEl = (el?.closest('.ws-tabs-shell') as HTMLElement | null) ?? el?.parentElement;
    if (!targetEl || typeof ResizeObserver === 'undefined') return undefined;
    const update = (width: number) => {
      if (width > 0) setCompact(width < COMPACT_HEADER_WIDTH);
    };
    update(targetEl.getBoundingClientRect().width || targetEl.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(targetEl);
    return () => observer.disconnect();
  }, []);

  const target = shareTarget ?? defaultBoardShareTarget(files);
  const blocker = shareCtaBlocker({ viewerOnly, streaming, target });
  // A run starting while the popover is open keeps it open with the panel disabled; losing the target
  // or the write access closes it for good (the stored state is cleared too, so it never reopens by
  // itself when a page or the access comes back later).
  const canOpen = target !== null && !viewerOnly;
  if (open && !canOpen) setOpen(false);
  const popoverOpen = open && canOpen;
  const shareLabel = t('fantayShell.workspace.share');

  return (
    <Popover open={popoverOpen} onOpenChange={setOpen}>
      <Tooltip label={compact && !blocker ? shareLabel : null} side="bottom">
        <PopoverTrigger asChild>
          <Button
            ref={buttonRef}
            variant="brand"
            size="sm"
            aria-label={shareLabel}
            data-testid="fantay-board-share"
            data-share-target={target ?? ''}
            data-compact={compact ? 'true' : undefined}
            className={cn(compact && 'w-7 px-0')}
            disabled={blocker !== null}
            disabledReason={blocker ? t(BLOCKER_KEYS[blocker]) : undefined}
          >
            <Icon icon={Share2} size="sm" />
            <span className={compact ? 'sr-only' : undefined}>{shareLabel}</span>
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" width={360} data-testid="fantay-board-share-popover">
        <FxLegacy>
          <TokenToSeaSharePanel projectId={projectId} fileName={target ?? ''} disabled={streaming || viewerOnly} />
        </FxLegacy>
      </PopoverContent>
    </Popover>
  );
}
