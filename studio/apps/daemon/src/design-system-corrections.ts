// Correction → design-system rules.
//
// When the user points out that something the agent made is wrong, the lesson belongs to the design
// system the run was using, not only to this conversation: the next screen built with that system
// should not repeat it. After a turn ends, this module reads the user's message (with any inline
// annotations and the agent's reply) and, only when the message reads as a correction, asks the
// memory model to turn it into at most a few standing rules: one instruction each, with its reason
// and a short note of what had gone wrong. The caller appends them to the system's `rules`.
//
// It reuses the memory extractor's provider selection and extraction records (`suggestWithLLM`,
// kind 'design-system'), so the same "Same as chat" provider runs it and Settings → Memory lists the
// attempt. It writes nothing itself; the caller finishes the attempt (`finishSuggestion`) after it has
// saved and announced the rules, so an open window still listening for the attempt sees them.
import { assertOdNextPlanningBuildOnlyV2, type StudioRule } from '@open-design/contracts';
import { failSuggestion, finishSuggestion, proposeWithLLM } from './memory-llm.js';
import { memoryEvents } from './memory.js';

const MAX_RULES = 3;
// The whole payload is sent as written, so each part has its own budget and the rules list, which
// the model must see to avoid repeating one, comes first.
const RULES_CAP = 4000;
const MESSAGE_CAP = 1500;
const ANNOTATIONS_CAP = 1500;
const REPLY_CAP = 1000;

/**
 * A cheap gate before any model call: words people use when telling a designer something is wrong,
 * in Chinese and English. A turn without them (and without annotations) is not a correction.
 */
const CORRECTION_CUES = /(不对|不是这样|不要|别再|别用|不该|不应该|应该|改成|改为|换成|太(?:大|小|多|少|亮|暗|挤|空|长|短|宽|窄|粗|细|花|乱|重|淡|密|松)|看不清|没对齐|不一致|不统一|不符合|错了|有误|难看|不好看|丑|wrong|incorrect|not right|isn'?t right|don'?t|do not|shouldn'?t|should(?:\s+(?:be|use|not|have))?|instead|too\s+(?:big|small|large|bright|dark|busy|tight|loose|wide|narrow|heavy|light|long)|not what i|doesn'?t match|missing|never use|always use)/i;

export interface CorrectionAnnotation { comment?: string; label?: string; currentText?: string }

export function looksLikeCorrection(message: string, annotations: CorrectionAnnotation[] = []): boolean {
  return CORRECTION_CUES.test(message) || annotations.some((annotation) => typeof annotation?.comment === 'string' && annotation.comment.trim().length >= 3);
}

function systemPrompt(title: string): string {
  return `You turn a designer's correction of an AI design assistant into standing rules for the design system "${title}".

You get the user's latest message (possibly with inline annotations on a generated artifact), the assistant's reply, and the rules the system already has.

First decide whether the user is pointing out that something the assistant made is wrong in a way that should hold for FUTURE screens built with this design system: a visual, layout, component, wording or interaction preference. A one-off content edit ("change this title to Pricing"), a request for something new, or praise is NOT a rule: return no entries.

For each real lesson write one rule:
- one short imperative sentence a designer could follow, in the user's language;
- the reason in one short sentence, taken from what the user said or clearly implied (leave it empty rather than invent one);
- what the assistant had done wrong, in a few words.
Keep at most ${MAX_RULES} rules. Do not repeat or rephrase an existing rule. Do not mention screenshots, browsers, checklists or verification steps: rules describe how the design should be, not how to check it.

Output STRICT JSON in this exact shape — nothing else, no prose, no markdown fences:
{
  "entries": [
    { "type": "rule", "name": "<the rule>", "description": "<the reason>", "body": "Assertion: <the rule>\\nRationale: <the reason>\\nContext: <what the assistant did wrong>" }
  ]
}

If there is no lasting lesson, return: {"entries": []}`;
}

function payload(input: DistillCorrectionInput): string {
  const clip = (text: string, max: number) => text.length > max ? text.slice(0, max - 1) + '…' : text;
  const rules = input.existingRules.map((rule) => '- ' + rule.rule.replace(/\s+/g, ' ').trim()).filter((line) => line.length > 2);
  const parts = ['Rules the design system already has (do not repeat or rephrase these):', rules.length ? clip(rules.join('\n'), RULES_CAP) : '(none)'];
  parts.push('', 'The user\'s latest message:', clip(input.userMessage.trim(), MESSAGE_CAP));
  const annotations = (input.annotations ?? []).filter((annotation) => typeof annotation?.comment === 'string' && annotation.comment.trim());
  if (annotations.length) {
    const lines = annotations.slice(0, 12).map((annotation, index) => `${index + 1}. ${String(annotation.comment).trim().slice(0, 300)}${annotation.label ? ` (on: ${String(annotation.label).trim().slice(0, 80)})` : ''}${annotation.currentText ? ` [current: "${String(annotation.currentText).trim().slice(0, 120)}"]` : ''}`);
    parts.push('', 'Inline annotations the user left on the artifact:', clip(lines.join('\n'), ANNOTATIONS_CAP));
  }
  const reply = String(input.assistantMessage ?? '').trim();
  if (reply) parts.push('', 'The assistant\'s reply to it:', clip(reply, REPLY_CAP));
  parts.push('', 'Return ONLY the JSON object described in the system prompt.');
  return parts.join('\n');
}

