import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatRunService } from '../../src/runtimes/runs.js';

// runs.ts is intentionally @ts-nocheck and its inferred public factory type is
// narrower than its runtime options/records. Keep this test adapter local.
const createRuns = (options: Record<string, unknown>): any =>
  createChatRunService(options as never);

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('run terminal finalizer', () => {
  it('persists artifact metadata added by the terminal finalizer before publishing end', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-run-finalizer-'));
    const runs = createRuns({
      createSseResponse: () => ({ send: vi.fn(), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      runsLogDir: path.join(tempDir, 'runs'),
    });
    const run = runs.create({ agentId: 'tokentosea' });
    run.onFinalize = () => {
      run.artifactCount = 2;
      run.artifactPaths = ['artifacts/index.html', 'artifacts/preview.png'];
    };

    runs.finish(run, 'failed', 1, null);

    expect(run.events.at(-1)).toMatchObject({
      event: 'end',
      data: {
        artifactCount: 2,
        artifactPaths: ['artifacts/index.html', 'artifacts/preview.png'],
      },
    });
    expect(JSON.parse(fs.readFileSync(run.statePath, 'utf8'))).toMatchObject({
      status: 'failed',
      artifactCount: 2,
      artifactPaths: ['artifacts/index.html', 'artifacts/preview.png'],
    });
  });
});
