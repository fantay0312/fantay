<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/color-picker-panel/FormatControls.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import { useColorPickerPanelContext } from '@/components/color-picker-panel/context'
import HsbFields from '@/components/color-picker-panel/HsbFields.vue'
import HslFields from '@/components/color-picker-panel/HslFields.vue'
import OkhclFields from '@/components/color-picker-panel/OkhclFields.vue'
import RGBFields from '@/components/color-picker-panel/RGBFields.vue'
import AppSelect from '@/components/ui/select/AppSelect.vue'

const ctx = useColorPickerPanelContext()
</script>

<template>
  <div class="flex flex-col gap-2">
    <AppSelect
      class="w-[120px]"
      data-test-id="color-format-select"
      :model-value="ctx.fieldFormat"
      :options="ctx.fieldOptions"
      @update:model-value="ctx.setFieldFormat"
    />

    <div class="min-w-0 flex flex-col gap-2">
      <RGBFields v-if="ctx.fieldFormat === 'rgb'" />
      <HslFields v-else-if="ctx.fieldFormat === 'hsl'" />
      <HsbFields v-else-if="ctx.fieldFormat === 'hsb'" />
      <OkhclFields v-else />
    </div>
  </div>
</template>
