import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, IconButton, SearchField, Segmented, SegmentedItem } from '../fantay/ui';
import { STUDIO_GROUP_NAME_MAX, type StudioDocument, type StudioLibraryEntry, type StudioLibraryExample } from '@open-design/contracts';
import { randomUUID } from '../utils/uuid';
import { renderMarkdown } from '../runtime/markdown';
import { bundleStudioEntry, type StudioEntryBundle, type StudioResourceReader } from '../runtime/studio-entry-bundle';
import { addStudioGroup, mergeStudioEntry, moveStudioGroup, rememberStudioGroup, removeStudioGroup, renameStudioGroup, STUDIO_GROUP_SUGGESTIONS, studioGroupedEntries, studioGroupNames, studioMutationMessage, type StudioCatalogSection } from '../runtime/studio-catalog';
import { StudioDialog } from './StudioDialog';
import { StudioEntryPreview } from './StudioEntryPreview';
import { useSlidingIndicator } from './StudioChapterNav';
import { Icon } from './Icon';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import styles from './StudioCatalog.module.css';
import { Select } from './Select';

interface Props {
  section: StudioCatalogSection; document: StudioDocument; onSave: (doc: StudioDocument) => Promise<void>;
  editable: boolean; busy?: boolean; chinese: boolean; css: string; scope: string; readResource: StudioResourceReader;
  resourceRevision?:number;
  onReuse?: (entry: StudioLibraryEntry, bundle: StudioEntryBundle) => Promise<void>;
  /** The shell's shared search across the chapter. Given, the catalog drops its own search field. */
  query?: string;
  /** Given, the shell shows the add button on its section heading and bumps this to start a new entry. */
  addRequest?: number;
  /** The shell's shared preview theme. Given, the catalog drops its own theme picker. */
  previewTheme?: string;
  /** Given, the shell shows "New group" on its section heading and bumps this to start one. */
  groupRequest?: number;
}
type GroupForm = { from: string | null; name: string };
interface Draft { entry: StudioLibraryEntry; baseline: StudioLibraryEntry | null; variants: string; states: string }

// Readers search a Chinese UI in Chinese while the starter entries carry English names.
const ZH_ALIASES: [string, string][] = [['按钮', 'button'], ['输入框', 'textfield'], ['选择', 'select'], ['复选', 'checkbox'], ['提示', 'toast'], ['空状态', 'empty state']];

function entryMatches(entry: StudioLibraryEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [entry.name, entry.description, entry.usage, entry.avoid, entry.api, ...entry.variants, ...entry.states, entry.defaultVariant ?? '', entry.good ?? '', entry.bad ?? '', entry.group ?? ''].join('\n').toLowerCase();
  return [needle, ...ZH_ALIASES.filter(([zh]) => needle.includes(zh)).map(([, en]) => en)].some(term => haystack.includes(term));
}

const EMPTY_COPY: Record<StudioCatalogSection, { title: [string, string]; editable: [string, string]; readOnly: [string, string] }> = {
  components: {
    title: ['还没有组件', 'No components yet'],
    editable: ['点「用 Agent 编辑」，按这套变量生成按钮、输入框等组件；也可以点「添加」手写一个。', 'Use Edit with agent to generate buttons, fields and other components from these tokens, or add one by hand.'],
    readOnly: ['这个设计体系没有收录组件。', 'This design system includes no components.'],
  },
  blocks: {
    title: ['还没有区块', 'No blocks yet'],
    editable: ['区块是从真实页面里提炼出的具名组合，比如页面标题栏、任务行、数据卡片。先做几个真实页面，把反复重建的部分加到这里；也可以点「添加」手写一个。', 'Blocks are named compositions lifted from real screens, such as a page header, a task row or a stat card. Build a few real screens first and add the parts you keep rebuilding, or add one by hand.'],
    readOnly: ['这个设计体系没有收录区块。', 'This design system includes no blocks.'],
  },
  patterns: {
    title: ['还没有模式', 'No patterns yet'],
    editable: ['模式把几个组件组合成表单、空状态这类常见场景。点「用 Agent 编辑」生成，也可以点「添加」手写一个。', 'Patterns combine components into common situations such as forms and empty states. Use Edit with agent to generate them, or add one by hand.'],
    readOnly: ['这个设计体系没有收录模式。', 'This design system includes no patterns.'],
  },
  templates: {
    title: ['还没有模板', 'No templates yet'],
    editable: ['模板是可以直接复用的整页，比如设置页或项目详情。点「用 Agent 编辑」生成，也可以点「添加」手写一个。', 'Templates are whole pages to reuse, such as settings or a project page. Use Edit with agent to generate them, or add one by hand.'],
    readOnly: ['这个设计体系没有收录模板。', 'This design system includes no templates.'],
  },
};

