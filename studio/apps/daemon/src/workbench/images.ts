// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// 生图：封面、配图和分镜都用登录的 TokenToSea 账号里的生图模型。这里只放提示词和图片校验。
import type { WorkbenchSettings } from '@open-design/contracts';
import { renderTokenToSeaImage } from '../media/tokentosea.js';
import { imageModels, pickModel, signedIn } from './ai.js';
import { httpError, tr } from './i18n.js';

const MAX_IMAGE_BYTES = 40_000_000;

function extensionOf(buffer: Buffer): string | null {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return '.png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg';
  if (buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  if (buffer.length > 6 && buffer.toString('latin1', 0, 3) === 'GIF') return '.gif';
  return null;
}

/** 工作台只保存真实且有界的图片内容。 */
export function imageBuffer(buffer: Buffer): { buffer: Buffer; ext: string } {
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(tr('图片太大'));
  const ext = extensionOf(buffer);
  if (!ext) throw new Error(tr('返回的内容不是图片'));
  return { buffer, ext };
}

/** 有账号、账号里也有生图模型，才算能画。 */
export async function imageReady(): Promise<boolean> {
  if (!signedIn()) return false;
  try {
    return (await imageModels()).length > 0;
  } catch {
    return false;
  }
}

export type ImageAspect = WorkbenchSettings['imageAspect'];

/** 有的模型只公布部分比例；比例不被支持时退回模型默认尺寸再试一次。 */
const ASPECT_UNSUPPORTED = /aspect ratio|matching image size/i;

/**
 * 用 TokenToSea 生成一张图。signal 中止时立刻放弃等待（已经提交的任务由服务端结算）。
 */
export async function generateImage(settings: Pick<WorkbenchSettings, 'imageModel' | 'imageAspect'>, prompt: string, { signal, aspect }: { signal?: AbortSignal | undefined; aspect?: ImageAspect | undefined } = {}): Promise<{ buffer: Buffer; ext: string }> {
  if (!signedIn()) throw Object.assign(httpError(tr('请先登录 TokenToSea'), 401), { permanent: true });
  const model = pickModel(await imageModels(), settings.imageModel);
  if (!model) throw Object.assign(httpError(tr('当前 TokenToSea 账号没有可用的生图模型'), 400), { permanent: true });
  signal?.throwIfAborted();
  const render = async (ratio: ImageAspect | undefined) => {
    const result = await renderTokenToSeaImage({ model: model.id, wireModel: model.id, prompt, imageRefs: [], ...(ratio ? { aspect: ratio } : {}) });
    return imageBuffer(result.bytes);
  };
  const work = render(aspect ?? settings.imageAspect).catch((error: unknown) => {
    if (error instanceof Error && ASPECT_UNSUPPORTED.test(error.message)) return render(undefined);
    throw error;
  });
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const COVER_STYLE = 'Editorial cover image, striking composition with calm negative space in the lower third, refined and cinematic, no text, no letters, no logo.';
const FIGURE_STYLE = 'Editorial article illustration, refined and consistent with a modern magazine, no text, no letters, no logo.';
const SHOT_STYLE = 'Film storyboard panel, black and white pencil line art sketch, loose confident lines, no color, plain white paper background, no text, no letters, no captions, no panel numbers.';

export function coverPrompt(prompt: string): string {
  return `${COVER_STYLE} ${prompt}`;
}

export function figurePrompt(prompt: string): string {
  return `${FIGURE_STYLE} ${prompt}`;
}

export function shotPrompt(prompt: string, characters?: string): string {
  return `${SHOT_STYLE} Widescreen 16:9 landscape framing, the scene fills the whole frame edge to edge, no borders. ${characters ? `Recurring characters and setting: ${characters}. ` : ''}${prompt}`;
}

export const TEST_PROMPT = 'A single paper boat on calm water, black and white pencil line art sketch, plain white paper background, no text.';
