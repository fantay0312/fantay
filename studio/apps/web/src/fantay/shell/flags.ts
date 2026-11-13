// SPDX-License-Identifier: AGPL-3.0-only
// Fantay shell feature flag (spec 02 §5.1). Default ON. `localStorage['fantay.shell']` ('on' | 'off')
// wins over the build env `NEXT_PUBLIC_FANTAY_SHELL` ('0' / 'off' disable). `apps/web/vitest.config.ts`
// sets the env to '0' so upstream unit tests keep today's chrome; Fantay tests opt in with `vi.stubEnv`.
import { useState, useSyncExternalStore } from 'react';

export const FANTAY_SHELL_STORAGE_KEY = 'fantay.shell'; // 'on' | 'off' (QA / e2e override)

/** Build-env half of the flag. The server has no localStorage, so this is also the server snapshot. */
function isFantayShellEnabledByEnv(): boolean {
  const env = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_FANTAY_SHELL : undefined; // literal ref: Next inlines it
  return env !== '0' && env !== 'off';
}

/** Read once per call; no caching so tests can stub env. Default ON. */
export function isFantayShellEnabled(): boolean {
  let local: string | null = null;
  try {
    local = typeof window === 'undefined' ? null : window.localStorage.getItem(FANTAY_SHELL_STORAGE_KEY);
  } catch {
    local = null;
  }
  if (local === 'on') return true;
  if (local === 'off') return false;
  return isFantayShellEnabledByEnv();
}

const subscribeNever = (): (() => void) => () => undefined;

/**
 * Stable for the component lifetime (session-stable in practice): the value is read once when the
 * component mounts. Amendment B2: server rendering and hydration use the env-only server snapshot,
 * then the client value applies; a client-only render returns the client value from the first render.
 */
export function useFantayShellEnabled(): boolean {
  const [enabled] = useState(isFantayShellEnabled);
  return useSyncExternalStore(subscribeNever, () => enabled, isFantayShellEnabledByEnv);
}
