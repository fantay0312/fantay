'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The floating mode bar above the bottom toolbar (spec 03 §6.3): Navigate / Edit / Capture for a frame or web node
// (disabled items keep their reason as a tooltip; the active item toggles the mode off), the kind controls, icon
// actions and an overflow menu; while a mode runs, the mode's hint, the capture sub-tools and Done. It stays mounted
// and toggles `data-state`, and hides while a draw/place tool is armed (the toolbar hint owns that spot) or a gesture
// runs. Pan and zoom never re-render it: its slice holds the selection, their runtime and the mode only.
import { Fragment, useMemo, useRef } from 'react';
import { isOpenDesignHostAvailable } from '@open-design/host';

import { useT } from '../../../i18n';
import { Button } from '../../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { isMacPlatform } from '../../ui/kbd';
import { Segmented, SegmentedItem } from '../../ui/segmented';
import { Spinner } from '../../ui/spinner';
import { Toolbar, ToolbarSeparator } from '../../ui/toolbar';
import { Tooltip } from '../../ui/tooltip';
import { useBoardEngine, useBoardHost, useBoardSelector } from '../context';
import { isDrawTool, isPlaceTool } from '../interaction/tools';
import { nodeFilePath } from '../model/contract-adapter';
import type { BoardUiState, EngineNode, NodeRuntime } from '../model/types';
import { BOARD_CHROME_ISLAND_ATTR } from '../nodes/frame/FrameNode';
import { useFrameRegistry, useFrameRegistryVersion } from '../nodes/frame/frame-registry';
import type { EngineState } from '../store/board-store';
import { useChromeActions } from './chrome-context';
import { useCaptureState } from './capture-state';
import {
  contextBarModelFor,
  MODE_HINT_KEYS,
  MODE_ICONS,
  MODE_LABEL_KEYS,
  type BoardAction,
  type BoardNodeModeName,
  type ContextBarModel,
  type ContextBarMode,
} from './context-bar-model';
import { ContextBarWidgetView } from './context-bar-widgets';
import { CHROME_ICON_STROKE, ICONS } from './icons';
import { ToolButton } from './ToolButton';
import styles from './chrome.module.css';

const ISLAND = { [BOARD_CHROME_ISLAND_ATTR]: '' } as const;
const HINT = `${styles.barText} ${styles.modeHint}`;
const GESTURES: ReadonlySet<BoardUiState['interaction']> = new Set(['dragging', 'resizing', 'marquee', 'drawing', 'connecting']);

interface BarSlice {
  nodes: readonly EngineNode[];
  runtime: ReadonlyArray<NodeRuntime | undefined>;
  mode: BoardUiState['mode'];
  maximizedNodeId: string | null;
  readOnly: boolean;
  suppressed: boolean;
}

function selectBarSlice(state: EngineState): BarSlice {
  const nodes: EngineNode[] = [];
  for (const id of state.ui.selection) {
    const node = state.doc.nodes.get(id);
    if (node) nodes.push(node);
  }
  return {
    nodes,
    runtime: nodes.map((node) => state.runtime.get(node.id)),
    mode: state.ui.mode,
    maximizedNodeId: state.ui.maximized?.nodeId ?? null,
    readOnly: state.readOnly,
    suppressed: isDrawTool(state.ui.tool) || isPlaceTool(state.ui.tool) || GESTURES.has(state.ui.interaction),
  };
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (!Object.is(a[index], b[index])) return false;
  return true;
}

function sameBarSlice(a: BarSlice, b: BarSlice): boolean {
  return (
    a.readOnly === b.readOnly &&
    a.suppressed === b.suppressed &&
    a.mode === b.mode &&
    a.maximizedNodeId === b.maximizedNodeId &&
    sameList(a.nodes, b.nodes) &&
    sameList(a.runtime, b.runtime)
  );
}

function ModeSwitch({ nodeId, modes, active }: { nodeId: string; modes: readonly ContextBarMode[]; active: BoardNodeModeName | undefined }) {
  const t = useT();
  const { commands } = useBoardEngine();
  return (
    <Segmented
      size="sm"
      aria-label={t('board.mode.label')}
      value={active ?? ''}
      onValueChange={(next) => {
        const entry = modes.find((candidate) => candidate.mode === next);
        if (entry?.enabled) commands.setMode(nodeId, entry.mode);
      }}
    >
      {modes.map((entry) => {
        const Glyph = MODE_ICONS[entry.mode];
        const item = (
          <SegmentedItem
            key={entry.mode}
            value={entry.mode}
            disabled={!entry.enabled}
            data-testid={`board-mode-${entry.mode}`}
            onClick={() => {
              // the active item turns its mode off (Radix swallows the deselection)
              if (active === entry.mode) commands.setMode(null);
            }}
          >
            <Glyph strokeWidth={CHROME_ICON_STROKE} />
            {t(MODE_LABEL_KEYS[entry.mode])}
          </SegmentedItem>
        );
        if (entry.enabled || !entry.reasonKey) return item;
        return (
          <Tooltip key={entry.mode} label={t(entry.reasonKey)}>
            <span className={styles.toolSlot} data-testid={`board-mode-${entry.mode}-reason`}>
              {item}
            </span>
          </Tooltip>
        );
      })}
    </Segmented>
  );
}

