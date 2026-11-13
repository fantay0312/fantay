// @vitest-environment jsdom
import '../fantay/helpers/radix-jsdom';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {emptyStudioDocument,type StudioDocument} from '@open-design/contracts';
import {StudioCatalog} from '../../src/components/StudioCatalog';
import {copyToClipboard} from '../../src/lib/copy-to-clipboard';
vi.mock('../../src/lib/copy-to-clipboard',()=>({copyToClipboard:vi.fn(async()=>true)}));
const previews=vi.hoisted(()=>({mounts:0}));
vi.mock('../../src/components/StudioEntryPreview',async()=>{const {useEffect}=await import('react');return {StudioEntryPreview:({thumbnail}:{thumbnail?:boolean})=>{useEffect(()=>{previews.mounts+=1;},[]);return <div data-thumbnail={thumbnail?'':undefined}>Live preview</div>;}};});
afterEach(()=>{cleanup();previews.mounts=0;vi.useRealTimers();});
function data():StudioDocument {const d=emptyStudioDocument();d.components=[{id:'button',name:'Button',description:'A button',status:'draft',html:'<button>Run</button>',usage:'Use',avoid:'Avoid',api:'| Prop | Type |\n| --- | --- |\n| tone | string |',accessibility:'Label',states:['default'],variants:['primary']}];return d;}
function two():StudioDocument {const d=data();d.components.push({...d.components[0]!,id:'field',name:'TextField',description:'A field',html:'<input>'});return d;}
const openEntry=(name='Button')=>fireEvent.click(screen.getByRole('button',{name,expanded:false}));
const openMenu=()=>fireEvent.keyDown(screen.getByRole('button',{name:'More actions'}),{key:'Enter'});
const base={section:'components' as const,editable:true,chinese:false,css:':root{--accent:red}',scope:'test',readResource:vi.fn()};
describe('catalog editing and reuse',()=>{
  it('locks draft fields until the captured save completes',async()=>{
    let resolve!:()=>void;const pending=new Promise<void>(done=>resolve=done);const save=vi.fn(()=>pending);render(<StudioCatalog {...base} document={data()} onSave={save}/>);openEntry();fireEvent.click(screen.getByRole('button',{name:/^Edit$/}));fireEvent.click(screen.getByRole('button',{name:'Save entry'}));expect(screen.getByLabelText('Name')).toBeDisabled();resolve();await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('preserves comma input while typing and saves a normalized list',async()=>{
    const save=vi.fn(async(_doc:StudioDocument)=>{});render(<StudioCatalog {...base} document={data()} onSave={save}/>);openEntry();fireEvent.click(screen.getByRole('button',{name:/^Edit$/}));const field=screen.getByLabelText('Variants (comma-separated)');fireEvent.change(field,{target:{value:'primary, '}});expect(field).toHaveValue('primary, ');fireEvent.change(field,{target:{value:'primary, secondary'}});fireEvent.click(screen.getByRole('button',{name:'Save entry'}));await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({components:[expect.objectContaining({variants:['primary','secondary']})]})));
  });
  it('detects an entry changed after the editor opened and keeps the draft',async()=>{
    const doc=data(),save=vi.fn(async(_doc:StudioDocument)=>{});const view=render(<StudioCatalog {...base} document={doc} onSave={save}/>);openEntry();fireEvent.click(screen.getByRole('button',{name:/^Edit$/}));fireEvent.change(screen.getByLabelText('Name'),{target:{value:'My draft'}});const changed=structuredClone(doc);changed.components[0]!.description='Updated elsewhere';view.rerender(<StudioCatalog {...base} document={changed} onSave={save}/>);fireEvent.click(screen.getByRole('button',{name:'Save entry'}));expect(await screen.findByRole('alert')).toHaveTextContent('changed elsewhere');expect(screen.getByLabelText('Name')).toHaveValue('My draft');expect(save).not.toHaveBeenCalled();
  });
  it('keeps a failed delete visible and retryable',async()=>{
    const save=vi.fn(async()=>{throw Error('SAVE_FAILED')});render(<StudioCatalog {...base} document={data()} onSave={save}/>);openEntry();openMenu();fireEvent.click(screen.getByRole('menuitem',{name:'Delete entry'}));const dialog=screen.getByRole('dialog');fireEvent.click(within(dialog).getByRole('button',{name:'Delete entry'}));expect(await screen.findByRole('alert')).toHaveTextContent('operation failed');expect(screen.getByRole('heading',{name:'Button'})).toBeInTheDocument();
  });
  it('offers reuse for components and copies a new entry id',async()=>{
    const save=vi.fn(async(_doc:StudioDocument)=>{}),reuse=vi.fn(async()=>{});render(<StudioCatalog {...base} document={data()} onSave={save} onReuse={reuse}/>);openEntry();expect(screen.getByRole('button',{name:'Create project'})).toBeInTheDocument();openMenu();fireEvent.click(screen.getByRole('menuitem',{name:'Duplicate'}));await waitFor(()=>expect(save).toHaveBeenCalled());const next=save.mock.calls[0]![0] as unknown as StudioDocument;expect(next.components).toHaveLength(2);expect(next.components[1]!.id).not.toBe('button');
  });
  it('shows entries as tiles and opens one at a time without remounting its preview',()=>{
    const {container}=render(<StudioCatalog {...base} document={two()} onSave={vi.fn()}/>);
    expect(screen.queryByRole('button',{name:/^Edit$/})).not.toBeInTheDocument();expect(screen.queryByRole('tablist')).not.toBeInTheDocument();expect(previews.mounts).toBe(2);
    // Closed tiles draw their preview as a thumbnail; the open entry draws it full size.
    expect(container.querySelectorAll('[data-thumbnail]')).toHaveLength(2);
    openEntry('Button');
    expect(container.querySelector('[data-entry-id="button"]')).toHaveAttribute('data-open');expect(screen.getByRole('button',{name:'Button',expanded:true})).toBeInTheDocument();
    expect(container.querySelector('[data-entry-id="button"] [data-thumbnail]')).toBeNull();expect(container.querySelector('[data-entry-id="field"] [data-thumbnail]')).not.toBeNull();
    openEntry('TextField');
    expect(container.querySelector('[data-entry-id="button"]')).not.toHaveAttribute('data-open');expect(container.querySelector('[data-entry-id="field"]')).toHaveAttribute('data-open');
    fireEvent.click(screen.getByRole('button',{name:'TextField',expanded:true}));
    expect(container.querySelector('[data-open]')).toBeNull();expect(previews.mounts).toBe(2);
  });
  it('opens on the specification, keeps props apart from source, and a second press closes it',()=>{
    render(<StudioCatalog {...base} document={data()} onSave={vi.fn()}/>);openEntry();
    expect(screen.getByRole('tab',{name:'Specification'})).toHaveAttribute('aria-selected','true');expect(screen.getByText('When to use')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab',{name:'Specification'}));expect(screen.getByRole('tab',{name:'Specification'})).toHaveAttribute('aria-selected','false');
    fireEvent.click(screen.getByRole('tab',{name:'Props'}));expect(screen.getByRole('table')).toHaveTextContent('tone');expect(screen.queryByText('Current example source')).not.toBeInTheDocument();
  });
  it('folds the panel away before showing the next tab',()=>{
    vi.useFakeTimers();const {container}=render(<StudioCatalog {...base} document={data()} onSave={vi.fn()}/>);openEntry();
    fireEvent.click(screen.getByRole('tab',{name:'Code'}));
    expect(screen.getByRole('tab',{name:'Code'})).toHaveAttribute('aria-selected','true');expect(container.querySelector('[data-entry-id="button"] [role="tabpanel"]')!.parentElement).not.toHaveAttribute('data-open');expect(screen.getByText('When to use')).toBeInTheDocument();
    act(()=>{vi.advanceTimersByTime(140);});
    expect(container.querySelector('[data-entry-id="button"] [role="tabpanel"]')!.parentElement).toHaveAttribute('data-open');expect(screen.getByText('Current example source')).toBeInTheDocument();expect(screen.queryByText('When to use')).not.toBeInTheDocument();
  });
  it('offers a way out of an empty search',()=>{
    render(<StudioCatalog {...base} document={data()} onSave={vi.fn()}/>);fireEvent.change(screen.getByRole('searchbox',{name:'Search entries'}),{target:{value:'nothing'}});expect(screen.getByRole('heading',{name:'No matching entries'})).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Clear search'}));expect(screen.getByRole('heading',{name:'Button'})).toBeInTheDocument();
  });
  it('follows a shared query, matches Chinese names and steps aside when nothing matches',()=>{
    const view=render(<StudioCatalog {...base} document={two()} onSave={vi.fn()} query="按钮" previewTheme="light"/>);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();expect(screen.queryByLabelText('Preview theme')).not.toBeInTheDocument();
    // Alone, adding (and starting a group) sits in its own hanging row right before the grid rather than a toolbar.
    const add=screen.getByRole('button',{name:'Add'});expect([...add.parentElement!.children].map(button=>button.textContent)).toEqual(['Add','New group']);expect(add.parentElement!.parentElement!.nextElementSibling!.querySelector('[data-entry-id]')).not.toBeNull();
    expect(screen.getByRole('heading',{name:'Button'})).toBeInTheDocument();expect(screen.queryByRole('heading',{name:'TextField'})).not.toBeInTheDocument();
    view.rerender(<StudioCatalog {...base} document={two()} onSave={vi.fn()} query="secondary"/>);
    expect(view.container.firstElementChild).toHaveAttribute('data-no-match');expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
  it('leaves adding to the shell heading when the shell asks for it',()=>{
    const view=render(<StudioCatalog {...base} document={two()} onSave={vi.fn()} query="" previewTheme="light" addRequest={0}/>);
    expect(screen.queryByRole('button',{name:'Add'})).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<StudioCatalog {...base} document={two()} onSave={vi.fn()} query="" previewTheme="light" addRequest={1}/>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/New entry/)).toBeInTheDocument();
  });
  it('names the next step for an empty section',()=>{
    const view=render(<StudioCatalog {...base} section="patterns" document={emptyStudioDocument()} onSave={vi.fn()}/>);
    expect(screen.getByRole('heading',{name:'No patterns yet'})).toBeInTheDocument();expect(screen.getByText(/Edit with agent/)).toBeInTheDocument();
    view.rerender(<StudioCatalog {...base} section="templates" editable={false} document={emptyStudioDocument()} onSave={vi.fn()}/>);
    expect(screen.getByText('This design system includes no templates.')).toBeInTheDocument();
  });
});
describe('component contract',()=>{
  const contract=(patch:Partial<StudioDocument['components'][number]>)=>{const d=data();Object.assign(d.components[0]!,{variants:['primary','quiet'],...patch});return d;};
  it('puts the named default first and shows only the examples that exist',async()=>{
    const view=render(<StudioCatalog {...base} document={contract({defaultVariant:'quiet',good:'<button class="btn">Save</button>'})} onSave={vi.fn()}/>);openEntry();
    const tags=screen.getByText('Default').closest('ul')!;expect(Array.from(tags.children).map(item=>item.textContent)).toEqual(['quietDefault','primary']);
    expect(screen.getByText('Good and bad examples')).toBeInTheDocument();expect(screen.getByText('Good')).toBeInTheDocument();expect(screen.queryByText('Bad')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Copy good example'}));await waitFor(()=>expect(copyToClipboard).toHaveBeenCalledWith('<button class="btn">Save</button>'));
    view.rerender(<StudioCatalog {...base} document={contract({defaultVariant:'ghost',bad:'<div onclick="save()">Save</div>'})} onSave={vi.fn()}/>);
    expect(screen.queryByText('Default')).not.toBeInTheDocument();expect(screen.getByText('Bad')).toBeInTheDocument();expect(screen.queryByText('Good')).not.toBeInTheDocument();expect(screen.getByText('<div onclick="save()">Save</div>')).toBeInTheDocument();
    view.rerender(<StudioCatalog {...base} document={contract({})} onSave={vi.fn()}/>);
    expect(screen.queryByText('Default')).not.toBeInTheDocument();expect(screen.queryByText('Good and bad examples')).not.toBeInTheDocument();
  });
  it('finds an entry by its examples',()=>{
    render(<StudioCatalog {...base} document={contract({good:'<button class="btn-save">Save</button>'})} onSave={vi.fn()} query="btn-save" previewTheme="light"/>);
    expect(screen.getByRole('heading',{name:'Button'})).toBeInTheDocument();
  });
  it('saves the default variant and examples, and drops what is blank or no longer named',async()=>{
    const save=vi.fn(async(_doc:StudioDocument)=>{});const view=render(<StudioCatalog {...base} document={data()} onSave={save}/>);openEntry();fireEvent.click(screen.getByRole('button',{name:/^Edit$/}));
    fireEvent.change(screen.getByLabelText('Variants (comma-separated)'),{target:{value:'primary, quiet'}});
    fireEvent.click(screen.getByLabelText(/^Default variant/));fireEvent.click(screen.getByRole('option',{name:'quiet'}));
    fireEvent.click(screen.getByRole('tab',{name:'Implementation'}));
    fireEvent.change(screen.getByLabelText('Good example (from real code)'),{target:{value:'<button class="btn">Save</button>'}});fireEvent.change(screen.getByLabelText('Bad example'),{target:{value:'  \n'}});
    fireEvent.click(screen.getByRole('button',{name:'Save entry'}));await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
    const saved=save.mock.calls[0]![0].components[0]!;expect(saved).toMatchObject({variants:['primary','quiet'],defaultVariant:'quiet',good:'<button class="btn">Save</button>'});expect(saved).not.toHaveProperty('bad');
    // Reopened on the saved entry: dropping the default's variant and blanking an example removes both keys.
    view.rerender(<StudioCatalog {...base} document={save.mock.calls[0]![0]} onSave={save}/>);await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button',{name:/^Edit$/}));
    fireEvent.change(screen.getByLabelText('Variants (comma-separated)'),{target:{value:'primary'}});expect(screen.getByLabelText(/^Default variant/)).toHaveTextContent('Not set');
    fireEvent.click(screen.getByRole('tab',{name:'Implementation'}));fireEvent.change(screen.getByLabelText('Good example (from real code)'),{target:{value:''}});
    fireEvent.click(screen.getByRole('button',{name:'Save entry'}));await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));
    const cleared=save.mock.calls[1]![0].components[0]!;expect(cleared.variants).toEqual(['primary']);expect(cleared).not.toHaveProperty('defaultVariant');expect(cleared).not.toHaveProperty('good');expect(cleared).not.toHaveProperty('bad');
  });
});
describe('blocks',()=>{
  it('names the next step for an empty blocks section',()=>{
    const view=render(<StudioCatalog {...base} section="blocks" document={emptyStudioDocument()} onSave={vi.fn()}/>);
    expect(screen.getByRole('heading',{name:'No blocks yet'})).toBeInTheDocument();expect(screen.getByText(/lifted from real screens/)).toBeInTheDocument();
    view.rerender(<StudioCatalog {...base} section="blocks" editable={false} document={emptyStudioDocument()} onSave={vi.fn()}/>);
    expect(screen.getByText('This design system includes no blocks.')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Add'})).not.toBeInTheDocument();
  });
  it('saves a new block into the blocks list',async()=>{
    const save=vi.fn(async(_doc:StudioDocument)=>{});render(<StudioCatalog {...base} section="blocks" document={data()} onSave={save}/>);
    fireEvent.click(screen.getByRole('button',{name:'Add'}));fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Page header'}});fireEvent.click(screen.getByRole('button',{name:'Save entry'}));
    await waitFor(()=>expect(save).toHaveBeenCalled());const next=save.mock.calls[0]![0];expect(next.blocks.map(entry=>entry.name)).toEqual(['Page header']);expect(next.components).toHaveLength(1);
  });
  it('shows one grid until the system has groups, then a grid per group with the ungrouped last',()=>{
    const flat=render(<StudioCatalog {...base} document={two()} onSave={vi.fn()}/>);
    expect(flat.container.querySelector('[data-catalog-group]')).toBeNull();flat.unmount();
    const d=two();d.components[1]!.group='Inputs';d.groups={components:['Actions','Inputs']};
    const {container}=render(<StudioCatalog {...base} document={d} onSave={vi.fn()}/>);
    expect([...container.querySelectorAll('[data-catalog-group]')].map(node=>node.getAttribute('data-catalog-group'))).toEqual(['Actions','Inputs','']);
    const actions=container.querySelector<HTMLElement>('[data-catalog-group="Actions"]')!;
    expect(within(actions).getByText('Nothing in this group yet. Use + to add an entry.')).toBeInTheDocument();
    expect(within(container.querySelector<HTMLElement>('[data-catalog-group="Inputs"]')!).getByRole('heading',{name:'TextField'})).toBeInTheDocument();
    expect(within(container.querySelector<HTMLElement>('[data-catalog-group=""]')!).getByRole('heading',{name:'Ungrouped'})).toBeInTheDocument();
  });
  it('creates a group from the shell request and refuses a duplicate name',async()=>{
    const save=vi.fn(async(_doc:StudioDocument)=>{});const d=data();d.groups={components:['Actions']};
    const view=render(<StudioCatalog {...base} document={d} onSave={save} query="" previewTheme="light" addRequest={0} groupRequest={0}/>);
    view.rerender(<StudioCatalog {...base} document={d} onSave={save} query="" previewTheme="light" addRequest={0} groupRequest={1}/>);
    const dialog=await screen.findByRole('dialog',{name:'New group'});
    fireEvent.change(within(dialog).getByLabelText('Group name'),{target:{value:'Actions'}});fireEvent.click(within(dialog).getByRole('button',{name:'Create'}));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists');expect(save).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Group name'),{target:{value:'  Agent   & chat '}});fireEvent.click(within(dialog).getByRole('button',{name:'Create'}));
    await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({groups:{components:['Actions','Agent & chat']}})));
  });
  it('saves an entry into a group typed for the first time and lists that group',async()=>{
    const save=vi.fn(async(_doc:StudioDocument)=>{});render(<StudioCatalog {...base} document={data()} onSave={save}/>);
    openEntry();fireEvent.click(screen.getByRole('button',{name:/^Edit$/}));
    fireEvent.change(screen.getByLabelText('Group (type a new one to create it)'),{target:{value:' Actions '}});
    fireEvent.click(screen.getByRole('button',{name:'Save entry'}));
    await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({groups:{components:['Actions']},components:[expect.objectContaining({group:'Actions'})]})));
  });
  it('renames and deletes a group, keeping its entries ungrouped',async()=>{
    const d=two();d.components[0]!.group='Actions';d.components[1]!.group='Actions';d.groups={components:['Actions']};
    const save=vi.fn(async(_doc:StudioDocument)=>{});render(<StudioCatalog {...base} document={d} onSave={save}/>);
    fireEvent.keyDown(screen.getByRole('button',{name:'Group actions: Actions'}),{key:'Enter'});fireEvent.click(screen.getByRole('menuitem',{name:'Rename'}));
    const rename=await screen.findByRole('dialog',{name:'Rename group'});fireEvent.change(within(rename).getByLabelText('Group name'),{target:{value:'Act'}});fireEvent.click(within(rename).getByRole('button',{name:'Save'}));
    await waitFor(()=>expect(save).toHaveBeenLastCalledWith(expect.objectContaining({groups:{components:['Act']},components:[expect.objectContaining({group:'Act'}),expect.objectContaining({group:'Act'})]})));
    fireEvent.keyDown(screen.getByRole('button',{name:'Group actions: Actions'}),{key:'Enter'});fireEvent.click(screen.getByRole('menuitem',{name:'Delete group'}));
    const remove=await screen.findByRole('dialog',{name:'Delete group'});expect(remove).toHaveTextContent('2 entries move to Ungrouped');
    fireEvent.click(within(remove).getByRole('button',{name:'Delete group'}));
    await waitFor(()=>expect(save).toHaveBeenLastCalledWith(expect.objectContaining({groups:{components:[]}})));
    const last=save.mock.calls.at(-1)![0];expect(last.components.map(entry=>entry.group)).toEqual([undefined,undefined]);expect(last.components).toHaveLength(2);
  });
  it('adds an entry straight into a group from its heading',async()=>{
    const d=data();d.groups={components:['Inputs']};const save=vi.fn(async(_doc:StudioDocument)=>{});render(<StudioCatalog {...base} document={d} onSave={save}/>);
    fireEvent.click(screen.getByRole('button',{name:'Add to group: Inputs'}));
    expect(screen.getByLabelText('Group (type a new one to create it)')).toHaveValue('Inputs');
  });
});

