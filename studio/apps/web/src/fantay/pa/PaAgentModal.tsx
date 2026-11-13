// SPDX-License-Identifier: AGPL-3.0-only
// Agent create/edit modal (spec §14.1), plus the frame and form helpers every Fantay management
// modal shares (spec §14 "Common layout"): kept mounted, fixed header and footer, one scrolling body,
// a revision-conflict notice that reloads the form, and other errors as an error Callout.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import {
  Button,
  Callout,
  Chip,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  ModalActions,
  ModalLede,
  ModalTitle,
  Switch,
  Textarea,
  cn,
  type ModalSize,
} from '../ui';
import { isRevisionConflict } from './pa-api';
import { usePa } from './pa-context';
import { isFantay } from './pa-model';
import { PaAvatar } from './PaAvatar';
import { PaModelPicker } from './PaModelPicker';
import type { PaAgentInput, PaModelOption, PersonalAgent, TFn } from './pa-types';
import styles from './PaModals.module.css';

/* ── shared frame and helpers (used by every U5 modal) ─────────────────────────────────── */

export interface PaModalFrameProps {
  open: boolean;
  onClose(): void;
  size: ModalSize;
  title: ReactNode;
  lede?: ReactNode;
  /** Clamp the lede to two lines (a quoted goal). */
  ledeClamp?: boolean;
  /** Shown before the title, e.g. the agent's preview avatar. */
  leading?: ReactNode;
  /** Shows the 409 revision-conflict notice at the top of the body. */
  conflict?: boolean;
  error?: string | null;
  /** When set, the frame is a <form> and Enter / the submit button call it. */
  onSubmit?(): void;
  footer: ReactNode;
  bodyClassName?: string;
  testId?: string;
  children: ReactNode;
}

export function PaModalFrame({
  open,
  onClose,
  size,
  title,
  lede,
  ledeClamp,
  leading,
  conflict,
  error,
  onSubmit,
  footer,
  bodyClassName,
  testId,
  children,
}: PaModalFrameProps) {
  const t = useT();
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);
  const inner = (
    <>
      <header className={styles.header}>
        {leading}
        <div className={styles.headerText}>
          <ModalTitle>{title}</ModalTitle>
          {lede ? <ModalLede className={cn(styles.lede, ledeClamp && styles.ledeClamp)}>{lede}</ModalLede> : null}
        </div>
      </header>
      <div className={cn(styles.body, bodyClassName)}>
        {conflict ? (
          <Callout tone="neutral" role="status">
            {t('pa.agentForm.conflict')}
          </Callout>
        ) : null}
        {error ? (
          <div ref={errorRef}>
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          </div>
        ) : null}
        {children}
      </div>
      <ModalActions className={styles.footer}>{footer}</ModalActions>
    </>
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      size={size}
      className={styles.modal}
      data-testid={testId}
      {...(lede ? {} : { 'aria-describedby': undefined })}
    >
      {onSubmit ? (
        <form
          className={styles.form}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {inner}
        </form>
      ) : (
        <div className={styles.form}>{inner}</div>
      )}
    </Modal>
  );
}

/** One row of a hairline group: label (+ hint) on the left, a Switch on the right. The label is a real
 *  <label> for the switch, so clicking the text toggles it too. Every on/off option in these modals uses
 *  it, so permissions read the same in the agent, channel-create and channel-edit forms. */
export function PaSwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className={styles.row} data-disabled={disabled ? '' : undefined}>
      <div className={styles.rowText}>
        <label htmlFor={id} className={styles.rowLabel}>
          {label}
        </label>
        {hint ? (
          <div id={hintId} className={styles.rowHint}>
            {hint}
          </div>
        ) : null}
      </div>
      <div className={styles.rowControl}>
        <Switch
          id={id}
          size="md"
          aria-describedby={hint ? hintId : undefined}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </div>
    </div>
  );
}

export function paErrorText(error: unknown, t: TFn): string {
  return error instanceof Error && error.message ? error.message : t('pa.error');
}

/** Calls `reset` when the modal opens, or when it is reused for another entity while open. The first
 *  render needs no reset: the caller's state initialisers already read the props. */
export function usePaModalReset(open: boolean, key: string, reset: () => void): void {
  const signature = open ? key : null;
  const last = useRef(signature);
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    if (signature !== null && signature !== last.current) resetRef.current();
    last.current = signature;
  }, [signature]);
}

