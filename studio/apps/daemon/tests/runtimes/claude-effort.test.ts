import { afterEach, describe, expect, it } from 'vitest';

import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
import { withClaudeExecutionMode } from '../../src/runtimes/claude-mode.js';

afterEach(() => agentCapabilities.delete('claude'));

const argsFor = (reasoning?: string) =>
  claudeAgentDef.buildArgs('', [], [], reasoning ? { reasoning } : {}, {});

describe('claude --effort', () => {
  it('passes the chosen level', () => {
    agentCapabilities.set('claude', { effort: true });
    expect(argsFor('max').join(' ')).toContain('--effort max');
  });

  it('leaves the flag off for the CLI default and on builds without it', () => {
    agentCapabilities.set('claude', { effort: true });
    expect(argsFor('default')).not.toContain('--effort');
    expect(argsFor()).not.toContain('--effort');
    agentCapabilities.set('claude', {});
    expect(argsFor('high')).not.toContain('--effort');
  });

  it('survives the TUI transport, which strips only print-mode flags', () => {
    agentCapabilities.set('claude', { effort: true });
    const tui = withClaudeExecutionMode(claudeAgentDef, 'tui');
    expect(tui.buildArgs('', [], [], { reasoning: 'low' }, {}).join(' ')).toContain('--effort low');
  });
});
