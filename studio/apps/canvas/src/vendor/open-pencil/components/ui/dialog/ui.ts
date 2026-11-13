// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/dialog/ui.ts
// Modified by Fantay: no
import { tv, type VariantProps } from 'tailwind-variants'

import dialogTheme from '@/theme/dialog/index'

export const dialog = tv(dialogTheme)

export type DialogVariants = VariantProps<typeof dialog>

export interface DialogUI {
  overlay?: string
  content?: string
  header?: string
  heading?: string
  title?: string
  description?: string
  close?: string
  body?: string
  footer?: string
}

export function useDialogUI(ui?: DialogUI, variants?: DialogVariants) {
  const cls = dialog(variants)
  return {
    overlay: cls.overlay({ class: ui?.overlay }),
    content: cls.content({ class: ui?.content }),
    header: cls.header({ class: ui?.header }),
    heading: cls.heading({ class: ui?.heading }),
    title: cls.title({ class: ui?.title }),
    description: cls.description({ class: ui?.description }),
    close: cls.close({ class: ui?.close }),
    body: cls.body({ class: ui?.body }),
    footer: cls.footer({ class: ui?.footer })
  }
}
