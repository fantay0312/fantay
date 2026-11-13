// SPDX-License-Identifier: AGPL-3.0-only
// Derives `buildingPaths` and `buildingAgentName` from the host's live run steps and chat messages
// so active frame nodes show the building indicator while an agent is writing them.
import type { RunProgressStep } from '../../../runtime/run-progress';
import type { ChatMessage, ProjectFile } from '../../../types';

export interface DeriveBuildingStateInput {
  runInFlight: boolean;
  streaming: boolean;
  runSteps: readonly RunProgressStep[];
  files: readonly ProjectFile[];
  messages: readonly ChatMessage[];
}

export interface BuildingState {
  buildingPaths: ReadonlySet<string>;
  buildingAgentName: string | undefined;
}

const EMPTY_PATHS: ReadonlySet<string> = new Set();

function normalizeProjectPath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '');
}

function matchCandidateToFilePath(candidate: string, files: readonly ProjectFile[]): string | null {
  const norm = normalizeProjectPath(candidate);
  if (!norm) return null;
  const exact = files.find((f) => f.type !== 'dir' && normalizeProjectPath(f.name) === norm);
  if (exact) return exact.name;
  const suffix = files.find(
    (f) => f.type !== 'dir' && (norm.endsWith(`/${normalizeProjectPath(f.name)}`) || normalizeProjectPath(f.name).endsWith(`/${norm}`)),
  );
  if (suffix) return suffix.name;
  if (/^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/.test(norm)) return norm;
  return null;
}

export function deriveBuildingState(input: DeriveBuildingStateInput): BuildingState {
  const { runInFlight, streaming, runSteps, files, messages } = input;
  if (!runInFlight && !streaming) {
    return { buildingPaths: EMPTY_PATHS, buildingAgentName: undefined };
  }

  const paths = new Set<string>();
  let buildingAgentName: string | undefined;

  for (const step of runSteps) {
    if (step.category !== 'write' && step.category !== 'edit') continue;
    if (!step.target) continue;
    const tokens = step.target.match(/[A-Za-z0-9_./-]+\.(?:html?|css|js|jsx|ts|tsx|svg|fig|op|json)/gi) ?? [step.target];
    for (const token of tokens) {
      const matched = matchCandidateToFilePath(token, files);
      if (matched) paths.add(matched);
    }
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (lastAssistant?.agentName) {
    buildingAgentName = lastAssistant.agentName;
  }
  if (lastAssistant?.events) {
    const completedToolUseIds = new Set<string>();
    for (const ev of lastAssistant.events) {
      if (ev.kind === 'tool_result') {
        completedToolUseIds.add(ev.toolUseId);
      }
    }
    for (const ev of lastAssistant.events) {
      if (ev.kind === 'tool_use' && !completedToolUseIds.has(ev.id)) {
        const inputObj =
          typeof ev.input === 'object' && ev.input !== null ? (ev.input as Record<string, unknown>) : null;
        if (!inputObj) continue;
        const candidates = [inputObj.file_path, inputObj.path, inputObj.filePath, inputObj.target].filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
        for (const candidate of candidates) {
          const matched = matchCandidateToFilePath(candidate, files);
          if (matched) paths.add(matched);
        }
      }
    }
  }

  return {
    buildingPaths: paths.size > 0 ? paths : EMPTY_PATHS,
    buildingAgentName,
  };
}
