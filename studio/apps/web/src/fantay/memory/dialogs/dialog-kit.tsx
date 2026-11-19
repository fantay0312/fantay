// SPDX-License-Identifier: AGPL-3.0-only
// What the Memory Center dialogs share: one bridge to the page's label helpers, a per-open session key
// (each opening starts clean while a closing dialog keeps its content for the exit motion), a loader that
// ignores answers arriving after the dialog moved on, the scope picker built from the overview, error copy
// in plain words, and the diff renderers.
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  MemoryConflictResolution,
  MemoryItemKind,
  MemoryItemStatus,
  MemoryOverviewResponse,
  MemoryScopeKind,
  MemoryScopeNode,
  MemoryScopeRef,
  PaMemoryOriginKind,
} from '@open-design/contracts';
import { memoryScopeKey } from '@open-design/contracts';

import {
  Button,
  Callout,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
} from '../../ui';
import { memoryApi } from '../api';
import { useMemoryLocale, useMemoryT } from '../i18n';
import {
  formatDay,
  formatWhen,
  kindLabel,
  readersSentence,
  scopeKindLabel,
  scopeNodeLabel,
  statusLabel,
} from '../labels';
import { useMemoryDialogT, type MemoryDialogKey, type MemoryDialogT } from './i18n';
import frame from './MemoryDialogFrame.module.css';
import type { DiffPart, DiffSpan } from './text-diff';

/* ── labels: the page's helpers, bound once ───────────────────────────────────────────── */

export function useMemoryLabels() {
  const pageT = useMemoryT();
  const locale = useMemoryLocale();
  return useMemo(
    () => ({
      kind: (kind: MemoryItemKind) => kindLabel(pageT, kind),
      status: (status: MemoryItemStatus) => statusLabel(pageT, status),
      scopeKind: (kind: MemoryScopeKind) => scopeKindLabel(pageT, kind),
      /** The navigator's name for a scope: its label, 个人画像 for the profile, the kind when unnamed. */
      scope: (scope: MemoryScopeRef, label?: string) => scopeNodeLabel(pageT, { scope, label: label ?? '' }),
      when: (at: number) => formatWhen(at, locale),
      day: (at: number) => formatDay(at, locale),
      readers: (node: Pick<MemoryScopeNode, 'scope' | 'label'>) => readersSentence(pageT, node),
    }),
    [pageT, locale],
  );
}

export type MemoryLabels = ReturnType<typeof useMemoryLabels>;

/** Item kinds in the order people reach for them. */
export const KIND_ORDER: readonly MemoryItemKind[] = [
  'fact',
  'preference',
  'rule',
  'decision',
  'promise',
  'procedure',
  'moment',
  'episode',
  'reference',
  'feedback',
  'profile',
];

export function resolutionKey(resolution: MemoryConflictResolution): MemoryDialogKey {
  return `resolution.${resolution}` as MemoryDialogKey;
}

export function originLabel(origin: PaMemoryOriginKind, t: MemoryDialogT): string {
  return t(`origin.${origin}` as MemoryDialogKey);
}

/** `owner` → 你, `system` → Fantay, anything else (an agent) → a character. */
export function actorLabel(actor: string, t: MemoryDialogT): string {
  if (actor === 'owner') return t('actor.owner');
  if (actor === 'system' || actor === '') return t('actor.system');
  return t('actor.agent');
}

export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/* ── sessions and loading ─────────────────────────────────────────────────────────────── */

/** A key that changes each time the dialog opens (or opens on something else) and holds while it closes,
 *  so a keyed session component starts clean on every opening and keeps its content during the exit. */
export function useSessionKey(open: boolean, identity: string): string {
  const ref = useRef({ open: false, count: 0, identity });
  if (open && (!ref.current.open || ref.current.identity !== identity)) {
    ref.current = { open: true, count: ref.current.count + 1, identity };
  } else if (!open && ref.current.open) {
    ref.current = { ...ref.current, open: false };
  }
  return `${ref.current.count}:${ref.current.identity}`;
}

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload(): void;
  /** Shows a fresher answer that came back from an action, without asking again. */
  replace(data: T): void;
}

/** Loads while `key` is set. A new key clears the data (a skeleton shows); a reload keeps it on screen
 *  so a refresh after an action does not jump. `key: null` (closed) keeps the last state as it was. */
export function useLoader<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: unknown; loading: boolean }>({
    key: null,
    data: null,
    error: null,
    loading: false,
  });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setState((prev) =>
      prev.key === key ? { ...prev, loading: true, error: null } : { key, data: null, error: null, loading: true },
    );
    loadRef.current().then(
      (data) => {
        if (live) setState({ key, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (live) setState((prev) => ({ key, data: prev.key === key ? prev.data : null, error, loading: false }));
      },
    );
    return () => {
      live = false;
    };
  }, [key, nonce]);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const replace = useCallback(
    (data: T) => setState((prev) => (prev.key === null ? prev : { key: prev.key, data, error: null, loading: prev.loading })),
    [],
  );
  const current = key === null || state.key === key ? state : { key, data: null, error: null, loading: true };
  return { data: current.data, error: current.error, loading: current.loading, reload, replace };
}

