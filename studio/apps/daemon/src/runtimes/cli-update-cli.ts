import type { CliUpdatesSnapshot } from '@open-design/contracts';
import { setTimeout as delay } from 'node:timers/promises';

export async function runAgentUpdateCli(options: {
  base: string; action: 'updates' | 'update'; agentId?: string; check?: boolean; wait?: boolean; json?: boolean;
}): Promise<void> {
  const root = `${options.base.replace(/\/$/, '')}/api/agents/updates`;
  async function request(url: string, body?: object): Promise<CliUpdatesSnapshot> {
    const response = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const payload = await response.json() as CliUpdatesSnapshot & { error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? `CLI update request failed (${response.status})`);
    return payload;
  }
  let snapshot = options.check ? await request(`${root}/check`, { force: true }) : await request(root);
  if (options.wait) {
    while (snapshot.checking) { await delay(500); snapshot = await request(root); }
  }
  if (options.action === 'update') {
    if (!options.agentId) throw new Error('Usage: od agent update <agent-id|all> [--wait] [--json]');
    const agentIds = options.agentId === 'all' ? snapshot.items.filter(item => item.state === 'available' && item.canUpdate).map(item => item.agentId) : [options.agentId];
    if (agentIds.length) snapshot = await request(root, { agentIds });
  }
  if (options.wait) {
    while (snapshot.items.some(item => item.state === 'queued' || item.state === 'updating')) {
      await delay(500); snapshot = await request(root);
    }
  }
  if (options.json) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  else {
    if (snapshot.error) console.error('CLI update check failed. Try again.');
    if (snapshot.checking) console.log('Checking CLI updates…');
    for (const item of snapshot.items) console.log(`${item.agentId}\t${item.installedVersion ?? 'unknown'}\t${item.latestVersion ?? 'unknown'}\t${item.state}${item.reason ? ` (${item.reason})` : ''}`);
    if (!snapshot.items.length && !snapshot.checking && !snapshot.error) console.log('No update results yet. Run: od agent updates --check --wait');
  }
  if (options.wait && (snapshot.error || snapshot.items.some(item => item.state === 'error'))) process.exitCode = 1;
}
