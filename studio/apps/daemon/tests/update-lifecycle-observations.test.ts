import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { observeUpdateLifecycleStages, type ObserveUpdateLifecycleStagesOptions } from '../src/migration/update-apply-observations.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'od-lifecycle-replay-')); roots.push(root);
  const flow = join(root, 'observations/installer/flow');
  await mkdir(join(flow, 'lifecycle'), { recursive: true });
  const summary = { schemaVersion: 1, kind: 'installer_apply_observation', flowId: 'flow',
    channel: 'prerelease', namespace: 'test', arch: 'x64', platform: 'win32', artifactType: 'payload',
    fromVersion: '0.22.2-prerelease.2', toVersion: '0.22.2-prerelease.3',
    attemptedAt: '2026-09-10T05:20:00Z', updatedAt: '2026-09-10T05:20:00Z', result: 'success', reason: 'app_version_matches',
    delivery: { status: 'submitted' } };
  await writeFile(join(flow, 'summary.json'), JSON.stringify(summary));
  const capture = vi.fn(async (_args: Parameters<ObserveUpdateLifecycleStagesOptions['analytics']['capture']>[0]) => ({ status: 'queued' as const, acknowledgement: 'local_buffer' as const, errorType: null }));
  const captureSafety = vi.fn(async (_args: Parameters<ObserveUpdateLifecycleStagesOptions['analytics']['captureSafety']>[0]) => undefined);
  const options: ObserveUpdateLifecycleStagesOptions = {
    analytics: { capture, captureSafety }, appVersion: summary.toVersion, currentVersion: summary.toVersion,
    currentChannel: 'prerelease', namespace: 'test', dataRoot: root, env: { POSTHOG_KEY: 'ph_test' },
    now: () => new Date('2026-09-10T05:22:00Z'),
    readConfig: async () => ({ installationId: 'test-device', telemetry: { metrics: true } }),
  };
  const stage = async (name: string, overrides: Record<string, unknown> = {}) => writeFile(join(flow, 'lifecycle', `${name}.json`), JSON.stringify({
    stage: name, outcome: 'completed', flow_id: 'flow', occurred_at: '2026-09-10T05:20:45Z', observation_version: 1, ...overrides,
  }));
  return { flow, capture, captureSafety, options, stage };
}
// FantayDesign has no automatic reporting: readPosthogConfig is always null, so
// valid stage records are settled locally as analytics-disabled and never sent.
const readReceipt = async (flow: string, file: string) => JSON.parse(await readFile(join(flow, file), 'utf8'));
const later = () => new Date('2026-09-10T05:23:00Z');
it('accepts legacy summaries without stages, then settles late desktop readiness separately', async () => {
  const { options, capture, stage, flow } = await fixture();
  expect(await observeUpdateLifecycleStages(options)).toEqual({ queued: 0 });
  await stage('desktop_ready');
  expect(await observeUpdateLifecycleStages(options)).toEqual({ queued: 0 });
  expect(await readReceipt(flow, 'lifecycle/desktop_ready.json.receipt')).toMatchObject({
    status: 'skipped_analytics_disabled', insertId: 'update_lifecycle_observed:flow:desktop_ready',
  });
  expect(capture).not.toHaveBeenCalled();
});
it('settles renderer quiescence as its own idempotent handoff stage', async () => {
  const { options, capture, stage, flow } = await fixture();
  await stage('renderer_quiesced');
  expect(await observeUpdateLifecycleStages(options)).toEqual({ queued: 0 });
  const settled = await readReceipt(flow, 'lifecycle/renderer_quiesced.json.receipt');
  expect(settled).toMatchObject({
    status: 'skipped_analytics_disabled', insertId: 'update_lifecycle_observed:flow:renderer_quiesced',
  });
  await observeUpdateLifecycleStages({ ...options, now: later });
  expect(await readReceipt(flow, 'lifecycle/renderer_quiesced.json.receipt')).toEqual(settled);
  expect(capture).not.toHaveBeenCalled();
});
it('records a shutdown stage as analytics-disabled, never as queued, with its stable insert ID', async () => {
  const { options, capture, stage, flow } = await fixture();
  await stage('shutdown_completed', { duration_ms: 32000, repeated_quit_count: 2 });
  expect(await observeUpdateLifecycleStages(options)).toEqual({ queued: 0 });
  expect(await observeUpdateLifecycleStages(options)).toEqual({ queued: 0 });
  expect(await readReceipt(flow, 'lifecycle/shutdown_completed.json.receipt')).toMatchObject({
    status: 'skipped_analytics_disabled', insertId: 'update_lifecycle_observed:flow:shutdown_completed',
  });
  expect(capture).not.toHaveBeenCalled();
});
it('does not emit opted-out observations later when consent changes', async () => {
  const { options, capture, stage } = await fixture();
  await stage('desktop_ready');
  await observeUpdateLifecycleStages({ ...options, readConfig: async () => ({ installationId: 'test-device', telemetry: { metrics: false } }) });
  await observeUpdateLifecycleStages(options);
  expect(capture).not.toHaveBeenCalled();
});
it('rejects mismatched flow, stage, identity and invalid counts before settling a stage', async () => {
  const { options, capture, stage, flow } = await fixture();
  await stage('cleanup_daemon', { outcome: 'forced', forced_process_count: 3, remaining_process_count: 0, raw_path: '/private/user/file', pid: 123 });
  await stage('desktop_ready', { flow_id: 'other' });
  await stage('shutdown_completed', { repeated_quit_count: -1 });
  await observeUpdateLifecycleStages({ ...options, namespace: 'other' });
  await expect(readFile(join(flow, 'lifecycle/cleanup_daemon.json.receipt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await observeUpdateLifecycleStages(options)).toEqual({ queued: 0 });
  expect(await readReceipt(flow, 'lifecycle/cleanup_daemon.json.receipt')).toMatchObject({ status: 'skipped_analytics_disabled' });
  for (const rejected of ['desktop_ready', 'shutdown_completed']) {
    await expect(readFile(join(flow, `lifecycle/${rejected}.json.receipt`))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(capture).not.toHaveBeenCalled();
});

async function metricFixture() {
  const { flow, options, captureSafety } = await fixture();
  await rm(join(flow, 'summary.json'));
  await mkdir(join(flow, 'stages'), { recursive: true });
  for (const phase of ['started', 'result']) await writeFile(join(flow, 'stages', `check-${phase}.json`), JSON.stringify({
    flow_id: 'flow', stage: 'check', result: phase === 'started' ? 'started' : 'failed',
    reason_code: phase === 'started' ? null : 'check_failed', from_version: '0.22.2-prerelease.2', to_version: null,
    update_path: null, artifact_type: null, trigger: 'silent', duration_ms: null,
    namespace: 'test', channel: 'prerelease', occurred_at: '2026-09-10T05:20:01Z',
    app_session_id: 'app-1', app_version: '0.22.2-prerelease.2', platform: 'win32', arch: 'x64',
    private_path: '/private', pid: 123, metric_schema_version: 1,
  }));
  return { flow, options, capture: captureSafety };
}

it('settles front-stage attempts without an install summary once per phase', async () => {
  const { flow, options, capture } = await metricFixture();
  expect(await observeUpdateLifecycleStages(options)).toEqual({ queued: 0 });
  const settled = await Promise.all(['started', 'result'].map(phase => readReceipt(flow, `stages/check-${phase}.json.receipt`)));
  expect(settled).toEqual([
    expect.objectContaining({ status: 'skipped_analytics_disabled', insertId: 'update_stage:flow:check:started' }),
    expect.objectContaining({ status: 'skipped_analytics_disabled', insertId: 'update_stage:flow:check:result' }),
  ]);
  expect(await observeUpdateLifecycleStages({ ...options, now: later })).toEqual({ queued: 0 });
  expect(await Promise.all(['started', 'result'].map(phase => readReceipt(flow, `stages/check-${phase}.json.receipt`)))).toEqual(settled);
  expect(capture).not.toHaveBeenCalled();
  expect(options.analytics.capture).not.toHaveBeenCalled();
});

it('re-settles an unacknowledged stage record with its stable ID and never records it as queued', async () => {
  const { flow, options, capture } = await metricFixture();
  expect(await observeUpdateLifecycleStages(options)).toEqual({ queued: 0 });
  await rm(join(flow, 'stages/check-started.json.receipt'));
  expect(await observeUpdateLifecycleStages({ ...options, now: later })).toEqual({ queued: 0 });
  expect(await readReceipt(flow, 'stages/check-started.json.receipt')).toEqual({
    status: 'skipped_analytics_disabled', insertId: 'update_stage:flow:check:started', updatedAt: later().toISOString(),
  });
  expect(capture).not.toHaveBeenCalled();
});

it.each(['disabled', 'unreadable'] as const)('settles safety stage records locally with %s consent', async consent => {
  const { flow, options, capture } = await metricFixture();
  expect(await observeUpdateLifecycleStages({ ...options, readConfig: async () => {
    if (consent === 'unreadable') throw new Error('damaged config');
    return { installationId: 'test-device', telemetry: { metrics: false } };
  } })).toEqual({ queued: 0 });
  expect((await readReceipt(flow, 'stages/check-started.json.receipt')).status).toBe('skipped_analytics_disabled');
  expect(await observeUpdateLifecycleStages(options)).toEqual({ queued: 0 });
  expect(capture).not.toHaveBeenCalled();
  expect(options.analytics.capture).not.toHaveBeenCalled();
});

it('does not send stage safety metrics without a PostHog key', async () => {
  const { options, capture } = await metricFixture();
  expect(await observeUpdateLifecycleStages({ ...options, env: {} })).toEqual({ queued: 0 });
  expect(capture).not.toHaveBeenCalled();
});

it('reconsiders old consent-skip receipts on the safety lane using the original event ID', async () => {
  const { flow, options, capture } = await metricFixture();
  for (const phase of ['started', 'result']) await writeFile(join(flow, `stages/check-${phase}.json.receipt`), JSON.stringify({ status: 'skipped_no_consent' }));
  expect(await observeUpdateLifecycleStages({ ...options, readConfig: async () => ({ telemetry: { metrics: false } }) })).toEqual({ queued: 0 });
  expect(await Promise.all(['started', 'result'].map(phase => readReceipt(flow, `stages/check-${phase}.json.receipt`)))).toEqual([
    expect.objectContaining({ status: 'skipped_analytics_disabled', insertId: 'update_stage:flow:check:started' }),
    expect.objectContaining({ status: 'skipped_analytics_disabled', insertId: 'update_stage:flow:check:result' }),
  ]);
  expect(await observeUpdateLifecycleStages(options)).toEqual({ queued: 0 });
  expect(capture).not.toHaveBeenCalled();
});
