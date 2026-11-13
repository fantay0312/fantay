import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

async function runPython(script: string, request: string, receipt: string, env: NodeJS.ProcessEnv = {}) {
  try {
    const result = await execFileAsync("python3", [script, "--request", request, "--receipt", receipt], {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, ...result };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { status: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function describeFile(file: string) {
  const body = await readFile(file);
  return { file, sha256: createHash("sha256").update(body).digest("hex"), size: body.byteLength };
}

describe("exact phased release control", () => {
  it("replays deterministic prepare documents and rejects incomplete Shell contributions", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-pack-control-"));
    roots.push(root);
    const scene = join(root, "scene");
    await mkdir(scene);
    const closure = join(root, "closure.mjs");
    const standalone = join(root, "standalone.mjs");
    await writeFile(closure, "export const closure = true;\n");
    await writeFile(standalone, "export const standalone = true;\n");
    const closureDigest = (await describeFile(closure)).sha256;
    const standaloneDigest = (await describeFile(standalone)).sha256;
    const shellBuildHash = "c".repeat(64);
    await writeFile(join(scene, "scene.json"), JSON.stringify({
      schemaVersion: 1,
      target: "darwin-arm64",
      shellVersion: "0.1.0",
      shellBuildHash,
      closure: { sha256: closureDigest },
      standalone: { sha256: standaloneDigest },
    }));
    const sceneDigest = (await describeFile(join(scene, "scene.json"))).sha256;
    const keys = generateKeyPairSync("ed25519");
    const signingEnv = {
      OD_EXACT_SIGNING_KEY_ID: "terminal-test",
      OD_EXACT_ED25519_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    const writePrepareRequest = async (path: string, outputDirectory: string) => writeFile(path, JSON.stringify({
      schemaVersion: 1,
      operation: "exact.prepare",
      channel: "somechan",
      releaseVersion: "0.1.0-somechan.1",
      sourceCommit: "a".repeat(40),
      publishedAt: "2026-09-02T00:00:00Z",
      standaloneVersion: "0.1.0",
      artifactBaseUrl: "https://releases.example.invalid/somechan/0.1.0-somechan.1",
      closureArtifactFile: closure,
      standaloneArtifactFile: standalone,
      shells: [{ type: "terminal", version: "0.1.0", scenes: [{ target: "darwin-arm64", sceneDirectory: scene, sceneManifestSha256: sceneDigest }] }],
      outputDirectory,
    }));
    const prepareA = join(root, "prepare-a");
    const prepareB = join(root, "prepare-b");
    const requestA = join(root, "prepare-a.json");
    const requestB = join(root, "prepare-b.json");
    await writePrepareRequest(requestA, prepareA);
    await writePrepareRequest(requestB, prepareB);
    await expect(runPython(".github/scripts/pack.py", requestA, join(prepareA, "receipt.json"), signingEnv)).resolves.toMatchObject({ status: 0, stderr: "" });
    await expect(runPython(".github/scripts/pack.py", requestB, join(prepareB, "receipt.json"), signingEnv)).resolves.toMatchObject({ status: 0, stderr: "" });
    expect(await readFile(join(prepareA, "documents/content-metadata.json"))).toEqual(await readFile(join(prepareB, "documents/content-metadata.json")));

    const contribution = join(root, "contribution.json");
    const archive = join(root, "terminal-darwin-arm64.tar.gz");
    await writeFile(archive, "terminal archive");
    await writeFile(contribution, JSON.stringify({
      schemaVersion: 1,
      operation: "shell.distribution.contribute",
      shell: { type: "terminal", version: "0.1.0", buildHash: shellBuildHash },
      target: "darwin-arm64",
      artifact: { ...await describeFile(archive), mediaType: "application/gzip" },
      updater: { protocol: "standalone-shell-updater-v3", handler: "sidecar-v1", interaction: "restart-and-install" },
    }));
    const finalizeRequest = join(root, "finalize.json");
    await writeFile(finalizeRequest, JSON.stringify({
      schemaVersion: 1,
      operation: "exact.finalize",
      prepareReceipt: join(prepareA, "receipt.json"),
      contributions: [],
      outputDirectory: join(root, "final"),
    }));
    const rejected = await runPython(".github/scripts/pack.py", finalizeRequest, join(root, "rejected.json"), signingEnv);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("requires Shell contributions");
    await writeFile(finalizeRequest, JSON.stringify({
      schemaVersion: 1,
      operation: "exact.finalize",
      prepareReceipt: join(prepareA, "receipt.json"),
      contributions: [{ receipt: contribution }],
      outputDirectory: join(root, "final"),
    }));
    const finalReceipt = join(root, "final/receipt.json");
    await expect(runPython(".github/scripts/pack.py", finalizeRequest, finalReceipt, signingEnv)).resolves.toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(await readFile(finalReceipt, "utf8"))).toMatchObject({
      schemaVersion: 2,
      operation: "exact.pack",
      requiredAcceptances: [{ shell: { type: "terminal", version: "0.1.0", buildHash: shellBuildHash }, target: "darwin-arm64" }],
    });
  });
});
