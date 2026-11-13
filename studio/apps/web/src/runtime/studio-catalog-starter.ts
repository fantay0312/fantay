import type { StudioDocument, StudioLibraryEntry, StudioLibraryExample } from '@open-design/contracts';

type DemoApi = { q: <T extends Element = HTMLElement>(selector: string) => T; all: <T extends Element = HTMLElement>(selector: string) => T[]; load: <T>(key: string, fallback: T) => T; save: (key: string, value: unknown) => void; say: (message: string) => void; id: string };
type Demo = (root: HTMLElement, api: DemoApi, mode: string) => void;
const STYLE = '<style>body{margin:0}.fd,.fd *{box-sizing:border-box}.fd{padding:24px;color:var(--fg,#202020);background:var(--bg,#fafaf8);font:16px/1.6 var(--font-body,Arial,sans-serif);min-height:260px}.fd [hidden]{display:none!important}.fd button,.fd input,.fd select,.fd textarea{font:inherit}.fd button{padding:8px 16px;border:1px solid var(--border,#d8d8d2);border-radius:var(--radius-sm,6px);background:var(--surface,#fff);color:var(--fg,#202020);cursor:pointer}.fd .primary{background:var(--accent,#353535);color:var(--accent-on,#fff)}.fd .danger{color:var(--danger,#b4382e)}.fd button:hover:not(:disabled),.fd .is-hover{filter:brightness(.9)}.fd :focus-visible,.fd .is-focus{outline:2px solid var(--link,#275e91);outline-offset:3px}.fd :disabled{opacity:.45;cursor:not-allowed}.fd input:not([type=checkbox]),.fd textarea,.fd select{width:100%;max-width:480px;padding:9px 12px;border:1px solid var(--border,#d8d8d2);border-radius:var(--radius-sm,6px);background:var(--surface,#fff);color:inherit}.fd [aria-invalid=true]{border-color:var(--danger,#b4382e)!important}.fd label{display:grid;gap:6px;margin-bottom:14px}.fd label.check{display:flex;align-items:center;gap:9px}.fd input[type=checkbox]{width:17px;height:17px;accent-color:var(--accent,#353535)}.fd .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.fd .stack{display:grid;gap:12px}.fd .muted,.fd small{color:var(--muted,#62625e);font-size:13px}.fd .error{color:var(--danger,#b4382e)}.fd .card{padding:20px;border:1px solid var(--border,#ddd);border-radius:var(--radius-md,12px);background:var(--surface,#fff)}.fd h2,.fd h3,.fd p{margin:0 0 12px}.fd h2{font:400 28px/1.2 var(--font-display,Georgia,serif)}.fd table{border-collapse:collapse;width:100%;font-size:14px}.fd th,.fd td{border-bottom:1px solid var(--border,#ddd);padding:10px;text-align:left}.fd dialog{max-width:min(420px,90vw);border:1px solid var(--border,#ddd);border-radius:12px;padding:24px;background:var(--surface,#fff);color:var(--fg,#202020)}.fd dialog::backdrop{background:#0005}.fd [role=tab][aria-selected=true]{background:var(--accent,#353535);color:var(--accent-on,#fff)}.fd [data-status]{margin-top:16px;min-height:1.6em;font-size:13px}.fd .notice{margin-top:18px;font-size:11px;color:var(--muted,#62625e)}.fd .spinner{display:inline-block;width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:fd-spin .8s linear infinite}@keyframes fd-spin{to{transform:rotate(360deg)}}@media(max-width:500px){.fd{padding:18px}.fd table{font-size:12px}.fd th,.fd td{padding:8px}}@media(prefers-reduced-motion:reduce){.fd *{transition:none!important;animation:none!important}}</style>';

function boot(init: Demo, mode: string) {
  const root = document.currentScript!.previousElementSibling as HTMLElement;
  const id = 'fd-' + Math.random().toString(36).slice(2);
  root.id = id;
  const slot = root.dataset.demo!;
  const index = [...document.querySelectorAll('[data-demo]')].filter(item => (item as HTMLElement).dataset.demo === slot).indexOf(root);
  const prefix = 'fantay-demo-v2:' + location.pathname + ':' + slot + ':' + index + ':';
  const api: DemoApi = {
    id, q: <T extends Element = HTMLElement>(selector:string) => root.querySelector<T>(selector)!, all: <T extends Element = HTMLElement>(selector:string) => [...root.querySelectorAll<T>(selector)],
    load: (key, fallback) => { const value = localStorage.getItem(prefix + key); if(value===null)return fallback;try{return JSON.parse(value);}catch{return fallback;} },
    save: (key, value) => { const text = JSON.stringify(value); localStorage.setItem(prefix + key, text); if (localStorage.getItem(prefix + key) !== text) throw new Error('无法保存到此浏览器'); },
    say: message => { const status = root.querySelector('[data-status]'); if (status) status.textContent = message; },
  };
  try { init(root, api, mode); } catch (error) { api.say('无法读取本地演示数据：' + (error instanceof Error ? error.message : String(error))); }
}
function demo(key: string, html: string, init: Demo, mode = 'default') {
  return STYLE + '<section class="fd" data-demo="' + key + '">' + html + '<p data-status role="status" aria-live="polite"></p></section><script>(' + boot.toString() + ')(' + init.toString() + ',' + JSON.stringify(mode) + ');</script>';
}
function example(kind: StudioLibraryExample['kind'], value: string, html: string): StudioLibraryExample { return { id: kind + '-' + value, kind, value, name: value, html }; }

