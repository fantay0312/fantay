// `cursor-agent models` takes ~2 s warm, and detection probes every CLI at
// once, so a probe can time out under load. Once a binary has answered, a
// later failed probe must reuse that live list instead of downgrading the
// picker to the static fallback (the "built-in list" users saw).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { detectAgent, resetLastLiveModelListsForTests } from '../../src/runtimes/detection.js';
import { cursorAgent, withEnvSnapshot } from './helpers/test-helpers.js';

const posixTest = process.platform === 'win32' ? test.skip : test;

afterEach(() => resetLastLiveModelListsForTests());

function writeCursorAgent(dir: string, modelsScript: string): void {
  const bin = join(dir, 'cursor-agent');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2026.11.05-test"; exit 0; fi',
      `if [ "$1" = "models" ]; then ${modelsScript}; fi`,
      'if [ "$1" = "status" ]; then echo "Authenticated"; exit 0; fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
}

posixTest('a failed model probe reuses the last live list from the same binary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-cursor-live-memory-'));
  try {
    await withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], async () => {
      process.env.PATH = dir;
      process.env.OD_AGENT_HOME = dir;

      writeCursorAgent(
        dir,
        'printf "%s\\n" "Available models" "" "claude-opus-5-5-low - Claude Opus 5.5 1M Low" "claude-opus-5-5-medium - Claude Opus 5.5 1M"; exit 0',
      );
      const first = await detectAgent(cursorAgent);
      expect(first.modelsSource).toBe('live');
      // The resolution-only catalog never reaches `/api/agents`.
      expect(first).not.toHaveProperty('modelCatalog');
      expect(first.models.map((model) => model.id)).toEqual(['default', 'claude-opus-5-5']);

      writeCursorAgent(dir, 'echo "boom" >&2; exit 1');
      const second = await detectAgent(cursorAgent);
      expect(second.modelsSource).toBe('live');
      expect(second.models).toEqual(first.models);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

posixTest('a binary that never answered still gets the static fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-cursor-live-memory-none-'));
  try {
    await withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], async () => {
      process.env.PATH = dir;
      process.env.OD_AGENT_HOME = dir;
      writeCursorAgent(dir, 'echo "No models available for this account."; exit 0');
      const detected = await detectAgent(cursorAgent);
      expect(detected.modelsSource).toBe('fallback');
      expect(detected.models.map((model) => model.id)).toEqual(cursorAgent.fallbackModels.map((model) => model.id));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
