// SPDX-License-Identifier: AGPL-3.0-only
// The drawing as files to keep: the SVG as drawn, a PNG drawn from that SVG (so it carries the same
// fonts and colours), and the PNG on the clipboard. Also the app theme, which decides how a drawing
// without paper of its own is inked.
'use client';

import { useSyncExternalStore } from 'react';

import { rasterScale } from './camera';
import type { WhiteboardPicture } from './draw';

/** A PNG of the picture at twice its size, or less when that would exceed what a canvas holds. */
export async function pictureToPng(picture: WhiteboardPicture): Promise<Blob> {
  const url = URL.createObjectURL(picture.svg);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = rasterScale({ width: picture.width, height: picture.height });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(picture.width * scale));
    canvas.height = Math.max(1, Math.round(picture.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Puts a PNG of the picture on the clipboard. False when the clipboard refused (no focus, no permission). */
export async function copyPicture(picture: WhiteboardPicture): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  try {
    // The PNG is handed over as a promise, so the write keeps the click's permission while it is drawn.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pictureToPng(picture) })]);
    return true;
  } catch {
    return false;
  }
}

/** "notes/草图.excalidraw" → "草图". */
export function pictureBaseName(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.excalidraw$/i, '') || name;
}

function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export function useIsDarkTheme(): boolean {
  return useSyncExternalStore(
    subscribeToTheme,
    () => document.documentElement.getAttribute('data-theme') === 'dark',
    () => false,
  );
}
