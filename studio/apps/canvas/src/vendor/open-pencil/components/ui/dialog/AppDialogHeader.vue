<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/dialog/AppDialogHeader.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import { DialogClose, DialogDescription, DialogTitle } from 'reka-ui'

import { useDialogUI, type DialogUI } from '@/components/ui/dialog/ui'

const {
  heading,
  description,
  closeLabel,
  showClose = true,
  titleVisuallyHidden = false,
  ui
} = defineProps<{
  heading: string
  description?: string
  closeLabel?: string
  showClose?: boolean
  titleVisuallyHidden?: boolean
  ui?: DialogUI
}>()

const cls = useDialogUI(ui)
</script>

<template>
  <header data-slot="dialog-header" :class="cls.header">
    <div :class="cls.heading">
      <DialogTitle
        data-slot="dialog-title"
        :data-visually-hidden="titleVisuallyHidden"
        :class="cls.title"
      >
        <slot name="title">{{ heading }}</slot>
      </DialogTitle>
      <DialogDescription
        v-if="description || $slots.description"
        data-slot="dialog-description"
        :class="cls.description"
        class="mt-0.5"
      >
        <slot name="description">{{ description }}</slot>
      </DialogDescription>
    </div>
    <slot name="actions" />
    <DialogClose v-if="showClose" as-child>
      <button type="button" data-slot="dialog-close" :class="cls.close" :aria-label="closeLabel">
        <slot name="close-icon"><icon-lucide-x class="size-4" /></slot>
      </button>
    </DialogClose>
  </header>
</template>
