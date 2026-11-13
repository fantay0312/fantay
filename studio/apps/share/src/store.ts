import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { HttpError, type PublishInput, type Target, type User } from './types.js';

export const MAX_BYTES = 20 * 1024 * 1024;
type Row = { id: string; owner: string; document_key: string; title: string; status: string; revision: number; version: string; updated_at: string };
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new HttpError(400, '内容格式无效');
  return value.trim();
}
export function safePath(value: unknown): string {
  const p = text(value, 500);
  if (p.includes('\\') || p.startsWith('/') || p.split('/').some(x => !x || x === '.' || x === '..') || /[\x00-\x1f]/.test(p)) throw new HttpError(400, '文件路径无效');
  return p;
}
export function decodeFiles(input: PublishInput): Array<{ path: string; bytes: Buffer; sha256: string }> {
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 500) throw new HttpError(400, '文件数量无效');
  let total = 0;
  const names = new Set<string>();
  const files = input.files.map(file => {
    const p = safePath(file.path), canonical = p.normalize('NFC').toLowerCase();
    if (names.has(canonical)) throw new HttpError(400, '存在重复文件路径');
    names.add(canonical);
    if (typeof file.contentBase64 !== 'string' || file.contentBase64.length > 28 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) throw new HttpError(400, '文件编码无效');
    const bytes = Buffer.from(file.contentBase64, 'base64'); total += bytes.length;
    if (total > MAX_BYTES) throw new HttpError(413, '每次分享最多 20 MB');
    const sha256 = hash(bytes);
    if (sha256 !== file.sha256) throw new HttpError(400, '文件校验失败');
    return { path: p, bytes, sha256 };
  });
  if (!files.some(file => file.path === 'index.html')) throw new HttpError(400, '缺少 index.html');
  for (const name of names) for (const other of names) if (other !== name && other.startsWith(`${name}/`)) throw new HttpError(400, '文件与目录路径冲突');
  return files;
}
function cleanTarget(value: unknown): Target | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '评论位置无效');
  const v = value as Record<string, unknown>, target: Target = {};
  for (const key of ['selector', 'label', 'text'] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'string' || (v[key] as string).length > (key === 'selector' ? 1024 : 300)) throw new HttpError(400, '评论位置无效');
    target[key] = v[key] as string;
  }
  if (v.position != null) {
    const pos = v.position as { x?: unknown; y?: unknown };
    if (typeof pos.x !== 'number' || typeof pos.y !== 'number' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.x < 0 || pos.x > 1 || pos.y < 0 || pos.y > 1) throw new HttpError(400, '评论坐标无效');
    target.position = { x: pos.x, y: pos.y };
  }
  return target;
}

