import { spawn } from "node:child_process";
import { mkdir, readFile, rm, unlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Agent, fetch as fetchDirect, type RequestInit as DirectRequestInit } from "undici";
import { isPaLocalCliModel, type PaAttempt, type PaDataClass, type PaModel, type PaModelOption } from "@open-design/contracts";
import {
  createCommandInvocation,
  terminateProcessGroup,
  captureProcessSnapshot,
  collectProcessTreePids,
  stopProcesses,
  isProcessGroupAlive,
} from "@open-design/platform";
import {
  getAgentDef,
  resolveAgentLaunch,
  spawnEnvForAgent,
  applyAgentLaunchEnv,
  detectAgents,
} from "../agents.js";
import { agentCliEnvForAgent, readAppConfig } from "../app-config.js";
import {
  tokenToSeaAgentOutputLimit,
  tokenToSeaRuntime,
} from "../integrations/tokentosea-runtime.js";
import { tokenToSeaNativeChat } from "../integrations/tokentosea-native-chat.js";
import { tokenToSeaNativePath } from "../integrations/tokentosea-claude.js";
import { PaError } from "../storage/personal-agent-store.js";
import { loadMmdRouteLaunchEnv } from "./mmd-routes.js";
import { executePaLocalModel } from "./personal-agent-local.js";

export interface PaModelResult {
  text: string;
  usage: PaAttempt["usage"];
  resolvedModel?: string | undefined;
  workerReceipt?: NonNullable<PaAttempt["workerReceipt"]>;
}
export interface PaModelRuntime {
  models(): Promise<PaModelOption[]>;
  accountId?(): string | undefined;
  reconcile?(model: PaModel, runId: string): Promise<'running' | 'stopped' | 'unknown'>;
  execute(
    model: PaModel,
    prompt: string,
    runId: string,
    signal: AbortSignal,
    limits?: { dataClass?: PaDataClass; maxCostUsd?: number },
  ): Promise<PaModelResult>;
}

const MAX_OUTPUT = 2 * 1024 * 1024;
const directOllama = new Agent();
const ollamaFetch = (endpoint: "tags" | "status" | "chat", options: DirectRequestInit = {}) =>
  fetchDirect(`http://127.0.0.1:11434/api/${endpoint}`, {
    ...options, redirect: "error", dispatcher: directOllama,
  });

async function boundedResponse(response: Response | Awaited<ReturnType<typeof fetchDirect>>): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes).toString("utf8");
      if ((bytes += value.byteLength) > MAX_OUTPUT) {
        void reader.cancel().catch(() => undefined);
        throw new PaError("模型输出超过上限", 413, "PA_INVALID_OUTPUT");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
}

