// SPDX-License-Identifier: AGPL-3.0-only
// 文风 (modal kind `preset`, Soul UI spec 7.5): how replies are written. Name and description, four full-width option
// rows, six switches, and the prompt texts and sampling behind two styled disclosures. A built-in style opens
// read-only with 复制一份来改, which saves a user copy and opens it.
import { useId, useMemo, useState } from 'react';
import { SOUL_LIMITS, toPresetInput } from '@open-design/contracts/soul';
import type { PaStylePresetDoc } from '@open-design/contracts/soul';

import { useT } from '../../../i18n';
import { Button, Callout, ConfirmDialog, Input, ModalSpacer, Segmented, SegmentedItem, Textarea, toast } from '../../ui';
import { usePa } from '../pa-context';
import { PaModalFrame, PaSwitchRow, paErrorText, usePaModalReset, usePaReload, usePaSubmit } from '../PaAgentModal';
import { PaDisclosure } from '../PaDisclosure';
import type { PaStylePreset, PaStylePresetInput } from '../pa-types';
import modalStyles from '../PaModals.module.css';
import { SoulDiscardDialog, SoulField, sameJson, useSoulArrival, useSoulDiscard } from './SoulProfileModal';
import { SoulNumberInput } from './SoulStateFieldsEditor';
import styles from './SoulProfileModal.module.css';

const L = SOUL_LIMITS;
const NEW_PRESET: PaStylePresetDoc = {
  name: '',
  description: '',
  main: '',
  postHistory: '',
  format: 'im',
  replyLength: 'short',
  narration: 'none',
  userAgency: 'strict',
  tempo: 'normal',
  multiBubble: true,
  timeAware: true,
  suggestChoices: false,
  mood: true,
  playRequests: false,
  extra: '',
  sampling: {},
};

const OPTION_ROWS = [
  {
    field: 'format',
    label: 'pa.soul.manage.preset.format',
    items: [
      ['im', 'pa.soul.manage.preset.format.im'],
      ['prose', 'pa.soul.manage.preset.format.prose'],
      ['script', 'pa.soul.manage.preset.format.script'],
    ],
  },
  {
    field: 'replyLength',
    label: 'pa.soul.manage.preset.length',
    items: [
      ['short', 'pa.soul.manage.preset.length.short'],
      ['medium', 'pa.soul.manage.preset.length.medium'],
      ['long', 'pa.soul.manage.preset.length.long'],
    ],
  },
  {
    field: 'narration',
    label: 'pa.soul.manage.preset.narration',
    items: [
      ['none', 'pa.soul.manage.preset.narration.none'],
      ['first', 'pa.soul.manage.preset.narration.first'],
      ['second', 'pa.soul.manage.preset.narration.second'],
      ['third', 'pa.soul.manage.preset.narration.third'],
    ],
  },
  {
    field: 'tempo',
    label: 'pa.soul.manage.preset.tempo',
    items: [
      ['slow', 'pa.soul.manage.preset.tempo.slow'],
      ['normal', 'pa.soul.manage.preset.tempo.normal'],
      ['fast', 'pa.soul.manage.preset.tempo.fast'],
    ],
  },
] as const;

const SWITCHES = [
  { field: 'multiBubble', label: 'pa.soul.manage.preset.multiBubble', hint: 'pa.soul.manage.preset.multiBubbleHint' },
  { field: 'timeAware', label: 'pa.soul.manage.preset.timeAware' },
  { field: 'suggestChoices', label: 'pa.soul.manage.preset.choices' },
  { field: 'mood', label: 'pa.soul.manage.preset.mood' },
  { field: 'playRequests', label: 'pa.soul.manage.preset.play' },
] as const;

const SAMPLING = [
  { field: 'temperature', label: 'pa.soul.manage.preset.temperature', min: 0, max: 2, integer: false },
  { field: 'topP', label: 'pa.soul.manage.preset.topP', min: 0, max: 1, integer: false },
  { field: 'maxTokens', label: 'pa.soul.manage.preset.maxTokens', min: 64, max: 8192, integer: true },
] as const;

export interface SoulPresetModalProps {
  open: boolean;
  onClose(): void;
  presetId: string | null;
}

function docOf(preset: PaStylePreset | null): PaStylePresetDoc {
  return preset ? toPresetInput(preset) : NEW_PRESET;
}

