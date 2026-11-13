import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { MessageSquare, Palette, TextCursorInput } from 'lucide-react';
import { movieDuration, movieShotStarts, movieTextEdit, movieTextValue, movieTextTargets, type MovieDocument, type MovieEditOperation, type MovieNoteTarget, type MovieReviewNote, type MovieStyle, type MovieTextTarget, type WorkspaceCollabContext } from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { fetchDesignSystems } from '../../providers/registry';
import { Button, Field, Icon, IconButton, Input, Popover, PopoverContent, PopoverTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '../../fantay/ui';
import { StyleFields } from '../../fantay/motion/StyleFields';
import { MovieReviewNotes } from './MovieReviewNotes';
import styles from './MovieLiveTools.module.css';

export interface MovieLiveToolsHandle { editText(target: MovieTextTarget): void }
interface Props {
  document: MovieDocument;
  projectId: string;
  context?: WorkspaceCollabContext | null;
  time: number;
  busy: boolean;
  readOnly: boolean;
  aiBusy: boolean;
  blocked: boolean;
  onPause(): void;
  onSeek(time: number): void;
  onPreview(document: MovieDocument | null): void;
  onApply(label: string, operations: MovieEditOperation[]): Promise<boolean>;
  onStyle(style: MovieStyle): Promise<boolean>;
  onLinkStyle(id: string): Promise<boolean>;
  onAddNote(target: MovieNoteTarget, text: string): Promise<boolean>;
  onSubmitNotes(ids: string[]): Promise<boolean>;
  onResolveNote(note: MovieReviewNote): void;
}

/** Small manual tools over the same revision-checked movie; agent requests stay in the main chat. */
export const MovieLiveTools = forwardRef<MovieLiveToolsHandle, Props>(function MovieLiveTools(p, ref) {
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const d = p.document;
  const [panel, setPanel] = useState<'text' | 'style' | 'notes' | null>(null);
  const [target, setTarget] = useState<MovieTextTarget | null>(null);
  const [text, setText] = useState('');
  const [styleDraft, setStyleDraft] = useState<MovieStyle | null>(null);
  const [noteTarget, setNoteTarget] = useState<MovieNoteTarget>({ scope: 'time', time: 0 });
  const [systems, setSystems] = useState<Array<{ id: string; title: string }>>([]);
  const [systemId, setSystemId] = useState('');
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const textDirty = Boolean(target && text !== movieTextValue(d, target));
  const dirty = panel === 'text' ? textDirty : panel === 'style' && styleDraft !== null;
  // Human edits remain available while an agent works; the shared revision check rejects conflicts.
  const locked = p.busy || p.readOnly;
  const rows = useMemo(() => {
    const fieldLabels = zh ? { title: '标题', body: '正文', caption: '字幕', layer: '文字图层' } : { title: 'Title', body: 'Body', caption: 'Caption', layer: 'Text layer' };
    return movieTextTargets(d).map(target => ({ target, label: `${fieldLabels[target.field]} · ${(movieTextValue(d, target) || d.shots.find(s => s.id === target.shotId)?.title || '').slice(0, 28)}` }));
  }, [d, zh]);
  const keyOf = (t: MovieTextTarget) => JSON.stringify(t);
  const selectText = (next: MovieTextTarget) => {
    p.onPause();
    setTarget(next);
    setText(movieTextValue(d, next) ?? '');
    setPanel('text');
    p.onPreview(null);
  };
  useImperativeHandle(ref, () => ({ editText(next) {
    if (!locked && !p.blocked && !dirty) selectText(next);
  } }));
  useEffect(() => {
    if (panel === 'text') input.current?.focus();
  }, [panel, target]);
  useEffect(() => {
    if (panel !== 'style') return;
    let active = true;
    void fetchDesignSystems(p.context).then(items => { if (active) setSystems(items); });
    return () => { active = false; };
  }, [panel, p.context]);
  // A clean selected field follows another editor's committed changes.
  useEffect(() => {
    if (target && !dirty) setText(movieTextValue(d, target) ?? '');
  }, [d.revision]);

  const cancel = () => { setStyleDraft(null); setTarget(null); setText(''); p.onPreview(null); setPanel(null); };
  const open = (next: 'text' | 'style' | 'notes') => {
    if (p.blocked || dirty) return;
    p.onPause();
    setSent(false);
    if (next === 'text') {
      const starts = movieShotStarts(d);
      const shot = [...d.shots].reverse().find(s => { const at = starts[d.shots.indexOf(s)]!; return p.time >= at && p.time <= at + s.duration; }) ?? d.shots[0];
      if (shot) selectText({ shotId: shot.id, field: 'title' });
      else setPanel('text');
    } else {
      setPanel(next);
      if (next === 'notes') setNoteTarget({ scope: 'time', time: Math.min(p.time, movieDuration(d)), contentRevision: d.contentRevision });
    }
  };
  const previewText = (value: string) => {
    setText(value);
    if (!target) return;
    const op = movieTextEdit(d, target, value);
    if (!op || value === movieTextValue(d, target)) { p.onPreview(null); return; }
    p.onPreview({ ...d, shots: d.shots.map(s => s.id !== target.shotId ? s : op.op === 'update-shot' ? { ...s, ...op.changes } : op.op === 'update-caption' ? { ...s, captions: s.captions?.map(c => c.id === target.captionId ? { ...c, text: value } : c) } : s) });
  };
  const saveText = async () => {
    if (!target) return;
    const op = movieTextEdit(d, target, text);
    if (op && await p.onApply(zh ? '修改画面文字' : 'Edit on-screen text', [op])) cancel();
  };
  const count = d.notes.filter(n => !n.renderId && !n.resolved).length;

  return <div className={styles.tools} data-testid="movie-live-tools">
    {(['text', 'style', 'notes'] as const).map(kind => <Popover key={kind} open={panel === kind} onOpenChange={value => { if (value) open(kind); else if (!dirty) cancel(); }}>
      <PopoverTrigger asChild>
        <IconButton size="sm" on={panel === kind} disabled={p.blocked || p.busy} aria-label={kind === 'text' ? (zh ? '编辑画面文字' : 'Edit on-screen text') : kind === 'style' ? (zh ? '动画样式' : 'Motion style') : (zh ? `时间批注${count ? `（${count}）` : ''}` : `Timed comments${count ? ` (${count})` : ''}`)}>
          {/* Editing existing on-screen text; the T glyph stays with 添加文字. */}
          <Icon icon={kind === 'text' ? TextCursorInput : kind === 'style' ? Palette : MessageSquare} size="sm" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" width={380} aria-label={kind === 'notes' ? (zh ? '时间批注' : 'Timed comments') : kind === 'text' ? (zh ? '画面文字' : 'On-screen text') : (zh ? '动画样式' : 'Motion style')} onOpenAutoFocus={e => { if (kind === 'text') { e.preventDefault(); input.current?.focus(); } }}>
        <div className={styles.panel} onKeyDown={e => e.stopPropagation()}>
          {kind === 'text' ? <>
            <strong>{zh ? '画面文字' : 'On-screen text'}</strong>
            <p className={styles.hint}>{zh ? '双击画面文字，或在这里选择。输入即预览，保存后可撤销。' : 'Double-click text in the preview or select it here. Changes preview as you type; saving creates one undo step.'}</p>
            {target ? <>
              <Select value={keyOf(target)} onValueChange={value => { const row = rows.find(r => keyOf(r.target) === value); if (row) selectText(row.target); }} disabled={Boolean(dirty) || locked}>
                <SelectTrigger aria-label={zh ? '文字位置' : 'Text location'}><SelectValue /></SelectTrigger>
                <SelectContent>{rows.map(row => <SelectItem key={keyOf(row.target)} value={keyOf(row.target)}>{row.label}</SelectItem>)}</SelectContent>
              </Select>
              <Textarea ref={input} rows={3} value={text} maxLength={target.field === 'body' ? 1200 : target.field === 'layer' ? 160 : 300} aria-label={zh ? '画面文字内容' : 'On-screen text content'} disabled={locked || d.shots.find(s => s.id === target.shotId)?.locked} onChange={e => previewText(e.target.value)} />
              <div className={styles.actions}><Button size="sm" onClick={cancel}>{zh ? '取消' : 'Cancel'}</Button><Button size="sm" variant="primary" disabled={locked || !textDirty || (target.field !== 'body' && !text.trim())} onClick={() => void saveText()}>{zh ? '保存文字' : 'Save text'}</Button></div>
            </> : <p>{zh ? '添加镜头或文字片段后即可编辑。' : 'Add a scene or text clip to edit its text.'}</p>}
          </> : kind === 'style' ? <>
            <strong>{zh ? '动画样式' : 'Motion style'}</strong>
            <StyleFields value={styleDraft ?? d.style} disabled={locked} onChange={style => { setStyleDraft(style); p.onPreview({ ...d, style }); }} />
            <Field label={zh ? '字体名称' : 'Typeface'}><Input value={(styleDraft ?? d.style).typeface ?? ''} disabled={locked} placeholder={zh ? '跟随字体类别' : 'Use font category'} onChange={e => { const style = { ...(styleDraft ?? d.style), typeface: e.target.value }; setStyleDraft(style); p.onPreview({ ...d, style }); }} /></Field>
            <div className={styles.actions}><Button size="sm" onClick={cancel}>{zh ? '取消' : 'Cancel'}</Button><Button size="sm" variant="primary" disabled={locked || !styleDraft} onClick={async () => { if (styleDraft && await p.onStyle(styleDraft)) cancel(); }}>{zh ? '保存样式' : 'Save style'}</Button></div>
            <div className={styles.brand}>
              <strong>{zh ? '品牌颜色与字体' : 'Brand colors and type'}</strong>
              <p className={styles.hint}>{d.style.designSystem ? `${zh ? '已取自' : 'From'} ${d.style.designSystem.id}` : (zh ? '从设计系统取用颜色与字体，保留镜头和动画。' : 'Use a design system’s colors and type while keeping scenes and motion.')}</p>
              <Select value={systemId} onValueChange={setSystemId} disabled={locked || Boolean(styleDraft)}>
                <SelectTrigger aria-label={zh ? '品牌设计系统' : 'Brand design system'}><SelectValue placeholder={zh ? '选择设计系统' : 'Choose a design system'} /></SelectTrigger>
                <SelectContent>{systems.map(s => <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>)}</SelectContent>
              </Select>
              <Button size="sm" disabled={locked || Boolean(styleDraft) || !systemId} onClick={() => void p.onLinkStyle(systemId)}>{zh ? '应用品牌样式' : 'Apply brand style'}</Button>
            </div>
          </> : <>
            {sent ? <p role="status" className={styles.hint}>{zh ? '已发送到主聊天，修改将同步到预览。' : 'Sent to the project chat. Edits will appear in the preview.'}</p> : null}
            <MovieReviewNotes document={d} projectId={p.projectId} context={p.context} target={noteTarget} onTarget={setNoteTarget} live
              onFreeze={p.onPause} busy={p.busy} aiRunning={p.aiBusy} readOnly={p.readOnly}
              onAdd={async value => { if (!await p.onAddNote(noteTarget, value)) throw new Error('Comment not saved'); }}
              onSubmit={ids => { void p.onSubmitNotes(ids).then(setSent); }} onResolve={p.onResolveNote}
              onLocate={note => { p.onSeek(note.time); setNoteTarget({ scope: note.scope ?? 'time', time: note.time, endTime: note.endTime, shotId: note.shotId, contentRevision: note.contentRevision }); }}
              onAddMaterial={() => {}} />
          </>}
        </div>
      </PopoverContent>
    </Popover>)}
  </div>;
});

export function MovieLiveMarkers({ document: d, onSeek }: { document: MovieDocument; onSeek(time: number): void }) {
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const notes = d.notes.filter(n => !n.renderId && !n.resolved);
  if (!notes.length) return null;
  return <div className={styles.markers} aria-label={zh ? '时间批注定位' : 'Comment locations'}>
    {notes.map(note => <Button key={note.id} size="sm" variant="bare" onClick={() => onSeek(note.time)} title={note.text}>
      <Icon icon={MessageSquare} size="sm" /><span>{note.time.toFixed(2)}s · {note.text}</span>
      {note.contentRevision !== d.contentRevision ? <small>{zh ? '较早版本' : 'Earlier version'}</small> : null}
    </Button>)}
  </div>;
}