async function localOllamaModel(modelId: string, signal: AbortSignal): Promise<string> {
  try {
    if (/(:cloud|-cloud)(?:$|:)/i.test(modelId)) throw new Error("cloud model");
    const response = await ollamaFetch("status", { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    const data = response.ok ? JSON.parse(await boundedResponse(response)) as { cloud?: { disabled?: boolean } } : null;
    if (data?.cloud?.disabled !== true) throw new Error("cloud status unavailable or enabled");
    if (modelId.endsWith(":local")) return modelId;
    const name = modelId.split("/").at(-1)!;
    return `${modelId}${name.includes(":") ? "" : ":latest"}:local`;
  } catch {
    signal.throwIfAborted();
    throw new PaError("请关闭 Ollama 云功能，并选择支持本机模式的已下载模型", 409, "PA_ROUTE_DENIED");
  }
}
export async function terminatePaProcess(pid: number): Promise<boolean> {
  try {
    if (process.platform !== "win32")
      return !(
        await terminateProcessGroup(pid, {
          termGraceMs: 1500,
          killGraceMs: 1500,
        })
      ).survived;
    const before = await captureProcessSnapshot({ timeoutMs: 2000 });
    if (!before.length) return false;
    const owned = collectProcessTreePids(before, [pid]);
    await stopProcesses(owned, { termGraceMs: 1500, killGraceMs: 1500 });
    const after = await captureProcessSnapshot({ timeoutMs: 2000 });
    if (!after.length) return false;
    const live = new Set(after.map((item) => item.pid));
    return !collectProcessTreePids([...before, ...after], [pid, ...owned]).some(
      (id) => live.has(id),
    );
  } catch {
    return false;
  }
}
/** Project writes are performed and verified by the coordinator; local adapters run read-only. */
export function createPaModelRuntime(dataDir: string): PaModelRuntime {
  const executionRoot = path.join(dataDir, "pa", "execution");
  const processDir = path.join(executionRoot, "processes");
  let localCatalog: { key: string; expiresAt: number; value: Promise<PaModelOption[]> } | undefined;
  async function localModels(): Promise<PaModelOption[]> {
    const config = await readAppConfig(dataDir);
    const key = JSON.stringify([config.agentCliEnv, config.hiddenAgentModels]);
    if (localCatalog?.key === key && localCatalog.expiresAt > Date.now()) return localCatalog.value;
    const value = detectAgents(config.agentCliEnv ?? {}).then((agents) => agents
      .filter((agent) => agent.available && !['tokentosea', 'byok', 'byok-opencode'].includes(agent.id))
      .flatMap((agent) => agent.models
        .filter((model) => !config.hiddenAgentModels?.[agent.id]?.includes(model.id))
        .map((model) => ({
          runtime: agent.id,
          modelId: model.id,
          label: `${agent.name} · ${model.label}`,
          available: agent.authStatus !== 'missing' && model.enabled !== false,
          ...(agent.authStatus === 'missing' ? { detail: agent.authMessage ?? '请先完成此模型的登录' } : {}),
        }))));
    localCatalog = { key, expiresAt: Date.now() + 30_000, value };
    value.catch(() => { if (localCatalog?.value === value) localCatalog = undefined; });
    return value;
  }
  const processFile = (runId: string) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new PaError("无效的执行标识");
    return path.join(processDir, `${runId}.json`);
  };
  async function claudeLaunch() {
    const config = await readAppConfig(dataDir);
    const def = getAgentDef("claude");
    if (!def) throw new PaError("Claude Code 尚未配置", 503);
    const configured = agentCliEnvForAgent(config.agentCliEnv, "claude");
    const launch = resolveAgentLaunch(def, configured);
    return {
      launch,
      env: applyAgentLaunchEnv(
        spawnEnvForAgent("claude", process.env, configured),
        launch,
      ),
    };
  }
  return {
    accountId: () => tokenToSeaRuntime().current()?.user?.id,
    async reconcile(model, runId) {
      if (!isPaLocalCliModel(model)) return 'unknown';
      try {
        const processes = await captureProcessSnapshot({ timeoutMs: 2000 });
        if (!processes.length) return 'unknown';
        if (processes.some(process => process.command.includes(runId))) return 'running';
        const record = await readFile(processFile(runId), "utf8").catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (record) {
          const { pid } = JSON.parse(record) as { pid: number };
          if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
          if (isProcessGroupAlive(pid) || processes.some(process => process.pid === pid)) return 'running';
        }
        return 'stopped';
      } catch { return 'unknown'; }
    },
    async models() {
      const options: PaModelOption[] = [];
      try {
        options.push(...await localModels());
      } catch {
        /* capability is unavailable, not a guessed model */
      }
      try {
        const response = await ollamaFetch("tags", {
          signal: AbortSignal.timeout(1500),
        });
        const data = JSON.parse(await boundedResponse(response)) as {
          models?: Array<{ name: string }>;
        };
        if (response.ok)
          for (const model of data.models ?? [])
            options.push({
              runtime: "ollama",
              modelId: model.name,
              label: `本机 Ollama · ${model.name}`,
              available: true,
            });
      } catch {
        /* optional local engine */
      }
      try {
        if (tokenToSeaRuntime().current()?.user)
          for (const model of await tokenToSeaRuntime().chatModels())
            options.push({
              runtime: "tokentosea",
              modelId: model.id,
              label: `TokenToSea · ${model.name ?? model.model}`,
              available: true,
              detail: "按已有账号授权计费",
            });
      } catch {
        /* account UI owns sign-in */
      }
      return options.sort((a, b) => Number(b.runtime === 'tokentosea') - Number(a.runtime === 'tokentosea'));
    },
    async execute(model, prompt, runId, signal, limits) {
      signal.throwIfAborted();
      if (model.runtime === "managed") throw new PaError("企业模型仅可从已配置的企业网关调用", 403, "PA_ROUTE_DENIED");
      if (isPaLocalCliModel(model) && model.runtime !== 'claude') {
        return executePaLocalModel(dataDir, model, prompt, runId, signal, terminatePaProcess);
      }
      if (model.runtime === "claude") {
        const { launch, env: baseEnv } = await claudeLaunch();
        if (!launch.launchPath)
          throw new PaError(
            "未找到 Claude Code，请在连接与设置中配置模型",
            503,
            "PA_MODEL_UNAVAILABLE",
          );
        const routeEnv = await loadMmdRouteLaunchEnv(baseEnv, model.modelId);
        const env = routeEnv ? { ...baseEnv, ...routeEnv } : baseEnv;
        const stampPath = processFile(runId);
        const cwd = path.join(executionRoot, "work", runId);
        await Promise.all([mkdir(cwd, { recursive: true, mode: 0o700 }), mkdir(processDir, { recursive: true, mode: 0o700 })]);
        signal.throwIfAborted();
        // Keep the user's normal TUI preference unchanged. This is an isolated,
        // explicitly model-only print invocation without MCP, hooks or tools.
        const invocation = createCommandInvocation({
          command: launch.launchPath,
          args: [
            "-p",
            "--output-format",
            "json",
            "--model",
            model.modelId,
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--setting-sources",
            "",
            "--settings",
            '{"disableAllHooks":true}',
            "--no-session-persistence",
            "--session-id",
            runId,
          ],
          env,
        });
        return new Promise<PaModelResult>((resolve, reject) => {
          const child = spawn(invocation.command, invocation.args, {
            cwd,
            env,
            ...(invocation.windowsVerbatimArguments !== undefined
              ? {
                  windowsVerbatimArguments: invocation.windowsVerbatimArguments,
                }
              : {}),
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          });
          let output = "",
            stderr = "",
            exceeded = false;
          let termination: Promise<boolean> | undefined;
          const abort = () => {
            termination ??= child.pid
              ? terminatePaProcess(child.pid)
              : Promise.resolve(false);
            void termination.then((stopped) => {
              if (!stopped)
                reject(
                  new PaError("执行进程停止结果待核对", 409, "PA_STOP_UNKNOWN"),
                );
            });
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          child.stdout.on("data", (chunk) => {
            if (output.length + String(chunk).length <= MAX_OUTPUT)
              output += String(chunk);
            else {
              exceeded = true;
              abort();
            }
          });
          child.stderr.on("data", (chunk) => {
            if (stderr.length < 1000) stderr += String(chunk);
          });
          child.stdin.on("error", () => {
            /* process close supplies authoritative outcome */
          });
          child.once("error", reject);
          child.once("close", async (code) => {
            signal.removeEventListener("abort", abort);
            const stopped = termination ? await termination :
              !isProcessGroupAlive(child.pid) || await terminatePaProcess(child.pid!);
            if (!stopped)
              return reject(
                new PaError("执行进程停止结果待核对", 409, "PA_STOP_UNKNOWN"),
              );
            void Promise.allSettled([unlink(stampPath), rm(cwd, { recursive: true, force: true })]);
            if (signal.aborted)
              return reject(
                new PaError(
                  stopped ? "执行已停止" : "执行进程停止结果待核对",
                  409,
                  stopped ? "PA_CANCEL_CONFIRMED" : "PA_STOP_UNKNOWN",
                ),
              );
            if (exceeded)
              return reject(new PaError("模型输出超过本次任务上限", 413));
            if (code !== 0)
              return reject(
                new PaError(
                  /ECONN|ENOTFOUND|EAI_AGAIN|network|connection error|timed out/i.test(stderr) ? '模型网络连接中断，请恢复网络后继续' : `Claude Code 执行失败（退出码 ${code ?? "unknown"}），请检查模型登录与配置`,
                  503,
                  /ECONN|ENOTFOUND|EAI_AGAIN|network|connection error|timed out/i.test(stderr) ? 'PA_NETWORK' : "PA_MODEL_UNAVAILABLE",
                ),
              );
            try {
              const result = JSON.parse(output) as {
                result?: string;
                is_error?: boolean;
                usage?: { input_tokens?: number; output_tokens?: number };
                total_cost_usd?: number;
                modelUsage?: Record<string, unknown>;
              };
              if (result.is_error || !result.result?.trim())
                throw new Error("empty");
              resolve({
                text: result.result,
                resolvedModel:
                  Object.keys(result.modelUsage ?? {}).join(",") ||
                  model.modelId,
                usage: {
                  inputTokens: result.usage?.input_tokens,
                  outputTokens: result.usage?.output_tokens,
                  costUsd: result.total_cost_usd?.toString(),
                  visibility: result.usage ? "reported" : "unknown",
                },
              });
            } catch {
              reject(
                new PaError(
                  "模型没有返回有效文本，请检查登录、额度或模型名称",
                  503,
                  "PA_MODEL_UNAVAILABLE",
                ),
              );
            }
          });
          if (child.pid) {
            try {
              // Persist ownership before any prompt reaches the child. A
              // surviving process group remains detectable after daemon exit.
              writeFileSync(stampPath, JSON.stringify({ pid: child.pid }), { mode: 0o600, flag: "wx", flush: true });
            } catch {
              abort();
              void termination?.then(stopped => reject(new PaError("无法保存执行进程回执", 503,
                stopped ? "PA_MODEL_UNAVAILABLE" : "PA_STOP_UNKNOWN")));
              return;
            }
          }
          child.stdin.end(prompt);
        });
      }
      if (model.runtime === "ollama") {
        const modelId = limits?.dataClass === "local_only" ? await localOllamaModel(model.modelId, signal) : model.modelId;
        signal.throwIfAborted();
        const response = await ollamaFetch("chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: prompt }],
            stream: false,
            options: { num_predict: 8192 },
          }),
        });
        if (!response.ok)
          throw new PaError(
            `本机模型暂不可用（${response.status}）`,
            503,
            "PA_MODEL_UNAVAILABLE",
          );
        const data = JSON.parse(await boundedResponse(response)) as {
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
        };
        if (!data.message?.content?.trim())
          throw new PaError("本机模型返回空内容", 503);
        return {
          text: data.message.content,
          usage: {
            inputTokens: data.prompt_eval_count,
            outputTokens: data.eval_count,
            visibility: "reported",
          },
        };
      }
      const runtime = tokenToSeaRuntime();
      const catalog = await runtime.chatModels();
      const entry = catalog.find((item) => item.id === model.modelId);
      if (!entry)
        throw new PaError(
          "模型已不在当前账号目录中",
          503,
          "PA_MODEL_UNAVAILABLE",
        );
      const maximum = Math.min(
        await runtime.authorizationBudget(),
        limits?.maxCostUsd ?? 0.25,
      ).toFixed(6);
      if (!Number.isFinite(Number(maximum)) || Number(maximum) <= 0)
        throw new PaError("模型授权额度不足", 403, "PA_BUDGET");
      const messages = [{ role: "user", content: prompt }];
      const operation = tokenToSeaNativePath(entry);
      const stream =
        entry.executionKind === "official" &&
        !entry.examples?.some(
          (example) => example.path === operation && example.mode === "json",
        );
      const body = {
        model: entry.id,
        messages,
        max_tokens: tokenToSeaAgentOutputLimit(entry),
        stream,
      };
      const response =
        entry.executionKind === "official"
          ? await tokenToSeaNativeChat(
              entry,
              body,
              maximum,
              (resource, method, wire, requestSignal) =>
                runtime.response(resource, method, wire, {}, requestSignal),
              signal,
              runId,
              operation,
            )
          : await runtime.response(
              "chat/completions",
              "POST",
              {
                ...body,
                priceVersion: entry.priceVersion,
                requestKey: runId,
                maxCostUsd: maximum,
              },
              {},
              signal,
            );
      if (response.status >= 500)
        throw new PaError("模型服务端未确认结果，请核对后继续", 503, "PA_RESULT_UNKNOWN");
      if (!response.ok)
        throw new PaError(
          `模型服务暂不可用（${response.status}）`,
          503,
          "PA_MODEL_UNAVAILABLE",
        );
      let raw: string;
      try { raw = await boundedResponse(response); }
      catch (error) {
        if (error instanceof PaError && error.code === "PA_INVALID_OUTPUT")
          throw new PaError("模型响应超出上限，服务端结果待核对", 409, "PA_RESULT_UNKNOWN");
        throw error;
      }
      if (stream) {
        let finished = false;
        const text = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .flatMap((line) => {
            const payload = line.slice(5).trim();
            if (!payload) return [];
            if (payload === "[DONE]") { finished = true; return []; }
            let frame;
            try { frame = JSON.parse(payload); }
            catch { throw new PaError("模型流回执不完整，结果待核对", 503, "PA_RESULT_UNKNOWN"); }
            if (frame.error || frame.type === "error")
              throw new PaError("模型流中断，结果待核对", 503, "PA_RESULT_UNKNOWN");
            if (frame.type === "message_stop") finished = true;
            return operation === "/v1/messages"
              ? frame.delta?.type === "text_delta"
                ? [frame.delta.text]
                : []
              : [frame.choices?.[0]?.delta?.content ?? ""];
          })
          .join("");
        if (!finished) throw new PaError("模型流未返回结束回执，结果待核对", 503, "PA_RESULT_UNKNOWN");
        if (!text.trim()) throw new PaError("模型返回空内容", 503);
        return { text, usage: { visibility: "unknown" } };
      }
      const data = JSON.parse(raw);
      const text =
        operation === "/v1/messages"
          ? data.content
              ?.filter((block: { type: string }) => block.type === "text")
              .map((block: { text: string }) => block.text)
              .join("")
          : data.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim())
        throw new PaError("模型返回空内容", 503);
      return {
        text,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? data.usage?.input_tokens,
          outputTokens:
            data.usage?.completion_tokens ?? data.usage?.output_tokens,
          costUsd: data.tokentosea?.chargedUsd,
          visibility: data.usage ? "reported" : "unknown",
        },
      };
    },
  };
}
