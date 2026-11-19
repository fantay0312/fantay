// SPDX-License-Identifier: AGPL-3.0-only
// 聊天外观 (modal kind `appearance`, Soul UI spec 7.6): the scope switch 只这个对话 / 和 TA 的所有对话 over the appearance
// picker and its live preview. Each scope edits its own layer; 应用 writes the chosen one. Writing the character's
// layer also clears this chat's own layer, so the choice shows here at once. The open chat changes only on 应用.
// The 立绘 switch is offered in a direct chat whose character has sprites; otherwise it is disabled and says why.
import { useMemo, useState } from 'react';
import type { PaChatAppearance } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import { Button, ModalSpacer, Segmented, SegmentedItem, toast } from '../../ui';
import { paSoulAssetUrl } from '../pa-api';
import { usePa } from '../pa-context';
import { conversationKind } from '../pa-model';
import { PaModalFrame, usePaModalReset, usePaSubmit } from '../PaAgentModal';
import modalStyles from '../PaModals.module.css';
import { characterOf, chatOf, displayName } from './soul-model';
import { SoulAppearancePicker } from './SoulAppearancePicker';
import { SoulDiscardDialog, sameJson, useSoulArrival, useSoulDiscard } from './SoulProfileModal';

export interface SoulAppearanceModalProps {
  open: boolean;
  onClose(): void;
  conversationId: string;
}

type Scope = 'chat' | 'character';

export function SoulAppearanceModal({ open, onClose, conversationId }: SoulAppearanceModalProps) {
  const t = useT();
  const { data, index, nav } = usePa();
  const conversation = index.conversations.get(conversationId) ?? null;
  const direct = conversation ? conversationKind(conversation) === 'direct' : false;
  const agentId = direct ? (conversation?.agentId ?? null) : null;
  const character = characterOf(index, agentId);
  const chat = chatOf(index, conversationId);
  // The character scope exists only for a direct chat with a character; a group chat edits its own layer.
  const canCharacter = Boolean(agentId && character);
  const name = agentId ? displayName(index, agentId) : '';
  const hasSprites = Object.keys(character?.sprites ?? {}).length > 0;

  // Enterprise mode: the character's own look is part of the shared library; a member styles only their chat.
  const canEditCharacter = canCharacter && index.canManageLibrary;
  const initialScope = (): Scope => (!canEditCharacter || Object.keys(chat.appearance).length > 0 ? 'chat' : 'character');
  const [scope, setScope] = useState<Scope>(initialScope);
  const [saved, setSaved] = useState(() => ({ chat: chat.appearance, character: character?.appearance ?? {} }));
  const [chatLayer, setChatLayer] = useState<PaChatAppearance>(saved.chat);
  const [characterLayer, setCharacterLayer] = useState<PaChatAppearance>(saved.character);
  const submit = usePaSubmit();
  const resetForm = () => {
    const next = { chat: chat.appearance, character: character?.appearance ?? {} };
    setSaved(next);
    setChatLayer(next.chat);
    setCharacterLayer(next.character);
    setScope(initialScope());
    submit.clear();
  };
  usePaModalReset(open, conversationId, resetForm);
  useSoulArrival(data.snapshot !== null && data.soul !== null, resetForm);

  const dirty = useMemo(
    () => !sameJson(chatLayer, saved.chat) || !sameJson(characterLayer, saved.character),
    [chatLayer, characterLayer, saved],
  );
  const close = useSoulDiscard(dirty, onClose);
  const editing = scope === 'chat' ? chatLayer : characterLayer;
  const setEditing = scope === 'chat' ? setChatLayer : setCharacterLayer;
  // Editing this chat shows it over the character's saved layer: only the chat layer is written in this scope.
  const base = scope === 'chat' && canCharacter ? saved.character : null;

  const apply = () => {
    if (submit.busy) return;
    void submit
      .run(async () => {
        if (scope === 'character' && agentId) {
          await data.actions.saveCharacter(agentId, { appearance: characterLayer });
          if (Object.keys(chatOf(index, conversationId).appearance).length > 0) await data.actions.saveChat(conversationId, { appearance: {} });
        } else {
          await data.actions.saveChat(conversationId, { appearance: chatLayer });
        }
      })
      .then((ok) => {
        if (!ok) return;
        toast({ tone: 'success', title: t('pa.soul.manage.look.applied') });
        onClose();
      });
  };

  return (
    <PaModalFrame
      open={open}
      onClose={() => close.guard()}
      size="lg"
      title={t('pa.soul.manage.look.title')}
      conflict={submit.conflict}
      error={submit.error}
      testId="pa-appearance-modal"
      bodyClassName={modalStyles.bodyStack}
      footer={
        <>
          <Button variant="ghost" onClick={() => setEditing({})} data-testid="pa-appearance-reset">
            {t('pa.soul.manage.look.reset')}
          </Button>
          <ModalSpacer />
          <Button variant="ghost" onClick={() => close.guard()}>
            {t('pa.cancel')}
          </Button>
          <Button variant="primary" loading={submit.busy} onClick={apply} data-testid="pa-appearance-apply">
            {t('pa.soul.manage.look.apply')}
          </Button>
        </>
      }
    >
      {canEditCharacter ? (
        <Segmented
          size="md"
          className="flex w-full"
          aria-label={t('pa.soul.manage.look.scope')}
          value={scope}
          onValueChange={(next) => setScope(next as Scope)}
          data-testid="pa-appearance-scope"
        >
          <SegmentedItem value="chat" className="min-w-0 flex-1">
            {t('pa.soul.manage.look.scopeChat')}
          </SegmentedItem>
          <SegmentedItem value="character" className="min-w-0 flex-1">
            {t('pa.soul.manage.look.scopeCharacter', { name })}
          </SegmentedItem>
        </Segmented>
      ) : !direct ? (
        <p className={modalStyles.optionHelp}>{t('pa.soul.manage.look.scopeRoom')}</p>
      ) : null}

      <SoulAppearancePicker
        value={editing}
        base={base}
        onChange={setEditing}
        portrait={{ src: paSoulAssetUrl(character?.portraitAssetId), name: name || (conversation?.title ?? '') }}
        stage={{
          available: direct && hasSprites,
          reason: direct ? 'no-sprites' : 'room',
          ...(direct && agentId
            ? { onAdd: () => close.guard(() => nav.openModal({ kind: 'agent', agentId, section: 'sprites' })) }
            : {}),
        }}
      />

      <SoulDiscardDialog unit="manage" {...close.dialog} />
    </PaModalFrame>
  );
}
