import { useState } from 'react';
import { Button } from '@open-design/components';
import { useT } from '../../i18n';
import type { ChatMessage } from '../../types';
import { Icon } from '../Icon';
import styles from './MessageVersions.module.css';

export interface MessageVersionActions {
  disabled: boolean;
  supports?: (messageId: string) => boolean;
  edit: (id: string, text: string) => Promise<boolean>;
  regenerate: (id: string) => Promise<boolean>;
  select: (id: string) => Promise<void>;
  editor: { messageId: string; draft: string } | null;
  setEditor: (id: string | null, draft?: string) => void;
}

export function MessageVersionNavigation({
  message, actions,
}: {
  message: ChatMessage;
  actions: MessageVersionActions;
}) {
  const t = useT();
  const ids = message.branchVersionIds;
  const index = ids?.indexOf(message.id) ?? -1;
  if (!ids || ids.length < 2 || index < 0) return null;
  const previous = ids[index - 1];
  const next = ids[index + 1];
  return (
    <span className={styles.navigation}>
      <Button size="icon" variant="ghost" disabled={actions.disabled || !previous}
        aria-label={t('chat.branchPrevious')} title={t('chat.branchPrevious')}
        onClick={() => { if (previous) void actions.select(previous); }}>
        <Icon name="chevron-left" size={16} />
      </Button>
      <span>{index + 1} / {ids.length}</span>
      <Button size="icon" variant="ghost" disabled={actions.disabled || !next}
        aria-label={t('chat.branchNext')} title={t('chat.branchNext')}
        onClick={() => { if (next) void actions.select(next); }}>
        <Icon name="chevron-right" size={16} />
      </Button>
    </span>
  );
}

export function AssistantMessageVersionActions({
  message, actions, canRegenerate,
}: {
  message: ChatMessage;
  actions: MessageVersionActions;
  canRegenerate: boolean;
}) {
  const t = useT();
  if (!canRegenerate && !message.branchVersionIds?.length) return null;
  return (
    <div className={styles.assistantActions} data-testid="assistant-message-versions">
      <MessageVersionNavigation message={message} actions={actions} />
      {canRegenerate ? (
        <Button size="icon" variant="ghost" disabled={actions.disabled}
          aria-label={t('chat.branchRegenerate')} title={t('chat.branchRegenerate')}
          onClick={() => void actions.regenerate(message.id)}>
          <Icon name="refresh" size={16} />
        </Button>
      ) : null}
    </div>
  );
}

export function EditSentMessage({
  message, actions, draft,
}: {
  message: ChatMessage;
  actions: MessageVersionActions;
  draft: string;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const text = draft.trim();
  const canSend = !submitting && !actions.disabled && text !== message.content.trim()
    && Boolean(text || message.attachments?.length || message.commentAttachments?.length);
  return (
    <form className={styles.editor} onSubmit={event => {
      event.preventDefault();
      if (!canSend) return;
      setSubmitting(true);
      void actions.edit(message.id, text).finally(() => setSubmitting(false));
    }}>
      <textarea aria-label={t('common.edit')} rows={4} autoFocus value={draft}
        onChange={event => actions.setEditor(message.id, event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape' && !submitting) {
            event.stopPropagation();
            actions.setEditor(null);
          }
        }}
      />
      <div className={styles.editorActions}>
        <Button size="sm" variant="ghost" onClick={() => actions.setEditor(null)} disabled={submitting}>{t('common.cancel')}</Button>
        <Button size="sm" variant="primary" type="submit" disabled={!canSend}>{t('chat.send')}</Button>
      </div>
    </form>
  );
}
