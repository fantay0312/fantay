import { emptyStudioDocument, parseStudioTokens, type StudioDocument, type StudioLibraryEntry } from '@open-design/contracts';
import { enhanceStudioCatalog } from './studio-catalog-starter';
import { studioGroupNames } from './studio-catalog';

const frame = '<style>*{box-sizing:border-box}body{padding:24px;margin:0;background:var(--bg,#fafaf8);color:var(--fg,#202020);font:var(--text-base,16px)/1.6 var(--font-body,Arial,sans-serif)}button,input,select,textarea{font:inherit}button{border:1px solid var(--border,#ddd);border-radius:var(--radius-sm,6px);padding:8px 16px;background:var(--surface,#fff);color:var(--fg,#202020);cursor:pointer}button.primary{background:var(--accent,#353535);color:var(--accent-on,#fff)}button.danger{color:var(--danger,#b4382e)}button:disabled{opacity:.45;cursor:not-allowed}button:hover:not(:disabled){filter:brightness(.94)}:focus-visible,.focus{outline:2px solid var(--link,#275e91);outline-offset:3px}input,select,textarea{padding:9px 12px;background:var(--surface,#fff);color:var(--fg,#202020);border:1px solid var(--border,#ddd);border-radius:var(--radius-sm,6px)}label{display:grid;gap:6px;margin-bottom:14px}input[type=checkbox]{accent-color:var(--accent,#353535)}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.stack{display:grid;gap:12px}.muted{color:var(--muted,#62625e);font-size:.9em}.error{color:var(--danger,#b4382e)}.card{padding:20px;border:1px solid var(--border,#ddd);border-radius:var(--radius-md,12px);background:var(--surface,#fff)}h2,h3,p{margin:0 0 12px}h2{font:400 28px/1.2 var(--font-display,Georgia,serif)}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid var(--border,#ddd)}dialog{background:var(--surface,#fff);color:var(--fg,#202020);border:1px solid var(--border,#ddd);border-radius:12px;padding:24px;max-width:350px}dialog::backdrop{background:#0005}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}</style>';
function entry(name:string,description:string,html:string,usage:string,avoid:string,api:string,variants=['default'],states=['default','hover','focus','disabled']):StudioLibraryEntry {
  return {id:name.toLowerCase().replace(/[^a-z0-9]+/g,'-'),name,description,status:'draft',html:frame+html,usage,avoid,api,variants,states,accessibility:'使用语义 HTML；键盘可达，焦点可见；图标操作提供可访问名称；信息不只依赖颜色。具体实现需在实际页面中再验收。'};
}
/**
 * Line length for Chinese, sizes and proportions. `ic` is the advance of 水, so 36ic holds about 36
 * characters (WCAG 1.4.8 suggests at most 40 CJK glyphs a line); 24px is the WCAG 2.5.8 AA target.
 */
const SIZING_TOKENS:Record<string,string>={'--measure-prose':'65ch','--measure-narrow':'42ch','--measure-cjk':'36ic','--icon-size-sm':'16px','--icon-size-md':'20px','--icon-size-lg':'24px','--control-height-sm':'32px','--control-height-md':'40px','--control-height-lg':'48px','--target-min':'24px','--target-comfort':'44px','--aspect-square':'1 / 1','--aspect-photo':'3 / 2','--aspect-video':'16 / 9','--aspect-portrait':'3 / 4'};
const SIZING_NOTES:Record<string,[string,string]>={'--measure-prose':['行宽 Measure','长文正文的最大行宽，约 65 个西文字符'],'--measure-narrow':['行宽 Measure','表单、对话框、卡片摘要的最大行宽'],'--measure-cjk':['行宽 Measure','中文正文的最大行宽，约 36 个汉字（WCAG 建议每行不超过 40 字）'],'--icon-size-sm':['尺寸 Sizing','小图标，配 14px 文字'],'--icon-size-md':['尺寸 Sizing','常规图标，配正文'],'--icon-size-lg':['尺寸 Sizing','大图标与独立出现的图标'],'--control-height-sm':['尺寸 Sizing','紧凑控件的高度'],'--control-height-md':['尺寸 Sizing','按钮、输入框的默认高度'],'--control-height-lg':['尺寸 Sizing','主要入口与触屏优先的控件'],'--target-min':['尺寸 Sizing','可点击目标的最小尺寸（WCAG 2.5.8 AA：24×24 CSS px）'],'--target-comfort':['尺寸 Sizing','常用操作与触屏的舒适点击尺寸'],'--aspect-square':['比例 Ratio','头像、图标底板、方形缩略图'],'--aspect-photo':['比例 Ratio','照片与作品图'],'--aspect-video':['比例 Ratio','视频与宽幅封面'],'--aspect-portrait':['比例 Ratio','竖版海报与人物图']};
/**
 * Adds the measure and sizing tokens a system does not declare anywhere yet, leaving everything else
 * as written. A name declared in any scope counts: an appended :root rule would override it.
 */
