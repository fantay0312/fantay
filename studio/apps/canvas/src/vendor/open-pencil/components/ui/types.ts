// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/ui/types.ts
// Modified by Fantay: no
export type ComponentUI<Theme extends { slots: Record<string, unknown> }> = Partial<{
  [Slot in keyof Theme['slots']]: string
}>
