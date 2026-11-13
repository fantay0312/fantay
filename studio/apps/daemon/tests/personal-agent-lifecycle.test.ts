import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paTaskInputSchema, type PaTask, type PaAttempt, type PaRoutine } from '@open-design/contracts';
import { closeDatabase, openDatabase, insertProject, ensureWorkspaceProject, type SqliteDb } from '../src/db.js';
import { PersonalAgentService } from '../src/services/personal-agent-service.js';
import type { PaModelRuntime } from '../src/runtimes/personal-agent.js';
import { paDigest } from '../src/services/personal-agent-gateway.js';
import { validatePaDeviceRequest } from '../src/services/personal-agent-device-cli.js';
import { PaError } from '../src/storage/personal-agent-store.js';

let root: string, db: SqliteDb, core: PersonalAgentService;
const execute = vi.fn<PaModelRuntime['execute']>();
const reconcile = vi.fn<NonNullable<PaModelRuntime['reconcile']>>();
const construct = () => new PersonalAgentService({ db, dataDir: root, projectsDir: join(root, 'projects'), runtime: { models: async () => [], execute, reconcile } });
const submit = (extra: Record<string, unknown> = {}) => core.submit(paTaskInputSchema.parse({ requestId: crypto.randomUUID(), conversationId: core.snapshot().conversations[0]!.id, goal: 'Local lifecycle test', ...extra }));
const waitFor = async (id: string, state: PaTask['status']) => vi.waitFor(() => expect(core.store.require<PaTask>('tasks', id).status).toBe(state));
beforeEach(() => { root = mkdtempSync(join(process.cwd(), '.tmp-pa-life-')); db = openDatabase(root, { dataDir: root }); execute.mockReset().mockResolvedValue({ text: 'Done', usage: { visibility: 'unknown' } }); reconcile.mockReset().mockResolvedValue('stopped'); core = construct(); });
afterEach(async () => { await core.shutdown(); closeDatabase(); rmSync(root, { recursive: true, force: true }); });
describe('PA local V1 lifecycle', () => {
  it('rebuilds a never-dispatched queue without duplicating the ticket', async () => {
    await core.setControl({ paused: true });
    const task = submit();
    await core.shutdown();
    core = construct();
    expect(core.store.require<PaTask>('tasks', task.id).status).toBe('queued');
    await core.setControl({ paused: false });
    await waitFor(task.id, 'completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(core.snapshot().tasks.map(item => item.id)).toEqual([task.id]);
  });
  it('advances a received attempt after restart without asking the provider again', async () => {
    await core.setControl({ paused: true });
    const task = submit({ budget: { maxAttempts: 1, timeoutMs: 30000 } });
    const agent = core.snapshot().agents.find(item => item.id === task.participantIds[0])!;
    const output = 'Durable fixture response';
    const attempt = core.store.create<PaAttempt>('attempts', {
      taskId: task.id, runId: crypto.randomUUID(), nodeId: core.node.id, protocolVersion: 1,
      agentSnapshot: agent, phase: 'respond', status: 'running', taskRevision: task.revision,
      startedAt: Date.now(), endedAt: null, output, error: null, usage: { visibility: 'unknown' },
      modelReceipt: { outputSha256: paDigest(output), receivedAt: Date.now() },
      authority: { principal: { kind: 'owner', id: 'owner' }, agentId: agent.id, authorizationVersion: 1, participantIndex: 0, capabilities: ['respond'] },
    });
    core.store.update<PaTask>('tasks', task.id, { status: 'running' });
    await core.shutdown();
    core = construct();
    await core.setControl({ paused: false });
    await waitFor(task.id, 'completed');
    expect(execute).not.toHaveBeenCalled();
    expect(core.snapshot().messages.filter(item => item.attemptId === attempt.id)).toMatchObject([{ content: output }]);
    expect(core.store.events(task.id).filter(event => event.kind === 'task.completed')).toHaveLength(1);
  });
  it('keeps local-only data out of standard requests and gates cloud routing before dispatch', async () => {
    const agent = core.snapshot().agents[0]!;
    core.saveMemory({ content: 'PA_PRIVATE_SENTINEL', source: 'owner', scope: 'private', scopeId: null, dataClass: 'local_only' });
    const privateTask = submit({ dataClass: 'local_only' });
    await waitFor(privateTask.id, 'waiting');
    expect(execute).not.toHaveBeenCalled();
    core.updateAgent(agent.id, { ...agent, model: { runtime: 'ollama', modelId: 'local-test' } }, agent.revision);
    core.resume(privateTask.id);
    await waitFor(privateTask.id, 'completed');
    const localCall = execute.mock.calls[0]!;
    expect(localCall[1]).toContain('PA_PRIVATE_SENTINEL');
    expect(localCall[4]).toMatchObject({ dataClass: 'local_only' });
    const standard = submit();
    await waitFor(standard.id, 'completed');
    expect(execute.mock.calls[1]![1]).not.toContain('PA_PRIVATE_SENTINEL');
  });
  it('recalls the still-current version of a fact until its successor takes effect', async () => {
    const first = core.saveMemory({ content: 'CURRENT_BUILD', source: 'release owner', scope: 'private', scopeId: null, kind: 'fact', validFrom: Date.now() - 60000 });
    const next = core.saveMemory({ ...first, content: 'FUTURE_BUILD', validFrom: Date.now() + 60000 }, first.id, first.revision);
    expect(core.memoryHistory(first.id).map(item => [item.revision, item.memory.content])).toEqual([[1, 'CURRENT_BUILD'], [2, 'FUTURE_BUILD']]);
    const task = submit();
    await waitFor(task.id, 'completed');
    expect(execute.mock.calls[0]![1]).toContain('CURRENT_BUILD');
    expect(execute.mock.calls[0]![1]).not.toContain('FUTURE_BUILD');
    expect(next.validFrom).toBeGreaterThan(Date.now());
    core.deleteMemory(first.id);
    expect(core.store.list('memory_versions')).toHaveLength(0);
  });
  it('detects an edited audit payload and rejects device RPC traversal', async () => {
    const task = submit();
    await waitFor(task.id, 'completed');
    expect(core.store.verifyAudit()).toMatchObject({ valid: true, entries: 3 });
    db.prepare("UPDATE pa_events SET data='{}' WHERE kind='gateway.model_received'").run();
    expect(core.store.verifyAudit()).toMatchObject({ valid: false, entries: 1 });
    expect(() => validatePaDeviceRequest({ method: 'GET', endpoint: '/../memories' })).toThrow();
    expect(() => validatePaDeviceRequest({ method: 'POST', endpoint: '/tasks/id/reconcile' })).toThrow();
    expect(validatePaDeviceRequest({ method: 'POST', endpoint: '/tasks/id/resume' }).method).toBe('POST');
  });
  it('records an explicit merge as a third artifact version and preserves both parents', async () => {
    const group = core.snapshot().groups[0]!;
    const produce = (content: string) => ({ text: JSON.stringify({ summary: 'Built', files: [{ path: 'brief.md', content }] }), usage: { visibility: 'unknown' } as const });
    const review = (approved: boolean) => ({ text: JSON.stringify({ approved, summary: 'Checked', issues: approved ? [] : ['Needs revision'] }), usage: { visibility: 'unknown' } as const });
    execute.mockResolvedValueOnce(produce('# First')).mockResolvedValueOnce(review(false))
      .mockResolvedValueOnce(produce('# Second')).mockResolvedValueOnce(review(true));
    const task = submit({ conversationId: group.conversationId, kind: 'project' });
    await waitFor(task.id, 'waiting');
    core.resume(task.id);
    await waitFor(task.id, 'completed');
    const [left, right] = core.snapshot().artifacts;
    expect(right?.baseVersionId).toBe(left?.id);
    const revision = core.store.require<PaTask>('tasks', task.id).revision;
    const input = { leftVersionId: left!.id, rightVersionId: right!.id, content: '# Merged\n', revision };
    const merged = await core.mergeArtifacts(task.id, input);
    expect(merged.mergedFrom).toEqual([left!.id, right!.id]);
    expect(await core.mergeArtifacts(task.id, input)).toEqual(merged);
    for (const [file, content] of [[left!, '# First'], [right!, '# Second'], [merged, '# Merged\n']] as const)
      expect(readFileSync(join(root, 'projects', file.projectId, file.path), 'utf8')).toBe(content);
  });
  it('does not dispatch another paid call after the ticket has reserved its cost ceiling', async () => {
    const agent = core.snapshot().agents[0]!;
    core.updateAgent(agent.id, { ...agent, model: { runtime: 'tokentosea', modelId: 'fixture' } }, agent.revision);
    execute.mockRejectedValueOnce(new PaError('Provider unavailable', 503, 'PA_MODEL_UNAVAILABLE'));
    const task = submit({ budget: { maxAttempts: 2, timeoutMs: 30000, maxCostUsd: 0.12 } });
    await waitFor(task.id, 'waiting');
    expect(execute.mock.calls[0]?.[4]).toMatchObject({ maxCostUsd: 0.12 });
    core.resume(task.id);
    await waitFor(task.id, 'waiting');
    expect(core.store.require<PaTask>('tasks', task.id).waitKind).toBe('budget');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('pauses active work without revoking authorization and resumes only after termination', async () => {
    execute.mockImplementationOnce((_model, _prompt, _id, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('paused')), { once: true })));
    const task = submit(); await waitFor(task.id, 'running');
    await core.setControl({ paused: true });
    expect(core.store.require<PaTask>('tasks', task.id)).toMatchObject({ status: 'waiting', waitKind: 'paused', waitingReason: 'Fantay 已暂停，等待恢复', stopConfirmation: 'confirmed', authorization: { revoked: false } });
    expect(core.control().activeCount).toBe(0);
    await core.setControl({ paused: false }); await waitFor(task.id, 'completed');
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('does not undo a user pause when the device resumes', async () => {
    await core.setControl({ paused: true }); const task = submit();
    await core.powerState('suspend'); await core.powerState('resume');
    expect(core.control().paused).toBe(true); expect(execute).not.toHaveBeenCalled();
    await core.setControl({ paused: false }); await waitFor(task.id, 'completed');
  });
  it('expires ordinary waits but preserves explicitly paused work', async () => {
    await core.setControl({ paused: true, waitingExpiryMs: 60000 });
    const login = submit(), paused = submit();
    core.store.update<PaTask>('tasks', login.id, { status: 'waiting', waitKind: 'login', waitingSince: Date.now() - 61000 });
    core.store.update<PaTask>('tasks', paused.id, { status: 'waiting', waitKind: 'paused', waitingSince: Date.now() - 61000 });
    (core as unknown as { expireWaitingTasks(): void }).expireWaitingTasks();
    expect(core.store.require<PaTask>('tasks', login.id).status).toBe('failed');
    expect(core.store.require<PaTask>('tasks', paused.id).status).toBe('waiting');
    expect(execute).not.toHaveBeenCalled();
  });
  it('retains network-dependent work without preventing independent tasks', async () => {
    execute.mockRejectedValueOnce(Object.assign(new Error('Network failed'), { cause: { code: 'ENOTFOUND' } }));
    const unavailable = submit(); await waitFor(unavailable.id, 'waiting');
    expect(core.store.require<PaTask>('tasks', unavailable.id).waitKind).toBe('network');
    const available = submit(); await waitFor(available.id, 'completed');
    core.resume(unavailable.id); await waitFor(unavailable.id, 'completed');
  });
  it('rejects exhausted time before mutating the task and clears wait metadata on an eligible resume', async () => {
    execute.mockRejectedValueOnce(Object.assign(new Error('Network failed'), { code: 'ENOTFOUND' }));
    const task = submit(); await waitFor(task.id, 'waiting');
    const attempt = core.snapshot().attempts[0]!;
    core.store.update<PaAttempt>('attempts', attempt.id, { durationMs: task.budget.timeoutMs });
    const waiting = core.store.update<PaTask>('tasks', task.id, { expiresAt: Date.now() + 60000 });
    expect(() => core.resume(task.id)).toThrow(expect.objectContaining({ status: 429, code: 'PA_BUDGET' }));
    expect(core.store.require<PaTask>('tasks', task.id)).toEqual(waiting);
    expect(core.snapshot().attempts).toHaveLength(1);
    core.store.update<PaAttempt>('attempts', attempt.id, { durationMs: task.budget.timeoutMs - 10000 });
    expect(core.resume(task.id)).toMatchObject({ status: 'queued', waitingReason: null });
    const queued = core.store.require<PaTask>('tasks', task.id);
    for (const key of ['waitKind', 'waitingSince', 'expiresAt']) expect(queued).not.toHaveProperty(key);
    await waitFor(task.id, 'completed');
  });
  it('reconciles a stopped local executor before allowing a new attempt after restart', async () => {
    const task = submit(); await waitFor(task.id, 'completed');
    const attempt = core.snapshot().attempts[0]!;
    core.store.update<PaTask>('tasks', task.id, { status: 'running', nextParticipant: 0 });
    core.store.update<PaAttempt>('attempts', attempt.id, { status: 'running', modelReceipt: undefined, output: '', endedAt: null });
    await core.shutdown(); core = construct();
    expect(() => core.resume(task.id)).toThrow('未知');
    await core.reconcileTask(task.id); expect(reconcile).toHaveBeenCalledWith(attempt.agentSnapshot.model, attempt.runId);
    core.resume(task.id); await waitFor(task.id, 'completed'); expect(execute).toHaveBeenCalledTimes(2);
  });
  it('keeps running/unknown outcomes blocked and records explicit human confirmation without auto replay', async () => {
    const task = submit(); await waitFor(task.id, 'completed');
    core.store.update<PaTask>('tasks', task.id, { status: 'waiting', stopConfirmation: 'unknown' });
    reconcile.mockResolvedValueOnce('running'); await expect(core.reconcileTask(task.id)).rejects.toMatchObject({ code: 'PA_EXECUTOR_RUNNING' });
    reconcile.mockResolvedValue('unknown'); await expect(core.reconcileTask(task.id)).rejects.toMatchObject({ code: 'PA_RECOVERY_REQUIRED' });
    const current = core.store.require<PaTask>('tasks', task.id);
    await core.reconcileTask(task.id, { revision: current.revision, note: 'Verified the original provider request ended' });
    expect(core.store.require<PaTask>('tasks', task.id).stopConfirmation).toBe('confirmed'); expect(execute).toHaveBeenCalledTimes(1);
    expect(core.store.events(task.id).at(-1)?.data).toMatchObject({ source: 'owner-confirmed' });
  });
  it('persists goals and routine outcomes, and runs a scheduled slot at most once', async () => {
    const conversationId = core.snapshot().conversations[0]!.id;
    const input = { name: 'Daily work', prompt: 'Summarize the brief', conversationId, time: '09:00', timezone: 'Asia/Taipei', enabled: true };
    const routine = core.saveRoutine(input);
    const due = routine.nextRunAt!;
    core.tickRoutines(due);
    core.tickRoutines(due);
    const task = core.snapshot().tasks[0]!;
    await waitFor(task.id, 'completed');
    expect(core.snapshot().tasks).toHaveLength(1);
    expect(task.routineId).toBe(routine.id);
    expect(core.snapshot().messages[0]?.routineId).toBe(routine.id);
    const goal = core.saveGoal({ name: 'Briefs', description: 'Daily progress', taskIds: [task.id, task.id] });
    expect(goal.taskIds).toEqual([task.id]);
    const feed = core.store.feed(Number.MAX_SAFE_INTEGER, 2);
    expect(feed.map(event => event.kind)).toEqual(['task.completed', 'task.accepted']);
    expect(core.store.feed(feed[0]!.sequence, 2)).toEqual([feed[1]]);
    await core.shutdown(); core = construct();
    expect(core.snapshot().goals).toEqual([goal]);
    expect(core.snapshot().routines?.[0]).toMatchObject({ id: routine.id, lastTaskId: task.id });
  });
  it('skips overdue and paused routine slots and supports a revision-checked manual run', async () => {
    const conversationId = core.snapshot().conversations[0]!.id;
    const routine = core.saveRoutine({ name: 'Daily', prompt: 'Summarize', conversationId, time: '09:00', timezone: 'UTC', enabled: true });
    core.tickRoutines(routine.nextRunAt! + 120000);
    expect(core.snapshot().tasks).toHaveLength(0);
    const next = core.store.require<PaRoutine>('routines', routine.id);
    await core.setControl({ paused: true });
    core.tickRoutines(next.nextRunAt!);
    expect(core.snapshot().tasks).toHaveLength(0);
    expect(() => core.runRoutine(next.id, next.revision)).toThrow(expect.objectContaining({ code: 'PA_REVISION_CONFLICT' }));
    await core.setControl({ paused: false });
    const manual = core.runRoutine(next.id, core.store.require<PaRoutine>('routines', next.id).revision);
    await waitFor(manual.id, 'completed');
  });
  it('reads the entire bounded output in pages and searches with original Unicode offsets', async () => {
    const content = `${'a'.repeat(33000)}İ NEEDLE ${'b'.repeat(33000)}`;
    execute.mockResolvedValueOnce({ text: content, usage: { visibility: 'unknown' } });
    const task = submit(); await waitFor(task.id, 'completed'); const attempt = core.snapshot().attempts[0]!;
    let offset: number | null = 0, collected = '';
    while (offset !== null) { const page = core.outputPage(attempt.id, offset, 16000); collected += page.text; offset = page.nextOffset; }
    expect(collected).toBe(content);
    expect(core.outputPage(attempt.id, 0, 100, 'needle').matches[0]!.offset).toBe(content.indexOf('NEEDLE'));
    expect(core.outputPage(attempt.id, 0, 100, '.').matches).toHaveLength(0);
  });
  it('associates parallel deliverables with a managed local project without overwriting its files', async () => {
    insertProject(db, { id: 'existing', name: 'Existing project', createdAt: 1, updatedAt: 1 });
    mkdirSync(join(root, 'projects', 'existing'), { recursive: true }); writeFileSync(join(root, 'projects', 'existing', 'brief.md'), 'Original');
    execute.mockImplementation(async (_model, prompt) => ({ text: prompt.includes('"approved":true|false') ? JSON.stringify({ approved: true, summary: 'Verified', issues: [] }) : JSON.stringify({ summary: 'New version', files: [{ path: 'brief.md', content: 'New deliverable' }] }), usage: { visibility: 'unknown' } }));
    const group = core.snapshot().groups[0]!;
    const secondGroup = core.createGroup({ name: 'Second group', memberIds: group.memberIds, moderatorId: group.moderatorId, mode: 'review' });
    const one = submit({ conversationId: group.conversationId, kind: 'project', projectId: 'existing' });
    const two = submit({ conversationId: secondGroup.conversationId, kind: 'project', projectId: 'existing' });
    await waitFor(one.id, 'completed'); await waitFor(two.id, 'completed');
    expect(readFileSync(join(root, 'projects', 'existing', 'brief.md'), 'utf8')).toBe('Original');
    const artifacts = core.snapshot().artifacts; expect(artifacts).toHaveLength(2); expect(new Set(artifacts.map(item => item.path)).size).toBe(2);
    expect(db.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({ count: 1 });
  });
  it('does not associate imported directories or workspace-bound projects through the local-only PA capability', () => {
    insertProject(db, { id: 'imported', name: 'Imported', metadata: { baseDir: '/tmp/never-accessed' }, createdAt: 1, updatedAt: 1 });
    insertProject(db, { id: 'team', name: 'Team', createdAt: 1, updatedAt: 1 });
    ensureWorkspaceProject(db, { projectId: 'team', workspaceId: 'workspace', visibility: 'team', resourceState: 'active', createdAt: 1, updatedAt: 1 });
    const conversationId = core.snapshot().groups[0]!.conversationId;
    expect(() => submit({ conversationId, kind: 'project', projectId: 'imported' })).toThrow('只能从桌面');
    expect(() => submit({ conversationId, kind: 'project', projectId: 'team' })).toThrow('只能从桌面');
    expect(core.projects()).toEqual([]); expect(execute).not.toHaveBeenCalled();
  });
});
