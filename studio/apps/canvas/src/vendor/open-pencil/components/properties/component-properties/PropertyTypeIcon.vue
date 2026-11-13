<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/properties/component-properties/PropertyTypeIcon.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import type { ComponentPropertyType } from '@open-pencil/scene-graph'
const { kind } = defineProps<{ kind: ComponentPropertyType }>()
</script>
<template>
  <icon-lucide-eye
    v-if="kind === 'BOOLEAN'"
    class="size-3.5 shrink-0 text-muted"
    aria-hidden="true"
  />
  <icon-lucide-diamond
    v-else-if="kind === 'VARIANT'"
    class="size-3.5 shrink-0 text-muted"
    aria-hidden="true"
  />
  <icon-lucide-type
    v-else-if="kind === 'TEXT'"
    class="size-3.5 shrink-0 text-muted"
    aria-hidden="true"
  />
  <icon-lucide-component v-else class="size-3.5 shrink-0 text-muted" aria-hidden="true" />
</template>
