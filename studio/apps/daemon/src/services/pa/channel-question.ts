import { z } from 'zod';
import { parsePaJson } from '../personal-agent-artifacts.js';

const schema = z.object({
  channelQuestion: z.object({
    prompt: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(100)).min(2).max(5),
    multiple: z.boolean().default(false),
  }).strict(),
}).strict();

export function parsePaChannelQuestion(output: string) {
  try {
    const result = schema.safeParse(parsePaJson(output));
    if (result.success && new Set(result.data.channelQuestion.options).size === result.data.channelQuestion.options.length)
      return result.data.channelQuestion;
  } catch { /* An ordinary text response can contain prose or code. */ }
  return null;
}
