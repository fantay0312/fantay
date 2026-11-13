import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { parseStudioTokens, resolveStudioToken, type StudioLibraryEntry } from '@open-design/contracts';
import { bundleStudioEntry, type StudioResourceReader } from '../runtime/studio-entry-bundle';
import { readStudioPreviewReport, STUDIO_TILE_HEIGHT, studioComponentPreview, studioThumbnail, type StudioPreviewReport } from '../runtime/design-system-studio';
import { previewStorageKey, readPreviewStorage, savePreviewStorageMessage } from '../runtime/preview-storage';
import { randomUUID } from '../utils/uuid';
import styles from './StudioCatalog.module.css';

// A stage never drops below a usable height, and a tall page scrolls inside it rather than pushing the catalog away.
const MIN_FIT_HEIGHT = 168;
const MAX_FIT_HEIGHT = 560;
// A page sized in vh grows with its frame; the thumbnail frame stops following it here.
const THUMBNAIL_FRAME_CAP = 1600;
// A thumbnail stays hidden until it has its final scale, but never longer than this after load.
const THUMBNAIL_REVEAL_WAIT = 600;

// Heights outlive a remount (chapter switch, reopening a system), so a box comes back at its
// last measured size instead of growing from the minimum after its frame loads.
const fitCache = new Map<string, number>();
// So does the layout width a thumbnail settled on, for the tile width it was settled in.
const thumbnailCache = new Map<string, { box: number; layout: number }>();

