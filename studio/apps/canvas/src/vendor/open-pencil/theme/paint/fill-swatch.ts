// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/theme/paint/fill-swatch.ts
// Modified by Fantay: no
import { CHECKERBOARD_BACKGROUND } from '@/theme/paint/checkerboard'

export default {
  slots: {
    root: `relative block overflow-hidden rounded border border-border ${CHECKERBOARD_BACKGROUND}`,
    preview: 'pointer-events-none absolute inset-0'
  }
} as const
