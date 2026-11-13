// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/theme/feedback/severity.ts
// Modified by Fantay: no
import { tv } from 'tailwind-variants'

/** The icon colour of a problem's severity, shared by the design check and property limits. */
export const severityIcon = tv({
  base: 'size-3 shrink-0',
  variants: {
    severity: {
      error: 'text-error',
      warning: 'text-warning',
      info: 'text-muted'
    }
  }
})
