// SPDX-License-Identifier: AGPL-3.0-only
// Memory create/edit modal (spec §14.3): content, source, scope with its recall rule, and a named
// target (agents, groups or projects; never a UUID). Edit mode can delete through a confirm.
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
import { usePa } from './pa-context';
import { PaModalFrame, paErrorText, usePaModalReset, usePaReload, usePaSubmit } from './PaAgentModal';
import type { PaIndex, PaMemory, PaMemoryInput, Project } from './pa-types';
import styles from './PaModals.module.css';

type Scope = PaMemoryInput['scope'];
type Preset = { scope: Scope; scopeId: string | null };

const SCOPES = ['private', 'agent', 'group', 'project'] as const;
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

function memoryForm(memory: PaMemory | null, preset: Preset | undefined, index: PaIndex, projects: readonly Project[]): MemoryForm {
  if (memory) return {
    content: memory.content, source: memory.source, scope: memory.scope, scopeId: memory.scopeId,
    kind: memory.kind ?? 'preference', dataClass: memory.dataClass ?? 'standard',
  };
  const scope = preset?.scope ?? 'private';
  const scopeId = scope === 'private' ? null : (preset?.scopeId ?? targetsFor(scope, index, projects)[0]?.id ?? null);
  return { content: '', source: '', scope, scopeId, kind: 'preference', dataClass: 'standard' };
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
  preset?: Preset;
}) {
  const t = useT();
  const { data, index, projects } = usePa();
  const enterprise = data.snapshot?.mode === 'enterprise';
  if (enterprise) preset = { scope: 'private', scopeId: null };
  const entity = memoryId ? (index.memories.get(memoryId) ?? null) : null;
  const [base, setBase] = useState<PaMemory | null>(entity);
  const [form, setForm] = useState<MemoryForm>(() => memoryForm(entity, preset, index, projects));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const submit = usePaSubmit();
  const reload = usePaReload(entity, (latest) => {
    setBase(latest);
    setForm(memoryForm(latest, undefined, index, projects));
  });
  usePaModalReset(open, `${memoryId ?? 'new'}:${preset?.scope ?? ''}:${preset?.scopeId ?? ''}`, () => {
    setBase(entity);
    setForm(memoryForm(entity, preset, index, projects));
    setConfirmDelete(false);
    submit.clear();
    reload.cancel();
  });

  const ids = { content: useId(), source: useId(), target: useId(), kind: useId(), dataClass: useId() };
  const targets = useMemo(() => {
    const list = targetsFor(form.scope, index, projects);
    if (form.scopeId && !list.some((target) => target.id === form.scopeId)) {
      list.unshift({ id: form.scopeId, name: t('pa.memoryForm.deletedTarget') });
    }
    return list;
  }, [form.scope, form.scopeId, index, projects, t]);
  const needsTarget = form.scope !== 'private';
  const noTargets = needsTarget && targets.length === 0;
  const valid =
    form.content.trim().length > 0 && form.source.trim().length > 0 && (!needsTarget || (!!form.scopeId && !noTargets));

  const setScope = (scope: Scope) =>
    setForm((current) => {
      if (scope === current.scope) return current;
      const fromPreset = preset && preset.scope === scope ? preset.scopeId : null;
      const scopeId = scope === 'private' ? null : (fromPreset ?? targetsFor(scope, index, projects)[0]?.id ?? null);
      return { ...current, scope, scopeId };
    });

  const save = () => {
    if (!valid || submit.busy) return;
    const input: PaMemoryInput = {
      content: form.content.trim(),
      source: form.source.trim(),
      scope: enterprise ? 'private' : form.scope,
      scopeId: form.scope === 'private' || enterprise ? null : form.scopeId,
      kind: form.kind,
      dataClass: form.dataClass,
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
      toast({ tone: 'success', title: t('pa.memoryForm.deleted') });
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
              {/* Quiet until its confirm dialog, which carries the solid destructive button. */}
              <Button variant="ghost" className={styles.dangerQuiet} onClick={() => setConfirmDelete(true)} disabled={submit.busy}>
                {t('pa.delete')}
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
          </SelectContent>
        </Select>
      </Field>
      <Field label={t('pa.memoryForm.dataClass')} htmlFor={ids.dataClass} labelVariant="form">
        <Select value={form.dataClass} onValueChange={dataClass => setForm(current => ({ ...current, dataClass: dataClass as MemoryForm['dataClass'] }))}>
          <SelectTrigger id={ids.dataClass} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">{t('pa.memoryForm.standard')}</SelectItem>
            <SelectItem value="local_only">{t('pa.composer.localOnly')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {enterprise ? null : <Field label={t('pa.scope')} labelVariant="form">
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

      {needsTarget && !enterprise ? (
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
          // The confirm click also requests close; keep the dialog up while the delete settles.
          if (!deletingRef.current) setConfirmDelete(next);
        }}
        title={t('pa.memory.deleteTitle')}
        description={t('pa.memory.deleteBody')}
        confirmLabel={t('pa.delete')}
        cancelLabel={t('pa.cancel')}
        destructive
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </PaModalFrame>
  );
}
