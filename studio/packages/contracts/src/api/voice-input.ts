import { z } from 'zod';

export const VOICE_INPUT_MAX_SECONDS = 120;
export const VOICE_INPUT_MAX_BYTES = 10 * 1024 * 1024;

export const VoiceInputConfigSchema = z.object({
  provider: z.enum(['tokentosea', 'custom']).default('tokentosea'),
  model: z.string().trim().max(200).default(''),
  custom: z.object({
    baseUrl: z.string().trim().max(2048).default(''),
    model: z.string().trim().max(200).default(''),
    apiKey: z.string().trim().max(8192).default(''),
  }).default({}),
});

export type VoiceInputConfig = z.infer<typeof VoiceInputConfigSchema>;
export type VoiceInputSettings = Omit<VoiceInputConfig, 'custom'> & {
  custom: Omit<VoiceInputConfig['custom'], 'apiKey'> & { apiKeyConfigured: boolean };
};
export const VoiceInputUpdateSchema = VoiceInputConfigSchema.extend({
  clearApiKey: z.boolean().optional(),
});
export type VoiceInputUpdate = z.infer<typeof VoiceInputUpdateSchema>;
export interface VoiceInputModel { id: string; name: string }
export interface VoiceInputTranscript { text: string; model: string }
