/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 studio — small pieces the sheet is built from: an auto-growing editable text, an image
 * plate with its per-asset status, and the video-cover poster.
 * Derived from dsh-media-desk client/studio.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import type { WorkbenchAsset, WorkbenchAssetStatus } from '@open-design/contracts';
import { workbenchMediaUrl } from '@open-design/contracts';

import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Icon } from '../../ui/icons';
import { Textarea } from '../../ui/textarea';
import { useL } from '../lang';
import { coverFontRatio } from './cover';
import styles from './Studio.module.css';

export interface AutoTextProps {
  value: string;
  onCommit(next: string): void;
  className?: string;
  label: string;
  disabled?: boolean;
  placeholder?: string;
  /** Enter commits instead of adding a line (titles, cover words). */
  singleLine?: boolean;
  maxLength?: number;
  /** Allow committing an empty value. */
  allowEmpty?: boolean;
}

/** A textarea that sizes to its text and commits on blur when the value changed. */
export function AutoText({ value, onCommit, className, label, disabled, placeholder, singleLine, maxLength, allowEmpty }: AutoTextProps) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const commit = () => {
    const next = singleLine ? draft.replace(/\s*\n\s*/g, ' ').trim() : draft;
    if ((next.trim() || allowEmpty) && next !== value) onCommit(next);
    else if (!next.trim() && !allowEmpty) setDraft(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      setDraft(value);
      event.currentTarget.blur();
      event.preventDefault();
    } else if (singleLine && event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };
  return (
    <Textarea
      ref={ref}
      rows={1}
      variant="bare"
      aria-label={label}
      className={cn(styles.autoText, className)}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}

const BUSY: WorkbenchAssetStatus[] = ['pending', 'running'];

export interface PlateProps {
  asset: Pick<WorkbenchAsset, 'status' | 'src' | 'error'> | null | undefined;
  /** Storyboard sketches sit on paper; covers and figures on a soft wash. */
  paper?: boolean;
  /** Faint mark shown while there is no picture (the shot number). */
  mark?: string;
  alt: string;
  onOpen?: () => void;
  /** Offered when the asset failed, was skipped, or never ran. */
  onRetry?: () => void;
  className?: string;
}

/** One picture. Empty: only the ground and a faint mark; busy: a shimmer; failed: a redraw chip. */
export function Plate({ asset, paper = false, mark, alt, onOpen, onRetry, className }: PlateProps) {
  const L = useL();
  const status = asset?.status ?? 'idle';
  const url = workbenchMediaUrl(asset?.src ?? null);
  const clickable = Boolean(url && onOpen);
  const retry = onRetry && (status === 'failed' || status === 'skipped' || status === 'idle') && !url;
  return (
    <div
      className={cn(styles.plate, paper ? styles.plateNote : styles.plateWash, clickable && styles.plateClickable, className)}
      data-status={status}
      data-filled={url ? '' : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? L(`查看 ${alt}`, `View ${alt}`).trim() : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={clickable ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen?.(); } } : undefined}
    >
      {url ? <img key={url} src={url} alt={alt} draggable={false} /> : mark ? <span className={styles.plateMark} aria-hidden>{mark}</span> : null}
      {BUSY.includes(status) ? (
        <span className={styles.plateBadge} data-tone="busy">
          <i className={styles.plateDot} aria-hidden />
          {status === 'running' ? L('正在画', 'Drawing') : L('排队中', 'Queued')}
        </span>
      ) : retry ? (
        <Button
          variant="bare"
          size="sm"
          className={cn(styles.plateBadge, styles.plateAction)}
          data-tone={status === 'failed' ? 'failed' : 'idle'}
          title={asset?.error ?? undefined}
          onClick={(event) => { event.stopPropagation(); onRetry?.(); }}
        >
          <Icon icon={RefreshCw} size={11} />
          {status === 'failed' ? L('没画成，重画', 'Failed, redraw') : L('画这张', 'Draw this')}
        </Button>
      ) : status === 'failed' ? (
        <span className={styles.plateBadge} data-tone="failed" title={asset?.error ?? undefined}>{L('没画成', 'Failed')}</span>
      ) : null}
    </div>
  );
}

export interface PosterProps {
  src: string | null | undefined;
  text: string;
  status?: WorkbenchAssetStatus;
  error?: string | null | undefined;
  onOpen?: () => void;
  onRetry?: () => void;
  className?: string;
}

/**
 * The video cover as the sheet shows it: picture + bottom shade + big words, or a gradient type
 * cover. Sizes come from container units with cover.ts's ratios, so the preview matches the export.
 */
export function Poster({ src, text, status = 'idle', error, onOpen, onRetry, className }: PosterProps) {
  const L = useL();
  const url = workbenchMediaUrl(src ?? null);
  const words = text.trim();
  const style = { '--poster-size': `${(coverFontRatio(words) * 100).toFixed(3)}cqw` } as CSSProperties;
  const clickable = Boolean(url && onOpen);
  return (
    <div
      className={cn(styles.poster, !url && styles.posterType, clickable && styles.plateClickable, className)}
      data-status={status}
      style={style}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? L('查看视频封面', 'View the video cover') : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={clickable ? (event) => { if (event.key === 'Enter') onOpen?.(); } : undefined}
    >
      {url ? <img key={url} src={url} alt={L('视频封面', 'Video cover')} draggable={false} /> : null}
      {words ? <b className={styles.posterWords}>{words}</b> : null}
      {BUSY.includes(status) ? (
        <span className={styles.plateBadge} data-tone="busy">
          <i className={styles.plateDot} aria-hidden />
          {status === 'running' ? L('正在画封面', 'Drawing the cover') : L('排队中', 'Queued')}
        </span>
      ) : onRetry && (status === 'failed' || status === 'skipped') ? (
        <Button
          variant="bare"
          size="sm"
          className={cn(styles.plateBadge, styles.plateAction)}
          data-tone={status === 'failed' ? 'failed' : 'idle'}
          title={error ?? undefined}
          onClick={(event) => { event.stopPropagation(); onRetry(); }}
        >
          <Icon icon={RefreshCw} size={11} />
          {status === 'failed' ? L('封面没画成，重画', 'Cover failed, redraw') : L('画封面', 'Draw the cover')}
        </Button>
      ) : null}
    </div>
  );
}
