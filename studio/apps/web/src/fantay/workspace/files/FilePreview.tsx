// SPDX-License-Identifier: AGPL-3.0-only
// What a file card shows above its name. Every file shows what it is, in one visual language:
//  - a picture is itself, on a checker only where it is transparent;
//  - a text file (Markdown, code, data, a table, a log) is a small page of its first lines, drawn in
//    real text from the first kilobytes; a web page is an outline of its headings and blocks;
//  - a video is its first frame;
//  - everything else (PDF, Office, audio, archives, fonts, 3D) is a quiet type tile.
// Nothing here runs a file or keeps a frame alive: the grid renders only the cards near the
// viewport, and a card that cannot be drawn falls back to the tile.
'use client';

import {
  AppWindow,
  AudioLines,
  Box,
  Braces,
  CaseSensitive,
  Database,
  File,
  FileText,
  Image as ImageGlyph,
  NotebookText,
  Package,
  PenLine,
  Play,
  Presentation,
  Table2,
  Text,
  type LucideIcon,
} from 'lucide-react';
import { memo, useMemo, useState, type SyntheticEvent } from 'react';

import { useProjectCollabContext } from '../../../collab/collab-context';
import { appendResourceQuery } from '../../../collab/workspace-identity';
import { projectFileUrl } from '../../../providers/registry';
import styles from './FilePreview.module.css';
import type { LibraryFile, LibraryKind } from './library-model';
import { previewKey, usePreviewText, useVideoPoster } from './preview-source';
import { looksBinary, sketchLines, sketchMarkdown, sketchPage, sketchTable, type SketchBlock } from './text-sketch';

/** Bytes read for a card. A page needs more: its outline starts after the styles in its head. */
const TEXT_PREVIEW_BYTES = 2048;
const PAGE_PREVIEW_BYTES = 24 * 1024;

type TileShape = 'page' | 'wide' | 'square';

/**
 * A type tile: the family's glyph on a small piece of paper. The paper's shape says the family
 * before the glyph does: a leaf for documents, a screen for slides, tables and video, a chip for
 * everything that is neither.
 */
const TILE: Record<LibraryKind, { glyph: LucideIcon; shape: TileShape }> = {
  page: { glyph: AppWindow, shape: 'wide' },
  image: { glyph: ImageGlyph, shape: 'square' },
  sketch: { glyph: PenLine, shape: 'square' },
  video: { glyph: Play, shape: 'wide' },
  audio: { glyph: AudioLines, shape: 'square' },
  pdf: { glyph: Text, shape: 'page' },
  document: { glyph: Text, shape: 'page' },
  text: { glyph: Text, shape: 'page' },
  sheet: { glyph: Table2, shape: 'wide' },
  slides: { glyph: Presentation, shape: 'wide' },
  code: { glyph: Braces, shape: 'page' },
  data: { glyph: Braces, shape: 'page' },
  notebook: { glyph: NotebookText, shape: 'square' },
  database: { glyph: Database, shape: 'square' },
  model: { glyph: Box, shape: 'square' },
  archive: { glyph: Package, shape: 'square' },
  font: { glyph: CaseSensitive, shape: 'square' },
  file: { glyph: File, shape: 'square' },
};

/** Formats that can carry transparency; only these are checked for it. */
const ALPHA_EXTENSIONS = new Set(['png', 'apng', 'gif', 'webp', 'avif', 'svg', 'ico', 'cur']);

/** True when the decoded picture has see-through pixels (sampled on a small canvas). */
function hasTransparency(image: HTMLImageElement): boolean {
  try {
    const size = 24;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(image, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);
    for (let index = 3; index < data.length; index += 4) if ((data[index] ?? 255) < 250) return true;
  } catch {
    // A canvas that cannot be read says nothing about the picture.
  }
  return false;
}

function TypeTile({ item, bare = false }: { item: LibraryFile; bare?: boolean }): JSX.Element {
  const { glyph: Glyph, shape } = TILE[item.kind];
  const label = !bare && item.extension.length > 0 && item.extension.length <= 6 ? item.extension : '';
  return (
    <div className={styles.tile} data-preview="tile">
      <span className={styles.tileChip} data-shape={shape}>
        <Glyph size={22} strokeWidth={1.5} aria-hidden="true" focusable="false" />
      </span>
      {label ? <span className={styles.tileLabel}>{label}</span> : null}
    </div>
  );
}

function PicturePreview({ item, url }: { item: LibraryFile; url: string }): JSX.Element {
  // Both keyed on the address, so a rewritten file starts over.
  const [loaded, setLoaded] = useState<{ url: string; alpha: boolean } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === url) return <TypeTile item={item} />;
  const ready = loaded?.url === url;
  const onLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const image = event.currentTarget;
    setLoaded({ url, alpha: ALPHA_EXTENSIONS.has(item.extension) && hasTransparency(image) });
  };
  return (
    <div className={styles.picture} data-preview="image">
      <img
        className={styles.image}
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        data-ready={ready || undefined}
        data-alpha={(ready && loaded.alpha) || undefined}
        onLoad={onLoad}
        onError={() => setFailed(url)}
      />
    </div>
  );
}

