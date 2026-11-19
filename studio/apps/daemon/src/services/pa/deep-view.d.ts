declare module 'deep-view/core' {
  export function checkShownView(title: unknown, view: unknown): { error: string } | {
    title: string; view: Record<string, unknown>; interactive: boolean;
  };
  export function viewSummary(view: Record<string, unknown>): string;
  export function validateViewAnswer(view: Record<string, unknown>, action: string, values: Record<string, unknown>): Record<string, unknown>;
  export const showViewParameters: { view: { description: string } };
}