export class ShareStore {
  readonly db: DatabaseSync;
  private readonly reservations = new Map<string, { owner: string; bytes: number }>();
  constructor(readonly directory: string, readonly origin: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'shares.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY,owner TEXT NOT NULL,document_key TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,version TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner,document_key));
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,share_id TEXT NOT NULL,manifest TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(owner TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,request_key));
      CREATE TABLE IF NOT EXISTS comments(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,share_id TEXT NOT NULL,version TEXT NOT NULL,author TEXT NOT NULL,author_name TEXT NOT NULL,text TEXT NOT NULL,target TEXT,status TEXT NOT NULL,request_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(share_id,author,request_key));`);
  }
  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM shares WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, '分享不存在');
    return row;
  }
  private present(row: Row) {
    return { id: row.id, title: row.title, status: row.status, revision: row.revision, version: row.version, updatedAt: row.updated_at, url: `${this.origin}/s/${row.id}` };
  }
  get(id: string, user?: User | null) {
    const row = this.row(id);
    if (row.status !== 'active' && user?.id !== row.owner) throw new HttpError(410, '分享已停用');
    return { ...this.present(row), isOwner: row.owner === user?.id };
  }
  list(user: User) { return (this.db.prepare('SELECT * FROM shares WHERE owner=? ORDER BY updated_at DESC LIMIT 500').all(user.id) as Row[]).map(row => ({ ...this.present(row), documentKey: row.document_key })); }
  async publish(user: User, input: PublishInput, requestedId?: string) {
    const documentKey = text(input.documentKey, 300), title = text(input.title, 160), requestKey = text(input.requestKey, 100);
    const files = decodeFiles(input);
    const fingerprint = hash(JSON.stringify([documentKey, title, files.map(f => [f.path, f.sha256]).sort()]));
    const previousRequest = this.db.prepare('SELECT * FROM requests WHERE owner=? AND request_key=?').get(user.id, requestKey) as { fingerprint: string; result: string } | undefined;
    if (previousRequest) {
      if (previousRequest.fingerprint !== fingerprint) throw new HttpError(409, '请求标识已用于其他内容');
      return JSON.parse(previousRequest.result);
    }
    const existing = this.db.prepare('SELECT * FROM shares WHERE owner=? AND document_key=?').get(user.id, documentKey) as Row | undefined;
    if (existing?.status === 'stopped') throw new HttpError(409, '请先恢复分享，再更新内容');
    if (existing && input.expectedRevision !== existing.revision) throw new HttpError(409, '分享已经更新，请刷新后重试');
    const totalStored = Number((this.db.prepare('SELECT COALESCE(SUM(size),0) AS size FROM versions v JOIN shares s ON s.id=v.share_id WHERE s.owner=?').get(user.id) as { size: number }).size);
    const versionCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM versions v JOIN shares s ON s.id=v.share_id WHERE s.owner=?').get(user.id) as { count: number }).count);
    const incomingSize = files.reduce((sum, file) => sum + file.bytes.length, 0);
    const allStored = Number((this.db.prepare('SELECT COALESCE(SUM(size),0) AS size FROM versions').get() as { size: number }).size);
    const reserved = [...this.reservations.values()];
    const ownerReserved = reserved.filter(item => item.owner === user.id);
    if (totalStored + incomingSize + ownerReserved.reduce((sum, item) => sum + item.bytes, 0) > 1024 * 1024 * 1024 || versionCount + ownerReserved.length >= 500 || allStored + incomingSize + reserved.reduce((sum, item) => sum + item.bytes, 0) > 20 * 1024 * 1024 * 1024) throw new HttpError(413, '分享存储已达上限');
    if (requestedId && (!/^[a-f0-9-]{36}$/.test(requestedId) || existing && existing.id !== requestedId)) throw new HttpError(409, '分享标识冲突');
    const id = existing?.id ?? requestedId ?? randomUUID(), version = randomUUID(), timestamp = new Date().toISOString();
    const directory = path.join(this.directory, 'versions', version);
    this.reservations.set(version, { owner: user.id, bytes: incomingSize });
    let committed = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const file of files) { const dest = path.join(directory, file.path); await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 }); await writeFile(dest, file.bytes, { flag: 'wx', mode: 0o600 }); }
      const repeated = this.db.prepare('SELECT fingerprint,result FROM requests WHERE owner=? AND request_key=?').get(user.id, requestKey) as { fingerprint: string; result: string } | undefined;
      if (repeated) { if (repeated.fingerprint !== fingerprint) throw new HttpError(409, '请求标识已用于其他内容'); return JSON.parse(repeated.result); }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const stored = this.db.prepare('SELECT COALESCE(SUM(size),0) AS size,COUNT(*) AS count FROM versions v JOIN shares s ON s.id=v.share_id WHERE s.owner=?').get(user.id) as { size: number; count: number };
        const global = this.db.prepare('SELECT COALESCE(SUM(size),0) AS size FROM versions').get() as { size: number };
        if (Number(stored.size) + incomingSize > 1024 * 1024 * 1024 || Number(stored.count) >= 500 || Number(global.size) + incomingSize > 20 * 1024 * 1024 * 1024) throw new HttpError(413, '分享存储已达上限');
        const latest = this.db.prepare('SELECT * FROM shares WHERE owner=? AND document_key=?').get(user.id, documentKey) as Row | undefined;
        if ((latest?.revision ?? 0) !== (existing?.revision ?? 0)) throw new HttpError(409, '分享已被其他请求更新');
        this.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?)').run(version, id, JSON.stringify(files.map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes.length }))), fingerprint, timestamp, incomingSize);
        if (existing) this.db.prepare('UPDATE shares SET title=?,version=?,revision=revision+1,updated_at=? WHERE id=?').run(title, version, timestamp, id);
        else this.db.prepare('INSERT INTO shares VALUES(?,?,?,?,?,?,?,?)').run(id, user.id, documentKey, title, 'active', 1, version, timestamp);
        const result = this.present(this.row(id));
        this.db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(user.id, requestKey, fingerprint, JSON.stringify(result));
        this.db.exec('COMMIT'); committed = true; return result;
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } finally { this.reservations.delete(version); if (!committed) await rm(directory, { recursive: true, force: true }); }
  }
  changeState(user: User, id: string, status: unknown, revision: unknown) {
    const row = this.row(id);
    if (row.owner !== user.id) throw new HttpError(403, '仅发布者可以修改分享');
    if (status !== 'active' && status !== 'stopped') throw new HttpError(400, '分享状态无效');
    if (revision !== row.revision) throw new HttpError(409, '分享状态已变化，请刷新后重试');
    this.db.prepare('UPDATE shares SET status=?,revision=revision+1,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id);
    return this.present(this.row(id));
  }
  async asset(id: string, version: string, file: string) {
    const row = this.row(id); if (row.status !== 'active') throw new HttpError(410, '分享已停用');
    const p = safePath(file);
    const v = this.db.prepare('SELECT manifest FROM versions WHERE id=? AND share_id=?').get(version, id) as { manifest: string } | undefined;
    if (!v || !(JSON.parse(v.manifest) as { path: string }[]).some(entry => entry.path === p)) throw new HttpError(404, '文件不存在');
    return readFile(path.join(this.directory, 'versions', version, p));
  }
  comments(id: string, user?: User | null) {
    this.get(id); // Stopping a link stops anonymous content and comment reads alike.
    return (this.db.prepare("SELECT * FROM comments WHERE share_id=? AND status!='deleted' ORDER BY seq LIMIT 500").all(id) as Array<Record<string, unknown>>).map(c => ({ id: c.id, seq: c.seq, version: c.version, text: c.text, author: { name: c.author_name }, isMine: c.author === user?.id, target: c.target ? JSON.parse(String(c.target)) : null, status: c.status, createdAt: c.created_at }));
  }
  addComment(user: User, id: string, input: Record<string, unknown>) {
    const share = this.row(id); if (share.status !== 'active') throw new HttpError(410, '分享已停用');
    if (input.version !== share.version) throw new HttpError(409, '作品已更新，请刷新后重新选择评论位置');
    const note = text(input.text, 3000), requestKey = text(input.requestKey, 100), target = cleanTarget(input.target);
    const existing = this.db.prepare('SELECT id,text,target,version FROM comments WHERE share_id=? AND author=? AND request_key=?').get(id, user.id, requestKey) as { id: string; text: string; target: string | null; version: string } | undefined;
    const encodedTarget = target ? JSON.stringify(target) : null;
    if (existing && (existing.text !== note || existing.target !== encodedTarget || existing.version !== input.version)) throw new HttpError(409, '评论请求标识已使用');
    if (!existing && Number((this.db.prepare("SELECT COUNT(*) AS count FROM comments WHERE share_id=? AND status!='deleted'").get(id) as { count: number }).count) >= 500) throw new HttpError(409, '评论已达 500 条上限，请先清理旧评论');
    if (!existing) { const now = new Date().toISOString(); this.db.prepare('INSERT INTO comments(id,share_id,version,author,author_name,text,target,status,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, share.version, user.id, user.name, note, encodedTarget, 'open', requestKey, now, now); }
    return this.comments(id, user);
  }
  changeComment(user: User, id: string, input: Record<string, unknown>) {
    const comment = this.db.prepare('SELECT * FROM comments WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!comment) throw new HttpError(404, '评论不存在');
    const share = this.row(String(comment.share_id)); if (share.status !== 'active') throw new HttpError(410, '分享已停用');
    if (comment.author !== user.id && share.owner !== user.id) throw new HttpError(403, '无权修改此评论');
    if (!['open', 'resolved', 'deleted'].includes(String(input.status))) throw new HttpError(400, '评论状态无效');
    this.db.prepare('UPDATE comments SET status=?,updated_at=? WHERE id=?').run(String(input.status), new Date().toISOString(), id);
    return this.comments(share.id, user);
  }
  close() { this.db.close(); }
}
