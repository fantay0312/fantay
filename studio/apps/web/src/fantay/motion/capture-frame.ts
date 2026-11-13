// SPDX-License-Identifier: AGPL-3.0-only
// Frame capture from a rendered film (spec 07 §3.4): decode the MP4 in a muted <video>, seek,
// draw to a canvas and hand the PNG to the chat composer through the annotation event (the
// composer stages it as a draft attachment of movie-studio.json).
import { MOVIE_DOCUMENT_FILE, type MovieRender, type WorkspaceCollabContext } from '@open-design/contracts';

import { ANNOTATION_EVENT, type AnnotationEventDetail } from '../../components/PreviewDrawOverlay';
import { movieRawUrl } from './motion-model';

const CAPTURE_TIMEOUT_MS = 15_000;

function slug(title: string): string {
  const base = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'film';
}

function waitFor(video: HTMLVideoElement, event: 'loadeddata' | 'seeked', signal: { failed?: Error }): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(signal.failed ?? new Error('video unavailable'));
    };
    const cleanup = () => {
      video.removeEventListener(event, done);
      video.removeEventListener('error', fail);
    };
    video.addEventListener(event, done, { once: true });
    video.addEventListener('error', fail, { once: true });
  });
}

/** A PNG of `render` at `time` seconds, named `<title>-<time>s.png`. */
export async function captureMotionFrame(input: {
  projectId: string;
  render: MovieRender;
  time: number;
  title: string;
  workspaceContext?: WorkspaceCollabContext | null;
}): Promise<File> {
  const { projectId, render, time, title, workspaceContext } = input;
  if (!render.file) throw new Error('render has no file');
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  const signal: { failed?: Error } = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      signal.failed = new Error('timed out');
      reject(signal.failed);
    }, CAPTURE_TIMEOUT_MS);
  });
  try {
    const loaded = waitFor(video, 'loadeddata', signal);
    video.src = movieRawUrl(projectId, render.file, workspaceContext);
    video.load();
    await Promise.race([loaded, timeout]);
    const length = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : render.duration ?? 0;
    const target = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, Math.max(0, length - 0.01)));
    const seeked = waitFor(video, 'seeked', signal);
    video.currentTime = target;
    await Promise.race([seeked, timeout]);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas unavailable');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('could not encode the frame');
    return new File([blob], `${slug(title)}-${target.toFixed(2)}s.png`, { type: 'image/png' });
  } finally {
    if (timer) clearTimeout(timer);
    video.removeAttribute('src');
    video.load();
  }
}

/** Stage the frame in the chat composer as a draft attachment of the film. */
export function sendFrameToChat(file: File): void {
  const detail: AnnotationEventDetail = { file, note: '', action: 'draft', filePath: MOVIE_DOCUMENT_FILE };
  window.dispatchEvent(new CustomEvent(ANNOTATION_EVENT, { detail }));
}
