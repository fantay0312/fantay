// SPDX-License-Identifier: AGPL-3.0-only
// One board engine per mounted board (spec 03 §3.3/§3.16 with plan R1/R2): the engine store over the 04 data
// store, the DOM camera, the command API, the pointer controller and the runtime that wires them together.
// Creating an engine has no side effects; `start()` subscribes and `stop()` releases everything.
import type { BoardDataStore } from '../data/types';
import { createBoardCommands, type BoardCommands } from '../commands/board-commands';
import { createCameraController, type CameraController, type CameraControllerOptions } from '../camera/camera-controller';
import type { BoardExtensions } from '../extensions';
import { createPointerController, type PointerController } from '../interaction/pointer';
import type { BoardEnvironment, BoardServices, BoardTranslate } from '../model/types';
import { publishBoardViewport, type FantayBoardViewportSnapshot } from '../../workspace/board-viewport-store';
import { createEngineStore, type EngineStore } from './board-store';
import { createEngineRuntime, type EngineRuntime } from './engine-runtime';
import { buildRuntimeEnv } from './runtime-state';

export interface BoardServicesRegistry {
  get(): BoardServices;
  /** Later registrations win per service; returns the unregister function. */
  register(services: BoardServices): () => void;
}

export interface BoardEngine {
  readonly projectId: string;
  readonly data: BoardDataStore;
  readonly store: EngineStore;
  readonly camera: CameraController;
  readonly commands: BoardCommands;
  readonly pointer: PointerController;
  readonly runtime: EngineRuntime;
  readonly services: BoardServicesRegistry;
  getEnvironment(): BoardEnvironment;
  setEnvironment(env: BoardEnvironment): void;
  getExtensions(): BoardExtensions | undefined;
  setExtensions(extensions: BoardExtensions | undefined): void;
  getTranslate(): BoardTranslate;
  setTranslate(t: BoardTranslate): void;
  /** 04 `noteCameraInteraction` of the current data value */
  setInteractionNotifier(notify: () => void): void;
  start(): void;
  stop(): void;
}

export interface BoardEngineOptions {
  projectId: string;
  data: BoardDataStore;
  readOnly?: boolean;
  active?: boolean;
  camera?: CameraControllerOptions;
  publishViewport?: (snapshot: FantayBoardViewportSnapshot | null) => void;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  newNodeId?: () => string;
}

function noop(): void {}

export function defaultBoardEnvironment(projectId: string): BoardEnvironment {
  return {
    projectId,
    files: [],
    filesAuthoritative: false,
    filesRefreshKey: undefined,
    liveArtifacts: [],
    messages: [],
    runInFlight: false,
    buildingPaths: new Set(),
    buildingAgentName: undefined,
    isDeckProject: false,
    projectPlatform: undefined,
    viewerOnly: false,
    workspaceContext: null,
    onOpenInFiles: noop,
  };
}

function createServicesRegistry(): BoardServicesRegistry {
  const entries: BoardServices[] = [];
  return {
    get() {
      return Object.assign({}, ...entries) as BoardServices;
    },
    register(services) {
      entries.push(services);
      return () => {
        const index = entries.lastIndexOf(services);
        if (index >= 0) entries.splice(index, 1);
      };
    },
  };
}

export function createBoardEngine(options: BoardEngineOptions): BoardEngine {
  const { projectId, data } = options;
  let env = defaultBoardEnvironment(projectId);
  let extensions: BoardExtensions | undefined;
  let translate: BoardTranslate = (key) => key;
  let notifyInteraction: () => void = noop;

  const store = createEngineStore({
    projectId,
    data,
    readOnly: options.readOnly ?? false,
    active: options.active ?? true,
    ...(options.newNodeId ? { newNodeId: options.newNodeId } : {}),
  });
  const camera = createCameraController({
    ...(options.now ? { now: options.now } : {}),
    ...(options.requestFrame ? { requestFrame: options.requestFrame } : {}),
    ...(options.cancelFrame ? { cancelFrame: options.cancelFrame } : {}),
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
    ...options.camera,
  });
  const services = createServicesRegistry();
  const commands = createBoardCommands({
    store,
    camera,
    getEnv: () => env,
    getExtensions: () => extensions,
    getServices: () => services.get(),
    getTranslate: () => translate,
    ...(options.newNodeId ? { newNodeId: options.newNodeId } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const pointer = createPointerController({
    store,
    camera,
    commands,
    getEnv: () => env,
    noteInteraction: () => notifyInteraction(),
    ...(options.now ? { now: options.now } : {}),
    ...(options.requestFrame ? { requestFrame: options.requestFrame } : {}),
    ...(options.cancelFrame ? { cancelFrame: options.cancelFrame } : {}),
  });
  const runtime = createEngineRuntime({
    store,
    camera,
    publishViewport: options.publishViewport ?? publishBoardViewport,
    noteCameraInteraction: () => notifyInteraction(),
    ...(options.now ? { now: options.now } : {}),
    ...(options.requestFrame ? { requestFrame: options.requestFrame } : {}),
    ...(options.cancelFrame ? { cancelFrame: options.cancelFrame } : {}),
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
  });

  let disconnect: (() => void) | null = null;
  let lastRuntimeKey: unknown[] = [];

  return {
    projectId,
    data,
    store,
    camera,
    commands,
    pointer,
    runtime,
    services,
    getEnvironment: () => env,
    setEnvironment(next) {
      env = next;
      const key = [next.files, next.filesAuthoritative, next.buildingPaths, next.buildingAgentName, next.liveArtifacts];
      if (key.length === lastRuntimeKey.length && key.every((value, index) => value === lastRuntimeKey[index])) return;
      lastRuntimeKey = key;
      store.setEnv(buildRuntimeEnv({
        files: next.files,
        filesAuthoritative: next.filesAuthoritative,
        buildingPaths: next.buildingPaths,
        buildingAgentName: next.buildingAgentName,
        liveArtifacts: next.liveArtifacts,
      }));
    },
    getExtensions: () => extensions,
    setExtensions(next) {
      extensions = next;
    },
    getTranslate: () => translate,
    setTranslate(t) {
      translate = t;
    },
    setInteractionNotifier(notify) {
      notifyInteraction = notify;
    },
    start() {
      if (disconnect) return;
      disconnect = store.connect();
      runtime.start();
    },
    stop() {
      if (!disconnect) return;
      pointer.cancel();
      runtime.stop();
      disconnect();
      disconnect = null;
    },
  };
}
