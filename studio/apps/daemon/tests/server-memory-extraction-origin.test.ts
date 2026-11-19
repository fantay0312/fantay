import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from 'prom-client';

// This suite isolates the heuristic request boundary. The actual heuristic,
// extraction records, memory files and HTTP routes are not mocked. Background
// provider inference is a separate pipeline and must not spend provider budget.
vi.mock('../src/memory-llm.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/memory-llm.js')>();
  return {
    ...actual,
    extractWithLLM: vi.fn(async () => []),
    distillAnnotationsToMemory: vi.fn(async () => []),
    completeWithMemoryProvider: vi.fn(async () => null),
  };
});

type Started = { url: string; server: Server; shutdown?: () => Promise<void> | void };
type Extraction = { id: string; kind: string; phase: string; writtenCount?: number; writtenIds?: string[] };
let started: Started | undefined;
let dataDir: string | undefined;
let projectId = '';
let conversationId = '';
const previousDataDir = process.env.OD_DATA_DIR;

async function api<T>(pathname: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
  if (!started) throw new Error('Missing isolated daemon');
  const response = await fetch(`${started.url}${pathname}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expect(response.status, `${method} ${pathname}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'od-memory-origin-'));
  process.env.OD_DATA_DIR = dataDir;
  // Match the existing isolated server suites: module reset does not clear
  // prom-client's process-wide registry. Each case owns new registrations.
  register.clear();
  vi.resetModules();
  const { startServer } = await import('../src/server.js');
  started = await startServer({ port: 0, returnServer: true }) as unknown as Started;
  const cli = join(dataDir, 'controlled-claude.ts');
  await writeFile(cli, `#!/usr/bin/env node
import { openSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('claude 0.0.0-memory-contract'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Usage: claude -p --input-format stream-json --output-format stream-json --include-partial-messages'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (process.argv.includes('--thinking-display')) { console.error('unknown option --thinking-display'); process.exit(1); }
createInterface({ input: process.stdin }).once('line', (line) => {
  writeSync(openSync(${JSON.stringify(join(dataDir, 'claude-stdin.jsonl'))}, 'a'), line + '\\n');
  for (const frame of [
    { type: 'system', subtype: 'init', session_id: 'memory-contract-session', model: 'claude-memory-contract' },
    { type: 'assistant', message: { id: 'memory-contract-reply', role: 'assistant', content: [{ type: 'text', text: 'Lesson prepared.' }], stop_reason: 'end_turn' } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Lesson prepared.', stop_reason: 'end_turn', session_id: 'memory-contract-session' },
  ]) writeSync(1, JSON.stringify(frame) + '\\n');
  process.exit(0);
});
`);
  await chmod(cli, 0o755);
  await api('/api/app-config', 'PUT', {
    agentId: 'claude', agentCliEnv: { claude: { CLAUDE_BIN: cli } }, claudeExecutionMode: 'print',
    odNextStrategyMode: 'off',
  });
  await api('/api/memory/config', 'PATCH', { enabled: true, chatExtractionEnabled: true });
  projectId = `memory-origin-${randomUUID()}`;
  const created = await api<{ conversationId: string }>('/api/projects', 'POST', {
    id: projectId, name: 'Memory current-turn contract', conversationMode: 'chat', skipDiscoveryBrief: true,
  });
  conversationId = created.conversationId;
  expect(conversationId).toEqual(expect.any(String));
}, 30_000);

afterEach(async () => {
  try {
    await started?.shutdown?.();
    if (started) {
      started.server.closeAllConnections();
      await new Promise<void>(resolve => started!.server.close(() => resolve()));
    }
  } finally {
    started = undefined;
    try {
      // Diagnostics can finish writing while recursive removal is in progress.
      // Bound retries to transient filesystem races; persistent failures still fail the test.
      if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } finally {
      dataDir = undefined;
      if (previousDataDir === undefined) delete process.env.OD_DATA_DIR;
      else process.env.OD_DATA_DIR = previousDataDir;
      register.clear();
      vi.resetModules();
    }
  }
}, 30_000);

