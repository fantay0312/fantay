// Project & command search palette (⌘K), after Claude desktop's: a dialog over a
// dimmed app with category tabs (All, Projects, Motion, Design Systems, Actions,
// Settings), grouped rows, and a shortcut legend. ↑/↓ move the highlight, ←/→ on
// an empty field or Tab change category, Enter opens or runs, Esc closes.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  FileCode2,
  Film,
  House,
  Images,
  Palette,
  PanelLeft,
  Puzzle,
  Settings,
  SquarePen,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import type { Project } from '../types';
import { useT } from '../i18n';
import { navigate } from '../router';
import { relativeTimeLong } from '../utils/chatTime';
import { projectCover } from './RecentProjectsStrip';
import { runFantayCommand } from '../fantay/shell/commands';
import { useFantayShell } from '../fantay/shell/shell-context';
import { useProjectOrganization } from '../fantay/shell/project-organization-store';
import { isProjectArchived, partitionSidebarProjects } from '../fantay/shell/sidebar/sidebar-model';

interface Props {
  projects: Project[];
  workspaceContext?: WorkspaceCollabContext | null;
  onOpenProject: (id: string) => Promise<boolean> | Promise<void> | boolean | void;
  onClose: () => void;
}

type SearchTabId = 'all' | 'projects' | 'motion' | 'designSystems' | 'actions' | 'settings';

const SEARCH_TAB_ORDER: readonly SearchTabId[] = [
  'all',
  'projects',
  'motion',
  'designSystems',
  'actions',
  'settings',
];

type SearchProjectRow = {
  kind: 'project';
  id: string;
  section: 'projects' | 'motion' | 'designSystems';
  project: Project;
};

type SearchActionRow = {
  kind: 'action';
  id: string;
  section: 'actions' | 'settings';
  label: string;
  keywords: string;
  icon: LucideIcon;
  shortcut?: readonly string[];
  onSelect: () => void;
};

type SearchRow = SearchProjectRow | SearchActionRow;

/**
 * Search spans both personal drafts and the shared workspace catalog. Shared
 * cards win if a project temporarily appears in both lists because they carry
 * the authoritative workspace-facing title and metadata.
 */
export function buildProjectSearchCatalog(
  draftProjects: readonly Project[],
  sharedProjects: readonly Project[],
): Project[] {
  const projectsById = new Map<string, Project>();
  for (const project of draftProjects) projectsById.set(project.id, project);
  for (const project of sharedProjects) projectsById.set(project.id, project);
  return [...projectsById.values()];
}

function projectSectionIcon(section: SearchProjectRow['section']): LucideIcon {
  if (section === 'motion') return Film;
  if (section === 'designSystems') return Palette;
  return FileCode2;
}

