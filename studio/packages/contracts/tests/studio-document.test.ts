import { describe,it,expect } from 'vitest';
import { emptyStudioDocument,parseStudioDocument,attachStudioHandbook,studioHandbookMarkdown,appendStudioRules,studioScreenReviewSkillMarkdown,STUDIO_SCREEN_REVIEW_STAGED_PATH } from '../src/design-systems/studio-document.js';
import { assertOdNextPlanningBuildOnlyV2 } from '../src/prompts/od-next-strategy.js';
import { editStudioToken,parseStudioTokens,resolveStudioToken,studioContrast,removeStudioToken } from '../src/design-systems/studio-tokens.js';
describe('complete design system document',()=>{
  it('preserves authored principles while replacing the generated handbook once',()=>{
    const doc=emptyStudioDocument();doc.content='Write clearly.';
    const first=attachStudioHandbook('# My system\n\n## Principles\nKeep it calm.',doc);
    doc.content='Write clearly and specifically.';
    const second=attachStudioHandbook(first,doc);
    expect(second).toContain('Keep it calm.');expect(second.match(/handbook:start/g)).toHaveLength(1);expect(second).toContain('Write clearly and specifically.');
    // Only what the document holds is printed: a content-only handbook has no empty sections.
    expect(studioHandbookMarkdown(doc)).toBe('# Design system handbook\n\n## Content guidelines\nWrite clearly and specifically.');
  });
  it('round-trips the five layers and rejects malformed entries',()=>{
    const doc=emptyStudioDocument();expect(parseStudioDocument(JSON.stringify(doc))).toEqual(doc);
    expect(()=>parseStudioDocument(JSON.stringify({...doc,typeStyles:[{}]}))).toThrow('INVALID_STUDIO_DOCUMENT');
  });
  it('rejects duplicate catalog ids and non-string state declarations',()=>{
    const doc=emptyStudioDocument();const entry={id:'button',name:'Button',description:'',status:'draft' as const,usage:'',avoid:'',accessibility:'',api:'',html:'<button>Run</button>',variants:[],states:['default']};
    doc.components=[entry,{...entry}];expect(()=>parseStudioDocument(JSON.stringify(doc))).toThrow('DUPLICATE_STUDIO_ENTRY_ID');
    expect(()=>parseStudioDocument(JSON.stringify({...doc,components:[{...entry,states:[{}]}]}))).toThrow('INVALID_STUDIO_ENTRY');
  });
  it('reads a document written before blocks, rules and review checks as having none',()=>{
    const legacy=emptyStudioDocument() as unknown as Record<string,unknown>;
    delete legacy.blocks;delete legacy.rules;delete legacy.reviewChecks;
    const doc=parseStudioDocument(JSON.stringify(legacy));
    expect(doc.blocks).toEqual([]);expect(doc.rules).toEqual([]);expect(doc.reviewChecks).toEqual([]);
    expect(studioHandbookMarkdown(doc)).not.toMatch(/## (Rules|Screen review|blocks)/);
  });
  it('validates rules, review checks, blocks and the component contract fields',()=>{
    const doc=emptyStudioDocument();const entry={id:'page-header',name:'Page header',description:'',status:'draft' as const,usage:'',avoid:'',accessibility:'',api:'',html:'<header>Title</header>',variants:['default','compact'],states:['default'],defaultVariant:'default',good:'<button class="primary">Save</button>',bad:'<div onclick="save()">Save</div>'};
    doc.blocks=[entry];doc.rules=[{id:'one-primary',rule:'Use one primary button per screen.',reason:'If everything is important, nothing is.'}];doc.reviewChecks=['Flag any raw value that is not a token.'];
    expect(parseStudioDocument(JSON.stringify(doc))).toEqual(doc);
    expect(()=>parseStudioDocument(JSON.stringify({...doc,blocks:[{...entry,good:3}]}))).toThrow('INVALID_STUDIO_ENTRY');
    expect(()=>parseStudioDocument(JSON.stringify({...doc,blocks:[entry,{...entry}]}))).toThrow('DUPLICATE_STUDIO_ENTRY_ID');
    expect(()=>parseStudioDocument(JSON.stringify({...doc,rules:[{id:'x',rule:' ',reason:''}]}))).toThrow('INVALID_STUDIO_DOCUMENT');
    expect(()=>parseStudioDocument(JSON.stringify({...doc,rules:[{id:'a b',rule:'Rule',reason:''}]}))).toThrow('INVALID_STUDIO_DOCUMENT');
    expect(()=>parseStudioDocument(JSON.stringify({...doc,reviewChecks:['']}))).toThrow('INVALID_STUDIO_DOCUMENT');
  });
  it('puts rules with their reasons and the screen review first, and prints a component contract',()=>{
    const doc=emptyStudioDocument();
    doc.rules=[{id:'one-primary',rule:'Use one primary button per screen.',reason:'If everything is important, nothing is.'}];
    doc.reviewChecks=['Flag any raw value that is not a token.','Check each block has loading, empty and error states.'];
    doc.components=[{id:'button',name:'Button',description:'',status:'stable',usage:'',avoid:'',accessibility:'',api:'',html:'<button>Run</button>',variants:['primary','secondary'],states:['default'],defaultVariant:'secondary',good:'<button>Save</button>',bad:'<div>```Save```</div>'}];
    const text=studioHandbookMarkdown(doc);
    expect(text.indexOf('## Rules')).toBeGreaterThan(-1);expect(text.indexOf('## Rules')).toBeLessThan(text.indexOf('## components'));
    expect(text).not.toMatch(/## (Content guidelines|Implementation|Governance|Changelog|patterns)/);
    expect(text).toContain('system/studio.json');
    expect(text).toContain('- Use one primary button per screen. Why: If everything is important, nothing is.');
    // The checks live in the on-demand skill; the handbook keeps only the pointer to it.
    expect(text).toContain('## Screen review');expect(text).not.toContain('2. Check each block has loading, empty and error states.');
    expect(text).toContain('Default variant: secondary');
    expect(text).toContain('Good example:\n```html\n<button>Save</button>\n```');
    // A fence longer than any backtick run inside keeps the bad example whole.
    expect(text).toContain('Bad example:\n````html\n<div>```Save```</div>\n````');
    expect(text).not.toContain('## blocks');
  });
  it('reads every section an author or agent left out as empty, and still rejects a section of the wrong shape',()=>{
    const doc=parseStudioDocument(JSON.stringify({schemaVersion:1,components:[],implementation:{repository:'https://example.com/repo'}}));
    expect(doc.patterns).toEqual([]);expect(doc.tokenNotes).toEqual({});expect(doc.content).toBe('');
    expect(doc.implementation).toEqual({repository:'https://example.com/repo',designFile:'',packageName:'',notes:''});
    expect(doc.governance).toEqual(emptyStudioDocument().governance);
    expect(()=>parseStudioDocument(JSON.stringify({schemaVersion:1,patterns:{}}))).toThrow('INVALID_STUDIO_DOCUMENT');
    expect(()=>parseStudioDocument(JSON.stringify({schemaVersion:1,content:3}))).toThrow('INVALID_STUDIO_DOCUMENT');
    expect(()=>parseStudioDocument(JSON.stringify({schemaVersion:2}))).toThrow('INVALID_STUDIO_DOCUMENT');
  });
  it('keeps code examples intact when the handbook is demoted into DESIGN.md, and prints only a real default variant',()=>{
    const doc=emptyStudioDocument();
    doc.components=[{id:'install',name:'Install',description:'',status:'draft',usage:'',avoid:'',accessibility:'',api:'',html:'<p>x</p>',variants:['primary','danger'],states:['default'],defaultVariant:'secondary',good:'# Install the kit\nnpm i @acme/ui',bad:'## not a heading'}];
    doc.rules=[{id:'r',rule:'Keep\nlabels short.',reason:'Line one.\n\n- Line two'}];
    const body=attachStudioHandbook('# Mine',doc);
    expect(body).toContain('```html\n# Install the kit\nnpm i @acme/ui\n```');
    expect(body).toContain('```html\n## not a heading\n```');
    expect(body).toContain('### components');
    expect(body).not.toContain('Default variant');
    expect(body).toContain('- Keep labels short. Why: Line one. - Line two');
  });
  it('keeps the user\'s catalogue groups, in order, and checks their names',()=>{
    const doc=emptyStudioDocument();doc.groups={components:['操作','输入'],blocks:[]};
    doc.components=[{id:'button',name:'Button',description:'',status:'draft',usage:'',avoid:'',accessibility:'',api:'',html:'<button>Run</button>',variants:[],states:['default'],group:'操作'}];
    expect(parseStudioDocument(JSON.stringify(doc))).toEqual(doc);
    expect(studioHandbookMarkdown(doc)).toContain('Group: 操作');
    // Groups are labels: an agent's untidy value is tidied or dropped, never a reason the document fails.
    const tidy=parseStudioDocument(JSON.stringify({...doc,groups:{components:['操作',' 操作 ','','x'.repeat(41),'A  B',3],widgets:['x']},components:[{...doc.components[0],group:'Inputs\n## Injected'}]}));
    expect(tidy.groups).toEqual({components:['操作','A B']});expect(tidy.components[0]!.group).toBe('Inputs ## Injected');
    expect(studioHandbookMarkdown(tidy)).toContain('Group: Inputs ## Injected');
    for(const group of ['','   ','x'.repeat(41)])expect(parseStudioDocument(JSON.stringify({...doc,components:[{...doc.components[0],group}]})).components[0]).not.toHaveProperty('group');
    for(const groups of [[],'操作',null])expect(parseStudioDocument(JSON.stringify({...doc,groups})).groups).toEqual({});
    const legacy=emptyStudioDocument() as unknown as Record<string,unknown>;delete legacy.groups;expect(parseStudioDocument(JSON.stringify(legacy)).groups).toEqual({});
  });
  it('appends learnt rules once each, with provenance, and keeps ids valid and unique',()=>{
    const doc=emptyStudioDocument();doc.rules=[{id:'mine',rule:'Use one primary action per region.',reason:''}];
    const first=appendStudioRules(doc,[{rule:'  Never use gradients\n on buttons. ',reason:'The brand is flat.',context:'Made the save button a purple gradient.',source:'correction',createdAt:'2026-11-03T04:00:00.000Z'},{rule:'use ONE primary action per region'},{rule:'never use gradients on buttons!'},{rule:'   '}]);
    expect(first.added).toHaveLength(1);
    expect(first.added[0]).toMatchObject({rule:'Never use gradients on buttons.',reason:'The brand is flat.',source:'correction',context:'Made the save button a purple gradient.'});
    expect(first.added[0]!.id).toMatch(/^rule-[a-z0-9-]+$/);
    expect(parseStudioDocument(JSON.stringify(first.doc)).rules).toHaveLength(2);
    expect(appendStudioRules(first.doc,[{rule:'Never use gradients on buttons'}]).added).toEqual([]);
    expect(()=>parseStudioDocument(JSON.stringify({...doc,rules:[{id:'x',rule:'r',reason:'',source:'agent'}]}))).toThrow('INVALID_STUDIO_DOCUMENT');
  });
  it('makes the screen review an on-demand skill file, leaving one pointer in the handbook that OD Next accepts',()=>{
    const doc=emptyStudioDocument();
    expect(studioScreenReviewSkillMarkdown(doc)).toBeNull();
    doc.reviewChecks=['Flag any raw value that is not a token.','Check each block has loading, empty and error states.'];
    const skill=studioScreenReviewSkillMarkdown(doc,'Fantay Design')!;
    expect(skill).toMatch(/^---\nname: screen-review\ndescription: "Use when building or changing a screen with Fantay Design\./);
    expect(skill).toContain('2. Check each block has loading, empty and error states.');
    const handbook=studioHandbookMarkdown(doc);
    expect(handbook).toContain(STUDIO_SCREEN_REVIEW_STAGED_PATH);expect(handbook).not.toContain('Flag any raw value');
    // DESIGN.md is an instruction block on the OD Next path, so the pointer must pass its guard.
    expect(()=>assertOdNextPlanningBuildOnlyV2(handbook,'design system')).not.toThrow();
  });
  it('resolves aliases by theme, reports cycles, and adds theme overrides',()=>{
    const css=':root { --base: #ffffff; --surface: var(--base); --bad: var(--bad); }';
    const next=editStudioToken(css,null,'--base','#000000','[data-theme="dark"]');
    const tokens=parseStudioTokens(next);
    expect(resolveStudioToken('--surface',tokens)).toBe('#ffffff');expect(resolveStudioToken('--surface',tokens,'[data-theme="dark"]')).toBe('#000000');expect(resolveStudioToken('--bad',tokens)).toBeNull();
    expect(()=>removeStudioToken(css,parseStudioTokens(css)[0]!)).toThrow('TOKEN_REFERENCED');
    expect(studioContrast('#fff','#000')).toBe(21);
    expect(resolveStudioToken('--nested',parseStudioTokens(':root { --nested: var(--missing, var(--base, #123456)); }'))).toBe('#123456');
  });
});
