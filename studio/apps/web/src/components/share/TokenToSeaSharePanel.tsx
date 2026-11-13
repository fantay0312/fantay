import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@open-design/components';
import { openHostExternalUrl } from '@open-design/host';
import { TokenToSeaAccount } from '../TokenToSeaAccount';
import styles from './TokenToSeaSharePanel.module.css';
import { TOKENTOSEA_SESSION_EVENT } from '../../lib/tokentosea-events';
import { notifyProjectShareHistoryChanged } from './share-publication-events';

type Publication = { id: string; title: string; status: 'active' | 'stopped'; url: string; revision: number; version: string };
type Comment = { id: string; text: string; author: { name: string }; isMine: boolean; status: string; version: string; target?: { text?: string; selector?: string }; createdAt: string };
const SERVICE_UNAVAILABLE = '分享服务暂时不可用', COPY_FAILED = '请手动复制链接';
async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // Proxies answer outages with HTML; a body that is not JSON is an outage, never a raw SyntaxError.
  const data = await response.json().catch(() => undefined) as { error?: unknown } | null | undefined;
  if (!response.ok || data === undefined) throw new Error(!response.ok && typeof data?.error === 'string' ? data.error : SERVICE_UNAVAILABLE);
  return data as T;
}
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** One publish per document and account. It outlives the panel (closing the Share
 * popover unmounts it), so a reopened panel shows the request in progress instead
 * of offering a second publish, and a retry reuses the idempotency key until a
 * publish succeeds. */
