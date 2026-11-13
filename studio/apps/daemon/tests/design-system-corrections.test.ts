import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetCorrectionClaimsForTests,
  announceDesignSystemRules,
  claimCorrectionTurn,
  distillDesignSystemCorrection,
  finishCorrection,
  looksLikeCorrection,
} from '../src/design-system-corrections.js';
import { memoryEvents } from '../src/memory.js';

type ProposeFn = NonNullable<Parameters<typeof distillDesignSystemCorrection>[2]>['propose'];

interface FakeSuggestion { type: string; name: string; description: string; body: string }

const suggestion = (assertion: string, rationale = '', context = ''): FakeSuggestion => ({
  type: 'rule',
  name: assertion,
  description: rationale,
  body: `Assertion: ${assertion}\nRationale: ${rationale}\nContext: ${context}`,
});

function fakePropose(suggestions: FakeSuggestion[], attemptId: string | null = 'attempt-1') {
  return vi.fn(async () => ({ attemptId, suggestions })) as unknown as ReturnType<typeof vi.fn> & NonNullable<ProposeFn>;
}

const baseInput = {
  userMessage: '不对，按钮不要用渐变',
  designSystemTitle: 'Brand Kit',
  existingRules: [] as { rule: string }[],
};

describe('looksLikeCorrection', () => {
  it('reads Chinese corrections as corrections', () => {
    expect(looksLikeCorrection('不对，按钮不要用渐变')).toBe(true);
    expect(looksLikeCorrection('标题应该再大一点')).toBe(true);
    expect(looksLikeCorrection('这个颜色太暗了')).toBe(true);
  });

  it('reads English corrections as corrections', () => {
    expect(looksLikeCorrection('too busy, use one accent')).toBe(true);
    expect(looksLikeCorrection("don't use gradients on buttons")).toBe(true);
    expect(looksLikeCorrection('Use a solid fill instead')).toBe(true);
  });

  it('treats an annotation with a real comment as a correction even when the message has no cue', () => {
    expect(looksLikeCorrection('see my notes', [{ comment: 'Make the heading larger', label: 'h1' }])).toBe(true);
  });

  it('ignores annotations with an empty or too-short comment', () => {
    expect(looksLikeCorrection('see my notes', [{ comment: '' }, { comment: '  ' }, { comment: 'ok' }, { label: 'h1' }])).toBe(false);
  });

  it('does not treat a new request or praise as a correction', () => {
    expect(looksLikeCorrection('做一个定价页')).toBe(false);
    expect(looksLikeCorrection('looks great')).toBe(false);
  });
});

