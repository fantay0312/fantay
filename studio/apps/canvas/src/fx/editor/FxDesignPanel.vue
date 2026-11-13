<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  SPDX-FileCopyrightText: 2026 Fantay contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/DesignPanel.vue
  Modified by Fantay: phase-1 sections only (no frame presets, components, variants, slots,
  behaviours, variables, libraries, layer-type menu, selection actions or retained panel).
-->
<script setup lang="ts">
import { computed } from 'vue';

import { COMPONENT_TYPES, sceneNodeIcon } from '@/app/editor/icons';
import AppearanceSection from '@/components/properties/AppearanceSection.vue';
import ConstraintsSection from '@/components/properties/constraints/ConstraintsSection.vue';
import EffectsSection from '@/components/properties/EffectsSection.vue';
import ExportSection from '@/components/properties/ExportSection.vue';
import FillSection from '@/components/properties/FillSection.vue';
import LayoutSection from '@/components/properties/layout/LayoutSection.vue';
import PageSection from '@/components/properties/PageSection.vue';
import PositionSection from '@/components/properties/PositionSection.vue';
import SelectionColorsSection from '@/components/properties/selection/SelectionColorsSection.vue';
import StrokeSection from '@/components/properties/stroke/StrokeSection.vue';
import TypographySection from '@/components/properties/TypographySection.vue';
import Tip from '@/components/ui/overlay/Tip.vue';
import PanelHeader from '@/components/ui/panel/PanelHeader.vue';

import { useI18n, useSelectionState } from '../engine/op';

const { selectedNode: node, selectedCount: multiCount } = useSelectionState();
const isComponentType = computed(() => {
  const type = node.value?.type;
  return type ? COMPONENT_TYPES.has(type) : false;
});
const selectedIcon = computed(() => (node.value ? sceneNodeIcon(node.value) : undefined));
const { panels } = useI18n();
</script>

<template>
  <div
    v-if="multiCount > 1"
    data-test-id="design-panel-multi"
    class="scrollbar-thin flex-1 overflow-x-hidden overflow-y-auto pb-4"
  >
    <PanelHeader>
      <template #icon>
        <icon-lucide-layers-3 class="size-3.5" aria-hidden="true" />
      </template>
      <span role="heading" aria-level="2">{{ panels.selectedCount({ count: String(multiCount) }) }}</span>
    </PanelHeader>
    <PositionSection />
    <ConstraintsSection />
    <AppearanceSection />
    <TypographySection />
    <FillSection />
    <StrokeSection />
    <EffectsSection />
    <ExportSection />
  </div>

  <div
    v-else-if="node"
    data-test-id="design-panel-single"
    class="scrollbar-thin flex-1 overflow-x-hidden overflow-y-auto pb-4"
  >
    <PanelHeader :component="isComponentType">
      <template #icon>
        <Tip :label="node.type">
          <span role="img" :aria-label="node.type" class="contents">
            <component :is="selectedIcon" class="size-3.5" />
          </span>
        </Tip>
      </template>
      <span role="heading" aria-level="2" class="min-w-0">{{ node.name }}</span>
    </PanelHeader>
    <PositionSection />
    <ConstraintsSection />
    <LayoutSection />
    <AppearanceSection />
    <TypographySection v-if="node.type === 'TEXT'" />
    <FillSection />
    <StrokeSection />
    <EffectsSection />
    <SelectionColorsSection />
    <ExportSection />
  </div>

  <div v-else data-test-id="design-panel-empty" class="scrollbar-thin flex-1 overflow-x-hidden overflow-y-auto pb-4">
    <PageSection />
    <ExportSection />
  </div>
</template>