function ActionButton({ action }: { action: BoardAction }) {
  const t = useT();
  const Glyph = action.icon;
  return (
    <ToolButton
      size="sm"
      data-testid={`board-action-${action.id}`}
      label={t(action.labelKey)}
      {...(action.disabledReasonKey ? { disabledReason: t(action.disabledReasonKey) } : {})}
      onClick={() => void action.run()}
    >
      <Glyph strokeWidth={CHROME_ICON_STROKE} />
    </ToolButton>
  );
}

function MoreMenu({ items }: { items: readonly BoardAction[] }) {
  const t = useT();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <ToolButton size="sm" data-testid="board-context-more" label={t('board.contextBar.more')}>
          <ICONS.more strokeWidth={CHROME_ICON_STROKE} />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" width="md" data-testid="board-context-more-menu">
        {items.map((action) => {
          const Glyph = action.icon;
          return (
            <DropdownMenuItem
              key={action.id}
              data-testid={`board-more-${action.id}`}
              tone={action.tone === 'danger' ? 'danger' : 'default'}
              disabled={action.disabledReasonKey !== undefined}
              icon={<Glyph strokeWidth={CHROME_ICON_STROKE} />}
              {...(action.disabledReasonKey ? { description: t(action.disabledReasonKey) } : {})}
              onSelect={() => void action.run()}
            >
              {t(action.labelKey)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Capture (frame): Pick / Markup, then 截取 the picked element or 整页 the whole page. */
function CaptureControls({ nodeId, kind }: { nodeId: string; kind: EngineNode['kind'] }) {
  const t = useT();
  const { commands } = useBoardEngine();
  const registry = useFrameRegistry();
  const tool = useBoardSelector((state) => (state.ui.mode?.nodeId === nodeId ? state.ui.mode.captureTool : 'pick'));
  const capture = useCaptureState(registry, nodeId);
  if (kind !== 'frame') return <span className={HINT}>{t('board.mode.captureHint')}</span>;
  const session = registry.captureSession();
  const working = capture?.working === true;
  return (
    <>
      <Segmented
        size="sm"
        aria-label={t('board.mode.capture')}
        value={tool}
        onValueChange={(next) => commands.setMode(nodeId, 'capture', next === 'markup' ? 'markup' : 'pick')}
      >
        <SegmentedItem value="pick" data-testid="board-capture-pick">
          <ICONS.pick strokeWidth={CHROME_ICON_STROKE} />
          {t('board.capture.pick')}
        </SegmentedItem>
        <SegmentedItem value="markup" data-testid="board-capture-markup">
          <ICONS.markup strokeWidth={CHROME_ICON_STROKE} />
          {t('board.capture.markup')}
        </SegmentedItem>
      </Segmented>
      {tool === 'pick' ? (
        <>
          <span className={HINT} data-testid="board-capture-hint">
            {working ? t('board.capture.working') : t('board.capture.hint', { mod: isMacPlatform() ? '⌘' : 'Ctrl+' })}
          </span>
          {working ? <Spinner size="xs" /> : null}
          <Button
            size="sm"
            variant="primary"
            data-testid="board-capture-element"
            disabled={!capture?.target || working}
            onClick={() => void session?.capture(false)}
          >
            {t('board.mode.capture')}
          </Button>
          <Button size="sm" variant="ghost" data-testid="board-capture-full" disabled={working} onClick={() => void session?.capture(true)}>
            {t('board.capture.fullPage')}
          </Button>
        </>
      ) : (
        <span className={HINT}>{t('board.mode.captureHint')}</span>
      )}
    </>
  );
}

function ModeActive({ model }: { model: ContextBarModel }) {
  const t = useT();
  const { commands } = useBoardEngine();
  const { env } = useBoardHost();
  const nodeId = model.nodeId!;
  const node = useBoardSelector((state) => state.doc.nodes.get(nodeId));
  const editPhase = useBoardSelector((state) => state.runtime.get(nodeId)?.editSession);
  const mode = model.activeMode!;
  const path = node ? nodeFilePath(node) : null;
  const reload = model.actions.find((action) => action.id === 'reload');
  const maximize = model.actions.find((action) => action.id === 'maximize');
  return (
    <>
      {model.modes ? <ModeSwitch nodeId={nodeId} modes={model.modes} active={mode} /> : null}
      <ToolbarSeparator />
      {mode === 'capture' && node ? (
        <CaptureControls nodeId={nodeId} kind={node.kind} />
      ) : (
        <span className={HINT} data-testid="board-mode-hint">
          {t(MODE_HINT_KEYS[mode])}
        </span>
      )}
      {mode === 'edit' && (editPhase === 'loading' || editPhase === 'mounting' || editPhase === 'saving' || editPhase === 'exiting') ? (
        <Spinner size="xs" label={t('board.node.state.loading')} />
      ) : null}
      {mode === 'edit' && path ? (
        <Button size="sm" variant="ghost" data-testid="board-edit-open-full" onClick={() => env.onOpenInFiles(path)}>
          {t('board.edit.openFull')}
        </Button>
      ) : null}
      {mode === 'navigate' && reload ? <ActionButton action={reload} /> : null}
      {maximize ? (
        <Button size="sm" variant="ghost" data-testid="board-action-maximize" onClick={() => void maximize.run()}>
          <maximize.icon strokeWidth={CHROME_ICON_STROKE} />
          {t(maximize.labelKey)}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" data-testid="board-mode-done" onClick={() => commands.setMode(null)}>
        {t('board.edit.done')}
      </Button>
    </>
  );
}

function BarContent({ model }: { model: ContextBarModel }) {
  const t = useT();
  if (model.kind === 'mode-active') return <ModeActive model={model} />;
  const parts: JSX.Element[] = [];
  if (model.countLabel) {
    parts.push(
      <span key="count" className={styles.barText} data-testid="board-selection-count">
        {t(model.countLabel.key, model.countLabel.vars)}
      </span>,
    );
  }
  if (model.modes && model.nodeId) parts.push(<ModeSwitch key="modes" nodeId={model.nodeId} modes={model.modes} active={undefined} />);
  if (model.widgets.length > 0) {
    parts.push(
      <span key="widgets" className={styles.barGroup}>
        {model.widgets.map((widget, index) => (
          <ContextBarWidgetView key={`${widget.type}-${index}`} widget={widget} />
        ))}
      </span>,
    );
  }
  if (model.actions.length > 0) {
    parts.push(
      <span key="actions" className={styles.barGroup}>
        {model.actions.map((action) => (
          <ActionButton key={action.id} action={action} />
        ))}
      </span>,
    );
  }
  if (model.more.length > 0) parts.push(<MoreMenu key="more" items={model.more} />);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={part.key ?? index}>
          {index > 0 ? <ToolbarSeparator /> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

export interface ContextBarProps {
  readOnly: boolean;
}

export function ContextBar({ readOnly }: ContextBarProps) {
  const t = useT();
  const { env, extensions } = useBoardHost();
  const actions = useChromeActions();
  const registry = useFrameRegistry();
  const registryVersion = useFrameRegistryVersion(registry);
  const slice = useBoardSelector(selectBarSlice, sameBarSlice);
  const hostAvailable = useMemo(() => {
    try {
      return isOpenDesignHostAvailable();
    } catch {
      return false;
    }
  }, []);
  const hasBrowserTab = env.onOpenBrowserTab !== undefined;

  const model = useMemo(() => {
    const runtime = new Map<string, NodeRuntime>();
    slice.nodes.forEach((node, index) => {
      const entry = slice.runtime[index];
      if (entry) runtime.set(node.id, entry);
    });
    return contextBarModelFor({
      selection: slice.nodes,
      runtime,
      mode: slice.mode,
      maximizedNodeId: slice.maximizedNodeId,
      readOnly: readOnly || slice.readOnly,
      hostAvailable,
      extensions,
      hasBrowserTab,
      facts: (nodeId) => registry.facts(nodeId),
      ops: actions,
    });
    // registryVersion: frame facts (powered page, transport) feed the disabled reasons
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slice, readOnly, hostAvailable, extensions, hasBrowserTab, actions, registry, registryVersion]);

  const open = model.kind !== 'none' && !slice.suppressed && (model.kind === 'mode-active' || model.modes !== undefined || model.widgets.length > 0 || model.actions.length > 0 || model.more.length > 0 || model.countLabel !== undefined);
  // the last shown content stays while the bar fades out
  const shown = useRef<ContextBarModel | null>(null);
  if (open) shown.current = model;
  const content = open ? model : shown.current;

  return (
    <div className={styles.contextDock} data-state={open ? 'open' : 'closed'} aria-hidden={open ? undefined : true} {...ISLAND} data-testid="board-context-dock">
      <Toolbar
        aria-label={t('board.contextBar.label')}
        data-testid="board-context-bar"
        data-state={open ? 'open' : 'closed'}
        data-kind={content?.nodeKind ?? content?.kind ?? 'none'}
        className={styles.contextBar}
      >
        {content ? <BarContent model={content} /> : null}
      </Toolbar>
    </div>
  );
}
