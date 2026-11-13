import { z } from 'zod';
import type { PaEntity } from './personal-agent.js';

export const paControlPatchSchema = z.object({
  backgroundEnabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  maxConcurrent: z.number().int().min(1).max(4).optional(),
  defaultMaxAttempts: z.number().int().min(1).max(12).optional(),
  defaultTimeoutMs: z.number().int().min(1000).max(1800000).optional(),
  waitingExpiryMs: z.number().int().min(60000).max(7 * 86400000).optional(),
}).strict();
export interface PaControl extends PaEntity {
  backgroundEnabled: boolean; paused: boolean; suspended: boolean;
  maxConcurrent: number; defaultMaxAttempts: number; defaultTimeoutMs: number; waitingExpiryMs: number;
  activeCount: number; pendingCount: number; lastResumeAt: number | null;
}
export type PaControlPatch = z.infer<typeof paControlPatchSchema>;
export const paChannelInputSchema = z.object({
  type: z.enum(['feishu', 'weixin']),
  name: z.string().trim().min(1).max(80),
  targetKind: z.enum(['agent', 'group']),
  targetId: z.string().min(1).max(100),
  enabled: z.boolean().default(false),
  allowProject: z.boolean().default(false),
  shareGroupMemory: z.boolean().default(false),
  allowedSenderIds: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  remoteChatId: z.string().max(200).nullable().default(null),
  tenantId: z.string().max(200).nullable().default(null),
});
export type PaChannelInput = z.infer<typeof paChannelInputSchema>;
export type PaChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'login_required' | 'paused' | 'error';
export interface PaChannel extends PaEntity, PaChannelInput {
  authorizationVersion: number;
  status: PaChannelStatus; credentialConfigured: boolean; accountLabel: string | null;
  lastReceivedAt: number | null; lastSentAt: number | null; lastError: string | null;
  capabilities: { direct: boolean; groups: boolean; threads: boolean; files: boolean; unsolicited: boolean };
  verification: { inboundAt: number | null; outboundAt: number | null; reconnectAt: number | null; reloginAt: number | null };
}
export interface PaChannelInbox extends PaEntity {
  preview: string; approvalId?: string;
  approvalActionable?: boolean;
  channelId: string; providerMessageId: string; senderId: string; chatId: string; threadId: string | null;
  receivedAt: number; taskId: string | null; state: 'pending' | 'accepted' | 'approval' | 'ignored' | 'failed'; error: string | null;
}
export interface PaChannelOutbox extends PaEntity {
  preview: string;
  authorizationVersion: number;
  channelId: string; taskId: string | null; inboxId: string; requestId: string;
  state: 'pending' | 'sending' | 'sent' | 'unknown' | 'failed' | 'cancelled';
  providerMessageId: string | null; attempts: number; nextAttemptAt: number;
  error: string | null; sentAt: number | null;
}
export function paOutboxAuthorizationMatches(outbox: PaChannelOutbox, channel: PaChannel | null): boolean {
  return channel !== null && channel.id === outbox.channelId && channel.authorizationVersion === outbox.authorizationVersion;
}
export interface PaChannelLogin {
  channelId: string; status: 'waiting' | 'scanned' | 'verify_code' | 'confirmed' | 'expired' | 'failed';
  expiresAt: number; qrImagePath: string | null; message: string;
}
export interface PaChannelPairing { channelId: string; code: string; expiresAt: number }
export interface PaChannelSnapshot { channels: PaChannel[]; inbox: PaChannelInbox[]; outbox: PaChannelOutbox[] }
export interface PaOutputPage { attemptId: string; offset: number; nextOffset: number | null; totalChars: number; text: string; matches: Array<{ offset: number; excerpt: string }> }
export interface PaProjectApproval extends PaEntity {
  parametersHash?: string;
  channelId: string; inboxId: string; requestId: string; goalHash: string; authorizationVersion: number;
  state: 'pending' | 'approved' | 'rejected'; expiresAt: number; taskId: string | null;
}