/** One submit at a time, with the error / conflict state the frame shows. On a 409
 *  PA_REVISION_CONFLICT it calls `onConflict`, so the form can reload once the snapshot moves on
 *  (every PaActions mutation re-reads the snapshot before it rejects). */
export function usePaSubmit() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const busyRef = useRef(false);
  const run = async (work: () => Promise<unknown>, onConflict?: () => void): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      setConflict(false);
      return true;
    } catch (caught) {
      if (isRevisionConflict(caught)) {
        setConflict(true);
        onConflict?.();
      } else {
        setError(paErrorText(caught, t));
      }
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const clear = () => {
    setError(null);
    setConflict(false);
  };
  return { busy, error, conflict, run, clear, setError };
}

/** After a conflict, waits for the snapshot entity to move past the revision the form holds, then
 *  hands the latest entity to `apply` (spec §14: "the form reloads from the current snapshot entity"). */
export function usePaReload<T extends { revision: number }>(entity: T | null | undefined, apply: (latest: T) => void) {
  const [held, setHeld] = useState<number | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (held === null || !entity || entity.revision === held) return;
    applyRef.current(entity);
    setHeld(null);
  }, [held, entity]);
  return { expect: (revision: number) => setHeld(revision), cancel: () => setHeld(null) };
}

export const modelKeyOf = (model: { runtime: string; modelId: string }) => `${model.runtime}/${model.modelId}`;

/* ── agent modal ─────────────────────────────────────────────────────────────────────── */

type AgentModel = PaAgentInput['model'];

interface AgentForm {
  name: string;
  role: string;
  model: AgentModel;
  enabled: boolean;
  project: boolean;
}

const TEMPLATES = [
  { name: 'pa.agentForm.tplResearcher', role: 'pa.agentForm.tplResearcherRole' },
  { name: 'pa.agentForm.tplDesigner', role: 'pa.agentForm.tplDesignerRole' },
  { name: 'pa.agentForm.tplWriter', role: 'pa.agentForm.tplWriterRole' },
  { name: 'pa.agentForm.tplReviewer', role: 'pa.agentForm.tplReviewerRole' },
] as const;

/** Prefer the account catalog for new agents, retaining existing agents' choices. */
function defaultModel(models: readonly PaModelOption[]): AgentModel {
  const first = models.find((option) => option.available && option.runtime === 'tokentosea')
    ?? models.find((option) => option.available);
  return first ? { runtime: first.runtime, modelId: first.modelId } : { runtime: 'claude', modelId: 'sonnet' };
}

function agentForm(agent: PersonalAgent | null, models: readonly PaModelOption[]): AgentForm {
  if (!agent) return { name: '', role: '', model: defaultModel(models), enabled: true, project: true };
  return {
    name: agent.name,
    role: agent.role,
    model: { runtime: agent.model.runtime, modelId: agent.model.modelId },
    enabled: agent.enabled,
    project: agent.tools.includes('create_project'),
  };
}

const DRAFT_ENTITY = { id: 'pa-draft-agent', createdAt: 0, updatedAt: 0, revision: 1 };

