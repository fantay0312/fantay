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
export const PA_CHANNEL_TYPES = ['feishu', 'weixin', 'dingtalk', 'wecom', 'qq', 'telegram', 'discord', 'slack'] as const;
export const PA_IM_PLATFORMS = {
  dingtalk: { fields: [{ key: 'clientId', label: 'Client ID', secret: false }, { key: 'clientSecret', label: 'Client Secret', secret: true }] },
  wecom: { fields: [{ key: 'botId', label: 'Bot ID', secret: false }, { key: 'secret', label: 'Secret', secret: true }] },
  qq: { fields: [{ key: 'appId', label: 'App ID', secret: false }, { key: 'appSecret', label: 'App Secret', secret: true }] },
  telegram: { fields: [{ key: 'token', label: 'Bot Token', secret: true }] },
  discord: { fields: [{ key: 'token', label: 'Bot Token', secret: true }] },
  slack: { fields: [{ key: 'appToken', label: 'App-Level Token', secret: true }, { key: 'botToken', label: 'Bot Token', secret: true }] },
} as const;
export type PaImPlatform = keyof typeof PA_IM_PLATFORMS;
export function isPaImPlatform(type: string): type is PaImPlatform {
  return Object.hasOwn(PA_IM_PLATFORMS, type);
}
export const paChannelInputSchema = z.object({
  type: z.enum(PA_CHANNEL_TYPES),
  name: z.string().trim().min(1).max(80),
  targetKind: z.enum(['agent', 'group']),
  targetId: z.string().min(1).max(100),
  enabled: z.boolean().default(false),
  allowProject: z.boolean().default(false),
  allowTeam: z.boolean().optional(),
  allowRemoteApproval: z.boolean().optional(),
  allowAccountModel: z.boolean().optional(),
  shareUpdates: z.boolean().optional(),
  shareGroupMemory: z.boolean().default(false),
  /** 'companion': plain messages are answered as chat turns by the target's characters (when every one of them has a
   *  character card); 'work' runs each message as a task. A record saved before this option existed is 'work'. */
  chatMode: z.enum(['work', 'companion']).default('work'),
  allowedSenderIds: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  remoteChatId: z.string().max(200).nullable().default(null),
  tenantId: z.string().max(200).nullable().default(null),
});
export type PaChannelInput = z.infer<typeof paChannelInputSchema>;
export type PaChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'login_required' | 'paused' | 'error';
export interface PaChannel extends PaEntity, PaChannelInput {
  connectionId?: string;
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
export interface PaFeishuRegistration {
  status: 'starting' | 'waiting' | 'confirmed' | 'expired' | 'failed' | 'cancelled';
  expiresAt: number;
  authorizationUrl: string | null;
  botUrl: string | null;
  error: 'denied' | 'registration' | 'connection' | null;
}
export interface PaChannelSnapshot { channels: PaChannel[]; inbox: PaChannelInbox[]; outbox: PaChannelOutbox[] }
export interface PaOutputPage { attemptId: string; offset: number; nextOffset: number | null; totalChars: number; text: string; matches: Array<{ offset: number; excerpt: string }> }
export interface PaProjectApproval extends PaEntity {
  parametersHash?: string;
  channelId: string; inboxId: string; requestId: string; goalHash: string; authorizationVersion: number;
  state: 'pending' | 'approved' | 'rejected'; expiresAt: number; taskId: string | null;
}
