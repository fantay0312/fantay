import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { constants, lstatSync, renameSync } from "node:fs";
import path from "node:path";
import type { PaArtifact, PaAttempt, PaEntity, PaTask } from "@open-design/contracts";
import { findRealTagOffset } from "@open-design/contracts/runtime/html-injection-points";
import { ensureProject } from "../projects.js";
import { PaError, type PaStore } from "../storage/personal-agent-store.js";
import { paDigest } from "./personal-agent-gateway.js";

export function parsePaJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Structured outputs are required for capability calls.
  }
  throw new PaError("模型未返回可验证的结构化成果，请调整要求后重试", 422, "PA_INVALID_OUTPUT");
}

export function paDeliverableFiles(output: string): Array<{ name: string; content: string }> {
  const { files } = parsePaJson(output);
  return validateFiles(files);
}

function validateFiles(files: unknown): Array<{ name: string; content: string }> {
  if (!Array.isArray(files) || files.length < 1 || files.length > 8)
    throw new PaError("项目成果必须包含 1–8 个文件", 422);
  const seen = new Set<string>();
  let total = 0;
  return files.map((file: unknown) => {
    const item = file as { path?: unknown; content?: unknown } | null;
    if (!item || typeof item.path !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.(html|md|css|js|json|svg|txt)$/.test(item.path) ||
      item.path.includes("..") || seen.has(item.path.toLowerCase()))
      throw new PaError("成果文件名无效或重复", 422);
    if (typeof item.content !== "string" || !item.content.trim() ||
      (total += Buffer.byteLength(item.content)) > 500000)
      throw new PaError("成果内容为空或超出上限", 422);
    if (item.path.endsWith(".html") && findRealTagOffset(item.content, /<html[\s>]/i) < 0)
      throw new PaError("HTML 成果不是完整文档", 422);
    if (item.path.endsWith(".json")) {
      try { JSON.parse(item.content); }
      catch { throw new PaError("JSON 成果格式无效", 422); }
    }
    seen.add(item.path.toLowerCase());
    return { name: item.path, content: item.content };
  });
}

async function readMatchingFile(file: string, size: number, sha256: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(file)).isFile() || size < 1 || size > 500000) return null;
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size !== size) return null;
      const bytes = await fd.readFile();
      return bytes.length === size && paDigest(bytes) === sha256 ? bytes : null;
    } finally { await fd.close(); }
  } catch { return null; }
}

