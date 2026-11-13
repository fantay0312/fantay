<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
  Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/properties/PropertyListRoot.vue
  Modified by Fantay: no
-->
<script setup lang="ts" generic="K extends PropertyListKey">
import type { VNode } from 'vue'

import type { SceneNode } from '@open-pencil/scene-graph'
import {
  PropertyListRoot as HeadlessPropertyListRoot,
  useEditorPropertyList
} from '@open-pencil/vue'
import type { PropertyListKey, PropertyListRootSlotProps } from '@open-pencil/vue'

const { propKey, label } = defineProps<{
  propKey: K
  label?: string
}>()
defineSlots<{
  default?(
    props: PropertyListRootSlotProps<K> & {
      isMulti: boolean
      activeNode: SceneNode | null
      selectedNodeIds: string[]
      flush: () => void
    }
  ): VNode[]
}>()

const context = useEditorPropertyList(propKey)
</script>

<template>
  <HeadlessPropertyListRoot
    v-if="context.active.value"
    v-slot="slotProps"
    :prop-key="propKey"
    :label="label"
    :items="context.items.value"
    :mixed="context.isMixed.value"
    @add="context.actions.add"
    @remove="context.actions.remove"
    @update="context.actions.update"
    @patch="context.actions.patch"
    @toggle-visibility="context.actions.toggleVisibility"
    @reorder="context.actions.reorder"
  >
    <slot
      v-bind="slotProps"
      :is-multi="context.isMulti.value"
      :active-node="context.activeNode.value"
      :selected-node-ids="context.selectedNodeIds.value"
      :flush="context.flush"
    />
  </HeadlessPropertyListRoot>
</template>
