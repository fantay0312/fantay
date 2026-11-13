'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — ⚡ quick capture: 笔记 / 金句 / 链接 / 文件 / 语音, into the Inbox or a space,
 * with tags. ⌘↵ saves. Files can be picked, dropped or pasted; voice is recorded in the browser.
 * The dialog shape follows dsh-media-desk's CaptureDialog (client/index.jsx, MIT, Copyright (c) 2026
 * woniuniuniu); the file, voice, space and tag parts are new.
 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Link2, Mic, Paperclip, Quote, RotateCcw, Square, StickyNote, Upload, X } from 'lucide-react';
import {
  Button, Chip, Icon, IconButton, Input, KbdCombo, Modal, ModalActions, ModalTitle, Segmented, SegmentedItem,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea,
} from '../../ui';
import type { QuickCaptureRequest, QuickCaptureTab } from '../capture-bus';
import { useL } from '../lang';
import { FILE_ACCEPT, acceptable, captureFiles, captureLink, captureText, parseTags, recorderMime } from './capture';
import { useLibraryState } from './context';
import { fmtBytes, fmtDuration, isUrl, tagStats } from './library';
import { SpaceGlyph } from './SpaceGlyph';
import styles from './CaptureDialog.module.css';

export interface CaptureOpen extends QuickCaptureRequest { tags?: string[] }

type RecState = 'idle' | 'asking' | 'recording' | 'done' | 'denied' | 'unsupported';

function useRecorder(active: boolean) {
  const [state, setState] = useState<RecState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const levelsRef = useRef<HTMLDivElement>(null);
  const live = useRef<{ recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext | null; raf: number; timer: ReturnType<typeof setInterval>; started: number } | null>(null);

  const teardown = () => {
    const run = live.current;
    if (!run) return;
    cancelAnimationFrame(run.raf);
    clearInterval(run.timer);
    run.stream.getTracks().forEach(track => track.stop());
    void run.ctx?.close().catch(() => undefined);
    live.current = null;
  };

  const reset = () => {
    teardown();
    if (url) URL.revokeObjectURL(url);
    setUrl(null);
    setFile(null);
    setElapsed(0);
    setState('idle');
  };

  useEffect(() => {
    if (!active) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => () => teardown(), []);

  const start = async () => {
    const mime = recorderMime();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setState('unsupported'); return; }
    reset();
    setState('asking');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState('denied');
      return;
    }
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      const type = recorder.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunks, { type: type.split(';')[0] });
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const now = new Date();
      const name = `voice-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}.${ext}`;
      const next = new File([blob], name, { type: blob.type });
      setFile(next);
      setUrl(URL.createObjectURL(next));
      setState('done');
      teardown();
    };
    let ctx: AudioContext | null = null;
    let raf = 0;
    try {
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        analyser.getByteFrequencyData(data);
        const bars = levelsRef.current?.children;
        if (bars) {
          for (let i = 0; i < bars.length; i += 1) {
            const v = (data[Math.min(data.length - 1, i + 1)] ?? 0) / 255;
            (bars[i] as HTMLElement).style.transform = `scaleY(${0.12 + v * 0.88})`;
          }
        }
        raf = requestAnimationFrame(draw);
        if (live.current) live.current.raf = raf;
      };
      raf = requestAnimationFrame(draw);
    } catch {
      ctx = null;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      const sec = (Date.now() - started) / 1000;
      setElapsed(sec);
      if (sec >= 600 && recorder.state === 'recording') recorder.stop();
    }, 200);
    live.current = { recorder, stream, ctx, raf, timer, started };
    recorder.start(250);
    setState('recording');
  };

  const stop = () => {
    const run = live.current;
    if (run && run.recorder.state === 'recording') run.recorder.stop();
  };

  return { state, elapsed, file, url, start, stop, reset, levelsRef };
}

const TABS: Array<{ value: QuickCaptureTab; icon: typeof StickyNote; zh: string; en: string }> = [
  { value: 'note', icon: StickyNote, zh: '笔记', en: 'Note' },
  { value: 'quote', icon: Quote, zh: '金句', en: 'Quote' },
  { value: 'link', icon: Link2, zh: '链接', en: 'Link' },
  { value: 'file', icon: Paperclip, zh: '文件', en: 'File' },
  { value: 'voice', icon: Mic, zh: '语音', en: 'Voice' },
];