export function StudioEntryPreview({ entry, html, css, theme, readResource, scope, title, reset = 0, storageId = 'default', resourceRevision = 0, chinese = true, fit = false, thumbnail = false }: {
  entry: StudioLibraryEntry; html: string; css: string; theme: string; readResource: StudioResourceReader; scope: string; title: string; reset?: number; storageId?:string; resourceRevision?:number; chinese?: boolean;
  /** Hug the content's height instead of the catalog's fixed stage height. */
  fit?: boolean;
  /** A closed gallery tile: the whole entry, scaled down into a tile-sized picture. Needs `fit`. */
  thumbnail?: boolean;
}) {
  const t = (zh: string, en: string) => chinese ? zh : en;
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const reader = useRef(readResource); reader.current = readResource;
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [waited, setWaited] = useState(false);
  const [externalCount,setExternalCount]=useState(0);
  const fitKey = scope + '\u0000' + entry.id + '\u0000' + storageId;
  const [fitHeight, setFitHeight] = useState(() => fitCache.get(fitKey) ?? MIN_FIT_HEIGHT);
  const [shownKey, setShownKey] = useState(fitKey);
  if (shownKey !== fitKey) {
    // Another example of the same entry: start from its own last size, or hold the current one.
    setShownKey(fitKey);
    const cached = fitCache.get(fitKey);
    if (cached !== undefined) setFitHeight(cached);
  }
  // The frame may report before it has loaded; the report waits here so the box changes size
  // once, as the frame fades in, rather than while it is still invisible.
  const reported = useRef<number | null>(null);
  const loadedRef = useRef(false);
  const applyFit = (height: number) => { fitCache.set(fitKey, height); setFitHeight(height); };
  const applyRef = useRef(applyFit); applyRef.current = applyFit;
  const lastReset=useRef(reset);
  const storageKey = previewStorageKey(scope, 'design-system-examples', entry.id + '/' + storageId);
  const generation = useMemo(() => randomUUID(), [scope, entry.id, title, html, css, theme, reset,resourceRevision]);

  // The tile's width, measured only while it is a tile: an open entry's width says nothing about the tile it closes back into.
  const tiled = fit && thumbnail;
  const tiledRef = useRef(tiled); tiledRef.current = tiled;
  const [boxWidth, setBoxWidth] = useState(0);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !tiled) return undefined;
    const measure = () => { if (tiledRef.current) setBoxWidth(node.clientWidth); };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [tiled]);
  const [report, setReport] = useState<StudioPreviewReport | null>(null);
  const [layout, setLayout] = useState({ key: '', box: 0, width: 0 });
  if (tiled && boxWidth > 0 && (layout.key !== fitKey || layout.box !== boxWidth)) {
    const cached = thumbnailCache.get(fitKey);
    setLayout({ key: fitKey, box: boxWidth, width: cached?.box === boxWidth ? cached.layout : boxWidth });
  }
  const thumb = tiled && boxWidth > 0 && layout.key === fitKey && layout.box === boxWidth ? studioThumbnail(boxWidth, layout.width, report) : null;
  if (thumb && thumb.layout !== layout.width) setLayout({ ...layout, width: thumb.layout });
  useEffect(() => { if (thumb?.settled) thumbnailCache.set(fitKey, { box: layout.box, layout: thumb.layout }); }, [thumb?.settled, thumb?.layout, layout.box, fitKey]);
  // A tile that cannot measure itself (no layout) still shows, as a plain top-aligned frame.
  if (!revealed && loaded && (!tiled || boxWidth <= 0 || thumb?.settled || waited)) setRevealed(true);
  useEffect(() => {
    if (!loaded || revealed) return undefined;
    const timer = setTimeout(() => setWaited(true), THUMBNAIL_REVEAL_WAIT);
    return () => clearTimeout(timer);
  }, [loaded, revealed]);

  useEffect(() => {
    let disposed = false; setError(''); setSource(''); setLoaded(false); setRevealed(false); setWaited(false); setReport(null);
    reported.current = null; loadedRef.current = false;
    if (reset!==lastReset.current && storageKey) { window.localStorage.removeItem(storageKey); lastReset.current=reset; }
    void bundleStudioEntry({ ...entry, html }, css, reader.current).then(bundle => {
      if (disposed) return;
      setExternalCount(bundle.externalResources.length);
      setSource(studioComponentPreview(bundle.html, '', theme, path => path, storageKey ? { generation, values: readPreviewStorage(storageKey) } : undefined, fit));
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : t('预览加载失败', 'Preview failed to load')); });
    return () => { disposed = true; };
  }, [html, css, theme, generation]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      savePreviewStorageMessage(event, frame.current?.contentWindow ?? null, generation, storageKey);
      if (!fit || event.source !== frame.current?.contentWindow) return;
      const next = readStudioPreviewReport(event.data);
      if (!next) return;
      // A tile settles its layout while the frame is still hidden; the open stage waits for the load.
      if (tiledRef.current) setReport(next);
      reported.current = Math.min(MAX_FIT_HEIGHT, Math.max(MIN_FIT_HEIGHT, next.height));
      if (loadedRef.current || tiledRef.current) applyRef.current(reported.current);
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  }, [generation, storageKey, fit]);
  const onLoad = () => {
    loadedRef.current = true;
    // The frame dedupes equal reports, so a height that arrived before load is never sent again.
    if (fit && reported.current !== null) applyFit(reported.current);
    setLoaded(true);
  };
  // The frame document is transparent past its content, so the system's own ground fills the rest
  // of the box and the wait. The box always holds its height: rows keep their place during a swap.
  const ground = useMemo(() => resolveStudioToken('--bg', parseStudioTokens(css), theme === 'light' ? ':root' : '[data-theme="' + theme + '"]'), [css, theme]);
  // A tile draws the frame at its layout width, scaled from the top and centred across, and keeps
  // the frame at least as tall as its page so it never shows a scrollbar; a crop is a clip, not a resize.
  let frameStyle: CSSProperties | undefined = fit ? { height: fitHeight } : undefined;
  if (thumb) {
    const height = Math.max(Math.ceil(STUDIO_TILE_HEIGHT / thumb.scale), Math.min(THUMBNAIL_FRAME_CAP, report?.height ?? 0));
    frameStyle = {
      width: thumb.layout, maxWidth: 'none', height, right: 'auto',
      left: Math.max(0, Math.round((boxWidth - thumb.scale * thumb.layout) / 2)),
      transform: thumb.scale < 1 ? 'scale(' + thumb.scale + ')' : undefined, transformOrigin: '0 0',
      clipPath: thumb.clip === null ? undefined : 'inset(0 0 ' + Math.max(0, height - thumb.clip) + 'px 0)',
    };
  } else if (tiled) frameStyle = { height: Math.max(STUDIO_TILE_HEIGHT, fitHeight) };
  const boxHeight = tiled ? STUDIO_TILE_HEIGHT : fit ? fitHeight : undefined;
  return <div ref={box} className={styles.previewBox} style={{ ...(ground ? { background: ground } : null), ...(boxHeight === undefined ? null : { height: boxHeight }) }} data-fit={fit ? '' : undefined} data-thumbnail={tiled ? '' : undefined} data-state={error ? 'error' : revealed ? 'ready' : 'loading'}>
    {error ? <p role="alert" className={styles.previewError}>{error}</p> : <p role="status" className={styles.previewLoading}>{revealed ? '' : t('正在加载预览…', 'Loading preview…')}</p>}
    {source && !error && <iframe ref={frame} title={title} sandbox="allow-scripts allow-popups" srcDoc={source} loading="lazy" style={frameStyle} onLoad={onLoad} />}
    {externalCount>0 && revealed && <p role="status" className={styles.previewNote}>{chinese ? '包含 ' + externalCount + ' 个远端资源，预览和导出后仍需联网。' : externalCount + ' remote resources: preview and exports still need a connection.'}</p>}
  </div>;
}
