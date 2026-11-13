import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { MovieVideoSource } from '@open-design/contracts';
import { Button, Icon } from '../../fantay/ui';
import styles from './MovieSourcePreview.module.css';

/** Source monitor: play an imported source, mark in/out (I / O) and add that range to the timeline. */
export function MovieSourcePreview({ source, url, zh, disabled, onClose, onAdd }: {
  source: MovieVideoSource;
  url(path: string): string;
  zh: boolean;
  disabled: boolean;
  onClose(): void;
  onAdd(range: { in: number; duration: number }, mode: 'append' | 'overlay'): void;
}) {
  const player = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const image = source.kind === 'image';
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState(source.duration.toFixed(3));
  const [mode, setMode] = useState<'append' | 'overlay'>(source.kind === 'audio' ? 'overlay' : 'append');
  const [error, setError] = useState('');
  useEffect(() => {
    const media = player.current;
    return () => media?.pause();
  }, []);
  const mark = (edge: 'in' | 'out') => {
    const t = Math.max(0, Math.min(source.duration, player.current?.currentTime ?? 0));
    if (edge === 'in') setStart(t.toFixed(3)); else setEnd(t.toFixed(3));
  };
  const add = () => {
    const a = Number(start), b = Number(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b - a < 1 / 60 || (!image && b > source.duration + 0.04)) {
      setError(zh ? '请选择素材范围内的有效入点和出点。' : 'Choose valid in/out points inside the source.');
      return;
    }
    player.current?.pause();
    onAdd({ in: image ? 0 : a, duration: b - a }, mode);
  };
  const length = Math.max(0, Number(end) - (image ? 0 : Number(start)));
  return (
    <div
      className={styles.preview}
      onKeyDown={e => {
        e.stopPropagation();
        if ((e.target as HTMLElement).closest('input,select,button')) return;
        if (e.key.toLowerCase() === 'i') mark('in');
        if (e.key.toLowerCase() === 'o') mark('out');
      }}
    >
      <div className={styles.head}>
        <Button size="sm" variant="bare" onClick={onClose}><Icon icon={ArrowLeft} size="sm" />{zh ? '返回时间线' : 'Back to timeline'}</Button>
        <strong className={styles.title} title={source.label}>{source.label}</strong>
        <span className={styles.meta}>{image ? (zh ? '图片' : 'Image') : `${source.width} × ${source.height}`}</span>
      </div>
      <div className={styles.stage}>
        {image ? <img className={styles.media} src={url(source.path)} alt={source.label} />
          : source.kind === 'audio' ? <audio ref={player as React.RefObject<HTMLAudioElement>} className={styles.audio} controls src={url(source.previewPath ?? source.path)} preload="metadata" />
          : <video ref={player as React.RefObject<HTMLVideoElement>} className={styles.media} controls src={url(source.previewPath ?? source.path)} preload="metadata" playsInline poster={source.frames[0] ? url(source.frames[0].path) : undefined} />}
      </div>
      <div className={styles.range}>
        {!image ? (
          <label className={styles.field}>
            <span>{zh ? '入点' : 'In'}</span>
            <input className={styles.number} aria-label={zh ? '素材入点' : 'Source in'} type="number" min={0} step={0.01} value={start} onChange={e => setStart(e.target.value)} />
            <button type="button" className={styles.mark} title={zh ? '在当前位置设入点 (I)' : 'Mark in (I)'} onClick={() => mark('in')}>I</button>
          </label>
        ) : null}
        <label className={styles.field}>
          <span>{image ? (zh ? '时长' : 'Duration') : (zh ? '出点' : 'Out')}</span>
          <input className={styles.number} aria-label={zh ? '素材出点' : 'Source out'} type="number" min={0} step={0.01} value={end} onChange={e => setEnd(e.target.value)} />
          {!image ? <button type="button" className={styles.mark} title={zh ? '在当前位置设出点 (O)' : 'Mark out (O)'} onClick={() => mark('out')}>O</button> : null}
        </label>
        <span className={styles.length}>{Number.isFinite(length) ? `${length.toFixed(2)} s` : ''}</span>
        <span className={styles.spacer} />
        <select className={styles.mode} aria-label={zh ? '素材添加位置' : 'Insert mode'} value={mode} onChange={e => setMode(e.target.value as 'append' | 'overlay')}>
          <option value="append">{zh ? '接到末尾' : 'Append'}</option>
          <option value="overlay">{zh ? '叠加到播放头' : 'Overlay at playhead'}</option>
        </select>
        <Button size="sm" variant="primary" disabled={disabled} onClick={add}>{zh ? '添加片段' : 'Add clip'}</Button>
      </div>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    </div>
  );
}