function samplingValid(sampling: PaStylePresetDoc['sampling']): boolean {
  return SAMPLING.every(({ field, min, max, integer }) => {
    const value = sampling[field];
    return value === undefined || (value >= min && value <= max && (!integer || Number.isInteger(value)));
  });
}

export function SoulPresetModal({ open, onClose, presetId }: SoulPresetModalProps) {
  const t = useT();
  const { data, index, nav } = usePa();
  const entity = presetId ? (index.presets.get(presetId) ?? null) : null;
  const builtin = Boolean(entity?.builtin);
  const [base, setBase] = useState<PaStylePreset | null>(entity);
  const [pristine, setPristine] = useState<PaStylePresetDoc>(() => docOf(entity));
  const [form, setForm] = useState<PaStylePresetDoc>(pristine);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const submit = usePaSubmit();
  const reload = usePaReload(builtin ? null : entity, (latest) => setBase(latest));
  const resetForm = () => {
    const next = docOf(entity);
    setBase(entity);
    setPristine(next);
    setForm(next);
    setConfirmDelete(false);
    submit.clear();
    reload.cancel();
  };
  usePaModalReset(open, presetId ?? 'new', resetForm);
  useSoulArrival(data.snapshot !== null && data.soul !== null, resetForm);

  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const patch = (next: Partial<PaStylePresetDoc>) => setForm((current) => ({ ...current, ...next }));
  const dirty = useMemo(() => !builtin && !sameJson(form, pristine), [builtin, form, pristine]);
  const close = useSoulDiscard(dirty, onClose);
  const name = form.name.trim();
  const blocked =
    name === '' ||
    form.name.length > L.presetName ||
    form.description.length > L.presetDescription ||
    form.main.length > L.presetMain ||
    form.postHistory.length > L.presetPostHistory ||
    form.extra.length > L.presetExtra ||
    !samplingValid(form.sampling);

  const save = () => {
    if (builtin || blocked || submit.busy) return;
    if (base && !dirty) {
      onClose();
      return;
    }
    const input: PaStylePresetInput = { ...form, name };
    const held = base;
    void submit
      .run(
        () => data.actions.savePreset(input, held ?? undefined),
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

  const copy = () => {
    if (!entity || submit.busy) return;
    let createdId: string | null = null;
    void submit
      .run(async () => {
        const created = await data.actions.savePreset({ ...toPresetInput(entity), name: t('pa.soul.manage.preset.copyName', { name: entity.name }).slice(0, L.presetName) });
        createdId = created.id;
      })
      .then((ok) => {
        if (ok && createdId) nav.openModal({ kind: 'preset', presetId: createdId });
      });
  };

  const remove = async () => {
    if (!base || deleting) return;
    setDeleting(true);
    try {
      await data.actions.removePreset(base);
      setConfirmDelete(false);
      onClose();
    } catch (caught) {
      setConfirmDelete(false);
      submit.setError(paErrorText(caught, t));
    } finally {
      setDeleting(false);
    }
  };

  const title = builtin && entity ? entity.name : presetId ? t('pa.soul.manage.preset.titleEdit') : t('pa.soul.manage.preset.titleNew');
  const textArea = (field: 'main' | 'postHistory' | 'extra', label: string, max: number, rows: number) => (
    <SoulField id={id(field)} label={label} text={form[field]} max={builtin ? undefined : max} tokens>
      <Textarea
        id={id(field)}
        rows={rows}
        value={form[field]}
        disabled={builtin}
        aria-invalid={form[field].length > max || undefined}
        onChange={(event) => {
          const next: Partial<PaStylePresetDoc> = {};
          next[field] = event.target.value;
          patch(next);
        }}
      />
    </SoulField>
  );

  return (
    <PaModalFrame
      open={open}
      onClose={() => close.guard()}
      size="lg"
      title={title}
      conflict={submit.conflict}
      error={submit.error}
      onSubmit={builtin ? undefined : save}
      testId="pa-preset-modal"
      bodyClassName={modalStyles.bodyStack}
      footer={
        builtin ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('fantay.ui.close')}
            </Button>
            <Button variant="primary" loading={submit.busy} onClick={copy} data-testid="pa-preset-copy">
              {t('pa.soul.manage.preset.copy')}
            </Button>
          </>
        ) : (
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
        )
      }
    >
      {builtin ? (
        <Callout tone="neutral" role="note">
          {t('pa.soul.manage.preset.builtinNote')}
        </Callout>
      ) : null}

      <div className={styles.grid2}>
        <SoulField id={id('name')} label={t('pa.soul.manage.preset.name')} text={form.name} max={builtin ? undefined : L.presetName}>
          <Input
            id={id('name')}
            value={form.name}
            required
            disabled={builtin}
            autoFocus={presetId === null}
            autoComplete="off"
            aria-invalid={form.name.length > L.presetName || undefined}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </SoulField>
        <SoulField id={id('description')} label={t('pa.soul.manage.preset.description')} text={form.description} max={builtin ? undefined : L.presetDescription}>
          <Input
            id={id('description')}
            value={form.description}
            disabled={builtin}
            autoComplete="off"
            aria-invalid={form.description.length > L.presetDescription || undefined}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </SoulField>
      </div>

      <div className={modalStyles.group}>
        {OPTION_ROWS.map((row) => (
          <div key={row.field} className={modalStyles.optionRow}>
            <span className={modalStyles.optionLabel}>{t(row.label)}</span>
            <Segmented
              size="md"
              className="flex w-full"
              aria-label={t(row.label)}
              value={form[row.field]}
              disabled={builtin}
              onValueChange={(value) => patch({ [row.field]: value } as Partial<PaStylePresetDoc>)}
            >
              {row.items.map(([item, label]) => (
                <SegmentedItem key={item} value={item} className="min-w-0 flex-1" disabled={builtin}>
                  {t(label)}
                </SegmentedItem>
              ))}
            </Segmented>
          </div>
        ))}
      </div>

      <div className={modalStyles.group}>
        {SWITCHES.map((item) => (
          <PaSwitchRow
            key={item.field}
            label={t(item.label)}
            hint={'hint' in item ? t(item.hint) : undefined}
            checked={form[item.field]}
            disabled={builtin}
            onChange={(on) => patch({ [item.field]: on } as Partial<PaStylePresetDoc>)}
          />
        ))}
        <PaSwitchRow
          label={t('pa.soul.manage.preset.agency')}
          checked={form.userAgency === 'strict'}
          disabled={builtin}
          onChange={(on) => patch({ userAgency: on ? 'strict' : 'allow' })}
        />
      </div>

      <div className={modalStyles.disclosures}>
        <PaDisclosure className={modalStyles.sectionDisclosure} label={t('pa.soul.manage.preset.prompts')}>
          <div className="flex flex-col gap-4 px-1 pb-1 pt-2">
            {textArea('main', t('pa.soul.manage.preset.main'), L.presetMain, 6)}
            {textArea('postHistory', t('pa.soul.manage.preset.post'), L.presetPostHistory, 3)}
            {textArea('extra', t('pa.soul.manage.preset.extra'), L.presetExtra, 3)}
          </div>
        </PaDisclosure>
        <PaDisclosure className={modalStyles.sectionDisclosure} label={t('pa.soul.manage.preset.sampling')}>
          <div className="flex flex-col gap-2 px-1 pb-1 pt-2">
            <div className="grid grid-cols-3 gap-3">
              {SAMPLING.map(({ field, label, min, max, integer }) => {
                const value = form.sampling[field];
                const bad = value !== undefined && (value < min || value > max || (integer && !Number.isInteger(value)));
                return (
                  <SoulField key={field} id={id(field)} label={t(label)}>
                    <SoulNumberInput
                      id={id(field)}
                      value={value}
                      disabled={builtin}
                      invalid={bad}
                      align="start"
                      placeholder={t('pa.soul.manage.preset.followModel')}
                      onChange={(next) => {
                        const sampling = { ...form.sampling };
                        if (next === undefined) delete sampling[field];
                        else sampling[field] = next;
                        patch({ sampling });
                      }}
                    />
                  </SoulField>
                );
              })}
            </div>
            <p className={modalStyles.fieldHint}>{t('pa.soul.manage.preset.samplingNote')}</p>
          </div>
        </PaDisclosure>
      </div>

      <SoulDiscardDialog unit="manage" {...close.dialog} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(next) => {
          if (!deleting) setConfirmDelete(next);
        }}
        title={t('pa.soul.manage.preset.confirmTitle', { name: base?.name ?? '' })}
        description={t('pa.soul.manage.preset.confirmBody')}
        confirmLabel={t('pa.delete')}
        cancelLabel={t('pa.cancel')}
        destructive
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </PaModalFrame>
  );
}
