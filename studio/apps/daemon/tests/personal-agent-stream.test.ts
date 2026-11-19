import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => ({ path: '' }));
vi.mock('../src/agents.js', async (original) => ({
  ...await original<typeof import('../src/agents.js')>(),
  getAgentDef: () => ({ id: 'claude' }),
  resolveAgentLaunch: () => ({ launchPath: launch.path, selectedPath: launch.path, childPathPrepend: [] }),
}));
vi.mock('../src/app-config.js', async (original) => ({
  ...await original<typeof import('../src/app-config.js')>(),
  readAppConfig: async () => ({}),
}));

import { createPaModelRuntime, type PaDeltaSink } from '../src/runtimes/personal-agent.js';
import {
  createPaClaudeStreamReader,
  createPaLineReader,
  readPaOllamaStream,
  readPaSseText,
} from '../src/runtimes/personal-agent-stream.js';

type Delta = [string, { reset?: boolean } | undefined];
const recording = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/claude-cli-recordings/${name}`, import.meta.url)));
const collect = (): { deltas: Delta[]; sink: PaDeltaSink } => {
  const deltas: Delta[] = [];
  return { deltas, sink: (chunk, meta) => { deltas.push([chunk, meta]); } };
};
/** What a live buffer holds after these deltas: a reset starts the text again. */
const applied = (deltas: Delta[]) => deltas.reduce((text, [chunk, meta]) => (meta?.reset ? chunk : text + chunk), '');
const chunked = (bytes: Buffer, size: number): Buffer[] =>
  Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => bytes.subarray(index * size, (index + 1) * size));
/** A response whose body yields these chunks; `cancelled` turns true when the reader cancels it. */
function body(chunks: Array<string | Uint8Array>): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  const queue = chunks.map((chunk) => (typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk));
  let cancelled = false;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = queue.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel() { cancelled = true; },
    }),
    cancelled: () => cancelled,
  };
}
function claude(bytes: Buffer, size?: number) {
  const { deltas, sink } = collect();
  const reader = createPaClaudeStreamReader(sink);
  for (const piece of size ? chunked(bytes, size) : [bytes]) reader.push(piece);
  reader.end();
  return { deltas, result: reader.result(), bytes: reader.bytes() };
}

describe('Claude stream-json reader over the 2.1.259 recordings', () => {
  for (const size of [undefined, 7]) {
    const label = size ? ' in 7-byte chunks' : '';
    it(`reads the single-turn recording${label}`, () => {
      const file = recording('claude-2.1.259-partial-single-turn.jsonl');
      const { deltas, result, bytes } = claude(file, size);
      expect(deltas).toEqual([['DONE1', undefined]]);
      expect(result?.result).toBe('DONE1');
      expect(result).toMatchObject({ type: 'result', is_error: false });
      expect(bytes).toBe(file.length);
    });

    it(`reports only text deltas of the two-turn recording and keeps its last result${label}`, () => {
      const { deltas, result } = claude(recording('claude-2.1.259-partial-two-turns.jsonl'), size);
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.every(([chunk]) => typeof chunk === 'string' && chunk.length > 0)).toBe(true);
      // The second turn starts a new message after text was shown: the buffer starts again.
      expect(deltas.filter(([, meta]) => meta?.reset)).toHaveLength(1);
      expect(applied(deltas)).toBe(result?.result);
      expect(String(result?.result)).toContain('<h1>Beta</h1>');
    });

    it(`reports nothing without partial messages but keeps the result${label}`, () => {
      const { deltas, result } = claude(recording('claude-2.1.259-no-partial-messages.jsonl'), size);
      expect(deltas).toEqual([]);
      expect(result?.result).toBe('DONE');
    });

    it(`ignores forwarded sub-agent frames${label}`, () => {
      const { deltas, result } = claude(recording('claude-2.1.259-partial-forwarded-subagent.jsonl'), size);
      expect(deltas).toEqual([['PARENTDONE', undefined]]);
      expect(result?.result).toBe('PARENTDONE');
    });
  }

  it('refuses a text delta that carries a parent_tool_use_id and ignores broken lines', () => {
    const text = recording('claude-2.1.259-partial-single-turn.jsonl').toString('utf8');
    const line = text.split('\n').find((item) => item.includes('"text_delta"'))!;
    const child = JSON.stringify({ ...JSON.parse(line), parent_tool_use_id: 'toolu_child' });
    const { deltas, sink } = collect();
    const reader = createPaClaudeStreamReader(sink);
    reader.push(`${child}\n{not json\n${line}\n`);
    reader.end();
    expect(deltas).toEqual([['DONE1', undefined]]);
    expect(reader.result()).toBeNull();
  });

  it('survives a sink that throws', () => {
    const reader = createPaClaudeStreamReader(() => { throw new Error('boom'); });
    expect(() => reader.push(recording('claude-2.1.259-partial-single-turn.jsonl'))).not.toThrow();
    reader.end();
    expect(reader.result()?.result).toBe('DONE1');
  });
});

/** A stand-in `claude` binary: `--help` prints the given help text; a run replays a recording (stream-json) or its
 *  result frame (json), 64 bytes per write, and saves its argv. */
function fakeClaude(dir: string, options: { partial: boolean; recording: string; dropResult?: boolean }) {
  const launchPath = path.join(dir, 'claude');
  const argsFile = path.join(dir, 'args.json');
  const help = options.partial
    ? 'Usage: claude [options]\n  --output-format <format>  "text", "json", or "stream-json"\n  --include-partial-messages  emit partial message chunks\n'
    : 'Usage: claude [options]\n  --output-format <format>  "text" or "json"\n';
  const source = fileURLToPath(new URL(`./fixtures/claude-cli-recordings/${options.recording}`, import.meta.url));
  writeFileSync(launchPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { process.stdout.write(${JSON.stringify(help)}); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
process.stdin.resume();
process.stdin.on('end', () => {
  const frames = fs.readFileSync(${JSON.stringify(source)}, 'utf8').split('\\n').filter(Boolean);
  const streaming = args[args.indexOf('--output-format') + 1] === 'stream-json';
  const out = streaming
    ? frames.filter((line) => !${options.dropResult === true} || JSON.parse(line).type !== 'result').join('\\n') + '\\n'
    : JSON.stringify(frames.map((line) => JSON.parse(line)).filter((frame) => frame.type === 'result').at(-1));
  const bytes = Buffer.from(out, 'utf8');
  let at = 0;
  const next = () => { if (at < bytes.length) process.stdout.write(bytes.subarray(at, at += 64), next); };
  next();
});
`, { mode: 0o755 });
  launch.path = launchPath;
  return { args: () => JSON.parse(readFileSync(argsFile, 'utf8')) as string[] };
}

