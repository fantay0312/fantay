// SPDX-License-Identifier: AGPL-3.0-only
// E-mail messages (`.eml`), read as the message a person received rather than as MIME text: the
// subject, who sent it and to whom, the date in the reader's locale, the files sent with it, and the
// body in a reading column. "Source" shows the raw message, wrapped.
//  - The file is read in a worker (`email/read-mail.ts`, postal-mime) against a size cap and a clock.
//  - An HTML body is sanitised (`email/sanitize-mail.ts`) and drawn in the frame that cannot run
//    script (`email/MailFrame.tsx`), on the message's own white page in both themes. Nothing is
//    fetched: remote pictures, style sheets, fonts, frames and forms are removed, and one quiet line
//    above the body says what was. Pictures the message carries (`cid:`) are shown from its own parts.
//  - When that line counts remote pictures it offers one quiet action, "show images", whose tooltip
//    says what it costs (the pictures come from the sender's servers, who may learn the message was
//    opened). It holds for this message, for this session (view state; nothing is written anywhere).
//    The pictures then load (tracking pixels still never do) and the line says how many are shown,
//    how many did not load and what is still blocked, with "hide images" to go back.
//  - A plain-text body is set in the column with its line breaks, quotes and signature
//    (`email/MailText.tsx`).
//  - Links never navigate. Pointing at one shows its real address at the foot of the panel; pressing
//    one copies that address and says so next to it, as the PDF viewer does.
//  - Attachments save to disk when pressed (a download of their bytes; never opened or run).
// A newer version of the file replaces the message only once it has been read; a version that
// cannot be read, or is cut short while the last one was whole, leaves the last one on screen. Mode,
// opened recipient lists and the reader's place are kept per file.
'use client';

