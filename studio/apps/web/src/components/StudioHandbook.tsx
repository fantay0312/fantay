import { useEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { Button, IconButton } from '../fantay/ui';
import type { DesignSystemRevision, StudioDocument, StudioLibraryEntry, StudioRule, StudioToken, StudioTypeStyle } from '@open-design/contracts';
import {parseStudioTokens,resolveStudioToken,studioContrast} from '@open-design/contracts';
import { renderMarkdown } from '../runtime/markdown';
import { studioMutationMessage } from '../runtime/studio-catalog';
import { StudioCatalog } from './StudioCatalog';
import { StudioDialog } from './StudioDialog';
import type { StudioEntryBundle, StudioResourceReader } from '../runtime/studio-entry-bundle';
export { StudioDialog } from './StudioDialog';
import { Icon } from './Icon';
import { randomUUID } from '../utils/uuid';
import styles from './StudioHandbook.module.css';
import { Select } from './Select';

export type HandbookSection = 'rules' | 'components' | 'blocks' | 'patterns' | 'templates' | 'content' | 'brand' | 'accessibility' | 'implementation' | 'governance' | 'typeStyles';
interface Props {
  section: HandbookSection; document: StudioDocument; onSave: (document: StudioDocument) => Promise<void>;
  editable: boolean; chinese: boolean; css: string; resolveAsset: (path: string) => string;
  history?: DesignSystemRevision[]; onRestore?: (revision: DesignSystemRevision) => Promise<void>; onTemplate?: (entry: StudioLibraryEntry, bundle?:StudioEntryBundle) => Promise<void>;
  scope?:string; busy?:boolean; readResource?:StudioResourceReader;resourceRevision?:number;
  /** Shared chapter search and preview theme, passed through to the catalog sections. */
  query?:string; previewTheme?:string; addRequest?:number; groupRequest?:number;
}
type Form = { kind: 'entry'; value: StudioLibraryEntry } | {kind:'type';value:StudioTypeStyle} | {kind:'text';value:string} | {kind:'settings';value:Record<string,string>} | {kind:'release';value:Record<string,string>} | {kind:'history';value:DesignSystemRevision} | {kind:'rule';value:StudioRule} | {kind:'checks';value:string};
export function StudioHandbook({section, document: doc, onSave, editable, chinese, css, resolveAsset, history=[], onRestore, onTemplate,scope='local',busy=false,readResource,resourceRevision=0,query,previewTheme,addRequest,groupRequest}:Props) {
  const t=(zh:string,en:string)=>chinese?zh:en;
  const [form,setForm]=useState<Form|null>(null);
  const [allHistory,setAllHistory]=useState(false);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const catalog=section==='components'||section==='blocks'||section==='patterns'||section==='templates';
  const tokenDefinitions=parseStudioTokens(css);
  const implementationText=[...doc.components,...doc.blocks,...doc.patterns,...doc.templates].map(entry=>entry.html).join('\n');
  const referenceCount=(implementationText.match(/var\(\s*--[\w-]+/g)??[]).length;
  async function save() {
    if(!form)return;
    setPending(true);setError('');
    try {
      const next={...doc};
      if((form.kind==='entry'||form.kind==='type')&&!form.value.name.trim())throw new Error(t('请填写名称。','Enter a name.'));
      if(form.kind==='entry'&&catalog) next[section]=doc[section].some(item=>item.id===form.value.id)?doc[section].map(item=>item.id===form.value.id?form.value:item):[...doc[section],form.value];
      if(form.kind==='type'){
        if(typeof CSS!=='undefined'&&CSS.supports&&(!CSS.supports('font-size',form.value.size)||!CSS.supports('font-weight',form.value.weight)||!CSS.supports('line-height',form.value.lineHeight)))throw new Error(t('请检查字号、字重和行高。','Check the size, weight and line height.'));
        next.typeStyles=doc.typeStyles.some(item=>item.id===form.value.id)?doc.typeStyles.map(item=>item.id===form.value.id?form.value:item):[...doc.typeStyles,form.value];
      }
      if(form.kind==='rule'){
        // One line each: a rule is one instruction and one reason, and the handbook prints it as one list item.
        const rule={...form.value,rule:form.value.rule.replace(/\s+/g,' ').trim(),reason:form.value.reason.replace(/\s+/g,' ').trim()};
        if(!rule.rule)throw new Error(t('请填写规则。','Enter a rule.'));
        next.rules=doc.rules.some(item=>item.id===rule.id)?doc.rules.map(item=>item.id===rule.id?rule:item):[...doc.rules,rule];
      }
      if(form.kind==='checks')next.reviewChecks=form.value.split('\n').map(line=>line.trim()).filter(Boolean);
      if(form.kind==='text'&&(section==='content'||section==='brand'||section==='accessibility'))next[section]=form.value;
      if(form.kind==='settings'&&section==='implementation')next.implementation=form.value as StudioDocument['implementation'];
      if(form.kind==='settings'&&section==='governance')next.governance=form.value as StudioDocument['governance'];
      if(form.kind==='release'){
        if(!/^\d+\.\d+\.\d+$/.test(form.value.version||''))throw new Error(t('版本号请使用 1.0.0 这样的格式。','Use a semantic version such as 1.0.0.'));
        next.governance={...doc.governance,version:form.value.version!};
        next.releases=[{version:form.value.version!,notes:form.value.notes||'',date:new Date().toISOString()},...doc.releases];
      }
      if(form.kind==='history') { await onRestore?.(form.value); }
      else await onSave(next);
      setForm(null);
    } catch(error) {setError(studioMutationMessage(error,chinese)||t('保存失败，请重试。','Save failed. Try again.'));}
    finally{setPending(false);}
  }
  /** Every dialog opens clean: an error left by an earlier action belongs to that action. */
  function openForm(next:Form){setError('');setForm(next);}
  const rulesRef=useRef<HTMLElement>(null);
  // A delete is undone by adding the rule back, so it skips the confirm step but still goes through the save.
  // Focus moves to the rule that took its place (or the one before, or Add rule), not back to the page top.
  function removeRule(id:string){
    if(pending)return;
    const index=doc.rules.findIndex(rule=>rule.id===id);
    setPending(true);setError('');
    void onSave({...doc,rules:doc.rules.filter(rule=>rule.id!==id)}).then(()=>requestAnimationFrame(()=>{
      const section=rulesRef.current;if(!section)return;
      const deletes=section.querySelectorAll<HTMLElement>('[data-rule-delete]');
      (deletes[Math.min(index,deletes.length-1)]??section.querySelector<HTMLElement>('[data-rule-add]'))?.focus();
    })).catch(error=>setError(studioMutationMessage(error,chinese)||t('删除失败，请重试。','Delete failed. Try again.'))).finally(()=>setPending(false));
  }
  function newEntry():StudioLibraryEntry{return{id:randomUUID(),name:'',description:'',status:'draft',usage:'',avoid:'',accessibility:'',api:'',variants:[],states:['default','hover','focus','disabled','error','loading'],html:''};}
  const add=<Button variant="ghost" size="sm" className={styles.smallButton} onClick={()=>openForm(section==='typeStyles'?{kind:'type',value:{id:randomUUID(),name:'',group:t('界面','Interface'),family:'var(--font-body)',size:'16px',weight:'400',lineHeight:'1.5',letterSpacing:'0',description:''}}:{kind:'entry',value:newEntry()})}><Icon name="plus" size={14}/>{t('添加字阶','Add type style')}</Button>;
  const editText=()=>openForm({kind:'text',value:doc[section as 'content'|'brand'|'accessibility']});
  const input=(label:string,value:string,change:(value:string)=>void,multiline=false)=><label className={styles.field}>{label}{multiline?<textarea value={value} onChange={event=>change(event.target.value)}/>:<input value={value} onChange={event=>change(event.target.value)}/>}</label>;
  if(catalog)return <StudioCatalog section={section} document={doc} onSave={onSave} editable={editable} busy={busy} chinese={chinese} css={css} scope={scope} readResource={readResource??(async path=>{const response=await fetch(resolveAsset(path));if(!response.ok)throw new Error('RESOURCE_NOT_FOUND');return response.blob();})} onReuse={onTemplate} resourceRevision={resourceRevision} query={query} previewTheme={previewTheme} addRequest={addRequest} groupRequest={groupRequest}/>;
  const prose=(text:string)=><div className={styles.prose}>{renderMarkdown(text)}</div>;
  // What acts on the whole section sits in one place in every section: right-aligned under the
  // shell's section header, hanging above the body. Actions on one block stay on that block's heading.
  const sectionTools=(actions:ReactNode)=>editable?<div className={styles.sectionTools}><div>{actions}</div></div>:null;
  // One note repeated under every role says nothing per role, so it is said once under the heading.
  const typeNotes=new Set(doc.typeStyles.map(style=>style.description.trim()));
  const sharedTypeNote=doc.typeStyles.length>1&&typeNotes.size===1?[...typeNotes][0]!:'';
  const contrastThemes=doc.themes.length?doc.themes:[{name:t('浅色','Light'),selector:':root',description:''}];
  const historyShown=history.slice(0,allHistory?30:5),historyTotal=Math.min(history.length,30);
  return <div className={styles.root}>
    {section==='rules'&&<>
      <section className={styles.block} ref={rulesRef}>
        <div className={styles.blockHead}><h3>{t('设计规则','Rules')}</h3>{editable&&<Button variant="ghost" size="sm" className={styles.smallButton} data-rule-add="" onClick={()=>openForm({kind:'rule',value:{id:'rule-'+randomUUID(),rule:'',reason:''}})}><Icon name="plus" size={14}/>{t('添加规则','Add rule')}</Button>}</div>
        {doc.rules.length>0&&<p className={styles.note}>{t('每条规则是一句指令加一句原因；遇到规则没写到的情况，按原因推断。','Each rule is an instruction followed by its reason; use the reason for cases the rules do not name.')}</p>}
        {doc.rules.length?<ul className={styles.rules}>{doc.rules.map(rule=><li key={rule.id} className={styles.rule}>
          <div><p className={styles.ruleText}>{rule.rule}</p>{rule.reason.trim()&&<p className={styles.ruleReason}>{t('原因：','Why: ')}{rule.reason.trim()}</p>}{rule.source==='correction'&&<p className={styles.ruleMeta}><span className={styles.ruleBadge}>{t('来自对话纠正','Learnt from a correction')}</span>{rule.createdAt&&!Number.isNaN(Date.parse(rule.createdAt))&&<time dateTime={rule.createdAt}>{new Date(rule.createdAt).toLocaleDateString(chinese?'zh-CN':'en-US')}</time>}{rule.context&&<span>{t('当时：','Was: ')}{rule.context}</span>}</p>}</div>
          {editable&&<div className={styles.ruleTools}><IconButton size="xs" tooltip={t('编辑规则','Edit rule')} aria-label={t('编辑规则：','Edit rule: ')+rule.rule} onClick={()=>openForm({kind:'rule',value:rule})}><Icon name="edit" size={14}/></IconButton><IconButton size="xs" variant="danger" data-rule-delete="" tooltip={t('删除规则','Delete rule')} aria-label={t('删除规则：','Delete rule: ')+rule.rule} disabled={pending} onClick={()=>removeRule(rule.id)}><Icon name="trash" size={14}/></IconButton></div>}
        </li>)}</ul>:<p className={styles.empty}>{editable?t('还没有规则。规则写成一句指令加一句原因，比如「每个区域只放一个主要操作。都重要，就都不重要。」','No rules yet. Write each as one instruction and its reason, e.g. “Use one primary action per region. If everything is important, nothing is.”'):t('这个设计体系没有写规则。','This design system has no rules.')}</p>}
      </section>
      <section className={styles.block}>
        <div className={styles.blockHead}><h3>{t('界面审查清单','Screen review')}</h3>{editable&&<Button variant="ghost" size="sm" className={styles.smallButton} onClick={()=>openForm({kind:'checks',value:doc.reviewChecks.join('\n')})}>{t('编辑清单','Edit checklist')}</Button>}</div>
        {(editable||doc.reviewChecks.length>0)&&<p className={styles.note}>{t('这是按需读取的技能，不常驻：保存后生成 system/skills/screen-review/SKILL.md，agent 只在构建或修改页面时打开它，对写好的源码逐条检查。','An on-demand skill, not a standing rule: saving writes system/skills/screen-review/SKILL.md, which an agent opens only when it builds or changes a screen, to check the source it wrote.')}</p>}
        {doc.reviewChecks.length?<ol className={styles.reviewChecks}>{doc.reviewChecks.map((check,index)=><li key={index}>{check}</li>)}</ol>:<p className={styles.empty}>{editable?t('还没有审查清单。','No review checklist yet.'):t('这个设计体系没有审查清单。','This design system has no review checklist.')}</p>}
      </section>
    </>}
    {section==='typeStyles'&&<section className={styles.typeBlock}>
      <div className={styles.blockHead}><h3>{t('字阶','Type styles')}</h3>{editable&&add}</div>
      {sharedTypeNote&&<p className={styles.note}>{sharedTypeNote}</p>}
      <div className={styles.typeRows}>{doc.typeStyles.map(style=><TypeRow key={style.id} style={style} tokens={tokenDefinitions} chinese={chinese} showNote={!sharedTypeNote} onEdit={editable?()=>openForm({kind:'type',value:style}):undefined}/>)}</div>
      {!doc.typeStyles.length&&<p className={styles.empty}>{editable?t('添加组合字阶，让字体、字号、字重、行高一起复用。','Add type styles to reuse font, size, weight and line height together.'):t('这个设计体系没有定义组合字阶。','This design system defines no type styles.')}</p>}
    </section>}
    {(section==='content'||section==='brand')&&<>{sectionTools(<Button variant="ghost" size="sm" className={styles.smallButton} onClick={editText}>{t('编辑规范','Edit guidelines')}</Button>)}{doc[section]?prose(doc[section]):<p className={styles.empty}>{t('这里还没有规范。','No guidelines yet.')}</p>}</>}
    {section==='accessibility'&&<>
      <section className={styles.block}>
        <h3>{t('自动对比度检查','Automatic contrast checks')}</h3>
        <p className={styles.note}>{t('仅计算已识别的不透明十六进制颜色组合；其他颜色格式与实际页面仍需人工验收。','Checks recognized opaque hex pairs. Other formats and rendered pages require manual review.')}</p>
        {contrastThemes.map(theme=><div key={theme.selector} className={styles.contrastGroup}>{contrastThemes.length>1&&<h4>{theme.name}</h4>}<div className={styles.contrastGrid}>{CONTRAST_PAIRS.map(([fg,bg])=><ContrastTile key={fg} foreground={fg} background={bg} scope={theme.selector} tokens={tokenDefinitions} chinese={chinese}/>)}</div></div>)}
        <p className={styles.note}>{t('标记按普通文字 AA 的 4.5:1 判定。','Marks use the 4.5:1 AA threshold for normal text.')} <a href="https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html" target="_blank" rel="noreferrer">WCAG 2.2 · Contrast minimum</a></p>
      </section>
      {doc.checklist.length>0&&<ManualChecklist document={doc} editable={editable} chinese={chinese} onSave={onSave} onError={setError}/>}
      {(editable||doc.accessibility)&&<section className={styles.block}>
        <div className={styles.blockHead}><h3>{t('无障碍规范','Accessibility guidelines')}</h3>{editable&&<Button variant="ghost" size="sm" className={styles.smallButton} onClick={editText}>{t('编辑规范','Edit guidelines')}</Button>}</div>
        {doc.accessibility?prose(doc.accessibility):<p className={styles.empty}>{t('这里还没有规范。','No guidelines yet.')}</p>}
      </section>}
    </>}
    {section==='implementation'&&<>
      {sectionTools(<Button variant="ghost" size="sm" className={styles.smallButton} onClick={()=>openForm({kind:'settings',value:{...doc.implementation}})}>{t('编辑来源','Edit sources')}</Button>)}
      <div className={styles.sources}>
        <SourceCard icon="github" label={t('代码仓库','Repository')} value={doc.implementation.repository} empty={t('尚未关联','Not linked')}/>
        <SourceCard icon="artboard" label={t('设计稿 / Figma','Design file / Figma')} value={doc.implementation.designFile} empty={t('尚未关联','Not linked')}/>
        <SourceCard icon="blocks" label={t('组件包','Package')} value={doc.implementation.packageName} empty={t('尚未关联','Not linked')}/>
      </div>
      {doc.implementation.notes&&prose(doc.implementation.notes)}
      <p className={styles.note}>{t('链接用于记录来源；只有完成对应连接器授权后，才能读取远端内容。','Links record provenance. Remote content requires authorization through its connector.')}</p>
    </>}
    {section==='governance'&&<>
      {sectionTools(<><Button variant="ghost" size="sm" className={styles.smallButton} onClick={()=>openForm({kind:'settings',value:{...doc.governance}})}>{t('维护规则','Maintenance rules')}</Button><Button variant="ghost" size="sm" className={styles.smallButton} onClick={()=>openForm({kind:'release',value:{version:doc.governance.version,notes:''}})}>{t('记录新版本','Record version')}</Button></>)}
      <dl className={styles.stats}>
        <div className={styles.stat}><dt>{t('当前版本','Version')}</dt><dd>{doc.governance.version}</dd></div>
        <div className={styles.stat} data-kind="text"><dt>{t('维护者','Maintainers')}</dt><dd>{doc.governance.owners||'—'}</dd></div>
        <div className={styles.stat}><dt>{t('变量定义','Token declarations')}</dt><dd>{tokenDefinitions.length}</dd></div>
        <div className={styles.stat}><dt>{t('组件、区块、模式和模板中的变量引用','References in components, blocks, patterns and templates')}</dt><dd>{referenceCount}</dd></div>
      </dl>
      <p className={styles.note}>{t('这是设计体系内的静态统计；编辑权限沿用工作区权限，维护者信息只记录责任人。','These are static package counts. Editing follows workspace permissions; maintainer names record responsibility.')}</p>
      <div className={styles.columns}><section><h3>{t('如何贡献','Contributing')}</h3>{prose(doc.governance.contribution||'—')}</section><section><h3>{t('弃用与迁移','Deprecation')}</h3>{prose(doc.governance.deprecation||'—')}</section></div>
      <section className={styles.block}>
        <h3>{t('更新日志','Changelog')}</h3>
        {doc.releases.length?<ol className={styles.timeline}>{doc.releases.map((release,index)=><li key={index}><div className={styles.timelineHead}><strong>{release.version}</strong><time>{release.date.slice(0,10)}</time></div>{prose(release.notes)}</li>)}</ol>:<p className={styles.empty}>{t('还没有记录版本。','No versions recorded yet.')}</p>}
      </section>
      <section className={styles.block}>
        <h3>{t('源文件修改历史','Source edit history')}</h3>
        {history.length?historyShown.map(revision=><button type="button" className={styles.history} key={revision.id} onClick={()=>openForm({kind:'history',value:revision})}><Icon name="history" size={15}/><span>{revision.sectionTitle||revision.feedback}</span><time>{new Date(revision.createdAt).toLocaleString()}</time><span>{t('比较 / 恢复','Compare / restore')}</span></button>):<p className={styles.empty}>{t('之后的源文件修改会记录在这里。','Future source edits will appear here.')}</p>}
        {!allHistory&&history.length>5&&<Button variant="ghost" size="sm" className={styles.smallButton+' '+styles.historyMore} onClick={()=>setAllHistory(true)}>{t('查看全部 '+historyTotal+' 条','Show all '+historyTotal)}</Button>}
      </section>
    </>}
    {error&&!form&&<p role="alert" className={styles.error}>{error}</p>}
    {form&&<StudioDialog title={form.kind==='history'?t('比较历史版本','Compare version'):form.kind==='rule'?(doc.rules.some(rule=>rule.id===form.value.id)?t('编辑规则','Edit rule'):t('添加规则','Add rule')):form.kind==='checks'?t('编辑界面审查清单','Edit screen review'):t('编辑设计规范','Edit specification')}pending={pending} onClose={()=>{if(!pending){setForm(null);setError('');}}}>{dismiss=><div className={styles.form}>
      {form.kind==='entry'&&<>{input(t('名称','Name'),form.value.name,value=>setForm({...form,value:{...form.value,name:value}}))}{input(t('一句话说明','Summary'),form.value.description,value=>setForm({...form,value:{...form.value,description:value}}))}<label>{t('状态','Status')}<Select value={form.value.status} onChange={event=>setForm({...form,value:{...form.value,status:event.target.value as StudioLibraryEntry['status']}})}><option value="draft">{t('草稿','Draft')}</option><option value="stable">{t('稳定','Stable')}</option><option value="deprecated">{t('已弃用','Deprecated')}</option></Select></label>{input(t('变体（逗号分隔）','Variants (comma-separated)'),form.value.variants.join(', '),value=>setForm({...form,value:{...form.value,variants:value.split(',').map(item=>item.trim()).filter(Boolean)}}))}{input(t('状态（逗号分隔）','States (comma-separated)'),form.value.states.join(', '),value=>setForm({...form,value:{...form.value,states:value.split(',').map(item=>item.trim()).filter(Boolean)}}))}{(['usage','avoid','accessibility','api','html'] as const).map(key=> <div key={key}>{input(({usage:t('什么时候用','When to use'),avoid:t('不要这样用','Avoid'),accessibility:t('无障碍要求','Accessibility'),api:t('属性 API（支持 Markdown）','Props API (Markdown)'),html:t('HTML 实现（可引用设计变量）','HTML source (may reference tokens)')})[key],form.value[key],value=>setForm({...form,value:{...form.value,[key]:value}}),true)}</div>)}</>}
      {form.kind==='type'&&(['name','group','family','size','weight','lineHeight','letterSpacing','description'] as const).map(key=><div key={key}>{input(({name:t('名称','Name'),group:t('分组','Group'),family:t('字体 / 变量引用','Font / token'),size:t('字号','Size'),weight:t('字重','Weight'),lineHeight:t('行高','Line height'),letterSpacing:t('字距','Letter spacing'),description:t('使用说明','Usage')})[key],form.value[key],value=>setForm({...form,value:{...form.value,[key]:value}}))}</div>)}
      {form.kind==='text'&&input('Markdown',form.value,value=>setForm({...form,value}),true)}
      {form.kind==='rule'&&<>{input(t('规则（一句话指令）','Rule (one instruction)'),form.value.rule,value=>setForm({...form,value:{...form.value,rule:value}}))}{input(t('原因（一句话）','Reason (one sentence)'),form.value.reason,value=>setForm({...form,value:{...form.value,reason:value}}))}</>}
      {form.kind==='checks'&&input(t('每行一条检查','One check per line'),form.value,value=>setForm({...form,value}),true)}
      {(form.kind==='settings'||form.kind==='release')&&Object.entries(form.value).map(([key,value])=><div key={key}>{input(({version:t('版本号','Version'),owners:t('维护者','Maintainers'),contribution:t('贡献流程','Contribution process'),deprecation:t('弃用流程','Deprecation policy'),repository:t('代码仓库 URL','Repository URL'),designFile:t('设计稿 URL','Design URL'),packageName:t('组件包名称','Package name'),notes:t('说明 / 变更记录','Notes / changes')})[key as 'notes']||key,value,next=>setForm({...form,value:{...form.value,[key]:next}}),['notes','contribution','deprecation'].includes(key))}</div>)}
      {form.kind==='history'&&<><p>{form.value.feedback}</p>{form.value.fileChanges?.map(change=><div key={change.path}><h4>{change.path}</h4><div className={styles.diff}><div><h4>{t('修改前','Before')}</h4><pre>{change.baseContent}</pre></div><div><h4>{t('此版本','This version')}</h4><pre>{change.proposedContent}</pre></div></div></div>)}</>}
      {error&&<p role="alert" className={styles.error}>{error}</p>}
      <footer><Button variant="ghost" size="sm" disabled={pending} onClick={dismiss}>{t('取消','Cancel')}</Button>{editable&&<Button variant="primary" size="sm" disabled={pending} onClick={()=>void save()}>{pending?t('正在保存…','Saving…'):form.kind==='history'?t('恢复此版本','Restore this version'):t('保存规范','Save specification')}</Button>}</footer>
    </div>}</StudioDialog>}
  </div>;
}

const CONTRAST_PAIRS=[['--fg','--bg'],['--muted','--bg'],['--accent-on','--accent']] as const;

/** Type styles may point at tokens. They are resolved here because a design system's names must never reach the app's own cascade. */
function resolveTokens(value:string,tokens:StudioToken[]):string{
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,(_match,name:string,fallback?:string)=>resolveStudioToken(name,tokens)??fallback?.trim()??'');
}

/** Pixels for a resolved size, so a display style can pick a sample short enough to fit. */
function sizeInPx(value:string):number{
  const match=value.trim().match(/^(-?[\d.]+)(px|rem|em)?$/i);
  if(!match)return 0;
  return Number(match[1])*(match[2]&&match[2].toLowerCase()!=='px'?16:1);
}

function TypeRow({style,tokens,chinese,showNote,onEdit}:{style:StudioTypeStyle;tokens:StudioToken[];chinese:boolean;showNote:boolean;onEdit?:()=>void}){
  const t=(zh:string,en:string)=>chinese?zh:en;
  const size=resolveTokens(style.size,tokens);
  const display=sizeInPx(size)>=32;
  const specimen:CSSProperties={fontFamily:resolveTokens(style.family,tokens),fontSize:size,fontWeight:resolveTokens(style.weight,tokens) as CSSProperties['fontWeight'],lineHeight:resolveTokens(style.lineHeight,tokens),letterSpacing:resolveTokens(style.letterSpacing,tokens)};
  return <div className={styles.typeRow}>
    <div className={styles.typeHead}>
      <strong>{style.name}</strong><small>{style.group}</small>
      <code>{style.size} / {style.lineHeight} · {style.weight}{style.letterSpacing&&style.letterSpacing!=='0'?' · '+style.letterSpacing:''} · {style.family}</code>
      {onEdit&&<IconButton size="xs" aria-label={t('编辑 ','Edit ')+style.name} onClick={onEdit}><Icon name="edit" size={14}/></IconButton>}
    </div>
    <p className={styles.typeSpecimen} style={specimen}>{display?'文字之间 Aa':t('The quick brown fox · 文字之间，自有秩序。','The quick brown fox jumps over the lazy dog.')}</p>
    {showNote&&style.description&&<p className={styles.typeNote}>{style.description}</p>}
  </div>;
}

function ContrastTile({foreground,background,scope,tokens,chinese}:{foreground:string;background:string;scope:string;tokens:StudioToken[];chinese:boolean}){
  const t=(zh:string,en:string)=>chinese?zh:en;
  const fg=resolveStudioToken(foreground,tokens,scope),bg=resolveStudioToken(background,tokens,scope);
  const ratio=fg&&bg?studioContrast(fg,bg):null;
  const verdict=!fg||!bg?'undefined':ratio===null?'manual':ratio>=4.5?'pass':'fail';
  return <div className={styles.contrastTile}>
    <div className={styles.contrastSample} data-undefined={!fg||!bg||undefined} style={fg&&bg?{background:bg,color:fg}:undefined} aria-hidden><span>Aa</span><small>{t('正文示例','Body text')}</small></div>
    <div className={styles.contrastFacts}>
      <div><strong>{ratio===null?'—':ratio.toFixed(2)+':1'}</strong><span className={styles.badge} data-verdict={verdict}><Icon name={verdict==='pass'?'check':verdict==='fail'?'alert-triangle':verdict==='undefined'?'minus':'eye'} size={12}/>{verdict==='pass'?'AA':verdict==='fail'?t('需调整','Adjust'):verdict==='undefined'?t('未定义','Undefined'):t('需人工','Manual')}</span></div>
      <code>{foreground} / {background}</code>
    </div>
  </div>;
}

function ManualChecklist({document:doc,editable,chinese,onSave,onError}:{document:StudioDocument;editable:boolean;chinese:boolean;onSave:(document:StudioDocument)=>Promise<void>;onError:(message:string)=>void}){
  const t=(zh:string,en:string)=>chinese?zh:en;
  const [saving,setSaving]=useState(false);
  // The save round trip is slow enough to read as lag, so the tick lands first and rolls back on failure.
  const [optimistic,setOptimistic]=useState<Record<string,boolean>>({});
  useEffect(()=>setOptimistic({}),[doc.checklist]);
  const isChecked=(item:StudioDocument['checklist'][number])=>optimistic[item.id]??item.checked;
  const done=doc.checklist.filter(isChecked).length,total=doc.checklist.length;
  function toggle(id:string,checked:boolean){
    if(saving)return;
    onError('');
    setSaving(true);setOptimistic({[id]:checked});
    void onSave({...doc,checklist:doc.checklist.map(check=>check.id===id?{...check,checked}:check)}).catch(error=>{setOptimistic({});onError(studioMutationMessage(error,chinese));}).finally(()=>setSaving(false));
  }
  return <section className={styles.block}>
    <div className={styles.blockHead}><h3>{t('人工验收清单','Manual review checklist')}</h3><span className={styles.progress}>{done} / {total} {t('已确认','confirmed')}</span></div>
    <div className={styles.progressBar} aria-hidden><i style={{transform:'scaleX('+(total?done/total:0)+')'}}/></div>
    <p className={styles.note}>{t('勾选仅表示你已确认，不代表自动通过无障碍标准。','Check only after manual verification; this is not an automatic accessibility certification.')}</p>
    <div className={styles.checks}>{doc.checklist.map(item=><label key={item.id} className={styles.check}><input type="checkbox" checked={isChecked(item)} disabled={!editable} onChange={event=>toggle(item.id,event.target.checked)}/><span className={styles.checkBox} aria-hidden><svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M3.5 8.5 6.5 11.5 12.5 4.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span>{item.label}</span></label>)}</div>
  </section>;
}

function SourceCard({icon,label,value,empty}:{icon:ComponentProps<typeof Icon>['name'];label:string;value:string;empty:string}){
  const link=/^https?:\/\//i.test(value);
  const body=<><span className={styles.sourceTop}><Icon name={icon} size={18}/>{link&&<Icon name="external-link" size={14}/>}</span><span className={styles.sourceLabel}>{label}</span><span className={styles.sourceValue} data-empty={!value||undefined}>{link?value.replace(/^https?:\/\/(www\.)?/i,'').replace(/\/$/,''):value||empty}</span></>;
  return link?<a className={styles.source} href={value} target="_blank" rel="noreferrer">{body}</a>:<div className={styles.source}>{body}</div>;
}
