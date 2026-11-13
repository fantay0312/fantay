<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  SPDX-FileCopyrightText: 2026 Fantay contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/toolbar/Toolbar.vue
  Modified by Fantay: desktop toolbar only, Fantay's fixed layout, "place image" action instead of
  icon insertion, no toolbar context menu or action toasts.
-->
<script setup lang="ts">
import { computed } from 'vue';

import { toolIcons } from '@/app/editor/icons';
import { toolbarItems } from '@/app/editor/toolbar/layout';
import { toolShortcutLabels } from '@/app/editor/toolbar/shortcuts';
import DesktopToolbar from '@/components/toolbar/DesktopToolbar.vue';
import { useMenuUI } from '@/components/ui/menu/menu';

import { ToolbarRoot } from '../engine/op';
import FxPlaceImageButton from './FxPlaceImageButton.vue';
import { useToolLabels } from './tool-labels';
import { FANTAY_TOOLBAR_LAYOUT } from './toolbar-layout';

const toolLabels = useToolLabels();
const toolShortcuts = toolShortcutLabels();
const items = computed(() => toolbarItems(FANTAY_TOOLBAR_LAYOUT, toolLabels.value, toolShortcuts));
const tools = computed(() => items.value.flatMap((item) => (item.kind === 'tool' ? [item.tool] : [])));
const flyoutMenuCls = useMenuUI({ content: 'min-w-32' });
const toolbarUI = { flyoutContent: flyoutMenuCls.content };
</script>

<template>
  <ToolbarRoot v-slot="{ activeTool, flyoutSelections, actions }" :tools="tools">
    <DesktopToolbar
      :items="items"
      :active-tool="activeTool"
      :flyout-selections="flyoutSelections"
      :tool-icons="toolIcons"
      :tool-labels="toolLabels"
      :tool-shortcuts="toolShortcuts"
      :ui="toolbarUI"
      @set-tool="actions.setTool"
    >
      <template #action="{ action }">
        <FxPlaceImageButton v-if="action === 'place-image'" />
      </template>
    </DesktopToolbar>
  </ToolbarRoot>
</template>
