// SPDX-License-Identifier: Apache-2.0
// W2 → W3 bridge (spec 07 §4.4, §5.4). Until W3-app-integration renders <MovieEmbeddedApp> in
// EntryShell itself and the legacy routes redirect (07 §5.5), EntryShell still mounts <MovieStudio>
// with the old route props for /movie-app, /movies and /create/animation. An inactive view renders
// nothing (EntryShell keeps the movies view mounted while hidden); an active one is the embedded app,
// which follows the current route and keeps its links in that route family. Once EntryShell no longer
// passes these props, this file and the legacy branch of MovieStudio are dead code.
import type { ReactNode } from "react";
import type { WorkspaceCollabContext } from "@open-design/contracts";

import { MovieEmbeddedApp } from "../../fantay/motion/MovieEmbeddedApp";
import type { AgentInfo, AppConfig, Project } from "../../types";

/** The pre-refactor `MovieStudio` props EntryShell still passes (MovieStudio.tsx before 07 §4.2). */
export interface LegacyMovieStudioRouteProps {
  isActive: boolean;
  config: AppConfig;
  agents: AgentInfo[];
  projects: Project[];
  workspaceContext?: WorkspaceCollabContext | null;
  executionSwitcher: ReactNode;
  onRefresh: () => void;
  /** The route already says which page this is; kept for the call sites only. */
  presentation?: "workspace" | "home" | "embedded";
}

export function MovieStudioLegacyRoute({
  isActive,
  config,
  agents,
  projects,
  workspaceContext,
  executionSwitcher,
  onRefresh,
}: LegacyMovieStudioRouteProps) {
  if (!isActive) return null;
  return (
    <MovieEmbeddedApp
      config={config}
      agents={agents}
      projects={projects}
      workspaceContext={workspaceContext ?? null}
      executionSwitcher={executionSwitcher}
      onRefresh={onRefresh}
    />
  );
}
