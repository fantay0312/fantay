import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createJsonEventStreamHandler } from '../../src/runtimes/json-event-stream.js';

const RECORDING = fileURLToPath(new URL('../fixtures/cursor-agent-stream/turn-all-tools.jsonl', import.meta.url));

type Event = Record<string, any>;

function parseRecording(): Event[] {
  const events: Event[] = [];
  const handler = createJsonEventStreamHandler('cursor-agent', (event) => events.push(event));
  handler.feed(readFileSync(RECORDING, 'utf8'));
  handler.flush();
  return events;
}

describe('cursor-agent stream: thinking and tools reach the execution record', () => {
  const events = parseRecording();
  const uses = events.filter((event) => event.type === 'tool_use');
  const results = events.filter((event) => event.type === 'tool_result');
  const resultOf = (id: string) => results.find((event) => event.toolUseId === id);

  it('leaves no thinking or tool line behind as an unrendered raw event', () => {
    const raw = events.filter((event) => event.type === 'raw');
    expect(raw.filter((event) => /"type":"(thinking|tool_call)"/.test(String(event.line)))).toEqual([]);
  });

  it('streams the reasoning text as one thinking block per wire block', () => {
    expect(events.filter((event) => event.type === 'thinking_start').length).toBeGreaterThan(0);
    const text = events.filter((event) => event.type === 'thinking_delta').map((event) => event.delta).join('');
    expect(text).toContain('todo list');
  });

  it('names every tool the way the web classifies it', () => {
    const names = new Set(uses.map((event) => event.name));
    for (const name of ['TodoWrite', 'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Delete']) {
      expect(names, name).toContain(name);
    }
  });

  it('never shows a schema fetch as work', () => {
    expect(uses.some((event) => /getmcp/i.test(event.name))).toBe(false);
  });

  it('keeps the todo statuses, ending with everything completed', () => {
    const snapshots = uses.filter((event) => event.name === 'TodoWrite');
    expect(snapshots[0]!.input.todos.map((todo: Event) => todo.status)).toContain('in_progress');
    const last = snapshots[snapshots.length - 1]!.input.todos;
    expect(last.length).toBeGreaterThan(0);
    expect(last.every((todo: Event) => todo.status === 'completed')).toBe(true);
  });

  it('announces an edit early and settles it with its line counts', () => {
    const early = events.filter((event) => event.type === 'tool_in_flight');
    expect(early.map((event) => event.name)).toContain('Edit');
    const created = uses.find((event) => event.name === 'Write')!;
    expect(created.input.file_path).toBe('/workspace/out.txt');
    expect(created.input.od_diff_stat).toEqual({ added: 1, removed: 0 });
    expect(created.input).not.toHaveProperty('content');
    const edited = uses.find((event) => event.name === 'Edit')!;
    expect(edited.input.od_diff_stat).toEqual({ added: 1, removed: 1 });
  });

  it('puts file copies nowhere in the transcript', () => {
    expect(JSON.stringify(events)).not.toContain('afterFullFileContent');
  });

  it('reports a failed read and a failed command with the reason', () => {
    const read = uses.find((event) => event.input.file_path === '/workspace/missing-file.txt')!;
    expect(resultOf(read.id)).toMatchObject({ isError: true, content: 'File not found' });
    const shell = uses.find((event) => event.input.command === 'ls /nonexistent-dir')!;
    expect(resultOf(shell.id)!.isError).toBe(true);
    expect(resultOf(shell.id)!.content).toContain('No such file or directory');
  });

  it('gives search rows one line per hit', () => {
    const grep = uses.find((event) => event.name === 'Grep' && event.input.pattern === 'world')!;
    expect(resultOf(grep.id)!.content.split('\n').filter(Boolean).length).toBe(2);
    const content = uses.find((event) => event.name === 'Grep' && event.input.pattern === 'hello')!;
    expect(resultOf(content.id)!.content).toBe('note.txt:1:hello');
    const glob = uses.find((event) => event.name === 'Glob')!;
    expect(glob.input.pattern).toBe('*.txt');
    expect(resultOf(glob.id)!.content.split('\n').length).toBe(2);
  });

  it('carries Cursor’s own timestamps, so a reloaded row keeps its time', () => {
    const read = uses.find((event) => event.name === 'Read')!;
    expect(read.startedAt).toBeGreaterThan(0);
    expect(resultOf(read.id)!.completedAt).toBeGreaterThan(read.startedAt);
  });

  it('still delivers the answer text exactly once per turn', () => {
    const text = events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join('');
    expect(text.match(/都做完了/g)?.length).toBe(1);
  });
});
