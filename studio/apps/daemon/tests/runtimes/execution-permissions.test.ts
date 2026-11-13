import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CHAT_EXECUTION_PERMISSIONS,
  supportsChatExecutionPermission,
} from '@open-design/contracts';
import { buildOpenCodeMcpConfigContent } from '../../src/mcp-config.js';
import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import {
  buildOpenCodeExecutionPermissionConfig,
  ensureStandalonePiWorkspaceGuardExtension,
  formatExecutionPermissionPromptDirective,
  prepareAmpPermissionSettingsFile,
} from '../../src/runtimes/execution-permission.js';
import { readLocalAgentProfileDefs } from '../../src/runtimes/local-profiles.js';
import { SHIPPED_AGENT_DEFS } from '../../src/runtimes/registry.js';

function getShippedDef(id: string) {
  const def = SHIPPED_AGENT_DEFS.find((entry) => entry.id === id);
  if (!def) throw new Error(`Missing shipped agent def: ${id}`);
  return def;
}

describe('execution permissions across all shipped runtimes and local profiles', () => {
  it('declares support for every one of the 27 shipped runtimes and rejects unknown ids', () => {
    expect(SHIPPED_AGENT_DEFS.length).toBeGreaterThanOrEqual(27);
    for (const def of SHIPPED_AGENT_DEFS) {
      expect(
        supportsChatExecutionPermission(def.id),
        `Expected supportsChatExecutionPermission('${def.id}') to be true`,
      ).toBe(true);
    }
    expect(supportsChatExecutionPermission('byok-opencode')).toBe(true);
    expect(supportsChatExecutionPermission('amr')).toBe(true);
    expect(supportsChatExecutionPermission('custom-local-profile', 'antigravity')).toBe(true);
    expect(supportsChatExecutionPermission('unknown-nonexistent-cli')).toBe(false);
    expect(supportsChatExecutionPermission('')).toBe(false);
    expect(supportsChatExecutionPermission(null)).toBe(false);
  });

  it('antigravity maps read-only, workspace-write, danger-full-access, and unset permissions accurately', () => {
    const agy = getShippedDef('antigravity');
    agentCapabilities.set('antigravity', {
      skipPermissions: true,
      modelFlag: true,
      modeFlag: true,
      sandboxFlag: true,
      addDir: true,
    });
    try {
      const unsetArgs = agy.buildArgs('', [], ['/ext/skills'], {}, {});
      expect(unsetArgs).toContain('--dangerously-skip-permissions');
      expect(unsetArgs).not.toContain('--mode');

      const roArgs = agy.buildArgs('', [], ['/ext/skills'], {}, { executionPermission: 'read-only' });
      expect(roArgs).not.toContain('--dangerously-skip-permissions');
      expect(roArgs).not.toContain('--add-dir');
      expect(roArgs).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']));

      const rwArgs = agy.buildArgs('', [], ['/ext/skills'], {}, { executionPermission: 'workspace-write' });
      expect(rwArgs).not.toContain('--dangerously-skip-permissions');
      expect(rwArgs).not.toContain('--add-dir');
      expect(rwArgs).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--sandbox']));

      const fullArgs = agy.buildArgs('', [], ['/ext/skills'], {}, { executionPermission: 'danger-full-access' });
      expect(fullArgs).toContain('--dangerously-skip-permissions');
      expect(fullArgs).toEqual(expect.arrayContaining(['--add-dir', '/ext/skills']));
    } finally {
      agentCapabilities.delete('antigravity');
    }
  });

  it('antigravity fails closed when --mode is explicitly unsupported on an old CLI build', () => {
    const agy = getShippedDef('antigravity');
    agentCapabilities.set('antigravity', {
      skipPermissions: true,
      modeFlag: false,
    });
    try {
      expect(() =>
        agy.buildArgs('', [], [], {}, { executionPermission: 'read-only' }),
      ).toThrow(/Update Antigravity CLI/);
    } finally {
      agentCapabilities.delete('antigravity');
    }
  });

  it('grok-build enforces permission modes and strips --always-approve when restricted', () => {
    const grok = getShippedDef('grok-build');
    const promptFilePath = '/tmp/od-grok/prompt.md';

    const defaultArgs = grok.buildArgs('', [], ['/ext/skills'], {}, { promptFilePath });
    expect(defaultArgs).toEqual(['--prompt-file', promptFilePath, '--no-plan', '--always-approve']);

    const roArgs = grok.buildArgs('', [], ['/ext/skills'], {}, {
      promptFilePath,
      executionPermission: 'read-only',
    });
    expect(roArgs).not.toContain('--always-approve');
    expect(roArgs).not.toContain('--no-plan');
    expect(roArgs).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'dontAsk',
        '--disallowed-tools',
        'Bash,Edit,Write,MultiEdit,NotebookEdit',
        '--disable-web-search',
        '--no-subagents',
      ]),
    );
    expect(roArgs).not.toContain('--add-dir');

    const rwArgs = grok.buildArgs('', [], ['/ext/skills'], {}, {
      promptFilePath,
      executionPermission: 'workspace-write',
    });
    expect(rwArgs).not.toContain('--always-approve');
    expect(rwArgs).toEqual(
      expect.arrayContaining([
        '--no-plan',
        '--permission-mode',
        'acceptEdits',
        '--disallowed-tools',
        'Bash',
        '--disable-web-search',
        '--no-subagents',
      ]),
    );

    const fullArgs = grok.buildArgs('', [], ['/ext/skills'], {}, {
      promptFilePath,
      executionPermission: 'danger-full-access',
    });
    expect(fullArgs).toEqual(
      expect.arrayContaining([
        '--always-approve',
        '--permission-mode',
        'bypassPermissions',
        '--add-dir',
        '/ext/skills',
      ]),
    );
  });

  it('enforces read-only, workspace-write, and danger-full-access across all remaining CLI adapters', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'od-exec-perm-test-'));
    try {
      const piGuardPath = await ensureStandalonePiWorkspaceGuardExtension(tempRoot);
      const ampRo = await prepareAmpPermissionSettingsFile({
        runtimeDataDir: tempRoot,
        runId: 'run-ro',
        permission: 'read-only',
        cwd: '/tmp/od-workspace',
      });
      const ampRw = await prepareAmpPermissionSettingsFile({
        runtimeDataDir: tempRoot,
        runId: 'run-rw',
        permission: 'workspace-write',
        cwd: '/tmp/od-workspace',
      });
      expect(JSON.parse(readFileSync(ampRo.settingsFilePath, 'utf8'))['amp.dangerouslyAllowAll']).toBe(false);
      expect(readFileSync(piGuardPath, 'utf8')).toContain('fantay_workspace_write');

      // cursor-agent
      const cursor = getShippedDef('cursor-agent');
      expect(cursor.buildArgs('', [], [], {}, { cwd: '/tmp/w', executionPermission: 'read-only' })).toEqual(
        expect.arrayContaining(['--mode', 'ask', '--sandbox', 'enabled']),
      );
      expect(cursor.buildArgs('', [], [], {}, { cwd: '/tmp/w', executionPermission: 'read-only' })).not.toContain('--force');
      expect(cursor.buildArgs('', [], [], {}, { cwd: '/tmp/w', executionPermission: 'workspace-write' })).toEqual(
        expect.arrayContaining(['--force', '--sandbox', 'enabled']),
      );
      expect(cursor.buildArgs('', [], [], {}, { cwd: '/tmp/w', executionPermission: 'danger-full-access' })).toEqual(
        expect.arrayContaining(['--force', '--sandbox', 'disabled']),
      );

      // standalone pi
      const pi = getShippedDef('pi');
      expect(pi.buildArgs('', [], [], {}, { executionPermission: 'read-only' })).toEqual([
        '--mode',
        'rpc',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--tools',
        'read,grep,find,ls',
      ]);
      expect(
        pi.buildArgs('', [], [], {}, {
          executionPermission: 'workspace-write',
          piGuardExtensionPath: piGuardPath,
        }),
      ).toEqual([
        '--mode',
        'rpc',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '-e',
        piGuardPath,
        '--tools',
        'read,grep,find,ls,fantay_workspace_edit,fantay_workspace_write',
      ]);

      // opencode & mimo
      agentCapabilities.set('opencode', { skipPermissions: true });
      agentCapabilities.set('mimo', { skipPermissions: true, dir: true });
      try {
        const opencode = getShippedDef('opencode');
        expect(opencode.buildArgs('', [], [], {}, { cwd: '/tmp/w', executionPermission: 'read-only' })).not.toContain(
          '--dangerously-skip-permissions',
        );
        expect(
          opencode.buildArgs('', [], [], {}, { cwd: '/tmp/w', executionPermission: 'danger-full-access' }),
        ).toContain('--dangerously-skip-permissions');

        const mimo = getShippedDef('mimo');
        expect(mimo.buildArgs('', [], [], {}, { cwd: '/tmp/w', executionPermission: 'workspace-write' })).toEqual([
          'run',
          '--format',
          'json',
          '--dir',
          '/tmp/w',
        ]);
        expect(mimo.buildArgs('', [], [], {}, { cwd: '/tmp/w', executionPermission: 'danger-full-access' })).toContain(
          '--dangerously-skip-permissions',
        );
      } finally {
        agentCapabilities.delete('opencode');
        agentCapabilities.delete('mimo');
      }

      // deepseek
      const deepseek = getShippedDef('deepseek');
      expect(deepseek.buildArgs('hi', [], [], {}, { executionPermission: 'read-only' })).toEqual([
        'exec',
        '--auto',
        '--sandbox=read-only',
        'hi',
      ]);
      expect(deepseek.buildArgs('hi', [], [], {}, { executionPermission: 'workspace-write' })).toEqual([
        'exec',
        '--auto',
        '--sandbox=workspace-write',
        'hi',
      ]);

      // codebuddy
      const codebuddy = getShippedDef('codebuddy');
      expect(codebuddy.buildArgs('', [], ['/ext'], {}, { executionPermission: 'read-only' })).toEqual(
        expect.arrayContaining(['--strict-mcp-config', '--tools', 'Read,Glob,Grep', '--permission-mode', 'plan']),
      );
      expect(codebuddy.buildArgs('', [], ['/ext'], {}, { executionPermission: 'read-only' })).not.toContain('--add-dir');
      expect(codebuddy.buildArgs('', [], ['/ext'], {}, { executionPermission: 'workspace-write' })).toEqual(
        expect.arrayContaining(['--tools', 'Read,Glob,Grep,Edit,Write', '--permission-mode', 'acceptEdits']),
      );

      // qoder
      const qoder = getShippedDef('qoder');
      const qoderRo = qoder.buildArgs('', [], ['/ext'], {}, { cwd: '/tmp/w', executionPermission: 'read-only' });
      expect(qoderRo).not.toContain('--yolo');
      expect(qoderRo).not.toContain('--add-dir');
      expect(qoderRo).toEqual(expect.arrayContaining(['--permission-mode', 'dont_ask', '--tools', 'Read,Glob,Grep']));
      const qoderRw = qoder.buildArgs('', [], ['/ext'], {}, { cwd: '/tmp/w', executionPermission: 'workspace-write' });
      expect(qoderRw).toEqual(
        expect.arrayContaining(['--permission-mode', 'accept_edits', '--tools', 'Read,Glob,Grep,Edit,Write']),
      );

      // copilot
      const copilot = getShippedDef('copilot');
      expect(copilot.buildArgs('', [], ['/ext'], {}, { executionPermission: 'read-only' })).toEqual([
        '--allow-tool=read',
        '--deny-tool=write',
        '--deny-tool=shell',
        '--output-format',
        'json',
      ]);
      expect(copilot.buildArgs('', [], ['/ext'], {}, { executionPermission: 'workspace-write' })).toEqual([
        '--allow-tool=read',
        '--allow-tool=write',
        '--deny-tool=shell',
        '--output-format',
        'json',
      ]);

      // qwen
      const qwen = getShippedDef('qwen');
      expect(qwen.buildArgs('', [], [], {}, { executionPermission: 'read-only' })).toEqual(['--approval-mode=plan']);
      expect(qwen.buildArgs('', [], [], {}, { executionPermission: 'workspace-write' })).toEqual([
        '--approval-mode=auto-edit',
        '--sandbox',
      ]);

      // aider
      const aider = getShippedDef('aider');
      expect(aider.buildArgs('hi', [], [], {}, { executionPermission: 'read-only' })).toEqual(
        expect.arrayContaining(['--chat-mode', 'ask', '--subtree-only']),
      );
      expect(aider.buildArgs('hi', [], [], {}, { executionPermission: 'workspace-write' })).toContain('--subtree-only');

      // amp
      const amp = getShippedDef('amp');
      expect(
        amp.buildArgs('', [], [], {}, {
          executionPermission: 'read-only',
          ampSettingsFilePath: ampRo.settingsFilePath,
        }),
      ).toEqual(['-x', '--stream-json', '--settings-file', ampRo.settingsFilePath]);
      expect(
        amp.buildArgs('', [], [], {}, {
          executionPermission: 'workspace-write',
          ampSettingsFilePath: ampRw.settingsFilePath,
        }),
      ).toEqual(['-x', '--stream-json', '--settings-file', ampRw.settingsFilePath]);

      // atomcode
      const atomcode = getShippedDef('atomcode');
      expect(
        atomcode.buildArgs('', [], [], {}, {
          cwd: '/tmp/w',
          promptFilePath: '/tmp/p.md',
          executionPermission: 'read-only',
        }),
      ).toEqual([
        '--prompt-file',
        '/tmp/p.md',
        '--disable-tools',
        'bash,edit,write,patch,web_fetch,web_search',
        '-C',
        '/tmp/w',
      ]);
      expect(
        atomcode.buildArgs('', [], [], {}, {
          cwd: '/tmp/w',
          promptFilePath: '/tmp/p.md',
          executionPermission: 'workspace-write',
        }),
      ).toEqual([
        '--prompt-file',
        '/tmp/p.md',
        '-y',
        '--disable-tools',
        'bash,web_fetch,web_search',
        '-C',
        '/tmp/w',
      ]);

      // ACP adapters with CLI-level permission flags
      expect(getShippedDef('devin').buildArgs('', [], [], {}, { executionPermission: 'read-only' })).toEqual([
        '--permission-mode',
        'normal',
        '--respect-workspace-trust',
        'false',
        'acp',
      ]);
      expect(getShippedDef('devin').buildArgs('', [], [], {}, { executionPermission: 'workspace-write' })).toEqual([
        '--permission-mode',
        'accept-edits',
        '--respect-workspace-trust',
        'false',
        'acp',
      ]);
      expect(getShippedDef('trae-cli').buildArgs('', [], [], {}, { executionPermission: 'read-only' })).toEqual([
        'acp',
        'serve',
      ]);
      expect(getShippedDef('hermes').buildArgs('', [], [], {}, { executionPermission: 'workspace-write' })).toEqual([
        'acp',
      ]);

      await ampRo.cleanup();
      await ampRw.cleanup();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('propagates baseAgentId and executionPermission to local agent profiles', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-local-profile-perm-'));
    const profileFile = path.join(dir, 'agents.local.json');
    const previous = process.env.OD_AGENT_PROFILES_CONFIG;
    process.env.OD_AGENT_PROFILES_CONFIG = profileFile;
    try {
      writeFileSync(
        profileFile,
        JSON.stringify([
          {
            id: 'team-grok',
            name: 'Team Grok',
            baseAgent: 'grok-build',
          },
        ]),
      );
      const [localDef] = readLocalAgentProfileDefs(SHIPPED_AGENT_DEFS);
      expect(localDef?.id).toBe('team-grok');
      expect(localDef?.baseAgentId).toBe('grok-build');
      expect(supportsChatExecutionPermission(localDef!.id, localDef!.baseAgentId)).toBe(true);
      for (const perm of CHAT_EXECUTION_PERMISSIONS) {
        const args = localDef!.buildArgs('', [], [], {}, {
          promptFilePath: '/tmp/p.md',
          executionPermission: perm,
        });
        expect(args[0]).toBe('--prompt-file');
      }
    } finally {
      if (previous === undefined) delete process.env.OD_AGENT_PROFILES_CONFIG;
      else process.env.OD_AGENT_PROFILES_CONFIG = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges OpenCode permission rules with external_directory workspace confinement', () => {
    const roJson = buildOpenCodeMcpConfigContent([], {}, {
      allowedDirectories: ['/tmp/od-project'],
      extraConfig: buildOpenCodeExecutionPermissionConfig('read-only'),
    });
    const roParsed = JSON.parse(roJson!);
    expect(roParsed.permission.read).toBe('allow');
    expect(roParsed.permission.edit).toBe('deny');
    expect(roParsed.permission.bash).toBe('deny');
    expect(roParsed.permission.external_directory['*']).toBe('deny');
    expect(roParsed.permission.external_directory['/tmp/od-project/**']).toBe('allow');

    const rwJson = buildOpenCodeMcpConfigContent([], {}, {
      allowedDirectories: ['/tmp/od-project'],
      extraConfig: buildOpenCodeExecutionPermissionConfig('workspace-write'),
    });
    const rwParsed = JSON.parse(rwJson!);
    expect(rwParsed.permission.edit).toBe('allow');
    expect(rwParsed.permission.bash).toBe('deny');
    expect(rwParsed.permission.external_directory['*']).toBe('deny');

    const fullJson = buildOpenCodeMcpConfigContent([], {}, {
      allowedDirectories: ['/tmp/od-project'],
      extraConfig: buildOpenCodeExecutionPermissionConfig('danger-full-access'),
    });
    const fullParsed = JSON.parse(fullJson!);
    expect(fullParsed.permission['*']).toBe('allow');
    expect(fullParsed.permission.external_directory['*']).toBe('allow');

    expect(formatExecutionPermissionPromptDirective('read-only', '/tmp/od-project')).toContain('read-only');
    expect(formatExecutionPermissionPromptDirective('workspace-write', '/tmp/od-project')).toContain('workspace-write');
    expect(formatExecutionPermissionPromptDirective('danger-full-access', '/tmp/od-project')).toBe('');
  });
});
