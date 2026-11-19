// SPDX-License-Identifier: AGPL-3.0-only
declare module 'deep-view/react' {
  import type { ComponentType, Context } from 'react';
  export const WIDGET_CSS: string;
  export const QUESTION_CSS: string;
  export const ViewUi: Context<{
    t(key: string, params?: Record<string, string | number>): string;
    Markdown: ComponentType<{ text: string }>;
  }>;
  export const WidgetCard: ComponentType<{
    title: string;
    view: Record<string, unknown>;
    settled?: boolean;
    answer?: { action: string; values: Record<string, unknown> } | null;
    busy?: boolean;
    onSubmit?: (action: string, values: Record<string, unknown>) => void;
    onDismiss?: () => void;
  }>;
}
