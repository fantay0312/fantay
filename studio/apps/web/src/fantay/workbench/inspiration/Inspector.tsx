'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — the ⓘ inspector (Resurf): preview, editing, tags, space, production,
 * AI summary / keywords / OCR, highlights, similar items, source and dates. With several items
 * selected it edits them together.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorkbenchItem, WorkbenchPublicSettings } from '@open-design/contracts';
import { workbenchMediaUrl } from '@open-design/contracts';
import {
  ArchiveRestore, ArrowRight, BookOpen, ExternalLink, FileText, Highlighter, Info, MoreHorizontal, ScanText, Sparkles, Star, Trash2, WandSparkles, X,
} from 'lucide-react';
import {
  Button, Icon, IconButton, Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue, Switch, Textarea, toast,
} from '../../ui';
import { workbenchApi } from '../api';
import { useL, useWorkbenchLang } from '../lang';
import { displayItem, fmtWhen, kindLabel, platformName, posterOf, relativeDay, statusLabel } from '../shared/format';
import { workbench } from '../store';
import { useActions, useLibraryState } from './context';
import { ItemDropdownMenu } from './ItemMenu';
import { fmtBytes, fmtDuration, hostOf, inLibrary, readMinutesOf, spaceById } from './library';
import { similarItems } from './related';
import { SpaceGlyph } from './SpaceGlyph';
import { TagEditor } from './TagEditor';
import styles from './Inspector.module.css';

