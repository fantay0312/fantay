'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The board (spec 03 §3.0/§3.1 with plan R1, R2, R6, R7, B5). Props per R2: the 04 data value (`useBoardData()`),
// project files and run state, extensions, and host callbacks. One engine per data store: the camera writes the
// DOM directly (pan/zoom never re-render React, I2), culling and the live budget run on camera frames and settle,
// edits go through the 04 store (`apply`, `undo`, `redo`). While the board is the active root tab it registers
// `fantay.board.*` commands and publishes its zoom for the header menu; inactive, it publishes null.
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import type { ProjectFile, ProjectPlatform, WorkspaceCollabContext } from '@open-design/contracts';

import { useT } from '../../i18n';
import type { ChatMessage, LiveArtifactWorkspaceEntry } from '../../types';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { VisuallyHidden } from '../ui/visually-hidden';
import styles from './BoardView.module.css';
import { BoardChrome } from './chrome/BoardChrome';
import type { BoardCommands } from './commands/board-commands';
import { useBoardFocusIntent } from './commands/focus-intent';
import { registerBoardShellCommands } from './commands/register-commands';
import { BoardCommentsContext, EMPTY_BOARD_COMMENTS_HOST, type BoardCommentsHost } from './comments/use-board-comment-session';
import { BoardEngineContext, BoardHostContext, useBoardSelector, type BoardHostValue } from './context';
import type { BoardDataValue } from './data/types';
import type { BoardExtensions } from './extensions';
import { useBoardKeyboard } from './interaction/keyboard';
import { BoardStage } from './layers/BoardStage';
import layerStyles from './layers/layers.module.css';
import { nodeDisplayTitle } from './model/labels';
import type { BoardEnvironment, BoardTranslate } from './model/types';
import { BoardSidePanel } from './panels/BoardSidePanel';
import { createBoardEngine, type BoardEngine, type BoardEngineOptions } from './store/board-engine';

export interface BoardViewProps {
  /** 04 `useBoardData()` (store, host bindings, focus intent) */
  data: BoardDataValue;
  files: readonly ProjectFile[];
  /** false while the file list may be partial: absent files are not shown as missing */
  filesAuthoritative?: boolean;
  filesRefreshKey: number | undefined;
  liveArtifacts: readonly LiveArtifactWorkspaceEntry[];
  /** artifact refs → chat snapshot covers */
  messages?: readonly ChatMessage[];
  runInFlight?: boolean;
  /** chat sync derives these from the run steps */
  buildingPaths?: ReadonlySet<string>;
  buildingAgentName?: string;
  isDeckProject?: boolean;
  projectPlatform?: ProjectPlatform;
  viewerOnly?: boolean;
  workspaceContext: WorkspaceCollabContext | null;
  extensions?: BoardExtensions;
  commandsRef?: Ref<BoardCommands | null>;
  /** switch to 文件 and open the file */
  onOpenInFiles(path: string): void;
  onOpenBrowserTab?(url: string): void;
  onRefreshFiles?(): void;
  /** R15: selection → 04 `useBoardSelectionContextSync` */
  onSelectionChange?(ids: readonly string[]): void;
  /** Preview comments of the active conversation and their callbacks (board comment pins, card, composer). */
  comments?: BoardCommentsHost;
  /** Test seam: clock/frame injection for the engine (not used by the app). */
  engineOptions?: Partial<Omit<BoardEngineOptions, 'projectId' | 'data'>>;
}

const EMPTY_PATHS: ReadonlySet<string> = new Set();
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

function useEngine(props: BoardViewProps): BoardEngine {
  const { data, engineOptions } = props;
  const projectId = data.host.projectId;
  const store = data.store;
  const options = useRef(engineOptions);
  return useMemo(
    () =>
      createBoardEngine({
        projectId,
        data: store,
        readOnly: data.host.readOnly || props.viewerOnly === true,
        active: data.host.active,
        ...options.current,
      }),
    // one engine per 04 store (= per project and workspace identity)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, store],
  );
}

/** Polite announcement of the selection (03 §3.20). */
function SelectionAnnouncer({ t }: { t: BoardTranslate }) {
  const text = useBoardSelector((state) => {
    const { selection } = state.ui;
    if (selection.length === 0) return '';
    if (selection.length > 1) return t('board.selection.count', { count: selection.length });
    const node = state.doc.nodes.get(selection[0]!);
    return node ? t('board.a11y.selected', { title: nodeDisplayTitle(state.doc, node, t) }) : '';
  });
  return (
    <VisuallyHidden aria-live="polite" data-testid="board-announcer">
      {text}
    </VisuallyHidden>
  );
}

/** Selection → host callback (R15), outside the render path. */
function SelectionReporter({ onSelectionChange }: { onSelectionChange?: (ids: readonly string[]) => void }) {
  const selection = useBoardSelector((state) => state.ui.selection);
  const callback = useRef(onSelectionChange);
  useEffect(() => {
    callback.current = onSelectionChange;
  }, [onSelectionChange]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (selection.length === 0) return;
    }
    callback.current?.(selection);
  }, [selection]);
  return null;
}

