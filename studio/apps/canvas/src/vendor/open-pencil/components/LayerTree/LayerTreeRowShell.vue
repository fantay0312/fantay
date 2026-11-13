<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/LayerTree/LayerTreeRowShell.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import { LAYER_TREE_ROW_HEIGHT } from './geometry'

const { padLeft } = defineProps<{ padLeft: string }>()
</script>

<template>
  <div :style="{ height: `${LAYER_TREE_ROW_HEIGHT}px`, paddingLeft: padLeft }">
    <slot />
  </div>
</template>
