import { z } from 'zod';

/** Stable run instruction for a normal conversation opened in the side-chat tool. */
export const FANTAY_SIDE_CHAT_INSTRUCTIONS = `你在 Fantay 的「侧边聊天」里与用户交谈。这里有独立的聊天记录、模型选择和执行权限。用用户的语言回答。随手提问、解释和闲聊直接接话；明确选择的附件、技能、研究或工具按该轮请求和本会话权限使用。讨论想法、询问进度和“先别跑”都不是执行授权。
用户准备给主会话交代任务时，保留目标、范围、原有约束与验收条件，只问确实会改变结果的问题。主会话的读取、转达和回执由 Fantay 的跟进与转达操作负责。需要主会话的新记录时提示使用“跟进进展”。不凭侧聊中的猜测报告进度，不声称已转发或替用户批准。用户可以在多轮中多次补充和转达，每条独立处理。`;

const choice = z.string().min(1).max(200);
export const sideDialogueRequest = z.object({
  mode: z.enum(['chat', 'progress', 'relay']),
  locale: z.string().min(1).max(40),
  agent: choice,
  model: choice,
  reasoning: choice.optional(),
  serviceTier: choice.optional(),
  byok: z.object({
    protocol: z.enum(['anthropic', 'openai', 'azure', 'google', 'ollama', 'senseaudio', 'aihubmix']),
    baseUrl: z.string().max(2048).optional(),
    apiKey: z.string().max(16384),
    requiresApiKey: z.boolean().optional(),
    reasoningModel: z.boolean().optional(),
    apiVersion: z.string().max(100).optional(),
  }).optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(16000) })).min(1).max(20),
  projectId: z.string().min(1).max(200).optional(),
  main: z.object({
    title: z.string().max(500),
    status: z.enum(['running', 'idle']),
    queued: z.number().int().nonnegative(),
    recent: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      text: z.string().max(2400),
      status: z.string().max(50).optional(),
      activity: z.array(z.string().max(250)).max(5),
    })).max(8),
  }).optional(),
});
export type SideDialogueRequest = z.infer<typeof sideDialogueRequest>;
export type SideDialogueSnapshot = NonNullable<SideDialogueRequest['main']>;
export type SideDialogueReply =
  | { kind: 'reply'; text: string }
  | { kind: 'draft'; text: string; review: boolean }
  | { kind: 'read_main' };
