// SPDX-License-Identifier: Apache-2.0
/**
 * Shim for OpenPencil's `@/app/editor/active-store` (06 §3.4). Fantay has one editor store per
 * iframe, so "active" and "this tab's" store are the same object; the injection key still lets
 * a subtree pin its store, and calls outside a component resolve the active one lazily.
 */
import { hasInjectionContext, inject, provide, shallowRef, triggerRef, type InjectionKey, type ShallowRef } from 'vue';

import { provideEditor } from '../engine/op';
import type { FxEditorStore } from '../store/types';

export type EditorStore = FxEditorStore;

const storeRef = shallowRef<FxEditorStore>();
const STORE_KEY: InjectionKey<FxEditorStore> = Symbol('fantay-design-editor-store');

export function useActiveEditorStoreRef(): ShallowRef<FxEditorStore | undefined> {
  return storeRef;
}

export function setActiveEditorStore(store: FxEditorStore): void {
  storeRef.value = store;
  triggerRef(storeRef);
}

export function getActiveEditorStore(): FxEditorStore {
  if (!storeRef.value) throw new Error('[fantay-design] editor store not provided');
  return storeRef.value;
}

export function getActiveEditorStoreOrNull(): FxEditorStore | null {
  return storeRef.value ?? null;
}

/** Reads through to the active store at access time, for callers that run before it exists. */
const activeStoreProxy = new Proxy({} as FxEditorStore, {
  get(_target, property) {
    return Reflect.get(getActiveEditorStore(), property);
  },
  set(_target, property, value) {
    return Reflect.set(getActiveEditorStore(), property, value);
  },
  has(_target, property) {
    return Reflect.has(getActiveEditorStore(), property);
  },
});

/** Provides the store to the subtree, for `useEditorStore` and the SDK's `useEditor`. */
export function provideTabEditorStore(store: FxEditorStore): void {
  provide(STORE_KEY, store);
  provideEditor(store);
}

export function useEditorStore(): FxEditorStore {
  return hasInjectionContext() ? inject(STORE_KEY, activeStoreProxy) : activeStoreProxy;
}

export function useFollowingEditorStore(): FxEditorStore {
  return activeStoreProxy;
}
