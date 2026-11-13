// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/LayerTree/ui.ts
// Modified by Fantay: no
import { type ComputedRef, type InjectionKey, computed, inject, provide } from 'vue'

import type { ComponentUI } from '@/components/ui/types'
import type { LayerTreeTheme } from '@/theme/layer-tree'

export type LayerTreeUI = ComponentUI<LayerTreeTheme>

const LAYER_TREE_UI_KEY: InjectionKey<ComputedRef<LayerTreeUI | undefined>> =
  Symbol('layer-tree-ui')

export function provideLayerTreeUI(ui: () => LayerTreeUI | undefined) {
  provide(LAYER_TREE_UI_KEY, computed(ui))
}

export function useLayerTreeUI(): ComputedRef<LayerTreeUI | undefined> {
  return inject(
    LAYER_TREE_UI_KEY,
    computed(() => undefined)
  )
}
