import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupTestArtifacts } from './fantay-test-cleanup.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [mode, ...input] = process.argv.slice(2);
const args = input[0] === '--' ? input.slice(1) : input;
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const reportDir = join(root, '.tmp', 'test-records', runId);

if (!['run', 'clean'].includes(mode ?? '') || (mode === 'run' && args.length === 0)) {
  console.error('Usage: fantay-test.ts run -- <command> [args...] | clean');
  process.exitCode = 2;
} else {
  await mkdir(reportDir, { recursive: true });
  let exitCode = 0;
  if (mode === 'run') {
    const output = createWriteStream(join(reportDir, 'test.log'));
    const child = spawn(args[0]!, args.slice(1), { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.stdout!.on('data', (chunk: Buffer) => { process.stdout.write(chunk); output.write(chunk); });
    child.stderr!.on('data', (chunk: Buffer) => { process.stderr.write(chunk); output.write(chunk); });
    const interrupt = (signal: NodeJS.Signals) => {
      if (child.pid == null) return;
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch { /* Already exited. */ }
    };
    const onInterrupt = () => interrupt('SIGINT');
    const onTerminate = () => interrupt('SIGTERM');
    process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
    exitCode = await new Promise<number>((resolve) => {
      child.once('error', (error) => { output.write(`${error.message}\n`); resolve(127); });
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
    await new Promise<void>((resolve) => output.end(resolve));
  }
  try {
    const cleanup = await cleanupTestArtifacts({ workspaceRoot: root });
    await writeFile(join(reportDir, 'result.json'), JSON.stringify({ exitCode, cleanup, completedAt: new Date().toISOString() }, null, 2));
    console.log(`Test records: ${reportDir}\nCleanup: ${cleanup.removed.length} removed, ${cleanup.skipped.length} retained for safety`);
  } catch (error) {
    console.error(`Test cleanup failed: ${String(error)}`);
    if (exitCode === 0) exitCode = 1;
  }
  process.exitCode = exitCode;
}
