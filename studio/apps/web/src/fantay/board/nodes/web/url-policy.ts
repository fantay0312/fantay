// SPDX-License-Identifier: AGPL-3.0-only
// Web node URL policy (spec 03 §4.2). Only http(s) pages are previewed, and never the app's own origin: the web
// sandbox allows scripts and same-origin for real sites, which on our origin would escape the sandbox. Same rule as
// the desktop embedded-browser allow-list minus about:blank.
import { isSafeBoardUrl } from '@open-design/contracts';

import type { DictKey } from '../../model/types';

/** Sandbox of an external page: real sites need their own origin (storage, cookies) to work. */
export const WEB_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads';

export type WebUrlCheck = { ok: true; url: string } | { ok: false; reasonKey: Extract<DictKey, 'board.url.invalid' | 'board.url.self'> };

/** Normalizes and checks a typed or pasted address (a bare host gets `https://`). */
export function checkWebUrl(raw: string, appOrigin: string | null): WebUrlCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reasonKey: 'board.url.invalid' };
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(trimmed);
  const bareHost = /^[\w.-]+(:\d+)?(\/|$)/.test(trimmed) || local;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : bareHost ? `${local ? 'http' : 'https'}://${trimmed}` : trimmed;
  if (!isSafeBoardUrl(candidate)) return { ok: false, reasonKey: 'board.url.invalid' };
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reasonKey: 'board.url.invalid' };
  }
  if (appOrigin && url.origin === appOrigin) return { ok: false, reasonKey: 'board.url.self' };
  return { ok: true, url: url.toString() };
}

/** The app origin of the running page (null outside a browser). */
export function currentAppOrigin(): string | null {
  try {
    return typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null' ? window.location.origin : null;
  } catch {
    return null;
  }
}

/** Text the clipboard holds is a single http(s) URL (paste priority 3, spec 03 §3.12). */
export function looksLikeWebUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return false;
  return isSafeBoardUrl(trimmed);
}
