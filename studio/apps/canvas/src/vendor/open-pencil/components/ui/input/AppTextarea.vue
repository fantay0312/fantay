<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/input/AppTextarea.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import { tv } from 'tailwind-variants'
import { computed } from 'vue'

import theme from '@/theme/input/textarea'

const model = defineModel<string>({ default: '' })

const { rows = 3, disabled = false } = defineProps<{ rows?: number; disabled?: boolean }>()
const textareaClass = computed(() => tv(theme)())
</script>

<template>
  <textarea v-model="model" :rows="rows" :disabled="disabled" :class="textareaClass" />
</template>