export function completeSizingCss(css:string):string {
  const declared=new Set(parseStudioTokens(css).map(token=>token.name));
  const lines=Object.entries(SIZING_TOKENS).filter(([name])=>!declared.has(name)).map(([name,value])=>'  '+name+': '+value+';');
  return lines.length?css.trimEnd()+'\n\n:root {\n'+lines.join('\n')+'\n}\n':css;
}
export function completeFoundationCss(css:string):string {
  const declared = new Set(parseStudioTokens(css).filter(token=>token.scope===':root').map(token=>token.name));
  const values:Record<string,string>={'--base-white':'#ffffff','--base-ink':'#202020','--bg':'var(--color-paper, #fafaf8)','--surface':'#ffffff','--fg':'var(--color-ink, #202020)','--muted':'#62625e','--accent':'#353535','--accent-on':'#ffffff','--border':'#d8d8d2','--danger':'#b4382e','--success':'#2a6941','--link':'#275e91','--font-display':'Georgia, serif','--font-body':'Arial, sans-serif','--text-base':'16px','--space-1':'4px','--space-2':'8px','--space-3':'12px','--space-4':'16px','--space-6':'24px','--space-8':'32px','--radius-sm':'6px','--radius-md':'12px','--shadow-float':'0 8px 28px rgb(0 0 0 / .12)','--motion-fast':'140ms','--motion-base':'200ms','--motion-slow':'320ms','--ease-standard':'cubic-bezier(0.23, 1, 0.32, 1)','--breakpoint-sm':'640px','--breakpoint-md':'960px','--breakpoint-lg':'1280px','--container-max':'72rem','--grid-columns':'12','--grid-gutter':'24px',...SIZING_TOKENS,'--z-base':'0','--z-menu':'10','--z-dialog':'100','--z-toast':'200'};
  const lines=Object.entries(values).filter(([name])=>!declared.has(name)).map(([name,value])=>'  '+name+': '+value+';');
  let result=css+(lines.length?'\n\n:root {\n'+lines.join('\n')+'\n}\n':'');
  if(!css.includes('[data-theme="dark"]'))result+='\n[data-theme="dark"] { --bg: #181916; --surface: #252621; --fg: #f6f5ed; --muted: #bbbdb2; --accent: #e8eadf; --accent-on: #20211c; --border: #56594d; --danger: #ff9a8e; --success: #91cfaa; --link: #a6c9f6; }\n';
  // Semantic values stay complete even when a system already has a dark base palette.
  else if(!parseStudioTokens(css).some(token=>token.scope.includes('dark')&&token.name==='--fg')) result+='\n[data-theme="dark"] { --bg: #181916; --surface: #252621; --fg: #f6f5ed; --muted: #bbbdb2; --accent: #e8eadf; --accent-on: #20211c; --border: #56594d; --danger: #ff9a8e; --success: #91cfaa; --link: #a6c9f6; }\n';
  if(!css.includes('[data-theme="contrast"]'))result+='\n[data-theme="contrast"] { --bg: #ffffff; --surface: #ffffff; --fg: #000000; --muted: #303030; --accent: #000000; --accent-on: #ffffff; --border: #000000; --danger: #a00000; --success: #005000; --link: #0000a0; }\n';
  return result;
}
// Each rule is one instruction and its reason: the reason is what lets an agent decide a case no rule names.
const STARTER_RULES:[string,string,string][]=[
  ['one-primary-action','每个区域只放一个主要操作。','都重要，就都不重要。'],
  ['tokens-not-raw-values','颜色、间距、圆角、阴影只用设计变量，文字只用已定义的字阶，不写裸值。','裸值不会跟着主题和统一调整一起变，改版时总有漏网的地方。'],
  ['status-colours-mean-status','红、黄、绿只表达真实状态，不做装饰。','装饰也用状态色，用户就分不清哪一处真的出了问题。'],
  ['not-colour-alone','状态同时用文字或图标表达，不只靠颜色。','色弱用户和灰度显示看不出颜色差别。'],
  ['loading-empty-error','会加载数据的区块都要有加载、空、出错三种状态。','真实数据总会慢、会空、会失败，只设计理想状态的页面一上线就会露出空白。'],
  ['honest-status-text','状态文案与真实状态一致，事情没完成就不说完成。','界面先说完成、结果却失败一次，用户就不再相信界面上的状态。'],
  ['measure','长文正文的行宽不超过 --measure-prose，中文正文用 --measure-cjk。','行太长，眼睛换行时找不到下一行。'],
  ['target-size','可点击目标不小于 --target-min，常用操作用 --target-comfort。','目标太小容易点错，触屏上尤其明显。'],
  ['use-what-exists','只用体系里已有的组件和图标；缺的先补进设计体系，再拿来用。','页面里临时画的组件和图标会各成一套，体系就失去了统一的意义。'],
];
const STARTER_REVIEW=['标出所有没有引用设计变量或字阶的裸值：颜色、间距、圆角、阴影、字号。','检查每个会加载数据的区块都有加载、空、出错三种状态。','检查状态文案与真实运行状态一致。','确认每个区域只有一个主要操作。','只用键盘走完主要流程，焦点始终可见。','检查正文行宽和点击目标符合 --measure-* 与 --target-* 变量。'];
const STARTER_CONTENT_ADDITIONS='## 错误提示\n写清发生了什么、用户可以怎么做；原因能帮用户判断时再补上。例如「暂时无法保存：网络已断开。你的编辑仍保留，联网后重试。」\n\n## 数字、日期与单位\n数字用阿拉伯数字，四位以上加千位分隔（12,800）。日期写作「2026 年 11 月 3 日」，同一页内格式一致。数字与英文单位之间加空格（16 GB），百分号和度数不加（15%、30°）。';
const STARTER_BRAND='## 资产目录\n品牌文件放在 assets/<分组>/ 下，第一层文件夹就是分组，例如 assets/Logos/、assets/Icons/、assets/Imagery/。在设计体系页上传的文件进入 assets/studio/，显示为「上传」。\n\n## 标志\n保留原始比例、最小可读尺寸和安全留白。写明深色底和浅色底各用哪个版本。不要擅自拉伸、描边、加阴影或改色。\n\n## 图标\n- 同一界面只用一个图标家族，线宽和圆角一致。\n- 尺寸用 --icon-size-sm（16px，配 14px 文字）、--icon-size-md（20px）、--icon-size-lg（24px）；在 24px 画布上四周留 2px。\n- 线宽随尺寸变化：24px 用 1.5–2px，16px 用 1–1.25px。\n- 装饰性图标加 aria-hidden="true"；纯图标按钮必须有可访问名称，点击区域不小于 --target-min。\n- 表达含义的图标与背景的对比度至少 3:1。\n\n## 图片与插画\n优先真实、有用途的内容。按 --aspect-* 统一裁切比例，色调一致，提供替代文本；装饰图片使用空替代文本。插画用于空状态与引导，配合文案，不替代文案。';
// The starter components grouped by job, as shadcn/ui groups its set. Only groups something is in are
// listed; the rest stay suggestions in the editor until the user puts an entry there.
const STARTER_GROUPS:Record<string,string>={button:'操作',textfield:'输入',select:'输入',checkbox:'输入',dialog:'浮层',tabs:'导航',card:'布局',toast:'反馈'};
const STARTER_GROUP_ORDER=['操作','输入','浮层','导航','布局','数据','反馈','智能体与聊天'];
const usedStarterGroups=(components:StudioLibraryEntry[])=>STARTER_GROUP_ORDER.filter(name=>components.some(entry=>entry.group===name));
// The component contract: the variant to reach for first (only where the shipped catalogue offers a
// real choice, see enhanceStudioCatalog), and one good and one bad example from real code.
const STARTER_CONTRACTS:Record<string,Pick<StudioLibraryEntry,'defaultVariant'|'good'|'bad'>>={
  button:{defaultVariant:'secondary',good:'<button class="primary" type="submit">保存更改</button>\n<button type="button">取消</button>',bad:'<!-- 用 div 冒充按钮，键盘按不到；「点这里」不说明结果 -->\n<div class="primary" onclick="save()">点这里</div>'},
  textfield:{defaultVariant:'text',good:'<label>电子邮箱<input type="email" autocomplete="email" aria-describedby="email-hint"></label>\n<p id="email-hint" class="muted">用于接收项目通知。</p>',bad:'<!-- 占位符代替标签：一开始输入，用户就看不到要填什么 -->\n<input type="email" placeholder="电子邮箱">'},
  select:{good:'<label>内容语言<select><option>简体中文</option><option>English</option></select></label>',bad:'<!-- 用下拉框做导航：选中即跳转，键盘浏览选项时也会跳走 -->\n<select onchange="location.href=this.value"><option value="/projects">项目</option><option value="/settings">设置</option></select>'},
  checkbox:{good:'<label class="row"><input type="checkbox"> 接收项目更新</label>',bad:'<!-- 标签没有关联控件：点文字不会勾选，读屏也念不出名称 -->\n<input type="checkbox"> <span>接收项目更新</span>'},
  dialog:{good:'<!-- 关闭后读 dialog.returnValue，判断用户选了哪一项 -->\n<dialog aria-labelledby="leave-title">\n  <h3 id="leave-title">离开编辑页面？</h3>\n  <p>未保存的修改会保留为本地草稿。</p>\n  <form method="dialog" class="row"><button value="stay">继续编辑</button><button class="primary" value="leave">离开</button></form>\n</dialog>',bad:'<!-- 没有对话框语义，焦点不进不出；「确定」不说明会发生什么 -->\n<div class="modal"><p>确定吗？</p><button>确定</button><button>取消</button></div>'},
  toast:{defaultVariant:'info',good:'<div role="status" aria-live="polite">草稿已保存。<button type="button">撤销</button></div>',bad:'<!-- 需要用户处理的错误只在提示里闪过，没有恢复入口 -->\n<div class="toast error">保存失败</div>'},
  tabs:{good:'<div role="tablist" aria-label="项目视图">\n  <button role="tab" id="tab-overview" aria-selected="true" aria-controls="panel-overview">概览</button>\n  <button role="tab" id="tab-changes" aria-selected="false" tabindex="-1" aria-controls="panel-changes">变更</button>\n</div>\n<div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview">…</div>\n<div id="panel-changes" role="tabpanel" aria-labelledby="tab-changes" hidden>…</div>',bad:'<!-- 跨页面导航做成标签页样式：用户以为留在原页，其实已经离开 -->\n<div class="tabs"><a href="/settings">设置</a><a href="/billing">账单</a></div>'},
  card:{good:'<article class="card">\n  <h3>个人作品集</h3>\n  <p class="muted">最近更新 · 今天</p>\n  <button type="button">查看项目</button>\n</article>',bad:'<!-- 卡片套卡片：层级被边框淹没，读不出哪层是对象 -->\n<div class="card"><div class="card"><div class="card">个人作品集</div></div></div>'},
};