export function BoardView(props: BoardViewProps) {
  const t = useT();
  const engine = useEngine(props);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { data } = props;
  const { host } = data;
  const readOnly = host.readOnly || props.viewerOnly === true;
  const active = host.active;

  const env: BoardEnvironment = useMemo(
    () => ({
      projectId: host.projectId,
      files: props.files,
      filesAuthoritative: props.filesAuthoritative ?? true,
      filesRefreshKey: props.filesRefreshKey,
      liveArtifacts: props.liveArtifacts,
      messages: props.messages ?? EMPTY_MESSAGES,
      runInFlight: props.runInFlight ?? false,
      buildingPaths: props.buildingPaths ?? EMPTY_PATHS,
      buildingAgentName: props.buildingAgentName,
      isDeckProject: props.isDeckProject ?? false,
      projectPlatform: props.projectPlatform,
      viewerOnly: props.viewerOnly ?? false,
      workspaceContext: props.workspaceContext,
      onOpenInFiles: props.onOpenInFiles,
      onOpenBrowserTab: props.onOpenBrowserTab,
      onRefreshFiles: props.onRefreshFiles,
    }),
    [
      host.projectId,
      props.files,
      props.filesAuthoritative,
      props.filesRefreshKey,
      props.liveArtifacts,
      props.messages,
      props.runInFlight,
      props.buildingPaths,
      props.buildingAgentName,
      props.isDeckProject,
      props.projectPlatform,
      props.viewerOnly,
      props.workspaceContext,
      props.onOpenInFiles,
      props.onOpenBrowserTab,
      props.onRefreshFiles,
    ],
  );

  // environment, extensions and translator reach the engine before any effect of this commit reads them
  useLayoutEffect(() => {
    engine.setEnvironment(env);
  }, [engine, env]);
  useLayoutEffect(() => {
    engine.setExtensions(props.extensions);
  }, [engine, props.extensions]);
  useLayoutEffect(() => {
    engine.setTranslate(t);
  }, [engine, t]);
  useLayoutEffect(() => {
    engine.setInteractionNotifier(() => data.noteCameraInteraction());
  }, [engine, data]);

  useLayoutEffect(() => {
    engine.store.setReadOnly(readOnly);
  }, [engine, readOnly]);
  useLayoutEffect(() => {
    engine.store.setActive(active);
  }, [engine, active]);

  useLayoutEffect(() => {
    engine.start();
    return () => engine.stop();
  }, [engine]);

  // the root carries `data-interacting` while a gesture runs (iframes stop taking the pointer) — no re-render
  useEffect(() => {
    let interacting = false;
    const sync = (): void => {
      const next = engine.store.getState().ui.interaction !== 'idle';
      if (next === interacting) return;
      interacting = next;
      const root = rootRef.current;
      if (!root) return;
      if (next) root.dataset.interacting = '';
      else delete root.dataset.interacting;
    };
    sync();
    return engine.store.subscribe(sync);
  }, [engine]);

  // R7 / B5: fantay.board.* only while the 画板 root tab is active
  useEffect(() => {
    if (!active) return undefined;
    return registerBoardShellCommands(engine.commands);
  }, [engine, active]);

  useImperativeHandle(props.commandsRef, () => engine.commands, [engine]);

  useBoardKeyboard(engine, rootRef, active);
  const focus = useBoardFocusIntent(engine, data, active);

  const hostValue: BoardHostValue = useMemo(() => ({ data, env, extensions: props.extensions }), [data, env, props.extensions]);

  return (
    <BoardEngineContext.Provider value={engine}>
      <BoardHostContext.Provider value={hostValue}>
        <BoardCommentsContext.Provider value={props.comments ?? EMPTY_BOARD_COMMENTS_HOST}>
        <div className={styles.shell}>
        <BoardSidePanel readOnly={readOnly} />
        <div
          ref={rootRef}
          className={cn(styles.root, 'fx')}
          data-testid="board-root"
          data-readonly={readOnly ? '' : undefined}
          role="application"
          aria-roledescription={t('board.context.kind')}
          aria-label={t('board.a11y.canvas')}
          tabIndex={-1}
        >
          <BoardStage rootRef={rootRef} />
          <div className={styles.chrome}>
            <BoardChrome readOnly={readOnly} active={active} />
          </div>
          <div className={layerStyles.focusPill} data-state={focus.pill ? 'open' : 'closed'} data-testid="board-focus-pill">
            <Button
              size="sm"
              variant="primary"
              tabIndex={focus.pill ? 0 : -1}
              aria-hidden={focus.pill ? undefined : true}
              onClick={focus.openPill}
            >
              <ArrowDownToLine strokeWidth={1.5} />
              {/* placeholder until i18n-extra `board.focus.newOutput` ("新输出") lands */}
              {t('board.focus.newOutput')}
            </Button>
          </div>
          <SelectionAnnouncer t={t} />
          <SelectionReporter onSelectionChange={props.onSelectionChange} />
        </div>
        </div>
        </BoardCommentsContext.Provider>
      </BoardHostContext.Provider>
    </BoardEngineContext.Provider>
  );
}
