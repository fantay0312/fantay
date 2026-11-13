// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/LayerTree/types.ts
// Modified by Fantay: no
import type { LayerDragInstruction } from '@open-pencil/vue'

export interface LayerTreeItemActions {
  select: (additive: boolean) => void
  toggleExpand: () => void
  toggleVisibility: () => void
  toggleLock: () => void
  rename: (name: string) => void
}

export interface LayerTreeChrome {
  draggingId: string | null
  instruction: LayerDragInstruction | null
  instructionTargetId: string | null
  focused: boolean
  indent: number
}

export interface LayerRenameControls {
  commit: (id: string, event: Event) => void
  onKeydown: (event: KeyboardEvent) => void
  focusInput: (input: HTMLInputElement) => Promise<void>
}