import { Check, Copy, FileWarning, Image as ImageGlyph, Lock, MailX, PenLine, ShieldCheck, TimerOff, WrapText, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useI18n, useT } from '../../../i18n';
import { copyText, downloadBlob } from '../../board/interaction/file-actions';
import { LARGE_TEXT_BYTES } from '../../workspace/code/text-preview';
import { ArtifactShell, type ArtifactAction, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { ARTIFACT_SLOW_LOAD_MS, formatBytes, useArtifactBytes } from '../use-artifact-source';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../use-view-state';
import { Button, Tooltip } from '../../ui';
import type { ArtifactViewerProps } from '../viewer-types';
import styles from './EmailViewer.module.css';
import { MailAttachments, type ShownAttachment } from './email/MailAttachments';
import { parseMail, type MailOutcome } from './email/mail-client';
import { attachmentName, decodeMailSource } from './email/mail-format';
import { MailFrame } from './email/MailFrame';
import { MailHeader } from './email/MailHeader';
import { MailText } from './email/MailText';
import { readPlainText, type MailTextNode } from './email/plain-text';
import { MAX_MAIL_BYTES, type MailMessage } from './email/mail-types';
import { blockedTotal, prepareMailHtml, type BlockedContent, type PreparedMailHtml } from './email/sanitize-mail';
import { TextPane } from './text/TextPane';

type Translate = ReturnType<typeof useT>;
type MailMode = 'mail' | 'source';

/** How long "link address copied" stays up. */
const HINT_MS = 1600;
/** A saved place further down than the column is tall yet is tried again while pictures arrive. */
const PLACE_RETRY_MS = 1500;
/** The column is shown after this even if the message's frame has not reported its size. */
const REVEAL_FALLBACK_MS = 800;

type MailBody =
  | { kind: 'html'; prepared: PreparedMailHtml }
  | { kind: 'text'; nodes: MailTextNode[] }
  | { kind: 'empty' }
  | { kind: 'locked'; security: 'encrypted' | 'sealed' };

function bodyOf(message: MailMessage, remotePictures = false): MailBody {
  if (message.security === 'encrypted' || message.security === 'sealed') return { kind: 'locked', security: message.security };
  if (message.html) {
    const parts = new Set(message.attachments.map((attachment) => attachment.contentId).filter((id): id is string => id !== null));
    const prepared = prepareMailHtml(message.html, (cid) => parts.has(cid), { remotePictures });
    if (prepared.visible) return { kind: 'html', prepared };
  }
  if (message.text?.trim()) return { kind: 'text', nodes: readPlainText(message.text) };
  return { kind: 'empty' };
}

/** "已拦截 3 张远程图片、1 个跟踪像素"; null when nothing was blocked. */
function blockedLine(blocked: BlockedContent, t: Translate): string | null {
  if (blockedTotal(blocked) === 0) return null;
  const items: string[] = [];
  const add = (count: number, one: Parameters<Translate>[0], many: Parameters<Translate>[0]): void => {
    if (count === 1) items.push(t(one));
    else if (count > 1) items.push(t(many, { count }));
  };
  add(blocked.images, 'artifact.email.blockedImagesOne', 'artifact.email.blockedImages');
  add(blocked.trackers, 'artifact.email.blockedTrackersOne', 'artifact.email.blockedTrackers');
  add(blocked.styles, 'artifact.email.blockedStylesOne', 'artifact.email.blockedStyles');
  add(blocked.fonts, 'artifact.email.blockedFontsOne', 'artifact.email.blockedFonts');
  add(blocked.embeds, 'artifact.email.blockedEmbedsOne', 'artifact.email.blockedEmbeds');
  add(blocked.forms, 'artifact.email.blockedFormsOne', 'artifact.email.blockedForms');
  add(blocked.scripts, 'artifact.email.blockedScriptsOne', 'artifact.email.blockedScripts');
  return t('artifact.email.blocked', { items: items.join(t('artifact.email.separator')) });
}

/**
 * The line about an HTML body's pictures and what was blocked. Pictures blocked: `blockedLine`.
 * Pictures shown: "已显示 3 张远程图片，1 张图片无法加载，已拦截 1 个跟踪像素" (`failed`: shown
 * pictures the frame could not load); null when there is nothing to say.
 */
function picturesLine(prepared: PreparedMailHtml, remote: boolean, failed: number, t: Translate): string | null {
  if (!remote) return blockedLine(prepared.blocked, t);
  const clauses: string[] = [];
  const missing = Math.min(failed, prepared.pictures);
  const shown = prepared.pictures - missing;
  if (shown > 0) {
    clauses.push(t('artifact.email.shown', { items: shown === 1 ? t('artifact.email.blockedImagesOne') : t('artifact.email.blockedImages', { count: shown }) }));
  }
  if (missing === 1) clauses.push(t('artifact.email.imagesFailedOne'));
  else if (missing > 1) clauses.push(t('artifact.email.imagesFailed', { count: missing }));
  const blocked = blockedLine(prepared.blocked, t);
  if (blocked) clauses.push(blocked);
  return clauses.length > 0 ? clauses.join(t('artifact.email.clauseSeparator')) : null;
}

/** What a link points at, as the reader would type it: a mail address without its `mailto:`. */
function linkAddress(href: string): string {
  if (!/^mailto:/i.test(href)) return href;
  const address = href.slice(7).split('?')[0] ?? '';
  try {
    return decodeURIComponent(address);
  } catch {
    return address;
  }
}

/** "name.pdf" twice in one ZIP becomes "name.pdf" and "name (2).pdf". */
function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  const dot = name.lastIndexOf('.');
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** True once `pending` has lasted longer than the grace period: only then is a wait worth a word. */
function useSlow(pending: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), ARTIFACT_SLOW_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);
  return pending && slow;
}

// ── the message ───────────────────────────────────────────────────────────────────────────────────

interface MailReaderProps {
  projectId: string;
  fileName: string;
  message: MailMessage;
  body: MailBody;
  attachments: readonly ShownAttachment[];
  /** `body` was made with remote pictures allowed to load. */
  remotePictures: boolean;
  onRemotePictures(show: boolean): void;
}

interface NoteProps {
  icon: LucideIcon;
  children: string;
  /** One quiet action at the end of the line. */
  action?: ReactNode;
  /** The words change in answer to that action: say them again when they do. */
  live?: boolean;
}

function Note({ icon: Glyph, children, action, live }: NoteProps): JSX.Element {
  return (
    <p className={styles.note}>
      <Glyph aria-hidden="true" size={14} strokeWidth={1.75} />
      <span className={styles.noteBody}>
        <span aria-live={live ? 'polite' : undefined}>{children}</span>
        {action}
      </span>
    </p>
  );
}