function button(mode = 'default') {
  return demo('button', '<div class="row"><button class="primary" data-action="save">保存更改</button><button data-action="cancel">取消更改</button><button class="danger" data-action="clear">清除记录</button></div><p class="muted" style="margin-top:16px">点击按钮操作本地计数，加载与错误状态可以直接切换验证。</p>', (_root, a, state) => {
    let count = a.load('count', 0); const save = a.q<HTMLButtonElement>('[data-action=save]'); a.say('已保存次数：' + count);
    if (state === 'hover') save.classList.add('is-hover');
    if (state === 'focus') save.focus();
    if (state === 'disabled' || state === 'loading') { save.disabled = true; if (state === 'loading') { save.setAttribute('aria-busy', 'true'); save.textContent = '正在保存…'; } }
    save.onclick = () => { try { if (state === 'error') throw new Error('这是可重试的错误状态示例'); a.save('count', ++count); a.say('已保存次数：' + count); } catch (error) { a.say(String(error)); save.textContent = '重试保存'; state = 'default'; } };
    a.q<HTMLButtonElement>('[data-action=cancel]').onclick = () => a.say('已取消，保存次数保持为 ' + count);
    a.q<HTMLButtonElement>('[data-action=clear]').onclick = () => { a.save('count', 0); count = 0; a.say('记录已清除'); };
    if (state === 'secondary') save.className = ''; if (state === 'danger') save.className = 'danger';
  }, mode);
}
function textField(mode = 'default') {
  return demo('text-field', '<label>显示名称<input data-input placeholder="至少 3 个字" minlength="3" required></label><p data-error class="error" hidden></p><label data-notes hidden>补充说明<textarea rows="3"></textarea></label><button data-reveal hidden>显示密码</button>', (_root, a, state) => {
    const input = a.q<HTMLInputElement>('[data-input]'), error = a.q<HTMLElement>('[data-error]'); error.id = a.id + '-error'; input.setAttribute('aria-describedby', error.id);
    if (state === 'email') { input.type = 'email'; input.placeholder = 'name@example.com'; }
    if (state === 'password') { input.type = 'password'; const reveal = a.q<HTMLButtonElement>('[data-reveal]'); reveal.hidden = false; reveal.onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; reveal.textContent = input.type === 'password' ? '显示密码' : '隐藏密码'; }; }
    if (state === 'multiline') a.q<HTMLElement>('[data-notes]').hidden = false;
    if (state === 'filled') input.value = 'Fantay';
    if (state === 'disabled') input.disabled = true;
    const validate = () => { const invalid = input.value.trim().length < 3 || !input.validity.valid; input.setAttribute('aria-invalid', String(invalid)); error.hidden = !invalid; error.textContent = '请填写至少 3 个字符，并使用正确的格式。'; a.say(invalid ? '请修正输入后继续。' : '输入有效。'); };
    input.onblur = validate; input.oninput = () => { input.removeAttribute('aria-invalid'); error.hidden = true; a.say('正在编辑，尚未提交。'); };
    if (state === 'error') { input.value = 'ab'; validate(); } if (state === 'focus') input.focus(); if (state === 'hover') input.style.borderColor = 'var(--link)';
  }, mode);
}
function select(mode = 'default') {
  return demo('select', '<label>内容语言<select data-select><option value="">请选择语言</option><option value="zh">简体中文</option><option value="en">English</option><option value="zh-TW">繁體中文</option></select></label><p data-error class="error" hidden>请选择一种语言。</p>', (_root, a, state) => {
    const input = a.q<HTMLSelectElement>('[data-select]'), error = a.q<HTMLElement>('[data-error]'); error.id = a.id + '-error'; input.setAttribute('aria-describedby', error.id);
    input.value = a.load('language', 'zh'); input.onchange = () => { const valid = Boolean(input.value); error.hidden = valid; input.setAttribute('aria-invalid', String(!valid)); if (valid) { a.save('language', input.value); a.say('当前语言：' + input.selectedOptions[0]!.textContent); } };
    if (state === 'disabled' || state === 'loading') input.disabled = true;
    if (state === 'loading') { input.setAttribute('aria-busy', 'true'); a.say('选项加载状态示例'); }
    if (state === 'error') { input.value = ''; error.hidden = false; input.setAttribute('aria-invalid', 'true'); }
    if (state === 'focus') input.focus();
  }, mode);
}
function checkbox(mode = 'default') {
  return demo('checkbox', '<label class="check"><input type="checkbox" data-all>接收全部更新</label><div style="padding-left:24px"><label class="check"><input type="checkbox" data-child value="product">产品更新</label><label class="check"><input type="checkbox" data-child value="security">安全通知</label></div>', (_root, a, state) => {
    const all = a.q<HTMLInputElement>('[data-all]'), items = a.all<HTMLInputElement>('[data-child]'); let selected = a.load<string[]>('selected', ['product']);
    if (state === 'checked') selected = ['product', 'security']; if (state === 'unchecked' || state === 'error') selected = []; if (state === 'indeterminate') selected = ['product'];
    const render = () => { items.forEach(item => item.checked = selected.includes(item.value)); all.checked = selected.length === items.length; all.indeterminate = selected.length > 0 && selected.length < items.length; if(selected.length)all.removeAttribute('aria-invalid'); a.say(selected.length ? '已选择 ' + selected.length + ' 项。' : '尚未选择通知。'); };
    all.onchange = () => { selected = all.checked ? items.map(item => item.value) : []; a.save('selected', selected); render(); };
    items.forEach(item => item.onchange = () => { selected = items.filter(item => item.checked).map(item => item.value); a.save('selected', selected); render(); }); render();
    if (state === 'disabled') [all, ...items].forEach(item => item.disabled = true); if (state === 'focus') all.focus(); if (state === 'error') { all.setAttribute('aria-invalid', 'true'); a.say('请至少选择一项；选择后错误会解除。'); }
  }, mode);
}
function dialog(mode = 'default') {
  return demo('dialog', '<button data-open>编辑项目名称</button><dialog data-dialog><h3 data-title>编辑项目名称</h3><p data-help>保存到此浏览器，取消不会修改记录。</p><label>项目名称<input data-name required></label><p data-error class="error" hidden></p><div class="row"><button data-cancel>取消</button><button class="primary" data-save>保存名称</button></div></dialog>', (_root, a, state) => {
    const box = a.q<HTMLDialogElement>('[data-dialog]'), open = a.q<HTMLButtonElement>('[data-open]'), input = a.q<HTMLInputElement>('[data-name]'), error = a.q<HTMLElement>('[data-error]');
    const title = a.q<HTMLElement>('[data-title]'), help = a.q<HTMLElement>('[data-help]'); title.id = a.id + '-title'; help.id = a.id + '-help'; box.setAttribute('aria-labelledby', title.id); box.setAttribute('aria-describedby', help.id);
    open.onclick = () => { input.value = a.load('name', '我的项目'); error.hidden = true; box.showModal(); input.focus(); };
    const cancel=a.q<HTMLButtonElement>('[data-cancel]'); cancel.onclick = () => { box.close('cancel'); a.say('已取消，原名称保持不变。'); };
    const save = a.q<HTMLButtonElement>('[data-save]'); save.onclick = () => { if (!input.value.trim()) { error.textContent = '请填写项目名称。'; error.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); return; } save.disabled = true; cancel.disabled = true; box.setAttribute('aria-busy','true'); save.textContent = '正在保存…'; setTimeout(() => { try { a.save('name', input.value.trim()); box.close('save'); a.say('项目名称已保存：' + input.value.trim()); } catch (e) { error.textContent = String(e); error.hidden = false; } finally { save.disabled = false; cancel.disabled = false; box.removeAttribute('aria-busy'); save.textContent = '保存名称'; } }, 180); };
    error.id=a.id+'-error';input.setAttribute('aria-describedby',error.id);input.oninput = () => input.removeAttribute('aria-invalid');input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();save.click();}}; box.onclose = () => open.focus(); box.oncancel = event => { if(save.disabled)event.preventDefault(); };
    if (state !== 'closed' && state !== 'default') { open.click(); if (state === 'error') { input.value = ''; save.click(); } if (state === 'loading') save.click(); }
  }, mode);
}
function toast(mode = 'default') {
  return demo('toast', '<label>草稿内容<input data-draft value="我的新想法"></label><div class="row"><button class="primary" data-save>保存草稿</button><button data-info>显示说明</button><button data-error>演示错误反馈</button></div><div class="card" data-toast role="status" aria-live="polite" hidden style="margin-top:20px"><span data-message></span><div class="row" style="margin-top:12px"><button data-undo>撤销</button><button data-close>关闭</button></div></div>', (_root, a, state) => {
    const box = a.q<HTMLElement>('[data-toast]'), message = a.q<HTMLElement>('[data-message]'), draft = a.q<HTMLInputElement>('[data-draft]'); let previous = a.load('draft', ''); draft.value = previous || draft.value;
    const show = (text: string, undo = false) => { message.textContent = text; box.hidden = false; a.q<HTMLElement>('[data-undo]').hidden = !undo; };
    a.q<HTMLButtonElement>('[data-save]').onclick = () => { previous = a.load('draft', ''); try { a.save('draft', draft.value); show('草稿已保存到此浏览器。', true); } catch (e) { show('保存失败：' + String(e)); } };
    a.q<HTMLButtonElement>('[data-undo]').onclick = () => { a.save('draft', previous); draft.value = previous; show('已恢复上一次内容。'); };
    a.q<HTMLButtonElement>('[data-close]').onclick = () => { box.hidden = true; a.q<HTMLButtonElement>('[data-save]').focus(); };
    a.q<HTMLButtonElement>('[data-info]').onclick = () => show('演示数据仅保存在当前浏览器。'); a.q<HTMLButtonElement>('[data-error]').onclick = () => show('错误反馈示例：内容仍保留，可以重试。');
    if (state === 'success' || state === 'action' || state === 'visible') a.q<HTMLButtonElement>('[data-save]').click(); if (state === 'error') a.q<HTMLButtonElement>('[data-error]').click(); if (state === 'info') a.q<HTMLButtonElement>('[data-info]').click();
  }, mode);
}
function tabs(mode = 'default') {
  return demo('tabs', '<div role="tablist" aria-label="项目视图" class="row"><button role="tab">概览</button><button role="tab">变更</button><button role="tab" disabled>成员</button></div><div role="tabpanel" class="card" style="margin-top:16px">这里是项目概览。</div><div role="tabpanel" class="card" hidden style="margin-top:16px">这里是变更记录。</div><div role="tabpanel" hidden>成员管理</div>', (_root, a, state) => {
    const buttons = a.all<HTMLButtonElement>('[role=tab]'), panels = a.all<HTMLElement>('[role=tabpanel]');
    const activate = (index: number, focus = false) => { buttons.forEach((button, i) => { button.id = a.id + '-tab-' + i; panels[i]!.id = a.id + '-panel-' + i; button.setAttribute('aria-controls', panels[i]!.id); panels[i]!.setAttribute('aria-labelledby', button.id); button.setAttribute('aria-selected', String(i === index)); button.tabIndex = i === index ? 0 : -1; panels[i]!.hidden = i !== index; }); a.save('active', index); if (focus) buttons[index]!.focus(); };
    buttons.forEach((button, index) => { button.onclick = () => activate(index); button.onkeydown = event => { const enabled = buttons.map((b, i) => !b.disabled ? i : -1).filter(i => i >= 0); const pos = enabled.indexOf(index); const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : event.key === 'ArrowRight' ? enabled[(pos + 1) % enabled.length] : event.key === 'ArrowLeft' ? enabled[(pos - 1 + enabled.length) % enabled.length] : undefined; if (next !== undefined) { event.preventDefault(); activate(next, true); } }; });
    activate(state === 'selected' ? 1 : Math.min(1, a.load('active', 0)), state === 'focus');
  }, mode);
}
function card(mode = 'default') {
  return demo('card', '<article class="card"><h3 data-title>个人作品集</h3><p class="muted">草稿 · 本地示例</p><p data-body>以清晰的结构展示你的作品。</p><div class="row"><button data-detail>查看详情</button><button data-favorite aria-pressed="false">收藏</button></div><div data-details hidden style="margin-top:16px">详情：内容、页面和资源统一管理。</div></article>', (_root, a, state) => {
    const favorite = a.q<HTMLButtonElement>('[data-favorite]'); let saved = a.load('favorite', false); const render = () => { favorite.setAttribute('aria-pressed', String(saved)); favorite.textContent = saved ? '取消收藏' : '收藏'; }; render();
    favorite.onclick = () => { saved = !saved; a.save('favorite', saved); render(); a.say(saved ? '已收藏' : '已取消收藏'); };
    const detail = a.q<HTMLButtonElement>('[data-detail]'); detail.onclick = () => { const content = a.q<HTMLElement>('[data-details]'); content.hidden = !content.hidden; detail.textContent = content.hidden ? '查看详情' : '收起详情'; detail.setAttribute('aria-expanded', String(!content.hidden)); };
    if (state === 'focus') detail.focus(); if (state === 'empty') { a.q('[data-title]').textContent = '还没有作品'; a.q('[data-body]').textContent = '添加第一段介绍，开始整理。'; detail.textContent = '添加介绍'; detail.onclick = () => { a.q('[data-body]').textContent = '这是我的第一段作品介绍。'; a.say('介绍已添加到演示视图。'); }; }
    if (state === 'loading') { detail.disabled = true; a.q('[data-body]').textContent = '正在读取本地内容…'; }
    if (state === 'error') { a.q('[data-body]').textContent = '演示错误状态：内容暂不可用。'; detail.textContent = '重试'; detail.onclick = () => { a.q('[data-body]').textContent = '本地示例内容已显示。'; a.say('恢复完成'); }; }
  }, mode);
}

