// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import type {StudioLibraryEntry} from '@open-design/contracts';
import {bundleStudioEntry,resolveStudioResource} from '../../src/runtime/studio-entry-bundle';
const entry=(html:string):StudioLibraryEntry=>({id:'test',name:'Reusable',description:'',status:'draft',usage:'',avoid:'',accessibility:'',api:'',variants:[],states:[],html});
describe('entry resource packaging',()=>{
  it('embeds HTML, srcset, poster, inline styles, imported CSS and fonts once',async()=>{
    const files:Record<string,Blob>={
      'styles/main.css':new Blob(['@import "more.css"; .x{background:url(../images/a.png)}'],{type:'text/css'}),
      'styles/more.css':new Blob(['.x{color:red}'],{type:'text/css'}),
      'images/a.png':new Blob(['a'],{type:'image/png'}),'images/b.png':new Blob(['b'],{type:'image/png'}),'fonts/test.woff2':new Blob(['font'],{type:'font/woff2'}),
    };
    const read=vi.fn(async(path:string)=>{if(!files[path])throw Error('missing');return files[path]!;});
    const result=await bundleStudioEntry(entry('<link rel="stylesheet" href="styles/main.css"><img src="images/a.png" srcset="images/a.png 1x, images/b.png 2x" style="background:url(images/b.png)"><video poster="images/a.png"></video>'),'@font-face{font-family:Test;src:url(fonts/test.woff2)}',read);
    expect(result.html).toContain('data:image/png;base64');expect(result.html).toContain('data:font/woff2;base64');expect(result.html).toContain('data:text/css;base64');expect(result.localResources).toHaveLength(5);expect(read).toHaveBeenCalledTimes(5);expect(result.html).not.toContain('images/a.png');expect(result.html.startsWith('<!doctype html>')).toBe(true);
  });
  it('fails before reuse when a local resource is missing or outside the package',async()=>{
    await expect(bundleStudioEntry(entry('<img src="missing.png">'),'',async()=>{throw Error('missing')})).rejects.toThrow('缺少资源');
    expect(()=>resolveStudioResource('../../secret.json')).toThrow('资源超出');
  });
  it('keeps explicit external dependencies visible instead of fetching them silently',async()=>{
    const read=vi.fn();const result=await bundleStudioEntry(entry('<img src="https://example.com/image.png">'),'',read);expect(result.externalResources).toEqual(['https://example.com/image.png']);expect(read).not.toHaveBeenCalled();
  });
  it('rejects side-effect and inline relative module imports before export',async()=>{
    await expect(bundleStudioEntry(entry('<script type="module" src="main.js"></script>'),'',async()=>new Blob(['import "./setup.js";'],{type:'text/javascript'}))).rejects.toThrow('请先构建');
    await expect(bundleStudioEntry(entry('<script type="module">import "./setup.js";</script>'),'',async()=>new Blob([]))).rejects.toThrow('请先构建');
  });
  it('carries declared asset license files inside the standalone document',async()=>{
    const read=Object.assign(async()=>new Blob(['SIL OPEN FONT LICENSE'],{type:'text/plain'}),{licenses:['fonts/OFL.txt']});
    const result=await bundleStudioEntry(entry('<p>Licensed font</p>'),'',read);expect(result.html).toContain('data-asset-licenses');expect(result.html).toContain('SIL OPEN FONT LICENSE');expect(result.localResources).toContain('fonts/OFL.txt');
  });
});