type Defaults = Pick<WorkbenchPublicSettings, 'generateImages' | 'imageReady'>;
let defaultsPromise: Promise<Defaults | null> | null = null;
function loadDefaults(): Promise<Defaults | null> {
  defaultsPromise ??= workbenchApi.settings().then(s => ({ generateImages: s.generateImages, imageReady: s.imageReady })).catch(() => {
    defaultsPromise = null;
    return null;
  });
  return defaultsPromise;
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Thumb({ item }: { item: WorkbenchItem }) {
  const shown = displayItem(item);
  const poster = workbenchMediaUrl(posterOf(shown));
  return (
    <span className={styles.thumb}>
      {poster ? <img src={poster} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span>{(shown.title || '·').slice(0, 1)}</span>}
    </span>
  );
}

function Preview({ item }: { item: WorkbenchItem }) {
  const L = useL();
  const media = item.media;
  const src = workbenchMediaUrl(media?.src);
  const poster = workbenchMediaUrl(media?.poster);
  if (!media || !src) return null;
  const colors = media.colors ?? [];
  const copy = (hex: string) => {
    void navigator.clipboard?.writeText(hex).then(
      () => toast({ title: L(`已复制 ${hex}`, `Copied ${hex}`) }),
      () => undefined,
    );
  };
  return (
    <div className={styles.preview}>
      {item.kind === 'image' || item.kind === 'web' ? (
        <a className={styles.previewMedia} href={src} target="_blank" rel="noreferrer" title={L('在新窗口打开原图', 'Open full size')}>
          <img src={src} alt="" referrerPolicy="no-referrer" />
        </a>
      ) : item.kind === 'video' ? (
        <div className={styles.previewMedia}>
          <video src={src} {...(poster ? { poster } : {})} controls playsInline preload="metadata" />
        </div>
      ) : item.kind === 'audio' ? (
        <audio className={styles.previewAudio} src={src} controls preload="metadata" />
      ) : item.kind === 'pdf' ? (
        <div className={styles.previewPdf}>
          <iframe src={src} title={item.title} />
          <a className={styles.previewOpen} href={src} target="_blank" rel="noreferrer">
            <Icon icon={ExternalLink} size={12} />
            {L('在新窗口打开 PDF', 'Open PDF in a new window')}
          </a>
        </div>
      ) : null}
      {colors.length ? (
        <div className={styles.colors} aria-label={L('主色', 'Dominant colours')}>
          {colors.slice(0, 6).map(hex => (
            <IconButton key={hex} size="xs" className={styles.color} style={{ background: hex }} tooltip={hex} aria-label={L(`复制颜色 ${hex}`, `Copy ${hex}`)} onClick={() => copy(hex)} />
          ))}
        </div>
      ) : null}
      {media.w || media.durationSec || media.bytes ? (
        <p className={styles.mediaMeta}>
          {[media.w && media.h ? `${media.w} × ${media.h}` : null, fmtDuration(media.durationSec), fmtBytes(media.bytes) || null].filter(Boolean).join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

/** Title and body edit in place and save on blur (quietly: the inspector shows the result). */
function useDraft(item: WorkbenchItem, field: 'title' | 'body') {
  const [value, setValue] = useState(item[field]);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setValue(item[field]);
  }, [item, field]);
  const commit = () => {
    focused.current = false;
    const next = field === 'title' ? value.trim() : value;
    if (next === item[field] || (field === 'title' && !next)) {
      setValue(item[field]);
      return;
    }
    void workbench.ops([{ op: 'update_item', id: item.id, [field]: next }], { label: field === 'title' ? '改标题' : '改正文', quiet: true });
  };
  return { value, setValue, commit, onFocus: () => { focused.current = true; } };
}

function SpacePicker({ ids, value }: { ids: string[]; value: string | null | 'mixed' }) {
  const L = useL();
  const state = useLibraryState();
  const actions = useActions();
  return (
    <Select
      value={value === 'mixed' ? '' : value ?? 'none'}
      onValueChange={(next) => {
        if (next === 'new') actions.createSpace(ids);
        else actions.moveToSpace(ids, next === 'none' ? null : next);
      }}
    >
      <SelectTrigger size="sm" className={styles.spaceTrigger} aria-label={L('空间', 'Space')}>
        <SelectValue placeholder={value === 'mixed' ? L('多个空间', 'Several spaces') : L('不放进空间', 'No space')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{L('不放进空间', 'No space')}</SelectItem>
        {state.spaces.map(space => (
          <SelectItem key={space.id} value={space.id}>
            <span className={styles.spaceOption}><SpaceGlyph color={space.color} size={15} />{space.name}</span>
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value="new">{L('新建空间…', 'New space…')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ProducePanel({ item }: { item: WorkbenchItem }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const actions = useActions();
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [draw, setDraw] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void loadDefaults().then(value => { if (alive) setDefaults(value); });
    return () => { alive = false; };
  }, []);
  useEffect(() => { setDraw(null); }, [item.id]);
  const production = item.production;
  const running = production?.status === 'running';
  const withImages = draw ?? (production?.withImages !== undefined ? production.withImages : defaults?.generateImages !== false);
  const cover = workbenchMediaUrl(production?.cover?.src);
  const rows: Array<[string, string]> = [
    [L('状态', 'Status'), statusLabel(item.status, lang)],
    ...(item.platform ? [[L('平台', 'Platform'), platformName(item.platform, lang)] as [string, string]] : []),
    ...(item.scheduledAt ? [[L('排期', 'Scheduled'), fmtWhen(item.scheduledAt, lang)] as [string, string]] : []),
    ...(item.publishedAt ? [[L('发布于', 'Published'), fmtWhen(item.publishedAt, lang)] as [string, string]] : []),
  ];
  return (
    <Section
      title={L('成稿', 'Production')}
      aside={item.status !== 'idea' || item.scheduledAt ? (
        <Button variant="link" size="sm" className={styles.sectionLink} onClick={() => actions.gotoPage(item.scheduledAt ? 'schedule' : 'content')}>
          {item.scheduledAt ? L('去排期', 'Schedule') : L('去内容', 'Content')}
          <Icon icon={ArrowRight} size={11} />
        </Button>
      ) : undefined}
    >
      <dl className={styles.facts}>
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      {production ? (
        <div className={styles.production} data-status={production.status}>
          {cover ? <img src={cover} alt="" className={styles.productionCover} /> : <span className={styles.productionIcon}><Icon icon={FileText} size={16} /></span>}
          <div className={styles.productionText}>
            <strong>{production.title || item.title}</strong>
            <span>
              {running
                ? (production.stage === 'making' ? L('正在配图和分镜…', 'Drawing figures and shots…') : L('正在写稿…', 'Writing…'))
                : production.status === 'failed'
                  ? (production.error || L('这次成稿没有完成', 'This run did not finish'))
                  : production.status === 'cancelled'
                    ? L('已取消', 'Cancelled')
                    : L(`${production.format === 'script' ? '脚本' : '文章'} · ${relativeDay(production.finishedAt ?? production.startedAt, lang)}`, `${production.format === 'script' ? 'Script' : 'Article'} · ${relativeDay(production.finishedAt ?? production.startedAt, lang)}`)}
            </span>
            {running ? <span className={styles.productionBar} data-stage={production.stage} aria-hidden /> : null}
          </div>
        </div>
      ) : null}
      <div className={styles.produceRow}>
        {production ? (
          <Button variant="primary" size="sm" onClick={() => actions.openProduction(item.id)}>
            <Icon icon={FileText} />
            {L('打开成稿', 'Open production')}
          </Button>
        ) : null}
        <Button
          variant={production ? 'secondary' : 'primary'}
          size="sm"
          disabled={running}
          disabledReason={running ? L('正在成稿，稍等一下', 'A production is running') : undefined}
          onClick={() => actions.produce(item.id, withImages)}
        >
          <Icon icon={WandSparkles} />
          {production ? L('重新成稿', 'Produce again') : L('一键成稿', 'Produce')}
        </Button>
        <label className={styles.drawToggle}>
          <Switch size="sm" checked={withImages} onCheckedChange={value => setDraw(value)} />
          {L('生成图片', 'Images')}
        </label>
      </div>
      {!running && !withImages ? <p className={styles.hint}>{L('这次只出文字版，之后仍可以单张补画。', 'Text only this time; you can draw single images later.')}</p> : null}
      {!running && withImages && defaults && !defaults.imageReady ? (
        <p className={styles.hint}>
          {L('接入生图模型后，封面和分镜也会画好。', 'Connect an image model and covers and shots are drawn too.')}
          <Button variant="link" size="sm" className={styles.inlineLink} onClick={() => actions.openSettings()}>{L('去设置', 'Settings')}</Button>
        </p>
      ) : null}
    </Section>
  );
}

function AiPanel({ item }: { item: WorkbenchItem }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const state = useLibraryState();
  const actions = useActions();
  const [showOcr, setShowOcr] = useState(false);
  const busy = state.organizing.has(item.id);
  const empty = !item.summary && !item.keywords?.length && !item.ocrText;
  return (
    <Section
      title={L('AI 整理', 'AI')}
      aside={(
        <Button variant="bare" size="sm" loading={busy} onClick={() => { void actions.organize([item.id]); }}>
          <Icon icon={Sparkles} />
          {item.organizedAt ? L('重新整理', 'Re-organise') : L('整理', 'Organise')}
        </Button>
      )}
    >
      {empty ? (
        <p className={styles.muted}>{L('让 AI 起标题、打标签、写摘要，图片里的文字也会认出来。', 'AI writes a title, tags and a summary, and reads text inside images.')}</p>
      ) : null}
      {item.summary ? <p className={styles.summary}>{item.summary}</p> : null}
      {item.keywords?.length ? (
        <div className={styles.keywords}>
          {item.keywords.map(keyword => <span key={keyword}>{keyword}</span>)}
        </div>
      ) : null}
      {item.ocrText ? (
        <div className={styles.ocr}>
          <Button variant="bare" size="sm" className={styles.ocrToggle} aria-expanded={showOcr} onClick={() => setShowOcr(v => !v)}>
            <Icon icon={ScanText} size={13} />
            {L(`图中文字 · ${item.ocrText.length} 字`, `Text in image · ${item.ocrText.length} chars`)}
          </Button>
          <div className={`accordion-collapsible${showOcr ? ' open' : ''}`}>
            <div className="accordion-collapsible-inner">
              <p className={styles.ocrText}>{item.ocrText}</p>
            </div>
          </div>
        </div>
      ) : null}
      {item.organizedAt ? <p className={styles.metaLine}>{L(`整理于 ${relativeDay(item.organizedAt, lang)}`, `Organised ${relativeDay(item.organizedAt, lang)}`)}</p> : null}
    </Section>
  );
}

const REASON: Record<string, [string, string]> = {
  tags: ['同标签', 'tags'], keywords: ['关键词', 'keywords'], colors: ['颜色相近', 'colours'], words: ['说到同一件事', 'shared words'], space: ['同空间', 'space'],
};

function SimilarPanel({ item }: { item: WorkbenchItem }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const state = useLibraryState();
  const actions = useActions();
  const pool = useMemo(() => state.items.filter(inLibrary), [state.items]);
  const hits = useMemo(() => similarItems(item, pool, 6), [item, pool]);
  return (
    <Section title={L('相似', 'Similar')}>
      {hits.length ? (
        <ul className={styles.similar}>
          {hits.map((hit) => {
            const row = state.byId.get(hit.id);
            if (!row) return null;
            return (
              <li key={hit.id}>
                <Button variant="bare" block className={styles.similarRow} onClick={() => actions.open(hit.id)}>
                  <Thumb item={row} />
                  <span className={styles.similarText}>
                    <span className={styles.similarTitle}>{displayItem(row).title || L('无标题', 'Untitled')}</span>
                    <span className={styles.similarWhy}>{hit.reasons.map(r => REASON[r]![lang === 'zh' ? 0 : 1]).join(' · ')}</span>
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.muted}>{L('还没找到相似的灵感。加几个标签，或者 AI 整理一下。', 'Nothing similar yet. Add tags or organise with AI.')}</p>
      )}
    </Section>
  );
}

function Detail({ item, onClose }: { item: WorkbenchItem; onClose(): void }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const state = useLibraryState();
  const actions = useActions();
  const title = useDraft(item, 'title');
  const body = useDraft(item, 'body');
  const space = spaceById(state.spaces, item.spaceId);
  const minutes = readMinutesOf(item);
  const highlights = item.highlights ?? [];
  const trashed = Boolean(item.trashedAt);

  return (
    <div className={styles.detail}>
      <header className={styles.head}>
        <span className={styles.kind}>{kindLabel(item.kind, lang)}</span>
        {space ? <span className={styles.headSpace}><SpaceGlyph color={space.color} size={13} />{space.name}</span> : null}
        {!item.triagedAt && !trashed ? <span className={styles.inboxBadge}>{L('收件箱', 'Inbox')}</span> : null}
        <span className={styles.headSpacer} />
        {!trashed ? (
          <IconButton size="sm" aria-label={item.starred ? L('取消星标', 'Unstar') : L('加星标', 'Star')} on={Boolean(item.starred)} shortcut="s" onClick={() => actions.star([item.id], !item.starred)}>
            <Icon icon={Star} fill={item.starred ? 'currentColor' : 'none'} className={item.starred ? styles.starOn : undefined} />
          </IconButton>
        ) : null}
        <ItemDropdownMenu item={item} trigger={<IconButton size="sm" aria-label={L('更多操作', 'More actions')}><Icon icon={MoreHorizontal} /></IconButton>} />
        <IconButton size="sm" aria-label={L('关闭详情', 'Close inspector')} onClick={onClose}><Icon icon={X} /></IconButton>
      </header>

      <div className={styles.scroll} data-wheel-scroll="">
        <Preview item={item} />

        <Textarea
          variant="bare"
          className={styles.titleInput}
          data-kind={item.kind}
          rows={1}
          value={title.value}
          disabled={trashed}
          placeholder={L('标题', 'Title')}
          aria-label={L('标题', 'Title')}
          onFocus={title.onFocus}
          onChange={event => title.setValue(event.target.value)}
          onBlur={title.commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === 'Escape') { title.setValue(item.title); event.currentTarget.blur(); }
            event.stopPropagation();
          }}
        />
        {item.kind !== 'quote' ? (
          <Textarea
            variant="bare"
            className={styles.bodyInput}
            value={body.value}
            disabled={trashed}
            placeholder={item.kind === 'note' ? L('写下更多…', 'Write more…') : L('添加备注…', 'Add a note…')}
            aria-label={L('正文', 'Body')}
            onFocus={body.onFocus}
            onChange={event => body.setValue(event.target.value)}
            onBlur={body.commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur(); }
              event.stopPropagation();
            }}
          />
        ) : item.source ? <p className={styles.quoteSource}>— {item.source}</p> : null}

        {!trashed ? (
          <>
            <div className={styles.fields}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{L('空间', 'Space')}</span>
                <SpacePicker ids={[item.id]} value={item.spaceId ?? null} />
              </div>
              <div className={styles.field} data-stack="">
                <span className={styles.fieldLabel}>{L('标签', 'Tags')}</span>
                <TagEditor ids={[item.id]} />
              </div>
            </div>

            {item.kind === 'web' ? (
              <Section title={L('阅读', 'Read')}>
                <div className={styles.readRow}>
                  <Button variant="secondary" size="sm" onClick={() => actions.openReader(item.id)}>
                    <Icon icon={BookOpen} />
                    {L('阅读模式', 'Reader')}
                  </Button>
                  <span className={styles.muted}>
                    {[minutes ? L(`约 ${minutes} 分钟`, `~${minutes} min`) : null, highlights.length ? L(`${highlights.length} 处高亮`, `${highlights.length} highlight${highlights.length === 1 ? '' : 's'}`) : null].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {highlights.length ? (
                  <ul className={styles.highlights}>
                    {highlights.slice(0, 3).map(h => (
                      <li key={h.id}><Icon icon={Highlighter} size={12} /><span>{h.text}</span></li>
                    ))}
                  </ul>
                ) : null}
              </Section>
            ) : null}

            <ProducePanel item={item} />
            <AiPanel item={item} />
            <SimilarPanel item={item} />
          </>
        ) : null}

        <Section title={L('信息', 'Info')}>
          <dl className={styles.facts}>
            {item.url ? (
              <div>
                <dt>{L('来源', 'Source')}</dt>
                <dd><a href={item.url} target="_blank" rel="noreferrer" className={styles.sourceLink}>{hostOf(item.url) ?? item.url}<Icon icon={ExternalLink} size={11} /></a></dd>
              </div>
            ) : item.source ? <div><dt>{L('来源', 'Source')}</dt><dd>{item.source}</dd></div> : null}
            <div><dt>{L('创建', 'Created')}</dt><dd>{fmtWhen(item.createdAt, lang)}</dd></div>
            {item.updatedAt ? <div><dt>{L('更新', 'Updated')}</dt><dd>{fmtWhen(item.updatedAt, lang)}</dd></div> : null}
            {item.surfacedCount ? <div><dt>{L('重温', 'Resurfaced')}</dt><dd>{L(`${item.surfacedCount} 次`, `${item.surfacedCount}×`)}</dd></div> : null}
            {trashed ? <div><dt>{L('删除于', 'Trashed')}</dt><dd>{fmtWhen(item.trashedAt, lang)}</dd></div> : null}
          </dl>
        </Section>
      </div>

      <footer className={styles.foot}>
        {trashed ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => actions.restore([item.id])}><Icon icon={ArchiveRestore} />{L('恢复', 'Restore')}</Button>
            <Button variant="bare" size="sm" className={styles.danger} onClick={() => actions.deleteForever([item.id])}>{L('永久删除', 'Delete forever')}</Button>
          </>
        ) : (
          <Button variant="bare" size="sm" className={styles.danger} onClick={() => actions.trash([item.id])}><Icon icon={Trash2} />{L('移到回收站', 'Move to Trash')}</Button>
        )}
      </footer>
    </div>
  );
}

function MultiDetail({ ids, onClose }: { ids: string[]; onClose(): void }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const state = useLibraryState();
  const actions = useActions();
  const items = ids.map(id => state.byId.get(id)).filter((item): item is WorkbenchItem => Boolean(item));
  const kinds = new Map<string, number>();
  items.forEach(item => kinds.set(kindLabel(item.kind, lang), (kinds.get(kindLabel(item.kind, lang)) ?? 0) + 1));
  const spaceIds = new Set(items.map(item => item.spaceId ?? null));
  const spaceValue = spaceIds.size === 1 ? [...spaceIds][0]! : 'mixed';
  const allStarred = items.every(item => item.starred);
  const trashed = items.every(item => item.trashedAt);
  const busy = ids.some(id => state.organizing.has(id));
  return (
    <div className={styles.detail}>
      <header className={styles.head}>
        <span className={styles.kind}>{L(`已选 ${items.length} 条`, `${items.length} selected`)}</span>
        <span className={styles.headSpacer} />
        <IconButton size="sm" aria-label={L('关闭详情', 'Close inspector')} onClick={onClose}><Icon icon={X} /></IconButton>
      </header>
      <div className={styles.scroll} data-wheel-scroll="">
        <div className={styles.stack}>
          {items.slice(0, 12).map(item => <Thumb key={item.id} item={item} />)}
          {items.length > 12 ? <span className={styles.stackMore}>+{items.length - 12}</span> : null}
        </div>
        <p className={styles.muted}>{[...kinds].map(([k, n]) => `${k} ${n}`).join(' · ')}</p>
        {!trashed ? (
          <div className={styles.fields}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{L('空间', 'Space')}</span>
              <SpacePicker ids={ids} value={spaceValue} />
            </div>
            <div className={styles.field} data-stack="">
              <span className={styles.fieldLabel}>{L('标签', 'Tags')}</span>
              <TagEditor ids={ids} />
            </div>
          </div>
        ) : null}
        <div className={styles.multiActions}>
          {trashed ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => actions.restore(ids)}><Icon icon={ArchiveRestore} />{L('全部恢复', 'Restore all')}</Button>
              <Button variant="bare" size="sm" className={styles.danger} onClick={() => actions.deleteForever(ids)}>{L('永久删除', 'Delete forever')}</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => actions.star(ids, !allStarred)}><Icon icon={Star} />{allStarred ? L('取消星标', 'Unstar') : L('全部加星标', 'Star all')}</Button>
              <Button variant="secondary" size="sm" loading={busy} onClick={() => { void actions.organize(ids); }}><Icon icon={Sparkles} />{L('AI 整理', 'Organise')}</Button>
              <Button variant="secondary" size="sm" onClick={() => actions.ask(L(`看看我选中的这 ${items.length} 条灵感：${items.slice(0, 8).map(item => `「${displayItem(item).title}」`).join('、')}。它们之间有什么联系，能做成什么内容？`, `Look at these ${items.length} ideas: ${items.slice(0, 8).map(item => `"${displayItem(item).title}"`).join(', ')}. How do they connect, and what could they become?`))}>
                <Icon icon={Info} />
                {L('问问助手', 'Ask the assistant')}
              </Button>
              <Button variant="bare" size="sm" className={styles.danger} onClick={() => actions.trash(ids)}><Icon icon={Trash2} />{L('移到回收站', 'Move to Trash')}</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function Inspector({ open, onClose }: { open: boolean; onClose(): void }) {
  const L = useL();
  const state = useLibraryState();
  const ids = [...state.selection].filter(id => state.byId.has(id));
  const item = ids.length === 1 ? state.byId.get(ids[0]!) : undefined;
  return (
    <aside className={styles.dock} data-open={open ? '' : undefined} aria-label={L('详情', 'Inspector')} aria-hidden={!open}>
      <div className={styles.inner} {...(open ? {} : { inert: true })}>
        {item ? <Detail key={item.id} item={item} onClose={onClose} /> : ids.length > 1 ? <MultiDetail ids={ids} onClose={onClose} /> : (
          <div className={styles.detail}>
            <header className={styles.head}>
              <span className={styles.kind}>{L('详情', 'Details')}</span>
              <span className={styles.headSpacer} />
              <IconButton size="sm" aria-label={L('关闭详情', 'Close inspector')} onClick={onClose}><Icon icon={X} /></IconButton>
            </header>
            <div className={styles.blank}>
              <span className={styles.blankMark}><Icon icon={Info} size={18} /></span>
              <p>{L('选中一条灵感，在这里看预览、改标题、加标签，或者一键成稿。', 'Select an idea to preview it, edit it, tag it, or produce it.')}</p>
              <p className={styles.muted}>{L('按住 ⌘ 或 Shift 可以多选，一起整理。', 'Hold ⌘ or Shift to select several and edit them together.')}</p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
