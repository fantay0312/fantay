// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/feedback/alert.ts
// Modified by Fantay: no
import { tv, type VariantProps } from 'tailwind-variants'

import type { ComponentUI } from '@/components/ui/types'
import alertTheme from '@/theme/feedback/alert'

export const alert = tv(alertTheme)
export type AlertUI = ComponentUI<typeof alertTheme>
export interface AlertProps {
  heading: string
  description?: string
  tone?: VariantProps<typeof alert>['tone']
  ui?: AlertUI
}
