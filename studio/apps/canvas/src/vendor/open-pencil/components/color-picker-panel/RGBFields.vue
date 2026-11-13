<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/color-picker-panel/RGBFields.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import { inputNumberValue, useI18n } from '@open-pencil/vue'

import { useColorPickerPanelContext } from '@/components/color-picker-panel/context'

const ctx = useColorPickerPanelContext()
const { panels } = useI18n()
</script>

<template>
  <div
    class="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-px overflow-hidden rounded border border-border bg-border"
  >
    <input
      type="number"
      :aria-label="panels.red"
      class="bg-input px-2 py-1 text-xs text-surface outline-none"
      :value="Math.round(ctx.rgbColor.r)"
      min="0"
      max="255"
      @change="ctx.updateRGBChannelValue('r', inputNumberValue($event))"
    />
    <input
      type="number"
      :aria-label="panels.green"
      class="bg-input px-2 py-1 text-xs text-surface outline-none"
      :value="Math.round(ctx.rgbColor.g)"
      min="0"
      max="255"
      @change="ctx.updateRGBChannelValue('g', inputNumberValue($event))"
    />
    <input
      type="number"
      :aria-label="panels.blue"
      class="bg-input px-2 py-1 text-xs text-surface outline-none"
      :value="Math.round(ctx.rgbColor.b)"
      min="0"
      max="255"
      @change="ctx.updateRGBChannelValue('b', inputNumberValue($event))"
    />
  </div>
</template>
