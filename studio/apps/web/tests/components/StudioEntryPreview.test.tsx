// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {StudioEntryPreview} from '../../src/components/StudioEntryPreview';
import {readStudioPreviewReport,studioComponentPreview,studioThumbnail,type StudioPreviewReport} from '../../src/runtime/design-system-studio';
import type {StudioLibraryEntry} from '@open-design/contracts';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const report=(width:number,content:number,breaks:number[]=[],height=Math.max(content,260)):StudioPreviewReport=>({width,height,content,breaks});
describe('closed tile thumbnails',()=>{
  it('keeps content that fits at full size',()=>{
    expect(studioThumbnail(240,240,report(240,120))).toEqual({layout:240,scale:1,clip:null,settled:true});
  });
  it('lays tall content out wider once and settles at the scale that fills the tile width',()=>{
    const first=studioThumbnail(240,240,report(240,280));
    expect(first).toMatchObject({layout:400,settled:false});expect(first.scale).toBeCloseTo(0.6);
    // A report from the old width only means the frame has not caught up.
    expect(studioThumbnail(240,400,report(240,280))).toMatchObject({layout:400,settled:false});
    expect(studioThumbnail(240,400,report(400,150))).toMatchObject({layout:400,scale:0.6,clip:null,settled:true});
  });
  it('widens again when the frame grows after its first report, never below half size',()=>{
    expect(studioThumbnail(240,400,report(400,480))).toMatchObject({layout:480,scale:0.5,settled:false});
  });
  it('shrinks a little past half size before it crops',()=>{
    const fit=studioThumbnail(240,480,report(480,380,[200,300]));
    expect(fit.clip).toBeNull();expect(fit.scale).toBeCloseTo(168/380);expect(fit.settled).toBe(true);
  });
  it('cuts a taller entry at the last clean line that fits, or scales it whole when there is none',()=>{
    expect(studioThumbnail(240,480,report(480,600,[90,250,320,400]))).toEqual({layout:480,scale:0.5,clip:320,settled:true});
    const whole=studioThumbnail(240,480,report(480,600,[90]));
    expect(whole.clip).toBeNull();expect(whole.scale).toBeCloseTo(168/600);
  });
  it('reads older reports as the page height with no clean lines',()=>{
    expect(readStudioPreviewReport({type:'studio-preview-height',height:240})).toEqual({width:0,height:240,content:240,breaks:[]});
    expect(readStudioPreviewReport({type:'studio-preview-height',width:300,height:260,content:120,breaks:[90,40,'x']})).toEqual({width:300,height:260,content:120,breaks:[40,90]});
    expect(readStudioPreviewReport({type:'other',height:1})).toBeNull();
  });
  it('injects a report script that parses',()=>{
    const doc=new DOMParser().parseFromString(studioComponentPreview('<p>Hi</p>','','light',path=>path,undefined,true),'text/html');
    const script=[...doc.querySelectorAll('script')].map(item=>item.textContent??'').find(text=>text.includes('studio-preview-height'));
    expect(script).toContain('breaks');expect(()=>new Function(script!)).not.toThrow();
  });
  it('scales a closed tile into its box and stays hidden until the scale is final',async()=>{
    vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(240);
    const entry={id:'thumb',name:'Thumb',html:'<form>Tall</form>',description:'',status:'draft',usage:'',avoid:'',api:'',accessibility:'',variants:[],states:[]} satisfies StudioLibraryEntry;
    const read=vi.fn(async()=>new Blob());
    const view=render(<StudioEntryPreview entry={entry} html={entry.html} css="" theme="light" readResource={read} scope="local:thumb" title="Thumb" fit thumbnail/>);
    const box=view.container.firstElementChild as HTMLElement;
    expect(box.style.height).toBe('168px');
    const frame=await screen.findByTitle('Thumb') as HTMLIFrameElement;
    expect(frame.style.width).toBe('240px');
    const send=(data:StudioPreviewReport)=>act(()=>{fireEvent(window,new MessageEvent('message',{data:{type:'studio-preview-height',...data},source:frame.contentWindow}));});
    send(report(240,400));
    expect(frame.style.width).toBe('480px');
    fireEvent.load(frame);
    expect(box).toHaveAttribute('data-state','loading');
    send(report(480,300));
    expect(frame.style.transform).toBe('scale(0.5)');expect(frame.style.left).toBe('0px');expect(frame.style.clipPath).toBe('');
    expect(box).toHaveAttribute('data-state','ready');expect(box.style.height).toBe('168px');
    view.rerender(<StudioEntryPreview entry={entry} html={entry.html} css="" theme="light" readResource={read} scope="local:thumb" title="Thumb" fit thumbnail={false}/>);
    // Open, the same frame goes back to full size and the stage hugs the page.
    expect(screen.getByTitle('Thumb')).toBe(frame);expect(frame.style.transform).toBe('');expect(frame.style.width).toBe('');expect(box.style.height).toBe('300px');
  });
});
it('repackages a changed same-path resource while preserving the preview scope',async()=>{
  const entry={id:'image',name:'Image',html:'<img src="assets/image.png">',description:'',status:'draft',usage:'',avoid:'',api:'',accessibility:'',variants:[],states:[]} satisfies StudioLibraryEntry;
  const read=vi.fn(async()=>new Blob(['first'],{type:'image/png'}));const props={entry,html:entry.html,css:'',theme:'light',readResource:read,scope:'local:system',title:'Image'};
  const view=render(<StudioEntryPreview {...props} resourceRevision={0}/>);await waitFor(()=>expect(screen.getByTitle('Image').getAttribute('srcdoc')).toContain('Zmlyc3Q='));
  read.mockResolvedValue(new Blob(['second'],{type:'image/png'}));view.rerender(<StudioEntryPreview {...props} resourceRevision={1}/>);await waitFor(()=>expect(screen.getByTitle('Image').getAttribute('srcdoc')).toContain('c2Vjb25k'));expect(read).toHaveBeenCalledTimes(2);
});
it('fits from its first frame and remembers the reported height',async()=>{
  const entry={id:'fit',name:'Fit',html:'<button>Run</button>',description:'',status:'draft',usage:'',avoid:'',api:'',accessibility:'',variants:[],states:[]} satisfies StudioLibraryEntry;
  const props={entry,html:entry.html,css:'',theme:'light',readResource:vi.fn(),scope:'local:fit',title:'Fit',fit:true};
  const view=render(<StudioEntryPreview {...props}/>);
  const box=view.container.firstElementChild as HTMLElement;
  expect(box).toHaveAttribute('data-fit');expect(box.style.height).toBe('168px');
  const frame=await screen.findByTitle('Fit') as HTMLIFrameElement;
  // jsdom may load the srcdoc first; either order ends with the reported height applied.
  fireEvent(window,new MessageEvent('message',{data:{type:'studio-preview-height',height:240},source:frame.contentWindow}));
  fireEvent.load(frame);
  expect(box.style.height).toBe('240px');expect(frame.style.height).toBe('240px');
  view.unmount();
  const again=render(<StudioEntryPreview {...props}/>);
  expect((again.container.firstElementChild as HTMLElement).style.height).toBe('240px');
});
