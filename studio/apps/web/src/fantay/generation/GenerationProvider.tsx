'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Generation context for the board (spec 05 §4.11): owns one GenerationService per project and workspace
// identity, resumes watches once the board is ready, turns run results into toasts through the host's
// `notify`, and keeps the per-board UI state the generation surfaces share (last active generator, the open
// tool dialog, live <video> elements for frame capture).
import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { workspaceIdentityCacheKey } from '../../collab/workspace-identity';
import { useI18n } from '../../i18n';
import type { MediaProviderCredentials, ProjectMetadata } from '../../types';
import type { GenerationBoardPort } from './board-adapter';
import { GenerationService } from './generation-service';

export type GenerationSettingsSection = 'media' | 'execution' | 'about';

export interface GenerationToolDialogRequest {
  kind: 'crop' | 'split' | 'upscale' | 'preview';
  nodeId: string;
  candidateId?: string;
}

export interface GenerationProviderProps {
  projectId: string;
  /** Defaults (`imageModel` / `videoModel`) and imported-folder detection (`baseDir`). */
  projectMetadata: ProjectMetadata | null;
  /** ProjectView `config.mediaProviders` (project bridge, plan R21). */
  mediaProviders: Record<string, MediaProviderCredentials> | undefined;
  workspaceContext: WorkspaceCollabContext | null;
  board: GenerationBoardPort;
  /** resume() runs once when true. */
  boardReady: boolean;
  /** B23: disables Run and board-mutating generation actions on read-only boards. */
  readOnly?: boolean;
  onOpenSettings: (section: GenerationSettingsSection) => void;
  /** Fantay toast, wired by the host. */
  notify: (n: { tone: 'info' | 'success' | 'error'; message: string }) => void;
  onRevealChat?: () => void;
  children: ReactNode;
  /**
   * Host for the media tool dialogs and the preview dialog (W2-gen-ui components, wired by the board
   * assembly). Called on every render with the open request (null when closed) so dialogs stay mounted.
   */
  renderToolDialogs?: (state: { request: GenerationToolDialogRequest | null; close(): void }) => ReactNode;
}

export interface GenerationContextValue {
  service: GenerationService;
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  board: GenerationBoardPort;
  onOpenSettings: GenerationProviderProps['onOpenSettings'];
  notify: GenerationProviderProps['notify'];
  lastActiveGeneratorId: string | null;
  setLastActiveGenerator(id: string): void;
  openToolDialog(d: GenerationToolDialogRequest): void;
  /** VideoNodeBody registers its live element so "capture current frame" can read `currentTime`. */
  registerVideoElement(nodeId: string, el: HTMLVideoElement | null): void;
  videoElementOf(nodeId: string): HTMLVideoElement | null;
  // Additions to spec 05 §4.11 (read by the hooks and tool surfaces).
  projectMetadata: ProjectMetadata | null;
  mediaProviders: Record<string, MediaProviderCredentials> | undefined;
  isImportedFolderProject: boolean;
  readOnly: boolean;
  locale: string;
  onRevealChat?: () => void;
  toolDialog: GenerationToolDialogRequest | null;
  closeToolDialog(): void;
}

export const GenerationContext = createContext<GenerationContextValue | null>(null);

/** One toast per burst of `reference-prepare-failed` events (one per unreadable reference). */
const PREPARE_FAILED_TOAST_GAP_MS = 2_000;

