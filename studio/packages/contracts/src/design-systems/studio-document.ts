export const STUDIO_DOCUMENT_PATH = 'system/studio.json';
export interface StudioTokenNote { group: string; layer: 'primitive' | 'semantic' | 'component'; description: string }
export interface StudioTheme { name: string; selector: string; description: string }
export interface StudioTypeStyle { id: string; name: string; group: string; family: string; size: string; weight: string; lineHeight: string; letterSpacing: string; description: string }
export interface StudioLibraryExample {
  id: string; name: string; kind: 'variant' | 'state' | 'flow'; value: string; html: string;
}
export interface StudioLibraryEntry {
  id: string; name: string; description: string; status: 'draft' | 'stable' | 'deprecated';
  usage: string; avoid: string; accessibility: string; api: string;
  variants: string[]; states: string[]; html: string;
  examples?: StudioLibraryExample[];
  dependencies?: string[];
  /** The variant to reach for when nothing says otherwise; one of `variants`. */
  defaultVariant?: string;
  /** One good and one bad example from real code. Absent when the system has none to show. */
  good?: string;
  bad?: string;
  /** The user's own grouping inside a catalogue section, such as 操作 or 输入. Absent is ungrouped. */
  group?: string;
}
export type StudioCatalogKey = 'components' | 'blocks' | 'patterns' | 'templates';
/** Group names per catalogue section, in the order the user set. A group may be listed before it holds anything. */
export type StudioLibraryGroups = Partial<Record<StudioCatalogKey, string[]>>;
export const STUDIO_GROUP_NAME_MAX = 40;
/** One standing rule for anyone, an agent included, building with the system: the instruction, then why. */
export interface StudioRule {
  id: string; rule: string; reason: string;
  /** `correction`: learnt from the user pointing out a mistake in a chat run. Absent: written by hand. */
  source?: 'correction';
  /** ISO time the rule was learnt. */
  createdAt?: string;
  /** What the agent had done that the user corrected, kept short. */
  context?: string;
}
export const STUDIO_RULES_MAX = 500;
/** The screen review is a skill, loaded on demand: the package file, and where a run finds its copy. */
export const STUDIO_SCREEN_REVIEW_SKILL_PATH = 'system/skills/screen-review/SKILL.md';
export const STUDIO_SCREEN_REVIEW_STAGED_PATH = '.od-skills/design-system/screen-review/SKILL.md';
export interface StudioRelease { version: string; date: string; notes: string }
export interface StudioChecklistItem { id: string; label: string; checked: boolean }
export interface StudioDocument {
  schemaVersion: 1;
  themes: StudioTheme[];
  tokenNotes: Record<string, StudioTokenNote>;
  typeStyles: StudioTypeStyle[];
  components: StudioLibraryEntry[];
  /** Named compositions of components lifted from real screens: a page header, a task row. */
  blocks: StudioLibraryEntry[];
  patterns: StudioLibraryEntry[];
  templates: StudioLibraryEntry[];
  /** Short rules with their reasons, read before anything is built. */
  rules: StudioRule[];
  /** Checks to run after building or changing a screen. */
  reviewChecks: string[];
  groups: StudioLibraryGroups;
  content: string;
  brand: string;
  accessibility: string;
  checklist: StudioChecklistItem[];
  implementation: { repository: string; designFile: string; packageName: string; notes: string };
  governance: { version: string; owners: string; contribution: string; deprecation: string };
  releases: StudioRelease[];
  catalogVersion?: number;
}
export function emptyStudioDocument(): StudioDocument {
  return { schemaVersion: 1, themes: [], tokenNotes: {}, typeStyles: [], components: [], blocks: [], patterns: [], templates: [], rules: [], reviewChecks: [], groups: {}, content: '', brand: '', accessibility: '', checklist: [], implementation: { repository: '', designFile: '', packageName: '', notes: '' }, governance: { version: '0.1.0', owners: '', contribution: '', deprecation: '' }, releases: [] };
}
export function parseStudioDocument(raw: string | null): StudioDocument {
  if (raw === null) return emptyStudioDocument();
  const value = JSON.parse(raw) as StudioDocument;
  // Every section is optional on disk: one an author or agent left out reads as empty, the way the
  // Studio shows it. A section that is present must still have the right shape.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const defaults = emptyStudioDocument() as unknown as Record<string, unknown>;
    const record = value as unknown as Record<string, unknown>;
    for (const key of ['themes', 'tokenNotes', 'typeStyles', 'components', 'blocks', 'patterns', 'templates', 'rules', 'reviewChecks', 'groups', 'content', 'brand', 'accessibility', 'checklist', 'releases'] as const) if (record[key] === undefined) record[key] = defaults[key];
    for (const key of ['implementation', 'governance'] as const) {
      const given = record[key];
      if (given === undefined) record[key] = defaults[key];
      else if (given && typeof given === 'object' && !Array.isArray(given)) record[key] = { ...(defaults[key] as object), ...given };
    }
  }
  if (value?.schemaVersion !== 1 || !Array.isArray(value.components) || !Array.isArray(value.blocks) || !Array.isArray(value.patterns) || !Array.isArray(value.templates) || !Array.isArray(value.typeStyles) || !Array.isArray(value.themes) || !Array.isArray(value.releases) || !Array.isArray(value.checklist) || !Array.isArray(value.rules) || !Array.isArray(value.reviewChecks) || !value.tokenNotes || !value.governance || !value.implementation) throw new Error('INVALID_STUDIO_DOCUMENT');
  for (const key of ['content', 'brand', 'accessibility'] as const) if (typeof value[key] !== 'string') throw new Error('INVALID_STUDIO_DOCUMENT');
  if ([value.components, value.blocks, value.patterns, value.templates, value.typeStyles, value.themes, value.releases, value.checklist, value.rules, value.reviewChecks].some((entries) => entries.length > 500)) throw new Error('STUDIO_DOCUMENT_TOO_LARGE');
  for (const entry of [...value.components, ...value.blocks, ...value.patterns, ...value.templates]) {
    if (!entry || ['id', 'name', 'description', 'usage', 'avoid', 'accessibility', 'api', 'html'].some((key) => typeof entry[key as keyof StudioLibraryEntry] !== 'string') || !Array.isArray(entry.states) || !Array.isArray(entry.variants) || !['draft', 'stable', 'deprecated'].includes(entry.status)) throw new Error('INVALID_STUDIO_ENTRY');
    if(!/^[a-zA-Z0-9_-]+$/.test(entry.id))throw new Error('INVALID_STUDIO_ENTRY_ID');
    if(!entry.name.trim()||[...entry.states,...entry.variants].some(item=>typeof item!=='string'||!item.trim()))throw new Error('INVALID_STUDIO_ENTRY');
    if(entry.examples!==undefined){
      if(!Array.isArray(entry.examples)||entry.examples.length>100)throw new Error('INVALID_STUDIO_EXAMPLES');
      const ids=new Set<string>();
      for(const example of entry.examples){
        if(!example||!['variant','state','flow'].includes(example.kind)||['id','name','value','html'].some(key=>typeof (example as unknown as Record<string,unknown>)[key]!=='string')||!example.id||ids.has(example.id)||!example.name.trim()||!example.html.trim())throw new Error('INVALID_STUDIO_EXAMPLES');
        ids.add(example.id);
      }
    }
    for(const key of ['defaultVariant','good','bad','group'] as const)if(entry[key]!==undefined&&typeof entry[key]!=='string')throw new Error('INVALID_STUDIO_ENTRY');
    // A group is a label, not data to reject the document over: it is tidied, and dropped if unusable.
    if(entry.group!==undefined){const group=groupName(entry.group);if(group)entry.group=group;else delete entry.group;}
    if(entry.dependencies!==undefined&&(!Array.isArray(entry.dependencies)||entry.dependencies.some(file=>typeof file!=='string'||!file||file.startsWith('/')||file.includes('\\')||file.split('/').some(part=>part==='..'||part.startsWith('.')))))throw new Error('INVALID_STUDIO_DEPENDENCIES');
  }
  for(const entries of [value.components,value.blocks,value.patterns,value.templates,value.typeStyles,value.rules])if(new Set(entries.map(entry=>entry.id)).size!==entries.length)throw new Error('DUPLICATE_STUDIO_ENTRY_ID');
  const strings=(entry:unknown,keys:string[])=>{if(!entry||typeof entry!=='object'||keys.some(key=>typeof (entry as Record<string,unknown>)[key]!=='string'))throw new Error('INVALID_STUDIO_DOCUMENT');};
  for(const theme of value.themes)strings(theme,['name','selector','description']);
  for(const style of value.typeStyles)strings(style,['id','name','group','family','size','weight','lineHeight','letterSpacing','description']);
  for(const item of value.checklist){strings(item,['id','label']);if(typeof item.checked!=='boolean')throw new Error('INVALID_STUDIO_DOCUMENT');}
  for(const release of value.releases)strings(release,['version','date','notes']);
  for(const rule of value.rules){
    strings(rule,['id','rule','reason']);if(!/^[a-zA-Z0-9_-]+$/.test(rule.id)||!rule.rule.trim())throw new Error('INVALID_STUDIO_DOCUMENT');
    if((rule.source!==undefined&&rule.source!=='correction')||(rule.createdAt!==undefined&&typeof rule.createdAt!=='string')||(rule.context!==undefined&&typeof rule.context!=='string'))throw new Error('INVALID_STUDIO_DOCUMENT');
  }
  if(value.reviewChecks.some(check=>typeof check!=='string'||!check.trim()))throw new Error('INVALID_STUDIO_DOCUMENT');
  // The group order is tidied the same way: unknown sections, unusable names and repeats are dropped.
  const groups:StudioLibraryGroups={};
  if(value.groups&&typeof value.groups==='object'&&!Array.isArray(value.groups)){
    for(const key of ['components','blocks','patterns','templates'] as const){
      const names=(value.groups as Record<string,unknown>)[key];
      if(Array.isArray(names))groups[key]=Array.from(new Set(names.map(name=>typeof name==='string'?groupName(name):null).filter((name):name is string=>Boolean(name)))).slice(0,100);
    }
  }
  value.groups=groups;
  for(const note of Object.values(value.tokenNotes)){strings(note,['group','layer','description']);if(!['primitive','semantic','component'].includes(note.layer))throw new Error('INVALID_STUDIO_DOCUMENT');}
  strings(value.governance,['version','owners','contribution','deprecation']);
  strings(value.implementation,['repository','designFile','packageName','notes']);
  return value;
}
/** A group name is trimmed, non-empty and short enough to head a row. */
/** A group name on one line, trimmed; null when empty or longer than a row heading can hold. */
function groupName(name: string): string | null { const value = name.replace(/\s+/g, ' ').trim(); return value && value.length <= STUDIO_GROUP_NAME_MAX ? value : null; }
export function studioHandbookMarkdown(doc: StudioDocument): string {
  // Rules and the review come first: they are what an agent must hold before it builds anything.
  const lines = ['# Design system handbook'];
  // A list item is one line: line breaks inside a rule or reason would split it into a second item.
  const line = (text: string) => text.replace(/\s+/g, ' ').trim();
  if (doc.rules.length) lines.push('', '## Rules', 'Each rule is followed by its reason; use the reason to decide cases the rules do not name.', ...doc.rules.map((rule) => '- ' + line(rule.rule) + (line(rule.reason) ? ' Why: ' + line(rule.reason) : '')));
  // The review is a skill, not a standing rule: only a pointer stays in every prompt, and the checks
  // themselves are read when a screen is built or changed.
  if (doc.reviewChecks.length) lines.push('', '## Screen review', 'An on-demand skill, not a standing rule. When you build or change a screen, open `' + STUDIO_SCREEN_REVIEW_STAGED_PATH + '` in your working folder (the package copy is `' + STUDIO_SCREEN_REVIEW_SKILL_PATH + '`) and apply it to your source before you finish. Other tasks can skip it.');
  // A section with nothing in it is left out: DESIGN.md rides in every prompt, and an empty heading
  // says nothing while suggesting the system has no such thing (a rules-only document prints Rules).
  const section = (title: string, ...body: string[]) => { const kept = body.filter((part) => part.trim()); if (kept.length) lines.push('', '## ' + title, ...kept); };
  section('Content guidelines', doc.content);
  section('Brand assets', doc.brand);
  section('Accessibility', doc.accessibility, ...doc.checklist.map((item) => '- [' + (item.checked ? 'x' : ' ') + '] ' + item.label));
  section('Themes', ...doc.themes.map((theme) => '- ' + theme.name + ' (' + theme.selector + '): ' + theme.description));
  section('Token semantics', ...Object.entries(doc.tokenNotes).map(([name, note]) => '- ' + name + ' · ' + note.layer + ' · ' + note.group + ': ' + note.description));
  section('Typography styles', ...doc.typeStyles.map((style) => '- ' + style.name + ': ' + [style.family, style.size, style.weight, style.lineHeight, style.letterSpacing].join(' / ') + '. ' + style.description));
  for (const group of ['components', 'blocks', 'patterns', 'templates'] as const) {
    if (!doc[group].length) continue;
    lines.push('', '## ' + group);
    for (const entry of doc[group]) {
      lines.push('', '### ' + entry.name + ' [' + entry.status + ']', entry.description, '');
      if (entry.group) lines.push('Group: ' + line(entry.group));
      lines.push('Use: ' + entry.usage, 'Avoid: ' + entry.avoid, 'Variants: ' + entry.variants.join(', '));
      // The Studio shows a default only when it is one of the variants; the handbook says no more than that.
      const defaultVariant = entry.defaultVariant?.trim();
      if (defaultVariant && entry.variants.includes(defaultVariant)) lines.push('Default variant: ' + defaultVariant);
      lines.push('States: ' + entry.states.join(', '), 'Runnable examples: '+(entry.examples??[]).map(example=>example.kind+':'+example.value).join(', '), 'Dependencies: '+(entry.dependencies??[]).join(', '), 'Accessibility: ' + entry.accessibility, '', 'API: ' + entry.api);
      // A fence one tick longer than any run inside the code keeps the example intact.
      const fence = (code: string) => '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((run) => run.length + 1)));
      for (const [label, code] of [['Good example', entry.good], ['Bad example', entry.bad]] as const) if (code?.trim()) lines.push('', label + ':', fence(code) + 'html', code.trim(), fence(code));
    }
  }
  const implementation = doc.implementation;
  if ([implementation.repository, implementation.designFile, implementation.packageName, implementation.notes].some((value) => value.trim())) {
    lines.push('', '## Implementation', ...[['Repository: ', implementation.repository], ['Design file: ', implementation.designFile], ['Package: ', implementation.packageName]].filter(([, value]) => value!.trim()).map(([label, value]) => label! + value), ...(implementation.notes.trim() ? [implementation.notes] : []));
  }
  const governance = doc.governance;
  if (governance.owners.trim() || governance.contribution.trim() || governance.deprecation.trim() || doc.releases.length) {
    lines.push('', '## Governance', 'Version: ' + governance.version, ...(governance.owners.trim() ? ['Owners: ' + governance.owners] : []), ...[governance.contribution, governance.deprecation].filter((value) => value.trim()));
  }
  if (doc.releases.length) lines.push('', '## Changelog', ...doc.releases.map((release) => '### ' + release.version + ' · ' + release.date + '\n' + release.notes));
  if (['components', 'blocks', 'patterns', 'templates'].some((group) => doc[group as StudioCatalogKey].length)) lines.push('', 'Component, block, pattern and template source: system/studio.json. CSS source of truth: tokens.css.');
  return lines.join('\n');
}
/**
 * The screen-review skill file, or null when the system has no checks (the file is then removed).
 * Its checks run on the source just written: no rendering, preview or second pass is asked for.
 */
