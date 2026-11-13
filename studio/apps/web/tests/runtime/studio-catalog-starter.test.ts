import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeFoundationCss, completeSizingCss, isStudioStarterDocument, starterStudioDocument, legacyStarterStudioDocument, STUDIO_STARTER_VERSION, upgradeStudioStarterCatalog } from '../../src/runtime/studio-starter';
import { emptyStudioDocument, parseStudioDocument, parseStudioTokens, studioHandbookMarkdown } from '@open-design/contracts';

const windows: JSDOM[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); vi.useRealTimers(); });
function open(html: string, saved: Record<string,string> = {}) {
  const errors: string[] = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(String(error)));
  const dom = new JSDOM(html, { url: 'https://demo.test/entry.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console, beforeParse(window) {
    for (const [key,value] of Object.entries(saved)) window.localStorage.setItem(key,value);
    window.HTMLDialogElement.prototype.showModal = function() { this.open=true; };
    window.HTMLDialogElement.prototype.close = function() { this.open=false; this.dispatchEvent(new window.Event('close')); };
    window.fetch = fetch as never;
  } }); windows.push(dom); return { dom, doc:dom.window.document, errors };
}
const catalog = starterStudioDocument();
function html(name:string) { return [...catalog.components,...catalog.patterns,...catalog.templates].find(entry=>entry.name===name)!.html; }
function storage(dom:JSDOM) { return Object.fromEntries(Object.keys(dom.window.localStorage).map(key=>[key,dom.window.localStorage.getItem(key)!])); }

