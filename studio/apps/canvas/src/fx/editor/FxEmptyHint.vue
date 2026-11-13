<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/** A centred hint while the current page has no layers. */
import { computed } from 'vue';

import { useEditorStore } from '@/app/editor/active-store';

import { t } from '../../host/i18n';

const store = useEditorStore();
const empty = computed(() => {
  void store.state.sceneVersion;
  return store.graph.getChildren(store.state.currentPageId).length === 0;
});
</script>

<template>
  <div
    v-if="empty"
    data-test-id="design-empty-hint"
    class="pointer-events-none absolute inset-0 flex items-center justify-center p-6"
  >
    <p class="m-0 max-w-sm text-center text-xs leading-5 text-muted">{{ t('designEditor.emptyHint') }}</p>
  </div>
</template>
