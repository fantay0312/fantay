/** @module agent-protocol/pi-rpc/events
 * Pure event mapper for pi's JSON-RPC stream protocol. Translates raw JSON
 * objects emitted by `pi --mode rpc` into the daemon's typed UI events:
 * status, text_delta, thinking, tool_use, tool_result, usage, and error.
 * No I/O — all side effects flow through the SendAgentEvent callback.
 */
import type { JsonRecord, SendAgentEvent, TokenUsage } from './internal.js';
import { getRecord } from './internal.js';
import { createToolInputPathScanner, type ToolInputPathScanner } from '../../runtimes/tool-input-path-scanner.js';

/** A tool call whose arguments are still streaming, keyed by content index. */
type StreamingToolCall = {
  id: string;
  name: string;
  startedAt: number;
  scanner: ToolInputPathScanner | null;
  targetPath?: string;
};

/** An assistant failure held back until pi says whether it will recover. */
type PendingTurnError = { message: string; raw: JsonRecord };

/** Timing and first-token-tracking context threaded through every mapPiRpcEvent call. */
export type PiRpcContext = {
  runStartedAt: number;
  sentFirstToken: { value: boolean };
  /** Per-run state for argument streaming; absent means previews are off. */
  toolCalls?: Map<number, StreamingToolCall>;
  /**
   * When present, an assistant-turn error is held until the run is final.
   * pi reports a failed turn (`turn_end` with stopReason `error`) BEFORE it
   * decides to auto-retry or compact and continue, so surfacing it at once
   * would fail a run pi is about to recover. It is reported at
   * `agent_settled` (or a legacy `agent_end` without `willRetry`) unless a
   * retry or continuation cleared it first.
   */
  turnError?: { pending: PendingTurnError | null };
};

function reportOrHoldTurnError(ctx: PiRpcContext, send: SendAgentEvent, message: string, raw: JsonRecord): void {
  if (ctx.turnError) ctx.turnError.pending = { message, raw };
  else send('agent', { type: 'error', message, raw });
}

/** Report an error held back while pi could still retry the turn. */
export function flushTurnError(ctx: Pick<PiRpcContext, 'turnError'>, send: SendAgentEvent): void {
  const pending = ctx.turnError?.pending;
  if (!pending) return;
  ctx.turnError!.pending = null;
  send('agent', { type: 'error', message: pending.message, raw: pending.raw });
}

/**
 * A tool call whose arguments were streaming when the assistant message
 * failed or was aborted never runs, so pi never reports it. Close the
 * in-flight row it produced instead of leaving it pending forever.
 */
function retireUnfinishedToolCalls(ctx: PiRpcContext, send: SendAgentEvent): void {
  if (!ctx.toolCalls || ctx.toolCalls.size === 0) return;
  for (const call of ctx.toolCalls.values()) {
    if (call.targetPath === undefined) continue;
    send('agent', { type: 'tool_use', id: call.id, name: call.name, input: { path: call.targetPath } });
    send('agent', {
      type: 'tool_result',
      toolUseId: call.id,
      content: 'The tool call was interrupted before it ran.',
      isError: true,
    });
  }
  ctx.toolCalls.clear();
}

/**
 * pi names its file tools in lowercase. The shared path scanner speaks the
 * Claude names; `write` is a whole-file write, `edit` names its file first.
 */
function scannerForPiTool(name: string): ToolInputPathScanner | null {
  if (name === 'write') return createToolInputPathScanner('Write');
  if (name === 'edit') return createToolInputPathScanner('Edit');
  return createToolInputPathScanner(name);
}

/**
 * What the session layer must act on; every other record maps to events only.
 * `work_start`/`work_end` bracket automatic work (retry, compaction,
 * summarization) that can run between a final `agent_end` and `agent_settled`.
 */
export type PiRpcLifecycle = 'agent_start' | 'agent_end' | 'agent_settled' | 'work_start' | 'work_end';
/**
 * Maps a single raw pi RPC JSON object to zero or more daemon SSE events,
 * dispatching each through `send`. Returns `'agent_end'` when pi signals the
 * end of the run; returns `null` for every other event type.
 *
 * @param raw  - Parsed JSON object read from pi's stdout.
 * @param send - Callback that forwards a typed event to the daemon SSE layer.
 * @param ctx  - Per-run context: start timestamp and first-token sentinel.
 * @returns `'agent_end'` on run completion, `null` otherwise.
 */
