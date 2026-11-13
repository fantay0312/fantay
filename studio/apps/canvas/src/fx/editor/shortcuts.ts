// SPDX-License-Identifier: Apache-2.0
/**
 * Keyboard shortcuts of the design editor (06 §3.7). Bindings come from the SDK (tool keys,
 * `EDITOR_COMMAND_METADATA`) plus the Fantay rows of the table; handlers run in the capture
 * phase and never while typing in a field, editing text on the canvas, composing with an IME,
 * or (except undo/redo) while a menu, popover or dialog is open. Combos the host asked for
 * (`init.forwardShortcuts`) that the editor does not bind are forwarded as `shortcut` events.
 */
import {
  TOOL_SHORTCUTS,
  editorCommandMetadata,
  opacityFromBuffer,
  type EditorCommandId,
  type Tool,
} from '../engine/op';
import { setSnappingPreference } from '../compat/preferences-apply';
import type { FxEditorStore } from '../store/types';
import { copySelection, cutSelection, handlePasteEvent } from './clipboard';
import { detectKeyPlatform, isTypingEvent, matchesKeybinding, parseKeybinding, type KeyPlatform, type ParsedKeybinding } from './keybinding';
import { toastError } from './toasts';

export interface ShortcutContext {
  store: FxEditorStore;
  runCommand(id: EditorCommandId): void;
  setOpacityTarget(value: number, coalesceKey?: string): void;
  isReadOnly(): boolean;
  isOpDocument(): boolean;
  saveNow(): void;
  toggleUi(): void;
  forwardShortcuts(): readonly string[];
  closeOnEscape(): boolean;
  requestClose(): void;
  forwardShortcut(combo: string): void;
  clipboardBlockedMessage(): string;
  platform?: KeyPlatform;
  target?: Window;
}

type Action = (event: KeyboardEvent) => void;

interface Binding {
  keys: ParsedKeybinding;
  run: Action;
  /** Also edits the document: off for read-only documents. */
  edits: boolean;
  /** Runs while a popover, menu or picker is open (undo/redo, as in Figma). */
  history?: boolean;
  /** Tab: only while no control has focus, so Tab still walks the panels. */
  canvasFocusOnly?: boolean;
}

/** SDK commands bound by their metadata keybindings. */
export const METADATA_COMMANDS = [
  'edit.undo',
  'edit.redo',
  'selection.selectAll',
  'selection.selectInverse',
  'selection.selectParent',
  'selection.duplicate',
  'selection.group',
  'selection.ungroup',
  'selection.frameSelection',
  'selection.createComponent',
  'selection.createComponentSet',
  'selection.detachInstance',
  'selection.toggleMask',
  'selection.bringForward',
  'selection.bringToFront',
  'selection.sendBackward',
  'selection.sendToBack',
  'selection.toggleVisibility',
  'selection.toggleLock',
  'selection.flipHorizontal',
  'selection.flipVertical',
  'selection.booleanUnion',
  'selection.booleanSubtract',
  'selection.booleanIntersect',
  'selection.booleanExclude',
  'selection.flatten',
  'view.zoom100',
  'view.zoomFit',
  'view.zoomSelection',
  'view.zoomNextFrame',
  'view.zoomPreviousFrame',
  'view.nextPage',
  'view.previousPage',
] as const satisfies readonly EditorCommandId[];

const VIEW_ONLY_COMMANDS = new Set<string>([
  'view.zoom100',
  'view.zoomFit',
  'view.zoomSelection',
  'view.zoomNextFrame',
  'view.zoomPreviousFrame',
  'view.nextPage',
  'view.previousPage',
  'selection.selectAll',
  'selection.selectInverse',
  'selection.selectParent',
]);

const NUDGE_DELTAS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

const OVERLAY_SELECTOR = '[data-picker-content], [role="dialog"], [role="listbox"], [role="menu"]';
const OPEN_LAYER_SELECTOR = '[data-dismissable-layer]:not([data-state="closed"])';

function originatedInOverlay(event: KeyboardEvent): boolean {
  return event.composedPath().some((target) => target instanceof Element && target.matches(OVERLAY_SELECTOR));
}

function hasOpenLayer(doc: Document): boolean {
  return doc.querySelector(OPEN_LAYER_SELECTOR) !== null;
}

/** Enter/Space on a focused button activates the button, not a shortcut. */
function isButtonActivation(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.code !== 'Enter' && event.code !== 'Space') return false;
  return event.composedPath().some((target) => target instanceof HTMLButtonElement);
}

