import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach,describe,it,expect} from 'vitest';
import {createMovieDocument,MOVIE_STYLES,type MaterialDetail,type MaterialApplyResponse} from '@open-design/contracts';
import {parseMovieStyle} from '../../src/movie/store.js';
import {styleFromDesignTokens,styleWithMaterial,copyReusableStyle} from '../../src/movie/style-links.js';
const dirs:string[]=[];const temp=async()=>{const p=await mkdtemp(path.join(os.tmpdir(),'movie-style-'));dirs.push(p);return p;};
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
describe('Reusable visual styles',()=>{
  it('binds real palette aliases and safe font values as a frozen snapshot',()=>{
    const original=createMovieDocument().style;
    const style=styleFromDesignTokens(original,'brand',':root{--paper:#abc;--bg:var(--paper);--fg:#111;--accent:#ff0033;--font-display:"Example",sans-serif}');
    expect(style.background).toBe('#aabbcc');expect(style.typeface).toBe('"Example",sans-serif');expect(style.designSystem?.digest).toHaveLength(64);
    expect(parseMovieStyle(style)).toEqual(style);
    expect(original.background).not.toBe(style.background);
  });
  it('rejects executable visual data and unsafe asset paths',()=>{
    const base=createMovieDocument().style;
    expect(()=>parseMovieStyle({...base,visual:{...base.visual,layers:[{id:'unsafe',type:'path',x:0,y:0,width:20,height:20,color:'accent',path:'<script>'}]}})).toThrow('SVG');
    expect(()=>parseMovieStyle({...base,assets:[{id:'cover',path:'../private.svg'}]})).toThrow('inside');
    expect(()=>parseMovieStyle({...base,typeface:'Arial;}</style><script>'})).toThrow('typeface');
  });
  it('retains material evidence and copies assets for another film',async()=>{
    const source=await temp(),target=await temp();await mkdir(path.join(source,'assets'));await writeFile(path.join(source,'assets','logo.svg'),'<svg/>');await writeFile(path.join(source,'fantasy-design-receipt.json'),'{}');
    const detail={id:'logo',title:'Library logo',license:'MIT',source:'https://example.test/logo'} as MaterialDetail;
    const applied={attachments:['assets/logo.svg'],receiptRelPath:'fantasy-design-receipt.json',files:[]} as unknown as MaterialApplyResponse;
    const style=styleWithMaterial(MOVIE_STYLES.find(s=>s.id==='collage')!,detail,applied);
    expect(style.visual?.layers.some(l=>l.assetId===style.assets?.[0]?.id)).toBe(true);
    const copy=await copyReusableStyle(parseMovieStyle(style),source,target);
    expect(copy.assets?.[0]?.path).not.toBe(style.assets?.[0]?.path);
    expect(await readFile(path.join(target,copy.assets![0]!.path),'utf8')).toBe('<svg/>');
    expect(copy.references?.[0]?.license).toBe('MIT');expect(copy.references?.[0]?.receipt).not.toBe('fantasy-design-receipt.json');
    style.references![0]!.licenseText='Full license';
    const referencedAgain=styleWithMaterial(style,detail);
    expect(referencedAgain.references?.[0]?.receipt).toBe('fantasy-design-receipt.json');expect(referencedAgain.references?.[0]?.licenseText).toBe('Full license');
  });
});
