import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { PaError } from "../../storage/personal-agent-store.js";
import type { PaSandboxConfig } from "./config.js";

const maxOutput = 1024 * 1024;
const label = "io.fantay.pa.sandbox";
type DockerResult = { code: number | null; out: string; err: string };

function docker(args: string[], signal: AbortSignal, input?: string, engine?: string): Promise<DockerResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const sandboxEnv = { ...process.env };
    if (engine) {
      delete sandboxEnv.DOCKER_CONTEXT;
      delete sandboxEnv.DOCKER_HOST;
      delete sandboxEnv.DOCKER_TLS_VERIFY;
      delete sandboxEnv.DOCKER_CERT_PATH;
    }
    const child = spawn("docker", engine ? ["--host", engine, ...args] : args, {
      stdio: ["pipe", "pipe", "pipe"], signal, windowsHide: true, killSignal: "SIGKILL", env: sandboxEnv,
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0, errorBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if ((bytes += chunk.length) <= maxOutput) chunks.push(chunk);
      else {
        child.kill("SIGKILL");
        reject(new PaError("隔离执行输出超出上限", 413, "PA_SANDBOX_OUTPUT"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { if ((errorBytes += chunk.length) <= 4096) errors.push(chunk); });
    child.stdin.on("error", () => undefined);
    child.once("error", reject);
    child.once("close", code => resolve({ code, out: Buffer.concat(chunks).toString("utf8"), err: Buffer.concat(errors).toString("utf8") }));
    child.stdin.end(input);
  });
}

function startContainerWatchdog(engine: string, name: string, timeoutMs: number): Promise<() => void> {
  // This process lives outside the container and survives worker exit. Only
  // the generated container name is passed to it, never input or credentials.
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", 'sleep "$1" && exec docker --host "$2" rm --force "$3"',
      "fantay-pa-watchdog", String(Math.ceil(timeoutMs / 1000)), engine, name], {
      detached: true, stdio: "ignore",
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(() => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* the watchdog has already exited */ }
      });
    });
  });
}

export class PaOciSandbox {
  private checkedAt = 0;
  private engine: string | undefined;
  constructor(private readonly config: PaSandboxConfig) {}

  async available(signal: AbortSignal): Promise<void> {
    if (Date.now() - this.checkedAt < 30000) return;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const context = !this.config.engineSocket && !process.env.DOCKER_HOST
      ? await docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], deadline).catch(() => null)
      : null;
    const endpoint = this.config.engineSocket ? `unix://${this.config.engineSocket}` : process.env.DOCKER_HOST ?? context?.out.trim() ?? "";
    const socket = endpoint.startsWith("unix://") ? endpoint.slice(7) : "";
    if (!path.isAbsolute(socket) || !(await stat(socket).catch(() => null))?.isSocket())
      throw new PaError("隔离执行仅支持本机 Unix 容器引擎套接字", 503, "PA_SANDBOX_UNAVAILABLE");
    const probe = await docker(["info", "--format", "{{.OSType}} {{json .SecurityOptions}}"], deadline, undefined, endpoint)
      .catch(() => null);
    if (probe?.code !== 0 || !probe.out.startsWith("linux ") || !probe.out.includes("name=seccomp"))
      throw new PaError("隔离执行需要启用 seccomp 的 Linux 容器引擎", 503, "PA_SANDBOX_UNAVAILABLE");
    const image = await docker(["image", "inspect", "--format", "{{json .Config.Volumes}}", this.config.image], deadline, undefined, endpoint)
      .catch(() => null);
    if (image?.code !== 0 || !["null", "{}"].includes(image.out.trim()))
      throw new PaError("隔离镜像未安装，或声明了自动挂载的卷", 503, "PA_SANDBOX_UNAVAILABLE");
    this.checkedAt = Date.now();
    this.engine = endpoint;
  }

  async execute(script: string, milliseconds: number, signal: AbortSignal): Promise<string> {
    if (!script.trim() || Buffer.byteLength(script) > 64000 || !Number.isFinite(milliseconds) || milliseconds < 100)
      throw new PaError("隔离执行参数无效", 400, "PA_SANDBOX_INPUT");
    await this.available(signal);
    const engine = this.engine!;
    const timeout = Math.min(milliseconds, 120000);
    const name = `fantay-pa-${randomUUID()}`;
    const watchdog = AbortSignal.any([signal, AbortSignal.timeout(timeout + 5000)]);
    const stopWatchdog = await startContainerWatchdog(engine, name, timeout + 5000);
    let started = false;
    try {
      const created = await docker([
        "create", "--rm", "--interactive", "--name", name, "--label", `${label}=${Date.now() + timeout + 10000}`,
        "--pull=never", "--network=none", "--read-only", "--init", "--user=65534:65534", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--ipc=private", "--no-healthcheck", "--pids-limit=64", `--memory=${this.config.memoryMb}m`,
        `--memory-swap=${this.config.memoryMb}m`, `--cpus=${this.config.cpu}`, "--ulimit", "nofile=128:128",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777", "--workdir", "/tmp",
        ...(this.config.runtime ? ["--runtime", this.config.runtime] : []),
        "--entrypoint", "/usr/bin/timeout", this.config.image, "--kill-after=1s", `${Math.ceil(timeout / 1000)}s`, "/bin/sh", "-s",
      ], watchdog, undefined, engine);
      if (created.code !== 0) throw new PaError("无法创建指定镜像的隔离容器", 503, "PA_SANDBOX_UNAVAILABLE");
      watchdog.throwIfAborted();
      started = true;
      const result = await docker(["start", "--attach", "--interactive", name], watchdog, script, engine);
      if (result.code !== 0) throw new PaError(`隔离命令退出（${result.code ?? "unknown"}）`, 422, "PA_SANDBOX_FAILED");
      return result.out.trim() || "隔离命令已执行完成（无标准输出）";
    } finally {
      const cleanup = await docker(["rm", "--force", name], AbortSignal.timeout(5000), undefined, engine).catch(() => null);
      const removed = cleanup?.code === 0 || cleanup?.err.includes("No such container");
      if (removed) stopWatchdog();
      if (started && !removed)
        throw new PaError("容器停止结果待核对", 409, "PA_STOP_UNKNOWN");
    }
  }
}
