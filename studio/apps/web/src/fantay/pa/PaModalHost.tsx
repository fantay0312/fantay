// SPDX-License-Identifier: AGPL-3.0-only
// Renders the one management / detail modal of `ui.modal` (spec §19.3). After `closeModal()` the last modal stays
// mounted with `open={false}` for 160 ms so its exit plays; a new modal replaces it at once.
import { useEffect, useState } from 'react';

import { usePa } from './pa-context';
import type { PaModalState } from './pa-types';
import { PaAgentModal } from './PaAgentModal';
import { PaAmendModal } from './PaAmendModal';
import { PaChannelModal } from './PaChannelModal';
import { PaGroupModal } from './PaGroupModal';
import { PaLimitsModal } from './PaLimitsModal';
import { PaMemoryModal } from './PaMemoryModal';
import { PaReconcileModal } from './PaReconcileModal';
import { PaTaskModal } from './PaTaskModal';

const EXIT_MS = 160;

/** A key per modal target, so each opened target starts with fresh form state. */
function modalKey(modal: PaModalState): string {
  switch (modal.kind) {
    case 'agent':
      return `agent:${modal.agentId ?? 'new'}`;
    case 'group':
      return `group:${modal.groupId ?? 'new'}`;
    case 'memory':
      return `memory:${modal.memoryId ?? 'new'}:${modal.preset?.scope ?? ''}:${modal.preset?.scopeId ?? ''}`;
    case 'amend':
      return `amend:${modal.taskId}`;
    case 'task':
      return `task:${modal.taskId}`;
    case 'reconcile':
      return `reconcile:${modal.taskId}`;
    case 'limits':
      return 'limits';
    case 'channel':
      return `channel:${modal.channelId ?? 'new'}`;
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
      return <PaAgentModal key={key} open={open} onClose={onClose} agentId={shown.agentId} />;
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
      return <PaChannelModal key={key} open={open} onClose={onClose} channelId={shown.channelId} />;
  }
}
