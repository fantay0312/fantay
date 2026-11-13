<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/feedback/SeverityIcon.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import type { DesignIssueSeverity } from '@open-pencil/core/canvas'

import { severityIcon } from '@/theme/feedback/severity'

const { severity, class: className } = defineProps<{
  severity: DesignIssueSeverity
  class?: string
}>()
</script>

<template>
  <icon-lucide-circle-alert
    v-if="severity === 'error'"
    aria-hidden="true"
    :class="severityIcon({ severity, class: className })"
  />
  <icon-lucide-triangle-alert
    v-else-if="severity === 'warning'"
    aria-hidden="true"
    :class="severityIcon({ severity, class: className })"
  />
  <icon-lucide-lightbulb
    v-else
    aria-hidden="true"
    :class="severityIcon({ severity, class: className })"
  />
</template>
