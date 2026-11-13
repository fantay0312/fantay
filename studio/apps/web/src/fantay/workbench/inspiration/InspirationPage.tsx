'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — the idea library. A Resurf-style library (rail, Inbox triage, spaces, tags,
 * starred, trash, inspector, reader, resurfacing) around the original desk's idea flow (scatter
 * canvas with related gathering, feed, one-click production).
 * Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
 *   source: client/canvas.jsx HomeView (view switch, kind filter, capture entry) and client/index.jsx
 *   (capture dialog wiring); everything else is new.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react';
import type { WorkbenchItem, WorkbenchSpace } from '@open-design/contracts';
import { ConfirmDialog, dismissToast, toast } from '../../ui';
import { workbenchApi } from '../api';
import { useQuickCaptureRequests, type QuickCaptureRequest } from '../capture-bus';
import { useL } from '../lang';
import { dayKey } from '../shared/format';
import { reportError, useWorkbench, workbench } from '../store';
import type { WorkbenchPageProps } from '../types';
import { ITEM_DRAG_TYPE, captureFiles, captureLink, isInternalDrag } from './capture';
import { CaptureDialog, type CaptureOpen } from './CaptureDialog';
import { CanvasView } from './CanvasView';
import { ActionsContext, StateContext, type LibraryActions, type LibraryState, type PointerMods } from './context';
import { BulkBar, ShuffleButton, ViewDock } from './Dock';
import { FeedView, GridView } from './GridView';
import { Inspector } from './Inspector';
import {
  EMPTY_FILTERS, activeFilterCount, applyFilters, countLibrary, inLibrary, isUrl, matchesQuery, sameNav, scopeItems, sortItems, spaceById, todaysResurface,
  type Density, type LibNav, type LibraryFilters, type SortMode, type ViewMode,
} from './library';
import { LibraryRail } from './LibraryRail';
import { ResurfaceDialog, SpaceDialog, TagEditDialog, TagsDialog, type SpaceDialogState } from './LibraryDialogs';
import { Reader } from './Reader';
import { Toolbar, type SearchState } from './Toolbar';
import { EmptyView, ErrorState, LoadingState, ResurfaceStrip, SearchRow, TrashRow, TriageRow } from './ViewParts';
import styles from './InspirationPage.module.css';

const EMPTY_ITEMS: WorkbenchItem[] = [];
const EMPTY_SPACES: WorkbenchSpace[] = [];
const PREFS_KEY = 'fantay.workbench.inspiration.v1';
const STRIP_KEY = 'fantay.workbench.inspiration.resurface';

interface Prefs { mode: ViewMode; sort: SortMode; density: Density; rail: boolean; inspector: boolean }

function readJson<T>(key: string): Partial<T> {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? '{}') as unknown;
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    return {};
  }
}
function writeJson(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window / blocked storage */ }
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const modalOpen = () => Boolean(document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]'));

interface ConfirmState { kind: 'delete' | 'empty' | 'space'; ids?: string[]; space?: WorkbenchSpace }