export function mapPiRpcEvent(
  raw: JsonRecord,
  send: SendAgentEvent,
  ctx: PiRpcContext,
): PiRpcLifecycle | null {
  if (raw.type === 'agent_start') {
    send('agent', { type: 'status', label: 'working' });
    return 'agent_start';
  }

  if (raw.type === 'agent_end') {
    // A retry, overflow recovery or queued follow-up can still follow; the
    // session decides from `willRetry` and `agent_settled`.
    if (raw.willRetry === true) {
      if (ctx.turnError) ctx.turnError.pending = null;
      return null;
    }
    // Builds that predate `willRetry` end the run here.
    if (!('willRetry' in raw)) flushTurnError(ctx, send);
    return 'agent_end';
  }

  if (raw.type === 'agent_settled') {
    flushTurnError(ctx, send);
    return 'agent_settled';
  }

  if (raw.type === 'turn_start') {
    send('agent', { type: 'status', label: 'thinking' });
    return null;
  }

  if (raw.type === 'turn_end') {
    const message = getRecord(raw.message);
    const messageUsage = getRecord(message?.usage);
    if (messageUsage) {
      const u = messageUsage;
      const usage: TokenUsage = {};
      if (typeof u.input === 'number') usage.input_tokens = u.input;
      if (typeof u.output === 'number') usage.output_tokens = u.output;
      if (typeof u.cacheRead === 'number') usage.cached_read_tokens = u.cacheRead;
      if (typeof u.cacheWrite === 'number') usage.cached_write_tokens = u.cacheWrite;
      if (typeof u.totalTokens === 'number') usage.total_tokens = u.totalTokens;
      if (Object.keys(usage).length > 0) {
        const cost = getRecord(u.cost);
        send('agent', {
          type: 'usage',
          usage,
          costUsd: cost?.total ?? cost?.totalCost ?? null,
          durationMs: Date.now() - ctx.runStartedAt,
        });
      }
    }

    if (message?.stopReason === 'error' || message?.stopReason === 'aborted') {
      retireUnfinishedToolCalls(ctx, send);
    } else {
      // turn_end follows the turn's tool executions; nothing is in flight.
      ctx.toolCalls?.clear();
    }
    if (message?.stopReason === 'error') {
      const messageText =
        typeof message.errorMessage === 'string' && message.errorMessage.length > 0
          ? message.errorMessage
          : 'Pi agent error';
      reportOrHoldTurnError(ctx, send, messageText, raw);
    }
    return null;
  }

  const assistantMessageEvent = getRecord(raw.assistantMessageEvent);
  if (raw.type === 'message_update' && assistantMessageEvent) {
    const ev = assistantMessageEvent;

    if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
      if (!ctx.sentFirstToken.value) {
        ctx.sentFirstToken.value = true;
        send('agent', {
          type: 'status',
          label: 'streaming',
          ttftMs: Date.now() - ctx.runStartedAt,
        });
      }
      send('agent', { type: 'text_delta', delta: ev.delta });
      return null;
    }

    if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') {
      send('agent', { type: 'thinking_delta', delta: ev.delta });
      return null;
    }

    if (ev.type === 'thinking_start') {
      send('agent', { type: 'thinking_start' });
      return null;
    }

    if (ev.type === 'thinking_end') {
      send('agent', { type: 'thinking_end' });
      return null;
    }

    // Tool arguments stream before the call runs. Mirror the Claude adapter:
    // `tool_input_delta` is the liveness heartbeat (never rendered), and the
    // file a write/edit targets is announced once its path is complete, so
    // the row appears while a long `content` is still generating.
    if (ev.type === 'toolcall_start' && ctx.toolCalls && typeof ev.contentIndex === 'number') {
      const id = typeof ev.id === 'string' && ev.id ? ev.id : null;
      const name = typeof ev.toolName === 'string' && ev.toolName ? ev.toolName : null;
      if (id && name) {
        ctx.toolCalls.set(ev.contentIndex, { id, name, startedAt: Date.now(), scanner: scannerForPiTool(name) });
      }
      return null;
    }

    if (ev.type === 'toolcall_delta' && ctx.toolCalls && typeof ev.contentIndex === 'number') {
      const call = ctx.toolCalls.get(ev.contentIndex);
      if (!call || typeof ev.delta !== 'string') return null;
      send('agent', { type: 'tool_input_delta', id: call.id, name: call.name, delta: ev.delta });
      const update = call.scanner?.push(ev.delta) ?? null;
      if (update?.path !== undefined) {
        call.targetPath = update.path;
        send('agent', { type: 'tool_input_target', id: call.id, name: call.name, path: update.path, startedAt: call.startedAt });
      }
      if (update?.lines !== undefined && call.targetPath !== undefined) {
        send('agent', {
          type: 'tool_input_progress',
          id: call.id,
          name: call.name,
          path: call.targetPath,
          lines: update.lines,
          startedAt: call.startedAt,
        });
      }
      return null;
    }

    if (ev.type === 'toolcall_end') {
      // pi closes the block before a failed stream throws, so the call can
      // still never run; turn_end decides (see retireUnfinishedToolCalls).
      return null;
    }

    // pi's RPC protocol emits a message_update with error delta when
    // the model returns an error (e.g. aborted, context overflow).
    // Surface it so sendAgentEvent's error-handling path sets
    // agentStreamError and the run flips to `failed` on close.
    if (ev.type === 'error') {
      const message =
        typeof ev.reason === 'string' && ev.reason.length > 0
          ? ev.reason
          : typeof ev.delta === 'string' && ev.delta.length > 0
            ? ev.delta
            : 'Agent error';
      reportOrHoldTurnError(ctx, send, message, raw);
      return null;
    }

    return null;
  }

  if (raw.type === 'message_end') {
    // message_end carries usage (already emitted from turn_end) and
    // tool call blocks (already emitted from tool_execution_start).
    // Nothing to extract here.
    return null;
  }

  if (raw.type === 'tool_execution_start') {
    const name = raw.toolName === 'fantay_workspace_write' ? 'write'
      : raw.toolName === 'fantay_workspace_edit' ? 'edit'
      : raw.toolName;
    send('agent', {
      type: 'tool_use',
      id: raw.toolCallId ?? null,
      name: name ?? null,
      input: raw.args ?? null,
    });
    return null;
  }

  if (raw.type === 'tool_execution_end') {
    const result = getRecord(raw.result);
    const content = result?.content;
    const text =
      Array.isArray(content)
        ? content
            .map((c: unknown) => {
              const item = getRecord(c);
              return item?.type === 'text' ? String(item.text ?? '') : JSON.stringify(c);
            })
            .join('\n')
        : typeof content === 'string'
          ? content
          : '';
    send('agent', {
      type: 'tool_result',
      toolUseId: raw.toolCallId ?? null,
      content: text,
      isError: raw.isError === true,
    });
    return null;
  }

  // pi's RPC protocol can emit `extension_error` when an extension
  // throws during a tool call or event handler. Surface it so the
  // daemon's error-handling path (sendAgentEvent → agentStreamError)
  // can flip the run to `failed` and forward a visible SSE error.
  if (raw.type === 'extension_error') {
    const message =
      typeof raw.error === 'string' && raw.error.length > 0
        ? raw.error
        : 'Extension error';
    send('agent', { type: 'error', message, raw });
    return null;
  }

  if (raw.type === 'compaction_start') {
    send('agent', { type: 'status', label: 'compacting' });
    return ctx.turnError ? 'work_start' : null;
  }
  if (raw.type === 'compaction_end') {
    // Overflow recovery compacts and then retries the failed turn.
    if (raw.willRetry === true) {
      if (ctx.turnError) ctx.turnError.pending = null;
      return ctx.turnError ? 'work_start' : null;
    }
    return ctx.turnError ? 'work_end' : null;
  }
  if (raw.type === 'auto_retry_start') {
    send('agent', { type: 'status', label: 'retrying' });
    if (ctx.turnError) ctx.turnError.pending = null;
    return ctx.turnError ? 'work_start' : null;
  }

  if (raw.type === 'auto_retry_end') {
    if (raw.success === false) {
      // Auto-retry exhausted. The run fails with this error unless pi still
      // recovers the turn through overflow compaction (compaction_end with
      // willRetry drops it); otherwise it is reported when the turn settles.
      const message =
        typeof raw.finalError === 'string' && raw.finalError.length > 0
          ? raw.finalError
          : 'Auto-retry exhausted';
      reportOrHoldTurnError(ctx, send, message, raw);
    }
    return ctx.turnError ? 'work_end' : null;
  }

  // summarization_retry_* happen inside a compaction, which can make a second
  // summarization call after the first one's retry finished; compaction_start
  // and compaction_end alone bracket that work.

  return null;
}
