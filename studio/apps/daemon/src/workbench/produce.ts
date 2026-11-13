// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// 一键成稿流水线：策划案 → 文章和画面同时开工（封面、配图、分镜）。
// 任务在 daemon 里跑，关掉页面也不会中断；每生成一张图就落盘一次。
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  WorkbenchAsset, WorkbenchAssetTarget, WorkbenchItem, WorkbenchProduction, WorkbenchProductionLive, WorkbenchSettings,
} from '@open-design/contracts';
import { articlePrompts, extractJson, fallbackArticle, fallbackPlan, planPrompts, shortCoverText, type CallText, type ProductionPlan } from './ai.js';
import { httpError, tr } from './i18n.js';
import { coverPrompt, figurePrompt, shotPrompt, type ImageAspect } from './images.js';
import { newId } from './ops.js';
import type { WorkbenchSettingsStore } from './settings.js';
import type { WorkbenchStore } from './store.js';
import { draftFormat } from './style.js';

const CONCURRENCY = 3;
// 模型卡住不出字时，到点改用草稿，不让进度条一直转
const TEXT_TIMEOUT_MS = 240_000;
const RETRY_WAIT_MS = [6000, 14000];
/** 分镜是 16:9 的横幅，取最接近的横版比例。 */
const SHOT_ASPECT: ImageAspect = '3:2';

export type GenerateImage = (settings: WorkbenchSettings, prompt: string, options: { signal?: AbortSignal | undefined; aspect?: ImageAspect | undefined }) => Promise<{ buffer: Buffer; ext: string }>;

function splitTitle(markdown: string, fallback: string): { title: string; article: string } {
  const match = /^\s*#\s+(.+)\n?/.exec(markdown);
  if (!match) return { title: fallback, article: markdown.trim() };
  return { title: match[1]!.trim(), article: markdown.slice(match[0].length).trim() };
}

/** 模型给的规划不可信：只取需要的字段，数量按设置截断。 */
export function normalizePlan(plan: unknown, settings: Pick<WorkbenchSettings, 'imageCount' | 'shotCount'>, title: string): ProductionPlan {
  const raw = (plan && typeof plan === 'object' ? plan : {}) as Record<string, any>;
  const text = (value: unknown, max = 400) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const images = (Array.isArray(raw.images) ? raw.images : []).slice(0, settings.imageCount).map((row: any) => ({ caption: text(row?.caption, 60), anchor: text(row?.anchor, 60), prompt: text(row?.prompt, 1200) })).filter(row => row.prompt);
  const shots = (Array.isArray(raw.shots) ? raw.shots : []).slice(0, settings.shotCount).map((row: any, index: number) => ({
    no: index + 1, shot: text(row?.shot, 12) || tr('中景'), visual: text(row?.visual, 200), voice: text(row?.voice, 200),
    seconds: Number.isFinite(row?.seconds) ? Math.max(1, Math.min(60, Math.round(row.seconds))) : 5, prompt: text(row?.prompt, 1200),
  })).filter(row => row.prompt || row.visual);
  return {
    title: text(raw.title, 60) || title,
    coverText: text(raw.coverText, 24) || shortCoverText(title),
    facts: (Array.isArray(raw.facts) ? raw.facts : []).map((row: unknown) => text(row, 120)).filter(Boolean).slice(0, 8),
    outline: (Array.isArray(raw.outline) ? raw.outline : []).map((row: unknown) => text(row, 40)).filter(Boolean).slice(0, 6),
    cover: text(raw.cover, 1200) || title,
    characters: text(raw.characters, 400),
    images,
    shots,
  };
}

type ParsedTarget = { kind: 'cover' } | { kind: 'image' | 'shot'; index: number };

export function parseTarget(target: unknown): ParsedTarget | null {
  if (target === 'cover') return { kind: 'cover' };
  const match = /^(image|shot):(\d{1,2})$/.exec(String(target));
  return match ? { kind: match[1] as 'image' | 'shot', index: Number(match[2]) } : null;
}

