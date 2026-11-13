import { showTokenToSeaWorkspaces } from './workspace-client.js';
type ClientUser = { id: string; name: string };
type ClientShare = { id: string; title: string; status: string; revision: number; version: string; url: string; updatedAt: string; isOwner?: boolean };
type ClientTarget = { selector?: string; label?: string; text?: string; position?: { x: number; y: number } };
type ClientComment = { id: string; author: { name: string }; text: string; target: ClientTarget | null; version: string; status: string; isMine: boolean; createdAt: string };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const make = (tag: string, content?: string, className?: string) => { const e = document.createElement(tag); if (content) e.textContent = content; if (className) e.className = className; return e; };
const shareId = /^\/s\/([a-f0-9-]{36})$/.exec(location.pathname)?.[1];
let currentUser: ClientUser | null = null, csrfToken = '', currentShare: ClientShare | null = null, target: ClientTarget | null = null, selecting = false;
const nonce = crypto.randomUUID(), preview = element<HTMLIFrameElement>('preview'), note = element<HTMLTextAreaElement>('note');
class ResponseError extends Error { constructor(readonly status: number, message: string) { super(message); } }
let toastTimer: number | undefined;
function message(text: string) { const e = element('message'); e.textContent = text; e.hidden = false; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { e.hidden = true; }, 7000); }
async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new ResponseError(response.status, result.error || '操作失败，请稍后重试'); return result as T;
}
function action(text: string, run: () => Promise<void>) { const b = make('button', text) as HTMLButtonElement; b.onclick = () => { b.disabled = true; void run().catch(e => message(e.message)).finally(() => { b.disabled = false; }); }; return b; }
function login() { if (shareId) sessionStorage.setItem(`draft:${shareId}`, JSON.stringify({ text: note.value, target })); location.href = `/api/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`; }
element('login').onclick = login;
element('logout').onclick = () => { void api('/api/auth/logout', 'POST', {}).then(() => location.reload()).catch(e => message(e.message)); };
async function auth() {
  const status = await api<{ user: ClientUser | null; csrf: string | null }>('/api/auth/status'); currentUser = status.user; csrfToken = status.csrf ?? '';
  element('account-name').textContent = currentUser?.name ?? '';
  element('login').hidden = !!currentUser; element('logout').hidden = !currentUser;
  element('upload-section').hidden = !currentUser;
  element('submit').textContent = currentUser ? '发布评论' : '登录后发布评论';
}
element<HTMLInputElement>('upload-file').onchange = () => { element<HTMLButtonElement>('upload-publish').disabled = !element<HTMLInputElement>('upload-file').files?.length; };
element('upload-publish').onclick = () => {
  const file = element<HTMLInputElement>('upload-file').files?.[0]; if (!file) return;
  const button = element<HTMLButtonElement>('upload-publish'); button.disabled = true;
  void (async () => {
    if (file.size > 20 * 1024 * 1024) throw new Error('每次分享最多 20 MB');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const publication = await api<ClientShare>('/api/shares', 'POST', { documentKey: `upload:${crypto.randomUUID()}`, title: file.name.replace(/\.html?$/i, ''), requestKey: crypto.randomUUID(), files: [{ path: 'index.html', contentBase64: btoa(binary), sha256: Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('') }] });
    location.href = `/s/${publication.id}`;
  })().catch(error => { message(error.message); button.disabled = false; });
};
async function dashboard() {
  element('dashboard').hidden = false; const container = element('shares'); container.replaceChildren();
  if (!currentUser) { container.append(make('p', '使用 TokenToSea 登录后，可以管理你从 Fantay 工作台发布的分享。', 'empty')); return; }
  document.querySelector('.workspace-section')?.remove();
  await showTokenToSeaWorkspaces(element('dashboard'), api, message);
  const { shares } = await api<{ shares: ClientShare[] }>('/api/shares'); element('share-count').textContent = `${shares.length} 个作品`;
  if (!shares.length) container.append(make('p', '还没有分享。回到工作台打开作品，点击「分享」即可发布。', 'empty'));
  for (const share of shares) {
    const card = make('article', '', 'share-card'), links = make('div', '', 'actions'), link = make('a', '查看作品'); link.setAttribute('href', share.url);
    card.append(make('h3', share.title), make('p', `${share.status === 'active' ? '分享中' : '已停用'} · ${new Date(share.updatedAt).toLocaleString()}`));
    links.append(link, action(share.status === 'active' ? '停止分享' : '恢复分享', async () => { await api(`/api/shares/${share.id}/state`, 'POST', { revision: share.revision, status: share.status === 'active' ? 'stopped' : 'active' }); await dashboard(); })); card.append(links); container.append(card);
  }
}
function frameControl(selector?: string) { preview.contentWindow?.postMessage({ type: 'fantay-share:control', nonce, select: selecting, ...(selector ? { selector } : {}) }, '*'); }
function showTarget() { const box = element('target'); box.hidden = !target; box.textContent = target ? `评论位置：${target.text || target.label || '已选位置'}` : ''; }
element('select').onclick = () => { selecting = !selecting; element('select').textContent = selecting ? '点击作品中的位置…' : '在作品上选择位置'; frameControl(); };
preview.onload = () => frameControl();
addEventListener('message', event => {
  if (event.source !== preview.contentWindow || !event.data || event.data.type !== 'fantay-share:target' || event.data.nonce !== nonce || !selecting) return;
  const value = event.data.target;
  if (!value || typeof value.selector !== 'string' || value.selector.length > 1024 || typeof value.text !== 'string' || value.text.length > 300) return;
  target = { selector: value.selector, label: typeof value.label === 'string' ? value.label.slice(0, 100) : '', text: value.text, ...(typeof value.position?.x === 'number' && typeof value.position?.y === 'number' ? { position: value.position } : {}) };
  selecting = false; element('select').textContent = '在作品上选择位置'; frameControl(); showTarget(); note.focus();
});
async function loadComments() {
  const { comments } = await api<{ comments: ClientComment[] }>(`/api/shares/${shareId}/comments`), list = element('comments'); list.replaceChildren();
  if (!comments.length) { list.append(make('p', '还没有评论。留下第一条反馈吧。', 'help')); return; }
  for (const comment of comments) {
    const item = make('article', '', `comment ${comment.status === 'resolved' ? 'resolved' : ''}`), controls = make('div', '', 'actions');
    item.append(make('strong', comment.author.name), make('p', comment.text), make('small', `${new Date(comment.createdAt).toLocaleString()}${comment.status === 'resolved' ? ' · 已解决' : ''}${comment.version !== currentShare?.version ? ' · 基于较早版本' : ''}`));
    if (comment.target?.selector) controls.append(action('查看位置', async () => frameControl(comment.target!.selector)));
    if (comment.isMine || currentShare?.isOwner) {
      controls.append(action(comment.status === 'resolved' ? '重新打开' : '标记解决', async () => { await api(`/api/comments/${comment.id}`, 'PATCH', { status: comment.status === 'resolved' ? 'open' : 'resolved' }); await loadComments(); }));
      controls.append(action('删除', async () => { await api(`/api/comments/${comment.id}`, 'PATCH', { status: 'deleted' }); await loadComments(); }));
    }
    item.append(controls); list.append(item);
  }
}
async function viewer() {
  element('viewer').hidden = false;
  const previousVersion = currentShare?.version;
  currentShare = await api<ClientShare>(`/api/shares/${shareId}`);
  if (currentShare.status !== 'active') throw new ResponseError(410, '分享已停用');
  preview.hidden = false; element('comment-form').hidden = false; element('select').hidden = false;
  element('share-title').textContent = currentShare.title; element('share-version').textContent = `第 ${currentShare.revision} 次发布 · ${new Date(currentShare.updatedAt).toLocaleString()}`;
  const url = `/content/${shareId}/${currentShare.version}/index.html`;
  if (!previousVersion || previousVersion !== currentShare.version || preview.getAttribute('src') !== url) {
    preview.src = url;
    if (previousVersion && previousVersion !== currentShare.version) { target = null; showTarget(); message('作品已更新，请重新选择评论位置。你的草稿已保留。'); }
  }
  element<HTMLAnchorElement>('download').href = url;
  if (!previousVersion) try { const draft = JSON.parse(sessionStorage.getItem(`draft:${shareId}`) ?? 'null'); if (draft) { note.value = String(draft.text ?? '').slice(0, 3000); target = draft.target; showTarget(); } } catch { /* Invalid local draft can be ignored. */ }
  await loadComments();
}
function viewerError(error: Error) {
  message(error.message);
  if (error instanceof ResponseError && [404, 410].includes(error.status)) {
    preview.hidden = true; preview.removeAttribute('src'); element('comment-form').hidden = true; element('select').hidden = true; element('comments').replaceChildren();
    element('share-title').textContent = error.message;
  }
}
element('refresh').onclick = () => { void viewer().catch(viewerError); };
element<HTMLFormElement>('comment-form').onsubmit = event => {
  event.preventDefault(); if (!currentUser) { login(); return; }
  if (!note.value.trim() || !currentShare) return;
  const b = element<HTMLButtonElement>('submit'); b.disabled = true;
  void api(`/api/shares/${shareId}/comments`, 'POST', { text: note.value, target, version: currentShare.version, requestKey: crypto.randomUUID() }).then(async () => { note.value = ''; target = null; showTarget(); sessionStorage.removeItem(`draft:${shareId}`); await loadComments(); }).catch(e => message(e.message)).finally(() => { b.disabled = false; });
};
void auth().then(() => shareId ? viewer() : dashboard()).catch(error => { message(error.message); if (shareId) { element('viewer').hidden = false; viewerError(error); } });
if (shareId) window.setInterval(() => { if (currentShare && document.visibilityState === 'visible') void viewer().catch(viewerError); }, 15_000);
