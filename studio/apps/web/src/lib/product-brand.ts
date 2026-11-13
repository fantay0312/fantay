/** Apply only to product-authored display copy, never URLs, identifiers or user content. */
export function productBrandCopy(text: string): string {
  return text.replace(/\b(?:OpenDesign|Open Design|FantayDesign|Fantaydesign|Fantay Studio|Fantay Design)\b/g, 'Fantay');
}
