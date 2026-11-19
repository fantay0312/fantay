// SPDX-License-Identifier: AGPL-3.0-only
// The Fantay workspace's data layer (spec §17.1): polling gated on `active`, change detection, defensive
// parsing, backoff, per-action pending keys, and every mutation in `PaActions`. All requests go through
// `usePaTransport()`, so the lab bench can inject fixtures and tests can keep mocking `pa-api`.
//
// Paths and bodies follow the daemon routes (`apps/daemon/src/routes/personal-agent.ts`,
// `personal-agent-channels.ts`) and the old UI that called them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PA_EMOTIONS } from '@open-design/contracts/soul';
import type { PaFeishuRegistration, PaTaskCardAnswer } from '@open-design/contracts';

import { refreshPaActivity } from './pa-activity';
import { isRevisionConflict } from './pa-api';
import { newRequestId } from './pa-model';
import { usePaTransport } from './pa-transport';
import { heldBehind } from './soul/soul-model';
import type {
  PaActions,
  PaAgentInput,
  PaChannel,
  PaChannelInbox,
  PaChannelInput,
  PaChannelLogin,
  PaChannelOutbox,
  PaChannelPairing,
  PaChannelSnapshot,
  PaCharacterView,
  PaChatView,
  PaControl,
  PaControlPatch,
  PaConversation,
  PaData,
  PaEmotion,
  PaGroup,
  PaGroupInput,
  PaLoadState,
  PaLocalFeishuApp,
  PaLorebook,
  PaLorebookSummary,
  PaMemory,
  PaMemoryInput,
  PaMessage,
  PaModelOption,
  PaNeedsReviewItem,
  PaOutputPage,
  PaPersona,
  PaSnapshot,
  PaSoulLiveResponse,
  PaSoulSnapshot,
  PaSoulTrace,
  PaSoulTraceLore,
  PaSpeechItem,
  PaSpeechPreview,
  PaSpeechStatus,
  PaSpeechVoices,
  PaStylePreset,
  PaTask,
  PaTaskEvent,
  PaTaskInput,
  PaTransport,
  PersonalAgent,
} from './pa-types';

export const PA_EMPTY_CHANNELS: PaChannelSnapshot = { channels: [], inbox: [], outbox: [] };

const SNAPSHOT_MS = 2000;
const SNAPSHOT_MAX_MS = 8000;
const AUX_MS = 5000;
/** Poll cadence while a chat turn of any conversation is queued or running, so a reply shows up promptly. */
const CHAT_POLL_MS = 700;

/** The `pending` keys each action registers while in flight, so a button can show `loading` for exactly its
 *  own request: `data.pending.has(paPendingKey.stop(task.id))`. */
export const paPendingKey = {
  send: (conversationId: string) => `send:${conversationId}`,
  conversation: (agentId: string) => `conversation:${agentId}`,
  stop: (taskId: string) => `stop:${taskId}`,
  resume: (taskId: string) => `resume:${taskId}`,
  amend: (taskId: string) => `amend:${taskId}`,
  reconcile: (taskId: string) => `reconcile:${taskId}`,
  agent: (agentId: string | null) => `agent:${agentId ?? 'new'}`,
  clone: (agentId: string) => `clone:${agentId}`,
  enable: (agentId: string) => `enable:${agentId}`,
  group: (groupId: string | null) => `group:${groupId ?? 'new'}`,
  memory: (memoryId: string | null) => `memory:${memoryId ?? 'new'}`,
  deleteMemory: (memoryId: string) => `deleteMemory:${memoryId}`,
  control: () => 'control',
  channel: (channelId: string | null) => `channel:${channelId ?? 'new'}`,
  feishu: (channelId: string) => `feishu:${channelId}`,
  localApps: () => 'localFeishuApps',
  pair: (channelId: string) => `pair:${channelId}`,
  login: (channelId: string) => `login:${channelId}`,
  pin: (channelId: string) => `pin:${channelId}`,
  connect: (channelId: string) => `connect:${channelId}`,
  disconnect: (channelId: string) => `disconnect:${channelId}`,
  approval: (inboxId: string) => `approval:${inboxId}`,
  outbox: (outboxId: string) => `outbox:${outboxId}`,
  // soul: `soul:<verb>:<id>`
  soulCharacter: (agentId: string) => `soul:character:${agentId}`,
  soulImport: () => 'soul:import',
  soulStarter: (id: string) => `soul:starter:${id}`,
  orgSync: () => 'org:sync',
  soulLorebook: (id: string | null) => `soul:lorebook:${id ?? 'new'}`,
  soulPersona: (id: string | null) => `soul:persona:${id ?? 'new'}`,
  soulPreset: (id: string | null) => `soul:preset:${id ?? 'new'}`,
  soulChat: (conversationId: string) => `soul:chat:${conversationId}`,
  soulState: (conversationId: string) => `soul:state:${conversationId}`,
  soulMessage: (messageId: string) => `soul:message:${messageId}`,
  soulTurn: (conversationId: string) => `soul:turn:${conversationId}`,
  soulPlay: (conversationId: string) => `soul:play:${conversationId}`,
  soulBranch: (messageId: string) => `soul:branch:${messageId}`,
  soulAsset: () => 'soul:asset',
  soulPreview: (conversationId: string) => `soul:preview:${conversationId}`,
  soulSpeech: (messageId: string) => `soul:speech:${messageId}`,
} as const;

