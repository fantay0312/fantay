<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  SPDX-FileCopyrightText: 2026 Fantay contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/EditorCanvas.vue
  Modified by Fantay: one pane; no AI chat, collaboration awareness, follow view, issue markers,
  comments, preparation overlay or play islands; read-only documents keep pan/zoom and selection
  but get no text editing, drops or context menu.
-->
<script setup lang="ts">
import { ContextMenuPortal, ContextMenuRoot, ContextMenuTrigger, PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui';
import { computed, onMounted, onUnmounted, ref, type Component } from 'vue';
import IconLucideAlignHorizontalSpaceBetween from '~icons/lucide/align-horizontal-space-between';
import IconLucideAlignVerticalSpaceBetween from '~icons/lucide/align-vertical-space-between';
import IconLucidePanelBottom from '~icons/lucide/panel-bottom';
import IconLucidePanelLeft from '~icons/lucide/panel-left';
import IconLucidePanelRight from '~icons/lucide/panel-right';
import IconLucidePanelTop from '~icons/lucide/panel-top';

import { useEditorStore } from '@/app/editor/active-store';
import { createCanvasContextSelection } from '@/app/editor/canvas/context-selection';
import { canvasOverlayObstacles } from '@/app/editor/canvas/obstacles';
import CanvasMenu from '@/components/canvas/CanvasMenu.vue';
import CanvasLabelEditor from '@/components/canvas/labels/CanvasLabelEditor.vue';
import { canvasLabelPresentation } from '@/components/canvas/labels/presentation';
import NumberField from '@/components/inputs/NumberField.vue';
import AppDropOverlay from '@/components/ui/feedback/AppDropOverlay.vue';
import { motionStyles } from '@/theme/motion/styles';
import { floatingSurface } from '@/theme/overlay';

import {
  AUTO_LAYOUT_PADDING_EDITOR_OFFSET_X,
  AUTO_LAYOUT_PADDING_EDITOR_OFFSET_Y,
  COMPONENT_LABEL_ICON_GAP,
  COMPONENT_LABEL_ICON_SIZE,
  SECTION_TITLE_GAP,
  SECTION_TITLE_HEIGHT,
  autoLayoutValueAnchor,
  toolCursor,
  useCanvas,
  useCanvasDrop,
  useCanvasInput,
  useCanvasVirtualReference,
  useTextEdit,
  type AutoLayoutValueField,
} from '../engine/op';
import { canAutoFocusCanvas, markCanvasGone, markCanvasReady } from './ui-state';

const { readOnly = false } = defineProps<{ readOnly?: boolean }>();

const store = useEditorStore();
const sceneCanvasRef = ref<HTMLCanvasElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const { selectAtContextPoint } = createCanvasContextSelection(canvasRef, store);

const onViewportResize = (width: number, height: number) => store.setViewportSize(width, height);

useCanvas(sceneCanvasRef, store, {
  layer: 'scene',
  sceneRenderer: 'retained',
  showRulers: false,
  onReady: markCanvasReady,
  onViewportResize,
});
const { hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle } = useCanvas(canvasRef, store, {
  layer: 'overlays',
  get showRulers() {
    return store.state.showRulers;
  },
  getOverlayObstacles: () => canvasOverlayObstacles(canvasRef.value),
  onViewportResize,
});
const {
  cursorOverride,
  canvasLabelEdit,
  updateCanvasLabelEdit,
  commitCanvasLabelEdit,
  cancelCanvasLabelEdit,
  autoLayoutValueEdit,
  updateAutoLayoutValueEdit,
  commitAutoLayoutValueEdit,
  cancelAutoLayoutValueEdit,
  cleanupInteractions,
} = useCanvasInput(canvasRef, store, hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle);
onUnmounted(() => {
  cleanupInteractions();
  markCanvasGone();
});

useTextEdit(canvasRef, store, { isEnabled: () => !store.readOnly.value });
const { isDraggingOver } = useCanvasDrop(canvasRef, store);

/** Read-only documents ignore dropped files before the SDK's drop handler sees them. */
function blockDrop(event: DragEvent) {
  if (!readOnly) return;
  event.preventDefault();
  event.stopPropagation();
}

const valueFieldIcons = {
  paddingTop: IconLucidePanelTop,
  paddingRight: IconLucidePanelRight,
  paddingBottom: IconLucidePanelBottom,
  paddingLeft: IconLucidePanelLeft,
} satisfies Record<Exclude<AutoLayoutValueField, 'itemSpacing'>, Component>;

const canvasLabelEditNode = computed(() => {
  const edit = canvasLabelEdit.value;
  return edit ? store.graph.getNode(edit.nodeId) : null;
});
const canvasLabelEditAnchor = computed(() => {
  const node = canvasLabelEditNode.value;
  if (!node) return null;
  const origin = store.graph.getAbsolutePosition(node.id);
  const { zoom, panX, panY } = store.state;
  const kind = canvasLabelEdit.value?.kind;
  // The canvas starts an upright label on a whole screen pixel; the field starts on the same one.
  const abs = {
    x: (Math.round(origin.x * zoom + panX) - panX) / zoom,
    y: (Math.round(origin.y * zoom + panY) - panY) / zoom,
  };
  // A component's name starts after its diamond, which keeps its screen size at any zoom.
  if (kind === 'component-label') return { x: abs.x + (COMPONENT_LABEL_ICON_SIZE + COMPONENT_LABEL_ICON_GAP) / zoom, y: abs.y };
  // A section inside another draws its title inside its top-left corner instead of above it.
  const nested = node.parentId && store.graph.closest(node.parentId, (candidate) => candidate.type === 'SECTION');
  if (kind === 'section-title' && nested) {
    const inset = SECTION_TITLE_GAP / zoom;
    return { x: abs.x + inset, y: abs.y + inset + (SECTION_TITLE_HEIGHT + SECTION_TITLE_GAP) / zoom };
  }
  return { x: abs.x, y: abs.y };
});
const canvasLabelEditReference = useCanvasVirtualReference(canvasRef, store, canvasLabelEditAnchor);
const canvasLabelEditPresentation = computed(() =>
  canvasLabelPresentation(store, canvasLabelEditNode.value ?? null, canvasLabelEdit.value?.kind),
);

const valueEditorAnchor = computed(() => {
  const edit = autoLayoutValueEdit.value;
  return edit ? autoLayoutValueAnchor(store, edit.nodeId, edit.field, edit.gap) : null;
});
const valueEditorReference = useCanvasVirtualReference(canvasRef, store, valueEditorAnchor);
const valueEditorIcon = computed(() => {
  const edit = autoLayoutValueEdit.value;
  if (!edit) return IconLucidePanelTop;
  if (edit.field !== 'itemSpacing') return valueFieldIcons[edit.field];
  return store.graph.getNode(edit.nodeId)?.layoutMode === 'VERTICAL'
    ? IconLucideAlignVerticalSpaceBetween
    : IconLucideAlignHorizontalSpaceBetween;
});

const cursor = computed(() => toolCursor(store.state.activeTool, cursorOverride.value));

onMounted(() => {
  if (canAutoFocusCanvas()) {
    canvasRef.value?.focus({ preventScroll: true });
  }
});
</script>

<template>
  <ContextMenuRoot :modal="false">
    <ContextMenuTrigger as-child :disabled="readOnly" @contextmenu.capture="selectAtContextPoint">
      <div
        data-test-id="canvas-area"
        class="canvas-area absolute inset-0 overflow-hidden"
        @dragenter.capture="blockDrop"
        @dragover.capture="blockDrop"
        @drop.capture="blockDrop"
      >
        <canvas
          ref="sceneCanvasRef"
          data-test-id="scene-canvas-element"
          aria-hidden="true"
          class="pointer-events-none absolute inset-0 size-full outline-none"
        />
        <canvas
          ref="canvasRef"
          data-test-id="canvas-element"
          tabindex="-1"
          :style="{ cursor }"
          class="absolute inset-0 block size-full touch-none outline-none"
        />
        <AppDropOverlay :visible="isDraggingOver && !readOnly" />
        <CanvasLabelEditor
          :edit="canvasLabelEdit"
          :presentation="canvasLabelEditPresentation"
          :reference="canvasLabelEditReference"
          @update="updateCanvasLabelEdit"
          @commit="commitCanvasLabelEdit"
          @cancel="cancelCanvasLabelEdit"
        />
        <PopoverRoot :open="!!autoLayoutValueEdit">
          <PopoverPortal>
            <PopoverContent
              v-if="autoLayoutValueEdit && valueEditorReference"
              :reference="valueEditorReference"
              side="top"
              align="center"
              :side-offset="AUTO_LAYOUT_PADDING_EDITOR_OFFSET_Y"
              :align-offset="AUTO_LAYOUT_PADDING_EDITOR_OFFSET_X"
              :collision-padding="8"
              :class="['z-50 w-20 p-1', floatingSurface, motionStyles.floating]"
              data-test-id="auto-layout-value-editor"
              @keydown.escape.prevent="cancelAutoLayoutValueEdit"
              @open-auto-focus.prevent
            >
              <NumberField
                :model-value="autoLayoutValueEdit.value"
                :min="0"
                :step="1"
                data-test-id="auto-layout-value-input"
                @update:model-value="updateAutoLayoutValueEdit"
                @commit="(value: number) => commitAutoLayoutValueEdit(value)"
                @editing-change="
                  (editing: boolean) => !editing && autoLayoutValueEdit && commitAutoLayoutValueEdit(autoLayoutValueEdit.value)
                "
              >
                <template #icon>
                  <component :is="valueEditorIcon" class="size-3.5" />
                </template>
              </NumberField>
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
      </div>
    </ContextMenuTrigger>

    <ContextMenuPortal>
      <CanvasMenu />
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
