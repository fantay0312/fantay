<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/color-picker-panel/ColorAreaControl.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import { ColorAreaArea, ColorAreaRoot, ColorAreaThumb } from 'reka-ui'

import { useColorPickerPanelContext } from '@/components/color-picker-panel/context'

const ctx = useColorPickerPanelContext()
</script>

<template>
  <ColorAreaRoot
    v-slot="{ style }"
    :model-value="ctx.rekaColor"
    color-space="hsb"
    x-channel="saturation"
    y-channel="brightness"
    @update:color="ctx.onRekaColorUpdate"
  >
    <ColorAreaArea
      class="relative h-[140px] w-full cursor-crosshair overflow-hidden rounded"
      :style="style"
    >
      <ColorAreaThumb
        class="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm"
      />
    </ColorAreaArea>
  </ColorAreaRoot>
</template>
