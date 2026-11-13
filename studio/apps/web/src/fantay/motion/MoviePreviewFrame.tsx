// SPDX-License-Identifier: AGPL-3.0-only
// Film preview frame (spec 07 §3.3), extracted from MovieStudio's private `MoviePreview` and fixed:
// the srcdoc is memoised, the iframe is scaled to its box with a ResizeObserver, and messages go
// out only through the imperative handle — never on a React re-render — so playback is driven by
// a clock instead of a 100 ms re-seek loop. On every load the last known state is re-posted.
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { buildMovieHtml, movieFrameSize, movieTextValue, type MovieTextTarget, type MovieDocument, type WorkspaceCollabContext } from '@open-design/contracts';

import { cn } from '../ui';
import { MotionCover } from './MotionCover';
import { motionFrameSize, resolveMotionCover } from './motion-model';
import styles from './MoviePreviewFrame.module.css';

export interface MoviePreviewFrameHandle {
  /** Posts `{ type: 'fantay-movie', action: 'seek', time }`. */
  seek(time: number): void;
  /** Posts `{ type: 'fantay-movie', action: 'play', loop }`. */
  play(options?: { loop?: boolean }): void;
  /** Posts `{ type: 'fantay-movie', action: 'pause' }`. */
  pause(): void;
}

export interface MoviePreviewFrameProps {
  document: MovieDocument;
  /** Asset base `/api/projects/<id>/raw/` (MovieStudio.tsx:160-162). */
  projectId?: string;
  /** Asset query `?workspaceId=…&workspaceMemberId=…`. */
  workspaceContext?: WorkspaceCollabContext | null;
  /** Applied on first load and after every srcdoc rebuild; not re-posted on change. Default 0.8. */
  initialTime?: number;
  /** 'fill' covers the parent box (node, editor stage); 'card' is an aspect-ratio box (thumbnails). */
  variant?: 'fill' | 'card';
  /** Mount the iframe only while the box intersects the viewport (rootMargin 200px). */
  lazy?: boolean;
  /** iframe title (the film title). */
  title: string;
  className?: string;
  onReady?: () => void;
  onEditText?: (target: MovieTextTarget) => void;
}

interface FrameState {
  time: number;
  playing: boolean;
  loop: boolean;
}

function assetQuery(context: WorkspaceCollabContext | null | undefined): string {
  return context
    ? `?workspaceId=${encodeURIComponent(context.workspaceId)}&workspaceMemberId=${encodeURIComponent(context.workspaceMemberId)}`
    : '';
}

export const MoviePreviewFrame = forwardRef<MoviePreviewFrameHandle, MoviePreviewFrameProps>(function MoviePreviewFrame(
  { document, projectId, workspaceContext, initialTime = 0.8, variant = 'fill', lazy = false, title, className, onReady, onEditText },
  ref,
) {
  const boxRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const state = useRef<FrameState>({ time: initialTime, playing: false, loop: false });
  const frame = movieFrameSize(document);
  const [layout, setLayout] = useState({ scale: 0, left: 0, top: 0 });
  const [visible, setVisible] = useState(!lazy);

  const workspaceId = workspaceContext?.workspaceId;
  const workspaceMemberId = workspaceContext?.workspaceMemberId;
  const editable = Boolean(onEditText);
  const srcDoc = useMemo(
    () =>
      buildMovieHtml(document, {
        gsapUrl: '/api/movie/gsap.js',
        assetBase: projectId ? `/api/projects/${encodeURIComponent(projectId)}/raw/` : '',
        assetQuery: assetQuery(workspaceContext),
        seek: initialTime,
        editable,
      }),
    // The workspace identity enters through its two ids only (07 §3.3).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [document, projectId, workspaceId, workspaceMemberId, initialTime, editable],
  );

  useEffect(() => {
    if (!onEditText) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.type !== 'fantay-movie-text') return;
      const { shotId, field, captionId, layerId } = event.data;
      if (typeof shotId !== 'string' || !['title', 'body', 'caption', 'layer'].includes(field)) return;
      const target: MovieTextTarget = { shotId, field, ...(typeof captionId === 'string' ? { captionId } : {}), ...(typeof layerId === 'string' ? { layerId } : {}) };
      if (document.shots.find(s => s.id === shotId)?.locked || movieTextValue(document, target) === undefined) return;
      onEditText(target);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [document, onEditText]);

  const post = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'fantay-movie', ...message }, '*');
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      seek(time: number) {
        state.current.time = time;
        post({ action: 'seek', time });
      },
      play(options?: { loop?: boolean }) {
        const loop = options?.loop === true;
        state.current.playing = true;
        state.current.loop = loop;
        post({ action: 'play', loop });
      },
      pause() {
        state.current.playing = false;
        post({ action: 'pause' });
      },
    }),
    [post],
  );

  // Scale the native-size iframe into the box, centred (contain).
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver !== 'function') return;
    const measure = (width: number, height: number) => {
      if (!(width > 0)) return;
      const scale = variant === 'card' || !(height > 0) ? width / frame.width : Math.min(width / frame.width, height / frame.height);
      setLayout({ scale, left: (width - frame.width * scale) / 2, top: variant === 'card' ? 0 : (height - frame.height * scale) / 2 });
    };
    const observer = new ResizeObserver(([entry]) => {
      if (entry) measure(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(box);
    measure(box.clientWidth, box.clientHeight);
    return () => observer.disconnect();
  }, [variant, frame.width, frame.height]);

  // Lazy mount: only while the box is near the viewport.
  useEffect(() => {
    if (!lazy) {
      setVisible(true);
      return;
    }
    const box = boxRef.current;
    if (!box || typeof IntersectionObserver !== 'function') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setVisible(entry.isIntersecting);
      },
      { rootMargin: '200px' },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [lazy]);

  const handleLoad = useCallback(() => {
    const { time, playing, loop } = state.current;
    post({ action: 'seek', time });
    post(playing ? { action: 'play', loop } : { action: 'pause' });
    onReady?.();
  }, [post, onReady]);

  const placeholder = useMemo(
    () => (visible ? null : resolveMotionCover({ projectId: projectId ?? '', doc: document, strip: null, workspaceContext })),
    // Only the poster's inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, document, projectId, workspaceId, workspaceMemberId],
  );

  const boxStyle: CSSProperties | undefined =
    variant === 'card' ? { aspectRatio: `${frame.width} / ${frame.height}` } : undefined;

  return (
    <div
      ref={boxRef}
      className={cn(styles.box, variant === 'card' ? styles.card : styles.fill, className)}
      style={boxStyle}
      data-testid="movie-preview-frame"
      data-variant={variant}
    >
      {visible ? (
        <iframe
          ref={iframeRef}
          className={styles.frame}
          data-editable={editable || undefined}
          title={title}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          tabIndex={-1}
          aria-hidden="true"
          onLoad={handleLoad}
          style={{
            width: frame.width,
            height: frame.height,
            transform: `translate(${layout.left}px, ${layout.top}px) scale(${layout.scale})`,
            visibility: layout.scale > 0 ? 'visible' : 'hidden',
          }}
        />
      ) : (
        <MotionCover cover={placeholder} aspect={document.aspect} />
      )}
    </div>
  );
});
