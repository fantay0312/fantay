// SPDX-License-Identifier: AGPL-3.0-only
// Group create/edit modal (spec §14.2): name, 1–12 members, moderator, reviewer, mode, and the
// same-model warning that mirrors the daemon's producer/reviewer rule.
import { useId, useState } from 'react';
import { useT } from '../../i18n';
import {
  Button,
  Callout,
  Checkbox,
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
} from '../ui';
import { usePa } from './pa-context';
import { isFantay } from './pa-model';
import { PaAvatar } from './PaAvatar';
import { modelKeyOf, PaModalFrame, usePaModalReset, usePaReload, usePaSubmit } from './PaAgentModal';
import { useSoulArrival } from './soul/SoulProfileModal';
import type { PaGroup, PaGroupInput, PaIndex, PersonalAgent } from './pa-types';
import styles from './PaModals.module.css';

const MAX_MEMBERS = 12;
const AUTO = '__auto__';
const MODES = ['discussion', 'collaboration', 'review'] as const;
const MODE_HELP = {
  discussion: 'pa.mode.discussionHelp',
  collaboration: 'pa.mode.collaborationHelp',
  review: 'pa.mode.reviewHelp',
} as const;

interface GroupForm {
  name: string;
  memberIds: string[];
  moderatorId: string;
  /** null = automatic (the last member other than the moderator). */
  reviewerId: string | null;
  mode: PaGroupInput['mode'];
}

/** Fantay first, then the snapshot order. */
function rosterAgents(index: PaIndex): PersonalAgent[] {
  const agents = [...index.agents.values()];
  const fantayId = index.fantay?.id;
  return [...agents.filter((agent) => agent.id === fantayId), ...agents.filter((agent) => agent.id !== fantayId)];
}

function autoReviewer(form: Pick<GroupForm, 'memberIds' | 'moderatorId'>): string | null {
  return form.memberIds.filter((id) => id !== form.moderatorId).at(-1) ?? null;
}

/** Keeps explicit roles assigned to eligible members. */
function normalize(form: GroupForm): GroupForm {
  const moderatorId = form.memberIds.includes(form.moderatorId) ? form.moderatorId : (form.memberIds[0] ?? '');
  const valid = form.reviewerId !== null && form.memberIds.includes(form.reviewerId) && form.reviewerId !== moderatorId;
  const reviewerId = valid ? form.reviewerId : null;
  return { ...form, moderatorId, reviewerId };
}

function groupForm(group: PaGroup | null, index: PaIndex): GroupForm {
  if (group) {
    return {
      name: group.name,
      memberIds: [...group.memberIds],
      moderatorId: group.moderatorId,
      reviewerId: group.reviewerId ?? null,
      mode: group.mode,
    };
  }
  const memberIds = rosterAgents(index)
    .filter((agent) => agent.enabled)
    .slice(0, MAX_MEMBERS)
    .map((agent) => agent.id);
  return { name: '', memberIds, moderatorId: memberIds[0] ?? '', reviewerId: null, mode: 'discussion' };
}

