'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — the idea card shared by the grid, the canvas and the feed.
 * Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
 *   source: client/card.jsx — media with hover autoplay, quote/note/caption bodies, the status
 *   footer with production state. Library additions: link, PDF and audio cards, star, space tint,
 *   selection, drag to the rail.
 */
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { WorkbenchItem, WorkbenchSpace } from '@open-design/contracts';
import { workbenchMediaUrl } from '@open-design/contracts';
import { BookOpen, CalendarClock, Clock, Globe, Pause, Play, Sparkles, Star, TriangleAlert } from 'lucide-react';
import { Icon, IconButton } from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { displayItem, hash, kindLabel, relativeDay, seeded, statusLabel } from '../shared/format';
import { useActions } from './context';
import { ItemContextMenu } from './ItemMenu';
import { faviconOf, fmtDuration, hostOf, readMinutesOf } from './library';
import { SpaceDot } from './SpaceGlyph';
import styles from './ItemCard.module.css';

export type CardVariant = 'tile' | 'canvas' | 'feed';

export interface ItemCardProps {
  item: WorkbenchItem;
  variant?: CardVariant;
  selected?: boolean;
  /** The item's space, drawn as a tint dot (left out inside that space's own view). */
  space?: WorkbenchSpace | null;
  /** HTML drag toward the rail (grid and feed). The canvas moves cards with its own pointer drag. */
  draggable?: boolean;
  /** Pulled close by the related-ideas gathering. */
  related?: boolean;
  /** Fixed width (canvas). */
  width?: number;
}

/** Tall images are capped so one portrait photo never becomes a column. */
function ratioOf(item: WorkbenchItem): string {
  const media = item.media;
  if (media?.w && media.h) return `${media.w} / ${Math.min(media.h, media.w * 1.5)}`;
  if (item.kind === 'web') return '1.91 / 1';
  if (item.kind === 'video') return '16 / 9';
  return '4 / 3';
}

function VideoMedia({ src, poster, ratio, play, onError }: { src: string; poster: string | null; ratio: string; play: boolean; onError(): void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (play) video.play().catch(() => undefined);
    else {
      video.pause();
      try { video.currentTime = 0; } catch { /* not seekable yet */ }
    }
  }, [play]);
  return (
    <video
      ref={ref}
      className={styles.media}
      style={{ aspectRatio: ratio }}
      src={poster ? src : `${src}#t=0.1`}
      {...(poster ? { poster } : {})}
      muted
      loop
      playsInline
      preload="metadata"
      onError={onError}
    />
  );
}

function CardVisual({ item, hover }: { item: WorkbenchItem; hover: boolean }) {
  const [broken, setBroken] = useState(false);
  const media = item.media;
  const src = workbenchMediaUrl(media?.src);
  const poster = workbenchMediaUrl(media?.poster);
  const ratio = ratioOf(item);
  if (!media) return null;
  if (broken || (!src && !poster)) {
    return <div className={styles.fallback} style={{ aspectRatio: ratio }}><span>{item.title.slice(0, 1)}</span></div>;
  }
  if (item.kind === 'video' && src) return <VideoMedia src={src} poster={poster} ratio={ratio} play={hover} onError={() => setBroken(true)} />;
  const still = item.kind === 'pdf' ? poster : src;
  if (!still) return null;
  return <img className={styles.media} style={{ aspectRatio: ratio }} src={still} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

function Favicon({ url }: { url: string | null | undefined }) {
  const [broken, setBroken] = useState(false);
  const icon = faviconOf(url);
  if (!icon || broken) return <Icon icon={Globe} size={12} className={styles.faviconFallback} />;
  return <img className={styles.favicon} src={icon} alt="" width={14} height={14} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

function AudioStrip({ item }: { item: WorkbenchItem }) {
  const L = useL();
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const src = workbenchMediaUrl(item.media?.src);
  const bars = useMemo(() => {
    const rand = seeded(hash(item.id));
    return Array.from({ length: 30 }, (_, i) => 22 + Math.round((Math.sin(i * 0.7) * 0.5 + 0.5) * 40 + rand() * 38));
  }, [item.id]);
  const toggle = () => {
    const audio = ref.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => undefined);
    else audio.pause();
  };
  return (
    <div className={styles.audio}>
      <IconButton
        variant="primary"
        shape="round"
        size="md"
        className={styles.audioPlay}
        aria-label={playing ? L('暂停', 'Pause') : L('播放', 'Play')}
        tooltip={false}
        disabled={!src}
        onClick={(event) => { event.stopPropagation(); toggle(); }}
        onDoubleClick={event => event.stopPropagation()}
      >
        <Icon icon={playing ? Pause : Play} size={14} fill="currentColor" />
      </IconButton>
      <div className={styles.wave} aria-hidden>
        {bars.map((h, i) => <i key={i} style={{ height: `${h}%` }} data-on={i / bars.length < progress ? '' : undefined} />)}
      </div>
      <span className={styles.audioTime}>{fmtDuration(item.media?.durationSec) ?? '—'}</span>
      {src ? (
        <audio
          ref={ref}
          src={src}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setProgress(0); }}
          onTimeUpdate={(event) => { const a = event.currentTarget; if (a.duration) setProgress(a.currentTime / a.duration); }}
        />
      ) : null}
    </div>
  );
}