export function InspirationPage(props: WorkbenchPageProps) {
  const { active } = props;
  const L = useL();
  const snapshot = useWorkbench();
  const items = snapshot.state?.items ?? EMPTY_ITEMS;
  const spaces = snapshot.state?.spaces ?? EMPTY_SPACES;
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ── first activation ──────────────────────────────────────────────
  const refreshed = useRef(false);
  useEffect(() => {
    if (active && !refreshed.current) {
      refreshed.current = true;
      void workbench.refresh();
    }
  }, [active]);

  // ── view preferences (per viewer) ─────────────────────────────────
  const [mode, setMode] = useState<ViewMode>('grid');
  const [sort, setSort] = useState<SortMode>('newest');
  const [density, setDensity] = useState<Density>('m');
  const [railOpen, setRailOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [seed, setSeed] = useState(1);
  useEffect(() => {
    const p = readJson<Prefs>(PREFS_KEY);
    if (p.mode === 'grid' || p.mode === 'canvas' || p.mode === 'feed') setMode(p.mode);
    if (p.sort === 'newest' || p.sort === 'oldest' || p.sort === 'updated' || p.sort === 'random') setSort(p.sort);
    if (p.density === 's' || p.density === 'm' || p.density === 'l') setDensity(p.density);
    if (typeof p.rail === 'boolean') setRailOpen(p.rail);
    if (typeof p.inspector === 'boolean') setInspectorOpen(p.inspector);
    setSeed(Math.floor(Math.random() * 1e9));
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (prefsLoaded) writeJson(PREFS_KEY, { mode, sort, density, rail: railOpen, inspector: inspectorOpen });
  }, [prefsLoaded, mode, sort, density, railOpen, inspectorOpen]);

  // ── navigation history ────────────────────────────────────────────
  const [history, setHistory] = useState<{ stack: LibNav[]; index: number }>({ stack: [{ kind: 'library' }], index: 0 });
  const nav = history.stack[history.index] ?? { kind: 'library' as const };
  const navigateTo = useCallback((next: LibNav, replace = false) => {
    setHistory((h) => {
      const current = h.stack[h.index];
      if (current && sameNav(current, next)) return h;
      if (replace) {
        const stack = [...h.stack];
        stack[h.index] = next;
        return { stack, index: h.index };
      }
      const stack = [...h.stack.slice(0, h.index + 1), next].slice(-60);
      return { stack, index: stack.length - 1 };
    });
  }, []);
  const back = useCallback(() => setHistory(h => (h.index > 0 ? { ...h, index: h.index - 1 } : h)), []);
  const forward = useCallback(() => setHistory(h => (h.index < h.stack.length - 1 ? { ...h, index: h.index + 1 } : h)), []);

  // A deleted space (or a tag that no longer exists) falls back to the library.
  useEffect(() => {
    if (snapshot.status !== 'ready') return;
    if (nav.kind === 'space' && !spaces.some(space => space.id === nav.id)) navigateTo({ kind: 'library' }, true);
  }, [snapshot.status, nav, spaces, navigateTo]);

  // ── filters & search ──────────────────────────────────────────────
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS);
  const [search, setSearch] = useState<SearchState>({ query: '', mode: 'text', open: false, busy: false, failed: false });
  const [remote, setRemote] = useState<{ key: string; hits: Map<string, number> } | null>(null);
  const query = search.query.trim();
  useEffect(() => {
    if (!query) {
      setRemote(null);
      setSearch(s => (s.busy || s.failed ? { ...s, busy: false, failed: false } : s));
      return undefined;
    }
    const controller = new AbortController();
    const key = `${search.mode}:${query}`;
    const timer = setTimeout(async () => {
      setSearch(s => ({ ...s, busy: true }));
      try {
        const response = await workbenchApi.search(query, search.mode, controller.signal);
        setRemote({ key, hits: new Map(response.hits.map(hit => [hit.id, hit.score])) });
        setSearch(s => ({ ...s, busy: false, failed: false }));
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') return;
        setRemote(null);
        setSearch(s => ({ ...s, busy: false, failed: true }));
      }
    }, search.mode === 'meaning' ? 380 : 260);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, search.mode]);

  // ── derived lists ─────────────────────────────────────────────────
  const byId = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  const counts = useMemo(() => countLibrary(items), [items]);
  const roots = useMemo(() => items.filter(inLibrary), [items]);
  const scoped = useMemo(() => scopeItems(items, nav), [items, nav]);
  const filtered = useMemo(() => applyFilters(scoped, filters), [scoped, filters]);
  const hits = remote && remote.key === `${search.mode}:${query}` ? remote.hits : null;
  const byMeaning = Boolean(query) && search.mode === 'meaning' && Boolean(hits) && !search.failed;
  const visible = useMemo(() => {
    if (!query) return sortItems(filtered, sort, seed);
    if (byMeaning && hits) return filtered.filter(item => hits.has(item.id)).sort((a, b) => (hits.get(b.id) ?? 0) - (hits.get(a.id) ?? 0));
    return sortItems(filtered.filter(item => matchesQuery(item, query) || Boolean(hits?.has(item.id))), sort, seed);
  }, [filtered, query, byMeaning, hits, sort, seed]);
  const feedItems = useMemo(() => {
    if (byMeaning) return visible;
    return sort === 'newest' || sort === 'oldest' ? visible : sortItems(visible, 'newest', seed);
  }, [visible, sort, seed, byMeaning]);
  const spaceMap = useMemo(() => new Map(spaces.map(space => [space.id, space])), [spaces]);
  const currentSpace = nav.kind === 'space' ? spaceById(spaces, nav.id) : null;
  const effectiveMode: ViewMode = nav.kind === 'trash' && mode === 'canvas' ? 'grid' : mode;
  const filteredOut = Boolean(query) || activeFilterCount(filters) > 0;

  // ── selection ─────────────────────────────────────────────────────
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [organizing, setOrganizing] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    // Leaving the view drops the selection; items that vanish from it leave the selection.
    setSelection((current) => {
      if (!current.size) return current;
      const shown = new Set(visible.map(item => item.id));
      const next = [...current].filter(id => shown.has(id));
      return next.length === current.size ? current : new Set(next);
    });
  }, [visible]);
  useEffect(() => {
    setSelection(new Set());
    anchorRef.current = null;
  }, [history.index, history.stack]);

  // ── dialogs ───────────────────────────────────────────────────────
  const [captureRequest, setCaptureRequest] = useState<CaptureOpen | null>(null);
  const [readerId, setReaderId] = useState<string | null>(null);
  const [spaceDialog, setSpaceDialog] = useState<SpaceDialogState | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagEditIds, setTagEditIds] = useState<string[] | null>(null);
  const [resurfaceOpen, setResurfaceOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [canvasFocus, setCanvasFocus] = useState(0);
  const [dropHint, setDropHint] = useState(false);

  const captureTarget = useMemo(() => ({
    spaceId: nav.kind === 'space' ? nav.id : null,
    tags: nav.kind === 'tag' ? [nav.tag] : [],
  }), [nav]);

  const openCapture = useCallback((request: QuickCaptureRequest = {}) => {
    setCaptureRequest({
      ...request,
      spaceId: request.spaceId !== undefined ? request.spaceId : captureTarget.spaceId,
      tags: captureTarget.tags,
    });
  }, [captureTarget]);
  useQuickCaptureRequests(request => openCapture(request));

  // ── actions (one stable object; reads the latest state through a ref) ──
  const live = useRef({ visible, selection, byId, nav, props, L, spaces, inspectorOpen });
  live.current = { visible, selection, byId, nav, props, L, spaces, inspectorOpen };

  const actions = useMemo<LibraryActions>(() => {
    const cur = () => live.current;
    const targetsFor = (id: string) => (cur().selection.has(id) ? [...cur().selection] : [id]);
    const organize = async (ids: string[]) => {
      const say = cur().L;
      if (!ids.length) return;
      setOrganizing(current => new Set([...current, ...ids]));
      const progress = toast({ title: say(`AI 正在整理 ${ids.length} 条…`, `Organising ${ids.length} idea${ids.length === 1 ? '' : 's'}…`), busy: true, duration: 0 });
      try {
        const response = await workbenchApi.organize(ids);
        workbench.setState(response.state);
        dismissToast(progress);
        if (response.errors.length) {
          toast({ title: say(`整理了 ${response.organized.length} 条，${response.errors.length} 条没完成`, `Organised ${response.organized.length}; ${response.errors.length} failed`), description: response.errors[0], tone: 'danger' });
        } else {
          toast({ title: say(`已整理 ${response.organized.length} 条：标题、标签、摘要都补好了`, `Organised ${response.organized.length}: titles, tags and summaries added`), tone: 'success' });
        }
      } catch (error) {
        dismissToast(progress);
        reportError(error, say('AI 整理没有完成', 'AI organise did not finish'));
      } finally {
        setOrganizing((current) => {
          const next = new Set(current);
          ids.forEach(id => next.delete(id));
          return next;
        });
      }
    };
    return {
      select(id: string, mods?: PointerMods) {
        const { visible: list, selection: current } = cur();
        const additive = Boolean(mods?.metaKey || mods?.ctrlKey);
        if (mods?.shiftKey && anchorRef.current) {
          const order = list.map(item => item.id);
          const a = order.indexOf(anchorRef.current);
          const b = order.indexOf(id);
          if (a >= 0 && b >= 0) {
            const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
            setSelection(new Set(additive ? [...current, ...range] : range));
            return;
          }
        }
        anchorRef.current = id;
        if (additive) {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          setSelection(next);
          return;
        }
        setSelection(current.size === 1 && current.has(id) ? current : new Set([id]));
      },
      setSelection(ids, anchor) {
        if (anchor !== undefined) anchorRef.current = anchor;
        setSelection(new Set(ids));
      },
      clearSelection() {
        setSelection(current => (current.size ? new Set() : current));
      },
      open(id) {
        anchorRef.current = id;
        setSelection(new Set([id]));
        setInspectorOpen(true);
      },
      openReader(id) {
        setReaderId(id);
      },
      star(ids, starred) {
        const say = cur().L;
        void workbench.ops([{ op: 'star_items', ids, starred }], { label: starred ? say('加星标', 'Star') : say('取消星标', 'Unstar') });
      },
      moveToSpace(ids, spaceId) {
        const say = cur().L;
        const space = spaceById(cur().spaces, spaceId);
        void workbench.ops([{ op: 'move_to_space', ids, spaceId }], { label: space ? say(`移到「${space.name}」`, `Move to ${space.name}`) : say('移出空间', 'Remove from space') });
      },
      keep(ids) {
        void workbench.ops([{ op: 'keep_items', ids }], { label: cur().L('保留', 'Keep') });
      },
      trash(ids) {
        void workbench.ops([{ op: 'trash_items', ids }], { label: cur().L('移到回收站', 'Move to Trash') });
      },
      restore(ids) {
        void workbench.ops([{ op: 'restore_items', ids }], { label: cur().L('恢复', 'Restore') });
      },
      deleteForever(ids) {
        setConfirm({ kind: 'delete', ids });
      },
      organize,
      produce(id, withImages) {
        cur().props.produce(id, withImages);
      },
      openProduction(id) {
        cur().props.openItem(id);
      },
      editTags(ids) {
        setTagEditIds(ids);
      },
      createSpace(moveIds) {
        setSpaceDialog({ space: null, moveIds: moveIds ?? [] });
      },
      navigate(next) {
        navigateTo(next);
      },
      gotoPage(page) {
        cur().props.navigate(page);
      },
      openSettings() {
        cur().props.openSettings();
      },
      capture(request) {
        openCapture(request);
      },
      ask(prompt) {
        cur().props.openAssistant(prompt);
      },
      targetsFor,
      dragStart(id, event) {
        const ids = targetsFor(id);
        const titles = ids.map(row => cur().byId.get(row)?.title).filter(Boolean).join('\n');
        event.dataTransfer.setData(ITEM_DRAG_TYPE, JSON.stringify(ids));
        event.dataTransfer.setData('text/plain', titles);
        event.dataTransfer.effectAllowed = 'copyMove';
        if (!cur().selection.has(id)) {
          anchorRef.current = id;
          setSelection(new Set([id]));
        }
      },
    };
  }, [navigateTo, openCapture]);

  const stateValue = useMemo<LibraryState>(() => ({ items, byId, spaces, selection, nav, organizing }), [items, byId, spaces, selection, nav, organizing]);

  // ── keyboard ──────────────────────────────────────────────────────
  const focusCard = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const card = rootRef.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`);
      if (!card) return;
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && event.shiftKey && key === 'f') {
        event.preventDefault();
        setSearch(s => ({ ...s, open: true }));
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }
      if (isTyping(event.target) || modalOpen()) return;
      const { visible: list, selection: current, nav: where, spaces: spaceList, byId: rows } = live.current;
      if (mod && event.key === '[') { event.preventDefault(); back(); return; }
      if (mod && event.key === ']') { event.preventDefault(); forward(); return; }
      if (mod && key === 'i') { event.preventDefault(); setInspectorOpen(v => !v); return; }
      if (mod && key === 'a') { event.preventDefault(); actions.setSelection(list.map(item => item.id), list[0]?.id ?? null); return; }
      if (mod || event.altKey) return;

      const order = list.map(item => item.id);
      const focus = anchorRef.current && current.has(anchorRef.current) ? anchorRef.current : [...current][0] ?? null;
      const ids = [...current];
      const step = (delta: number) => {
        if (!order.length) return;
        const index = focus ? order.indexOf(focus) : -1;
        const next = order[index < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, index + delta))];
        if (!next) return;
        actions.setSelection([next], next);
        focusCard(next);
      };
      /** After items leave the view, the cursor moves on to the next one (Resurf triage). */
      const advance = () => {
        if (!focus) return;
        const gone = new Set(ids);
        const index = order.indexOf(focus);
        const next = order.slice(index + 1).find(id => !gone.has(id)) ?? order.slice(0, Math.max(index, 0)).reverse().find(id => !gone.has(id));
        if (next) {
          actions.setSelection([next], next);
          focusCard(next);
        } else actions.clearSelection();
      };

      if (key === 'j') { event.preventDefault(); step(1); return; }
      if (key === 'k') { event.preventDefault(); step(-1); return; }
      if (event.key === 'Escape') {
        if (current.size) { event.preventDefault(); actions.clearSelection(); }
        return;
      }
      if (!ids.length) return;
      const inTrash = where.kind === 'trash';
      if (key === 's' && !inTrash) {
        event.preventDefault();
        const allStarred = ids.every(id => rows.get(id)?.starred);
        actions.star(ids, !allStarred);
        return;
      }
      if (key === 'e' && !inTrash) {
        event.preventDefault();
        const untriaged = ids.filter(id => !rows.get(id)?.triagedAt);
        if (!untriaged.length) return;
        if (where.kind === 'inbox') advance();
        actions.keep(untriaged);
        return;
      }
      if (/^[1-9]$/.test(event.key) && !inTrash) {
        const space = spaceList[Number(event.key) - 1];
        if (!space) return;
        event.preventDefault();
        if (where.kind === 'inbox' || (where.kind === 'space' && where.id !== space.id)) advance();
        actions.moveToSpace(ids, space.id);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        if (inTrash) { actions.deleteForever(ids); return; }
        advance();
        actions.trash(ids);
        return;
      }
      if (event.key === 'Enter' && focus) {
        event.preventDefault();
        actions.open(focus);
        return;
      }
      if (key === 'r' && focus && rows.get(focus)?.kind === 'web') {
        event.preventDefault();
        actions.openReader(focus);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, actions, back, forward, focusCard]);

  // ── paste anywhere ────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      if (isTyping(event.target) || modalOpen()) return;
      const say = live.current.L;
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length) {
        event.preventDefault();
        void captureFiles(files, captureTarget, say);
        return;
      }
      const text = event.clipboardData?.getData('text/plain')?.trim();
      if (!text) return;
      event.preventDefault();
      if (isUrl(text)) void captureLink(text, captureTarget, say);
      else openCapture({ tab: 'note', text });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [active, captureTarget, openCapture]);

  // ── drop anywhere ─────────────────────────────────────────────────
  const external = (event: DragEvent) => {
    if (isInternalDrag(event.dataTransfer)) return false;
    const types = [...event.dataTransfer.types];
    return types.includes('Files') || types.includes('text/uri-list');
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!external(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dropHint) setDropHint(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setDropHint(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDropHint(false);
    if (!external(event)) return;
    event.preventDefault();
    const files = [...event.dataTransfer.files];
    if (files.length) { void captureFiles(files, captureTarget, L); return; }
    const url = (event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')).split('\n').map(line => line.trim()).find(line => isUrl(line));
    if (url) void captureLink(url, captureTarget, L);
  };

  // ── today's resurfacing ───────────────────────────────────────────
  const [strip, setStrip] = useState<{ day: string; ids: string[]; hidden: boolean } | null>(null);
  useEffect(() => {
    if (snapshot.status !== 'ready' || !items.length) return;
    const day = dayKey(new Date());
    if (strip?.day === day) return;
    const stored = readJson<{ day: string; ids: string[]; hidden: boolean }>(STRIP_KEY);
    if (stored.day === day && Array.isArray(stored.ids)) {
      setStrip({ day, ids: stored.ids, hidden: Boolean(stored.hidden) });
      return;
    }
    const ids = todaysResurface(items).map(item => item.id);
    const next = { day, ids, hidden: false };
    writeJson(STRIP_KEY, next);
    setStrip(next);
    if (ids.length) void workbench.ops([{ op: 'mark_surfaced', ids }], { undoable: false, quiet: true });
  }, [snapshot.status, items, strip?.day]);
  const stripItems = strip && !strip.hidden ? strip.ids.map(id => byId.get(id)).filter((item): item is WorkbenchItem => Boolean(item && inLibrary(item))) : [];
  const showStrip = nav.kind === 'library' && !filteredOut && stripItems.length > 0 && effectiveMode !== 'canvas';

  // ── confirm dialogs ───────────────────────────────────────────────
  const runConfirm = () => {
    const current = confirm;
    setConfirm(null);
    if (!current) return;
    if (current.kind === 'delete' && current.ids?.length) {
      void workbench.ops(current.ids.map(id => ({ op: 'delete_item' as const, id })), { label: L('永久删除', 'Delete forever') });
    } else if (current.kind === 'empty') {
      void workbench.ops([{ op: 'empty_trash' }], { label: L('清空回收站', 'Empty Trash') });
    } else if (current.kind === 'space' && current.space) {
      if (nav.kind === 'space' && nav.id === current.space.id) navigateTo({ kind: 'library' }, true);
      void workbench.ops([{ op: 'delete_space', id: current.space.id }], { label: L('删除空间', 'Delete space') });
    }
  };
  const confirmCopy = (() => {
    if (!confirm) return { title: '', description: '', label: '' };
    if (confirm.kind === 'delete') {
      const n = confirm.ids?.length ?? 0;
      return { title: L(`永久删除 ${n} 条灵感？`, `Delete ${n} idea${n === 1 ? '' : 's'} forever?`), description: L('删除后不能恢复，成稿和高亮也会一起删掉。', 'This cannot be undone; productions and highlights go too.'), label: L('永久删除', 'Delete forever') };
    }
    if (confirm.kind === 'empty') {
      return { title: L('清空回收站？', 'Empty the Trash?'), description: L(`回收站里的 ${counts.trash} 条会被永久删除，不能恢复。`, `${counts.trash} item${counts.trash === 1 ? '' : 's'} will be deleted for good.`), label: L('清空回收站', 'Empty Trash') };
    }
    const n = counts.spaces[confirm.space?.id ?? ''] ?? 0;
    return { title: L(`删除空间「${confirm.space?.name ?? ''}」？`, `Delete the space "${confirm.space?.name ?? ''}"?`), description: L(`空间里的 ${n} 条灵感不会删除，会留在灵感库里。`, `Its ${n} idea${n === 1 ? '' : 's'} stay in the library.`), label: L('删除空间', 'Delete space') };
  })();

  // ── content ───────────────────────────────────────────────────────
  const selectedIds = [...selection];
  const bulkVisible = selection.size >= 2 || (selection.size === 1 && !inspectorOpen);
  const loading = !snapshot.state && (snapshot.status === 'idle' || snapshot.status === 'loading');
  const header = (
    <>
      {showStrip ? (
        <ResurfaceStrip
          items={stripItems}
          onMore={() => setResurfaceOpen(true)}
          onHide={() => {
            if (!strip) return;
            const next = { ...strip, hidden: true };
            writeJson(STRIP_KEY, next);
            setStrip(next);
          }}
        />
      ) : null}
      {query ? (
        <SearchRow query={query} count={visible.length} mode={search.mode} busy={search.busy} failed={search.failed} onClear={() => setSearch(s => ({ ...s, query: '' }))} />
      ) : null}
      {nav.kind === 'inbox' && visible.length && !query ? (
        <TriageRow
          count={counts.inbox}
          spaces={spaces.length}
          organizing={scoped.some(item => organizing.has(item.id))}
          onOrganize={() => { void actions.organize(scoped.map(item => item.id)); }}
        />
      ) : null}
      {nav.kind === 'trash' && visible.length && !query ? <TrashRow count={counts.trash} onEmpty={() => setConfirm({ kind: 'empty' })} /> : null}
    </>
  );

  let content: ReactElement;
  if (snapshot.status === 'error' && !snapshot.state) {
    content = <ErrorState message={snapshot.error} onRetry={() => { void workbench.refresh(); }} />;
  } else if (loading) {
    content = <LoadingState />;
  } else if (effectiveMode === 'canvas') {
    content = (
      <CanvasView
        roots={roots}
        shown={visible}
        allItems={items}
        selection={selection}
        spaces={spaceMap}
        target={captureTarget}
        focusSignal={canvasFocus}
      />
    );
  } else if (!visible.length) {
    content = (
      <>
        {query ? <div className={styles.emptyHeader}>{header}</div> : null}
        <EmptyView nav={nav} filtered={filteredOut && scoped.length > 0} onClearFilters={() => { setFilters(EMPTY_FILTERS); setSearch(s => ({ ...s, query: '' })); }} />
      </>
    );
  } else if (effectiveMode === 'feed') {
    content = <FeedView items={feedItems} selection={selection} spaces={spaceMap} hideSpace={nav.kind === 'space'} header={header} draggable={nav.kind !== 'trash'} />;
  } else {
    content = <GridView items={visible} density={density} selection={selection} spaces={spaceMap} hideSpace={nav.kind === 'space'} header={header} draggable={nav.kind !== 'trash'} />;
  }

  const inboxIds = useMemo(() => items.filter(item => inLibrary(item) && !item.triagedAt).map(item => item.id), [items]);
  const anyOrganizing = organizing.size > 0;

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={stateValue}>
        <div
          ref={rootRef}
          className={styles.page}
          data-active={active ? '' : undefined}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <LibraryRail
            open={railOpen}
            onCollapse={() => setRailOpen(false)}
            nav={nav}
            counts={counts}
            spaces={spaces}
            onOpenTags={() => setTagsOpen(true)}
            onEditSpace={space => setSpaceDialog({ space, moveIds: [] })}
            onDeleteSpace={space => setConfirm({ kind: 'space', space })}
            onImport={props.openImport}
          />
          <main className={styles.main}>
            <Toolbar
              railOpen={railOpen}
              onExpandRail={() => setRailOpen(true)}
              canBack={history.index > 0}
              canForward={history.index < history.stack.length - 1}
              onBack={back}
              onForward={forward}
              nav={nav}
              space={currentSpace}
              count={visible.length}
              total={scoped.length}
              filters={filters}
              onFilters={setFilters}
              search={search}
              onSearch={patch => setSearch(s => ({ ...s, ...patch }))}
              searchRef={searchRef}
              selectionCount={selection.size}
              inboxCount={inboxIds.length}
              organizing={anyOrganizing}
              onOrganizeSelected={() => { void actions.organize(selectedIds); }}
              onOrganizeInbox={() => { void actions.organize(inboxIds); }}
              onAsk={prompt => props.openAssistant(prompt)}
              onAskSelected={() => {
                const titles = selectedIds.map(id => byId.get(id)?.title).filter(Boolean).slice(0, 10);
                props.openAssistant(L(`关于这 ${selectedIds.length} 条灵感：${titles.map(t => `「${t}」`).join('、')}。`, `About these ${selectedIds.length} ideas: ${titles.map(t => `"${t}"`).join(', ')}. `));
              }}
              onCapture={() => {
                if (effectiveMode === 'canvas') setCanvasFocus(v => v + 1);
                else openCapture();
              }}
              inspectorOpen={inspectorOpen}
              onToggleInspector={() => setInspectorOpen(v => !v)}
            />
            <div className={styles.viewport}>
              {content}
              <ShuffleButton onClick={() => setResurfaceOpen(true)} />
              <ViewDock
                hidden={bulkVisible}
                mode={effectiveMode}
                onMode={setMode}
                sort={sort}
                onSort={(next) => { setSort(next); if (next === 'random') setSeed(Math.floor(Math.random() * 1e9)); }}
                density={density}
                onDensity={setDensity}
                canvasAllowed={nav.kind !== 'trash'}
              />
              <BulkBar ids={selectedIds} visible={bulkVisible} inTrash={nav.kind === 'trash'} />
              <div className={styles.dropHint} data-show={dropHint ? '' : undefined} aria-hidden>
                <span>{currentSpace ? L(`松手放进「${currentSpace.name}」`, `Drop to save into ${currentSpace.name}`) : L('松手放进收件箱', 'Drop to save to the Inbox')}</span>
              </div>
            </div>
          </main>
          <Inspector open={inspectorOpen} onClose={() => setInspectorOpen(false)} />

          <CaptureDialog request={captureRequest} onClose={() => setCaptureRequest(null)} />
          <Reader itemId={readerId} onClose={() => setReaderId(null)} />
          <SpaceDialog request={spaceDialog} onClose={() => setSpaceDialog(null)} />
          <TagsDialog open={tagsOpen} onClose={() => setTagsOpen(false)} />
          <TagEditDialog ids={tagEditIds} onClose={() => setTagEditIds(null)} />
          <ResurfaceDialog open={resurfaceOpen} onClose={() => setResurfaceOpen(false)} />
          <ConfirmDialog
            open={Boolean(confirm)}
            onOpenChange={(next) => { if (!next) setConfirm(null); }}
            title={confirmCopy.title}
            description={confirmCopy.description}
            confirmLabel={confirmCopy.label}
            cancelLabel={L('取消', 'Cancel')}
            destructive
            onConfirm={runConfirm}
          />
        </div>
      </StateContext.Provider>
    </ActionsContext.Provider>
  );
}
