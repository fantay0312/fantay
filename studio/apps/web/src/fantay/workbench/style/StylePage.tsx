// fx-governance-allow-raw: the add tile is a dashed card and 内容进度 is a stat strip that opens 内容, which no button primitive models
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 风格 — whose voice the drafts are written in. The current style and format
 * (口播脚本 / 文章), the creator's own styles (imported accounts or 提炼风格) with full editing,
 * and the preset library grouped by creator type. A small 内容进度 strip links to 内容.
 * Derived from dsh-media-desk client/style.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useMemo, useState } from 'react';
import { Check, CopyPlus, Pencil, Plus, Sparkles, Trash2, UserPlus } from 'lucide-react';
import type { WorkbenchDraftFormat, WorkbenchStatus, WorkbenchStyle } from '@open-design/contracts';
import { WORKBENCH_STATUSES } from '@open-design/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Icon,
  IconButton,
  MoreHorizontalIcon,
  Segmented,
  SegmentedItem,
  Skeleton,
  cn,
} from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { STYLE_BOARDS, statusLabel } from '../shared/format';
import { workbench } from '../store';
import type { WorkbenchPageProps } from '../types';
import { isContentItem, useWorkbenchPageData } from '../pages-shared/data';
import page from '../pages-shared/page.module.css';
import { ExtractStyleDialog, StyleEditDialog } from './StyleDialogs';
import styles from './StylePage.module.css';

const OTHER_BOARD = '__other__';
const BOARD_EN: Record<string, string> = {
  科技数码: 'Tech', 旅行探店: 'Travel & food', 'Vlog 生活': 'Vlog & life', 观点认知: 'Ideas', 干货教程: 'How-to',
  种草测评: 'Reviews', 情感故事: 'Stories', 热点资讯: 'News',
};

const iconOf = (style: WorkbenchStyle) => style.icon || '✍️';

