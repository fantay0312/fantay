// SPDX-License-Identifier: AGPL-3.0-only
// Client modules of the tool plugins that ship with Fantay, keyed by plugin id. Each loads on demand,
// the first time its plugin is enabled. The desktop host lists the same ids as built-in plugins.
import type { ToolPluginClientModule } from '../types';

export const BUILTIN_CLIENT_MODULES: Record<string, () => Promise<{ default: ToolPluginClientModule }>> = {
  toolbox: () => import('./toolbox'),
  'project-timeline': () => import('./project-timeline'),
};
