<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * `.op` documents: ZSeven's read-only viewer (06 §8.3) with a floating bar for zoom, SVG export
 * and the lossy conversion to an editable design (saved by the session as a new `.fig`).
 */
import { createViewer, type OpViewer } from '@zseven-w/op-web-sdk';
import { onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';

import AppButton from '@/components/ui/button/AppButton.vue';
import IconButton from '@/components/ui/button/IconButton.vue';

import { t } from '../../host/i18n';
import { useI18n } from '../engine/op';
import { ensureOpCanvasKitInit, OP_WASM_URL } from '../interop/op';
import { toastError } from './toasts';
import { registerOpViewer } from './ui-state';

const { bytes, name, canConvert = false } = defineProps<{ bytes: Uint8Array; name: string; canConvert?: boolean }>();
const emit = defineEmits<{ convert: [svg: string] }>();

const { menu, commands } = useI18n();
const canvas = useTemplateRef<HTMLCanvasElement>('canvas');
const host = useTemplateRef<HTMLElement>('host');
const viewer = shallowRef<OpViewer | null>(null);
const zoom = ref(1);
let resizeObserver: ResizeObserver | null = null;
let stopViewportEvents: (() => void) | null = null;

function size() {
  const element = host.value;
  return { width: Math.max(1, element?.clientWidth ?? 900), height: Math.max(1, element?.clientHeight ?? 700) };
}

function syncZoom() {
  zoom.value = viewer.value?.viewport.zoom ?? 1;
}

function exportSvg(): string | null {
  try {
    const data = viewer.value?.export({ format: 'svg' });
    return data ? new TextDecoder().decode(data) : null;
  } catch {
    return null;
  }
}

function setZoom(level: number) {
  viewer.value?.setZoom(Math.min(64, Math.max(0.02, level)));
  syncZoom();
}

function zoomFit() {
  const { width, height } = size();
  viewer.value?.zoomToFit(width, height);
  syncZoom();
}

function downloadSvg() {
  const svg = exportSvg();
  if (!svg) {
    toastError(t('designEditor.toast.exportFailed', { reason: 'SVG' }));
    return;
  }
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name || 'design'}.svg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function convert() {
  const svg = exportSvg();
  if (svg) emit('convert', svg);
  else toastError(t('designEditor.toast.exportFailed', { reason: 'SVG' }));
}

async function mountViewer(source: Uint8Array) {
  stopViewportEvents?.();
  stopViewportEvents = null;
  viewer.value?.destroy();
  viewer.value = null;
  const element = canvas.value;
  if (!element) return;
  const { width, height } = size();
  element.width = width;
  element.height = height;
  try {
    await ensureOpCanvasKitInit();
    viewer.value = await createViewer({ canvas: element, doc: source, wasmUrl: OP_WASM_URL });
    stopViewportEvents = viewer.value.on('viewportchange', syncZoom);
    zoomFit();
  } catch (error) {
    toastError(t('designEditor.loadFailed', { reason: error instanceof Error ? error.message : String(error) }));
  }
}

onMounted(() => {
  void mountViewer(bytes);
  registerOpViewer({
    zoomIn: () => setZoom(zoom.value * 1.25),
    zoomOut: () => setZoom(zoom.value * 0.8),
    zoomFit,
    zoom100: () => setZoom(1),
    exportSvg,
  });
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    resizeObserver = new ResizeObserver(() => {
      const element = canvas.value;
      const current = viewer.value;
      if (!element || !current) return;
      const { width, height } = size();
      element.width = width;
      element.height = height;
      current.setViewport(current.viewport);
    });
    resizeObserver.observe(host.value);
  }
});

watch(
  () => bytes,
  (next) => void mountViewer(next),
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  stopViewportEvents?.();
  registerOpViewer(null);
  viewer.value?.destroy();
  viewer.value = null;
});
</script>

<template>
  <div ref="host" data-test-id="op-viewer" class="absolute inset-0 overflow-hidden">
    <canvas id="fantay-op-preview" ref="canvas" class="block size-full" :aria-label="name" />
    <div
      data-canvas-obstacle
      class="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl bg-panel p-1 shadow-[var(--shadow-float)]"
    >
      <IconButton :label="menu.zoomOut" size="sm" data-test-id="op-zoom-out" @click="setZoom(zoom * 0.8)">
        <icon-lucide-minus class="size-3.5" />
      </IconButton>
      <AppButton size="sm" variant="ghost" :aria-label="commands.zoomToFit" data-test-id="op-zoom-fit" class="tabular-nums" @click="zoomFit">
        {{ Math.round(zoom * 100) }}%
      </AppButton>
      <IconButton :label="menu.zoomIn" size="sm" data-test-id="op-zoom-in" @click="setZoom(zoom * 1.25)">
        <icon-lucide-plus class="size-3.5" />
      </IconButton>
      <span class="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <AppButton size="sm" variant="ghost" data-test-id="op-export-svg" @click="downloadSvg">
        {{ t('designEditor.op.exportSvg') }}
      </AppButton>
      <AppButton v-if="canConvert" size="sm" color="primary" variant="soft" data-test-id="op-convert" @click="convert">
        {{ t('designEditor.op.convert') }}
      </AppButton>
    </div>
  </div>
</template>
