// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { PaComposerDraft, PaContextValue, PaDrafts } from './pa-types';

export const PaContext = createContext<PaContextValue | null>(null);

export function usePa(): PaContextValue {
  const value = useContext(PaContext);
  if (!value) throw new Error('usePa() must be used inside the Fantay workspace');
  return value;
}

export const EMPTY_PA_DRAFT: PaComposerDraft = { text: '', replyTo: null, project: false, projectName: '', request: null };

/** The composer drafts of one workspace (spec §7). They live outside React state: the workspace context keeps this
 *  one object for its lifetime, and only the components that subscribe (the composer) re-render as the owner
 *  types. Drafts are replaced, never mutated, so `get` returns a stable snapshot for useSyncExternalStore. */
export function createPaDrafts(): PaDrafts {
  const store = new Map<string, PaComposerDraft>();
  const listeners = new Set<() => void>();
  let focus = 0;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: (id) => store.get(id) ?? EMPTY_PA_DRAFT,
    set(id, patch) {
      const previous = store.get(id) ?? EMPTY_PA_DRAFT;
      const keys = Object.keys(patch) as Array<keyof PaComposerDraft>;
      if (keys.every((key) => Object.is(previous[key], patch[key]))) return;
      store.set(id, { ...previous, ...patch });
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focusNonce: () => focus,
    requestFocus() {
      focus += 1;
      notify();
    },
  };
}

/** One conversation's draft; re-renders the caller only when that draft changes. */
export function usePaDraft(conversationId: string): PaComposerDraft {
  const { drafts } = usePa();
  const read = () => drafts.get(conversationId);
  return useSyncExternalStore(drafts.subscribe, read, read);
}

/** The focus-request counter (`nav.fillComposer`); re-renders the caller only when it moves. */
export function usePaFocusNonce(): number {
  const { drafts } = usePa();
  return useSyncExternalStore(drafts.subscribe, drafts.focusNonce, drafts.focusNonce);
}
