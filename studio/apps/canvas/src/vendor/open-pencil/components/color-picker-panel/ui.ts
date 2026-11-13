// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/color-picker-panel/ui.ts
// Modified by Fantay: no
import { tv } from 'tailwind-variants'
import { computed } from 'vue'

import type { ComponentUI } from '@/components/ui/types'
import theme from '@/theme/color-slider'

export type ColorSliderUI = ComponentUI<typeof theme>

export function useColorSliderUI(checkerboard: () => boolean, ui: () => ColorSliderUI | undefined) {
  const styles = computed(() => tv(theme)({ checkerboard: checkerboard() }))
  return {
    root: computed(() => styles.value.root({ class: ui()?.root })),
    label: computed(() => styles.value.label({ class: ui()?.label })),
    slider: computed(() => styles.value.slider({ class: ui()?.slider })),
    track: computed(() => styles.value.track({ class: ui()?.track })),
    thumb: computed(() => styles.value.thumb({ class: ui()?.thumb })),
    input: computed(() => styles.value.input({ class: ui()?.input }))
  }
}