type PublishAttempt = { result: Promise<Publication>; copied?: Promise<boolean> };
type PublishFlight = { requestKey: string; attempt: PublishAttempt | null };
const publishFlights = new Map<string, PublishFlight>();
const publishFlightListeners = new Set<() => void>();
function subscribePublishFlights(listener: () => void) {
  publishFlightListeners.add(listener);
  return () => { publishFlightListeners.delete(listener); };
}
function startPublishFlight(key: string, send: (requestKey: string) => Promise<Publication>, historyProjectId: string): PublishAttempt {
  const existing = publishFlights.get(key);
  if (existing?.attempt) return existing.attempt;
  const flight = existing ?? { requestKey: crypto.randomUUID(), attempt: null };
  publishFlights.set(key, flight);
  const result = send(flight.requestKey).then(publication => {
    if (publishFlights.get(key) === flight) publishFlights.delete(key);
    // Project share history (after-export guide) must learn about this publication.
    if (historyProjectId) notifyProjectShareHistoryChanged(historyProjectId);
    return publication;
  }).finally(() => {
    flight.attempt = null;
    publishFlightListeners.forEach(listener => listener());
  });
  result.catch(() => undefined); // Reported by whichever panel is attached; none may be.
  flight.attempt = { result };
  publishFlightListeners.forEach(listener => listener());
  return flight.attempt;
}
export function TokenToSeaSharePanel({ projectId = '', fileName = '', canvas, disabled = false }: { projectId?: string; fileName?: string; canvas?: { id: string; sha256: string; html: string }; disabled?: boolean }) {
  const [user, setUser] = useState<{ id: string; name: string } | null>(null);
  const [publication, setPublication] = useState<Publication | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [feedback, setFeedback] = useState(''), [note, setNote] = useState('');
  const [checking, setChecking] = useState(true);
  const sequence = useRef(0), mounted = useRef(false), attached = useRef<PublishAttempt | null>(null);
  const contextVersion = useRef(0);
  const scope = `${canvas?.id ?? `${projectId}:${fileName}`}|${user?.id ?? ''}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const publishing = useSyncExternalStore(subscribePublishFlights, () => Boolean(user && publishFlights.get(scope)?.attempt), () => false);
  const locked = busy || publishing;
  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    setChecking(true);
    try {
      const status = await request<{ user: { id: string; name: string } | null; publication: Publication | null }>(`/api/tokentosea/shares?${new URLSearchParams(canvas ? { canvasId: canvas.id } : { projectId, fileName })}`);
      if (seq !== sequence.current) return;
      setUser(status.user); setPublication(status.publication); setError('');
      if (status.publication?.status === 'active') {
        const data = await request<{ comments: Comment[] }>(`/api/tokentosea/shares/${status.publication.id}/comments`);
        if (seq === sequence.current) setComments(data.comments);
      } else setComments([]);
    } catch (e) { if (seq === sequence.current) setError(e instanceof Error ? e.message : '读取分享失败'); }
    finally { if (seq === sequence.current) setChecking(false); }
  }, [projectId, fileName, canvas?.id]);
  useEffect(() => {
    ++contextVersion.current;
    setBusy(false); setPublication(null); setComments([]); setError(''); setFeedback(''); setNote(''); void refresh();
    const focus = () => { void refresh(); }; window.addEventListener('focus', focus);
    const accountChanged = () => { ++contextVersion.current; setUser(null); setPublication(null); setComments([]); setBusy(false); void refresh(); };
    window.addEventListener(TOKENTOSEA_SESSION_EVENT, accountChanged);
    const timer = window.setInterval(focus, 15_000);
    return () => { ++sequence.current; clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener(TOKENTOSEA_SESSION_EVENT, accountChanged); };
  }, [refresh]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /** Reflect one publish attempt in this panel. A panel unmounted by closing the
   * popover still counts as current (its context never changed), so a background
   * publish delivers its link; attached panels share one clipboard write. */
  const attach = useCallback((attempt: PublishAttempt) => {
    if (attached.current === attempt) return;
    attached.current = attempt;
    const attachScope = scopeRef.current, attachVersion = contextVersion.current;
    const isCurrent = () => scopeRef.current === attachScope && contextVersion.current === attachVersion;
    setError(''); setFeedback('');
    void attempt.result.then(async result => {
      if (!isCurrent()) return;
      setPublication(result);
      const copied = await (attempt.copied ??= copyText(result.url));
      if (!isCurrent() || !mounted.current) return;
      setFeedback(copied ? '分享链接已复制' : '分享已发布，可复制下方链接');
      await refresh();
    }, (e: unknown) => { if (isCurrent()) setError(e instanceof Error ? e.message : '操作失败'); });
  }, [refresh]);
  useEffect(() => {
    const attempt = publishFlights.get(scope)?.attempt;
    if (publishing && attempt) attach(attempt);
  }, [publishing, scope, attach]);
  async function perform(action: (isCurrent: () => boolean) => Promise<void>) {
    const requestScope = scopeRef.current;
    const requestVersion = contextVersion.current;
    const isCurrent = () => scopeRef.current === requestScope && contextVersion.current === requestVersion;
    setBusy(true); setError(''); setFeedback('');
    try { await action(isCurrent); if (isCurrent()) await refresh(); }
    catch (e) { if (isCurrent()) setError(e instanceof Error ? e.message : '操作失败'); }
    finally { if (isCurrent()) setBusy(false); }
  }
  function publish() {
    if (!user || disabled || locked) return;
    const target = canvas ? { canvasId: canvas.id, canvasSha: canvas.sha256, html: canvas.html } : { projectId, fileName };
    const revision = publication ? { revision: publication.revision } : {};
    attach(startPublishFlight(scope, requestKey => request<Publication>('/api/tokentosea/shares/publish', 'POST', { ...target, requestKey, ...revision }), canvas ? '' : projectId));
  }
  function copyLink(url: string) {
    void copyText(url).then(copied => {
      if (copied) { setError(current => current === COPY_FAILED ? '' : current); setFeedback('链接已复制'); }
      else { setFeedback(''); setError(COPY_FAILED); }
    });
  }
  return <div className={styles.panel} data-testid="tokentosea-share-panel">
    <div><strong>通过 TokenToSea 分享</strong><p className={styles.hint}>发布可访问的作品链接，评论会同步到这里。</p></div>
    {!user ? <><TokenToSeaAccount onSignedIn={refresh} /><p className={styles.hint}>使用你的 TokenToSea 账号发布和管理分享。</p></> : <>
      <span className={styles.identity}>{user.name}</span>
      {publication ? <div className={styles.publication}><span>{publication.status === 'active' ? '链接分享中' : '分享已停止'}</span><a href={publication.url} target="_blank" rel="noopener noreferrer">{publication.url}</a>
        <div className={styles.actions}><Button size="sm" variant="ghost" disabled={locked || disabled} onClick={() => copyLink(publication.url)}>复制链接</Button><Button size="sm" variant="ghost" onClick={() => void openHostExternalUrl(publication.url)}>打开</Button>
          <Button size="sm" variant="ghost" disabled={locked || checking || disabled} onClick={() => void perform(async () => { await request(`/api/tokentosea/shares/${publication.id}/state`, 'POST', { status: publication.status === 'active' ? 'stopped' : 'active', revision: publication.revision }); })}>{publication.status === 'active' ? '停止分享' : '恢复同一链接'}</Button></div>
      </div> : null}
      {publication?.status !== 'stopped' ? <Button disabled={locked || checking || disabled} onClick={publish}>{locked ? '正在发布…' : publication ? '更新分享内容' : '发布并复制链接'}</Button> : null}
      {publication?.status === 'active' ? <div className={styles.comments}><div className={styles.actions}><strong>评论 ({comments.length})</strong><Button size="sm" variant="ghost" disabled={locked} onClick={() => void refresh()}>刷新</Button></div>
        {comments.map(comment => <article key={comment.id} className={styles.comment}><strong>{comment.author.name}</strong><p>{comment.text}</p>{comment.target?.text ? <small>位置：{comment.target.text}</small> : null}{comment.version !== publication.version ? <small>基于较早版本</small> : null}<div className={styles.actions}><small>{comment.status === 'resolved' ? '已解决' : new Date(comment.createdAt).toLocaleString()}</small><Button size="sm" variant="ghost" disabled={locked} onClick={() => void perform(async () => { await request(`/api/tokentosea/shares/comments/${comment.id}`, 'PATCH', { status: comment.status === 'resolved' ? 'open' : 'resolved' }); })}>{comment.status === 'resolved' ? '重新打开' : '标记解决'}</Button></div></article>)}
        <label className={styles.note}>补充评论<textarea value={note} maxLength={3000} rows={3} onChange={e => setNote(e.target.value)} placeholder="写下反馈…" /></label><Button size="sm" disabled={locked || checking || !note.trim()} onClick={() => void perform(async isCurrent => { await request(`/api/tokentosea/shares/${publication.id}/comments`, 'POST', { text: note.trim(), version: publication.version, requestKey: crypto.randomUUID() }); if (isCurrent()) setNote(''); })}>发布评论</Button>
      </div> : null}
    </>}
    {feedback ? <p role="status" className={styles.hint}>{feedback}</p> : null}{error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {disabled ? <p className={styles.hint}>作品保存完成后即可发布。</p> : null}
  </div>;
}
