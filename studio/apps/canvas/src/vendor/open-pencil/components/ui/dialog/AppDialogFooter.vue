<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/dialog/AppDialogFooter.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import { useDialogUI, type DialogUI } from '@/components/ui/dialog/ui'

const { ui } = defineProps<{ ui?: DialogUI }>()
const cls = useDialogUI(ui)
</script>

<template>
  <footer data-slot="dialog-footer" :class="cls.footer">
    <slot />
  </footer>
</template>