export function StylePage({ navigate, openImport }: WorkbenchPageProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  const { state, items, loading, error } = useWorkbenchPageData();
  const [board, setBoard] = useState('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);

  const styleList = useMemo(() => state?.styles ?? [], [state?.styles]);
  const activeId = state?.activeStyleId ?? null;
  const active = styleList.find((style) => style.id === activeId) ?? null;
  const format: WorkbenchDraftFormat = state?.draftFormat ?? 'script';
  const mine = styleList.filter((style) => !style.preset);
  const presets = styleList.filter((style) => style.preset);
  const boardName = (key: string) => (key === OTHER_BOARD ? L('其他', 'Other') : lang === 'zh' ? key : (BOARD_EN[key] ?? key));
  const boards = useMemo(() => {
    const known = STYLE_BOARDS.filter((name) => presets.some((style) => style.board === name)) as string[];
    const other = presets.some((style) => !style.board || !(STYLE_BOARDS as readonly string[]).includes(style.board));
    return other ? [...known, OTHER_BOARD] : known;
  }, [presets]);
  const boardOf = (style: WorkbenchStyle) => (style.board && (STYLE_BOARDS as readonly string[]).includes(style.board) ? style.board : OTHER_BOARD);
  const shownBoards = board === 'all' ? boards : boards.filter((name) => name === board);

  const progress = useMemo(() => {
    const counts: Record<WorkbenchStatus, number> = { idea: 0, outline: 0, draft: 0, ready: 0, published: 0 };
    for (const item of items) if (isContentItem(item)) counts[item.status] += 1;
    return counts;
  }, [items]);

  const choose = (style: WorkbenchStyle | null) =>
    void workbench.ops([{ op: 'set_style', id: style ? style.id : null }], { label: L('切换风格', 'Switch style') });
  const setFormat = (value: string) => {
    const next: WorkbenchDraftFormat = value === 'article' ? 'article' : 'script';
    if (next !== format) void workbench.ops([{ op: 'set_format', format: next }], { label: L('切换成稿格式', 'Switch draft format') });
  };
  const copyPreset = async (style: WorkbenchStyle) => {
    const response = await workbench.ops(
      [
        {
          op: 'add_style',
          name: L(`${style.name}（我的）`, `${style.name} (mine)`),
          icon: style.icon ?? '',
          summary: style.summary,
          tone: style.tone,
          sentences: style.sentences,
          opening: style.opening,
          structure: style.structure,
          logic: style.logic,
          story: style.story,
          flow: style.flow,
          words: style.words,
          avoid: style.avoid,
          samples: style.samples,
        },
      ],
      { label: L(`复制「${style.name}」`, `Copy “${style.name}”`) },
    );
    const id = response?.receipts.find((receipt) => receipt.target)?.target;
    if (id) setEditing(id);
  };
  const remove = (style: WorkbenchStyle) =>
    void workbench.ops([{ op: 'delete_style', id: style.id }], { label: L(`删除风格「${style.name}」`, `Delete style “${style.name}”`) });

  const editingStyle = editing ? (styleList.find((style) => style.id === editing) ?? null) : null;

  if (loading || error !== null) {
    return (
      <div className={page.page}>
        <div className={cn(page.inner, styles.stack)}>
          {error !== null ? (
            <div className={page.centerState}>
              <EmptyState
                variant="dashed"
                title={L('没能读取工作台', 'Could not load the workbench')}
                description={error || undefined}
                action={<Button variant="primary" onClick={() => void workbench.refresh()}>{L('重试', 'Retry')}</Button>}
              />
            </div>
          ) : (
            <>
              <Skeleton shape="card" style={{ minHeight: 168 }} />
              <div className={styles.grid}>
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} shape="card" index={i} style={{ minHeight: 190 }} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const card = (style: WorkbenchStyle, index: number) => (
    <StyleCard
      key={style.id}
      style={style}
      index={index}
      active={style.id === activeId}
      subtitle={style.id === activeId ? L('正在使用', 'In use') : style.preset ? boardName(boardOf(style)) : (style.source || L('手动', 'Manual'))}
      onChoose={() => choose(style.id === activeId ? null : style)}
      onEdit={style.preset ? null : () => setEditing(style.id)}
      onCopy={style.preset ? () => void copyPreset(style) : null}
      onDelete={style.preset ? null : () => remove(style)}
    />
  );

  return (
    <div className={page.page}>
      <div className={cn(page.inner, styles.stack)}>
        <section className={cn(page.tile, page.hero, page.rise, styles.hero)}>
          <div className={page.heroCopy}>
            <h1 className={page.heroLine}>
              {active ? (
                <>
                  {L('现在按', 'Writing as')}
                  <span className={page.heroEmoji} aria-hidden>
                    {iconOf(active)}
                  </span>
                  <b>{active.name}</b>
                  {L(' 的风格，', ', ')}
                  <br />
                  {L('写成', 'as ')}
                  <b>{format === 'article' ? L('文章', 'an article') : L('口播脚本', 'a spoken script')}</b>
                  {L('。', '.')}
                </>
              ) : (
                <>
                  {L('选一种预设直接开写，', 'Pick a preset and start writing,')}
                  <br />
                  <b>{L('或者导入自己的账号，提炼你的风格。', 'or import your account to distil your own voice.')}</b>
                </>
              )}
            </h1>
            <div className={page.heroActions}>
              <Button variant="primary" onClick={openImport}>
                <Icon icon={UserPlus} />
                {L('导入账号', 'Import account')}
              </Button>
              <Button variant="secondary" onClick={() => setExtracting(true)}>
                <Icon icon={Sparkles} />
                {L('提炼风格', 'Extract a style')}
              </Button>
              {active ? (
                <Button variant="bare" onClick={() => choose(null)}>
                  {L('不指定风格', 'No specific style')}
                </Button>
              ) : null}
            </div>
          </div>
          <div className={styles.heroSide}>
            <div className={styles.sideBlock}>
              <span className={styles.sideLabel}>{L('成稿格式', 'Draft format')}</span>
              <Segmented value={format} onValueChange={setFormat} aria-label={L('成稿格式', 'Draft format')} className="flex w-full">
                <SegmentedItem value="script" className="min-w-0 flex-1">
                  {L('口播脚本', 'Spoken script')}
                </SegmentedItem>
                <SegmentedItem value="article" className="min-w-0 flex-1">
                  {L('文章', 'Article')}
                </SegmentedItem>
              </Segmented>
              <span className={styles.sideHint}>
                {format === 'article'
                  ? L('按自然段写，可以直接发。', 'Written in paragraphs, ready to post.')
                  : L('一句一行，照着念就行。', 'One line per sentence, ready to read aloud.')}
              </span>
            </div>
            <button type="button" className={styles.progress} onClick={() => navigate('content')} aria-label={L('内容进度，打开内容页', 'Content progress — open Content')}>
              <span className={styles.sideLabel}>{L('内容进度', 'Content progress')}</span>
              <span className={styles.progressRow}>
                {WORKBENCH_STATUSES.map((status) => (
                  <span key={status} className={styles.progressCell}>
                    <b>{progress[status]}</b>
                    <small>
                      <span className={page.statusDot} data-status={status} />
                      {statusLabel(status, lang)}
                    </small>
                  </span>
                ))}
              </span>
            </button>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="wb-style-mine">
          <header className={styles.sectionHead}>
            <h2 id="wb-style-mine" className={styles.sectionTitle}>
              {L('我的风格', 'My styles')}
              <span className={styles.sectionCount}>{mine.length}</span>
            </h2>
            <span className={styles.sectionHint}>{L('从导入的账号或提炼出来，每一项都能改。', 'From imported accounts or extraction; every field is editable.')}</span>
          </header>
          <div className={styles.grid}>
            {mine.map(card)}
            <button type="button" className={cn(styles.addCard, page.rise)} onClick={() => setExtracting(true)}>
              <span className={styles.addIcon}>
                <Icon icon={Plus} />
              </span>
              <strong>{L('提炼一个新风格', 'Extract a new style')}</strong>
              <small>{L('贴稿子或链接，几十秒出一张风格卡', 'Paste writing or links; a style card in under a minute')}</small>
            </button>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="wb-style-presets">
          <header className={styles.sectionHead}>
            <h2 id="wb-style-presets" className={styles.sectionTitle}>
              {L('预设风格', 'Presets')}
              <span className={styles.sectionCount}>{presets.length}</span>
            </h2>
            <span className={styles.sectionHint}>{L('按博主类型分好，选一张就按它写。', 'Grouped by creator type; pick one and drafts follow it.')}</span>
          </header>
          {presets.length ? (
            <>
              <Segmented value={board} onValueChange={setBoard} aria-label={L('博主类型', 'Creator type')} className={cn('flex w-full', styles.boardFilter)}>
                <SegmentedItem value="all" className="min-w-0 flex-1">
                  {L('全部', 'All')}
                </SegmentedItem>
                {boards.map((name) => (
                  <SegmentedItem key={name} value={name} className="min-w-0 flex-1">
                    <span className={styles.segLabel}>{boardName(name)}</span>
                  </SegmentedItem>
                ))}
              </Segmented>
              <div key={board} className={styles.boards}>
                {shownBoards.map((name) => (
                  <div key={name} className={styles.board}>
                    {board === 'all' ? <h3 className={styles.boardTitle}>{boardName(name)}</h3> : null}
                    <div className={styles.grid}>{presets.filter((style) => boardOf(style) === name).map(card)}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className={page.noMatch}>{L('预设还没有加载。', 'Presets have not loaded yet.')}</p>
          )}
        </section>
      </div>

      <StyleEditDialog style={editingStyle} onClose={() => setEditing(null)} />
      <ExtractStyleDialog open={extracting} onClose={() => setExtracting(false)} onImport={openImport} />
    </div>
  );
}

function StyleCard({
  style,
  index,
  active,
  subtitle,
  onChoose,
  onEdit,
  onCopy,
  onDelete,
}: {
  style: WorkbenchStyle;
  index: number;
  active: boolean;
  subtitle: string;
  onChoose(): void;
  onEdit: (() => void) | null;
  onCopy: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  const L = useL();
  return (
    <article className={cn(styles.card, page.rise)} data-active={active ? '' : undefined} style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}>
      <header className={styles.cardHead}>
        <span className={styles.cardIcon} aria-hidden>
          {iconOf(style)}
        </span>
        <div className={styles.cardName}>
          <strong>{style.name}</strong>
          <small>
            {active ? <Icon icon={Check} size={11} /> : null}
            {subtitle}
          </small>
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" className={styles.cardMenu} aria-label={L(`「${style.name}」的更多操作`, `More for “${style.name}”`)} tooltip={L('更多操作', 'More')}>
              <MoreHorizontalIcon />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="sm">
            {onEdit ? (
              <DropdownMenuItem icon={<Icon icon={Pencil} size="sm" />} onSelect={onEdit}>
                {L('编辑', 'Edit')}
              </DropdownMenuItem>
            ) : null}
            {onCopy ? (
              <DropdownMenuItem icon={<Icon icon={CopyPlus} size="sm" />} onSelect={onCopy}>
                {L('复制为我的风格', 'Copy to my styles')}
              </DropdownMenuItem>
            ) : null}
            {onDelete ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" icon={<Icon icon={Trash2} size="sm" />} onSelect={onDelete}>
                  {L('删除', 'Delete')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {style.summary ? <p className={styles.cardSummary}>{style.summary}</p> : null}
      {style.samples?.[0] ? <blockquote className={styles.cardSample}>{style.samples[0]}</blockquote> : null}
      {style.words?.length ? (
        <div className={styles.cardWords}>
          {style.words.slice(0, 4).map((word) => (
            <span key={word}>{word}</span>
          ))}
        </div>
      ) : null}
      <footer className={styles.cardFoot}>
        <Button size="sm" variant={active ? 'secondary' : 'primary'} onClick={onChoose}>
          {active ? L('不用了', 'Stop using') : L('用这个写', 'Write with this')}
        </Button>
        {onEdit ? (
          <Button size="sm" variant="bare" onClick={onEdit}>
            {L('编辑', 'Edit')}
          </Button>
        ) : null}
      </footer>
    </article>
  );
}