describe('distillDesignSystemCorrection', () => {
  it('returns no drafts and never calls the model when the message has no correction cue', async () => {
    const propose = fakePropose([suggestion('Use solid buttons')]);
    const result = await distillDesignSystemCorrection('/data', { ...baseInput, userMessage: '做一个定价页' }, { propose });
    expect(result).toEqual({ drafts: [], attemptId: null });
    expect(propose).not.toHaveBeenCalled();
  });

  it('returns no drafts without calling the model for an empty message', async () => {
    const propose = fakePropose([suggestion('Use solid buttons')]);
    const result = await distillDesignSystemCorrection('/data', { ...baseInput, userMessage: '   ' }, { propose });
    expect(result).toEqual({ drafts: [], attemptId: null });
    expect(propose).not.toHaveBeenCalled();
  });

  it('maps Assertion / Rationale / Context into rule / reason / context', async () => {
    const propose = fakePropose([suggestion('Use solid buttons, never gradients', 'Gradients look dated', 'A gradient was used on the CTA')]);
    const { drafts } = await distillDesignSystemCorrection('/data', baseInput, { propose });
    expect(drafts).toEqual([
      { rule: 'Use solid buttons, never gradients', reason: 'Gradients look dated', context: 'A gradient was used on the CTA' },
    ]);
  });

  it('falls back to name and description when the body carries no labelled lines', async () => {
    const propose = fakePropose([{ type: 'rule', name: 'Keep one accent colour', description: 'Too many colours feel busy', body: 'free text' }]);
    const { drafts } = await distillDesignSystemCorrection('/data', baseInput, { propose });
    expect(drafts).toEqual([{ rule: 'Keep one accent colour', reason: 'Too many colours feel busy', context: '' }]);
  });

  it('collapses whitespace inside each field', async () => {
    const propose = fakePropose([suggestion('Use   one\taccent   colour', 'Fewer   colours\t read calmer', 'Used   five  accents')]);
    const { drafts } = await distillDesignSystemCorrection('/data', baseInput, { propose });
    expect(drafts).toEqual([{ rule: 'Use one accent colour', reason: 'Fewer colours read calmer', context: 'Used five accents' }]);
  });

  it('skips a suggestion whose rule is shorter than three characters', async () => {
    const propose = fakePropose([suggestion('ab', 'too short'), suggestion('Use solid buttons', 'cleaner')]);
    const { drafts } = await distillDesignSystemCorrection('/data', baseInput, { propose });
    expect(drafts.map((draft) => draft.rule)).toEqual(['Use solid buttons']);
  });

  it('keeps at most three rules', async () => {
    const propose = fakePropose([1, 2, 3, 4, 5].map((n) => suggestion(`Rule number ${n}`, `Reason ${n}`)));
    const { drafts } = await distillDesignSystemCorrection('/data', baseInput, { propose });
    expect(drafts.map((draft) => draft.rule)).toEqual(['Rule number 1', 'Rule number 2', 'Rule number 3']);
  });

  it('drops a rule that mentions a checklist (OD Next build-only guard)', async () => {
    const propose = fakePropose([
      suggestion('Run a checklist before delivering the screen', 'Catches mistakes'),
      suggestion('Use solid buttons', 'Cleaner look'),
    ]);
    const { drafts } = await distillDesignSystemCorrection('/data', baseInput, { propose });
    expect(drafts.map((draft) => draft.rule)).toEqual(['Use solid buttons']);
  });

  it('drops a rule that tells the agent to take a screenshot and compare', async () => {
    const propose = fakePropose([
      suggestion('Take a screenshot and compare it with the mock', 'Spots drift'),
      suggestion('Keep card radius at 12px', 'Matches the brand'),
    ]);
    const { drafts } = await distillDesignSystemCorrection('/data', baseInput, { propose });
    expect(drafts.map((draft) => draft.rule)).toEqual(['Keep card radius at 12px']);
  });

  it('drops a rule whose reason trips the guard even when the instruction is clean', async () => {
    const propose = fakePropose([suggestion('Keep spacing on the 8px grid', 'See the verification checklist')]);
    const { drafts } = await distillDesignSystemCorrection('/data', baseInput, { propose });
    expect(drafts).toEqual([]);
  });

  it('does not count dropped rules against the cap of three', async () => {
    const propose = fakePropose([
      suggestion('Add a checklist step', 'bad'),
      suggestion('Rule A', 'a'),
      suggestion('Rule B', 'b'),
      suggestion('Rule C', 'c'),
      suggestion('Rule D', 'd'),
    ]);
    const { drafts } = await distillDesignSystemCorrection('/data', baseInput, { propose });
    expect(drafts.map((draft) => draft.rule)).toEqual(['Rule A', 'Rule B', 'Rule C']);
  });

  it("passes kind 'design-system' and the (whitespace-collapsed) title into the system prompt", async () => {
    const propose = fakePropose([]);
    await distillDesignSystemCorrection('/data/dir', { ...baseInput, designSystemTitle: '  Brand \n Kit  ' }, { propose, projectRoot: '/proj', chatAgentId: 'agent-x', chatModel: 'model-y' });
    expect(propose).toHaveBeenCalledTimes(1);
    const [dataDir, , options] = propose.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(dataDir).toBe('/data/dir');
    expect(options.kind).toBe('design-system');
    expect(options.systemPrompt).toContain('the design system "Brand Kit"');
    expect(options.projectRoot).toBe('/proj');
    expect(options.chatAgentId).toBe('agent-x');
    expect(options.chatModel).toBe('model-y');
  });

  it('falls back to a generic title when the design system has none', async () => {
    const propose = fakePropose([]);
    await distillDesignSystemCorrection('/data', { ...baseInput, designSystemTitle: '   ' }, { propose });
    const options = (propose.mock.calls[0] as unknown[])[2] as Record<string, any>;
    expect(options.systemPrompt).toContain('"this design system"');
  });

  it('only accepts rule-typed candidates from the model', async () => {
    const propose = fakePropose([]);
    await distillDesignSystemCorrection('/data', baseInput, { propose });
    const options = (propose.mock.calls[0] as unknown[])[2] as { candidateFilter: (candidate: { type?: string }) => boolean };
    expect(options.candidateFilter({ type: 'rule' })).toBe(true);
    expect(options.candidateFilter({ type: 'user' })).toBe(false);
    expect(options.candidateFilter({})).toBe(false);
  });

  it('sends the message, annotations, assistant reply and existing rules to the model', async () => {
    const propose = fakePropose([]);
    await distillDesignSystemCorrection('/data', {
      userMessage: 'The cards are wrong, they should be flat',
      assistantMessage: 'I added drop shadows to every card.',
      annotations: [{ comment: 'No shadow here', label: 'card-1', currentText: 'Pricing' }, { comment: '   ' }],
      designSystemTitle: 'Brand Kit',
      existingRules: [{ rule: 'Use 8px spacing' }],
    }, { propose });
    const input = (propose.mock.calls[0] as unknown[])[1] as { userMessage: string; assistantMessage: string };
    expect(input.assistantMessage).toBe('');
    expect(input.userMessage).toContain('The cards are wrong, they should be flat');
    expect(input.userMessage).toContain('1. No shadow here (on: card-1) [current: "Pricing"]');
    expect(input.userMessage).not.toContain('2. ');
    expect(input.userMessage).toContain('I added drop shadows to every card.');
    expect(input.userMessage).toContain('- Use 8px spacing');
  });

  it('lists "(none)" when the system has no rules yet', async () => {
    const propose = fakePropose([]);
    await distillDesignSystemCorrection('/data', baseInput, { propose });
    const input = (propose.mock.calls[0] as unknown[])[1] as { userMessage: string };
    expect(input.userMessage).toContain('(none)');
  });

  it('returns the attemptId the model call opened, with or without drafts', async () => {
    const withRules = await distillDesignSystemCorrection('/data', baseInput, { propose: fakePropose([suggestion('Use solid buttons', 'cleaner')], 'attempt-42') });
    expect(withRules.attemptId).toBe('attempt-42');
    const without = await distillDesignSystemCorrection('/data', baseInput, { propose: fakePropose([], 'attempt-43') });
    expect(without).toEqual({ drafts: [], attemptId: 'attempt-43' });
  });

  it('returns no drafts when the model call yields no attempt (no provider or failure)', async () => {
    const result = await distillDesignSystemCorrection('/data', baseInput, { propose: fakePropose([], null) });
    expect(result).toEqual({ drafts: [], attemptId: null });
  });

  it('treats a non-array suggestions value as no drafts but keeps the attemptId', async () => {
    const propose = vi.fn(async () => ({ attemptId: 'attempt-7', suggestions: null })) as unknown as NonNullable<ProposeFn>;
    const result = await distillDesignSystemCorrection('/data', baseInput, { propose });
    expect(result).toEqual({ drafts: [], attemptId: 'attempt-7' });
  });
});

