// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/theme/select/app.ts
// Modified by Fantay: no
import selectTheme from './select'

const appSelectTheme = {
  slots: {
    ...selectTheme.slots,
    trigger: [selectTheme.slots.trigger, 'w-full min-w-0 px-1.5']
  },
  variants: selectTheme.variants,
  defaultVariants: selectTheme.defaultVariants
}

export type AppSelectTheme = typeof appSelectTheme
export default appSelectTheme
