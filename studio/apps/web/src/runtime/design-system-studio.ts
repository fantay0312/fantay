import type { DesignSystemPackageInfo, DesignSystemEditorSaveRequest, DesignSystemEditorSaveResponse, WorkspaceCollabContext } from '@open-design/contracts';
import { designSystemStaticUrl, projectRawUrl } from '../providers/registry';
import { workspaceProjectHeaders } from '../collab/workspace-identity';
import { buildSrcdoc } from './srcdoc';

export function studioTemplateDocument(html:string,title:string):string {
  const doc=new DOMParser().parseFromString(html,'text/html');
  doc.documentElement.lang='zh-CN';doc.title=title;
  const viewport=doc.createElement('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';doc.head.prepend(viewport);
  const tokens=doc.createElement('link');tokens.rel='stylesheet';tokens.href='tokens.css';doc.head.appendChild(tokens);
  return '<!doctype html>\n'+doc.documentElement.outerHTML;
}

/** Resolve package assets before putting authored HTML in an opaque iframe. */
/** Sent by a preview frame so its stage can hug the content. The frame is opaque-origin, so it must speak first. */
export const STUDIO_PREVIEW_HEIGHT_MESSAGE = 'studio-preview-height';
// Besides the page height the frame reports the width it was laid out at, where its ink ends (an entry
// often pads itself to a min-height) and the lines between ink runs where a crop cuts no text or
// control. Ink is text, controls and media as whole boxes (no cut lands inside a select), empty boxes
// that only paint, and the edges of bordered or filled boxes, so a cut may pass between table rows.
// Boxes that touch (a stack of buttons) still leave a clean line where one ends and the next begins.
const REPORT_HEIGHT_SCRIPT = `(function(){var last='',SKIP=/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|BR)$/i,SOLID=/^(INPUT|SELECT|TEXTAREA|BUTTON|IMG|SVG|VIDEO|CANVAS|IFRAME|OBJECT|EMBED|PROGRESS|METER|PICTURE)$/i,CLEAR=/^(transparent|rgba\\([^)]*,\\s*0\\))$/;
function ink(body,height){var spans=[],y=scrollY||0,full=body.getBoundingClientRect().width-1,range=document.createRange(),walker=document.createTreeWalker(body,4),node,seen=0,i,r,list;
while((node=walker.nextNode())&&seen++<4000){var host=node.parentElement;if(!host||SKIP.test(host.tagName)||!/\\S/.test(node.data))continue;range.selectNodeContents(node);list=range.getClientRects();for(i=0;i<list.length;i++){r=list[i];if(r.width>0&&r.height>0)spans.push([r.top+y,r.bottom+y]);}}
var all=body.getElementsByTagName('*');for(i=0;i<all.length&&i<4000;i++){var el=all[i];if(SKIP.test(el.tagName))continue;r=el.getBoundingClientRect();if(!(r.width>0&&r.height>0))continue;
if(SOLID.test(el.tagName)||(!el.firstElementChild&&!/\\S/.test(el.textContent||''))){spans.push([r.top+y,r.bottom+y]);continue;}
var css=getComputedStyle(el),top=css.borderTopStyle==='none'?0:parseFloat(css.borderTopWidth)||0,bottom=css.borderBottomStyle==='none'?0:parseFloat(css.borderBottomWidth)||0;
if(r.width<full&&(css.boxShadow!=='none'||css.backgroundImage!=='none'||!CLEAR.test(css.backgroundColor))){top=Math.max(top,1);bottom=Math.max(bottom,1);}
if(top)spans.push([r.top+y,r.top+y+top]);if(bottom)spans.push([r.bottom+y-bottom,r.bottom+y]);}
if(!spans.length)return{content:height,breaks:[]};spans.sort(function(a,b){return a[0]-b[0];});
var breaks=[],first=spans[0][0],end=spans[0][1];for(i=1;i<spans.length;i++){var s=spans[i],gap=s[0]-end;if(gap>=-0.5&&breaks.length<200)breaks.push(Math.round(gap<2?end:Math.min(end+8,(end+s[0])/2)));if(s[1]>end)end=s[1];}
return{content:Math.min(height,Math.ceil(end+Math.max(0,first))),breaks:breaks};}
function send(){var body=document.body;if(!body)return;var style=getComputedStyle(body);var height=Math.ceil(body.getBoundingClientRect().height+parseFloat(style.marginTop)+parseFloat(style.marginBottom));var found=ink(body,height),width=innerWidth,key=width+'|'+height+'|'+found.content+'|'+found.breaks.join(',');if(key===last)return;last=key;parent.postMessage({type:'${STUDIO_PREVIEW_HEIGHT_MESSAGE}',width:width,height:height,content:found.content,breaks:found.breaks},'*');}
if(typeof ResizeObserver==='function')new ResizeObserver(send).observe(document.body);addEventListener('load',send);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(send);send();})();`;

/** One report from a preview frame. Fields a frame left out fall back to the page height and no breaks. */
export interface StudioPreviewReport { width: number; height: number; content: number; breaks: number[] }

export function readStudioPreviewReport(data: unknown): StudioPreviewReport | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  const height = Number(value.height);
  if (value.type !== STUDIO_PREVIEW_HEIGHT_MESSAGE || !Number.isFinite(height)) return null;
  const width = Number(value.width), content = Number(value.content);
  const breaks = Array.isArray(value.breaks) ? value.breaks.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  return { width: Number.isFinite(width) ? width : 0, height, content: Number.isFinite(content) && content > 0 ? Math.min(content, height) : height, breaks };
}

