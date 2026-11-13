<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/panel/PanelFieldGroup.vue
  Modified by Fantay: no
-->
<script lang="ts">
import type { ClassValue } from 'tailwind-variants'
import type { VNode } from 'vue'

import type { ComponentUI } from '@/components/ui/types'
import type { PanelFieldGroupTheme } from '@/theme/panel/field-group'

export interface PanelFieldGroupProps {
  label?: string
  for?: string
  class?: ClassValue
  ui?: ComponentUI<PanelFieldGroupTheme>
}

export interface PanelFieldGroupSlots {
  default(): VNode[]
}
</script>

<script setup lang="ts">
import { tv } from 'tailwind-variants'

import theme from '@/theme/panel/field-group'

const { label, for: labelFor, class: className, ui } = defineProps<PanelFieldGroupProps>()
defineSlots<PanelFieldGroupSlots>()
const styles = tv(theme)()
</script>

<template>
  <div
    data-slot="root"
    data-panel-field-group
    :class="styles.root({ class: [ui?.root, className] })"
  >
    <label
      v-if="label"
      data-slot="label"
      :for="labelFor"
      :class="styles.label({ class: ui?.label })"
    >
      {{ label }}
    </label>
    <div data-slot="container" :class="styles.container({ class: ui?.container })">
      <slot />
    </div>
  </div>
</template>
