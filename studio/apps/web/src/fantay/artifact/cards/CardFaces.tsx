// SPDX-License-Identifier: AGPL-3.0-only
// The picture a product card shows, at two sizes: the cover of a single product and the 36px tile
// of a row. A page is its frozen first screen or the page drawn live, an image is the image, a clip
// its poster or first frame, and a document is a sheet of its own paper with its first lines. A
// picture that cannot be drawn falls back to the document cover or the type glyph, never to a
// broken-image box or an empty block.
'use client';

import { useMemo, useState } from 'react';

import { useInView } from '../../../components/plugins-home/useInView';
import { HtmlProjectCoverFrame } from '../../../components/project-cover';
import type { ProjectFile } from '../../../types';
import { pickFileIcon } from '../../workspace/code/file-visual';
import { useArtifactText } from '../use-artifact-source';
import styles from './ArtifactCards.module.css';
import {
  EXCERPT_MAX_BYTES,
  coverExcerpt,
  coverMediaFit,
  coverReadsText,
  excerptStyle,
  productName,
  tileImageFit,
  type ArtifactProduct,
  type ProductFace,
  type ProductMeasure,
} from './card-model';

/** The waiting sweep: while a file is being written and while a live page is on its way. */
export function Sheen(): JSX.Element {
  return <span className={styles.sheen} data-testid="artifact-card-sheen" aria-hidden="true" />;
}

/** The type glyph a file wears when it has no picture. */
export function TypeGlyph({ name, mime, size }: { name: string; mime?: string; size: number }): JSX.Element {
  const Icon = pickFileIcon(name, mime);
  return (
    <span className={styles.glyph}>
      <Icon aria-hidden="true" size={size} strokeWidth={1.75} />
    </span>
  );
}

export interface ProductFaceProps {
  item: ArtifactProduct;
  face: ProductFace;
  size: 'cover' | 'tile';
  projectId: string;
  /** The current file's address, carrying its revision. */
  liveUrl: string;
  /** What an image or a clip is read from: this turn's frozen copy when there is one. */
  mediaUrl: string;
  /** The project's record of the file, when it is in the list. */
  file: ProjectFile | undefined;
  /** What is known of the picture so far; a cover picks its fit from it. */
  measure?: ProductMeasure | undefined;
  /** Pixel size and length, read off the loaded picture. */
  onMeasure(measure: ProductMeasure): void;
}

export function ProductFaceView(props: ProductFaceProps): JSX.Element {
  const { item, face, size, projectId, mediaUrl, file, measure, onMeasure } = props;
  const fit = size === 'tile' ? 'cover' : coverMediaFit(measure);
  // A picture that failed is remembered by its address, so a new revision gets a new attempt.
  const [failed, setFailed] = useState<string | null>(null);
  // Shown once it has something to show, and from then on: when the file changes, the element
  // keeps the previous picture until the new one has loaded, so the card never blinks.
  const [ready, setReady] = useState(false);

  const fallback =
    size === 'tile' ? (
      <TypeGlyph name={item.name} mime={file?.mime} size={18} />
    ) : (
      <DocumentCover projectId={projectId} name={item.name} file={file} readText={face === 'document'} />
    );

  if (face === 'page') return <PageFace {...props} fallback={fallback} />;
  if (face === 'document' || failed === mediaUrl) return fallback;

  if (face === 'video') {
    return (
      /*
       * Still a `<video>`: with a poster it paints this turn's frozen frame, without one the
       * browser paints the current file's first frame. Nothing is pressed onto it.
       */
      <video
        className={styles.media}
        data-fit={fit}
        data-ready={ready ? '' : undefined}
        src={mediaUrl}
        poster={item.coverUrl}
        muted
        playsInline
        preload="metadata"
        tabIndex={-1}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          onMeasure({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
          setReady(true);
        }}
        onError={() => setFailed(mediaUrl)}
      />
    );
  }

  return (
    <img
      className={styles.media}
      data-fit={size === 'tile' ? tileImageFit(item.name) : fit}
      data-ready={ready ? '' : undefined}
      src={mediaUrl}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (image.naturalWidth > 0) onMeasure({ width: image.naturalWidth, height: image.naturalHeight });
        setReady(true);
      }}
      onError={() => setFailed(mediaUrl)}
    />
  );
}