function VideoPreview({ item, url, posterKey }: { item: LibraryFile; url: string; posterKey: string }): JSX.Element {
  const poster = useVideoPoster(posterKey, url, true);
  if (poster === false) return <TypeTile item={item} />;
  // Until the frame is read the card is the plain tile; the frame fades in over it.
  return (
    <div className={styles.frame} data-preview="video">
      <TypeTile item={item} bare />
      {poster ? (
        <>
          <img className={styles.cover} src={poster} alt="" draggable={false} />
          <span className={styles.play}>
            <Play size={11} strokeWidth={2} aria-hidden="true" focusable="false" />
          </span>
        </>
      ) : null}
    </div>
  );
}

function Blocks({ blocks }: { blocks: readonly SketchBlock[] }): JSX.Element {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return (
              <p key={index} className={styles.heading} data-level={block.level}>
                {block.text}
              </p>
            );
          case 'item':
            return (
              <p key={index} className={styles.item}>
                {block.text}
              </p>
            );
          case 'quote':
            return (
              <p key={index} className={styles.quote}>
                {block.text}
              </p>
            );
          case 'code':
            return (
              <p key={index} className={styles.codeLine}>
                {block.text || ' '}
              </p>
            );
          case 'rule':
            return <span key={index} className={styles.rule} />;
          case 'image':
            return <span key={index} className={styles.block} />;
          case 'button':
            return (
              <span key={index} className={styles.pill}>
                {block.text}
              </span>
            );
          default:
            return (
              <p key={index} className={styles.paragraph}>
                {block.text}
              </p>
            );
        }
      })}
    </>
  );
}

type Sketch =
  | { kind: 'lines'; lines: string[] }
  | { kind: 'blocks'; blocks: SketchBlock[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'page'; title: string; blocks: SketchBlock[] };

function sketchOf(item: LibraryFile, text: string): Sketch | null {
  if (looksBinary(text)) return null;
  if (item.preview === 'markdown') {
    const blocks = sketchMarkdown(text);
    return blocks.length > 0 ? { kind: 'blocks', blocks } : null;
  }
  if (item.preview === 'table') {
    const rows = sketchTable(text, item.extension === 'tsv' || item.extension === 'tab' ? '\t' : undefined);
    return rows.length > 0 ? { kind: 'table', rows } : null;
  }
  if (item.preview === 'page') {
    const page = sketchPage(text);
    return { kind: 'page', title: page.title || item.label, blocks: page.blocks };
  }
  const lines = sketchLines(text);
  return lines.some((line) => line !== '') ? { kind: 'lines', lines } : null;
}

function SheetPreview({ projectId, item }: { projectId: string; item: LibraryFile }): JSX.Element {
  const { workspaceContext } = useProjectCollabContext();
  const source = usePreviewText(
    projectId,
    item.file,
    item.preview === 'page' ? PAGE_PREVIEW_BYTES : TEXT_PREVIEW_BYTES,
    true,
    workspaceContext,
  );
  const text = source?.status === 'ready' ? source.text : null;
  const sketch = useMemo(() => (text === null ? null : sketchOf(item, text)), [item, text]);

  // Read, and there is nothing to draw (another encoding, binary content, no text at all).
  if (source && !sketch) return <TypeTile item={item} />;

  const columns = sketch?.kind === 'table' ? Math.max(1, ...sketch.rows.map((row) => row.length)) : 0;
  return (
    <div className={styles.sheetGround} data-preview={item.preview}>
      <div className={styles.sheet} data-variant={sketch?.kind ?? 'pending'}>
        {sketch?.kind === 'page' ? <span className={styles.pageBar} aria-hidden="true" /> : null}
        <div className={styles.sheetInner} data-ready={sketch ? '' : undefined}>
          {sketch?.kind === 'lines' ? <pre className={styles.lines}>{sketch.lines.join('\n')}</pre> : null}
          {sketch?.kind === 'blocks' ? <Blocks blocks={sketch.blocks} /> : null}
          {sketch?.kind === 'page' ? (
            <>
              <p className={styles.heading} data-level={1}>
                {sketch.title}
              </p>
              {sketch.blocks.length > 0 ? (
                <Blocks blocks={sketch.blocks} />
              ) : (
                // A page that builds itself with script has no outline to read: quiet bars stand in.
                <>
                  <span className={styles.bar} data-width="wide" />
                  <span className={styles.bar} />
                  <span className={styles.block} />
                  <span className={styles.bar} data-width="short" />
                </>
              )}
            </>
          ) : null}
          {sketch?.kind === 'table' ? (
            <div className={styles.table} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {sketch.rows.map((row, rowIndex) =>
                Array.from({ length: columns }, (_, column) => (
                  <span key={`${rowIndex}:${column}`} className={styles.cell} data-head={rowIndex === 0 || undefined}>
                    {row[column] ?? ''}
                  </span>
                )),
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface FilePreviewProps {
  projectId: string;
  item: LibraryFile;
}

export const FilePreview = memo(function FilePreview({ projectId, item }: FilePreviewProps): JSX.Element {
  const { workspaceContext } = useProjectCollabContext();
  const { file } = item;
  const url = useMemo(
    () => appendResourceQuery(projectFileUrl(projectId, file.name, workspaceContext), `v=${Math.round(file.mtime)}`),
    [projectId, file.name, file.mtime, workspaceContext],
  );
  switch (item.preview) {
    case 'image':
      return <PicturePreview item={item} url={url} />;
    case 'video':
      return <VideoPreview item={item} url={url} posterKey={previewKey(projectId, file)} />;
    case 'page':
    case 'markdown':
    case 'table':
    case 'text':
      return <SheetPreview projectId={projectId} item={item} />;
    default:
      return <TypeTile item={item} />;
  }
});
