import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import { opencodeAgentDef } from '../../src/runtimes/defs/opencode.js';
import { ensureDetectedRuntimeCapabilities } from '../../src/runtimes/detection.js';

// `opencode run --format json` drops every reasoning part unless `--thinking`
// is passed, so without it a run whose live-delta plugin is inactive shows no
// thinking at all. These pin when the user-installed OpenCode runtime sends
// the flag. (TokenToSea and BYOK run the bundled pi; see bundled-pi.test.ts.)

type Caps = Record<string, boolean> | undefined;
function setCaps(id: string, caps: Caps): void {
  if (caps) agentCapabilities.set(id, caps);
  else agentCapabilities.delete(id);
}

const roots: string[] = [];
afterEach(() => {
  agentCapabilities.delete('opencode');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('opencode run --thinking', () => {
  it.each([
    ['opencode', opencodeAgentDef],
  ] as const)('%s sends --thinking only once run --help advertises it', (id, def) => {
    expect(def.capabilityFlags['--thinking']).toBe('thinking');
    // Not probed yet, probe failed ({}), and an older CLI without the flag.
    for (const caps of [undefined, {}, { thinking: false }] satisfies Caps[]) {
      setCaps(id, caps);
      expect(def.buildArgs('', [], [], {})).not.toContain('--thinking');
    }
    agentCapabilities.set(id, { thinking: true });
    expect(def.buildArgs('', [], [], {})).toEqual(['run', '--format', 'json', '--thinking']);
  });

  it('gives OpenCode a cold-start budget for its version and help probes', () => {
    expect(opencodeAgentDef.versionProbeTimeoutMs).toBeGreaterThanOrEqual(15_000);
  });

  it.runIf(process.platform !== 'win32')(
    'detects --thinking from the stderr-only run --help of OpenCode 1.18',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'od-opencode-thinking-'));
      roots.push(root);
      const bin = join(root, 'opencode');
      // Verbatim excerpt of `opencode run --help` (1.18.18), which OpenCode
      // writes to stderr only. It no longer lists --dangerously-skip-permissions.
      writeFileSync(bin, [
        '#!/bin/sh',
        'if [ "$1" = "run" ] && [ "$2" = "--help" ]; then',
        "  printf '%s\\n' '      --variant      model variant (provider-specific reasoning effort, e.g., high, max, minimal)' >&2",
        "  printf '%s\\n' '      --thinking     show thinking blocks                                                  [boolean]' >&2",
        'fi',
        '',
      ].join('\n'));
      chmodSync(bin, 0o755);

      await expect(ensureDetectedRuntimeCapabilities('opencode', { OPENCODE_BIN: bin }))
        .resolves.toEqual({ skipPermissions: false, thinking: true });
      expect(opencodeAgentDef.buildArgs('', [], [], {}, { cwd: '/projects/p1' })).toEqual([
        'run', '--format', 'json', '--thinking', '--dir', '/projects/p1',
      ]);
    },
  );
});