export function legacyStarterStudioDocument():StudioDocument {
  const doc=emptyStudioDocument();
  doc.themes=[{name:'浅色 Light',selector:':root',description:'默认工作主题。'},{name:'深色 Dark',selector:'[data-theme="dark"]',description:'低照度环境；在实际页面中验证所有组合。'},{name:'高对比 Contrast',selector:'[data-theme="contrast"]',description:'增强文字、边框和操作的区分度。'}];
  for(const name of ['--bg','--surface','--fg','--muted','--accent','--accent-on','--border','--danger','--success','--link'])doc.tokenNotes[name]={group:'语义颜色 Semantic',layer:'semantic',description:({'--bg':'页面背景','--surface':'内容表面','--fg':'主要文字','--muted':'次要文字','--accent':'主要操作','--accent-on':'主要操作上的文字','--border':'边界与分割线','--danger':'错误与危险操作','--success':'完成与成功','--link':'链接与焦点'})[name]||''};
  for(const [name,[group,description]] of Object.entries(SIZING_NOTES))doc.tokenNotes[name]={group,layer:'semantic',description};
  doc.typeStyles=[['display','展示标题','Georgia, serif','44px','400','1.15'],['heading','页面标题','Georgia, serif','32px','400','1.25'],['body','正文','Arial, sans-serif','16px','400','1.65'],['label','控件标签','Arial, sans-serif','14px','600','1.4'],['caption','辅助说明','Arial, sans-serif','12px','400','1.5'],['code','代码','ui-monospace, monospace','13px','400','1.6']].map(([id,name,family,size,weight,lineHeight])=>({id:id!,name:name!,group:id==='display'||id==='heading'?'标题':'界面',family:family!,size:size!,weight:weight!,lineHeight:lineHeight!,letterSpacing:'0',description:'按信息层级使用，避免仅靠字号表达状态。'}));
  doc.components=[
    entry('Button','明确、可预期的动作入口。','<div class="row"><button class="primary">保存更改</button><button>取消</button><button class="danger">删除</button><button class="focus">焦点状态</button><button disabled>不可用</button><button aria-busy="true">正在保存…</button></div>','每个区域保留一个主要操作；用动词描述结果。','不要把链接伪装成按钮；不要只用图标表达危险动作。','| 属性 | 类型 | 说明 |\n|---|---|---|\n| variant | primary / secondary / danger | 视觉重要性 |\n| disabled | boolean | 不可用 |\n| loading | boolean | 操作进行中 |',['primary','secondary','danger','icon'],['default','hover','focus','disabled','loading','error']),
    entry('TextField','带标签、说明和错误反馈的输入。','<label>项目名称<input placeholder="例如：个人作品集"></label><label>电子邮箱<input type="email" aria-invalid="true" aria-describedby="email-error" style="border-color:var(--danger)" value="example"></label><p id="email-error" class="error">请填写完整的邮箱地址。</p>','标签始终可见；错误说明放在相应字段附近。','不要用占位符替代标签；不要在用户尚未输入时显示错误。','| 属性 | 类型 | 说明 |\n|---|---|---|\n| label | string | 永久标签 |\n| error | string | 错误说明 |\n| required | boolean | 必填语义 |',['text','email','password','multiline'],['empty','filled','hover','focus','disabled','error']),
    entry('Select','在有限的已知选项中选择。','<label>内容语言<select><option>简体中文</option><option>English</option><option>繁體中文</option></select></label><label>不可用<select disabled><option>请先选择工作区</option></select></label>','选项超过少量并且必须单选时使用。','不要用于导航；少于三个选项优先考虑单选按钮。','label: string\noptions: {value,label}[]\nvalue: string\ndisabled: boolean',['single','disabled']),
    entry('Checkbox','多个独立开关或多选。','<div class="stack"><label class="row"><input type="checkbox" checked>接收项目更新</label><label class="row"><input type="checkbox">公开显示个人资料</label><label class="row"><input type="checkbox" disabled>由管理员管理</label></div>','用于可独立选择的选项；标签点击区域与控件连在一起。','互斥选择应使用单选；不能只靠勾选框确认危险操作。','checked: boolean\nindeterminate: boolean\nlabel: string\nonChange(checked)',['checked','unchecked','indeterminate'],['default','hover','focus','disabled','error']),
    entry('Dialog','需要集中注意力的短任务。','<button onclick="document.getElementById(\'demo-dialog\').showModal()">打开确认对话框</button><dialog id="demo-dialog"><h3>离开编辑页面？</h3><p>未保存的修改会保留为本地草稿。</p><form method="dialog" class="row"><button>继续编辑</button><button class="primary">离开</button></form></dialog>','用于确认、短表单或必须做出的选择；关闭后归还焦点。','不要嵌套对话框；不要把完整页面塞进弹层。','open: boolean\ntitle: string\nonClose(): void\ninitialFocus: HTMLElement',['confirmation','form'],['open','closed','loading','error']),
    entry('Toast','轻量的操作结果反馈。','<button onclick="document.getElementById(\'toast\').hidden=false">显示保存反馈</button><div id="toast" role="status" aria-live="polite" class="card" hidden style="margin-top:20px">草稿已保存。<button onclick="this.parentElement.hidden=true" aria-label="关闭提示" style="float:right">关闭</button></div>','用于不阻塞下一步的结果；为需要恢复的动作提供撤销入口。','重要错误不能只短暂出现；不要重复播报同一条信息。','message: string\nintent: info / success / error\naction?: {label,onClick}',['info','success','error'],['visible','dismissed']),
    entry('Tabs','在同一上下文中切换视图。','<div role="tablist" class="row"><button role="tab" aria-selected="true" onclick="document.getElementById(\'tab-panel\').textContent=\'这里是概览内容。\';this.setAttribute(\'aria-selected\',\'true\');this.nextElementSibling.setAttribute(\'aria-selected\',\'false\')">概览</button><button role="tab" aria-selected="false" onclick="document.getElementById(\'tab-panel\').textContent=\'这里是变更记录。\';this.setAttribute(\'aria-selected\',\'true\');this.previousElementSibling.setAttribute(\'aria-selected\',\'false\')">变更</button></div><div id="tab-panel" role="tabpanel" class="card" style="margin-top:16px">这里是概览内容。</div>','视图属于同一个对象时使用；保持标签顺序稳定。','跨页面主导航应使用链接；不要隐藏完成任务必读的信息。','items: {id,label,panel}[]\nactiveId: string\nonChange(id)',['horizontal'],['default','hover','focus','selected','disabled']),
    entry('Card','将一个对象的信息与动作组织在一起。','<article class="card"><h3>个人作品集</h3><p class="muted">最近更新 · 今天</p><p>让作品成为主角，说明保持简短。</p><button>查看项目</button></article>','用于可重复的对象摘要，保持信息层次一致。','不要给每个段落套卡片；避免多层嵌套。','title: string\nsummary?: string\nactions?: Action[]',['default','interactive'],['default','hover','focus','loading','empty','error']),
  ];
  doc.components=doc.components.map(component=>({...component,...STARTER_CONTRACTS[component.id],...(STARTER_GROUPS[component.id]?{group:STARTER_GROUPS[component.id]}:{})}));
  doc.groups={components:usedStarterGroups(doc.components)};
  doc.patterns=[
    entry('Form','标签、帮助文字、校验与提交反馈。','<form onsubmit="event.preventDefault();document.getElementById(\'form-status\').textContent=\'资料已保存。\'"><label>显示名称<input required placeholder="填写你的名字"></label><label>简介<textarea rows="2"></textarea></label><button class="primary">保存资料</button><p id="form-status" role="status" style="margin-top:12px"></p></form>','按用户理解顺序分组；提交失败保留所有输入。','不要使用“参数不合法”等无法指导恢复的提示。','提交时校验必填；字段错误就地显示；完成后展示明确反馈。'),
    entry('Empty state','说明为什么为空，以及下一步能做什么。','<div style="text-align:center;padding:30px"><h2>还没有项目</h2><p class="muted">创建第一个项目，开始整理你的设计。</p><button class="primary" onclick="this.nextElementSibling.hidden=false">新建项目</button><p hidden role="status">为项目命名后即可开始。</p></div>','用于首次使用、搜索无结果和内容被清空。','不要用错误语气描述正常空状态；不要塞入多个争抢注意力的按钮。','title / description / primaryAction / optional secondaryAction'),
    entry('Error recovery','保留上下文，提供可执行的恢复动作。','<div class="card" role="alert"><h3>暂时无法加载内容</h3><p>你的编辑仍然保留。请检查网络后重试。</p><button onclick="this.parentElement.innerHTML=\'<p role=status>内容已重新加载。</p>\'">重试</button></div>','明确影响范围、已保留的内容和恢复方式。','不要让用户反复提交；不要把内部错误堆栈当提示。','message / retry / retainedState / supportLink'),
    entry('Search','查询、结果与无结果状态。','<label>搜索项目<input type="search" placeholder="输入项目名称" oninput="document.getElementById(\'results\').textContent=this.value?\'正在查找：\'+this.value:\'全部项目\'"></label><p id="results" role="status">全部项目</p>','查询清晰可撤销，结果数量可见。','不要每次输入都把焦点移到结果区。','query / results / loading / empty / error'),
  ];
  doc.templates=[
    entry('Project list','带搜索、筛选与创建入口的列表页。','<div class="row" style="justify-content:space-between"><h2>项目</h2><button class="primary" onclick="document.getElementById(\'new\').hidden=false">新建项目</button></div><label>搜索<input placeholder="按名称搜索" oninput="document.querySelectorAll(\'tbody tr\').forEach(row=>row.hidden=!row.textContent.includes(this.value))"></label><table><thead><tr><th>名称</th><th>状态</th><th>更新</th></tr></thead><tbody><tr><td>个人作品集</td><td>进行中</td><td>今天</td></tr><tr><td>品牌规范</td><td>草稿</td><td>昨天</td></tr><tr id="new" hidden><td>新项目</td><td>草稿</td><td>刚刚</td></tr></tbody></table>','管理同类对象；把主操作与筛选固定在列表上方。','不要把不同比较维度混在同一列。','替换数据与动作处理器；保留加载、空状态和错误恢复区域。'),
    entry('Project detail','对象摘要、正文和相关操作的详情页。','<a href="#details" style="color:var(--link)">返回项目</a><h2 style="margin-top:24px">个人作品集</h2><p class="muted">草稿 · 最近编辑于今天</p><section id="details" class="card"><h3>项目概述</h3><p>用真实作品、明确结果与精简说明呈现你的工作。</p><button onclick="this.nextElementSibling.hidden=false">编辑概述</button><textarea hidden style="display:block;margin-top:16px;width:100%">用真实作品呈现你的工作。</textarea></section>','用于一个对象的详细阅读与编辑。','不要将危险操作与主要编辑动作并排强化。','id / title / metadata / body / actions'),
    entry('Settings','分组设置、辅助说明与保存反馈。','<h2>工作区设置</h2><form onsubmit="event.preventDefault();document.getElementById(\'saved\').textContent=\'设置已保存。\'"><label>工作区名称<input value="我的工作室"></label><label>默认语言<select><option>简体中文</option><option>English</option></select></label><label class="row"><input type="checkbox" checked>保存编辑历史</label><button class="primary">保存设置</button><p id="saved" role="status" style="margin-top:16px"></p></form>','按用户目标分组，并解释会影响他人的设置。','不要在没有说明的情况下立即应用高影响的设置。','sections / values / dirty / onSave / saveStatus'),
  ];
  doc.rules=STARTER_RULES.map(([id,rule,reason])=>({id,rule,reason}));
  doc.reviewChecks=[...STARTER_REVIEW];
  doc.content='## 语气与称呼\n用「你」，语气平实、具体。优先短句，直接说明动作和结果。\n\n## 按钮与提示\n按钮用动词开头，例如「保存草稿」「创建项目」。错误提示说明问题和恢复方法，例如「暂时无法保存，你的编辑仍保留，请重试」。\n\n## 中英混排\n中文与英文、数字之间保留适当空格。英文采用 sentence case。标点遵循当前语言。\n\n## 术语表\n| 术语 | 统一用法 |\n|---|---|\n| Draft | 草稿 |\n| Publish | 发布 |\n| Workspace | 工作区 |\n| Design system | 设计体系 |\n\n'+STARTER_CONTENT_ADDITIONS;
  doc.brand=STARTER_BRAND;
  doc.accessibility='## 文字与对比度\n普通文字以至少 4.5:1、大文字至少 3:1 为目标。对比度面板是辅助检查，不能代替页面验收。\n\n## 键盘与焦点\n所有操作可通过键盘完成。焦点顺序符合阅读顺序，弹层关闭后返回触发点，不隐藏焦点。\n\n## 状态与反馈\n错误用文字解释，并与字段关联。异步结果使用适当的状态播报。\n\n## 触控与动效\n保持足够大的可点击范围和间隔；尊重 prefers-reduced-motion。';
  doc.checklist=['主要流程可仅用键盘完成','所有交互控件具有可见焦点','表单标签与错误信息正确关联','普通文字对比度达到目标','状态不只依赖颜色表达','触控目标尺寸与间隔已检查','200% 缩放下内容仍可用','减少动效设置生效','图片替代文本与装饰标记已检查','弹层焦点进入、约束和返回正确'].map((label,index)=>({id:'a11y-'+index,label,checked:false}));
  doc.implementation.notes='组件名、设计稿名称和代码导出保持一致。每次变更同时检查主题、状态和实际页面。此处填写真实仓库与设计稿链接，不代表已经建立双向同步。';
  doc.governance={version:'0.1.0',owners:'个人维护',contribution:'1. 先确认现有组件或模式无法满足需求。\n2. 提供真实场景、状态全集和无障碍说明。\n3. 通过预览与受影响页面检查后再标记稳定。',deprecation:'弃用时保留旧名称和迁移说明，记录替代方案。破坏性变更提升主版本；新增能力提升次版本；修复提升补丁版本。'};
  doc.releases=[{version:'0.1.0',date:new Date().toISOString(),notes:'建立五层设计体系起步规范，包含 8 个组件、4 个模式、3 个模板，以及设计规则与界面审查清单。所有条目初始为草稿，待实际产品验收。'}];
  return doc;
}

