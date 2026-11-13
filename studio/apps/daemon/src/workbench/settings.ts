// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// 工作台设置。文字和生图都走登录的 TokenToSea 账号，这里只存模型选择和成稿偏好，不存任何密钥。文件权限 600。
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkbenchLanguage, WorkbenchSettings, WorkbenchSettingsPatch } from '@open-design/contracts';
import { httpError, tr } from './i18n.js';

export const DEFAULT_SETTINGS: WorkbenchSettings = {
  textModel: '',
  imageModel: '',
  imageAspect: '3:2',
  voice: '',
  exportDir: '',
  generateImages: true,
  imageCount: 2,
  shotCount: 6,
  language: 'auto',
  autoOrganize: true,
};

const ASPECTS: ReadonlyArray<WorkbenchSettings['imageAspect']> = ['1:1', '3:2', '2:3'];
const LANGUAGES: readonly WorkbenchLanguage[] = ['auto', 'zh', 'en'];

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** 读盘时把旧文件或手改过的文件规整成合法设置。 */
function normalize(saved: Record<string, unknown>): WorkbenchSettings {
  const base = DEFAULT_SETTINGS;
  return {
    textModel: typeof saved.textModel === 'string' ? saved.textModel.slice(0, 200) : base.textModel,
    imageModel: typeof saved.imageModel === 'string' ? saved.imageModel.slice(0, 200) : base.imageModel,
    imageAspect: ASPECTS.includes(saved.imageAspect as WorkbenchSettings['imageAspect']) ? saved.imageAspect as WorkbenchSettings['imageAspect'] : base.imageAspect,
    voice: typeof saved.voice === 'string' ? saved.voice.slice(0, 8000) : base.voice,
    exportDir: typeof saved.exportDir === 'string' ? saved.exportDir.slice(0, 500) : base.exportDir,
    generateImages: typeof saved.generateImages === 'boolean' ? saved.generateImages : base.generateImages,
    imageCount: clamp(saved.imageCount, 0, 4, base.imageCount),
    shotCount: clamp(saved.shotCount, 0, 12, base.shotCount),
    language: LANGUAGES.includes(saved.language as WorkbenchLanguage) ? saved.language as WorkbenchLanguage : base.language,
    autoOrganize: typeof saved.autoOrganize === 'boolean' ? saved.autoOrganize : base.autoOrganize,
  };
}

export class WorkbenchSettingsStore {
  readonly file: string;

  /** @param root 工作台目录，由调用方从 RUNTIME_DATA_DIR 派生。 */
  constructor(root: string) {
    this.file = path.join(root, 'settings.json');
  }

  /** 每次都读文件：可能有别的进程刚改过。 */
  async read(): Promise<WorkbenchSettings> {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      return normalize(saved && typeof saved === 'object' ? saved as Record<string, unknown> : {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return { ...DEFAULT_SETTINGS };
      throw error;
    }
  }

  async update(patch: WorkbenchSettingsPatch | Record<string, unknown>): Promise<WorkbenchSettings> {
    const input = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    const current = await this.read();
    const next: WorkbenchSettings = { ...current };
    if (typeof input.textModel === 'string') next.textModel = input.textModel.trim().slice(0, 200);
    if (typeof input.imageModel === 'string') next.imageModel = input.imageModel.trim().slice(0, 200);
    if (input.imageAspect !== undefined) {
      if (!ASPECTS.includes(input.imageAspect as WorkbenchSettings['imageAspect'])) throw httpError(tr('图片比例只能是 1:1、3:2 或 2:3'), 400);
      next.imageAspect = input.imageAspect as WorkbenchSettings['imageAspect'];
    }
    if (typeof input.voice === 'string') next.voice = input.voice.slice(0, 8000);
    if (typeof input.exportDir === 'string') next.exportDir = input.exportDir.trim().slice(0, 500);
    if (typeof input.generateImages === 'boolean') next.generateImages = input.generateImages;
    if (input.imageCount !== undefined) next.imageCount = clamp(input.imageCount, 0, 4, current.imageCount);
    if (input.shotCount !== undefined) next.shotCount = clamp(input.shotCount, 0, 12, current.shotCount);
    if (LANGUAGES.includes(input.language as WorkbenchLanguage)) next.language = input.language as WorkbenchLanguage;
    if (typeof input.autoOrganize === 'boolean') next.autoOrganize = input.autoOrganize;
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
    return next;
  }
}