function form(mode = 'default', settings = false) {
  return demo(settings ? 'settings' : 'form', '<h2>' + (settings ? '工作区设置' : '个人资料') + '</h2><form novalidate><label>' + (settings ? '工作区名称' : '显示名称') + '<input name="name" required minlength="2" value="我的工作室"></label><p data-name-error class="error" hidden>请填写至少 2 个字符。</p><label>默认语言<select name="language"><option value="zh">简体中文</option><option value="en">English</option></select></label><label>简介<textarea name="bio" rows="2"></textarea></label><label class="check"><input type="checkbox" name="history" checked>记录本地修改历史</label><label class="check muted"><input type="checkbox" data-fail>演示保存失败（不会写入数据）</label><div class="row"><button class="primary" type="submit">保存设置</button><button type="button" data-cancel>取消更改</button><button type="button" data-default>恢复默认值</button></div></form><p class="notice">数据仅保存在此浏览器；不会发送到服务器。</p><details><summary>本地保存记录</summary><ul data-history></ul></details>', (_root, a, state) => {
    const form = a.q<HTMLFormElement>('form'), name = form.elements.namedItem('name') as HTMLInputElement, language = form.elements.namedItem('language') as HTMLSelectElement, bio = form.elements.namedItem('bio') as HTMLTextAreaElement, history = form.elements.namedItem('history') as HTMLInputElement, error = a.q<HTMLElement>('[data-name-error]');
    const defaults = { name: '我的工作室', language: 'zh', bio: '', history: true }; let saved = a.load('settings', defaults);
    error.id = a.id + '-name-error'; name.setAttribute('aria-describedby', error.id);
    const renderHistory = () => { const list = a.q('[data-history]'); list.replaceChildren(); for (const item of a.load<string[]>('history', [])) { const li = document.createElement('li'); li.textContent = item; list.append(li); } };
    const fill = (value: typeof defaults) => { name.value = value.name; language.value = value.language; bio.value = value.bio; history.checked = value.history; error.hidden = true; name.removeAttribute('aria-invalid'); }; fill(saved); renderHistory();
    form.oninput = () => { a.say('有未保存的更改。'); error.hidden = true; name.removeAttribute('aria-invalid'); };
    form.onsubmit = event => { event.preventDefault(); if(form.getAttribute('aria-busy')==='true')return; if (name.value.trim().length < 2) { error.hidden = false; name.setAttribute('aria-invalid', 'true'); name.focus(); a.say('请修正字段后保存。'); return; } const next = { name: name.value.trim(), language: language.value, bio: bio.value, history: history.checked }; const controls=[...form.elements] as HTMLInputElement[]; const disabledBefore=controls.map(control=>control.disabled); controls.forEach(control=>control.disabled=true); const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!; submit.disabled = true; submit.textContent = '正在保存…'; form.setAttribute('aria-busy', 'true'); setTimeout(() => { try { if (a.q<HTMLInputElement>('[data-fail]').checked) throw new Error('演示失败，未写入任何内容'); a.save('settings', next); if (next.history) a.save('history', [new Date().toLocaleString() + ' · ' + next.name, ...a.load<string[]>('history', [])].slice(0, 20)); saved = next; renderHistory(); a.say('设置已保存到此浏览器。'); } catch (error) { a.say('保存失败：' + String(error) + '。输入仍然保留。'); } finally { controls.forEach((control,index)=>control.disabled=disabledBefore[index]??false); submit.textContent = '保存设置'; form.removeAttribute('aria-busy'); } }, 180); };
    a.q<HTMLButtonElement>('[data-cancel]').onclick = () => { fill(saved); a.say('未保存的更改已取消。'); }; a.q<HTMLButtonElement>('[data-default]').onclick = () => { fill(defaults); a.say('已填入默认值，尚未保存。'); };
    if (state === 'error') { name.value = ''; form.requestSubmit(); } if (state === 'loading') form.requestSubmit(); if (state === 'disabled') [...form.elements].forEach(item => (item as HTMLInputElement).disabled = true);
  }, mode);
}
function empty(mode = 'default') {
  return demo('empty', '<h2 data-title>还没有项目</h2><p data-description>创建第一个项目，开始整理设计。</p><form data-create><label>项目名称<input name="name" required></label><button class="primary">创建项目</button></form><button data-clear hidden>清除搜索条件</button><ul data-list></ul>', (_root, a, state) => {
    let items = a.load<string[]>('items', []); const render = () => { const list = a.q('[data-list]'); list.replaceChildren(); items.forEach(item => { const li = document.createElement('li'); li.textContent = item; list.append(li); }); a.q('[data-title]').textContent = items.length ? '我的项目' : '还没有项目'; a.q('[data-description]').textContent = items.length ? '已保存 ' + items.length + ' 个本地项目。' : '创建第一个项目，开始整理设计。'; }; render();
    a.q<HTMLFormElement>('[data-create]').onsubmit = event => { event.preventDefault(); const input = a.q<HTMLInputElement>('input'); if (!input.value.trim()) return; items = [...items, input.value.trim()]; a.save('items', items); input.value = ''; render(); a.say('项目已创建并保存在此浏览器。'); };
    if (state === 'no-results') { a.q('[data-title]').textContent = '没有匹配的结果'; a.q('[data-description]').textContent = '试试其他关键词，或清除搜索条件。'; const clear = a.q<HTMLButtonElement>('[data-clear]'); clear.hidden = false; clear.onclick = () => { clear.hidden = true; render(); a.say('已清除搜索条件。'); }; }
  }, mode);
}
function search(mode = 'default') {
  return demo('search', '<label>搜索项目<input type="search" data-query placeholder="输入名称"></label><label class="check muted"><input type="checkbox" data-fail>演示查询失败</label><p data-count></p><ul data-results></ul><button data-clear>清除搜索</button>', (_root, a, state) => {
    const records = ['个人作品集', '品牌规范', '网站改版', '设计系统', '学习工具']; const input = a.q<HTMLInputElement>('[data-query]'), list = a.q<HTMLElement>('[data-results]'), count = a.q<HTMLElement>('[data-count]'); let timer: ReturnType<typeof setTimeout>;
    const run = () => { clearTimeout(timer); list.setAttribute('aria-busy', 'true'); count.textContent = '正在筛选本地项目…'; timer = setTimeout(() => { list.replaceChildren(); list.removeAttribute('aria-busy'); if (a.q<HTMLInputElement>('[data-fail]').checked) { count.textContent = '查询失败示例；关闭演示开关后可以重试。'; return; } const results = records.filter(name => name.toLowerCase().includes(input.value.trim().toLowerCase())); count.textContent = results.length + ' 个结果'; results.forEach(name => { const li = document.createElement('li'), button = document.createElement('button'); button.textContent = name; button.onclick = () => a.say('已选择：' + name); li.append(button); list.append(li); }); if (!results.length) a.say('没有匹配结果，试试其他关键词。'); }, 100); };
    input.oninput = run; a.q<HTMLInputElement>('[data-fail]').onchange = run; a.q<HTMLButtonElement>('[data-clear]').onclick = () => { input.value = ''; run(); input.focus(); };
    if (state === 'empty') input.value = '不存在的项目'; if (state === 'error') a.q<HTMLInputElement>('[data-fail]').checked = true; run();
  }, mode);
}
function recovery(mode = 'default') {
  return demo('recovery', '<label>尚未提交的说明<textarea data-draft>这段输入会在重试时保留。</textarea></label><div class="card"><h3 data-title>正在读取演示数据</h3><p data-message></p><button data-retry>重试</button><button data-fail>制造读取错误</button></div>', (_root, a, state) => {
    let invalid = state !== 'success'; const retry = a.q<HTMLButtonElement>('[data-retry]');
    const read = async () => { retry.disabled = true; a.q('[data-title]').textContent = '正在读取本地演示数据'; try { const payload = invalid ? '{invalid' : JSON.stringify({ message: '本地数据读取成功，输入保持不变。' }); const response = await fetch('data:application/json,' + encodeURIComponent(payload)); const data = await response.json(); a.q('[data-title]').textContent = '内容已恢复'; a.q('[data-message]').textContent = data.message; a.say('读取完成。'); } catch { a.q('[data-title]').textContent = '无法解析本地演示数据'; a.q('[data-message]').textContent = '你的输入仍然保留。点击重试以读取有效数据。'; a.say('读取失败。'); } finally { retry.disabled = false; } };
    retry.onclick = () => { invalid = false; void read(); }; a.q<HTMLButtonElement>('[data-fail]').onclick = () => { invalid = true; void read(); }; void read();
  }, mode);
}
function projectList(mode = 'default') {
  return demo('project-list', '<div class="row" style="justify-content:space-between"><h2>项目</h2><button class="primary" data-new>新建项目</button></div><div class="row"><label>搜索<input type="search" data-search></label><label>状态<select data-filter><option value="all">全部</option><option value="draft">草稿</option><option value="active">进行中</option></select></label></div><p data-count class="muted"></p><table><thead><tr><th>名称</th><th>状态</th><th>操作</th></tr></thead><tbody></tbody></table><p data-empty hidden>暂无匹配项目。清除筛选或新建一个项目。</p><dialog><form method="dialog"><h3 data-dialog-title>新建项目</h3><label>项目名称<input name="title" required></label><label>状态<select name="status"><option value="draft">草稿</option><option value="active">进行中</option></select></label><div class="row"><button type="button" data-cancel>取消</button><button class="primary" value="save">保存项目</button></div></form></dialog><section data-detail class="card" hidden style="margin-top:20px"><h3 data-detail-title></h3><p data-detail-status></p><button data-back>收起详情</button></section><p class="notice">项目数据保存在当前浏览器。</p>', (_root, a, state) => {
    type Item = { id: string; title: string; status: string };
    const seed = [{ id: 'portfolio', title: '个人作品集', status: 'active' }, { id: 'brand', title: '品牌规范', status: 'draft' }]; let items = a.load<Item[]>('projects', seed); let editing: string | null = null;
    const query = a.q<HTMLInputElement>('[data-search]'), filter = a.q<HTMLSelectElement>('[data-filter]'), dialog = a.q<HTMLDialogElement>('dialog'), form = a.q<HTMLFormElement>('dialog form');
    const title = form.elements.namedItem('title') as HTMLInputElement, status = form.elements.namedItem('status') as HTMLSelectElement;
    const heading = a.q<HTMLElement>('[data-dialog-title]'); heading.id = a.id + '-dialog-title'; dialog.setAttribute('aria-labelledby', heading.id);
    const edit = (item?: Item) => { editing = item?.id ?? null; heading.textContent = item ? '编辑项目' : '新建项目'; title.value = item?.title ?? ''; status.value = item?.status ?? 'draft'; dialog.showModal(); title.focus(); };
    const render = () => { const body = a.q('tbody'); body.replaceChildren(); const result = items.filter(item => item.title.includes(query.value.trim()) && (filter.value === 'all' || item.status === filter.value)); a.q('[data-count]').textContent = result.length + ' 个项目'; a.q<HTMLElement>('[data-empty]').hidden = result.length > 0; result.forEach(item => { const row = document.createElement('tr'), name = document.createElement('td'), statusCell = document.createElement('td'), actions = document.createElement('td'); name.textContent = item.title; statusCell.textContent = item.status === 'active' ? '进行中' : '草稿'; const view = document.createElement('button'); view.textContent = '查看'; view.onclick = () => { a.q<HTMLElement>('[data-detail]').hidden = false; a.q('[data-detail-title]').textContent = item.title; a.q('[data-detail-status]').textContent = statusCell.textContent; }; const change = document.createElement('button'); change.textContent = '编辑'; change.onclick = () => edit(item); actions.append(view, change); row.append(name, statusCell, actions); body.append(row); }); };
    a.q<HTMLButtonElement>('[data-new]').onclick = () => edit(); a.q<HTMLButtonElement>('[data-cancel]').onclick = () => dialog.close('cancel'); a.q<HTMLButtonElement>('[data-back]').onclick = () => a.q<HTMLElement>('[data-detail]').hidden = true;
    form.onsubmit = event => { event.preventDefault(); if (!title.value.trim()) { title.reportValidity(); return; } const item = { id: editing ?? 'project-' + Date.now() + '-' + Math.random().toString(36).slice(2), title: title.value.trim(), status: status.value }; const next = editing ? items.map(old => old.id === editing ? item : old) : [...items, item]; try { a.save('projects', next); items = next; dialog.close('save'); render(); a.say('项目已保存。'); } catch (error) { a.say('保存失败，输入仍保留：' + String(error)); } };
    query.oninput = render; filter.onchange = render; if (state === 'empty') query.value = '没有结果'; render();
  }, mode);
}
function projectDetail(mode = 'default') {
  return demo('project-detail', '<h2>项目详情</h2><div data-view class="card"><h3 data-title></h3><p data-description></p><button data-edit>编辑详情</button></div><form data-form hidden><label>项目名称<input name="title" required></label><label>项目说明<textarea name="description" rows="4" required></textarea></label><div class="row"><button class="primary">保存详情</button><button type="button" data-cancel>取消更改</button></div></form><p class="notice">保存后刷新页面，内容仍保留在当前浏览器。</p>', (_root, a, state) => {
    let saved = a.load('detail', { title: '个人作品集', description: '用真实作品、明确结果与精简说明呈现工作。' }); const view = a.q<HTMLElement>('[data-view]'), form = a.q<HTMLFormElement>('[data-form]'), title = form.elements.namedItem('title') as HTMLInputElement, description = form.elements.namedItem('description') as HTMLTextAreaElement;
    const render = () => { a.q('[data-title]').textContent = saved.title; a.q('[data-description]').textContent = saved.description; }; render();
    const edit = () => { title.value = saved.title; description.value = saved.description; form.hidden = false; view.hidden = true; title.focus(); };
    a.q<HTMLButtonElement>('[data-edit]').onclick = edit; a.q<HTMLButtonElement>('[data-cancel]').onclick = () => { form.hidden = true; view.hidden = false; a.q<HTMLButtonElement>('[data-edit]').focus(); a.say('未保存的更改已取消。'); };
    form.onsubmit = event => { event.preventDefault(); if (!title.value.trim() || !description.value.trim()) { form.reportValidity(); return; } const next = { title: title.value.trim(), description: description.value.trim() }; try { a.save('detail', next); saved = next; render(); form.hidden = true; view.hidden = false; a.say('详情已保存。'); a.q<HTMLButtonElement>('[data-edit]').focus(); } catch (error) { a.say('保存失败，输入仍然保留：' + String(error)); } };
    if (state === 'editing') edit();
  }, mode);
}

