// SPDX-License-Identifier: AGPL-3.0-only
// Finds and reads the subtitle file that belongs to a film (`clip.mp4` → `clip.vtt`, else
// `clip.srt`, in the same folder). The project's file list is asked once per film, so a film
// without subtitles costs no failed request.
import { useEffect, useMemo, useState } from 'react';

import { useProjectCollabContext } from '../../../../collab/collab-context';
import { fetchProjectFiles } from '../../../../providers/registry';
import type { ProjectFile } from '../../../../types';
import { useArtifactText } from '../../use-artifact-source';
import { captionFileNames, parseCaptions, type Cue } from './captions';

const MAX_CAPTION_BYTES = 2 * 1024 * 1024;
const NO_CUES: readonly Cue[] = [];

/** The film's subtitles; empty when it has none or they could not be read. */
export function useCaptions(projectId: string, file: ProjectFile, active: boolean): readonly Cue[] {
  const { workspaceContext } = useProjectCollabContext();
  const [found, setFound] = useState<{ film: string; captions: ProjectFile | null } | null>(null);
  const looked = found?.film === file.name;
  const captions = looked ? found.captions : null;

  useEffect(() => {
    if (!active || looked) return;
    const controller = new AbortController();
    fetchProjectFiles(projectId, { signal: controller.signal, workspaceContext }).then(
      (files) => {
        if (controller.signal.aborted) return;
        const byName = new Map(files.map((candidate) => [candidate.name.toLowerCase(), candidate]));
        const match = captionFileNames(file.name)
          .map((name) => byName.get(name.toLowerCase()))
          .find((candidate) => candidate !== undefined);
        setFound({ film: file.name, captions: match ?? null });
      },
      // Without the list there are simply no subtitles.
      () => undefined,
    );
    return () => controller.abort();
  }, [projectId, file.name, active, looked, workspaceContext]);

  const text = useArtifactText(projectId, captions ?? file, { enabled: captions !== null && active, maxBytes: MAX_CAPTION_BYTES });
  const data = captions !== null && text.source.status === 'ready' ? text.source.data : null;
  return useMemo(() => (data === null ? NO_CUES : parseCaptions(data)), [data]);
}
