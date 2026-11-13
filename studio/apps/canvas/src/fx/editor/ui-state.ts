// SPDX-License-Identifier: Apache-2.0
/**
 * View state of the editor iframe, shared by FxEditorApp, the session and the shortcuts. One
 * editor lives in each iframe, so this is a module singleton.
 */
import { reactive } from 'vue';
import type { DesignDocumentFormat } from '@open-design/contracts/runtime/design-editor-bridge';

export type EditorPhase = 'booting' | 'waiting' | 'opening' | 'ready' | 'failed';

export interface OpViewerControls {
  zoomIn(): void;
  zoomOut(): void;
  zoomFit(): void;
  zoom100(): void;
  exportSvg(): string | null;
}

export const UI_STORAGE_KEY = 'fantay:design:ui';
/** Below this width the inspector is hidden (06 §3.6). */
export const INSPECTOR_MIN_WIDTH_PX = 720;
/** Below this width the pages/layers panel is hidden too, leaving the canvas and its toolbar. */
export const LEFT_PANEL_MIN_WIDTH_PX = 480;

function readPanelsVisible(): boolean {
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(UI_STORAGE_KEY) ?? 'null');
    if (stored && typeof stored === 'object' && typeof (stored as { panels?: unknown }).panels === 'boolean') {
      return (stored as { panels: boolean }).panels;
    }
  } catch {
    // Unreadable storage keeps the panels shown.
  }
  return true;
}

export const editorUi = reactive({
  /** CanvasKit and the bundled fonts. */
  engine: 'loading' as 'loading' | 'ready' | 'failed',
  phase: 'booting' as EditorPhase,
  /** Message shown in the failed state (already translated by the host's messages). */
  failure: '',
  format: null as DesignDocumentFormat | null,
  /** The open document cannot be saved (legacy preview, viewer access, forbidden). */
  readOnly: false,
  /** Whether the host iframe is currently visible and interactive. */
  visible: true,
  legacy: false,
  documentName: '',
  /** Bytes of the open `.op` document (shown by FxOpViewer). */
  opBytes: null as Uint8Array | null,
  /** $mod+\ hides both side panels; persisted. */
  panelsVisible: readPanelsVisible(),
  /** The iframe's width, followed on resize (narrow iframes hide the side panels). */
  viewportWidth: typeof window === 'undefined' ? 1440 : window.innerWidth,
});

export function canAutoFocusCanvas(win: Window = window): boolean {
  if (!editorUi.visible) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  try {
    const params = new URLSearchParams(win.location?.search ?? '');
    if (params.get('headless') === '1' || params.get('interactive') === '0') return false;
  } catch {
    // Ignore URL parsing errors in synthetic test windows.
  }
  try {
    const frame = win.frameElement as HTMLElement | null;
    if (frame) {
      if (frame.getAttribute('aria-hidden') === 'true' || frame.tabIndex < 0) return false;
      if (frame.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
    }
  } catch {
    // Cross-origin frameElement access throws; fall back to bridge visibility state.
  }
  return true;
}

/** Follows the iframe width; returns the stop function. */
export function trackViewportWidth(win: Window = window): () => void {
  const update = () => {
    editorUi.viewportWidth = win.innerWidth;
  };
  update();
  win.addEventListener('resize', update);
  return () => win.removeEventListener('resize', update);
}

export function setPanelsVisible(visible: boolean): void {
  editorUi.panelsVisible = visible;
  try {
    globalThis.localStorage?.setItem(UI_STORAGE_KEY, JSON.stringify({ panels: visible }));
  } catch {
    // Storage may be unavailable; the toggle still applies to this session.
  }
}

let opControls: OpViewerControls | null = null;

export function registerOpViewer(controls: OpViewerControls | null): void {
  opControls = controls;
}

export function opViewer(): OpViewerControls | null {
  return opControls;
}

let resolveCanvas: (() => void) | null = null;
let canvasReady = new Promise<void>((resolve) => {
  resolveCanvas = resolve;
});

/** Called by FxCanvasStage once the scene surface exists (renderer and viewport size known). */
export function markCanvasReady(): void {
  resolveCanvas?.();
  resolveCanvas = null;
}

/** Called when the canvas stage unmounts (e.g. an `.op` document replaced it). */
export function markCanvasGone(): void {
  if (resolveCanvas) return;
  canvasReady = new Promise<void>((resolve) => {
    resolveCanvas = resolve;
  });
}

export function whenCanvasReady(): Promise<void> {
  return canvasReady;
}