/** The overview the page passed, or one fetched here when the page has none yet. */
export function useOverviewFallback(open: boolean, given: MemoryOverviewResponse | null) {
  const loaded = useLoader<MemoryOverviewResponse>(open && !given ? 'overview' : null, () => memoryApi.overview());
  return {
    overview: given ?? loaded.data,
    loading: !given && loaded.loading,
    error: given ? null : loaded.error,
    retry: loaded.reload,
  };
}

/* ── scopes ───────────────────────────────────────────────────────────────────────────── */

export interface ScopeOption {
  key: string;
  scope: MemoryScopeRef;
  label: string;
  sub: string | null;
  nested: boolean;
  node: MemoryScopeNode;
}

export interface ScopeOptionGroup {
  id: 'me' | 'bots' | 'groups' | 'projects';
  label: string;
  options: ScopeOption[];
}

export function scopeOptionGroups(
  overview: MemoryOverviewResponse,
  t: MemoryDialogT,
  labels: MemoryLabels,
  exclude?: string,
): ScopeOptionGroup[] {
  const option = (node: MemoryScopeNode, sub: string | null, nested = false): ScopeOption => ({
    key: memoryScopeKey(node.scope),
    scope: node.scope,
    label: labels.scope(node.scope, node.label),
    sub,
    nested,
    node,
  });
  const groups: ScopeOptionGroup[] = [
    {
      id: 'me',
      label: t('scope.group.me'),
      options: [
        option(overview.profile, null),
        ...overview.personas.map((node) => option(node, node.isDefault ? t('scope.personaDefault') : t('scope.persona'))),
      ],
    },
    {
      id: 'bots',
      label: t('scope.group.bots'),
      options: overview.bots.map((node) => option(node, node.isCharacter ? t('scope.botCharacter') : t('scope.botAssistant'))),
    },
    { id: 'groups', label: t('scope.group.groups'), options: overview.groups.map((node) => option(node, null)) },
    {
      id: 'projects',
      label: t('scope.group.projects'),
      options: overview.projects.flatMap((node) => [
        option(node, null),
        ...(node.children ?? []).map((child) => option(child, null, true)),
      ]),
    },
  ];
  return groups
    .map((group) => ({ ...group, options: group.options.filter((entry) => entry.key !== exclude) }))
    .filter((group) => group.options.length > 0);
}

export function findScopeOption(groups: readonly ScopeOptionGroup[], key: string): ScopeOption | null {
  for (const group of groups) {
    const found = group.options.find((entry) => entry.key === key);
    if (found) return found;
  }
  return null;
}