export function ProjectSearchModal({
  projects,
  workspaceContext = null,
  onOpenProject,
  onClose,
}: Props) {
  const t = useT();
  const shell = useFantayShell();
  const { entries: archiveEntries } = useProjectOrganization();
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<SearchTabId>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs = useMemo(
    () => [
      { id: 'all' as const, label: t('common.all') },
      { id: 'projects' as const, label: t('entry.navProjects') },
      { id: 'motion' as const, label: t('fantayShell.sidebar.motion') },
      { id: 'designSystems' as const, label: t('fantayShell.sidebar.designSystems') },
      { id: 'actions' as const, label: t('tokentosea.services.actionLabel') },
      { id: 'settings' as const, label: t('entry.openSettingsTitle') },
    ],
    [t],
  );

  const sectionLabels = useMemo<Record<SearchRow['section'], string>>(
    () => ({
      projects: t('entry.navProjects'),
      motion: t('fantayShell.sidebar.motion'),
      designSystems: t('fantayShell.sidebar.designSystems'),
      actions: t('tokentosea.services.actionLabel'),
      settings: t('entry.openSettingsTitle'),
    }),
    [t],
  );

  const actionRows = useMemo<SearchActionRow[]>(
    () => [
      {
        kind: 'action',
        id: 'action-go-back',
        section: 'actions',
        label: t('designBrowser.goBack'),
        keywords: 'back go back 后退 返回',
        icon: ArrowLeft,
        shortcut: ['⌘', '['],
        onSelect: () => window.history.back(),
      },
      {
        kind: 'action',
        id: 'action-go-forward',
        section: 'actions',
        label: t('designBrowser.goForward'),
        keywords: 'forward go forward 前进',
        icon: ArrowRight,
        shortcut: ['⌘', ']'],
        onSelect: () => window.history.forward(),
      },
      {
        kind: 'action',
        id: 'action-new-chat',
        section: 'actions',
        label: t('fantayShell.sidebar.newChat'),
        keywords: 'new chat conversation 新对话 新建对话',
        icon: SquarePen,
        shortcut: ['⌘', 'N'],
        onSelect: () => {
          if (shell) shell.newChat();
          else navigate({ kind: 'home', view: 'home' });
        },
      },
      {
        kind: 'action',
        id: 'action-toggle-sidebar',
        section: 'actions',
        label: t('fantayMenu.toggleSidebar'),
        keywords: 'toggle sidebar collapse expand 侧栏 收起 展开',
        icon: PanelLeft,
        shortcut: ['⌘', '\\'],
        onSelect: () => shell?.toggleSidebar(),
      },
      {
        kind: 'action',
        id: 'action-home',
        section: 'actions',
        label: t('entry.navHome'),
        keywords: 'home 主页 首页',
        icon: House,
        onSelect: () => navigate({ kind: 'home', view: 'home' }),
      },
      {
        kind: 'action',
        id: 'action-materials',
        section: 'actions',
        label: t('entry.navMaterials'),
        keywords: 'materials library 素材库',
        icon: Images,
        onSelect: () => {
          if (shell) shell.openMaterials();
          else navigate({ kind: 'home', view: 'materials' });
        },
      },
      {
        kind: 'action',
        id: 'action-plugins',
        section: 'actions',
        label: t('entry.navPlugins'),
        keywords: 'plugins marketplace 插件',
        icon: Puzzle,
        onSelect: () => navigate({ kind: 'home', view: 'plugins' }),
      },
      {
        kind: 'action',
        id: 'action-automations',
        section: 'actions',
        label: t('entry.navTasks'),
        keywords: 'automations tasks 自动化 定时任务',
        icon: Workflow,
        onSelect: () => navigate({ kind: 'home', view: 'tasks' }),
      },
    ],
    [shell, t],
  );

  const settingRows = useMemo<SearchActionRow[]>(
    () => [
      {
        kind: 'action',
        id: 'settings-general',
        section: 'settings',
        label: t('entry.openSettingsTitle'),
        keywords: 'settings preferences 设置 偏好',
        icon: Settings,
        shortcut: ['⌘', ','],
        onSelect: () => {
          if (shell) runFantayCommand('fantay.openSettings');
          else navigate({ kind: 'home', view: 'settings' });
        },
      },
      {
        kind: 'action',
        id: 'settings-account',
        section: 'settings',
        label: t('fantayShell.account.services'),
        keywords: 'account billing services 账户 服务 账单',
        icon: Settings,
        onSelect: () => {
          if (shell) shell.openAccountServices();
          else navigate({ kind: 'home', view: 'tokentosea' });
        },
      },
    ],
    [shell, t],
  );

  const rows = useMemo<SearchRow[]>(() => {
    const sorted = projects
      .filter((project) => !isProjectArchived(archiveEntries, project.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const q = query.trim().toLowerCase();
    const matchedProjects =
      q.length === 0
        ? sorted
        : sorted.filter((p) => (p.name || '').toLowerCase().includes(q));
    const partition = partitionSidebarProjects(matchedProjects);
    const toProjectRow =
      (section: SearchProjectRow['section']) =>
      (project: Project): SearchProjectRow => ({
        kind: 'project',
        id: project.id,
        section,
        project,
      });

    const projectSectionRows = partition.projects.map(toProjectRow('projects'));
    const motionSectionRows = partition.motion.map(toProjectRow('motion'));
    const dsSectionRows = partition.designSystems.map(toProjectRow('designSystems'));

    const filterAction = (item: SearchActionRow) =>
      q.length === 0 ||
      item.label.toLowerCase().includes(q) ||
      item.keywords.toLowerCase().includes(q);
    const matchedActions = actionRows.filter(filterAction);
    const matchedSettings = settingRows.filter(filterAction);

    if (activeTab === 'projects') return projectSectionRows;
    if (activeTab === 'motion') return motionSectionRows;
    if (activeTab === 'designSystems') return dsSectionRows;
    if (activeTab === 'actions') return matchedActions;
    if (activeTab === 'settings') return matchedSettings;

    // When rendered outside FantayShell (e.g. standalone unit tests), keep pure recency project list in 'all'.
    if (!shell) {
      const sectionById = new Map<string, SearchProjectRow['section']>();
      for (const p of partition.motion) sectionById.set(p.id, 'motion');
      for (const p of partition.designSystems) sectionById.set(p.id, 'designSystems');
      return matchedProjects.map((project) => ({
        kind: 'project',
        id: project.id,
        section: sectionById.get(project.id) ?? 'projects',
        project,
      }));
    }

    return [
      ...projectSectionRows,
      ...motionSectionRows,
      ...dsSectionRows,
      ...matchedActions,
      ...(q.length > 0 ? matchedSettings : []),
    ];
  }, [projects, archiveEntries, query, activeTab, actionRows, settingRows, shell]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, activeTab]);

  useEffect(() => {
    const container = resultsRef.current;
    const active = container?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, rows.length]);

  const selectRow = (row: SearchRow) => {
    if (row.kind === 'project') {
      void onOpenProject(row.project.id);
    } else {
      row.onSelect();
    }
    onClose();
  };

  const stepTab = (delta: 1 | -1) => {
    setActiveTab((current) => {
      const idx = SEARCH_TAB_ORDER.indexOf(current);
      const nextIdx = (idx + delta + SEARCH_TAB_ORDER.length) % SEARCH_TAB_ORDER.length;
      return SEARCH_TAB_ORDER[nextIdx] ?? 'all';
    });
    inputRef.current?.focus();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      stepTab(event.shiftKey ? -1 : 1);
      return;
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && query.length === 0) {
      event.preventDefault();
      stepTab(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (rows.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % rows.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + rows.length) % rows.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = rows[Math.min(activeIndex, rows.length - 1)];
      if (target) selectRow(target);
    }
  };

  const showGroupHeaders = activeTab === 'all' && Boolean(shell);

  return createPortal(
    <div
      className="project-search-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="project-search-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('common.search')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="project-search-input-row">
          <input
            ref={inputRef}
            type="text"
            className="project-search-input"
            value={query}
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            data-testid="project-search-input"
          />
          <button
            type="button"
            className="project-search-clear"
            aria-label={query.length > 0 ? t('common.clear') : t('common.close')}
            onClick={() => {
              if (query.length === 0) {
                onClose();
                return;
              }
              setQuery('');
              inputRef.current?.focus();
            }}
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>
        <div className="project-search-tabs" role="tablist" aria-label={t('common.search')}>
          {tabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`project-search-tab${selected ? ' is-active' : ''}`}
                data-testid={`project-search-tab-${tab.id}`}
                onClick={() => {
                  setActiveTab(tab.id);
                  inputRef.current?.focus();
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="project-search-results" role="listbox" ref={resultsRef}>
          {rows.length === 0 ? (
            <div className="project-search-empty">{t('quickSwitcher.noMatches')}</div>
          ) : (
            rows.map((row, index) => {
              const prevSection = index > 0 ? rows[index - 1]?.section : null;
              const showHeader = showGroupHeaders && row.section !== prevSection;
              const active = index === activeIndex;

              if (row.kind === 'project') {
                const { project } = row;
                const cover = projectCover(project, null, workspaceContext);
                const showImage =
                  (cover.kind === 'image' || cover.kind === 'logo') && Boolean(cover.src);
                const SectionIcon = projectSectionIcon(row.section);
                return (
                  <div key={project.id} className="project-search-row-wrap">
                    {showHeader ? (
                      <div className="project-search-section-label">
                        {sectionLabels[row.section]}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className={`project-search-item${active ? ' is-active' : ''}`}
                      role="option"
                      aria-selected={active}
                      data-active={active ? 'true' : undefined}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => selectRow(row)}
                      data-testid={`project-search-item-${project.id}`}
                    >
                      <span className="project-search-item-thumb" aria-hidden>
                        {showImage ? (
                          <img src={cover.src} alt="" loading="lazy" />
                        ) : (
                          <SectionIcon size={18} strokeWidth={1.75} className="project-search-item-icon" />
                        )}
                      </span>
                      <span className="project-search-item-name">
                        {project.name || t('chat.untitledConversation')}
                      </span>
                      <span className="project-search-item-meta">
                        {relativeTimeLong(project.updatedAt, t)}
                      </span>
                      <CornerDownLeft size={15} className="project-search-item-enter" aria-hidden />
                    </button>
                  </div>
                );
              }

              const ActionIcon = row.icon;
              return (
                <div key={row.id} className="project-search-row-wrap">
                  {showHeader ? (
                    <div className="project-search-section-label">
                      {sectionLabels[row.section]}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={`project-search-item${active ? ' is-active' : ''}`}
                    role="option"
                    aria-selected={active}
                    data-active={active ? 'true' : undefined}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectRow(row)}
                    data-testid={`project-search-item-${row.id}`}
                  >
                    <span className="project-search-item-thumb" aria-hidden>
                      <ActionIcon size={18} strokeWidth={1.75} className="project-search-item-icon" />
                    </span>
                    <span className="project-search-item-name">{row.label}</span>
                    {row.shortcut ? (
                      <span className="project-search-item-kbd" aria-hidden>
                        {row.shortcut.map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                      </span>
                    ) : null}
                    <CornerDownLeft size={15} className="project-search-item-enter" aria-hidden />
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="project-search-footer" aria-hidden>
          <span>
            {t('quickSwitcher.close')} <kbd>Esc</kbd>
          </span>
          <span>
            {t('quickSwitcher.switchCategory')} <kbd>←</kbd>
            <kbd>→</kbd>
          </span>
          <span>
            {t('quickSwitcher.navigate')} <kbd>↑</kbd>
            <kbd>↓</kbd>
          </span>
          <span className="project-search-footer-end">
            {t('quickSwitcher.open')} <kbd>↵</kbd>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
