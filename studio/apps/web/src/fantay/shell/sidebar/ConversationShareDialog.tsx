// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import type { Conversation } from '../../../types';
import { useT } from '../../../i18n';
import { TokenToSeaSharePanel } from '../../../components/share/TokenToSeaSharePanel';
import { writeProjectTextFileDetailed } from '../../../providers/registry';
import { currentWorkspaceAccountGeneration } from '../../../collab/workspace-identity';
import { Button } from '../../ui/button';
import { Modal, ModalTitle, ModalLede, ModalActions } from '../../ui/dialog';
import { conversationShareHtml, conversationText } from './conversation-actions';

export function ConversationShareDialog({
  conversation,
  context,
  onClose,
}: {
  conversation: Conversation;
  context: WorkspaceCollabContext | null;
  onClose(): void;
}) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const title = conversation.title?.trim() || t('chat.untitledConversation');
  useEffect(() => {
    setText(null);
    setFile(null);
    setError('');
    const controller = new AbortController();
    void conversationText(
      conversation,
      context,
      { user: t('chat.you'), assistant: 'Fantay', designSystem: t('chat.designSystemStatus.title') },
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setText(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t('ds.actionFailed'));
      });
    return () => controller.abort();
  }, [conversation.id, conversation.projectId, context, t]);
  const prepare = async () => {
    if (text === null || busy) return;
    const generation = currentWorkspaceAccountGeneration();
    setBusy(true);
    setError('');
    const path = `conversation-shares/${conversation.id}.html`;
    const result = await writeProjectTextFileDetailed(
      conversation.projectId,
      path,
      conversationShareHtml(title, text),
      undefined,
      context,
    );
    setBusy(false);
    if (generation !== currentWorkspaceAccountGeneration()) return;
    if (result.ok) setFile(path);
    else setError(result.message);
  };
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      size="lg"
    >
      <ModalTitle>{t('fantayShell.sidebar.shareConversation')}</ModalTitle>
      <ModalLede>{title}</ModalLede>
      <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-row bg-paper p-3 font-ui text-copy">
        {text ?? t('common.loading')}
      </pre>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
      {file ? (
        <TokenToSeaSharePanel projectId={conversation.projectId} fileName={file} />
      ) : (
        <>
          <p className="text-copy text-ink-soft">{t('fantayShell.sidebar.sharePreview')}</p>
          <ModalActions>
            <Button disabled={text === null || !text.trim()} loading={busy} onClick={() => void prepare()}>
              {t('fantayShell.sidebar.prepareShare')}
            </Button>
          </ModalActions>
        </>
      )}
    </Modal>
  );
}