// ---- defensive parsing (spec §17.1) ----

const NODE_FALLBACK: PaSnapshot['node'] = {
  id: 'local',
  protocolVersion: 1,
  location: 'local',
  available: false,
  capabilities: [],
  heartbeatAt: 0,
};

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** A snapshot with every collection present; anything that is not an object with an `agents` array is a
 *  failed read (a proxy error page, a wrong route). */
function parseSnapshot(value: unknown): PaSnapshot {
  const raw = value as Partial<PaSnapshot> | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.agents)) throw new Error('Unexpected Fantay snapshot');
  return {
    agents: list(raw.agents),
    groups: list(raw.groups),
    conversations: list(raw.conversations),
    messages: list(raw.messages),
    tasks: list(raw.tasks),
    attempts: list(raw.attempts),
    artifacts: list(raw.artifacts),
    memories: list(raw.memories),
    memoryCandidates: list(raw.memoryCandidates),
    goals: list(raw.goals),
    routines: list(raw.routines),
    ...(raw.mode ? { mode: raw.mode } : {}),
    ...(raw.member && typeof raw.member === 'object' ? { member: raw.member } : {}),
    ...(raw.org && typeof raw.org === 'object' ? { org: raw.org } : {}),
    ...(raw.execution ? { execution: raw.execution } : {}),
    // `tag` is deliberately not copied: it lives in a ref, so a new tag never re-renders anything.
    ...(typeof raw.soulVersion === 'string' ? { soulVersion: raw.soulVersion } : {}),
    node: raw.node && typeof raw.node === 'object' ? raw.node : NODE_FALLBACK,
  };
}

/** The soul snapshot with every collection present; anything without a string `version` is a failed read. */
function parseSoul(value: unknown): PaSoulSnapshot {
  const raw = value as Partial<PaSoulSnapshot> | null;
  if (!raw || typeof raw !== 'object' || typeof raw.version !== 'string') throw new Error('Unexpected Fantay soul snapshot');
  return {
    version: raw.version,
    characters: list(raw.characters),
    lorebooks: list(raw.lorebooks),
    personas: list(raw.personas),
    presets: list(raw.presets),
    chats: list(raw.chats),
  };
}

function parseChannels(value: unknown): PaChannelSnapshot {
  const raw = value as Partial<PaChannelSnapshot> | null;
  if (!raw || !Array.isArray(raw.channels)) return PA_EMPTY_CHANNELS;
  return { channels: raw.channels, inbox: list(raw.inbox), outbox: list(raw.outbox) };
}

function parseControl(value: unknown): PaControl | null {
  const raw = value as Partial<PaControl> | null;
  return raw && typeof raw.paused === 'boolean' ? (raw as PaControl) : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error ?? '');
}

function agentInput(agent: PersonalAgent): PaAgentInput {
  return { name: agent.name, role: agent.role, avatar: agent.avatar, model: agent.model, enabled: agent.enabled, tools: agent.tools };
}

