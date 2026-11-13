import { spawn } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createCommandInvocation, isProcessGroupAlive } from '@open-design/platform';
import type { PaModel } from '@open-design/contracts';
import { getAgentDef, resolveAgentLaunch, spawnEnvForAgent, applyAgentLaunchEnv } from '../agents.js';
import { agentCliEnvForAgent, readAppConfig } from '../app-config.js';
import { attachAcpSession, attachPiRpcSession, attachDshProfileSession } from '../agent-protocol/index.js';
import { createClaudeStreamHandler } from './claude-stream.js';
import { createJsonEventStreamHandler } from './json-event-stream.js';
import { createQoderStreamHandler } from './qoder-stream.js';
import { createCopilotStreamHandler } from '../copilot-stream.js';
import { CODEX_RESTRICTED_TOOL_ARGS, codexRestrictedMcpArgs } from './defs/codex.js';
import { acquireAntigravityModelLock, antigravityTakesModelFlag, resolveAntigravityConcreteModel, waitForAgyToReadModel } from './defs/antigravity.js';
import { buildOpenCodeExecutionPermissionConfig, prepareAmpPermissionSettingsFile } from './execution-permission.js';
import { loadMmdRouteLaunchEnv } from './mmd-routes.js';
import { sanitizeCustomModel } from './models.js';
import { checkPromptArgvBudget } from './prompt-budget.js';
import { PaError } from '../storage/personal-agent-store.js';
import type { PaModelResult } from './personal-agent.js';

const MAX_OUTPUT = 2 * 1024 * 1024;

