/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — one shared client store for the daemon's workbench state.
 * Every page reads `useWorkbench()` and writes through `workbench.*`; each write returns the
 * daemon's next state, which replaces the snapshot, so pages never keep their own copies.
 */
import { useSyncExternalStore } from 'react';
import type {
  WorkbenchChatResponse,
  WorkbenchOp,
  WorkbenchOpsResponse,
  WorkbenchState,
  WorkbenchStateResponse,
} from '@open-design/contracts';
import { toast } from '../ui/toast';
import { getWorkbenchRequestLang, workbenchApi, WorkbenchRequestError } from './api';

const L = (zh: string, en: string) => (getWorkbenchRequestLang() === 'zh' ? zh : en);

export interface WorkbenchSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error';
  state: WorkbenchState | null;
  signedIn: boolean;
  /** Label of the text model in use, null when none. */
  model: string | null;
  modelOk: boolean | null;
  modelError: string | null;
  canUndo: boolean;
  undoLabel: string | null;
  error: string | null;
}

let snapshot: WorkbenchSnapshot = {
  status: 'idle', state: null, signedIn: false, model: null, modelOk: null, modelError: null, canUndo: false, undoLabel: null, error: null,
};
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function set(patch: Partial<WorkbenchSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWorkbench(): WorkbenchSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function getWorkbenchSnapshot(): WorkbenchSnapshot {
  return snapshot;
}

function applyStateResponse(response: WorkbenchStateResponse): void {
  set({
    status: 'ready', state: response.state, signedIn: response.signedIn, model: response.model,
    modelOk: response.modelOk, modelError: response.modelError, canUndo: response.canUndo,
    undoLabel: response.undoLabel ?? null, error: null,
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof WorkbenchRequestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Show a failure as a danger toast and rethrow nothing; returns undefined so callers can `?? fallback`. */
export function reportError(error: unknown, title?: string): undefined {
  if ((error as { name?: string })?.name === 'AbortError') return undefined;
  toast({ title: title ?? errorMessage(error), ...(title ? { description: errorMessage(error) } : {}), tone: 'danger' });
  return undefined;
}

export const workbench = {
  /** Load (or reload) the full state. Concurrent calls share one request. */
  refresh(): Promise<void> {
    if (inflight) return inflight;
    if (snapshot.status === 'idle' || snapshot.status === 'error') set({ status: 'loading' });
    inflight = workbenchApi.state()
      .then(applyStateResponse)
      .catch((error: unknown) => {
        if (snapshot.state) reportError(error);
        else set({ status: 'error', error: errorMessage(error) });
      })
      .finally(() => { inflight = null; });
    return inflight;
  },

  /** Replace the state with one returned by any workbench route. */
  setState(state: WorkbenchState, canUndo?: boolean): void {
    set({ state, status: 'ready', ...(typeof canUndo === 'boolean' ? { canUndo } : {}) });
  },

  /**
   * Run whitelisted ops. Receipts toast once (with 撤销 when undoable) unless `quiet`;
   * errors always toast. Resolves to the daemon response, or undefined on failure.
   */
  async ops(
    ops: WorkbenchOp[],
    options: { label?: string; undoable?: boolean; quiet?: boolean } = {},
  ): Promise<WorkbenchOpsResponse | undefined> {
    try {
      const response = await workbenchApi.ops(ops, { ...(options.label ? { label: options.label } : {}), ...(options.undoable === false ? { undoable: false } : {}) });
      set({ state: response.state, canUndo: response.canUndo, status: 'ready' });
      if (response.errors.length) toast({ title: response.errors[0]!, tone: 'danger' });
      else if (!options.quiet && response.receipts.length) {
        toast({
          title: response.receipts.length === 1 ? response.receipts[0]!.text : L(`${response.receipts[0]!.text} 等 ${response.receipts.length} 项`, `${response.receipts[0]!.text} and ${response.receipts.length - 1} more`),
          ...(options.undoable !== false ? { action: { label: L('撤销', 'Undo'), onClick: () => { void workbench.undo(); } } } : {}),
        });
      }
      return response;
    } catch (error) {
      return reportError(error);
    }
  },

  async undo(): Promise<void> {
    try {
      const response = await workbenchApi.undo();
      set({ state: response.state, canUndo: response.canUndo });
      toast({ title: response.label ? L(`已撤销：${response.label}`, `Undid: ${response.label}`) : L('没有可以撤销的操作', 'Nothing to undo') });
    } catch (error) {
      reportError(error);
    }
  },

  async chat(message: string, focusId?: string, signal?: AbortSignal): Promise<WorkbenchChatResponse | undefined> {
    try {
      const response = await workbenchApi.chat(message, focusId, signal);
      set({ state: response.state, canUndo: response.canUndo, modelOk: response.modelOk, modelError: response.modelError });
      return response;
    } catch (error) {
      return reportError(error);
    }
  },
};
