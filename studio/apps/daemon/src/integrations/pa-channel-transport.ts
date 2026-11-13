export interface PaInboundMessage {
  id: string; senderId: string; chatId: string; tenantId: string | null; threadId: string | null;
  text: string; createdAt: number; direct: boolean; mentioned: boolean; contextToken?: string;
  unsupported?: boolean;
}
export interface PaOutboundMessage { requestId: string; chatId: string; replyTo: string | null; threadId: string | null; text: string; contextToken?: string }
export interface PaSendReceipt { messageId: string | null; acknowledged: true }
export interface PaChannelTransport {
  start(onMessage: (message: PaInboundMessage) => Promise<void>, onState: (state: 'connecting' | 'connected' | 'login_required' | 'error', message?: string) => void): Promise<void>;
  stop(): Promise<void>;
  send(message: PaOutboundMessage, signal: AbortSignal): Promise<PaSendReceipt>;
  receipt?(messageId: string, signal: AbortSignal): Promise<boolean>;
  /** Provider-documented deduplication window, zero when not guaranteed. */
  idempotencyWindowMs: number;
}
export class PaChannelTransportError extends Error {
  constructor(message: string, readonly kind: 'login' | 'rate_limit' | 'rejected' | 'unknown', readonly retryAfterMs = 0) { super(message); }
}
export const channelRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const channelText = (value: unknown): string => typeof value === 'string' ? value : '';

/** Preserve JSON uint64 identifiers without matching strings with regular expressions. */
export function parseChannelJson(text: string): unknown {
  return (JSON.parse as (text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown)(text, (key, value, context) => {
    if (['message_id', 'msg_id', 'svr_id', 'seq'].includes(key) && typeof value === 'number') {
      if (context?.source && /^\d+$/.test(context.source)) return context.source;
      if (!Number.isSafeInteger(value)) throw new Error('Message identifier precision is unavailable');
      return String(value);
    }
    return value;
  });
}
export async function readChannelJson(response: Response, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new PaChannelTransportError('渠道响应为空', 'unknown');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new PaChannelTransportError('渠道响应超过上限', 'unknown'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  return parseChannelJson(Buffer.concat(chunks).toString('utf8'));
}