function field(body: string, label: string): string {
  const match = new RegExp('^\\s*' + label + ':\\s*(.*)$', 'im').exec(body);
  return (match?.[1] ?? '').trim();
}
const oneLine = (text: string, max: number) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1).trim() + '…' : value;
};

export interface DistillCorrectionInput {
  userMessage: string;
  assistantMessage?: string;
  annotations?: CorrectionAnnotation[];
  designSystemTitle: string;
  existingRules: Pick<StudioRule, 'rule'>[];
}
export interface CorrectionRuleDraft { rule: string; reason: string; context: string }
export interface DistillCorrectionOptions {
  projectRoot?: string | null;
  chatAgentId?: string | null;
  chatModel?: string | null;
  chatProvider?: unknown;
  extractionOrigin?: unknown;
  /** Test seam: a fake model call. */
  propose?: typeof proposeWithLLM;
}

/**
 * The rules a turn teaches the design system, or none. Rules that would trip the OD Next build-only
 * guard (DESIGN.md is an instruction block there) are dropped rather than written.
 */
export async function distillDesignSystemCorrection(dataDir: string, input: DistillCorrectionInput, options: DistillCorrectionOptions = {}): Promise<{ drafts: CorrectionRuleDraft[]; attemptId: string | null }> {
  const message = String(input.userMessage ?? '').trim();
  if (!message || !looksLikeCorrection(message, input.annotations)) return { drafts: [], attemptId: null };
  const propose = options.propose ?? proposeWithLLM;
  const title = oneLine(input.designSystemTitle, 80) || 'this design system';
  const { attemptId, suggestions } = await propose(dataDir, { userMessage: payload({ ...input, userMessage: message }), assistantMessage: '' }, {
    projectRoot: options.projectRoot ?? null,
    chatAgentId: options.chatAgentId ?? null,
    chatModel: options.chatModel ?? null,
    chatProvider: options.chatProvider ?? null,
    extractionOrigin: options.extractionOrigin,
    kind: 'design-system',
    systemPrompt: systemPrompt(title),
    candidateFilter: (candidate: { type?: string }) => candidate?.type === 'rule',
  });
  if (!Array.isArray(suggestions)) return { drafts: [], attemptId };
  const drafts: CorrectionRuleDraft[] = [];
  for (const suggestion of suggestions as { name?: string; description?: string; body?: string }[]) {
    const body = String(suggestion?.body ?? '');
    const rule = oneLine(field(body, 'Assertion') || suggestion?.name || '', 240);
    if (rule.length < 3) continue;
    const reason = oneLine(field(body, 'Rationale') || suggestion?.description || '', 240);
    const context = oneLine(field(body, 'Context'), 160);
    try { assertOdNextPlanningBuildOnlyV2('- ' + rule + (reason ? ' Why: ' + reason : ''), 'design-system rule'); }
    catch { continue; }
    drafts.push({ rule, reason, context });
    if (drafts.length >= MAX_RULES) break;
  }
  return { drafts, attemptId };
}

// The close hook fires again for every retry or re-fed attempt of one turn. One distillation per
// (conversation, message) is enough; a bounded set keeps the claim from growing without end.
const claimedTurns = new Set<string>();
export function claimCorrectionTurn(conversationId: string | null | undefined, message: string): boolean {
  const key = (conversationId ?? '') + '\0' + message.trim();
  if (claimedTurns.has(key)) return false;
  claimedTurns.add(key);
  if (claimedTurns.size > 200) claimedTurns.delete(claimedTurns.values().next().value as string);
  return true;
}
export function releaseCorrectionTurn(conversationId: string | null | undefined, message: string): void {
  claimedTurns.delete((conversationId ?? '') + '\0' + message.trim());
}
export function __resetCorrectionClaimsForTests(): void { claimedTurns.clear(); }

/** Tells open windows (the memory toast) that a correction became rules of a design system. */
export function announceDesignSystemRules(designSystemId: string, designSystemTitle: string, rules: Pick<StudioRule, 'rule'>[]): void {
  if (!rules.length) return;
  memoryEvents.emit('change', { kind: 'design-system-rule', source: 'correction', count: rules.length, designSystemId, designSystemTitle, rules: rules.map((rule) => rule.rule), at: Date.now() });
}

/** Closes the extraction attempt a distillation opened, recording the rules that were written. */
export function finishCorrection(attemptId: string | null, added: Pick<StudioRule, 'id'>[]): void {
  finishSuggestion(attemptId, added.map((rule) => rule.id));
}
/** Closes the attempt as failed when the rules it proposed could not be saved. */
export function failCorrection(attemptId: string | null, error: unknown): void {
  failSuggestion(attemptId, error);
}
