// SPDX-License-Identifier: AGPL-3.0-only
// One-shot "open the generator panel at …" requests. The panel itself is shown by the board engine
// when a single generator is selected (spec 03 §4.9 panel slot); callers that select a generator
// (the node face's "+" and double-click, next-step actions on an output node, "use as reference")
// leave a request here and the panel consumes it when it mounts or when the request changes.
import { useSyncExternalStore } from 'react';

export type GeneratorPanelFocusTarget = 'prompt' | 'refs' | 'model';

export interface GeneratorPanelFocusRequest {
  nodeId: string;
  target: GeneratorPanelFocusTarget;
  nonce: number;
}

let pending: GeneratorPanelFocusRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function requestGeneratorPanelFocus(nodeId: string, target: GeneratorPanelFocusTarget): void {
  nonce += 1;
  pending = { nodeId, target, nonce };
  emit();
}

/** Clears the request once the panel acted on it (only when it is still the same request). */
export function consumeGeneratorPanelFocus(request: GeneratorPanelFocusRequest): void {
  if (pending && pending.nonce === request.nonce) {
    pending = null;
    emit();
  }
}

export function getGeneratorPanelFocusRequest(): GeneratorPanelFocusRequest | null {
  return pending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The pending request for `nodeId`, if any. */
export function useGeneratorPanelFocusRequest(nodeId: string): GeneratorPanelFocusRequest | null {
  const request = useSyncExternalStore(subscribe, getGeneratorPanelFocusRequest, () => null);
  return request && request.nodeId === nodeId ? request : null;
}

export function resetGeneratorUiStoreForTests(): void {
  pending = null;
  nonce = 0;
  emit();
}
