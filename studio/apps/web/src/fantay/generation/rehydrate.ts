// SPDX-License-Identifier: AGPL-3.0-only
// Rehydration after a reload (spec 05 §4.6 `resume()`). The board keeps every candidate's `taskId` and output
// stem; the daemon keeps task rows for an hour after they end. A candidate that was still active when the page
// went away is matched against the project's task list first; when its task is gone (or it never got one), the
// unique output stem finds the file it produced; otherwise it is `lost`. `stopped` candidates are left alone.
import {
  candidatePatchFromTask,
  isActiveSlot,
  outputStemOf,
  type CandidatePatch,
  type GenerationCandidate,
  type GenerationGraph,
  type ProjectFile,
  type ProjectMediaTask,
} from '@open-design/contracts';

export interface ResumableCandidate {
  nodeId: string;
  candidate: GenerationCandidate;
  /** Model id the request was sent with (for `nextStep` classification). */
  model: string;
}

export interface ResumePlan {
  patches: Array<{ nodeId: string; patch: CandidatePatch }>;
  watch: Array<{ nodeId: string; candidateId: string; taskId: string; runId: string }>;
  recovered: number;
  lost: number;
}

/** Candidates in `pending | queued | running` on every image/video node, whatever created them. */
export function collectResumableCandidates(graph: GenerationGraph): ResumableCandidate[] {
  const out: ResumableCandidate[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'image' && node.kind !== 'video') continue;
    const generation = node.media?.generation;
    if (!generation) continue;
    for (const candidate of generation.candidates) {
      if (isActiveSlot(candidate.status)) out.push({ nodeId: node.id, candidate, model: generation.request.model });
    }
  }
  return out;
}

/** A project file whose stem is the candidate's output stem: the generation finished while nobody watched. */
export function findFileByStem(files: readonly ProjectFile[], outputStem: string): ProjectFile | null {
  return files.find((file) => file.type !== 'dir' && outputStemOf(file.name) === outputStem) ?? null;
}

export function patchFromRecoveredFile(candidateId: string, file: ProjectFile): CandidatePatch {
  const patch: CandidatePatch = {
    id: candidateId,
    status: 'done',
    file: { path: file.name, ...(file.mime ? { mime: file.mime } : {}), size: file.size, mtime: file.mtime },
    error: undefined,
  };
  if (typeof file.mtime === 'number' && file.mtime > 0) patch.endedAt = file.mtime;
  return patch;
}

export function lostPatch(candidateId: string): CandidatePatch {
  return { id: candidateId, status: 'lost' };
}

/**
 * Plans the resumption: patches to apply (task states, recovered files, `lost`) and the tasks to watch.
 * A failed task listing leaves candidates with a task id to the watcher (404 → stem recovery) and does not
 * declare anything lost; a failed file listing leaves the unmatched candidates untouched.
 */
export async function resumeCandidates(input: {
  graph: GenerationGraph;
  listTasks(): Promise<ProjectMediaTask[]>;
  listFiles(): Promise<ProjectFile[]>;
}): Promise<ResumePlan> {
  const plan: ResumePlan = { patches: [], watch: [], recovered: 0, lost: 0 };
  const targets = collectResumableCandidates(input.graph);
  if (targets.length === 0) return plan;

  let tasks: Map<string, ProjectMediaTask> | null = null;
  try {
    tasks = new Map((await input.listTasks()).map((task) => [task.taskId, task]));
  } catch {
    tasks = null;
  }

  let files: ProjectFile[] | null | undefined;
  const listFiles = async (): Promise<ProjectFile[] | null> => {
    if (files === undefined) {
      try {
        files = await input.listFiles();
      } catch {
        files = null;
      }
    }
    return files;
  };

  for (const { nodeId, candidate, model } of targets) {
    const taskId = candidate.taskId;
    if (taskId && tasks === null) {
      plan.watch.push({ nodeId, candidateId: candidate.id, taskId, runId: candidate.runId });
      continue;
    }
    const task = taskId ? tasks?.get(taskId) : undefined;
    if (task) {
      const patch = candidatePatchFromTask(candidate.id, task, model);
      plan.patches.push({ nodeId, patch });
      if (patch.status === 'queued' || patch.status === 'running') {
        plan.watch.push({ nodeId, candidateId: candidate.id, taskId: task.taskId, runId: candidate.runId });
      } else if (patch.status === 'done') {
        plan.recovered += 1;
      }
      continue;
    }
    // Task gone (GC'd after an hour, or the daemon restarted) or never acknowledged: look for the file.
    const listed = await listFiles();
    if (listed === null) continue;
    const file = findFileByStem(listed, candidate.outputStem);
    if (file) {
      plan.patches.push({ nodeId, patch: patchFromRecoveredFile(candidate.id, file) });
      plan.recovered += 1;
    } else {
      plan.patches.push({ nodeId, patch: lostPatch(candidate.id) });
      plan.lost += 1;
    }
  }
  return plan;
}

/** Single-candidate path (a watched task returned 404): the file by stem, else `lost`; null when unknown. */
export async function recoverCandidateByStem(input: {
  candidateId: string;
  outputStem: string;
  listFiles(): Promise<ProjectFile[]>;
}): Promise<CandidatePatch | null> {
  let files: ProjectFile[];
  try {
    files = await input.listFiles();
  } catch {
    return null;
  }
  const file = findFileByStem(files, input.outputStem);
  return file ? patchFromRecoveredFile(input.candidateId, file) : lostPatch(input.candidateId);
}