export function studioScreenReviewSkillMarkdown(doc: StudioDocument, title = 'this design system'): string | null {
  const checks = doc.reviewChecks.map((check) => check.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!checks.length) return null;
  const name = title.replace(/\s+/g, ' ').trim() || 'this design system';
  return ['---', 'name: screen-review', 'description: ' + JSON.stringify('Use when building or changing a screen with ' + name + '. Apply these checks to the source you wrote before you finish.'), '---', '', '# Screen review — ' + name, '',
    'Go through these against the source you just wrote and fix what fails. They complement the Rules in DESIGN.md, which hold at all times.', '',
    ...checks.map((check, index) => (index + 1) + '. ' + check), ''].join('\n');
}

/** Text compared when deciding that two rules say the same thing. */
export function studioRuleKey(rule: string): string {
  return rule.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
/**
 * Adds rules a document does not already state, as one save. Wording is collapsed to one line, a rule
 * the document already has (by its text) is skipped, and the list never grows past its cap.
 */
export function appendStudioRules(doc: StudioDocument, drafts: { rule: string; reason?: string; context?: string; source?: 'correction'; createdAt?: string }[]): { doc: StudioDocument; added: StudioRule[] } {
  const line = (text: string | undefined) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const seen = new Set(doc.rules.map((rule) => studioRuleKey(rule.rule)));
  const ids = new Set(doc.rules.map((rule) => rule.id));
  const added: StudioRule[] = [];
  for (const draft of drafts) {
    const rule = line(draft.rule), key = studioRuleKey(rule);
    if (!rule || !key || seen.has(key) || doc.rules.length + added.length >= STUDIO_RULES_MAX) continue;
    // A stable id from the wording, made unique within the document.
    let hash = 0x811c9dc5;
    for (const char of key) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 0x01000193) >>> 0; }
    let id = 'rule-' + hash.toString(36), suffix = 2;
    while (ids.has(id)) id = 'rule-' + hash.toString(36) + '-' + suffix++;
    const context = line(draft.context).slice(0, 240);
    added.push({ id, rule, reason: line(draft.reason), ...(draft.source ? { source: draft.source } : {}), ...(draft.createdAt ? { createdAt: draft.createdAt } : {}), ...(context ? { context } : {}) });
    seen.add(key); ids.add(id);
  }
  return { doc: added.length ? { ...doc, rules: [...doc.rules, ...added] } : doc, added };
}
export function attachStudioHandbook(body: string, doc: StudioDocument): string {
  const start = '<!-- fantay-studio-handbook:start -->', end = '<!-- fantay-studio-handbook:end -->';
  const index = body.indexOf(start), endIndex = body.indexOf(end);
  const original = index >= 0 && endIndex >= index ? body.slice(0, index) + body.slice(endIndex + end.length) : body;
  return original.trimEnd() + '\n\n' + start + '\n' + demoteHeadings(studioHandbookMarkdown(doc)) + '\n' + end + '\n';
}
/** One heading level down, outside fenced code only: a '#' line in a code example is code, not a heading. */
function demoteHeadings(markdown: string): string {
  let fence = '';
  return markdown.split('\n').map((text) => {
    const run = /^(`{3,})/.exec(text)?.[1];
    if (run && (!fence || (run.length >= fence.length && !text.slice(run.length).trim()))) { fence = fence ? '' : run; return text; }
    return !fence && /^#{1,4} /.test(text) ? '#' + text : text;
  }).join('\n');
}
export function stripStudioHandbook(body:string):string {
  return body.replace(/<!-- fantay-studio-handbook:start -->[\s\S]*?<!-- fantay-studio-handbook:end -->/g,'').trimEnd();
}
