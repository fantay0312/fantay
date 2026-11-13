// fx-governance-allow-raw: calendar chips, tray cards and the 下一条 card are draggable whole-card controls, which no button primitive models
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 排期 — the publishing calendar and the idea calendar are one calendar: every day
 * carries its 灵感邮票, scheduled items sit in their day, and content is dragged from the right-hand
 * 待排期 tray onto a day (`schedule_item`, keeping the time of day, 20:00 by default). Chips drag
 * between days to reschedule and back onto the tray to unschedule. 下一条 is always at the top.
 * Derived from dsh-media-desk client/schedule.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useMemo, useState, type CSSProperties, type DragEvent } from 'react';
import { CalendarPlus, ChevronLeft, ChevronRight, CircleCheck } from 'lucide-react';
import type { WorkbenchItem } from '@open-design/contracts';
import { Button, EmptyState, Icon, IconButton, Segmented, SegmentedItem, Skeleton, cn } from '../../ui';
import { requestQuickCapture } from '../capture-bus';
import { useL, useWorkbenchLang } from '../lang';
import { computeStreak, dayKey, displayItem, fmtDate, fmtTime, pad, platformName, relativeDay, statusLabel } from '../shared/format';
import { workbench } from '../store';
import type { WorkbenchPageProps } from '../types';
import { dragHasItem, isContentItem, readItemDrag, shortcutBlocked, startItemDrag, useNow, useWorkbenchPageData } from '../pages-shared/data';
import { ItemCover } from '../pages-shared/ItemCover';
import page from '../pages-shared/page.module.css';
import { ScheduleDialog } from '../pages-shared/ScheduleDialog';
import { Stamp, useIdeaDays } from './Stamp';
import styles from './SchedulePage.module.css';

type Mode = 'month' | 'week';

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ZH = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_CHIPS = 2;

const startOfWeek = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** Month grid from the Sunday on or before the 1st; 4, 5 or 6 rows as the month needs. */
function monthCells(cursor: Date): Date[] {
  const y = cursor.getFullYear();
  const m = cursor.getMonth();
  const first = new Date(y, m, 1).getDay();
  const cells: Date[] = [];
  for (let i = 0; i < 42; i += 1) cells.push(new Date(y, m, i - first + 1));
  if (cells[28]!.getMonth() !== m) return cells.slice(0, 28);
  return cells[35]!.getMonth() === m ? cells : cells.slice(0, 35);
}

function moveTo(item: WorkbenchItem, day: Date, label: string): void {
  const target = new Date(day);
  const previous = item.scheduledAt ? new Date(item.scheduledAt) : null;
  target.setHours(previous?.getHours() ?? 20, previous?.getMinutes() ?? 0, 0, 0);
  if (previous && previous.getTime() === target.getTime()) return;
  void workbench.ops([{ op: 'schedule_item', id: item.id, scheduledAt: target.toISOString() }], { label });
}

