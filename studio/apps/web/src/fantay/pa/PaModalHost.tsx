// SPDX-License-Identifier: AGPL-3.0-only
// Renders the one management / detail modal of `ui.modal` (spec §19.3). After `closeModal()` the last modal stays
// mounted with `open={false}` for 160 ms so its exit plays; a new modal replaces it at once.
import { useEffect, useState } from 'react';

import { usePa } from './pa-context';
import type { PaModalState } from './pa-types';
import { PaAmendModal } from './PaAmendModal';
import { PaChannelModal } from './PaChannelModal';
import { PaGroupModal } from './PaGroupModal';
import { PaLimitsModal } from './PaLimitsModal';
import { PaMemoryModal } from './PaMemoryModal';
import { PaReconcileModal } from './PaReconcileModal';
import { PaTaskModal } from './PaTaskModal';
import { SoulAppearanceModal } from './soul/SoulAppearanceModal';
import { SoulCardImportModal } from './soul/SoulCardImportModal';
import { SoulChatSettingsModal } from './soul/SoulChatSettingsModal';
import { SoulContextModal } from './soul/SoulContextModal';
import { SoulLorebookModal } from './soul/SoulLorebookModal';
import { SoulPersonaModal } from './soul/SoulPersonaModal';
import { SoulPresetModal } from './soul/SoulPresetModal';
import { SoulProfileModal } from './soul/SoulProfileModal';

const EXIT_MS = 160;

/** A key per modal target, so each opened target starts with fresh form state. */
function modalKey(modal: PaModalState): string {
  switch (modal.kind) {
    case 'agent':
      return `agent:${modal.agentId ?? 'new'}:${modal.template ?? ''}`;
    case 'group':
      return `group:${modal.groupId ?? 'new'}`;
    case 'memory':
      return `memory:${modal.memoryId ?? 'new'}:${modal.preset?.scope ?? ''}:${modal.preset?.scopeId ?? ''}:${modal.preset?.sourceMessageId ?? ''}`;
    case 'amend':
      return `amend:${modal.taskId}`;
    case 'task':
      return `task:${modal.taskId}`;
    case 'reconcile':
      return `reconcile:${modal.taskId}`;
    case 'limits':
      return 'limits';
    case 'channel':
      return modal.connectionId ? `channel-binding:${modal.connectionId}` : `channel:${modal.channelId ?? 'new'}`;
    case 'cardImport':
      return `cardImport:${modal.agentId ?? 'new'}:${modal.file ? `${modal.file.name}:${modal.file.size}:${modal.file.lastModified}` : ''}`;
    case 'lorebook':
      return `lorebook:${modal.lorebookId ?? 'new'}:${modal.entryId ?? ''}:${modal.bindAgentId ?? ''}`;
    case 'persona':
      return `persona:${modal.personaId ?? 'new'}`;
    case 'preset':
      return `preset:${modal.presetId ?? 'new'}`;
    case 'appearance':
      return `appearance:${modal.conversationId}`;
    case 'chatSettings':
      return `chatSettings:${modal.conversationId}`;
    case 'context':
      return `context:${modal.conversationId}:${modal.messageId ?? 'preview'}`;
  }
}

export function PaModalHost() {
  const { ui, nav } = usePa();
  const current = ui.modal;
  const [last, setLast] = useState<PaModalState | null>(current);
  if (current && current !== last) setLast(current);

  useEffect(() => {
    if (current || !last) return undefined;
    const timer = setTimeout(() => setLast(null), EXIT_MS);
    return () => clearTimeout(timer);
  }, [current, last]);

  const shown = current ?? last;
  if (!shown) return null;
  const open = current !== null;
  const onClose = nav.closeModal;
  const key = modalKey(shown);

  switch (shown.kind) {
    case 'task':
      return <PaTaskModal key={key} open={open} onClose={onClose} taskId={shown.taskId} output={shown.output} />;
    case 'agent':
      return (
        <SoulProfileModal
          key={key}
          open={open}
          onClose={onClose}
          agentId={shown.agentId}
          section={shown.section}
          template={shown.template}
        />
      );
    case 'group':
      return <PaGroupModal key={key} open={open} onClose={onClose} groupId={shown.groupId} />;
    case 'memory':
      return <PaMemoryModal key={key} open={open} onClose={onClose} memoryId={shown.memoryId} preset={shown.preset} />;
    case 'amend':
      return <PaAmendModal key={key} open={open} onClose={onClose} taskId={shown.taskId} />;
    case 'reconcile':
      return <PaReconcileModal key={key} open={open} onClose={onClose} taskId={shown.taskId} />;
    case 'limits':
      return <PaLimitsModal key={key} open={open} onClose={onClose} />;
    case 'channel':
      return <PaChannelModal key={key} open={open} onClose={onClose} channelId={shown.channelId} connectionId={shown.connectionId} />;
    case 'cardImport':
      return <SoulCardImportModal key={key} open={open} onClose={onClose} file={shown.file} agentId={shown.agentId} />;
    case 'lorebook':
      return (
        <SoulLorebookModal
          key={key}
          open={open}
          onClose={onClose}
          lorebookId={shown.lorebookId}
          entryId={shown.entryId}
          bindAgentId={shown.bindAgentId}
        />
      );
    case 'persona':
      return <SoulPersonaModal key={key} open={open} onClose={onClose} personaId={shown.personaId} />;
    case 'preset':
      return <SoulPresetModal key={key} open={open} onClose={onClose} presetId={shown.presetId} />;
    case 'appearance':
      return <SoulAppearanceModal key={key} open={open} onClose={onClose} conversationId={shown.conversationId} />;
    case 'chatSettings':
      return <SoulChatSettingsModal key={key} open={open} onClose={onClose} conversationId={shown.conversationId} />;
    case 'context':
      return <SoulContextModal key={key} open={open} onClose={onClose} conversationId={shown.conversationId} messageId={shown.messageId} />;
  }
}
