<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/** Toolbar action: place image or SVG files at the centre of the view. */
import { useTemplateRef } from 'vue';
import IconImagePlus from '~icons/lucide/image-plus';

import { useEditorStore } from '@/app/editor/active-store';
import ToolButton from '@/components/toolbar/ToolButton.vue';
import Tip from '@/components/ui/overlay/Tip.vue';

import { t } from '../../host/i18n';
import { PLACE_IMAGE_ACCEPT } from './toolbar-layout';

const store = useEditorStore();
const input = useTemplateRef<HTMLInputElement>('input');

function pick() {
  input.value?.click();
}

async function onFiles(event: Event) {
  const target = event.target as HTMLInputElement;
  const files = [...(target.files ?? [])];
  target.value = '';
  if (files.length === 0) return;
  const { x, y } = store.viewportCanvasCenter();
  await store.placeFiles(files, x, y);
}
</script>

<template>
  <Tip :label="t('designEditor.toolbar.placeImage')">
    <ToolButton
      data-test-id="toolbar-place-image"
      :icon="IconImagePlus"
      :label="t('designEditor.toolbar.placeImage')"
      @click="pick"
    />
  </Tip>
  <input ref="input" type="file" :accept="PLACE_IMAGE_ACCEPT" multiple hidden @change="onFiles" />
</template>
