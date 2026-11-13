import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handoffCurrentSidecarGeneration } from "@open-design/sidecar";
import { PACKAGED_KERNEL as KERNEL } from "@open-design/sidecar-proto";
import { lockKernelDataRoot, startKernelUpdates } from "../src/sidecar/kernel-update.js";

vi.mock("@open-design/sidecar", () => ({ handoffCurrentSidecarGeneration: vi.fn(async () => undefined) }));

const activeVersion = "a".repeat(64);
const candidateVersion = "b".repeat(64);
let directory: string;

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "fantay-kernel-update-")); });
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function stage(version: string, release: string) {
  const root = join(directory, KERNEL.versions, version);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, KERNEL.manifestFile), JSON.stringify({ version, release, protocol: 1 }));
  for (const file of [KERNEL.entry, KERNEL.cli, KERNEL.supervisor]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "");
  }
  const require = createRequire(import.meta.url);
  await symlink(dirname(require.resolve("better-sqlite3/package.json")), join(root, "app/node_modules/better-sqlite3"), "junction");
  await symlink(process.execPath, join(root, KERNEL.node));
}

describe("independent Fantay kernel lifecycle", () => {
  it.skipIf(process.platform === "win32")("waits for the daemon to close admission and switches only once", async () => {
    await stage(activeVersion, "0.25.1");
    await stage(candidateVersion, "0.25.2");
    vi.stubEnv(KERNEL.rootEnv, directory);
    vi.stubEnv(KERNEL.versionEnv, activeVersion);
    vi.useFakeTimers();
    const acquire = vi.fn<() => (() => void) | null>().mockReturnValue(null);
    const exit = vi.fn(async () => undefined);
    const controller = await startKernelUpdates({ acquire, exit });
    try {
      await expect(controller!.stage({ version: candidateVersion, release: "0.25.2" })).resolves.toEqual({ accepted: true });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(controller!.status()).toMatchObject({ version: activeVersion, pendingVersion: candidateVersion });
      expect(handoffCurrentSidecarGeneration).not.toHaveBeenCalled();

      acquire.mockReturnValue(() => undefined);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(handoffCurrentSidecarGeneration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        args: [join(directory, KERNEL.versions, candidateVersion, KERNEL.entry)],
        env: expect.objectContaining({ [KERNEL.versionEnv]: candidateVersion }),
      }));
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      controller?.close();
    }
  });

  it("permits one kernel writer per data directory", () => {
    const writer = lockKernelDataRoot(directory);
    try {
      expect(() => lockKernelDataRoot(directory)).toThrow("Another Fantay kernel");
    } finally {
      writer.close();
    }
    lockKernelDataRoot(directory).close();
  });
});
