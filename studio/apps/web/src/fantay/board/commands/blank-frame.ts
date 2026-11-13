// SPDX-License-Identifier: AGPL-3.0-only
// Frame tool file (spec 03 §3.8, §4.1): drawing a frame writes `untitled-<n>.html` (lowest free n) at the project
// root, then the board adds a frame node for it. The writer is the existing project file API; it is loaded lazily
// so the engine core does not pull the provider registry into every import.
import type { WorkspaceCollabContext } from '@open-design/contracts';

export const BLANK_FRAME_HTML =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Untitled</title></head><body style="margin:0;background:#fff"></body></html>';

/** `untitled-<n>.html` with the lowest n ≥ 1 not taken (case-insensitive). */
export function nextUntitledFrameName(existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const name of existing) taken.add(name.toLowerCase());
  for (let n = 1; ; n += 1) {
    const candidate = `untitled-${n}.html`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface BlankFrameWriteResult {
  ok: boolean;
  name?: string;
  message?: string;
}

export type ProjectTextWriter = (
  projectId: string,
  name: string,
  content: string,
  workspaceContext: WorkspaceCollabContext | null,
) => Promise<BlankFrameWriteResult>;

async function defaultWriter(
  projectId: string,
  name: string,
  content: string,
  workspaceContext: WorkspaceCollabContext | null,
): Promise<BlankFrameWriteResult> {
  const { writeProjectTextFileDetailed } = await import('../../../providers/registry');
  const result = await writeProjectTextFileDetailed(projectId, name, content, { versionSource: 'manual' }, workspaceContext);
  return result.ok ? { ok: true, name: result.file.name } : { ok: false, message: result.message };
}

/** Writes a blank page and resolves to its project path (the file name the daemon stored). */
export async function createBlankFrameFile(input: {
  projectId: string;
  existingNames: Iterable<string>;
  workspaceContext: WorkspaceCollabContext | null;
  write?: ProjectTextWriter;
}): Promise<BlankFrameWriteResult> {
  const name = nextUntitledFrameName(input.existingNames);
  try {
    return await (input.write ?? defaultWriter)(input.projectId, name, BLANK_FRAME_HTML, input.workspaceContext);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
