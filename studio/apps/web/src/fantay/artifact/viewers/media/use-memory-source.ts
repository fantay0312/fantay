// SPDX-License-Identifier: AGPL-3.0-only
// Playing a file from memory. The browser can only move around in a file the server sends in byte
// ranges, and the daemon sends ranges only for files it labels as audio or video. A FLAC or an Ogg
// file arrives unlabelled: played straight from its address, a FLAC snaps back to the start on
// every seek and an Ogg never learns its length. Such a file is fetched whole (up to a limit) and
// played from an object URL, which the browser can seek in freely.
import { useEffect, useRef, useState } from 'react';

import type { ProjectFile } from '../../../../types';

/** True when the server will send this file in byte ranges, so it can be played from its address. */
export function servedInRanges(file: Pick<ProjectFile, 'mime'>): boolean {
  return /^(audio|video)\//i.test(file.mime ?? '');
}

const MEDIA_TYPES: Record<string, string> = {
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  weba: 'audio/webm',
  m4v: 'video/mp4',
  ogv: 'video/ogg',
};

/** The type to give the in-memory copy; the browser still looks at the bytes themselves. */
export function memoryMediaType(extension: string): string {
  return MEDIA_TYPES[extension] ?? '';
}

/**
 * An address for bytes held in memory; null until there are bytes. Addresses made here are released
 * when the viewer goes away, not before: a player keeps the address it is playing from until it
 * pauses, even after a newer version of the file has arrived.
 */
export function useObjectUrl(bytes: ArrayBuffer | null, type: string): string | null {
  const [held, setHeld] = useState<{ bytes: ArrayBuffer; url: string } | null>(null);
  const madeRef = useRef<string[]>([]);

  useEffect(() => {
    if (bytes === null) return;
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    madeRef.current.push(url);
    setHeld({ bytes, url });
  }, [bytes, type]);

  useEffect(
    () => () => {
      for (const url of madeRef.current) URL.revokeObjectURL(url);
      madeRef.current = [];
    },
    [],
  );

  // While a newer version is on its way the previous address stays in use.
  return held?.url ?? null;
}