export function ScopeSelect({
  id,
  groups,
  value,
  onChange,
  disabled,
  placeholder,
  testId,
}: {
  id?: string;
  groups: readonly ScopeOptionGroup[];
  value: string;
  onChange(key: string): void;
  disabled?: boolean;
  placeholder: string;
  testId: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full" data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 ? <SelectSeparator /> : null}
            <SelectGroup>
              <SelectLabel>{group.label}</SelectLabel>
              {group.options.map((entry) => (
                <SelectItem key={entry.key} value={entry.key} className={entry.nested ? 'ps-6' : undefined}>
                  {entry.label}
                  {entry.sub ? <span className={frame.optionSub}>{` · ${entry.sub}`}</span> : null}
                </SelectItem>
              ))}
            </SelectGroup>
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ── errors ───────────────────────────────────────────────────────────────────────────── */

export interface ErrorCopy {
  lead: string;
  detail: string | null;
  /** The memory changed elsewhere (409): reload before trying again. */
  stale: boolean;
  code: string | null;
}

/** Plain words for a failed call. Known codes get their own sentence; anything else gets the fallback
 *  sentence with the service's own reason under it. */
export function describeError(error: unknown, t: MemoryDialogT, fallback: MemoryDialogKey = 'error.generic'): ErrorCopy {
  const raw = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof raw.code === 'string' ? raw.code : null;
  const status = typeof raw.status === 'number' ? raw.status : null;
  const message = typeof raw.message === 'string' && raw.message.trim() ? raw.message.trim() : null;
  const plain = (key: MemoryDialogKey, stale = false): ErrorCopy => ({ lead: t(key), detail: null, stale, code });
  if (code === 'MEMORY_SECRET_BLOCKED') return plain('error.secret');
  if (code === 'MEMORY_CONFLICT_RESOLVED') return plain('error.alreadyResolved', true);
  if (code === 'PA_ENTERPRISE_AUTH') return plain('error.access');
  // The current state refuses the step (409 MEMORY_INVALID): not a newer version, but worth reading again.
  if ((code === 'MEMORY_INVALID' || code === 'MEMORY_SIDE_PUT_AWAY') && status === 409) return plain('error.notNow', true);
  if (code === 'MEMORY_REVISION_CONFLICT' || status === 409) return plain('error.stale', true);
  if (code === 'MEMORY_FORBIDDEN' || status === 403) return plain('error.forbidden');
  if (code === 'MEMORY_NOT_FOUND' || status === 404) return plain('error.notFound');
  if (error instanceof TypeError || status === 0) return plain('error.offline');
  if (code === 'MEMORY_INVALID' || status === 400) return { lead: t('error.invalid'), detail: message, stale: false, code };
  return { lead: t(fallback), detail: message, stale: false, code };
}

export function ErrorNotice({
  error,
  fallback,
  onRetry,
  retryLabel,
  testId,
}: {
  error: unknown;
  fallback?: MemoryDialogKey;
  onRetry?(): void;
  retryLabel?: string;
  testId?: string;
}) {
  const { t } = useMemoryDialogT();
  const copy = describeError(error, t, fallback);
  return (
    <Callout tone="error" role="alert" className={frame.notice} data-testid={testId}>
      <span className={frame.noticeText}>
        <span>{copy.lead}</span>
        {copy.detail ? <span className={frame.noticeDetail}>{copy.detail}</span> : null}
      </span>
      {onRetry ? (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          {retryLabel ?? t('common.retry')}
        </Button>
      ) : null}
    </Callout>
  );
}

/* ── loading ──────────────────────────────────────────────────────────────────────────── */

/** Placeholder shaped like the content it stands in for: text lines, then list rows. */
export function LoadingBlock({ lines = 0, rows = 0, label, testId }: { lines?: number; rows?: number; label: string; testId?: string }) {
  const widths = ['92%', '78%', '64%', '86%', '52%'];
  return (
    <div className={frame.loading} role="status" aria-busy="true" aria-label={label} data-testid={testId}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={`l${index}`} shape="line" index={index} className={frame.loadingLine} style={{ width: widths[index % widths.length] }} />
      ))}
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={`r${index}`} shape="row" index={lines + index} />
      ))}
    </div>
  );
}

/* ── layout bits ──────────────────────────────────────────────────────────────────────── */

export function Section({
  title,
  count,
  aside,
  note,
  testId,
  className,
  children,
}: {
  title: ReactNode;
  count?: number;
  aside?: ReactNode;
  note?: ReactNode;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={cn(frame.section, className)} aria-labelledby={id} data-testid={testId}>
      <div className={frame.sectionHead}>
        <h3 id={id} className={frame.sectionTitle}>
          {title}
        </h3>
        {count !== undefined ? <span className={frame.sectionCount}>{count}</span> : null}
        {aside ? <span className={frame.sectionAside}>{aside}</span> : null}
      </div>
      {note ? <p className={frame.sectionNote}>{note}</p> : null}
      {children}
    </section>
  );
}

export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={frame.fact}>
      <span className={frame.factLabel}>{label}</span>
      <span className={frame.factValue}>{children}</span>
    </div>
  );
}

/* ── diff renderers ───────────────────────────────────────────────────────────────────── */

/** One side of a side-by-side comparison: the words the other side lacks are washed. */
export function DiffText({ spans, className, testId }: { spans: readonly DiffSpan[]; className?: string; testId?: string }) {
  return (
    <p className={cn(frame.text, className)} data-testid={testId}>
      {spans.map((span, index) =>
        span.changed ? (
          <mark key={index} className={frame.mark}>
            {span.text}
          </mark>
        ) : (
          <Fragment key={index}>{span.text}</Fragment>
        ),
      )}
    </p>
  );
}

/** One text showing what changed from the previous one: removed words struck, added words washed. */
export function InlineDiff({ parts, className }: { parts: readonly DiffPart[]; className?: string }) {
  return (
    <p className={cn(frame.text, className)}>
      {parts.map((part, index) =>
        part.op === 'equal' ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : part.op === 'delete' ? (
          <del key={index} className={frame.del}>
            {part.text}
          </del>
        ) : (
          <ins key={index} className={frame.ins}>
            {part.text}
          </ins>
        ),
      )}
    </p>
  );
}

/* ── dates ────────────────────────────────────────────────────────────────────────────── */

/** `YYYY-MM-DD` in local time for a date input. */
export function dateInputValue(at: number | null): string {
  if (at === null) return '';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a date input's value, or null when it is empty or not a date. */
export function parseDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(at) ? at : null;
}
