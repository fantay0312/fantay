// SPDX-License-Identifier: AGPL-3.0-only
// Node runtime (spec 03 §3.0 NodeRuntime, §4.0 states table): the structural phase derived from the project
// files, in-flight writes and pending media, merged with the ephemeral state faces report through
// `commands.setRuntime` (loading/ready, covers, playing, current href). Never persisted.
import type { ProjectFile } from '@open-design/contracts';

import type { LiveArtifactWorkspaceEntry } from '../../../types';
import { jsonEqual, nodeFilePath } from '../model/contract-adapter';
import type { EngineDoc, EngineNode, NodePhase, NodeRuntime } from '../model/types';

export interface RuntimeEnv {
  filesByName: ReadonlyMap<string, ProjectFile>;
  /** false while the file list may be partial: absent files are then never `missing` */
  filesAuthoritative: boolean;
  buildingPaths: ReadonlySet<string>;
  buildingAgentName: string | undefined;
  /** null = unknown */
  liveArtifactIds: ReadonlySet<string> | null;
}

export const IDLE_RUNTIME: NodeRuntime = Object.freeze({ phase: 'idle' as NodePhase });

const EMPTY_FILES: ReadonlyMap<string, ProjectFile> = new Map();
const EMPTY_PATHS: ReadonlySet<string> = new Set();

export const EMPTY_RUNTIME_ENV: RuntimeEnv = {
  filesByName: EMPTY_FILES,
  filesAuthoritative: false,
  buildingPaths: EMPTY_PATHS,
  buildingAgentName: undefined,
  liveArtifactIds: null,
};

export function buildRuntimeEnv(input: {
  files: readonly ProjectFile[];
  filesAuthoritative: boolean;
  buildingPaths?: ReadonlySet<string> | undefined;
  buildingAgentName?: string | undefined;
  liveArtifacts?: readonly LiveArtifactWorkspaceEntry[] | undefined;
}): RuntimeEnv {
  const filesByName = new Map<string, ProjectFile>();
  for (const file of input.files) if (file.type !== 'dir') filesByName.set(file.name, file);
  return {
    filesByName,
    filesAuthoritative: input.filesAuthoritative,
    buildingPaths: input.buildingPaths ?? EMPTY_PATHS,
    buildingAgentName: input.buildingAgentName,
    liveArtifactIds: input.liveArtifacts ? new Set(input.liveArtifacts.map((entry) => entry.artifactId)) : null,
  };
}

function pendingOf(node: EngineNode): { status: string; error?: { message: string; nextStep?: string } } | null {
  if (node.kind === 'image' || node.kind === 'video' || node.kind === 'audio') return node.data.pending ?? null;
  return null;
}

/** Runtime of one node: ephemeral fields, then file stats, pending media, building and missing (strongest last). */
export function deriveNodeRuntime(node: EngineNode, env: RuntimeEnv, ephemeral?: Partial<NodeRuntime>): NodeRuntime {
  const out: NodeRuntime = { ...ephemeral, phase: ephemeral?.phase ?? 'idle' };
  const path = nodeFilePath(node);
  const file = path ? env.filesByName.get(path) : undefined;
  if (file) {
    out.fileMtime = file.mtime;
    out.fileSize = file.size;
  }
  const pending = pendingOf(node);
  if (pending) {
    if (pending.status === 'queued' || pending.status === 'running') out.phase = 'streaming';
    else {
      out.phase = 'error';
      out.error = {
        ...(pending.error?.message ? { message: pending.error.message } : { messageKey: 'board.node.state.error' as const }),
        actionId: pending.error?.nextStep ? 'open-media-settings' : 'retry',
      };
    }
  }
  const building = path !== null && env.buildingPaths.has(path);
  if (building) {
    out.phase = 'building';
    if (env.buildingAgentName) out.agentName = env.buildingAgentName;
  }
  const fileGone = path !== null && env.filesAuthoritative && !file && !building && !pending;
  const artifactGone = node.kind === 'frame'
    && typeof node.data.liveArtifactId === 'string'
    && env.liveArtifactIds !== null
    && env.filesAuthoritative
    && !env.liveArtifactIds.has(node.data.liveArtifactId);
  if (node.missing || fileGone || artifactGone) out.phase = 'missing';
  return out;
}

const NESTED_KEYS: ReadonlySet<string> = new Set(['error', 'cover']);

export function sameRuntime(a: NodeRuntime, b: NodeRuntime): boolean {
  if (a === b) return true;
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const x = left[key];
    const y = right[key];
    if (x === y) continue;
    if (NESTED_KEYS.has(key) && jsonEqual(x, y)) continue;
    return false;
  }
  return true;
}

/** Runtime per node; entries equal to `prev` keep their identity (and the map itself when nothing changed). */
export function deriveRuntimeMap(
  doc: EngineDoc,
  env: RuntimeEnv,
  ephemeral: ReadonlyMap<string, Partial<NodeRuntime>>,
  prev: ReadonlyMap<string, NodeRuntime>,
): ReadonlyMap<string, NodeRuntime> {
  const next = new Map<string, NodeRuntime>();
  let changed = prev.size !== doc.nodes.size;
  for (const node of doc.nodes.values()) {
    const derived = deriveNodeRuntime(node, env, ephemeral.get(node.id));
    const before = prev.get(node.id);
    if (before && sameRuntime(before, derived)) next.set(node.id, before);
    else {
      next.set(node.id, derived);
      changed = true;
    }
  }
  return changed ? next : prev;
}