/** A closed gallery tile: how tall it is, and the smallest scale that still reads as the entry. */
export const STUDIO_TILE_HEIGHT = 168;
export const STUDIO_THUMBNAIL_MIN_SCALE = 0.5;
// A little past the minimum still beats cropping, so a slightly tall entry shrinks instead.
const THUMBNAIL_SHRINK_FLOOR = 0.42;

/** `layout` is the width the frame is laid out at, `scale` maps it into the tile, `clip` ends the picture at a clean line. */
export interface StudioThumbnail { layout: number; scale: number; clip: number | null; settled: boolean }

/**
 * Fit a preview into a tile `box` wide and `tile` tall, whole. Content taller than the tile is laid
 * out wider and scaled down by the same factor, so it still fills the tile's width. The layout only
 * ever widens (a frame that grows after its first report widens it again), so it cannot oscillate.
 * Content that needs less than the minimum scale is cut at the last clean line that fits, and only
 * shrinks further when no such line exists. A report from another width only says the frame has not
 * caught up yet.
 */
export function studioThumbnail(box: number, layout: number, report: StudioPreviewReport | null, tile = STUDIO_TILE_HEIGHT): StudioThumbnail {
  const scale = Math.min(1, box / layout);
  if (!report || (report.width > 0 && Math.abs(report.width - layout) > 1)) return { layout, scale, clip: null, settled: false };
  const content = report.content;
  if (content * scale <= tile) return { layout, scale, clip: null, settled: true };
  const target = Math.max(STUDIO_THUMBNAIL_MIN_SCALE, tile / content);
  const wider = Math.round(box / target);
  if (target < scale && wider > layout + 1) return { layout: wider, scale: target, clip: null, settled: false };
  const shrunk = tile / content;
  if (shrunk >= THUMBNAIL_SHRINK_FLOOR) return { layout, scale: shrunk, clip: null, settled: true };
  const limit = tile / scale;
  const cut = [...report.breaks].reverse().find((at) => at <= limit && at >= limit * 0.6);
  return cut === undefined ? { layout, scale: shrunk, clip: null, settled: true } : { layout, scale, clip: cut, settled: true };
}

