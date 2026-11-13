'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Board context menus (spec 03 §3.14, plan R7). The stage records `ui.contextTarget` (node / edge / background with
// the world and client point) on `contextmenu` and selects the pressed node; this menu opens at that client point
// (a zero-size anchor) and clears the target when it closes. Node: modes, open actions, clipboard, grouping, Arrange ▸,
// Align ▸, rename / cover / path / download / chat, remove / delete file. Background: Paste here, Add note / text,
// Insert ▸ (the "+" rows), undo / redo, select all, zoom to fit. Both end with the ZoomPill's former extras (R7):
// Zoom to selection, Show/Hide minimap, Scroll wheel zooms, Keyboard shortcuts. Edge: Remove connection. Disabled
// rows carry their reason as the sub-line (a disabled menu row cannot show a tooltip).
import { Fragment, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { isOpenDesignHostAvailable } from '@open-design/host';
import { canGroupNodes, canUngroupNodes } from '@open-design/contracts';

import { useT } from '../../../i18n';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { MenuItemIcon } from '../../ui/menu';
import { toast } from '../../ui/toast';
import { useChromeActions } from '../chrome/chrome-context';
import { modesFor, MODE_ICONS, MODE_LABEL_KEYS } from '../chrome/context-bar-model';
import { CHROME_ICON_STROKE, ICONS } from '../chrome/icons';
import { InsertMenuItems } from '../chrome/InsertMenu';
import styles from '../chrome/chrome.module.css';
import { clickRectFor, type AlignMode, type ReorderMode } from '../commands/board-commands';
import { useBoardEngine, useBoardHost, useBoardSelector } from '../context';
import { useBoardStoreState } from '../data/BoardDataProvider';
import { nodeFilePath } from '../model/contract-adapter';
import type { BoardContextTarget, DictKey, EngineNode, Point } from '../model/types';
import { frameRegistryFor } from '../nodes/frame/frame-registry';
import type { EngineState } from '../store/board-store';
import { selectAll } from '../store/selection';
import { copyBoardSelection } from './clipboard';

interface RowProps {
  testId: string;
  labelKey: DictKey;
  icon?: LucideIcon;
  shortcut?: string;
  /** disabled, with this reason as the sub-line */
  reasonKey?: DictKey;
  /** disabled without a reason (nothing to undo, …) */
  disabled?: boolean;
  tone?: 'default' | 'danger';
  onSelect(): void;
}

function Row({ testId, labelKey, icon: Glyph, shortcut, reasonKey, disabled = false, tone = 'default', onSelect }: RowProps) {
  const t = useT();
  const off = disabled || reasonKey !== undefined;
  return (
    <DropdownMenuItem
      data-testid={`board-menu-${testId}`}
      tone={tone}
      disabled={off}
      {...(Glyph ? { icon: <Glyph strokeWidth={CHROME_ICON_STROKE} /> } : {})}
      {...(shortcut && !off ? { shortcut } : {})}
      {...(reasonKey ? { description: t(reasonKey) } : {})}
      onSelect={() => onSelect()}
    >
      {t(labelKey)}
    </DropdownMenuItem>
  );
}

/** Groups of rows separated by rules; empty groups are dropped. */
function Groups({ groups }: { groups: ReadonlyArray<ReadonlyArray<ReactNode>> }) {
  const filled = groups.map((group) => group.filter(Boolean)).filter((group) => group.length > 0);
  return (
    <>
      {filled.map((group, index) => (
        <Fragment key={index}>
          {index > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuGroup>{group}</DropdownMenuGroup>
        </Fragment>
      ))}
    </>
  );
}

/** The ZoomPill's former extras (R7), shared by every menu. */
function useViewRows(hasSelection: boolean): ReactNode[] {
  const t = useT();
  const engine = useBoardEngine();
  const minimapOpen = useBoardSelector((state) => state.ui.minimapOpen);
  const wheelZooms = useBoardSelector((state) => state.ui.wheelZooms);
  return [
    <Row
      key="zoom-selection"
      testId="zoom-selection"
      labelKey="board.zoom.selection"
      icon={ICONS.zoomToGroup}
      shortcut="shift+2"
      {...(hasSelection ? {} : { reasonKey: 'board.zoom.selectionDisabled' as const })}
      onSelect={() => engine.commands.zoomToSelection()}
    />,
    <Row
      key="minimap"
      testId="minimap"
      labelKey={minimapOpen ? 'board.minimap.hide' : 'board.minimap.show'}
      icon={ICONS.minimap}
      onSelect={() => engine.store.setUi({ minimapOpen: !minimapOpen })}
    />,
    <DropdownMenuCheckboxItem
      key="wheel"
      data-testid="board-menu-wheel-zooms"
      checked={wheelZooms}
      onCheckedChange={(checked) => engine.store.setUi({ wheelZooms: checked === true })}
    >
      <MenuItemIcon>
        <ICONS.wheel strokeWidth={CHROME_ICON_STROKE} />
      </MenuItemIcon>
      {t('board.zoom.wheelZooms')}
    </DropdownMenuCheckboxItem>,
    <Row
      key="shortcuts"
      testId="shortcuts"
      labelKey="board.shortcuts.open"
      icon={ICONS.keyboard}
      shortcut="?"
      onSelect={() => engine.store.setUi({ shortcutsOpen: true })}
    />,
  ];
}

function Sub({ testId, labelKey, icon: Glyph, children }: { testId: string; labelKey: DictKey; icon: LucideIcon; children: ReactNode }) {
  const t = useT();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={`board-menu-${testId}`} icon={<Glyph strokeWidth={CHROME_ICON_STROKE} />}>
        {t(labelKey)}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

const ARRANGE: ReadonlyArray<{ to: ReorderMode; key: DictKey; shortcut: string; icon: LucideIcon }> = [
  { to: 'front', key: 'board.menu.bringToFront', shortcut: 'mod+alt+]', icon: ICONS.front },
  { to: 'forward', key: 'board.menu.bringForward', shortcut: 'mod+]', icon: ICONS.front },
  { to: 'backward', key: 'board.menu.sendBackward', shortcut: 'mod+[', icon: ICONS.back },
  { to: 'back', key: 'board.menu.sendToBack', shortcut: 'mod+alt+[', icon: ICONS.back },
];

const ALIGN: ReadonlyArray<{ how: AlignMode; key: DictKey; icon: LucideIcon }> = [
  { how: 'left', key: 'board.menu.alignLeft', icon: ICONS.alignLeft },
  { how: 'center', key: 'board.menu.alignCenter', icon: ICONS.alignCenter },
  { how: 'right', key: 'board.menu.alignRight', icon: ICONS.alignRight },
  { how: 'top', key: 'board.menu.alignTop', icon: ICONS.alignTop },
  { how: 'middle', key: 'board.menu.alignMiddle', icon: ICONS.alignMiddle },
  { how: 'bottom', key: 'board.menu.alignBottom', icon: ICONS.alignBottom },
];

function selectionNodes(state: EngineState): EngineNode[] {
  const nodes: EngineNode[] = [];
  for (const id of state.ui.selection) {
    const node = state.doc.nodes.get(id);
    if (node) nodes.push(node);
  }
  return nodes;
}

function sameNodes(a: readonly EngineNode[], b: readonly EngineNode[]): boolean {
  return a.length === b.length && a.every((node, index) => node === b[index]);
}

function hostAvailable(): boolean {
  try {
    return isOpenDesignHostAvailable();
  } catch {
    return false;
  }
}

/** A node whose project file "Add to chat" can stage (the rule of `stageBoardNodesInChat`, sync/capture.ts). */
function chatStageable(node: EngineNode): boolean {
  if (node.missing) return false;
  switch (node.kind) {
    case 'image':
    case 'video':
    case 'audio':
      return !node.data.pending && node.data.ref !== null;
    case 'frame':
    case 'design':
      return nodeFilePath(node) !== null;
    default:
      return false;
  }
}

function NodeRows({ target, onPaste }: { target: BoardContextTarget; onPaste(at: Point): void }) {
  const engine = useBoardEngine();
  const { extensions } = useBoardHost();
  const actions = useChromeActions();
  const { commands } = engine;
  const readOnly = useBoardSelector((state) => state.readOnly);
  const nodes = useBoardSelector(selectionNodes, sameNodes);
  const runtime = useBoardSelector((state) => (target.id ? state.runtime.get(target.id) : undefined));
  const ids = nodes.map((node) => node.id);
  const single = nodes.length === 1 ? nodes[0]! : null;
  const path = single ? nodeFilePath(single) : null;
  const host = hostAvailable();
  const facts = single ? frameRegistryFor(engine).facts(single.id) : undefined;
  const modes = single ? modesFor(single, runtime, { readOnly, hostAvailable: host, ...(facts ? { facts } : {}) }) : undefined;
  const geometry = nodes.map((node) => ({ id: node.id, kind: node.kind, x: node.x, y: node.y, w: node.w, h: node.h, parentId: node.parentId ?? undefined }));
  // bodies that own their playback (generation video body, film) take no board Play
  const playable =
    single &&
    ((single.kind === 'video' && !extensions?.renderVideoBody) ||
      single.kind === 'audio' ||
      (single.kind === 'motion' && single.data.source.type !== 'movie'));
  const playing = runtime?.playing === true;
  const locked = nodes.length > 0 && nodes.every((node) => node.locked);
  const designOpenable = extensions?.openDesignDocument !== undefined;
  const studioOpenable = single?.kind === 'motion' && (single.data.source.type !== 'movie' || extensions?.openMotionStudio !== undefined);
  const view = useViewRows(true);
  const t = useT();
  const { data } = useBoardHost();
  const pages = useBoardStoreState(data.store, (state) => state.pages);
  const activePageId = useBoardStoreState(data.store, (state) => state.activePageId);
  const otherPages = pages.filter((page) => page.id !== activePageId);

  const open = [
    ...(modes ?? []).map((entry) => (
      <Row
        key={`mode-${entry.mode}`}
        testId={`mode-${entry.mode}`}
        labelKey={MODE_LABEL_KEYS[entry.mode]}
        icon={MODE_ICONS[entry.mode]}
        {...(entry.mode === 'edit' ? { shortcut: 'e' } : entry.mode === 'capture' ? { shortcut: 'shift+c' } : {})}
        {...(entry.enabled || !entry.reasonKey ? {} : { reasonKey: entry.reasonKey })}
        onSelect={() => commands.setMode(single!.id, entry.mode)}
      />
    )),
    path && single && single.kind !== 'design' ? (
      <Row key="open-in-files" testId="open-in-files" labelKey="board.node.openInFiles" icon={ICONS.openInFiles} onSelect={() => actions.openInFiles(path)} />
    ) : null,
    single?.kind === 'design' ? (
      <Row
        key="open-editor"
        testId="open-editor"
        labelKey="board.node.openEditor"
        icon={ICONS.design}
        {...(designOpenable ? {} : { reasonKey: 'board.insert.unavailable' as const })}
        onSelect={() => actions.openEditor(single.data.ref.path)}
      />
    ) : null,
    single?.kind === 'motion' ? (
      <Row
        key="open-studio"
        testId="open-studio"
        labelKey="board.node.openStudio"
        icon={ICONS.animation}
        {...(studioOpenable ? {} : { reasonKey: 'board.insert.unavailable' as const })}
        onSelect={() => actions.openStudio(single.id)}
      />
    ) : null,
    playable && single ? (
      <Row
        key="play"
        testId="play"
        labelKey={playing ? 'board.node.pause' : 'board.node.play'}
        icon={playing ? ICONS.pause : ICONS.play}
        onSelect={() => actions.togglePlay(single.id)}
      />
    ) : null,
  ];

  const clipboard = [
    <Row key="copy" testId="copy" labelKey="board.menu.copy" icon={ICONS.copy} shortcut="mod+c" onSelect={() => void copyBoardSelection(engine)} />,
    readOnly ? null : (
      <Row key="cut" testId="cut" labelKey="board.menu.cut" icon={ICONS.copy} shortcut="mod+x" onSelect={() => void copyBoardSelection(engine, true)} />
    ),
    readOnly ? null : (
      <Row key="paste" testId="paste" labelKey="board.menu.paste" icon={ICONS.paste} shortcut="mod+v" onSelect={() => onPaste(target.world)} />
    ),
    single && (single.kind === 'image' || single.kind === 'frame' || single.kind === 'web') ? (
      <Row
        key="copy-png"
        testId="copy-png"
        labelKey="board.menu.copyAsPng"
        icon={ICONS.image}
        {...(single.kind === 'web' && !host ? { reasonKey: 'board.mode.reason.webCapture' as const } : {})}
        onSelect={() => actions.copyAsPng(single.id)}
      />
    ) : null,
    readOnly ? null : (
      <Row key="duplicate" testId="duplicate" labelKey="board.menu.duplicate" icon={ICONS.duplicate} shortcut="mod+d" onSelect={() => actions.duplicate(ids)} />
    ),
  ];

  const structure = readOnly
    ? []
    : [
        canGroupNodes(ids, geometry) ? (
          <Row key="group" testId="group" labelKey="board.menu.group" icon={ICONS.group} shortcut="mod+g" onSelect={() => actions.group(ids)} />
        ) : null,
        canUngroupNodes(ids, geometry) ? (
          <Row key="ungroup" testId="ungroup" labelKey="board.menu.ungroup" icon={ICONS.ungroup} shortcut="mod+shift+g" onSelect={() => actions.ungroup(ids)} />
        ) : null,
        <Row
          key="lock"
          testId={locked ? 'unlock' : 'lock'}
          labelKey={locked ? 'board.menu.unlock' : 'board.menu.lock'}
          icon={locked ? ICONS.unlock : ICONS.lock}
          shortcut="mod+shift+l"
          onSelect={() => actions.setLocked(ids, !locked)}
        />,
        <Sub key="arrange" testId="arrange" labelKey="board.menu.arrange" icon={ICONS.front}>
          {ARRANGE.map((entry) => (
            <Row
              key={entry.to}
              testId={`arrange-${entry.to}`}
              labelKey={entry.key}
              icon={entry.icon}
              shortcut={entry.shortcut}
              onSelect={() => commands.reorder(ids, entry.to)}
            />
          ))}
        </Sub>,
        otherPages.length > 0 ? (
          <Sub key="move-page" testId="move-page" labelKey="board.pages.moveTo" icon={ICONS.front}>
            {otherPages.map((page) => (
              <DropdownMenuItem
                key={page.id}
                data-testid="board-menu-move-page-target"
                onSelect={() => {
                  commands.moveNodesToPage(ids, page.id);
                  toast({ title: t('board.pages.moved', { name: page.title }) });
                }}
              >
                {page.title}
              </DropdownMenuItem>
            ))}
          </Sub>
        ) : null,
      ];

  const align =
    readOnly || nodes.length < 2
      ? []
      : [
          <Sub key="align" testId="align" labelKey="board.menu.align" icon={ICONS.alignLeft}>
            {ALIGN.map((entry) => (
              <Row key={entry.how} testId={`align-${entry.how}`} labelKey={entry.key} icon={entry.icon} onSelect={() => commands.align(ids, entry.how)} />
            ))}
            {nodes.length >= 3 ? (
              <>
                <DropdownMenuSeparator />
                <Row testId="distribute-h" labelKey="board.menu.distributeH" icon={ICONS.distributeH} onSelect={() => commands.distribute(ids, 'h')} />
                <Row testId="distribute-v" labelKey="board.menu.distributeV" icon={ICONS.distributeV} onSelect={() => commands.distribute(ids, 'v')} />
              </>
            ) : null}
          </Sub>,
        ];

  const details = [
    single && !readOnly ? (
      <Row key="rename" testId="rename" labelKey="common.rename" icon={ICONS.rename} shortcut="f2" onSelect={() => actions.rename(single.id)} />
    ) : null,
    single && !readOnly && (single.kind === 'frame' || single.kind === 'web') ? (
      <Row
        key="refresh-cover"
        testId="refresh-cover"
        labelKey="board.node.refreshCover"
        icon={ICONS.refreshCover}
        {...(single.kind === 'web' && !host ? { reasonKey: 'board.mode.reason.webCapture' as const } : {})}
        onSelect={() => actions.refreshCover(single.id)}
      />
    ) : null,
    path ? <Row key="copy-path" testId="copy-path" labelKey="board.node.copyPath" icon={ICONS.copy} onSelect={() => actions.copyPath(path)} /> : null,
    path && single && single.kind !== 'motion' ? (
      <Row key="download" testId="download" labelKey="board.node.download" icon={ICONS.download} onSelect={() => actions.download(path)} />
    ) : null,
    nodes.some(chatStageable) ? (
      <Row key="add-to-chat" testId="add-to-chat" labelKey="board.node.addToChat" icon={ICONS.addToChat} onSelect={() => actions.addToChat(ids)} />
    ) : null,
  ];

  const removal = readOnly
    ? []
    : [
        <Row key="remove" testId="remove" labelKey="board.menu.remove" icon={ICONS.remove} shortcut="delete" onSelect={() => actions.remove(ids)} />,
        path && single && single.kind !== 'motion' && single.kind !== 'web' ? (
          <Row key="delete-file" testId="delete-file" labelKey="board.menu.deleteFile" icon={ICONS.deleteFile} tone="danger" onSelect={() => actions.deleteFile(single.id)} />
        ) : null,
      ];

  return <Groups groups={[open, clipboard, structure, align, details, removal, view]} />;
}

function BackgroundRows({ target, onPaste }: { target: BoardContextTarget; onPaste(at: Point): void }) {
  const engine = useBoardEngine();
  const { env } = useBoardHost();
  const { commands } = engine;
  const readOnly = useBoardSelector((state) => state.readOnly);
  const canUndo = useBoardSelector((state) => state.history.canUndo);
  const canRedo = useBoardSelector((state) => state.history.canRedo);
  const hasSelection = useBoardSelector((state) => state.ui.selection.length > 0);
  const t = useT();
  const view = useViewRows(hasSelection);
  const at = target.world;
  const create = readOnly
    ? []
    : [
        <Row key="paste-here" testId="paste-here" labelKey="board.menu.pasteHere" icon={ICONS.paste} shortcut="mod+v" onSelect={() => onPaste(at)} />,
        <Row key="add-note" testId="add-note" labelKey="board.menu.addNote" icon={ICONS.note} shortcut="n" onSelect={() => commands.placeNode('note', at)} />,
        <Row
          key="add-text"
          testId="add-text"
          labelKey="board.menu.addText"
          icon={ICONS.text}
          shortcut="t"
          onSelect={() => void commands.createDrawnNode('text', clickRectFor('text', at, env))}
        />,
        <DropdownMenuSub key="insert">
          <DropdownMenuSubTrigger data-testid="board-menu-insert" icon={<ICONS.insert strokeWidth={CHROME_ICON_STROKE} />}>
            {t('board.tool.insert')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[min(288px,calc(100vw-24px))]">
            <InsertMenuItems at={at} testIdPrefix="board-menu-insert" />
          </DropdownMenuSubContent>
        </DropdownMenuSub>,
      ];
  const history = readOnly
    ? []
    : [
        <Row key="undo" testId="undo" labelKey="board.menu.undo" icon={ICONS.undo} shortcut="mod+z" disabled={!canUndo} onSelect={() => void commands.undo()} />,
        <Row key="redo" testId="redo" labelKey="board.menu.redo" icon={ICONS.redo} shortcut="mod+shift+z" disabled={!canRedo} onSelect={() => void commands.redo()} />,
      ];
  const select = [
    <Row
      key="select-all"
      testId="select-all"
      labelKey="board.menu.selectAll"
      icon={ICONS.selectAll}
      shortcut="mod+a"
      onSelect={() => commands.select(selectAll(engine.store.getState().doc))}
    />,
    <Row key="zoom-fit" testId="zoom-fit" labelKey="board.zoom.fit" icon={ICONS.zoomToGroup} shortcut="shift+1" onSelect={() => commands.zoomToFit({ animate: true })} />,
  ];
  return <Groups groups={[create, history, select, view]} />;
}

function EdgeRows({ target }: { target: BoardContextTarget }) {
  const engine = useBoardEngine();
  const readOnly = useBoardSelector((state) => state.readOnly);
  const view = useViewRows(false);
  const id = target.id;
  const remove =
    readOnly || !id
      ? []
      : [<Row key="remove-edge" testId="remove-connection" labelKey="board.menu.removeConnection" icon={ICONS.remove} tone="danger" onSelect={() => engine.commands.disconnect([id])} />];
  return <Groups groups={[remove, view]} />;
}

export interface BoardContextMenuProps {
  /** paste the clipboard at a world point (the chrome's paste flow) */
  onPaste(at: Point): void;
}

export function BoardContextMenu({ onPaste }: BoardContextMenuProps) {
  const engine = useBoardEngine();
  const target = useBoardSelector((state) => state.ui.contextTarget);
  if (!target) return null;
  const close = () => {
    if (engine.store.getState().ui.contextTarget) engine.store.setUi({ contextTarget: null });
  };
  return (
    <DropdownMenu key={`${target.kind}-${target.id ?? ''}-${target.client.x}-${target.client.y}`} open modal={false} onOpenChange={(open) => (open ? undefined : close())}>
      <DropdownMenuTrigger asChild>
        <span className={styles.menuAnchor} style={{ left: target.client.x, top: target.client.y }} aria-hidden data-testid="board-menu-anchor" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={2}
        width="md"
        data-testid={`board-context-menu-${target.kind}`}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          engine.camera.elements()?.root.focus({ preventScroll: true });
        }}
      >
        {target.kind === 'node' ? (
          <NodeRows target={target} onPaste={onPaste} />
        ) : target.kind === 'edge' ? (
          <EdgeRows target={target} />
        ) : (
          <BackgroundRows target={target} onPaste={onPaste} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
