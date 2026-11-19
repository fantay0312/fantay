// SPDX-License-Identifier: AGPL-3.0-only
// 记忆 — plain-language names for kinds, scopes and states, the dates the page prints, and the scope tree
// helpers the page and its dialogs share. Every visible word goes through the page translator (`MemoryT`).
import {
  memoryScopeKey,
  type MemoryItem,
  type MemoryItemKind,
  type MemoryItemStatus,
  type MemoryOverviewResponse,
  type MemoryScopeKind,
  type MemoryScopeNode,
  type MemoryScopeRef,
} from '@open-design/contracts';
import { MEMORY_ACCESS_REQUIRED, MEMORY_OFFLINE, MemoryApiError } from './api';
import type { MemoryPageKey, MemoryT } from './i18n';

/* ── kinds ─────────────────────────────────────────────────────────────────────────────────── */

const KIND_KEY: Record<MemoryItemKind, MemoryPageKey> = {
  profile: 'memory.kind.profile',
  preference: 'memory.kind.preference',
  fact: 'memory.kind.fact',
  decision: 'memory.kind.decision',
  procedure: 'memory.kind.procedure',
  promise: 'memory.kind.promise',
  moment: 'memory.kind.moment',
  episode: 'memory.kind.episode',
  rule: 'memory.kind.rule',
  reference: 'memory.kind.reference',
  feedback: 'memory.kind.feedback',
};

export function kindLabel(t: MemoryT, kind: MemoryItemKind): string {
  return t(KIND_KEY[kind]);
}

/** The six families the kind filter offers; every kind belongs to exactly one. */
export type MemoryKindGroup = 'fact' | 'preference' | 'decision' | 'promise' | 'experience' | 'method';

export const MEMORY_KIND_GROUPS: ReadonlyArray<{ id: MemoryKindGroup; kinds: readonly MemoryItemKind[] }> = [
  { id: 'fact', kinds: ['fact', 'profile', 'reference'] },
  { id: 'preference', kinds: ['preference', 'rule', 'feedback'] },
  { id: 'decision', kinds: ['decision'] },
  { id: 'promise', kinds: ['promise'] },
  { id: 'experience', kinds: ['moment', 'episode'] },
  { id: 'method', kinds: ['procedure'] },
];

export function kindGroupOf(kind: MemoryItemKind): MemoryKindGroup {
  return MEMORY_KIND_GROUPS.find((group) => group.kinds.includes(kind))?.id ?? 'fact';
}

const GROUP_KEY: Record<MemoryKindGroup | 'all', MemoryPageKey> = {
  all: 'memory.group.all',
  fact: 'memory.group.fact',
  preference: 'memory.group.preference',
  decision: 'memory.group.decision',
  promise: 'memory.group.promise',
  experience: 'memory.group.experience',
  method: 'memory.group.method',
};

export function kindGroupLabel(t: MemoryT, group: MemoryKindGroup | 'all'): string {
  return t(GROUP_KEY[group]);
}

/* ── scopes and states ─────────────────────────────────────────────────────────────────────── */

const SCOPE_KEY: Record<MemoryScopeKind, MemoryPageKey> = {
  profile: 'memory.scope.profile',
  persona: 'memory.scope.persona',
  bot: 'memory.scope.bot',
  group: 'memory.scope.group',
  project: 'memory.scope.project',
  conversation: 'memory.scope.conversation',
};

export function scopeKindLabel(t: MemoryT, kind: MemoryScopeKind): string {
  return t(SCOPE_KEY[kind]);
}

const STATUS_KEY: Record<MemoryItemStatus, MemoryPageKey> = {
  active: 'memory.status.active',
  pending: 'memory.status.pending',
  superseded: 'memory.status.superseded',
  rejected: 'memory.status.rejected',
  archived: 'memory.status.archived',
};

export function statusLabel(t: MemoryT, status: MemoryItemStatus): string {
  return t(STATUS_KEY[status]);
}

/** Archived, replaced or declined: kept on record, never recalled, and never brought back by a resolution. */
export function isPutAway(status: MemoryItemStatus): status is 'archived' | 'superseded' | 'rejected' {
  return status === 'archived' || status === 'superseded' || status === 'rejected';
}

/**
 * Why an in-use memory is still not recalled: recall reads only `validFrom <= now < validUntil`.
 * `kept` is a promise whose window closed (the Personal Agent marks a kept promise that way); `paused` is any
 * other memory whose window closed (for example one paused because the memory it came from changed).
 */
export type RecallHold = 'notYet' | 'kept' | 'paused';

export function recallHold(item: Pick<MemoryItem, 'status' | 'kind' | 'validFrom' | 'validUntil'>, now: number): RecallHold | null {
  if (item.status !== 'active') return null;
  if (item.validUntil !== null && item.validUntil <= now) return item.kind === 'promise' ? 'kept' : 'paused';
  if (item.validFrom !== null && item.validFrom > now) return 'notYet';
  return null;
}

/** One plain sentence saying who reads the memory of this scope. */
export function readersSentence(t: MemoryT, node: Pick<MemoryScopeNode, 'scope' | 'label'>): string {
  switch (node.scope.kind) {
    case 'profile':
      return t('memory.readers.profile');
    case 'persona':
      return t('memory.readers.persona');
    case 'bot':
      return t('memory.readers.bot', { name: node.label });
    case 'group':
      return t('memory.readers.group');
    case 'project':
      return t('memory.readers.project');
    case 'conversation':
      return t('memory.readers.conversation');
  }
}

