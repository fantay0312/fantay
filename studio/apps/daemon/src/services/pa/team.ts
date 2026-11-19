import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PaGroup, PaPrincipal, PersonalAgent } from '@open-design/contracts';
import { PaError } from '../../storage/personal-agent-store.js';
import { parsePaJson } from '../personal-agent-artifacts.js';

export interface PaCreatedTeam extends PaGroup {
  teamSourceTaskId: string;
  teamChannelScope: string | null;
}

export const paTeamNameKey = (name: string) => name.normalize('NFKC').trim().toLowerCase();

export function paTeamChannelScope(principal: Extract<PaPrincipal, { kind: 'channel' }>): string {
  return createHash('sha256').update(JSON.stringify([principal.id, principal.accountId, principal.subjectId])).digest('hex');
}

const name = (max: number) => z.string().trim().min(1).max(max).regex(/^[^|｜\r\n\t\u0000-\u001f\u007f]+$/u);
const planSchema = z.union([
  z.object({ question: z.string().trim().min(1).max(600) }).strict(),
  z.object({
    name: name(80),
    members: z.array(z.object({ name: name(60), role: z.string().trim().min(1).max(1200) }).strict()).min(1).max(11),
  }).strict(),
]);

export function parsePaTeamPlan(output: string, coordinator: PersonalAgent) {
  const result = planSchema.safeParse(parsePaJson(output));
  if (!result.success) throw new PaError('团队方案格式不正确，请重试或明确列出需要的成员', 422, 'PA_TEAM_PLAN');
  const plan = result.data;
  if ('question' in plan) return plan;
  const names = [coordinator.name, ...plan.members.map(member => member.name)].map(paTeamNameKey);
  if (new Set(names).size !== names.length) throw new PaError('团队成员名称重复，请指定不同的名字', 422, 'PA_TEAM_PLAN');
  return plan;
}
