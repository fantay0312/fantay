/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — the workbench's own top row: title, the pages as one inline tab strip on the
 * hairline, and the desk actions (示例数据 · 清空, 撤销, ⚡ 快速记录, ✨ 助手, ⚙ 设置).
 * Derived from dsh-media-desk client/index.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { Eraser, Settings2, Sparkles, Undo2, Zap } from 'lucide-react';
import type { WorkbenchPage } from '@open-design/contracts';
import { WORKBENCH_PAGES } from '@open-design/contracts';

import { useI18n } from '../../../i18n';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import { Tooltip } from '../../ui/tooltip';
import { useL } from '../lang';
import type { WorkbenchTab } from '../types';
import styles from './Header.module.css';

const TABS = ['projects', ...WORKBENCH_PAGES] as const;

export const PAGE_LABEL: Record<WorkbenchPage, [string, string]> = {
  inspiration: ['灵感', 'Ideas'],
  content: ['内容', 'Content'],
  schedule: ['排期', 'Schedule'],
  insights: ['复盘', 'Insights'],
  style: ['风格', 'Style'],
};

export interface WorkbenchHeaderProps {
  page: WorkbenchTab;
  studioOpen: boolean;
  onPage(page: WorkbenchTab): void;
  hasSamples: boolean;
  onClearSamples(): void;
  canUndo: boolean;
  undoLabel: string | null;
  onUndo(): void;
  onCapture(): void;
  assistantOpen: boolean;
  onToggleAssistant(): void;
  onSettings(): void;
}

export function WorkbenchHeader({
  page,
  studioOpen,
  onPage,
  hasSamples,
  onClearSamples,
  canUndo,
  undoLabel,
  onUndo,
  onCapture,
  assistantOpen,
  onToggleAssistant,
  onSettings,
}: WorkbenchHeaderProps) {
  const L = useL();
  const { t } = useI18n();
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{L('工作台', 'Workbench')}</h1>
      <nav className={styles.tabs} aria-label={L('工作台页面', 'Workbench pages')}>
        {TABS.map((entry) => {
          const label = entry === 'projects' ? t('fantayShell.sidebar.allProjects') : L(...PAGE_LABEL[entry]);
          const current = entry === page;
          return (
            <Button
              variant="bare"
              key={entry}
              className={cn(styles.tab, current && styles.tabOn, current && studioOpen && styles.tabUnder)}
              aria-current={current ? 'page' : undefined}
              onClick={() => onPage(entry)}
            >
              {label}
            </Button>
          );
        })}
      </nav>
      <span className={styles.grow} />
      <div className={styles.actions} hidden={page === 'projects'}>
        {hasSamples ? (
          <Tooltip label={L('现在看到的都是示例内容，可以一键清空', 'Everything shown is sample data; clear it in one go')}>
            <Button variant="bare" size="sm" className={styles.sample} onClick={onClearSamples}>
              <Icon icon={Eraser} size={13} />
              <span className={styles.sampleText}>{L('示例数据 · 清空', 'Sample data · Clear')}</span>
            </Button>
          </Tooltip>
        ) : null}
        <IconButton
          aria-label={canUndo && undoLabel ? L(`撤销：${undoLabel}`, `Undo: ${undoLabel}`) : L('撤销', 'Undo')}
          shortcut="mod+z"
          disabled={!canUndo}
          disabledReason={!canUndo ? L('没有可以撤销的操作', 'Nothing to undo') : undefined}
          onClick={onUndo}
        >
          <Icon icon={Undo2} />
        </IconButton>
        <IconButton aria-label={L('快速记录灵感', 'Quick capture')} shortcut="mod+shift+k" onClick={onCapture}>
          <Icon icon={Zap} />
        </IconButton>
        <IconButton
          aria-label={assistantOpen ? L('收起助手', 'Hide assistant') : L('打开助手', 'Show assistant')}
          on={assistantOpen && !studioOpen}
          disabled={studioOpen}
          disabledReason={studioOpen ? L('成稿工作区里有它自己的对话', 'The studio has its own conversation') : undefined}
          onClick={onToggleAssistant}
        >
          <Icon icon={Sparkles} />
        </IconButton>
        <IconButton aria-label={L('工作台设置', 'Workbench settings')} onClick={onSettings}>
          <Icon icon={Settings2} />
        </IconButton>
      </div>
    </header>
  );
}
