'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — 画布: the infinite scatter canvas. Pan by dragging the ground or with the
 * wheel, zoom with ⌘/Ctrl + wheel or pinch, drag cards to place them (saved as `pos`). Typing in the
 * centre composer pulls related ideas around it ("相关的灵感自己凑过来"); ↵ records the sentence.
 * Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
 *   source: client/canvas.jsx (useCamera, Hero, Node, Scatter) and client/stamps.jsx (MiniStamps).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type FocusEvent, type FormEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { WorkbenchItem, WorkbenchSpace } from '@open-design/contracts';
import { workbenchMediaUrl } from '@open-design/contracts';
import { ArrowUp, ArrowUpRight, LocateFixed, Plus, Sparkles, ZoomIn, ZoomOut } from 'lucide-react';
import { Button, Icon, IconButton, Input } from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { SPRING_SOFT, computeStreak, dayKey, hash, posterOf, reducedMotion } from '../shared/format';
import { workbench } from '../store';
import { captureLink, captureText, type CaptureTarget } from './capture';
import { useActions } from './context';
import { ItemCard } from './ItemCard';
import { cardSize, scatterLayout, type ScatterSpot } from './layout';
import { isUrl } from './library';
import { relatedIdeas, relatedLayout } from './related';
import styles from './CanvasView.module.css';

interface Cam {
  x: number; y: number; s: number;
  vx: number; vy: number; vs: number;
  tx: number; ty: number; ts: number;
  raf: number; stiffness: number; damping: number;
}
interface FlyTarget { x: number; y: number; s: number }
interface FlyOptions { instant?: boolean; stiffness?: number; damping?: number }

/** A spring-driven camera written straight to the DOM (no React render per frame). */
function useCamera(stageRef: RefObject<HTMLDivElement>, worldRef: RefObject<HTMLDivElement>) {
  const cam = useRef<Cam>({ x: 0, y: 0, s: 1, vx: 0, vy: 0, vs: 0, tx: 0, ty: 0, ts: 1, raf: 0, stiffness: 90, damping: 17 });
  const apply = useCallback(() => {
    const c = cam.current;
    const world = worldRef.current;
    const stage = stageRef.current;
    if (!world || !stage) return;
    world.style.transform = `translate3d(${c.x}px, ${c.y}px, 0) scale(${c.s})`;
    world.style.setProperty('--px', `${c.x / c.s}px`);
    world.style.setProperty('--py', `${c.y / c.s}px`);
    stage.style.setProperty('--grid-x', `${c.x}px`);
    stage.style.setProperty('--grid-y', `${c.y}px`);
    stage.style.setProperty('--grid-size', `${28 * c.s}px`);
  }, [stageRef, worldRef]);
  const tick = useCallback(() => {
    const c = cam.current;
    const k = c.stiffness;
    const d = c.damping;
    const dt = 1 / 60;
    c.vx += (k * (c.tx - c.x) - d * c.vx) * dt;
    c.vy += (k * (c.ty - c.y) - d * c.vy) * dt;
    c.vs += (k * (c.ts - c.s) - d * c.vs) * dt;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.s += c.vs * dt;
    apply();
    const idle = Math.abs(c.tx - c.x) < 0.2 && Math.abs(c.ty - c.y) < 0.2 && Math.abs(c.ts - c.s) < 0.0005 && Math.abs(c.vx) + Math.abs(c.vy) < 0.5;
    if (idle) {
      Object.assign(c, { x: c.tx, y: c.ty, s: c.ts, vx: 0, vy: 0, vs: 0, raf: 0 });
      apply();
      return;
    }
    c.raf = requestAnimationFrame(tick);
  }, [apply]);
  const flyTo = useCallback((target: FlyTarget, { instant = false, stiffness = 90, damping = 17 }: FlyOptions = {}) => {
    const c = cam.current;
    Object.assign(c, { tx: target.x, ty: target.y, ts: target.s, stiffness, damping });
    if (instant || reducedMotion()) {
      cancelAnimationFrame(c.raf);
      Object.assign(c, { x: c.tx, y: c.ty, s: c.ts, vx: 0, vy: 0, vs: 0, raf: 0 });
      apply();
      return;
    }
    if (!c.raf) c.raf = requestAnimationFrame(tick);
  }, [apply, tick]);
  const halt = useCallback(() => {
    const c = cam.current;
    cancelAnimationFrame(c.raf);
    Object.assign(c, { raf: 0, vx: 0, vy: 0, vs: 0, tx: c.x, ty: c.y, ts: c.s });
  }, []);
  useEffect(() => () => cancelAnimationFrame(cam.current.raf), []);
  return { cam, flyTo, halt };
}

