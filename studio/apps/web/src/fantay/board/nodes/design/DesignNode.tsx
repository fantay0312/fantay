'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Design face (spec 03 §4.10): an OpenPencil document is never live on the board — it shows its cover (board cover,
// else the design host's export `extensions.resolveDesignCover(path)`) on paper, a format badge, and "Open editor"
// on hover. Double-click / Enter open the editor (engine `enterNode`); without the design extension the button is
// disabled with the "not available yet" reason.
import { PenTool } from 'lucide-react';

import { useT } from '../../../../i18n';
import { Button } from '../../../ui/button';
import { useBoardHost } from '../../context';
import { resolveCover } from '../../engine/covers';
import { BOARD_INTERACTIVE_ATTR } from '../../extensions';
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import { CoverImage } from '../common/CoverImage';
import { PlaceholderFace } from '../common/PlaceholderFace';
import { ICON_STROKE } from '../common/kind-icons';
import { basenameOf, projectFileFor } from '../frame/project-files';
import styles from './design.module.css';

const INTERACTIVE = { [BOARD_INTERACTIVE_ATTR]: '' } as const;
const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

export function DesignNode({ view }: NodeFaceProps) {
  const { env, extensions } = useBoardHost();
  const t = useT();
  const node = view.node as EngineNodeOf<'design'>;
  const path = node.data.ref.path;
  const file = projectFileFor(env.files, path);
  const title = node.title ?? basenameOf(path);
  let designCoverUrl: string | null = null;
  try {
    designCoverUrl = extensions?.resolveDesignCover?.(path) ?? null;
  } catch {
    designCoverUrl = null;
  }
  const cover = resolveCover({ node, file, messages: env.messages, projectId: env.projectId, workspaceContext: env.workspaceContext, designCoverUrl });
  const open = extensions?.openDesignDocument;
  return (
    <div className={styles.design} data-testid="board-design" data-selected={view.selected ? '' : undefined}>
      {cover ? <CoverImage src={cover.url} alt={title} stale={cover.stale && cover.source === 'board'} /> : <PlaceholderFace kind="design" caption={title} />}
      <span className={styles.badge}>
        <PenTool size={12} strokeWidth={ICON_STROKE} aria-hidden />
        {t('board.kind.design')} · .{node.data.format}
      </span>
      <span className={styles.open} {...INTERACTIVE} onPointerDown={stop} data-visible={view.hovered || view.selected ? '' : undefined}>
        <Button
          size="sm"
          variant="default"
          disabled={!open}
          disabledReason={open ? undefined : t('board.insert.unavailable')}
          tabIndex={view.hovered || view.selected ? 0 : -1}
          onClick={() => open?.(path)}
        >
          {t('board.node.openEditor')}
        </Button>
      </span>
    </div>
  );
}
