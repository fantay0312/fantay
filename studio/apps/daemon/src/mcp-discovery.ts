import { catalogPage, shortDescription } from './capability-discovery.js';
import { randomUUID } from 'node:crypto';

type ToolEntry = { name: string; description?: string | undefined; inputSchema: unknown; annotations?: unknown };
type Arguments = Record<string, unknown>;
type InputProperty = { type: string; description?: string; minimum?: number; maxLength?: number };
export const objectInput = (properties: Record<string, InputProperty>, required: string[] = []) => ({
  type: 'object' as const, properties, required, additionalProperties: false,
});
const name = { type: 'string', description: 'Exact tool name.' };
const query = { type: 'string', maxLength: 240 };
const offset = { type: 'integer', minimum: 0 };
const read: { readOnlyHint: true; idempotentHint: true; title?: string } = { readOnlyHint: true, idempotentHint: true };
export const resultPageTool = {
  name: 'read_result_page', description: 'Read the next text page of a previous tool result without executing it again.',
  inputSchema: objectInput({ id: { type: 'string' }, offset }, ['id', 'offset']), annotations: read,
};

/** Results belong to this MCP session. Large replies never trigger a replay of the operation. */
export class RoutedResults {
  private pages = new Map<string, { text: string; truncated: boolean }>();
  private chars = 0;

  read(args: Arguments) {
    const item = this.pages.get(String(args.id));
    if (!item) throw new Error('Result expired or belongs to another session');
    const start = routeOffset(args);
    let end = Math.min(start + 6000, item.text.length);
    if (end < item.text.length && /[\uD800-\uDBFF]/u.test(item.text[end - 1] ?? '')) end--;
    return { id: args.id, text: item.text.slice(start, end), nextOffset: end < item.text.length ? end : null, truncated: item.truncated };
  }

  bound<T extends Record<string, unknown>>(result: T) {
    if (!Array.isArray(result.content)) return result;
    const textBlocks = result.content.filter(b => b?.type === 'text');
    const serialized = textBlocks.length === 1 && !result.structuredContent
      ? String(textBlocks[0].text)
      : JSON.stringify({ content: textBlocks, structuredContent: result.structuredContent });
    if (serialized.length <= 6000) return result;
    const limit = 8_000_000;
    const id = randomUUID();
    const text = serialized.slice(0, limit);
    while (this.pages.size >= 8 || this.chars + text.length > limit) {
      const oldest = this.pages.keys().next().value!;
      this.chars -= this.pages.get(oldest)!.text.length;
      this.pages.delete(oldest);
    }
    this.pages.set(id, { text, truncated: serialized.length > text.length });
    this.chars += text.length;
    const page = { ...this.read({ id, offset: 0 }), continueWith: 'read_result_page' };
    return { ...(result.isError ? { isError: true } : {}), content: [
      { type: 'text' as const, text: JSON.stringify(page) }, ...result.content.filter(b => b?.type !== 'text'),
    ] };
  }
}
export const routerTools = [
  { name: 'find_tools', description: 'Search tool names and short descriptions. Omit query to browse.', inputSchema: objectInput({ query, offset }), annotations: read },
  { name: 'describe_tool', description: 'Read the input schema for one tool before using it.', inputSchema: objectInput({ name, offset }, ['name']), annotations: read },
  { name: 'call_tool', description: 'Execute the named tool with its own arguments. Check its effects before calling.', inputSchema: objectInput({ name, arguments: { type: 'object' } }, ['name', 'arguments']),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false } },
];

export const skillTools = [
  { name: 'find_skills', description: 'Search Fantay workflows by task, localized terms or skill ID. Returns up to six summaries.', inputSchema: objectInput({ query, offset }), annotations: read },
  { name: 'read_skill', description: 'Read one skill page. Use file=references to list companion texts or pass a returned path.', inputSchema: objectInput({ id: { type: 'string' }, file: { type: 'string' }, offset }, ['id']), annotations: read },
];

export function routeOffset(args: Arguments) {
  const value = args.offset ?? 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('offset must be a non-negative integer');
  return value;
}

export function routeQuery(args: Arguments) {
  if (args.query === undefined) return '';
  if (typeof args.query !== 'string' || args.query.length > 240) throw new Error('query must be a string of at most 240 characters');
  return args.query;
}

export function findTools(tools: readonly ToolEntry[], args: Arguments, aliases: Readonly<Record<string, string>> = {}) {
  const page = catalogPage(tools, routeQuery(args), routeOffset(args), tool => ({
    id: tool.name, terms: [tool.description ?? '', aliases[tool.name] ?? ''],
  }));
  return { ...page, items: page.items.map(tool => ({ name: tool.name, description: shortDescription(tool.description ?? '') })) };
}

export function lookupTool<T extends ToolEntry>(tools: readonly T[], args: Arguments): T {
  const tool = tools.find(entry => entry.name === args.name);
  if (!tool) throw new Error('Unknown tool. Search find_tools for an exact name.');
  return tool;
}

export function describeTool(tools: readonly ToolEntry[], args: Arguments) {
  const tool = lookupTool(tools, args);
  const schema = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations };
  const start = routeOffset(args);
  const encoded = JSON.stringify(schema);
  if (!start && encoded.length <= 6000) return schema;
  return { name: tool.name, schemaText: encoded.slice(start, start + 6000),
    nextOffset: start + 6000 < encoded.length ? start + 6000 : null };
}

export function targetArguments(args: Arguments): Arguments {
  if (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) throw new Error('arguments must be an object');
  return args.arguments as Arguments;
}
