// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/overlay/tooltip.ts
// Modified by Fantay: no
import { createGlobalState } from '@vueuse/core'
import { tv } from 'tailwind-variants'
import { shallowRef } from 'vue'

import { tooltipSurface } from '@/theme/overlay'

export const tooltip = tv({
  slots: {
    content: ['z-50 px-2 py-1 text-[11px]', tooltipSurface]
  }
})

interface TooltipUI {
  content?: string
}

export function useTooltipUI(ui?: TooltipUI) {
  const cls = tooltip()
  return {
    content: cls.content({ class: ui?.content })
  }
}

/** After one tooltip closes, the next opens at once for this long, as the pointer moves along a row. */
export const TOOLTIP_SKIP_DELAY_MS = 300

/** When a tooltip last closed because the pointer or focus moved on, shared by every tooltip. */
export const useTooltipWarmth = createGlobalState(() => shallowRef(Number.NEGATIVE_INFINITY))
