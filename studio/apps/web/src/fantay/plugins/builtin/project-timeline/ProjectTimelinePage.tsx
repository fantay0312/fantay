// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Project, WorkspaceCollabContext } from '@open-design/contracts';
import { Folder, ListTree, Lock, RefreshCw, X } from 'lucide-react';

import { useWorkspaceContext } from '../../../../collab/useWorkspaceContext';
import { resolveWorkspaceResourceReadIdentity, workspaceResourceReadIdentityKey } from '../../../../collab/workspace-identity';
import { useI18n } from '../../../../i18n';
import { navigate, useRoute } from '../../../../router';
import { useTokenToSeaSession } from '../../../account/use-tokentosea-session';
import { useProjectOrganization } from '../../../shell/project-organization-store';
import { expandSidebarSection, setSidebarProjectExpanded } from '../../../shell/sidebar-store';
import { Avatar } from '../../../ui/avatar';
import { Button } from '../../../ui/button';
import { Callout } from '../../../ui/callout';
import { Modal, ModalTitle } from '../../../ui/dialog';
import { SearchField } from '../../../ui/search-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs';
import { Textarea } from '../../../ui/textarea';
import { TIMELINE_COPY, TIMELINE_NAME, type TimelineCopy } from './copy';
import { TimelineEntryDetails } from './TimelineEntry';
import { TimelineFeed } from './TimelineFeed';
import { buildTimeline, showsInFollowing, sortTimeline, timelineFollowTarget, TIMELINE_ORDERS, UPDATE_LIMIT } from './timeline-model';
import { saveTimelineNote, timelineStoragePrefix } from './timeline-storage';
import { notifyTimelineNotesChanged, useTimelineNotes } from './use-timeline-notes';
import { useTimelinePreferences } from './use-timeline-preferences';
import { useProjectTimeline } from './use-project-timeline';
import styles from './timeline.module.css';

const SHOW_COUNT = 24;
const NO_PROJECT = 'none';
const PROJECT_VALUE_PREFIX = 'project:';

export function ProjectTimelinePage() {
  const { locale } = useI18n();
  const language = locale.startsWith('zh') ? 'zh' : 'en';
  const copy = TIMELINE_COPY[language];
  const title = TIMELINE_NAME[language];
  const route = useRoute();
  const workspace = useWorkspaceContext();
  const identity = resolveWorkspaceResourceReadIdentity(workspace);
  const { session } = useTokenToSeaSession();
  if (workspace.loading || workspace.identityChangePending || session.phase === 'loading') {
    return <div className={styles.message} role="status">{copy.loading}</div>;
  }
  if (workspace.failure && workspace.failure !== 'unsupported') {
    return <div className={styles.message} role="alert">{copy.loadError}</div>;
  }
  if (workspace.context && !identity) {
    return <div className={styles.message} role="status">{copy.loading}</div>;
  }
  const account = session.phase === 'ready' && session.signedIn ? session.user : undefined;
  if (!identity && !account?.id) {
    return <div className={styles.message} role="alert">{copy.loadError}</div>;
  }
  return <TimelineWorkspace
    key={JSON.stringify([workspace.accountGeneration, workspaceResourceReadIdentityKey(identity), account?.id])}
    context={identity?.context ?? null} title={title} copy={copy} locale={locale}
    accountId={account?.id ?? null} authorName={account?.name ?? copy.you}
    selectedId={route.kind === 'tool' ? route.itemId : undefined}
  />;
}

