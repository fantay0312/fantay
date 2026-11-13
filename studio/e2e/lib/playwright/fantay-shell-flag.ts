// SPDX-License-Identifier: Apache-2.0
import type { BrowserContext, Page } from '@playwright/test';

import { seedLocalStorageEntry } from './fantay-theme.ts';

/** Must equal FANTAY_SHELL_STORAGE_KEY in apps/web/src/fantay/shell/flags.ts ('on' | 'off'). */
export const FANTAY_SHELL_STORAGE_KEY = 'fantay.shell';

export type FantayShellSeed = 'on' | 'off';

/**
 * Upstream specs drive the pre-Fantay chrome: the suite seeds `off` per context (91 B9). Fantay specs turn the
 * shell on per page (page init scripts run after context ones): `await seedFantayShell(page, 'on')`.
 */
export async function seedFantayShell(
  target: BrowserContext | Page,
  state: FantayShellSeed = 'off',
): Promise<void> {
  await seedLocalStorageEntry(target, FANTAY_SHELL_STORAGE_KEY, state);
}