function MailReader({ projectId, fileName, message, body, attachments, remotePictures, onRemotePictures }: MailReaderProps): JSX.Element {
  const t = useT();
  const { locale } = useI18n();
  const [expanded, setExpanded] = useArtifactViewState<string[]>(projectId, fileName, 'recipients', []);

  // ── the reader's place ────────────────────────────────────────────────────────────────────────
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const place = useRef({ settled: false, since: 0 });
  const [fitted, setFitted] = useState(false);
  const [sideways, setSideways] = useState(false);

  /** Puts the reader back where they were; done once the column is tall enough to hold that place. */
  const restorePlace = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || place.current.settled) return;
    if (place.current.since === 0) place.current.since = performance.now();
    const target = readArtifactViewState<number>(projectId, fileName, 'scroll') ?? 0;
    scroller.scrollTop = target;
    if (scroller.scrollTop >= target - 1 || performance.now() - place.current.since > PLACE_RETRY_MS) place.current.settled = true;
  }, [projectId, fileName]);

  useLayoutEffect(() => {
    if (body.kind !== 'html') restorePlace();
  }, [body, restorePlace]);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // A saved place the message no longer reaches is given up once the retry window has passed.
    if (!place.current.settled && place.current.since > 0 && performance.now() - place.current.since > PLACE_RETRY_MS) place.current.settled = true;
    if (place.current.settled) writeArtifactViewState(projectId, fileName, 'scroll', scroller.scrollTop);
  }, [projectId, fileName]);

  const onFitted = useCallback((wide: boolean) => {
    setFitted(true);
    setSideways(wide);
    restorePlace();
  }, [restorePlace]);

  // A frame that never reports its size (it failed to load) must not keep the column hidden.
  useEffect(() => {
    if (body.kind !== 'html') return;
    const timer = window.setTimeout(() => setFitted(true), REVEAL_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [body.kind]);

  // ── links: the address on hover, a copy on press ──────────────────────────────────────────────
  const [hover, setHover] = useState<string | null>(null);
  const [hint, setHint] = useState<{ x: number; y: number; show: boolean } | null>(null);
  const hintTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    },
    [],
  );

  /** Copies an address and says so above `rect` (viewport coordinates). */
  const copyAddress = useCallback((address: string, rect: DOMRect) => {
    void copyText(address).then((copied) => {
      const stage = stageRef.current;
      if (!copied || !stage) return;
      const bounds = stage.getBoundingClientRect();
      const x = Math.min(bounds.width - 12, Math.max(12, rect.left + rect.width / 2 - bounds.left));
      setHint({ x, y: Math.max(36, rect.top - bounds.top), show: true });
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(() => setHint((previous) => (previous ? { ...previous, show: false } : previous)), HINT_MS);
    });
  }, []);

  const onFrameLink = useCallback(
    (href: string, anchor: Element, frame: HTMLIFrameElement | null): boolean => {
      // In-page links scroll inside the message; everything else stays where it is.
      if (href.startsWith('#')) return false;
      if (/^(?:https?:|mailto:)/i.test(href) && frame) {
        const inner = anchor.getBoundingClientRect();
        const outer = frame.getBoundingClientRect();
        copyAddress(linkAddress(href), new DOMRect(outer.left + inner.left, outer.top + inner.top, inner.width, inner.height));
      }
      return true;
    },
    [copyAddress],
  );

  const onTextLink = useCallback((address: string, element: Element) => copyAddress(address, element.getBoundingClientRect()), [copyAddress]);
  const onHover = useCallback((href: string | null) => setHover(href ? linkAddress(href) : null), []);

  // ── remote pictures: how many of the shown ones did not load ──────────────────────────────────
  const [failedPictures, setFailedPictures] = useState(0);

  // ── attachments ───────────────────────────────────────────────────────────────────────────────
  const [savingAll, setSavingAll] = useState(false);
  const save = useCallback((item: ShownAttachment) => {
    // Always a download of the bytes, typed so that nothing opens or runs them.
    downloadBlob(new Blob([item.attachment.content], { type: 'application/octet-stream' }), item.name);
  }, []);
  const baseName = (fileName.split('/').pop() ?? fileName).replace(/\.eml$/i, '');
  const saveAll = useCallback(async () => {
    setSavingAll(true);
    try {
      const { zipSync } = await import('fflate');
      const used = new Set<string>();
      const files: Record<string, [Uint8Array, { level: 0 }]> = {};
      for (const item of attachments) files[uniqueName(item.name, used)] = [new Uint8Array(item.attachment.content), { level: 0 }];
      const zipped = zipSync(files);
      const bytes = new Uint8Array(zipped.length);
      bytes.set(zipped);
      downloadBlob(new Blob([bytes], { type: 'application/zip' }), `${t('artifact.email.zipName', { name: baseName })}.zip`);
    } finally {
      setSavingAll(false);
    }
  }, [attachments, baseName, t]);

  // ── the words above the body ──────────────────────────────────────────────────────────────────
  // Keyed by what each line is about, not by its words: the pictures line keeps its action (and
  // the keyboard focus on it) when its words change.
  const notes: Array<{ id: string; icon: LucideIcon; text: string; action?: ReactNode; live?: boolean }> = [];
  if (message.truncated) {
    const name = message.truncated.part === 'attachment' ? attachments.find((item) => item.attachment.incomplete)?.name : undefined;
    notes.push({
      id: 'truncated',
      icon: FileWarning,
      text:
        message.truncated.part === 'body'
          ? t('artifact.email.truncatedBody')
          : name
            ? t('artifact.email.truncatedAttachment', { name })
            : t('artifact.email.truncatedPart'),
    });
  }
  if (message.security === 'signed') notes.push({ id: 'signed', icon: PenLine, text: t('artifact.email.signed') });
  const pictures = body.kind === 'html' ? picturesLine(body.prepared, remotePictures, failedPictures, t) : null;
  if (pictures && body.kind === 'html') {
    const offer = body.prepared.pictures > 0;
    notes.push({
      id: 'pictures',
      icon: remotePictures && offer ? ImageGlyph : ShieldCheck,
      text: pictures,
      live: offer,
      action: offer ? (
        <Tooltip label={t(remotePictures ? 'artifact.email.hideImagesHint' : 'artifact.email.showImagesHint')} align="start">
          <Button
            variant="link"
            size="sm"
            className={styles.noteAction}
            onClick={() => onRemotePictures(!remotePictures)}
            data-mail-pictures={remotePictures ? 'shown' : 'blocked'}
          >
            {t(remotePictures ? 'artifact.email.hideImages' : 'artifact.email.showImages')}
          </Button>
        </Tooltip>
      ) : undefined,
    });
  }

  // The column fades in once, when the body has its size.
  const showColumn = body.kind !== 'html' || fitted;

  return (
    <div ref={stageRef} className={styles.stage}>
      <div
        ref={scrollerRef}
        className={styles.scroller}
        tabIndex={0}
        role="region"
        aria-label={message.subject ?? t('artifact.email.noSubject')}
        onScroll={onScroll}
        data-mail-scroller=""
      >
        <div className={styles.column} data-ready={showColumn ? '' : undefined}>
          <MailHeader
            message={message}
            locale={locale}
            expanded={expanded}
            onExpand={(row, open) => setExpanded((current) => (open ? [...current.filter((id) => id !== row), row] : current.filter((id) => id !== row)))}
          />
          {attachments.length > 0 ? <MailAttachments items={attachments} onSave={save} onSaveAll={() => void saveAll()} savingAll={savingAll} /> : null}
          {notes.length > 0 ? (
            <div className={styles.notes} data-mail-notes="">
              {notes.map((note) => (
                <Note key={note.id} icon={note.icon} action={note.action} live={note.live}>
                  {note.text}
                </Note>
              ))}
            </div>
          ) : null}
          {body.kind === 'html' ? (
            <div className={styles.sheet} data-mail-body="html" data-sideways={sideways ? '' : undefined}>
              <MailFrame
                title={t('artifact.email.bodyLabel')}
                prepared={body.prepared}
                remotePictures={remotePictures}
                attachments={message.attachments}
                onLink={onFrameLink}
                onHover={onHover}
                onFitted={onFitted}
                onPicturesFailed={setFailedPictures}
              />
            </div>
          ) : body.kind === 'text' ? (
            <MailText nodes={body.nodes} label={t('artifact.email.bodyLabel')} onLink={onTextLink} onHover={onHover} />
          ) : body.kind === 'locked' ? (
            <div className={styles.locked} data-mail-body="locked">
              <span className={styles.lockedGlyph}>
                <Lock aria-hidden="true" size={18} strokeWidth={1.75} />
              </span>
              <p className={styles.lockedTitle}>{t(body.security === 'encrypted' ? 'artifact.email.encrypted' : 'artifact.email.sealed')}</p>
              <p className={styles.lockedText}>{t(body.security === 'encrypted' ? 'artifact.email.encryptedHint' : 'artifact.email.sealedHint')}</p>
            </div>
          ) : (
            <p className={styles.noBody} data-mail-body="empty">
              {t('artifact.email.noBody')}
            </p>
          )}
        </div>
      </div>
      <div className={styles.status} data-show={hover ? '' : undefined} aria-hidden="true">
        <span className={styles.statusAddress}>{hover ?? ''}</span>
        <span className={styles.statusHint}>{t('artifact.email.clickToCopy')}</span>
      </div>
      <div
        className={styles.hint}
        style={hint ? { left: hint.x, top: hint.y } : undefined}
        data-show={hint?.show ? '' : undefined}
        role="status"
        aria-live="polite"
      >
        {hint ? t('artifact.pdf.linkCopied') : ''}
      </div>
    </div>
  );
}

