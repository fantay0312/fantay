/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 studio — the production sheet. Every slot is laid out before the run starts and fills in
 * as the daemon writes and draws: hero (title, numbers, cover collage, actions), the publish strip
 * (status, platform, schedule), script/article beside the storyboard, the video cover and figures,
 * then the facts and outline the writer worked from.
 * Derived from dsh-media-desk client/studio.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import {
  CalendarClock,
  Check,
  Clock,
  Copy,
  Download,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Maximize2,
  MessageSquareText,
  PenLine,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import type { WorkbenchAssetTarget, WorkbenchItem, WorkbenchProduction, WorkbenchProductionLive, WorkbenchStatus } from '@open-design/contracts';
import { WORKBENCH_STATUSES } from '@open-design/contracts';

import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { Icon } from '../../ui/icons';
import { Input } from '../../ui/input';
import { Segmented, SegmentedItem } from '../../ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { Textarea } from '../../ui/textarea';
import { toast } from '../../ui/toast';
import type { ChatQuote } from '../assistant/ChatThread';
import { useL, useWorkbenchLang } from '../lang';
import { useWorkbenchShell } from '../shell/context';
import { fmtWhen, platformChoices, platformName, renderMarkdown, statusLabel, textLength, toLocalInput } from '../shared/format';
import { useWorkbench, workbench } from '../store';
import { copyCover, coverFileName, downloadCover } from './cover';
import { AutoText, Plate, Poster } from './parts';
import { isBusy, regenAsset, revealProduction, saveProduction, unescapeJson } from './production';
import styles from './Studio.module.css';

const NO_PLATFORM = '__none__';

export interface SheetProps {
  item: WorkbenchItem;
  live: WorkbenchProductionLive | null;
  onAsk(quote: ChatQuote): void;
  onView(target: WorkbenchAssetTarget): void;
  onRead(): void;
  onAgain(): void;
}

export function Sheet({ item, live, onAsk, onView, onRead, onAgain }: SheetProps) {
  const shell = useWorkbenchShell();
  const production = item.production;
  const settings = shell.settings;
  // Before a run the storyboard shows the planned cells; after one, only what was made.
  const shotCount = production
    ? production.shots.length || (production.status === 'running' ? settings?.shotCount ?? 6 : 0)
    : settings?.shotCount ?? 6;
  const showShots = shotCount > 0 || Boolean(live?.visuals?.length);
  return (
    <div className={styles.sheetInner}>
      <Hero item={item} live={live} onView={onView} onAgain={onAgain} />
      <MetaStrip item={item} />
      <div className={cn(styles.bento, !showShots && styles.bentoSingle)}>
        <ScriptTile item={item} live={live} onAsk={onAsk} onRead={onRead} />
        {showShots ? <ShotsTile item={item} live={live} count={shotCount} onView={onView} /> : null}
      </div>
      <div className={styles.mediaRow}>
        <CoverTile item={item} onView={onView} />
        <FiguresTile item={item} onView={onView} />
      </div>
      <NotesTile production={production} />
    </div>
  );
}

// ── hero ──────────────────────────────────────────────────────────────

function Stat({ icon, value, unit }: { icon: typeof Clock; value: number; unit: string }) {
  return (
    <span className={styles.stat}>
      <Icon icon={icon} size={13} />
      <b>{value}</b>
      {unit}
    </span>
  );
}

function Hero({ item, live, onView, onAgain }: { item: WorkbenchItem; live: WorkbenchProductionLive | null; onView(target: WorkbenchAssetTarget): void; onAgain(): void }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const shell = useWorkbenchShell();
  const snapshot = useWorkbench();
  const settings = shell.settings;
  const production = item.production;
  const running = production?.status === 'running';
  const done = production?.status === 'done';
  const stage = live?.stage ?? production?.stage;
  const liveTitle = stage === 'brief' && live?.title ? unescapeJson(live.title) : null;
  const title = liveTitle ?? production?.title ?? item.title;
  const words = textLength(production?.article || live?.text || '', lang);
  const shots = production?.shots ?? [];
  const seconds = shots.reduce((sum, shot) => sum + (shot.seconds ?? 0), 0);
  const images = production?.images ?? [];
  const pictures = [production?.cover, ...images].filter(asset => asset?.src).length;
  const imageReady = Boolean(settings?.imageReady);
  const showFigures = (imageReady && production?.withImages !== false) || images.some(asset => asset.src);
  const figures = images.length ? images : !production || running ? Array.from({ length: Math.min(2, settings?.imageCount ?? 2) }, () => null) : [];
  const isArticle = (production?.format ?? snapshot.state?.draftFormat) === 'article';
  const [saving, setSaving] = useState(false);
  const coverText = stage === 'brief' ? '' : production?.coverText || production?.title || '';

  const drawn = [production?.cover, ...images, ...shots].filter(Boolean);
  const eyebrow = !production
    ? L('还没成稿', 'Not produced yet')
    : running
      ? stage === 'brief'
        ? L('正在构思标题和封面字', 'Planning the title and cover words')
        : !production.article
          ? L(`正在写${isArticle ? '文章' : '脚本'} · ${words} 字`, `Writing the ${isArticle ? 'article' : 'script'} · ${words} words`)
          : L(`正在画图 ${drawn.filter(asset => asset?.src).length}/${drawn.length}`, `Drawing ${drawn.filter(asset => asset?.src).length}/${drawn.length}`)
      : production.status === 'failed'
        ? L('上次没成稿', 'The last run failed')
        : production.status === 'cancelled'
          ? L('已取消', 'Cancelled')
          : [
              L(`成稿于 ${fmtWhen(production.finishedAt ?? production.startedAt, lang)}`, `Produced ${fmtWhen(production.finishedAt ?? production.startedAt, lang)}`),
              production.savedAt ? L('已保存', 'Saved') : '',
            ].filter(Boolean).join(' · ');

  const copy = async () => {
    if (!production) return;
    try {
      await navigator.clipboard.writeText(`# ${production.title}\n\n${production.article}`);
      toast({ title: isArticle ? L('文章已复制', 'Article copied') : L('脚本已复制', 'Script copied'), tone: 'success' });
    } catch {
      toast({ title: L('复制失败', 'Copy failed'), tone: 'danger' });
    }
  };
  const save = async () => {
    if (!production) return;
    setSaving(true);
    await saveProduction(item.id, production, L);
    setSaving(false);
  };
  const remove = () => {
    void workbench.ops([{ op: 'trash_items', ids: [item.id] }], { label: L(`删除《${item.title.slice(0, 12)}》`, `Delete “${item.title.slice(0, 20)}”`) });
    shell.closeItem();
  };

  return (
    <section className={styles.hero} data-running={running ? '' : undefined}>
      <div className={styles.heroCopy}>
        <span className={cn(styles.heroEyebrow, running && styles.shimmer)}>{eyebrow}</span>
        <AutoText
          className={cn(styles.heroTitle, !production && styles.heroTitleIdle)}
          label={L('标题', 'Title')}
          value={title}
          disabled={!done}
          singleLine
          onCommit={next => { void workbench.ops([{ op: 'update_production', id: item.id, title: next }], { label: L('修改标题', 'Edit title'), quiet: true }); }}
        />
        <div className={styles.stats}>
          {words ? <Stat icon={PenLine} value={words} unit={L('字', ' words')} /> : null}
          {shots.length ? <Stat icon={Film} value={shots.length} unit={L('镜', ' shots')} /> : null}
          {seconds ? <Stat icon={Clock} value={seconds} unit={L('秒', 's')} /> : null}
          {pictures ? <Stat icon={ImageIcon} value={pictures} unit={L('张图', ' images')} /> : null}
        </div>
        {done && production ? (
          <div className={styles.heroActions}>
            <Button variant="primary" onClick={() => { void copy(); }}>
              <Icon icon={Copy} size={14} />
              {isArticle ? L('复制文章', 'Copy article') : L('复制脚本', 'Copy script')}
            </Button>
            <Button variant="secondary" loading={saving} onClick={() => { void save(); }}>
              <Icon icon={Save} size={14} />
              {L('保存到文件夹', 'Save to folder')}
            </Button>
            {production.savedPath ? (
              <Button variant="secondary" onClick={() => { void revealProduction(item.id, L); }}>
                <Icon icon={FolderOpen} size={14} />
                {L('在访达中显示', 'Show in Finder')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                downloadCover({ src: production.cover?.src, text: coverText }, coverFileName(production.title, L('视频封面', 'cover')))
                  .catch(() => toast({ title: L('封面导出失败', 'Could not export the cover'), tone: 'danger' }));
              }}
            >
              <Icon icon={Download} size={14} />
              {L('下载封面', 'Download cover')}
            </Button>
          </div>
        ) : null}
      </div>
      <div className={styles.collage}>
        <div className={styles.collageMain}>
          <Poster
            src={production?.cover?.src ?? (!production ? item.media?.poster ?? (item.media?.src && item.kind === 'image' ? item.media.src : null) : null)}
            text={coverText}
            status={production?.cover?.status ?? 'idle'}
            error={production?.cover?.error}
            onOpen={() => onView('cover')}
            {...(imageReady && done && production?.cover ? { onRetry: () => { void regenAsset(item.id, 'cover', L); } } : {})}
          />
        </div>
        {showFigures
          ? figures.slice(0, 2).map((image, index) => (
              <div key={index} className={cn(styles.collageSide, index === 0 ? styles.collageSideA : styles.collageSideB)}>
                <Plate
                  asset={image}
                  alt={image?.caption || L(`配图 ${index + 1}`, `Figure ${index + 1}`)}
                  onOpen={() => onView(`image:${index}`)}
                />
              </div>
            ))
          : null}
      </div>
      <div className={styles.heroCorner}>
        {production && !running ? (
          <IconButton size="sm" aria-label={L('重新成稿', 'Produce again')} onClick={onAgain}>
            <Icon icon={RefreshCw} />
          </IconButton>
        ) : null}
        <IconButton size="sm" aria-label={L('工作台设置', 'Workbench settings')} onClick={shell.openSettings}>
          <Icon icon={Settings2} />
        </IconButton>
        <IconButton size="sm" variant="danger" aria-label={L('删除这条灵感', 'Delete this idea')} onClick={remove}>
          <Icon icon={Trash2} />
        </IconButton>
      </div>
    </section>
  );
}

// ── publish strip ─────────────────────────────────────────────────────

function MetaStrip({ item }: { item: WorkbenchItem }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const quiet = { quiet: true } as const;
  return (
    <section className={cn(styles.tile, styles.metaStrip)} aria-label={L('发布', 'Publishing')}>
      <div className={cn(styles.metaGroup, styles.metaGrow)}>
        <span className={styles.metaLabel}>{L('状态', 'Status')}</span>
        <Segmented
          size="sm"
          aria-label={L('状态', 'Status')}
          className={styles.fullSegmented}
          value={item.status}
          onValueChange={(status) => {
            void workbench.ops([{ op: 'set_status', id: item.id, status: status as WorkbenchStatus }], { label: L('修改状态', 'Change status'), ...quiet });
          }}
        >
          {WORKBENCH_STATUSES.map(status => <SegmentedItem key={status} value={status}>{statusLabel(status, lang)}</SegmentedItem>)}
        </Segmented>
      </div>
      <div className={styles.metaGroup}>
        <span className={styles.metaLabel}>{L('平台', 'Platform')}</span>
        <Select
          value={item.platform ?? NO_PLATFORM}
          onValueChange={(next) => {
            const platform = next === NO_PLATFORM ? null : next;
            void workbench.ops([{ op: 'update_item', id: item.id, platform }], { label: L('修改平台', 'Change platform'), ...quiet });
          }}
        >
          <SelectTrigger size="sm" className={styles.platformTrigger} aria-label={L('平台', 'Platform')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PLATFORM}>{L('未选择', 'None')}</SelectItem>
            {platformChoices(lang).map(platform => <SelectItem key={platform} value={platform}>{platformName(platform, lang)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className={styles.metaGroup}>
        <span className={styles.metaLabel}>{L('排期', 'Schedule')}</span>
        <label className={styles.datePill} data-empty={item.scheduledAt ? undefined : ''}>
          <Icon icon={CalendarClock} size={14} />
          <span>{item.scheduledAt ? fmtWhen(item.scheduledAt, lang) : L('选时间', 'Pick a time')}</span>
          <Input
            type="datetime-local"
            variant="bare"
            inputSize="auto"
            className={styles.dateInput}
            aria-label={L('排期', 'Schedule')}
            value={toLocalInput(item.scheduledAt)}
            onClick={(event) => {
              try {
                event.currentTarget.showPicker();
              } catch {
                // Older engines open their own picker on click.
              }
            }}
            onChange={(event) => {
              const scheduledAt = event.target.value ? new Date(event.target.value).toISOString() : null;
              void workbench.ops([{ op: 'schedule_item', id: item.id, scheduledAt }], { label: L('修改排期', 'Reschedule'), ...quiet });
            }}
          />
        </label>
        {item.scheduledAt ? (
          <IconButton
            size="xs"
            aria-label={L('取消排期', 'Unschedule')}
            onClick={() => { void workbench.ops([{ op: 'schedule_item', id: item.id, scheduledAt: null }], { label: L('取消排期', 'Unschedule'), ...quiet }); }}
          >
            <Icon icon={X} />
          </IconButton>
        ) : null}
      </div>
    </section>
  );
}

// ── script / article ──────────────────────────────────────────────────

function ScriptTile({ item, live, onAsk, onRead }: { item: WorkbenchItem; live: WorkbenchProductionLive | null; onAsk(quote: ChatQuote): void; onRead(): void }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const snapshot = useWorkbench();
  const production = item.production;
  const running = production?.status === 'running';
  const article = production?.article ?? '';
  const aiArticle = production?.aiArticle ?? '';
  const text = article || (live?.text ?? '').replace(/^\s*#\s+.*\n?/, '');
  const streaming = running && !article;
  const isArticle = (production?.format ?? snapshot.state?.draftFormat) === 'article';
  const name = isArticle ? L('文章', 'Article') : L('脚本', 'Script');
  const edited = Boolean(aiArticle && article && aiArticle !== article);
  const [editing, setEditing] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [draft, setDraft] = useState(article);
  const [picked, setPicked] = useState<{ text: string; x: number; y: number } | null>(null);
  const tileRef = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(article), [article]);
  useEffect(() => {
    setEditing(false);
    setComparing(false);
  }, [item.id]);
  useEffect(() => {
    if (!edited) setComparing(false);
  }, [edited]);
  // Follow the pen while it writes; once finished, start reading from the top.
  useEffect(() => {
    if (streaming && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [text, streaming]);
  const hasArticle = Boolean(article);
  useEffect(() => {
    if (hasArticle && scroller.current) scroller.current.scrollTop = 0;
  }, [hasArticle]);

  const save = () => {
    if (draft !== article) void workbench.ops([{ op: 'update_production', id: item.id, article: draft }], { label: L(`修改${name}`, `Edit ${name.toLowerCase()}`), quiet: true });
    setEditing(false);
  };
  const restore = () => {
    void workbench.ops([{ op: 'update_production', id: item.id, article: aiArticle }], { label: L('恢复 AI 原稿', 'Restore the AI draft') });
    setComparing(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`# ${production?.title || item.title}\n\n${article}`);
      toast({ title: isArticle ? L('文章已复制', 'Article copied') : L('脚本已复制', 'Script copied'), tone: 'success' });
    } catch {
      toast({ title: L('复制失败', 'Copy failed'), tone: 'danger' });
    }
  };
  // Select a passage, hand it to the assistant.
  const onMouseUp = (event: ReactMouseEvent) => {
    if (comparing) return;
    const selection = window.getSelection();
    const value = selection?.toString().trim() ?? '';
    if (!selection || value.length < 4 || !article || !scroller.current?.contains(selection.anchorNode) || !tileRef.current) {
      setPicked(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const box = tileRef.current.getBoundingClientRect();
    event.stopPropagation();
    setPicked({ text: value, x: Math.max(80, Math.min(rect.left - box.left + rect.width / 2, box.width - 80)), y: rect.top - box.top });
  };

  const words = textLength(comparing ? aiArticle : text, lang);
  const prose = cn(styles.prose, isArticle ? styles.proseArticle : styles.proseScript);
  return (
    <section ref={tileRef} className={cn(styles.tile, styles.textTile)} aria-label={name}>
      <header className={styles.tileHead}>
        <h2 className={styles.tileTitle}>{name}</h2>
        {words ? <span className={styles.tileMeta}>{L(`${words} 字`, `${words} words`)}</span> : null}
        {edited && !comparing ? <span className={styles.tileTag}>{L('已改动', 'Edited')}</span> : null}
        <span className={styles.grow} />
        {article ? (
          <>
            {edited ? (
              <Button variant="bare" size="sm" className={cn(styles.compareToggle, comparing && styles.compareOn)} aria-pressed={comparing} onClick={() => { setEditing(false); setComparing(value => !value); }}>
                <Icon icon={RotateCcw} size={13} />
                {L('AI 原稿', 'AI draft')}
              </Button>
            ) : null}
            {editing ? (
              <Button size="sm" variant="primary" onClick={save}>
                <Icon icon={Check} size={13} />
                {L('完成', 'Done')}
              </Button>
            ) : (
              <IconButton size="sm" aria-label={L('直接修改', 'Edit directly')} disabled={comparing} onClick={() => setEditing(true)}>
                <Icon icon={SquarePen} />
              </IconButton>
            )}
            <IconButton size="sm" aria-label={isArticle ? L('复制文章', 'Copy article') : L('复制脚本', 'Copy script')} onClick={() => { void copy(); }}>
              <Icon icon={Copy} />
            </IconButton>
            <IconButton size="sm" aria-label={L('放大阅读', 'Read full size')} onClick={onRead}>
              <Icon icon={Maximize2} />
            </IconButton>
          </>
        ) : null}
      </header>
      {comparing ? (
        <>
          <div className={styles.compareBar}>
            <span>{L('这是 AI 写的原稿，你的修改不会丢，直到你选择恢复。', 'This is the AI’s original. Your edits stay until you restore.')}</span>
            <Button size="sm" variant="primary" onClick={restore}>{L('恢复为 AI 原稿', 'Restore AI draft')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setComparing(false)}>{L('回到我的版本', 'Back to mine')}</Button>
          </div>
          <div className={styles.textScroll}>
            <div className={prose} dangerouslySetInnerHTML={{ __html: renderMarkdown(aiArticle) }} />
          </div>
        </>
      ) : editing ? (
        <Textarea
          variant="bare"
          className={styles.textEdit}
          aria-label={name}
          value={draft}
          autoFocus
          onChange={event => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(article);
              setEditing(false);
            }
          }}
        />
      ) : text ? (
        <div className={styles.textScroll} ref={scroller} onMouseUp={onMouseUp} onScroll={() => setPicked(null)}>
          <h1 className={styles.textTitle}>{production?.title || item.title}</h1>
          {/* renderMarkdown escapes first: model output HTML never runs. */}
          <div className={cn(prose, streaming && styles.proseStreaming)} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        </div>
      ) : (
        <div className={cn(styles.skeleton, !running && styles.skeletonStill)} aria-hidden>
          {Array.from({ length: 12 }, (_, index) => <i key={index} />)}
        </div>
      )}
      {picked ? (
        <Button
          variant="primary"
          size="sm"
          className={styles.pick}
          style={{ left: picked.x, top: picked.y } as CSSProperties}
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            onAsk({ label: L('这段', 'this passage'), text: picked.text });
            setPicked(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          <Icon icon={MessageSquareText} size={12} />
          {L('让助手改这段', 'Ask the assistant')}
        </Button>
      ) : null}
      {streaming && words ? <span className={styles.tileFoot}>{L(`${words} 字`, `${words} words`)}</span> : null}
    </section>
  );
}

// ── storyboard ────────────────────────────────────────────────────────

function ShotsTile({ item, live, count, onView }: { item: WorkbenchItem; live: WorkbenchProductionLive | null; count: number; onView(target: WorkbenchAssetTarget): void }) {
  const L = useL();
  const shell = useWorkbenchShell();
  const production = item.production;
  const shots = production?.shots ?? [];
  const visuals = live?.visuals ?? [];
  const running = production?.status === 'running';
  const imageReady = Boolean(shell.settings?.imageReady);
  // While the plan is still being written, shot descriptions appear cell by cell.
  const cells = shots.length
    ? shots
    : Array.from({ length: Math.max(count, visuals.length) }, (_, index) => ({
        no: index + 1,
        shot: '',
        visual: visuals[index] ? unescapeJson(visuals[index]!) : '',
        voice: '',
        seconds: 0,
        prompt: undefined as string | undefined,
        status: running ? ('pending' as const) : ('idle' as const),
        src: undefined as string | undefined,
        error: null,
      }));
  const total = shots.reduce((sum, shot) => sum + (shot.seconds ?? 0), 0);
  const copy = async () => {
    const table = shots
      .map((shot, index) => L(
        `${index + 1}. ${shot.shot}｜${shot.seconds} 秒\n画面：${shot.visual}\n口播：${shot.voice}`,
        `${index + 1}. ${shot.shot} | ${shot.seconds}s\nVisual: ${shot.visual}\nVoice: ${shot.voice}`,
      ))
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(table);
      toast({ title: L('分镜脚本已复制', 'Storyboard copied'), tone: 'success' });
    } catch {
      toast({ title: L('复制失败', 'Copy failed'), tone: 'danger' });
    }
  };
  return (
    <section className={cn(styles.tile, styles.shotsTile)} aria-label={L('分镜头脚本', 'Storyboard')}>
      <header className={styles.tileHead}>
        <h2 className={styles.tileTitle}>{L('分镜头脚本', 'Storyboard')}</h2>
        {total ? <span className={styles.tileMeta}>{L(`约 ${total} 秒`, `about ${total}s`)}</span> : null}
        <span className={styles.grow} />
        {shots.length ? (
          <IconButton size="sm" aria-label={L('复制分镜脚本', 'Copy storyboard')} onClick={() => { void copy(); }}>
            <Icon icon={Copy} />
          </IconButton>
        ) : null}
      </header>
      <div className={styles.shots}>
        {cells.map((shot, index) => {
          const no = String(shot.no ?? index + 1).padStart(2, '0');
          const canRetry = imageReady && production?.status === 'done' && shot.prompt !== undefined;
          return (
            <figure key={index} className={styles.shot}>
              <Plate
                asset={shot}
                paper
                alt={shot.visual || L(`第 ${index + 1} 镜`, `Shot ${index + 1}`)}
                mark={no}
                className={styles.shotPlate}
                onOpen={() => onView(`shot:${index}`)}
                {...(canRetry ? { onRetry: () => { void regenAsset(item.id, `shot:${index}`, L); } } : {})}
              />
              <figcaption className={styles.shotCaption}>
                <span className={styles.shotMeta}>
                  <b>{no}</b>
                  {shot.shot ? ` ${shot.shot} · ${L(`${shot.seconds} 秒`, `${shot.seconds}s`)}` : ''}
                </span>
                {shot.voice ? <p className={styles.shotVoice}>{shot.voice}</p> : null}
                {shot.visual ? <p className={styles.shotVisual}>{shot.visual}</p> : null}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </section>
  );
}

// ── video cover ───────────────────────────────────────────────────────

function CoverTile({ item, onView }: { item: WorkbenchItem; onView(target: WorkbenchAssetTarget): void }) {
  const L = useL();
  const shell = useWorkbenchShell();
  const production = item.production;
  const done = production?.status === 'done';
  const text = production?.stage === 'brief' ? '' : production?.coverText || production?.title || '';
  const imageReady = Boolean(shell.settings?.imageReady);
  const [busy, setBusy] = useState<'copy' | 'download' | null>(null);
  const source = { src: production?.cover?.src, text };
  const run = async (kind: 'copy' | 'download') => {
    setBusy(kind);
    try {
      if (kind === 'copy') {
        await copyCover(source);
        toast({ title: L('封面已复制，可以直接粘贴', 'Cover copied to the clipboard'), tone: 'success' });
      } else {
        await downloadCover(source, coverFileName(production?.title || item.title, L('视频封面', 'cover')));
      }
    } catch {
      toast({ title: kind === 'copy' ? L('复制封面失败', 'Could not copy the cover') : L('封面导出失败', 'Could not export the cover'), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className={cn(styles.tile, styles.coverTile)} aria-label={L('视频封面', 'Video cover')}>
      <header className={styles.tileHead}>
        <h2 className={styles.tileTitle}>{L('视频封面', 'Video cover')}</h2>
        <span className={styles.tileMeta}>16:9</span>
        <span className={styles.grow} />
        {done ? (
          <>
            <IconButton size="sm" aria-label={L('复制封面图片', 'Copy cover image')} disabled={busy !== null} onClick={() => { void run('copy'); }}>
              <Icon icon={Copy} />
            </IconButton>
            <IconButton size="sm" aria-label={L('下载封面', 'Download cover')} disabled={busy !== null} onClick={() => { void run('download'); }}>
              <Icon icon={Download} />
            </IconButton>
            {imageReady && production?.cover ? (
              <IconButton size="sm" aria-label={L('重画封面', 'Redraw cover')} disabled={isBusy(production.cover)} onClick={() => { void regenAsset(item.id, 'cover', L); }}>
                <Icon icon={RefreshCw} />
              </IconButton>
            ) : null}
          </>
        ) : null}
      </header>
      <div className={styles.coverBody}>
        <Poster
          src={production?.cover?.src}
          text={text}
          status={production?.cover?.status ?? 'idle'}
          error={production?.cover?.error}
          className={styles.coverPoster}
          onOpen={() => onView('cover')}
          {...(imageReady && done && production?.cover ? { onRetry: () => { void regenAsset(item.id, 'cover', L); } } : {})}
        />
        {done ? (
          <div className={styles.coverWords}>
            <span className={styles.metaLabel}>{L('封面大字', 'Cover words')}</span>
            <AutoText
              className={styles.coverInput}
              label={L('封面大字', 'Cover words')}
              value={production?.coverText ?? ''}
              placeholder={production?.title}
              singleLine
              maxLength={24}
              onCommit={coverText => { void workbench.ops([{ op: 'update_production', id: item.id, coverText }], { label: L('修改封面字', 'Edit cover words'), quiet: true }); }}
            />
            <span className={styles.counter}>{[...(production?.coverText ?? '')].length}/24</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ── figures ───────────────────────────────────────────────────────────

function FiguresTile({ item, onView }: { item: WorkbenchItem; onView(target: WorkbenchAssetTarget): void }) {
  const L = useL();
  const shell = useWorkbenchShell();
  const production = item.production;
  const images = production?.images ?? [];
  const imageReady = Boolean(shell.settings?.imageReady);
  const planned = production ? (production.status === 'running' && !images.length ? shell.settings?.imageCount ?? 2 : 0) : shell.settings?.imageCount ?? 2;
  const cells = images.length ? images : Array.from({ length: planned }, () => null);
  const doneCount = images.filter(image => image.src).length;
  if (!cells.length) {
    return (
      <section className={cn(styles.tile, styles.figuresTile)} aria-label={L('配图', 'Figures')}>
        <header className={styles.tileHead}>
          <h2 className={styles.tileTitle}>{L('配图', 'Figures')}</h2>
        </header>
        <p className={styles.tileEmpty}>{L('这次没有配图。可以在设置里调整配图数量。', 'No figures this time. Change the count in settings.')}</p>
      </section>
    );
  }
  return (
    <section className={cn(styles.tile, styles.figuresTile)} aria-label={L('配图', 'Figures')}>
      <header className={styles.tileHead}>
        <h2 className={styles.tileTitle}>{L('配图', 'Figures')}</h2>
        {images.length ? <span className={styles.tileMeta}>{doneCount}/{images.length}</span> : null}
      </header>
      <div className={styles.figures}>
        {cells.map((image, index) => (
          <figure key={index} className={styles.figure}>
            <Plate
              asset={image}
              alt={image?.caption || L(`配图 ${index + 1}`, `Figure ${index + 1}`)}
              className={styles.figurePlate}
              onOpen={() => onView(`image:${index}`)}
              {...(image && imageReady && production?.status === 'done' ? { onRetry: () => { void regenAsset(item.id, `image:${index}`, L); } } : {})}
            />
            <figcaption className={styles.figureCaption}>
              <span className={styles.figureText}>{image?.caption || L(`配图 ${index + 1}`, `Figure ${index + 1}`)}</span>
              {image?.anchor ? <span className={styles.figureAnchor}>{L(`放在「${image.anchor}」`, `Under “${image.anchor}”`)}</span> : null}
              {image?.src && imageReady && production?.status === 'done' ? (
                <Button variant="link" size="sm" className={styles.linkButton} disabled={isBusy(image)} onClick={() => { void regenAsset(item.id, `image:${index}`, L); }}>
                  {L('重画', 'Redraw')}
                </Button>
              ) : null}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

// ── facts and outline ─────────────────────────────────────────────────

function NotesTile({ production }: { production: WorkbenchProduction | undefined }) {
  const L = useL();
  const facts = useMemo(() => production?.facts?.filter(Boolean) ?? [], [production?.facts]);
  const outline = useMemo(() => production?.outline?.filter(Boolean) ?? [], [production?.outline]);
  const characters = production?.characters?.trim();
  if (!facts.length && !outline.length && !characters) return null;
  return (
    <section className={cn(styles.tile, styles.notesTile)} aria-label={L('要点与大纲', 'Facts and outline')}>
      {facts.length ? (
        <div className={styles.notesGroup}>
          <h2 className={styles.tileTitle}>{L('要点', 'Facts')}</h2>
          <ul className={styles.notesList}>{facts.map((fact, index) => <li key={index}>{fact}</li>)}</ul>
        </div>
      ) : null}
      {outline.length ? (
        <div className={styles.notesGroup}>
          <h2 className={styles.tileTitle}>{L('大纲', 'Outline')}</h2>
          <ol className={styles.notesOrdered}>{outline.map((row, index) => <li key={index}>{row}</li>)}</ol>
        </div>
      ) : null}
      {characters ? (
        <div className={styles.notesGroup}>
          <h2 className={styles.tileTitle}>{L('人物', 'Characters')}</h2>
          <p className={styles.notesText}>{characters}</p>
        </div>
      ) : null}
    </section>
  );
}