/** Runs the same installed adapters as chat in an isolated, read-only PA work directory. */
export async function executePaLocalModel(
  dataDir: string,
  model: PaModel,
  prompt: string,
  runId: string,
  signal: AbortSignal,
  terminate: (pid: number) => Promise<boolean>,
): Promise<PaModelResult> {
  const def = getAgentDef(model.runtime);
  if (!def || ['tokentosea', 'byok'].includes(def.id)) {
    throw new PaError('本地模型运行器不可用，请重新选择模型', 503, 'PA_MODEL_UNAVAILABLE');
  }
  if (!sanitizeCustomModel(model.modelId)) throw new PaError('无效的模型名称');
  const promptBudget = checkPromptArgvBudget(def, prompt);
  if (promptBudget) throw new PaError(promptBudget.message, 413, 'PA_INVALID_INPUT');
  const config = await readAppConfig(dataDir);
  const configured = agentCliEnvForAgent(config.agentCliEnv, def.id);
  const launch = resolveAgentLaunch(def, configured);
  if (!launch.launchPath) throw new PaError(`${def.name} 尚未安装`, 503, 'PA_MODEL_UNAVAILABLE');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new PaError('无效的执行标识');
  const baseId = def.baseAgentId ?? def.id;
  const root = path.join(dataDir, 'pa', 'execution');
  const cwd = path.join(root, 'work', runId);
  const stampPath = path.join(root, 'processes', `${runId}.json`);
  await Promise.all([
    mkdir(cwd, { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(stampPath), { recursive: true, mode: 0o700 }),
  ]);
  const ampSettings = baseId === 'amp' ? await prepareAmpPermissionSettingsFile({
    runtimeDataDir: dataDir, runId, permission: 'read-only', cwd,
  }) : null;
  let releaseModelLock: (() => void) | undefined;
  let spawned = false;
  try {
    const promptFilePath = path.join(cwd, 'prompt.txt');
    if (def.promptViaFile) await writeFile(promptFilePath, prompt, { mode: 0o600 });
    let env = applyAgentLaunchEnv(spawnEnvForAgent(def.id, {
      ...process.env, ...def.env,
    }, configured, undefined, { resolvedBin: launch.selectedPath }), launch);
    const routeEnv = baseId === 'claude' ? await loadMmdRouteLaunchEnv(env, model.modelId) : null;
    if (routeEnv) env = { ...env, ...routeEnv };
    const permissionConfig = JSON.stringify(buildOpenCodeExecutionPermissionConfig('read-only'));
    if (['opencode', 'mimo', 'kilo'].includes(baseId)) {
      env.OPENCODE_CONFIG_CONTENT = permissionConfig;
      if (baseId === 'mimo') env.MIMOCODE_CONFIG_CONTENT = permissionConfig;
      if (baseId === 'kilo') env.KILO_CONFIG_CONTENT = permissionConfig;
    }
    if (baseId === 'deepseek-harness') env.OD_DSH_TOOL_POLICY = 'read-only';
    const logFilePath = path.join(cwd, 'agent.log');
    const antigravityModel = baseId === 'antigravity' ? resolveAntigravityConcreteModel({ model: model.modelId }) : null;
    if (antigravityModel && !antigravityTakesModelFlag(antigravityModel)) {
      releaseModelLock = await acquireAntigravityModelLock();
    }
    const args = def.buildArgs(def.promptViaStdin || def.promptViaFile ? '' : prompt, [], [], {
      model: model.modelId,
    }, {
      cwd, executionPermission: 'read-only', disablePlugins: true,
      promptFilePath, ampSettingsFilePath: ampSettings?.settingsFilePath,
      agentLogFilePath: logFilePath,
    });
    if (baseId === 'codex') {
      args.splice(1, 0, ...CODEX_RESTRICTED_TOOL_ARGS, ...await codexRestrictedMcpArgs(launch.launchPath, cwd, env));
    }
    signal.throwIfAborted();
    const invocation = createCommandInvocation({ command: launch.launchPath, args, env });
    return await new Promise<PaModelResult>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd, env, windowsHide: true, detached: process.platform !== 'win32',
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      spawned = Boolean(child.pid);
      if (releaseModelLock && antigravityModel) {
        const watcherAbort = new AbortController();
        child.once('exit', () => { watcherAbort.abort(); releaseModelLock?.(); });
        child.once('error', () => { watcherAbort.abort(); releaseModelLock?.(); });
        void waitForAgyToReadModel(logFilePath, antigravityModel, { abortSignal: watcherAbort.signal })
          .then((applied) => { if (applied) releaseModelLock?.(); });
      }
      let text = '';
      let outputBytes = 0;
      let stderr = '';
      let failure: PaError | null = null;
      let usage: PaModelResult['usage'] = { visibility: 'unknown' };
      let termination: Promise<boolean> | undefined;
      let session: { completedSuccessfully(): boolean; abort(): void } | undefined;
      const decoder = new StringDecoder('utf8');
      const stop = () => {
        termination ??= child.pid ? terminate(child.pid) : Promise.resolve(false);
        return termination;
      };
      const abort = () => { session?.abort(); void stop(); };
      const receive = (event: Record<string, unknown>) => {
        if (event.type === 'text_delta' && typeof event.delta === 'string') text += event.delta;
        if (event.type === 'error') {
          failure = new PaError(`${def.name} 调用失败，请检查模型登录与配置`, 503, 'PA_MODEL_UNAVAILABLE');
          void stop();
        }
        if (event.type === 'usage' && event.usage && typeof event.usage === 'object') {
          const value = event.usage as Record<string, unknown>;
          usage = {
            inputTokens: typeof value.input_tokens === 'number' ? value.input_tokens : undefined,
            outputTokens: typeof value.output_tokens === 'number' ? value.output_tokens : undefined,
            costUsd: typeof event.costUsd === 'number' ? String(event.costUsd) : undefined,
            visibility: 'reported',
          };
        }
      };
      const send = (event: string, payload: unknown) => {
        if (event === 'agent' && payload && typeof payload === 'object') receive(payload as Record<string, unknown>);
        else if (event === 'error') receive({ type: 'error' });
      };
      const parser = def.streamFormat === 'claude-stream-json' ? createClaudeStreamHandler(receive)
        : def.streamFormat === 'qoder-stream-json' ? createQoderStreamHandler(receive)
        : def.streamFormat === 'copilot-stream-json' ? createCopilotStreamHandler(receive)
        : def.streamFormat === 'json-event-stream' ? createJsonEventStreamHandler(def.eventParser ?? baseId, receive)
        : null;
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_OUTPUT) {
          failure = new PaError('模型输出超过本次任务上限', 413, 'PA_INVALID_OUTPUT');
          void stop();
          return;
        }
        const decoded = decoder.write(chunk);
        if (parser) parser.feed(decoded);
        else if (def.streamFormat === 'plain') text += decoded;
      });
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-1000); });
      child.stdin.on('error', () => { /* close supplies the final outcome */ });
      child.once('error', (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
      child.once('close', async (code) => {
        signal.removeEventListener('abort', abort);
        const tail = decoder.end();
        if (parser) { parser.feed(tail); parser.flush(); }
        else if (def.streamFormat === 'plain') text += tail;
        const stopped = termination ? await termination
          : !isProcessGroupAlive(child.pid) || await terminate(child.pid!);
        if (!stopped) return reject(new PaError('执行进程停止结果待核对', 409, 'PA_STOP_UNKNOWN'));
        await rm(stampPath, { force: true });
        if (signal.aborted) return reject(new PaError('执行已停止', 409, 'PA_CANCEL_CONFIRMED'));
        if (failure) return reject(failure);
        if (session ? !session.completedSuccessfully() : code !== 0) {
          const network = /ECONN|ENOTFOUND|EAI_AGAIN|network|connection error|timed out/i.test(stderr);
          return reject(new PaError(network ? '模型网络连接中断，请恢复网络后继续'
            : `${def.name} 执行失败，请检查模型登录与配置`, 503, network ? 'PA_NETWORK' : 'PA_MODEL_UNAVAILABLE'));
        }
        if (!text.trim()) return reject(new PaError('模型没有返回有效文本', 503, 'PA_MODEL_UNAVAILABLE'));
        resolve({ text, usage, resolvedModel: model.modelId });
      });
      try {
        if (child.pid) writeFileSync(stampPath, JSON.stringify({ pid: child.pid }), { mode: 0o600, flag: 'wx', flush: true });
        signal.throwIfAborted();
        if (def.streamFormat === 'acp-json-rpc') {
          session = attachAcpSession({
            child, cwd, prompt, model: model.modelId, send,
            executionPermission: 'read-only', mcpServers: [],
            envFormat: def.acpMcpEnvFormat ?? 'array',
            ...(def.acpStdioMcpRemovedInVersion ? { stdioMcpRemovedInVersion: def.acpStdioMcpRemovedInVersion } : {}),
          });
        } else if (def.streamFormat === 'pi-rpc') {
          session = attachPiRpcSession({ child, cwd, prompt, model: model.modelId, send, executionPermission: 'read-only' });
        } else if (def.streamFormat === 'dsh-profile-jsonl') {
          session = attachDshProfileSession({ child, cwd, prompt, model: model.modelId, send, requestId: runId });
        } else if (def.promptInputFormat === 'stream-json') {
          child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
        } else {
          child.stdin.end(def.promptViaStdin ? def.encodeStdinPrompt?.(prompt) ?? prompt : undefined);
        }
      } catch {
        failure = new PaError('无法启动本地模型执行', 503, 'PA_MODEL_UNAVAILABLE');
        void stop();
      }
    });
  } finally {
    if (!spawned) releaseModelLock?.();
    // Keep work files until process ownership is confirmed stopped.
    if (await access(stampPath).then(() => false, () => true)) {
      await ampSettings?.cleanup();
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