// ── the viewer ────────────────────────────────────────────────────────────────────────────────────

function MailView({ projectId, file, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const [mode, setMode] = useArtifactViewState<MailMode>(projectId, file.name, 'mode', 'mail');
  const [wrap, setWrap] = useArtifactViewState<boolean>(projectId, file.name, 'wrap', true);
  // The reader asked to see this message's remote pictures: this session only, never stored.
  const [pictures, setPictures] = useArtifactViewState<boolean>(projectId, file.name, 'pictures', false);
  const bytes = useArtifactBytes(projectId, file, { enabled: active, maxBytes: MAX_MAIL_BYTES });
  const data = bytes.source.status === 'ready' ? bytes.source.data : null;

  // ── read the message, off the main thread and against the clock ───────────────────────────────
  const [read, setRead] = useState<{ data: ArrayBuffer; outcome: MailOutcome } | null>(null);
  useEffect(() => {
    if (!data) return;
    const controller = new AbortController();
    let current = true;
    void parseMail(data, controller.signal).then((outcome) => {
      if (current) setRead({ data, outcome });
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [data]);

  // The last good message stays while a newer version is read, and when the newer one cannot be
  // read or was cut short (the agent may still be writing it).
  const [good, setGood] = useState<{ data: ArrayBuffer; message: MailMessage } | null>(null);
  if (read?.outcome.ok && good?.data !== read.data) {
    const next = read.outcome.message;
    if (good === null || next.truncated === null || good.message.truncated !== null) setGood({ data: read.data, message: next });
  }
  const message = good?.message ?? null;
  const failed = data !== null && read?.data === data && !read.outcome.ok && message === null ? read.outcome.code : null;

  // Both ways of making the body are kept while the message stays, so hiding the pictures again
  // reuses the first one; the files under the header do not depend on the choice.
  const blockedBody = useMemo(() => (message ? bodyOf(message) : null), [message]);
  const remoteBody = useMemo(() => (message && pictures ? bodyOf(message, true) : null), [message, pictures]);
  const remotePictures = remoteBody?.kind === 'html' && blockedBody?.kind === 'html';
  const body = remotePictures ? remoteBody : blockedBody;
  const attachments = useMemo<ShownAttachment[]>(() => {
    if (!message) return [];
    const shownInBody = blockedBody?.kind === 'html' ? blockedBody.prepared.cids : new Set<string>();
    return message.attachments
      .filter((attachment) => attachment.contentId === null || !shownInBody.has(attachment.contentId))
      .map((attachment, position) => ({
        attachment,
        name: attachmentName(attachment, position + 1, (n) => t('artifact.email.unnamed', { n }), t('artifact.email.forwarded')),
      }));
  }, [message, blockedBody, t]);

  // ── source ────────────────────────────────────────────────────────────────────────────────────
  const showingSource = mode === 'source';
  const source = useMemo(() => (showingSource && data ? decodeMailSource(data) : null), [showingSource, data]);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copySource = useCallback(async () => {
    if (source === null || !(await copyText(source))) return;
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  }, [source]);

  // ── bar ───────────────────────────────────────────────────────────────────────────────────────
  const actions = useMemo<ArtifactAction[]>(() => {
    if (!showingSource) return [fileActions.download];
    return [
      { id: 'wrap', label: t('workspace.code.wrap'), icon: WrapText, on: wrap, disabled: source === null, onSelect: () => setWrap((value) => !value) },
      {
        id: 'copy',
        label: copied ? t('fileViewer.copied') : t('artifact.text.copyAll'),
        icon: copied ? Check : Copy,
        disabled: source === null,
        onSelect: () => void copySource(),
      },
      fileActions.download,
    ];
  }, [showingSource, fileActions.download, t, wrap, setWrap, source, copied, copySource]);

  const menu = useMemo<ArtifactMenuEntry[]>(() => [...fileActions.menu, fileActions.reloadEntry(bytes.reload)], [fileActions, bytes.reload]);

  const facts = [
    attachments.length === 1 ? t('artifact.email.attachmentsOne') : attachments.length > 1 ? t('artifact.email.attachments', { count: attachments.length }) : null,
    formatBytes(file.size),
  ].filter(Boolean);

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  const reading = data !== null && message === null && failed === null;
  const slow = useSlow(reading);
  const toSource = { label: t('artifact.notebook.showSource'), onSelect: () => setMode('source') };
  const toDownload = { label: t('fileViewer.download'), onSelect: fileActions.downloadFile };
  const notice = (icon: LucideIcon, title: string, description: string): ArtifactShellState => ({
    kind: 'notice',
    icon,
    title,
    description,
    action: toSource,
    secondaryAction: toDownload,
  });

  let state: ArtifactShellState | null = null;
  if (data === null) state = fileActions.sourceState(bytes.source, bytes.reload);
  else if (data.byteLength === 0 || failed === 'empty') state = { kind: 'notice', icon: FileWarning, title: t('artifact.text.empty') };
  else if (!showingSource) {
    if (failed === 'not-mail') state = notice(MailX, t('artifact.email.notMail'), t('artifact.email.notMailHint'));
    else if (failed === 'too-complex') state = notice(FileWarning, t('artifact.email.tooComplex'), t('artifact.email.heavyHint'));
    else if (failed === 'timeout') state = notice(TimerOff, t('artifact.document.timeout'), t('artifact.email.heavyHint'));
    else if (failed === 'too-large') state = fileActions.unsupported(t('artifact.state.tooLarge'), t('artifact.email.heavyHint'));
    else if (failed !== null) state = notice(FileWarning, t('artifact.email.failed'), t('artifact.email.failedHint'));
    else if (reading) state = slow ? { kind: 'loading', label: t('artifact.email.reading') } : { kind: 'loading', quiet: true };
  }

  return (
    <ArtifactShell
      viewer="email"
      path={file.name}
      stage={showingSource ? 'fill' : 'page'}
      modes={[
        { id: 'mail', label: t('artifact.email.viewMail') },
        { id: 'source', label: t('artifact.email.viewSource') },
      ]}
      mode={mode}
      modesLabel={t('artifact.viewMode')}
      onModeChange={(next) => setMode(next === 'source' ? 'source' : 'mail')}
      meta={facts.join(' · ')}
      actions={actions}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      {showingSource ? (
        source === null ? null : (
          <TextPane
            projectId={projectId}
            fileName={file.name}
            view="source"
            languageName={`${file.name}.txt`}
            text={source}
            wrap={wrap}
            notice={source.length > LARGE_TEXT_BYTES ? t('workspace.code.largeFile') : null}
          />
        )
      ) : message && body ? (
        <MailReader
          projectId={projectId}
          fileName={file.name}
          message={message}
          body={body}
          attachments={attachments}
          remotePictures={remotePictures}
          onRemotePictures={setPictures}
        />
      ) : null}
    </ArtifactShell>
  );
}

/** Keyed by file, so each message has its own instance and never inherits another one's state. */
export default function EmailViewer(props: ArtifactViewerProps): JSX.Element {
  return <MailView key={`${props.projectId}\n${props.file.name}`} {...props} />;
}
