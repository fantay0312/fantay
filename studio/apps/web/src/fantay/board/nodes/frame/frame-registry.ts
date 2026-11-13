// SPDX-License-Identifier: AGPL-3.0-only
// Live surfaces of one board (spec 03 §4.1, §5): every mounted frame/web/motion face registers a handle (its
// current iframe, load state, reload, cover refresh, postMessage), the facts the chrome needs for disabled reasons
// (powered page, transport), and the frame that runs an Edit or Capture session. The chrome (context bar, Edit
// panel, capture overlay, export) reads this registry; faces write it. One registry per engine.
import { useSyncExternalStore } from 'react';

import { useBoardEngine } from '../../context';
import type { BoardEngine } from '../../store/board-engine';
import type { FrameCaptureSession } from './use-frame-capture';
import type { FrameEditSession } from './use-frame-edit-session';

export interface FrameHandle {
  readonly nodeId: string;
  readonly kind: 'frame' | 'web' | 'motion';
  /** the iframe that shows the current document (null while not live) */
  iframe(): HTMLIFrameElement | null;
  /** the current document finished loading */
  loaded(): boolean;
  /** resolves with the current iframe once it has loaded, or null after `timeoutMs` */
  whenLoaded(timeoutMs: number): Promise<HTMLIFrameElement | null>;
  reload(): void;
  /** captures and saves a new cover now; false when the node is not live or the capture failed */
  refreshCover(): Promise<boolean>;
  post(message: unknown): void;
}

export interface FrameFacts {
  /** WebGL/Worker/WASM page that only runs in the 文件 tab's powered preview */
  powered?: boolean;
  transport?: 'url' | 'srcdoc';
}

export interface FrameRegistry {
  register(handle: FrameHandle): () => void;
  get(nodeId: string): FrameHandle | undefined;
  setFacts(nodeId: string, facts: FrameFacts | null): void;
  facts(nodeId: string): FrameFacts;
  setEditSession(session: FrameEditSession | null): void;
  editSession(): FrameEditSession | null;
  setCaptureSession(session: FrameCaptureSession | null): void;
  captureSession(): FrameCaptureSession | null;
  subscribe(listener: () => void): () => void;
  /** bumps on every change (useSyncExternalStore snapshot) */
  version(): number;
}

const EMPTY_FACTS: FrameFacts = Object.freeze({});

export function createFrameRegistry(): FrameRegistry {
  const handles = new Map<string, FrameHandle>();
  const facts = new Map<string, FrameFacts>();
  const listeners = new Set<() => void>();
  let edit: FrameEditSession | null = null;
  let capture: FrameCaptureSession | null = null;
  let version = 0;
  const emit = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  return {
    register(handle) {
      handles.set(handle.nodeId, handle);
      emit();
      return () => {
        if (handles.get(handle.nodeId) === handle) {
          handles.delete(handle.nodeId);
          emit();
        }
      };
    },
    get: (nodeId) => handles.get(nodeId),
    setFacts(nodeId, next) {
      const before = facts.get(nodeId);
      if (next === null) {
        if (!before) return;
        facts.delete(nodeId);
      } else {
        if (before && before.powered === next.powered && before.transport === next.transport) return;
        facts.set(nodeId, next);
      }
      emit();
    },
    facts: (nodeId) => facts.get(nodeId) ?? EMPTY_FACTS,
    setEditSession(session) {
      if (edit === session) return;
      edit = session;
      emit();
    },
    editSession: () => edit,
    setCaptureSession(session) {
      if (capture === session) return;
      capture = session;
      emit();
    },
    captureSession: () => capture,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
}

const REGISTRIES = new WeakMap<BoardEngine, FrameRegistry>();

/** The live-surface registry of a board engine. */
export function frameRegistryFor(engine: BoardEngine): FrameRegistry {
  let registry = REGISTRIES.get(engine);
  if (!registry) {
    registry = createFrameRegistry();
    REGISTRIES.set(engine, registry);
  }
  return registry;
}

export function useFrameRegistry(): FrameRegistry {
  return frameRegistryFor(useBoardEngine());
}

/** Re-renders when the registry changes (server snapshot: B2). */
export function useFrameRegistryVersion(registry: FrameRegistry): number {
  return useSyncExternalStore(registry.subscribe, registry.version, registry.version);
}
