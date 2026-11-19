// SPDX-License-Identifier: AGPL-3.0-only
// The conversation & agent inspector (spec §8): a docked (resizable 300–420) or floating panel with a layered card
// surface, an atmospheric subject hero, and three inline tabs — 动态 (needs you → in progress → scheduled routines →
// done log → channels → this device), 确认 (channel approvals, deliveries, channel status) and 档案 (soul, deliverables,
// memory, interactive group members). Clicking any agent in the header, transcript or group roster focuses that agent.
// A companion chat keeps the panel and head but shows the Soul body below the head (soul/SoulInspector: TA · 此刻 · 记忆).
import type { PaRoutine, PaRoutineInput } from '@open-design/contracts';
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  FolderOpen,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Pause,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { useDwell } from '../../components/chat/useDwell';
import { useGlideIndicator } from '../../hooks/useGlideIndicator';
import { usePresence } from '../../hooks/usePresence';
import { useI18n, useT } from '../../i18n';
import { FantayMascot, FantayMascotStill } from '../brand/FantayMascot';
import {
  Button,
  Callout,
  Dot,
  Icon,
  IconButton,
  MetaLine,
  Panel,
  PanelClose,
  Segmented,
  SegmentedItem,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
  toast,
} from '../ui';
import { usePa } from './pa-context';
import { PaModelPicker } from './PaModelPicker';
import {
  agentStatus,
  conversationKind,
  hueIndex,
  isFantay,
  isNeedsYouTask,
  predictResponders,
  projectGate,
  subjectOf,
  tasksForSubject,
} from './pa-model';
import { usePaTransport } from './pa-transport';
import type {
  PaChannel,
  PaConversation,
  PaGroup,
  PaIndex,
  PaInspectorTab,
  PaMemory,
  PaSubject,
  PaTask,
  PersonalAgent,
} from './pa-types';
import { PaAvatar, PaGroupAvatar } from './PaAvatar';
import { PaMarkdown } from './PaMarkdown';
import { conversationMode, portraitSrc } from './soul/soul-model';
import { SoulInspector, markPaneScrolled, memoryFirstLine } from './soul/SoulInspector';
import { PA_INSPECTOR, PA_ROSTER_WIDTH } from './usePaLayout';
import {
  PaApprovalCard,
  PaDayLog,
  PaDeliveryCard,
  PaNeedsYouCard,
  PaTaskRow,
  paPlatformName,
  paShortDate,
  paTryT,
} from './PaWorkCards';
import styles from './PaInspector.module.css';

const TAB_ORDER: PaInspectorTab[] = ['activity', 'approvals', 'profile'];
const MIN_WIDTH = PA_INSPECTOR.min;
const MAX_WIDTH = PA_INSPECTOR.max;
const CHAT_MIN = PA_INSPECTOR.chatMin;
/** Real wall-clock timestamps exceed one day after epoch; synthetic unit-test stamps (`createdAt: 1`) skip the date tag. */
const REAL_TIMESTAMP_FLOOR = 86_400_000;

export function PaInspector({ conversationId, surface }: { conversationId: string; surface: 'docked' | 'floating' }) {
  const { index, ui } = usePa();
  const presence = usePresence(ui.inspectorOpen, surface === 'floating' ? 150 : 160);
  const conversation = index.conversations.get(conversationId);
  const convSubject = conversation ? subjectOf(index, conversation) : null;
  if (!presence.mounted || !conversation || !convSubject) return null;

  const overrideAgent = ui.inspectorAgentId ? index.agents.get(ui.inspectorAgentId) ?? null : null;
  const isOverride = Boolean(
    overrideAgent && (convSubject.kind !== 'agent' || convSubject.agent.id !== overrideAgent.id),
  );
  const subject: PaSubject = isOverride && overrideAgent ? { kind: 'agent', agent: overrideAgent } : convSubject;

  return (
    <InspectorFrame
      conversation={conversation}
      convSubject={convSubject}
      subject={subject}
      isOverride={isOverride}
      surface={surface}
      closing={presence.closing}
    />
  );
}

/* ── frame ────────────────────────────────────────────────────────────────────────────────── */

function subjectName(subject: PaSubject): string {
  return subject.kind === 'agent' ? subject.agent.name : subject.group.name;
}

function subjectId(subject: PaSubject): string {
  return subject.kind === 'agent' ? `agent:${subject.agent.id}` : `group:${subject.group.id}`;
}

function channelTargets(channel: PaChannel, subject: PaSubject): boolean {
  return subject.kind === 'agent'
    ? channel.targetKind === 'agent' && channel.targetId === subject.agent.id
    : channel.targetKind === 'group' && channel.targetId === subject.group.id;
}

/** Inbox approvals and uncertain outbox rows whose channel routes to this subject. Fantay also takes rows whose
 *  channel can no longer be resolved, so nothing becomes unreachable. */
function confirmationsFor(index: PaIndex, subject: PaSubject) {
  const takesOrphans = subject.kind === 'agent' && isFantay(index, subject.agent.id);
  const routes = (channelId: string) => {
    const channel = index.channels.get(channelId);
    return channel ? channelTargets(channel, subject) : takesOrphans;
  };
  return {
    approvals: index.inbox.filter((row) => row.state === 'approval' && row.approvalActionable !== false && routes(row.channelId)),
    deliveries: index.outbox.filter((row) => (row.state === 'unknown' || row.state === 'failed') && routes(row.channelId)),
  };
}

