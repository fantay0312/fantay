// SPDX-License-Identifier: AGPL-3.0-only
// 对话设置 (modal kind `chatSettings`, Soul UI spec 7.7): the single home of per-chat settings — the mode switch, who you
// are and the style, this chat's scene and note, extra world books, history and the turn record, and 谁来接话 in a
// group chat, and 先开口 in a direct companion chat (W6). Headings over hairline groups; every option row is a
// full-width equal Segmented. 保存 sends only the changed keys, then the one `/routines` write 先开口 needs.
// 语音回复 (stage 2, companion mode only): 关 / 点了才读 / 自动朗读; without a speech service the two that would make
// audio are disabled and a line says why, with the way to Settings.
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { PaRoutine, PaRoutineInput } from '@open-design/contracts';
import { SOUL_LIMITS } from '@open-design/contracts/soul';
import type { PaChatSettingsPatch } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import {
  Button,
  IconButton,
  Input,
  ModalSpacer,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  XIcon,
  toast,
} from '../../ui';
import { usePa } from '../pa-context';
import { conversationKind, conversationTitle, isFantay } from '../pa-model';
import { PaModalFrame, PaSwitchRow, usePaModalReset, usePaSubmit } from '../PaAgentModal';
import { routineTarget } from '../PaActivityPage';
import { usePaTransport } from '../pa-transport';
import type { PaChatView, PaIndex } from '../pa-types';
import modalStyles from '../PaModals.module.css';
import { runFantayCommand } from '../../shell/commands';
import { characterOf, chatOf, conversationMode, displayName } from './soul-model';
import { useSoulSpeechStatus } from './soul-voice';
import { SOUL_NONE, SoulDiscardDialog, SoulField, sameJson, useSoulArrival, useSoulDiscard } from './SoulProfileModal';
import { SoulStepper, SoulTag } from './SoulPrimitives';

const L = SOUL_LIMITS;
const HISTORY = ['short', 'medium', 'long', 'max'] as const;
const STRATEGIES = ['natural', 'list', 'manual'] as const;
const VOICE = ['off', 'manual', 'auto'] as const;

export interface SoulChatSettingsModalProps {
  open: boolean;
  onClose(): void;
  conversationId: string;
}

interface ChatForm {
  mode: 'work' | 'companion';
  personaId: string | null;
  presetId: string | null;
  scenario: string;
  noteText: string;
  noteDepth: number;
  lorebookIds: string[];
  disabledLoreEntryIds: string[];
  historyBudget: PaChatView['historyBudget'];
  turnRecord: PaChatView['turnRecord'];
  groupStrategy: PaChatView['groupStrategy'];
  /** 语音回复 (stage 2). Optional so a form built before stage 2 still reads as "unchanged". */
  voiceReplies?: PaChatView['voiceReplies'];
}

function chatForm(chat: PaChatView, mode: 'work' | 'companion'): ChatForm {
  return {
    mode,
    personaId: chat.personaId,
    presetId: chat.presetId,
    scenario: chat.scenario,
    noteText: chat.authorNote?.text ?? '',
    noteDepth: chat.authorNote?.depth ?? 4,
    lorebookIds: [...chat.lorebookIds],
    disabledLoreEntryIds: [...chat.disabledLoreEntryIds],
    historyBudget: chat.historyBudget,
    turnRecord: chat.turnRecord,
    groupStrategy: chat.groupStrategy,
    voiceReplies: chat.voiceReplies ?? 'manual',
  };
}

function noteOf(form: ChatForm): PaChatView['authorNote'] {
  return form.noteText.trim() ? { text: form.noteText, depth: form.noteDepth } : null;
}