describe('claimCorrectionTurn', () => {
  beforeEach(() => __resetCorrectionClaimsForTests());
  afterEach(() => __resetCorrectionClaimsForTests());

  it('returns true once and false for the same conversation and message afterwards', () => {
    expect(claimCorrectionTurn('conv-1', '不对，按钮不要用渐变')).toBe(true);
    expect(claimCorrectionTurn('conv-1', '不对，按钮不要用渐变')).toBe(false);
    expect(claimCorrectionTurn('conv-1', '不对，按钮不要用渐变')).toBe(false);
  });

  it('ignores surrounding whitespace in the message', () => {
    expect(claimCorrectionTurn('conv-1', 'too busy')).toBe(true);
    expect(claimCorrectionTurn('conv-1', '  too busy \n')).toBe(false);
  });

  it('claims separately per conversation and per message', () => {
    expect(claimCorrectionTurn('conv-1', 'too busy')).toBe(true);
    expect(claimCorrectionTurn('conv-2', 'too busy')).toBe(true);
    expect(claimCorrectionTurn('conv-1', 'too small')).toBe(true);
  });

  it('accepts a missing conversation id', () => {
    expect(claimCorrectionTurn(null, 'too busy')).toBe(true);
    expect(claimCorrectionTurn(undefined, 'too busy')).toBe(false);
  });

  it('can be reset for tests', () => {
    expect(claimCorrectionTurn('conv-1', 'too busy')).toBe(true);
    __resetCorrectionClaimsForTests();
    expect(claimCorrectionTurn('conv-1', 'too busy')).toBe(true);
  });

  it('stays bounded: an old claim is forgotten once more than 200 turns are claimed', () => {
    expect(claimCorrectionTurn('conv-old', 'first')).toBe(true);
    for (let index = 0; index < 200; index += 1) claimCorrectionTurn('conv-fill', `message ${index}`);
    expect(claimCorrectionTurn('conv-old', 'first')).toBe(true);
  });
});

describe('announceDesignSystemRules', () => {
  const events: Record<string, any>[] = [];
  const listener = (event: Record<string, any>) => { events.push(event); };
  beforeEach(() => { events.length = 0; memoryEvents.on('change', listener); });
  afterEach(() => { memoryEvents.off('change', listener); });

  it("emits one 'change' event with kind, count, ids and the rule texts", () => {
    const before = Date.now();
    announceDesignSystemRules('user:brand-kit', 'Brand Kit', [{ rule: 'Use solid buttons' }, { rule: 'Keep one accent colour' }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'design-system-rule',
      source: 'correction',
      count: 2,
      designSystemId: 'user:brand-kit',
      designSystemTitle: 'Brand Kit',
      rules: ['Use solid buttons', 'Keep one accent colour'],
    });
    expect(typeof events[0]!.at).toBe('number');
    expect(events[0]!.at).toBeGreaterThanOrEqual(before);
  });

  it('emits nothing for an empty rule list', () => {
    announceDesignSystemRules('user:brand-kit', 'Brand Kit', []);
    expect(events).toHaveLength(0);
  });
});

describe('finishCorrection', () => {
  it('is a no-op without an attempt id', () => {
    expect(() => finishCorrection(null, [{ id: 'rule-1' }])).not.toThrow();
  });
});
