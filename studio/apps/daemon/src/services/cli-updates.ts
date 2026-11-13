import type { CliUpdateInfo, CliUpdatesSnapshot, CliUpdateReason } from '@open-design/contracts';
import { compareCliVersions } from '../runtimes/cli-update-version.js';
import { discoverCliUpdateTargets, executeCliUpdate, latestCliVersion, type CliUpdateTarget } from '../runtimes/cli-update-sources.js';

export class CliUpdateError extends Error {
  constructor(public readonly code: 'BUSY' | 'NOT_AVAILABLE' | 'BAD_REQUEST', message: string) { super(message); }
}

const updatingAgentIds = new Set<string>();
export function isCliUpdateInProgress(agentId: string): boolean { return updatingAgentIds.has(agentId); }

export interface CliUpdateServiceOptions {
  discover: () => Promise<CliUpdateTarget[]>;
  latest?: typeof latestCliVersion;
  execute?: typeof executeCliUpdate;
  isBusy?: (agentId: string) => boolean;
  now?: () => number;
}

export function createCliUpdateService(options: CliUpdateServiceOptions) {
  const latest = options.latest ?? latestCliVersion;
  const execute = options.execute ?? executeCliUpdate;
  const now = options.now ?? Date.now;
  const items = new Map<string, CliUpdateInfo>();
  const targets = new Map<string, CliUpdateTarget>();
  let lastCheckedAt: string | null = null;
  let checking: Promise<void> | null = null;
  let updating: Promise<void> | null = null;
  let checkFailed = false;
  const snapshot = (): CliUpdatesSnapshot => ({ checking: checking !== null, lastCheckedAt, items: [...items.values()].map(item => ({ ...item })), ...(checkFailed ? { error: 'check-failed' as const } : {}) });

  const info = (target: CliUpdateTarget): CliUpdateInfo => ({
    agentId: target.agentId, installedVersion: target.version, latestVersion: null,
    state: 'unchecked', method: target.method, canUpdate: target.method !== 'manual' && !!target.version,
    ...(target.sourceUrl ? { sourceUrl: target.sourceUrl } : {}), ...(target.reason ? { reason: target.reason } : {}),
  });

  async function checkTarget(target: CliUpdateTarget) {
    targets.set(target.agentId, target);
    const item = info(target);
    items.set(target.agentId, item);
    try {
      item.latestVersion = await latest(target);
      if (!target.version || !item.latestVersion) return;
      const order = compareCliVersions(item.latestVersion, target.version);
      item.state = order === null ? 'unchecked' : order > 0 ? 'available' : 'current';
    } catch {
      item.state = 'error';
      item.reason = 'check-failed';
    }
  }

  function check(force = false): CliUpdatesSnapshot {
    if (updating || checking) return snapshot();
    const cacheMs = checkFailed || [...items.values()].some(item => item.reason === 'check-failed') ? 5 * 60_000 : 6 * 60 * 60_000;
    if (!force && lastCheckedAt && now() - Date.parse(lastCheckedAt) < cacheMs) return snapshot();
    checkFailed = false;
    checking = Promise.resolve().then(async () => {
      const found = await options.discover();
      const ids = new Set(found.map(target => target.agentId));
      for (const id of items.keys()) if (!ids.has(id)) { items.delete(id); targets.delete(id); }
      // Keep network work bounded while each row becomes ready independently.
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, found.length) }, async () => {
        while (index < found.length) await checkTarget(found[index++]!);
      }));
      lastCheckedAt = new Date(now()).toISOString();
    }).catch(() => {
      checkFailed = true;
      lastCheckedAt = new Date(now()).toISOString();
      for (const item of items.values()) { item.state = 'error'; item.reason = 'check-failed'; }
    }).finally(() => { checking = null; });
    return snapshot();
  }

  function update(agentIds: string[]): CliUpdatesSnapshot {
    if (checking || updating) throw new CliUpdateError('BUSY', 'Another CLI maintenance operation is running.');
    if (!agentIds.length || agentIds.length > 32 || new Set(agentIds).size !== agentIds.length) throw new CliUpdateError('BAD_REQUEST', 'Choose installed CLIs to update.');
    const selected = agentIds.map(id => {
      const target = targets.get(id);
      const item = items.get(id);
      if (!target || !item || !item.canUpdate || !item.latestVersion || !['available', 'error'].includes(item.state)) throw new CliUpdateError('NOT_AVAILABLE', 'Check this CLI for updates first.');
      if (options.isBusy?.(id) || updatingAgentIds.has(id)) throw new CliUpdateError('BUSY', 'This CLI has an active task. Try again when it finishes.');
      return { target, item, expected: item.latestVersion };
    });
    for (const { item } of selected) { updatingAgentIds.add(item.agentId); item.state = 'queued'; delete item.reason; }
    // A single queue also serializes two CLIs owned by the same package manager.
    updating = Promise.resolve().then(async () => {
      for (const { target, item, expected } of selected) {
        let failure: CliUpdateReason = 'install-failed';
        try {
          if (options.isBusy?.(target.agentId)) { failure = 'busy'; throw new Error('Active task'); }
          const before = (await options.discover()).find(next => next.agentId === target.agentId);
          if (!before || before.identity !== target.identity || before.selectedPath !== target.selectedPath) {
            failure = 'installation-changed'; throw new Error('Installation changed');
          }
          if (options.isBusy?.(target.agentId)) { failure = 'busy'; throw new Error('Active task'); }
          if (before.version && (compareCliVersions(before.version, expected) ?? -1) >= 0) {
            item.installedVersion = before.version; item.state = 'current'; continue;
          }
          item.state = 'updating'; item.phase = 'installing';
          await execute(before, expected);
          item.phase = 'verifying'; failure = 'verification-failed';
          const after = (await options.discover()).find(next => next.agentId === target.agentId);
          item.installedVersion = after?.version ?? null;
          // A zero exit code is insufficient: the active CLI must reach the version promised.
          if (!after?.version || after.identity !== target.identity || (compareCliVersions(after.version, expected) ?? -1) < 0) throw new Error('Version not verified');
          targets.set(target.agentId, after);
          item.state = 'updated';
        } catch {
          item.state = 'error'; item.reason = failure;
        } finally { delete item.phase; }
      }
    }).finally(() => { for (const { item } of selected) updatingAgentIds.delete(item.agentId); updating = null; });
    return snapshot();
  }

  return { snapshot, check, update, settled: async () => { await checking; await updating; } };
}

export function createLocalCliUpdateService(runtimeDataDir: string, isBusy: (agentId: string) => boolean) {
  return createCliUpdateService({ discover: () => discoverCliUpdateTargets(runtimeDataDir), isBusy });
}

export type CliUpdateService = ReturnType<typeof createCliUpdateService>;