function PageFace({ item, size, projectId, liveUrl, fallback }: ProductFaceProps & { fallback: JSX.Element }): JSX.Element {
  // A frozen first screen is an optimisation, not the only face: if it is gone or cannot be decoded,
  // the page is drawn live instead.
  const [failedCover, setFailedCover] = useState<string | null>(null);
  const [coverReady, setCoverReady] = useState(false);
  const [motionSize, setMotionSize] = useState<{ src: string; width: number; height: number }>();
  // A live page may have changed since the turn's snapshot; its announced canvas only sizes the
  // inner viewport, the box around it stays put.
  const frameSize = motionSize?.src === liveUrl ? motionSize : item.motionPreview;

  if (item.coverUrl && !item.motionPreview && failedCover !== item.coverUrl) {
    return (
      /*
       * This turn's first screen, frozen: the card looks as it did then, while a click opens the
       * workspace's latest version.
       */
      <img
        className={styles.media}
        data-fit="cover"
        data-kind="page"
        data-ready={coverReady ? '' : undefined}
        src={item.coverUrl}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setCoverReady(true)}
        onError={() => setFailedCover(item.coverUrl ?? null)}
      />
    );
  }

  return (
    <>
      {/* Under the frame: it shows through only when the page cannot be drawn. */}
      {fallback}
      <HtmlProjectCoverFrame
        src={liveUrl}
        motionThumbnail
        motionSize={frameSize}
        onMotionSize={(next) =>
          setMotionSize((current) =>
            current?.src === liveUrl && current.width === next.width && current.height === next.height
              ? current
              : { src: liveUrl, ...next },
          )
        }
        initial=""
        iframeClassName={styles.frame ?? ''}
        glyphClassName={styles.frameGlyph ?? ''}
        /* Non-empty on purpose: it is also what admits the frame to the chat's frame recycling. */
        pendingContent={<Sheen />}
        diagnostic={`${projectId}:${item.name}:${size}`}
        /* The product is the answer's subject, so it loads in the foreground lane (with its own budget). */
        ungated
      />
    </>
  );
}

/** An empty line still takes a line's height. */
const BLANK_LINE = String.fromCharCode(0xa0);

function placeholderFile(name: string): ProjectFile {
  return { name, size: 0, mtime: 0, kind: 'text', mime: '' };
}

/**
 * A sheet of the document's own paper: its type, its title, and its first lines when the file is
 * text and small enough to read. The structure shows at once; the lines arrive when they are read.
 */
function DocumentCover({
  projectId,
  name,
  file,
  readText,
}: {
  projectId: string;
  name: string;
  file: ProjectFile | undefined;
  /** False when this cover stands in for a picture that failed: there is no text to fetch. */
  readText: boolean;
}): JSX.Element {
  const readable = readText && coverReadsText(name, file?.size);
  const style = readable ? excerptStyle(name) : null;
  const { ref, inView } = useInView<HTMLSpanElement>({ rootMargin: '200px' });
  const text = useArtifactText(projectId, file ?? placeholderFile(name), {
    enabled: readable && inView,
    maxBytes: EXCERPT_MAX_BYTES,
  });
  const content = readable && text.source.status === 'ready' ? text.source.data : null;
  const excerpt = useMemo(() => (content !== null && style ? coverExcerpt(content, style) : null), [content, style]);
  // While the text is on its way the title's place is kept empty: the document's own heading is
  // about to take it, and a file name that turns into a heading reads as a flicker. Only for the
  // grace period, though: a slow read shows the file name rather than an empty sheet.
  const waiting = readable && text.source.status === 'loading' && !text.source.slow;

  const { stem, extension } = productName(name);
  const Icon = pickFileIcon(name, file?.mime);

  return (
    <span ref={ref} className={styles.sheetStage}>
      <span className={styles.sheet} data-style={style === 'mono' ? 'mono' : 'prose'} data-testid="artifact-card-sheet">
        <span className={styles.sheetTag}>
          <Icon aria-hidden="true" size={13} strokeWidth={1.75} />
          {extension ? extension.slice(1).toUpperCase() : null}
        </span>
        <span key={waiting ? 'waiting' : 'set'} className={styles.sheetTitle} data-waiting={waiting ? '' : undefined}>
          {excerpt?.title ?? stem}
        </span>
        {excerpt && excerpt.lines.length > 0 ? (
          <span className={styles.sheetLines}>
            {excerpt.lines.map((line, index) => (
              // Lines are positional and never reorder.
              // eslint-disable-next-line react/no-array-index-key
              <span key={index} className={styles.sheetLine} data-heading={line.heading ? '' : undefined}>
                {line.text || BLANK_LINE}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </span>
  );
}
