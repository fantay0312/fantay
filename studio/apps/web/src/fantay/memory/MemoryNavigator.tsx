// SPDX-License-Identifier: AGPL-3.0-only
// 记忆 navigator: the 264px list of every place a memory can live — 我 (profile, personas), 角色, 群组 and
// 项目 with their chats — on a hairline, not a card. A filter field narrows it; the arrow keys walk it; a
// warm dot marks a place where something waits for you.
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronRight, Folder, MessageSquare, UserRound, Users, VenetianMask, type LucideIcon } from 'lucide-react';
import type { MemoryOverviewResponse, MemoryScopeKind, MemoryScopeNode, MemoryScopeRef } from '@open-design/contracts';
import { Button, Icon, IconButton, InputGroupClear, SearchField, Skeleton, cn } from '../ui';
import { PaAvatar, PaGroupAvatar } from '../pa/PaAvatar';
import type { PersonalAgent } from '../pa/pa-types';
import { useMemoryT, type MemoryT } from './i18n';
import { nodeNeedsYou, parentProjectOf, scopeKeyOf, scopeNodeLabel } from './labels';
import styles from './MemoryCenterView.module.css';

/** The test id of a scope node: `memory-nav-profile`, `memory-nav-bot-<id>`, `memory-nav-conversation-<id>`. */
export function scopeTestId(scope: MemoryScopeRef): string {
  return scope.id ? `memory-nav-${scope.kind}-${scope.id}` : `memory-nav-${scope.kind}`;
}

const GLYPH: Record<MemoryScopeKind, LucideIcon> = {
  profile: UserRound,
  persona: VenetianMask,
  bot: UserRound,
  group: Users,
  project: Folder,
  conversation: MessageSquare,
};

/** PaAvatar and PaGroupAvatar only read an agent's id and name. */
function faceAgent(id: string, name: string): PersonalAgent {
  return { id, name } as PersonalAgent;
}

export interface ScopeFaceProps {
  node: MemoryScopeNode;
  /** The id of the bot that wears the Fantay mascot, if any. */
  fantayId: string | null;
  size: number;
}

/** One face per scope: the bot's own avatar, the group's cluster, or a quiet glyph for the rest. */
export function ScopeFace({ node, fantayId, size }: ScopeFaceProps) {
  const { scope } = node;
  if (scope.kind === 'bot') {
    return <PaAvatar agent={faceAgent(scope.id, node.label)} size={size} fantay={scope.id === fantayId} />;
  }
  if (scope.kind === 'group') {
    const members = (node.members ?? []).map((member) => faceAgent(member.id, member.name));
    if (members.length > 0) return <PaGroupAvatar members={members} fantayId={fantayId} size={size} />;
  }
  const glyph = GLYPH[scope.kind];
  return (
    <span
      aria-hidden
      className={cn(styles.glyph, scope.kind === 'conversation' && styles.glyphBare)}
      style={{ width: size, height: size }}
    >
      <Icon icon={glyph} size={Math.max(12, Math.round(size * 0.6))} />
    </span>
  );
}

export function fantayBotId(overview: MemoryOverviewResponse | null): string | null {
  return overview?.bots.find((bot) => bot.avatar === 'fantay')?.scope.id ?? null;
}

function nodeSublabel(t: MemoryT, node: MemoryScopeNode): string | null {
  if (node.scope.kind === 'bot') return t(node.isCharacter ? 'memory.nav.character' : 'memory.nav.assistant');
  if (node.scope.kind === 'persona' && node.isDefault) return t('memory.nav.defaultPersona');
  return node.sublabel?.trim() || null;
}

