// SPDX-License-Identifier: AGPL-3.0-only
// Board shortcuts (spec 03 §3.10, plan R7/B5): resolved by a pure function, run only while the board is the
// active root tab and focused (last press or focus inside the board root), never in typing targets, IME
// composition, `data-board-interactive` regions or while a dialog/menu is open. Copy/cut/paste use DOM clipboard
// events (chrome), not keydown. Global app shortcuts (⌘, ⌘1–9 ⌘P ⌘⇧K mod+\) are left alone.
import { useEffect, type RefObject } from 'react';

import { ensureVisible } from '../camera/camera';
import { BOARD_INTERACTIVE_ATTR } from '../extensions';
import type { BoardNodeMode, BoardTool, DictKey } from '../model/types';
import { cycleSelection, selectAll } from '../store/selection';
import type { BoardEngine } from '../store/board-engine';
import { toolForKey } from './tools';

export type BoardShortcutId =
  | 'tool.select' | 'tool.hand' | 'tool.frame' | 'tool.rectangle' | 'tool.ellipse' | 'tool.pen' | 'tool.text' | 'tool.generate' | 'tool.note'
  | 'tool.comment'
  | 'zoom.in' | 'zoom.out' | 'zoom.reset' | 'zoom.fit' | 'zoom.selection'
  | 'edit.undo' | 'edit.redo' | 'edit.selectAll' | 'edit.duplicate' | 'edit.delete' | 'edit.group' | 'edit.ungroup'
  | 'edit.lock' | 'edit.forward' | 'edit.backward' | 'edit.front' | 'edit.back' | 'edit.rename'
  | 'nudge.left' | 'nudge.right' | 'nudge.up' | 'nudge.down'
  | 'node.enter' | 'mode.edit' | 'mode.capture' | 'escape' | 'select.next' | 'select.prev' | 'help';

export interface BoardShortcut {
  id: BoardShortcutId;
  /** display form for `formatShortcut` (`mod` = ⌘ on macOS, Ctrl elsewhere) */
  keys: string;
  labelKey: DictKey;
  when: 'always' | 'selection' | 'single-live';
}

/**
 * The shortcut sheet rows. `select.next/prev` reuse `board.shortcuts.title` and `zoom.reset` reuses
 * `board.zoom.level` until dedicated keys land (i18n-extra `board.shortcut.cycle`, `board.shortcut.zoomReset`).
 */
export const BOARD_SHORTCUTS: readonly BoardShortcut[] = [
  { id: 'tool.select', keys: 'v', labelKey: 'board.tool.select', when: 'always' },
  { id: 'tool.hand', keys: 'h', labelKey: 'board.tool.hand', when: 'always' },
  { id: 'tool.frame', keys: 'f', labelKey: 'board.tool.frame', when: 'always' },
  { id: 'tool.rectangle', keys: 'r', labelKey: 'board.tool.rectangle', when: 'always' },
  { id: 'tool.pen', keys: 'p', labelKey: 'board.tool.pen', when: 'always' },
  { id: 'tool.ellipse', keys: 'o', labelKey: 'board.tool.ellipse', when: 'always' },
  { id: 'tool.text', keys: 't', labelKey: 'board.tool.text', when: 'always' },
  { id: 'tool.generate', keys: 'g', labelKey: 'board.tool.generate', when: 'always' },
  { id: 'tool.note', keys: 'n', labelKey: 'board.tool.note', when: 'always' },
  { id: 'tool.comment', keys: 'c', labelKey: 'board.tool.comment', when: 'always' },
  { id: 'zoom.in', keys: 'mod+=', labelKey: 'board.zoom.in', when: 'always' },
  { id: 'zoom.out', keys: 'mod+-', labelKey: 'board.zoom.out', when: 'always' },
  { id: 'zoom.reset', keys: 'mod+0', labelKey: 'board.shortcut.zoomReset', when: 'always' },
  { id: 'zoom.fit', keys: 'shift+1', labelKey: 'board.zoom.fit', when: 'always' },
  { id: 'zoom.selection', keys: 'shift+2', labelKey: 'board.zoom.selection', when: 'selection' },
  { id: 'edit.undo', keys: 'mod+z', labelKey: 'board.menu.undo', when: 'always' },
  { id: 'edit.redo', keys: 'mod+shift+z', labelKey: 'board.menu.redo', when: 'always' },
  { id: 'edit.selectAll', keys: 'mod+a', labelKey: 'board.menu.selectAll', when: 'always' },
  { id: 'edit.duplicate', keys: 'mod+d', labelKey: 'board.menu.duplicate', when: 'selection' },
  { id: 'edit.delete', keys: 'delete', labelKey: 'board.menu.remove', when: 'selection' },
  { id: 'edit.group', keys: 'mod+g', labelKey: 'board.menu.group', when: 'selection' },
  { id: 'edit.ungroup', keys: 'mod+shift+g', labelKey: 'board.menu.ungroup', when: 'selection' },
  { id: 'edit.lock', keys: 'mod+shift+l', labelKey: 'board.menu.lock', when: 'selection' },
  { id: 'edit.forward', keys: 'mod+]', labelKey: 'board.menu.bringForward', when: 'selection' },
  { id: 'edit.backward', keys: 'mod+[', labelKey: 'board.menu.sendBackward', when: 'selection' },
  { id: 'edit.front', keys: 'mod+alt+]', labelKey: 'board.menu.bringToFront', when: 'selection' },
  { id: 'edit.back', keys: 'mod+alt+[', labelKey: 'board.menu.sendToBack', when: 'selection' },
  { id: 'edit.rename', keys: 'f2', labelKey: 'board.shortcut.rename', when: 'selection' },
  { id: 'nudge.left', keys: 'left', labelKey: 'board.shortcut.nudge', when: 'selection' },
  { id: 'nudge.right', keys: 'right', labelKey: 'board.shortcut.nudge', when: 'selection' },
  { id: 'nudge.up', keys: 'up', labelKey: 'board.shortcut.nudge', when: 'selection' },
  { id: 'nudge.down', keys: 'down', labelKey: 'board.shortcut.nudge', when: 'selection' },
  { id: 'node.enter', keys: 'enter', labelKey: 'board.shortcut.enter', when: 'selection' },
  { id: 'mode.edit', keys: 'e', labelKey: 'board.mode.edit', when: 'single-live' },
  { id: 'mode.capture', keys: 'shift+c', labelKey: 'board.mode.capture', when: 'single-live' },
  { id: 'escape', keys: 'escape', labelKey: 'board.shortcut.exit', when: 'always' },
  { id: 'select.next', keys: 'tab', labelKey: 'board.shortcut.cycle', when: 'always' },
  { id: 'select.prev', keys: 'shift+tab', labelKey: 'board.shortcut.cycle', when: 'always' },
  { id: 'help', keys: '?', labelKey: 'board.shortcuts.open', when: 'always' },
];

