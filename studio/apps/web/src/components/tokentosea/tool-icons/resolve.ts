/** Portable, brand-free tool identity shared with the Fantay renderer. */
import catalog from './catalog.json';
import nodes from './nodes.json';
import rules from './rules.json';

export type ToolPurposeIconName = keyof typeof nodes;
export interface ToolPurposeInput { id?: string; publicId?: string; name?: string; category?: string; }
export type ToolIconNode = [string, Record<string, string | number>];
export const toolPurposeNodes = nodes as unknown as Record<ToolPurposeIconName, ToolIconNode[]>;
const byId = catalog as Record<string, ToolPurposeIconName>;
const categories = rules.categories as Record<string, ToolPurposeIconName>;
const nameRules = (rules.names as [ToolPurposeIconName, string][]).map(([icon, pattern]) => [icon, new RegExp(pattern, 'i')] as const);

export function toolCategoryIcon(category?: string): ToolPurposeIconName {
  return category && Object.prototype.hasOwnProperty.call(categories, category) ? categories[category] ?? 'Wrench' : 'Wrench';
}

/** Curated public IDs win over legacy categories; never read brands, URLs or iconPath. */
export function resolveToolPurposeIcon(tool: ToolPurposeInput): ToolPurposeIconName {
  for (const id of [tool.publicId, tool.id]) {
    if (id && Object.prototype.hasOwnProperty.call(byId, id)) {
      const assigned = byId[id];
      if (assigned) return assigned;
    }
  }
  const name = tool.name?.trim() ?? '';
  const match = nameRules.find(([, pattern]) => pattern.test(name));
  return match?.[0] ?? toolCategoryIcon(tool.category);
}
