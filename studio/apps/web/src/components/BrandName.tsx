// The product name as a wordmark. Wherever Fantay stands as a title or a signature (the Home
// subtitle, the loading screen, the welcome heading, the sidebar, the open-the-app gate, the
// use-everywhere dialog) it is set in IM FELL English italic, the Latin face of the Home headline
// (`.fx-brand` in fantay/styles/desktop-workspace.css). Prose that only mentions the product keeps
// the face around it, so the name is not sprinkled through settings copy and error text.
import type { ReactNode } from 'react';

export const BRAND_NAME = 'Fantay';

export function BrandName({ className }: { className?: string }) {
  return <span className={className ? `fx-brand ${className}` : 'fx-brand'}>{BRAND_NAME}</span>;
}

/** A translated title that names the product: the name becomes the wordmark, the rest stays text. */
export function withBrandName(text: string): ReactNode {
  const parts = text.split(new RegExp(`\\b(${BRAND_NAME})\\b`));
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? <BrandName key={`brand-${index}`} /> : part,
  );
}
