import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  SearchEngineCommand,
  SearchEngineConfigField,
  SearchServiceConfig,
} from "@open-design/contracts/api/search-service";
import { engineValues } from "./configuration.js";

export class WebSearchError extends Error {
  constructor(
    message: string,
    public readonly code = "SEARCH_FAILED",
    public readonly status = 502,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}
export interface SearchTransport {
  configDir?: string;
  signal?: AbortSignal;
  executable?: string;
  language?: "zh" | "en";
  dispatcher?: unknown;
}
export type EngineResult = Record<string, unknown>;

export function engineCommands(): SearchEngineCommand[] {
  return JSON.parse(
    readFileSync(new URL("../commands.json", import.meta.url), "utf8"),
  ) as SearchEngineCommand[];
}
export function engineConfigurationFields(): SearchEngineConfigField[] {
  return JSON.parse(
    readFileSync(new URL("../configuration.json", import.meta.url), "utf8"),
  ) as SearchEngineConfigField[];
}
function engineExecutable(): string {
  return fileURLToPath(
    new URL(
      `../runtime/${process.platform}-${process.arch}/smart-search${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
}
function redact(message: string, values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) {
    if (/KEY|TOKEN|SECRET/.test(key) && value)
      message = message.split(value).join("[REDACTED]");
  }
  return message;
}

export async function executeEngine(
  command: string,
  args: string[],
  config: SearchServiceConfig,
  transport: SearchTransport,
): Promise<EngineResult> {
  if (!transport.configDir)
    throw new WebSearchError(
      "搜索引擎配置目录未就绪。",
      "ENGINE_NOT_READY",
      500,
    );
  if (!engineCommands().some((item) => item.id === command))
    throw new WebSearchError("未知搜索引擎命令。", "INVALID_COMMAND", 400);
  if (args.some((value) => typeof value !== "string") || args.length > 256)
    throw new WebSearchError("搜索命令参数无效。", "INVALID_ARGUMENTS", 400);
  const values = engineValues(config);
  const configKeys = new Set(engineConfigurationFields().map(field => field.key));
  const runId = randomUUID();
  const runDirectory = path.join(transport.configDir, 'runs', runId);
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !configKeys.has(key) && !/^(?:PYTHON|CONDA|_CE_|_PYI_|PYINSTALLER_|VIRTUAL_ENV|_MEIPASS2|SMART_SEARCH_)/i.test(
          key,
        ),
    ),
  );
  const executable = transport.executable ?? engineExecutable();
  return new Promise<EngineResult>((resolve, reject) => {
    const child = spawn(executable, ["--desktop-worker"], {
      cwd: runDirectory,
      env: {
        ...environment,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYINSTALLER_RESET_ENVIRONMENT: "1",
        SMART_SEARCH_CONFIG_DIR: transport.configDir!,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.stdin.write('{"cancel":true}\n');
      cancellationTimer = setTimeout(() => child.kill(), 3000);
    };
    const cleanup = () => {
      clearTimeout(cancellationTimer);
      transport.signal?.removeEventListener("abort", stop);
    };
    transport.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) child.kill();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      settled = true;
      cleanup();
      reject(
        new WebSearchError(
          "内置搜索引擎未就绪，请先构建搜索运行环境。",
          "ENGINE_NOT_READY",
          503,
        ),
      );
    });
    child.once("close", () => {
      cleanup();
      if (settled) return;
      if (transport.signal?.aborted) {
        reject(new WebSearchError("搜索已取消。", "CANCELLED", 499));
        return;
      }
      try {
        const envelope = JSON.parse(stdout) as { result?: EngineResult };
        if (!envelope.result) throw new Error("Invalid engine result");
        resolve(envelope.result);
      } catch {
        reject(
          new WebSearchError(
            redact(stderr, values) || "搜索引擎返回了无效结果。",
            "ENGINE_FAILED",
          ),
        );
      }
    });
    child.stdin.write(
      JSON.stringify({
        method: "run.start",
        command,
        params: { arguments: args },
        values,
        config_dir: transport.configDir,
        run_id: runId,
        language: transport.language ?? "zh",
      }) + "\n",
    );
    if (transport.signal?.aborted) stop();
  });
}
