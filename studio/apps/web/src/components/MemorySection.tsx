import { SettingsSelect } from './SettingsSelect';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@open-design/components';
import { Icon } from './Icon';
import { ConnectorLogo, useResolvedTheme } from './ConnectorLogo';
import { useT } from '../i18n';

type Translate = ReturnType<typeof useT>;
import { renderMarkdown } from '../runtime/markdown';
import type {
  ConnectorDetail,
  ConnectorDiscoveryResponse,
  ConnectorMemorySuggestionResponse,
  ConnectorStatusResponse,
  MemoryChangeEvent,
  MemoryEntry,
  MemoryEntrySummary,
  MemoryExtractionEvent,
  MemoryExtractionRecord,
  MemoryExtractionSkipReason,
  MemoryExtractionsResponse,
  MemoryListResponse,
  MemoryTreeListResponse,
  MemoryTreeNode,
  MemorySuggestion,
  MemoryType,
} from '@open-design/contracts';
import {
  connectConnector,
  fetchConnectorStatuses,
} from '../providers/registry';
import { notifyConnectorsChanged } from './connectors-events';
import { hasConnectorStatusChanges } from './connectors-state';
import { MemoryProfilePanel } from './MemoryProfilePanel';
import { MemoryHooksPanel, type MemoryHookKey } from './MemoryHooksPanel';
import {
  hooksOffWhileEnabled,
  paintedMemoryFlags,
  type MemoryFlags,
} from './memory-switch-state';

// All manually-selectable memory types. `profile` (the structured singleton)
// and `rule` (verified checks the POST loop enforces) join the original four
// so the editor type-picker and the saved-memory filter pills surface them.
const TYPES: MemoryType[] = [
  'profile',
  'user',
  'feedback',
  'project',
  'reference',
  'rule',
];

interface DraftEntry {
  id?: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

const EMPTY_DRAFT: DraftEntry = {
  name: '',
  description: '',
  type: 'user',
  body: '',
};

// Click-to-prefill examples shown above the editor when creating a new
// memory. Three starters cover the most common reasons a person writes
// a memory by hand: tell the assistant about themselves, lock in a
// repeated UI/output preference, or pin the current project. The
// strings live behind i18n keys so each chip stays localized.
const STARTERS: ReadonlyArray<{
  type: MemoryType;
  nameKey: 'settings.memoryStarterUserName' | 'settings.memoryStarterFeedbackName' | 'settings.memoryStarterProjectName';
  descKey: 'settings.memoryStarterUserDesc' | 'settings.memoryStarterFeedbackDesc' | 'settings.memoryStarterProjectDesc';
  bodyKey: 'settings.memoryStarterUserBody' | 'settings.memoryStarterFeedbackBody' | 'settings.memoryStarterProjectBody';
}> = [
  {
    type: 'user',
    nameKey: 'settings.memoryStarterUserName',
    descKey: 'settings.memoryStarterUserDesc',
    bodyKey: 'settings.memoryStarterUserBody',
  },
  {
    type: 'feedback',
    nameKey: 'settings.memoryStarterFeedbackName',
    descKey: 'settings.memoryStarterFeedbackDesc',
    bodyKey: 'settings.memoryStarterFeedbackBody',
  },
  {
    type: 'project',
    nameKey: 'settings.memoryStarterProjectName',
    descKey: 'settings.memoryStarterProjectDesc',
    bodyKey: 'settings.memoryStarterProjectBody',
  },
];

const MEMORY_CONNECTOR_APP_IDS = [
  'notion',
  'figma',
  'linear',
  'google_drive',
  'github',
  'slack',
] as const;

const MEMORY_CONNECTOR_APP_LABELS: Record<string, string> = {
  notion: 'Notion',
  figma: 'Figma',
  linear: 'Linear',
  google_drive: 'Google Drive',
  github: 'GitHub',
  slack: 'Slack',
};

type ConnectorMemoryAttempt = ConnectorMemorySuggestionResponse['connectors'][number];
type ConnectorStatusMap = ConnectorStatusResponse['statuses'];

const CONNECTOR_CALLBACK_MESSAGE_TYPE = 'open-design:connector-connected';
const MEMORY_CONNECTOR_PENDING_AUTH_STORAGE_KEY = 'od:memory:pending-connector-auth';

function isTrustedConnectorCallbackOrigin(origin: string): boolean {
  const expectedOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  if (origin === expectedOrigin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return (
      url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]'
      || url.hostname === '::1'
    );
  } catch {
    return false;
  }
}

function readPendingConnectorAuthIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.sessionStorage.getItem(MEMORY_CONNECTOR_PENDING_AUTH_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0));
  } catch {
    return new Set();
  }
}

function writePendingConnectorAuthIds(ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    if (ids.size === 0) {
      window.sessionStorage.removeItem(MEMORY_CONNECTOR_PENDING_AUTH_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(
      MEMORY_CONNECTOR_PENDING_AUTH_STORAGE_KEY,
      JSON.stringify([...ids]),
    );
  } catch {
    // Session storage can be blocked; the in-memory state still works.
  }
}

// `null` means "we did not learn the daemon's config on this pass". It used to
// return a fabricated all-true config instead, which made every switch on this
// screen render green off the back of a failed request — a claim about the
// daemon made without having heard from it (OPEND-2606). Callers keep whatever
// they last knew and, on first paint, keep claiming nothing.
async function fetchMemoryList(): Promise<MemoryListResponse | null> {
  const resp = await fetch('/api/memory');
  if (!resp.ok) return null;
  return (await resp.json()) as MemoryListResponse;
}

async function fetchMemoryTree(): Promise<MemoryTreeNode[]> {
  const resp = await fetch('/api/memory/tree');
  if (!resp.ok) return [];
  const json = (await resp.json()) as MemoryTreeListResponse;
  return json.tree ?? [];
}

async function fetchMemoryEntry(id: string): Promise<MemoryEntry | null> {
  const resp = await fetch(`/api/memory/${encodeURIComponent(id)}`);
  if (!resp.ok) return null;
  const json = (await resp.json()) as { entry: MemoryEntry };
  return json.entry ?? null;
}

async function saveMemoryEntry(draft: DraftEntry): Promise<MemoryEntry | null> {
  const url = draft.id
    ? `/api/memory/${encodeURIComponent(draft.id)}`
    : '/api/memory';
  const resp = await fetch(url, {
    method: draft.id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (!resp.ok) return null;
  const json = (await resp.json()) as { entry: MemoryEntry };
  return json.entry ?? null;
}

function memoryEntryIdForConnectorSuggestion(suggestion: MemorySuggestion): string | undefined {
  return /^[a-z0-9_]+$/.test(suggestion.id) ? suggestion.id : undefined;
}

async function deleteMemoryEntry(id: string): Promise<boolean> {
  const resp = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return resp.ok;
}

async function saveMemoryIndex(index: string): Promise<boolean> {
  const resp = await fetch('/api/memory/index', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index }),
  });
  return resp.ok;
}

async function setMemoryEnabled(enabled: boolean): Promise<boolean> {
  const resp = await fetch('/api/memory/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return resp.ok;
}

// Patch a single per-hook config flag. The PATCH parser merges any subset of
// { chatExtractionEnabled, profileEnabled, rewriteEnabled, verifyEnabled } so
// the hooks panel can flip one flag without re-sending the others.
async function patchMemoryConfigFlag(
  flag: MemoryHookKey,
  value: boolean,
): Promise<boolean> {
  const resp = await fetch('/api/memory/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [flag]: value }),
  });
  return resp.ok;
}

async function fetchExtractions(): Promise<MemoryExtractionRecord[]> {
  const resp = await fetch('/api/memory/extractions');
  if (!resp.ok) return [];
  const json = (await resp.json()) as MemoryExtractionsResponse;
  return json.extractions ?? [];
}

async function fetchMemoryConnectors(): Promise<ConnectorDetail[]> {
  const resp = await fetch('/api/connectors/discovery?hydrateTools=false');
  if (!resp.ok) return [];
  const json = (await resp.json()) as ConnectorDiscoveryResponse;
  return json.connectors ?? [];
}

async function suggestConnectorMemories(
  connectorIds: string[],
  context: { chatAgentId?: string | null; chatModel?: string | null } = {},
): Promise<ConnectorMemorySuggestionResponse | null> {
  const body: {
    connectorIds: string[];
    chatAgentId?: string;
    chatModel?: string;
  } = { connectorIds };
  if (context.chatAgentId) body.chatAgentId = context.chatAgentId;
  if (context.chatModel) body.chatModel = context.chatModel;
  const resp = await fetch('/api/memory/connectors/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return null;
  return (await resp.json()) as ConnectorMemorySuggestionResponse;
}

function describeConnectorReadIssue(
  result: ConnectorMemorySuggestionResponse,
  t: Translate,
): string | null {
  const failed = result.connectors.filter((connector) => connector.status === 'failed');
  const skipped = result.connectors.filter((connector) => connector.status === 'skipped');
  const firstIssue = failed[0] ?? skipped[0];
  if (!firstIssue) return null;

  const connectorName =
    firstIssue.connectorName
    || MEMORY_CONNECTOR_APP_LABELS[firstIssue.connectorId]
    || firstIssue.connectorId;
  const reason = (firstIssue.error || firstIssue.summary || '').trim();
  const suffix = reason ? ` ${reason}` : '';

  if (failed.length > 0) {
    return `${t('memory.connectorReadFailed', { name: connectorName })}${suffix}`;
  }
  return `${t('memory.connectorNoReadableContent', { name: connectorName })}${suffix}`;
}

interface FriendlyExtractionFailure {
  title: string;
  detail: string;
  action?: string;
}

function providerDisplayName(
  provider: MemoryExtractionRecord['provider'] | undefined,
  t: Translate,
): string {
  if (provider?.credentialSource === 'chat-cli') {
    if (provider.kind === 'anthropic') return 'Claude Code';
    return t('memory.providerLocalCli');
  }
  switch (provider?.kind) {
    case 'anthropic':
      return 'Anthropic';
    case 'azure':
      return 'Azure OpenAI';
    case 'google':
      return 'Google Gemini';
    case 'ollama':
      return 'Ollama';
    case 'senseaudio':
      return 'SenseAudio';
    case 'aihubmix':
      return 'AIHubMix';
    case 'openai':
      return 'OpenAI';
    default:
      return t('memory.providerFallbackName');
  }
}

function parseProviderError(raw: string): { message: string; code: string; status: number | null } {
  const jsonStart = raw.indexOf('{');
  let message = raw.trim();
  let code = '';
  let status: number | null = null;

  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      const error = parsed?.error;
      if (typeof error?.message === 'string') message = error.message;
      else if (typeof parsed?.message === 'string') message = parsed.message;
      if (typeof error?.code === 'string') code = error.code;
      else if (typeof parsed?.code === 'string') code = parsed.code;
      if (typeof parsed?.status === 'number') status = parsed.status;
      else if (typeof error?.status === 'number') status = error.status;
    } catch {
      // Fall through to regex parsing below.
    }
  }

  const statusMatch = /\b(4\d\d|5\d\d)\b/.exec(raw);
  if (status === null && statusMatch?.[1]) status = Number(statusMatch[1]);

  return {
    message: message.replace(/\s+/g, ' ').trim(),
    code,
    status,
  };
}

