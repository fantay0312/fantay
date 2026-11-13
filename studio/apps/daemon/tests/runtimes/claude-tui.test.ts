import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeTuiPaste, ClaudeTuiTranscript, spawnClaudeTuiProcess } from '../../src/runtimes/claude-tui.js';
import { withClaudeExecutionMode } from '../../src/runtimes/claude-mode.js';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
import { agentProcessRecordPath } from '../../src/runtimes/agent-process.js';
import { encodeStreamJsonUserMessage } from '../../src/runtimes/run-steering.js';
import { readAppConfig, writeAppConfig } from '../../src/app-config.js';

const temporary: string[] = [];
const children: Array<{ kill: () => unknown }> = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantay-claude-tui-'));
  temporary.push(dir); return dir;
}

describe('Claude execution mode', () => {
  it('keeps print unchanged and creates an isolated native definition by default', () => {
    expect(withClaudeExecutionMode(claudeAgentDef, 'print')).toBe(claudeAgentDef);
    const native = withClaudeExecutionMode(claudeAgentDef, undefined);
    expect(native.processTransport).toBe('claude-tui');
    const args = native.buildArgs('prompt', [], ['/tmp/read'], { model: 'sonnet' }, { resumeSessionId: 'stored-id' });
    expect(args).toEqual(['--model', 'sonnet', '--add-dir', '/tmp/read', '--resume', 'stored-id', '--permission-mode', 'default']);
    expect(claudeAgentDef.buildArgs('prompt', [])).toContain('-p');
  });
  it('persists both settings and refuses invalid values', async () => {
    const dir = temp();
    await writeAppConfig(dir, { claudeExecutionMode: 'print' });
    expect((await readAppConfig(dir)).claudeExecutionMode).toBe('print');
    await writeAppConfig(dir, { claudeExecutionMode: 'tui' });
    await writeAppConfig(dir, { claudeExecutionMode: 'invalid' });
    expect((await readAppConfig(dir)).claudeExecutionMode).toBe('tui');
  });
  it('neutralizes terminal escapes and slash command prefixes', () => {
    expect(claudeTuiPaste('/exit\r\n\x1b[201~hello\x03')).toBe('\n/exit\n[201~hello');
  });
});

describe('native transcript', () => {
  it('handles split JSON and ignores sidechains and premature stop reasons', () => {
    const rows: any[] = []; const ends: unknown[] = [];
    const reader = new ClaudeTuiTranscript((r) => rows.push(r), (e) => ends.push(e));
    reader.begin();
    const assistant = JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer' }] } });
    reader.feed(assistant.slice(0, 20)); reader.feed(assistant.slice(20) + '\n');
    expect(rows[0].message.stop_reason).toBeNull(); expect(ends).toEqual([]);
    reader.feed('{"isSidechain":true,"type":"system","subtype":"turn_duration"}\n');
    expect(ends).toEqual([]);
    reader.feed('{"type":"system","subtype":"turn_duration"}\n');
    expect(ends).toEqual([undefined]);
  });
  it('surfaces native API errors instead of reporting success', () => {
    const errors: unknown[] = [];
    const reader = new ClaudeTuiTranscript(() => {}, (e) => errors.push(e));
    reader.begin();
    reader.feed(JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'Rate limit' }] } }) + '\n');
    reader.feed('{"type":"system","subtype":"turn_duration"}\n');
    expect(errors).toEqual(['Rate limit']);
  });
});

describe.skipIf(process.platform === 'win32')('real PTY transport with a fake provider', () => {
  async function launch(id = randomUUID(), root = temp(), extraEnv: Record<string, string> = {}) {
    const child = (await spawnClaudeTuiProcess({
      command: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/claude-tui.ts', import.meta.url)), '--session-id', id],
      cwd: root, env: { ...process.env, CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', ...extraEnv },
      stdin: 'pipe', runDir: root, runId: id,
    })).child;
    children.push(child);
    let output = '';
    child.stdout!.on('data', (c) => { output += c.toString(); });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    return { child, root, closed, output: () => output };
  }
  it('runs in a TTY, queues prompts, and cleans its durable process record', async () => {
    const run = await launch();
    expect(fs.existsSync(agentProcessRecordPath(run.root, run.child.pid!))).toBe(true);
    run.child.stdin!.write(encodeStreamJsonUserMessage('first'));
    run.child.stdin!.write(encodeStreamJsonUserMessage('second'));
    expect(await run.closed).toBe(0);
    const rows = run.output().trim().split('\n').map((s) => JSON.parse(s));
    expect(rows.filter((r) => r.type === 'result')).toHaveLength(1);
    expect(rows.filter((r) => r.type === 'assistant').map((r) => r.message.content[0].text)).toEqual(['reply 1: first', 'reply 2: second']);
    expect(JSON.parse(fs.readFileSync(path.join(run.root, 'launch.json'), 'utf8'))).toMatchObject({ isTTY: true, entrypoint: null });
    expect(fs.existsSync(agentProcessRecordPath(run.root, run.child.pid!))).toBe(false);
  }, 10000);
  it('fails a native permission prompt without confirming it', async () => {
    const run = await launch(); run.child.stdin!.write(encodeStreamJsonUserMessage('WAIT_PERMISSION'));
    expect(await run.closed).toBe(1);
    expect(run.output()).toContain('waiting for a tool permission');
    expect(run.output()).not.toContain('"subtype":"success"');
  }, 10000);
  it('does not mistake an external-file approval menu for an input prompt', async () => {
    const run = await launch(randomUUID(), temp(), { FANTAY_TEST_TUI_DIALOG: 'external' });
    run.child.stdin!.write(encodeStreamJsonUserMessage('must not be submitted'));
    expect(await run.closed).toBe(1);
    expect(run.output()).toContain('external-file approval');
    expect(run.output()).not.toContain('"subtype":"init"');
  }, 10000);
  it('reads only newly appended rows when resuming an existing native session', async () => {
    const id = randomUUID(); const root = temp();
    const first = await launch(id, root);
    first.child.stdin!.write(encodeStreamJsonUserMessage('first-only'));
    expect(await first.closed).toBe(0);
    const second = await launch(id, root);
    second.child.stdin!.write(encodeStreamJsonUserMessage('second-only'));
    expect(await second.closed).toBe(0);
    expect(second.output()).toContain('second-only');
    expect(second.output()).not.toContain('first-only');
  }, 10000);
  it('cancels an unfinished native process without success', async () => {
    const run = await launch(); run.child.stdin!.write(encodeStreamJsonUserMessage('HANG'));
    setTimeout(() => run.child.kill(), 600);
    expect(await run.closed).not.toBe(0);
    expect(run.output()).not.toContain('"subtype":"success"');
  }, 10000);
  it('delivers a prompt larger than the pipe buffer without losing its tail', async () => {
    const run = await launch();
    const prompt = `${'context '.repeat(12000)}final-尾部`;
    run.child.stdin!.write(encodeStreamJsonUserMessage(prompt));
    expect(await run.closed).toBe(0);
    expect(run.output()).toContain(prompt);
  }, 10000);
});
