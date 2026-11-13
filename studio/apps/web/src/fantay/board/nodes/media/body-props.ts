// SPDX-License-Identifier: AGPL-3.0-only
// Props of an extension node body (plan §3.2, R4/R6): the engine grants the live slot, the body asks to stay live
// (`requestLive(true)`, e.g. while playing) through `commands.requestLive`.
import { useMemo } from 'react';

import { useBoardEngine, useBoardHost } from '../../context';
import type { BoardNodeBodyProps } from '../../extensions';
import type { NodeView } from '../../model/types';

export function useNodeBodyProps(view: NodeView, kind: BoardNodeBodyProps['kind']): BoardNodeBodyProps {
  const { commands } = useBoardEngine();
  const { env } = useBoardHost();
  const nodeId = view.node.id;
  const requestLive = useMemo(() => (pinned: boolean) => commands.requestLive(nodeId, pinned), [commands, nodeId]);
  const { w, h } = view.node;
  return useMemo(
    () => ({
      projectId: env.projectId,
      nodeId,
      kind,
      width: w,
      height: h,
      zoom: view.settledZoom,
      selected: view.selected,
      live: view.live,
      requestLive,
    }),
    [env.projectId, nodeId, kind, w, h, view.settledZoom, view.selected, view.live, requestLive],
  );
}
