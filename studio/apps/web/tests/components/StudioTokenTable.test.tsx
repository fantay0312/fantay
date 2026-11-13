// @vitest-environment jsdom
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {emptyStudioDocument,parseStudioTokens} from '@open-design/contracts';
import {StudioTokenTable} from '../../src/components/StudioTokenTable';
afterEach(cleanup);
describe('theme token table',()=>{
  it('clearing an override restores inheritance without deleting the base token',async()=>{
    const save=vi.fn(async(_css:string)=>{});const css=':root { --color: #ffffff; }\n[data-theme="dark"] { --color: #000000; }';
    render(<StudioTokenTable css={css} group="colors" document={emptyStudioDocument()} editable busy={false} chinese={false} onSave={save} onNote={()=>{}}/>);
    const input=screen.getByRole('textbox',{name:'--color · [data-theme="dark"]'});fireEvent.change(input,{target:{value:''}});fireEvent.blur(input);
    await waitFor(()=>expect(save).toHaveBeenCalled());
    expect(parseStudioTokens(save.mock.calls[0]![0] as string)).toEqual([expect.objectContaining({name:'--color',value:'#ffffff',scope:':root'})]);
  });
  it('escape cancels an uncommitted value',()=>{
    const save=vi.fn(async()=>{});render(<StudioTokenTable css=":root { --color: #ffffff; }" group="colors" document={emptyStudioDocument()} editable busy={false} chinese={false} onSave={save} onNote={()=>{}}/>);
    const input=screen.getByRole('textbox',{name:'--color · :root'});fireEvent.change(input,{target:{value:'#000000'}});fireEvent.keyDown(input,{key:'Escape'});fireEvent.blur(input);expect(save).not.toHaveBeenCalled();
  });
  it('reports why a value was refused and keeps it in the field',async()=>{
    const save=vi.fn(async()=>{});render(<StudioTokenTable css=":root { --color: #ffffff; }" group="colors" document={emptyStudioDocument()} editable busy={false} chinese={false} onSave={save} onNote={()=>{}}/>);
    const input=screen.getByRole<HTMLInputElement>('textbox',{name:'--color · :root'});fireEvent.change(input,{target:{value:'var(--missing)'}});fireEvent.blur(input);
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('alias'));expect(save).not.toHaveBeenCalled();expect(input.value).toBe('var(--missing)');
  });
  it('reads an alias as the token it names over the value it resolves to, and edits the CSS',async()=>{
    const save=vi.fn(async(_css:string)=>{});
    render(<StudioTokenTable css=":root { --color-ink: #191918; --fg: var(--color-ink); --color-wash: color-mix(in srgb, var(--color-ink) 50%, white); }" group="colors" document={emptyStudioDocument()} editable busy={false} chinese={false} onSave={save} onNote={()=>{}}/>);
    const input=screen.getByRole<HTMLInputElement>('textbox',{name:'--fg · :root'});
    expect(input.value).toBe('color-ink');
    expect(input.title).toBe('var(--color-ink)');
    const cell=input.closest('td')!;
    expect(cell.textContent).toContain('↳ #191918');
    expect(cell.textContent).not.toContain('var(');
    // A value that does more than point at one token stays as written.
    expect(screen.getByRole<HTMLInputElement>('textbox',{name:'--color-wash · :root'}).value).toBe('color-mix(in srgb, var(--color-ink) 50%, white)');
    fireEvent.focus(input);
    expect(input.value).toBe('var(--color-ink)');
    fireEvent.change(input,{target:{value:'#000000'}});fireEvent.blur(input);
    await waitFor(()=>expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toContain('--fg: #000000');
  });
  it('labels each theme once in a single header row',()=>{
    const document={...emptyStudioDocument(),themes:[{name:'Dusk',selector:'[data-theme="dusk"]'}]} as ReturnType<typeof emptyStudioDocument>;
    render(<StudioTokenTable css=":root { --a: #ffffff; --b: #000000; }" group="colors" document={document} editable={false} busy={false} chinese={false} onSave={async()=>{}} onNote={()=>{}}/>);
    expect(screen.getAllByRole('columnheader').map((cell)=>cell.textContent)).toEqual(['Name','Light','Dusk','']);
    expect(screen.getByRole<HTMLInputElement>('textbox',{name:'--a · :root'}).readOnly).toBe(true);
  });
});
