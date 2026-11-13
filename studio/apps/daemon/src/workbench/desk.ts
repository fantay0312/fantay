// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// 工作台的业务层：路由和命令行调用的都是这里。每个方法对应 `/api/workbench/*` 的一个接口。
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WORKBENCH_PAGES,
  type WorkbenchCaptureResponse, type WorkbenchChatAction, type WorkbenchChatMessage, type WorkbenchChatResponse,
  type WorkbenchModelsResponse, type WorkbenchOp, type WorkbenchOpsResponse, type WorkbenchOrganizeResponse, type WorkbenchPage,
  type WorkbenchProduceResponse, type WorkbenchProductionResponse, type WorkbenchPublicSettings, type WorkbenchReaderResponse,
  type WorkbenchReceipt, type WorkbenchSaveResponse, type WorkbenchSearchMode, type WorkbenchSearchResponse, type WorkbenchSettingsTestResponse,
  type WorkbenchSkillsExportResponse, type WorkbenchSkillsLearnResponse, type WorkbenchSocialImportResponse, type WorkbenchSocialStatus,
  type WorkbenchState, type WorkbenchStateResponse, type WorkbenchStyleExtractResponse, type WorkbenchUndoResponse, type WorkbenchUploadResponse,
} from '@open-design/contracts';
import {
  callText, chatPrompts, configureWorkbenchModels, currentTextModel, extractJson, imageModels, modelLabel, modelStatus,
  pickModel, resetModelStatus, signedIn, textModels,
} from './ai.js';
import { defaultExportDir, resolveExportDir, saveProduction } from './export.js';
import { assertPublicUrl, fetchPublic, harvest, harvestText, readLimited } from './harvest.js';
import { currentLang, httpError, platformName, tr } from './i18n.js';
import { generateImage, imageReady, TEST_PROMPT } from './images.js';
import { localIntent } from './intents.js';
import { computeInsights, exportSkill, proposeRules } from './learn.js';
import { applyOrganize, buildReader, organizeItems, readMinutesFor, searchLibrary } from './library-ai.js';
import { applyOps, liveItems, newId } from './ops.js';
import { applyRevision, Producer } from './produce.js';
import { localizeSamples, samplesNeedLocale } from './seed.js';
import { WorkbenchSettingsStore } from './settings.js';
import { fetchAccount, importPosts, postsToMaterial, resolveAccount, saveCovers, socialStatus } from './social-import.js';
import { WorkbenchStore } from './store.js';
import { normalizeStyle, referenceExcerpt, stylePrompts } from './style.js';

type Body = Record<string, unknown>;

export const MAX_UPLOAD_BYTES = 250_000_000;
const MAX_MEDIA_READ_BYTES = 25_000_000;
const CHAT_HISTORY = 300;

/** 允许上传的类型 → 扩展名和条目类型。扩展名唯一对应一种 MIME，读文件时据此回填 content-type。 */
export const UPLOAD_TYPES: Record<string, { ext: string; kind: WorkbenchUploadResponse['kind']; mime: string }> = {
  'image/jpeg': { ext: '.jpg', kind: 'image', mime: 'image/jpeg' },
  'image/png': { ext: '.png', kind: 'image', mime: 'image/png' },
  'image/webp': { ext: '.webp', kind: 'image', mime: 'image/webp' },
  'image/gif': { ext: '.gif', kind: 'image', mime: 'image/gif' },
  'video/mp4': { ext: '.mp4', kind: 'video', mime: 'video/mp4' },
  'video/webm': { ext: '.webm', kind: 'video', mime: 'video/webm' },
  'video/quicktime': { ext: '.mov', kind: 'video', mime: 'video/quicktime' },
  'application/pdf': { ext: '.pdf', kind: 'pdf', mime: 'application/pdf' },
  'audio/webm': { ext: '.weba', kind: 'audio', mime: 'audio/webm' },
  'audio/mp4': { ext: '.m4a', kind: 'audio', mime: 'audio/mp4' },
  'audio/mpeg': { ext: '.mp3', kind: 'audio', mime: 'audio/mpeg' },
  'audio/wav': { ext: '.wav', kind: 'audio', mime: 'audio/wav' },
  'audio/x-wav': { ext: '.wav', kind: 'audio', mime: 'audio/wav' },
  'audio/wave': { ext: '.wav', kind: 'audio', mime: 'audio/wav' },
  'audio/ogg': { ext: '.ogg', kind: 'audio', mime: 'audio/ogg' },
};

