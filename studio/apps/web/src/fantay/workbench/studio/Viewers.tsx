/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 studio — the dialogs on top of the sheet: the image viewer (←/→ through cover, figures
 * and shots; redraw, download, hand to the assistant), the full-size reader with figures placed back
 * under their sections, and the 重新成稿 confirmation with this run's image switch.
 * Derived from dsh-media-desk client/studio.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, MessageSquareText, RefreshCw } from 'lucide-react';
import type { WorkbenchAsset, WorkbenchAssetTarget, WorkbenchItem, WorkbenchProduction } from '@open-design/contracts';
import { workbenchMediaUrl } from '@open-design/contracts';

import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Modal, ModalActions, ModalLede, ModalTitle } from '../../ui/dialog';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import { Switch } from '../../ui/switch';
import type { ChatQuote } from '../assistant/ChatThread';
import { useL } from '../lang';
import { useWorkbenchShell } from '../shell/context';
import { renderMarkdown } from '../shared/format';
import { Plate } from './parts';
import { isBusy, regenAsset } from './production';
import styles from './Studio.module.css';

type Copy = (zh: string, en: string) => string;

interface AssetRow {
  target: WorkbenchAssetTarget;
  asset: WorkbenchAsset;
  label: string;
  note?: string;
  paper?: boolean;
}

function assetRows(production: WorkbenchProduction | undefined, L: Copy): AssetRow[] {
  if (!production) return [];
  return [
    ...(production.cover ? [{ target: 'cover' as const, asset: production.cover, label: L('视频封面', 'Video cover'), ...(production.coverText ? { note: production.coverText } : {}) }] : []),
    ...production.images.map((asset, index) => ({ target: `image:${index}` as const, asset, label: L(`配图 ${index + 1}`, `Figure ${index + 1}`), note: asset.caption })),
    ...production.shots.map((asset, index) => ({
      target: `shot:${index}` as const,
      asset,
      label: L(`第 ${index + 1} 镜`, `Shot ${index + 1}`),
      note: [asset.visual, asset.voice].filter(Boolean).join(' · '),
      paper: true,
    })),
  ];
}

export interface AssetViewerProps {
  item: WorkbenchItem | null;
  target: WorkbenchAssetTarget | null;
  onChange(target: WorkbenchAssetTarget): void;
  onClose(): void;
  onAsk(quote: ChatQuote): void;
}

export function AssetViewer({ item, target, onChange, onClose, onAsk }: AssetViewerProps) {
  const L = useL();
  const shell = useWorkbenchShell();
  const imageReady = Boolean(shell.settings?.imageReady);
  const lastTarget = useRef(target);
  if (target) lastTarget.current = target;
  const shown = target ?? lastTarget.current;
  const list = useMemo(() => assetRows(item?.production, L).filter(row => row.asset.src || isBusy(row.asset)), [item?.production, L]);
  const index = Math.max(0, list.findIndex(row => row.target === shown));
  const current = list[index];
  const previous = list[index - 1];
  const next = list[index + 1];
  const open = Boolean(target && current);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight' && next) onChange(next.target);
      if (event.key === 'ArrowLeft' && previous) onChange(previous.target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, next, previous, onChange]);

  const url = workbenchMediaUrl(current?.asset.src ?? null);
  return (
    <Modal open={open} onClose={onClose} size="2xl" className={styles.viewer} aria-describedby={undefined}>
      {current && item ? (
        <>
          <ModalTitle className={styles.viewerTitle}>{current.label}</ModalTitle>
          <div className={cn(styles.viewerImage, current.paper && styles.viewerPaper)}>
            {url ? <img key={url} src={url} alt={current.label} /> : null}
            {isBusy(current.asset) ? <span className={cn(styles.viewerBusy, styles.shimmer)}>{L('正在重画…', 'Redrawing…')}</span> : null}
          </div>
          <footer className={styles.viewerFoot}>
            <p className={styles.viewerNote}>{current.note || ' '}</p>
            <span className={styles.viewerCount}>{index + 1} / {list.length}</span>
            <IconButton aria-label={L('上一张', 'Previous')} shortcut="left" disabled={!previous} onClick={() => previous && onChange(previous.target)}>
              <Icon icon={ChevronLeft} />
            </IconButton>
            <IconButton aria-label={L('下一张', 'Next')} shortcut="right" disabled={!next} onClick={() => next && onChange(next.target)}>
              <Icon icon={ChevronRight} />
            </IconButton>
            <Button variant="secondary" size="sm" onClick={() => { onAsk({ label: current.label }); onClose(); }}>
              <Icon icon={MessageSquareText} size={13} />
              {L('让助手改', 'Ask the assistant')}
            </Button>
            {imageReady ? (
              <Button variant="secondary" size="sm" disabled={isBusy(current.asset)} onClick={() => { void regenAsset(item.id, current.target, L); }}>
                <Icon icon={RefreshCw} size={13} />
                {L('重画', 'Redraw')}
              </Button>
            ) : null}
            {url ? (
              <Button variant="secondary" size="sm" asChild>
                <a href={url} download>
                  <Icon icon={Download} size={13} />
                  {L('下载', 'Download')}
                </a>
              </Button>
            ) : null}
          </footer>
        </>
      ) : null}
    </Modal>
  );
}

