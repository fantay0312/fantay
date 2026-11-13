import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { T } from '@/timeouts';

/**
 * Make the project file workspace visible and assert it.
 *
 * An empty project opens chat-only: once its first file list comes back empty,
 * ProjectView collapses the workspace (`.split[data-empty-project-collapse]`
 * goes `pending` → `collapsed`) and reopens it by itself when a file lands.
 * Specs that drive Design Files right after creating a project wait for that
 * decision, reopen the panel when it was collapsed, then assert it is visible.
 *
 * The wait is bounded: a project whose file list never loads stays `pending`,
 * and a pending project is never collapsed, so the visibility check below is
 * still the real assertion.
 */
export async function revealFileWorkspace(page: Page, options: { timeout?: number } = {}): Promise<void> {
  const split = page.locator('.split[data-empty-project-collapse]');
  await expect(split).toHaveAttribute('data-empty-project-collapse', /^(collapsed|settled)$/, {
    timeout: options.timeout ?? T.short,
  }).catch(() => {});
  if ((await split.getAttribute('data-empty-project-collapse').catch(() => null)) === 'collapsed') {
    await page.locator('.split-workspace-toggle').click({ timeout: T.short });
  }
  await expect(page.getByTestId('file-workspace')).toBeVisible(options);
}
