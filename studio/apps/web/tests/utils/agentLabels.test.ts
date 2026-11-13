import { describe, expect, it } from 'vitest';

import {
  agentDisplayName,
  agentIconId,
  agentModelDisplayName,
  exactAgentDisplayName,
} from '../../src/utils/agentLabels';

describe('agentDisplayName', () => {
  it('returns the canonical label for known agent ids', () => {
    expect(agentDisplayName('claude')).toBe('Claude');
    expect(agentDisplayName('codex')).toBe('Codex');
    expect(agentDisplayName('cursor-agent')).toBe('Cursor');
    expect(agentDisplayName('deepseek-harness')).toBe('DeepSeek Harness');
    expect(agentDisplayName('kimi')).toBe('Kimi CLI');
  });

  it('resolves common aliases like "claude code" and "qodercli"', () => {
    expect(agentDisplayName('Claude Code')).toBe('Claude');
    expect(agentDisplayName('qodercli')).toBe('Qoder');
    expect(agentDisplayName('DeepSeek Harness')).toBe('DeepSeek Harness');
  });

  it('matches embedded substrings such as cursor-agent in a longer path', () => {
    expect(agentDisplayName('/opt/bin/cursor-agent')).toBe('Cursor');
  });

  it('falls back to a trimmed name when the id is unknown but the fallback is safe', () => {
    expect(agentDisplayName('unknown-id', '  My Bot  ')).toBe('My Bot');
  });

  it('rejects path-like id and fallback so unknown filesystem hints do not leak', () => {
    expect(agentDisplayName('/opt/unknown/runner', 'C:\\Tools\\runner.exe')).toBeNull();
  });

  it('returns null when both id and fallback are missing', () => {
    expect(agentDisplayName(undefined, null)).toBeNull();
  });

  it('resolves "kiro cli" and "kiro-cli" aliases to Kiro', () => {
    expect(agentDisplayName('kiro cli')).toBe('Kiro');
    expect(agentDisplayName('kiro-cli')).toBe('Kiro');
  });
});

describe('exactAgentDisplayName', () => {
  it('returns the label only when the exact normalized key is a known agent', () => {
    expect(exactAgentDisplayName('Qoder CLI')).toBe('Qoder');
    expect(exactAgentDisplayName('qodercli.cmd')).toBe('Qoder');
    expect(exactAgentDisplayName('cursor-agent-fork')).toBeNull();
  });

  it('returns null for empty or nullish input', () => {
    expect(exactAgentDisplayName(null)).toBeNull();
    expect(exactAgentDisplayName('')).toBeNull();
  });

  it('returns "Kiro" for exact id "kiro"', () => {
    expect(exactAgentDisplayName('kiro')).toBe('Kiro');
    expect(exactAgentDisplayName('Kiro')).toBe('Kiro');
  });

  it('resolves kiro-related aliases through exactAgentDisplayName (consistent with Qoder CLI)', () => {
    expect(exactAgentDisplayName('kiro cli')).toBe('Kiro');
    expect(exactAgentDisplayName('kiro-cli')).toBe('Kiro');
  });
});

describe('agentModelDisplayName', () => {
  it('omits the model when it is undefined or the literal "default"', () => {
    expect(agentModelDisplayName('claude', 'Claude Code', undefined)).toBe('Claude');
    expect(agentModelDisplayName('claude', 'Claude Code', 'default')).toBe('Claude');
  });

  it('joins the agent label and model with a middle dot', () => {
    expect(agentModelDisplayName('codex', null, 'gpt-5.4')).toBe('Codex · gpt-5.4');
  });

  it('returns just the model id when no agent label can be derived', () => {
    expect(agentModelDisplayName(null, null, 'sonnet-4-6')).toBe('sonnet-4-6');
  });
});

describe('built-in agents are not OpenCode', () => {
  // `byok-opencode` is a legacy id; the built-in BYOK agent runs on pi. The separate
  // third-party `opencode` agent keeps its own label and mark.
  it('labels the BYOK agent "BYOK", not by the opencode substring in its id', () => {
    expect(agentDisplayName('byok-opencode')).toBe('BYOK');
    expect(agentDisplayName('byok-opencode', 'BYOK OpenCode')).toBe('BYOK');
    expect(agentModelDisplayName('byok-opencode', 'BYOK', 'gpt-5.4')).toBe('BYOK · gpt-5.4');
  });

  it('reads a conversation saved under the old "BYOK OpenCode" name as BYOK too', () => {
    expect(agentDisplayName(null, 'BYOK OpenCode')).toBe('BYOK');
    expect(exactAgentDisplayName('BYOK OpenCode')).toBe('BYOK');
    expect(agentDisplayName(null, 'BYOK OpenCode · gpt-5.4')).toBe('BYOK');
  });

  it('never resolves the BYOK agent to the OpenCode logo', () => {
    expect(agentIconId('byok-opencode')).not.toBe('opencode');
    expect(agentIconId('byok-opencode', 'BYOK OpenCode')).not.toBe('opencode');
    expect(agentIconId(null, 'BYOK OpenCode · gpt-5.4')).not.toBe('opencode');
  });

  it('keeps the third-party OpenCode agent as OpenCode', () => {
    expect(agentDisplayName('opencode')).toBe('OpenCode');
    expect(agentDisplayName('OpenCode')).toBe('OpenCode');
    expect(agentIconId('opencode')).toBe('opencode');
  });

  it('keeps TokenToSea as TokenToSea with its own logo', () => {
    expect(agentDisplayName('tokentosea')).toBe('TokenToSea');
    expect(agentIconId('tokentosea')).toBe('tokentosea');
  });
});
