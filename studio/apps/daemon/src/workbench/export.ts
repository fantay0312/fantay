// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// 一键保存：把成稿写成一个普通文件夹，脚本、封面、配图和分镜都在里面。保存位置是用户选的文件夹，不是 daemon 数据目录。
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { WorkbenchAsset, WorkbenchProduction } from '@open-design/contracts';
import { currentLang, tr } from './i18n.js';

export function defaultExportDir(): string {
  return path.join(homedir(), 'Documents', 'Fantay 工作台');
}

export function resolveExportDir(value: unknown): string {
  const dir = String(value ?? '').trim();
  if (!dir) return defaultExportDir();
  if (dir === '~') return homedir();
  return dir.startsWith('~/') ? path.join(homedir(), dir.slice(2)) : path.resolve(dir);
}

function folderName(title: unknown): string {
  const clean = String(title ?? '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60);
  return clean || tr('未命名');
}

function cell(text: unknown): string {
  return String(text ?? '').replace(/\|/g, '｜').replace(/\n/g, ' ');
}

/** 写出一份成稿，返回文件夹路径和写入的文件名。同一份成稿再保存时覆盖原文件夹。 */
export async function saveProduction(production: WorkbenchProduction, { filesDir, exportDir, videoCover }: { filesDir: string; exportDir: string; videoCover?: Buffer | null }): Promise<{ path: string; files: string[] }> {
  // 英文界面用纯 ASCII 文件名，方便在别的系统和工具里打开
  const en = currentLang() === 'en';
  const names = en
    ? { cover: 'cover-original', videoCover: 'video-cover.jpg', figure: (i: number) => `figure-${i}`, shot: (n: string) => `shot-${n}`, script: 'script.md', board: 'storyboard.md' }
    : { cover: '封面原图', videoCover: '视频封面.jpg', figure: (i: number) => `配图${i}`, shot: (n: string) => `分镜${n}`, script: 'script.md', board: '分镜脚本.md' };
  const target = production.savedPath || path.join(exportDir, folderName(production.title));
  await mkdir(target, { recursive: true });
  const files: string[] = [];

  const copy = async (asset: WorkbenchAsset | null | undefined, name: string): Promise<string | null> => {
    const match = /^workbench\/files\/([\w.-]+)$/.exec(asset?.src ?? '');
    if (!match) return null;
    const file = `${name}${path.extname(match[1]!)}`;
    try {
      await copyFile(path.join(filesDir, match[1]!), path.join(target, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    files.push(file);
    return file;
  };

  await copy(production.cover, names.cover);
  if (videoCover) {
    await writeFile(path.join(target, names.videoCover), videoCover);
    files.push(names.videoCover);
  }
  const figures: Array<{ caption: string; anchor: string; file: string | null }> = [];
  for (const [i, image] of (production.images ?? []).entries()) {
    figures.push({ caption: image.caption ?? '', anchor: image.anchor ?? '', file: await copy(image, names.figure(i + 1)) });
  }
  const shots: Array<{ shot: WorkbenchProduction['shots'][number]; file: string | null }> = [];
  for (const [i, shot] of (production.shots ?? []).entries()) {
    shots.push({ shot, file: await copy(shot, names.shot(String(i + 1).padStart(2, '0'))) });
  }

  // 配图放回对应小标题那一节的末尾
  const sections = String(production.article ?? '').split(/\n(?=##\s)/);
  const unplaced: string[] = [];
  for (const { caption, anchor, file } of figures) {
    if (!file) continue;
    const line = `\n\n![${caption}](${file})`;
    const at = sections.findIndex(part => anchor && part.startsWith(`## ${anchor}`));
    if (at >= 0) sections[at] = `${sections[at]!.trimEnd()}${line}\n`;
    else unplaced.push(line);
  }
  const article = `# ${production.title}\n\n${sections.join('\n')}${unplaced.join('')}\n`;
  await writeFile(path.join(target, names.script), article);
  files.push(names.script);

  if (shots.length) {
    const seconds = (value: unknown) => (value === undefined || value === null ? '' : en ? `${value}s` : `${value} 秒`);
    const rows = shots.map(({ shot, file }, i) => `| ${i + 1} | ${cell(shot.shot)} | ${seconds(shot.seconds)} | ${cell(shot.visual)} | ${cell(shot.voice)} | ${file ? `![](${file})` : ''} |`);
    const heading = en ? `# ${production.title}: storyboard\n\n| Shot | Size | Length | Visual | Voice-over | Frame |` : `# ${production.title}：分镜头脚本\n\n| 镜号 | 景别 | 时长 | 画面 | 口播 | 分镜图 |`;
    await writeFile(path.join(target, names.board), `${heading}\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`);
    files.push(names.board);
  }
  return { path: target, files };
}