function TimelineWorkspace({ context, title, copy, locale, accountId, authorName, selectedId }: {
  context: WorkspaceCollabContext | null;
  title: string;
  copy: TimelineCopy;
  locale: string;
  accountId: string | null;
  authorName: string;
  selectedId?: string;
}) {
  const { snapshot, refreshing, refresh } = useProjectTimeline(context);
  const prefix = timelineStoragePrefix(context, accountId);
  const { notes, error: storageError } = useTimelineNotes(prefix);
  const { order, follows, error: preferencesError, changeOrder, toggleFollow } = useTimelinePreferences(prefix);
  const organization = useProjectOrganization();
  const [projectFilter, setProjectFilter] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState('all');
  const [limit, setLimit] = useState(SHOW_COUNT);
  const [docked, setDocked] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const page = root.current;
    if (!page) return;
    const observer = new ResizeObserver(([entry]) => setDocked((entry?.contentRect.width ?? 0) >= 770));
    observer.observe(page);
    return () => observer.disconnect();
  }, []);

  const projects = useMemo(
    () => [...(snapshot?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name, locale)), [snapshot, locale],
  );
  const visibleProject = projects.some(project => project.id === projectFilter) ? projectFilter : '';
  const allEntries = useMemo(() => buildTimeline(snapshot?.projects ?? [], snapshot?.histories ?? new Map(), notes), [snapshot, notes]);
  const entries = useMemo(() => {
    const search = query.trim().toLocaleLowerCase(locale);
    const filtered = allEntries.filter(entry =>
      (view !== 'following' || showsInFollowing(entry, follows)) &&
      (!visibleProject || entry.project?.id === visibleProject) &&
      (!search || [entry.project?.name, copy[entry.kind], entry.text, ...entry.files].some(value =>
        value?.toLocaleLowerCase(locale).includes(search))),
    );
    return sortTimeline(filtered, order);
  }, [allEntries, visibleProject, query, view, follows, order, copy, locale]);
  const visibleEntries = useMemo(() => entries.slice(0, limit), [entries, limit]);
  const selected = allEntries.find(entry => entry.id === selectedId);
  const selectedTarget = selected ? timelineFollowTarget(selected).key : null;
  const clock = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: 'short' }), [locale]);
  const details = selected && selectedTarget ? <TimelineEntryDetails
    key={selected.id} entry={selected} copy={copy} clock={clock} context={context}
    followed={follows.has(selectedTarget)} onToggleFollow={() => toggleFollow(selectedTarget)}
  /> : null;

  function saveNote(projectId: string | null, text: string) {
    saveTimelineNote(window.localStorage, prefix, projectId, text);
    notifyTimelineNotesChanged(prefix);
    if (projectId) {
      const entry = organization.entries.get(projectId);
      if (entry?.archivedAt == null && entry?.removedAt == null) {
        expandSidebarSection(entry?.pinnedAt != null ? 'pinned' : entry?.groupId ? `group:${entry.groupId}` : 'projects');
        setSidebarProjectExpanded(projectId, true);
      }
    } else {
      expandSidebarSection('timeline-recent');
    }
    setQuery('');
    if (visibleProject && visibleProject !== projectId) setProjectFilter(projectId ?? '');
    setView('all');
    setLimit(SHOW_COUNT);
  }

  function selectEntry(itemId?: string) {
    navigate({ kind: 'tool', pluginId: 'project-timeline', pageId: 'timeline', itemId }, { replace: Boolean(selectedId) });
  }

  return (
    <div className={styles.page} ref={root} data-testid="project-timeline">
      <div className={styles.layout} data-docked={docked}>
        <section className={styles.main} aria-label={title}>
          <header className={styles.header}>
            <div className={styles.title}><ListTree aria-hidden size={22} /><h1>{title}</h1></div>
            <Button variant="secondary" size="icon-sm" aria-label={copy.refresh} title={copy.refresh}
              disabled={refreshing} onClick={refresh}><RefreshCw aria-hidden size={15} /></Button>
          </header>
          <Tabs value={view} onValueChange={next => { setView(next); setLimit(SHOW_COUNT); }}>
            <TabsList variant="line" size="md" className={styles.tabs} aria-label={title}>
              <TabsTrigger value="all">{copy.all}</TabsTrigger>
              <TabsTrigger value="following">{copy.following}</TabsTrigger>
            </TabsList>
            <UpdateComposer projects={projects} authorName={authorName} copy={copy} onSave={saveNote} />
            <div className={styles.filters}>
              <TimelineProjectSelect projects={projects} projectId={visibleProject} copy={copy}
                onChange={id => {
                  setProjectFilter(id);
                  setLimit(SHOW_COUNT);
                  if (selectedId) selectEntry();
                }} />
              <SearchField placeholder={copy.search} aria-label={copy.search} className={styles.search} type="search" value={query}
                onChange={event => { setQuery(event.target.value); setLimit(SHOW_COUNT); }} />
              <Select value={order} onValueChange={value => {
                const next = TIMELINE_ORDERS.find(candidate => candidate === value);
                if (next) { changeOrder(next); setLimit(SHOW_COUNT); }
              }}>
                <SelectTrigger aria-label={copy.sort} className={styles.sortSelect}><SelectValue /></SelectTrigger>
                <SelectContent align="end">
                  {TIMELINE_ORDERS.map(value => <SelectItem key={value} value={value}>{copy[value]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <TabsContent value={view} className={styles.feed} aria-busy={!snapshot && refreshing}>
              {snapshot?.error ? <Callout tone="error" role="alert">{copy.loadError}</Callout> : null}
              {snapshot?.partial ? <Callout role="status">{copy.partialError}</Callout> : null}
              {storageError ? <Callout role="status">{copy.noteReadError}</Callout> : null}
              {preferencesError ? <Callout role="status">{copy.preferencesError}</Callout> : null}
              {!snapshot ? <p className={styles.message} role="status">{copy.loading}</p> : null}
              {snapshot && !snapshot.error && !entries.length ? <div className={styles.empty}>
                <ListTree size={26} aria-hidden />
                <h2>{visibleProject || query.trim() ? copy.emptyResults : view === 'following' ? copy.followingEmpty : copy.empty}</h2>
              </div> : null}
              <TimelineFeed key={view} entries={visibleEntries} order={order} copy={copy} locale={locale}
                context={context} followed={follows} selectedId={selectedId} onSelect={selectEntry} onToggleFollow={toggleFollow} />
              {entries.length > limit ? <div className={styles.more}>
                <Button variant="secondary" size="sm" onClick={() => setLimit(value => value + SHOW_COUNT)}>{copy.more}</Button>
              </div> : null}
            </TabsContent>
          </Tabs>
        </section>
        {docked ? <aside className={styles.inspector} aria-label={copy.details}>
          <header>
            <h2>{copy.details}</h2>
            {selected ? <Button variant="ghost" size="sm" aria-label={copy.closeDetails} title={copy.closeDetails}
              onClick={() => selectEntry()}><X size={16} aria-hidden /></Button> : null}
          </header>
          {details ?? <p className={styles.inspectorHint}>{copy.selectEntry}</p>}
        </aside> : null}
      </div>
      {!docked && selected ? <Modal open onClose={() => selectEntry()} aria-describedby={undefined}>
        <ModalTitle>{copy.details}</ModalTitle>
        {details}
      </Modal> : null}
    </div>
  );
}

function TimelineProjectSelect({ projects, projectId, copy, composer = false, onChange }: {
  projects: readonly Project[];
  projectId: string;
  copy: TimelineCopy;
  composer?: boolean;
  onChange(id: string): void;
}) {
  const value = projectId ? PROJECT_VALUE_PREFIX + projectId : NO_PROJECT;
  const unavailable = Boolean(projectId && !projects.some(project => project.id === projectId));
  return (
    <Select value={value} onValueChange={next => onChange(next === NO_PROJECT ? '' : next.slice(PROJECT_VALUE_PREFIX.length))}>
      <SelectTrigger aria-label={composer ? copy.project : copy.projects} aria-invalid={unavailable || undefined}
        className={composer ? styles.composerProject : styles.projectFilter}>
        {composer ? <Folder size={14} aria-hidden className="shrink-0 text-ink-soft" /> : null}
        <SelectValue className={composer ? 'flex-1' : undefined} />
      </SelectTrigger>
      <SelectContent className={styles.projectOptions}>
        <SelectItem value={NO_PROJECT}>{composer ? copy.unassigned : copy.allProjects}</SelectItem>
        {unavailable ? <SelectItem value={value} disabled>{copy.projectUnavailable}</SelectItem> : null}
        {projects.map(project => (
          <SelectItem key={project.id} value={PROJECT_VALUE_PREFIX + project.id}>{project.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function UpdateComposer({ projects, authorName, copy, onSave }: {
  projects: Project[];
  authorName: string;
  copy: TimelineCopy;
  onSave(projectId: string | null, text: string): void;
}) {
  const id = useId();
  const [projectId, setProjectId] = useState('');
  const [text, setText] = useState('');
  const [failed, setFailed] = useState(false);
  const count = [...text.trim()].length;
  const validProject = !projectId || projects.some(project => project.id === projectId);
  const valid = validProject && count > 0 && count <= UPDATE_LIMIT;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    try {
      onSave(projectId || null, text);
      setText('');
      setProjectId('');
      setFailed(false);
    }
    catch { setFailed(true); }
  }
  return (
    <form className={styles.composer} aria-label={copy.update} onSubmit={submit}>
      <Avatar name={authorName} size={37} tone="ink" className={styles.composerAvatar} />
      <div className={styles.composerBody}>
        <TimelineProjectSelect projects={projects} projectId={projectId} copy={copy} composer onChange={setProjectId} />
        <Textarea id={`${id}-text`} variant="bare" className={styles.composerText} value={text}
          rows={2} maxLength={UPDATE_LIMIT * 4} aria-label={copy.noteField}
          aria-describedby={`${id}-count ${id}-visibility`} aria-invalid={count > UPDATE_LIMIT || undefined}
          placeholder={copy.noteHint} onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {failed ? <Callout tone="error" role="alert">{copy.noteSaveError}</Callout> : null}
        <div className={styles.composerFoot}>
          <span id={`${id}-visibility`} className={styles.visibility}><Lock size={13} aria-hidden />{copy.localNote}</span>
          <span id={`${id}-count`} data-over={count > UPDATE_LIMIT} className={styles.count}>{count}/{UPDATE_LIMIT}</span>
          <Button type="submit" variant="primary" size="sm" disabled={!valid}>{copy.post}</Button>
        </div>
      </div>
    </form>
  );
}