/** The article with its figures placed back: under the section their anchor names, else spread evenly. */
function ArticleBody({ production, text, proseClass }: { production: WorkbenchProduction | undefined; text: string; proseClass: string }) {
  const sections = useMemo(() => text.split(/\n(?=##\s)/).map(part => ({ text: part, heading: /^##\s+(.+)/.exec(part)?.[1]?.trim() ?? '' })), [text]);
  const images = useMemo(() => production?.images ?? [], [production?.images]);
  const placed = useMemo(() => {
    const map = new Map<number, Array<{ index: number; src: string; caption: string }>>();
    images.forEach((image, index) => {
      if (!image.src) return;
      let at = sections.findIndex(section => image.anchor && section.heading === image.anchor);
      if (at < 0) at = Math.min(sections.length - 1, Math.round(((index + 1) * sections.length) / (images.length + 1)));
      const list = map.get(at) ?? [];
      list.push({ index, src: image.src, caption: image.caption });
      map.set(at, list);
    });
    return map;
  }, [images, sections]);
  return (
    <div className={styles.readerBody}>
      {sections.map((section, at) => (
        <Fragment key={at}>
          <div className={proseClass} dangerouslySetInnerHTML={{ __html: renderMarkdown(section.text) }} />
          {(placed.get(at) ?? []).map(figure => (
            <figure key={figure.index} className={styles.readerFigure}>
              <Plate asset={{ status: 'done', src: figure.src }} alt={figure.caption} className={styles.figurePlate} />
              {figure.caption ? <figcaption>{figure.caption}</figcaption> : null}
            </figure>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

export function FocusReader({ item, open, onClose }: { item: WorkbenchItem | null; open: boolean; onClose(): void }) {
  const L = useL();
  const production = item?.production;
  const isArticle = production?.format === 'article';
  return (
    <Modal open={open && Boolean(production?.article)} onClose={onClose} size="xl" className={styles.reader} aria-describedby={undefined}>
      <ModalTitle className={styles.readerEyebrow}>{isArticle ? L('文章', 'Article') : L('脚本', 'Script')}</ModalTitle>
      {production ? (
        <>
          <h1 className={styles.readerTitle}>{production.title}</h1>
          <ArticleBody
            production={production}
            text={production.article}
            proseClass={cn(styles.prose, styles.proseLarge, isArticle ? styles.proseArticle : styles.proseScript)}
          />
        </>
      ) : null}
    </Modal>
  );
}

export function AgainDialog({ item, open, onClose }: { item: WorkbenchItem | null; open: boolean; onClose(): void }) {
  const L = useL();
  const shell = useWorkbenchShell();
  const [withImages, setWithImages] = useState(true);
  useEffect(() => {
    if (open) setWithImages(item?.production?.withImages ?? shell.settings?.generateImages ?? true);
  }, [open, item?.production?.withImages, shell.settings?.generateImages]);
  return (
    <Modal open={open} onClose={onClose} size="sm">
      <ModalTitle>{L('重新成稿', 'Produce again')}</ModalTitle>
      <ModalLede>{L('现在的标题、文章、封面和分镜会被替换，也会再用一次 TokenToSea 额度。', 'The current title, text, cover and storyboard are replaced, and TokenToSea credits are used again.')}</ModalLede>
      <label className={styles.againOption}>
        <span>
          <b>{L('同时生成图片', 'Also draw images')}</b>
          <small>{L('封面、配图和分镜图', 'Cover, figures and storyboard')}</small>
        </span>
        <Switch checked={withImages} onCheckedChange={setWithImages} />
      </label>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>{L('取消', 'Cancel')}</Button>
        <Button
          variant="primary"
          onClick={() => {
            if (item) shell.produce(item.id, withImages);
            onClose();
          }}
        >
          {L('重新生成', 'Regenerate')}
        </Button>
      </ModalActions>
    </Modal>
  );
}
