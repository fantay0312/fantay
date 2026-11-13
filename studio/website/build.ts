import { mkdir, writeFile, copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { FANTAY_PRIVACY_SECTIONS, FANTAY_PRIVACY_VERSION } from '../packages/contracts/src/privacy-policy.ts';
import { FANTAY_FEISHU_COMMUNITY_URL } from '../packages/contracts/src/product.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '.tmp/fantay-website');
await rm(out,{recursive:true,force:true});
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const repo = 'https://github.com/fantay0312/fantay';
const shell = (title: string, body: string, script = '') => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Fantay</title><meta name="description" content="Fantay，本地优先的 AI 桌面工作台，支持对话、项目协作、设计和视频创作。"><link rel="icon" href="/assets/brand.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/site.css"></head>
<body><header><a class="brand" href="/"><img src="/assets/brand.svg" alt="" width="28" height="28">Fantay</a><nav aria-label="主导航"><a href="/downloads/">下载</a><a href="/feedback/">反馈</a><a href="/privacy/">隐私</a><a href="${repo}" rel="noopener noreferrer">GitHub ↗</a></nav></header>
<main>${body}</main><footer><span>Fantay</span><a href="/privacy/">隐私说明</a><a href="mailto:support@tokentosea.com">support@tokentosea.com</a><a href="/credits/">开源致谢</a></footer>${script ? `<script src="/assets/${script}" defer></script>` : ''}</body></html>`;
const pages: Record<string,string> = {
  'index.html': shell('让想法成为作品', `<section class="hero"><h1>让想法<br>成为作品。</h1><div class="intro"><p>把素材、设计、AI 对话与视频剪辑放进同一个桌面工作台。<br>从第一笔构思，到可以继续编辑的交付。</p><div class="actions"><a class="button" href="/downloads/">获取 Fantay <span>↗</span></a><a class="text-link" href="/feedback/">联系与反馈 →</a></div><p class="small">本地优先 · TokenToSea 与自带密钥 · 自动统计关闭</p></div></section><section class="features"><article><span>设计</span><h2>让素材进入创作</h2><p>在素材库中组织灵感，在画布中编辑作品。已有项目与本地文件由你管理。</p></article><article><span>视频</span><h2>AI 与手动编辑同行</h2><p>分镜、素材、字幕、音频与时间线，在同一项目里逐步完成。</p></article><article><span>选择</span><h2>工具服务于你的方式</h2><p>继续使用 TokenToSea，或连接自己的密钥与本机工具。需要诊断时，由你主动导出。</p></article></section><section class="closing"><h2>你的工作台，你的创作。</h2><p>Fantay 保留开源组件的许可与来源。源码将由维护者发布到自有 GitHub 仓库。</p><a class="text-link" href="${repo}">访问项目仓库 ↗</a></section>`),
  'privacy/index.html': shell('隐私说明', `<article class="document"><h1>隐私说明</h1><p class="small">版本日期：${FANTAY_PRIVACY_VERSION}</p>${FANTAY_PRIVACY_SECTIONS.map(s=>`<section><h2>${escape(s.title)}</h2>${s.paragraphs.map(p=>`<p>${escape(p)}</p>`).join('')}</section>`).join('')}</article>`),
  'feedback/index.html': shell('问题反馈', `<article class="document"><h1>把问题告诉我们。</h1><p>描述发生了什么、你希望得到什么结果，以及应用版本和系统。不要提交密钥或私密项目。</p><form id="feedback-form"><label for="category">反馈类型</label><select id="category"><option>功能问题</option><option>功能建议</option><option>隐私与数据请求</option></select><label for="subject">标题</label><input id="subject" required maxlength="160" placeholder="例如：导出视频时没有声音"><label for="details">问题描述</label><textarea id="details" rows="8" required maxlength="6000" placeholder="复现步骤、预期结果、实际结果、应用版本、操作系统"></textarea><p class="small">点击后打开你的邮件客户端，确认内容后再发送。此页面不上传表单或诊断文件；如需附件，请在邮件中自行添加。</p><button class="button" type="submit">打开邮件草稿 ↗</button><p id="feedback-status" role="status"></p></form><p>也可以加入 <a href="${FANTAY_FEISHU_COMMUNITY_URL}" rel="noopener noreferrer">FantayAI 飞书群</a>，或直接联系 <a href="mailto:support@tokentosea.com">support@tokentosea.com</a>。公开源码后，可使用 <a href="${repo}/issues">GitHub Issues</a> 反馈。</p></article>`, 'feedback.js'),
  'downloads/index.html': shell('下载', `<article class="document"><h1>开始下一件作品。</h1><p>正式安装包将在版本发布后提供。下载请认准本站与 <a href="${repo}/releases">Fantay GitHub Releases</a>。</p><div id="release-downloads" aria-live="polite"><p>尚未发布可下载的正式安装包。</p></div><section id="clipper"><h2>Fantay Web Clipper</h2><p>保存网页素材到本地素材库。当前提供开发者安装包，解压后在浏览器扩展页选择“加载已解压的扩展程序”，并选中其中的 clipper 文件夹。安装后可访问网页内容，仅在你主动采集时写入本地应用。</p><a class="text-link" href="/downloads/Fantay-Clipper.zip">下载扩展 ZIP ↓</a></section><section><h2>Fantay Figma Import</h2><p>将 Clipper 导出的结构化 JSON 导入 Figma。解压后，通过 Figma 的开发插件菜单导入 figma-plugin 文件夹中的 manifest.json。</p><a class="text-link" href="/downloads/Fantay-Figma-Import.zip">下载 Figma 插件 ZIP ↓</a></section></article>`, 'downloads.js'),
  'credits/index.html': shell('开源致谢', `<article class="document"><h1>开源致谢</h1><p>Fantay 在 OpenDesign 及其他开源项目的基础上开发。上游作者的贡献、版权及原始许可证继续保留。</p><p><a href="https://github.com/nexu-io/open-design" rel="noopener noreferrer">OpenDesign 上游项目 ↗</a></p><p><a href="/credits/LICENSE.txt">原始许可证</a> · <a href="/credits/THIRD_PARTY_NOTICES.txt">第三方声明</a></p></article>`),
};
const pluginLinks: string[] = [];
async function pluginPages(dir: string): Promise<void> {
  const entries=await readdir(dir,{withFileTypes:true});
  if (entries.some(e=>e.name==='open-design.json')) {
    const manifest=JSON.parse(await readFile(resolve(dir,'open-design.json'),'utf8'));
    const name=String(manifest.name || basename(dir));
    const slug=name.split('/').at(-1)!.toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'') || 'plugin';
    const title=String(manifest.title || name);
    const description=String(manifest.description || '此插件随 Fantay 提供。');
    const url='/plugins/'+slug+'/';
    pages['plugins/'+slug+'/index.html']=shell(title,`<article class="document"><a href="/plugins/">← 插件目录</a><h1>${escape(title)}</h1><p>${escape(description)}</p><p class="small">${escape(name)} · ${escape(String(manifest.version || ''))}</p><p>请在 Fantay 桌面应用的插件页中查看、启用和使用。内置插件随软件更新。</p><p>原作者、项目来源和许可证见随包插件说明及<a href="/credits/">第三方声明</a>。自有源码仓库公开后，可通过 <a href="${repo}">Fantay GitHub</a> 查看发行版。</p></article>`);
    pluginLinks.push(`<p><a href="${url}">${escape(title)}</a> <span class="small">${escape(name)}</span></p>`);
  }
  for (const entry of entries) if(entry.isDirectory()) await pluginPages(resolve(dir,entry.name));
}
await pluginPages(resolve(root,'plugins/_official'));
pages['plugins/index.html']=shell('内置插件',`<article class="document"><h1>内置插件</h1><p>随 Fantay 提供的插件目录。使用方式与原作者说明请在桌面应用中查看。</p>${pluginLinks.sort().join('')}</article>`);
await mkdir(resolve(out,'assets'),{recursive:true});
for (const [name,content] of Object.entries(pages)) { await mkdir(dirname(resolve(out,name)),{recursive:true}); await writeFile(resolve(out,name),content); }
for (const name of ['site.css','feedback.ts','downloads.ts']) await copyFile(resolve(root,'website',name),resolve(out,'assets',name.replace(/\.ts$/,'.js')));
await copyFile(resolve(root,'apps/web/public/brand-icon.svg'),resolve(out,'assets/brand.svg'));
await copyFile(resolve(root,'apps/web/public/fonts/AlbertSans-VariableFont_wght.ttf'),resolve(out,'assets/albert-sans.ttf'));
for (const name of ['LICENSE','THIRD_PARTY_NOTICES.md']) await writeFile(resolve(out,'credits',name === 'LICENSE' ? 'LICENSE.txt':'THIRD_PARTY_NOTICES.txt'),await readFile(resolve(root,name)));
const JSZip=createRequire(resolve(root,'packages/diagnostics/package.json'))('jszip');
for (const [folder,archive] of [['clipper','Clipper'],['figma-plugin','Figma-Import']]) {
  const zip=new JSZip();
  async function addFiles(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      if (entry.name.startsWith('.') || entry.name==='store') continue;
      const path=resolve(directory,entry.name), name=prefix+'/'+entry.name;
      if(entry.isDirectory()) await addFiles(path,name);
      else if(entry.isFile()) zip.file(name,await readFile(path));
    }
  }
  await addFiles(resolve(root,folder!),folder!);
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])zip.file(folder+'/'+name,await readFile(resolve(root,name)));
  const archivePath = resolve(out, 'downloads', `Fantay-${archive}.zip`);
  await writeFile(archivePath, await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
  // Keep previously shared download URLs usable.
  await copyFile(archivePath, resolve(out, 'downloads', `FantayDesign-${archive}.zip`));
}
const markdown = '# Fantay 隐私说明\n\n版本日期：'+FANTAY_PRIVACY_VERSION+'\n\n'+FANTAY_PRIVACY_SECTIONS.map(s=>'## '+s.title+'\n\n'+s.paragraphs.join('\n\n')).join('\n\n')+'\n';
await writeFile(resolve(root,'PRIVACY.md'),markdown);
console.log(out);
