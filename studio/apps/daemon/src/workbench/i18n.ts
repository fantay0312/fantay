// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// 工作台在 daemon 这一侧的语言。浏览器每次请求都带上 x-workbench-lang，一个请求里发起的生成任务沿用同一个语言。
import { AsyncLocalStorage } from 'node:async_hooks';
import { EN } from './en.js';

export type WorkbenchLang = 'zh' | 'en';

const current = new AsyncLocalStorage<WorkbenchLang>();

/** 把请求头里的语言规整成 'zh' 或 'en'。 */
export function normalizeLang(value: unknown): WorkbenchLang {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

/** 在指定语言下运行 fn，里面的 tr() 和模型提示词都按这个语言来。 */
export function withLang<T>(lang: unknown, fn: () => T): T {
  return current.run(normalizeLang(lang), fn);
}

/** 当前语言，没有请求上下文时是中文。 */
export function currentLang(): WorkbenchLang {
  return current.getStore() ?? 'zh';
}

/** 翻译一段给用户看的文字。key 是中文原文，{name} 是占位符。 */
export function tr(zh: string, vars?: Record<string, unknown>): string {
  const text = currentLang() === 'en' ? (EN[zh] ?? zh) : zh;
  return vars ? text.replace(/\{(\w+)\}/g, (match, key: string) => (vars[key] === undefined ? match : String(vars[key]))) : text;
}

/** 英文界面时追加到系统提示词末尾，让模型用英文写所有给人看的内容。 */
export const ENGLISH_DIRECTIVE = [
  '',
  '## Output language',
  'The user works in English. Write every human-readable value (titles, cover text, scripts, outlines, captions, storyboard lines, voice-over, style cards, rules, chat replies, summaries, tags) in natural, fluent English, even if the instructions above or the material are in Chinese.',
  'Keep JSON keys, op names, ids, enum values and platform names exactly as specified above.',
  'Where a length limit is given in Chinese characters (字), treat it as about half as many English words.',
].join('\n');

/** 按当前语言二选一，给提示词里的语言相关片段用。 */
export function byLang<T>(zh: T, en: T): T {
  return currentLang() === 'en' ? en : zh;
}

const PLATFORM_EN: Record<string, string> = { 公众号: 'WeChat', 小红书: 'RedNote', 抖音: 'Douyin', B站: 'Bilibili', 视频号: 'WeChat Channels', TikTok: 'TikTok', Instagram: 'Instagram', YouTube: 'YouTube', X: 'X' };

/** 平台在数据里一直是中文值；拼进给人看的句子时按当前语言显示。 */
export function platformName(platform: string | null | undefined): string {
  if (!platform) return '';
  return currentLang() === 'en' ? (PLATFORM_EN[platform] ?? platform) : platform;
}

/** 带 HTTP 状态码的错误，路由层按 status 回应。 */
export function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
