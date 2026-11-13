<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/** Left panel: pages over layers, in a vertical splitter whose sizes persist. */
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from 'reka-ui';
import { tv } from 'tailwind-variants';

import LayerTree from '@/components/LayerTree/LayerTree.vue';
import PanelHeader from '@/components/ui/panel/PanelHeader.vue';
import splitterTheme from '@/theme/splitter';

import { t } from '../../host/i18n';
import FxPagesPanel from './FxPagesPanel.vue';

const { readOnly = false } = defineProps<{ readOnly?: boolean }>();
const splitterStyles = tv(splitterTheme)({ direction: 'vertical' });
</script>

<template>
  <aside data-test-id="layers-panel" class="flex h-full min-w-0 flex-col overflow-hidden" style="contain: paint layout style">
    <SplitterGroup direction="vertical" auto-save-id="fantay-design-left" class="flex-1 overflow-hidden">
      <SplitterPanel :default-size="28" :min-size="12" :max-size="60" class="flex flex-col overflow-hidden">
        <FxPagesPanel :read-only="readOnly" />
      </SplitterPanel>
      <SplitterResizeHandle :class="splitterStyles.handle()">
        <div :class="splitterStyles.divider()" />
      </SplitterResizeHandle>
      <SplitterPanel :default-size="72" :min-size="20" class="flex flex-col overflow-hidden">
        <PanelHeader>
          <template #icon>
            <icon-lucide-layers class="size-3.5" aria-hidden="true" />
          </template>
          <span data-test-id="layers-header">{{ t('designEditor.panel.layers') }}</span>
        </PanelHeader>
        <LayerTree data-test-id="layers-tree" />
      </SplitterPanel>
    </SplitterGroup>
  </aside>
</template>
