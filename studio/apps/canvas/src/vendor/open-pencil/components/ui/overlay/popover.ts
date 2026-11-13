// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/overlay/popover.ts
// Modified by Fantay: no
import { tv } from 'tailwind-variants'

import { motionStyles } from '@/theme/motion/styles'
import { floatingSurface } from '@/theme/overlay'

export const popover = tv({
  slots: {
    content: ['z-[100]', floatingSurface, motionStyles.floating],
    header: '',
    body: '',
    footer: ''
  }
})

interface PopoverUI {
  content?: string
  header?: string
  body?: string
  footer?: string
}

export function usePopoverUI(ui?: PopoverUI) {
  const cls = popover()
  return {
    content: cls.content({ class: ui?.content }),
    header: cls.header({ class: ui?.header }),
    body: cls.body({ class: ui?.body }),
    footer: cls.footer({ class: ui?.footer })
  }
}
