// SPDX-License-Identifier: Apache-2.0
/**
 * Toast store for the design editor (rendered by FxToasts.vue with the vendored AppToast at the
 * top centre). A repeat of the newest message counts up instead of stacking.
 */
import { shallowRef, type ShallowRef } from 'vue';

export type FxToastVariant = 'default' | 'warning' | 'error';

export interface FxToast {
  id: number;
  message: string;
  variant: FxToastVariant;
  count: number;
  /** Milliseconds before reka-ui dismisses it. */
  duration: number;
}

export const TOAST_DURATION_MS: Record<FxToastVariant, number> = { default: 3000, warning: 6000, error: 6000 };
const MAX_TOASTS = 4;

const toasts = shallowRef<readonly FxToast[]>([]);
let nextId = 1;

function push(message: string, variant: FxToastVariant): number {
  const text = message.trim();
  if (!text) return 0;
  const newest = toasts.value.at(-1);
  if (newest && newest.message === text && newest.variant === variant) {
    toasts.value = [...toasts.value.slice(0, -1), { ...newest, count: newest.count + 1 }];
    return newest.id;
  }
  const toast: FxToast = { id: nextId++, message: text, variant, count: 1, duration: TOAST_DURATION_MS[variant] };
  toasts.value = [...toasts.value, toast].slice(-MAX_TOASTS);
  return toast.id;
}

export function toastInfo(message: string): number {
  return push(message, 'default');
}

export function toastWarning(message: string): number {
  return push(message, 'warning');
}

export function toastError(message: string): number {
  return push(message, 'error');
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

export function useToasts(): Readonly<ShallowRef<readonly FxToast[]>> {
  return toasts;
}

export function resetToastsForTests(): void {
  toasts.value = [];
  nextId = 1;
}