async function writeStagedFile(directory: string, final: string, contents: string, check: () => void): Promise<void> {
  const temp = path.join(directory, `.stage-${randomUUID()}`);
  const fd = await open(temp, "wx", 0o600);
  try {
    try {
      await fd.writeFile(contents, "utf8");
      await fd.sync();
    } finally {
      await fd.close();
    }
    check();
    try { await link(temp, final); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function preparePaArtifacts(
  store: PaStore,
  projectsDir: string,
  task: PaTask,
  attempt: PaAttempt,
  check: () => void,
): Promise<{ files: Array<Omit<PaArtifact, keyof PaEntity>>; publish: () => void }> {
  if (!task.projectId || !attempt.authority?.capabilities.includes("create_project"))
    throw new PaError("本次尝试未获准保存项目成果", 403, "PA_CAPABILITY_DENIED");
  return prepareArtifactBatch(store, projectsDir, task, attempt.id, `pa-${attempt.id}`, paDeliverableFiles(attempt.output), check);
}

export async function preparePaArtifactMerge(
  store: PaStore, projectsDir: string, task: PaTask, left: PaArtifact, right: PaArtifact,
  versionId: string, content: string, check: () => void,
): Promise<{ file: Omit<PaArtifact, keyof PaEntity>; publish: () => void }> {
  const name = path.basename(left.path);
  const batch = await prepareArtifactBatch(store, projectsDir, task, left.attemptId, `pa-merge-${versionId}`,
    validateFiles([{ path: name, content }]), check);
  return {
    file: { ...batch.files[0]!, baseVersionId: left.id, mergedFrom: [left.id, right.id] },
    publish: batch.publish,
  };
}

async function prepareArtifactBatch(
  store: PaStore, projectsDir: string, task: PaTask, attemptId: string, subdir: string,
  files: Array<{ name: string; content: string }>, check: () => void,
): Promise<{ files: Array<Omit<PaArtifact, keyof PaEntity>>; publish: () => void }> {
  await mkdir(projectsDir, { recursive: true, mode: 0o700 });
  if (!(await lstat(projectsDir)).isDirectory())
    throw new PaError("项目存储目录已改变", 409, "PA_ARTIFACT_CONFLICT");
  const root = await ensureProject(projectsDir, task.projectId!);
  if (!(await lstat(root)).isDirectory())
    throw new PaError("项目目录已改变", 409, "PA_ARTIFACT_CONFLICT");
  const destination = path.join(root, subdir);
  const stage = path.join(root, `.${subdir}.staging`);
  const existing = await lstat(destination).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  });
  const directory = existing ? destination : stage;
  check();
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  if (!(await lstat(directory)).isDirectory())
    throw new PaError("成果目录已改变", 409, "PA_ARTIFACT_CONFLICT");
  if (existing && (await readdir(directory)).sort().join("\0") !== files.map(file => file.name).sort().join("\0"))
    throw new PaError("成果目录的文件清单不一致，请核对冲突", 409, "PA_ARTIFACT_CONFLICT");
  const versions = store.list<PaArtifact>("artifacts").filter(item => item.taskId === task.id);
  const records = [];
  for (const file of files) {
    check();
    const bytes = Buffer.byteLength(file.content);
    const sha256 = paDigest(file.content);
    const filePath = path.join(directory, file.name);
    if (!existing) await writeStagedFile(directory, filePath, file.content, check);
    if (!(await readMatchingFile(filePath, bytes, sha256)))
      throw new PaError("成果版本已存在且内容不同，请核对冲突", 409, "PA_ARTIFACT_CONFLICT");
    const artifactKey = paDigest(`${task.id}\0${file.name.toLowerCase()}`);
    const base = versions.filter(item =>
      item.artifactKey === artifactKey || path.basename(item.path).toLowerCase() === file.name.toLowerCase()).at(-1);
    records.push({
      taskId: task.id,
      attemptId,
      projectId: task.projectId!,
      path: `${subdir}/${file.name}`,
      sha256,
      bytes,
      dataClass: task.dataClass ?? "standard",
      artifactKey,
      baseVersionId: base?.id ?? null,
      verification: ["文件已读回", "SHA-256 一致", ...(file.name.endsWith(".json") ? ["JSON 格式有效"] : [])],
    } satisfies Omit<PaArtifact, keyof PaEntity>);
  }
  if (!existing) {
    const filenames = new Set(files.map(file => file.name));
    for (const item of await readdir(stage)) {
      if (filenames.has(item)) continue;
      if (!/^\.stage-[a-f0-9-]{36}$/.test(item))
        throw new PaError("成果暂存目录存在未知文件，请核对", 409, "PA_ARTIFACT_CONFLICT");
      await unlink(path.join(stage, item));
    }
  }
  return {
    files: records,
    publish() {
      if (existing) return;
      try {
        lstatSync(destination);
        throw new PaError("成果版本目录已存在，请核对冲突", 409, "PA_ARTIFACT_CONFLICT");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      renameSync(stage, destination);
    },
  };
}

export async function readVerifiedPaArtifact(projectsDir: string, artifact: PaArtifact): Promise<Buffer | null> {
  const root = path.join(projectsDir, artifact.projectId);
  const directory = path.dirname(artifact.path);
  const expected = artifact.mergedFrom ? `pa-merge-${artifact.id}` : `pa-${artifact.attemptId}`;
  if (directory !== expected || !(await lstat(projectsDir).catch(() => null))?.isDirectory() ||
    !(await lstat(root).catch(() => null))?.isDirectory() ||
    !(await lstat(path.join(root, directory)).catch(() => null))?.isDirectory()) return null;
  return readMatchingFile(path.join(root, artifact.path), artifact.bytes, artifact.sha256);
}
