// SPDX-License-Identifier: AGPL-3.0-only
// Mounted once in App (plan R18), in both shell modes: the drawer reads the geometry FantayShell publishes
// on the document root, so the host need not sit inside the shell root. Renders the materials drawer from
// its store (`openMaterialsDrawer()` from the board "+" menu; the sidebar and `/materials` use a full page).
// The project comes from the route. Nothing mounts (or fetches)
// before the first open; afterwards the drawer stays mounted so closing animates and state survives.
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { Suspense, lazy, useEffect, useState } from 'react';

import { useRoute } from '../../router';
import { closeMaterialsDrawer, useMaterialsDrawer } from './materials-drawer-store';

const LazyMaterialsDrawer = lazy(() =>
  import('./MaterialsDrawer').then((mod) => ({ default: mod.MaterialsDrawer })),
);

export interface MaterialsDrawerHostProps {
  /** Scope for team-workspace projects (apply requests); omit for local projects. */
  workspaceContext?: WorkspaceCollabContext | null;
}

export function MaterialsDrawerHost({ workspaceContext = null }: MaterialsDrawerHostProps = {}) {
  const drawer = useMaterialsDrawer();
  const route = useRoute();
  const [mounted, setMounted] = useState(drawer.open);

  useEffect(() => {
    if (drawer.open) setMounted(true);
  }, [drawer.open]);

  if (!mounted && !drawer.open) return null;
  return (
    <Suspense fallback={null}>
      <LazyMaterialsDrawer
        open={drawer.open}
        projectId={route.kind === 'project' ? route.projectId : null}
        workspaceContext={workspaceContext}
        width={drawer.width}
        onResize={drawer.setWidth}
        onClose={closeMaterialsDrawer}
      />
    </Suspense>
  );
}
