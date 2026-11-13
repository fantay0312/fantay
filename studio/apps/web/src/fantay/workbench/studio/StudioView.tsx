/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — 成稿工作区. Opens over the page area for one item: on the left the conversation focused
 * on that item (its idea card on top), on the right the production sheet. Stays mounted while closed
 * so the exit plays; WorkbenchView keeps the last item for that moment.
 * Derived from dsh-media-desk client/studio.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, MessageSquare, PanelLeftClose } from 'lucide-react';
import type { WorkbenchAssetTarget, WorkbenchPage } from '@open-design/contracts';

import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import { useChatActions } from '../assistant/AssistantPanel';
import { ChatThread, type ChatQuote } from '../assistant/ChatThread';
import { useL } from '../lang';
import { useWorkbenchShell } from '../shell/context';
import { useWorkbench } from '../store';
import { IdeaCard } from './IdeaCard';
import { productionAssets, isBusy, useProductionWatch } from './production';
import { Sheet } from './Sheet';
import styles from './Studio.module.css';
import { AgainDialog, AssetViewer, FocusReader } from './Viewers';

const PAGE_NAME: Record<WorkbenchPage, [string, string]> = {
  inspiration: ['灵感', 'Ideas'],
  content: ['内容', 'Content'],
  schedule: ['排期', 'Schedule'],
  insights: ['复盘', 'Insights'],
  style: ['风格', 'Style'],
};

const DONE_SUGGESTIONS: Array<[string, string]> = [
  ['标题再短一点', 'Make the title shorter'],
  ['语气轻松一点', 'Lighter tone'],
  ['开场再抓人一点', 'A stronger opening'],
  ['封面大字更有冲击力', 'Punchier cover words'],
];

export interface StudioViewProps {
  /** The item on stage (kept briefly after closing so the exit can play). */
  itemId: string | null;
  open: boolean;
}

export function StudioView({ itemId, open }: StudioViewProps) {
  const L = useL();
  const shell = useWorkbenchShell();
  const snapshot = useWorkbench();
  const runActions = useChatActions();
  const item = itemId ? snapshot.state?.items.find(row => row.id === itemId) ?? null : null;
  const production = item?.production;
  const running = production?.status === 'running';
  const watching = Boolean(open && item && (running || productionAssets(production).some(isBusy)));
  const live = useProductionWatch(open && item ? item.id : null, watching);
  const [quote, setQuote] = useState<ChatQuote | null>(null);
  const [viewing, setViewing] = useState<WorkbenchAssetTarget | null>(null);
  const [reading, setReading] = useState(false);
  const [again, setAgain] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuote(null);
    setViewing(null);
    setReading(false);
    setAgain(false);
    setChatOpen(false);
  }, [itemId]);

  // The open item was deleted or undone away: go back to the page instead of a blank sheet.
  const missing = open && Boolean(itemId) && snapshot.status === 'ready' && Boolean(snapshot.state) && !item;
  useEffect(() => {
    if (missing) shell.closeItem();
  }, [missing, shell]);

  // Esc closes the studio unless a dialog, a field or a selection owns the key.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      if (document.querySelector('[data-slot="modal"], [data-slot="confirm-dialog"], [role="listbox"], [role="menu"]')) return;
      shell.closeItem();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, shell]);

  const ask = (next: ChatQuote) => {
    setQuote(next);
    setChatOpen(true);
  };
  const [backZh, backEn] = PAGE_NAME[shell.page];

  return (
    <div
      ref={rootRef}
      className={styles.studio}
      data-state={open ? 'open' : 'closed'}
      data-chat={chatOpen ? 'open' : 'closed'}
      role="region"
      aria-label={L('成稿工作区', 'Production studio')}
      aria-hidden={open ? undefined : true}
    >
      {item ? (
        <>
          <div className={styles.chatCol}>
            <ChatThread
              key={item.id}
              itemId={item.id}
              className={styles.studioThread}
              head={(
                <>
                  <IconButton size="sm" aria-label={L(`返回${backZh}`, `Back to ${backEn}`)} onClick={shell.closeItem} shortcut="esc">
                    <Icon icon={ChevronLeft} />
                  </IconButton>
                  <h2 className={styles.chatTitle}>{L('成稿', 'Studio')}</h2>
                  <span className={styles.grow} />
                  <IconButton size="sm" className={styles.chatCollapse} aria-label={L('收起对话', 'Hide conversation')} onClick={() => setChatOpen(false)}>
                    <Icon icon={PanelLeftClose} />
                  </IconButton>
                </>
              )}
              top={<IdeaCard item={item} live={live} settings={shell.settings} />}
              suggestions={production?.status === 'done' ? DONE_SUGGESTIONS.map(([zh, en]) => L(zh, en)) : []}
              placeholder={
                running
                  ? L('正在成稿，马上就好', 'Producing, almost there')
                  : production?.status === 'done'
                    ? L('想怎么改，直接说', 'Say what to change')
                    : L('补充点想法，或者直接说要什么', 'Add a thought, or say what you want')
              }
              disabled={running}
              quote={quote}
              onClearQuote={() => setQuote(null)}
              onActions={runActions}
              onOpenItem={shell.openItem}
            />
          </div>
          <IconButton
            variant="primary"
            shape="round"
            size="lg"
            className={styles.chatToggle}
            aria-label={chatOpen ? L('收起对话', 'Hide conversation') : L('打开对话', 'Open conversation')}
            aria-expanded={chatOpen}
            onClick={() => setChatOpen(value => !value)}
          >
            <Icon icon={MessageSquare} size={16} />
          </IconButton>
          <div className={cn(styles.sheet)}>
            <Sheet
              key={item.id}
              item={item}
              live={live}
              onAsk={ask}
              onView={setViewing}
              onRead={() => setReading(true)}
              onAgain={() => setAgain(true)}
            />
          </div>
        </>
      ) : null}
      <AssetViewer item={item} target={viewing} onChange={setViewing} onClose={() => setViewing(null)} onAsk={ask} />
      <FocusReader item={item} open={reading} onClose={() => setReading(false)} />
      <AgainDialog item={item} open={again} onClose={() => setAgain(false)} />
    </div>
  );
}
