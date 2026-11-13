// SPDX-License-Identifier: Apache-2.0
/**
 * Design editor entry (06 §3.2, §5.1). Runs inside the host's iframe: says hello to the parent
 * at once, loads CanvasKit and the bundled fonts, and mounts the editor. Opened directly (no
 * parent window) it only shows where design files are opened.
 */
import { createApp } from 'vue';
import { VERSION as OP_WEB_SDK_VERSION } from '@zseven-w/op-web-sdk';

import './theme/index.css';

import canvasPackage from '../package.json';
import { setActiveEditorStore } from './fx/compat/active-store';
import { downloadBytes } from './fx/editor/download';
import FxEditorApp from './fx/editor/FxEditorApp.vue';
import { startEditorSession } from './fx/editor/session';
import { editorUi } from './fx/editor/ui-state';
import { createRetainedScopePlugin, fontManager, getCanvasKit, OPEN_PENCIL_VERSION } from './fx/engine/op';
import { createFxEditorStore } from './fx/store/create-store';
import { connectEditorBridge } from './host/bridge';
import { STANDALONE_NOTICE } from './host/i18n';
import { applyTheme, normalizeTheme } from './host/theme';

const ASSET_BASE = '/canvas-editor/';
const CJK_FONT_FAMILY = 'Noto Sans CJK SC';

function showStandaloneNotice(): void {
  const root = document.getElementById('app');
  if (!root) return;
  const notice = document.createElement('p');
  notice.setAttribute('role', 'note');
  notice.textContent = STANDALONE_NOTICE;
  notice.style.cssText = 'margin:0;display:flex;height:100%;align-items:center;justify-content:center;padding:24px;text-align:center;font:13px/1.6 var(--font-sans);color:var(--color-muted)';
  root.replaceChildren(notice);
}

async function loadEngine(): Promise<void> {
  fontManager.setBundledFontLocator((file) => `${ASSET_BASE}${file}`);
  const [, cjkFont] = await Promise.all([
    getCanvasKit({ locateFile: (file: string) => `${ASSET_BASE}${file}` }),
    fetch(`${ASSET_BASE}NotoSansCJKsc-Regular.otf`).then((response) => {
      if (!response.ok) throw new Error('The bundled CJK font is unavailable');
      return response.arrayBuffer();
    }),
    document.fonts?.load('13px Inter').catch(() => undefined),
  ]);
  fontManager.markLoaded(CJK_FONT_FAMILY, 'Regular', cjkFont, 'bundled');
  fontManager.setCJKFallbackFamily(CJK_FONT_FAMILY);
}

function boot(): void {
  applyTheme(normalizeTheme(new URLSearchParams(location.search).get('theme')));
  const bridge = connectEditorBridge(window, {
    editorVersion: canvasPackage.version,
    engines: { openPencil: OPEN_PENCIL_VERSION, opWebSdk: OP_WEB_SDK_VERSION },
    capabilities: [
      'document.open',
      'document.flush',
      'document.saveCopy',
      'document.forceSave',
      'document.exportCover',
      'document.exportHtml',
      'view.command',
      'selection.set',
      'insert',
      'focus',
      'asset.fetch',
    ],
  });
  if (!bridge) {
    showStandaloneNotice();
    return;
  }

  const store = createFxEditorStore({
    getViewportElement: () => document.querySelector<HTMLElement>('[data-test-id="canvas-area"]'),
    downloadFile: downloadBytes,
  });
  setActiveEditorStore(store);

  const engineReady = loadEngine();
  startEditorSession({ store, bridge, engineReady });
  engineReady.then(
    () => {
      editorUi.engine = 'ready';
    },
    (error: unknown) => {
      editorUi.engine = 'failed';
      editorUi.phase = 'failed';
      console.error('[fantay-design] engine failed to load', error);
    },
  );

  const app = createApp(FxEditorApp, { store });
  app.use(createRetainedScopePlugin());
  app.config.errorHandler = (error, _instance, info) => {
    console.error('[fantay-design]', info, error);
  };
  app.mount('#app');
}

boot();