async function send(message: string, current?: { currentPrompt: string | null }): Promise<string> {
  const created = await api<{ runId: string }>('/api/runs', 'POST', {
    projectId, conversationId, agentId: 'claude', sessionMode: 'chat', message,
    ...current, assistantMessageId: randomUUID(), userMessageId: randomUUID(), clientRequestId: randomUUID(),
  }, 202);
  // Real child completion is the barrier: the pre-spawn heuristic is awaited
  // before this point. Polling observes work completion, not a fixed sleep.
  await vi.waitFor(async () => {
    const run = await api<{ status: string; exitCode: number | null; childExited: boolean }>(`/api/runs/${created.runId}`);
    expect(run).toMatchObject({ status: 'succeeded', exitCode: 0, childExited: true });
  }, { timeout: 10_000, interval: 20 });
  return created.runId;
}

// These are actual HTTP/run/heuristic records. Only background provider work
// is mocked; the next suite separately proves the real LLM record writer.
describe('memory extraction records preserve their producing chat origin', () => {
  it('threads the authoritative daemon run identity to heuristic records, and child-close learning goes to the memory engine', async () => {
    const { extractWithLLM, completeWithMemoryProvider } = await import('../src/memory-llm.js');
    const background = vi.mocked(extractWithLLM);
    const engineModel = vi.mocked(completeWithMemoryProvider);
    background.mockClear();
    engineModel.mockClear();
    const runId = await send('Remember: use cobalt blue for project headings');
    // 从对话中学习 is on, so the engine distils the turn with this run's agent; the extractor pass is replaced.
    await vi.waitFor(() => expect(engineModel).toHaveBeenCalledTimes(1));
    expect(engineModel.mock.calls[0]?.[0]).toBe(dataDir);
    expect(engineModel.mock.calls[0]?.[1].user).toContain('Remember: use cobalt blue for project headings');
    expect(engineModel.mock.calls[0]?.[2]).toMatchObject({ chatAgentId: 'claude' });
    expect(background).not.toHaveBeenCalled();
    const run = await api<{ assistantMessageId: string }>(`/api/runs/${runId}`);
    expect(run.assistantMessageId).toEqual(expect.any(String));
    const origin = { projectId, conversationId, runId, assistantMessageId: run.assistantMessageId };
    const { extractions } = await api<{ extractions: Array<Extraction & { extractionOrigin?: unknown }> }>('/api/memory/extractions');
    const record = extractions.find(item => item.kind === 'heuristic' && (item.writtenCount ?? 0) > 0);
    expect(record, 'actual heuristic wrote a real memory entry before checking ownership').toMatchObject({ phase: 'success', writtenCount: 1 });
    expect(record?.extractionOrigin).toEqual(origin);
  });

  it('puts what a sibling conversation of the project said into the turn the agent receives', async () => {
    const sibling = await api<{ conversation: { id: string } }>(`/api/projects/${projectId}/conversations`, 'POST', {
      title: 'Heading colours',
    });
    const siblingId = sibling.conversation.id;
    for (const [index, [role, content]] of [
      ['user', 'Project headings use cobalt blue #1F4FD8 at 28px'],
      ['assistant', 'Noted: cobalt blue #1F4FD8 for project headings'],
    ].entries()) {
      await api(`/api/projects/${projectId}/conversations/${siblingId}/messages/sibling-m${index}`, 'PUT', {
        id: `sibling-m${index}`, role, content,
      });
    }
    const question = 'Which cobalt blue did we choose for the project headings?';
    // The recall rides the chat turn's user body; an OD Next strategy run sends its frozen task text instead.
    vi.stubEnv('OD_NEXT_STRATEGY_ROLLOUT', 'off');
    try {
      await send(question, { currentPrompt: question });
    } finally {
      vi.unstubAllEnvs();
    }
    const stdin = await readFile(join(dataDir!, 'claude-stdin.jsonl'), 'utf8');
    expect(stdin).toContain('<memory>');
    expect(stdin).toContain('cobalt blue #1F4FD8 at 28px');
  });

  it('puts it into an OD Next request too, frozen with the rest of the task text', async () => {
    const sibling = await api<{ conversation: { id: string } }>(`/api/projects/${projectId}/conversations`, 'POST', {
      title: 'Heading colours',
    });
    const siblingId = sibling.conversation.id;
    // "checklist" and "verification" are words the OD Next instruction guard refuses; recalled text is quoted
    // as a fact, so a conversation that used them must not stop the request from being prepared.
    for (const [index, [role, content]] of [
      ['user', 'Project headings use cobalt blue #1F4FD8 at 28px, and add a checklist with a verification step'],
      ['assistant', 'Noted: cobalt blue #1F4FD8 for project headings'],
    ].entries()) {
      await api(`/api/projects/${projectId}/conversations/${siblingId}/messages/sibling-m${index}`, 'PUT', {
        id: `sibling-m${index}`, role, content,
      });
    }
    const question = 'Which cobalt blue did we choose for the project headings?';
    // No rollout override: a fresh project's run takes the OD Next strategy path, which is the default.
    await send(question, { currentPrompt: question });
    const stdin = await readFile(join(dataDir!, 'claude-stdin.jsonl'), 'utf8');
    expect(stdin, 'this run must be an OD Next request for the case to mean anything').toContain('user_first_prompt');
    expect(stdin).toContain('kind=\\"fact\\" name=\\"recalled-memory\\"');
    expect(stdin).toContain('<memory>');
    expect(stdin).toContain('cobalt blue #1F4FD8 at 28px');
    expect(stdin).toContain('add a checklist with a verification step');
  });

  it('preserves the existing explicit HTTP project/conversation fields without inventing a run', async () => {
    await api('/api/memory/extract', 'POST', {
      userMessage: 'Remember: use amber headings for the appendix', projectId, conversationId,
    });
    const { extractions } = await api<{ extractions: Array<Extraction & { extractionOrigin?: unknown }> }>('/api/memory/extractions');
    const written = extractions.filter(item => item.kind === 'heuristic' && (item.writtenCount ?? 0) > 0);
    expect(written).toHaveLength(1);
    expect(written[0]?.extractionOrigin).toEqual({ projectId, conversationId });
  });

  it('leaves old unscoped HTTP extraction unowned instead of adopting the open conversation', async () => {
    await api('/api/memory/extract', 'POST', { userMessage: 'Remember: prefer compact table headers' });
    const { extractions } = await api<{ extractions: Array<Extraction & { extractionOrigin?: unknown }> }>('/api/memory/extractions');
    const written = extractions.filter(item => item.kind === 'heuristic' && (item.writtenCount ?? 0) > 0);
    expect(written).toHaveLength(1);
    expect(written[0]?.extractionOrigin).toBeUndefined();
  });

  it('preserves the BYOK sending draft in both HTTP phases without trusting a client run claim', async () => {
    const { extractWithLLM } = await import('../src/memory-llm.js');
    const background = vi.mocked(extractWithLLM);
    background.mockClear();
    const assistantMessageId = 'byok-draft-from-send';
    const request = {
      projectId, conversationId, assistantMessageId, runId: 'untrusted-client-run',
      userMessage: 'Remember: prefer violet section labels',
    };
    await api('/api/memory/extract', 'POST', request);
    const { extractions } = await api<{ extractions: Array<Extraction & { extractionOrigin?: unknown }> }>('/api/memory/extractions');
    const written = extractions.filter(item => item.kind === 'heuristic' && (item.writtenCount ?? 0) > 0);
    expect(written).toHaveLength(1);
    const expected = { projectId, conversationId, assistantMessageId };
    expect(written[0]?.extractionOrigin).toEqual(expected);
    // The public endpoint accepts post-turn requests too. Current ProjectView
    // uses daemon child-close for this phase; external HTTP clients still have
    // this existing API and must preserve the same explicit draft identity.
    await api('/api/memory/extract', 'POST', { ...request, assistantMessage: 'Noted.' });
    await vi.waitFor(() => expect(background).toHaveBeenCalledTimes(1));
    expect(background.mock.calls[0]?.[2]).toMatchObject({ extractionOrigin: expected });
  });
});