export function studioComponentPreview(html: string, css: string, dark: boolean | string, resolveAsset: (path: string) => string, storage?: {generation:string;values:Record<string,string>}, reportHeight = false): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const resolve = (url: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(url) ? url : resolveAsset(url);
  const rewriteCss = (value: string) => value.replace(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi, (_match, url: string) => 'url("' + resolve(url).replace(/"/g, '%22') + '")');
  for (const element of doc.querySelectorAll('[src], [href]')) {
    for (const name of ['src', 'href']) { const value = element.getAttribute(name); if (value) element.setAttribute(name, resolve(value)); }
  }
  for (const element of doc.querySelectorAll('style')) element.textContent = rewriteCss(element.textContent ?? '');
  const style = doc.createElement('style');
  style.textContent = rewriteCss(css);
  doc.head.appendChild(style);
  for (const element of [doc.documentElement, doc.body]) {
    const theme = typeof dark === 'string' ? dark : dark ? 'dark' : 'light';
    element.dataset.theme = theme;
    element.classList.toggle('dark', theme === 'dark');
    element.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
  }
  if (reportHeight) {
    const script = doc.createElement('script');
    script.textContent = REPORT_HEIGHT_SCRIPT;
    doc.body.appendChild(script);
  }
  return buildSrcdoc('<!doctype html>' + doc.documentElement.outerHTML, {previewStorage:Boolean(storage),previewStorageSeed:storage});
}

export function studioFileUrl(id: string, file: string, projectId?: string, context?: WorkspaceCollabContext | null): string {
  return projectId ? projectRawUrl(projectId, file, context) : designSystemStaticUrl(id, file, context);
}

export async function readStudioFile(url: string): Promise<string | null> {
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('SOURCE_READ_FAILED');
  return response.text();
}

export function studioTokenFile(info?: DesignSystemPackageInfo): string {
  return info?.manifest?.files?.tokens || 'tokens.css';
}

export async function saveStudioFile(options: {
  id: string; projectId?: string; path: string; content: string; expected: string | null;
  context?: WorkspaceCollabContext | null;
}): Promise<string> {
  const { id, path, content, expected, context } = options;
  const input: DesignSystemEditorSaveRequest = { path, content, expected };
  const response = await fetch('/api/design-systems/' + encodeURIComponent(id) + '/editor', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(context ? workspaceProjectHeaders(context) : {}) }, body: JSON.stringify(input),
  });
  if (response.status === 409) throw new Error('TOKEN_CONFLICT');
  if (!response.ok) throw new Error('SAVE_FAILED');
  const result = await response.json() as DesignSystemEditorSaveResponse;
  if (!result.projectId || !result.synced.includes(path)) throw new Error('SYNC_FAILED');
  return result.projectId;
}

export interface StudioOverviewBlock { title: string; body: string }
/**
 * The brand book the overview prints under the cover, as Claude Design prints a system's README:
 * DESIGN.md whole, less what the page already shows or keeps for machines — front matter, the H1
 * (the cover names the system), the generated handbook block and the catalogue's Category/Surface lines.
 */
export function brandBookFromMarkdown(body: string): string {
  return body
    .replace(/<!-- fantay-studio-handbook:start -->[\s\S]*?<!-- fantay-studio-handbook:end -->/g, '')
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
    .replace(/^\s*#\s+[^\n]+\n?/, '')
    .split('\n').filter((line) => !/^>\s*(Category|Surface):/i.test(line)).join('\n')
    .trim();
}

export function overviewFromMarkdown(body: string): { intro: string; blocks: StudioOverviewBlock[] } {
  const clean = body.replace(/<!-- fantay-studio-handbook:start -->[\s\S]*?<!-- fantay-studio-handbook:end -->/g, '').replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').replace(/^#\s+[^\n]+\n?/, '').trim();
  const intro = (clean.split(/^#{1,3}\s/m)[0] ?? '').split('\n').filter((line) => !/^>\s*(Category|Surface):/i.test(line)).join('\n').trim();
  const blocks: StudioOverviewBlock[] = [];
  const pattern = /^#{2,3}\s+([^\n]+)\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/gm;
  for (const match of clean.matchAll(pattern)) {
    if (match[1] && /principle|规则|原则|using token|using component|accessib|无障碍|理念|使用/i.test(match[1])) blocks.push({ title: match[1], body: (match[2] ?? '').trim() });
  }
  return { intro, blocks: blocks.slice(0, 6) };
}