export function starterStudioDocument():StudioDocument { return {...enhanceStudioCatalog(legacyStarterStudioDocument()),catalogVersion:STUDIO_STARTER_VERSION}; }

/**
 * Whether a document came from the starter, the only thing the upgrade may touch. The starter and
 * its upgrade are the only writers of `catalogVersion`; a first-version starter has none, but still
 * holds its shipped prose or at least one shipped entry. An agent-built or imported system has none
 * of these, and the upgrade must not fill it with starter content.
 */
export function isStudioStarterDocument(doc:StudioDocument):boolean {
  if(doc.catalogVersion!==undefined)return true;
  if(doc.content===LEGACY_CONTENT||doc.brand===LEGACY_BRAND)return true;
  const legacy=legacyStarterStudioDocument();
  return (['components','patterns','templates'] as const).some(section=>doc[section].some(entry=>legacy[section].some(item=>item.id===entry.id&&(item.html===entry.html||item.usage===entry.usage))));
}
/**
 * Upgrade only what is still as shipped. Examples, contract fields and guidance land on entries and
 * sections the author has not changed; user-authored fields, entries and text survive untouched.
 * `declared` names the tokens the system's tokens.css declares after the upgrade: notes are added
 * only for those, so the handbook never describes a token that does not exist.
 */