export function PaAgentModal({ open, onClose, agentId }: { open: boolean; onClose(): void; agentId: string | null }) {
  const t = useT();
  const { data, index } = usePa();
  const entity = agentId ? (index.agents.get(agentId) ?? null) : null;
  const [base, setBase] = useState<PersonalAgent | null>(entity);
  const [form, setForm] = useState<AgentForm>(() => agentForm(entity, data.models));
  const modelChosen = useRef(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const submit = usePaSubmit();
  const reload = usePaReload(entity, (latest) => {
    setBase(latest);
    setForm(agentForm(latest, data.models));
  });

  usePaModalReset(open, agentId ?? 'new', () => {
    setBase(entity);
    setForm(agentForm(entity, data.models));
    modelChosen.current = false;
    setConfirmDisable(false);
    submit.clear();
    reload.cancel();
  });

  useEffect(() => {
    if (open) void data.actions.refreshModels();
  }, [open, data.actions]);

  useEffect(() => {
    if (!open || agentId !== null || modelChosen.current) return;
    const preferred = defaultModel(data.models);
    setForm((current) => modelKeyOf(current.model) === modelKeyOf(preferred) ? current : { ...current, model: preferred });
  }, [open, agentId, data.models]);

  const editing = agentId !== null;
  const fantay = base ? isFantay(index, base.id) : false;
  const valid = form.name.trim().length > 0 && form.role.trim().length > 0;
  const ids = { name: useId(), role: useId(), model: useId() };
  const previewName = form.name.trim() || base?.name || '';
  const preview: PersonalAgent = {
    ...(base ?? DRAFT_ENTITY),
    name: previewName,
    role: form.role,
    avatar: base?.avatar ?? '',
    model: form.model,
    enabled: form.enabled,
    tools: form.project ? ['respond', 'create_project'] : ['respond'],
  };
  const hasFace = fantay || !!previewName;
  const patch = (next: Partial<AgentForm>) => setForm((current) => ({ ...current, ...next }));

  const save = () => {
    if (!valid || submit.busy) return;
    const input: PaAgentInput = {
      name: form.name.trim(),
      role: form.role.trim(),
      avatar: base?.avatar ?? '',
      model: { runtime: form.model.runtime, modelId: form.model.modelId },
      enabled: form.enabled,
      tools: form.project ? ['respond', 'create_project'] : ['respond'],
    };
    const held = base;
    void submit
      .run(
        () => data.actions.saveAgent(input, held ?? undefined),
        () => {
          if (held) reload.expect(held.revision);
        },
      )
      .then((ok) => {
        if (ok) onClose();
      });
  };

  return (
    <PaModalFrame
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? t('pa.agentForm.editTitle') : t('pa.newAgent')}
      leading={<PaAvatar agent={hasFace ? preview : null} size={40} fantay={fantay} className={hasFace ? undefined : styles.blankFace} />}
      conflict={submit.conflict}
      error={submit.error}
      onSubmit={save}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('pa.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={submit.busy}>
            {t('pa.save')}
          </Button>
        </>
      }
    >
      {!editing ? (
        <div>
          <div className={styles.caption}>{t('pa.agentForm.templates')}</div>
          <div className={styles.chips}>
            {TEMPLATES.map((template) => (
              <Chip
                key={template.name}
                size="sm"
                // `solid`, not `suggestion`: a suggestion chip rests at 60% opacity and read as disabled here.
                variant="solid"
                on={form.name === t(template.name) && form.role === t(template.role)}
                onClick={() => patch({ name: t(template.name), role: t(template.role) })}
              >
                {t(template.name)}
              </Chip>
            ))}
          </div>
        </div>
      ) : null}

      <Field label={t('pa.name')} htmlFor={ids.name} labelVariant="form">
        <Input
          id={ids.name}
          value={form.name}
          maxLength={60}
          required
          autoComplete="off"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>

      <Field label={t('pa.role')} htmlFor={ids.role} labelVariant="form" hint={t('pa.agentForm.roleHint')}>
        <Textarea
          id={ids.role}
          value={form.role}
          rows={6}
          maxLength={4000}
          required
          onChange={(event) => patch({ role: event.target.value })}
        />
      </Field>

      <Field
        label={t('pa.model')}
        htmlFor={ids.model}
        labelVariant="form"
        hint={data.models.length ? undefined : t('pa.noModels')}
      >
        <PaModelPicker id={ids.model} agent={preview} variant="profile" onModelChange={(model) => {
          modelChosen.current = true;
          patch({ model });
        }} />
      </Field>

      {/* The on/off options share one hairline group (the settings recipe), like the channel permissions. */}
      <div className={styles.group}>
        <PaSwitchRow
          label={t('pa.agentForm.project')}
          hint={t('pa.agentForm.projectHint')}
          checked={form.project}
          onChange={(checked) => patch({ project: checked })}
        />
        {editing ? (
          <PaSwitchRow
            label={t('pa.agentForm.enabled')}
            hint={t('pa.agentForm.enabledHint')}
            checked={form.enabled}
            onChange={(checked) => {
              if (checked) patch({ enabled: true });
              else setConfirmDisable(true);
            }}
          />
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={t('pa.agentForm.disableConfirmTitle', { name: form.name.trim() || base?.name || '' })}
        description={t('pa.agentForm.enabledHint')}
        confirmLabel={t('pa.disable')}
        cancelLabel={t('pa.cancel')}
        destructive
        onConfirm={() => {
          patch({ enabled: false });
          setConfirmDisable(false);
        }}
      />
    </PaModalFrame>
  );
}
