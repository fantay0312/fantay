<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/** Right panel: "Design" title with the zoom menu, then the design properties (or a read-only notice). */
import { computed } from 'vue';

import ZoomDropdown from '@/components/editor/ZoomDropdown.vue';

import { t } from '../../host/i18n';
import FxDesignPanel from './FxDesignPanel.vue';
import { editorUi } from './ui-state';

const notice = computed(() => {
  if (editorUi.format === 'op') return t('designEditor.op.readOnly');
  if (editorUi.legacy) return t('designEditor.legacy.readOnlyNotice');
  return t('designEditor.status.readOnly');
});
</script>

<template>
  <section data-test-id="design-inspector" class="flex h-full min-w-0 flex-col overflow-hidden">
    <header class="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
      <span class="px-1 text-[11px] font-semibold text-surface">{{ t('designEditor.panel.design') }}</span>
      <ZoomDropdown v-if="editorUi.format !== 'op'" />
    </header>
    <p v-if="editorUi.readOnly" role="note" class="m-0 px-3 py-3 text-[11px] leading-4 text-muted" data-test-id="design-read-only">
      {{ notice }}
    </p>
    <FxDesignPanel v-else />
  </section>
</template>