function matches(t: MemoryT, node: MemoryScopeNode, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${scopeNodeLabel(t, node)} ${nodeSublabel(t, node) ?? ''}`.toLowerCase();
  return haystack.includes(needle);
}

interface Group {
  id: 'me' | 'bots' | 'groups' | 'projects';
  title: string;
  nodes: MemoryScopeNode[];
}

export interface MemoryNavigatorProps {
  overview: MemoryOverviewResponse | null;
  selectedKey: string;
  onSelect(scope: MemoryScopeRef): void;
}

export function MemoryNavigator({ overview, selectedKey, onSelect }: MemoryNavigatorProps) {
  const t = useMemoryT();
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const needle = filter.trim().toLowerCase();
  const fantayId = fantayBotId(overview);

  // A chat that is selected (from a link, a remembered choice or a new memory) shows inside an open project.
  useEffect(() => {
    if (!overview || !selectedKey.startsWith('conversation:')) return;
    const parent = parentProjectOf(overview, selectedKey.slice('conversation:'.length));
    if (!parent) return;
    setExpanded((current) => (current.has(parent.scope.id) ? current : new Set(current).add(parent.scope.id)));
  }, [overview, selectedKey]);

  const groups = useMemo<Group[]>(() => {
    if (!overview) return [];
    // A project whose name matches keeps all its chats; otherwise only the chats that match are shown.
    const projects = overview.projects
      .map((project) => {
        if (matches(t, project, needle)) return project;
        const children = (project.children ?? []).filter((child) => matches(t, child, needle));
        return children.length > 0 ? { ...project, children } : null;
      })
      .filter((project): project is MemoryScopeNode => project !== null);
    const all: Group[] = [
      { id: 'me', title: t('memory.nav.me'), nodes: [overview.profile, ...overview.personas].filter((node) => matches(t, node, needle)) },
      { id: 'bots', title: t('memory.nav.bots'), nodes: overview.bots.filter((node) => matches(t, node, needle)) },
      { id: 'groups', title: t('memory.nav.groups'), nodes: overview.groups.filter((node) => matches(t, node, needle)) },
      { id: 'projects', title: t('memory.nav.projects'), nodes: projects },
    ];
    return all.filter((group) => group.nodes.length > 0);
  }, [overview, needle, t]);

  const toggle = (projectId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });

  // Up/Down walk the visible nodes, Home/End jump; Left/Right fold and unfold a project.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const visible = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-memory-node]')).filter(
      (element) => !element.closest('[data-folded]'),
    );
    const index = visible.indexOf(target);
    const focusAt = (next: number) => {
      const element = visible[Math.max(0, Math.min(visible.length - 1, next))];
      if (element) {
        event.preventDefault();
        element.focus();
      }
    };
    if (target.dataset.memoryFilter !== undefined) {
      if (event.key === 'ArrowDown') focusAt(0);
      return;
    }
    if (index < 0) return;
    if (event.key === 'ArrowDown') focusAt(index + 1);
    else if (event.key === 'ArrowUp') focusAt(index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(visible.length - 1);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const projectId = target.dataset.memoryProject;
      if (!projectId) return;
      const open = expanded.has(projectId);
      if ((event.key === 'ArrowRight') !== open) {
        event.preventDefault();
        toggle(projectId);
      }
    }
  };

  const renderNode = (node: MemoryScopeNode, depth: 0 | 1) => {
    const key = scopeKeyOf(node.scope);
    const selected = key === selectedKey;
    const label = scopeNodeLabel(t, node);
    const sublabel = nodeSublabel(t, node);
    const needsYou = nodeNeedsYou(node);
    const isProject = node.scope.kind === 'project';
    const children = isProject ? node.children ?? [] : [];
    // While filtering, a project shown only for its matching chats stands open.
    const open = isProject && children.length > 0 && (expanded.has(node.scope.id) || (needle !== '' && !matches(t, node, needle)));
    const select = () => {
      // The selected project's row folds and unfolds its chats, as in the app sidebar; another row opens it.
      if (isProject && children.length > 0) {
        if (selected) toggle(node.scope.id);
        else if (!expanded.has(node.scope.id)) toggle(node.scope.id);
      }
      onSelect(node.scope);
    };
    return (
      <li key={key}>
        <div className={styles.navRow} data-selected={selected ? '' : undefined} data-depth={depth} data-kind={node.scope.kind}>
          {isProject ? (
            children.length > 0 ? (
              <IconButton
                size="xs"
                tooltip={false}
                className={styles.navChevron}
                aria-label={t(open ? 'memory.nav.collapse' : 'memory.nav.expand', { name: label })}
                aria-expanded={open}
                tabIndex={-1}
                data-testid={`memory-nav-expand-${node.scope.id}`}
                onClick={() => toggle(node.scope.id)}
              >
                <Icon icon={ChevronRight} size={12} className={styles.navChevronIcon} />
              </IconButton>
            ) : (
              <span aria-hidden className={styles.navChevronSpace} />
            )
          ) : null}
          <Button
            variant="bare"
            className={styles.navItem}
            aria-current={selected ? 'true' : undefined}
            aria-expanded={isProject && children.length > 0 ? open : undefined}
            data-memory-node=""
            data-memory-project={isProject && children.length > 0 ? node.scope.id : undefined}
            data-needs-you={needsYou ? '' : undefined}
            data-testid={scopeTestId(node.scope)}
            onClick={select}
          >
            <span className={styles.navFace}>
              <ScopeFace node={node} fantayId={fantayId} size={depth === 1 ? 18 : 22} />
            </span>
            <span className={styles.navLabel} title={label}>
              {label}
            </span>
            {sublabel ? <span className={styles.navSub}>{sublabel}</span> : null}
            <span className={styles.navTrail}>
              {needsYou ? <span className={styles.warmDot} role="img" aria-label={t('memory.nav.needsYou')} /> : null}
              {node.counts.active > 0 ? (
                <span className={styles.navCount} aria-label={t('memory.nav.count', { count: node.counts.active })}>
                  {node.counts.active}
                </span>
              ) : null}
            </span>
          </Button>
        </div>
        {children.length > 0 ? (
          <div className={styles.navChildren} data-open={open ? '' : undefined} data-folded={open ? undefined : ''}>
            <ul className={cn(styles.navList, styles.navChildrenInner)}>{children.map((child) => renderNode(child, 1))}</ul>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <nav className={styles.nav} aria-label={t('memory.nav.label')} data-testid="memory-navigator" onKeyDown={onKeyDown}>
      <div className={styles.navFilterWrap}>
        <SearchField
          className={styles.navFilter}
          value={filter}
          placeholder={t('memory.nav.filter')}
          aria-label={t('memory.nav.filter')}
          data-memory-filter=""
          data-testid="memory-nav-filter"
          onChange={(event) => setFilter(event.target.value)}
          trailing={filter ? <InputGroupClear onClear={() => setFilter('')} /> : null}
          disabled={!overview}
        />
      </div>
      <div className={styles.navScroll}>
        {!overview ? (
          <div className={styles.navSkeleton} aria-hidden>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <Skeleton key={index} index={index} className={styles.navSkeletonRow} />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className={styles.navEmpty} data-testid="memory-nav-no-match">
            <p className={styles.navEmptyText}>{t('memory.nav.noMatch')}</p>
            <Button variant="ghost" size="sm" onClick={() => setFilter('')}>
              {t('memory.clearFilter')}
            </Button>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.id} className={styles.navGroup} aria-labelledby={`memory-nav-group-${group.id}`}>
              <h3 id={`memory-nav-group-${group.id}`} className={styles.navGroupTitle}>
                {group.title}
              </h3>
              <ul className={styles.navList}>{group.nodes.map((node) => renderNode(node, 0))}</ul>
            </section>
          ))
        )}
      </div>
    </nav>
  );
}