export const FILE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf',
  '.weba': 'audio/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

const SAFE_NAME = /^[\w.-]+$/;

const str = (value: unknown, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** 同一次故障只提醒一次，用人话说。原始错误放在模型状态的提示里。 */
function outageNotice(wasDown: boolean, fallback: string): string | null {
  // 没登录是一种状态，每次都说；模型故障同一次只提醒一次
  if (!signedIn()) return tr('请先登录 TokenToSea，{fallback}。', { fallback });
  return wasDown ? null : tr('模型暂时用不了，{fallback}。可以到设置里检查 TokenToSea 账号和模型。', { fallback });
}

export interface WorkbenchDeskOptions {
  /** 工作台数据目录，由 server.ts 从 RUNTIME_DATA_DIR 派生后传入。 */
  root: string;
  /** 内置示例素材（只读资源目录）。 */
  assetsDir: string;
  /** Fantay 用户 Skills 目录，导出写作规则时写到这里。 */
  userSkillsDir: string;
}

export class WorkbenchDesk {
  readonly store: WorkbenchStore;
  readonly settings: WorkbenchSettingsStore;
  readonly producer: Producer;
  readonly assetsDir: string;
  readonly userSkillsDir: string;
  private importing = false;
  private settled = false;

  constructor(options: WorkbenchDeskOptions) {
    this.store = new WorkbenchStore(options.root);
    this.settings = new WorkbenchSettingsStore(options.root);
    this.assetsDir = options.assetsDir;
    this.userSkillsDir = options.userSkillsDir;
    this.producer = new Producer({ store: this.store, settings: this.settings, callText, generate: (settings, prompt, opts) => generateImage(settings, prompt, opts), ready: imageReady });
    configureWorkbenchModels(() => this.settings.read());
  }

  // ── 文件 ──────────────────────────────────────────────────────

  /** 只接受单段文件名，拼出素材或用户文件的绝对路径。 */
  filePath(scope: 'files' | 'assets', name: string): string {
    if (!SAFE_NAME.test(name) || name.startsWith('.')) throw httpError(tr('路径无效'), 400);
    return path.join(scope === 'files' ? this.store.filesDir : this.assetsDir, name);
  }

  /** 给 AI 整理用：读一张图或一个文件的内容；外部链接只读公开地址，读不到时返回 null。 */
  async readMedia(src: string): Promise<Buffer | null> {
    try {
      const local = /^workbench\/(files|assets)\/([\w.-]+)$/.exec(src);
      if (local) {
        const file = this.filePath(local[1] as 'files' | 'assets', local[2]!);
        if ((await stat(file)).size > MAX_MEDIA_READ_BYTES) return null;
        return await readFile(file);
      }
      if (!/^https?:\/\//i.test(src)) return null;
      const { res } = await fetchPublic(src, fetch, { accept: 'image/*,application/pdf,*/*;q=0.5', timeoutMs: 15_000 });
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); return null; }
      return await readLimited(res, MAX_MEDIA_READ_BYTES);
    } catch {
      return null;
    }
  }

  async saveUpload(contentType: string, buffer: Buffer): Promise<WorkbenchUploadResponse> {
    const type = UPLOAD_TYPES[contentType];
    if (!type) throw httpError(tr('不支持这种文件：{type}', { type: contentType || tr('未知') }), 415);
    if (!buffer.length) throw httpError(tr('文件是空的'), 400);
    await this.store.read();
    const name = `${newId('f')}${type.ext}`;
    await writeFile(path.join(this.store.filesDir, name), buffer);
    return { src: `workbench/files/${name}`, kind: type.kind, mime: type.mime, bytes: buffer.length };
  }

  // ── 状态与操作 ────────────────────────────────────────────────

  async state(): Promise<WorkbenchStateResponse> {
    if (!this.settled) { this.settled = true; await this.producer.settleAll().catch(() => undefined); }
    let state = await this.store.read();
    // 示例数据跟着界面语言走；用户自己的内容不动
    if (samplesNeedLocale(state, currentLang())) state = await this.store.mutate('', draft => localizeSamples(draft, currentLang()), { undoable: false });
    const model = await currentTextModel();
    return { state, signedIn: signedIn(), model: model ? modelLabel(model) : null, modelOk: modelStatus.ok, modelError: modelStatus.error, canUndo: this.store.canUndo, undoLabel: this.store.undoLabel };
  }

  async ops(body: Body): Promise<WorkbenchOpsResponse> {
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.slice(0, 80) : tr('操作');
    if (!Array.isArray(body.ops)) throw httpError(tr('ops 需要是一个数组'), 400);
    const { receipts, errors, state, uploads } = await this.store.mutate(label, (draft) => {
      const before = new Set(draft.items.map(row => row.id));
      const applied = applyOps(draft, body.ops);
      // 新收进来的上传文件交给 AI 整理
      const uploads = draft.items.filter(row => !before.has(row.id) && typeof row.media?.src === 'string' && row.media.src.startsWith('workbench/files/')).map(row => row.id);
      return { ...applied, state: draft, uploads };
    }, { undoable: body.undoable !== false });
    this.scheduleOrganize(uploads);
    return { receipts, errors, state, canUndo: this.store.canUndo };
  }

  async undo(): Promise<WorkbenchUndoResponse> {
    const label = await this.store.undoLast();
    return { label, state: await this.store.read(), canUndo: this.store.canUndo };
  }

  // ── 对话 ──────────────────────────────────────────────────────

  async chat(body: Body): Promise<WorkbenchChatResponse> {
    const message = str(body.message, 8000);
    if (!message) throw httpError(tr('消息为空'), 400);
    const focusId = typeof body.focusId === 'string' && body.focusId ? body.focusId : undefined;
    const snapshot = structuredClone(await this.store.read());
    let plan: Record<string, any>;
    let engine = 'local';
    let notice: string | null = null;
    const wasDown = modelStatus.ok === false;
    try {
      const history = snapshot.chat.filter(row => (row.itemId ?? null) === (focusId ?? null));
      const { system, user } = chatPrompts(snapshot, message, { focusId, history });
      const editing = snapshot.items.find(row => row.id === focusId)?.production?.status === 'done';
      const { text, model } = await callText({ system, user, maxTokens: editing ? 8000 : 3000, light: true, signal: AbortSignal.timeout(editing ? 240_000 : 90_000) });
      engine = model;
      try {
        plan = extractJson(text);
        if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('not an object');
        if (typeof plan.reply !== 'string') plan.reply = tr('处理好了。');
      } catch {
        // 模型只回了一段话时，当成普通回答，不算失败
        plan = { reply: text.trim().slice(0, 1200) || tr('我没有听懂，可以换个说法吗？'), ops: [] };
      }
    } catch {
      notice = outageNotice(wasDown, tr('先用本地规则处理'));
      plan = localIntent(snapshot, message, { focusId });
    }
    const canDraw = await this.producer.ready();
    // 只把真正改了数据的那一步放进撤销；问一句话不占撤销位
    const changed = await this.store.mutate(tr('对话：{text}', { text: message.slice(0, 18) }), (draft) => {
      const target = focusId ? draft.items.find(row => row.id === focusId) : null;
      const production = target?.production?.status === 'done' ? target.production : null;
      // 本地规则只会改灵感标题；有成稿时要改的是成稿标题
      const ops = (Array.isArray(plan.ops) ? plan.ops : []).map((op: WorkbenchOp) => {
        if (production && op?.op === 'update_item' && op.id === focusId && typeof op.title === 'string') return { op: 'update_production', id: focusId, title: op.title };
        return op;
      });
      const { receipts, errors } = applyOps(draft, ops);
      let targets: string[] = [];
      if (production && plan.revise) {
        // 没接生图时，图不会重画，回执要说实话
        const revision = applyRevision(production, plan.revise, { canDraw });
        receipts.push(...revision.receipts.map(text => ({ text })));
        errors.push(...revision.errors);
        targets = canDraw ? revision.targets : [];
      }
      return { receipts, errors, targets, done: Boolean(production) };
    });
    const result = await this.store.mutate('对话记录', (draft) => {
      const { receipts, errors, targets, done } = changed;
      const at = new Date().toISOString();
      const live = new Map(liveItems(draft).map(row => [row.id, row]));
      const actions = normalizeActions(plan.actions, live, done ? focusId : undefined);
      const citations = focusId ? [] : [...new Set((Array.isArray(plan.citations) ? plan.citations : []).filter((id: unknown): id is string => typeof id === 'string' && live.has(id)))].slice(0, 8);
      draft.chat.push({ id: newId('c'), at, role: 'user', text: message, ...(focusId ? { itemId: focusId } : {}) });
      const answer: WorkbenchChatMessage = {
        id: newId('c'), at, role: 'assistant', text: String(plan.reply).slice(0, 4000), receipts: receipts as WorkbenchReceipt[], errors, engine, notice,
        undoable: receipts.length > 0, ...(focusId ? { itemId: focusId } : {}), ...(citations.length ? { citations } : {}),
      };
      draft.chat.push(answer);
      draft.chat = draft.chat.slice(-CHAT_HISTORY);
      return { answer, actions, targets, state: draft };
    }, { undoable: false });
    if (canDraw && focusId && result.targets.length) {
      await Promise.all(result.targets.map(target => this.producer.regenerate(focusId, target).catch(() => undefined)));
      return { answer: result.answer, actions: result.actions, state: await this.store.read(), modelOk: modelStatus.ok, modelError: modelStatus.error, canUndo: this.store.canUndo };
    }
    return { answer: result.answer, actions: result.actions, state: result.state, modelOk: modelStatus.ok, modelError: modelStatus.error, canUndo: this.store.canUndo };
  }

  async clearChat(): Promise<{ state: WorkbenchState }> {
    const state = await this.store.mutate('清空对话', (draft) => { draft.chat = []; return draft; }, { undoable: false });
    return { state };
  }

  // ── 成稿 ──────────────────────────────────────────────────────

  async produce(body: Body): Promise<WorkbenchProduceResponse> {
    const id = str(body.id, 200);
    if (!id) throw httpError(tr('找不到这条灵感'), 404);
    const started = await this.producer.start(id, { withImages: body.withImages });
    return { started, state: await this.store.read() };
  }

  async production(id: string): Promise<WorkbenchProductionResponse> {
    await this.producer.settle(id);
    const state = await this.store.read();
    const item = state.items.find(row => row.id === id);
    const live = this.producer.status(id);
    return { production: item?.production ?? null, ...(item ? { status: item.status } : {}), live: live.running ? live : null };
  }

  async cancelProduce(body: Body): Promise<{ ok: true }> {
    await this.producer.cancel(str(body.id, 200));
    return { ok: true };
  }

  async regen(body: Body): Promise<{ state: WorkbenchState }> {
    await this.producer.regenerate(str(body.id, 200), body.target);
    return { state: await this.store.read() };
  }

  async save(body: Body): Promise<WorkbenchSaveResponse> {
    const id = str(body.id, 200);
    const settings = await this.settings.read();
    const state = await this.store.read();
    const item = state.items.find(row => row.id === id);
    if (!item?.production?.article) throw httpError(tr('还没有可以保存的成稿'), 400);
    // 视频封面由浏览器合成（画面叠大字），这里只接受 JPEG
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(typeof body.videoCover === 'string' ? body.videoCover : '');
    const videoCover = match ? Buffer.from(match[1]!, 'base64') : null;
    if (videoCover && !(videoCover[0] === 0xff && videoCover[1] === 0xd8)) throw httpError(tr('封面不是有效的图片'), 400);
    const saved = await saveProduction(item.production, { filesDir: this.store.filesDir, exportDir: resolveExportDir(settings.exportDir), videoCover });
    const next = await this.store.mutate('保存成稿', (draft) => {
      const target = draft.items.find(row => row.id === id);
      if (target?.production) {
        target.production.savedPath = saved.path;
        target.production.savedAt = new Date().toISOString();
      }
      return draft;
    }, { undoable: false });
    return { ...saved, state: next };
  }

  /** 路径只取自保存记录，不接受请求里传来的路径。 */
  async reveal(body: Body): Promise<{ path: string }> {
    const state = await this.store.read();
    const saved = state.items.find(row => row.id === body.id)?.production?.savedPath;
    if (!saved) throw httpError(tr('还没有保存过'), 400);
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(command, [saved], () => undefined);
    return { path: saved };
  }

  // ── 风格与账号 ────────────────────────────────────────────────

  async extractStyle(body: Body): Promise<WorkbenchStyleExtractResponse> {
    const urls = (Array.isArray(body.urls) ? body.urls : []).map(row => String(row).trim()).filter(Boolean).slice(0, 5);
    const parts = [String(body.text ?? '').trim()].filter(Boolean);
    const failures: string[] = [];
    for (const url of urls) {
      try {
        const page = await harvestText(url);
        if (page.text.length >= 80) parts.push(`${page.title ?? ''}\n${page.text}`);
        else failures.push(tr('{url}：页面上几乎没有文字，可能需要登录', { url }));
      } catch (error) {
        failures.push(tr('{url}：{error}', { url, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    const material = parts.join('\n\n---\n\n');
    if (material.length < 80) {
      throw httpError(failures.length ? tr('抓不到内容。{reason}。可以把内容直接贴进来。', { reason: failures[0] }) : tr('内容太少了，至少贴一段完整的文字'), 400);
    }
    const name = str(body.name, 20);
    const source = urls.length && parts.length === urls.length ? tr('链接') : urls.length ? tr('内容和链接') : tr('内容');
    return this.styleFromMaterial({ material, name, source, sourceUrls: urls, failures });
  }

  /** 提炼一张风格卡并设为当前风格。同一个账号再抓一次时更新原来那张。 */
  private async styleFromMaterial({ material, name, source, sourceUrls = [], failures = [], accountKey = null }: { material: string; name: string; source: string; sourceUrls?: string[]; failures?: string[]; accountKey?: string | null }): Promise<WorkbenchStyleExtractResponse> {
    let style: ReturnType<typeof normalizeStyle>;
    try {
      const { system, user } = stylePrompts(material, name);
      const { text } = await callText({ system, user, maxTokens: 1500, light: true, signal: AbortSignal.timeout(120_000) });
      style = normalizeStyle(extractJson(text), name);
    } catch (error) {
      throw httpError(tr('提炼风格需要文字模型：{error}', { error: error instanceof Error ? error.message : String(error) }), (error as { status?: number }).status === 401 ? 401 : 502);
    }
    return this.store.mutate(tr('提炼风格「{name}」', { name: style.name }), (draft) => {
      const existing = accountKey ? (draft.styles ?? []).find(row => row.accountKey === accountKey) : null;
      const id = existing?.id ?? newId('st');
      const row = { id, ...style, reference: referenceExcerpt(material), source, sourceUrls, ...(accountKey ? { accountKey } : {}), createdAt: existing?.createdAt ?? new Date().toISOString() };
      draft.styles = existing ? draft.styles.map(entry => (entry.id === id ? row : entry)) : [row, ...(draft.styles ?? [])];
      draft.activeStyleId = id;
      return { id, failures, state: draft };
    });
  }

  socialStatus(): Promise<WorkbenchSocialStatus> {
    return socialStatus();
  }

  /** 导入用户自己的账号。钱花在 TokenToSea 社媒数据上，所以先把内容存好，提炼失败也不会白花。一次只导一个。 */
  async importAccount(body: Body): Promise<WorkbenchSocialImportResponse> {
    if (this.importing) throw httpError(tr('上一个账号还在导入，等它结束再试'), 409);
    if (!signedIn()) throw httpError(tr('请先登录 TokenToSea'), 401);
    this.importing = true;
    try {
      const account = await resolveAccount(String(body.text ?? ''));
      const { posts, profile, chargedUsd } = await fetchAccount(account);
      await this.store.read();
      const covers = await saveCovers(posts, this.store.filesDir);
      const imported = await this.store.mutate(tr('导入{platform}账号', { platform: platformName(account.platform) }), draft => importPosts(draft, { account, profile, posts, covers }));
      const nickname = profile.nickname || platformName(account.platform);
      let styleError: string | null = null;
      const material = postsToMaterial(posts);
      if (material.length >= 80) {
        try {
          await this.styleFromMaterial({ material, name: nickname, source: tr('{platform}账号', { platform: platformName(account.platform) }), sourceUrls: [account.url], accountKey: `${account.platform}:${account.id}` });
        } catch (error) {
          styleError = error instanceof Error ? error.message : String(error);
        }
      } else {
        styleError = tr('这个账号的文字太少，提炼不出风格');
      }
      this.scheduleOrganize(imported.ids);
      return { platform: account.platform, nickname, count: posts.length, added: imported.added, chargedUsd, styleName: styleError ? null : nickname, styleError, state: await this.store.read() };
    } finally {
      this.importing = false;
    }
  }

  async refreshAccount(body: Body): Promise<{ state: WorkbenchState; errors: string[]; fetchError: string | null }> {
    const url = str(body.url, 2000);
    const now = new Date().toISOString();
    let patch: Body;
    try {
      const info = await harvest(url);
      patch = { url: info.url, ...(info.title ? { title: info.title } : {}), ...(info.description ? { description: info.description } : {}), ...(info.image ? { avatar: info.image } : {}), fetchedAt: now, fetchError: '', ...(info.followers ? { followers: info.followers } : {}) };
    } catch (error) {
      patch = { url, fetchedAt: now, fetchError: error instanceof Error ? error.message : String(error) };
    }
    return this.store.mutate(tr('更新账号档案'), (draft) => {
      const op = typeof body.id === 'string' && body.id ? { op: 'update_account', id: body.id, ...patch } : { op: 'add_account', platform: str(body.platform, 40), handle: str(body.handle, 200), ...patch };
      const { errors } = applyOps(draft, [op]);
      return { state: draft, errors, fetchError: typeof patch.fetchError === 'string' && patch.fetchError ? patch.fetchError : null };
    });
  }

  // ── 收集 ──────────────────────────────────────────────────────

  /** 收藏一个链接。页面读不到时（比如要登录）仍然存下链接，把原因写进 errors。 */
  async captureUrl(body: Body): Promise<WorkbenchCaptureResponse> {
    const raw = str(body.url, 4000);
    if (!raw) throw httpError(tr('链接格式不对'), 400);
    let url: URL;
    try {
      url = await assertPublicUrl(raw);
    } catch (error) {
      throw httpError(error instanceof Error ? error.message : String(error), 400);
    }
    const failures: string[] = [];
    let info: Awaited<ReturnType<typeof harvest>> | null = null;
    try {
      info = await harvest(url.toString());
    } catch (error) {
      failures.push(tr('没能读取页面内容：{error}', { error: error instanceof Error ? error.message : String(error) }));
    }
    const title = str(body.title, 400) || info?.title || url.hostname.replace(/^www\./, '');
    const op: WorkbenchOp = {
      op: 'add_item', kind: 'web', title, body: str(body.note, 40000) || info?.description || '', url: info?.url ?? url.toString(),
      source: info?.siteName ?? url.hostname.replace(/^www\./, ''), tags: Array.isArray(body.tags) ? body.tags : [],
      ...(typeof body.spaceId === 'string' && body.spaceId ? { spaceId: body.spaceId } : {}),
      media: info?.image ? { src: info.image } : null,
    };
    const result = await this.store.mutate(tr('收藏《{title}》', { title: title.slice(0, 12) }), (draft) => {
      const { receipts, errors } = applyOps(draft, [op]);
      const id = receipts[0]?.target;
      return { receipts, errors: [...errors, ...failures], ...(id ? { id } : {}), state: draft };
    });
    if (result.id) this.scheduleOrganize([result.id]);
    return result;
  }

  // ── 灵感库 AI ─────────────────────────────────────────────────

  /** 收进来的新条目交给 AI 整理（开了自动整理且已登录时）。不等结果，也不占撤销位。 */
  scheduleOrganize(ids: string[]): void {
    if (!ids.length) return;
    void (async () => {
      const settings = await this.settings.read();
      if (!settings.autoOrganize || !signedIn()) return;
      await this.organize({ ids }, { undoable: false });
    })().catch(() => undefined);
  }

  async organize(body: Body, { undoable = true }: { undoable?: boolean } = {}): Promise<WorkbenchOrganizeResponse> {
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id): id is string => typeof id === 'string').slice(0, 500);
    if (!ids.length) throw httpError(tr('找不到要处理的条目'), 400);
    if (!signedIn()) throw httpError(tr('请先登录 TokenToSea'), 401);
    const snapshot = structuredClone(await this.store.read());
    const { patches, errors } = await organizeItems(snapshot, ids, { callText, readMedia: src => this.readMedia(src) });
    const organized = patches.length ? await this.store.mutate(tr('整理灵感'), draft => applyOrganize(draft, patches), { undoable }) : [];
    return { organized, errors, state: await this.store.read() };
  }

  async reader(body: Body): Promise<WorkbenchReaderResponse> {
    const id = str(body.id, 200);
    const item = (await this.store.read()).items.find(row => row.id === id);
    if (!item) throw httpError(tr('找不到对象：{id}', { id }), 404);
    if (!item.url) throw httpError(tr('这条没有链接，没法打开阅读视图'), 400);
    const reader = await buildReader(item.url);
    const minutes = reader.text ? readMinutesFor(reader.text) : undefined;
    const state = await this.store.mutate(tr('阅读视图'), (draft) => {
      const target = draft.items.find(row => row.id === id);
      if (target) {
        target.reader = reader;
        if (minutes) target.readMinutes = minutes;
        target.updatedAt = new Date().toISOString();
      }
      return draft;
    }, { undoable: false });
    return { reader, state };
  }

  async search(q: string, mode: WorkbenchSearchMode): Promise<WorkbenchSearchResponse> {
    const query = q.trim().slice(0, 500);
    if (!query) return { mode, hits: [] };
    const state = await this.store.read();
    return { mode, hits: await searchLibrary(state, query, mode, { callText }) };
  }

  // ── 设置与模型 ────────────────────────────────────────────────

  async publicSettings(): Promise<WorkbenchPublicSettings> {
    const settings = await this.settings.read();
    const signed = signedIn();
    let textModelLabel: string | null = null;
    let imageModelLabel: string | null = null;
    let ready = false;
    if (signed) {
      try {
        const text = pickModel(await textModels(), settings.textModel);
        textModelLabel = text ? modelLabel(text) : null;
        const image = pickModel(await imageModels(), settings.imageModel);
        imageModelLabel = image ? modelLabel(image) : null;
        ready = Boolean(image);
      } catch {
        // 目录拉不到时按没有模型显示
      }
    }
    return { ...settings, defaultExportDir: defaultExportDir(), signedIn: signed, imageReady: ready, textModelLabel, imageModelLabel };
  }

  async updateSettings(body: Body): Promise<WorkbenchPublicSettings> {
    const before = await this.settings.read();
    const updated = await this.settings.update(body);
    if (before.textModel !== updated.textModel) resetModelStatus();
    return this.publicSettings();
  }

  async models(): Promise<WorkbenchModelsResponse> {
    if (!signedIn()) return { signedIn: false, text: [], image: [] };
    const option = (model: { id: string; name?: string; model: string; provider?: string }) => ({ id: model.id, name: String(model.name || model.model || model.id), ...(model.provider ? { provider: model.provider } : {}) });
    const [text, image] = await Promise.all([textModels(), imageModels()]);
    return { signedIn: true, text: text.map(option), image: image.map(option) };
  }

  async testImage(): Promise<WorkbenchSettingsTestResponse> {
    if (!await imageReady()) throw httpError(tr('还没有可用的生图模型，请先登录 TokenToSea'), 400);
    const settings = await this.settings.read();
    await this.store.read();
    const { buffer, ext } = await generateImage(settings, TEST_PROMPT, { aspect: '1:1' });
    const name = `${newId('t')}${ext}`;
    await writeFile(path.join(this.store.filesDir, name), buffer);
    return { src: `workbench/files/${name}` };
  }

  // ── 复盘与写作规则 ────────────────────────────────────────────

  async insights() {
    return computeInsights(await this.store.read());
  }

  async learnSkills(): Promise<WorkbenchSkillsLearnResponse> {
    const proposals = proposeRules(await this.store.read());
    if (!proposals.length) return { added: 0, state: await this.store.read() };
    const state = await this.store.mutate(tr('从数据中学习'), (draft) => {
      // 只用示例数据算出来的建议也算示例，清空示例时一起清掉，也不会被导出
      const fromSamples = !draft.metrics.some(metric => !metric.sample);
      const { receipts } = applyOps(draft, proposals.map(row => ({ op: 'add_skill', ...row, status: 'proposed' })));
      if (fromSamples) for (const receipt of receipts) { const skill = draft.skills.find(row => row.id === receipt?.target); if (skill) skill.sample = true; }
      return draft;
    });
    return { added: proposals.length, state };
  }

  async exportSkills(): Promise<WorkbenchSkillsExportResponse> {
    const result = await exportSkill(await this.store.read(), this.userSkillsDir);
    const state = await this.store.mutate('导出 Skill', (draft) => {
      applyOps(draft, draft.skills.filter(s => !s.sample && s.status === 'active').map(s => ({ op: 'update_skill', id: s.id, status: 'exported' })));
      return draft;
    }, { undoable: false });
    return { ...result, state };
  }
}

/** 模型给的动作不可信：只认三种，id 必须是还在库里的条目；已经做好的成稿不会因为一句话被整篇重做。 */
function normalizeActions(raw: unknown, live: Map<string, WorkbenchState['items'][number]>, doneFocusId: string | undefined): WorkbenchChatAction[] {
  const out: WorkbenchChatAction[] = [];
  for (const entry of Array.isArray(raw) ? raw.slice(0, 6) : []) {
    const action = (entry && typeof entry === 'object' ? entry : {}) as Body;
    if (action.type === 'produce' || action.type === 'open') {
      const id = typeof action.id === 'string' ? action.id : '';
      const item = live.get(id);
      if (!item) continue;
      if (action.type === 'produce' && (id === doneFocusId || item.production?.status === 'done')) continue;
      out.push({ type: action.type, id });
    } else if (action.type === 'nav') {
      const raw = String(action.page ?? action.view ?? '');
      const page = (raw === 'home' ? 'inspiration' : raw) as WorkbenchPage;
      if ((WORKBENCH_PAGES as readonly string[]).includes(page)) out.push({ type: 'nav', page });
    }
  }
  return out;
}