export function GenerationProvider(props: GenerationProviderProps): JSX.Element {
  const { projectId, projectMetadata, mediaProviders, workspaceContext, board, boardReady, onOpenSettings, notify } = props;
  const readOnly = Boolean(props.readOnly);
  const { locale, t } = useI18n();
  const isImportedFolderProject = Boolean(projectMetadata?.baseDir);
  const serviceKey = `${projectId}\u0000${workspaceIdentityCacheKey(workspaceContext)}\u0000${isImportedFolderProject ? 1 : 0}`;

  const holder = useRef<{ key: string; board: GenerationBoardPort; service: GenerationService } | null>(null);
  if (!holder.current || holder.current.key !== serviceKey || holder.current.board !== board) {
    holder.current = {
      key: serviceKey,
      board,
      service: new GenerationService({ projectId, workspaceContext, board, locale, isImportedFolderProject, readOnly }),
    };
  }
  const service = holder.current.service;

  useEffect(() => {
    service.setLocale(locale);
  }, [service, locale]);

  useEffect(() => {
    service.setReadOnly(readOnly);
  }, [service, readOnly]);

  // Dispose on unmount / identity change. Under StrictMode the effect re-runs and resume() restarts the service.
  useEffect(() => () => service.dispose(), [service]);

  useEffect(() => {
    if (boardReady) void service.resume().catch(() => undefined);
  }, [service, boardReady]);

  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    let lastPrepareToast = Number.NEGATIVE_INFINITY;
    return service.subscribe((event) => {
      const translate = tRef.current;
      if (event.type === 'run-finished' && event.failed > 0) {
        notifyRef.current({
          tone: 'error',
          message:
            event.done > 0
              ? translate('fantay.gen.run.partialFailed', { failed: event.failed, done: event.done })
              : translate('fantay.gen.run.allFailed'),
        });
      } else if (event.type === 'reference-prepare-failed') {
        const now = Date.now();
        if (now - lastPrepareToast < PREPARE_FAILED_TOAST_GAP_MS) return;
        lastPrepareToast = now;
        notifyRef.current({ tone: 'error', message: translate('fantay.gen.refs.notReady') });
      }
    });
  }, [service]);

  const [lastActiveGeneratorId, setLastActiveGeneratorId] = useState<string | null>(null);
  const [toolDialog, setToolDialog] = useState<GenerationToolDialogRequest | null>(null);
  const videoElements = useRef(new Map<string, HTMLVideoElement>());

  const setLastActiveGenerator = useCallback((id: string) => setLastActiveGeneratorId(id), []);
  const openToolDialog = useCallback((request: GenerationToolDialogRequest) => setToolDialog({ ...request }), []);
  const closeToolDialog = useCallback(() => setToolDialog(null), []);
  const registerVideoElement = useCallback((nodeId: string, el: HTMLVideoElement | null) => {
    if (el) videoElements.current.set(nodeId, el);
    else videoElements.current.delete(nodeId);
  }, []);
  const videoElementOf = useCallback((nodeId: string) => videoElements.current.get(nodeId) ?? null, []);

  // A board switch or a new project starts without stale per-board state.
  useEffect(() => {
    setLastActiveGeneratorId(null);
    setToolDialog(null);
    videoElements.current.clear();
  }, [service]);

  const value = useMemo<GenerationContextValue>(
    () => ({
      service,
      projectId,
      workspaceContext,
      board,
      onOpenSettings,
      notify,
      lastActiveGeneratorId,
      setLastActiveGenerator,
      openToolDialog,
      registerVideoElement,
      videoElementOf,
      projectMetadata,
      mediaProviders,
      isImportedFolderProject,
      readOnly,
      locale,
      ...(props.onRevealChat ? { onRevealChat: props.onRevealChat } : {}),
      toolDialog,
      closeToolDialog,
    }),
    [
      service,
      projectId,
      workspaceContext,
      board,
      onOpenSettings,
      notify,
      lastActiveGeneratorId,
      setLastActiveGenerator,
      openToolDialog,
      registerVideoElement,
      videoElementOf,
      projectMetadata,
      mediaProviders,
      isImportedFolderProject,
      readOnly,
      locale,
      props.onRevealChat,
      toolDialog,
      closeToolDialog,
    ],
  );

  return (
    <GenerationContext.Provider value={value}>
      {props.children}
      {props.renderToolDialogs?.({ request: toolDialog, close: closeToolDialog }) ?? null}
    </GenerationContext.Provider>
  );
}
