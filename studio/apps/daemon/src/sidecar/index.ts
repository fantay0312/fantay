import { APP_KEYS, PACKAGED_KERNEL, SIDECAR_MESSAGES, SIDECAR_MODES, SIDECAR_SOURCES, isSidecarSource, type DesktopStatusSnapshot } from "@open-design/sidecar-proto";
import { getSidecarStatus, invokeSidecar, SidecarFactory, type SidecarClient } from "@open-design/sidecar";

import { startDaemonSidecar, type DaemonSidecarHandle } from "./server.js";
import {
  executeLegacyPayloadDesktopHandoff,
  prepareLegacyPayloadDesktopHandoff,
} from "./payload-desktop-handoff.js";
import { waitForParentMonitorRelease } from "./parent-monitor-gate.js";
import { lockKernelDataRoot, startKernelUpdates } from "./kernel-update.js";

async function main(): Promise<void> {
  let runtimeHandle: DaemonSidecarHandle | null = null;
  let kernel: Awaited<ReturnType<typeof startKernelUpdates>> = null;
  const independent = process.env[PACKAGED_KERNEL.versionEnv] != null;
  const discoverDesktop = async (timeoutMs: number) => {
    for (const mode of [SIDECAR_MODES.RUNTIME, "headless"] as const) {
      for (const source of [SIDECAR_SOURCES.PACKAGED, SIDECAR_SOURCES.TOOLS_PACK]) {
        const stamp = { ...client.stamp, app: APP_KEYS.DESKTOP, mode, source };
        const status = await getSidecarStatus<DesktopStatusSnapshot>(stamp, { timeoutMs: Math.min(timeoutMs, 500) }).catch(() => null);
        if (status?.state === "running") return { stamp, status };
      }
    }
    throw new Error("Fantay desktop is not connected to the kernel");
  };
  const invoke = async (action: string, input: unknown) => {
    if (runtimeHandle == null) throw new Error("daemon sidecar is not running");
    return await runtimeHandle.invoke(action, input);
  };
  let client!: SidecarClient<DaemonSidecarHandle>;
  client = SidecarFactory.create<DaemonSidecarHandle>({
    handlers: {
      [SIDECAR_MESSAGES.MINT_IMPORT_TOKEN]: (input) => invoke(SIDECAR_MESSAGES.MINT_IMPORT_TOKEN, input),
      [SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH]: (input) => invoke(SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH, input),
      [SIDECAR_MESSAGES.REGISTER_WEB_URL]: (input) => invoke(SIDECAR_MESSAGES.REGISTER_WEB_URL, input),
      [SIDECAR_MESSAGES.STAGE_KERNEL_UPDATE]: async (input) => {
        if (kernel == null) throw new Error("Fantay kernel updates are unavailable");
        return await kernel.stage(input);
      },
    },
    lifecycle: {
      async start(resources) {
        if (client.stamp.app !== APP_KEYS.DAEMON) throw new Error(`daemon sidecar cannot run stamp app ${client.stamp.app}`);
        if (!isSidecarSource(client.stamp.source)) throw new Error(`unsupported daemon sidecar source: ${client.stamp.source}`);
        if (resources.dataRoot == null) delete process.env.OD_DATA_DIR;
        else process.env.OD_DATA_DIR = resources.dataRoot;
        const started = await startDaemonSidecar({
          base: resources.runtimeRoot,
          mode: client.stamp.mode,
          namespace: client.stamp.namespace,
          source: client.stamp.source,
        }, {
          inheritedEnvironment: (baseEnv) => SidecarFactory.inheritedEnvironment(baseEnv),
          invokeDesktop: async <TResult>(action: string, input: unknown, timeoutMs: number) => {
            if (!independent) return await client.invoke<TResult>(APP_KEYS.DESKTOP, action, input, { timeoutMs });
            const { stamp } = await discoverDesktop(timeoutMs);
            return await invokeSidecar<TResult>(stamp, action, input, { timeoutMs });
          },
          port: resources.port,
          statusDesktop: async (timeoutMs: number) => independent
            ? (await discoverDesktop(timeoutMs)).status
            : await client.status(APP_KEYS.DESKTOP, { timeoutMs }),
        });
        runtimeHandle = started;
        return started;
      },
      async status(runtime) {
        return { ...await runtime.status(), ...(kernel == null ? {} : { kernel: kernel.status() }) };
      },
      async stop(runtime) {
        kernel?.close();
        await waitForParentMonitorRelease();
        await runtime.stop();
        runtimeHandle = null;
      },
    },
  });
  if (independent) {
    if (client.resources.dataRoot == null) throw new Error("Fantay kernel requires a data directory");
    const writerLock = lockKernelDataRoot(client.resources.dataRoot);
    try {
      await client.start();
      kernel = await startKernelUpdates({
        acquire: () => runtimeHandle?.acquireKernelUpdate?.() ?? null,
        exit: async () => { await client.stop(); process.exit(0); },
      });
      await client.waitUntilStopped();
    } finally {
      writerLock.close();
    }
    return;
  }
  await client.start();
  if (!isSidecarSource(client.stamp.source)) throw new Error(`unsupported daemon sidecar source: ${client.stamp.source}`);
  const desktopHandoff = client.resources.dataRoot == null ? null : await prepareLegacyPayloadDesktopHandoff({
    dataRoot: client.resources.dataRoot,
    namespace: client.stamp.namespace,
    outerPid: client.resources.ownerPid,
    requestDesktopStatus: async () => await client.status(APP_KEYS.DESKTOP, { timeoutMs: 800 }),
    runtimeRoot: client.resources.runtimeRoot,
    source: client.stamp.source,
  }).catch((error: unknown) => {
    console.warn("[packaged desktop handoff] prepare failed", error);
    return null;
  });
  if (desktopHandoff?.kind === "none") {
    console.info("[packaged desktop handoff] skipped", { reason: desktopHandoff.reason });
  } else if (desktopHandoff?.kind === "prepared") {
    void executeLegacyPayloadDesktopHandoff(desktopHandoff, {
      requestDesktop: async (message) => message === "status"
        ? await client.status(APP_KEYS.DESKTOP, { timeoutMs: 800 })
        : await client.requestStop(APP_KEYS.DESKTOP, { timeoutMs: 800 }),
    }).then((result) => {
      console.info("[packaged desktop handoff]", result);
    }).catch((error: unknown) => {
      console.warn("[packaged desktop handoff] execute failed", error);
    });
  }
  await client.waitUntilStopped();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
