import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SideDialogueRequest } from '@open-design/contracts';
import { isByokAgentId } from '@open-design/contracts';
import { getAgentDef } from '../agents.js';
import { validateUserProviderBaseUrl } from '../connectionTest.js';
import { tokenToSeaLeaseProvider } from '../integrations/tokentosea-pi-provider.js';
import { tokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';
import { sideDialoguePrompt } from '../prompts/side-dialogue.js';
import { assertRuntimeEnabled } from './access-policy.js';
import { buildByokPiProvider, BUNDLED_PI_PROVIDER_ID, prepareBundledPiRunHome, type BundledPiProvider } from './bundled-pi.js';
import { spawnEnvForAgent } from './env.js';
import { resolveBundledPiExecutable } from './executables.js';
import { createPaModelRuntime } from './personal-agent.js';

async function bundledText(
  dataDir: string, agentId: string, accountKey: string, runId: string, provider: BundledPiProvider,
  prompt: ReturnType<typeof sideDialoguePrompt>, signal: AbortSignal,
): Promise<string> {
  const bin = resolveBundledPiExecutable();
  if (!bin) throw new Error('Fantay 内置模型运行器不可用。');
  const home = await prepareBundledPiRunHome({ runtimeDataDir: dataDir, agentId, accountKey, runId, provider, mcp: null });
  try {
    signal.throwIfAborted();
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(bin, [
        '--print', '--no-session', '--no-tools', '--no-mcp', '--no-extensions', '--no-skills',
        '--no-prompt-templates', '--no-context-files', '--no-themes', '--offline',
        '--provider', BUNDLED_PI_PROVIDER_ID, '--model', provider.modelId,
        ...(provider.thinking ? ['--thinking', provider.thinking] : []), '--system-prompt', prompt.system,
      ], {
        cwd: home.agentDir, env: { ...spawnEnvForAgent(agentId, process.env), ...home.env },
        signal, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
      }, (error, stdout) => {
        if (error) reject(new Error('所选模型调用失败，请检查渠道连接、登录和额度。'));
        else resolve(stdout);
      });
      child.stdin?.on('error', () => { /* An early process exit is reported by execFile. */ });
      child.stdin?.end(prompt.user);
    });
  } finally { await home.cleanup(); }
}

export async function runSideDialogue(input: SideDialogueRequest, dataDir: string, origin: string, signal: AbortSignal) {
  const agentId = isByokAgentId(input.agent) ? 'byok' : input.agent;
  const def = getAgentDef(agentId);
  if (!def) throw new Error('所选模型渠道不可用。');
  assertRuntimeEnabled(def);
  const runId = randomUUID();
  const prompt = sideDialoguePrompt(input);
  if (agentId === 'tokentosea') {
    const lease = await tokenToSeaRuntime().createInferenceLease(input.model, { localRunId: runId, ...(input.projectId && { projectId: input.projectId }) }, input.reasoning);
    try {
      return await bundledText(dataDir, agentId, lease.userKey, runId, tokenToSeaLeaseProvider(lease, origin), prompt, signal);
    } finally { lease.release(); }
  }
  if (agentId === 'byok') {
    if (input.byok?.baseUrl && (await validateUserProviderBaseUrl(input.byok.baseUrl)).error) throw new Error('渠道地址不可用。');
    const provider = buildByokPiProvider(input.byok as Parameters<typeof buildByokPiProvider>[0], input.model);
    if (!provider) throw new Error('请在设置中补全渠道地址、模型和凭据。');
    return bundledText(dataDir, agentId, 'local', runId, provider, prompt, signal);
  }
  const runtime = createPaModelRuntime(dataDir);
  const result = await runtime.execute({ runtime: agentId, modelId: input.model }, prompt.system + '\n\n' + prompt.user, runId, signal, {
    choice: { ...(input.reasoning && { reasoning: input.reasoning }), ...(input.serviceTier && { serviceTier: input.serviceTier }) },
    chat: { system: prompt.system, messages: [{ role: 'user', content: prompt.user }], transcript: prompt.user, stop: [] },
  });
  return result.text;
}