describe('Claude runtime: stream-json only where partial messages are supported', () => {
  let dir: string;
  let runs = 0;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'pa-stream-cli-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const run = (onDelta?: PaDeltaSink) => createPaModelRuntime(dir)
    .execute({ runtime: 'claude', modelId: 'sonnet' }, '你好', `run-${(runs += 1)}`, new AbortController().signal, onDelta ? { onDelta } : undefined);
  const format = (args: string[]) => args[args.indexOf('--output-format') + 1];

  it('streams the recording and resolves exactly what JSON mode resolves', async () => {
    const cli = fakeClaude(dir, { partial: true, recording: 'claude-2.1.259-partial-single-turn.jsonl' });
    const plain = await run();
    expect(format(cli.args())).toBe('json');
    expect(cli.args()).not.toContain('--include-partial-messages');
    const { deltas, sink } = collect();
    const streamed = await run(sink);
    expect(format(cli.args())).toBe('stream-json');
    expect(cli.args()).toEqual(expect.arrayContaining(['--verbose', '--include-partial-messages']));
    expect(deltas).toEqual([['DONE1', undefined]]);
    expect(plain.text).toBe('DONE1');
    expect(streamed).toEqual(plain);
  });

  it('keeps JSON mode and reports nothing when the CLI has no partial messages', async () => {
    const cli = fakeClaude(dir, { partial: false, recording: 'claude-2.1.259-partial-single-turn.jsonl' });
    const { deltas, sink } = collect();
    await expect(run(sink)).resolves.toMatchObject({ text: 'DONE1' });
    expect(format(cli.args())).toBe('json');
    expect(deltas).toEqual([]);
  });

  it('fails a stream without a result frame with the JSON mode error', async () => {
    fakeClaude(dir, { partial: true, recording: 'claude-2.1.259-partial-single-turn.jsonl', dropResult: true });
    const { deltas, sink } = collect();
    await expect(run(sink)).rejects.toMatchObject({ status: 503, code: 'PA_MODEL_UNAVAILABLE' });
    expect(deltas).toEqual([['DONE1', undefined]]);
  });
});

describe('line reader', () => {
  it('keeps multi-byte characters whole across chunks and flushes the last line at the end', () => {
    const lines: string[] = [];
    const reader = createPaLineReader((line) => lines.push(line));
    const bytes = Buffer.from('第一行\r\n第二行🙂\n最后', 'utf8');
    for (const piece of chunked(bytes, 1)) reader.push(piece);
    expect(lines).toEqual(['第一行', '第二行🙂']);
    reader.end();
    expect(lines).toEqual(['第一行', '第二行🙂', '最后']);
    expect(reader.bytes()).toBe(bytes.length);
  });

  it('drops a line longer than 4 MiB and keeps the next one', () => {
    const lines: string[] = [];
    const reader = createPaLineReader((line) => lines.push(line));
    reader.push('短\n');
    reader.push('x'.repeat(3 * 1024 * 1024));
    reader.push('x'.repeat(1024 * 1024 + 1));
    reader.push('也丢掉\n还在\n尾');
    reader.end();
    expect(lines).toEqual(['短', '还在', '尾']);
  });
});

