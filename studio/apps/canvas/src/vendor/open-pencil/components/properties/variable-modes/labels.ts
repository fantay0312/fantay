// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/properties/variable-modes/labels.ts
// Modified by Fantay: no
import type { usePanelMessages, VariableModeChoice } from '@open-pencil/vue'

type PanelMessages = ReturnType<typeof usePanelMessages>['value']

/** The value Auto stands for in the menu and the row select; mode ids never take this form. */
export const AUTO_MODE = ':auto'

/** "Auto (Light)", naming the mode the targets inherit, or "Auto" when they inherit different ones. */
export function autoModeLabel(panels: PanelMessages, choice: VariableModeChoice): string {
  return choice.inherited
    ? panels.variableModeAuto({ mode: choice.inherited.name })
    : panels.variableModeAutoMixed
}
