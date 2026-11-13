import { expect, it } from 'vitest';
import { createJsonEventStreamHandler } from '../../src/runtimes/json-event-stream.js';

it('streams root reasoning and text once, including events before step_start and native completion records', () => {
  const events: Record<string, unknown>[] = [];
  const parser = createJsonEventStreamHandler('opencode', event => events.push(event));
  const feed = (value: object) => parser.feed(JSON.stringify(value) + '\n');
  const delta = (extra: object) => feed({ type: 'od_opencode_delta', version: 1, sessionID: 'root', partID: 'thought', kind: 'reasoning', offset: 0, delta: 'First ', ...extra });
  delta({}); delta({ sessionID: 'child', delta: 'private child output' });
  feed({ type: 'step_start', sessionID: 'root' });
  delta({ offset: 6, delta: 'thought.' }); delta({ offset: 6, delta: 'thought.' });
  delta({ partID: 'text', kind: 'text', delta: 'First ' });
  delta({ partID: 'text', kind: 'text', offset: 6, delta: 'answer.' });
  feed({ type: 'text', sessionID: 'root', part: { id: 'text', text: 'First answer.' } });
  feed({ type: 'reasoning', sessionID: 'root', part: { id: 'thought', text: 'First thought.' } });
  feed({ type: 'step_finish', sessionID: 'root', part: {} }); parser.flush();
  expect(events.filter(event => event.type === 'thinking_delta').map(event => event.delta).join('')).toBe('First thought.');
  expect(events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe('First answer.');
  expect(events.filter(event => event.type === 'thinking_start')).toHaveLength(1);
  expect(events.filter(event => event.type === 'thinking_end')).toHaveLength(1);
});

function opencodeStream() {
  const events: Record<string, unknown>[] = [];
  const parser = createJsonEventStreamHandler('opencode', event => events.push(event));
  const feed = (value: object) => parser.feed(JSON.stringify(value) + '\n');
  const reasoning = (offset: number, delta: string) => feed({ type: 'od_opencode_delta', version: 1, sessionID: 'root', partID: 'thought', kind: 'reasoning', offset, delta });
  const thinking = () => events.filter(event => event.type === 'thinking_delta').map(event => event.delta).join('');
  const count = (type: string) => events.filter(event => event.type === type).length;
  return { events, parser, feed, reasoning, thinking, count };
}

// `run --thinking` adds a native `reasoning` record per completed part next to
// the plugin's live deltas for the same part id.
it('a native reasoning record never repeats what plugin deltas already streamed, in either order', () => {
  const { feed, reasoning, thinking, count, parser } = opencodeStream();
  feed({ type: 'step_start', sessionID: 'root' });
  reasoning(0, 'Plan the ');
  // The CLI writer can flush the completed record before the plugin's last frame.
  feed({ type: 'reasoning', sessionID: 'root', part: { id: 'thought', type: 'reasoning', text: 'Plan the layout.', time: { start: 1, end: 2 } } });
  reasoning(9, 'layout.');
  feed({ type: 'text', sessionID: 'root', part: { id: 'answer', type: 'text', text: 'Done.' } });
  feed({ type: 'step_finish', sessionID: 'root', part: {} }); parser.flush();
  expect(thinking()).toBe('Plan the layout.');
  expect(count('thinking_start')).toBe(1);
  expect(count('thinking_end')).toBe(1);
});

it('without the live plugin, --thinking still yields one complete thinking block before the answer', () => {
  const { events, feed, thinking, parser } = opencodeStream();
  feed({ type: 'step_start', sessionID: 'root' });
  feed({ type: 'reasoning', sessionID: 'root', part: { id: 'thought', type: 'reasoning', text: 'Read the brief first.' } });
  feed({ type: 'text', sessionID: 'root', part: { id: 'answer', type: 'text', text: 'Here it is.' } });
  feed({ type: 'step_finish', sessionID: 'root', part: {} }); parser.flush();
  expect(thinking()).toBe('Read the brief first.');
  expect(events.map(event => event.type).filter(type => type !== 'status')).toEqual(['thinking_start', 'thinking_delta', 'thinking_end', 'text_delta']);
});

it('an offset gap stops live frames for that part and the completed record backfills the exact tail', () => {
  const { feed, reasoning, thinking, count } = opencodeStream();
  feed({ type: 'step_start', sessionID: 'root' });
  reasoning(0, 'Check ');
  // 'the ' (offset 6) was lost; every later frame is past the gap.
  reasoning(10, 'grid, ');
  reasoning(16, 'then type.');
  expect(thinking()).toBe('Check ');
  feed({ type: 'reasoning', sessionID: 'root', part: { id: 'thought', text: 'Check the grid, then type.' } });
  expect(thinking()).toBe('Check the grid, then type.');
  expect(count('thinking_start')).toBe(1);
});

it('reasoning that carries no visible text opens no thinking block', () => {
  const { feed, reasoning, count, parser } = opencodeStream();
  feed({ type: 'step_start', sessionID: 'root' });
  reasoning(0, '\n\n');
  feed({ type: 'reasoning', sessionID: 'root', part: { id: 'thought', text: '\n\n' } });
  feed({ type: 'reasoning', sessionID: 'root', part: { id: 'redacted', text: '' } });
  feed({ type: 'text', sessionID: 'root', part: { id: 'answer', text: 'Hi.' } });
  parser.flush();
  expect(count('thinking_start')).toBe(0);
  expect(count('thinking_delta')).toBe(0);
  expect(count('thinking_end')).toBe(0);
  expect(count('text_delta')).toBe(1);
});

it('retains a final CLI suffix if only a prefix was observed live', () => {
  const events: Record<string, unknown>[] = [];
  const parser = createJsonEventStreamHandler('opencode', event => events.push(event));
  for (const event of [
    { type: 'step_start', sessionID: 'root' },
    { type: 'od_opencode_delta', version: 1, sessionID: 'root', partID: 'text', kind: 'text', offset: 0, delta: 'Hello' },
    { type: 'text', sessionID: 'root', part: { id: 'text', text: 'Hello world' } },
  ]) parser.feed(JSON.stringify(event) + '\n');
  expect(events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe('Hello world');
});
