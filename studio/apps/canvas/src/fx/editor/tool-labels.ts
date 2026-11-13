// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// SPDX-FileCopyrightText: 2026 Fantay contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/components/toolbar/labels.ts
// Modified by Fantay: only the tool names (no Settings toolbar editor entries).
import { computed, type ComputedRef } from 'vue';

import { useI18n, type Tool } from '../engine/op';

export function useToolLabels(): ComputedRef<Record<Tool, string>> {
  const { tools } = useI18n();
  return computed<Record<Tool, string>>(() => ({
    SELECT: tools.value.move,
    FRAME: tools.value.frame,
    SECTION: tools.value.section,
    RECTANGLE: tools.value.rectangle,
    ELLIPSE: tools.value.ellipse,
    LINE: tools.value.line,
    POLYGON: tools.value.polygon,
    STAR: tools.value.star,
    PEN: tools.value.pen,
    PENCIL: tools.value.pencil,
    TEXT: tools.value.text,
    HAND: tools.value.hand,
    COMMENT: tools.value.comment,
  }));
}
