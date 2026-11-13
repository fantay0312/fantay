<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/menu/AppShortcutText.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import { twMerge } from 'tailwind-merge'
import { computed } from 'vue'

const { ui } = defineProps<{
  ui?: {
    base?: string
  }
}>()

const cls = computed(() => twMerge('text-[11px] text-muted', ui?.base))
</script>

<template>
  <span :class="cls"><slot /></span>
</template>
