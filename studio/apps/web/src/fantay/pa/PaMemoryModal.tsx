// SPDX-License-Identifier: AGPL-3.0-only
// Memory create/edit modal (spec §14.3): content, source, scope with its recall rule, and a named
// target (agents, groups or projects; never a UUID). Edit mode can archive through a confirm (a memory is
// never deleted; it is restored in the Memory Center). Editing never moves a memory or changes its model
// access (the service refuses both), so edit mode shows them as fixed text with the reason.
import { useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import {
  Button,
  ConfirmDialog,
  Field,
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
  toast,
} from '../ui';
import frame from '../memory/dialogs/MemoryDialogFrame.module.css';
import { usePa } from './pa-context';
import { conversationKind, conversationTitle, memoryScopeName } from './pa-model';
import { PaModalFrame, paErrorText, usePaModalReset, usePaReload, usePaSubmit } from './PaAgentModal';
import { useSoulArrival } from './soul/SoulProfileModal';
import { displayName } from './soul/soul-model';
import type { PaIndex, PaMemory, PaMemoryInput, PaUiState, Project } from './pa-types';
import styles from './PaModals.module.css';

type Scope = PaMemoryInput['scope'];
export interface PaMemoryPreset {
  scope?: Scope;
  scopeId?: string | null;
  agentId?: string | null;
  projectId?: string | null;
  groupId?: string | null;
  content?: string;
  kind?: PaMemoryInput['kind'];
  source?: string;
  sourceMessageId?: string;
}

const SCOPES = ['private', 'agent', 'group', 'project'] as const;

/** A memory the Personal Agent surfaces list as in use: archived and replaced ones live in the Memory Center. */
export function paMemoryInUse(memory: Pick<PaMemory, 'status'>): boolean {
  return memory.status === undefined || memory.status === 'active' || memory.status === 'challenged';
}
const SCOPE_LABEL = {
  private: 'pa.memoryForm.scopePrivate',
  agent: 'pa.memoryForm.scopeAgent',
  group: 'pa.memoryForm.scopeGroup',
  project: 'pa.memoryForm.scopeProject',
} as const;
const SCOPE_RULE = {
  private: 'pa.memoryForm.rulePrivate',
  agent: 'pa.memoryForm.ruleAgent',
  group: 'pa.memoryForm.ruleGroup',
  project: 'pa.memoryForm.ruleProject',
} as const;

interface MemoryForm {
  content: string;
  source: string;
  scope: Scope;
  scopeId: string | null;
  kind: NonNullable<PaMemoryInput['kind']>;
  dataClass: NonNullable<PaMemoryInput['dataClass']>;
  /** 约定's 到期 as a local `YYYY-MM-DD` (empty: no date). */
  due: string;
}

/** A local `YYYY-MM-DD` for a date input. */
function dueInput(at: number | null | undefined): string {
  if (typeof at !== 'number') return '';
  const day = new Date(at);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/** The local end of that day (23:59:59.999), or null for an empty or malformed date. */
function dueAtOf(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999).getTime();
  return Number.isFinite(at) ? at : null;
}

/** 「来自和 {name} 的对话」 for a memory taken from a chat message: the direct character, else the chat's title. */
function chatSourceName(index: PaIndex, messageId: string | undefined): string | null {
  const message = messageId ? index.messages.get(messageId) : undefined;
  const conversation = message ? index.conversations.get(message.conversationId) : undefined;
  if (!conversation) return null;
  if (conversationKind(conversation) === 'direct' && conversation.agentId) return displayName(index, conversation.agentId);
  return conversationTitle(index, conversation);
}

interface Target {
  id: string;
  name: string;
}

function targetsFor(scope: Scope, index: PaIndex, projects: readonly Project[]): Target[] {
  if (scope === 'agent') {
    const agents = [...index.agents.values()];
    const fantayId = index.fantay?.id;
    return [...agents.filter((a) => a.id === fantayId), ...agents.filter((a) => a.id !== fantayId)].map((a) => ({ id: a.id, name: a.name }));
  }
  if (scope === 'group') return [...index.groups.values()].map((g) => ({ id: g.id, name: g.name }));
  if (scope === 'project') return projects.map((p) => ({ id: p.id, name: p.name }));
  return [];
}

function contextualTargetFor(
  scope: Scope,
  ui: Pick<PaUiState, 'conversationId' | 'inspectorAgentId'> | undefined,
  index: PaIndex,
  projects: readonly Project[],
): string | null {
  const conv = ui?.conversationId ? index.conversations.get(ui.conversationId) ?? null : null;
  if (scope === 'agent') {
    if (ui?.inspectorAgentId && index.agents.has(ui.inspectorAgentId)) return ui.inspectorAgentId;
    if (conv?.agentId && index.agents.has(conv.agentId)) return conv.agentId;
    return targetsFor('agent', index, projects)[0]?.id ?? null;
  }
  if (scope === 'project') {
    if (conv) {
      const taskProjectId = [...(index.tasksByConversation.get(conv.id) ?? [])]
        .reverse()
        .find((task) => Boolean(task.projectId))?.projectId;
      if (taskProjectId) return taskProjectId;
    }
    return projects[0]?.id ?? null;
  }
  if (scope === 'group') {
    if (conv?.groupId && index.groups.has(conv.groupId)) return conv.groupId;
    return targetsFor('group', index, projects)[0]?.id ?? null;
  }
  return null;
}

/**
 * D3 scope resolution:
 * - Opening "New Memory" from a specific Bot defaults to `scope: "agent", scopeId: botId`.
 * - Opening "New Memory" from a project defaults to `scope: "project", scopeId: projectId`.
 * - Never silently falls back to global `private` (`个人画像与全局偏好`) unless explicitly requested
 *   or no Bot/Project/Group target exists.
 */
export function resolveDefaultMemoryScope(
  preset: PaMemoryPreset | undefined,
  index: PaIndex,
  projects: readonly Project[],
  ui?: Pick<PaUiState, 'conversationId' | 'inspectorAgentId'>,
): { scope: Scope; scopeId: string | null } {
  if (preset?.scope) {
    const scope = preset.scope;
    if (scope === 'private') return { scope: 'private', scopeId: null };
    const explicitId =
      preset.scopeId
      ?? (scope === 'agent' ? preset.agentId : scope === 'project' ? preset.projectId : preset.groupId)
      ?? null;
    const scopeId = explicitId ?? contextualTargetFor(scope, ui, index, projects);
    return { scope, scopeId };
  }
  if (preset?.projectId) return { scope: 'project', scopeId: preset.projectId };
  if (preset?.agentId) return { scope: 'agent', scopeId: preset.agentId };
  if (preset?.groupId) return { scope: 'group', scopeId: preset.groupId };

  if (ui?.inspectorAgentId && index.agents.has(ui.inspectorAgentId)) {
    return { scope: 'agent', scopeId: ui.inspectorAgentId };
  }
  const conv = ui?.conversationId ? index.conversations.get(ui.conversationId) ?? null : null;
  if (conv) {
    if (conv.agentId && index.agents.has(conv.agentId)) {
      return { scope: 'agent', scopeId: conv.agentId };
    }
    const taskProjectId = [...(index.tasksByConversation.get(conv.id) ?? [])]
      .reverse()
      .find((task) => Boolean(task.projectId))?.projectId;
    if (taskProjectId) {
      return { scope: 'project', scopeId: taskProjectId };
    }
    if (conv.groupId && index.groups.has(conv.groupId)) {
      return { scope: 'group', scopeId: conv.groupId };
    }
  }
  const firstAgentId = targetsFor('agent', index, projects)[0]?.id ?? null;
  if (firstAgentId) return { scope: 'agent', scopeId: firstAgentId };
  const firstProjectId = projects[0]?.id ?? null;
  if (firstProjectId) return { scope: 'project', scopeId: firstProjectId };
  return { scope: 'private', scopeId: null };
}

function memoryForm(
  memory: PaMemory | null,
  preset: PaMemoryPreset | undefined,
  index: PaIndex,
  projects: readonly Project[],
  ui?: Pick<PaUiState, 'conversationId' | 'inspectorAgentId'>,
  fromChat?: string,
): MemoryForm {
  if (memory) return {
    content: memory.content, source: memory.source, scope: memory.scope, scopeId: memory.scopeId,
    kind: memory.kind ?? 'preference', dataClass: memory.dataClass ?? 'standard', due: dueInput(memory.dueAt),
  };
  const { scope, scopeId } = resolveDefaultMemoryScope(preset, index, projects, ui);
  return {
    due: '',
    content: preset?.content ?? '',
    source: preset?.source ?? fromChat ?? '',
    scope,
    scopeId,
    kind: preset?.kind ?? 'preference',
    dataClass: 'standard',
  };
}

export function PaMemoryModal({
  open,
  onClose,
  memoryId,
  preset,
}: {
  open: boolean;
  onClose(): void;
  memoryId: string | null;
  preset?: PaMemoryPreset;
}) {
  const t = useT();
  const { data, index, projects, ui } = usePa();
  const enterprise = data.snapshot?.mode === 'enterprise';
  // Enterprise memory is the member's own: a private note, or what one character remembers about this member.
  const characterScoped = (scope: PaMemoryInput['scope'] | undefined, scopeId: string | null | undefined): boolean =>
    scope === 'agent' && Boolean(scopeId) && index.characters.has(scopeId!);
  if (enterprise && !characterScoped(preset?.scope, preset?.scopeId ?? preset?.agentId)) preset = { ...preset, scope: 'private', scopeId: null };
  const entity = memoryId ? (index.memories.get(memoryId) ?? null) : null;
  const chatName = chatSourceName(index, preset?.sourceMessageId);
  const fromChat = chatName !== null ? t('pa.soul.manage.memory.fromChat', { name: chatName }) : undefined;
  const [base, setBase] = useState<PaMemory | null>(entity);
  const [form, setForm] = useState<MemoryForm>(() => memoryForm(entity, preset, index, projects, ui, fromChat));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const submit = usePaSubmit();
  const reload = usePaReload(entity, (latest) => {
    setBase(latest);
    setForm(memoryForm(latest, undefined, index, projects, ui));
  });
  usePaModalReset(
    open,
    `${memoryId ?? 'new'}:${preset?.scope ?? ''}:${preset?.scopeId ?? ''}:${preset?.agentId ?? ''}:${preset?.projectId ?? ''}:${preset?.groupId ?? ''}:${preset?.sourceMessageId ?? ''}`,
    () => {
      setBase(entity);
      setForm(memoryForm(entity, preset, index, projects, ui, fromChat));
      setConfirmDelete(false);
      submit.clear();
      reload.cancel();
    },
  );
  // Opened before the first snapshot (a lab deep link): fill the form once the data arrives.
  useSoulArrival(data.snapshot !== null, () => {
    setBase(entity);
    setForm(memoryForm(entity, preset, index, projects, ui, fromChat));
  });

  const ids = { content: useId(), source: useId(), target: useId(), kind: useId(), dataClass: useId(), due: useId() };
  const targets = useMemo(() => {
    const list = targetsFor(form.scope, index, projects);
    if (form.scopeId && !list.some((target) => target.id === form.scopeId)) {
      list.unshift({ id: form.scopeId, name: t('pa.memoryForm.deletedTarget') });
    }
    return list;
  }, [form.scope, form.scopeId, index, projects, t]);
  const needsTarget = form.scope !== 'private';
  const noTargets = needsTarget && targets.length === 0;
  // An edit keeps its own place, so only a new memory needs a target.
  const valid =
    form.content.trim().length > 0 &&
    form.source.trim().length > 0 &&
    (base !== null || !needsTarget || (!!form.scopeId && !noTargets));

  const setScope = (scope: Scope) =>
    setForm((current) => {
      if (scope === current.scope) return current;
      const fromPreset =
        preset && preset.scope === scope
          ? preset.scopeId
          : scope === 'agent'
            ? (preset?.agentId ?? null)
            : scope === 'project'
              ? (preset?.projectId ?? null)
              : scope === 'group'
                ? (preset?.groupId ?? null)
                : null;
      const scopeId =
        scope === 'private'
          ? null
          : (fromPreset ?? contextualTargetFor(scope, ui, index, projects) ?? targetsFor(scope, index, projects)[0]?.id ?? null);
      return { ...current, scope, scopeId };
    });

  const save = () => {
    if (!valid || submit.busy) return;
    // An edit keeps the memory's own place and model access; only a new memory chooses them.
    const place = base
      ? { scope: base.scope, scopeId: base.scopeId ?? null, dataClass: base.dataClass ?? 'standard' }
      : {
          scope: enterprise && !characterScoped(form.scope, form.scopeId) ? 'private' as const : form.scope,
          scopeId: form.scope === 'private' || (enterprise && !characterScoped(form.scope, form.scopeId)) ? null : form.scopeId,
          dataClass: form.dataClass,
        };
    const input: PaMemoryInput = {
      content: form.content.trim(),
      source: form.source.trim(),
      ...place,
      kind: form.kind,
      // 约定 carries its 到期; a memory that stops being a promise drops a date it had.
      ...(form.kind === 'promise' ? { dueAt: dueAtOf(form.due) } : base?.dueAt ? { dueAt: null } : {}),
      ...(!base && preset?.sourceMessageId ? { sourceMessageId: preset.sourceMessageId } : {}),
    };
    const held = base;
    void submit
      .run(
        () => data.actions.saveMemory(input, held ?? undefined),
        () => {
          if (held) reload.expect(held.revision);
        },
      )
      .then((ok) => {
        if (ok) onClose();
      });
  };

  const remove = async () => {
    if (!base || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await data.actions.deleteMemory(base.id);
      setConfirmDelete(false);
      toast({ tone: 'success', title: t('pa.memory.archived'), description: t('pa.memory.archivedBody') });
      onClose();
    } catch (caught) {
      setConfirmDelete(false);
      submit.setError(paErrorText(caught, t));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  return (
    <PaModalFrame
      open={open}
      onClose={onClose}
      size="md"
      title={memoryId ? t('pa.memoryForm.editTitle') : t('pa.newMemory')}
      conflict={submit.conflict}
      error={submit.error}
      onSubmit={save}
      footer={
        <>
          {base ? (
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(true)} disabled={submit.busy}>
                {t('pa.memory.archive')}
              </Button>
              <ModalSpacer />
            </>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {t('pa.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={submit.busy}>
            {t('pa.save')}
          </Button>
        </>
      }
    >
      <Field label={t('pa.content')} htmlFor={ids.content} labelVariant="form" hint={t('pa.memoryForm.markdown')}>
        <Textarea
          id={ids.content}
          value={form.content}
          rows={8}
          maxLength={16000}
          required
          onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))}
        />
      </Field>

      <Field label={t('pa.source')} htmlFor={ids.source} labelVariant="form">
        <Input
          id={ids.source}
          value={form.source}
          maxLength={500}
          required
          autoComplete="off"
          placeholder={t('pa.memoryForm.sourcePlaceholder')}
          onChange={(event) => setForm((current) => ({ ...current, source: event.target.value }))}
        />
      </Field>

      <Field label={t('pa.memoryForm.kind')} htmlFor={ids.kind} labelVariant="form">
        <Select value={form.kind} onValueChange={kind => setForm(current => ({ ...current, kind: kind as MemoryForm['kind'] }))}>
          <SelectTrigger id={ids.kind} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="preference">{t('pa.memoryForm.kindPreference')}</SelectItem>
            <SelectItem value="fact">{t('pa.memoryForm.kindFact')}</SelectItem>
            <SelectItem value="procedure">{t('pa.memoryForm.kindProcedure')}</SelectItem>
            <SelectItem value="promise">{t('pa.soul.manage.kind.promise')}</SelectItem>
            <SelectItem value="moment">{t('pa.soul.manage.kind.moment')}</SelectItem>
            {/* 画像 (owner profile) memories come from the memory centre; listed only so an existing one keeps its kind. */}
            {form.kind === 'profile' ? <SelectItem value="profile">{t('pa.soul.manage.kind.profile')}</SelectItem> : null}
          </SelectContent>
        </Select>
      </Field>
      {form.kind === 'promise' ? (
        <Field label={t('pa.soul.manage.memory.due')} htmlFor={ids.due} labelVariant="form" hint={t('pa.soul.manage.memory.dueHint')}>
          <Input
            id={ids.due}
            type="date"
            value={form.due}
            data-testid="pa-memory-due"
            onChange={(event) => setForm((current) => ({ ...current, due: event.target.value }))}
          />
        </Field>
      ) : null}
      {base ? (
        <Field label={t('pa.memoryForm.dataClass')} labelVariant="form" hint={t('pa.memoryForm.dataClassFixed')}>
          <p className={frame.fixedField} data-testid="pa-memory-data-class-fixed">
            {(base.dataClass ?? 'standard') === 'local_only' ? t('pa.composer.localOnly') : t('pa.memoryForm.standard')}
          </p>
        </Field>
      ) : (
        <Field label={t('pa.memoryForm.dataClass')} htmlFor={ids.dataClass} labelVariant="form">
          <Select value={form.dataClass} onValueChange={dataClass => setForm(current => ({ ...current, dataClass: dataClass as MemoryForm['dataClass'] }))}>
            <SelectTrigger id={ids.dataClass} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">{t('pa.memoryForm.standard')}</SelectItem>
              <SelectItem value="local_only">{t('pa.composer.localOnly')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
      {base && !enterprise ? (
        <Field label={t('pa.scope')} labelVariant="form" hint={t('pa.memoryForm.scopeFixed')}>
          <p className={frame.fixedField} data-testid="pa-memory-scope-fixed">
            {memoryScopeName(index, base, projects, t)}
          </p>
          <p className={styles.help}>{t(SCOPE_RULE[base.scope])}</p>
        </Field>
      ) : null}
      {enterprise || base ? null : <Field label={t('pa.scope')} labelVariant="form">
        <Segmented
          size="md"
          className="flex w-full"
          aria-label={t('pa.scope')}
          value={form.scope}
          onValueChange={(scope) => setScope(scope as Scope)}
        >
          {SCOPES.map((scope) => (
            <SegmentedItem key={scope} value={scope} className="min-w-0 flex-1">
              {t(SCOPE_LABEL[scope])}
            </SegmentedItem>
          ))}
        </Segmented>
        <p className={styles.help}>{t(SCOPE_RULE[form.scope])}</p>
      </Field>}

      {needsTarget && !enterprise && !base ? (
        <Field label={t('pa.memoryForm.target')} htmlFor={ids.target} labelVariant="form">
          {noTargets ? (
            <p className={styles.muted}>{t('pa.memoryForm.noProjects')}</p>
          ) : (
            <Select
              value={form.scopeId ?? ''}
              onValueChange={(scopeId) => setForm((current) => ({ ...current, scopeId }))}
            >
              <SelectTrigger id={ids.target} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {target.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(next) => {
          // The confirm click also requests close; keep the dialog up while archiving settles.
          if (!deletingRef.current) setConfirmDelete(next);
        }}
        title={t('pa.memory.archiveTitle')}
        description={t('pa.memory.archiveBody')}
        confirmLabel={t('pa.memory.archive')}
        cancelLabel={t('pa.cancel')}
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </PaModalFrame>
  );
}
