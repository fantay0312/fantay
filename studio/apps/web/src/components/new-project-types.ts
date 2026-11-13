// Shared shapes for project creation from the New Project form (NewProjectModal) and its callers
// (EntryShell → App). Kept apart from the modal so the App-level create path does not import a component.
import type { DesignSystemSummary, ProjectMetadata } from '../types';

export interface CreateInput {
  name: string;
  skillId: string | null;
  /** UI-only intent marker; the public project contract still receives only the resolved skill id. */
  skillSelectionProvenance?: 'automatic-default' | 'explicit-user';
  designSystemId: string | null;
  metadata: ProjectMetadata;
  userWorkingDirToken?: string;
  /**
   * An explicit scenario plugin. The free-form New Project form names the hidden default router (od-default) here,
   * so the project skips the per-kind default binding and the agent infers the task from the first message.
   */
  pluginId?: string;
}

export type ImportClaudeDesignOutcome =
  | { ok: true }
  | { ok: false; message?: string; details?: string };

/** The user's default design system, when it still exists and is not a draft; otherwise none. */
export function defaultDesignSystemSelection(
  defaultDesignSystemId: string | null,
  designSystems: DesignSystemSummary[],
): string[] {
  if (!defaultDesignSystemId) return [];
  return designSystems.some((d) => d.id === defaultDesignSystemId && (d.status ?? 'published') !== 'draft')
    ? [defaultDesignSystemId]
    : [];
}