function assetAt(production: WorkbenchProduction, target: string): WorkbenchAsset | null {
  const parsed = parseTarget(target);
  if (!parsed) return null;
  if (parsed.kind === 'cover') return production.cover;
  return (parsed.kind === 'image' ? production.images : production.shots)?.[parsed.index] ?? null;
}

function fullPrompt(production: WorkbenchProduction, target: string, asset: WorkbenchAsset): string {
  const parsed = parseTarget(target)!;
  if (parsed.kind === 'cover') return coverPrompt(asset.prompt);
  if (parsed.kind === 'image') return figurePrompt(asset.prompt);
  const shot = asset as WorkbenchAsset & { visual?: string };
  return shotPrompt(asset.prompt || shot.visual || '', production.characters);
}

function assets(production: WorkbenchProduction): WorkbenchAsset[] {
  return [production.cover, ...(production.images ?? []), ...(production.shots ?? [])].filter((row): row is WorkbenchAsset => Boolean(row));
}

/**
 * 把对话里的修改落到成稿上。模型输出不可信：只认这几个字段，序号越界的直接丢弃。
 * 没接生图时，回执只说更新了画面描述。
 */
export function applyRevision(production: WorkbenchProduction, revise: unknown, { canDraw = true }: { canDraw?: boolean } = {}): { receipts: string[]; errors: string[]; targets: WorkbenchAssetTarget[] } {
  const input = (revise && typeof revise === 'object' ? revise : {}) as Record<string, any>;
  const receipts: string[] = [];
  const errors: string[] = [];
  const targets: WorkbenchAssetTarget[] = [];
  const redraw = (what: string) => (canDraw ? tr('重画{what}', { what }) : tr('更新了画面描述：{what}（接入生图模型后才会重画）', { what }));
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const title = text(input.title, 80);
  if (title && title !== production.title) {
    production.title = title;
    receipts.push(tr('标题改成《{title}》', { title }));
  }
  const coverText = text(input.coverText, 24);
  if (coverText && coverText !== production.coverText) {
    production.coverText = coverText;
    receipts.push(tr('封面大字改成「{text}」', { text: coverText }));
  }
  if (typeof input.article === 'string' && input.article.trim()) {
    production.article = input.article.replace(/^\s*#\s+.*\n?/, '').trim().slice(0, 200000);
    receipts.push(tr('重写了脚本'));
  } else if (Array.isArray(input.edits)) {
    let changed = 0;
    for (const edit of input.edits.slice(0, 20)) {
      if (typeof edit?.find !== 'string' || typeof edit?.replace !== 'string' || !edit.find) continue;
      if (production.article.includes(edit.find)) {
        production.article = production.article.replace(edit.find, () => edit.replace);
        changed += 1;
      } else {
        errors.push(tr('脚本里没找到「{text}」', { text: edit.find.slice(0, 16) }));
      }
    }
    if (changed) receipts.push(tr(changed === 1 ? '改了脚本的 1 处' : '改了脚本的 {n} 处', { n: changed }));
  }
  const cover = text(input.cover?.prompt, 1200);
  if (cover && production.cover) {
    production.cover.prompt = cover;
    targets.push('cover');
    receipts.push(redraw(tr('封面')));
  }
  for (const row of Array.isArray(input.images) ? input.images.slice(0, 8) : []) {
    const image = production.images?.[Number(row?.no) - 1];
    if (!image) continue;
    const caption = text(row.caption, 40);
    if (caption) image.caption = caption;
    const prompt = text(row.prompt, 1200);
    if (prompt) {
      image.prompt = prompt;
      targets.push(`image:${Number(row.no) - 1}`);
    }
    receipts.push(prompt ? redraw(tr('配图 {no}', { no: row.no })) : tr('改了配图 {no} 的图注', { no: row.no }));
  }
  for (const row of Array.isArray(input.shots) ? input.shots.slice(0, 24) : []) {
    const shot = production.shots?.[Number(row?.no) - 1];
    if (!shot) continue;
    for (const [key, max] of [['shot', 12], ['visual', 200], ['voice', 200]] as const) {
      const value = text(row[key], max);
      if (value) shot[key] = value;
    }
    if (Number.isFinite(row.seconds)) shot.seconds = Math.max(1, Math.min(60, Math.round(row.seconds)));
    const prompt = text(row.prompt, 1200);
    if (prompt) {
      shot.prompt = prompt;
      targets.push(`shot:${Number(row.no) - 1}`);
    }
    receipts.push(prompt ? redraw(tr('第 {no} 镜', { no: row.no })) : tr('改了第 {no} 镜的文案', { no: row.no }));
  }
  return { receipts, errors, targets };
}

interface Job { stage: 'brief' | 'making' | 'done'; text: string; planText: string; controller: AbortController; withImages: boolean }

export interface ProducerDeps {
  store: WorkbenchStore;
  settings: WorkbenchSettingsStore;
  callText: CallText;
  generate: GenerateImage;
  /** 能不能画图：登录了且账号里有生图模型。 */
  ready: () => Promise<boolean>;
}

export class Producer {
  private readonly jobs = new Map<string, Job>();
  private readonly active = new Set<string>();
  /** 测试里缩短 429 重试等待。 */
  retryScale = 1;

  constructor(private readonly deps: ProducerDeps) {}

  ready(): Promise<boolean> { return this.deps.ready(); }

  isRunning(id: string): boolean { return this.jobs.has(id); }

  status(id: string): WorkbenchProductionLive {
    const job = this.jobs.get(id);
    if (!job) return { running: false };
    // 策划案是流式写出来的：标题和分镜一出现就先显示
    const plan = job.planText;
    const title = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(plan)?.[1];
    return {
      running: true,
      stage: job.stage,
      text: job.text,
      ...(title !== undefined ? { title } : {}),
      visuals: [...plan.matchAll(/"visual"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!),
    };
  }

  private patch(id: string, mutate: (production: WorkbenchProduction, item: WorkbenchItem) => void): Promise<unknown> {
    return this.deps.store.mutate('成稿', (state) => {
      const item = state.items.find(row => row.id === id);
      if (item?.production) mutate(item.production, item);
      return null;
    }, { undoable: false });
  }

  async start(id: string, { withImages }: { withImages?: unknown } = {}): Promise<boolean> {
    if (this.jobs.has(id)) return false;
    const state = await this.deps.store.read();
    const item = state.items.find(row => row.id === id);
    if (!item) throw httpError(tr('找不到这条灵感'), 404);
    if (item.trashedAt) throw httpError(tr('这条在废纸篓里，先恢复再成稿'), 400);
    // 单次选择优先；没传就按设置里的默认值
    const settings = await this.deps.settings.read();
    const draw = typeof withImages === 'boolean' ? withImages : settings.generateImages !== false;
    const job: Job = { stage: 'brief', text: '', planText: '', controller: new AbortController(), withImages: draw };
    this.jobs.set(id, job);
    try {
      await this.deps.store.mutate('开始成稿', (draft) => {
        const target = draft.items.find(row => row.id === id);
        if (target) target.production = { status: 'running', stage: 'brief', withImages: draw, startedAt: new Date().toISOString(), format: draftFormat(draft.draftFormat), title: target.title, article: '', cover: null, images: [], shots: [] };
        return null;
      }, { undoable: false });
    } catch (error) {
      this.jobs.delete(id);
      throw error;
    }
    // 不等待：界面靠轮询拿进度。后台任务沿用发起请求的语言和 TokenToSea 账号
    void this.run(id, job).catch(() => undefined).finally(() => this.jobs.delete(id));
    return true;
  }

  async cancel(id: string): Promise<void> {
    this.jobs.get(id)?.controller.abort();
  }

  private async run(id: string, job: Job): Promise<void> {
    const { signal } = job.controller;
    try {
      const settings = await this.deps.settings.read();
      const state = await this.deps.store.read();
      const snapshot = structuredClone(state);
      const item = snapshot.items.find(row => row.id === id);
      if (!item) throw new Error(tr('找不到这条灵感'));

      signal.throwIfAborted();
      const backup = normalizePlan(fallbackPlan(item, '', settings), settings, item.title);

      let plan: ProductionPlan;
      try {
        const prompts = planPrompts(snapshot, item, settings);
        const { text } = await this.deps.callText({ ...prompts, maxTokens: 3000, light: true, signal: AbortSignal.any([signal, AbortSignal.timeout(TEXT_TIMEOUT_MS)]), onText: (delta) => { job.planText += delta; } });
        plan = normalizePlan(extractJson(text), settings, item.title);
      } catch (error) {
        if (signal.aborted) throw error;
        plan = backup;
      }
      // 模型漏掉配图或分镜时用模板补上，流水线不能因此少一块
      if (plan.images.length < settings.imageCount) plan.images = [...plan.images, ...backup.images.slice(plan.images.length)];
      if (plan.shots.length < settings.shotCount) plan.shots = [...plan.shots, ...backup.shots.slice(plan.shots.length).map((row, i) => ({ ...row, no: plan.shots.length + i + 1 }))];

      const configured = await this.deps.ready();
      const draw = job.withImages !== false;
      const ready = configured && draw;
      const initial = ready ? 'pending' : 'skipped';
      job.stage = 'making';
      await this.patch(id, (production) => {
        production.stage = 'making';
        production.withImages = draw;
        production.title = plan.title;
        production.coverText = plan.coverText;
        production.facts = plan.facts;
        production.outline = plan.outline;
        production.characters = plan.characters;
        production.cover = { prompt: plan.cover, status: initial };
        production.images = plan.images.map(row => ({ ...row, status: initial }));
        production.shots = plan.shots.map(row => ({ ...row, status: initial }));
        if (!configured && draw) production.needsProvider = true;
      });

      // 策划案定了之后，文章和所有画面同时开工
      const writeArticle = async () => {
        let engine = 'local';
        let notice: string | null = null;
        let markdown = '';
        try {
          const prompts = articlePrompts(snapshot, item, settings.voice, plan);
          const result = await this.deps.callText({ ...prompts, maxTokens: 6000, signal: AbortSignal.any([signal, AbortSignal.timeout(TEXT_TIMEOUT_MS)]), onText: (delta) => { job.text += delta; } });
          markdown = result.text;
          engine = result.model;
          if (!markdown.trim()) throw new Error(tr('模型返回了空内容'));
        } catch (error) {
          if (signal.aborted) throw error;
          markdown = fallbackArticle(item);
          job.text = markdown;
          notice = tr('没有可用的文字模型，先给你一份结构草稿。请先登录 TokenToSea，或到设置里检查文字模型。');
        }
        const { article } = splitTitle(markdown, plan.title);
        await this.patch(id, (production) => {
          production.article = article;
          production.aiArticle = article;
          production.engine = engine;
          production.notice = notice;
        });
      };

      const tasks: Array<Promise<unknown>> = [writeArticle()];
      if (ready) {
        const targets: string[] = ['cover', ...plan.images.map((_, i) => `image:${i}`), ...plan.shots.map((_, i) => `shot:${i}`)];
        let next = 0;
        const worker = async () => {
          while (next < targets.length && !signal.aborted) {
            const target = targets[next]!;
            next += 1;
            await this.renderAsset(id, target, settings, signal);
          }
        };
        for (let i = 0; i < CONCURRENCY; i += 1) tasks.push(worker());
      }
      await Promise.all(tasks);
      if (signal.aborted) throw new Error('cancelled');

      await this.deps.store.mutate('完成成稿', (draft) => {
        const target = draft.items.find(row => row.id === id);
        if (!target?.production) return null;
        target.production.status = 'done';
        target.production.stage = 'done';
        target.production.finishedAt = new Date().toISOString();
        if (['idea', 'outline'].includes(target.status)) target.status = target.scheduledAt ? 'ready' : 'draft';
        target.updatedAt = target.production.finishedAt;
        return null;
      }, { undoable: false });
    } catch (error) {
      const cancelled = signal.aborted;
      await this.patch(id, (production) => {
        production.status = cancelled ? 'cancelled' : 'failed';
        production.stage = 'done';
        production.error = cancelled ? null : error instanceof Error ? error.message : String(error);
        for (const asset of assets(production)) if (['pending', 'running'].includes(asset.status)) asset.status = 'idle';
      });
    } finally {
      job.stage = 'done';
    }
  }

  /** 生图服务限流（429）时等一会儿再试，最多再试两次；其他错误直接报。 */
  private async generateWithRetry(settings: WorkbenchSettings, prompt: string, aspect: ImageAspect | undefined, signal?: AbortSignal): Promise<{ buffer: Buffer; ext: string }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.deps.generate(settings, prompt, { signal, aspect });
      } catch (error) {
        const failure = error as { status?: number; message?: string; permanent?: boolean };
        const limited = failure?.status === 429 || /429/.test(String(failure?.message));
        if (failure?.permanent || !limited || attempt >= RETRY_WAIT_MS.length || signal?.aborted) throw error;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, RETRY_WAIT_MS[attempt]! * this.retryScale);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
        });
      }
    }
  }

  private async renderAsset(id: string, target: string, settings: WorkbenchSettings, signal?: AbortSignal): Promise<void> {
    let prompt: string | null = null;
    await this.patch(id, (production) => {
      const asset = assetAt(production, target);
      if (!asset) return;
      asset.status = 'running';
      asset.error = null;
      prompt = fullPrompt(production, target, asset);
    });
    if (!prompt) return;
    const aspect = parseTarget(target)?.kind === 'shot' ? SHOT_ASPECT : undefined;
    try {
      const { buffer, ext } = await this.generateWithRetry(settings, prompt, aspect, signal);
      const name = `${newId('g')}${ext}`;
      await writeFile(path.join(this.deps.store.filesDir, name), buffer);
      await this.patch(id, (production) => {
        const asset = assetAt(production, target);
        if (!asset) return;
        asset.status = 'done';
        asset.src = `workbench/files/${name}`;
      });
    } catch (error) {
      if (signal?.aborted) return;
      await this.patch(id, (production) => {
        const asset = assetAt(production, target);
        if (!asset) return;
        asset.status = 'failed';
        asset.error = error instanceof Error ? error.message : String(error);
      });
    }
  }

  /** 单独重画一张。 */
  async regenerate(id: string, target: unknown): Promise<void> {
    if (!await this.deps.ready()) throw httpError(tr('还没有可用的生图模型，请先登录 TokenToSea'), 400);
    if (!parseTarget(target)) throw httpError(tr('目标无效'), 400);
    const key = `${id}:${String(target)}`;
    if (this.active.has(key)) return;
    const settings = await this.deps.settings.read();
    const state = await this.deps.store.read();
    const production = state.items.find(row => row.id === id)?.production;
    if (!production || !assetAt(production, String(target))) throw httpError(tr('找不到这张图'), 404);
    this.active.add(key);
    await this.patch(id, (next) => { const asset = assetAt(next, String(target)); if (asset) asset.status = 'running'; });
    void this.renderAsset(id, String(target), settings).catch(() => undefined).finally(() => this.active.delete(key));
  }

  /** daemon 重启后，把上次没做完的成稿都标成中断，卡片不会一直显示「正在成稿」。 */
  async settleAll(): Promise<void> {
    const state = await this.deps.store.read();
    for (const item of state.items) if (item.production?.status === 'running' || item.production && assets(item.production).some(asset => asset.status === 'running')) await this.settle(item.id);
  }

  async settle(id: string): Promise<void> {
    const state = await this.deps.store.read();
    const production = state.items.find(row => row.id === id)?.production;
    if (!production || this.jobs.has(id)) return;
    const stuck = !this.anyAssetActive(id) && assets(production).some(asset => asset.status === 'running');
    if (production.status !== 'running' && !stuck) return;
    await this.patch(id, (next) => {
      if (next.status === 'running') {
        next.status = 'failed';
        next.stage = 'done';
        next.error = tr('上次成稿被中断了，可以重新开始');
      }
      for (const asset of assets(next)) if (['pending', 'running'].includes(asset.status)) asset.status = 'idle';
    });
  }

  private anyAssetActive(id: string): boolean {
    return [...this.active].some(key => key.startsWith(`${id}:`));
  }
}
