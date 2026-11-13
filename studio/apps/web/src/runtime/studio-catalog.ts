import { STUDIO_GROUP_NAME_MAX, type StudioDocument, type StudioLibraryEntry } from '@open-design/contracts';
export type StudioCatalogSection = 'components' | 'blocks' | 'patterns' | 'templates';

export function mergeStudioEntry(doc: StudioDocument, section: StudioCatalogSection, entry: StudioLibraryEntry, baseline: StudioLibraryEntry | null): StudioDocument {
  const current = doc[section].find(item => item.id === entry.id);
  if (baseline ? !current || JSON.stringify(current) !== JSON.stringify(baseline) : Boolean(current)) throw new Error('ENTRY_CONFLICT');
  return { ...doc, [section]: baseline ? doc[section].map(item => item.id === entry.id ? entry : item) : [...doc[section], entry] };
}

/**
 * Suggested group names, offered in the entry editor and never applied on their own: the user decides
 * which groups a system has. Components follow the job-based grouping of shadcn/ui.
 */
export const STUDIO_GROUP_SUGGESTIONS: Record<StudioCatalogSection, [string, string][]> = {
  components: [['操作', 'Actions'], ['输入', 'Inputs'], ['浮层', 'Overlays'], ['导航', 'Navigation'], ['布局', 'Layout'], ['数据', 'Data'], ['反馈', 'Feedback'], ['智能体与聊天', 'Agent & chat']],
  blocks: [], patterns: [], templates: [],
};

/** The section's groups in reading order: the user's list first, then any name only an entry carries. */
export function studioGroupNames(doc: StudioDocument, section: StudioCatalogSection): string[] {
  const names = [...(doc.groups[section] ?? [])];
  for (const entry of doc[section]) if (entry.group && !names.includes(entry.group)) names.push(entry.group);
  return names;
}

/** Entries by group, ungrouped last (name null). A listed group with no entries is kept, empty. */
export function studioGroupedEntries(doc: StudioDocument, section: StudioCatalogSection, entries: StudioLibraryEntry[]): { name: string | null; entries: StudioLibraryEntry[] }[] {
  const groups: { name: string | null; entries: StudioLibraryEntry[] }[] = studioGroupNames(doc, section).map((name) => ({ name, entries: entries.filter((entry) => entry.group === name) }));
  const loose = entries.filter((entry) => !entry.group);
  return loose.length ? [...groups, { name: null, entries: loose }] : groups;
}

function cleanGroupName(name: string, existing: string[], from?: string): string {
  const next = name.replace(/\s+/g, ' ').trim();
  if (!next || next.length > STUDIO_GROUP_NAME_MAX) throw new Error('INVALID_GROUP');
  if (next !== from && existing.includes(next)) throw new Error('GROUP_EXISTS');
  return next;
}
const withGroups = (doc: StudioDocument, section: StudioCatalogSection, names: string[]): StudioDocument => ({ ...doc, groups: { ...doc.groups, [section]: names } });

export function addStudioGroup(doc: StudioDocument, section: StudioCatalogSection, name: string): StudioDocument {
  const names = studioGroupNames(doc, section);
  return withGroups(doc, section, [...names, cleanGroupName(name, names)]);
}
export function renameStudioGroup(doc: StudioDocument, section: StudioCatalogSection, from: string, to: string): StudioDocument {
  const names = studioGroupNames(doc, section), next = cleanGroupName(to, names, from);
  return { ...withGroups(doc, section, names.map((name) => name === from ? next : name)), [section]: doc[section].map((entry) => entry.group === from ? { ...entry, group: next } : entry) };
}
/** The group goes; its entries stay, ungrouped. */
export function removeStudioGroup(doc: StudioDocument, section: StudioCatalogSection, name: string): StudioDocument {
  return { ...withGroups(doc, section, studioGroupNames(doc, section).filter((item) => item !== name)), [section]: doc[section].map((entry) => { if (entry.group !== name) return entry; const { group: _group, ...rest } = entry; return rest; }) };
}
export function moveStudioGroup(doc: StudioDocument, section: StudioCatalogSection, name: string, step: -1 | 1): StudioDocument {
  const names = studioGroupNames(doc, section), at = names.indexOf(name), to = at + step;
  if (at < 0 || to < 0 || to >= names.length) return doc;
  [names[at], names[to]] = [names[to]!, names[at]!];
  return withGroups(doc, section, names);
}
/**
 * Saving an entry into a group it names for the first time puts that group at the end of the list.
 * `before` is the document as it was before the entry was saved: a group another entry already
 * carried keeps its place, a new one goes last, whatever position the saved entry has.
 */
export function rememberStudioGroup(doc: StudioDocument, section: StudioCatalogSection, group: string | undefined, before: StudioDocument = doc): StudioDocument {
  if (!group || (doc.groups[section] ?? []).includes(group)) return doc;
  const names = studioGroupNames(before, section);
  return withGroups(doc, section, names.includes(group) ? names : [...names, group]);
}

export function studioMutationMessage(error: unknown, chinese = true): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/GROUP_EXISTS/.test(message)) return chinese ? '已经有同名分组。' : 'A group with this name already exists.';
  if (/INVALID_GROUP/.test(message)) return chinese ? '分组名称不能为空，且不超过 ' + STUDIO_GROUP_NAME_MAX + ' 个字。' : 'Group names cannot be empty or longer than ' + STUDIO_GROUP_NAME_MAX + ' characters.';
  if (/CONFLICT/.test(message)) return chinese ? '这个条目已被其他操作修改。草稿仍保留，请先复制草稿，再重新打开最新版本。' : 'This entry changed elsewhere. Your draft is retained; copy it before reopening the latest version.';
  if (/BUSY/.test(message)) return chinese ? '另一个保存正在进行，请稍后重试。' : 'Another save is in progress. Please retry shortly.';
  if (/^[A-Z_]+$/.test(message)) return chinese ? '操作未完成，内容仍保留，请重试。' : 'The operation failed. Your content is retained; please retry.';
  return message;
}