export function SchedulePage({ active, openItem, navigate }: WorkbenchPageProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  const { items, loading, error } = useWorkbenchPageData();
  const now = useNow(active);
  const [mode, setMode] = useState<Mode>('month');
  const [cursor, setCursor] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [over, setOver] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<WorkbenchItem | null>(null);

  const content = useMemo(() => items.filter(isContentItem), [items]);
  const byId = useMemo(() => new Map(content.map((item) => [item.id, item])), [content]);
  const ideaDays = useIdeaDays(items);
  const byDay = useMemo(() => {
    const map = new Map<string, WorkbenchItem[]>();
    for (const item of content) {
      if (!item.scheduledAt) continue;
      const key = dayKey(item.scheduledAt);
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    for (const list of map.values()) list.sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
    return map;
  }, [content]);

  const today = dayKey(now);
  const cells = mode === 'month' ? monthCells(cursor) : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i));
  const inRange = (key: string) => (mode === 'month' ? key.startsWith(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`) : cells.some((d) => dayKey(d) === key));
  const rangeIdeas = [...ideaDays.entries()].filter(([key]) => inRange(key)).reduce((sum, [, list]) => sum + list.length, 0);
  const rangePosts = [...byDay.entries()].filter(([key]) => inRange(key)).reduce((sum, [, list]) => sum + list.length, 0);
  const streak = useMemo(() => computeStreak(items, now), [items, now]);

  const go = (step: number) =>
    setCursor((current) => (mode === 'month' ? new Date(current.getFullYear(), current.getMonth() + step, 1) : addDays(current, step * 7)));
  const goToday = () => setCursor(mode === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now));
  const changeMode = (next: string) => {
    const value: Mode = next === 'week' ? 'week' : 'month';
    if (value === mode) return;
    if (value === 'week') {
      const sameMonth = now.getFullYear() === cursor.getFullYear() && now.getMonth() === cursor.getMonth();
      setCursor(sameMonth ? new Date(now) : new Date(cursor.getFullYear(), cursor.getMonth(), 1));
    } else {
      const anchor = addDays(startOfWeek(cursor), 3);
      setCursor(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    }
    setMode(value);
  };
  const openWeek = (day: Date) => {
    setCursor(day);
    setMode('week');
  };

  // Keyboard: ←/→ or PageUp/PageDown step the range, T jumps to today, W/M switch the view.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (shortcutBlocked(event)) return;
      const key = event.key;
      if (key === 'ArrowLeft' || key === 'PageUp') go(-1);
      else if (key === 'ArrowRight' || key === 'PageDown') go(1);
      else if (key === 't' || key === 'T') goToday();
      else if (key === 'w' || key === 'W') changeMode('week');
      else if (key === 'm' || key === 'M') changeMode('month');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const capture = () => {
    if (!requestQuickCapture({ tab: 'note' })) navigate('inspiration');
  };

  const dayLabel = (date: Date) => fmtDate(date.toISOString(), lang);
  const dropOnDay = (event: DragEvent, date: Date) => {
    event.preventDefault();
    setOver(null);
    const id = readItemDrag(event);
    const item = id ? byId.get(id) : undefined;
    if (item) moveTo(item, date, L(`排到${dayLabel(date)}`, `Schedule for ${dayLabel(date)}`));
  };

  if (loading || error !== null) {
    return (
      <div className={page.page}>
        <div className={cn(page.inner, styles.inner)}>
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
            <div className={styles.layout} aria-busy>
              <Skeleton shape="card" className={styles.skeletonCal} />
              <div className={styles.rail}>
                <Skeleton shape="card" style={{ minHeight: 132 }} />
                <Skeleton shape="card" index={1} style={{ flex: 1 }} />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const weekStart = startOfWeek(cursor);
  const weekEnd = addDays(weekStart, 6);
  const weekLabels = lang === 'zh' ? WEEK_ZH : WEEK_EN;

  return (
    <div className={page.page}>
      <div className={cn(page.inner, styles.inner)}>
        <div className={styles.layout}>
          <section className={cn(page.tile, page.rise, styles.calendar)} aria-label={L('排期日历', 'Schedule calendar')}>
            <header className={styles.calHead}>
              <div className={styles.calMonth}>
                <span className={styles.calNum}>{pad((mode === 'month' ? month : weekStart.getMonth()) + 1)}</span>
                <span className={styles.calName}>
                  <small>{mode === 'month' ? year : weekStart.getFullYear()}</small>
                  <em>
                    {mode === 'month'
                      ? (lang === 'zh' ? MONTHS_ZH : MONTHS_EN)[month]
                      : `${fmtDate(weekStart.toISOString(), lang)} – ${weekStart.getMonth() === weekEnd.getMonth() && lang === 'zh' ? `${weekEnd.getDate()}日` : fmtDate(weekEnd.toISOString(), lang)}`}
                  </em>
                </span>
              </div>
              <dl className={styles.calStats}>
                <div>
                  <dt>{L('连续记录', 'Streak')}</dt>
                  <dd>
                    {streak}
                    <small>{L('天', streak === 1 ? 'day' : 'days')}</small>
                  </dd>
                </div>
                <div>
                  <dt>{mode === 'month' ? L('本月灵感', 'Ideas this month') : L('本周灵感', 'Ideas this week')}</dt>
                  <dd>
                    {rangeIdeas}
                    <small>{L('条', '')}</small>
                  </dd>
                </div>
                <div>
                  <dt>{mode === 'month' ? L('本月排期', 'Posts this month') : L('本周排期', 'Posts this week')}</dt>
                  <dd>
                    {rangePosts}
                    <small>{L('条', '')}</small>
                  </dd>
                </div>
              </dl>
              <span className={page.grow} />
              <div className={styles.calNav}>
                <Segmented size="sm" value={mode} onValueChange={changeMode} aria-label={L('日历范围', 'Calendar range')}>
                  <SegmentedItem value="month" aria-keyshortcuts="M">{L('月', 'Month')}</SegmentedItem>
                  <SegmentedItem value="week" aria-keyshortcuts="W">{L('周', 'Week')}</SegmentedItem>
                </Segmented>
                <IconButton size="sm" aria-label={mode === 'month' ? L('上个月', 'Previous month') : L('上一周', 'Previous week')} aria-keyshortcuts="ArrowLeft PageUp" onClick={() => go(-1)}>
                  <Icon icon={ChevronLeft} />
                </IconButton>
                <Button size="sm" variant="ghost" aria-keyshortcuts="T" onClick={goToday}>
                  {L('今天', 'Today')}
                </Button>
                <IconButton size="sm" aria-label={mode === 'month' ? L('下个月', 'Next month') : L('下一周', 'Next week')} aria-keyshortcuts="ArrowRight PageDown" onClick={() => go(1)}>
                  <Icon icon={ChevronRight} />
                </IconButton>
              </div>
            </header>

            <div className={styles.weekdays} aria-hidden>
              {weekLabels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>

            <div
              key={`${mode}-${dayKey(cells[0]!)}`}
              className={cn(styles.grid, mode === 'week' && styles.gridWeek)}
              role="grid"
              aria-label={mode === 'month' ? `${year}-${pad(month + 1)}` : `${dayKey(weekStart)} – ${dayKey(weekEnd)}`}
              style={{ '--rows': Math.ceil(cells.length / 7) } as CSSProperties}
            >
              {cells.map((date) => {
                const key = dayKey(date);
                const posts = byDay.get(key) ?? [];
                const ideas = ideaDays.get(key);
                const isToday = key === today;
                const outside = mode === 'month' && date.getMonth() !== month;
                const shown = mode === 'month' ? posts.slice(0, MONTH_CHIPS) : posts;
                const label = dayLabel(date);
                return (
                  <div
                    key={key}
                    role="gridcell"
                    aria-label={[
                      label,
                      isToday ? L('今天', 'today') : '',
                      posts.length ? L(`${posts.length} 条排期`, `${posts.length} scheduled`) : '',
                      ideas?.length ? L(`${ideas.length} 条灵感`, `${ideas.length} ideas`) : '',
                    ].filter(Boolean).join('，')}
                    className={styles.cell}
                    data-outside={outside ? '' : undefined}
                    data-today={isToday ? '' : undefined}
                    data-over={over === key ? '' : undefined}
                    data-past={key < today ? '' : undefined}
                    onDragOver={(event) => {
                      if (!dragHasItem(event)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      if (over !== key) setOver(key);
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => (current === key ? null : current));
                    }}
                    onDrop={(event) => dropOnDay(event, date)}
                  >
                    <div className={styles.cellTop}>
                      <span className={styles.date}>
                        {mode === 'week' ? <small className={styles.dateWeekday}>{weekLabels[date.getDay()]}</small> : null}
                        <span className={styles.dateNum}>{date.getDate()}</span>
                      </span>
                      <Stamp list={ideas} today={isToday} label={label} className={styles.stamp} onOpen={openItem} onCapture={capture} />
                    </div>
                    <div className={styles.posts}>
                      {shown.map((item) => (
                        <CalendarChip key={item.id} item={item} large={mode === 'week'} lang={lang} onOpen={openItem} />
                      ))}
                      {posts.length > shown.length ? (
                        <button type="button" className={styles.more} onClick={() => openWeek(date)}>
                          {L(`还有 ${posts.length - shown.length} 条`, `${posts.length - shown.length} more`)}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <Rail items={content} now={now} byId={byId} onOpen={openItem} onSchedule={setScheduling} />
        </div>
      </div>
      <ScheduleDialog
        item={scheduling ? (byId.get(scheduling.id) ?? scheduling) : null}
        open={scheduling !== null}
        onClose={() => setScheduling(null)}
      />
    </div>
  );
}

function CalendarChip({ item, large, lang, onOpen }: { item: WorkbenchItem; large: boolean; lang: 'zh' | 'en'; onOpen(id: string): void }) {
  const shown = displayItem(item);
  const time = fmtTime(item.scheduledAt!);
  const platform = platformName(item.platform, lang);
  return (
    <button
      type="button"
      draggable
      className={cn(styles.chip, large && styles.chipLarge)}
      data-status={item.status}
      title={`${time} ${shown.title}${platform ? ` · ${platform}` : ''}`}
      onDragStart={(event) => startItemDrag(event, item.id)}
      onClick={() => onOpen(item.id)}
    >
      <ItemCover item={item} className={styles.chipThumb} />
      <span className={styles.chipText}>
        <time dateTime={item.scheduledAt!}>
          {time}
          {large && platform ? ` · ${platform}` : ''}
        </time>
        <span className={styles.chipTitle}>{shown.title}</span>
      </span>
      {item.status === 'published' ? <Icon icon={CircleCheck} size={12} className={styles.chipDone} /> : null}
    </button>
  );
}

function Rail({
  items,
  now,
  byId,
  onOpen,
  onSchedule,
}: {
  items: WorkbenchItem[];
  now: Date;
  byId: Map<string, WorkbenchItem>;
  onOpen(id: string): void;
  onSchedule(item: WorkbenchItem): void;
}) {
  const L = useL();
  const lang = useWorkbenchLang();
  const [over, setOver] = useState(false);
  const upcoming = items
    .filter((item) => item.scheduledAt && item.status !== 'published' && Date.parse(item.scheduledAt) >= now.getTime())
    .sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
  const next = upcoming[0];
  const waiting = items.filter((item) => !item.scheduledAt && item.status !== 'published');
  const produced = (item: WorkbenchItem) => item.production?.status === 'done';
  const ready = waiting
    .filter(produced)
    .sort((a, b) => Date.parse(b.production!.finishedAt ?? b.createdAt) - Date.parse(a.production!.finishedAt ?? a.createdAt));
  const rest = waiting
    .filter((item) => !produced(item))
    .sort((a, b) => ['ready', 'draft', 'outline', 'idea'].indexOf(a.status) - ['ready', 'draft', 'outline', 'idea'].indexOf(b.status) || Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return (
    <aside className={styles.rail} aria-label={L('下一条与待排期', 'Next up and unscheduled')}>
      {next ? (
        <button type="button" className={cn(styles.next, page.rise)} onClick={() => onOpen(next.id)}>
          <span className={styles.nextTop}>
            <span>{L('下一条', 'Next up')}</span>
            <span>{relativeDay(next.scheduledAt!, lang)}</span>
          </span>
          <b className={styles.nextTime}>{fmtTime(next.scheduledAt!)}</b>
          <span className={styles.nextTitle}>{displayItem(next).title}</span>
          <span className={styles.nextFoot}>
            {[next.platform ? platformName(next.platform, lang) : null, statusLabel(next.status, lang), fmtDate(next.scheduledAt!, lang)].filter(Boolean).join(' · ')}
          </span>
          {upcoming.length > 1 ? <span className={styles.nextMore}>{L(`之后还有 ${upcoming.length - 1} 条`, `${upcoming.length - 1} more after this`)}</span> : null}
        </button>
      ) : (
        <div className={cn(styles.nextEmpty, page.rise)}>
          <span className={styles.nextTop}>
            <span>{L('下一条', 'Next up')}</span>
          </span>
          <p>{L('还没有待发布的排期。把下面的内容拖到日历上的某一天。', 'Nothing scheduled yet. Drag something below onto a day.')}</p>
        </div>
      )}

      <section
        className={cn(page.tile, page.rise, styles.tray)}
        data-over={over ? '' : undefined}
        aria-label={L('待排期', 'Unscheduled')}
        style={{ animationDelay: '60ms' }}
        onDragOver={(event) => {
          if (!dragHasItem(event)) return;
          event.preventDefault();
          if (!over) setOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const id = readItemDrag(event);
          const item = id ? byId.get(id) : undefined;
          if (item?.scheduledAt) void workbench.ops([{ op: 'schedule_item', id: item.id, scheduledAt: null }], { label: L('取消排期', 'Unschedule') });
        }}
      >
        <header className={page.tileHead}>
          <h2 className={page.tileTitle}>{L('待排期', 'Unscheduled')}</h2>
          <span className={page.tileMeta}>{over ? L('松手取消排期', 'Drop to unschedule') : L('拖到日历上', 'Drag onto a day')}</span>
        </header>
        <div className={styles.trayScroll}>
          {ready.length ? (
            <>
              <h3 className={styles.trayGroup}>
                {L('已成稿', 'Produced')} <span>{ready.length}</span>
              </h3>
              <div className={styles.trayGrid}>
                {ready.map((item) => (
                  <div key={item.id} className={styles.trayCardWrap}>
                    <button
                      type="button"
                      draggable
                      className={styles.trayCard}
                      onDragStart={(event) => startItemDrag(event, item.id)}
                      onClick={() => onOpen(item.id)}
                    >
                      <ItemCover item={item} fallback="words" className={styles.trayCover} />
                      <span className={styles.trayTitle}>{displayItem(item).title}</span>
                    </button>
                    <IconButton size="xs" variant="frosted" className={styles.trayCardAction} aria-label={L('排期…', 'Schedule…')} onClick={() => onSchedule(item)}>
                      <Icon icon={CalendarPlus} />
                    </IconButton>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          <h3 className={styles.trayGroup}>
            {L('草稿与灵感', 'Drafts and ideas')} <span>{rest.length}</span>
          </h3>
          {!ready.length && !rest.length ? (
            <p className={styles.trayEmpty}>{L('记下灵感或做好稿子后，从这里拖到日历上。', 'Capture ideas or finish drafts, then drag them from here onto the calendar.')}</p>
          ) : null}
          <ul className={styles.trayList}>
            {rest.map((item) => (
              <li key={item.id} className={styles.trayRow}>
                <button
                  type="button"
                  draggable
                  className={styles.trayItem}
                  onDragStart={(event) => startItemDrag(event, item.id)}
                  onClick={() => onOpen(item.id)}
                >
                  <ItemCover item={item} className={styles.trayThumb} />
                  <span className={styles.trayItemTitle}>{displayItem(item).title}</span>
                  <span className={page.statusDot} data-status={item.status} title={statusLabel(item.status, lang)} />
                </button>
                <IconButton size="xs" className={styles.trayRowAction} aria-label={L(`给「${displayItem(item).title}」排期`, `Schedule “${displayItem(item).title}”`)} tooltip={L('排期…', 'Schedule…')} onClick={() => onSchedule(item)}>
                  <Icon icon={CalendarPlus} />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </aside>
  );
}
