import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Film, FolderOpen } from 'lucide-react';
import { movieDuration, movieFps, movieFrameSize, type MovieDocument, type MovieExportOptions, type MovieRender, type WorkspaceCollabContext } from '@open-design/contracts';
import { getHostMovieExport } from '@open-design/host';
import { useI18n } from '../../i18n';
import { Button, Icon, Input, Modal, ModalTitle, Progress, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../fantay/ui';
import { MoviePreviewFrame } from '../../fantay/motion/MoviePreviewFrame';
import styles from './MovieExportDialog.module.css';
import { movieExportProgress } from './movie-export-progress';

export interface MovieExportDialogProps {
  open: boolean;
  onClose(): void;
  document: MovieDocument;
  projectId: string;
  context?: WorkspaceCollabContext | null;
  rendererControl?: ReactNode;
  progress?: string;
  onExport(options: MovieExportOptions): Promise<MovieRender | null> | void;
}

export function MovieExportDialog({ open, onClose, document: film, projectId, context, rendererControl, progress, onExport }: MovieExportDialogProps) {
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const [filename, setFilename] = useState(film.title);
  const [format, setFormat] = useState<'mp4' | 'mov'>('mp4');
  const [resolution, setResolution] = useState('source');
  const [frameRate, setFrameRate] = useState('source');
  const [destination, setDestination] = useState<{ id: string; path: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const render = useRef<MovieRender | null>(null);
  const renderedContent = useRef(film.contentRevision);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const original = movieFrameSize(film);
  const scale = resolution === 'source' ? 1 : Number(resolution) / Math.min(original.width, original.height);
  const width = Math.round(original.width * scale / 2) * 2;
  const height = Math.round(original.height * scale / 2) * 2;
  const duration = movieDuration(film);
  const fps = frameRate === 'source' ? movieFps(film) : Number(frameRate);
  const reset = () => { setDestination(null); setSaved(false); setError(''); render.current = null; };
  useEffect(() => {
    if (busy || renderedContent.current === film.contentRevision) return;
    renderedContent.current = film.contentRevision;
    setDestination(null); setSaved(false); setError(''); render.current = null;
  }, [film.contentRevision, busy]);
  const choose = async () => {
    const host = getHostMovieExport();
    if (!host) { setError(zh ? '请更新桌面应用后导出。' : 'Update the desktop app to export.'); return null; }
    setChoosing(true); setError('');
    try {
      const result = await host.chooseDestination({ filename, format });
      if (!result.ok) { if (!result.cancelled) setError(result.reason); return null; }
      setDestination(result); setSaved(false);
      return result;
    } catch (cause) { setError(String(cause)); return null; }
    finally { setChoosing(false); }
  };
  const start = async () => {
    if (inFlight.current || choosing || !filename.trim()) return;
    inFlight.current = true;
    try {
      const target = destination ?? await choose();
      if (!target) return;
      const host = getHostMovieExport();
      if (!host) throw new Error(zh ? '桌面导出不可用。' : 'Desktop export is unavailable.');
      setBusy(true); setError(''); setSaved(false);
      if (!render.current) render.current = await onExport({ format, width, height, frameRate: frameRate === 'source' ? film.settings?.frameRate ?? { numerator: 30, denominator: 1 } : { numerator: Number(frameRate), denominator: 1 } }) ?? null;
      if (!render.current) throw new Error(zh ? '未能开始导出，请检查项目后重试。' : 'Could not start export. Check the project and try again.');
      const result = await host.save({ destinationId: target.id, projectId, renderId: render.current.id, workspaceContext: context });
      if (!result.ok) throw new Error(result.reason);
      setDestination(result); setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // The next attempt starts a fresh render after a failed render or save.
      render.current = null;
    } finally { setBusy(false); inFlight.current = false; }
  };
  const openSaved = async (reveal: boolean) => {
    if (!destination) return;
    const result = await getHostMovieExport()?.open({ destinationId: destination.id, reveal });
    if (result && !result.ok) setError(result.reason);
  };
  const meter = movieExportProgress(progress, film.renders.some(item => item.id === render.current?.id && item.status === 'done'), zh);

  return <Modal open={open} onClose={onClose} size="2xl" className={styles.dialog} aria-describedby={undefined}>
    <header className={styles.header}><ModalTitle>{zh ? '导出视频' : 'Export video'}</ModalTitle><p title={film.title}>{film.title}</p></header>
    <div className={styles.body}>
      <div className={styles.previewColumn}>
        <div className={styles.preview} style={{ aspectRatio: `${original.width} / ${original.height}` }}>
          {open ? <MoviePreviewFrame document={film} projectId={projectId} workspaceContext={context} initialTime={Math.min(.8, duration / 2)} variant="fill" title={zh ? '导出预览' : 'Export preview'} /> : null}
        </div>
        <div className={styles.summary}><Icon icon={Film} size="sm" /><span>{duration.toFixed(2)} {zh ? '秒' : 'seconds'} · {width} × {height} · {Number(fps.toFixed(3))} fps</span></div>
        <p className={styles.hint}>{zh ? '按当前时间线导出，包含文字、字幕和音频。' : 'Exports the current timeline with text, captions and audio.'}</p>
      </div>
      <div className={styles.settings}>
        <fieldset disabled={busy || choosing} className={styles.fields}>
          <label className={styles.row}><span>{zh ? '文件名' : 'Filename'}</span><Input aria-label={zh ? '文件名' : 'Filename'} value={filename} maxLength={160} onChange={event => { setFilename(event.target.value); reset(); }} /></label>
          <div className={styles.row}><span>{zh ? '导出到' : 'Save to'}</span><button type="button" className={styles.destination} onClick={() => void choose()} title={destination?.path} aria-label={zh ? '选择导出位置' : 'Choose export location'}><span>{destination?.path ?? (choosing ? (zh ? '正在选择…' : 'Choosing…') : (zh ? '选择保存位置…' : 'Choose a location…'))}</span><Icon icon={FolderOpen} size="sm" /></button></div>
          <div className={styles.divider} />
          <label className={styles.row}><span>{zh ? '分辨率' : 'Resolution'}</span><Select value={resolution} disabled={busy || choosing} onValueChange={value => { setResolution(value); reset(); }}><SelectTrigger aria-label={zh ? '导出分辨率' : 'Export resolution'}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="source">{zh ? '与项目一致' : 'Match project'} · {original.width} × {original.height}</SelectItem><SelectItem value="720">720P</SelectItem><SelectItem value="1080">1080P</SelectItem><SelectItem value="2160">4K</SelectItem></SelectContent></Select></label>
          <label className={styles.row}><span>{zh ? '格式' : 'Format'}</span><Select value={format} disabled={busy || choosing} onValueChange={value => { setFormat(value as 'mp4' | 'mov'); reset(); }}><SelectTrigger aria-label={zh ? '导出格式' : 'Export format'}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="mp4">MP4</SelectItem><SelectItem value="mov">MOV</SelectItem></SelectContent></Select></label>
          <label className={styles.row}><span>{zh ? '帧率' : 'Frame rate'}</span><Select value={frameRate} disabled={busy || choosing} onValueChange={value => { setFrameRate(value); reset(); }}><SelectTrigger aria-label={zh ? '导出帧率' : 'Export frame rate'}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="source">{zh ? '与项目一致' : 'Match project'} · {Number(movieFps(film).toFixed(3))} fps</SelectItem>{[24, 25, 30, 50, 60].map(value => <SelectItem key={value} value={String(value)}>{value} fps</SelectItem>)}</SelectContent></Select></label>
          <div className={styles.row}><span>{zh ? '编码' : 'Codec'}</span><span className={styles.codec}>H.264 · AAC</span></div>
          {rendererControl ? <div className={styles.row}><span>{zh ? '导出方式' : 'Renderer'}</span>{rendererControl}</div> : null}
        </fieldset>
      </div>
    </div>
    {(busy || saved || error) ? <div className={styles.feedback}>
      {busy ? <div role="status" className={styles.progress}><div className={styles.progressLabel}><span>{meter.label}</span><strong>{meter.value}%</strong></div><Progress value={meter.value} aria-label={zh ? '导出进度' : 'Export progress'} /><span className={styles.hint}>{zh ? '已用时' : 'Elapsed'} {Math.floor(elapsed / 60).toString().padStart(2, '0')}:{(elapsed % 60).toString().padStart(2, '0')}</span></div> : null}
      {saved ? <><Progress value={100} aria-label={zh ? '导出进度' : 'Export progress'} /><div role="status" className={styles.success}><Icon icon={Check} size="sm" /><div><strong>{zh ? '导出完成 · 100%' : 'Export complete · 100%'}</strong><p>{destination?.path}</p></div></div></> : null}
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    </div> : null}
    <footer className={styles.footer}>
      <span className={styles.hint}>{format.toUpperCase()} · {width} × {height}</span>
      <div className={styles.actions}>
        {saved ? <><Button variant="secondary" onClick={() => void openSaved(true)}>{zh ? '在文件夹中显示' : 'Show in folder'}</Button><Button variant="primary" onClick={() => void openSaved(false)}>{zh ? '打开文件' : 'Open file'}</Button></> : <><Button variant="secondary" onClick={onClose}>{busy ? (zh ? '在后台继续' : 'Continue in background') : (zh ? '取消' : 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={busy || choosing || !filename.trim()} onClick={() => void start()}>{busy ? (zh ? '正在导出' : 'Exporting') : (zh ? '导出' : 'Export')}</Button></>}
      </div>
    </footer>
  </Modal>;
}