export function upgradeStudioStarterCatalog(current:StudioDocument,declared?:ReadonlySet<string>):StudioDocument {
  const before=legacyStarterStudioDocument(),after=enhanceStudioCatalog(before),next=structuredClone(current);
  // Starter groups land only on a document from before groups existed (none listed, no entry grouped);
  // once the author has grouped anything, grouping is theirs.
  const ungroupedDocument=!(current.groups.components??[]).length&&!current.components.some(entry=>entry.group!==undefined);
  for(const section of ['components','patterns','templates'] as const)next[section]=current[section].map(entry=>{
    const old=before[section].find(item=>item.id===entry.id),updated=after[section].find(item=>item.id===entry.id);
    if(!old||!updated)return entry;
    const merged={...entry};
    // Examples and refreshed fields go only to entries still on the first shipped implementation.
    if(entry.html===old.html){
      for(const key of ['description','usage','avoid','api','accessibility','variants','states','html'] as const){if(JSON.stringify(entry[key])===JSON.stringify(old[key]))Object.assign(merged,{[key]:updated[key]});}
      if(!entry.examples?.length)merged.examples=updated.examples;
    }
    // The contract is new in v3, so it is offered wherever the shipped guidance still stands; a default
    // variant only when the entry, as it now stands, has that variant.
    // v4: a shipped component, still recognisably as shipped, joins its job group.
    if(section==='components'&&ungroupedDocument&&merged.group===undefined&&updated.group!==undefined&&(entry.html===old.html||(entry.usage===old.usage&&entry.avoid===old.avoid)))merged.group=updated.group;
    if(entry.usage===old.usage&&entry.avoid===old.avoid){
      for(const key of ['good','bad'] as const)if(merged[key]===undefined&&updated[key]!==undefined)merged[key]=updated[key];
      if(merged.defaultVariant===undefined&&updated.defaultVariant!==undefined&&merged.variants.includes(updated.defaultVariant))merged.defaultVariant=updated.defaultVariant;
    }
    return merged;
  });
  // Groups the upgrade just filled are listed after the author's own, in the job order.
  const listed=studioGroupNames(current,'components');
  const added=usedStarterGroups(next.components).filter(name=>!listed.includes(name));
  if(added.length)next.groups={...next.groups,components:[...listed,...added]};
  if(!current.rules.length&&!current.reviewChecks.length){next.rules=structuredClone(before.rules);next.reviewChecks=[...before.reviewChecks];}
  for(const [key,legacy] of [['content',LEGACY_CONTENT],['brand',LEGACY_BRAND]] as const)if(current[key]===legacy)next[key]=before[key];
  for(const [name,note] of Object.entries(before.tokenNotes))if(SIZING_NOTES[name]&&!next.tokenNotes[name]&&(!declared||declared.has(name)))next.tokenNotes[name]=note;
  next.catalogVersion=STUDIO_STARTER_VERSION;
  return next;
}
/** The starter guidance this build ships; an older system offers the upgrade. */
export const STUDIO_STARTER_VERSION=4;
// The v1/v2 text of the two prose sections, so an upgrade can tell untouched guidance from the author's own.
const LEGACY_CONTENT='## 语气与称呼\n用「你」，语气平实、具体。优先短句，直接说明动作和结果。\n\n## 按钮与提示\n按钮用动词开头，例如「保存草稿」「创建项目」。错误提示说明问题和恢复方法，例如「暂时无法保存，你的编辑仍保留，请重试」。\n\n## 中英混排\n中文与英文、数字之间保留适当空格。英文采用 sentence case。标点遵循当前语言。\n\n## 术语表\n| 术语 | 统一用法 |\n|---|---|\n| Draft | 草稿 |\n| Publish | 发布 |\n| Workspace | 工作区 |\n| Design system | 设计体系 |';
const LEGACY_BRAND='## 标志\n保留原始比例、最小可读尺寸和安全留白。不要擅自拉伸、描边或改色。\n\n## 图标\n同一界面使用同一图标家族、线宽与光学尺寸。纯图标按钮必须有可访问名称。\n\n## 图片与插画\n优先真实、有用途的内容。统一裁切和色调，提供替代文本；装饰图片使用空替代文本。';