export interface ShortcutEventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
}

export interface ShortcutContext {
  isMac: boolean;
  /** a node or a connection is selected */
  hasSelection: boolean;
  /** kind of the single selected frame/web node (E/C apply), else null */
  singleLive: 'frame' | 'web' | null;
  mode: BoardNodeMode | null;
}

const ARROWS: Readonly<Record<string, BoardShortcutId>> = {
  ArrowLeft: 'nudge.left',
  ArrowRight: 'nudge.right',
  ArrowUp: 'nudge.up',
  ArrowDown: 'nudge.down',
};

const TOOL_SHORTCUTS: Readonly<Record<BoardTool, BoardShortcutId>> = {
  select: 'tool.select',
  hand: 'tool.hand',
  frame: 'tool.frame',
  rectangle: 'tool.rectangle',
  ellipse: 'tool.ellipse',
  pen: 'tool.pen',
  text: 'tool.text',
  generate: 'tool.generate',
  note: 'tool.note',
  comment: 'tool.comment',
};

/** The board shortcut a key press means, or null (pure; the board-active rule is applied by the caller). */
export function resolveShortcut(e: ShortcutEventLike, ctx: ShortcutContext): BoardShortcutId | null {
  const mod = ctx.isMac ? e.metaKey : e.ctrlKey;
  const otherMod = ctx.isMac ? e.ctrlKey : e.metaKey;
  const key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (mod) {
    if (otherMod) return null;
    if (e.altKey) {
      if (key === ']' || e.code === 'BracketRight') return ctx.hasSelection ? 'edit.front' : null;
      if (key === '[' || e.code === 'BracketLeft') return ctx.hasSelection ? 'edit.back' : null;
      return null;
    }
    if (lower === 'z') return e.shiftKey ? 'edit.redo' : 'edit.undo';
    if (!ctx.isMac && lower === 'y' && !e.shiftKey) return 'edit.redo';
    /* '+' arrives as ⇧= on most layouts */
    if (key === '=' || key === '+') return 'zoom.in';
    if (e.shiftKey) {
      if (lower === 'g') return ctx.hasSelection ? 'edit.ungroup' : null;
      if (lower === 'l') return ctx.hasSelection ? 'edit.lock' : null;
      return null;
    }
    if (key === '-') return 'zoom.out';
    if (key === '0') return 'zoom.reset';
    if (lower === 'a') return 'edit.selectAll';
    if (lower === 'd') return ctx.hasSelection ? 'edit.duplicate' : null;
    if (lower === 'g') return ctx.hasSelection ? 'edit.group' : null;
    if (key === ']' || e.code === 'BracketRight') return ctx.hasSelection ? 'edit.forward' : null;
    if (key === '[' || e.code === 'BracketLeft') return ctx.hasSelection ? 'edit.backward' : null;
    return null;
  }
  if (otherMod || e.altKey) return null;
  /* by code: ⇧1 types '!' on most layouts, so the key name is no use */
  if (e.shiftKey && e.code === 'Digit1') return 'zoom.fit';
  if (e.shiftKey && e.code === 'Digit2') return ctx.hasSelection ? 'zoom.selection' : null;
  if (key === 'Escape') return 'escape';
  if (key === 'Tab') return e.shiftKey ? 'select.prev' : 'select.next';
  if (key === '?') return 'help';
  const arrow = ARROWS[key];
  if (arrow) return ctx.hasSelection ? arrow : null;
  if (key === 'Delete' || key === 'Backspace') return ctx.hasSelection ? 'edit.delete' : null;
  if (key === 'F2') return ctx.hasSelection ? 'edit.rename' : null;
  if (key === 'Enter') return ctx.hasSelection && !e.shiftKey ? 'node.enter' : null;
  /* ⇧C captures (bare C is the Comment tool, as in Claude Design) */
  if (e.shiftKey && !e.repeat && lower === 'c') return ctx.singleLive ? 'mode.capture' : null;
  if (e.shiftKey || e.repeat) return null;
  if (lower === 'e') return ctx.singleLive === 'frame' ? 'mode.edit' : null;
  const tool = toolForKey(key);
  return tool ? TOOL_SHORTCUTS[tool] : null;
}

