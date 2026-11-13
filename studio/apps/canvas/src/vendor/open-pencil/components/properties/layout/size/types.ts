// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/properties/layout/size/types.ts
// Modified by Fantay: no
import type { LayoutAxis, SizeLimitProp } from '@open-pencil/vue'

export interface SizeAxisFieldProps {
  axis: LayoutAxis
  icon: string
  label: string
}

export interface SizeLimitItem {
  prop: SizeLimitProp
  icon: string
  label: string
  setLabel: string
  removeLabel: string
}

export interface SizeLimitFieldProps {
  item: SizeLimitItem
}
