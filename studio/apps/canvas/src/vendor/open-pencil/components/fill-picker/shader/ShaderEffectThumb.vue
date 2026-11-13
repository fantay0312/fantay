<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/fill-picker/shader/ShaderEffectThumb.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import { useIntersectionObserver } from '@vueuse/core'
import { ref, useTemplateRef } from 'vue'

import { shaderEffectPreview, type ShaderEffect } from '@open-pencil/vue'

/** A small still of an effect, drawn the first time its row scrolls into view. */
const { effect } = defineProps<{ effect?: ShaderEffect }>()

const root = useTemplateRef<HTMLElement>('root')
const src = ref<string | null>(null)

const { stop } = useIntersectionObserver(root, ([entry]) => {
  if (!entry?.isIntersecting || !effect) return
  stop()
  void shaderEffectPreview(effect).then((url) => {
    src.value = url
    return url
  })
})
</script>

<template>
  <span
    ref="root"
    class="block h-8 w-12 shrink-0 overflow-hidden rounded border border-border bg-input"
  >
    <img v-if="src" :src="src" alt="" class="size-full object-cover" />
  </span>
</template>
