/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — the desk-wide assistant beside every page: one sentence edits ideas, schedule, styles
 * and rules through the same whitelisted ops, answers questions about the library with citations, and
 * can start 一键成稿. Each change is undoable.
 * Derived from dsh-media-desk client/chat.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useState } from 'react';
import { Eraser, PanelRightClose } from 'lucide-react';
import type { WorkbenchChatAction } from '@open-design/contracts';

import { Button } from '../../ui/button';
import { Callout } from '../../ui/callout';
import { cn } from '../../ui/cn';
import { ConfirmDialog } from '../../ui/dialog';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import { Tooltip } from '../../ui/tooltip';
import { workbenchApi } from '../api';
import { useL } from '../lang';
import { useWorkbenchShell } from '../shell/context';
import { reportError, useWorkbench, workbench } from '../store';
import styles from './AssistantPanel.module.css';
import { ChatThread, type ChatDraft } from './ChatThread';

const SUGGESTIONS: Array<[string, string]> = [
  ['把今天最好的灵感一键成稿', 'Produce the best idea from today'],
  ['接下来有什么排期？', 'What is scheduled next?'],
  ['以后标题都不要超过 20 个字', 'From now on keep titles under 20 characters'],
  ['我的灵感库里关于 agent 的都有哪些？', 'What is in my library about agents?'],
];

/** Run what an answer asked the desk to do: start a production, open an item, switch page. */
export function useChatActions(): (actions: WorkbenchChatAction[]) => void {
  const shell = useWorkbenchShell();
  return (actions) => {
    for (const action of actions) {
      if (action.type === 'produce') shell.produce(action.id);
      else if (action.type === 'open') shell.openItem(action.id);
      else if (action.type === 'nav') shell.navigate(action.page);
    }
  };
}

export interface AssistantPanelProps {
  draft: ChatDraft | null;
  onClose(): void;
}

export function AssistantPanel({ draft, onClose }: AssistantPanelProps) {
  const L = useL();
  const shell = useWorkbenchShell();
  const snapshot = useWorkbench();
  const runActions = useChatActions();
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const hasChat = Boolean(snapshot.state?.chat.some(message => !message.itemId));
  const { model, modelOk, modelError, signedIn } = snapshot;

  const tone = !model ? 'none' : modelOk === false ? 'down' : 'live';
  const modelLabel = !signedIn
    ? L('未登录', 'Signed out')
    : !model
      ? L('本地规则', 'Local rules')
      : modelOk === false
        ? L('模型调用失败', 'Model failed')
        : model;
  const modelHint = !signedIn
    ? L('登录 TokenToSea 后，助手使用你账户里的文字模型', 'Sign in to TokenToSea so the assistant can use your text model')
    : !model
      ? L('当前没有可用模型，只能处理常见说法。点按选择模型', 'No model is available; only common phrases work. Click to pick a model')
      : modelOk === false
        ? L(`${model} 调用失败，现在只能处理常见说法`, `${model} failed; only common phrases work for now`)
        : L(`正在使用 TokenToSea 模型 ${model}，点按更换`, `Using TokenToSea model ${model}. Click to change`);

  const clear = async () => {
    setClearing(true);
    try {
      const response = await workbenchApi.clearChat();
      workbench.setState(response.state);
      setConfirmClear(false);
    } catch (error) {
      reportError(error, L('清空失败', 'Could not clear'));
    } finally {
      setClearing(false);
    }
  };

  return (
    <aside className={styles.panel} aria-label={L('工作台助手', 'Workbench assistant')}>
      <ChatThread
        head={(
          <>
            <h2 className={styles.title}>{L('助手', 'Assistant')}</h2>
            <Tooltip label={modelHint}>
              <Button variant="bare" size="sm" className={cn(styles.model)} data-tone={tone} onClick={shell.openSettings}>
                <i className={styles.modelDot} aria-hidden />
                <span className={styles.modelLabel}>{modelLabel}</span>
              </Button>
            </Tooltip>
            <span className={styles.grow} />
            {hasChat ? (
              <IconButton size="sm" aria-label={L('清空对话', 'Clear conversation')} onClick={() => setConfirmClear(true)}>
                <Icon icon={Eraser} />
              </IconButton>
            ) : null}
            <IconButton size="sm" aria-label={L('收起助手', 'Hide assistant')} onClick={onClose}>
              <Icon icon={PanelRightClose} />
            </IconButton>
          </>
        )}
        top={model && modelOk === false && modelError ? (
          <Callout tone="error" className={styles.alert}>
            <strong className={styles.alertTitle}>{L(`模型 ${model} 调用失败`, `Model ${model} failed`)}</strong>
            <span className={styles.alertBody}>{modelError.length > 280 ? `${modelError.slice(0, 280)}…` : modelError}</span>
          </Callout>
        ) : null}
        intro={(
          <div className={styles.intro}>
            <h3 className={styles.introTitle}>
              {L('说一句话，', 'Say one sentence,')}
              <br />
              {L('剩下的我来补全。', 'I will fill in the rest.')}
            </h3>
            <p className={styles.introCopy}>
              {L(
                '选题、灵感、内容、排期、风格和写作规则，都可以直接说；也可以问灵感库里有什么。每一步都能撤销。',
                'Ideas, content, schedule, styles and writing rules: just say it, or ask what your library holds. Every step can be undone.',
              )}
            </p>
            {!signedIn ? (
              <p className={styles.introNote}>
                {L('还没登录 TokenToSea：现在只能处理常见说法。', 'Not signed in to TokenToSea: only common phrases work for now.')}
                <Button variant="link" size="sm" className={styles.inlineLink} onClick={shell.signIn} disabled={shell.signingIn}>
                  {shell.signingIn ? L('等待授权…', 'Waiting…') : L('登录', 'Sign in')}
                </Button>
              </p>
            ) : null}
          </div>
        )}
        suggestions={SUGGESTIONS.map(([zh, en]) => L(zh, en))}
        placeholder={L('想改什么，直接说', 'Say what to change')}
        draft={draft}
        onActions={runActions}
        onOpenItem={shell.openItem}
      />
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={L('清空和助手的对话？', 'Clear the assistant conversation?')}
        description={L('只清空这里的对话记录，灵感和成稿不受影响。', 'Only this conversation is cleared; ideas and productions stay.')}
        confirmLabel={L('清空对话', 'Clear')}
        cancelLabel={L('取消', 'Cancel')}
        destructive
        busy={clearing}
        onConfirm={() => { void clear(); }}
      />
    </aside>
  );
}