function isCanvasFocus(event: KeyboardEvent, doc: Document): boolean {
  return event.target === doc.body || event.target instanceof HTMLCanvasElement;
}

function metadataKeys(id: EditorCommandId): string[] {
  const binding = editorCommandMetadata(id).keybinding;
  return binding === undefined ? [] : Array.isArray(binding) ? binding : [binding];
}

export function buildBindings(ctx: ShortcutContext, platform: KeyPlatform): Binding[] {
  const { store } = ctx;
  const bindings: Binding[] = [];
  const add = (keys: string | readonly string[], run: Action, edits: boolean, extra: Partial<Binding> = {}) => {
    for (const key of typeof keys === 'string' ? [keys] : keys) bindings.push({ keys: parseKeybinding(key, platform), run, edits, ...extra });
  };
  const zoomAtCenter = (delta: number) => () => {
    const center = store.viewportScreenCenter();
    store.applyZoom(delta, center.x, center.y);
  };

  // Tools (COMMENT is not part of Fantay).
  for (const [keys, tool] of Object.entries(TOOL_SHORTCUTS)) {
    if (!tool || tool === 'COMMENT') continue;
    add(keys, () => store.setTool(tool as Tool), tool !== 'HAND');
  }

  for (const id of METADATA_COMMANDS) {
    const history = id === 'edit.undo' || id === 'edit.redo';
    add(metadataKeys(id), () => ctx.runCommand(id), !VIEW_ONLY_COMMANDS.has(id), { history });
  }

  // Enter: edit the selected text, commit a pen path, else select children (as Figma).
  add('Enter', () => {
    if (store.state.penState) {
      store.penCommit(false);
      return;
    }
    const selected = store.getSelectedNodes();
    const node = selected.length === 1 ? selected[0] : undefined;
    if (node?.type === 'TEXT') {
      requestAnimationFrame(() => {
        store.startTextEditing(node.id);
        store.textEditor?.selectAll();
        store.requestRender();
      });
      return;
    }
    ctx.runCommand('selection.selectChildren');
  }, true);

  // Tab / Shift+Tab walk sibling layers only while no control has focus.
  add(metadataKeys('selection.selectNextSibling'), () => ctx.runCommand('selection.selectNextSibling'), false, { canvasFocusOnly: true });
  add(metadataKeys('selection.selectPreviousSibling'), () => ctx.runCommand('selection.selectPreviousSibling'), false, { canvasFocusOnly: true });

  add(['Backspace', 'Delete'], () => ctx.runCommand('selection.delete'), true);

  // Shift+A adds auto layout to a selected frame (or turns it off), else wraps the selection.
  add('Shift+KeyA', () => {
    const selected = store.getSelectedNodes();
    const node = selected.length === 1 ? selected[0] : undefined;
    if (node?.type === 'FRAME') store.setLayoutMode(node.id, node.layoutMode === 'NONE' ? 'VERTICAL' : 'NONE');
    else if (selected.length > 0) ctx.runCommand('selection.wrapInAutoLayout');
  }, true);

  // Opacity: 1…9 → 10…90 %, 0 → 100 %; two quick digits set an exact value (55 → 55 %).
  let opacityBuffer = '';
  let opacitySelection = '';
  let opacityCoalesce = '';
  let opacityTimer: ReturnType<typeof setTimeout> | undefined;
  for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    add(`Digit${digit}`, () => {
      if (store.state.selectedIds.size === 0) return;
      const selection = [...store.state.selectedIds].sort().join('\0');
      if (selection !== opacitySelection) opacityBuffer = '';
      if (!opacityBuffer) {
        opacitySelection = selection;
        opacityCoalesce = `opacity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      opacityBuffer = (opacityBuffer + digit).slice(-3);
      ctx.setOpacityTarget(opacityFromBuffer(opacityBuffer), opacityCoalesce);
      ctx.runCommand('selection.setOpacity');
      clearTimeout(opacityTimer);
      opacityTimer = setTimeout(() => {
        opacityBuffer = '';
        opacitySelection = '';
      }, 800);
    }, true);
  }

  add(['$mod+Equal', '$mod+Shift+Equal'], zoomAtCenter(-100), false);
  add('$mod+Minus', zoomAtCenter(100), false);

  for (const [code, [dx, dy]] of Object.entries(NUDGE_DELTAS)) {
    add(code, () => {
      if (store.state.selectedIds.size > 0) store.nudgeSelected(dx, dy);
    }, true);
    add(`Shift+${code}`, () => {
      if (store.state.selectedIds.size > 0) store.nudgeSelected(dx * 10, dy * 10);
    }, true);
  }

  add('$mod+KeyC', () => {
    void copySelection(store).then((ok) => {
      if (!ok && store.state.selectedIds.size > 0) toastError(ctx.clipboardBlockedMessage());
      return undefined;
    });
  }, false);
  add('$mod+KeyX', () => {
    void cutSelection(store).then((ok) => {
      if (!ok) toastError(ctx.clipboardBlockedMessage());
      return undefined;
    });
  }, true);

  add('$mod+KeyS', () => ctx.saveNow(), false);

  add('Shift+KeyR', () => {
    store.state.showRulers = !store.state.showRulers;
    store.requestRepaint();
  }, false);
  add('Shift+Quote', () => {
    store.state.showPixelGrid = store.state.showPixelGrid === false;
    store.requestRepaint();
  }, false);
  add('$mod+Shift+Quote', () => setSnappingPreference('pixelGrid', !store.state.snappingPreferences.pixelGrid), false);

  add('$mod+Backslash', () => ctx.toggleUi(), false);

  add('Escape', () => {
    if (store.state.play) {
      store.stopPlay();
      return;
    }
    if (store.state.pencilState) {
      store.pencilCancel();
      return;
    }
    if (store.state.penState) {
      if (store.state.penState.vertices.length >= 2) store.penCommit(false);
      else store.penCancel();
      return;
    }
    if (store.state.enteredContainerId) {
      store.exitContainer();
      return;
    }
    if (store.state.selectedIds.size > 0) {
      store.clearSelection();
      if (!ctx.isReadOnly()) store.setTool('SELECT');
      return;
    }
    if (ctx.closeOnEscape()) ctx.requestClose();
  }, false);

  return bindings;
}

/** Installs the editor's key handling on `window` (capture phase); returns the uninstaller. */
export function installShortcuts(ctx: ShortcutContext): () => void {
  const target = ctx.target ?? window;
  const doc = target.document;
  const platform = ctx.platform ?? detectKeyPlatform();
  const bindings = buildBindings(ctx, platform);
  const { store } = ctx;
  let toolBeforeSpace: Tool | null = null;

  function restoreSpaceTool() {
    if (toolBeforeSpace === null) return;
    store.setTool(toolBeforeSpace);
    toolBeforeSpace = null;
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || isTypingEvent(event) || store.state.editingTextId || store.state.numberFieldFocused) return;
    if (isButtonActivation(event)) return;

    // Space held: the hand tool, back to the previous tool on release.
    if (event.code === 'Space' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (ctx.isOpDocument()) return;
      event.preventDefault();
      if (toolBeforeSpace === null && store.state.activeTool !== 'HAND') {
        toolBeforeSpace = store.state.activeTool;
        store.setTool('HAND');
      }
      return;
    }

    const overlay = originatedInOverlay(event) || hasOpenLayer(doc);
    const binding = bindings.find((candidate) => matchesKeybinding(event, candidate.keys, platform));
    if (binding) {
      if (overlay && !binding.history) return;
      if (binding.edits && ctx.isReadOnly()) return;
      if (binding.canvasFocusOnly && !isCanvasFocus(event, doc)) return;
      event.preventDefault();
      binding.run(event);
      return;
    }
    if (overlay) return;
    const forwarded = ctx.forwardShortcuts().find((combo) => {
      try {
        return matchesKeybinding(event, combo, platform);
      } catch {
        return false;
      }
    });
    if (forwarded) {
      event.preventDefault();
      ctx.forwardShortcut(forwarded);
    }
  }

  function onKeyUp(event: KeyboardEvent) {
    if (event.code === 'Space') restoreSpaceTool();
    if (event.code in NUDGE_DELTAS) store.flushNudge();
  }

  // Paste reads the native event (no clipboard permission needed); copy and cut run from keydown.
  function onPaste(event: ClipboardEvent) {
    if (isTypingEvent({ code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: event.target })) return;
    if (store.state.editingTextId || ctx.isReadOnly()) return;
    if (handlePasteEvent(store, event)) event.preventDefault();
  }

  target.addEventListener('keydown', onKeyDown, { capture: true });
  target.addEventListener('keyup', onKeyUp, { capture: true });
  target.addEventListener('blur', restoreSpaceTool);
  target.addEventListener('paste', onPaste);
  return () => {
    target.removeEventListener('keydown', onKeyDown, { capture: true });
    target.removeEventListener('keyup', onKeyUp, { capture: true });
    target.removeEventListener('blur', restoreSpaceTool);
    target.removeEventListener('paste', onPaste);
  };
}
