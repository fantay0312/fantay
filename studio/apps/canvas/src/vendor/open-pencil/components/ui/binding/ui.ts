// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/binding/ui.ts
// Modified by Fantay: no
import { tv } from 'tailwind-variants'

import type { BindingState } from '@open-pencil/vue'

import type { ComponentUI } from '@/components/ui/types'
import theme from '@/theme/binding/field'
import type { BindingFieldTheme } from '@/theme/binding/field'

export type BindingFieldUI = ComponentUI<BindingFieldTheme>

export interface BindingFieldUIOptions {
  state?: BindingState
  open?: boolean
  disabled?: boolean
  derived?: boolean
}

export function useBindingFieldUI(options: BindingFieldUIOptions = {}, ui?: BindingFieldUI) {
  const styles = tv(theme)(options)
  return {
    root: styles.root({ class: ui?.root }),
    pill: styles.pill({ class: ui?.pill }),
    pillLabel: styles.pillLabel({ class: ui?.pillLabel }),
    trigger: styles.trigger({ class: ui?.trigger }),
    createForm: styles.createForm({ class: ui?.createForm }),
    createInput: styles.createInput({ class: ui?.createInput })
  }
}
