// SPDX-License-Identifier: AGPL-3.0-only
// 我的人设 (modal kind `persona`, Soul UI spec 7.4): who the characters think you are. Avatar, name, an introduction and
// the default switch; the first persona is always the default. Delete confirms first.
import { useMemo, useState } from 'react';
import { SOUL_LIMITS } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import { Button, ConfirmDialog, Input, ModalSpacer, Textarea, toast } from '../../ui';
import { paSoulAssetUrl } from '../pa-api';
import { usePa } from '../pa-context';
import { PaModalFrame, PaSwitchRow, paErrorText, usePaModalReset, usePaReload, usePaSubmit } from '../PaAgentModal';
import type { PaPersona, PaPersonaInput } from '../pa-types';
import modalStyles from '../PaModals.module.css';
import { SoulPortrait } from './SoulPortrait';
import { SoulDiscardDialog, SoulField, useSoulArrival, useSoulDiscard, useSoulImageUpload } from './SoulProfileModal';
import styles from './SoulProfileModal.module.css';

const L = SOUL_LIMITS;

export interface SoulPersonaModalProps {
  open: boolean;
  onClose(): void;
  personaId: string | null;
}

interface PersonaForm {
  name: string;
  description: string;
  avatarAssetId: string | null;
  isDefault: boolean;
}

function personaForm(persona: PaPersona | null, first: boolean): PersonaForm {
  return persona
    ? { name: persona.name, description: persona.description, avatarAssetId: persona.avatarAssetId, isDefault: persona.isDefault }
    : { name: '', description: '', avatarAssetId: null, isDefault: first };
}

export function SoulPersonaModal({ open, onClose, personaId }: SoulPersonaModalProps) {
  const t = useT();
  const { data, index } = usePa();
  const entity = personaId ? (index.personas.get(personaId) ?? null) : null;
  // The first persona is always the default: creating the first one, or editing the only one.
  const onlyOne = entity ? index.personas.size <= 1 : index.personas.size === 0;
  const [base, setBase] = useState<PaPersona | null>(entity);
  const [pristine, setPristine] = useState<PersonaForm>(() => personaForm(entity, onlyOne));
  const [form, setForm] = useState<PersonaForm>(pristine);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const submit = usePaSubmit();
  const reload = usePaReload(entity, (latest) => setBase(latest));
  const resetForm = () => {
    const next = personaForm(entity, onlyOne);
    setBase(entity);
    setPristine(next);
    setForm(next);
    setConfirmDelete(false);
    submit.clear();
    reload.cancel();
  };
  usePaModalReset(open, personaId ?? 'new', resetForm);
  useSoulArrival(data.snapshot !== null && data.soul !== null, resetForm);
  const upload = useSoulImageUpload((avatarAssetId) => setForm((current) => ({ ...current, avatarAssetId })), { crop: true });
  const patch = (next: Partial<PersonaForm>) => setForm((current) => ({ ...current, ...next }));

  const dirty = useMemo(
    () =>
      form.name !== pristine.name ||
      form.description !== pristine.description ||
      form.avatarAssetId !== pristine.avatarAssetId ||
      form.isDefault !== pristine.isDefault,
    [form, pristine],
  );
  const close = useSoulDiscard(dirty, onClose);
  const name = form.name.trim();
  const blocked = name === '' || form.name.length > L.personaName || form.description.length > L.personaDescription;
  const ids = { name: 'pa-persona-name', description: 'pa-persona-description' };

  const save = () => {
    if (blocked || submit.busy) return;
    if (base && !dirty) {
      onClose();
      return;
    }
    const input: PaPersonaInput = {
      name,
      description: form.description,
      avatarAssetId: form.avatarAssetId,
      isDefault: onlyOne ? true : form.isDefault,
    };
    const held = base;
    void submit
      .run(
        () => data.actions.savePersona(input, held ?? undefined),
        () => {
          if (held) reload.expect(held.revision);
        },
      )
      .then((ok) => {
        if (!ok) return;
        toast({ tone: 'success', title: t('pa.soul.manage.saved') });
        onClose();
      });
  };

  const remove = async () => {
    if (!base || deleting) return;
    setDeleting(true);
    try {
      await data.actions.removePersona(base);
      setConfirmDelete(false);
      onClose();
    } catch (caught) {
      setConfirmDelete(false);
      submit.setError(paErrorText(caught, t));
    } finally {
      setDeleting(false);
    }
  };

  const src = upload.preview ?? paSoulAssetUrl(form.avatarAssetId);

  return (
    <PaModalFrame
      open={open}
      onClose={() => close.guard()}
      size="md"
      title={personaId ? t('pa.soul.manage.persona.titleEdit') : t('pa.soul.manage.persona.titleNew')}
      conflict={submit.conflict}
      error={submit.error}
      onSubmit={save}
      testId="pa-persona-modal"
      bodyClassName={modalStyles.bodyStack}
      footer={
        <>
          {base ? (
            <Button variant="ghost" className={modalStyles.dangerQuiet} disabled={submit.busy} onClick={() => setConfirmDelete(true)}>
              {t('pa.delete')}
            </Button>
          ) : null}
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
      <div className="flex items-center gap-4">
        <SoulPortrait src={src} name={name || '·'} size={64} frame="circle" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-label font-medium text-ink-soft">{t('pa.soul.manage.persona.avatar')}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" loading={upload.busy} onClick={upload.choose}>
              {t('pa.soul.manage.persona.change')}
            </Button>
            {form.avatarAssetId ? (
              <Button variant="bare" size="sm" onClick={() => patch({ avatarAssetId: null })}>
                {t('pa.soul.manage.persona.remove')}
              </Button>
            ) : null}
          </div>
          {upload.error ? (
            <p role="alert" className={styles.portraitError}>
              {upload.error}
            </p>
          ) : null}
          {upload.input}
          {upload.dialog}
        </div>
      </div>

      <SoulField id={ids.name} label={t('pa.soul.manage.persona.name')} hint={t('pa.soul.manage.persona.nameHint')} text={form.name} max={L.personaName}>
        <Input
          id={ids.name}
          value={form.name}
          required
          autoFocus={personaId === null}
          autoComplete="off"
          aria-invalid={form.name.length > L.personaName || undefined}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </SoulField>

      <SoulField
        id={ids.description}
        label={t('pa.soul.manage.persona.description')}
        hint={t('pa.soul.manage.persona.descriptionHint')}
        text={form.description}
        max={L.personaDescription}
        tokens
      >
        <Textarea
          id={ids.description}
          rows={6}
          value={form.description}
          aria-invalid={form.description.length > L.personaDescription || undefined}
          onChange={(event) => patch({ description: event.target.value })}
        />
      </SoulField>

      <div className={modalStyles.group}>
        <PaSwitchRow
          label={t('pa.soul.manage.persona.default')}
          hint={t('pa.soul.manage.persona.defaultHint')}
          checked={onlyOne ? true : form.isDefault}
          disabled={onlyOne}
          onChange={(isDefault) => patch({ isDefault })}
        />
      </div>

      <SoulDiscardDialog unit="manage" {...close.dialog} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(next) => {
          if (!deleting) setConfirmDelete(next);
        }}
        title={t('pa.soul.manage.persona.confirmTitle', { name: base?.name ?? '' })}
        description={t('pa.soul.manage.persona.confirmBody')}
        confirmLabel={t('pa.delete')}
        cancelLabel={t('pa.cancel')}
        destructive
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </PaModalFrame>
  );
}
