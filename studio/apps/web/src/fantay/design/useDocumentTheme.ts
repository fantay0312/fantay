// SPDX-License-Identifier: AGPL-3.0-only
// The app theme as the design editor sees it (spec 06 §6.1): a MutationObserver on `<html data-theme>`,
// independent of the theme state module, so theme switches reach the editor as a bridge event without
// reloading the iframe. Anything but "light" counts as dark (the app default, 01 §3.6).
import { useSyncExternalStore } from 'react';
import type { DesignTheme } from '@open-design/contracts';

export function readDocumentTheme(): DesignTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function getServerSnapshot(): DesignTheme {
  return 'dark';
}

export function useDocumentTheme(): DesignTheme {
  return useSyncExternalStore(subscribe, readDocumentTheme, getServerSnapshot);
}
