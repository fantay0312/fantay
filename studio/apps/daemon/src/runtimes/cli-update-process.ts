import { spawn } from 'node:child_process';
import os from 'node:os';
import { createCommandInvocation, terminateProcessGroup } from '@open-design/platform';
import { execAgentFile } from './invocation.js';

/** Bounded, noninteractive updates; neither shell strings nor installer output reach the UI. */
export function runCliUpdateCommand(command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const invocation = createCommandInvocation({ command, args, env: options.env });
    const child = spawn(invocation.command, invocation.args, {
      env: options.env, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true,
      ...(invocation.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
    });
    let bytes = 0;
    let stopping = false;
    let termination: Promise<void> | null = null;
    let failure: Error | null = null;
    const onExit = () => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    };
    process.once('exit', onExit);
    const stop = (reason: string) => {
      if (stopping) return;
      stopping = true; failure = new Error(reason);
      termination = (async () => {
        if (child.pid) {
          if (process.platform === 'win32') await execAgentFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000 }).catch(() => child.kill('SIGKILL'));
          else await terminateProcessGroup(child.pid, { termGraceMs: 500, killGraceMs: 1_000 });
        }
      })().catch(() => { child.kill('SIGKILL'); });
    };
    const timer = setTimeout(() => void stop('CLI update timed out'), options.timeoutMs);
    const consume = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) void stop('CLI update output limit exceeded'); };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', error => { failure = error; });
    child.once('close', async code => {
      // The group leader can exit before a child using ignored stdio. Keep the
      // update lock until group termination, not merely the leader's close.
      await termination;
      clearTimeout(timer); process.removeListener('exit', onExit);
      if (failure || code !== 0) reject(failure ?? new Error(`CLI updater exited ${code}`));
      else resolve();
    });
  });
}
