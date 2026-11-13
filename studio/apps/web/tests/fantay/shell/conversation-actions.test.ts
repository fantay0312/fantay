import { expect, it } from 'vitest';
import { conversationShareHtml, visibleTranscript } from '../../../src/fantay/shell/sidebar/conversation-actions';

it('copies only visible user and assistant text, excluding internal events', () => {
  const text = visibleTranscript([
    { id: 'u', role: 'user', content: 'Question' },
    { id: 'a', role: 'assistant', content: 'Answer', events: [{ kind: 'thinking', text: 'internal' }] },
  ], { user: 'You', assistant: 'Assistant', designSystem: 'Design system' });
  expect(text).toBe('## You\n\nQuestion\n\n## Assistant\n\nAnswer');
  expect(text).not.toContain('internal');
});
it('escapes both the title and conversation in the public snapshot', () => {
  const html = conversationShareHtml('<script>title</script>', '</pre><script>alert(1)</script>');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;/pre&gt;&lt;script&gt;');
});