/** Polls and mutates the Fantay service. `active` gates every poll: the hidden view costs no requests. */
export function usePaWorkspace(active: boolean): PaData {
  const transport = usePaTransport();
  const transportRef = useRef<PaTransport>(transport);
  transportRef.current = transport;

  const [snapshot, setSnapshot] = useState<PaSnapshot | null>(null);
  const [models, setModels] = useState<PaModelOption[]>([]);
  const [control, setControl] = useState<PaControl | null>(null);
  const [channels, setChannels] = useState<PaChannelSnapshot>(PA_EMPTY_CHANNELS);
  const [load, setLoad] = useState<PaLoadState>('loading');
  const [stale, setStale] = useState<PaData['stale']>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [soul, setSoul] = useState<PaSoulSnapshot | null>(null);

  const snapshotRef = useRef<PaSnapshot | null>(null);
  const soulRef = useRef<PaSoulSnapshot | null>(null);
  /** The daemon's change tag of the last applied snapshot; sent as `?since=` so an idle poll answers `unchanged`. */
  const tagRef = useRef<string | null>(null);
  const json = useRef({ snapshot: '', node: '', channels: '', control: '', models: '' });
  /** Snapshot reads in flight: `issued` counts requests as they start, `applied` is the newest one applied. */
  const reads = useRef({ issued: 0, applied: 0 });
  /** The same ordering for soul snapshot reads. */
  const soulReads = useRef({ issued: 0, applied: 0 });
  /** True while a chat task is queued or running: the poll runs at CHAT_POLL_MS. */
  const fastRef = useRef(false);
  /** Set by the poll effect: runs the next poll now. */
  const kickRef = useRef<(() => void) | null>(null);
  const loadedAt = useRef<number | null>(null);
  const counts = useRef(new Map<string, number>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ---- reads ----

  /** Skips setState when nothing changed, so an idle 2 s poll never re-renders the view. The node's
   *  `heartbeatAt` is left out of the comparison: the daemon stamps it with the read time on every snapshot
   *  (`PaLocalNode.capabilities()`), and nothing renders it. When only it moved, the previous node object is
   *  kept, so a snapshot that changed elsewhere still hands consumers the same `node`. */
  const applySnapshot = useCallback((next: PaSnapshot) => {
    const { node, ...rest } = next;
    const nodeText = JSON.stringify({ ...node, heartbeatAt: 0 });
    const text = JSON.stringify(rest);
    const previous = snapshotRef.current;
    if (text !== json.current.snapshot || nodeText !== json.current.node || !previous) {
      const stable = previous && nodeText === json.current.node ? { ...next, node: previous.node } : next;
      json.current.snapshot = text;
      json.current.node = nodeText;
      snapshotRef.current = stable;
      setSnapshot(stable);
    }
    loadedAt.current = Date.now();
    setLoad('ready');
    setStale(null);
  }, []);

  const applyChannels = useCallback((next: PaChannelSnapshot) => {
    const text = JSON.stringify(next);
    if (text === json.current.channels) return;
    json.current.channels = text;
    setChannels(next);
  }, []);

  const applyControl = useCallback((next: PaControl | null) => {
    const text = JSON.stringify(next);
    if (text === json.current.control) return;
    json.current.control = text;
    setControl(next);
  }, []);

  /** First failure → offline; a later one keeps the data and marks it stale since the last good read. The
   *  message is kept on `stale` in both cases (the offline state shows it as its description). */
  const markFailure = useCallback((error: unknown) => {
    const message = messageOf(error);
    if (loadedAt.current === null) setLoad('offline');
    setStale((current) =>
      current && current.message === message ? current : { since: loadedAt.current ?? Date.now(), message },
    );
  }, []);

  /** The poll and every mutation's re-read run concurrently, so responses can land out of order (a poll sent
   *  just before a Stop can resolve after the re-read that follows it). Each read is numbered when it starts,
   *  and a response older than the newest applied one is dropped instead of rolling the view (and the task
   *  revision that amend and reconcile send) back.
   *
   *  The read sends the last tag (`?since=`); `{ unchanged: true }` keeps everything. When the snapshot names a new
   *  `soulVersion`, the soul snapshot is fetched before either is applied, and both are set in the same tick, so no
   *  render sees an imported agent without its character. Enterprise mode never fetches `/soul`. */
  const readSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      reads.current.issued += 1;
      const sequence = reads.current.issued;
      const since = tagRef.current;
      const raw = await transportRef.current<unknown>(since ? `?since=${encodeURIComponent(since)}` : '', 'GET', undefined, signal);
      if (signal?.aborted || !mounted.current) return;
      if (sequence < reads.current.applied) return;
      if (raw && typeof raw === 'object' && (raw as { unchanged?: unknown }).unchanged === true) {
        reads.current.applied = sequence;
        loadedAt.current = Date.now();
        setLoad('ready');
        setStale(null);
        return;
      }
      const parsed = parseSnapshot(raw);
      let nextSoul = soulRef.current;
      if (parsed.soulVersion && parsed.soulVersion !== nextSoul?.version) {
        soulReads.current.issued += 1;
        const soulSequence = soulReads.current.issued;
        const fetched = parseSoul(await transportRef.current<unknown>('/soul', 'GET', undefined, signal));
        if (signal?.aborted || !mounted.current) return;
        if (soulSequence >= soulReads.current.applied) {
          soulReads.current.applied = soulSequence;
          nextSoul = fetched;
        }
      }
      if (sequence < reads.current.applied) return;
      reads.current.applied = sequence;
      const tag = (raw as { tag?: unknown }).tag;
      tagRef.current = typeof tag === 'string' ? tag : null;
      // Fast poll while a chat turn runs or is about to; a turn held behind another task of its conversation waits.
      fastRef.current = parsed.tasks.some((task) => task.kind === 'chat' && (task.status === 'running' || (task.status === 'queued'
        && !heldBehind(task, parsed.tasks.filter((other) => other.conversationId === task.conversationId)))));
      if (nextSoul !== soulRef.current) {
        soulRef.current = nextSoul;
        setSoul(nextSoul);
      }
      applySnapshot(parsed);
    },
    [applySnapshot],
  );

  const applyModels = useCallback((value: unknown) => {
    if (!Array.isArray(value)) return;
    const text = JSON.stringify(value);
    if (text === json.current.models) return;
    json.current.models = text;
    setModels(value as PaModelOption[]);
  }, []);

  const readModels = useCallback(
    async (signal?: AbortSignal) => {
      const value = await transportRef.current<unknown>('/models', 'GET', undefined, signal);
      if (signal?.aborted || !mounted.current) return;
      applyModels(value);
    },
    [applyModels],
  );

  const readAux = useCallback(
    async (signal?: AbortSignal) => {
      const [nextControl, nextChannels, nextModels] = await Promise.allSettled([
        transportRef.current<unknown>('/control', 'GET', undefined, signal),
        transportRef.current<unknown>('/channels', 'GET', undefined, signal),
        transportRef.current<unknown>('/models', 'GET', undefined, signal),
      ]);
      if (signal?.aborted || !mounted.current) return;
      if (nextControl.status === 'fulfilled') applyControl(parseControl(nextControl.value));
      if (nextChannels.status === 'fulfilled') applyChannels(parseChannels(nextChannels.value));
      if (nextModels.status === 'fulfilled') applyModels(nextModels.value);
    },
    [applyChannels, applyControl, applyModels],
  );

  /** Snapshot every 2 s while active, doubling to 4 s and 8 s while it fails; immediately on activation. Every
   *  700 ms while a chat turn is queued or running (and the last read succeeded). `kickRef` runs the next poll now. */
  useEffect(() => {
    if (!active) return undefined;
    let disposed = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const schedule = (ms: number) => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      timer = undefined;
      try {
        await readSnapshot(controller.signal);
        failures = 0;
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        failures += 1;
        markFailure(error);
      }
      if (disposed) return;
      schedule(fastRef.current && failures === 0 ? CHAT_POLL_MS : Math.min(SNAPSHOT_MAX_MS, SNAPSHOT_MS * 2 ** failures));
    };
    kickRef.current = () => schedule(0);
    void tick();
    return () => {
      disposed = true;
      kickRef.current = null;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [active, markFailure, readSnapshot]);

  /** Control, channels and models every 5 s while active (the global entry never fetches /channels, spec §3.1). */
  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    void readAux(controller.signal).catch(() => {});
    const timer = setInterval(() => void readAux(controller.signal).catch(() => {}), AUX_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [active, readAux]);

  /** Model options on each activation. */
  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    void readModels(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [active, readModels]);

  // ---- mutations ----

  const begin = useCallback((key: string) => {
    counts.current.set(key, (counts.current.get(key) ?? 0) + 1);
    setPending(new Set(counts.current.keys()));
  }, []);
  const end = useCallback((key: string) => {
    const left = (counts.current.get(key) ?? 1) - 1;
    if (left > 0) counts.current.set(key, left);
    else counts.current.delete(key);
    if (mounted.current) setPending(new Set(counts.current.keys()));
  }, []);

  /** Runs one mutation under its pending key, then re-reads the snapshot (and control/channels when `aux`)
   *  before resolving, so a caller that closes a modal on success sees the new state. A failed mutation still
   *  re-reads (a 409 conflict should load the latest revision) and then rethrows the original error. With `kick`,
   *  the next poll runs at once after the re-read, so the fast chat cadence starts without waiting 2 s. */
  const run = useCallback(
    async <T>(key: string, work: (send: PaTransport) => Promise<T>, aux = false, kick = false): Promise<T> => {
      begin(key);
      let result: T | undefined;
      let failure: { error: unknown } | null = null;
      try {
        result = await work(transportRef.current);
      } catch (error) {
        failure = { error };
      }
      await Promise.allSettled([readSnapshot(), aux ? readAux() : Promise.resolve()]);
      if (kick) kickRef.current?.();
      end(key);
      refreshPaActivity();
      if (failure) throw failure.error;
      return result as T;
    },
    [begin, end, readAux, readSnapshot],
  );

  /** A request under a pending key without the snapshot re-read (reads and exports that change nothing). */
  const flight = useCallback(
    async <T>(key: string, work: (send: PaTransport) => Promise<T>): Promise<T> => {
      begin(key);
      try {
        return await work(transportRef.current);
      } finally {
        end(key);
      }
    },
    [begin, end],
  );

  const actions = useMemo<PaActions>(() => {
    /** The task's current revision, from the latest snapshot (amend and reconcile are revision-checked). */
    const revisionOf = (taskId: string): number => {
      const task = snapshotRef.current?.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`Unknown task ${taskId}`);
      return task.revision;
    };
    /** The card's current revision from the soul snapshot; null while the agent has no card. */
    const characterRevision = (agentId: string): number | null =>
      soulRef.current?.characters.find((item) => item.id === agentId)?.revision ?? null;
    return {
      async refresh() {
        try {
          await Promise.all([readSnapshot(), readAux()]);
        } catch (error) {
          markFailure(error);
        }
      },
      refreshModels: () => readModels().catch(() => {}),
      sendTask: (input: PaTaskInput) =>
        run(paPendingKey.send(input.conversationId), (send) => send<PaTask>('/tasks', 'POST', input)),
      createConversation: (agentId: string) =>
        run(paPendingKey.conversation(agentId), (send) => send<PaConversation>('/conversations', 'POST', { agentId })),
      stopTask: (taskId: string) =>
        run(paPendingKey.stop(taskId), async (send) => {
          await send(`/tasks/${encodeURIComponent(taskId)}/cancel`, 'POST');
        }),
      resumeTask: (taskId: string) =>
        run(paPendingKey.resume(taskId), async (send) => {
          await send(`/tasks/${encodeURIComponent(taskId)}/resume`, 'POST');
        }),
      amendTask: (taskId: string, content: string) =>
        run(paPendingKey.amend(taskId), async (send) => {
          await send(`/tasks/${encodeURIComponent(taskId)}/amend`, 'POST', { content, revision: revisionOf(taskId) });
        }),
      reconcileTask: (taskId: string, confirmation?: { note: string }) =>
        run(paPendingKey.reconcile(taskId), (send) =>
          send<PaTask>(
            `/tasks/${encodeURIComponent(taskId)}/reconcile`,
            'POST',
            confirmation ? { confirmedStopped: true, revision: revisionOf(taskId), note: confirmation.note } : {},
          ),
        ),
      answerTaskCard: (taskId: string, input: PaTaskCardAnswer) =>
        run(`card:${taskId}`, send => send<PaTask>(`/tasks/${encodeURIComponent(taskId)}/answer`, 'POST', input)),
      saveAgent: (input: PaAgentInput, existing?: PersonalAgent) =>
        run(paPendingKey.agent(existing?.id ?? null), (send) =>
          existing
            ? send<PersonalAgent>(`/agents/${encodeURIComponent(existing.id)}`, 'PATCH', { ...input, revision: existing.revision })
            : send<PersonalAgent>('/agents', 'POST', input),
        ),
      setAgentModel: async (agent: PersonalAgent, model: PersonalAgent['model']) => {
        const nextModel = { runtime: model.runtime, modelId: model.modelId };
        const patchOnce = () =>
          run(paPendingKey.agent(agent.id), (send) => {
            const current = snapshotRef.current?.agents.find((item) => item.id === agent.id) ?? agent;
            return send<PersonalAgent>(`/agents/${encodeURIComponent(current.id)}`, 'PATCH', {
              ...agentInput(current),
              model: nextModel,
              revision: current.revision,
            });
          });
        try {
          return await patchOnce();
        } catch (error) {
          if (isRevisionConflict(error)) return patchOnce();
          throw error;
        }
      },
      cloneAgent: (agentId: string) =>
        run(paPendingKey.clone(agentId), (send) => send<PersonalAgent>(`/agents/${encodeURIComponent(agentId)}/clone`, 'POST')),
      setAgentEnabled: (agent: PersonalAgent, enabled: boolean) =>
        run(paPendingKey.enable(agent.id), async (send) => {
          await send(`/agents/${encodeURIComponent(agent.id)}`, 'PATCH', { ...agentInput(agent), enabled, revision: agent.revision });
        }),
      saveGroup: (input: PaGroupInput, existing?: PaGroup) =>
        run(paPendingKey.group(existing?.id ?? null), (send) =>
          existing
            ? send<PaGroup>(`/groups/${encodeURIComponent(existing.id)}`, 'PATCH', { ...input, revision: existing.revision })
            : send<PaGroup>('/groups', 'POST', input),
        ),
      saveMemory: (input: PaMemoryInput, existing?: PaMemory) =>
        run(paPendingKey.memory(existing?.id ?? null), (send) =>
          existing
            ? send<PaMemory>(`/memories/${encodeURIComponent(existing.id)}`, 'PATCH', { ...input, revision: existing.revision })
            : send<PaMemory>('/memories', 'POST', input),
        ),
      deleteMemory: (memoryId: string) =>
        run(paPendingKey.deleteMemory(memoryId), async (send) => {
          await send(`/memories/${encodeURIComponent(memoryId)}`, 'DELETE');
        }),
      resolveMemoryCandidate: (id: string, revision: number, accept: boolean) =>
        run(paPendingKey.memory(id), async (send) => {
          await send(`/memory-candidates/${encodeURIComponent(id)}/resolve`, 'POST', { revision, accept });
        }),
      patchControl: (patch: PaControlPatch) =>
        run(
          paPendingKey.control(),
          async (send) => {
            const next = await send<PaControl>('/control', 'PATCH', patch);
            const parsed = parseControl(next);
            if (parsed && mounted.current) applyControl(parsed);
            return next;
          },
          true,
        ),
      createChannel: (input: PaChannelInput) =>
        run(paPendingKey.channel(null), (send) => send<PaChannel>('/channels', 'POST', input), true),
      createChannelBinding: (connectionId: string, input: PaChannelInput) =>
        run(paPendingKey.channel(null), send => send<PaChannel>(`/channels/${encodeURIComponent(connectionId)}/bindings`, 'POST', input), true),
      updateChannel: (channel: PaChannel, input: PaChannelInput) =>
        run(
          paPendingKey.channel(channel.id),
          (send) => send<PaChannel>(`/channels/${encodeURIComponent(channel.id)}`, 'PATCH', { ...input, revision: channel.revision }),
          true,
        ),
      connectFeishu: (channelId: string, body: { appId: string; appSecret: string; brand?: 'feishu' | 'lark' } | { localAppId: string }) =>
        run(
          paPendingKey.feishu(channelId),
          async (send) => {
            await send(`/channels/${encodeURIComponent(channelId)}/feishu`, 'POST', body);
          },
          true,
        ),
      connectIm: (channelId: string, fields: Record<string, string>) =>
        run(paPendingKey.connect(channelId), async send => {
          await send(`/channels/${encodeURIComponent(channelId)}/im`, 'POST', fields);
        }, true),
      startFeishuRegistration: (channelId: string) =>
        transportRef.current<PaFeishuRegistration>(`/channels/${encodeURIComponent(channelId)}/feishu-registration`, 'POST'),
      readFeishuRegistration: async (channelId: string, signal?: AbortSignal) => {
        const registration = await transportRef.current<PaFeishuRegistration | null>(
          `/channels/${encodeURIComponent(channelId)}/feishu-registration`, 'GET', undefined, signal,
        );
        if (registration?.status === 'confirmed' && !signal?.aborted) void readAux().catch(() => {});
        return registration;
      },
      cancelFeishuRegistration: (channelId: string) =>
        transportRef.current<PaFeishuRegistration | null>(`/channels/${encodeURIComponent(channelId)}/feishu-registration`, 'DELETE'),
      listLocalFeishuApps: async () => {
        begin(paPendingKey.localApps());
        try {
          return list<PaLocalFeishuApp>(await transportRef.current<unknown>('/channels/local-feishu-apps', 'GET'));
        } finally {
          end(paPendingKey.localApps());
        }
      },
      pairChannel: (channelId: string) =>
        run(paPendingKey.pair(channelId), (send) => send<PaChannelPairing>(`/channels/${encodeURIComponent(channelId)}/pair`, 'POST'), true),
      startWeixinLogin: (channelId: string) =>
        run(paPendingKey.login(channelId), (send) => send<PaChannelLogin>(`/channels/${encodeURIComponent(channelId)}/login`, 'POST'), true),
      /** A poll, not a mutation: no pending key and no snapshot re-read, except once the login completes. */
      pollWeixinLogin: async (channelId: string) => {
        const login = await transportRef.current<PaChannelLogin>(`/channels/${encodeURIComponent(channelId)}/login`, 'GET');
        if (login?.status === 'confirmed') void readAux().catch(() => {});
        return login;
      },
      submitWeixinPin: (channelId: string, pin: string) =>
        run(
          paPendingKey.pin(channelId),
          (send) => send<PaChannelLogin>(`/channels/${encodeURIComponent(channelId)}/login/pin`, 'POST', { pin }),
          true,
        ),
      connectChannel: (channelId: string) =>
        run(
          paPendingKey.connect(channelId),
          async (send) => {
            // The route answers with the full channel snapshot.
            const next = parseChannels(await send<unknown>(`/channels/${encodeURIComponent(channelId)}/connect`, 'POST'));
            if (next !== PA_EMPTY_CHANNELS && mounted.current) applyChannels(next);
          },
          true,
        ),
      disconnectChannel: (channelId: string, forget: boolean) =>
        run(
          paPendingKey.disconnect(channelId),
          async (send) => {
            await send(`/channels/${encodeURIComponent(channelId)}/disconnect`, 'POST', forget ? { forget: true } : {});
          },
          true,
        ),
      removeChannel: (channelId: string) =>
        run(paPendingKey.disconnect(channelId), async send => {
          await send(`/channels/${encodeURIComponent(channelId)}`, 'DELETE');
        }, true),
      answerApproval: (inbox: PaChannelInbox, approved: boolean) =>
        run(
          paPendingKey.approval(inbox.id),
          async (send) => {
            await send(`/channels/inbox/${encodeURIComponent(inbox.id)}/approve`, 'POST', { approved, revision: inbox.revision });
          },
          true,
        ),
      resolveOutbox: (outbox: PaChannelOutbox, action: 'query' | 'delivered' | 'retry') =>
        run(
          paPendingKey.outbox(outbox.id),
          async (send) => {
            await send(`/channels/outbox/${encodeURIComponent(outbox.id)}/resolve`, 'POST', { action, revision: outbox.revision });
          },
          true,
        ),
      taskEvents: async (taskId: string) =>
        list<PaTaskEvent>(await transportRef.current<unknown>(`/tasks/${encodeURIComponent(taskId)}/events`, 'GET')),
      attemptOutput: (attemptId: string, q: { offset: number; limit: number; q?: string }) => {
        const params = new URLSearchParams({ offset: String(q.offset), limit: String(q.limit) });
        if (q.q) params.set('q', q.q);
        return transportRef.current<PaOutputPage>(`/attempts/${encodeURIComponent(attemptId)}/output?${params.toString()}`, 'GET');
      },

      // ---- soul. Bodies come from the patch argument or a to…Input picker; no entity is ever spread. ----
      sendChat: (input) =>
        run(
          paPendingKey.send(input.conversationId),
          (send) =>
            send<PaTask>('/tasks', 'POST', {
              requestId: input.requestId,
              conversationId: input.conversationId,
              goal: input.text,
              kind: 'chat',
              targetAgentIds: input.targetAgentIds ?? [],
              ...(input.replyTo ? { replyTo: input.replyTo } : {}),
            }),
          false,
          true,
        ),
      saveCharacter: (agentId, patch) =>
        run(paPendingKey.soulCharacter(agentId), (send) => {
          const revision = characterRevision(agentId);
          return send<PaCharacterView>(soulPath('characters', agentId), 'PUT', {
            ...patch,
            ...(revision !== null ? { revision } : {}),
          });
        }),
      removeCharacter: (agentId, forgetMemories) =>
        run(paPendingKey.soulCharacter(agentId), async (send) => {
          const revision = characterRevision(agentId);
          if (revision === null) throw new Error(`Unknown character ${agentId}`);
          await send(soulPath('characters', agentId), 'DELETE', { revision, ...(forgetMemories ? { forgetMemories: true } : {}) });
        }),
      importCard: (body) =>
        run(paPendingKey.soulImport(), (send) =>
          send<{ agent: PersonalAgent; conversation: PaConversation; report: { needsReview: PaNeedsReviewItem[]; preservedKeys: string[] } }>(
            '/soul/characters/import',
            'POST',
            {
              card: body.card,
              ...(body.fileName !== undefined ? { fileName: body.fileName } : {}),
              ...(body.portrait ? { portrait: { mime: body.portrait.mime, data: body.portrait.data } } : {}),
              ...(body.model ? { model: body.model } : {}),
              ...(body.agentId ? { agentId: body.agentId } : {}),
              ...(body.agentId && body.revision !== undefined ? { revision: body.revision } : {}),
              ...spritesBody(body.sprites),
            },
          ),
        ),
      exportCard: (agentId, includeQuarantined) =>
        flight(paPendingKey.soulCharacter(agentId), (send) =>
          send<Record<string, unknown>>(`${soulPath('characters', agentId)}/export${includeQuarantined ? '?quarantine=1' : ''}`, 'GET'),
        ),
      installStarter: (id) =>
        run(paPendingKey.soulStarter(id), (send) =>
          send<{ conversation: PaConversation }>(`/soul/starters/${encodeURIComponent(id)}/install`, 'POST', {}),
        ),
      syncOrg: () => run(paPendingKey.orgSync(), (send) => send<unknown>('/enterprise/org/sync', 'POST', {})),
      loadLorebook: (id) => transportRef.current<PaLorebook>(soulPath('lorebooks', id), 'GET'),
      saveLorebook: (input, existing) =>
        run(paPendingKey.soulLorebook(existing?.id ?? null), (send) =>
          existing
            ? send<PaLorebookSummary>(soulPath('lorebooks', existing.id), 'PATCH', { ...input, revision: existing.revision })
            : send<PaLorebookSummary>('/soul/lorebooks', 'POST', input),
        ),
      removeLorebook: (book) =>
        run(paPendingKey.soulLorebook(book.id), async (send) => {
          await send(soulPath('lorebooks', book.id), 'DELETE', { revision: book.revision });
        }),
      importWorld: (body) =>
        run(paPendingKey.soulImport(), (send) =>
          send<{ lorebook: PaLorebookSummary; report: PaNeedsReviewItem[] }>('/soul/lorebooks/import', 'POST', {
            world: body.world,
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.fileName !== undefined ? { fileName: body.fileName } : {}),
            ...(body.agentId ? { agentId: body.agentId } : {}),
          }),
        ),
      exportWorld: (id) => transportRef.current<Record<string, unknown>>(`${soulPath('lorebooks', id)}/export`, 'GET'),
      testLorebook: (body) =>
        transportRef.current<{ trace: PaSoulTraceLore[]; used: number; limit: number }>('/soul/lorebooks/test', 'POST', {
          ...(body.lorebook ? { lorebook: body.lorebook } : {}),
          ...(body.lorebookId ? { lorebookId: body.lorebookId } : {}),
          messages: body.messages,
          ...(body.index !== undefined ? { index: body.index } : {}),
        }),
      savePersona: (input, existing) =>
        run(paPendingKey.soulPersona(existing?.id ?? null), (send) =>
          existing
            ? send<PaPersona>(soulPath('personas', existing.id), 'PATCH', { ...input, revision: existing.revision })
            : send<PaPersona>('/soul/personas', 'POST', input),
        ),
      removePersona: (persona) =>
        run(paPendingKey.soulPersona(persona.id), async (send) => {
          await send(soulPath('personas', persona.id), 'DELETE', { revision: persona.revision });
        }),
      savePreset: (input, existing) =>
        run(paPendingKey.soulPreset(existing?.id ?? null), (send) =>
          existing
            ? send<PaStylePreset>(soulPath('presets', existing.id), 'PATCH', { ...input, revision: existing.revision })
            : send<PaStylePreset>('/soul/presets', 'POST', input),
        ),
      removePreset: (preset) =>
        run(paPendingKey.soulPreset(preset.id), async (send) => {
          await send(soulPath('presets', preset.id), 'DELETE', { revision: preset.revision });
        }),
      saveChat: (conversationId, patch) =>
        run(paPendingKey.soulChat(conversationId), (send) => {
          const revision = soulRef.current?.chats.find((chat) => chat.id === conversationId)?.revision ?? 0;
          return send<PaChatView>(soulPath('chats', conversationId), 'PUT', { ...patch, ...(revision > 0 ? { revision } : {}) });
        }),
      applyStateOps: (conversationId, ops) =>
        run(paPendingKey.soulState(conversationId), (send) =>
          send<PaChatView>('/soul/chat/state', 'POST', { conversationId, ops: ops.map(({ key, op, value }) => ({ key, op, value })) }),
        ),
      uploadAsset: (body) =>
        flight(paPendingKey.soulAsset(), (send) => send<{ id: string }>('/soul/assets', 'POST', { mime: body.mime, data: body.data })),
      editMessage: (message, patch) =>
        run(paPendingKey.soulMessage(message.id), (send) =>
          send<PaMessage>(soulPath('messages', message.id), 'PATCH', {
            ...(patch.content !== undefined ? { content: patch.content } : {}),
            ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
            revision: message.revision,
          }),
        ),
      deleteMessage: (message, forget) =>
        run(paPendingKey.soulMessage(message.id), async (send) => {
          await send(soulPath('messages', message.id), 'DELETE', { revision: message.revision, ...(forget ? { forget: true } : {}) });
        }),
      selectVariant: (rootId, choice) =>
        run(paPendingKey.soulMessage(rootId), async (send) => {
          await send(
            `${soulPath('messages', rootId)}/variant`,
            'POST',
            'messageId' in choice ? { messageId: choice.messageId } : { greetingIndex: choice.greetingIndex },
          );
        }),
      revealDraw: (messageId) =>
        run(paPendingKey.soulMessage(messageId), async (send) => {
          await send(`${soulPath('messages', messageId)}/reveal`, 'POST', {});
        }),
      regenerate: (conversationId, messageId) =>
        run(
          paPendingKey.soulTurn(conversationId),
          (send) => send<PaTask>('/soul/chat/regenerate', 'POST', { conversationId, messageId, requestId: newRequestId() }),
          false,
          true,
        ),
      continueChat: (conversationId, options) =>
        run(
          paPendingKey.soulTurn(conversationId),
          (send) =>
            send<PaTask>('/soul/chat/continue', 'POST', {
              conversationId,
              requestId: newRequestId(),
              ...(options?.agentId ? { agentId: options.agentId } : {}),
              ...(options?.directive ? { directive: options.directive } : {}),
            }),
          false,
          true,
        ),
      roll: (conversationId, body) =>
        run(
          paPendingKey.soulPlay(conversationId),
          async (send) => {
            await send('/soul/chat/roll', 'POST', {
              conversationId,
              notation: body.notation,
              ...(body.label ? { label: body.label } : {}),
              ...(body.dc !== undefined ? { dc: body.dc } : {}),
              ...(body.respond !== undefined ? { respond: body.respond } : {}),
              requestId: newRequestId(),
            });
          },
          false,
          true,
        ),
      draw: (conversationId, body) =>
        run(
          paPendingKey.soulPlay(conversationId),
          async (send) => {
            await send('/soul/chat/draw', 'POST', {
              conversationId,
              deckId: body.deckId,
              ...(body.respond !== undefined ? { respond: body.respond } : {}),
              requestId: newRequestId(),
            });
          },
          false,
          true,
        ),
      eventAction: (conversationId, action, respond) =>
        run(
          paPendingKey.soulPlay(conversationId),
          async (send) => {
            await send('/soul/chat/event', 'POST', {
              conversationId,
              action,
              ...(respond !== undefined ? { respond } : {}),
              requestId: newRequestId(),
            });
          },
          false,
          true,
        ),
      branch: (conversationId, messageId) =>
        run(paPendingKey.soulBranch(messageId), (send) =>
          send<PaConversation>(`/soul/conversations/${encodeURIComponent(conversationId)}/branch`, 'POST', { messageId }),
        ),
      loadTrace: (messageId) => transportRef.current<PaSoulTrace | null>(soulPath('trace', messageId), 'GET'),
      previewTurn: (conversationId, draft, agentId) =>
        flight(paPendingKey.soulPreview(conversationId), (send) =>
          send<PaSoulTrace>('/soul/chat/preview', 'POST', {
            conversationId,
            ...(draft ? { draft } : {}),
            ...(agentId ? { agentId } : {}),
          }),
        ),

      // ---- soul, stage 2. Reads go straight through the transport; only `speak` holds a pending key. ----
      readLive: (conversationId, known, signal) => {
        const params = new URLSearchParams({ conversationId });
        if (known) {
          params.set('attempt', known.attemptId);
          params.set('seq', String(known.seq));
        }
        return transportRef.current<PaSoulLiveResponse>(`/soul/live?${params.toString()}`, 'GET', undefined, signal);
      },
      speechStatus: () => transportRef.current<PaSpeechStatus>('/soul/speech/status', 'GET'),
      speechVoices: (model) => transportRef.current<PaSpeechVoices>(`/soul/speech/voices?model=${encodeURIComponent(model)}`, 'GET'),
      listSpeech: async (conversationId) => {
        const raw = await transportRef.current<unknown>(`/soul/speech?conversationId=${encodeURIComponent(conversationId)}`, 'GET');
        return list<PaSpeechItem>((raw as { items?: unknown } | null)?.items);
      },
      speak: (messageId) =>
        flight(paPendingKey.soulSpeech(messageId), (send) => send<PaSpeechItem>('/soul/speech', 'POST', { messageId })),
      previewSpeech: (input) => transportRef.current<PaSpeechPreview>('/soul/speech/preview', 'POST', input),
    };
  }, [applyChannels, applyControl, begin, end, flight, markFailure, readAux, readModels, readSnapshot, run]);

  return useMemo<PaData>(
    () => ({ snapshot, soul, models, control, channels, load, stale, pending, actions }),
    [actions, channels, control, load, models, pending, snapshot, soul, stale],
  );
}

/** The `sprites` member of an import body: only the eight emotion keys, only non-empty ids, omitted when none. The
 *  keys come from PA_EMOTIONS, never from the caller's object. */
function spritesBody(sprites: Partial<Record<PaEmotion, string>> | undefined): { sprites?: Partial<Record<PaEmotion, string>> } {
  if (!sprites) return {};
  const picked = PA_EMOTIONS.flatMap((emotion) => {
    const id = Object.hasOwn(sprites, emotion) ? sprites[emotion] : undefined;
    return typeof id === 'string' && id ? [[emotion, id] as const] : [];
  });
  return picked.length > 0 ? { sprites: Object.fromEntries(picked) as Partial<Record<PaEmotion, string>> } : {};
}

/** `/soul/<collection>/<id>` with the id encoded. */
function soulPath(collection: 'characters' | 'lorebooks' | 'personas' | 'presets' | 'chats' | 'messages' | 'trace', id: string): string {
  return `/soul/${collection}/${encodeURIComponent(id)}`;
}