export function CaptureDialog({ request, onClose }: { request: CaptureOpen | null; onClose(): void }) {
  const L = useL();
  const state = useLibraryState();
  const open = Boolean(request);
  const [tab, setTab] = useState<QuickCaptureTab>('note');
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRecorder(open && tab === 'voice');

  useEffect(() => {
    if (!request) return;
    const value = request.text?.trim() ?? '';
    const asUrl = value && isUrl(value);
    setTab(request.tab ?? (request.files?.length ? 'file' : asUrl ? 'link' : 'note'));
    setText(asUrl ? '' : value);
    setUrl(asUrl ? value : '');
    setSource('');
    setNote('');
    setFiles(request.files?.filter(acceptable) ?? []);
    setSpaceId(request.spaceId ?? null);
    setTags(request.tags ?? []);
    setTagDraft('');
    setBusy(false);
  }, [request]);

  const previews = useMemo(() => files.map(file => ({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null })), [files]);
  useEffect(() => () => previews.forEach(p => { if (p.url) URL.revokeObjectURL(p.url); }), [previews]);

  const suggestions = useMemo(() => tagStats(state.items).filter(row => !tags.includes(row.tag)).slice(0, 8), [state.items, tags]);
  const space = state.spaces.find(s => s.id === spaceId) ?? null;
  const allTags = [...new Set([...tags, ...parseTags(tagDraft)])];

  const addFiles = (list: File[]) => {
    const usable = list.filter(acceptable);
    if (usable.length) setFiles(current => [...current, ...usable]);
  };

  const ready = tab === 'note' || tab === 'quote' ? Boolean(text.trim())
    : tab === 'link' ? isUrl(url)
      : tab === 'file' ? files.length > 0
        : recorder.state === 'done' && Boolean(recorder.file);

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const target = { spaceId, tags: allTags };
    let ok = false;
    if (tab === 'note' || tab === 'quote') ok = await captureText(tab, text, { ...target, source }, L);
    else if (tab === 'link') ok = await captureLink(url, { ...target, ...(note.trim() ? { note: note.trim() } : {}) }, L);
    else if (tab === 'file') ok = await captureFiles(files, target, L, note.trim() ? { body: note.trim() } : {});
    else if (recorder.file) {
      const now = new Date();
      ok = await captureFiles([recorder.file], target, L, {
        title: L(`语音 ${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, `Voice note, ${now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`),
        ...(note.trim() ? { body: note.trim() } : {}),
      });
    }
    setBusy(false);
    if (ok) onClose();
  };

  const onPaste = (event: ClipboardEvent) => {
    const pasted = [...(event.clipboardData?.files ?? [])];
    if (pasted.length) {
      event.preventDefault();
      addFiles(pasted);
      setTab('file');
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = [...(event.dataTransfer?.files ?? [])];
    if (dropped.length) {
      addFiles(dropped);
      setTab('file');
      return;
    }
    const dropText = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || '';
    if (isUrl(dropText.trim())) { setUrl(dropText.trim()); setTab('link'); }
  };

  return (
    <Modal open={open} onClose={onClose} size="md" aria-describedby={undefined}>
      <div
        className={styles.root}
        data-dragging={dragging ? '' : undefined}
        onPaste={onPaste}
        onDragOver={(event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); setDragging(true); } }}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={onDrop}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
        }}
      >
        <ModalTitle>{L('记下一个灵感', 'Capture an idea')}</ModalTitle>
        <Segmented className={styles.tabs} value={tab} onValueChange={value => setTab(value as QuickCaptureTab)} aria-label={L('记录方式', 'Capture type')}>
          {TABS.map(entry => (
            <SegmentedItem key={entry.value} value={entry.value} className={styles.tab}>
              <Icon icon={entry.icon} />
              {L(entry.zh, entry.en)}
            </SegmentedItem>
          ))}
        </Segmented>

        <div className={styles.body}>
          {tab === 'note' || tab === 'quote' ? (
            <>
              <Textarea
                className={styles.textarea}
                rows={tab === 'quote' ? 4 : 6}
                autoFocus
                value={text}
                onChange={event => setText(event.target.value)}
                placeholder={tab === 'quote' ? L('好的选题不是想出来的，是被你反复抱怨出来的。', 'Good topics are not invented; they are what you keep complaining about.') : L('想到什么就写什么，之后让 AI 帮你整理。第一句会成为标题。', 'Write whatever comes to mind; AI can tidy it later. The first sentence becomes the title.')}
                aria-label={tab === 'quote' ? L('金句', 'Quote') : L('笔记', 'Note')}
              />
              {tab === 'quote' ? (
                <Input variant="well" value={source} onChange={event => setSource(event.target.value)} placeholder={L('出处（可选）：谁说的、哪本书', 'Source (optional): who said it, which book')} aria-label={L('出处', 'Source')} />
              ) : null}
            </>
          ) : tab === 'link' ? (
            <>
              <Input variant="well" inputSize="lg" type="url" autoFocus value={url} onChange={event => setUrl(event.target.value)} placeholder="https://" aria-label={L('链接', 'Link')} />
              <p className={styles.help}>{L('会自动读取页面的标题、简介和封面，正文可以在阅读模式里看和高亮。', 'Title, summary and cover are read automatically; read and highlight the text in the reader.')}</p>
              <Textarea className={styles.textareaSmall} rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder={L('为什么存它？（可选）', 'Why save it? (optional)')} aria-label={L('备注', 'Note')} />
            </>
          ) : tab === 'file' ? (
            <>
              <Button variant="bare" block className={styles.dropzone} data-active={dragging ? '' : undefined} onClick={() => fileInput.current?.click()}>
                <span className={styles.dropIcon}><Icon icon={Upload} size={20} /></span>
                <span className={styles.dropTitle}>{L('选择文件，或拖进来、粘贴进来', 'Choose files, or drop or paste them here')}</span>
                <span className={styles.dropHint}>{L('图片、视频、PDF、音频，可以一次放多个', 'Images, videos, PDFs and audio — several at once is fine')}</span>
              </Button>
              <input
                ref={fileInput}
                type="file"
                hidden
                multiple
                accept={FILE_ACCEPT}
                onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ''; }}
              />
              {previews.length ? (
                <ul className={styles.files}>
                  {previews.map(({ file, url: preview }, index) => (
                    <li key={`${file.name}-${index}`} className={styles.file}>
                      <span className={styles.fileThumb}>
                        {preview ? <img src={preview} alt="" /> : <span>{(file.name.split('.').pop() ?? '').toUpperCase().slice(0, 4)}</span>}
                      </span>
                      <span className={styles.fileName}>{file.name}</span>
                      <span className={styles.fileSize}>{fmtBytes(file.size)}</span>
                      <IconButton size="xs" aria-label={L(`移除 ${file.name}`, `Remove ${file.name}`)} onClick={() => setFiles(current => current.filter((_, i) => i !== index))}>
                        <Icon icon={X} />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              ) : null}
              {files.length ? (
                <Textarea className={styles.textareaSmall} rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder={files.length > 1 ? L('备注（可选，只用于单个文件）', 'Note (optional, single file only)') : L('备注（可选）', 'Note (optional)')} disabled={files.length > 1} aria-label={L('备注', 'Note')} />
              ) : null}
            </>
          ) : (
            <div className={styles.voice} data-state={recorder.state}>
              <div className={styles.levels} ref={recorder.levelsRef} aria-hidden>
                {Array.from({ length: 28 }, (_, i) => <i key={i} />)}
              </div>
              <p className={styles.voiceTime}>{fmtDuration(Math.max(recorder.elapsed, 0.01)) ?? '0:00'}</p>
              {recorder.state === 'recording' ? (
                <Button variant="danger" onClick={recorder.stop}><Icon icon={Square} fill="currentColor" />{L('停止', 'Stop')}</Button>
              ) : recorder.state === 'done' && recorder.url ? (
                <div className={styles.voiceDone}>
                  <audio src={recorder.url} controls className={styles.voicePlayer} />
                  <Button variant="ghost" size="sm" onClick={() => { void recorder.start(); }}><Icon icon={RotateCcw} />{L('重录', 'Re-record')}</Button>
                </div>
              ) : (
                <Button variant="primary" onClick={() => { void recorder.start(); }} loading={recorder.state === 'asking'}>
                  <Icon icon={Mic} />
                  {L('开始录音', 'Start recording')}
                </Button>
              )}
              <p className={styles.help}>
                {recorder.state === 'denied'
                  ? L('没有拿到麦克风权限。在系统设置里允许 Fantay 使用麦克风后再试。', 'Microphone access was denied. Allow it in system settings and try again.')
                  : recorder.state === 'unsupported'
                    ? L('这里不能录音。可以在「文件」里上传录好的音频。', 'Recording is not available here. Upload an audio file under File instead.')
                    : L('说完点停止，录音会存成一条语音灵感。', 'Stop when you are done; the recording becomes a voice idea.')}
              </p>
              {recorder.state === 'done' ? (
                <Textarea className={styles.textareaSmall} rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder={L('补一句文字（可选）', 'Add a line of text (optional)')} aria-label={L('备注', 'Note')} />
              ) : null}
            </div>
          )}
        </div>

        <div className={styles.meta}>
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>{L('放到', 'Into')}</span>
            <Select value={spaceId ?? 'inbox'} onValueChange={value => setSpaceId(value === 'inbox' ? null : value)}>
              <SelectTrigger size="sm" className={styles.spaceTrigger} aria-label={L('空间', 'Space')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inbox">{L('收件箱', 'Inbox')}</SelectItem>
                {state.spaces.map(s => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className={styles.spaceOption}><SpaceGlyph color={s.color} size={15} />{s.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className={styles.metaRow} data-stack="">
            <span className={styles.metaLabel}>{L('标签', 'Tags')}</span>
            <div className={styles.tagsBox}>
              {tags.map(tag => (
                <span key={tag} className={styles.tag}>
                  #{tag}
                  <IconButton size="xs" shape="round" className={styles.tagRemove} tooltip={false} aria-label={L(`移除 ${tag}`, `Remove ${tag}`)} onClick={() => setTags(current => current.filter(t => t !== tag))}><Icon icon={X} size={10} /></IconButton>
                </span>
              ))}
              <Input
                variant="bare"
                inputSize="auto"
                className={styles.tagInput}
                value={tagDraft}
                onChange={event => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' && !(event.metaKey || event.ctrlKey)) || event.key === ',' || event.key === '，') {
                    if (!tagDraft.trim()) return;
                    event.preventDefault();
                    setTags(current => [...new Set([...current, ...parseTags(tagDraft)])]);
                    setTagDraft('');
                  } else if (event.key === 'Backspace' && !tagDraft && tags.length) {
                    setTags(current => current.slice(0, -1));
                  }
                }}
                placeholder={tags.length ? '' : L('回车添加', 'Enter to add')}
                aria-label={L('标签', 'Tags')}
              />
            </div>
          </div>
          {suggestions.length ? (
            <div className={styles.suggestions}>
              {suggestions.map(row => (
                <Chip key={row.tag} size="sm" variant="suggestion" onClick={() => setTags(current => [...current, row.tag])}>#{row.tag}</Chip>
              ))}
            </div>
          ) : null}
        </div>

        <ModalActions className={styles.actions}>
          <span className={styles.shortcut}><KbdCombo shortcut="mod+enter" />{L('保存', 'Save')}</span>
          <span className={styles.spacer} />
          <Button variant="ghost" onClick={onClose}>{L('取消', 'Cancel')}</Button>
          <Button variant="primary" onClick={() => { void save(); }} loading={busy} disabled={!ready}>
            {space ? L(`放进「${space.name}」`, `Save to ${space.name}`) : L('放进收件箱', 'Save to Inbox')}
          </Button>
        </ModalActions>
        <div className={styles.dropOverlay} aria-hidden>{L('松手放进来', 'Drop to add')}</div>
      </div>
    </Modal>
  );
}
