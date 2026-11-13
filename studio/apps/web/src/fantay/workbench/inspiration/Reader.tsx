'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — Resurf-style reader: the clean text of a saved page, read time, select text
 * to highlight it (or keep it as a 金句), and the highlight list beside the text.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorkbenchHighlight, WorkbenchItem } from '@open-design/contracts';
import { ExternalLink, Highlighter, Quote, RotateCcw, Trash2, X } from 'lucide-react';
import { Button, Icon, IconButton, Modal, ModalTitle, Skeleton } from '../../ui';
import { workbenchApi } from '../api';
import { useL, useWorkbenchLang } from '../lang';
import { relativeDay } from '../shared/format';
import { errorMessage, workbench } from '../store';
import { captureText } from './capture';
import { useLibraryState } from './context';
import { estimateMinutes, faviconOf, hostOf } from './library';
import styles from './Reader.module.css';

function splitParagraphs(text: string): string[] {
  return text.split(/\n+/).map(line => line.trim()).filter(Boolean);
}

/** Wrap every highlight occurrence in a paragraph with <mark>. */
function withMarks(text: string, highlights: WorkbenchHighlight[]): ReactNode {
  const pieces = highlights.flatMap(h => h.text.split(/\n+/).map(t => t.trim()).filter(t => t.length >= 2).map(t => ({ id: h.id, t })));
  if (!pieces.length) return text;
  const ranges: Array<{ start: number; end: number; id: string }> = [];
  for (const piece of pieces) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(piece.t, from);
      if (at < 0) break;
      ranges.push({ start: at, end: at + piece.t.length, id: piece.id });
      from = at + piece.t.length;
    }
  }
  if (!ranges.length) return text;
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) out.push(text.slice(cursor, range.start));
    out.push(<mark key={`${range.id}-${range.start}`} data-h={range.id}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

interface Pick { text: string; x: number; y: number }

function ReaderBody({ item }: { item: WorkbenchItem }) {
  const L = useL();
  const lang = useWorkbenchLang();
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const reader = item.reader;
  const highlights = item.highlights ?? [];
  const text = reader?.text ?? '';

  const load = async () => {
    setStatus('loading');
    setError(null);
    try {
      const response = await workbenchApi.reader(item.id);
      workbench.setState(response.state);
      setStatus('idle');
      if (response.reader.error && !response.reader.text) {
        setError(response.reader.error);
        setStatus('error');
      }
    } catch (err) {
      setError(errorMessage(err));
      setStatus('error');
    }
  };

  useEffect(() => {
    if (!reader?.text && !reader?.error) void load();
    else if (reader?.error && !reader.text) { setError(reader.error); setStatus('error'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const paragraphs = useMemo(() => splitParagraphs(text), [text]);
  const minutes = item.readMinutes ?? (text ? estimateMinutes(text) : null);
  const words = reader?.words;
  const host = hostOf(item.url);
  const favicon = faviconOf(item.url);

  const onSelect = () => {
    const selection = window.getSelection();
    const article = articleRef.current;
    const scroller = scrollRef.current;
    if (!selection || selection.isCollapsed || !article || !scroller || !selection.rangeCount) { setPick(null); return; }
    const range = selection.getRangeAt(0);
    if (!article.contains(range.commonAncestorContainer)) { setPick(null); return; }
    const value = selection.toString().trim();
    if (value.length < 2) { setPick(null); return; }
    const rect = range.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    setPick({ text: value, x: rect.left + rect.width / 2 - frame.left, y: rect.top - frame.top + scroller.scrollTop });
  };

  const highlight = async () => {
    if (!pick) return;
    const value = pick.text;
    setPick(null);
    window.getSelection()?.removeAllRanges();
    await workbench.ops([{ op: 'add_highlight', id: item.id, text: value }], { label: L('高亮', 'Highlight') });
  };
  const keepQuote = async () => {
    if (!pick) return;
    const value = pick.text;
    setPick(null);
    window.getSelection()?.removeAllRanges();
    await captureText('quote', value, { source: reader?.title || item.title, tags: item.tags.slice(0, 3) }, L);
  };
  const jump = (id: string) => {
    const mark = articleRef.current?.querySelector<HTMLElement>(`mark[data-h="${CSS.escape(id)}"]`);
    if (!mark) return;
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark.animate([{ backgroundColor: 'color-mix(in srgb, var(--warning) 70%, transparent)' }, { backgroundColor: '' }], { duration: 900, easing: 'ease-out' });
  };

  return (
    <div className={styles.layout}>
      <div className={styles.scroll} ref={scrollRef} onMouseUp={onSelect} onKeyUp={onSelect} onScroll={() => setPick(null)}>
        <article className={styles.article} ref={articleRef}>
          <p className={styles.site}>
            {favicon ? <img src={favicon} alt="" width={16} height={16} referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} /> : null}
            <span>{reader?.siteName || host || L('网页', 'Web page')}</span>
          </p>
          <h1 className={styles.title}>{reader?.title || item.title}</h1>
          <p className={styles.byline}>
            {[reader?.byline, minutes ? L(`约 ${minutes} 分钟读完`, `${minutes} min read`) : null, words ? L(`${words.toLocaleString()} 字`, `${words.toLocaleString()} words`) : null, reader?.fetchedAt ? L(`抓取于 ${relativeDay(reader.fetchedAt, lang)}`, `Fetched ${relativeDay(reader.fetchedAt, lang)}`) : null].filter(Boolean).join(' · ')}
          </p>
          {status === 'loading' && !text ? (
            <div className={styles.loading} aria-busy>
              {[96, 88, 92, 70, 0, 94, 84, 90, 62].map((w, i) => (w ? <Skeleton key={i} shape="line" index={i} style={{ width: `${w}%` }} /> : <span key={i} className={styles.gap} />))}
              <p className={styles.loadingText}>{L('正在把网页整理成干净的正文…', 'Turning the page into clean text…')}</p>
            </div>
          ) : status === 'error' && !text ? (
            <div className={styles.failed}>
              <p>{L('这个网页的正文没取到。', 'Could not read this page.')}</p>
              {error ? <p className={styles.failedReason}>{error}</p> : null}
              <div className={styles.failedActions}>
                <Button variant="secondary" size="sm" onClick={() => { void load(); }}><Icon icon={RotateCcw} />{L('再试一次', 'Try again')}</Button>
                {item.url ? <Button variant="ghost" size="sm" onClick={() => window.open(item.url!, '_blank', 'noopener,noreferrer')}><Icon icon={ExternalLink} />{L('打开原网页', 'Open original')}</Button> : null}
              </div>
            </div>
          ) : (
            <div className={styles.text}>
              {paragraphs.map((paragraph, index) => (
                /^#{1,3}\s/.test(paragraph)
                  ? <h2 key={index}>{paragraph.replace(/^#{1,3}\s+/, '')}</h2>
                  : <p key={index}>{withMarks(paragraph, highlights)}</p>
              ))}
              {!paragraphs.length ? <p className={styles.emptyText}>{item.summary || item.body || L('这个网页没有可读的正文。', 'This page has no readable text.')}</p> : null}
            </div>
          )}
        </article>
        {pick ? (
          <div className={styles.pick} style={{ left: pick.x, top: pick.y }} onMouseUp={event => event.stopPropagation()}>
            <Button variant="bare" size="sm" className={styles.pickButton} onMouseDown={event => event.preventDefault()} onClick={() => { void highlight(); }}>
              <Icon icon={Highlighter} size={13} />
              {L('高亮', 'Highlight')}
            </Button>
            <span className={styles.pickSep} aria-hidden />
            <Button variant="bare" size="sm" className={styles.pickButton} onMouseDown={event => event.preventDefault()} onClick={() => { void keepQuote(); }}>
              <Icon icon={Quote} size={13} />
              {L('存为金句', 'Save as quote')}
            </Button>
          </div>
        ) : null}
      </div>
      <aside className={styles.side} aria-label={L('高亮', 'Highlights')}>
        <h2 className={styles.sideHead}>
          <Icon icon={Highlighter} size={14} />
          {L('高亮', 'Highlights')}
          <span>{highlights.length}</span>
        </h2>
        {highlights.length ? (
          <ul className={styles.highlightList}>
            {highlights.map(h => (
              <li key={h.id} className={styles.highlight}>
                <Button variant="bare" block className={styles.highlightText} onClick={() => jump(h.id)}>{h.text}</Button>
                <div className={styles.highlightFoot}>
                  <span>{relativeDay(h.at, lang)}</span>
                  <IconButton size="xs" variant="danger" aria-label={L('删除高亮', 'Delete highlight')} onClick={() => { void workbench.ops([{ op: 'delete_highlight', id: item.id, highlightId: h.id }], { label: L('删除高亮', 'Delete highlight') }); }}>
                    <Icon icon={Trash2} />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.sideEmpty}>{L('选中正文里的一段话，点「高亮」留下来。', 'Select a passage in the text and click Highlight to keep it.')}</p>
        )}
      </aside>
    </div>
  );
}

export function Reader({ itemId, onClose }: { itemId: string | null; onClose(): void }) {
  const L = useL();
  const state = useLibraryState();
  const item = itemId ? state.byId.get(itemId) : undefined;
  return (
    <Modal open={Boolean(item)} onClose={onClose} size="2xl" showClose={false} className="flex h-[min(880px,calc(100dvh-40px))] flex-col overflow-hidden p-0" aria-describedby={undefined}>
      {item ? (
        <>
          <header className={styles.bar}>
            <ModalTitle className={styles.barTitle}>{item.reader?.title || item.title}</ModalTitle>
            {item.url ? (
              <Button variant="ghost" size="sm" onClick={() => window.open(item.url!, '_blank', 'noopener,noreferrer')}>
                <Icon icon={ExternalLink} />
                {L('打开原网页', 'Open original')}
              </Button>
            ) : null}
            <IconButton aria-label={L('关闭阅读', 'Close reader')} shortcut="esc" onClick={onClose}><Icon icon={X} /></IconButton>
          </header>
          <ReaderBody key={item.id} item={item} />
        </>
      ) : null}
    </Modal>
  );
}