function describeExtractionFailure(
  record: MemoryExtractionRecord,
  t: Translate,
): FriendlyExtractionFailure | null {
  if (record.phase !== 'failed' || !record.error) return null;
  const providerName = providerDisplayName(record.provider, t);
  const usesChatCli = record.provider?.credentialSource === 'chat-cli';
  const parsed = parseProviderError(record.error);
  const haystack = `${parsed.message} ${parsed.code} ${record.error}`.toLowerCase();
  const source =
    record.kind === 'connector'
      ? t('memory.extractionSourceConnector')
      : t('memory.extractionSourceChat');

  if (
    parsed.status === 401
    || /token[_ -]?expired|authentication token has expired|invalid[_ -]?api[_ -]?key|unauthorized/.test(haystack)
  ) {
    return {
      title: t('memory.failureAuthExpiredTitle', { provider: providerName }),
      detail: source,
      action: usesChatCli
        ? t('memory.failureAuthActionCli')
        : t('memory.failureAuthActionKey'),
    };
  }

  if (parsed.status === 429 || /rate limit|quota|too many requests|insufficient_quota/.test(haystack)) {
    return {
      title: t('memory.failureQuotaTitle', { provider: providerName }),
      detail: source,
      action: t('memory.failureQuotaAction'),
    };
  }

  if (/network|fetch failed|timeout|timed out|econnreset|enotfound/.test(haystack)) {
    return {
      title: t('memory.failureRequestTitle', { provider: providerName }),
      detail: source,
      action: usesChatCli
        ? t('memory.failureRequestActionCli')
        : t('memory.failureRequestActionProvider'),
    };
  }

  return {
    title: t('memory.failureGenericTitle'),
    detail: parsed.message || source,
    action: usesChatCli
      ? t('memory.failureGenericActionCli')
      : t('memory.failureGenericActionSettings'),
  };
}

function formatConnectorContextBytes(bytes: number, t: Translate): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return t('memory.noData');
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function connectorAttemptName(attempt: ConnectorMemoryAttempt): string {
  return attempt.connectorName
    || MEMORY_CONNECTOR_APP_LABELS[attempt.connectorId]
    || attempt.connectorId;
}

function connectorAttemptTitle(attempt: ConnectorMemoryAttempt, t: Translate): string {
  const connectorName = connectorAttemptName(attempt);
  if (attempt.status === 'succeeded') return t('memory.attemptReadTitle', { name: connectorName });
  if (attempt.status === 'failed') return t('memory.attemptFailedTitle', { name: connectorName });
  return t('memory.attemptSkippedTitle', { name: connectorName });
}

