import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliUpdateCommand } from '../../src/runtimes/cli-update-process.js';
import { isProcessAlive } from '@open-design/platform';

it.runIf(process.platform !== 'win32').each([true, false])('waits for the whole process tree even when the leader ignores TERM: %s', async (leaderIgnoresTerm) => {
  const root = mkdtempSync(join(tmpdir(), 'cli-update-process-'));
  const script = join(root, 'updater.cjs');
  const childPidFile = join(root, 'child.pid');
  writeFileSync(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');${leaderIgnoresTerm ? "process.on('SIGTERM',()=>{});" : ''}const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(process.argv[2],String(child.pid));setInterval(()=>{},1000);`);
  try {
    await expect(runCliUpdateCommand(process.execPath, [script, childPidFile], { env: process.env, timeoutMs: 700 })).rejects.toThrow('timed out');
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    expect(isProcessAlive(childPid)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