function ItemCardImpl({ item: raw, variant = 'tile', selected = false, space = null, draggable = false, related = false, width }: ItemCardProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  const actions = useActions();
  const item = displayItem(raw);
  const [hover, setHover] = useState(false);
  const production = raw.production;
  const running = production?.status === 'running';
  const produced = production?.status === 'done' && Boolean(production.title);
  const failed = production?.status === 'failed';
  const isWeb = raw.kind === 'web';
  const hasVisual = Boolean(item.media) && (['image', 'video', 'web'].includes(item.kind) || (item.kind === 'pdf' && Boolean(item.media?.poster)));
  const host = isWeb ? hostOf(raw.url) : null;
  const minutes = isWeb ? readMinutesOf(raw) : null;
  const excerpt = raw.kind === 'note' ? raw.body : raw.kind === 'web' ? raw.summary || raw.body : raw.summary ?? '';
  const progress = running ? (production?.stage === 'making' ? 0.68 : 0.32) : 1;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter') { event.preventDefault(); actions.open(raw.id); }
    else if (event.key === ' ') { event.preventDefault(); actions.select(raw.id, { metaKey: true, ctrlKey: false, shiftKey: false }); }
  };

  const right = running ? (
    <span className={styles.shimmer}>{production?.stage === 'making' ? L('配图中', 'Illustrating') : L('成稿中', 'Writing')}</span>
  ) : failed ? (
    <span className={styles.failed}><Icon icon={TriangleAlert} size={11} />{L('成稿失败', 'Failed')}</span>
  ) : raw.scheduledAt && raw.status !== 'published' ? (
    <span className={styles.metaIcon}><Icon icon={CalendarClock} size={11} />{relativeDay(raw.scheduledAt, lang)}</span>
  ) : produced ? (
    <span className={styles.metaIcon}><Icon icon={Sparkles} size={11} />{L('已成稿', 'Produced')}</span>
  ) : minutes ? (
    <span className={styles.metaIcon}><Icon icon={Clock} size={11} />{L(`${minutes} 分钟`, `${minutes} min`)}</span>
  ) : (
    <span>{relativeDay(raw.createdAt, lang)}</span>
  );

  const source = isWeb ? host ?? kindLabel('web', lang) : raw.source || kindLabel(raw.kind, lang);

  return (
    <ItemContextMenu item={raw} selected={selected}>
      <article
        className={styles.card}
        data-card={raw.id}
        data-variant={variant}
        data-kind={item.kind}
        data-selected={selected ? '' : undefined}
        data-related={related ? '' : undefined}
        data-running={running ? '' : undefined}
        style={width ? ({ width } as CSSProperties) : undefined}
        tabIndex={0}
        role="button"
        aria-pressed={selected}
        aria-label={`${kindLabel(raw.kind, lang)}：${item.title || L('无标题', 'Untitled')}`}
        draggable={draggable}
        onDragStart={draggable ? event => actions.dragStart(raw.id, event) : undefined}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onClick={event => actions.select(raw.id, event)}
        onDoubleClick={() => actions.open(raw.id)}
        onKeyDown={onKeyDown}
      >
        {running ? <span className={styles.progress} style={{ '--p': progress } as CSSProperties} aria-hidden /> : null}

        {hasVisual ? (
          <div className={styles.visual}>
            <CardVisual item={item} hover={hover} />
            {item.kind === 'video' ? (
              <span className={styles.badge}>
                <Icon icon={Play} size={10} fill="currentColor" />
                {fmtDuration(item.media?.durationSec) ?? ''}
              </span>
            ) : null}
            {item.kind === 'pdf' ? <span className={styles.badge}>PDF</span> : null}
          </div>
        ) : null}

        <div className={styles.body}>
          {isWeb ? (
            <div className={styles.site}>
              <Favicon url={raw.url} />
              <span>{raw.reader?.siteName || host || L('网页', 'Web')}</span>
            </div>
          ) : null}

          {item.kind === 'quote' ? (
            <>
              <blockquote className={styles.quote}>{item.title}</blockquote>
              {raw.source ? <p className={styles.quoteSource}>— {raw.source}</p> : null}
            </>
          ) : item.kind === 'pdf' && !hasVisual ? (
            <div className={styles.paper}>
              <span className={styles.paperBadge}>PDF</span>
              <p className={styles.paperTitle}>{item.title}</p>
              <span className={styles.paperLines} aria-hidden><i /><i /><i /><i /><i /></span>
            </div>
          ) : (
            <>
              {raw.rel ? <span className={styles.rel}>{raw.rel}</span> : null}
              <h3 className={styles.title} data-lines={item.kind === 'note' ? 3 : 2}>{item.title || L('无标题', 'Untitled')}</h3>
              {item.kind === 'audio' ? <AudioStrip item={raw} /> : null}
              {excerpt && (item.kind === 'note' || isWeb || variant === 'feed') ? (
                <p className={styles.excerpt} data-kind={raw.kind}>{excerpt}</p>
              ) : null}
            </>
          )}

          {variant === 'feed' && raw.tags.length ? (
            <div className={styles.tags}>{raw.tags.slice(0, 6).map(tag => <span key={tag}>#{tag}</span>)}</div>
          ) : null}
        </div>

        <footer className={styles.foot}>
          <span className={styles.dot} data-status={raw.status} title={statusLabel(raw.status, lang)} />
          {space ? <SpaceDot color={space.color} /> : null}
          <span className={styles.source}>
            {raw.status !== 'idea' ? <b>{statusLabel(raw.status, lang)} · </b> : null}
            {source}
          </span>
          <span className={styles.meta}>{right}</span>
        </footer>

        <div className={styles.actions} data-visible={raw.starred ? '' : undefined}>
          {isWeb && !raw.trashedAt ? (
            <IconButton
              variant="frosted"
              shape="round"
              size="sm"
              className={styles.action}
              aria-label={L('阅读', 'Read')}
              shortcut="r"
              onClick={(event) => { event.stopPropagation(); actions.openReader(raw.id); }}
              onDoubleClick={event => event.stopPropagation()}
            >
              <Icon icon={BookOpen} size={13} />
            </IconButton>
          ) : null}
          {!raw.trashedAt ? (
            <IconButton
              variant="frosted"
              shape="round"
              size="sm"
              className={styles.action}
              data-star={raw.starred ? '' : undefined}
              aria-label={raw.starred ? L('取消星标', 'Unstar') : L('加星标', 'Star')}
              shortcut="s"
              on={Boolean(raw.starred)}
              onClick={(event) => { event.stopPropagation(); actions.star([raw.id], !raw.starred); }}
              onDoubleClick={event => event.stopPropagation()}
            >
              <Icon icon={Star} size={13} fill={raw.starred ? 'currentColor' : 'none'} />
            </IconButton>
          ) : null}
        </div>
      </article>
    </ItemContextMenu>
  );
}

export const ItemCard = memo(ItemCardImpl);

/** Height estimate for masonry column balancing. */
export function estimateCardHeight(raw: WorkbenchItem, width: number): number {
  const item = displayItem(raw);
  let h = 44; // footer
  const hasVisual = Boolean(item.media) && (['image', 'video', 'web'].includes(item.kind) || (item.kind === 'pdf' && Boolean(item.media?.poster)));
  if (hasVisual) {
    const m = item.media!;
    const ratio = m.w && m.h ? Math.min(m.h / m.w, 1.5) : item.kind === 'web' ? 0.52 : item.kind === 'video' ? 0.5625 : 0.75;
    h += width * ratio + 8;
  }
  const charsPerLine = Math.max(8, Math.floor(width / 13));
  const lines = (text: string, max: number) => Math.min(max, Math.ceil(text.length / charsPerLine));
  switch (item.kind) {
    case 'quote': return h + 36 + lines(item.title, 6) * 26;
    case 'note': return h + 30 + lines(item.title, 3) * 21 + (raw.body ? lines(raw.body, 7) * 20 + 8 : 0);
    case 'web': return h + 52 + lines(item.title, 2) * 19 + ((raw.summary || raw.body) ? lines(raw.summary || raw.body, 4) * 19 : 0);
    case 'audio': return h + 92;
    case 'pdf': return hasVisual ? h + 44 : h + width * 1.05;
    default: return h + 22 + lines(item.title, 2) * 19;
  }
}
