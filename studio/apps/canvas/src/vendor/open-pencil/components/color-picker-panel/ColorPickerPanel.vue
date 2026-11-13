<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/color-picker-panel/ColorPickerPanel.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import type { Color } from '@open-pencil/scene-graph/primitives'
import type { OkHCLControls } from '@open-pencil/vue'

import ColorAreaControl from '@/components/color-picker-panel/ColorAreaControl.vue'
import { provideColorPickerPanel } from '@/components/color-picker-panel/context'
import FormatControls from '@/components/color-picker-panel/FormatControls.vue'
import HueAlphaSliders from '@/components/color-picker-panel/HueAlphaSliders.vue'

const { color, okhcl = null } = defineProps<{
  color: Color
  okhcl?: OkHCLControls | null
}>()

const emit = defineEmits<{
  update: [color: Color]
}>()

provideColorPickerPanel(
  {
    get color() {
      return color
    },
    get okhcl() {
      return okhcl
    }
  },
  emit
)
</script>

<template>
  <div class="flex flex-col gap-2">
    <ColorAreaControl />
    <HueAlphaSliders />
    <FormatControls />
  </div>
</template>
