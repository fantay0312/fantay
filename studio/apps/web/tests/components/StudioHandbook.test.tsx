// @vitest-environment jsdom
import {render,screen,fireEvent,waitFor,cleanup,within} from '@testing-library/react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {StudioHandbook} from '../../src/components/StudioHandbook';
import {starterStudioDocument} from '../../src/runtime/studio-starter';
import {studioTemplateDocument} from '../../src/runtime/design-system-studio';
import type {StudioDocument} from '@open-design/contracts';
// The catalogue has its own suite; here it only has to receive the section it is routed.
vi.mock('../../src/components/StudioCatalog',()=>({StudioCatalog:({section,document}:{section:'components'|'blocks'|'patterns'|'templates';document:StudioDocument})=><div data-testid="studio-catalog" data-section={section}>{document[section].map(entry=>entry.name).join(', ')}</div>}));
afterEach(cleanup);
const ruleDoc=():StudioDocument=>({...starterStudioDocument(),rules:[{id:'rule-one',rule:'Use one primary action per screen.',reason:'If everything is important, nothing is.'},{id:'rule-two',rule:'Keep labels short.',reason:''}],reviewChecks:['Every action has a visible label.','Focus order follows reading order.']});
describe('five-layer handbook',()=>{
  it('materializes templates as complete HTML documents for project previews',()=>{
    const html=studioTemplateDocument('<style>body{color:red}</style><h2>Settings</h2><form><input></form>','Settings');
    expect(html.startsWith('<!doctype html>')).toBe(true);expect(html).toContain('<body>');expect(html).toContain('href="tokens.css"');expect(html).toContain('<h2>Settings</h2>');
  });
  it('edits and persists content guidelines through a structured form',async()=>{
    const save=vi.fn(async()=>{});render(<StudioHandbook section="content" document={starterStudioDocument()} onSave={save} editable chinese={false} css="" resolveAsset={path=>path}/>);
    fireEvent.click(screen.getByRole('button',{name:'Edit guidelines'}));const dialog=screen.getByRole('dialog');fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'## Voice\nBe specific.'}});fireEvent.click(within(dialog).getByRole('button',{name:'Save specification'}));await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({content:'## Voice\nBe specific.'})));
  });
  it('ships documented starters and leaves manual accessibility review unchecked',()=>{
    const doc=starterStudioDocument();expect(doc.components).toHaveLength(8);expect(doc.patterns.length).toBeGreaterThanOrEqual(2);expect(doc.templates).toHaveLength(3);expect(doc.checklist.every(item=>!item.checked)).toBe(true);expect(doc.components.every(item=>item.avoid&&item.api&&item.states.length)).toBe(true);
  });
  it('states each contrast verdict in words and counts confirmed checks',()=>{
    const doc=starterStudioDocument();doc.themes=[];doc.checklist=doc.checklist.map((item,index)=>({...item,checked:index<3}));render(<StudioHandbook section="accessibility" document={doc} onSave={vi.fn()} editable={false} chinese={false} css=":root{--fg:#111111;--bg:#ffffff;--muted:#cccccc;--accent:oklch(0.5 0.1 200);--accent-on:#ffffff}" resolveAsset={path=>path}/>);
    expect(screen.getByText('AA')).toBeInTheDocument();expect(screen.getByText('Adjust')).toBeInTheDocument();expect(screen.getByText('Manual')).toBeInTheDocument();expect(screen.getByText('3 / '+doc.checklist.length+' confirmed')).toBeInTheDocument();
  });
  it('puts section actions in one row ahead of the body and keeps block actions on their block heading',()=>{
    const doc=starterStudioDocument();
    const sectionRow=(name:string)=>{const button=screen.getByRole('button',{name});const row=button.closest('div')!.parentElement!;expect(row.parentElement!.firstElementChild).toBe(row);return row;};
    const view=render(<StudioHandbook section="content" document={doc} onSave={vi.fn()} editable chinese={false} css="" resolveAsset={path=>path}/>);
    sectionRow('Edit guidelines');
    view.rerender(<StudioHandbook section="implementation" document={doc} onSave={vi.fn()} editable chinese={false} css="" resolveAsset={path=>path}/>);
    sectionRow('Edit sources');
    view.rerender(<StudioHandbook section="governance" document={doc} onSave={vi.fn()} editable chinese={false} css="" resolveAsset={path=>path}/>);
    expect(sectionRow('Maintenance rules')).toBe(sectionRow('Record version'));
    view.rerender(<StudioHandbook section="accessibility" document={doc} onSave={vi.fn()} editable chinese={false} css="" resolveAsset={path=>path}/>);
    expect(screen.getByRole('button',{name:'Edit guidelines'}).parentElement).toContainElement(screen.getByRole('heading',{name:'Accessibility guidelines'}));
    view.rerender(<StudioHandbook section="governance" document={doc} onSave={vi.fn()} editable={false} chinese={false} css="" resolveAsset={path=>path}/>);
    expect(screen.queryByRole('button',{name:'Maintenance rules'})).not.toBeInTheDocument();
  });
  it('returns focus to the opener when a dialog closes',()=>{
    render(<StudioHandbook section="content" document={starterStudioDocument()} onSave={vi.fn()} editable chinese={false} css="" resolveAsset={path=>path}/>);
    const opener=screen.getByRole('button',{name:'Edit guidelines'});opener.focus();fireEvent.click(opener);
    const cancel=within(screen.getByRole('dialog')).getByRole('button',{name:'Cancel'});cancel.focus();expect(document.activeElement).toBe(cancel);fireEvent.click(cancel);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(document.activeElement).toBe(opener);
  });
  it('says a shared type note once and gives display sizes a short sample',()=>{
    render(<StudioHandbook section="typeStyles" document={starterStudioDocument()} onSave={vi.fn()} editable chinese={false} css="" resolveAsset={path=>path}/>);
    expect(screen.getByRole('heading',{name:'Type styles'})).toBeInTheDocument();expect(screen.getAllByText('按信息层级使用，避免仅靠字号表达状态。')).toHaveLength(1);
    expect(screen.getAllByText('文字之间 Aa')).toHaveLength(2);expect(screen.getAllByRole('button',{name:/^Edit /})).toHaveLength(6);
  });
  it('shows the latest five source edits until asked for the rest',()=>{
    const history=Array.from({length:18},(_,index)=>({id:'r'+index,designSystemId:'user:x',status:'accepted' as const,feedback:'Edit '+index,baseBody:'',proposedBody:'',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}));
    render(<StudioHandbook section="governance" document={starterStudioDocument()} onSave={vi.fn()} editable={false} chinese={false} css="" resolveAsset={path=>path} history={history}/>);
    expect(screen.getAllByRole('button',{name:/Compare \/ restore/})).toHaveLength(5);fireEvent.click(screen.getByRole('button',{name:'Show all 18'}));expect(screen.getAllByRole('button',{name:/Compare \/ restore/})).toHaveLength(18);expect(screen.queryByRole('button',{name:'Show all 18'})).not.toBeInTheDocument();
  });
  it('names a missing token pair and hides the caption of a single theme',()=>{
    const doc=starterStudioDocument();doc.themes=[];doc.checklist=[];render(<StudioHandbook section="accessibility" document={doc} onSave={vi.fn()} editable={false} chinese css=":root{--fg:#111111;--bg:#ffffff}" resolveAsset={path=>path}/>);
    expect(screen.getAllByText('未定义')).toHaveLength(2);expect(screen.queryByRole('heading',{name:'浅色'})).not.toBeInTheDocument();expect(screen.queryByText('Light')).not.toBeInTheDocument();
  });
  it('turns a failed checklist save into plain words and clears it on the next try',async()=>{
    const doc=starterStudioDocument();const save=vi.fn(async()=>{throw new Error('SOURCE_BUSY');});render(<StudioHandbook section="accessibility" document={doc} onSave={save} editable chinese={false} css="" resolveAsset={path=>path}/>);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);expect(await screen.findByRole('alert')).toHaveTextContent('Another save is in progress');
    save.mockImplementationOnce(()=>new Promise(()=>{}));fireEvent.click(screen.getAllByRole('checkbox')[1]!);expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
describe('rules and screen review',()=>{
  it('shows each rule with its reason and the review checks in order',()=>{
    render(<StudioHandbook section="rules" document={ruleDoc()} onSave={vi.fn()} editable chinese={false} css="" resolveAsset={path=>path}/>);
    expect(screen.getByRole('heading',{name:'Rules'})).toBeInTheDocument();expect(screen.getByText('Use one primary action per screen.')).toBeInTheDocument();expect(screen.getByText('Why: If everything is important, nothing is.')).toBeInTheDocument();
    expect(screen.getByText('Keep labels short.').closest('li')).not.toHaveTextContent('Why:');
    const checks=screen.getByText('Every action has a visible label.').closest('ol')!;expect(checks).not.toBeNull();
    expect(within(checks).getAllByRole('listitem').map(item=>item.textContent)).toEqual(['Every action has a visible label.','Focus order follows reading order.']);
  });
  it('adds, edits and deletes a rule through onSave',async()=>{
    const doc=ruleDoc();const save=vi.fn(async(_next:StudioDocument)=>{});
    render(<StudioHandbook section="rules" document={doc} onSave={save} editable chinese={false} css="" resolveAsset={path=>path}/>);
    fireEvent.click(screen.getByRole('button',{name:'Add rule'}));let dialog=screen.getByRole('dialog',{name:'Add rule'});
    fireEvent.click(within(dialog).getByRole('button',{name:'Save specification'}));expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a rule.');expect(save).not.toHaveBeenCalled();
    const [ruleField,reasonField]=within(dialog).getAllByRole('textbox');
    fireEvent.change(ruleField!,{target:{value:'  Name the action on the button.  '}});fireEvent.change(reasonField!,{target:{value:'People scan buttons, not the text around them.'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Save specification'}));await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
    const added=save.mock.calls[0]![0].rules;expect(added.slice(0,2)).toEqual(doc.rules);expect(added[2]).toMatchObject({rule:'Name the action on the button.',reason:'People scan buttons, not the text around them.'});expect(added[2]!.id).toMatch(/^rule-[a-zA-Z0-9_-]+$/);
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button',{name:'Edit rule: Use one primary action per screen.'}));dialog=screen.getByRole('dialog',{name:'Edit rule'});
    fireEvent.change(within(dialog).getAllByRole('textbox')[0]!,{target:{value:'Use one primary action per view.'}});fireEvent.click(within(dialog).getByRole('button',{name:'Save specification'}));
    await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));expect(save.mock.calls[1]![0].rules).toEqual([{...doc.rules[0]!,rule:'Use one primary action per view.'},doc.rules[1]]);
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button',{name:'Delete rule: Keep labels short.'}));
    await waitFor(()=>expect(save).toHaveBeenCalledTimes(3));expect(save.mock.calls[2]![0].rules).toEqual([doc.rules[0]]);
  });
  it('says why a rule delete failed',async()=>{
    const save=vi.fn(async()=>{throw new Error('SOURCE_BUSY');});
    render(<StudioHandbook section="rules" document={ruleDoc()} onSave={save} editable chinese={false} css="" resolveAsset={path=>path}/>);
    fireEvent.click(screen.getByRole('button',{name:'Delete rule: Keep labels short.'}));expect(await screen.findByRole('alert')).toHaveTextContent('Another save is in progress');
  });
  it('saves the review checklist one check per line and drops blank lines',async()=>{
    const save=vi.fn(async(_next:StudioDocument)=>{});
    render(<StudioHandbook section="rules" document={ruleDoc()} onSave={save} editable chinese={false} css="" resolveAsset={path=>path}/>);
    fireEvent.click(screen.getByRole('button',{name:'Edit checklist'}));const dialog=screen.getByRole('dialog');
    const field=within(dialog).getByRole('textbox');expect(field).toHaveValue('Every action has a visible label.\nFocus order follows reading order.');
    fireEvent.change(field,{target:{value:'  Every action has a visible label.  \n\n   \nNo text below 12px.\n'}});fireEvent.click(within(dialog).getByRole('button',{name:'Save specification'}));
    await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));expect(save.mock.calls[0]![0].reviewChecks).toEqual(['Every action has a visible label.','No text below 12px.']);
  });
  it('offers no edit controls when read-only and says plainly what is missing',()=>{
    const view=render(<StudioHandbook section="rules" document={ruleDoc()} onSave={vi.fn()} editable={false} chinese={false} css="" resolveAsset={path=>path}/>);
    expect(screen.getByText('Use one primary action per screen.')).toBeInTheDocument();expect(screen.queryAllByRole('button')).toHaveLength(0);
    view.rerender(<StudioHandbook section="rules" document={{...ruleDoc(),rules:[],reviewChecks:[]}} onSave={vi.fn()} editable={false} chinese={false} css="" resolveAsset={path=>path}/>);
    expect(screen.getByText('This design system has no rules.')).toBeInTheDocument();expect(screen.getByText('This design system has no review checklist.')).toBeInTheDocument();expect(screen.queryAllByRole('button')).toHaveLength(0);
    view.rerender(<StudioHandbook section="rules" document={{...ruleDoc(),rules:[],reviewChecks:[]}} onSave={vi.fn()} editable chinese css="" resolveAsset={path=>path}/>);
    expect(screen.getByText(/^还没有规则。/)).toBeInTheDocument();expect(screen.getByText('还没有审查清单。')).toBeInTheDocument();
  });
  describe('rules learnt from a correction',()=>{
    const learntDoc=():StudioDocument=>({...starterStudioDocument(),rules:[
      {id:'rule-learnt',rule:'Never use a red primary button.',reason:'Red reads as destructive.',source:'correction',createdAt:'2026-03-04T12:00:00.000Z',context:'Made the Save button red'},
      {id:'rule-hand',rule:'Keep labels short.',reason:'Short labels scan faster.'},
    ]});
    const renderRules=(chinese:boolean,doc=learntDoc())=>render(<StudioHandbook section="rules" document={doc} onSave={vi.fn()} editable chinese={chinese} css="" resolveAsset={path=>path}/>);
    const itemOf=(text:string)=>screen.getByText(text).closest('li')!;
    it('marks a correction rule with a badge, its date and the situation it came from (en)',()=>{
      renderRules(false);const item=itemOf('Never use a red primary button.');
      expect(within(item).getByText('Learnt from a correction')).toBeInTheDocument();
      const date=item.querySelector('time')!;expect(date).not.toBeNull();expect(date).toHaveAttribute('dateTime','2026-03-04T12:00:00.000Z');expect(date).toHaveTextContent('3/4/2026');
      expect(within(item).getByText('Was: Made the Save button red')).toBeInTheDocument();
      expect(within(item).getByText('Why: Red reads as destructive.')).toBeInTheDocument();
    });
    it('marks a correction rule in Chinese with the localized badge, date and 当时 context',()=>{
      renderRules(true);const item=itemOf('Never use a red primary button.');
      expect(within(item).getByText('来自对话纠正')).toBeInTheDocument();
      const date=item.querySelector('time')!;expect(date).not.toBeNull();expect(date).toHaveTextContent('2026/3/4');
      expect(within(item).getByText('当时：Made the Save button red')).toBeInTheDocument();
      expect(within(item).queryByText('Learnt from a correction')).not.toBeInTheDocument();expect(within(item).queryByText(/^Was:/)).not.toBeInTheDocument();
    });
    it('shows no badge, date or context on a hand-written rule',()=>{
      for(const chinese of [false,true]){
        const view=renderRules(chinese);const item=itemOf('Keep labels short.');
        expect(item.querySelector('time')).toBeNull();expect(within(item).queryByText(/Learnt from a correction|来自对话纠正/)).not.toBeInTheDocument();expect(within(item).queryByText(/Was:|当时：/)).not.toBeInTheDocument();
        expect(screen.getAllByText(/Learnt from a correction|来自对话纠正/)).toHaveLength(1);
        view.unmount();
      }
    });
    it('omits the date and the context lines a correction rule does not carry',()=>{
      const doc=learntDoc();doc.rules=[{id:'rule-bare',rule:'Use sentence case.',reason:'',source:'correction'},{id:'rule-bad-date',rule:'Left-align body text.',reason:'',source:'correction',createdAt:'not a date',context:'Centered the paragraph'}];
      renderRules(false,doc);
      const bare=itemOf('Use sentence case.');expect(within(bare).getByText('Learnt from a correction')).toBeInTheDocument();expect(bare.querySelector('time')).toBeNull();expect(within(bare).queryByText(/Was:/)).not.toBeInTheDocument();
      const bad=itemOf('Left-align body text.');expect(within(bad).getByText('Learnt from a correction')).toBeInTheDocument();expect(bad.querySelector('time')).toBeNull();expect(within(bad).getByText('Was: Centered the paragraph')).toBeInTheDocument();
    });
    it('keeps the badge on a read-only handbook',()=>{
      render(<StudioHandbook section="rules" document={learntDoc()} onSave={vi.fn()} editable={false} chinese={false} css="" resolveAsset={path=>path}/>);
      expect(within(itemOf('Never use a red primary button.')).getByText('Learnt from a correction')).toBeInTheDocument();
    });
  });
  it('says the screen review is an on-demand skill written to system/skills/screen-review/SKILL.md',()=>{
    const view=render(<StudioHandbook section="rules" document={ruleDoc()} onSave={vi.fn()} editable chinese={false} css="" resolveAsset={path=>path}/>);
    const heading=screen.getByRole('heading',{name:'Screen review'});const note=heading.closest('section')!.querySelector('p')!;
    expect(note).toHaveTextContent(/^An on-demand skill, not a standing rule/);expect(note).toHaveTextContent('system/skills/screen-review/SKILL.md');expect(note).toHaveTextContent('only when it builds or changes a screen');
    view.rerender(<StudioHandbook section="rules" document={ruleDoc()} onSave={vi.fn()} editable chinese css="" resolveAsset={path=>path}/>);
    const zhNote=screen.getByRole('heading',{name:'界面审查清单'}).closest('section')!.querySelector('p')!;
    expect(zhNote).toHaveTextContent(/^这是按需读取的技能，不常驻/);expect(zhNote).toHaveTextContent('system/skills/screen-review/SKILL.md');
  });
  it('hides the on-demand skill note for a read-only system with no review checks',()=>{
    render(<StudioHandbook section="rules" document={{...ruleDoc(),reviewChecks:[]}} onSave={vi.fn()} editable={false} chinese={false} css="" resolveAsset={path=>path}/>);
    expect(screen.queryByText(/system\/skills\/screen-review\/SKILL\.md/)).not.toBeInTheDocument();
  });
  it('routes blocks to the catalogue like components, patterns and templates',()=>{
    const base=starterStudioDocument();const doc={...base,blocks:[{...base.components[0]!,id:'page-header',name:'Page header'}]};
    render(<StudioHandbook section="blocks" document={doc} onSave={vi.fn()} editable chinese={false} css="" resolveAsset={path=>path}/>);
    const catalog=screen.getByTestId('studio-catalog');expect(catalog).toHaveAttribute('data-section','blocks');expect(catalog).toHaveTextContent('Page header');
  });
});