export function enhanceStudioCatalog(doc: StudioDocument): StudioDocument {
  const next = structuredClone(doc); next.catalogVersion = 2;
  const builders: Record<string, (mode?: string) => string> = { button, textfield: textField, select, checkbox, dialog, toast, tabs, card, form, 'empty-state': empty, 'error-recovery': recovery, search, 'project-list': projectList, 'project-detail': projectDetail, settings: mode => form(mode, true) };
  const states: Record<string, string[]> = {
    button: ['default', 'hover', 'focus', 'disabled', 'loading', 'error'], textfield: ['default', 'filled', 'hover', 'focus', 'disabled', 'error'], select: ['default', 'focus', 'disabled', 'loading', 'error'], checkbox: ['checked', 'unchecked', 'indeterminate', 'focus', 'disabled', 'error'], dialog: ['closed', 'open', 'loading', 'error'], toast: ['visible', 'dismissed'], tabs: ['default', 'focus', 'selected', 'disabled'], card: ['default', 'focus', 'empty', 'loading', 'error'], form: ['default', 'loading', 'error', 'disabled'], 'empty-state': ['default', 'no-results'], 'error-recovery': ['error', 'success'], search: ['default', 'empty', 'error'], 'project-list': ['default', 'empty'], 'project-detail': ['default', 'editing'], settings: ['default', 'loading', 'error'],
  };
  const variants: Record<string, string[]> = { button: ['primary', 'secondary', 'danger'], textfield: ['text', 'email', 'password', 'multiline'], select: ['single'], checkbox: [], dialog: ['form'], toast: ['info', 'success', 'error', 'action'], tabs: ['horizontal'], card: ['interactive'], form: ['profile'], 'empty-state': [], 'error-recovery': [], search: [], 'project-list': [], 'project-detail': [], settings: [] };
  for (const section of ['components', 'patterns', 'templates'] as const) next[section] = next[section].map(entry => {
    const build = builders[entry.id]; if (!build) return entry;
    const stateNames = states[entry.id] ?? [], variantNames = variants[entry.id] ?? [];
    return { ...entry, html: build(), states: stateNames, variants: variantNames, examples: [...stateNames.map(state => example('state', state, build(state))), ...variantNames.map(variant => example('variant', variant, build(variant)))], accessibility: entry.accessibility + '\n交互示例使用实例作用域；对话框有可访问名称；Tabs 支持方向键、Home/End 和焦点漫游。实际适用性仍须在产品中验证。', api: entry.api + '\n\n### 本地演示接口\n保存示例使用隔离的 localStorage；业务接入时替换为自己的读写服务。预览、复制 HTML 和独立项目使用同一份实现。' };
  });
  return next;
}