/** Only the keys that differ from the stored chat view; `mode` only when it differs from the resolved mode. */
export function chatSettingsPatch(form: ChatForm, chat: PaChatView, resolvedMode: 'work' | 'companion', room: boolean): PaChatSettingsPatch {
  const patch: PaChatSettingsPatch = {};
  if (form.mode !== resolvedMode) patch.mode = form.mode;
  if (form.personaId !== chat.personaId) patch.personaId = form.personaId;
  if (!room && form.presetId !== chat.presetId) patch.presetId = form.presetId;
  if (form.scenario !== chat.scenario) patch.scenario = form.scenario;
  const note = noteOf(form);
  if (!sameJson(note, chat.authorNote)) patch.authorNote = note;
  if (!sameJson(form.lorebookIds, chat.lorebookIds)) patch.lorebookIds = form.lorebookIds;
  if (!sameJson(form.disabledLoreEntryIds, chat.disabledLoreEntryIds)) patch.disabledLoreEntryIds = form.disabledLoreEntryIds;
  if (form.historyBudget !== chat.historyBudget) patch.historyBudget = form.historyBudget;
  if (form.turnRecord !== chat.turnRecord) patch.turnRecord = form.turnRecord;
  if (room && form.groupStrategy !== chat.groupStrategy) patch.groupStrategy = form.groupStrategy;
  if (form.voiceReplies !== undefined && form.voiceReplies !== (chat.voiceReplies ?? 'manual')) patch.voiceReplies = form.voiceReplies;
  return patch;
}

/* ── 先开口 (W6): one routine with `soul: { kind: 'reachout' }` per direct companion chat ─────────────────────────── */

export interface ReachForm {
  on: boolean;
  time: string;
  note: string;
}

const REACH_TIME = '20:00';
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** The routine prompt when the note is left empty (a routine needs one); it reads back as an empty note. */
export const REACHOUT_PROMPT = '先开口';

/** The chat's 先开口 routine, if it has one. */
export function reachoutRoutine(routines: readonly PaRoutine[] | undefined, conversationId: string): PaRoutine | null {
  return routines?.find((routine) => routine.soul?.kind === 'reachout' && routine.conversationId === conversationId) ?? null;
}

export function reachForm(routine: PaRoutine | null): ReachForm {
  if (!routine) return { on: false, time: REACH_TIME, note: '' };
  return { on: routine.enabled, time: routine.time, note: routine.prompt === REACHOUT_PROMPT ? '' : routine.prompt };
}

/** The daemon's quiet time (`reachoutBlocked`: 23:00–8:00 local): a 先开口 set inside it would always be skipped. */
export function reachQuiet(time: string): boolean {
  const hour = Number(time.slice(0, 2));
  return hour >= 23 || hour < 8;
}

export interface ReachWrite {
  path: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  body: PaRoutineInput | (PaRoutineInput & { revision: number }) | { revision: number };
}

/** The one `/routines` write the section needs, or null when nothing changed: create when switched on, update the
 *  time or the note, remove when switched off. `routine` is the live one, so its revision is current. */
export function reachoutWrite(
  form: ReachForm,
  routine: PaRoutine | null,
  target: { conversationId: string; name: string; timezone: string },
): ReachWrite | null {
  const prompt = form.note.trim() || REACHOUT_PROMPT;
  const soul = { kind: 'reachout' } as const;
  if (!routine) {
    if (!form.on) return null;
    const body: PaRoutineInput = { name: target.name, prompt, conversationId: target.conversationId, time: form.time, timezone: target.timezone, enabled: true, soul };
    return { path: '/routines', method: 'POST', body };
  }
  if (!form.on) return routine.enabled ? { path: `/routines/${routine.id}`, method: 'DELETE', body: { revision: routine.revision } } : null;
  if (routine.enabled && routine.time === form.time && routine.prompt === prompt) return null;
  const body: PaRoutineInput & { revision: number } = {
    name: routine.name,
    prompt,
    conversationId: routine.conversationId,
    time: form.time,
    timezone: routine.timezone,
    enabled: true,
    soul,
    revision: routine.revision,
  };
  return { path: `/routines/${routine.id}`, method: 'PATCH', body };
}

