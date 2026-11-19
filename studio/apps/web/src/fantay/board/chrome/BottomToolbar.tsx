'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/Stage.tsx (tool rail markup and drawing hint L955-1012) @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the board's bottom toolbar (spec 03 §6.1):
 *   one sliding highlight under the active tool, 32 px tool buttons (amendment B4) with aria-pressed, labelled
 *   tooltips with key caps, Upload image, the Insert "+" menu, a hint bubble while a draw/place tool is armed,
 *   Select and Hand only on read-only boards, Generate disabled with a reason without the generation extension;
 *   the Comment tool (C) with its own hint bar (`../comments/BoardCommentLayer.tsx`).
 */
import { useT } from '../../../i18n';
import { BoardCommentHintBar } from '../comments/BoardCommentLayer';
import { Toolbar, ToolbarHighlight, ToolbarSeparator } from '../../ui/toolbar';
import { useBoardEngine, useBoardHost, useBoardSelector } from '../context';
import { UPLOAD_IMAGE_ACCEPT } from '../interaction/drop';
import { BOARD_TOOLS, isDrawTool, isPlaceTool } from '../interaction/tools';
import type { BoardTool, DictKey } from '../model/types';
import { BOARD_CHROME_ISLAND_ATTR } from '../nodes/frame/FrameNode';
import { useChromeActions } from './chrome-context';
import { CHROME_ICON_STROKE, ICONS, TOOL_ICONS } from './icons';
import { InsertMenu } from './InsertMenu';
import { ToolButton } from './ToolButton';
import styles from './chrome.module.css';

const ISLAND = { [BOARD_CHROME_ISLAND_ATTR]: '' } as const;
const DRAW_GROUP: readonly BoardTool[] = ['pen', 'frame', 'rectangle', 'ellipse', 'text'];

export function toolHintKey(tool: BoardTool): DictKey | null {
  if (tool === 'frame') return 'board.tool.frameHint';
  if (isDrawTool(tool)) return 'board.tool.hintDraw';
  if (isPlaceTool(tool)) return 'board.tool.hintPlace';
  return null;
}

export interface BottomToolbarProps {
  readOnly: boolean;
}

export function BottomToolbar({ readOnly }: BottomToolbarProps) {
  const engine = useBoardEngine();
  const { extensions } = useBoardHost();
  const actions = useChromeActions();
  const t = useT();
  const tool = useBoardSelector((state) => state.ui.tool);
  const hint = toolHintKey(tool);
  const generateUnavailable = !extensions?.createGenerator;

  const toolButton = (id: BoardTool) => {
    const entry = BOARD_TOOLS.find((candidate) => candidate.id === id);
    if (!entry) return null;
    const Glyph = TOOL_ICONS[id];
    const unavailable = id === 'generate' && generateUnavailable;
    return (
      <ToolButton
        key={id}
        data-testid={`board-tool-${id}`}
        label={t(entry.labelKey)}
        shortcut={entry.key.toLowerCase()}
        pressed={tool === id}
        {...(unavailable ? { disabledReason: t('board.insert.unavailable') } : {})}
        onClick={() => engine.commands.setTool(id)}
      >
        <Glyph strokeWidth={CHROME_ICON_STROKE} />
      </ToolButton>
    );
  };

  return (
    <div className={styles.toolbarDock} {...ISLAND} data-testid="board-toolbar-dock">
      <div className={styles.hint} data-state={hint ? 'open' : 'closed'} aria-hidden={hint ? undefined : true} data-testid="board-tool-hint">
        {hint ? t(hint) : null}
      </div>
      {readOnly ? null : <BoardCommentHintBar />}
      <Toolbar aria-label={t('board.toolbar.label')} data-testid="board-toolbar">
        <ToolbarHighlight activeKey={tool} />
        {toolButton('select')}
        {toolButton('hand')}
        {readOnly ? null : (
          <>
            <ToolbarSeparator />
            {DRAW_GROUP.map(toolButton)}
            <ToolbarSeparator />
            <ToolButton data-testid="board-tool-image" label={t('board.tool.image')} onClick={() => actions.openUpload(UPLOAD_IMAGE_ACCEPT)}>
              <ICONS.upload strokeWidth={CHROME_ICON_STROKE} />
            </ToolButton>
            {toolButton('generate')}
            {toolButton('note')}
            {toolButton('comment')}
            <ToolbarSeparator />
            <InsertMenu />
          </>
        )}
      </Toolbar>
    </div>
  );
}
