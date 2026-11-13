// SPDX-License-Identifier: Apache-2.0
// Shared harness of the board chrome / node face component tests (W2-board-nodes-chrome): mounts the real
// `BoardView` (engine, stage, faces and chrome) over the fake 04 store with manual frames and engine timers, and
// gives jsdom a stage size (it has no layout).
import { createRef } from 'react';
import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import type { BoardDocument, ProjectFile } from '@open-design/contracts';

import { I18nProvider, type Locale } from '../../../src/i18n';
import { BoardView, type BoardViewProps } from '../../../src/fantay/board/BoardView';
import type { BoardCommands } from '../../../src/fantay/board/commands/board-commands';
import type { BoardExtensions } from '../../../src/fantay/board/extensions';
import type { BoardStoreState } from '../../../src/fantay/board/data/types';
import { createFakeDataStore, createFrameQueue, createManualTimers, dataValue, type FakeDataStore } from './engine-fixtures';

export const STAGE = { w: 1200, h: 800 };

/** jsdom has no layout: the board stage reports a fixed size, every other element 0. Returns the restore. */
export function installStageSize(): () => void {
  const saved = {
    clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'board-stage' ? STAGE.w : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'board-stage' ? STAGE.h : 0;
    },
  });
  return () => {
    if (saved.clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', saved.clientWidth);
    if (saved.clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', saved.clientHeight);
  };
}

export function projectFile(name: string, extra: Partial<ProjectFile> = {}): ProjectFile {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const kind: ProjectFile['kind'] = ext === 'html' || ext === 'htm' ? 'html' : ext === 'png' || ext === 'jpg' ? 'image' : ext === 'mp4' ? 'video' : 'text';
  return { name, size: 1_000, mtime: 5_000, kind, mime: kind === 'html' ? 'text/html' : kind === 'image' ? 'image/png' : 'text/plain', ...extra };
}

export interface BoardHarness {
  data: FakeDataStore;
  frames: ReturnType<typeof createFrameQueue>;
  timers: ReturnType<typeof createManualTimers>;
  commands(): BoardCommands;
  props: BoardViewProps;
  rerender(next: Partial<BoardViewProps>): void;
  /** runs queued frames, advances the engine timers by `ms`, runs frames again (inside act) */
  flush(ms?: number): void;
}

export interface MountOptions {
  board: BoardDocument;
  files?: ProjectFile[];
  extensions?: BoardExtensions;
  readOnly?: boolean;
  /** the 04 initial viewport (default: centre 720/450 at zoom 1) */
  viewport?: { centerX: number; centerY: number; zoom: number } | null;
  store?: Partial<BoardStoreState>;
  onOpenInFiles?: (path: string) => void;
  onOpenBrowserTab?: (url: string) => void;
  /** wraps the board in an I18nProvider with this locale (default: the provider-less English fallback) */
  locale?: Locale;
}

export function mountBoard(options: MountOptions): BoardHarness {
  const data = createFakeDataStore(options.board, {
    initialViewport: options.viewport === undefined ? { centerX: 720, centerY: 450, zoom: 1 } : options.viewport,
    ...options.store,
  });
  const frames = createFrameQueue();
  const timers = createManualTimers();
  const commandsRef = createRef<BoardCommands>();
  const props: BoardViewProps = {
    data: dataValue(data, { host: { readOnly: options.readOnly === true } }),
    files: options.files ?? [],
    filesAuthoritative: false,
    filesRefreshKey: 0,
    liveArtifacts: [],
    workspaceContext: null,
    commandsRef,
    onOpenInFiles: options.onOpenInFiles ?? vi.fn(),
    ...(options.onOpenBrowserTab ? { onOpenBrowserTab: options.onOpenBrowserTab } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
    engineOptions: {
      now: timers.now,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      camera: { reducedMotion: () => true, density: true },
    },
  };
  let current = props;
  const tree = (value: BoardViewProps) =>
    options.locale ? (
      <I18nProvider initial={options.locale}>
        <BoardView {...value} />
      </I18nProvider>
    ) : (
      <BoardView {...value} />
    );
  const view = render(tree(current));
  const flush = (ms = 0): void => {
    act(() => {
      frames.flush();
      if (ms > 0) timers.advance(ms);
      frames.flush();
    });
  };
  flush(300);
  return {
    data,
    frames,
    timers,
    commands: () => commandsRef.current!,
    props,
    flush,
    rerender(next) {
      current = { ...current, ...next };
      view.rerender(tree(current));
    },
  };
}
