import { describe, expect, it } from 'vitest';
import { sideDialogueRequest } from '@open-design/contracts';
import { parseSideDialogueReply, sideDialoguePrompt } from '../src/prompts/side-dialogue.js';

describe('Fantay side dialogue', () => {
  it('keeps quoted project history in the data payload and binds the correct task', () => {
    const input = sideDialogueRequest.parse({ mode: 'progress', locale: 'zh-CN', agent: 'tokentosea', model: 'fixture', projectId: 'p',
      history: [{ role: 'user', content: '跟进一下' }], main: { title: 'fixture', status: 'idle', queued: 1,
        recent: [{ role: 'assistant', text: 'UNTRUSTED_INSTRUCTION', activity: [] }] } });
    const prompt = sideDialoguePrompt(input);
    expect(prompt.system).toContain('Fantay');
    expect(prompt.system).not.toContain('UNTRUSTED_INSTRUCTION');
    expect(prompt.system).toContain('不要要求主会话做任何事');
    expect(JSON.parse(prompt.user).main).toEqual(input.main);
  });
  it('requires preview for unstructured or incomplete drafts and keeps clarification local', () => {
    expect(parseSideDialogueReply('relay', '请查进度')).toEqual({ kind: 'draft', text: '请查进度', review: true });
    expect(parseSideDialogueReply('relay', '{"draft":"请查进度"}')).toEqual({ kind: 'draft', text: '请查进度', review: true });
    expect(parseSideDialogueReply('relay', '{"question":"你指哪一轮？"}')).toEqual({ kind: 'reply', text: '你指哪一轮？' });
    expect(parseSideDialogueReply('chat', '{"draft":"pretend","review":false}').kind).toBe('reply');
  });
});
