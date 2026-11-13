// SPDX-License-Identifier: AGPL-3.0-only
// Shell shortcuts (spec 02 §6.2 with amendment B5). One document listener in the CAPTURE phase, so it sees a
// combo before EntryShell's and ProjectView's bubble-phase listeners can claim it:
//   mod+\  toggle the sidebar — skipped when the desktop menu owns the accelerator (host `menu` capability);
//   mod+K  project search, only where EntryShell is not mounted (EntryShell's own ⌘K handles home).
// The shell binds no mod+B: EntryShell keeps it for its hidden rail (B5). Mod+N is not bound on the web
// (Chrome reserves Ctrl+N); on desktop it comes from the menu accelerator.
import { useEffect, useRef } from 'react';

const EDITABLE_TARGET = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export interface ShellKeyboardHandlers {
  /** False while the shell is chromeless (onboarding): no shortcut fires. */
  enabled: boolean;
  /** route.kind === 'home' && route.view !== 'settings' — EntryShell is on screen and owns ⌘K. */
  entryShellMounted: boolean;
  onToggleSidebar(): void;
  onSearch(): void;
  /** Desktop menu accelerator owns mod+\ (the native menu sends `fantay.toggleSidebar` instead). */
  menuOwnsToggle?: () => boolean;
  /** Platform override for tests; default `navigator`. */
  isMac?: () => boolean;
}

function defaultIsMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad/i.test(platform);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE_TARGET) !== null;
}

export function isSidebarToggleCombo(event: KeyboardEvent, mac: boolean): boolean {
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.altKey || event.shiftKey) return false;
  return event.key === '\\' || event.code === 'Backslash';
}

export function isSearchCombo(event: KeyboardEvent, mac: boolean): boolean {
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.altKey || event.shiftKey) return false;
  return event.key === 'k' || event.key === 'K';
}

export function useShellKeyboard(handlers: ShellKeyboardHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const current = ref.current;
      if (!current.enabled) return;
      if (event.isComposing || event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;
      const mac = (current.isMac ?? defaultIsMac)();
      if (isSidebarToggleCombo(event, mac)) {
        if (current.menuOwnsToggle?.()) return;
        event.preventDefault();
        current.onToggleSidebar();
        return;
      }
      if (isSearchCombo(event, mac) && !current.entryShellMounted) {
        event.preventDefault();
        current.onSearch();
      }
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);
}
