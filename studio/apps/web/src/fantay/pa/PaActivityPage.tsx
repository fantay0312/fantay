// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState } from 'react';
import type { PaFeedItem, PaGoal, PaGoalInput, PaRoutine, PaRoutineInput } from '@open-design/contracts';
import { useI18n, useT } from '../../i18n';
import {
  Button, Callout, CheckboxField, ConfirmDialog, Field, Input, Segmented, SegmentedItem,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea,
} from '../ui';
import { PaModalFrame, paErrorText, usePaSubmit } from './PaAgentModal';
import { usePa } from './pa-context';
import { usePaTransport } from './pa-transport';
import page from './PaPages.module.css';
import styles from './PaActivityPage.module.css';

const TABS = ['activity', 'goals', 'routines'] as const;
type Tab = typeof TABS[number];
type Editor = { kind: 'goals'; item?: PaGoal } | { kind: 'routines'; item?: PaRoutine };
interface FeedPage { items: PaFeedItem[]; nextBefore: number | null }

export function PaActivityPage({ active }: { active: boolean }) {
  const { t, locale } = useI18n();
  const { data, index, nav, ui } = usePa();
  const send = usePaTransport();
  const [tab, setTab] = useState<Tab>(ui.activityTab ?? 'activity');
  useEffect(() => {
    if (ui.activityTab) setTab(ui.activityTab);
  }, [ui.activityTab]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [remove, setRemove] = useState<Editor | null>(null);
  const mutation = usePaSubmit();
  const goals = data.snapshot?.goals ?? [];
  const routines = data.snapshot?.routines ?? [];
  return (
    <section className={page.page} data-testid="pa-activity-page">
      <div className={page.inner}>
        <header className={page.head}>
          <div className={page.headText}>
            <h1 className={page.title}>{t('pa.work.activity')}</h1>
            <p className={page.summary}>{t('pa.work.intro')}</p>
          </div>
          {tab !== 'activity' ? (
            <Button variant="primary" onClick={() => setEditor({ kind: tab })}>
              {t(tab === 'goals' ? 'pa.work.newGoal' : 'pa.work.newRoutine')}
            </Button>
          ) : null}
        </header>
        <Segmented className={page.filter} value={tab} onValueChange={(value) => { if (value) { mutation.clear(); setTab(value as Tab); } }} aria-label={t('pa.work.activity')}>
          {TABS.map(value => <SegmentedItem className="min-w-0 flex-1" key={value} value={value}>{t(`pa.work.${value}`)}</SegmentedItem>)}
        </Segmented>
        {mutation.error ? <Callout tone="error" role="alert">{mutation.error}</Callout> : null}
        {mutation.conflict ? <Callout tone="neutral" role="status">{t('pa.agentForm.conflict')}</Callout> : null}
        {tab === 'activity' ? <Feed active={active} /> : null}
        {tab === 'goals' ? (
          <div className={styles.list}>
            {!goals.length ? <p className={page.hint}>{t('pa.work.noGoals')}</p> : null}
            {goals.map(goal => {
              const tasks = goal.taskIds.flatMap(id => { const task = index.tasks.get(id); return task ? [task] : []; });
              return (
                <article className={styles.entry} key={goal.id}>
                  <div className={styles.heading}>
                    <h2>{goal.name}</h2>
                    <Button size="sm" variant="ghost" onClick={() => setEditor({ kind: 'goals', item: goal })}>{t('pa.edit')}</Button>
                  </div>
                  {goal.description ? <p>{goal.description}</p> : null}
                  <p>{t('pa.work.goalProgress', { done: tasks.filter(task => task.status === 'completed').length, total: tasks.length })}</p>
                  {tasks.map(task => (
                    <Button key={task.id} variant="link" className={styles.taskLink} onClick={() => nav.openTaskTurn(task.id)}>
                      {task.goal} · {t(`pa.${task.status}`)}
                    </Button>
                  ))}
                </article>
              );
            })}
          </div>
        ) : null}
        {tab === 'routines' ? (
          <div className={styles.list}>
            <p className={page.hint}>{t('pa.work.routineHelp')}</p>
            {!routines.length ? <p className={page.hint}>{t('pa.work.noRoutines')}</p> : null}
            {routines.map(routine => {
              const task = routine.lastTaskId ? index.tasks.get(routine.lastTaskId) : undefined;
              return (
                <article className={styles.entry} key={routine.id}>
                  <div className={styles.heading}>
                    <h2>{routine.name}</h2>
                    <Button size="sm" variant="ghost" onClick={() => setEditor({ kind: 'routines', item: routine })}>{t('pa.edit')}</Button>
                  </div>
                  <p>{routine.enabled && routine.nextRunAt
                    ? t('pa.work.nextRun', {
                      time: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: routine.timezone }).format(routine.nextRunAt),
                      zone: routine.timezone,
                    })
                    : t('pa.work.scheduleOff')}</p>
                  {routine.lastError ? <p role="status">{routine.lastError}</p> : null}
                  <div className={styles.actions}>
                    <Button size="sm" disabled={mutation.busy || data.control?.paused || data.control?.suspended ||
                      !!task && !['completed', 'failed', 'cancelled'].includes(task.status)}
                      onClick={() => void mutation.run(async () => {
                        await send(`/routines/${routine.id}/run`, 'POST', { revision: routine.revision });
                        await data.actions.refresh();
                      }, () => void data.actions.refresh())}>{t('pa.work.runNow')}</Button>
                    {task ? <Button size="sm" variant="ghost" onClick={() => nav.openTaskTurn(task.id)}>{t(`pa.${task.status}`)}</Button> : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
      </div>
      {editor ? <PlanEditor editor={editor} onClose={() => setEditor(null)} onDelete={() => { setRemove(editor); setEditor(null); }} /> : null}
      <ConfirmDialog open={remove !== null} onOpenChange={open => { if (!open) setRemove(null); }}
        title={t('pa.work.deleteTitle')} description={t('pa.work.deleteBody')} confirmLabel={t('pa.delete')}
        cancelLabel={t('pa.cancel')} destructive busy={mutation.busy}
        onConfirm={() => {
          if (!remove?.item) return;
          const { kind, item } = remove;
          void mutation.run(async () => {
            await send(`/${kind}/${item.id}`, 'DELETE', { revision: item.revision });
            await data.actions.refresh();
          }, () => void data.actions.refresh()).then(() => setRemove(null));
        }} />
    </section>
  );
}

function Feed({ active }: { active: boolean }) {
  const { t, locale } = useI18n();
  const { index, nav } = usePa();
  const send = usePaTransport();
  const [cursor, setCursor] = useState<number | null>(null);
  const [result, setResult] = useState<FeedPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    const load = () => {
      void send<FeedPage>(cursor === null ? '/feed' : `/feed?before=${cursor}`, 'GET', undefined, abort.signal)
        .then(value => { if (!abort.signal.aborted) { setResult(value); setError(null); } })
        .catch(cause => { if (!abort.signal.aborted) setError(paErrorText(cause, t)); });
    };
    load();
    const timer = cursor === null ? setInterval(load, 8000) : undefined;
    return () => { abort.abort(); clearInterval(timer); };
  }, [active, cursor, send, t]);
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className={styles.list} aria-busy={!result && !error}>
      {error ? <Callout tone="error" role="alert">{error}</Callout> : null}
      {!result && !error ? <p className={page.hint}>{t('pa.loading')}</p> : null}
      {result?.items.length === 0 ? <p className={page.hint}>{t('pa.work.noActivity')}</p> : null}
      {result?.items.map(item => {
        const task = item.taskId ? index.tasks.get(item.taskId) : undefined;
        return (
          <article className={styles.entry} key={item.sequence}>
            <div className={styles.heading}>
              <h2>{t(`pa.work.event.${item.kind}`)}</h2>
              <time dateTime={new Date(item.at).toISOString()}>{time.format(item.at)}</time>
            </div>
            {task ? <Button variant="link" className={styles.taskLink} onClick={() => nav.openTaskTurn(task.id)}>{task.goal}</Button>
              : item.kind === 'channel.send_unconfirmed' ? <Button variant="link" onClick={() => nav.openPlace('connections')}>{t('pa.connections')}</Button> : null}
          </article>
        );
      })}
      <div className={styles.actions}>
        {cursor !== null ? <Button onClick={() => { setResult(null); setCursor(null); }}>{t('pa.work.latest')}</Button> : null}
        {result?.nextBefore ? <Button onClick={() => { setCursor(result.nextBefore); setResult(null); }}>{t('pa.work.older')}</Button> : null}
      </div>
    </div>
  );
}

function PlanEditor({ editor, onClose, onDelete }: { editor: Editor; onClose(): void; onDelete(): void }) {
  const t = useT();
  const { data, index } = usePa();
  const send = usePaTransport();
  const mutation = usePaSubmit();
  const ids = useId();
  const goal = editor.kind === 'goals' ? editor.item : undefined;
  const routine = editor.kind === 'routines' ? editor.item : undefined;
  const conversations = [...index.conversations.values()].filter(chat => {
    const agent = chat.agentId ? index.agents.get(chat.agentId) : undefined;
    return !chat.groupId && !chat.channelId && agent?.enabled && agent.tools.includes('respond') && agent.model.runtime !== 'tokentosea';
  });
  const [name, setName] = useState(editor.item?.name ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  const [taskIds, setTaskIds] = useState(goal?.taskIds ?? []);
  const [query, setQuery] = useState('');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [conversationId, setConversationId] = useState(routine?.conversationId ?? conversations[0]?.id ?? '');
  const [time, setTime] = useState(routine?.time ?? '09:00');
  const [timezone, setTimezone] = useState(routine?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [enabled, setEnabled] = useState(routine?.enabled ?? false);
  const valid = !!name.trim() && (editor.kind === 'goals' || !!prompt.trim() &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) && !!timezone.trim() &&
    (conversations.some(chat => chat.id === conversationId) || !!routine && !enabled));
  const tasks = [...index.tasks.values()].reverse().filter(task => taskIds.includes(task.id) || task.goal.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const submit = () => {
    if (!valid) return;
    const input: PaGoalInput | PaRoutineInput = editor.kind === 'goals'
      ? { name, description, taskIds }
      : { name, prompt, conversationId, time, timezone: timezone.trim(), enabled };
    const item = editor.item;
    void mutation.run(async () => {
      await send(item ? `/${editor.kind}/${item.id}` : `/${editor.kind}`, item ? 'PATCH' : 'POST',
        item ? { ...input, revision: item.revision } : input);
      await data.actions.refresh();
    }, () => void data.actions.refresh()).then(ok => { if (ok) onClose(); });
  };
  return (
    <PaModalFrame open onClose={() => { if (!mutation.busy) onClose(); }} size="md" title={t(editor.item ? 'pa.edit' : editor.kind === 'goals' ? 'pa.work.newGoal' : 'pa.work.newRoutine')}
      onSubmit={submit} error={mutation.error} conflict={mutation.conflict} footer={<>
        {editor.item ? <Button variant="ghost" disabled={mutation.busy} onClick={onDelete}>{t('pa.delete')}</Button> : null}
        <Button variant="ghost" disabled={mutation.busy} onClick={onClose}>{t('pa.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!valid} loading={mutation.busy}>{t('pa.save')}</Button>
      </>}>
      <Field label={t('pa.name')} htmlFor={`${ids}-name`} labelVariant="form">
        <Input id={`${ids}-name`} value={name} maxLength={120} onChange={event => setName(event.target.value)} required />
      </Field>
      {editor.kind === 'goals' ? <>
        <Field label={t('pa.work.goalNotes')} htmlFor={`${ids}-notes`} labelVariant="form">
          <Textarea id={`${ids}-notes`} value={description} rows={3} maxLength={4000} onChange={event => setDescription(event.target.value)} />
        </Field>
        <Field label={t('pa.work.goalTasks')} htmlFor={`${ids}-query`} labelVariant="form">
          <Input id={`${ids}-query`} value={query} onChange={event => setQuery(event.target.value)} />
        </Field>
        <div className={styles.taskChoices}>
          {!tasks.length ? <p className={page.hint}>{t('pa.work.noMatches')}</p> : null}
          {tasks.map(task => <CheckboxField key={task.id} label={task.goal} checked={taskIds.includes(task.id)}
            disabled={taskIds.length >= 100 && !taskIds.includes(task.id)}
            onChange={event => setTaskIds(ids => event.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} />)}
        </div>
      </> : <>
        <Field label={t('pa.work.routineChat')} htmlFor={`${ids}-chat`} labelVariant="form">
          <Select value={conversationId} onValueChange={setConversationId}>
            <SelectTrigger id={`${ids}-chat`} className="w-full"><SelectValue placeholder={t('pa.work.chooseChat')} /></SelectTrigger>
            <SelectContent>{conversations.map(chat => <SelectItem key={chat.id} value={chat.id}>{chat.title}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label={t('pa.work.routinePrompt')} htmlFor={`${ids}-prompt`} labelVariant="form">
          <Textarea id={`${ids}-prompt`} value={prompt} rows={4} maxLength={32000} onChange={event => setPrompt(event.target.value)} required />
        </Field>
        <Field label={t('pa.work.routineTime')} htmlFor={`${ids}-time`} labelVariant="form">
          <Input id={`${ids}-time`} type="time" value={time} onChange={event => setTime(event.target.value)} required />
        </Field>
        <Field label={t('pa.work.timezone')} htmlFor={`${ids}-zone`} labelVariant="form">
          <Input id={`${ids}-zone`} value={timezone} maxLength={100} onChange={event => setTimezone(event.target.value)} required />
        </Field>
        <CheckboxField label={t('pa.work.scheduleOn')} checked={enabled} onChange={event => setEnabled(event.target.checked)} />
        <p className={page.hint}>{t('pa.work.routineHelp')}</p>
      </>}
    </PaModalFrame>
  );
}