describe('runnable starter catalog',()=>{
  it('all declared states and variants have executable examples and valid data',()=>{
    expect(parseStudioDocument(JSON.stringify(catalog)).catalogVersion).toBe(STUDIO_STARTER_VERSION);
    for(const entry of [...catalog.components,...catalog.patterns,...catalog.templates]){
      for(const state of entry.states) expect(entry.examples?.some(example=>example.kind==='state'&&example.value===state)).toBe(true);
      for(const variant of entry.variants) expect(entry.examples?.some(example=>example.kind==='variant'&&example.value===variant)).toBe(true);
      for(const source of [entry.html,...(entry.examples??[]).map(example=>example.html)]){const view=open(source);expect(view.errors,entry.name).toEqual([]);view.dom.window.close();}
    }
  });
  it('settings validates, saves, reloads, and cancels without overwriting saved data',async()=>{
    const first=open(html('Settings'));const name=first.doc.querySelector<HTMLInputElement>('[name=name]')!;
    name.value='';first.doc.querySelector('form')!.dispatchEvent(new first.dom.window.Event('submit',{cancelable:true}));expect(name.getAttribute('aria-invalid')).toBe('true');
    name.value='新工作室';first.doc.querySelector('form')!.dispatchEvent(new first.dom.window.Event('submit',{cancelable:true}));await vi.advanceTimersByTimeAsync(200);expect(first.doc.querySelector('[data-status]')?.textContent).toContain('已保存');
    const second=open(html('Settings'),storage(first.dom));expect(second.doc.querySelector<HTMLInputElement>('[name=name]')!.value).toBe('新工作室');
    second.doc.querySelector<HTMLInputElement>('[name=name]')!.value='不要保存';second.doc.querySelector<HTMLButtonElement>('[data-cancel]')!.click();expect(second.doc.querySelector<HTMLInputElement>('[name=name]')!.value).toBe('新工作室');
  });
  it('project list creates real rows and filtering never creates a hidden project',()=>{
    const view=open(html('Project list'));expect(view.doc.querySelectorAll('tbody tr')).toHaveLength(2);
    const query=view.doc.querySelector<HTMLInputElement>('[data-search]')!;query.value='';query.dispatchEvent(new view.dom.window.Event('input'));expect(view.doc.querySelectorAll('tbody tr')).toHaveLength(2);
    view.doc.querySelector<HTMLButtonElement>('[data-new]')!.click();view.doc.querySelector<HTMLInputElement>('[name=title]')!.value='新建测试';view.doc.querySelector('dialog form')!.dispatchEvent(new view.dom.window.Event('submit',{cancelable:true}));expect(view.doc.querySelectorAll('tbody tr')).toHaveLength(3);
    const restored=open(html('Project list'),storage(view.dom));expect(restored.doc.querySelectorAll('tbody tr')).toHaveLength(3);
  });
  it('project details support cancel, save and reload',()=>{
    const view=open(html('Project detail'));expect(view.doc.querySelector<HTMLElement>('[data-form]')!.hidden).toBe(true);
    view.doc.querySelector<HTMLButtonElement>('[data-edit]')!.click();view.doc.querySelector<HTMLInputElement>('[name=title]')!.value='详情已修改';view.doc.querySelector('form')!.dispatchEvent(new view.dom.window.Event('submit',{cancelable:true}));
    expect(open(html('Project detail'),storage(view.dom)).doc.querySelector('[data-title]')!.textContent).toBe('详情已修改');
  });
  it('tabs support keyboard selection and associated panels',()=>{
    const view=open(html('Tabs'));const tabs=view.doc.querySelectorAll<HTMLButtonElement>('[role=tab]');tabs[0]!.dispatchEvent(new view.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');expect(view.doc.getElementById(tabs[1]!.getAttribute('aria-controls')!)!.hidden).toBe(false);expect(view.doc.activeElement).toBe(tabs[1]);
  });
  it('button, field, select, checkbox and card examples execute their advertised actions',()=>{
    const b=open(html('Button'));b.doc.querySelector<HTMLButtonElement>('[data-action=save]')!.click();expect(b.doc.querySelector('[data-status]')!.textContent).toContain('1');b.doc.querySelector<HTMLButtonElement>('[data-action=clear]')!.click();expect(b.doc.querySelector('[data-status]')!.textContent).toContain('清除');
    const f=open(html('TextField'));const field=f.doc.querySelector<HTMLInputElement>('[data-input]')!;field.value='a';field.dispatchEvent(new f.dom.window.Event('blur'));expect(field.getAttribute('aria-invalid')).toBe('true');field.value='valid';field.dispatchEvent(new f.dom.window.Event('input'));field.dispatchEvent(new f.dom.window.Event('blur'));expect(field.getAttribute('aria-invalid')).toBe('false');
    const s=open(html('Select'));const select=s.doc.querySelector<HTMLSelectElement>('select')!;select.value='en';select.dispatchEvent(new s.dom.window.Event('change'));expect(open(html('Select'),storage(s.dom)).doc.querySelector<HTMLSelectElement>('select')!.value).toBe('en');
    const c=open(html('Checkbox'));const all=c.doc.querySelector<HTMLInputElement>('[data-all]')!;expect(all.indeterminate).toBe(true);all.click();expect(c.doc.querySelectorAll('[data-child]:checked')).toHaveLength(2);
    const card=open(html('Card'));card.doc.querySelector<HTMLButtonElement>('[data-detail]')!.click();expect(card.doc.querySelector<HTMLElement>('[data-details]')!.hidden).toBe(false);card.doc.querySelector<HTMLButtonElement>('[data-favorite]')!.click();expect(open(html('Card'),storage(card.dom)).doc.querySelector('[data-favorite]')!.getAttribute('aria-pressed')).toBe('true');
  });
  it('dialog distinguishes cancel and save, restores focus, and toast undo restores data',async()=>{
    const d=open(html('Dialog'));const trigger=d.doc.querySelector<HTMLButtonElement>('[data-open]')!;trigger.click();const input=d.doc.querySelector<HTMLInputElement>('[data-name]')!;input.value='Canceled';d.doc.querySelector<HTMLButtonElement>('[data-cancel]')!.click();expect(Object.keys(storage(d.dom))).toHaveLength(0);trigger.click();input.value='Saved';d.doc.querySelector<HTMLButtonElement>('[data-save]')!.click();expect(d.doc.querySelector<HTMLButtonElement>('[data-cancel]')!.disabled).toBe(true);await vi.advanceTimersByTimeAsync(200);expect(d.doc.querySelector('dialog')!.open).toBe(false);expect(d.doc.activeElement).toBe(trigger);trigger.click();expect(input.value).toBe('Saved');
    const toast=open(html('Toast'));toast.doc.querySelector<HTMLButtonElement>('[data-save]')!.click();expect(toast.doc.querySelector('[data-message]')!.textContent).toContain('已保存');toast.doc.querySelector<HTMLButtonElement>('[data-undo]')!.click();expect(toast.doc.querySelector<HTMLInputElement>('[data-draft]')!.value).toBe('');
  });
  it('empty, search and recovery patterns perform real local operations',async()=>{
    const e=open(html('Empty state'));e.doc.querySelector<HTMLInputElement>('input')!.value='真实条目';e.doc.querySelector('form')!.dispatchEvent(new e.dom.window.Event('submit',{cancelable:true}));expect(open(html('Empty state'),storage(e.dom)).doc.querySelector('[data-list]')!.textContent).toContain('真实条目');
    const s=open(html('Search'));await vi.advanceTimersByTimeAsync(110);expect(s.doc.querySelectorAll('[data-results] li')).toHaveLength(5);const query=s.doc.querySelector<HTMLInputElement>('[data-query]')!;query.value='作品';query.dispatchEvent(new s.dom.window.Event('input'));await vi.advanceTimersByTimeAsync(110);expect(s.doc.querySelectorAll('[data-results] li')).toHaveLength(1);
    const r=open(html('Error recovery'));await vi.waitFor(()=>expect(r.doc.querySelector('[data-title]')!.textContent).toContain('无法解析'));const original=r.doc.querySelector<HTMLTextAreaElement>('[data-draft]')!.value;r.doc.querySelector<HTMLButtonElement>('[data-retry]')!.click();await vi.waitFor(()=>expect(r.doc.querySelector('[data-title]')!.textContent).toContain('内容已恢复'));expect(r.doc.querySelector<HTMLTextAreaElement>('[data-draft]')!.value).toBe(original);
  });
  it('ships rules with reasons, a screen review, and a contract only where a component has a real choice of variant',()=>{
    expect(catalog.rules.length).toBeGreaterThan(5);
    for(const rule of catalog.rules){expect(rule.id).toMatch(/^[a-z0-9-]+$/);expect(rule.rule.trim()).not.toBe('');expect(rule.reason.trim()).not.toBe('');}
    expect(catalog.reviewChecks.length).toBeGreaterThanOrEqual(3);
    for(const entry of catalog.components){
      expect(entry.good?.trim(),entry.name).toBeTruthy();expect(entry.bad?.trim(),entry.name).toBeTruthy();
      if(entry.defaultVariant!==undefined){expect(entry.variants).toContain(entry.defaultVariant);expect(entry.variants.length).toBeGreaterThan(1);}
    }
    expect(catalog.components.find(entry=>entry.id==='button')!.defaultVariant).toBe('secondary');
    const text=studioHandbookMarkdown(catalog);expect(text).toContain('## Rules');expect(text).toContain('Why:');expect(text).toContain('## Screen review');
  });
  it('adds only the sizing tokens a system lacks, filed under sizing and measure',()=>{
    const css=':root { --target-min: 32px; }';const next=completeSizingCss(css);
    expect(next.startsWith(css)).toBe(true);expect(next.match(/--target-min/g)).toHaveLength(1);
    const groups=Object.fromEntries(parseStudioTokens(next).map(token=>[token.name,token.group]));
    expect(groups['--icon-size-md']).toBe('sizing');expect(groups['--aspect-video']).toBe('sizing');expect(groups['--measure-cjk']).toBe('measure');
    expect(completeSizingCss(next)).toBe(next);
    expect(parseStudioTokens(completeFoundationCss('')).some(token=>token.name==='--control-height-md')).toBe(true);
    // Every starter token lands in a named section, so a new system has no catch-all Other section.
    expect(parseStudioTokens(completeFoundationCss('')).filter(token=>token.group==='other').map(token=>token.name)).toEqual([]);
    // A name declared in any scope counts: an appended :root rule would override the author's value.
    for(const css of [':root, :host { --control-height-md: 36px; }','@layer tokens { :root { --target-min: 32px; } }','@media (pointer: coarse) { :root { --target-comfort: 48px; } }','html { --icon-size-sm: 18px; }']){
      const name=/--[\w-]+/.exec(css)![0];expect(completeSizingCss(css).match(new RegExp(name+':','g'))).toHaveLength(1);
    }
  });
  it('upgrades an older system to the current guidance without overwriting what the author wrote',()=>{
    const v1=legacyStarterStudioDocument() as unknown as Record<string,unknown>;
    const old=JSON.parse(JSON.stringify(v1));delete old.rules;delete old.reviewChecks;delete old.catalogVersion;
    for(const entry of old.components){delete entry.defaultVariant;delete entry.good;delete entry.bad;}
    old.components[1].usage='我的输入框规则';
    old.content='## 语气与称呼\n用「你」，语气平实、具体。优先短句，直接说明动作和结果。\n\n## 按钮与提示\n按钮用动词开头，例如「保存草稿」「创建项目」。错误提示说明问题和恢复方法，例如「暂时无法保存，你的编辑仍保留，请重试」。\n\n## 中英混排\n中文与英文、数字之间保留适当空格。英文采用 sentence case。标点遵循当前语言。\n\n## 术语表\n| 术语 | 统一用法 |\n|---|---|\n| Draft | 草稿 |\n| Publish | 发布 |\n| Workspace | 工作区 |\n| Design system | 设计体系 |';
    old.brand='我自己写的品牌规范';
    const upgraded=upgradeStudioStarterCatalog(parseStudioDocument(JSON.stringify(old)));
    expect(upgraded.catalogVersion).toBe(STUDIO_STARTER_VERSION);
    expect(upgraded.rules.length).toBeGreaterThan(0);expect(upgraded.reviewChecks.length).toBeGreaterThan(0);
    expect(upgraded.components[0]!.good).toBeTruthy();expect(upgraded.components[1]!.good).toBeUndefined();
    expect(upgraded.content).toContain('## 错误提示');expect(upgraded.brand).toBe('我自己写的品牌规范');
    expect(upgraded.tokenNotes['--target-min']?.group).toContain('Sizing');
    const authored={...upgraded,rules:[{id:'mine',rule:'我的规则',reason:''}],catalogVersion:2};
    expect(upgradeStudioStarterCatalog(authored).rules).toEqual([{id:'mine',rule:'我的规则',reason:''}]);
  });
  it('offers the upgrade only to a system the starter made, and adds a default variant only if the entry has it',()=>{
    expect(isStudioStarterDocument(starterStudioDocument())).toBe(true);
    const v1=JSON.parse(JSON.stringify(legacyStarterStudioDocument()));delete v1.catalogVersion;
    expect(isStudioStarterDocument(parseStudioDocument(JSON.stringify(v1)))).toBe(true);
    const agent=emptyStudioDocument();agent.components=[{id:'hero',name:'Hero',description:'',status:'stable',usage:'Open a landing page.',avoid:'',accessibility:'',api:'',variants:[],states:['default'],html:'<section>Hero</section>'}];
    expect(isStudioStarterDocument(agent)).toBe(false);
    const v2=starterStudioDocument();v2.catalogVersion=2;
    for(const entry of v2.components){delete entry.defaultVariant;delete entry.good;delete entry.bad;}
    v2.components[0]!.variants=['primary','danger'];
    for(const name of Object.keys(v2.tokenNotes))if(/^--(target|measure|icon|control|aspect)-/.test(name))delete v2.tokenNotes[name];
    const upgraded=upgradeStudioStarterCatalog(v2,new Set(['--target-min']));
    expect(upgraded.components[0]!.defaultVariant).toBeUndefined();expect(upgraded.components[0]!.good).toBeTruthy();
    // Notes only for tokens the system declares after the upgrade.
    expect(Object.keys(upgraded.tokenNotes).filter(name=>/^--(target|measure|icon|control|aspect)-/.test(name))).toEqual(['--target-min']);
  });
  it('groups the starter components by job, listing only the groups that hold something, and upgrades a v3 system to them',()=>{
    expect(catalog.groups.components).toEqual(['操作','输入','浮层','导航','布局','反馈']);
    expect(Object.fromEntries(catalog.components.map(entry=>[entry.id,entry.group]))).toMatchObject({button:'操作',textfield:'输入',dialog:'浮层',toast:'反馈'});
    const strip=(doc:ReturnType<typeof starterStudioDocument>)=>{doc.catalogVersion=3;doc.groups={};doc.components=doc.components.map(entry=>{const {group:_group,...rest}=entry;return rest;});return doc;};
    // A v3 system with no grouping yet gets the starter's job groups, in job order.
    const fresh=upgradeStudioStarterCatalog(strip(starterStudioDocument()));
    expect(fresh.components.find(entry=>entry.id==='button')!.group).toBe('操作');
    expect(fresh.groups.components).toEqual(['操作','输入','浮层','导航','布局','反馈']);
    // Once the author has grouped anything, grouping is theirs: nothing is moved or added.
    const mine=strip(starterStudioDocument());mine.components=mine.components.map(entry=>entry.id==='card'?{...entry,group:'我的分组'}:entry);
    const kept=upgradeStudioStarterCatalog(mine);
    expect(kept.components.find(entry=>entry.id==='button')!.group).toBeUndefined();
    expect(kept.components.find(entry=>entry.id==='card')!.group).toBe('我的分组');
    expect(kept.groups.components ?? []).toEqual([]);
  });
  it('upgrades unchanged examples while preserving user-authored implementations and fields',()=>{
    const current=legacyStarterStudioDocument();current.components[0]!.usage='我的使用要求';current.components[1]!.html='<button>用户自写</button>';
    const upgraded=upgradeStudioStarterCatalog(current);expect(upgraded.components[0]!.usage).toBe('我的使用要求');expect(upgraded.components[0]!.examples!.length).toBeGreaterThan(0);expect(upgraded.components[1]!.html).toBe('<button>用户自写</button>');
  });
});
