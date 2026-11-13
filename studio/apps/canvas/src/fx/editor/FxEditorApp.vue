<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Root of the design editor iframe (06 §3.6): pages and layers | canvas with the bottom toolbar |
 * design inspector, in a persistent horizontal splitter. No header, tab bar, menubar, home,
 * settings or share: the host page owns those. `$mod+\` hides both side panels.
 */
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from 'reka-ui';
import { tv } from 'tailwind-variants';
import { computed, onBeforeUnmount } from 'vue';

import { provideTabEditorStore } from '@/app/editor/active-store';
import splitterTheme from '@/theme/splitter';

import type { FxEditorStore } from '../store/types';
import FxCanvasStage from './FxCanvasStage.vue';
import FxEmptyHint from './FxEmptyHint.vue';
import FxInspector from './FxInspector.vue';
import FxLeftPanel from './FxLeftPanel.vue';
import FxOpViewer from './FxOpViewer.vue';
import FxShortcuts from './FxShortcuts.vue';
import FxToasts from './FxToasts.vue';
import FxToolbar from './FxToolbar.vue';
import { getEditorSession } from './session';
import { INSPECTOR_MIN_WIDTH_PX, LEFT_PANEL_MIN_WIDTH_PX, editorUi, trackViewportWidth } from './ui-state';

const { store } = defineProps<{ store: FxEditorStore }>();
provideTabEditorStore(store);

const stopTracking = trackViewportWidth();
onBeforeUnmount(stopTracking);

const splitter = tv(splitterTheme)({ direction: 'horizontal' });
// An `.op` document is not in the editor's graph: its pages and layers would show the empty one.
const showLeft = computed(() => editorUi.format !== 'op' && editorUi.panelsVisible && editorUi.viewportWidth >= LEFT_PANEL_MIN_WIDTH_PX);
const showRight = computed(() => editorUi.panelsVisible && editorUi.viewportWidth >= INSPECTOR_MIN_WIDTH_PX);
const busy = computed(() => editorUi.engine === 'loading' || editorUi.phase === 'booting' || editorUi.phase === 'waiting' || editorUi.phase === 'opening');
const editing = computed(() => editorUi.phase === 'ready' && !editorUi.readOnly);
const showOp = computed(() => editorUi.format === 'op' && editorUi.opBytes !== null);
const canConvertOp = computed(() => {
  void editorUi.format;
  void editorUi.readOnly;
  return getEditorSession()?.canConvertOp() ?? false;
});

function convertOp(svg: string) {
  void getEditorSession()?.convertOp(svg);
}
</script>

<template>
  <FxShortcuts>
    <div
      data-test-id="fantay-design-editor"
      :data-phase="editorUi.phase"
      :data-read-only="editorUi.readOnly || undefined"
      class="flex h-dvh w-dvw overflow-hidden bg-canvas text-surface antialiased"
    >
      <SplitterGroup
        v-if="editorUi.engine === 'ready'"
        direction="horizontal"
        auto-save-id="fantay-design-layout"
        class="min-w-0 flex-1"
      >
        <template v-if="showLeft">
          <SplitterPanel
            id="fx-design-left"
            :order="1"
            :default-size="18"
            :min-size="12"
            :max-size="30"
            class="min-w-0 border-r border-border bg-panel"
          >
            <FxLeftPanel :read-only="editorUi.readOnly" />
          </SplitterPanel>
          <SplitterResizeHandle id="fx-design-left-handle" :class="splitter.handle()">
            <div :class="splitter.divider()" />
          </SplitterResizeHandle>
        </template>

        <SplitterPanel id="fx-design-canvas" :order="2" :min-size="30" class="relative min-w-0">
          <FxOpViewer
            v-if="showOp"
            :bytes="editorUi.opBytes!"
            :name="editorUi.documentName"
            :can-convert="canConvertOp"
            @convert="convertOp"
          />
          <template v-else>
            <FxCanvasStage :read-only="editorUi.readOnly" />
            <FxEmptyHint v-if="editing" />
            <FxToolbar v-if="editing" />
          </template>
          <div
            v-if="busy"
            data-test-id="design-editor-busy"
            class="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas"
          >
            <span class="size-5 animate-spin rounded-full border-2 border-border border-t-accent motion-reduce:animate-none" aria-hidden="true" />
          </div>
          <div
            v-else-if="editorUi.phase === 'failed' && editorUi.failure"
            role="alert"
            class="absolute inset-0 flex items-center justify-center bg-canvas p-6"
          >
            <p class="m-0 max-w-md text-center text-xs leading-5 text-muted">{{ editorUi.failure }}</p>
          </div>
        </SplitterPanel>

        <template v-if="showRight">
          <SplitterResizeHandle id="fx-design-right-handle" :class="splitter.handle()">
            <div :class="splitter.divider()" />
          </SplitterResizeHandle>
          <SplitterPanel
            id="fx-design-right"
            :order="3"
            :default-size="20"
            :min-size="14"
            :max-size="32"
            class="min-w-0 border-l border-border bg-panel"
          >
            <FxInspector />
          </SplitterPanel>
        </template>
      </SplitterGroup>
      <div v-else class="flex flex-1 items-center justify-center" data-test-id="design-editor-booting">
        <span
          v-if="editorUi.engine === 'loading'"
          class="size-5 animate-spin rounded-full border-2 border-border border-t-accent motion-reduce:animate-none"
          aria-hidden="true"
        />
      </div>
      <FxToasts />
    </div>
  </FxShortcuts>
</template>
