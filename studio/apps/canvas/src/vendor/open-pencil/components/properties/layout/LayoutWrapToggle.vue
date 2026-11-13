<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/properties/layout/LayoutWrapToggle.vue
  Modified by Fantay: no
-->
<script setup lang="ts">
import { useI18n, useLayoutControlsContext } from '@open-pencil/vue'

import IconButton from '@/components/ui/button/IconButton.vue'

const ctx = useLayoutControlsContext()
const { panels } = useI18n()

function toggleWrap() {
  const node = ctx.node
  const enabling = node.layoutWrap !== 'WRAP'
  ctx.editor.updateNodeWithUndo(
    node.id,
    {
      layoutWrap: enabling ? 'WRAP' : 'NO_WRAP',
      primaryAxisAlign:
        enabling && node.primaryAxisAlign === 'SPACE_BETWEEN' ? 'MIN' : node.primaryAxisAlign
    },
    'Toggle layout wrap'
  )
}
</script>

<template>
  <IconButton
    :label="panels.layoutWrap"
    size="xs"
    :active="ctx.node.layoutWrap === 'WRAP'"
    @click="toggleWrap"
  >
    <icon-lucide-wrap-text class="size-3.5" />
  </IconButton>
</template>
