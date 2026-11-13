import { afterEach, describe, expect, it, vi } from 'vitest';
const invoked = vi.hoisted(()=>vi.fn());
vi.mock('../../src/runtimes/invocation.js',()=>({execAgentFile:invoked}));
import { runtimeDisabledReason, preferredAvailableAgent, skipRuntimeProbe } from '../../src/runtimes/access-policy.js';
import { detectAgent, ensureDetectedRuntimeVersions, ensureDetectedRuntimeCapabilities } from '../../src/runtimes/detection.js';
import { resolveAgentLaunch } from '../../src/runtimes/launch.js';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
afterEach(()=>{vi.unstubAllEnvs();invoked.mockClear();});
describe('Installation agent policy',()=>{
  it('can skip automatic Claude probing without disabling its execution',async()=>{
    vi.stubEnv('OD_DISABLED_AGENTS','');vi.stubEnv('OD_SKIP_AGENT_PROBES','claude');
    expect(skipRuntimeProbe(claudeAgentDef)).toBe(true);expect(runtimeDisabledReason(claudeAgentDef)).toBeNull();
    await detectAgent(claudeAgentDef);expect(invoked).not.toHaveBeenCalled();
  });
  it('blocks Claude and derived profiles before a version, capability or execution probe',async()=>{
    vi.stubEnv('OD_DISABLED_AGENTS','claude');
    expect(runtimeDisabledReason({...claudeAgentDef,id:'custom-claude'})).toBeTruthy();
    expect((await detectAgent(claudeAgentDef)).available).toBe(false);
    expect(await ensureDetectedRuntimeVersions('claude')).toBeNull();
    expect(await ensureDetectedRuntimeCapabilities('claude')).toBeNull();
    expect(()=>resolveAgentLaunch(claudeAgentDef)).toThrow('disabled');
    expect(invoked).not.toHaveBeenCalled();
  });
  it('does not silently replace the requested default when it is unavailable',()=>{
    vi.stubEnv('OD_PREFERRED_AGENT','deepseek-harness');
    expect(preferredAvailableAgent([{id:'codex',available:true},{id:'deepseek-harness',available:false}])).toBeUndefined();
    expect(preferredAvailableAgent([{id:'codex',available:true},{id:'deepseek-harness',available:true}])?.id).toBe('deepseek-harness');
  });
});