/** The label a scope node shows: the profile's own name, a chat's title or "untitled". */
export function scopeNodeLabel(t: MemoryT, node: Pick<MemoryScopeNode, 'scope' | 'label'>): string {
  if (node.scope.kind === 'profile') return t('memory.nav.profile');
  const label = node.label.trim();
  if (label) return label;
  return node.scope.kind === 'conversation' ? t('memory.nav.untitled') : scopeKindLabel(t, node.scope.kind);
}

/** A failed request in words: no service, a stale revision, or the service's own message. */
export function errorMessage(t: MemoryT, error: unknown): string {
  if (error instanceof MemoryApiError) {
    if (error.code === MEMORY_OFFLINE) return t('memory.error.offline');
    if (error.code === MEMORY_ACCESS_REQUIRED) return t('memory.error.access');
    // A 409 MEMORY_INVALID is a step the current state refuses, not a newer version.
    if (error.code === 'MEMORY_INVALID' && error.status === 409) return t('memory.error.notNow');
    if (error.status === 409) return t('memory.error.stale');
    return error.message || t('memory.error.generic');
  }
  return t('memory.error.generic');
}

/* ── dates ─────────────────────────────────────────────────────────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 分钟前", "昨天", "11月9日", "2025年3月2日": relative inside a week, a date after that. */
export function formatWhen(ts: number, lang: string, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff >= 0 && diff < 7 * DAY) {
    const relative = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    if (diff < MINUTE) return relative.format(0, 'second');
    if (diff < HOUR) return relative.format(-Math.floor(diff / MINUTE), 'minute');
    if (diff < DAY) return relative.format(-Math.floor(diff / HOUR), 'hour');
    return relative.format(-Math.floor(diff / DAY), 'day');
  }
  return formatDay(ts, lang, now);
}

/** "11月9日" in this year, with the year otherwise. */
export function formatDay(ts: number, lang: string, now: number = Date.now()): string {
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(lang, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

/** The full date and time, for a tooltip. */
export function formatFull(ts: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
}

/** "11月9日 14:02–14:20"; two full stamps when the range crosses a day. */
export function formatTimeRange(startAt: number, endAt: number, lang: string, now: number = Date.now()): string {
  const time = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' });
  const start = new Date(startAt);
  const end = new Date(endAt);
  const day = formatDay(startAt, lang, now);
  if (start.toDateString() === end.toDateString()) {
    const from = time.format(start);
    const to = time.format(end);
    return from === to ? `${day} ${from}` : `${day} ${from}–${to}`;
  }
  return `${day} ${time.format(start)} – ${formatDay(endAt, lang, now)} ${time.format(end)}`;
}

/* ── the scope tree ────────────────────────────────────────────────────────────────────────── */

export function scopeKeyOf(scope: MemoryScopeRef): string {
  return memoryScopeKey(scope);
}

export function sameScope(a: MemoryScopeRef, b: MemoryScopeRef): boolean {
  return memoryScopeKey(a) === memoryScopeKey(b);
}

/** Every node in navigator order: profile, personas, bots, groups, projects each followed by its chats. */
export function scopeNodes(overview: MemoryOverviewResponse): MemoryScopeNode[] {
  const nodes: MemoryScopeNode[] = [overview.profile, ...overview.personas, ...overview.bots, ...overview.groups];
  for (const project of overview.projects) {
    nodes.push(project, ...(project.children ?? []));
  }
  return nodes;
}

export function findScopeNode(overview: MemoryOverviewResponse, scope: MemoryScopeRef | string): MemoryScopeNode | null {
  const key = typeof scope === 'string' ? scope : memoryScopeKey(scope);
  return scopeNodes(overview).find((node) => memoryScopeKey(node.scope) === key) ?? null;
}

/** The project a conversation node belongs to. */
export function parentProjectOf(overview: MemoryOverviewResponse, conversationId: string): MemoryScopeNode | null {
  return (
    overview.projects.find((project) =>
      (project.children ?? []).some((child) => child.scope.kind === 'conversation' && child.scope.id === conversationId),
    ) ?? null
  );
}

/** A node has something waiting for a person: an open disagreement or a proposal to confirm. */
export function nodeNeedsYou(node: MemoryScopeNode): boolean {
  return node.counts.conflicts > 0 || node.counts.pending > 0;
}

/** Replaces one node (matched by scope) anywhere in the tree, keeping everything else as it was. */
export function replaceScopeNode(
  overview: MemoryOverviewResponse,
  next: MemoryScopeNode,
): MemoryOverviewResponse {
  const key = memoryScopeKey(next.scope);
  const swap = (node: MemoryScopeNode): MemoryScopeNode => (memoryScopeKey(node.scope) === key ? next : node);
  return {
    ...overview,
    profile: swap(overview.profile),
    personas: overview.personas.map(swap),
    bots: overview.bots.map(swap),
    groups: overview.groups.map(swap),
    projects: overview.projects.map((project) => {
      const swapped = swap(project);
      return swapped.children ? { ...swapped, children: swapped.children.map(swap) } : swapped;
    }),
  };
}