const WEEKDAYS: Array<[string, string]> = [['周日', 'Sun'], ['周一', 'Mon'], ['周二', 'Tue'], ['周三', 'Wed'], ['周四', 'Thu'], ['周五', 'Fri'], ['周六', 'Sat']];

function InlinePic({ src }: { src: string | null }) {
  const url = workbenchMediaUrl(src);
  if (!url) return <span className={`${styles.inlinePic} ${styles.inlineEmpty}`} />;
  return <img className={styles.inlinePic} src={url} alt="" draggable={false} referrerPolicy="no-referrer" />;
}

/** The last ten days as stamps: a picture or the first letter of that day's idea. */
function MiniStamps({ roots, onCapture }: { roots: WorkbenchItem[]; onCapture(): void }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const actions = useActions();
  const days = useMemo(() => {
    const map = new Map<string, WorkbenchItem[]>();
    for (const item of roots) {
      const key = dayKey(item.createdAt);
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return map;
  }, [roots]);
  const now = new Date();
  const cells: Date[] = [];
  for (let i = 9; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    cells.push(d);
  }
  return (
    <div className={styles.stamps}>
      {cells.map((d) => {
        const key = dayKey(d);
        const list = days.get(key);
        const today = key === dayKey(now);
        const label = lang === 'zh' ? `${d.getMonth() + 1}月${d.getDate()}日` : d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
        if (!list?.length) {
          return (
            <IconButton
              key={key}
              className={styles.stamp}
              data-blank=""
              data-today={today ? '' : undefined}
              disabled={!today}
              aria-label={today ? L('今天还没有记录，记一条', 'Nothing yet today — capture one') : L(`${label} 没有记录`, `${label}: nothing`)}
              onClick={today ? onCapture : undefined}
            >
              {today ? <Icon icon={Plus} size={14} /> : null}
            </IconButton>
          );
        }
        const cover = list.find(item => posterOf(item)) ?? list[0]!;
        const poster = workbenchMediaUrl(posterOf(cover));
        return (
          <IconButton
            key={key}
            className={styles.stamp}
            data-tone={poster ? undefined : hash(cover.id) % 5}
            aria-label={L(`${label}：${cover.title}，共 ${list.length} 条`, `${label}: ${cover.title}, ${list.length} total`)}
            tooltip={`${label} · ${cover.title}${list.length > 1 ? L(` 等 ${list.length} 条`, ` +${list.length - 1}`) : ''}`}
            onClick={() => actions.setSelection(list.map(item => item.id), cover.id)}
          >
            {poster ? <img src={poster} alt="" loading="lazy" draggable={false} /> : <span>{cover.title.slice(0, 1)}</span>}
            {list.length > 1 ? <i>{list.length}</i> : null}
          </IconButton>
        );
      })}
    </div>
  );
}

interface Gathering { query: string; ids: string[]; newId: string | null; pinned: boolean }

interface HeroProps {
  roots: WorkbenchItem[];
  allItems: WorkbenchItem[];
  text: string;
  setText(value: string): void;
  onSubmit(): void;
  busy: boolean;
  related: Gathering | null;
  onRelease(): void;
  inputRef: RefObject<HTMLInputElement>;
}

/** The centre sentence: pictures, words and numbers, then the composer and the stamps. */
function Hero({ roots, allItems, text, setText, onSubmit, busy, related, onRelease, inputRef }: HeroProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  const actions = useActions();
  const pending = roots.filter(item => item.status === 'idea' && !item.production);
  const now = new Date();
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  const upcoming = allItems.filter(item => item.scheduledAt && !item.trashedAt && item.status !== 'published' && new Date(item.scheduledAt) >= now && new Date(item.scheduledAt) <= week);
  const streak = computeStreak(allItems, now);
  const pic = (list: WorkbenchItem[]) => list.map(posterOf).find(Boolean) ?? null;
  const date = lang === 'zh'
    ? `${now.getFullYear()} · ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAYS[now.getDay()]![0]}`
    : `${WEEKDAYS[now.getDay()]![1]} · ${now.toLocaleString('en-US', { month: 'short', day: 'numeric' })}, ${now.getFullYear()}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <section className={styles.hero} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <p className={styles.heroDate}>{date}</p>
      <h1 className={styles.heroLine}>
        {lang === 'zh' ? (
          <>
            还有 <InlinePic src={pic(pending)} /> <b>{pending.length} 个灵感</b> 等你成稿，<br />
            <InlinePic src={pic(upcoming)} /> <b>{upcoming.length} 条内容</b> 排在本周，<br />
            你已经连续记录 <b className={styles.streak}>{streak} 天</b>。
          </>
        ) : (
          <>
            <InlinePic src={pic(pending)} /> <b>{pending.length} idea{pending.length === 1 ? '' : 's'}</b> waiting to be written,<br />
            <InlinePic src={pic(upcoming)} /> <b>{upcoming.length} post{upcoming.length === 1 ? '' : 's'}</b> lined up this week,<br />
            a <b className={styles.streak}>{streak}-day</b> streak.
          </>
        )}
      </h1>
      <form className={styles.composer} onSubmit={submit}>
        <Icon icon={Sparkles} size={16} className={styles.composerIcon} />
        <Input
          ref={inputRef}
          variant="bare"
          inputSize="auto"
          className={styles.composerInput}
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') { if (text) setText(''); else onRelease(); event.stopPropagation(); } }}
          placeholder={L('记下一个灵感，或贴一个链接', 'Jot an idea, or paste a link')}
          aria-label={L('记下灵感', 'Capture an idea')}
          disabled={busy}
        />
        <IconButton type="submit" variant="primary" shape="round" className={styles.send} aria-label={L('记下', 'Save')} shortcut="enter" disabled={!text.trim() || busy}>
          <Icon icon={ArrowUp} size={15} strokeWidth={2} />
        </IconButton>
      </form>
      <div className={styles.heroNote} data-show={related ? '' : undefined} aria-live="polite">
        {related ? (
          <>
            <span>{related.pinned
              ? L(`找到 ${related.ids.length} 条相关的灵感，放在了旁边`, `${related.ids.length} related idea${related.ids.length === 1 ? '' : 's'} pulled alongside`)
              : L(`${related.ids.length} 条相关的灵感凑过来了`, `${related.ids.length} related idea${related.ids.length === 1 ? '' : 's'} came closer`)}</span>
            <Button variant="link" size="sm" className={styles.linkButton} onClick={onRelease}>{L('放回去', 'Put back')}</Button>
            <Button variant="link" size="sm" className={styles.linkButton} onClick={() => actions.setSelection(related.ids, related.ids[0] ?? null)}>{L('全选', 'Select them')}</Button>
          </>
        ) : roots.length === 0 ? (
          <span>{L('写一句话、贴一个链接，或者把图片、视频、PDF 拖进来。', 'Write a sentence, paste a link, or drop images, videos and PDFs here.')}</span>
        ) : (
          <span>{L('边打字，相关的灵感会自己凑过来。', 'As you type, related ideas drift closer.')}</span>
        )}
      </div>
      <MiniStamps roots={roots} onCapture={() => inputRef.current?.focus()} />
      <Button variant="link" size="sm" className={styles.heroMore} onClick={() => actions.capture()}>
        {L('更多记录方式：文件、语音、金句', 'More ways: files, voice, quotes')}
        <Icon icon={ArrowUpRight} size={13} />
      </Button>
    </section>
  );
}

interface NodeProps {
  item: WorkbenchItem;
  pos: ScatterSpot;
  index: number;
  entered: MutableRefObject<Set<string>>;
  selected: boolean;
  tone: 'related' | 'dim' | null;
  space: WorkbenchSpace | null;
}

function Node({ item, pos, index, entered, selected, tone, space }: NodeProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (entered.current.has(item.id)) return;
    entered.current.add(item.id);
    const el = ref.current?.firstElementChild as HTMLElement | null;
    if (!el || reducedMotion() || typeof el.animate !== 'function') return;
    const k = 0.25;
    el.animate([
      { transform: `translate(${-pos.x * k}px, ${-pos.y * k}px) scale(.82) rotate(${(hash(item.id) % 20) - 10}deg)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: SPRING_SOFT.duration + 200, easing: SPRING_SOFT.easing, delay: Math.min(index * 28, 620), fill: 'backwards' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const size = cardSize(item);
  return (
    <div
      ref={ref}
      className={styles.node}
      data-node={item.id}
      data-tone={tone ?? undefined}
      data-selected={selected ? '' : undefined}
      style={{ left: pos.x, top: pos.y, width: size.w, '--r': `${pos.r ?? 0}deg`, '--d': pos.d ?? 0 } as CSSProperties}
    >
      <div className={styles.pop}>
        <ItemCard item={item} variant="canvas" width={size.w} selected={selected} related={tone === 'related'} space={space} />
      </div>
    </div>
  );
}

export interface CanvasViewProps {
  /** Every library idea: the layout and the gathering pool (filters never reshuffle the wall). */
  roots: WorkbenchItem[];
  /** Ideas visible under the current scope, filters and search. */
  shown: WorkbenchItem[];
  /** All items (stats: scheduled this week, streak). */
  allItems: WorkbenchItem[];
  selection: ReadonlySet<string>;
  spaces: Map<string, WorkbenchSpace>;
  /** Where the composer captures to (the current space / tag). */
  target: CaptureTarget;
  /** Bump to fly home and focus the composer. */
  focusSignal: number;
}

export function CanvasView({ roots, shown, allItems, selection, spaces, target, focusSignal }: CanvasViewProps) {
  const L = useL();
  const actions = useActions();
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { cam, flyTo, halt } = useCamera(stageRef, worldRef);
  const dragPos = useRef<Record<string, ScatterSpot>>({});
  const [, force] = useReducer((v: number) => v + 1, 0);
  const entered = useRef(new Set<string>());
  const suppressClick = useRef(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [related, setRelated] = useState<Gathering | null>(null);

  const rootKey = roots.map(item => `${item.id}:${item.pos ? `${item.pos.x},${item.pos.y}` : ''}:${item.production?.cover?.src ?? ''}:${item.media?.w ?? ''}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => scatterLayout(roots), [rootKey]);
  const byId = useMemo(() => new Map(roots.map(item => [item.id, item])), [roots]);

  // Gather while typing (debounced); an empty composer keeps a gathering made by ↵.
  useEffect(() => {
    const value = text.trim();
    if (!value || isUrl(value)) {
      setRelated(current => (current?.pinned ? current : null));
      return undefined;
    }
    const timer = setTimeout(() => {
      const ids = relatedIdeas(roots, value);
      setRelated(ids.length ? { query: value, ids, newId: null, pinned: false } : null);
    }, 220);
    return () => clearTimeout(timer);
  }, [text, roots]);

  const relatedSpots = useMemo(() => {
    if (!related) return {} as Record<string, { x: number; y: number }>;
    return relatedLayout(related.ids.filter(id => byId.has(id) && id !== related.newId).map(id => ({ id, ...cardSize(byId.get(id)!) })));
  }, [related, byId]);

  const posOf = useCallback((item: WorkbenchItem): ScatterSpot => {
    const dragged = dragPos.current[item.id];
    if (dragged) return dragged;
    if (related) {
      // The fresh one sits straight above the sentence; related ones flank it.
      if (item.id === related.newId) return { x: 0, y: -250 - cardSize(item).h / 2, r: 0, d: 0 };
      const spot = relatedSpots[item.id];
      if (spot) return { ...spot, r: 0, d: 0 };
    }
    if (item.pos) return { d: 0, ...item.pos };
    return layout[item.id] ?? { x: 0, y: 0, r: 0, d: 0 };
  }, [layout, related, relatedSpots]);

  const stageBox = useCallback(() => {
    const el = stageRef.current;
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 1000, h: 700 };
  }, []);
  const frameHome = useCallback((): FlyTarget => {
    const { w, h } = stageBox();
    return { x: w / 2, y: h / 2 - 12, s: w < 760 ? 0.66 : w < 1040 ? 0.8 : w < 1400 ? 0.92 : 1 };
  }, [stageBox]);

  useLayoutEffect(() => {
    flyTo(frameHome(), { instant: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!focusSignal) return;
    flyTo(frameHome());
    inputRef.current?.focus();
  }, [focusSignal, flyTo, frameHome]);

  // Frame the gathering together with the sentence.
  useEffect(() => {
    if (!related) return;
    let half = { x: 320, y: 260 };
    for (const [id, p] of Object.entries(relatedSpots)) {
      const item = byId.get(id);
      if (!item) continue;
      const size = cardSize(item);
      half = { x: Math.max(half.x, Math.abs(p.x) + size.w / 2), y: Math.max(half.y, Math.abs(p.y) + size.h / 2) };
    }
    const fresh = related.newId ? byId.get(related.newId) : undefined;
    if (fresh) half.y = Math.max(half.y, 250 + cardSize(fresh).h);
    const home = frameHome();
    const { w, h } = stageBox();
    flyTo({ ...home, s: Math.min(home.s, (w - 80) / (half.x * 2), (h - 170) / (half.y * 2)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relatedSpots, related?.newId]);

  // A new idea may land off screen: bring the camera to it (or seat it above the sentence while gathering).
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    const previous = known.current;
    known.current = new Set(roots.map(item => item.id));
    if (!previous) return;
    const added = roots.find(item => !previous.has(item.id));
    if (!added) return;
    if (related?.pinned && !related.newId) {
      setRelated({ ...related, newId: added.id });
      return;
    }
    const p = posOf(added);
    const size = cardSize(added);
    const { w, h } = stageBox();
    const c = cam.current;
    const margin = 90;
    const left = c.tx + c.ts * (p.x - size.w / 2);
    const right = c.tx + c.ts * (p.x + size.w / 2);
    const top = c.ty + c.ts * (p.y - size.h / 2);
    const bottom = c.ty + c.ts * (p.y + size.h / 2);
    const dx = left < margin ? margin - left : right > w - margin ? w - margin - right : 0;
    const dy = top < margin ? margin - top : bottom > h - margin ? h - margin - bottom : 0;
    if (dx || dy) flyTo({ x: c.tx + dx, y: c.ty + dy, s: c.ts });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    let last = { w: el.clientWidth, h: el.clientHeight };
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // Mounted while the page was hidden (0×0): frame home once it has a size.
      if (!last.w || !last.h) {
        last = { w, h };
        if (w && h) flyTo(frameHome(), { instant: true });
        return;
      }
      const delta = w - last.w;
      last = { w, h };
      if (!delta) return;
      const c = cam.current;
      flyTo({ x: c.tx + delta / 2, y: c.ty, s: c.ts }, { stiffness: 140, damping: 24 });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [cam, flyTo, frameHome]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number, instant = true) => {
    const c = cam.current;
    const s = Math.max(0.25, Math.min(2.2, c.ts * factor));
    const k = s / c.ts;
    flyTo({ x: cx - (cx - c.tx) * k, y: cy - (cy - c.ty) * k, s }, { instant, stiffness: 160, damping: 24 });
  }, [cam, flyTo]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('[data-wheel-scroll]')) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      } else {
        const c = cam.current;
        flyTo({ x: c.tx - event.deltaX, y: c.ty - event.deltaY, s: c.ts }, { instant: true });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [cam, flyTo, zoomAt]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,button,a,audio,video[controls],[data-toolrow]')) return;
    const nodeEl = target.closest<HTMLElement>('[data-node]');
    const startX = event.clientX;
    const startY = event.clientY;
    const c = cam.current;
    let moved = false;
    suppressClick.current = false;
    halt();
    if (nodeEl) {
      const id = nodeEl.dataset.node!;
      const item = byId.get(id);
      if (!item) return;
      const origin = posOf(item);
      const onMove = (e: PointerEvent) => {
        const dx = (e.clientX - startX) / c.s;
        const dy = (e.clientY - startY) / c.s;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        if (!moved) {
          moved = true;
          nodeEl.dataset.dragging = '';
          suppressClick.current = true;
        }
        const next = { x: origin.x + dx, y: origin.y + dy, r: origin.r, d: 0 };
        dragPos.current[id] = next;
        nodeEl.style.left = `${next.x}px`;
        nodeEl.style.top = `${next.y}px`;
      };
      const onUp = async () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        delete nodeEl.dataset.dragging;
        if (!moved) return;
        const next = dragPos.current[id]!;
        setTimeout(() => { suppressClick.current = false; }, 0);
        await workbench.ops([{ op: 'update_item', id, pos: { x: Math.round(next.x), y: Math.round(next.y), r: next.r } }], { undoable: false, quiet: true });
        delete dragPos.current[id];
        force();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }
    const baseX = c.x;
    const baseY = c.y;
    let lastX = startX;
    let lastY = startY;
    let lastT = performance.now();
    let vx = 0;
    let vy = 0;
    stageRef.current?.setAttribute('data-panning', '');
    const onMove = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 4) moved = true;
      const now = performance.now();
      const dt = Math.max(now - lastT, 1);
      vx = (e.clientX - lastX) / dt;
      vy = (e.clientY - lastY) / dt;
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = now;
      flyTo({ x: baseX + e.clientX - startX, y: baseY + e.clientY - startY, s: c.s }, { instant: true });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      stageRef.current?.removeAttribute('data-panning');
      if (moved) flyTo({ x: c.x + vx * 180, y: c.y + vy * 180, s: c.s }, { stiffness: 42, damping: 13 });
      else if (!(event.metaKey || event.ctrlKey || event.shiftKey)) actions.clearSelection();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Keyboard Tab onto an off-screen card: the camera follows.
  const onFocusIn = (event: FocusEvent<HTMLDivElement>) => {
    const node = (event.target as HTMLElement).closest?.('[data-node]');
    if (!node || !(event.target as HTMLElement).matches(':focus-visible')) return;
    const stageRect = stageRef.current!.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const c = cam.current;
    const margin = 72;
    let dx = 0;
    let dy = 0;
    if (rect.left < stageRect.left + margin) dx = stageRect.left + margin - rect.left;
    else if (rect.right > stageRect.right - margin) dx = stageRect.right - margin - rect.right;
    if (rect.top < stageRect.top + margin) dy = stageRect.top + margin - rect.top;
    else if (rect.bottom > stageRect.bottom - margin) dy = stageRect.bottom - margin - rect.bottom;
    if (dx || dy) flyTo({ x: c.tx + dx, y: c.ty + dy, s: c.ts });
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setText('');
    try {
      if (isUrl(value)) {
        await captureLink(value, target, L);
      } else {
        const ids = relatedIdeas(roots, value);
        setRelated(ids.length ? { query: value, ids, newId: null, pinned: true } : null);
        await captureText('note', value, target, L);
      }
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const toneOf = (item: WorkbenchItem): 'related' | 'dim' | null => {
    if (!related) return null;
    if (item.id === related.newId || related.ids.includes(item.id)) return 'related';
    return 'dim';
  };

  const center = (): [number, number] => {
    const { w, h } = stageBox();
    return [w / 2, h / 2];
  };

  return (
    <div
      className={styles.stage}
      ref={stageRef}
      onPointerDown={onPointerDown}
      onClickCapture={(event) => {
        if (suppressClick.current) { event.stopPropagation(); event.preventDefault(); }
      }}
      onFocus={onFocusIn}
      onKeyDown={(event) => { if (event.key === 'Escape' && related) { setRelated(null); event.stopPropagation(); } }}
    >
      <div className={styles.world} ref={worldRef}>
        <div className={styles.heroAnchor}>
          <Hero
            roots={roots}
            allItems={allItems}
            text={text}
            setText={setText}
            onSubmit={() => { void submit(); }}
            busy={busy}
            related={related}
            onRelease={() => setRelated(null)}
            inputRef={inputRef}
          />
        </div>
        {shown.map((item, index) => (
          <Node
            key={item.id}
            item={item}
            pos={posOf(item)}
            index={index}
            entered={entered}
            selected={selection.has(item.id)}
            tone={toneOf(item)}
            space={spaces.get(item.spaceId ?? '') ?? null}
          />
        ))}
      </div>
      <div className={styles.toolrow} data-toolrow="" onPointerDown={event => event.stopPropagation()}>
        <IconButton aria-label={L('缩小', 'Zoom out')} size="sm" onClick={() => zoomAt(0.8, ...center(), false)}><Icon icon={ZoomOut} /></IconButton>
        <IconButton aria-label={L('回到中心', 'Back to centre')} size="sm" onClick={() => flyTo(frameHome())}><Icon icon={LocateFixed} /></IconButton>
        <IconButton aria-label={L('放大', 'Zoom in')} size="sm" onClick={() => zoomAt(1.25, ...center(), false)}><Icon icon={ZoomIn} /></IconButton>
      </div>
    </div>
  );
}
