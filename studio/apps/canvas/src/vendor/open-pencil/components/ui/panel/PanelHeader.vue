<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/panel/PanelHeader.vue
  Modified by Fantay: no
-->
<script lang="ts">
import type { ClassValue } from 'tailwind-variants'
import type { VNode } from 'vue'

import type { ComponentUI } from '@/components/ui/types'
import type { PanelHeaderTheme } from '@/theme/panel/header'

export interface PanelHeaderProps {
  component?: boolean
  class?: ClassValue
  ui?: ComponentUI<PanelHeaderTheme>
}

export interface PanelHeaderSlots {
  icon?(): VNode[]
  default(): VNode[]
  actions?(): VNode[]
}
</script>

<script setup lang="ts">
import { tv } from 'tailwind-variants'

import theme from '@/theme/panel/header'

const { component = false, class: className, ui } = defineProps<PanelHeaderProps>()
const slots = defineSlots<PanelHeaderSlots>()
const styles = tv(theme)({ component })
</script>

<template>
  <header
    data-slot="root"
    :data-component="component ? '' : undefined"
    :class="styles.root({ class: [ui?.root, className] })"
  >
    <div data-slot="icon" :class="styles.icon({ class: ui?.icon })">
      <slot name="icon" />
    </div>
    <div data-slot="title" :class="styles.title({ class: ui?.title })">
      <slot />
    </div>
    <div v-if="slots.actions" data-slot="actions" :class="styles.actions({ class: ui?.actions })">
      <slot name="actions" />
    </div>
  </header>
</template>
