// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/properties/paint/binding.ts
// Modified by Fantay: no
import type { Color } from '@open-pencil/scene-graph/primitives'
import type { BindableValueActions, BindingTarget } from '@open-pencil/vue'

export type PaintBindingKind = 'fills' | 'strokes'

export function paintBindingTargets(
  nodeIds: string[],
  kind: PaintBindingKind,
  index: number
): BindingTarget[] {
  return nodeIds.map((nodeId) => ({ nodeId, path: `${kind}/${index}/color` }))
}

export function applyPaintMutation(
  actions: BindableValueActions<Color>,
  flush: () => void,
  update: () => void
): boolean {
  flush()
  if (!actions.beginMutation('edit')) return false
  update()
  return true
}

export function commitPaintMutation(actions: BindableValueActions<Color>) {
  actions.commitMutation()
}

export function cancelPaintMutation(actions: BindableValueActions<Color>) {
  actions.cancelMutation()
}
