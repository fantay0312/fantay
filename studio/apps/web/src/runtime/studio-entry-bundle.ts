import type { StudioLibraryEntry } from '@open-design/contracts';

export interface StudioEntryBundle { html: string; localResources: string[]; externalResources: string[] }
export type StudioResourceReader = ((path: string) => Promise<Blob>) & { licenses?: string[] };

function assertPortableScript(text:string,label:string):void{
  const imports=/\b(?:import|export)\s*(?:[\w*{},\s]+?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;
  for(const match of text.matchAll(imports)){const source=match[1]??match[2]??'';if(!/^(https?:|data:)/.test(source))throw new Error('请先构建带模块依赖的脚本：'+label+' → '+source);}
}

export function resolveStudioResource(raw: string, from = 'index.html'): { path: string; hash: string } | null {
  const value = raw.trim();
  if (!value || value.startsWith('#') || /^data:/i.test(value)) return null;
  if (/^blob:/i.test(value)) throw new Error('临时 blob 资源不能复用，请先上传原文件。');
  if (/^(https?:)?\/\//i.test(value)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) throw new Error('不支持的资源地址：' + value);
  const parts = value.startsWith('/') ? [] : from.split('/').slice(0, -1);
  const pathOnly = value.split(/[?#]/)[0] ?? '';
  for (const part of pathOnly.split('/')) {
    const decoded = decodeURIComponent(part);
    if (!decoded || decoded === '.') continue;
    if (decoded === '..') { if (!parts.length) throw new Error('资源超出设计包：' + raw); parts.pop(); }
    else { if (decoded.startsWith('.') || /[\\\u0000]/.test(decoded)) throw new Error('不支持的资源路径：' + raw); parts.push(decoded); }
  }
  const path = parts.join('/');
  if (!/\.(css|m?js|json|svg|png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|ogg)$/i.test(path)) throw new Error('不能打包此资源类型：' + path);
  return { path, hash: value.includes('#') ? '#' + value.split('#').slice(1).join('#') : '' };
}

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取资源失败'));
    reader.readAsDataURL(blob);
  });
}
function asText(blob:Blob):Promise<string>{
  if(typeof blob.text==='function')return blob.text();
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('读取文本资源失败'));reader.readAsText(blob);});
}

/** One packaging path for previews, copy, HTML download and project reuse. */
export async function bundleStudioEntry(entry: StudioLibraryEntry, css: string, read: StudioResourceReader): Promise<StudioEntryBundle> {
  const local = new Set<string>(), external = new Set<string>();
  const cache = new Map<string, Promise<string>>();
  async function rewriteReference(raw: string, from: string, chain: string[] = []): Promise<string> {
    if (/^(https?:)?\/\//i.test(raw.trim())) { external.add(raw); return raw; }
    const resource = resolveStudioResource(raw, from);
    if (!resource) return raw;
    if (chain.includes(resource.path)) throw new Error('循环资源引用：' + resource.path);
    let promise = cache.get(resource.path);
    if (!promise) {
      promise = (async () => {
        local.add(resource.path);
        let blob: Blob;
        try { blob = await read(resource.path); } catch { throw new Error('缺少资源：' + resource.path + '。请上传资源后重试。'); }
        if(!blob.type||blob.type==='application/octet-stream'){
          const extension=resource.path.split('.').pop()?.toLowerCase()??'';
          const mime:Record<string,string>={ttf:'font/ttf',otf:'font/otf',woff:'font/woff',woff2:'font/woff2',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',avif:'image/avif',mp4:'video/mp4',webm:'video/webm'};
          if(mime[extension])blob=new Blob([blob],{type:mime[extension]});
        }
        if (/\.css$/i.test(resource.path)) {
          const text = await asText(blob);
          return asDataUrl(new Blob([await rewriteCss(text, resource.path, [...chain, resource.path])], { type: 'text/css' }));
        }
        if (/\.m?js$/i.test(resource.path)) {
          const text = await asText(blob);
          assertPortableScript(text,resource.path);
          return asDataUrl(new Blob([text], { type: 'text/javascript' }));
        }
        return asDataUrl(blob);
      })();
      cache.set(resource.path, promise);
    }
    return await promise + resource.hash;
  }
  async function rewriteCss(text: string, from: string, chain: string[] = []): Promise<string> {
    const pattern = /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/gi;
    let result = '', end = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index!; result += text.slice(end, start);
      const url = await rewriteReference(match[2] ?? match[4] ?? '', from, chain);
      result += match[4] ? '@import url("' + url + '")' : 'url("' + url + '")';
      end = start + match[0].length;
    }
    return result + text.slice(end);
  }
  const doc = new DOMParser().parseFromString(entry.html, 'text/html');
  for(const script of doc.querySelectorAll('script:not([src])'))assertPortableScript(script.textContent??'','inline script');
  doc.documentElement.lang ||= 'zh-CN'; doc.title = entry.name;
  for (const element of doc.querySelectorAll('[src],[poster],link[rel="stylesheet"][href],link[rel="icon"][href],use[href]')) {
    for (const attr of ['src', 'poster', 'href']) {
      const value = element.getAttribute(attr); if (value) element.setAttribute(attr, await rewriteReference(value, 'index.html'));
    }
  }
  for (const element of doc.querySelectorAll('[srcset]')) {
    const value = element.getAttribute('srcset') ?? '';
    if (/^data:/i.test(value.trim())) continue;
    const candidates = value.split(',').map(part => part.trim()).filter(Boolean);
    element.setAttribute('srcset', (await Promise.all(candidates.map(async candidate => {
      const [url, ...descriptor] = candidate.split(/\s+/);
      return await rewriteReference(url ?? '', 'index.html') + (descriptor.length ? ' ' + descriptor.join(' ') : '');
    }))).join(', '));
  }
  for (const element of doc.querySelectorAll('[style]')) element.setAttribute('style', await rewriteCss(element.getAttribute('style') ?? '', 'index.html'));
  for (const element of doc.querySelectorAll('style')) element.textContent = await rewriteCss(element.textContent ?? '', 'index.html');
  const tokens = doc.createElement('style'); tokens.setAttribute('data-design-tokens', ''); tokens.textContent = await rewriteCss(css, 'tokens.css'); doc.head.appendChild(tokens);
  if (!doc.querySelector('meta[name="viewport"]')) { const viewport = doc.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1'; doc.head.prepend(viewport); }
  for (const dependency of entry.dependencies ?? []) {
    const resource=resolveStudioResource(dependency);
    if(resource&&!local.has(resource.path))throw new Error('额外依赖未被 HTML/CSS 静态引用：'+dependency+'。请先构建动态资源，再复用。');
  }
  const licenses:Record<string,string>={};
  for(const file of read.licenses??[]){
    if(!/^(?:fonts|assets|logos|imagery)\/[^.][\w/.-]*\/(?:OFL|LICENSE|COPYING)(?:\.txt|\.md)?$/i.test(file)&&!/^(?:fonts|assets|logos|imagery)\/(?:OFL|LICENSE|COPYING)(?:\.txt|\.md)?$/i.test(file))continue;
    if(file.split('/').some(part=>part==='..'||part.startsWith('.')))continue;
    licenses[file]=await asText(await read(file));local.add(file);
  }
  if(Object.keys(licenses).length){const license=doc.createElement('script');license.type='application/json';license.setAttribute('data-asset-licenses','');license.textContent=JSON.stringify(licenses).replace(/</g,'\\u003c');doc.head.appendChild(license);}
  return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, localResources: [...local], externalResources: [...external] };
}
