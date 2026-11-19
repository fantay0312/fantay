// SPDX-License-Identifier: AGPL-3.0-only
// 任务 page (spec §9) under the 工作 title and its tab strip (Soul UI spec §6.3): a summary sentence, a full-width
// four-way filter, and per segment the needs-you cards, the active rows, a day log of ended work, or the delivered
// projects.
import { useMemo, useState, type ReactNode } from 'react';
import { Activity, FolderOpen, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useI18n, useT } from '../../i18n';
import { FantayMascotStill } from '../brand/FantayMascot';
import { Button, EmptyState, Icon, MetaLine, Segmented, SegmentedItem, Skeleton, cn } from '../ui';
import { PaApprovalCard, PaDayLog, PaDeliveryCard, PaNeedsYouCard, PaTaskRow } from './PaWorkCards';
import { PaArtifactRow, formatDay } from './PaTaskModal';
import { usePa } from './pa-context';
import { SoulWorkTabs } from './soul/SoulWorkTabs';
import type { PaArtifact, PaChannelInbox, PaChannelOutbox, PaTask, PaTasksFilter } from './pa-types';
import styles from './PaPages.module.css';

const DAY_MS = 86_400_000;
/** 进行中 order: work on a slot, then the queue, then the tasks that wait on their own (Fantay paused, device
    asleep; `paAutoWait`, shown with the muted 等待中 word), which continue by themselves after the queue. Every
    other waiting task is in 需要你; without the `waiting` rank the auto-waiting ones would be in no segment. */
const ACTIVE_ORDER: Partial<Record<PaTask['status'], number>> = { running: 0, verifying: 1, cancelling: 2, queued: 3, waiting: 4 };
const ENDED: ReadonlySet<PaTask['status']> = new Set(['completed', 'failed', 'cancelled']);
const FILES_SHOWN = 4;

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

interface ProjectDeliverable {
  projectId: string;
  name: string;
  files: PaArtifact[]; // write order, as in the result card
  latest: PaArtifact | null;
  latestAt: number;
}