function InspectorFrame({
  conversation,
  convSubject,
  subject,
  isOverride,
  surface,
  closing,
}: {
  conversation: PaConversation;
  convSubject: PaSubject;
  subject: PaSubject;
  isOverride: boolean;
  surface: 'docked' | 'floating';
  closing: boolean;
}) {
  const t = useT();
  const { index, ui, nav, layout } = usePa();
  // A companion chat shows the Soul body (TA · 此刻 · 记忆); an inspected member of a room keeps today's body.
  const companion = !isOverride && conversationMode(index, conversation) === 'companion';
  // Work tabs only: a companion tab left in the state (TA, 此刻, 记忆) opens the work tab that holds the same things.
  const workTab: PaInspectorTab = TAB_ORDER.includes(ui.inspectorTab) ? ui.inspectorTab : ui.inspectorTab === 'scene' ? 'activity' : 'profile';
  const confirmations = confirmationsFor(index, subject);
  const confirmCount = confirmations.approvals.length + confirmations.deliveries.length;
  const hasWaiting = tasksForSubject(index, subject, 'all', conversation.id).some(
    (task) => task.status === 'waiting' && isNeedsYouTask(task, index.attemptsByTask.get(task.id) ?? []),
  );

  // Tab glide and the directional pane entrance (spec §16).
  const trackRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  useGlideIndicator({
    containerRef: trackRef,
    indicatorRef: chipRef,
    activeSelector: '[role="tab"][aria-selected="true"]',
    activeKey: workTab,
    layoutKey: `${confirmCount > 0}-${hasWaiting}-${subjectId(subject)}-${companion}`,
  });
  const [tabMotion, setTabMotion] = useState<{ tab: PaInspectorTab; dir: 'next' | 'prev' | null }>({ tab: workTab, dir: null });
  if (tabMotion.tab !== workTab) {
    const step = TAB_ORDER.indexOf(workTab) - TAB_ORDER.indexOf(tabMotion.tab);
    setTabMotion({ tab: workTab, dir: step > 0 ? 'next' : 'prev' });
  }

  const rosterColumn = PA_ROSTER_WIDTH[layout.roster];
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, layout.width - rosterColumn - CHAT_MIN));
  const width = Math.min(Math.max(ui.inspectorWidth, MIN_WIDTH), maxWidth);

  const close = () => nav.setInspector(false);
  const body = (
    <>
      <div className={styles.head}>
        {isOverride ? (
          <Button
            variant="bare"
            size="sm"
            data-testid="pa-inspector-back"
            className={styles.backButton}
            onClick={() => nav.clearInspectorAgent()}
          >
            <Icon icon={ChevronLeft} size={14} />
            <span className={styles.backLabel}>{t('pa.inspector.backTo', { name: subjectName(convSubject) })}</span>
          </Button>
        ) : (
          <span className={styles.headTitle}>{companion ? t('pa.soul.inspector.title') : t('pa.inspector.title')}</span>
        )}
        <PanelClose label={paTryT(t, 'pa.state.closeInspector') ?? t('fantay.ui.close')} onClick={close} />
      </div>
      {companion ? (
        <SoulInspector conversation={conversation} subject={subject} />
      ) : (
        <>
          <InspectorHero conversation={conversation} subject={subject} isOverride={isOverride} />
          <Tabs
            value={workTab}
            onValueChange={(value) => nav.setInspector(true, value as PaInspectorTab)}
            className={styles.tabs}
          >
            <TabsList ref={trackRef} className={styles.track} aria-label={t('pa.inspector.tabs')}>
              <span ref={chipRef} className={styles.chip} aria-hidden />
              <TabsTrigger value="activity" className={styles.tab}>
                <span className={styles.tabLabel}>{t('pa.inspector.activity')}</span>
                {hasWaiting ? <span className={styles.tabDot} aria-hidden /> : null}
              </TabsTrigger>
              <TabsTrigger value="approvals" className={styles.tab}>
                <span className={styles.tabLabel}>{t('pa.inspector.approvals')}</span>
                {confirmCount > 0 ? (
                  <>
                    {' '}
                    <span className={styles.tabBadge}>{confirmCount}</span>
                  </>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="profile" className={styles.tab}>
                <span className={styles.tabLabel}>{t('pa.inspector.profile')}</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="activity" className={styles.pane} data-dir={tabMotion.dir ?? undefined} onScroll={markPaneScrolled}>
              <ActivityPane conversation={conversation} subject={subject} isOverride={isOverride} />
            </TabsContent>
            <TabsContent value="approvals" className={styles.pane} data-dir={tabMotion.dir ?? undefined} onScroll={markPaneScrolled}>
              <ApprovalsPane subject={subject} approvals={confirmations.approvals} deliveries={confirmations.deliveries} />
            </TabsContent>
            <TabsContent value="profile" className={styles.pane} data-dir={tabMotion.dir ?? undefined} onScroll={markPaneScrolled}>
              {subject.kind === 'agent' ? (
                <AgentProfile agent={subject.agent} />
              ) : (
                <GroupProfile group={subject.group} conversation={conversation} />
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </>
  );

  if (surface === 'docked') {
    return (
      <Panel
        id="pa-inspector-panel"
        surface="docked"
        data-testid="pa-inspector"
        data-state={closing ? 'closed' : 'open'}
        role="complementary"
        aria-label={subjectName(subject)}
        className={styles.docked}
        resize={{ edge: 'start', width, min: MIN_WIDTH, max: maxWidth, onResize: nav.setInspectorWidth }}
      >
        <div className={styles.content} style={{ width }}>
          {body}
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      id="pa-inspector-panel"
      surface="floating"
      data-testid="pa-inspector"
      data-state={closing ? 'closed' : 'open'}
      role="complementary"
      aria-label={subjectName(subject)}
      className={styles.floating}
      style={layout.roster === 'sheet' ? { width: Math.min(340, Math.max(240, layout.width - 24)) } : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className={styles.content}>{body}</div>
    </Panel>
  );
}

/* ── hero ─────────────────────────────────────────────────────────────────────────────────── */

/** Workspace instances (keyed by their actions object) whose hero mascot has already drifted in once. */
const appeared = new WeakSet<object>();

function FantayHeroMascot({ fantay }: { fantay: PersonalAgent }) {
  const { index, data, ui } = usePa();
  const live = ui.inspectorOpen && data.load === 'ready';

  const running = useMemo(() => {
    for (const attempts of index.attemptsByTask.values()) {
      if (attempts.some((attempt) => attempt.status === 'running' && attempt.agentSnapshot.id === fantay.id)) return true;
    }
    return false;
  }, [index, fantay.id]);
  const working = useDwell(running, 600) && !data.stale;

  // pulse: a new Fantay message after the first render.
  const seen = useRef<Set<string> | null>(null);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    const ids: string[] = [];
    for (const message of index.messages.values()) if (message.senderId === fantay.id) ids.push(message.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    let fresh = false;
    for (const id of ids) {
      if (!seen.current.has(id)) {
        seen.current.add(id);
        fresh = true;
      }
    }
    if (fresh) setPulse((value) => value + 1);
  }, [index.messages, fantay.id]);

  // flip: once after Fantay's profile is saved (its revision moves on).
  const revision = useRef(fantay.revision);
  const [flip, setFlip] = useState(0);
  useEffect(() => {
    if (fantay.revision > revision.current) setFlip((value) => value + 1);
    revision.current = fantay.revision;
  }, [fantay.revision]);

  // appear: only on the first mount within this workspace instance.
  const owner = data.actions as object;
  const [appear] = useState(() => !appeared.has(owner));
  useEffect(() => {
    appeared.add(owner);
  }, [owner]);

  if (!live) return <FantayMascotStill size={100} />;
  return (
    <FantayMascot
      size={100}
      grounded
      tracking
      interactive
      mood={working ? 'working' : 'idle'}
      pulse={pulse}
      flip={flip}
      appear={appear}
    />
  );
}

function StatusDot({ tone }: { tone: ReturnType<typeof agentStatus>['tone'] }) {
  if (tone === 'warning') return <span className={styles.ringDot} aria-hidden />;
  return <Dot size="sm" tone={tone} className={tone === 'muted' ? styles.dotMuted : undefined} />;
}

function modeLabel(t: ReturnType<typeof useT>, mode: PaGroup['mode']): string {
  return mode === 'review' ? t('pa.review') : mode === 'collaboration' ? t('pa.collaboration') : t('pa.discussion');
}

function members(index: PaIndex, group: PaGroup): PersonalAgent[] {
  return group.memberIds.map((id) => index.agents.get(id)).filter((agent): agent is PersonalAgent => !!agent);
}

function reviewerOf(group: PaGroup): string | undefined {
  return group.reviewerId ?? [...group.memberIds].reverse().find((id) => id !== group.moderatorId);
}

/** Width of an element's text as laid out on one line (a Range ignores the box, so a part cut short by an ellipsis
 *  or stretched to a full line still reports its natural width). */
function textWidth(element: Element): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  return typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect().width : 0;
}

/** The centred meta line under the hero name. While its parts fit, one line joined by quiet dots; when they do not
 *  (English at a narrow inspector), the last part moves to its own line instead of every part being cut to an ellipsis. */
function HeroMeta({ parts }: { parts: string[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const measureKey = parts.join('\u0000');

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    const check = () => {
      const line = box.firstElementChild;
      if (!line) return;
      const nodes = Array.from(line.children).filter((child) => child.getAttribute('aria-hidden') !== 'true');
      if (nodes.length < 2) {
        setStacked(false);
        return;
      }
      const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
      const natural = nodes.reduce((sum, part) => sum + textWidth(part), 0) + (nodes.length - 1) * (gap * 2 + 4);
      setStacked(natural > box.clientWidth + 0.5);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(box);
    return () => observer.disconnect();
  }, [measureKey]);

  return (
    <div ref={boxRef} className={styles.heroMetaBox} data-stacked={stacked ? 'true' : undefined}>
      <MetaLine className={styles.heroMeta}>
        {parts.map((part, position) => (
          <span key={position} className={styles.metaPart}>
            {part}
          </span>
        ))}
      </MetaLine>
    </div>
  );
}

function InspectorHero({
  conversation,
  subject,
  isOverride,
}: {
  conversation: PaConversation;
  subject: PaSubject;
  isOverride: boolean;
}) {
  const t = useT();
  const { locale } = useI18n();
  const { index, data, nav } = usePa();
  const status = agentStatus(index, data, subject);
  const statusText = paTryT(t, status.key, status.vars) ?? '';

  let avatar: ReactNode;
  let kind: 'mascot' | 'disc' | 'group';
  let bio = '';
  let meta: ReactNode;
  let heroStyle: CSSProperties | undefined;

  if (subject.kind === 'agent') {
    const agent = subject.agent;
    const fantay = isFantay(index, agent.id);
    kind = fantay ? 'mascot' : 'disc';
    if (!fantay) {
      heroStyle = { '--pa-hue': `var(--pa-id-${hueIndex(agent.id)})` } as CSSProperties;
    }
    avatar = fantay ? (
      <FantayHeroMascot fantay={agent} />
    ) : (
      <span className={styles.discFrame}>
        <PaAvatar agent={agent} size={64} fantay={false} dim={!agent.enabled} />
      </span>
    );
    bio = memoryFirstLine(agent.role);
    const parts: string[] = [];
    if (agent.tools.includes('create_project')) parts.push(t('pa.inspector.canProject'));
    if (agent.createdAt > REAL_TIMESTAMP_FLOOR) {
      parts.push(
        t('pa.inspector.createdOn', {
          date: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(agent.createdAt),
        }),
      );
    }
    meta = parts.length > 0 ? <HeroMeta parts={parts} /> : null;
  } else {
    const group = subject.group;
    const cluster = members(index, group);
    kind = cluster.length > 1 ? 'group' : 'disc';
    avatar = <PaGroupAvatar members={cluster} fantayId={index.fantay?.id ?? null} size={64} portraitOf={(agentId) => portraitSrc(index, agentId)} />;
    bio = paTryT(t, `pa.mode.${group.mode}Help`) ?? '';
    const reviewerId = reviewerOf(group);
    meta = (
      <HeroMeta
        parts={[
          t('pa.inspector.moderatorPart', { name: index.agents.get(group.moderatorId)?.name ?? '—' }),
          t('pa.inspector.reviewerPart', { reviewer: (reviewerId && index.agents.get(reviewerId)?.name) || '—' }),
          modeLabel(t, group.mode),
        ]}
      />
    );
  }

  const edit = () =>
    nav.openModal(subject.kind === 'agent' ? { kind: 'agent', agentId: subject.agent.id } : { kind: 'group', groupId: subject.group.id });

  const showMessageButton =
    subject.kind === 'agent' && (isOverride || conversationKind(conversation) !== 'direct' || conversation.agentId !== subject.agent.id);

  return (
    <div className={styles.hero} data-testid="pa-inspector-hero" data-kind={kind} style={heroStyle}>
      <span className={styles.heroAura} data-kind={kind} aria-hidden />
      <div className={styles.stage} data-kind={kind}>
        <div className={styles.avatar} data-kind={kind}>
          {avatar}
          <span className={styles.badge} data-kind={kind}>
            <IconButton size="sm" shape="round" className={styles.badgeButton} aria-label={t('pa.inspector.edit')} onClick={edit}>
              <Icon icon={Pencil} size={13} />
            </IconButton>
          </span>
        </div>
      </div>
      <h2 className={styles.heroName}>{subjectName(subject)}</h2>
      {statusText ? (
        <div className={styles.heroStatus} data-tone={status.tone}>
          <StatusDot tone={status.tone} />
          <span className={styles.heroStatusText}>{statusText}</span>
        </div>
      ) : null}
      {bio ? <p className={styles.heroBio}>{bio}</p> : null}
      {meta}
      {showMessageButton && subject.kind === 'agent' ? (
        <div className={styles.heroActions}>
          <Button
            size="sm"
            variant="secondary"
            data-testid="pa-inspector-message"
            className={styles.heroActionPill}
            onClick={() => void nav.openAgent(subject.agent.id)}
          >
            <Icon icon={MessageSquare} size={13} />
            {t('pa.inspector.messageAgent')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ── 动态 ─────────────────────────────────────────────────────────────────────────────────── */

const ACTIVE_STATUSES = new Set<PaTask['status']>(['queued', 'running', 'verifying', 'cancelling']);
const MAX_NEEDS = 3;

function routinesForSubject(routines: readonly PaRoutine[], index: PaIndex, conversation: PaConversation, subject: PaSubject): PaRoutine[] {
  return routines.filter((routine) => {
    if (routine.conversationId === conversation.id) return true;
    if (subject.kind === 'agent') {
      const target = index.conversations.get(routine.conversationId);
      return target?.agentId === subject.agent.id && !target.groupId && !target.channelId;
    }
    return false;
  });
}

function ActivityPane({
  conversation,
  subject,
  isOverride,
}: {
  conversation: PaConversation;
  subject: PaSubject;
  isOverride: boolean;
}) {
  const t = useT();
  const { index, nav } = usePa();
  const [scope, setScope] = useState<'conversation' | 'all'>(() => (isOverride ? 'all' : 'conversation'));
  const prevSubjectKey = useRef(subjectId(subject));
  if (prevSubjectKey.current !== subjectId(subject)) {
    prevSubjectKey.current = subjectId(subject);
    setScope(isOverride ? 'all' : 'conversation');
  }

  const allSubjectTasks = tasksForSubject(index, subject, 'all', conversation.id);
  const convTasks = tasksForSubject(index, subject, 'conversation', conversation.id);
  const anyWork = allSubjectTasks.length > 0;
  const tasks = scope === 'all' ? allSubjectTasks : convTasks;

  const needs: PaTask[] = [];
  const active: PaTask[] = [];
  const done: PaTask[] = [];
  for (const task of tasks) {
    const attempts = index.attemptsByTask.get(task.id) ?? [];
    if (isNeedsYouTask(task, attempts)) needs.push(task);
    else if (ACTIVE_STATUSES.has(task.status) || task.status === 'waiting') active.push(task);
    else done.push(task);
  }
  needs.sort((a, b) => b.updatedAt - a.updatedAt);
  active.sort((a, b) => a.createdAt - b.createdAt);

  const openTask = (taskId: string) => nav.openModal({ kind: 'task', taskId });

  return (
    <div className={styles.paneStack}>
      {anyWork ? (
        <Segmented
          size="sm"
          value={scope}
          onValueChange={(value) => setScope(value === 'all' ? 'all' : 'conversation')}
          aria-label={t('pa.inspector.scope')}
          className={cn('flex w-full', styles.scope)}
        >
          <SegmentedItem value="conversation" className="min-w-0 flex-1">
            {t('pa.inspector.thisChat')}
          </SegmentedItem>
          <SegmentedItem value="all" className="min-w-0 flex-1">
            {t('pa.inspector.allWork')}
          </SegmentedItem>
        </Segmented>
      ) : null}

      {needs.length ? (
        <section className={styles.section} aria-label={t('pa.inspector.needsYou')}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionLabel}>
              {t('pa.inspector.needsYou')}
              <span className={styles.sectionCount}>{needs.length}</span>
            </h3>
            <Button variant="link" size="sm" className={styles.sectionAction} onClick={() => nav.openPlace('tasks', { tasksFilter: 'needs' })}>
              {t('pa.inspector.seeAll')}
              <Icon icon={ChevronRight} size={12} />
            </Button>
          </div>
          <div className={styles.cardStack}>
            {needs.slice(0, MAX_NEEDS).map((task) => (
              <PaNeedsYouCard key={task.id} task={task} compact showConversation={scope === 'all'} />
            ))}
          </div>
        </section>
      ) : null}

      {active.length ? (
        <section className={styles.section} aria-label={t('pa.inspector.inProgress')}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionLabel}>
              {t('pa.inspector.inProgress')}
              <span className={styles.sectionCount}>{active.length}</span>
            </h3>
          </div>
          <div className={cn(styles.surfaceCard, styles.paddedCard)}>
            <div className={styles.rows}>
              {active.map((task) => (
                <PaTaskRow key={task.id} task={task} density="compact" onOpen={() => openTask(task.id)} />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <RoutinesSection conversation={conversation} subject={subject} />

      {done.length ? (
        <section className={styles.section} aria-label={t('pa.inspector.completed')}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionLabel}>
              {t('pa.inspector.completed')}
              <span className={styles.sectionCount}>{done.length}</span>
            </h3>
          </div>
          <div className={cn(styles.surfaceCard, styles.dayCard)}>
            <PaDayLog tasks={done} onOpenTask={openTask} bleed />
          </div>
        </section>
      ) : tasks.length === 0 ? (
        <div className={styles.emptyActivityCard}>
          <span className={styles.emptyActivityBadge} aria-hidden>
            <Icon icon={Sparkles} size={15} />
          </span>
          <div className={styles.emptyActivityCopy}>
            <p className={styles.emptyActivity}>{t('pa.inspector.emptyActivity', { name: subjectName(subject) })}</p>
            <p className={styles.emptyActivityHint}>{t('pa.inspector.emptyActivityHint')}</p>
          </div>
        </div>
      ) : null}

      <ChannelsSection subject={subject} />

      <DeviceCard />
    </div>
  );
}

function RoutinesSection({ conversation, subject }: { conversation: PaConversation; subject: PaSubject }) {
  const t = useT();
  const { data, index, nav } = usePa();
  const send = usePaTransport();
  const [busyId, setBusyId] = useState<string | null>(null);
  const routines = routinesForSubject(data.snapshot?.routines ?? [], index, conversation, subject);

  // Only direct agent conversations execute scheduled routines in the PA daemon; hide the routine creator for groups
  // that have none configured so we never offer an inapplicable target.
  if (subject.kind === 'group' && routines.length === 0) return null;

  const toggleRoutine = async (routine: PaRoutine, enabled: boolean) => {
    if (busyId) return;
    setBusyId(routine.id);
    const input: PaRoutineInput = {
      name: routine.name,
      prompt: routine.prompt,
      conversationId: routine.conversationId,
      time: routine.time,
      timezone: routine.timezone,
      enabled,
    };
    try {
      await send(`/routines/${routine.id}`, 'PATCH', { ...input, revision: routine.revision });
      await data.actions.refresh();
    } catch (error: unknown) {
      toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className={styles.section} aria-label={t('pa.inspector.routines')}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionLabel}>
          {t('pa.inspector.routines')}
          {routines.length > 0 ? <span className={styles.sectionCount}>{routines.length}</span> : null}
        </h3>
        {routines.length > 0 ? (
          <Button
            variant="link"
            size="sm"
            className={styles.sectionAction}
            onClick={() => nav.openPlace('activity', { activityTab: 'routines' })}
          >
            {t('pa.inspector.manageRoutines')}
            <Icon icon={ChevronRight} size={12} />
          </Button>
        ) : null}
      </div>
      <div className={styles.surfaceCard}>
        {routines.length > 0 ? (
          routines.map((routine) => (
            <div key={routine.id} className={styles.routineRow} data-enabled={routine.enabled ? 'true' : undefined}>
              <span className={styles.routineIcon} data-enabled={routine.enabled ? 'true' : undefined} aria-hidden>
                <Icon icon={Clock3} size={14} />
              </span>
              <div className={styles.routineText}>
                <div className={styles.routineName}>{routine.name}</div>
                <div className={styles.routineMeta}>
                  {routine.enabled
                    ? t('pa.inspector.routineDaily', { time: routine.time })
                    : t('pa.inspector.routineOff', { time: routine.time })}
                </div>
              </div>
              <Switch
                size="sm"
                checked={routine.enabled}
                disabled={busyId === routine.id}
                aria-label={routine.name}
                onCheckedChange={(checked) => void toggleRoutine(routine, checked)}
              />
            </div>
          ))
        ) : (
          <Button
            variant="bare"
            className={styles.quickActionRow}
            onClick={() => nav.openPlace('activity', { activityTab: 'routines' })}
          >
            <span className={styles.quickActionIcon} aria-hidden>
              <Icon icon={Clock3} size={14} />
            </span>
            <span className={styles.quickActionText}>
              <span className={styles.quickActionTitle}>{t('pa.inspector.addRoutine')}</span>
              <span className={styles.quickActionCaption}>{t('pa.inspector.emptyRoutines')}</span>
            </span>
            <Icon icon={ChevronRight} size={14} className={styles.rowChevron} />
          </Button>
        )}
      </div>
    </section>
  );
}

function channelStatusTone(channel: PaChannel): 'done' | 'warning' | 'muted' {
  if (channel.status === 'connected') return 'done';
  if (channel.status === 'login_required' || channel.status === 'error') return 'warning';
  return 'muted';
}

function channelStatusLabel(t: ReturnType<typeof useT>, channel: PaChannel): string {
  const key = channel.status === 'error' ? 'pa.channelError' : `pa.${channel.status}`;
  return paTryT(t, key) ?? channel.status;
}

function ChannelsSection({ subject }: { subject: PaSubject }) {
  const t = useT();
  const { index, nav } = usePa();
  const channels = [...index.channels.values()].filter((ch) => channelTargets(ch, subject));

  return (
    <section className={styles.section} aria-label={t('pa.inspector.channels')}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionLabel}>
          {t('pa.inspector.channels')}
          {channels.length > 0 ? <span className={styles.sectionCount}>{channels.length}</span> : null}
        </h3>
        {channels.length > 0 ? (
          <IconButton
            size="xs"
            variant="quiet"
            aria-label={t('pa.addChannel')}
            onClick={() => nav.openModal({ kind: 'channel', channelId: null })}
          >
            <Icon icon={Plus} size={13} />
          </IconButton>
        ) : null}
      </div>
      {channels.length >= 2 ? (
        <div className={styles.channelGrid}>
          {channels.map((channel) => {
            const tone = channelStatusTone(channel);
            return (
              <Button
                key={channel.id}
                variant="bare"
                className={styles.channelTile}
                onClick={() => nav.openModal({ kind: 'channel', channelId: channel.id })}
              >
                <span className={styles.channelBadge} data-platform={channel.type} aria-hidden>
                  {channel.type === 'feishu' ? '飞' : '微'}
                </span>
                <span className={styles.channelTileName}>{channel.name || paPlatformName(t, channel)}</span>
                <span className={styles.channelTileStatus}>
                  <StatusDot tone={tone} />
                  <span className={styles.channelStatusText}>{channelStatusLabel(t, channel)}</span>
                </span>
              </Button>
            );
          })}
        </div>
      ) : channels.length === 1 ? (
        <div className={styles.surfaceCard}>
          {channels.map((channel) => {
            const tone = channelStatusTone(channel);
            return (
              <Button
                key={channel.id}
                variant="bare"
                className={styles.quickActionRow}
                onClick={() => nav.openModal({ kind: 'channel', channelId: channel.id })}
              >
                <span className={styles.channelBadge} data-platform={channel.type} aria-hidden>
                  {channel.type === 'feishu' ? '飞' : '微'}
                </span>
                <span className={styles.quickActionText}>
                  <span className={styles.quickActionTitle}>
                    {paPlatformName(t, channel)} · {channel.name}
                  </span>
                  <span className={styles.channelInlineStatus}>
                    <StatusDot tone={tone} />
                    <span>{channelStatusLabel(t, channel)}</span>
                  </span>
                </span>
                <Icon icon={ChevronRight} size={14} className={styles.rowChevron} />
              </Button>
            );
          })}
        </div>
      ) : (
        <div className={styles.surfaceCard}>
          <Button
            variant="bare"
            className={styles.quickActionRow}
            onClick={() => nav.openModal({ kind: 'channel', channelId: null })}
          >
            <span className={styles.quickActionIcon} aria-hidden>
              <Icon icon={MessagesSquare} size={14} />
            </span>
            <span className={styles.quickActionText}>
              <span className={styles.quickActionTitle}>{t('pa.inspector.connectChannels')}</span>
              <span className={styles.quickActionCaption}>
                {t('pa.inspector.connectChannelsHint', { name: subjectName(subject) })}
              </span>
            </span>
            <Icon icon={ChevronRight} size={14} className={styles.rowChevron} />
          </Button>
        </div>
      )}
    </section>
  );
}

function DeviceCard() {
  const t = useT();
  const { data, nav } = usePa();
  const control = data.control;
  const [busy, setBusy] = useState(false);
  const paused = control?.paused ?? false;
  const asleep = control?.suspended ?? false;

  let caption: string | null = null;
  if (control) {
    if (control.paused) caption = t('pa.inspector.devicePaused');
    else if (control.suspended) caption = t('pa.inspector.deviceAsleep');
    else caption = t('pa.inspector.deviceRunning', { active: control.activeCount, pending: control.pendingCount });
  }

  const toggle = () => {
    if (!control || busy) return;
    setBusy(true);
    void data.actions
      .patchControl({ paused: !control.paused })
      .catch((error: unknown) => toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) }))
      .finally(() => setBusy(false));
  };

  return (
    <div className={styles.device}>
      <span className={styles.deviceBadge} data-live={!paused && !asleep && Boolean(control) ? 'true' : undefined} aria-hidden>
        <Icon icon={Monitor} size={15} className={styles.deviceIcon} />
        <span className={styles.deviceIndicator} />
      </span>
      <div className={styles.deviceText}>
        <div className={styles.deviceTitleRow}>
          <span className={styles.deviceTitle}>{t('pa.inspector.device')}</span>
          {control ? <span className={styles.deviceMetaPill}>{t('pa.inspector.deviceCap', { max: control.maxConcurrent })}</span> : null}
        </div>
        {caption ? <div className={styles.deviceCaption}>{caption}</div> : null}
      </div>
      <IconButton
        size="xs"
        aria-label={paused ? t('pa.resumeAll') : t('pa.pauseAll')}
        disabled={!control || busy}
        onClick={toggle}
      >
        <Icon icon={paused ? Play : Pause} size={13} />
      </IconButton>
      <IconButton size="xs" aria-label={t('pa.connections')} onClick={() => nav.openPlace('connections')}>
        <Icon icon={ChevronRight} size={14} />
      </IconButton>
    </div>
  );
}

/* ── 确认 ─────────────────────────────────────────────────────────────────────────────────── */

function ApprovalsPane({
  subject,
  approvals,
  deliveries,
}: {
  subject: PaSubject;
  approvals: PaIndex['inbox'];
  deliveries: PaIndex['outbox'];
}) {
  const t = useT();
  return (
    <div className={styles.paneStack}>
      {approvals.length === 0 && deliveries.length === 0 ? (
        <div className={styles.emptyApprovals}>
          <span className={styles.emptyApprovalsBadge} aria-hidden>
            <Icon icon={ShieldCheck} size={20} className={styles.emptyIcon} />
          </span>
          <div className={styles.emptyTitle}>{t('pa.inspector.emptyApprovalsTitle')}</div>
          <p className={styles.emptyBody}>{t('pa.inspector.emptyApprovalsBody', { name: subjectName(subject) })}</p>
        </div>
      ) : (
        <div className={styles.cardStack} data-gap="loose" data-fill-actions="true">
          {approvals.map((row) => (
            <PaApprovalCard key={row.id} inbox={row} />
          ))}
          {deliveries.map((row) => (
            <PaDeliveryCard key={row.id} outbox={row} />
          ))}
        </div>
      )}
      <ChannelsSection subject={subject} />
    </div>
  );
}

/* ── 档案 ─────────────────────────────────────────────────────────────────────────────────── */

function latest(memories: PaMemory[]): number | null {
  return memories.length ? Math.max(...memories.map((memory) => memory.updatedAt)) : null;
}

function MemoryCard({
  count,
  label,
  updated,
  onOpen,
}: {
  count: number;
  label: string;
  updated: number | null;
  onOpen(): void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const { now } = usePa();
  return (
    <Button variant="bare" className={styles.memoryCard} data-empty={count === 0 ? 'true' : undefined} onClick={onOpen}>
      <span className={styles.memoryCount}>{count}</span>
      <span className={styles.memoryLabel}>{label}</span>
      {updated !== null ? (
        <span className={styles.memoryUpdated}>{t('pa.inspector.updated', { date: paShortDate(updated, now, locale) })}</span>
      ) : null}
    </Button>
  );
}

/** Role prose clamped to six lines, with 展开 / 收起 only when it overflows. */
function ClampedProse({ text }: { text: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const check = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [text, expanded]);

  return (
    <>
      <div ref={ref} className={styles.soulText} data-clamped={expanded ? undefined : 'true'} data-overflows={overflows ? 'true' : undefined}>
        <PaMarkdown text={text} />
      </div>
      {overflows || expanded ? (
        <Button variant="link" size="sm" className={styles.expand} onClick={() => setExpanded((value) => !value)}>
          {expanded
            ? paTryT(t, 'pa.chat.collapse') ?? t('fantay.ui.collapse')
            : paTryT(t, 'pa.chat.expand') ?? t('fantay.ui.expand')}
        </Button>
      ) : null}
    </>
  );
}

function AgentProfile({ agent }: { agent: PersonalAgent }) {
  const t = useT();
  const { locale } = useI18n();
  const { index, nav, projects, onOpenProject, now } = usePa();
  const memories = [...index.memories.values()];
  const privateMemories = memories.filter((memory) => memory.scope === 'private');
  const agentMemories = memories.filter((memory) => memory.scope === 'agent' && memory.scopeId === agent.id);
  const recent = [...privateMemories, ...agentMemories].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const privateLabel = t('pa.inspector.privateMemory');
  const agentLabel = t('pa.inspector.agentMemory', { name: agent.name });

  const deliverables = useMemo(() => {
    const byProject = new Map<string, { id: string; name: string; files: number; firstPath?: string }>();
    for (const task of tasksForSubject(index, { kind: 'agent', agent }, 'all', '')) {
      const arts = index.artifactsByTask.get(task.id) ?? [];
      for (const art of arts) {
        const existing = byProject.get(art.projectId);
        if (existing) {
          existing.files += 1;
        } else {
          const proj = projects.find((p) => p.id === art.projectId);
          byProject.set(art.projectId, {
            id: art.projectId,
            name: proj?.name || task.projectName || art.projectId,
            files: 1,
            firstPath: art.path,
          });
        }
      }
    }
    return [...byProject.values()];
  }, [agent, index, projects]);

  return (
    <div className={styles.paneStack}>
      <div className={styles.soul}>
        <div className={styles.cardHeaderRow}>
          <h3 className={styles.cardLabel}>{t('pa.model')}</h3>
        </div>
        <div className={styles.profileModelRow}>
          <PaModelPicker agent={agent} variant="profile" />
        </div>
      </div>

      <div className={styles.soul}>
        <div className={styles.cardHeaderRow}>
          <h3 className={styles.cardLabel}>{t('pa.inspector.soul')}</h3>
          <Button
            variant="link"
            size="sm"
            className={styles.sectionAction}
            onClick={() => nav.openModal({ kind: 'agent', agentId: agent.id })}
          >
            {t('pa.inspector.editProfile')}
          </Button>
        </div>
        <ClampedProse text={agent.role} />
        <div className={styles.capabilityRow}>
          {agent.tools.includes('respond') ? <span className={styles.capabilityTag}>{t('pa.inspector.canRespond')}</span> : null}
          {agent.tools.includes('create_project') ? (
            <span className={styles.capabilityTag}>{t('pa.inspector.canProject')}</span>
          ) : null}
        </div>
      </div>

      {deliverables.length > 0 ? (
        <section className={styles.section} aria-label={t('pa.inspector.deliverables')}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionLabel}>
              {t('pa.inspector.deliverables')}
              <span className={styles.sectionCount}>{deliverables.length}</span>
            </h3>
          </div>
          <div className={styles.surfaceCard}>
            {deliverables.map((item) => (
              <Button
                key={item.id}
                variant="bare"
                className={styles.quickActionRow}
                onClick={() => onOpenProject(item.id, item.firstPath)}
              >
                <span className={styles.quickActionIcon} aria-hidden>
                  <Icon icon={FolderOpen} size={14} />
                </span>
                <span className={styles.quickActionText}>
                  <span className={styles.quickActionTitle}>{item.name}</span>
                  <span className={styles.quickActionCaption}>{t('pa.tasks.fileCount', { count: item.files })}</span>
                </span>
                <Icon icon={ChevronRight} size={14} className={styles.rowChevron} />
              </Button>
            ))}
          </div>
        </section>
      ) : null}

      <div className={styles.memoryGrid}>
        <MemoryCard
          count={privateMemories.length}
          label={privateLabel}
          updated={latest(privateMemories)}
          onOpen={() => nav.openPlace('memory', { memoryFilter: 'private' })}
        />
        <MemoryCard
          count={agentMemories.length}
          label={agentLabel}
          updated={latest(agentMemories)}
          onOpen={() => nav.openPlace('memory', { memoryFilter: 'agent' })}
        />
      </div>

      <section className={styles.section} aria-label={t('pa.inspector.recent')}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionLabel}>{t('pa.inspector.recent')}</h3>
          <Button
            variant="link"
            size="sm"
            className={styles.sectionAction}
            onClick={() => nav.openModal({ kind: 'memory', memoryId: null, preset: { scope: 'agent', scopeId: agent.id } })}
          >
            <Icon icon={Plus} size={12} />
            {t('pa.inspector.addMemory')}
          </Button>
        </div>
        <div className={styles.surfaceCard}>
          {recent.length ? (
            <div className={styles.recentRows}>
              {recent.map((memory) => (
                <Button
                  key={memory.id}
                  variant="bare"
                  className={styles.recentRow}
                  onClick={() => nav.openModal({ kind: 'memory', memoryId: memory.id })}
                >
                  <span className={styles.recentText}>{memoryFirstLine(memory.content)}</span>
                  <MetaLine className={styles.recentMeta}>
                    <span className={styles.metaPart}>{memory.scope === 'private' ? privateLabel : agentLabel}</span>
                    <span className={styles.metaPart}>{memory.source}</span>
                    <span className={styles.tabular}>{paShortDate(memory.updatedAt, now, locale)}</span>
                  </MetaLine>
                </Button>
              ))}
            </div>
          ) : (
            <p className={styles.quietLine}>{t('pa.inspector.noRecent')}</p>
          )}
        </div>
        <Button variant="link" size="sm" className={styles.seeAll} onClick={() => nav.openPlace('memory', { memoryFilter: 'all' })}>
          {t('pa.inspector.allMemory')}
          <Icon icon={ChevronRight} size={12} />
        </Button>
      </section>
    </div>
  );
}

function GroupProfile({ group, conversation }: { group: PaGroup; conversation: PaConversation }) {
  const t = useT();
  const { index, nav } = usePa();
  const reviewerId = reviewerOf(group);
  const roster = members(index, group);

  const gate = projectGate(index, conversation);
  let sameModel: { producer: string; reviewer: string } | null = null;
  if (!gate.ok && gate.reason === 'sameModel') {
    const order = predictResponders(index, conversation, { text: '', replyTo: null, project: true }).ids;
    const producer = order.at(-2);
    const reviewer = order.at(-1);
    sameModel = {
      producer: (producer && index.agents.get(producer)?.name) || '—',
      reviewer: (reviewer && index.agents.get(reviewer)?.name) || '—',
    };
  }

  const memories = [...index.memories.values()];
  const groupMemories = memories.filter((memory) => memory.scope === 'group' && memory.scopeId === group.id);
  const projectIds = new Set(
    (index.tasksByConversation.get(group.conversationId) ?? [])
      .map((task) => task.projectId)
      .filter((id): id is string => !!id),
  );
  const projectMemories = memories.filter(
    (memory) => memory.scope === 'project' && memory.scopeId !== null && projectIds.has(memory.scopeId),
  );
  const help = paTryT(t, `pa.mode.${group.mode}Help`);

  return (
    <div className={styles.paneStack}>
      <section className={styles.section} aria-label={t('pa.members')}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionLabel}>
            {t('pa.members')}
            <span className={styles.sectionCount}>{roster.length}</span>
          </h3>
        </div>
        <div className={styles.members}>
          {roster.map((member) => {
            const model = index.models.get(`${member.model.runtime}/${member.model.modelId}`);
            const role =
              member.id === group.moderatorId
                ? t('pa.inspector.roleModerator')
                : member.id === reviewerId
                  ? t('pa.inspector.roleReviewer')
                  : null;
            return (
              <Button
                key={member.id}
                variant="bare"
                data-testid="pa-group-member"
                className={styles.memberRow}
                data-disabled={member.enabled ? undefined : 'true'}
                aria-label={t('pa.inspector.inspectMember', { name: member.name })}
                onClick={() => nav.inspectAgent(member.id)}
              >
                <PaAvatar agent={member} size={28} fantay={isFantay(index, member.id)} disc dim={!member.enabled} />
                <span className={styles.memberText}>
                  <span className={styles.memberLine}>
                    <span className={styles.memberName}>{member.name}</span>
                    {role ? <span className={styles.roleBadge}>{role}</span> : null}
                  </span>
                  <span className={styles.memberModel}>{model?.label ?? member.model.modelId}</span>
                </span>
                {member.enabled ? (
                  <Icon icon={ChevronRight} size={14} className={styles.rowChevron} />
                ) : (
                  <span className={styles.memberDisabled}>{t('pa.disabled')}</span>
                )}
              </Button>
            );
          })}
        </div>
      </section>

      <div className={styles.modeBlock}>
        <div className={styles.cardHeaderRow}>
          <h3 className={styles.cardLabel}>{t('pa.mode')}</h3>
          <Button
            variant="link"
            size="sm"
            className={styles.sectionAction}
            onClick={() => nav.openModal({ kind: 'group', groupId: group.id })}
          >
            {t('pa.inspector.editGroup')}
          </Button>
        </div>
        <div className={styles.modeName}>{modeLabel(t, group.mode)}</div>
        {help ? <p className={styles.modeHelp}>{help}</p> : null}
        {sameModel ? <Callout className={styles.callout}>{t('pa.inspector.sameModel', sameModel)}</Callout> : null}
      </div>

      <div className={styles.memoryGrid}>
        <MemoryCard
          count={groupMemories.length}
          label={t('pa.inspector.groupMemory')}
          updated={latest(groupMemories)}
          onOpen={() => nav.openPlace('memory', { memoryFilter: 'group' })}
        />
        <MemoryCard
          count={projectMemories.length}
          label={t('pa.inspector.projectMemory')}
          updated={latest(projectMemories)}
          onOpen={() => nav.openPlace('memory', { memoryFilter: 'project' })}
        />
      </div>
    </div>
  );
}
