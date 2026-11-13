// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/properties/fill-label.ts
// Modified by Fantay: no
import type { Fill, ShaderPaint, Variable } from '@open-pencil/scene-graph'
import { colorToHexRaw } from '@open-pencil/scene-graph/color'
import { shaderEffectLabel } from '@open-pencil/vue'

export function fillLabel(
  fill: Fill,
  boundVariable?: Variable,
  shader?: ShaderPaint | null
): string {
  if (boundVariable) return boundVariable.name
  // A shader is named by its effects, top first, as its picker lists them.
  if (shader)
    return shader.preset.components
      .map((component) => shaderEffectLabel(component.type))
      .reverse()
      .join(', ')
  if (fill.type === 'SOLID') return colorToHexRaw(fill.color)
  if (fill.type.startsWith('GRADIENT')) return fill.type.replace('GRADIENT_', '')
  return fill.type
}