export function PaTasksPage() {
  const { data, index, ui, nav, projects, onOpenProject, now } = usePa();
  const t = useT();
  const { locale } = useI18n();
  const [days, setDays] = useState(7);

  const tasks = useMemo(() => [...index.workTasks.values()], [index]);
  const needs = index.needs;
  const approvals = useMemo(
    () => needs.flatMap((need): PaChannelInbox[] => (need.kind === 'approval' ? [need.inbox] : [])),
    [needs],
  );
  const deliveries = useMemo(
    () => needs.flatMap((need): PaChannelOutbox[] => (need.kind === 'delivery' ? [need.outbox] : [])),
    [needs],
  );
  const waiting = useMemo(() => needs.flatMap((need): PaTask[] => (need.kind === 'task' ? [need.task] : [])), [needs]);

  const active = useMemo(() => {
    // A waiting task belongs here exactly when 需要你 does not hold it, so it is never in two segments or none: that
    // is the auto-wait set (`paAutoWait`), and stays complete if the needs-you rule and the stored kind disagree.
    const needIds = new Set(waiting.map((task) => task.id));
    return tasks
      .filter((task) => (task.status === 'waiting' ? !needIds.has(task.id) : ACTIVE_ORDER[task.status] !== undefined))
      .sort((a, b) => (ACTIVE_ORDER[a.status] ?? 9) - (ACTIVE_ORDER[b.status] ?? 9) || a.createdAt - b.createdAt);
  }, [tasks, waiting]);
  const queuedCount = active.filter((task) => task.status === 'queued').length;
  // The summary's 进行中 + 排队 add up to the 进行中 segment count (a task that waits on its own counts as active).
  const runningCount = active.length - queuedCount;

  const ended = useMemo(() => tasks.filter((task) => ENDED.has(task.status)).sort((a, b) => b.updatedAt - a.updatedAt), [tasks]);
  const cutoff = startOfDay(now) - (days - 1) * DAY_MS;
  const endedShown = useMemo(() => ended.filter((task) => task.updatedAt >= cutoff), [ended, cutoff]);
  const hasEarlier = endedShown.length < ended.length;

  const deliverables = useMemo<ProjectDeliverable[]>(() => {
    const byProject = new Map<string, PaArtifact[]>();
    for (const list of index.artifactsByTask.values()) {
      for (const artifact of list) {
        const bucket = byProject.get(artifact.projectId);
        if (bucket) bucket.push(artifact);
        else byProject.set(artifact.projectId, [artifact]);
      }
    }
    return [...byProject.entries()]
      .map(([projectId, files]) => {
        const sorted = [...files].sort((a, b) => a.createdAt - b.createdAt);
        const latest = sorted[sorted.length - 1] ?? null;
        const task = tasks.find((item) => item.projectId === projectId) ?? index.tasks.get(latest?.taskId ?? '') ?? null;
        const name = projects.find((project) => project.id === projectId)?.name || task?.projectName || t('pa.taskDetail.kindProject');
        return { projectId, name, files: sorted, latest, latestAt: latest?.createdAt ?? 0 };
      })
      .sort((a, b) => b.latestAt - a.latestAt);
  }, [index, tasks, projects, t]);

  const filter: PaTasksFilter = ui.tasksFilter ?? (needs.length > 0 ? 'needs' : 'active');
  const counts: Record<PaTasksFilter, number> = {
    needs: needs.length,
    active: active.length,
    ended: ended.length,
    deliverables: deliverables.length,
  };
  const openTask = (taskId: string) => nav.openModal({ kind: 'task', taskId });
  const loading = data.load === 'loading' && !data.snapshot;

  let content: ReactNode;
  if (loading) {
    content = (
      <div className={styles.skeletonStack}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} shape="row" index={i} />
        ))}
      </div>
    );
  } else if (filter === 'needs') {
    content =
      needs.length === 0 ? (
        <QuietEmpty icon={ShieldCheck} text={t('pa.tasks.emptyNeeds')} />
      ) : (
        <div className={styles.groups}>
          {approvals.length > 0 ? (
            <Group title={t('pa.tasks.approvals')} count={approvals.length}>
              {approvals.map((inbox) => (
                <PaApprovalCard key={inbox.id} inbox={inbox} />
              ))}
            </Group>
          ) : null}
          {deliveries.length > 0 ? (
            <Group title={t('pa.tasks.deliveries')} count={deliveries.length}>
              {deliveries.map((outbox) => (
                <PaDeliveryCard key={outbox.id} outbox={outbox} />
              ))}
            </Group>
          ) : null}
          {waiting.length > 0 ? (
            <Group title={t('pa.tasks.waiting')} count={waiting.length}>
              {waiting.map((task) => (
                <PaNeedsYouCard key={task.id} task={task} showConversation />
              ))}
            </Group>
          ) : null}
        </div>
      );
  } else if (filter === 'active') {
    content =
      active.length === 0 ? (
        <QuietEmpty icon={Activity} text={t('pa.tasks.emptyActive')} />
      ) : (
        <div className={styles.rowGroup}>
          {active.map((task) => (
            <PaTaskRow key={task.id} task={task} density="regular" showConversation onOpen={() => openTask(task.id)} />
          ))}
        </div>
      );
  } else if (filter === 'ended') {
    content =
      ended.length === 0 ? (
        <EmptyState
          variant="dashed"
          className={styles.empty}
          illustration={<FantayMascotStill size={48} />}
          title={t('pa.tasks.emptyEndedTitle')}
          description={t('pa.tasks.emptyEnded')}
        />
      ) : (
        <>
          <PaDayLog tasks={endedShown} openDays={2} onOpenTask={openTask} />
          {hasEarlier ? (
            <div className={styles.more}>
              <Button variant="ghost" size="sm" onClick={() => setDays((value) => value + 7)}>
                {t('pa.tasks.showEarlier')}
              </Button>
            </div>
          ) : null}
        </>
      );
  } else {
    content =
      deliverables.length === 0 ? (
        <QuietEmpty icon={FolderOpen} text={t('pa.tasks.emptyDeliverables')} />
      ) : (
        <div className={styles.projects}>
          {deliverables.map((project) => {
            const latest = project.latest;
            const extra = project.files.length - FILES_SHOWN;
            return (
              <section key={project.projectId} className={styles.project} data-testid="pa-deliverable">
                <div className={styles.projectHead}>
                  <span className={styles.projectTile} aria-hidden>
                    <Icon icon={FolderOpen} size={16} />
                  </span>
                  <div className={styles.projectTitle}>
                    <h3 className={styles.projectName}>{project.name}</h3>
                    <MetaLine className={styles.projectMeta}>
                      <span>{t('pa.tasks.fileCount', { count: project.files.length })}</span>
                      <span>{formatDay(project.latestAt, now, locale)}</span>
                    </MetaLine>
                  </div>
                  {latest?.dataClass !== 'local_only' && !latest?.privateStorage ? (
                    <Button size="sm" variant="default" onClick={() => onOpenProject(project.projectId, latest?.path)}>
                      {t('pa.openProject')}
                    </Button>
                  ) : null}
                </div>
                <div className={styles.projectFiles}>
                  {project.files.slice(0, FILES_SHOWN).map((artifact) => (
                    <PaArtifactRow key={artifact.id} artifact={artifact} onOpen={() => onOpenProject(project.projectId, artifact.path)} />
                  ))}
                  {extra > 0 && latest ? (
                    <Button variant="link" size="sm" className={styles.moreFiles} onClick={() => openTask(latest.taskId)}>
                      {t('pa.result.moreFiles', { count: extra })}
                    </Button>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      );
  }

  const label = (key: PaTasksFilter): string =>
    key === 'needs'
      ? t('pa.tasks.needs')
      : key === 'active'
        ? t('pa.tasks.active')
        : key === 'ended'
          ? t('pa.tasks.ended')
          : t('pa.tasks.deliverables');

  return (
    <div className={styles.page} data-testid="pa-tasks-page">
      <div className={styles.inner}>
        <header className={styles.head}>
          <div className={styles.headText}>
            <h1 className={styles.title}>{t('pa.soul.shell.work.title')}</h1>
            <p className={styles.summary}>
              {t('pa.tasks.summary', {
                active: runningCount,
                queued: queuedCount,
                needs: needs.length,
                max: data.control?.maxConcurrent ?? '—',
              })}
            </p>
          </div>
        </header>
        <SoulWorkTabs />
        <Segmented
          size="md"
          className={cn('flex w-full', styles.filter)}
          value={filter}
          onValueChange={(value) => nav.setTasksFilter(value as PaTasksFilter)}
          aria-label={t('pa.tasks.filter')}
        >
          {(['needs', 'active', 'ended', 'deliverables'] as const).map((key) => (
            <SegmentedItem key={key} value={key} className="min-w-0 flex-1" data-testid={`pa-tasks-filter-${key}`}>
              <span className={styles.segLabel}>{label(key)}</span>
              {counts[key] > 0 ? (
                <span className={styles.segCount}>{counts[key]}</span>
              ) : null}
            </SegmentedItem>
          ))}
        </Segmented>
        <div key={filter} className={styles.content}>
          {content}
        </div>
      </div>
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className={styles.groupBlock}>
      <h2 className={styles.groupTitle}>
        {title}
        <span className={styles.groupCount}>{count}</span>
      </h2>
      <div className={styles.cards}>{children}</div>
    </section>
  );
}

/** A calm, top-aligned empty state: an outline glyph and one line, no call to action (Muse #2). */
function QuietEmpty({ icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className={styles.quiet}>
      <span className={styles.quietTile} aria-hidden>
        <Icon icon={icon} size={22} />
      </span>
      <p className={styles.quietText}>{text}</p>
    </div>
  );
}