/** INPUT / TEXTAREA / SELECT / contenteditable, dialog/menu/listbox, or anything inside a `data-board-interactive` region (R6, B21c). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.closest('[contenteditable=""],[contenteditable="true"]')) return true;
  if (target.closest('dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')) return true;
  return target.closest(`[${BOARD_INTERACTIVE_ATTR}]`) !== null;
}

const ACTIVATION_SELECTOR =
  'button, a[href], summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="slider"]';

/** A focused control that Space/Enter activate and arrows/Tab navigate (chrome buttons, segmented items…). */
export function isActivationTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ACTIVATION_SELECTOR) !== null;
}

/** Keys a focused control keeps for itself; the board shortcut runs only when no control has focus. */
const CONTROL_KEYS: ReadonlySet<BoardShortcutId> = new Set<BoardShortcutId>([
  'node.enter', 'select.next', 'select.prev', 'nudge.left', 'nudge.right', 'nudge.up', 'nudge.down',
]);

/** A Fantay/Radix dialog or menu is open (its own keys win). */
export function isOverlayOpen(doc: Document = document): boolean {
  return doc.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[role="menu"][data-state="open"]') !== null;
}

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

const READ_ONLY_SHORTCUTS: ReadonlySet<BoardShortcutId> = new Set<BoardShortcutId>([
  'tool.select', 'tool.hand', 'zoom.in', 'zoom.out', 'zoom.reset', 'zoom.fit', 'zoom.selection', 'edit.selectAll',
  'node.enter', 'escape', 'select.next', 'select.prev', 'help',
]);

/** Shortcut context of the current engine state. */
export function shortcutContextOf(engine: BoardEngine, isMac = isMacPlatform()): ShortcutContext {
  const { ui, doc } = engine.store.getState();
  const single = ui.selection.length === 1 ? doc.nodes.get(ui.selection[0]!) : undefined;
  return {
    isMac,
    hasSelection: ui.selection.length > 0 || ui.selectedEdgeId !== null,
    singleLive: single && (single.kind === 'frame' || single.kind === 'web') ? single.kind : null,
    mode: ui.mode?.mode ?? null,
  };
}