export function PaGroupModal({ open, onClose, groupId }: { open: boolean; onClose(): void; groupId: string | null }) {
  const t = useT();
  const { data, index, nav } = usePa();
  const entity = groupId ? (index.groups.get(groupId) ?? null) : null;
  const [base, setBase] = useState<PaGroup | null>(entity);
  const [form, setForm] = useState<GroupForm>(() => groupForm(entity, index));
  const submit = usePaSubmit();
  const reload = usePaReload(entity, (latest) => {
    setBase(latest);
    setForm(groupForm(latest, index));
  });
  usePaModalReset(open, groupId ?? 'new', () => {
    setBase(entity);
    setForm(groupForm(entity, index));
    submit.clear();
    reload.cancel();
  });
  // Opened before the first snapshot (a lab deep link): fill the form once the data arrives.
  useSoulArrival(data.snapshot !== null, () => {
    setBase(entity);
    setForm(groupForm(entity, index));
  });

  const ids = { name: useId(), moderator: useId(), reviewer: useId() };
  const agents = rosterAgents(index);
  const members = form.memberIds.map((id) => index.agents.get(id)).filter((agent): agent is PersonalAgent => Boolean(agent));
  const update = (next: Partial<GroupForm>) => setForm((current) => normalize({ ...current, ...next }));

  const resolvedReviewerId = form.reviewerId ?? autoReviewer(form);
  const producer = index.agents.get(form.moderatorId);
  const reviewer = resolvedReviewerId ? index.agents.get(resolvedReviewerId) : undefined;
  const sameModel = members.length >= 2 && !!producer && !!reviewer && modelKeyOf(producer.model) === modelKeyOf(reviewer.model);

  const valid =
    form.name.trim().length > 0 &&
    form.memberIds.length >= 1 &&
    form.memberIds.length <= MAX_MEMBERS &&
    form.memberIds.includes(form.moderatorId) &&
    form.reviewerId !== form.moderatorId;

  const save = () => {
    if (!valid || submit.busy) return;
    const input: PaGroupInput = {
      name: form.name.trim(),
      memberIds: form.memberIds,
      moderatorId: form.moderatorId,
      reviewerId: form.reviewerId,
      mode: form.mode,
    };
    const held = base;
    void submit
      .run(
        () => data.actions.saveGroup(input, held ?? undefined),
        () => {
          if (held) reload.expect(held.revision);
        },
      )
      .then((ok) => {
        if (ok) onClose();
      });
  };

  const modelLabel = (agent: PersonalAgent) => index.models.get(modelKeyOf(agent.model))?.label ?? modelKeyOf(agent.model);
  const autoName = autoReviewer(form);

  return (
    <PaModalFrame
      open={open}
      onClose={onClose}
      size="lg"
      title={groupId ? t('pa.groupForm.editTitle') : t('pa.newGroup')}
      conflict={submit.conflict}
      error={submit.error}
      onSubmit={save}
      footer={
        <>
          {/* A saved group chat whose members all have a character can be a companion chat: its per-chat settings
              live in 对话设置 (Soul UI spec 7.8). */}
          {base && base.memberIds.length > 0 && base.memberIds.every((memberId) => index.characters.has(memberId)) ? (
            <>
              <Button variant="ghost" onClick={() => nav.openModal({ kind: 'chatSettings', conversationId: base.conversationId })}>
                {t('pa.soul.manage.group.settings')}
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
      <Field label={t('pa.name')} htmlFor={ids.name} labelVariant="form">
        <Input
          id={ids.name}
          value={form.name}
          maxLength={80}
          required
          autoComplete="off"
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
        />
      </Field>

      <Field
        label={t('pa.members')}
        labelVariant="form"
        hint={form.memberIds.length ? t('pa.groupForm.membersCount', { count: form.memberIds.length, max: MAX_MEMBERS }) : undefined}
        error={form.memberIds.length ? undefined : t('pa.groupForm.needMember')}
      >
        {/* A hairline list (one checkbox row per agent) rather than a wall of selected cards: the
            checkboxes carry the state, the list stays quiet with all twelve members ticked. */}
        <div className={styles.group} role="group" aria-label={t('pa.members')}>
          {agents.map((agent) => {
            const checked = form.memberIds.includes(agent.id);
            const blocked = !checked && form.memberIds.length >= MAX_MEMBERS;
            return (
              <label
                key={agent.id}
                className={styles.memberRow}
                data-disabled={blocked ? '' : undefined}
                data-inactive={agent.enabled ? undefined : ''}
              >
                <Checkbox
                  checked={checked}
                  disabled={blocked}
                  onChange={(event) =>
                    update({
                      memberIds: event.target.checked ? [...form.memberIds, agent.id] : form.memberIds.filter((id) => id !== agent.id),
                    })
                  }
                />
                <PaAvatar agent={agent} size={24} fantay={isFantay(index, agent.id)} dim={!agent.enabled} />
                <span className={styles.memberName}>{agent.name}</span>
                <span className={styles.memberModel}>
                  {agent.enabled ? modelLabel(agent) : `${modelLabel(agent)} · ${t('pa.disabled')}`}
                </span>
              </label>
            );
          })}
        </div>
      </Field>

      <div className={styles.fields}>
        <Field label={t('pa.moderator')} htmlFor={ids.moderator} labelVariant="form">
          <Select value={form.moderatorId} onValueChange={(id) => update({ moderatorId: id })} disabled={!members.length}>
            <SelectTrigger id={ids.moderator} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {members.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('pa.reviewer')} htmlFor={ids.reviewer} labelVariant="form">
          <Select
            value={form.reviewerId ?? AUTO}
            onValueChange={(id) => update({ reviewerId: id === AUTO ? null : id })}
          >
            <SelectTrigger id={ids.reviewer} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>
                {autoName && index.agents.get(autoName)
                  ? `${t('pa.groupForm.reviewerAuto')} · ${index.agents.get(autoName)?.name}`
                  : t('pa.groupForm.reviewerAuto')}
              </SelectItem>
              {members
                .filter((agent) => agent.id !== form.moderatorId)
                .map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label={t('pa.mode')} labelVariant="form">
        <Segmented
          size="md"
          className="flex w-full"
          aria-label={t('pa.mode')}
          value={form.mode}
          onValueChange={(mode) => update({ mode: mode as PaGroupInput['mode'] })}
        >
          {MODES.map((mode) => (
            <SegmentedItem key={mode} value={mode} className="min-w-0 flex-1">
              {t(`pa.${mode}`)}
            </SegmentedItem>
          ))}
        </Segmented>
        <p className={styles.help}>{t(MODE_HELP[form.mode])}</p>
      </Field>

      {sameModel ? <Callout tone="neutral">{t('pa.groupForm.sameModel')}</Callout> : null}
    </PaModalFrame>
  );
}