export function StudioCatalog({ section, document: doc, onSave, editable, busy = false, chinese, css, scope, readResource, onReuse, resourceRevision=0, query: sharedQuery, previewTheme, addRequest, groupRequest }: Props) {
  const t = (zh: string, en: string) => chinese ? zh : en;
  const [localQuery, setQuery] = useState('');
  const [localTheme, setTheme] = useState('light');
  const query = sharedQuery ?? localQuery;
  const theme = previewTheme ?? localTheme;
  // One open entry per section: it spans the row, every other entry stays a tile.
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editorTab, setEditorTab] = useState<'details' | 'source' | 'examples'>('details');
  const [exampleIndex, setExampleIndex] = useState(-1);
  const [remove, setRemove] = useState<StudioLibraryEntry | null>(null);
  const [groupForm, setGroupForm] = useState<GroupForm | null>(null);
  const [groupRemove, setGroupRemove] = useState<string | null>(null);
  const groupListId = useId();
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackShown, setFeedbackShown] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setFeedbackShown(Boolean(feedback));
    if (!feedback) return;
    const timer = setTimeout(() => setFeedbackShown(false), 2600);
    return () => clearTimeout(timer);
  }, [feedback]);
  const open = (entry: StudioLibraryEntry, baseline: StudioLibraryEntry | null) => {
    setDraft({ entry: structuredClone(entry), baseline: baseline ? structuredClone(baseline) : null, variants: entry.variants.join(', '), states: entry.states.join(', ') });
    setEditorTab('details'); setExampleIndex(-1); setError(''); setFeedback('');
  };
  async function perform(action: () => Promise<void>, success = t('已保存', 'Saved')): Promise<boolean> {
    if (lock.current || busy) return false;
    lock.current = true; setPending(true); setError(''); setFeedback('');
    try { await action(); setFeedback(success); return true; }
    catch (error) { setError(studioMutationMessage(error, chinese)); return false; }
    finally { lock.current = false; setPending(false); }
  }
  async function save() {
    if (!draft) return;
    const variants = split(draft.variants);
    const entry: StudioLibraryEntry = { ...draft.entry, name: draft.entry.name.trim(), variants, states: split(draft.states) };
    // Absent stays absent: a default the variants no longer name, or a blank example, leaves no key behind.
    if (!entry.defaultVariant || !variants.includes(entry.defaultVariant)) delete entry.defaultVariant;
    for (const key of ['good', 'bad'] as const) if (!entry[key]?.trim()) delete entry[key];
    const group = entry.group?.replace(/\s+/g, ' ').trim();
    if (group) entry.group = group; else delete entry.group;
    const ok = await perform(async () => {
      if (!entry.name) throw new Error(t('请填写名称。', 'Enter a name.'));
      if (!entry.html.trim()) throw new Error(t('请添加可以运行的 HTML 实现，再保存条目。', 'Add a runnable HTML implementation before saving.'));
      for (const example of entry.examples ?? []) if (!example.name.trim() || !example.value.trim() || !example.html.trim()) throw new Error(t('每个交互示例都需要名称、对应值与实现。', 'Every example needs a name, target value and implementation.'));
      if (group && group.length > STUDIO_GROUP_NAME_MAX) throw new Error('INVALID_GROUP');
      await onSave(rememberStudioGroup(mergeStudioEntry(doc, section, entry, draft.baseline), section, group, doc));
    });
    if (ok) setDraft(null);
  }
  function update(patch: Partial<StudioLibraryEntry>) { if (draft) setDraft({ ...draft, entry: { ...draft.entry, ...patch } }); }
  function updateExample(patch: Partial<StudioLibraryExample>) {
    if (!draft || exampleIndex < 0) return;
    update({ examples: (draft.entry.examples ?? []).map((example, index) => index === exampleIndex ? { ...example, ...patch } : example) });
  }
  const field = (label: string, value: string, change: (value: string) => void, multiline = false) => <label className={styles.field}>{label}{multiline ? <textarea value={value} onChange={event => change(event.target.value)} /> : <input value={value} onChange={event => change(event.target.value)} />}</label>;
  const editorExample = draft?.entry.examples?.[exampleIndex];
  const draftVariants = draft ? split(draft.variants) : [];
  const entries = doc[section].filter(entry => entryMatches(entry, query));
  const empty = EMPTY_COPY[section];
  const startAdd = (group?: string) => open({ id: randomUUID(), name: '', description: '', status: 'draft', usage: '', avoid: '', accessibility: '', api: '', variants: [], states: [], html: '<section><h2>New design</h2><p>Start here.</p></section>', examples: [], ...(group ? { group } : {}) }, null);
  const add = <Button variant="ghost" size="sm" className={styles.add} disabled={pending || busy} onClick={() => startAdd()}><Icon name="plus" size={14} />{t('添加', 'Add')}</Button>;
  const startGroup = () => { setError(''); setGroupForm({ from: null, name: '' }); };
  const addGroup = <Button variant="ghost" size="sm" className={styles.add} disabled={pending || busy} onClick={startGroup}><Icon name="folder" size={14} />{t('新建分组', 'New group')}</Button>;
  const groupNames = studioGroupNames(doc, section);
  // The user's groups first, then the suggestions they have not used, so a new name can still be typed.
  const groupOptions = [...groupNames, ...STUDIO_GROUP_SUGGESTIONS[section].map(([zh, en]) => chinese ? zh : en).filter(name => !groupNames.includes(name))];
  async function saveGroup() {
    if (!groupForm) return;
    const ok = await perform(async () => { await onSave(groupForm.from === null ? addStudioGroup(doc, section, groupForm.name) : renameStudioGroup(doc, section, groupForm.from, groupForm.name)); }, groupForm.from === null ? t('分组已新建', 'Group created') : t('分组已重命名', 'Group renamed'));
    if (ok) setGroupForm(null);
  }
  const seenGroupRequest = useRef(groupRequest);
  useEffect(() => {
    if (groupRequest === undefined || seenGroupRequest.current === undefined) { seenGroupRequest.current = groupRequest; return; }
    if (groupRequest === seenGroupRequest.current) return;
    seenGroupRequest.current = groupRequest;
    if (editable && !pending && !busy) startGroup();
  });
  // The heading's add button lives in the shell; each press arrives as a new number.
  const seenAddRequest = useRef(addRequest);
  useEffect(() => {
    // A count appearing (edit rights arriving after mount) sets the baseline; only a change after it is a press.
    if (addRequest === undefined || seenAddRequest.current === undefined) { seenAddRequest.current = addRequest; return; }
    if (addRequest === seenAddRequest.current) return;
    seenAddRequest.current = addRequest;
    if (editable && !pending && !busy) startAdd();
  });
  const dialogs = <>
    {draft && <StudioDialog className={styles.editor} title={t('编辑条目 · ', 'Edit entry · ') + (draft.entry.name || t('新条目', 'New entry'))} pending={pending} onClose={() => { if (!pending) setDraft(null); }}>{dismiss => <>
      <LineTabs label={t('编辑内容', 'Editor sections')} active={editorTab} onSelect={setEditorTab} tabs={[{ id: 'details', label: t('规范', 'Specification') }, { id: 'source', label: t('实现', 'Implementation') }, { id: 'examples', label: t('变体与状态', 'Variants & states') }]} />
      <div className={styles.editorGrid}><fieldset disabled={pending} className={styles.editorFields} data-editor-tab={editorTab}>
        {editorTab === 'details' && <>
          <div className={styles.fieldPair}>{field(t('名称', 'Name'), draft.entry.name, name => update({ name }))}<label className={styles.field}>{t('成熟度', 'Maturity')}<Select value={draft.entry.status} onChange={event => update({ status: event.target.value as StudioLibraryEntry['status'] })}><option value="draft">{t('草稿', 'Draft')}</option><option value="stable">{t('稳定', 'Stable')}</option><option value="deprecated">{t('已弃用', 'Deprecated')}</option></Select></label></div>
          {field(t('一句话说明', 'Summary'), draft.entry.description, description => update({ description }))}
          <div className={styles.fieldPair}><label className={styles.field}>{t('分组（可输入新分组）', 'Group (type a new one to create it)')}<input list={groupListId} value={draft.entry.group ?? ''} placeholder={t('未分组', 'Ungrouped')} maxLength={STUDIO_GROUP_NAME_MAX} onChange={event => update({ group: event.target.value })} /></label><datalist id={groupListId}>{groupOptions.map(name => <option key={name} value={name} />)}</datalist></div>
          <div className={styles.fieldPair}>{field(t('变体（逗号分隔）', 'Variants (comma-separated)'), draft.variants, variants => setDraft({ ...draft, variants }))}{field(t('状态（逗号分隔）', 'States (comma-separated)'), draft.states, states => setDraft({ ...draft, states }))}</div>
          <div className={styles.fieldPair}><label className={styles.field}>{t('默认变体', 'Default variant')}<Select value={draft.entry.defaultVariant && draftVariants.includes(draft.entry.defaultVariant) ? draft.entry.defaultVariant : ''} onChange={event => update({ defaultVariant: event.target.value || undefined })}><option value="">{t('未指定', 'Not set')}</option>{draftVariants.map(variant => <option key={variant} value={variant}>{variant}</option>)}</Select></label></div>
          {field(t('什么时候用', 'When to use'), draft.entry.usage, usage => update({ usage }), true)}{field(t('不要这样用', 'Avoid'), draft.entry.avoid, avoid => update({ avoid }), true)}{field(t('无障碍要求', 'Accessibility'), draft.entry.accessibility, accessibility => update({ accessibility }), true)}{field(t('属性 API（Markdown）', 'Props API (Markdown)'), draft.entry.api, api => update({ api }), true)}
        </>}
        {editorTab === 'source' && <><p>{t('右侧实时预览当前草稿。保存后会同步到设计体系；复用会携带变量和本地资源。', 'The preview reflects your draft. Saving syncs the design system; reuse includes tokens and local resources.')}</p>{field(t('HTML 实现', 'HTML implementation'), draft.entry.html, html => update({ html }), true)}<div className={styles.pairFields}>{field(t('正确写法（来自真实代码）', 'Good example (from real code)'), draft.entry.good ?? '', good => update({ good }), true)}{field(t('错误写法', 'Bad example'), draft.entry.bad ?? '', bad => update({ bad }), true)}</div></>}
        {editorTab === 'examples' && <><div className={styles.exampleTools}><Select aria-label={t('选择示例', 'Select example')} value={exampleIndex} onChange={event => setExampleIndex(Number(event.target.value))}><option value={-1}>{t('默认实现', 'Default implementation')}</option>{(draft.entry.examples ?? []).map((example, index) => <option key={example.id} value={index}>{example.name}</option>)}</Select><Button variant="ghost" size="sm" onClick={() => { const examples = [...draft.entry.examples ?? [], { id: randomUUID(), name: t('新示例', 'New example'), kind: 'state' as const, value: 'default', html: draft.entry.html }]; update({ examples }); setExampleIndex(examples.length - 1); }}><Icon name="plus" size={14} />{t('添加示例', 'Add example')}</Button></div>
          {editorExample ? <>{field(t('示例名称', 'Example name'), editorExample.name, name => updateExample({ name }))}<label className={styles.field}>{t('示例类型', 'Example kind')}<Select value={editorExample.kind} onChange={event => updateExample({ kind: event.target.value as StudioLibraryExample['kind'] })}><option value="variant">{t('变体', 'Variant')}</option><option value="state">{t('状态', 'State')}</option><option value="flow">{t('流程', 'Flow')}</option></Select></label>{field(t('对应的变体或状态值', 'Variant or state value'), editorExample.value, value => updateExample({ value }))}{field(t('示例 HTML', 'Example HTML'), editorExample.html, html => updateExample({ html }), true)}<Button variant="ghost" size="sm" onClick={() => { update({ examples: draft.entry.examples?.filter((_, index) => index !== exampleIndex) }); setExampleIndex(-1); }}>{t('移除此示例', 'Remove example')}</Button></> : <p>{t('每个声明的状态应有实际实现。可以添加独立示例，或者在默认实现中展示全部状态。', 'Declared states need real implementations. Add individual examples or demonstrate them in the default implementation.')}</p>}
        </>}
      </fieldset><div className={styles.draftPreview}><strong>{t('未保存的实时预览', 'Live draft preview')}</strong><StudioEntryPreview entry={draft.entry} html={editorTab === 'examples' && editorExample ? editorExample.html : draft.entry.html} css={css} theme={theme} readResource={readResource} scope={scope + ':draft'} title={t('草稿预览', 'Draft preview')} resourceRevision={resourceRevision} chinese={chinese}/></div></div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <footer className={styles.editorFooter}><span>{t('保存失败时，草稿会留在这里。', 'Your draft stays here if saving fails.')}</span><Button variant="ghost" size="sm" disabled={pending} onClick={dismiss}>{t('取消更改', 'Cancel changes')}</Button><Button variant="primary" size="sm" disabled={pending || busy} onClick={() => void save()}>{pending ? t('正在保存…', 'Saving…') : t('保存条目', 'Save entry')}</Button></footer>
    </>}</StudioDialog>}
    {groupForm && <StudioDialog className={styles.confirm} title={groupForm.from === null ? t('新建分组', 'New group') : t('重命名分组', 'Rename group')} pending={pending} onClose={() => { if (!pending) { setGroupForm(null); setError(''); } }}>{dismiss => <form className={styles.groupForm} onSubmit={event => { event.preventDefault(); void saveGroup(); }}>
      <label className={styles.field}>{t('分组名称', 'Group name')}<input value={groupForm.name} maxLength={STUDIO_GROUP_NAME_MAX} list={groupForm.from === null ? groupListId + '-new' : undefined} data-autofocus="" onChange={event => setGroupForm({ ...groupForm, name: event.target.value })} /></label>
      {groupForm.from === null && <datalist id={groupListId + '-new'}>{groupOptions.filter(name => !groupNames.includes(name)).map(name => <option key={name} value={name} />)}</datalist>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.editorFooter}><Button type="button" variant="ghost" size="sm" disabled={pending} onClick={dismiss}>{t('取消', 'Cancel')}</Button><Button type="submit" variant="primary" size="sm" disabled={pending || !groupForm.name.trim()}>{groupForm.from === null ? t('新建', 'Create') : t('保存', 'Save')}</Button></div>
    </form>}</StudioDialog>}
    {groupRemove !== null && <StudioDialog className={styles.confirm} title={t('删除分组', 'Delete group')} pending={pending} onClose={() => { if (!pending) { setGroupRemove(null); setError(''); } }}>{dismiss => { const count = doc[section].filter(entry => entry.group === groupRemove).length; return <><p className={styles.confirmText}>{chinese ? '删除分组「' + groupRemove + '」？' + (count ? '其中 ' + count + ' 个条目会移到「未分组」，条目本身不会删除。' : '这个分组里没有条目。') : 'Delete the group “' + groupRemove + '”? ' + (count ? count + (count === 1 ? ' entry moves' : ' entries move') + ' to Ungrouped; no entry is deleted.' : 'It holds no entries.')}</p>{error && <p role="alert" className={styles.error}>{error}</p>}<div className={styles.editorFooter}><Button variant="ghost" size="sm" disabled={pending} onClick={dismiss}>{t('取消', 'Cancel')}</Button><Button variant="primary" size="sm" disabled={pending} onClick={() => void perform(async () => { await onSave(removeStudioGroup(doc, section, groupRemove)); setGroupRemove(null); }, t('分组已删除', 'Group deleted'))}>{t('删除分组', 'Delete group')}</Button></div></>; }}</StudioDialog>}
    {remove && <StudioDialog className={styles.confirm} title={t('删除条目', 'Delete entry')} pending={pending} onClose={() => { if (!pending) setRemove(null); }}>{dismiss => <><p className={styles.confirmText}>{t('删除「', 'Delete “') + remove.name + t('」？历史版本仍保留，可从治理页恢复。', '”? Previous source versions remain in Governance.')}</p>{error && <p role="alert" className={styles.error}>{error}</p>}<div className={styles.editorFooter}><Button variant="ghost" size="sm" disabled={pending} onClick={dismiss}>{t('取消', 'Cancel')}</Button><Button variant="primary" size="sm" disabled={pending} onClick={() => void perform(async () => { const current = doc[section].find(entry => entry.id === remove.id); if (JSON.stringify(current) !== JSON.stringify(remove)) throw new Error('ENTRY_CONFLICT'); await onSave({ ...doc, [section]: doc[section].filter(entry => entry.id !== remove.id) }); setRemove(null); }, t('条目已删除', 'Entry deleted'))}>{t('确认删除', 'Delete entry')}</Button></div></>}</StudioDialog>}
  </>;
  const renderEntry = (entry: StudioLibraryEntry, grouped = false) => <CatalogEntry key={scope + entry.id} grouped={grouped} fit open={openId === entry.id} onToggle={() => setOpenId(current => current === entry.id ? null : entry.id)} entry={entry} css={css} theme={theme} chinese={chinese} scope={scope} readResource={readResource} resourceRevision={resourceRevision} pending={pending || busy} editable={editable}
    onEdit={() => open(entry, entry)} onRemove={() => { setRemove(entry); setError(''); }}
    onDuplicate={() => void perform(async () => { const clone = { ...structuredClone(entry), id: randomUUID(), name: entry.name + t(' 副本', ' copy'), status: 'draft' as const }; await onSave(mergeStudioEntry(doc, section, clone, null)); }, t('副本已保存', 'Copy saved'))}
    onCopy={source => void perform(async () => { const bundle = await bundleStudioEntry(source, css, readResource); if(!await copyToClipboard(bundle.html))throw new Error(t('浏览器未允许复制，请改用下载 HTML。','Clipboard access was denied. Use Download HTML instead.')); }, t('已复制 HTML，含变量与本地资源', 'Copied HTML with tokens and local resources'))}
    onCopySource={html => void perform(async () => { if(!await copyToClipboard(html))throw new Error(t('浏览器未允许复制，请改用下载 HTML。','Clipboard access was denied. Use Download HTML instead.')); }, t('已复制示例代码', 'Example source copied'))}
    onDownload={source => void perform(async () => { const bundle = await bundleStudioEntry(source, css, readResource); const url = URL.createObjectURL(new Blob([bundle.html], { type: 'text/html' })); const a = document.createElement('a'); a.href = url; a.download = source.name.replace(/[^\p{L}\p{N}._-]+/gu, '-') + '.html'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }, t('HTML 已导出', 'HTML exported'))}
    onReuse={onReuse ? source => void perform(async () => { const bundle = await bundleStudioEntry(source, css, readResource); await onReuse(source, bundle); }, t('项目已创建', 'Project created')) : undefined}
  />;
  // The shell searches every section at once; a section with no hit steps aside instead of saying so.
  if (sharedQuery !== undefined && sharedQuery.trim() && entries.length === 0) return <div className={styles.root} data-catalog={section} data-no-match="">{dialogs}</div>;
  const ownSearch = sharedQuery === undefined, ownTheme = previewTheme === undefined;
  const toolbar = (doc[section].length > 0 || groupNames.length > 0) && (ownSearch || ownTheme || (editable && addRequest === undefined));
  // With the search and theme in the shell, adding is the only control left: it hangs above the
  // grid's top edge, under the section header, instead of taking a row of its own.
  const addOnly = !ownSearch && !ownTheme;
  return <div className={styles.root} data-catalog={section}>
    {toolbar && (addOnly ? <div className={styles.addRow}><div className={styles.addTools}>{add}{addGroup}</div></div> : <div className={styles.toolbar}>
      {ownSearch && <SearchField className={styles.search} type="search" aria-label={t('搜索条目', 'Search entries')} placeholder={t('搜索名称或用途…', 'Search name or usage…')} value={query} onChange={event => setQuery(event.target.value)} />}
      {ownTheme && <Select aria-label={t('预览主题', 'Preview theme')} value={theme} onChange={event => setTheme(event.target.value)}><option value="light">{t('浅色', 'Light')}</option>{doc.themes.flatMap(item => { const key = item.selector.match(/data-theme=['"]([^'"]+)/)?.[1]; return key ? [<option key={key} value={key}>{item.name}</option>] : []; })}</Select>}
      {editable && add}{editable && addGroup}
    </div>)}
    {error && !draft && !remove && !groupForm && groupRemove === null && <p className={styles.error} role="alert">{error}</p>}
    {doc[section].length === 0 && !groupNames.length
      ? <EmptyState variant="dashed" title={t(...empty.title)} description={editable ? t(...empty.editable) : t(...empty.readOnly)} action={editable ? add : undefined} />
      : entries.length === 0 && (query.trim() || !groupNames.length)
        ? <EmptyState variant="dashed" title={t('没有匹配的条目', 'No matching entries')} description={(chinese ? '没有名称或用途包含「' + query.trim() + '」的条目。' : 'Nothing mentions “' + query.trim() + '”.')} action={ownSearch ? <Button variant="ghost" size="sm" onClick={() => setQuery('')}>{t('清除搜索', 'Clear search')}</Button> : undefined} />
        : <>
          {/* A system with no groups keeps one grid; once it has groups, each heads its own grid and the
              ungrouped close the list. A search hides the groups it leaves empty. */}
          {groupNames.length
            ? studioGroupedEntries(doc, section, entries).filter(group => !query.trim() || group.entries.length).map((group) => <section key={group.name ?? ''} className={styles.group} data-catalog-group={group.name ?? ''}>
              <header className={styles.groupHead}>
                <h3>{group.name ?? t('未分组', 'Ungrouped')}</h3><span className={styles.groupCount}>{doc[section].filter(entry => (entry.group ?? null) === group.name).length}</span>
                {editable && group.name !== null && <div className={styles.groupTools}>
                  <IconButton size="xs" aria-label={t('添加到分组：', 'Add to group: ') + group.name} tooltip={t('添加到这个分组', 'Add to this group')} disabled={pending || busy} onClick={() => startAdd(group.name!)}><Icon name="plus" size={14} /></IconButton>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild><IconButton size="xs" aria-label={t('分组操作：', 'Group actions: ') + group.name} disabled={pending || busy}><Icon name="more-horizontal" size={14} /></IconButton></DropdownMenuTrigger>
                    <DropdownMenuContent width="sm">
                      <DropdownMenuItem icon={<Icon name="edit" size={14} />} onSelect={() => { setError(''); setGroupForm({ from: group.name!, name: group.name! }); }}>{t('重命名', 'Rename')}</DropdownMenuItem>
                      <DropdownMenuItem icon={<Icon name="chevron-up" size={14} />} disabled={groupNames.indexOf(group.name!) <= 0} onSelect={() => void perform(async () => { await onSave(moveStudioGroup(doc, section, group.name!, -1)); }, t('分组已上移', 'Group moved up'))}>{t('上移', 'Move up')}</DropdownMenuItem>
                      <DropdownMenuItem icon={<Icon name="chevron-down" size={14} />} disabled={groupNames.indexOf(group.name!) >= groupNames.length - 1} onSelect={() => void perform(async () => { await onSave(moveStudioGroup(doc, section, group.name!, 1)); }, t('分组已下移', 'Group moved down'))}>{t('下移', 'Move down')}</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem tone="danger" icon={<Icon name="trash" size={14} />} onSelect={() => { setError(''); setGroupRemove(group.name!); }}>{t('删除分组', 'Delete group')}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>}
              </header>
              {group.entries.length ? <div className={styles.entries}>{group.entries.map(entry => renderEntry(entry, true))}</div> : <p className={styles.groupEmpty}>{editable ? t('这个分组还没有条目，点 + 添加。', 'Nothing in this group yet. Use + to add an entry.') : t('这个分组还没有条目。', 'Nothing in this group yet.')}</p>}
            </section>)
            : <div className={styles.entries}>{entries.map(entry => renderEntry(entry))}</div>}
          {entries.length > 0 && <p className={styles.footnote}>{t('演示数据仅保存在此浏览器，按条目隔离。', 'Demo data is browser-local and isolated per entry.')}</p>}
        </>}
    <div className={styles.feedbackDock}><p className={styles.feedback} role="status" data-shown={feedbackShown || undefined}><Icon name="check" size={13} />{feedback}</p></div>
    {dialogs}
  </div>;
}

/** Text tabs on a hairline with one sliding underline. `active: null` is a closed disclosure. */
function LineTabs<Id extends string>({ label, tabs, active, onSelect, className = '' }: {
  label: string; tabs: { id: Id; label: string }[]; active: Id | null; onSelect: (id: Id) => void; className?: string;
}) {
  const { containerRef, indicatorStyle } = useSlidingIndicator(active ?? '');
  const arrows = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    event.preventDefault();
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };
  return <div ref={containerRef} className={styles.lineTabs + ' ' + className} role="tablist" aria-label={label} onKeyDown={arrows}>
    {tabs.map(tab => <button type="button" role="tab" key={tab.id} data-indicator-item={tab.id} aria-selected={tab.id === active} onClick={() => onSelect(tab.id)}>{tab.label}</button>)}
    <span aria-hidden className={styles.lineTabsUnderline} style={indicatorStyle} />
  </div>;
}

/** A one-of-N row on the stage: the thumb slides under the labels instead of each item lighting up. */
function StagePicker({ label, value, onChange, items, className = '' }: {
  label: string; value: string; onChange: (value: string) => void; items: { value: string; label: string }[]; className?: string;
}) {
  const { containerRef, indicatorStyle } = useSlidingIndicator(value);
  return <Segmented ref={containerRef} size="sm" aria-label={label} value={value} onValueChange={onChange} className={styles.picker + ' ' + className}>
    <span aria-hidden className={styles.pickerThumb} style={indicatorStyle} />
    {items.map(item => <SegmentedItem key={item.value} value={item.value} data-indicator-item={item.value}>{item.label}</SegmentedItem>)}
  </Segmented>;
}

type DetailTab = 'spec' | 'props' | 'code' | 'a11y';

// Matches --st-dur-exit: a tab swap closes the panel before the next one opens.
const PANEL_EXIT_MS = 140;
const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Closed, an entry is a tile: name, maturity and its whole live preview scaled into a thumbnail, under one stretched button.
 * Open, it spans the row with its actions, stage and details. The preview stays the same element
 * in both, so opening never reloads the frame.
 */
function CatalogEntry({ fit, open, onToggle, entry, css, theme, chinese, scope, readResource, pending, editable, onEdit, onDuplicate, onRemove, onCopy, onCopySource, onDownload, onReuse,resourceRevision, grouped = false }: {
  /** Under a group heading the entry sits one level lower in the outline. */
  grouped?: boolean;
  fit: boolean; open: boolean; onToggle: () => void;
  entry: StudioLibraryEntry; css: string; theme: string; chinese: boolean; scope: string; readResource: StudioResourceReader; pending: boolean; editable: boolean;
  resourceRevision:number;
  onEdit: () => void; onDuplicate: () => void; onRemove: () => void; onCopy: (entry: StudioLibraryEntry) => void; onCopySource: (html: string) => void; onDownload: (entry: StudioLibraryEntry) => void; onReuse?: (entry: StudioLibraryEntry) => void;
}) {
  const t = (zh: string, en: string) => chinese ? zh : en;
  const Title = grouped ? 'h4' : 'h3';
  const Sub = grouped ? 'h5' : 'h4';
  const card = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  // `detail` is the selected tab, `panel` the content on screen, `shown` whether the disclosure is open.
  // They part during a swap: the old content folds away before the new tab's content unfolds.
  const [detail, setDetail] = useState<DetailTab | null>('spec');
  const [panel, setPanel] = useState<DetailTab>('spec');
  const [shown, setShown] = useState(true);
  const swap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) { setDetail('spec'); setPanel('spec'); setShown(true); }
  }
  const [selected, setSelected] = useState('default'), [width, setWidth] = useState('auto'), [reset, setReset] = useState(0);
  const example = entry.examples?.find(item => item.id === selected);
  useEffect(()=>{if(selected!=='default'&&!entry.examples?.some(example=>example.id===selected))setSelected('default');},[entry.examples,selected]);
  useEffect(() => () => { if (swap.current) clearTimeout(swap.current); }, []);
  // React 18 drops a boolean `inert`: a tile's frame must not take focus or clicks meant for the tile.
  useLayoutEffect(() => { if (open) stage.current?.removeAttribute('inert'); else stage.current?.setAttribute('inert', ''); }, [open]);
  useEffect(() => {
    if (!open) { if (swap.current) { clearTimeout(swap.current); swap.current = null; } return; }
    // The open entry takes its own row, which can land below the fold.
    card.current?.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [open]);
  const selectTab = (tab: DetailTab) => {
    if (swap.current) { clearTimeout(swap.current); swap.current = null; }
    if (detail === tab) { setDetail(null); setShown(false); return; }
    const switching = detail !== null;
    setDetail(tab);
    if (!switching) { setPanel(tab); setShown(true); return; }
    if (reducedMotion()) { setPanel(tab); setShown(true); return; }
    setShown(false);
    swap.current = setTimeout(() => { swap.current = null; setPanel(tab); setShown(true); }, PANEL_EXIT_MS);
  };
  const source = example ? { ...entry, name: entry.name + ' · ' + example.name, html: example.html } : entry;
  const covered = entry.states.filter(state => entry.examples?.some(example => example.kind === 'state' && example.value === state));
  const examples = entry.examples ?? [];
  const exampleLabel = entry.name + t(' 示例', ' example');
  const markdown = (value: string): ReactNode => renderMarkdown(value || '—');
  const status = ({ draft: t('草稿', 'Draft'), stable: t('稳定', 'Stable'), deprecated: t('已弃用', 'Deprecated') })[entry.status];
  // The default leads the variants; a default the variants do not name is not shown at all.
  const preferred = entry.defaultVariant && entry.variants.includes(entry.defaultVariant) ? entry.defaultVariant : undefined;
  const variants = preferred ? [preferred, ...entry.variants.filter(variant => variant !== preferred)] : entry.variants;
  // Only the examples the system has: a missing one leaves no empty panel behind.
  const pair = ([['good', entry.good], ['bad', entry.bad]] as const).flatMap(([tone, code]) => code?.trim() ? [{ tone, code }] : []);
  return <article ref={card} className={styles.card} data-entry-id={entry.id} data-open={open || undefined}>
    <header className={styles.cardHeader}>
      <button type="button" className={styles.hit} aria-expanded={open} aria-label={entry.name} title={open ? undefined : entry.description || undefined} onClick={onToggle} />
      <div className={styles.cardTitle}><Title>{entry.name}</Title><span className={styles.status} data-status={entry.status}><i aria-hidden />{status}</span><Icon name="chevron-down" size={14} className={styles.chevron} /></div>
      {open && <div className={styles.cardActions}>
        <IconButton size="sm" aria-label={t('复制完整 HTML', 'Copy HTML')} disabled={pending || !source.html} onClick={() => onCopy(source)}><Icon name="copy" size={15} /></IconButton>
        <IconButton size="sm" aria-label={t('下载 HTML', 'Download HTML')} disabled={pending || !source.html} onClick={() => onDownload(source)}><Icon name="download" size={15} /></IconButton>
        {onReuse && <IconButton size="sm" aria-label={t('创建独立项目', 'Create project')} disabled={pending || !source.html} onClick={() => onReuse(source)}><Icon name="folder" size={15} /></IconButton>}
        {editable && <IconButton size="sm" aria-label={t('编辑', 'Edit')} disabled={pending} onClick={onEdit}><Icon name="edit" size={15} /></IconButton>}
        {editable && <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild><IconButton size="sm" aria-label={t('更多操作', 'More actions')} disabled={pending}><Icon name="more-horizontal" size={15} /></IconButton></DropdownMenuTrigger>
          <DropdownMenuContent width="sm">
            <DropdownMenuItem icon={<Icon name="copy" size={14} />} onSelect={onDuplicate}>{t('复制条目', 'Duplicate')}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="danger" icon={<Icon name="trash" size={14} />} onSelect={onRemove}>{t('删除条目', 'Delete entry')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>}
    </header>
    {open && entry.description && <p className={styles.cardDescription}>{entry.description}</p>}
    <div ref={stage} className={styles.stage}>
      {open && <div className={styles.stageControls}>
        {examples.length > 0 && <Select className={styles.exampleSelect} aria-label={exampleLabel} value={selected} onChange={event => setSelected(event.target.value)}><option value="default">{t('默认实现', 'Default implementation')}</option>{examples.map(example => <option key={example.id} value={example.id}>{example.name}</option>)}</Select>}
        <StagePicker className={styles.widthPicker} label={entry.name + t(' 预览宽度', ' preview width')} value={width} onChange={setWidth} items={[{ value: 'auto', label: t('自适应', 'Responsive') }, { value: '768', label: '768' }, { value: '375', label: '375' }]} />
        <IconButton size="sm" className={styles.stageReset} aria-label={t('重置', 'Reset')} tooltip={t('清除这个示例的本地演示数据', 'Clear this example’s local demo data')} onClick={() => setReset(value => value + 1)}><Icon name="refresh" size={14} /></IconButton>
      </div>}
      <div className={styles.stageViewport}><div className={styles.stageFrame} style={!open || width === 'auto' ? undefined : { flexBasis: Number(width) }}><StudioEntryPreview entry={entry} html={source.html} css={css} theme={theme} readResource={readResource} scope={scope} title={entry.name + ' · ' + (example?.name ?? 'default')} storageId={example?.id??'default'} reset={reset} resourceRevision={resourceRevision} chinese={chinese} fit={fit} thumbnail={!open}/></div></div>
    </div>
    {open && <div className={styles.disclosure} data-open={shown || undefined}>
      <LineTabs label={entry.name + t(' 说明', ' details')} active={detail} onSelect={selectTab} tabs={[{ id: 'spec', label: t('规范', 'Specification') }, { id: 'props', label: t('属性', 'Props') }, { id: 'code', label: t('代码', 'Code') }, { id: 'a11y', label: t('无障碍', 'Accessibility') }]} />
      <div className={styles.detailPanel} role="tabpanel" aria-label={entry.name + t(' 说明', ' details')}><div className={styles.detailClip}><div className={styles.detailBody}>
        {panel === 'spec' && <><div className={styles.specGrid}>
          <section><Sub>{t('什么时候用', 'When to use')}</Sub>{markdown(entry.usage)}</section>
          <section><Sub>{t('不要这样用', 'Avoid')}</Sub>{markdown(entry.avoid)}</section>
          <section><Sub>{t('变体', 'Variants')}</Sub>{variants.length ? <ul className={styles.tags}>{variants.map(variant => <li key={variant} data-default={variant === preferred || undefined}>{variant}{variant === preferred && <span className={styles.defaultBadge}>{t('默认', 'Default')}</span>}</li>)}</ul> : <p>—</p>}</section>
          <section><Sub>{t('状态示例', 'State examples')}</Sub><p>{covered.length} / {entry.states.length} {t('个声明状态有独立示例', 'declared states have individual examples')}</p><ul className={styles.tags}>{entry.states.map(state => <li key={state} data-missing={!covered.includes(state) || undefined}>{(covered.includes(state) ? '' : t('待补：', 'Missing: ')) + state}</li>)}</ul></section>
        </div>
        {pair.length > 0 && <section className={styles.pair}><Sub>{t('正确与错误写法', 'Good and bad examples')}</Sub><div className={styles.pairGrid}>{pair.map(({ tone, code }) => <div key={tone} className={styles.codeBlock} data-tone={tone}><header><span className={styles.pairLabel}><i aria-hidden className={styles.pairMark}><Icon name={tone === 'good' ? 'check' : 'close'} size={11} /></i>{tone === 'good' ? t('正确写法', 'Good') : t('错误写法', 'Bad')}</span><IconButton size="xs" aria-label={tone === 'good' ? t('复制正确写法', 'Copy good example') : t('复制错误写法', 'Copy bad example')} disabled={pending} onClick={() => onCopySource(code)}><Icon name="copy" size={14} /></IconButton></header><pre>{code}</pre></div>)}</div></section>}</>}
        {panel === 'props' && <section className={styles.api}>{markdown(entry.api)}</section>}
        {panel === 'code' && <div className={styles.codeBlock}><header><span>{t('当前示例代码', 'Current example source')}</span><IconButton size="xs" aria-label={t('复制示例代码', 'Copy example source')} disabled={pending || !source.html} onClick={() => onCopySource(source.html)}><Icon name="copy" size={14} /></IconButton></header><pre>{source.html}</pre></div>}
        {panel === 'a11y' && <section className={styles.a11y}>{markdown(entry.accessibility)}</section>}
      </div></div></div>
    </div>}
  </article>;
}
function split(value: string) { return Array.from(new Set(value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean))); }