/** The world books the chat's characters bring (the direct character's, or every member's in a group chat). */
function ownBooks(index: PaIndex, agentIds: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const agentId of agentIds) for (const bookId of characterOf(index, agentId)?.lorebookIds ?? []) ids.add(bookId);
  return [...ids];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={modalStyles.section}>
      <h3 className={modalStyles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

export function SoulChatSettingsModal({ open, onClose, conversationId }: SoulChatSettingsModalProps) {
  const t = useT();
  const { data, index, nav } = usePa();
  const speechStatus = useSoulSpeechStatus();
  const conversation = index.conversations.get(conversationId) ?? null;
  const kind = conversation ? conversationKind(conversation) : 'direct';
  const room = kind === 'group';
  const group = conversation ? (index.groupByConversation.get(conversation.id) ?? (conversation.groupId ? index.groups.get(conversation.groupId) : undefined)) : undefined;
  const agentId = !room ? (conversation?.agentId ?? null) : null;
  const members = room ? (group?.memberIds ?? []) : agentId ? [agentId] : [];
  const character = characterOf(index, agentId);
  const chat = chatOf(index, conversationId);
  const resolvedMode = conversation ? conversationMode(index, conversation) : 'work';
  // 聊天方式 is offered only where a companion chat is possible: not Fantay, not a channel, and every person has a card.
  const canCompanion =
    kind !== 'channel' &&
    !(agentId && isFantay(index, agentId)) &&
    members.length > 0 &&
    members.every((memberId) => index.characters.has(memberId));
  const name = room ? (group?.name ?? (conversation ? conversationTitle(index, conversation) : '')) : agentId ? displayName(index, agentId) : '';

  // 先开口 lives in direct companion chats only; its routine is read live from the snapshot.
  const send = usePaTransport();
  // Enterprise mode has no routines (they run without a member's grant), so 先开口 is not offered there.
  const showReach = !room && canCompanion && !index.enterprise;
  const routine = reachoutRoutine(data.snapshot?.routines, conversationId);

  const [base, setBase] = useState(() => ({ chat, mode: resolvedMode }));
  const [form, setForm] = useState<ChatForm>(() => chatForm(chat, resolvedMode));
  const [reach, setReach] = useState<ReachForm>(() => reachForm(routine));
  const submit = usePaSubmit();
  const resetForm = () => {
    setBase({ chat, mode: resolvedMode });
    setForm(chatForm(chat, resolvedMode));
    setReach(reachForm(routine));
    submit.clear();
  };
  usePaModalReset(open, conversationId, resetForm);
  useSoulArrival(data.snapshot !== null && data.soul !== null, resetForm);

  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const patchForm = (next: Partial<ChatForm>) => setForm((current) => ({ ...current, ...next }));
  const patch = useMemo(() => chatSettingsPatch(form, base.chat, base.mode, room), [form, base, room]);
  const patchReach = (next: Partial<ReachForm>) => setReach((current) => ({ ...current, ...next }));
  const reachWrite = showReach
    ? reachoutWrite(reach, routine, {
        conversationId,
        name: t('pa.soul.manage.reach.name', { name }).slice(0, 120),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    : null;
  // Switching on needs a companion chat whose character can run a routine; switching off is always allowed.
  const reachMode = form.mode === 'companion';
  const reachTarget = conversation !== null && routineTarget(index, conversation);
  const reachLocked = !reach.on && !(reachMode && reachTarget);
  const reachQuietTime = reach.on && CLOCK.test(reach.time) && reachQuiet(reach.time);
  const reachBlocked =
    reachWrite !== null && reach.on && (!CLOCK.test(reach.time) || reachQuietTime || reach.note.length > L.authorNote);
  const dirty = Object.keys(patch).length > 0 || reachWrite !== null;
  const close = useSoulDiscard(dirty, onClose);
  const blocked = form.scenario.length > L.chatScenario || form.noteText.length > L.authorNote || reachBlocked;

  const own = ownBooks(index, members);
  const extra = form.lorebookIds;
  const addable = [...index.lorebooks.values()].filter((book) => !own.includes(book.id) && !extra.includes(book.id));
  const bookName = (bookId: string) => index.lorebooks.get(bookId)?.name ?? bookId;

  const save = () => {
    if (blocked || submit.busy) return;
    if (!dirty) {
      onClose();
      return;
    }
    const chatPatch = patch;
    const write = reachWrite;
    void submit
      .run(
        async () => {
          // The chat first, so a mode switched to 聊天 in the same save is stored before the routine.
          if (Object.keys(chatPatch).length > 0) await data.actions.saveChat(conversationId, chatPatch);
          if (write) {
            await send(write.path, write.method, write.body);
            await data.actions.refresh();
          }
        },
        () => void data.actions.refresh(),
      )
      .then((ok) => {
        if (!ok) return;
        toast({ tone: 'success', title: t('pa.soul.manage.chat.saved') });
        onClose();
      });
  };
  const reachHint = !reachMode
    ? t('pa.soul.manage.reach.workMode')
    : !reachTarget
      ? t('pa.soul.manage.reach.unavailable', { name })
      : t('pa.soul.manage.reach.allowHint', { name });

  // 语音回复: once the speech status has answered without a usable service, 点了才读 and 自动朗读 are disabled and the
  // line under the help says why. Otherwise a direct chat whose character has no voice, or a group chat, gets its line.
  const voice = form.voiceReplies ?? 'manual';
  const noSpeech = speechStatus !== null && !speechStatus.available;
  let voiceNote: ReactNode = null;
  if (noSpeech)
    voiceNote = (
      <>
        {t('pa.soul.manage.chat.voiceNoProvider')}
        <Button
          variant="link"
          size="sm"
          className="ms-1 align-baseline"
          data-testid="pa-chat-voice-settings"
          onClick={() =>
            close.guard(() => {
              onClose();
              runFantayCommand('fantay.openSettings');
            })
          }
        >
          {t('pa.soul.manage.chat.voiceOpenSettings')}
        </Button>
      </>
    );
  else if (room) voiceNote = t('pa.soul.manage.chat.voiceRoom');
  else if (agentId && character && !character.voice && !speechStatus?.default)
    voiceNote = (
      <>
        {t('pa.soul.manage.chat.voiceNoVoice', { name })}
        <Button
          variant="link"
          size="sm"
          className="ms-1 align-baseline"
          data-testid="pa-chat-voice-profile"
          onClick={() => close.guard(() => nav.openModal({ kind: 'agent', agentId, section: 'style' }))}
        >
          {t('pa.soul.manage.chat.voiceOpenProfile')}
        </Button>
      </>
    );

  return (
    <PaModalFrame
      open={open}
      onClose={() => close.guard()}
      size="lg"
      title={t('pa.soul.manage.chat.title')}
      lede={name ? t('pa.soul.manage.chat.lede', { name }) : undefined}
      conflict={submit.conflict}
      error={submit.error}
      onSubmit={save}
      testId="pa-chat-settings-modal"
      bodyClassName={modalStyles.bodyStack}
      footer={
        <>
          <ModalSpacer />
          <Button variant="ghost" onClick={() => close.guard()}>
            {t('pa.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={blocked} loading={submit.busy}>
            {t('pa.save')}
          </Button>
        </>
      }
    >
      {canCompanion ? (
        <Section title={t('pa.soul.manage.chat.mode')}>
          <div className={modalStyles.group}>
            <div className={modalStyles.optionRow}>
              <Segmented
                size="md"
                className="flex w-full"
                aria-label={t('pa.soul.manage.chat.mode')}
                value={form.mode}
                onValueChange={(mode) => patchForm({ mode: mode as ChatForm['mode'] })}
                data-testid="pa-chat-mode"
              >
                <SegmentedItem value="companion" className="min-w-0 flex-1">
                  {t('pa.soul.manage.chat.modeChat')}
                </SegmentedItem>
                <SegmentedItem value="work" className="min-w-0 flex-1">
                  {t('pa.soul.manage.chat.modeWork')}
                </SegmentedItem>
              </Segmented>
              <p className={modalStyles.optionHelp}>
                {t(form.mode === 'companion' ? 'pa.soul.manage.chat.modeChatHelp' : 'pa.soul.manage.chat.modeWorkHelp')}
              </p>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title={t('pa.soul.manage.chat.us', { name })}>
        <div className={modalStyles.group}>
          <div className={modalStyles.row}>
            <div className={modalStyles.rowText}>
              <label htmlFor={id('persona')} className={modalStyles.rowLabel}>
                {t('pa.soul.manage.chat.persona')}
              </label>
            </div>
            <div className={modalStyles.rowControl}>
              <Select value={form.personaId ?? SOUL_NONE} onValueChange={(value) => patchForm({ personaId: value === SOUL_NONE ? null : value })}>
                <SelectTrigger id={id('persona')} className={modalStyles.rowSelect}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SOUL_NONE}>{t('pa.soul.manage.chat.follow')}</SelectItem>
                  {[...index.personas.values()].map((persona) => (
                    <SelectItem key={persona.id} value={persona.id}>
                      {persona.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {!room ? (
            <div className={modalStyles.row}>
              <div className={modalStyles.rowText}>
                <label htmlFor={id('preset')} className={modalStyles.rowLabel}>
                  {t('pa.soul.manage.chat.preset')}
                </label>
              </div>
              <div className={modalStyles.rowControl}>
                <Select value={form.presetId ?? SOUL_NONE} onValueChange={(value) => patchForm({ presetId: value === SOUL_NONE ? null : value })}>
                  <SelectTrigger id={id('preset')} className={modalStyles.rowSelect}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SOUL_NONE}>{t('pa.soul.manage.chat.follow')}</SelectItem>
                    {[...index.presets.values()].map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}
        </div>
      </Section>

      <Section title={t('pa.soul.manage.chat.this')}>
        <div className={modalStyles.group}>
          <div className={modalStyles.groupPad}>
            <SoulField id={id('scenario')} label={t('pa.soul.manage.chat.scenario')} hint={t('pa.soul.manage.chat.scenarioHint')} text={form.scenario} max={L.chatScenario}>
              <Textarea
                id={id('scenario')}
                rows={4}
                value={form.scenario}
                placeholder={character?.scenario || undefined}
                aria-invalid={form.scenario.length > L.chatScenario || undefined}
                onChange={(event) => patchForm({ scenario: event.target.value })}
              />
            </SoulField>
          </div>
          <div className={modalStyles.groupPad}>
            <SoulField id={id('note')} label={t('pa.soul.manage.chat.note')} hint={t('pa.soul.manage.chat.noteHint', { name })} text={form.noteText} max={L.authorNote}>
              <Textarea
                id={id('note')}
                rows={3}
                value={form.noteText}
                aria-invalid={form.noteText.length > L.authorNote || undefined}
                onChange={(event) => patchForm({ noteText: event.target.value })}
              />
            </SoulField>
          </div>
          <div className={modalStyles.row}>
            <div className={modalStyles.rowText}>
              <span className={modalStyles.rowLabel}>{t('pa.soul.manage.chat.depth')}</span>
              <div className={modalStyles.rowHint}>{t('pa.soul.manage.chat.depthHint')}</div>
            </div>
            <div className={modalStyles.rowControl}>
              <SoulStepper
                value={form.noteDepth}
                min={0}
                max={L.noteDepth}
                aria-label={t('pa.soul.manage.chat.depth')}
                onChange={(noteDepth) => patchForm({ noteDepth })}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section title={t('pa.soul.manage.chat.lore')}>
        {own.length > 0 ? (
          <div>
            <span className={modalStyles.caption}>{t('pa.soul.manage.chat.loreOwn')}</span>
            <div className={modalStyles.group}>
              {own.map((bookId) => (
                <div key={bookId} className={modalStyles.listRow}>
                  <span className={modalStyles.listName}>{bookName(bookId)}</span>
                  <SoulTag tone="outline">{t('pa.soul.manage.chat.loreTag')}</SoulTag>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div>
          <span className={modalStyles.caption}>{t('pa.soul.manage.chat.loreExtra')}</span>
          <div className={modalStyles.group}>
            {extra.map((bookId) => (
              <div key={bookId} className={modalStyles.listRow}>
                <span className={modalStyles.listName}>{bookName(bookId)}</span>
                <IconButton
                  size="xs"
                  aria-label={t('pa.soul.manage.chat.loreRemove')}
                  onClick={() => patchForm({ lorebookIds: extra.filter((item) => item !== bookId) })}
                >
                  <XIcon />
                </IconButton>
              </div>
            ))}
            <div className={modalStyles.listRow}>
              <Select
                value=""
                disabled={addable.length === 0 || extra.length >= L.chatLorebookIds}
                onValueChange={(bookId) => patchForm({ lorebookIds: [...extra, bookId] })}
              >
                <SelectTrigger className="w-full" aria-label={t('pa.soul.manage.chat.loreAdd')}>
                  <SelectValue placeholder={t('pa.soul.manage.chat.loreAdd')} />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((book) => (
                    <SelectItem key={book.id} value={book.id}>
                      {book.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        {form.disabledLoreEntryIds.length > 0 ? (
          <div className={modalStyles.group}>
            <div className={modalStyles.listRow}>
              <span className={modalStyles.listName}>{t('pa.soul.manage.chat.loreOff', { n: form.disabledLoreEntryIds.length })}</span>
              <Button variant="link" size="sm" onClick={() => patchForm({ disabledLoreEntryIds: [] })}>
                {t('pa.soul.manage.chat.loreRestore')}
              </Button>
            </div>
          </div>
        ) : null}
      </Section>

      <Section title={t('pa.soul.manage.chat.turns')}>
        <div className={modalStyles.group}>
          <div className={modalStyles.optionRow}>
            <span className={modalStyles.optionLabel}>{t('pa.soul.manage.chat.history')}</span>
            <Segmented
              size="md"
              className="flex w-full"
              aria-label={t('pa.soul.manage.chat.history')}
              value={form.historyBudget}
              onValueChange={(value) => patchForm({ historyBudget: value as ChatForm['historyBudget'] })}
            >
              {HISTORY.map((item) => (
                <SegmentedItem key={item} value={item} className="min-w-0 flex-1">
                  {t(`pa.soul.manage.chat.history.${item}`)}
                </SegmentedItem>
              ))}
            </Segmented>
            <p className={modalStyles.optionHelp}>{t('pa.soul.manage.chat.historyHint')}</p>
          </div>
          <PaSwitchRow
            label={t('pa.soul.manage.chat.record')}
            hint={t('pa.soul.manage.chat.recordHint', { name })}
            checked={form.turnRecord === 'auto'}
            onChange={(on) => patchForm({ turnRecord: on ? 'auto' : 'off' })}
          />
          {form.mode === 'companion' ? (
            <div className={modalStyles.optionRow}>
              <span className={modalStyles.optionLabel}>{t('pa.soul.manage.chat.voice')}</span>
              <Segmented
                size="md"
                className="flex w-full"
                aria-label={t('pa.soul.manage.chat.voice')}
                value={voice}
                onValueChange={(value) => patchForm({ voiceReplies: value as (typeof VOICE)[number] })}
                data-testid="pa-chat-voice"
              >
                {VOICE.map((item) => (
                  <SegmentedItem key={item} value={item} className="min-w-0 flex-1" disabled={noSpeech && item !== 'off'}>
                    {t(`pa.soul.manage.chat.voice.${item}`)}
                  </SegmentedItem>
                ))}
              </Segmented>
              <p className={modalStyles.optionHelp}>{t(`pa.soul.manage.chat.voiceHelp.${voice}`)}</p>
              {voiceNote ? (
                <p className={modalStyles.optionHelp} data-testid="pa-chat-voice-note">
                  {voiceNote}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Section>

      {room ? (
        <Section title={t('pa.soul.manage.chat.group')}>
          <div className={modalStyles.group}>
            <div className={modalStyles.optionRow}>
              <span className={modalStyles.optionLabel}>{t('pa.soul.manage.chat.strategy')}</span>
              <Segmented
                size="md"
                className="flex w-full"
                aria-label={t('pa.soul.manage.chat.strategy')}
                value={form.groupStrategy}
                onValueChange={(value) => patchForm({ groupStrategy: value as ChatForm['groupStrategy'] })}
                data-testid="pa-chat-strategy"
              >
                {STRATEGIES.map((item) => (
                  <SegmentedItem key={item} value={item} className="min-w-0 flex-1">
                    {t(`pa.soul.manage.chat.strategy.${item}`)}
                  </SegmentedItem>
                ))}
              </Segmented>
              <p className={modalStyles.optionHelp}>{t(`pa.soul.manage.chat.strategyHelp.${form.groupStrategy}`)}</p>
            </div>
          </div>
        </Section>
      ) : null}

      {showReach ? (
        <Section title={t('pa.soul.manage.reach.title')}>
          <div className={modalStyles.group} data-testid="pa-chat-reachout">
            <PaSwitchRow
              label={t('pa.soul.manage.reach.allow', { name })}
              hint={reachHint}
              checked={reach.on}
              disabled={reachLocked}
              onChange={(on) => patchReach({ on })}
            />
            <div className={modalStyles.row}>
              <div className={modalStyles.rowText}>
                <label htmlFor={id('reach-time')} className={modalStyles.rowLabel}>
                  {t('pa.soul.manage.reach.time')}
                </label>
                {reachQuietTime ? (
                  <div role="alert" className={modalStyles.rowError}>
                    {t('pa.soul.manage.reach.quiet')}
                  </div>
                ) : null}
              </div>
              <div className={modalStyles.rowControl}>
                <Input
                  id={id('reach-time')}
                  type="time"
                  className={modalStyles.rowSelect}
                  value={reach.time}
                  disabled={!reach.on}
                  aria-invalid={reachQuietTime || undefined}
                  onChange={(event) => patchReach({ time: event.target.value })}
                />
              </div>
            </div>
            <div className={modalStyles.groupPad}>
              <SoulField
                id={id('reach-note')}
                label={t('pa.soul.manage.reach.note', { name })}
                hint={t('pa.soul.manage.reach.noteHint', { name })}
                text={reach.note}
                max={L.authorNote}
              >
                <Textarea
                  id={id('reach-note')}
                  rows={2}
                  value={reach.note}
                  disabled={!reach.on}
                  aria-invalid={reach.note.length > L.authorNote || undefined}
                  onChange={(event) => patchReach({ note: event.target.value })}
                />
              </SoulField>
            </div>
            <div className={modalStyles.optionRow}>
              <p className={modalStyles.optionHelp}>{t('pa.soul.manage.reach.rules')}</p>
              {routine?.lastError ? (
                <p className={modalStyles.optionHelp} role="status">
                  {t('pa.soul.manage.reach.skipped', { reason: routine.lastError })}
                </p>
              ) : null}
            </div>
          </div>
        </Section>
      ) : null}

      <SoulDiscardDialog unit="manage" {...close.dialog} />
    </PaModalFrame>
  );
}
