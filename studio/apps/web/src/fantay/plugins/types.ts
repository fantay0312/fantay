// SPDX-License-Identifier: AGPL-3.0-only
// What a tool plugin's client module looks like to Fantay. Installed plugins ship it as a script (see
// `module-loader.ts`); built-in plugins export the same object from a module under `builtin/`.
import type { Context } from '@deepseek-ai/cordis';

export interface ToolPluginClientModule {
  name?: string;
  /** Workspace services the plugin needs before it starts: `slots`, `locale`, `bridge`, `fantay` … */
  inject?: string[];
  apply(ctx: Context): void;
}

/** Props of a page registered into `fantay.sidebar.nav`. */
export interface ToolPluginPageProps {
  pluginId: string;
  pageId: string;
}