/** Runs a resolved shortcut; true when it was handled (the caller prevents the default). */
export function runShortcut(engine: BoardEngine, id: BoardShortcutId, event: Pick<ShortcutEventLike, 'shiftKey'>): boolean {
  const { store, commands, pointer } = engine;
  const state = store.getState();
  const { ui, doc } = state;
  if (state.readOnly && !READ_ONLY_SHORTCUTS.has(id)) return false;
  const selection = ui.selection;
  const step = event.shiftKey ? 10 : 1;
  switch (id) {
    case 'tool.select': commands.setTool('select'); return true;
    case 'tool.hand': commands.setTool('hand'); return true;
    case 'tool.frame': commands.setTool('frame'); return true;
    case 'tool.rectangle': commands.setTool('rectangle'); return true;
    case 'tool.pen': commands.setTool('pen'); return true;
    case 'tool.ellipse': commands.setTool('ellipse'); return true;
    case 'tool.text': commands.setTool('text'); return true;
    case 'tool.generate': commands.setTool('generate'); return true;
    case 'tool.note': commands.setTool('note'); return true;
    case 'tool.comment': commands.setTool('comment'); return true;
    case 'zoom.in': commands.zoomIn(); return true;
    case 'zoom.out': commands.zoomOut(); return true;
    case 'zoom.reset': commands.zoomTo(1); return true;
    case 'zoom.fit': commands.zoomToFit(); return true;
    case 'zoom.selection': commands.zoomToSelection(); return true;
    case 'edit.undo': void commands.undo(); return true;
    case 'edit.redo': void commands.redo(); return true;
    case 'edit.selectAll': commands.select(selectAll(doc)); return true;
    case 'edit.duplicate': void commands.duplicate(selection); return true;
    case 'edit.delete':
      if (ui.selectedEdgeId) commands.disconnect([ui.selectedEdgeId]);
      else commands.removeNodes(selection);
      return true;
    case 'edit.group': commands.group(selection); return true;
    case 'edit.ungroup': commands.ungroup(selection); return true;
    case 'edit.lock': {
      const locked = selection.every((nodeId) => doc.nodes.get(nodeId)?.locked === true);
      commands.setLocked(selection, !locked);
      return true;
    }
    case 'edit.forward': commands.reorder(selection, 'forward'); return true;
    case 'edit.backward': commands.reorder(selection, 'backward'); return true;
    case 'edit.front': commands.reorder(selection, 'front'); return true;
    case 'edit.back': commands.reorder(selection, 'back'); return true;
    case 'edit.rename':
      if (selection[0]) commands.startRename(selection[0]);
      return true;
    case 'nudge.left': commands.nudge(selection, -step, 0); return true;
    case 'nudge.right': commands.nudge(selection, step, 0); return true;
    case 'nudge.up': commands.nudge(selection, 0, -step); return true;
    case 'nudge.down': commands.nudge(selection, 0, step); return true;
    case 'node.enter':
      if (selection.length !== 1) return false;
      commands.enterNode(selection[0]!);
      return true;
    case 'mode.edit':
      if (selection[0]) commands.setMode(selection[0], 'edit');
      return true;
    case 'mode.capture':
      if (selection[0]) commands.setMode(selection[0], 'capture');
      return true;
    case 'escape':
      /* cancel a gesture → un-maximize → leave the mode → clear the selection → back to Select */
      if (pointer.cancel()) return true;
      if (ui.connectMenu || ui.contextTarget) {
        store.setUi({ connectMenu: null, contextTarget: null });
        return true;
      }
      if (ui.maximized) {
        commands.toggleMaximize(ui.maximized.nodeId);
        return true;
      }
      if (ui.mode) {
        commands.setMode(null);
        return true;
      }
      if (ui.renamingId) {
        commands.stopRename();
        return true;
      }
      if (selection.length > 0 || ui.selectedEdgeId) {
        commands.clearSelection();
        return true;
      }
      if (ui.tool !== 'select') {
        commands.setTool('select');
        return true;
      }
      return false;
    case 'select.next':
    case 'select.prev': {
      const next = cycleSelection(doc, selection, id === 'select.next' ? 1 : -1);
      if (!next) return false;
      commands.select([next]);
      const node = doc.nodes.get(next);
      if (node) {
        const { camera } = engine;
        const before = camera.get();
        const after = ensureVisible(before, node, camera.stageSize());
        if (after !== before) camera.set(after, 'program');
      }
      return true;
    }
    case 'help':
      store.setUi({ shortcutsOpen: true });
      return true;
    default:
      return false;
  }
}

/**
 * Board keyboard handling. Active only while `active` (the 画板 tab is visible); a key counts for the board when
 * the last press landed inside `rootRef` or focus is inside it.
 */
export function useBoardKeyboard(engine: BoardEngine, rootRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    let pressInside = false;
    const inside = (): boolean => {
      const root = rootRef.current;
      if (!root) return false;
      return pressInside || root.contains(document.activeElement);
    };
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      pressInside = !!root && event.target instanceof Node && root.contains(event.target);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !inside()) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
      if (isOverlayOpen()) return;
      const control = isActivationTarget(event.target) || isActivationTarget(document.activeElement);
      if (event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (control) return; // Space activates the focused button
        event.preventDefault();
        if (!event.repeat && !engine.store.getState().ui.spaceHeld) engine.store.setUi({ spaceHeld: true });
        return;
      }
      const id = resolveShortcut(event, shortcutContextOf(engine));
      if (!id) return;
      if (control && (CONTROL_KEYS.has(id) || (!event.metaKey && !event.ctrlKey && id !== 'escape'))) return;
      if (runShortcut(engine, id, event)) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === ' ' && engine.store.getState().ui.spaceHeld) engine.store.setUi({ spaceHeld: false });
    };
    const onBlur = (): void => {
      if (engine.store.getState().ui.spaceHeld) engine.store.setUi({ spaceHeld: false });
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      onBlur();
    };
  }, [engine, rootRef, active]);
}