function connectorAttemptDetail(attempt: ConnectorMemoryAttempt): string {
  const parts = [
    attempt.toolTitle || attempt.toolName,
    attempt.status === 'failed' ? attempt.error : null,
    attempt.summary,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}

function mergeMemoryConnector(current: ConnectorDetail, next: ConnectorDetail): ConnectorDetail {
  return {
    ...current,
    ...next,
    tools: next.tools.length > 0 ? next.tools : current.tools,
    toolCount: next.toolCount ?? current.toolCount,
    toolsNextCursor: next.toolsNextCursor ?? current.toolsNextCursor,
    toolsHasMore: next.toolsHasMore ?? current.toolsHasMore,
  };
}

function upsertMemoryConnector(
  current: ConnectorDetail[],
  next: ConnectorDetail | null,
): ConnectorDetail[] {
  if (!next) return current;
  let found = false;
  const merged = current.map((connector) => {
    if (connector.id !== next.id) return connector;
    found = true;
    return mergeMemoryConnector(connector, next);
  });
  return found ? merged : [...merged, next];
}

function applyMemoryConnectorStatus(
  connector: ConnectorDetail,
  status: ConnectorStatusMap[string],
): ConnectorDetail {
  const { accountLabel: _accountLabel, lastError: _lastError, ...base } = connector;
  return { ...base, ...status };
}

function applyMemoryConnectorStatuses(
  current: ConnectorDetail[],
  statuses: ConnectorStatusMap,
): ConnectorDetail[] {
  if (Object.keys(statuses).length === 0) return current;
  return current.map((connector) => {
    const status = statuses[connector.id];
    if (!status) return connector;
    return applyMemoryConnectorStatus(connector, status);
  });
}

function connectorWithPendingAuthorization(connector: ConnectorDetail): ConnectorDetail {
  const { accountLabel: _accountLabel, lastError: _lastError, ...base } = connector;
  return {
    ...base,
    status: base.status === 'disabled' ? 'disabled' : 'available',
  };
}

// Drop one extraction row server-side. Returns true on a 2xx — the
// listing always re-fetches from the SSE stream, so the UI doesn't need
// the new state back here.
async function deleteExtraction(id: string): Promise<boolean> {
  const resp = await fetch(
    `/api/memory/extractions/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  return resp.ok;
}

async function clearExtractionHistory(): Promise<boolean> {
  const resp = await fetch('/api/memory/extractions', { method: 'DELETE' });
  return resp.ok;
}

// Map a record back to a single human label for the small badge that
// appears next to the row's preview text. Centralised so phase + skip
// reason render consistently across the empty banner and the list.
//
// `tone` only covers the four phases we actually render in the list —
// the `'deleted'` and `'cleared'` pseudo-phases ride the SSE channel
// and never show up in `extractions[]`, so they're filtered out before
// reaching describeRecord. We fall back to 'skipped' defensively in
// case a daemon-side regression sneaks one through.
function describeRecord(
  record: MemoryExtractionRecord,
  t: Translate,
): {
  phaseLabel: string;
  reasonLabel: string | null;
  kindLabel: string;
  tone: 'running' | 'success' | 'skipped' | 'failed';
} {
  const tone: 'running' | 'success' | 'skipped' | 'failed' =
    record.phase === 'running'
    || record.phase === 'success'
    || record.phase === 'failed'
      ? record.phase
      : 'skipped';
  const phaseLabel = (() => {
    switch (record.phase) {
      case 'running':
        return t('settings.memoryExtractionPhaseRunning');
      case 'success':
        return t('settings.memoryExtractionPhaseSuccess');
      case 'skipped':
        return t('settings.memoryExtractionPhaseSkipped');
      case 'failed':
        return t('settings.memoryExtractionPhaseFailed');
      default:
        return record.phase;
    }
  })();
  const reasonLabel = (() => {
    if (record.phase !== 'skipped') return null;
    const reason: MemoryExtractionSkipReason | undefined = record.reason;
    if (reason === 'no-provider') return t('settings.memoryExtractionSkipNoProvider');
    if (reason === 'unsupported-provider') {
      return t('settings.memoryExtractionSkipUnsupportedProvider');
    }
    if (reason === 'memory-disabled') return t('settings.memoryExtractionSkipDisabled');
    if (reason === 'chat-disabled') return t('memory.skipChatDisabled');
    if (reason === 'empty-message') return t('settings.memoryExtractionSkipEmpty');
    if (reason === 'no-match') return t('settings.memoryExtractionSkipNoMatch');
    return null;
  })();
  // Records written before the `kind` field existed default to 'llm' —
  // that was the only writer at the time, so labelling them as such
  // keeps the history list legible after upgrading.
  const kind = record.kind ?? 'llm';
  const kindLabel =
    kind === 'heuristic'
      ? t('settings.memoryExtractionKindHeuristic')
      : kind === 'connector'
        ? t('memory.kindConnectedApps')
      : t('settings.memoryExtractionKindLlm');
  return { phaseLabel, reasonLabel, kindLabel, tone };
}

function formatRelativeTime(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < 60_000) return `${Math.round(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h`;
  return `${Math.round(delta / 86_400_000)}d`;
}

// Wall-clock timestamp shown next to the relative age. The user asked
// to "see when each extraction started" — relative ages on their own
// drift after the panel sits open for a few minutes, and "5m" gives no
// hint about whether that 5m was during today's session or a stale row
// from yesterday. We omit the date for same-day rows so the line stays
// short, and tack on the date for older rows.
function formatAbsoluteTime(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  if (sameDay) return time;
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${day} ${time}`;
}

function formatDuration(record: MemoryExtractionRecord): string | null {
  if (!record.finishedAt) return null;
  const ms = Math.max(0, record.finishedAt - record.startedAt);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatRelativeTimeAgo(at: number, now: number, t: Translate): string {
  const relative = formatRelativeTime(at, now);
  return relative === '0s' ? t('common.justNow') : t('memory.timeAgo', { time: relative });
}

function extractionCardTitle(record: MemoryExtractionRecord, t: Translate): string {
  const kind = record.kind ?? 'llm';
  if (kind !== 'connector') {
    return record.userMessagePreview || t('settings.memoryExtractions');
  }

  if (record.phase === 'running') return t('memory.scanRunningTitle');
  if (record.phase === 'failed') return t('memory.scanFailedTitle');
  if (record.phase === 'skipped') return t('memory.scanSkippedTitle');

  if (record.phase === 'success') {
    const writtenCount =
      typeof record.writtenCount === 'number' ? record.writtenCount : null;
    if (writtenCount && writtenCount > 0) {
      return writtenCount === 1
        ? t('memory.scanSavedOne', { count: writtenCount })
        : t('memory.scanSavedOther', { count: writtenCount });
    }
    return t('memory.scanNoNewMemories');
  }

  return t('memory.scanTitle');
}

function extractionCardMeta(
  record: MemoryExtractionRecord,
  now: number,
  t: Translate,
): string {
  const kind = record.kind ?? 'llm';
  const age = formatRelativeTimeAgo(record.startedAt, now, t);
  if (kind === 'connector') {
    if (record.phase === 'running') return t('memory.scanMetaChecking');
    if (record.phase === 'failed') return `${t('memory.scanMetaNeedsAttention')} · ${age}`;
    if (record.phase === 'skipped') return `${t('settings.memoryExtractionPhaseSkipped')} · ${age}`;
    if (record.phase === 'success') {
      const writtenCount =
        typeof record.writtenCount === 'number' ? record.writtenCount : null;
      const result =
        writtenCount && writtenCount > 0
          ? t('memory.scanMetaFromConnectedApps')
          : t('memory.scanMetaCheckedApps');
      return `${result} · ${age}`;
    }
    return `${t('memory.kindConnectedApps')} · ${age}`;
  }

  const duration = formatDuration(record);
  const parts = [
    formatAbsoluteTime(record.startedAt, now),
    formatRelativeTime(record.startedAt, now),
  ];
  if (duration) parts.push(`${t('settings.memoryExtractionDuration')} ${duration}`);
  if (record.phase === 'success' && typeof record.writtenCount === 'number') {
    parts.push(`${record.writtenCount} ${t('settings.memoryExtractionWritten')}`);
  }
  return parts.join(' · ');
}

type FlashKind = 'created' | 'saved' | 'deleted' | 'indexSaved' | 'pathCopied';
type MemoryTab = 'profile' | 'manual' | 'chat' | 'connected';

interface MemorySectionProps {
  onOpenConnectors?: () => void;
  chatAgentId?: string | null;
  chatModel?: string | null;
}

export function MemorySection({
  onOpenConnectors,
  chatAgentId = null,
  chatModel = null,
}: MemorySectionProps = {}) {
  const t = useT();
  const logoTheme = useResolvedTheme();
  const [enabled, setEnabled] = useState(true);
  const [chatExtractionEnabled, setChatExtractionEnabled] = useState(true);
  // False until `GET /api/memory` has actually answered. Every switch position
  // on this screen is drawn through `paintedMemoryFlags`, which reads `null`
  // (i.e. this being false) as "claim nothing" rather than "everything is on".
  const [configKnown, setConfigKnown] = useState(false);
  // The three new per-hook flags (default-on). They live alongside the
  // existing chat-extraction flag and are surfaced through MemoryHooksPanel.
  const [profileEnabled, setProfileEnabled] = useState(true);
  const [rewriteEnabled, setRewriteEnabled] = useState(true);
  const [verifyEnabled, setVerifyEnabled] = useState(true);
  const [rootDir, setRootDir] = useState('');
  const [index, setIndex] = useState('');
  const [indexDraft, setIndexDraft] = useState<string | null>(null);
  const [entries, setEntries] = useState<MemoryEntrySummary[]>([]);
  const [memoryTree, setMemoryTree] = useState<MemoryTreeNode[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewBody, setPreviewBody] = useState<string | null>(null);
  const [editing, setEditing] = useState<DraftEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [filter, setFilter] = useState<'all' | MemoryType>('all');
  const [topTab, setTopTab] = useState<'memories' | 'how'>('memories');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [advancedModalOpen, setAdvancedModalOpen] = useState(false);
  // These dialogs open over Settings, which leaves Esc to them while one is up.
  // A dropdown open inside one consumes the key first, in the capture phase.
  const memoryDialogOpen = addModalOpen || advancedModalOpen;
  useEffect(() => {
    if (!memoryDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setAddModalOpen(false);
      setAdvancedModalOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [memoryDialogOpen]);
  const [activeTab, setActiveTab] = useState<MemoryTab>('profile');
  // Brief inline confirmation after a manual save/create/delete. The
  // form vanishes on success and the existing list re-renders, but
  // those signals are subtle — a 1.8s pill makes "your click did
  // something" obvious without the heavyweight global toast.
  const [flash, setFlash] = useState<{ kind: FlashKind; key: number } | null>(
    null,
  );
  const editorRef = useRef<HTMLDivElement | null>(null);
  const editorNameRef = useRef<HTMLInputElement | null>(null);
  const recordsRef = useRef<HTMLElement | null>(null);
  const editingTarget = editing?.id ?? (editing ? 'new' : null);
  // Recent LLM-extraction attempts, newest first. Driven by a one-shot
  // fetch on mount + live SSE updates merged by id so phase transitions
  // (running → success) replace the row in place.
  const [extractions, setExtractions] = useState<MemoryExtractionRecord[]>([]);
  const [connectors, setConnectors] = useState<ConnectorDetail[]>([]);
  const [connectorStatuses, setConnectorStatuses] = useState<ConnectorStatusMap>({});
  const [connectorsLoading, setConnectorsLoading] = useState(true);
  const [selectedConnectorIds, setSelectedConnectorIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [connectorExtracting, setConnectorExtracting] = useState(false);
  const [connectorSaving, setConnectorSaving] = useState(false);
  const [connectorSuggestions, setConnectorSuggestions] = useState<MemorySuggestion[]>([]);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [connectorAttempts, setConnectorAttempts] = useState<ConnectorMemoryAttempt[]>([]);
  const [connectorContextBytes, setConnectorContextBytes] = useState(0);
  const [connectorStatus, setConnectorStatus] = useState<string | null>(null);
  const [connectorError, setConnectorError] = useState<string | null>(null);
  const [connectingConnectorIds, setConnectingConnectorIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingConnectorAuthIds, setPendingConnectorAuthIds] = useState<Set<string>>(
    readPendingConnectorAuthIds,
  );
  const [connectorConnectErrors, setConnectorConnectErrors] = useState<Record<string, string>>({});
  const connectorsRef = useRef(connectors);

  const fireFlash = useCallback((kind: FlashKind) => {
    setFlash({ kind, key: Date.now() });
  }, []);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(id);
  }, [flash]);

  useEffect(() => {
    connectorsRef.current = connectors;
  }, [connectors]);

  useEffect(() => {
    if (!editingTarget) return;
    editorRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    editorNameRef.current?.focus({ preventScroll: true });
  }, [editingTarget]);

  const flashLabel = useMemo<Record<FlashKind, string>>(
    () => ({
      created: t('settings.memoryFlashCreated'),
      saved: t('settings.memoryFlashSaved'),
      deleted: t('settings.memoryFlashDeleted'),
      indexSaved: t('settings.memoryFlashIndexSaved'),
      pathCopied: t('settings.memoryFlashPathCopied'),
    }),
    [t],
  );

  const onCopyPath = useCallback(async () => {
    if (!rootDir) return;
    try {
      await navigator.clipboard.writeText(rootDir);
      fireFlash('pathCopied');
    } catch {
      // Some sandboxed contexts block clipboard writes silently. Fall
      // back to a transient input so the user can still grab the path
      // with a manual select-all + copy.
      const input = document.createElement('input');
      input.value = rootDir;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      fireFlash('pathCopied');
    }
  }, [rootDir, fireFlash]);

  const TYPE_LABEL: Record<MemoryType, string> = useMemo(
    () => ({
      profile: t('settings.memoryTypeProfile'),
      user: t('settings.memoryTypeUser'),
      feedback: t('settings.memoryTypeFeedback'),
      project: t('settings.memoryTypeProject'),
      reference: t('settings.memoryTypeReference'),
      rule: t('settings.memoryTypeRule'),
    }),
    [t],
  );

  // Reads can finish out of order (a mount read still in flight when a write's follow-up read starts);
  // only the latest one may paint, or an older answer undoes a change the user just made.
  const reloadSeqRef = useRef(0);
  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    const [list, tree] = await Promise.all([
      fetchMemoryList(),
      fetchMemoryTree(),
    ]);
    if (seq !== reloadSeqRef.current) return;
    setMemoryTree(tree);
    // A pass that never heard back leaves the previous knowledge in place and,
    // when there was none, leaves the switches claiming nothing at all.
    if (!list) return;
    setEnabled(list.enabled);
    setChatExtractionEnabled(list.chatExtractionEnabled !== false);
    setProfileEnabled(list.profileEnabled !== false);
    setRewriteEnabled(list.rewriteEnabled !== false);
    setVerifyEnabled(list.verifyEnabled !== false);
    setRootDir(list.rootDir);
    setIndex(list.index);
    setEntries(list.entries);
    setConfigKnown(true);
  }, []);

  const reloadExtractions = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const next = await fetchExtractions();
      setExtractions(next);
      return next;
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const reloadConnectors = useCallback(async () => {
    setConnectorsLoading(true);
    try {
      const statusesPromise = fetchConnectorStatuses();
      const connectorsPromise = fetchMemoryConnectors();
      const statuses = await statusesPromise;
      setConnectorStatuses(statuses);
      setConnectors((prev) => applyMemoryConnectorStatuses(prev, statuses));
      setConnectors(applyMemoryConnectorStatuses(await connectorsPromise, statuses));
    } finally {
      setConnectorsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    void reloadExtractions();
  }, [reload, reloadExtractions]);

  useEffect(() => {
    if (activeTab !== 'connected') return;
    void reloadConnectors();
  }, [activeTab, reloadConnectors]);

  useEffect(() => {
    writePendingConnectorAuthIds(pendingConnectorAuthIds);
  }, [pendingConnectorAuthIds]);

  // Live updates: when the daemon emits a memory change event (chat
  // hook, LLM extractor, settings PATCH from a different tab, curl…),
  // re-fetch the list so what the user sees stays in sync. We
  // deliberately ignore events the user just triggered themselves
  // (manual upserts/deletes via this same panel) by listening only to
  // the broader signals — the local code already updated state
  // optimistically, but a re-fetch keeps mtime / index in sync anyway,
  // so we just always reload on any change. EventSource auto-reconnects
  // on temporary daemon hiccups.
  useEffect(() => {
    const es = new EventSource('/api/memory/events');
    es.addEventListener('change', (raw) => {
      try {
        const ev = JSON.parse((raw as MessageEvent).data) as MemoryChangeEvent;
        // Don't reload if the event payload is just a connection ping.
        if (!ev || !ev.kind) return;
        void reload();
      } catch {
        // Malformed — ignore.
      }
    });
    es.addEventListener('extraction', (raw) => {
      try {
        const ev = JSON.parse((raw as MessageEvent).data) as MemoryExtractionEvent;
        if (!ev || !ev.id) return;
        // Pseudo-phases: the daemon emits these synthetically when a
        // row is dropped from the buffer, either by the manual delete
        // button per row or by the "Clear" affordance at the top.
        if (ev.phase === 'cleared') {
          setExtractions([]);
          return;
        }
        if (ev.phase === 'deleted') {
          setExtractions((prev) => prev.filter((r) => r.id !== ev.id));
          return;
        }
        // Merge by id: phase transitions for an in-flight attempt
        // collapse onto a single row instead of stacking N entries
        // for the same attempt. New ids are unshifted so the latest
        // appears at the top.
        setExtractions((prev) => {
          const existing = prev.findIndex((r) => r.id === ev.id);
          if (existing >= 0) {
            const next = prev.slice();
            next[existing] = ev;
            return next;
          }
          return [ev, ...prev].slice(0, 30);
        });
      } catch {
        // Malformed — ignore.
      }
    });
    return () => {
      es.close();
    };
  }, [reload]);

  const filtered = useMemo(() => {
    if (filter === 'all') return entries;
    return entries.filter((e) => e.type === filter);
  }, [entries, filter]);

  // The provider banner only shows when the most recent attempt skipped
  // because extraction could not resolve a usable provider. We don't show it
  // for memory-disabled (the user's own toggle) or empty-message (a routine
  // no-op on tool-only turns); those skips just appear in the history list
  // with a muted subtitle.
  const providerConfigBanner = useMemo(() => {
    const latest = extractions[0];
    if (!latest || latest.phase !== 'skipped') return null;
    if (latest.reason === 'no-provider') {
      return {
        title: t('settings.memoryNoProviderBannerTitle'),
        body: t('settings.memoryNoProviderBannerBody'),
      };
    }
    if (latest.reason === 'unsupported-provider') {
      return {
        title: t('settings.memoryNoProviderBannerTitle'),
        body: t('settings.memoryUnsupportedProviderBannerBody'),
      };
    }
    return null;
  }, [extractions, t]);

  // Now-clock for relative timestamps in the extraction list. Refresh
  // every 30s so "12s ago" doesn't get stuck reading "12s ago" five
  // minutes after the user opened the panel. Using state (not a ref)
  // keeps the re-render in the React scheduler.
  const [nowClock, setNowClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

	  const connectorExtractions = useMemo(
	    () => extractions.filter((record) => record.kind === 'connector'),
	    [extractions],
  );
  const visibleExtractions = useMemo(
    () =>
      filter === 'all'
        ? extractions.filter((record) => record.kind !== 'connector')
        : [],
    [extractions, filter],
  );
  const unifiedMemoryCount = filtered.length + visibleExtractions.length;
  const memoryConnectors = useMemo(() => {
    const byId = new Map(connectors.map((connector) => [connector.id, connector]));
    return MEMORY_CONNECTOR_APP_IDS.map((id) => {
      const connector = byId.get(id);
      const status = connectorStatuses[id];
      if (connector) {
        return status ? applyMemoryConnectorStatus(connector, status) : connector;
      }
      return {
        id,
        name: MEMORY_CONNECTOR_APP_LABELS[id] ?? id,
        provider: 'composio',
        category: 'Memory source',
        status: status?.status ?? 'available' as const,
        ...(status?.accountLabel ? { accountLabel: status.accountLabel } : {}),
        ...(status?.lastError ? { lastError: status.lastError } : {}),
        tools: [],
      };
    });
  }, [connectorStatuses, connectors]);
  const connectorIdsWithDetails = useMemo(
    () => new Set(connectors.map((connector) => connector.id)),
    [connectors],
  );
  const connectedMemoryConnectors = useMemo(
    () => memoryConnectors.filter((connector) => connector.status === 'connected'),
    [memoryConnectors],
  );
  const selectedConnectedConnectorIds = useMemo(
    () =>
      [...selectedConnectorIds].filter((id) =>
        connectedMemoryConnectors.some((connector) => connector.id === id),
      ),
	    [selectedConnectorIds, connectedMemoryConnectors],
	  );
	  const connectedCount = connectedMemoryConnectors.length;
	  const connectorScanLabel = connectorExtracting
	    ? t('memory.scanBusyLabel')
	    : selectedConnectedConnectorIds.length === 0
	      ? t('memory.scanSelectPrompt')
	      : t('memory.scanSelectedApps');
	  const selectedConnectorSuggestions = useMemo(
	    () => connectorSuggestions.filter((suggestion) => selectedSuggestionIds.has(suggestion.id)),
	    [connectorSuggestions, selectedSuggestionIds],
	  );

  useEffect(() => {
    setSelectedConnectorIds((prev) => {
      const connectedIds = connectedMemoryConnectors.map((connector) => connector.id);
      const connected = new Set(connectedIds);
      const next = new Set([...prev].filter((id) => connected.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [connectedMemoryConnectors]);

  const treeFolders = useMemo(
    () => memoryTree.filter((node) => node.kind === 'folder'),
    [memoryTree],
  );

  const treeChildren = useMemo(() => {
    const map = new Map<string, MemoryTreeNode[]>();
    for (const node of memoryTree) {
      if (node.kind !== 'entry' || !node.parentId) continue;
      const list = map.get(node.parentId) ?? [];
      list.push(node);
      map.set(node.parentId, list);
    }
    return map;
  }, [memoryTree]);

  const openPreview = useCallback(
    async (id: string) => {
      if (previewId === id) {
        setPreviewId(null);
        setPreviewBody(null);
        return;
      }
      setPreviewId(id);
      setPreviewBody(null);
      const entry = await fetchMemoryEntry(id);
      setPreviewBody(entry?.body ?? '');
    },
    [previewId],
  );

  const startEdit = useCallback(async (id: string) => {
    const entry = await fetchMemoryEntry(id);
    if (!entry) return;
    setTopTab('memories');
    setAddModalOpen(true);
    setActiveTab('manual');
    setEditing({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      type: entry.type,
      body: entry.body,
    });
  }, []);

  const startNew = useCallback(() => {
    setTopTab('memories');
    setAddModalOpen(true);
    setActiveTab('manual');
    setEditing({ ...EMPTY_DRAFT });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
  }, []);

  const toggleConnectorSelection = useCallback((connectorId: string) => {
    setSelectedConnectorIds((prev) => {
      const next = new Set(prev);
      if (next.has(connectorId)) {
        next.delete(connectorId);
      } else {
        next.add(connectorId);
      }
      return next;
    });
  }, []);

  const refreshMemoryConnectorStatuses = useCallback(async () => {
    const statuses = await fetchConnectorStatuses();
    const statusChanged = hasConnectorStatusChanges(connectorsRef.current, statuses);
    setConnectorStatuses(statuses);
    setConnectors((prev) => applyMemoryConnectorStatuses(prev, statuses));
    setPendingConnectorAuthIds((prev) => {
      const next = new Set(prev);
      for (const connectorId of prev) {
        if (statuses[connectorId]?.status === 'connected') next.delete(connectorId);
      }
      return next.size === prev.size ? prev : next;
    });
    setConnectorConnectErrors((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [connectorId, status] of Object.entries(statuses)) {
        if (status.status === 'connected' && next[connectorId] !== undefined) {
          delete next[connectorId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    if (statusChanged) notifyConnectorsChanged();
  }, []);

  useEffect(() => {
    if (pendingConnectorAuthIds.size === 0) return;
    const interval = window.setInterval(() => {
      void refreshMemoryConnectorStatuses();
    }, 2_000);
    const onFocus = () => {
      void refreshMemoryConnectorStatuses();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [pendingConnectorAuthIds, refreshMemoryConnectorStatuses]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if ((data as { type?: unknown }).type !== CONNECTOR_CALLBACK_MESSAGE_TYPE) return;
      if (!isTrustedConnectorCallbackOrigin(event.origin)) return;
      void refreshMemoryConnectorStatuses();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refreshMemoryConnectorStatuses]);

  const onConnectMemoryConnector = useCallback(async (connectorId: string) => {
    if (connectingConnectorIds.has(connectorId)) return;
    setConnectingConnectorIds((prev) => new Set(prev).add(connectorId));
    setConnectorConnectErrors((prev) => {
      if (prev[connectorId] === undefined) return prev;
      const next = { ...prev };
      delete next[connectorId];
      return next;
    });
    try {
      const result = await connectConnector(connectorId);
      if (result.connector?.status === 'connected') notifyConnectorsChanged();
      const requiresAuthorizationCompletion =
        result.auth?.kind === 'redirect_required' || result.auth?.kind === 'pending';
      setConnectors((prev) =>
        upsertMemoryConnector(
          prev,
          requiresAuthorizationCompletion && result.connector
            ? connectorWithPendingAuthorization(result.connector)
            : result.connector,
        ),
      );
      if (result.error) {
        setConnectorConnectErrors((prev) => ({ ...prev, [connectorId]: result.error! }));
        setPendingConnectorAuthIds((prev) => {
          if (!prev.has(connectorId)) return prev;
          const next = new Set(prev);
          next.delete(connectorId);
          return next;
        });
        return;
      }
      if (result.auth?.kind === 'redirect_required' || result.auth?.kind === 'pending') {
        setPendingConnectorAuthIds((prev) => new Set(prev).add(connectorId));
      } else {
        setPendingConnectorAuthIds((prev) => {
          if (!prev.has(connectorId)) return prev;
          const next = new Set(prev);
          next.delete(connectorId);
          return next;
        });
      }
      await refreshMemoryConnectorStatuses();
    } finally {
      setConnectingConnectorIds((prev) => {
        if (!prev.has(connectorId)) return prev;
        const next = new Set(prev);
        next.delete(connectorId);
        return next;
      });
    }
  }, [connectingConnectorIds, refreshMemoryConnectorStatuses]);

  const toggleConnectorSuggestion = useCallback((suggestionId: string) => {
    setSelectedSuggestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(suggestionId)) {
        next.delete(suggestionId);
      } else {
        next.add(suggestionId);
      }
      return next;
    });
  }, []);

  const onSuggestConnectorMemory = useCallback(async () => {
    if (selectedConnectedConnectorIds.length === 0) return;
    setConnectorExtracting(true);
    setConnectorSuggestions([]);
    setSelectedSuggestionIds(new Set());
    setConnectorAttempts([]);
    setConnectorContextBytes(0);
    setConnectorStatus(null);
    setConnectorError(null);
    const startedAt = Date.now();
    try {
      const result = await suggestConnectorMemories(selectedConnectedConnectorIds, {
        chatAgentId,
        chatModel,
      });
      if (!result) {
        setConnectorError(t('memory.connectorReadFailedRetry'));
        return;
      }
      const latestExtractions = await reloadExtractions();
      const latestFailure = latestExtractions.find(
        (record) =>
          record.kind === 'connector'
          && record.phase === 'failed'
          && record.startedAt >= startedAt - 5_000,
      );
      const friendlyFailure = latestFailure
        ? describeExtractionFailure(latestFailure, t)
        : null;
      setConnectorAttempts(result.connectors);
      setConnectorContextBytes(result.contextBytes);
      const succeeded = result.connectors.filter(
        (connector) => connector.status === 'succeeded',
      ).length;
      if (friendlyFailure) {
        setConnectorError([
          friendlyFailure.title,
          friendlyFailure.detail,
          friendlyFailure.action,
        ].filter(Boolean).join(' '));
      } else if (result.suggestions.length > 0) {
        setConnectorSuggestions(result.suggestions);
        setSelectedSuggestionIds(new Set(result.suggestions.map((suggestion) => suggestion.id)));
        const appsLabel =
          succeeded === 1
            ? t('memory.appCountOne', { count: succeeded })
            : t('memory.appCountOther', { count: succeeded });
        setConnectorStatus(
          result.suggestions.length === 1
            ? t('memory.foundSuggestionsOne', {
              count: result.suggestions.length,
              apps: appsLabel,
            })
            : t('memory.foundSuggestionsOther', {
              count: result.suggestions.length,
              apps: appsLabel,
            }),
        );
      } else if (!result.attemptedLLM) {
        setConnectorError(
          describeConnectorReadIssue(result, t)
          ?? t('memory.noSuggestionsFound'),
        );
      } else {
        setConnectorStatus(
          succeeded === 1
            ? t('memory.checkedNoSuggestionsOne', { count: succeeded })
            : t('memory.checkedNoSuggestionsOther', { count: succeeded }),
        );
      }
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectorExtracting(false);
    }
  }, [chatAgentId, chatModel, reloadExtractions, selectedConnectedConnectorIds, t]);

  const onDiscardConnectorSuggestions = useCallback(() => {
    setConnectorSuggestions([]);
    setSelectedSuggestionIds(new Set());
    setConnectorAttempts([]);
    setConnectorContextBytes(0);
    setConnectorStatus(null);
  }, []);

  const onSaveConnectorSuggestions = useCallback(async () => {
    if (selectedConnectorSuggestions.length === 0) return;
    setConnectorSaving(true);
    setConnectorError(null);
    try {
      const saved: MemoryEntry[] = [];
      const savedSuggestionIds = new Set<string>();
      for (const suggestion of selectedConnectorSuggestions) {
        const entry = await saveMemoryEntry({
          id: memoryEntryIdForConnectorSuggestion(suggestion),
          name: suggestion.name,
          description: suggestion.description,
          type: suggestion.type,
          body: suggestion.body,
        });
        if (entry) {
          saved.push(entry);
          savedSuggestionIds.add(suggestion.id);
        }
      }
      await reload();
      const savedEntriesById = new Map(saved.map((entry) => [entry.id, entry]));
      setConnectorSuggestions((prev) =>
        prev.filter((suggestion) => !savedSuggestionIds.has(suggestion.id)),
      );
      setSelectedSuggestionIds(
        new Set(
          selectedConnectorSuggestions
            .filter((suggestion) => !savedSuggestionIds.has(suggestion.id))
            .map((suggestion) => suggestion.id),
        ),
      );
      setConnectorStatus(
        savedEntriesById.size === 1
          ? t('memory.savedFromConnectedAppsOne', { count: savedEntriesById.size })
          : t('memory.savedFromConnectedAppsOther', { count: savedEntriesById.size }),
      );
      if (savedEntriesById.size !== selectedConnectorSuggestions.length) {
        setConnectorError(
          t('memory.savedPartial', {
            saved: savedEntriesById.size,
            total: selectedConnectorSuggestions.length,
          }),
        );
      }
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectorSaving(false);
    }
  }, [reload, selectedConnectorSuggestions, t]);

  const onSave = useCallback(async () => {
    if (!editing) return;
    if (!editing.name.trim()) return;
    const wasNew = !editing.id;
    setBusy(true);
    try {
      const entry = await saveMemoryEntry(editing);
      if (entry) {
        await reload();
        setEditing(null);
        setAddModalOpen(false);
        fireFlash(wasNew ? 'created' : 'saved');
      }
    } finally {
      setBusy(false);
    }
  }, [editing, reload, fireFlash]);

  const onDelete = useCallback(
    async (id: string) => {
      const ok = await deleteMemoryEntry(id);
      if (ok) {
        await reload();
        fireFlash('deleted');
      }
    },
    [reload, fireFlash],
  );

  const onToggleEnabled = useCallback(async (next: boolean) => {
    setEnabled(next);
    await setMemoryEnabled(next);
    // A read that began before this write can land after the optimistic set and undo it.
    await reload();
  }, [reload]);

  // Map each hook key to its setter so a single optimistic-set + rollback path
  // covers all four toggles.
  const HOOK_SETTERS: Record<MemoryHookKey, (fn: (cur: boolean) => boolean) => void> = {
    profileEnabled: setProfileEnabled,
    rewriteEnabled: setRewriteEnabled,
    verifyEnabled: setVerifyEnabled,
    chatExtractionEnabled: setChatExtractionEnabled,
  };

  const onToggleHook = useCallback(
    async (key: MemoryHookKey, next: boolean) => {
      const setter = HOOK_SETTERS[key];
      setter(() => next);
      const ok = await patchMemoryConfigFlag(key, next);
      if (!ok) setter((current) => !current);
    },
    // HOOK_SETTERS references stable useState setters, so the deps are empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The daemon's config as far as we actually know it; `null` until the first
  // successful read. Everything the screen renders about on/off state is
  // derived from this one value, so a switch cannot get ahead of the daemon.
  const knownFlags = useMemo<MemoryFlags | null>(
    () => (configKnown
      ? {
        enabled,
        chatExtractionEnabled,
        profileEnabled,
        rewriteEnabled,
        verifyEnabled,
      }
      : null),
    [
      configKnown,
      enabled,
      chatExtractionEnabled,
      profileEnabled,
      rewriteEnabled,
      verifyEnabled,
    ],
  );
  const painted = useMemo(() => paintedMemoryFlags(knownFlags), [knownFlags]);
  const hookFlags = useMemo<Record<MemoryHookKey, boolean>>(
    () => ({
      profileEnabled: painted.profileEnabled,
      rewriteEnabled: painted.rewriteEnabled,
      verifyEnabled: painted.verifyEnabled,
      chatExtractionEnabled: painted.chatExtractionEnabled,
    }),
    [painted],
  );
  // Capabilities the master switch would otherwise silently claim. Memory reads
  // and memory writes are separate switches in the daemon, so the view that
  // owns the master toggle has to show every one of them that is not running —
  // rather than leaving the user to find it under a second tab (OPEND-2606).
  const undisclosedHooks = useMemo(
    () => hooksOffWhileEnabled(knownFlags),
    [knownFlags],
  );

  const onSaveIndex = useCallback(async () => {
    if (indexDraft === null) return;
    setBusy(true);
    try {
      const ok = await saveMemoryIndex(indexDraft);
      if (ok) {
        setIndex(indexDraft);
        setIndexDraft(null);
        fireFlash('indexSaved');
      }
    } finally {
      setBusy(false);
    }
  }, [indexDraft, fireFlash]);

  const onDeleteExtraction = useCallback(async (id: string) => {
    // Optimistic removal: drop the row immediately so the click feels
    // instant. The SSE 'deleted' event will arrive moments later and is
    // a no-op against an already-removed id; if the request fails we
    // re-fetch to put the row back instead of silently lying.
    setExtractions((prev) => prev.filter((r) => r.id !== id));
    const ok = await deleteExtraction(id);
    if (!ok) {
      void reloadExtractions();
    }
  }, [reloadExtractions]);

  const onClearExtractions = useCallback(async () => {
    if (!window.confirm(t('settings.memoryExtractionsClearConfirm'))) return;
    setExtractions([]);
    const ok = await clearExtractionHistory();
    if (!ok) {
      void reloadExtractions();
    }
  }, [reloadExtractions, t]);

  const memoryTabs: ReadonlyArray<{ id: MemoryTab; label: string }> = [
    { id: 'profile', label: t('settings.memoryProfileTab') },
    { id: 'manual', label: t('memory.tabManual') },
    { id: 'connected', label: t('memory.tabConnected') },
  ];

  const renderMemoryEntry = (entry: MemoryEntrySummary) => (
    <div key={entry.id} className="library-card">
      <div className="library-card-info">
        <div className="library-card-title-row">
          <span className="library-card-name">{entry.name}</span>
        </div>
        <div className="library-card-desc">
          {entry.description || '—'}
        </div>
      </div>
      {/* The chevron stays last: it is the one control always on show, so it holds the row's right edge. */}
      <div className="memory-card-actions">
        <button
          type="button"
          className="ghost library-card-action"
          onClick={() => startEdit(entry.id)}
          title={t('settings.memoryEdit')}
        >
          <Icon name="edit" size={14} />
        </button>
        <button
          type="button"
          className="ghost library-card-action"
          onClick={() => onDelete(entry.id)}
          title={t('settings.memoryDelete')}
        >
          <Icon name="close" size={14} />
        </button>
        <button
          type="button"
          className="library-card-expand"
          onClick={() => openPreview(entry.id)}
          title={t('settings.memoryPreview')}
        >
          <Icon
            name={previewId === entry.id ? 'chevron-down' : 'chevron-right'}
            size={14}
          />
        </button>
      </div>
      {previewId === entry.id && (
        <div className="library-preview">
          {previewBody === null ? (
            <p>{t('common.loading')}</p>
          ) : previewBody ? (
            <div className="library-preview-body">
              {renderMarkdown(previewBody)}
            </div>
          ) : (
            <p className="hint">—</p>
          )}
        </div>
      )}
    </div>
  );

  const renderExtractionCard = (record: MemoryExtractionRecord) => {
    const desc = describeRecord(record, t);
    const title = extractionCardTitle(record, t);
    const meta = extractionCardMeta(record, nowClock, t);
    return (
      <div
        key={record.id}
        className={`library-card memory-extraction-card is-${desc.tone}`}
      >
        <div className="library-card-info">
          <div className="library-card-title-row">
            <span className="library-card-name">
              {title}
            </span>
          </div>
          <div className="memory-extraction-meta">
            <span className={`memory-extraction-pill is-${desc.tone}`}>
              {desc.phaseLabel}
            </span>
            <span className="library-card-badge">
              {desc.kindLabel}
            </span>
            <span className="library-card-desc">
              {meta}
            </span>
          </div>
          {desc.reasonLabel ? (
            <div className="memory-extraction-reason">
              {desc.reasonLabel}
            </div>
          ) : null}
          {record.phase === 'failed' && record.error ? (
            <div className="memory-extraction-failure">
              {(() => {
                const failure = describeExtractionFailure(record, t);
                if (!failure) return null;
                return (
                  <>
                    <strong>{failure.title}</strong>
                    <span>{failure.detail}</span>
                    {failure.action ? <span>{failure.action}</span> : null}
                  </>
                );
              })()}
            </div>
          ) : null}
          {Array.isArray(record.writtenIds) &&
          record.writtenIds.length > 0 ? (
            <div className="memory-extraction-counts">
              <span>
                {t('settings.memoryExtractionWritten')}
              </span>
              <span className="memory-extraction-ids">
                {record.writtenIds.map((id: string) => (
                  <button
                    key={id}
                    type="button"
                    className="filter-pill"
                    onClick={() => openPreview(id)}
                    title={id}
                  >
                    {id}
                  </button>
                ))}
              </span>
            </div>
          ) : null}
        </div>
        <div className="memory-card-actions">
          <button
            type="button"
            className="ghost library-card-action"
            onClick={() => void onDeleteExtraction(record.id)}
            title={t('settings.memoryExtractionDelete')}
            aria-label={t('settings.memoryExtractionDelete')}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <section
        className={`settings-section settings-section-card memory-create-section${enabled ? '' : ' is-disabled'}`}
      >
      {/* These switch the whole page, so they sit straight under its title. */}
      <div
        className="memory-top-tabs"
        role="tablist"
        aria-label={t('settings.memory')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={topTab === 'memories'}
          className={`memory-top-tab${topTab === 'memories' ? ' active' : ''}`}
          onClick={() => setTopTab('memories')}
        >
          {t('settings.memoryTabMemories')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={topTab === 'how'}
          className={`memory-top-tab${topTab === 'how' ? ' active' : ''}`}
          onClick={() => setTopTab('how')}
        >
          {t('settings.memoryTabHow')}
        </button>
      </div>

      <div className="memory-master">
        <div className="memory-rows">
          <div className="memory-row">
            <div className="memory-row-copy">
              <span className="memory-row-label">{t('settings.memoryEnableLabel')}</span>
              <p className="hint">{t('settings.memoryDescription')}</p>
            </div>
            <label
              className="toggle-switch"
              title={t('settings.memoryEnableLabel')}
              aria-label={t('settings.memoryEnableLabel')}
            >
              <input
                type="checkbox"
                checked={painted.enabled}
                onChange={(e) => onToggleEnabled(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          {topTab === 'memories' ? (
            <button
              type="button"
              className="memory-row memory-row--link"
              onClick={() => setAdvancedModalOpen(true)}
              aria-label={t('settings.advanced')}
            >
              <span className="memory-row-copy">
                <span className="memory-row-label">{t('settings.advanced')}</span>
                <span className="hint">{t('memory.advancedHint')}</span>
              </span>
              <Icon name="chevron-right" size={16} />
            </button>
          ) : null}
        </div>

        {configKnown && !enabled ? (
          <div role="status" className="memory-disabled-banner">
            <strong>{t('settings.memoryDisabled')}</strong> —{' '}
            {t('settings.memoryDisabledBanner')}
          </div>
        ) : null}

        {enabled && providerConfigBanner ? (
          <div role="status" className="memory-noprovider-banner">
            <strong>{providerConfigBanner.title}</strong> —{' '}
            {providerConfigBanner.body}
          </div>
        ) : null}
      </div>

      {/*
        The master switch above reads as "memory is on". It is not the switch
        that mines new conversations — that is `chatExtractionEnabled`, which
        the daemon defaults to off — so every hook that is not running is shown
        here, with its own switch and its own state, on the view the master
        switch lives on. `undisclosedHooks` is empty once they all match, and
        the "How it works" tab keeps the full panel, so no row is drawn twice.
      */}
      {topTab === 'memories' && undisclosedHooks.length > 0 ? (
        <MemoryHooksPanel
          enabled={painted.enabled}
          flags={hookFlags}
          onToggle={onToggleHook}
          hooks={undisclosedHooks}
          testId="memory-hooks-undisclosed"
        />
      ) : null}

      {topTab === 'how' ? (
        <div className="memory-how-panel">
          <div className="memory-how-intro">
            <div className="memory-auto-flow">
              <span>{t('memory.flowOnboarding')}</span>
              <Icon name="chevron-right" size={14} />
              <span>{t('memory.flowBrandContext')}</span>
              <Icon name="chevron-right" size={14} />
              <span>{t('memory.flowChatSignals')}</span>
              <Icon name="chevron-right" size={14} />
              <strong>{t('memory.flowSavedMemory')}</strong>
            </div>
            <p className="memory-how-copy">
              {t('memory.howCopy')}
            </p>
          </div>
          <MemoryHooksPanel
            enabled={enabled}
            flags={hookFlags}
            onToggle={onToggleHook}
          />
        </div>
      ) : null}

      {/*
        Rendered before the add dialog so that editing a tree entry, which opens
        the add dialog from in here, stacks on top. Both stay inside the page
        rather than in a portal: that is what lets them inherit the Settings
        controls, fields and spacing instead of restating them.
      */}
      {advancedModalOpen ? (
      <div
        className="memory-action-modal-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setAdvancedModalOpen(false);
          }
        }}
      >
        <div
          className="memory-action-modal memory-action-modal--advanced"
          role="dialog"
          aria-modal="true"
          aria-labelledby="memory-advanced-modal-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="memory-action-modal-head">
            <div>
              <h3 id="memory-advanced-modal-title">{t('settings.advanced')}</h3>
              <p>{t('memory.advancedHint')}</p>
            </div>
            <button
              type="button"
              className="memory-action-modal-close"
              onClick={() => setAdvancedModalOpen(false)}
              aria-label={t('common.close')}
              title={t('common.close')}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="memory-action-modal-body memory-advanced-modal-body">
            <div className="memory-advanced-stack">
              {rootDir ? (
                <div className="memory-path-row">
                  <code title={rootDir}>{rootDir}</code>
                  {flash?.kind === 'pathCopied' ? (
                    <span key={flash.key} className="memory-path-copied-badge">
                      {flashLabel.pathCopied}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="memory-icon-action"
                    onClick={() => void onCopyPath()}
                    title={t('memory.storagePathAria')}
                    aria-label={t('memory.storagePathAria')}
                  >
                    <Icon name="copy" size={14} />
                  </button>
                </div>
              ) : null}
              <details className="library-group memory-advanced-card">
                <summary className="memory-details-summary">
                  <span className="memory-details-title">
                    {t('settings.memoryIndex')}
                  </span>
                  <Icon name="chevron-right" size={16} />
                </summary>
                <div className="memory-advanced-card-body">
                  <textarea
                    value={indexDraft ?? index}
                    onChange={(e) => setIndexDraft(e.target.value)}
                    rows={8}
                  />
                  <div className="memory-index-foot">
                    <span className={`hint${indexDraft !== null ? ' is-dirty' : ''}`}>
                      {indexDraft !== null
                        ? `${t('settings.memoryIndexUnsaved')} — ${t('settings.memoryIndexSaveHint')}`
                        : t('settings.memoryIndexSaveHint')}
                    </span>
                    <div className="memory-index-actions">
                      <button
                        type="button"
                        className="memory-source-action"
                        onClick={() => setIndexDraft(null)}
                        disabled={indexDraft === null}
                      >
                        {t('settings.memoryIndexReset')}
                      </button>
                      <button
                        type="button"
                        className="primary"
                        onClick={onSaveIndex}
                        disabled={busy || indexDraft === null}
                      >
                        {t('settings.memoryIndexSave')}
                      </button>
                    </div>
                  </div>
                </div>
              </details>
              {treeFolders.length > 0 ? (
                <details className="library-group memory-advanced-card">
                  <summary className="memory-details-summary">
                    <span className="memory-details-title">{t('memory.memoryTree')}</span>
                    <span className="filter-pill-count">{memoryTree.length}</span>
                    <Icon name="chevron-right" size={16} />
                  </summary>
                  <div className="memory-advanced-card-body">
                    <p className="hint">{t('memory.memoryTreeHint')}</p>
                    <div className="memory-tree-advanced">
                      {treeFolders.map((folder) => {
                        const children = treeChildren.get(folder.id) ?? [];
                        return (
                          <div key={folder.id} className="memory-tree-folder">
                            <div className="memory-tree-folder-head">
                              <span className="library-card-name">{folder.name}</span>
                              <span className="library-card-badge">{folder.path}</span>
                              <span className="memory-tree-folder-count">
                                {children.length === 1
                                  ? t('memory.nodeCountOne', { count: children.length })
                                  : t('memory.nodeCountOther', { count: children.length })}
                              </span>
                            </div>
                            {children.length > 0 ? (
                              <ul className="memory-tree-children">
                                {children.map((child) => (
                                  <li key={child.id} className="memory-tree-child-row">
                                    <span className="memory-tree-child-copy">
                                      <span className="library-card-name">{child.name}</span>{' '}
                                      <span className="library-card-badge">{child.id}</span>
                                      {child.description ? (
                                        <span className="library-card-desc">{child.description}</span>
                                      ) : null}
                                    </span>
                                    <div className="memory-card-actions">
                                      <button
                                        type="button"
                                        className="ghost library-card-action"
                                        onClick={() => startEdit(child.id)}
                                        title={t('settings.memoryEdit')}
                                      >
                                        <Icon name="edit" size={14} />
                                      </button>
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </details>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      ) : null}

      {addModalOpen ? (
      <div
        className="memory-action-modal-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setAddModalOpen(false);
          }
        }}
      >
        <div
          className="memory-action-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="memory-add-modal-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="memory-action-modal-head">
            <h3 id="memory-add-modal-title">
              {t('settings.memoryAddDisclosure')}
            </h3>
            <button
              type="button"
              className="memory-action-modal-close"
              onClick={() => setAddModalOpen(false)}
              aria-label={t('common.close')}
              title={t('common.close')}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="memory-action-modal-body memory-source-layout">

      <div
        className="memory-top-tabs"
        role="tablist"
        aria-label={t('memory.areasAria')}
      >
        {memoryTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`memory-top-tab${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="memory-source-content">
      {activeTab === 'profile' ? (
        <div className="memory-tab-panel memory-profile-tab-panel">
          <MemoryProfilePanel enabled={enabled} />
        </div>
      ) : null}

      {activeTab === 'manual' ? (
        <div className="memory-tab-panel memory-manual-panel">
          <div className="memory-subsection-head">
            <p className="hint">
              {t('memory.manualPanelHint')}
            </p>
            <button
              type="button"
              className="memory-source-action"
              onClick={startNew}
              disabled={editing !== null}
            >
              <Icon name="plus" size={14} />
              <span>{t('settings.memoryNew')}</span>
            </button>
          </div>

          {flash && flash.kind !== 'pathCopied' ? (
            <div
              key={flash.key}
              role="status"
              aria-live="polite"
              className="memory-flash-pill"
            >
              {flashLabel[flash.kind]}
            </div>
          ) : null}

          {editing ? (
            <div ref={editorRef} className="memory-editor">
              {!editing.id ? (
                <div className="memory-editor-starters">
                  <span className="hint">{t('settings.memoryStartersLabel')}</span>
                  {STARTERS.map((starter) => (
                    <button
                      key={starter.nameKey}
                      type="button"
                      className="memory-source-action"
                      onClick={() =>
                        setEditing({
                          id: editing.id,
                          type: starter.type,
                          name: t(starter.nameKey),
                          description: t(starter.descKey),
                          body: t(starter.bodyKey),
                        })
                      }
                      title={t(starter.descKey)}
                    >
                      {t(starter.nameKey)}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="memory-editor-pair">
                <label className="memory-field">
                  <span className="field-label">{t('settings.memoryNameLabel')}</span>
                  <input
                    ref={editorNameRef}
                    type="text"
                    placeholder={t('settings.memoryName')}
                    value={editing.name}
                    onChange={(e) =>
                      setEditing({ ...editing, name: e.target.value })
                    }
                  />
                </label>
                <div className="memory-field">
                  <span className="field-label">{t('settings.memoryTypeLabel')}</span>
                  <SettingsSelect
                    aria-label={t('settings.memoryTypeLabel')}
                    value={editing.type}
                    options={TYPES.map((tt) => ({ value: tt, label: TYPE_LABEL[tt] }))}
                    onChange={(value) =>
                      setEditing({
                        ...editing,
                        type: value as MemoryType,
                      })
                    }
                  />
                </div>
              </div>
              <label className="memory-field">
                <span className="field-label">{t('settings.memoryDescLabel')}</span>
                <input
                  type="text"
                  placeholder={t('settings.memoryDesc')}
                  value={editing.description}
                  onChange={(e) =>
                    setEditing({ ...editing, description: e.target.value })
                  }
                />
              </label>
              <label className="memory-field">
                <span className="field-label">{t('settings.memoryBodyLabel')}</span>
                <textarea
                  className="memory-editor-body"
                  placeholder={t('settings.memoryBody')}
                  value={editing.body}
                  onChange={(e) =>
                    setEditing({ ...editing, body: e.target.value })
                  }
                  rows={7}
                />
                <span className="hint">{t('settings.memoryBodyHint')}</span>
              </label>
              <div className="memory-editor-foot">
                <span className="hint">{t('settings.memorySaveHint')}</span>
                <div className="memory-editor-actions">
                  <Button variant="ghost" onClick={cancelEdit}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={onSave}
                    disabled={busy || !editing.name.trim()}
                  >
                    {editing.id ? t('common.save') : t('common.create')}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

        </div>
      ) : null}

      {activeTab === 'connected' ? (
        <div className="memory-tab-panel memory-connected-panel">
          <div className="memory-subsection-head">
            <p className="hint">
              {t('memory.connectedPanelHint')}
            </p>
            <div className="memory-subsection-side">
              <span className="memory-source-badge">
                {connectorsLoading
                  ? t('memory.loading')
                  : t('memory.connectedCount', { count: connectedCount })}
              </span>
              <button
                type="button"
                className="memory-source-action"
                onClick={onOpenConnectors}
                disabled={!onOpenConnectors}
              >
                {t('memory.manage')}
              </button>
            </div>
          </div>
          <div className="memory-connector-workbench">
            <div className="memory-subsection-head">
              <div>
                <h4>{t('memory.chooseSources')}</h4>
                <p className="hint">
                  {t('memory.chooseSourcesHint')}
                </p>
              </div>
              <span className="memory-source-badge">
                {t('memory.selectedCount', { count: selectedConnectedConnectorIds.length })}
              </span>
            </div>
            <div className="memory-connector-list" aria-label={t('memory.connectorListAria')}>
              {memoryConnectors.map((connector) => {
                const connected = connector.status === 'connected';
                const selected = selectedConnectorIds.has(connector.id) && connected;
                const connecting = connectingConnectorIds.has(connector.id);
                const authorizationPending = pendingConnectorAuthIds.has(connector.id);
                const connectError = connectorConnectErrors[connector.id];
                const statusResolved =
                  connectorIdsWithDetails.has(connector.id)
                  || connectorStatuses[connector.id] !== undefined;
                const checkingStatus =
                  connectorsLoading
                  && !statusResolved
                  && !connected
                  && !authorizationPending
                  && !connectError
                  && !connecting;
                const connectorLastError = connector.lastError?.trim();
                const reconnecting = connector.status === 'error';
                const connectorHint = connected
                  ? connector.accountLabel
                    || t('memory.readToolsCount', { count: connector.tools.length })
                  : checkingStatus
                    ? t('memory.checkingConnectionStatus')
                    : authorizationPending
                    ? t('memory.finishAuthorization')
                    : connectorLastError || connectError || t('memory.connectBeforeExtraction');
                return (
                  <label
                    key={connector.id}
                    className={`memory-connector-row${connected ? '' : ' is-disabled'}${selected ? ' is-selected' : ''}`}
                    data-memory-connector-id={connector.id}
                  >
                    <input
                      className="memory-connector-input"
                      type="checkbox"
                      checked={selected}
                      disabled={!connected}
                      aria-label={t('memory.useConnectorAria', { name: connector.name })}
                      onChange={() => toggleConnectorSelection(connector.id)}
                    />
                    <span className={`memory-connector-brand${selected ? ' is-selected' : ''}`}>
                      <ConnectorLogo connector={connector} theme={logoTheme} size="sm" />
                      <span className="memory-connector-selected-mark" aria-hidden="true">
                        {selected ? <Icon name="check" size={14} /> : null}
                      </span>
                    </span>
                    <span className="memory-connector-copy">
                      <strong>{connector.name}</strong>
                      <small>{connectorHint}</small>
                    </span>
                    {connected ? (
                      <span className={`memory-connector-picker${selected ? ' is-selected' : ''}`}>
                        <span className="memory-connector-picker-box" aria-hidden="true">
                          {selected ? <Icon name="check" size={14} /> : null}
                        </span>
                        <span>{selected ? t('memory.selected') : t('memory.select')}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={`memory-connector-connect-button${connecting || authorizationPending || checkingStatus ? ' is-loading' : ''}`}
                        disabled={connecting || authorizationPending || checkingStatus}
                        aria-busy={connecting || authorizationPending || checkingStatus || undefined}
                        aria-label={
                          reconnecting
                            ? t('memory.reconnectConnectorAria', { name: connector.name })
                            : t('memory.connectConnectorAria', { name: connector.name })
                        }
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void onConnectMemoryConnector(connector.id);
                        }}
                      >
                        <Icon
                          name={connecting || authorizationPending || checkingStatus ? 'refresh' : 'plus'}
                          size={14}
                          className={connecting || authorizationPending || checkingStatus ? 'icon-spin' : ''}
                        />
                        <span>
                          {checkingStatus
                            ? t('memory.connectStateChecking')
                            : authorizationPending
                              ? t('memory.connectStateWaiting')
                              : connecting
                                ? t('memory.connectStateConnecting')
                                : reconnecting
                                  ? t('memory.reconnect')
                                  : t('connectors.connect')}
                        </span>
                      </button>
                    )}
                  </label>
                );
              })}
            </div>
            <div className="memory-connector-actions memory-connector-runbar">
              <span className="hint">
                {connectedCount === 1
                  ? t('memory.selectedOfConnectedOne', {
                    count: selectedConnectedConnectorIds.length,
                    total: connectedCount,
                  })
                  : t('memory.selectedOfConnectedOther', {
                    count: selectedConnectedConnectorIds.length,
                    total: connectedCount,
                  })}
              </span>
              <button
                type="button"
                className="primary memory-source-action"
                onClick={() => void onSuggestConnectorMemory()}
                disabled={
                  !enabled
                  || connectorExtracting
                  || connectorSaving
                  || selectedConnectedConnectorIds.length === 0
                }
              >
                {connectorExtracting ? (
                  <Icon name="refresh" size={14} className="icon-spin" />
                ) : null}
                <span>{connectorScanLabel}</span>
              </button>
            </div>
          </div>
          {connectorSuggestions.length > 0 ? (
            <div className="memory-suggestion-panel">
              <div className="memory-subsection-head">
                <div>
                  <h4>{t('memory.suggestedMemories')}</h4>
                  <p className="hint">
                    {t('memory.suggestedMemoriesHint')}
                  </p>
                </div>
                <span className="memory-source-badge">
                  {t('memory.selectedCount', { count: selectedConnectorSuggestions.length })}
                </span>
              </div>
              <div className="memory-suggestion-list">
                {connectorSuggestions.map((suggestion) => {
                  const selected = selectedSuggestionIds.has(suggestion.id);
                  const sourceLabel =
                    suggestion.source?.connectorName
                    || suggestion.source?.toolTitle
                    || t('memory.kindConnectedApps');
                  return (
                    <label
                      key={suggestion.id}
                      className={`memory-suggestion-card${selected ? ' is-selected' : ''}`}
                    >
                      <span className="memory-connector-check">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleConnectorSuggestion(suggestion.id)}
                        />
                        <span aria-hidden="true">
                          {selected ? <Icon name="check" size={14} /> : null}
                        </span>
                      </span>
                      <span className="memory-suggestion-copy">
                        <span className="memory-suggestion-title">
                          <strong>{suggestion.name}</strong>
                          <span className="memory-type-badge">
                            {TYPE_LABEL[suggestion.type]}
                          </span>
                        </span>
                        {suggestion.description ? (
                          <small>{suggestion.description}</small>
                        ) : null}
                        <span className="memory-suggestion-body">{suggestion.body}</span>
                      </span>
                      <span className="memory-connector-state is-connected">
                        {sourceLabel}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="memory-connector-actions">
                <button
                  type="button"
                  className="primary memory-source-action"
                  onClick={() => void onSaveConnectorSuggestions()}
                  disabled={connectorSaving || selectedConnectorSuggestions.length === 0}
                >
                  {connectorSaving ? (
                    <Icon name="refresh" size={14} className="icon-spin" />
                  ) : null}
                  <span>{connectorSaving ? t('memory.saving') : t('memory.saveSelected')}</span>
                </button>
                <button
                  type="button"
                  className="ghost memory-source-action"
                  onClick={onDiscardConnectorSuggestions}
                  disabled={connectorSaving}
                >
                  {t('memory.discard')}
                </button>
              </div>
            </div>
          ) : null}
          {connectorStatus ? (
            <div role="status" className="memory-connector-result is-success">
              {connectorStatus}
            </div>
          ) : null}
          {connectorError ? (
            <div role="alert" className="memory-connector-result is-error">
              {connectorError}
            </div>
          ) : null}
          {connectorAttempts.length > 0 ? (
            <div className="memory-connector-diagnostics" aria-label={t('memory.diagnosticsAria')}>
              <div className="memory-connector-diagnostics-head">
                <strong>{t('memory.lastScan')}</strong>
                <span>
                  {t('memory.bytesRead', {
                    bytes: formatConnectorContextBytes(connectorContextBytes, t),
                  })}
                </span>
              </div>
              <div className="memory-connector-diagnostics-list">
                {connectorAttempts.map((attempt) => (
                  <div
                    key={`${attempt.connectorId}-${attempt.status}-${attempt.toolName ?? 'none'}`}
                    className={`memory-connector-diagnostic-row is-${attempt.status}`}
                  >
                    <span className="memory-connector-diagnostic-dot" aria-hidden="true" />
                    <span className="memory-connector-diagnostic-copy">
                      <strong>{connectorAttemptTitle(attempt, t)}</strong>
                      <small>{connectorAttemptDetail(attempt)}</small>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {connectorExtractions.length > 0 ? (
            <details className="memory-scan-history">
              <summary>
                <span>{t('memory.recentScans')}</span>
                <span>{connectorExtractions.length}</span>
              </summary>
              <div
                className="memory-connector-run-history"
                aria-label={t('memory.runHistoryAria')}
              >
                {connectorExtractions.slice(0, 4).map(renderExtractionCard)}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
          </div>
          </div>
        </div>
      </div>
      ) : null}

      </section>

      {topTab === 'memories' ? (
      <section ref={recordsRef} className="settings-section settings-section-card memory-records-section">
        <div className="memory-management-panel">
          <div className="memory-subsection-head">
            <div>
              <h4>{t('memory.flowSavedMemory')}</h4>
              <div className="memory-management-counts">
                <span className="memory-source-badge">
                  {t('memory.savedCount', { count: entries.length })}
                </span>
                {visibleExtractions.length > 0 ? (
                  <span className="memory-source-badge">
                    {visibleExtractions.length === 1
                      ? t('memory.extractionCountOne', { count: visibleExtractions.length })
                      : t('memory.extractionCountOther', { count: visibleExtractions.length })}
                  </span>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              className="memory-source-action"
              onClick={() => setAddModalOpen(true)}
            >
              <Icon name="plus" size={14} />
              <span>{t('settings.memoryAddDisclosure')}</span>
            </button>
          </div>

          {/* Nothing to narrow down yet, so an "All 0" filter would only be noise above the empty state. */}
          {entries.length > 0 || visibleExtractions.length > 0 || filter !== 'all' ? (
            <div className="library-toolbar is-row">
              <div className="library-filters">
                <button
                  type="button"
                  className={`filter-pill${filter === 'all' ? ' active' : ''}`}
                  onClick={() => setFilter('all')}
                >
                  {t('settings.memoryAll')}
                  <span className="filter-pill-count">
                    {entries.length + visibleExtractions.length}
                  </span>
                </button>
                {TYPES.map((type) => {
                  const count = entries.filter((e) => e.type === type).length;
                  if (count === 0 && filter !== type) return null;
                  return (
                    <button
                      key={type}
                      type="button"
                      className={`filter-pill${filter === type ? ' active' : ''}`}
                      onClick={() => setFilter(type)}
                    >
                      {TYPE_LABEL[type]}
                      <span className="filter-pill-count">{count}</span>
                    </button>
                  );
                })}
              </div>
              {visibleExtractions.length > 0 ? (
                <div className="memory-management-actions">
                  <button
                    type="button"
                    className="ghost memory-clear-extractions"
                    onClick={() => void onClearExtractions()}
                    title={t('settings.memoryExtractionsClearTitle')}
                  >
                    <Icon name="close" size={14} />
                    <span>{t('settings.memoryExtractionsClear')}</span>
                  </button>
                  <button
                    type="button"
                    className="ghost memory-refresh-extractions"
                    onClick={() => void reloadExtractions()}
                    disabled={isRefreshing}
                    title={t('settings.memoryExtractionsRefresh')}
                  >
                    <Icon
                      name="refresh"
                      size={14}
                      className={isRefreshing ? 'icon-spin' : ''}
                    />
                    <span>
                      {isRefreshing
                        ? t('settings.memoryExtractionsRefreshing')
                        : t('settings.memoryExtractionsRefresh')}
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="library-content memory-unified-list">
            {unifiedMemoryCount === 0 ? (
              <div className="library-empty">
                <p className="library-empty-title">
                  {t('settings.memoryEmpty')}
                </p>
                <p className="library-empty-hint">
                  {t('memory.emptyHintBefore')}{' '}
                  <code>{t('settings.memoryEmptyHintEn')}</code>{' '}
                  {t('memory.emptyHintAfter')}
                </p>
              </div>
            ) : (
              <>
                {filtered.map(renderMemoryEntry)}
                {visibleExtractions.map(renderExtractionCard)}
              </>
            )}
          </div>
        </div>
      </section>
      ) : null}
    </>
  );
}