describe('Ollama NDJSON reader', () => {
  const ndjson = (...frames: unknown[]) => frames.map((frame) => `${JSON.stringify(frame)}\n`).join('');

  it('appends content lines, reports each one and takes token counts from the done line', async () => {
    const text = ndjson(
      { message: { content: '你好' }, done: false },
      { message: { content: '，在' }, done: false },
      { message: { content: '呢' }, done: false },
      { message: { content: '' }, done: true, prompt_eval_count: 12, eval_count: 3 },
    );
    const { deltas, sink } = collect();
    const response = body(chunked(Buffer.from(text, 'utf8'), 5));
    await expect(readPaOllamaStream(response, sink, 1024)).resolves.toEqual({ text: '你好，在呢', inputTokens: 12, outputTokens: 3 });
    expect(deltas).toEqual([['你好', undefined], ['，在', undefined], ['呢', undefined]]);
  });

  it('fails on an error line, an unparsable line and an end without done', async () => {
    const { sink } = collect();
    const unavailable = { status: 503, code: 'PA_MODEL_UNAVAILABLE' };
    await expect(readPaOllamaStream(body([ndjson({ message: { content: '你' } }, { error: 'model crashed' })]), sink, 1024))
      .rejects.toMatchObject(unavailable);
    await expect(readPaOllamaStream(body([`${ndjson({ message: { content: '你' } })}{broken\n`]), sink, 1024))
      .rejects.toMatchObject(unavailable);
    await expect(readPaOllamaStream(body([ndjson({ message: { content: '你' } }, { message: { content: '好' } })]), sink, 1024))
      .rejects.toMatchObject(unavailable);
  });

  it('cancels the body and answers 413 past the byte cap', async () => {
    const response = body([ndjson({ message: { content: 'x'.repeat(40) } }), ndjson({ message: { content: 'y'.repeat(40) } })]);
    await expect(readPaOllamaStream(response, () => undefined, 64)).rejects.toMatchObject({ status: 413, code: 'PA_INVALID_OUTPUT' });
    expect(response.cancelled()).toBe(true);
  });

  it('returns the same result when the sink throws', async () => {
    const text = ndjson({ message: { content: '好' } }, { done: true, prompt_eval_count: 1, eval_count: 1 });
    await expect(readPaOllamaStream(body([text]), () => { throw new Error('boom'); }, 1024))
      .resolves.toEqual({ text: '好', inputTokens: 1, outputTokens: 1 });
  });
});

describe('SSE reader', () => {
  const sse = (...frames: Array<unknown | string>) =>
    frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');

  it('reports chat-completion deltas and returns the body bytes unchanged', async () => {
    const text = `: keep-alive\n${sse(
      { choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: '晚上' } }] },
      '{broken',
      { choices: [{ delta: { content: '好🙂' } }] },
      '[DONE]',
    )}`;
    const bytes = Buffer.from(text, 'utf8');
    const { deltas, sink } = collect();
    await expect(readPaSseText(body(chunked(bytes, 3)), '/v1/chat/completions', sink, 4096)).resolves.toBe(bytes.toString('utf8'));
    expect(deltas).toEqual([['晚上', undefined], ['好🙂', undefined]]);
  });

  it('reports Messages text deltas only', async () => {
    const text = sse(
      { type: 'message_start', message: { id: 'msg_1' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一想' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你来' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '了。' } },
      { type: 'message_stop' },
    );
    const { deltas, sink } = collect();
    await expect(readPaSseText(body([text]), '/v1/messages', sink, 4096)).resolves.toBe(text);
    expect(deltas).toEqual([['你来', undefined], ['了。', undefined]]);
  });

  it('cancels the body and answers 413 past the byte cap; a throwing sink changes nothing', async () => {
    const response = body([sse({ choices: [{ delta: { content: 'x'.repeat(60) } }] }), sse('[DONE]')]);
    await expect(readPaSseText(response, '/v1/chat/completions', () => undefined, 64))
      .rejects.toMatchObject({ status: 413, code: 'PA_INVALID_OUTPUT' });
    expect(response.cancelled()).toBe(true);
    const text = sse({ choices: [{ delta: { content: '好' } }] }, '[DONE]');
    await expect(readPaSseText(body([text]), '/v1/chat/completions', () => { throw new Error('boom'); }, 4096)).resolves.toBe(text);
  });
});
