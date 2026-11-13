// SPDX-License-Identifier: AGPL-3.0-only
// Thumbnail URLs of a generator's image inputs (chips, reference tiles, mention menu), stable while the
// inputs do not change so the chip editor does not rebuild its DOM on every render.
import { useMemo } from 'react';
import type { CompiledInput } from '@open-design/contracts';

import { useGeneration } from '../hooks';
import { mediaUrl } from '../references';

export function useInputPreviews(inputs: readonly CompiledInput[]): Record<string, string | undefined> {
  const { projectId, workspaceContext } = useGeneration();
  const signature = inputs.map((input) => `${input.nodeId}\u0001${input.image?.path ?? ''}`).join('\u0000');
  return useMemo(() => {
    const previews: Record<string, string | undefined> = {};
    for (const input of inputs) {
      if (input.kind === 'image' && input.image?.path) previews[input.nodeId] = mediaUrl(projectId, input.image.path, workspaceContext);
    }
    return previews;
    // `signature` captures every field read from `inputs`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, projectId, workspaceContext]);
}
