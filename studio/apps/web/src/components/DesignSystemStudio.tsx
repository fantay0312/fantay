import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from 'react';
import { Button, SearchField, Segmented, SegmentedItem, Select as ListSelect, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea } from '../fantay/ui';
import { editStudioToken, parseStudioTokens, isStudioPackageAsset, studioTokenValueSupported, type DesignSystemPackageInfo, type StudioToken, type StudioTokenGroup, type WorkspaceCollabContext } from '@open-design/contracts';
import { appendStudioRules, emptyStudioDocument, parseStudioDocument, STUDIO_DOCUMENT_PATH, attachStudioHandbook, stripStudioHandbook, type StudioDocument, type StudioTokenNote, type StudioLibraryEntry, type DesignSystemRevision } from '@open-design/contracts';
import { useI18n } from '../i18n';
import { createDesignSystemDraft, ensureDesignSystemWorkspace, fetchDesignSystem, fetchProjectFiles, fetchDesignSystemRevisions, importGitHubDesignSystem, uploadProjectFile, syncDesignSystemAssetsFromWorkspace } from '../providers/registry';
import { workspaceIdentityCacheKey } from '../collab/workspace-identity';
import { navigate } from '../router';
import { brandBookFromMarkdown, overviewFromMarkdown, readStudioFile, saveStudioFile, studioFileUrl, studioTokenFile, studioComponentPreview, STUDIO_PREVIEW_HEIGHT_MESSAGE } from '../runtime/design-system-studio';
import { type DesignKit } from '../runtime/design-kit';
import { completeFoundationCss, completeSizingCss, isStudioStarterDocument, starterStudioDocument, STUDIO_STARTER_VERSION, upgradeStudioStarterCatalog } from '../runtime/studio-starter';
import { bundleStudioEntry, type StudioEntryBundle } from '../runtime/studio-entry-bundle';
import { createStudioEntryProject } from '../runtime/studio-entry-project';
import { downloadDesignSystemArchive } from '../runtime/exports';
import { studioScopeLabel, studioThemeScopes } from '../runtime/studio-palette';
import { studioViewTransition } from '../runtime/studio-view-transition';
import { studioAssetGroups } from '../runtime/studio-assets';
import { StudioNavBar, StudioSectionMenu, type StudioChapterId, type StudioNavIcon, type StudioNavItem } from './StudioChapterNav';
import { StudioColorBoard } from './StudioColorBoard';
import { StudioOverview, studioDisplayName, type StudioJumpTarget } from './StudioOverview';
import { StudioSpecimens, studioSpecimenNames } from './StudioSpecimens';
import { StudioTokenDock } from './StudioTokenDock';
import { StudioTokenTable } from './StudioTokenTable';
import { StudioHandbook, type HandbookSection } from './StudioHandbook';
import { HeaderActionsMenu, useBrandFonts, type HeaderMenuAction } from './DesignKitView';
import { Icon, type IconName } from './Icon';
import { studioCopy } from './design-system-studio-copy';
import styles from './DesignSystemStudio.module.css';
import { Select } from './Select';

type LibrarySection = 'components' | 'blocks' | 'patterns' | 'templates';
type GuidelineSection = 'rules' | 'content' | 'assets' | 'accessibility' | 'implementation' | 'governance';
type SectionId = StudioTokenGroup | LibrarySection | GuidelineSection | 'files';
type FoundationsView = 'specimens' | 'table';
const CHAPTERS: StudioChapterId[] = ['overview', 'foundations', 'library', 'guidelines', 'files'];
const FOUNDATION_GROUPS: StudioTokenGroup[] = ['colors', 'typography', 'spacing', 'radius', 'shadows', 'motion', 'layout', 'measure', 'sizing', 'layers', 'other'];
const LIBRARY_SECTIONS: LibrarySection[] = ['components', 'blocks', 'patterns', 'templates'];
// Rules open the chapter: they are what anyone, an agent included, reads before building.
const GUIDELINE_SECTIONS: GuidelineSection[] = ['rules', 'content', 'assets', 'accessibility', 'implementation', 'governance'];
/** Where a section's top comes to rest: clear of the sticky chips, with room to breathe. */
const SECTION_OFFSET = 72;
const VIEW_STORAGE_KEY = 'fantay.studio.foundationsView';
/** How long a restored place is held while previews and fonts above it settle. */
const PLACE_HOLD_MS = 1500;
/** The longest the chips wait for a smooth jump to end before they follow the page again. */
const SPY_HOLD_MS = 1500;
/** Matches the skeleton's animation-delay: until then it is invisible. */
const SKELETON_HOLD_MS = 120;
/** Matches --st-dur-exit: the dialog stays mounted for its exit. */
const DIALOG_EXIT_MS = 140;
/** Most package pages size something to 100vh, which grows with the frame; this is where it stops. */
const COMPONENT_FRAME_MAX = 6000;

function readFoundationsView(): FoundationsView {
  try { return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'table' ? 'table' : 'specimens'; }
  catch { return 'specimens'; }
}
function writeFoundationsView(view: FoundationsView) {
  try { window.localStorage.setItem(VIEW_STORAGE_KEY, view); }
  catch { /* Storage is blocked: the choice simply lasts until the page closes. */ }
}
function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
/** A point on the page that survives a reflow: an element, and how far below the scroller's top it sat. */
type Anchor = { attr: 'data-section' | 'data-entry-id' | 'data-palette-card' | 'data-chapter'; id: string; offset: number };

function byAttr(root: ParentNode, attr: string, id: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>('[' + attr + ']')).find((node) => node.getAttribute(attr) === id) ?? null;
}
/** A section the library search has hidden has no box: it is not on the page to read or to land on. */
const laidOut = (node: HTMLElement) => window.getComputedStyle(node).display !== 'none';
/** The scrollTop that puts an anchor back where it sat, or null when it is not on the page. */
function anchorTop(scroller: HTMLElement, anchor: Anchor): number | null {
  const node = byAttr(scroller, anchor.attr, anchor.id);
  return node && laidOut(node) ? Math.max(0, node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - anchor.offset) : null;
}
/** The scrollTop that brings a section to its resting place, or null when it is not on the page. */
function sectionTop(scroller: HTMLElement, id: string): number | null {
  return anchorTop(scroller, { attr: 'data-section', id, offset: SECTION_OFFSET });
}
/**
 * What the reader is looking at: the innermost entry or section that reaches below the sticky chips.
 * A raw scrollTop goes stale as soon as a preview above it loads at another height.
 */
function readingAnchor(scroller: HTMLElement): Anchor | null {
  // At the top of the page the top is the place; an anchor further down would hold that one instead.
  if (scroller.scrollTop <= 1) return null;
  const { top, bottom } = scroller.getBoundingClientRect();
  // Only what is on screen counts: a section that starts below the fold is not where the reader is.
  const hits = Array.from(scroller.querySelectorAll<HTMLElement>('[data-entry-id], [data-section]')).filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > top + SECTION_OFFSET && rect.top < bottom;
  });
  // Document order puts a section before its entries, so a hit that holds the next hit is too coarse.
  const node = hits.find((hit, index) => { const next = hits[index + 1]; return !next || !hit.contains(next); });
  if (!node) return null;
  const attr = node.hasAttribute('data-entry-id') ? 'data-entry-id' : 'data-section';
  return { attr, id: node.getAttribute(attr) ?? '', offset: node.getBoundingClientRect().top - top };
}

type Editor = { kind: 'token'; group: StudioTokenGroup; token: StudioToken | null; name: string; value: string }
  | { kind: 'text'; path: string; value: string; original: string | null }
  | { kind: 'github'; value: string } | { kind: 'connectors' }
  | {kind:'note';name:string;value:StudioTokenNote} | {kind:'theme';name:string;key:string};

export interface DesignSystemStudioProps {
  kit: DesignKit;
  body?: string;
  packageInfo?: DesignSystemPackageInfo;
  loadPackageInfo?: boolean;
  editable?: boolean;
  workspaceContext?: WorkspaceCollabContext | null;
  readContext?: WorkspaceCollabContext | null;
  workspaceReadGeneration?: string;
  actionsSlot?: ReactNode;
  badgeSlot?: ReactNode;
  noticeSlot?: ReactNode;
  headerMenuActions?: HeaderMenuAction[];
  onRefresh?: () => void;
  onSetup?: () => void;
  dataTestId?: string;
  /** The host already shows the system's name, so the identity bar leaves it out. */
  embedded?: boolean;
  /** Rendered after every toolbar control, e.g. a dialog's close button. */
  trailingSlot?: ReactNode;
  /** Off where the studio already fills a dialog: full screen there could only fill the dialog again. */
  expandable?: boolean;
}

export function DesignSystemStudio({ kit, body: suppliedBody, packageInfo: suppliedInfo, loadPackageInfo = false, editable = false, workspaceContext = null, readContext, workspaceReadGeneration, actionsSlot, badgeSlot, noticeSlot, headerMenuActions, onRefresh, onSetup, dataTestId = 'design-system-studio', embedded = false, trailingSlot, expandable = true }: DesignSystemStudioProps) {
  const { locale } = useI18n();
  const chinese = locale.startsWith('zh');
  const copy = chinese ? studioCopy.zh : studioCopy.en;
  const id = kit.designSystemId;
  const context = readContext === undefined ? workspaceContext : readContext;
  const identity = workspaceIdentityCacheKey(context) + ':' + (workspaceReadGeneration ?? '');
  const writeIdentity = workspaceIdentityCacheKey(workspaceContext);
  const identityRef = useRef(id+':'+identity+':'+writeIdentity);
  identityRef.current = id+':'+identity+':'+writeIdentity;
  const documentWriteRef = useRef(false);
  const resourceCacheRef=useRef(new Map<string,Promise<Blob>>());
  const [body, setBody] = useState(suppliedBody ?? '');
  const [info, setInfo] = useState(suppliedInfo);
  const [projectId, setProjectId] = useState(kit.projectId);
  const [css, setCss] = useState<string | null>(null);
  const [componentHtml, setComponentHtml] = useState<string | null>(null);
  const [documentData,setDocumentData]=useState<StudioDocument>(emptyStudioDocument);
  const [documentRaw,setDocumentRaw]=useState<string|null>(null);
  const [history,setHistory]=useState<DesignSystemRevision[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // Writes in flight, from `work` or from a chapter (dock, table, handbook): the header says 正在保存… for them all.
  const [saving, setSaving] = useState(false);
  const savesRef = useRef(0);
  const tokenSaveRef = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef(0);
  const [chapter, setChapter] = useState<StudioChapterId>('overview');
  const [section, setSection] = useState('');
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [foundationsView, setFoundationsView] = useState<FoundationsView>(readFoundationsView);
  const [packageOpen, setPackageOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [scope, setScope] = useState('');
  const [fileQuery, setFileQuery] = useState('');
  const [fileView, setFileView] = useState<{ path: string; text: string } | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  // Presses of a library heading's add button, handed to that section's catalogue.
  const [addRequests, setAddRequests] = useState<Partial<Record<LibrarySection, number>>>({});
  // Presses of a library heading's new-group button, the same way.
  const [groupRequests, setGroupRequests] = useState<Partial<Record<LibrarySection, number>>>({});
  // The package's own page reports its height; the last one is kept so a return to 组件 does not jump.
  const [componentHeight, setComponentHeight] = useState<number | null>(null);
  const componentFrameRef = useRef<HTMLIFrameElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const fontRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // Every chapter sits on one continuous page. `chapter` and `section` follow the reader's scroll and
  // name what the sticky bar shows; a jump sets them up front and holds them until the scroll lands.
  const pendingScrollRef = useRef<{ anchor: Anchor } | null>(null);
  const lastSystemRef = useRef<string | undefined>(id);
  const releaseHoldRef = useRef<(() => void) | null>(null);
  const spyHoldRef = useRef(false);
  const releaseSpyRef = useRef<(() => void) | null>(null);
  // When the loading skeleton is (or will be) visible; null while none is mounted.
  const skeletonShownRef = useRef<number | null>(null);
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);
  const [systemId, setSystemId] = useState(id);
  // Reset while rendering, not in an effect: an effect would paint one frame of the old system's
  // chapter and tokens under the new system's name.
  if (systemId !== id) {
    setSystemId(id);
    setChapter('overview'); setSection(''); setSelectedToken(null); setPackageOpen(false);
    setCss(null); setComponentHtml(null); setDocumentData(emptyStudioDocument()); setDocumentRaw(null); setHistory([]); setFiles([]);
    setLibraryQuery(''); setComponentHeight(null);
    pendingScrollRef.current = null;
  }
  const ready = !id || loadedId === id;
  const tokenPath = studioTokenFile(info);
  const canEdit = editable && Boolean(id);
  const fileUrl = (file: string) => studioFileUrl(id ?? '', file, canEdit ? projectId : undefined, context);
  useBrandFonts(projectId, kit.fonts, context, identity);

  useEffect(() => { setBody(suppliedBody ?? ''); }, [suppliedBody, id, identity]);
  useEffect(() => {
    setProjectId(kit.projectId); setEditor(null); setFileView(null); setScope('');
    window.clearTimeout(closeTimerRef.current); closeTimerRef.current = 0; setClosing(false);
  }, [id, identity, writeIdentity, kit.projectId]);
  useEffect(() => () => { window.clearTimeout(closeTimerRef.current); releaseHoldRef.current?.(); releaseSpyRef.current?.(); }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void (async () => {
      try {
        if (!id) return;
        const detail = !suppliedInfo && (loadPackageInfo || suppliedBody === undefined) ? await fetchDesignSystem(id, context) : null;
        const nextInfo = suppliedInfo ?? detail?.packageInfo;
        const nextProject = kit.projectId ?? detail?.projectId;
        const sourceProject = canEdit ? nextProject : undefined;
        const [nextCss, projectFiles, nextComponents, nextDocument, revisions] = await Promise.all([
          readStudioFile(studioFileUrl(id, studioTokenFile(nextInfo), sourceProject, context)),
          sourceProject ? fetchProjectFiles(sourceProject, { workspaceContext: context, fresh: true }) : Promise.resolve([]),
          readStudioFile(studioFileUrl(id, nextInfo?.manifest?.files?.components ?? 'components.html', sourceProject, context)),
          readStudioFile(studioFileUrl(id, STUDIO_DOCUMENT_PATH, sourceProject, context)),
          id.startsWith('user:')?fetchDesignSystemRevisions(id,context):Promise.resolve([]),
        ]);
        if (cancelled) return;
        // Parsed before anything is set: a file that fails to parse must not become the `expected` of
        // the next write, or that write would replace it with a document built from nothing.
        const parsedDocument = parseStudioDocument(nextDocument);
        setInfo(nextInfo); setProjectId(nextProject); setCss(nextCss); setComponentHtml(nextComponents);
        setDocumentRaw(nextDocument);setDocumentData(parsedDocument);setHistory(revisions.filter(revision=>revision.jobId==='studio-editor'&&revision.status==='accepted'&&revision.fileChanges?.length===1));
        if (suppliedBody === undefined && detail) setBody(detail.body);
        const names = sourceProject ? projectFiles.map((file) => file.path ?? file.name) : (nextInfo?.availableFiles ?? []);
        if(nextDocument!==null)names.push(STUDIO_DOCUMENT_PATH,'system/studio-guide.md');
        setFiles(Array.from(new Set(['DESIGN.md', ...names])).filter((name) => name === 'DESIGN.md' || isStudioPackageAsset(name)));
      } catch {
        if (!cancelled) setError(copy.loadFailed);
      } finally {
        if (!cancelled) {
          const reveal = () => { setLoading(false); setLoadedId(id); };
          // A skeleton already on screen crossfades into the page: the stagger would start from white.
          // One still held back is simply replaced, and inside a running transition the page lands in
          // the new picture.
          const shownAt = skeletonShownRef.current;
          if (shownAt !== null && performance.now() >= shownAt && !document.documentElement.dataset.studioVt) studioViewTransition('swap', reveal);
          else reveal();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [id, identity, suppliedInfo, reload, canEdit, kit.projectId, loadPackageInfo]);

  useEffect(() => {
    if (!editor && !fileView) { triggerRef.current?.focus(); return; }
    const dialog = rootRef.current?.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    const handle = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); closeDialog(); }
      if (event.key === 'Tab' && dialog) {
        const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,a[href]'));
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [Boolean(editor), Boolean(fileView)]);

  // Escape leaves full screen once nothing above the page wants it. A menu or a dialog is noted before
  // anyone handles the key, since closing one removes it before this listener runs; whatever closes on
  // Escape itself (the token dock) marks the event handled. Window bubble runs after every document listener.
  useEffect(() => {
    if (!expanded || editor || fileView) return undefined;
    let covered = false;
    const note = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') covered = Boolean(document.querySelector('[role="menu"], dialog[open]')); };
    const leave = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !covered && !event.defaultPrevented) toggleExpanded(); };
    window.addEventListener('keydown', note, true);
    window.addEventListener('keydown', leave);
    return () => { window.removeEventListener('keydown', note, true); window.removeEventListener('keydown', leave); };
  }, [expanded, Boolean(editor), Boolean(fileView)]);

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const frame = componentFrameRef.current;
      if (!frame || !event.source || event.source !== frame.contentWindow || event.data?.type !== STUDIO_PREVIEW_HEIGHT_MESSAGE) return;
      const height = Number(event.data.height);
      if (Number.isFinite(height) && height > 0) setComponentHeight(Math.min(COMPONENT_FRAME_MAX, Math.ceil(height)));
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);

  const tokens = useMemo(() => parseStudioTokens(css ?? ''), [css]);
  const scopes = useMemo(() => studioThemeScopes(tokens, documentData.themes), [tokens, documentData.themes]);
  // Some packages declare their colours only under theme selectors, with no plain :root.
  const selectedScope = scopes.includes(scope) ? scope : scopes[0] ?? ':root';
  const previewTheme = /data-theme=['"]([^'"]+)/.exec(selectedScope)?.[1] ?? 'light';
  const fontFaces = (css?.match(/@font-face\s*\{[^{}]*\}/gi) ?? []).map((face) => face.replace(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi, (_match, asset: string) => {
    const path = asset.replace(/^\.\//, '');
    return /^fonts\/[\w.\/-]+$/.test(path) && !path.includes('..') ? 'url("' + fileUrl(path) + '")' : 'url("")';
  })).join('\n');
  const overview = useMemo(() => overviewFromMarkdown(body), [body]);
  const brandBook = useMemo(() => brandBookFromMarkdown(body), [body]);
  const overviewBlocks = overview.blocks.length ? overview.blocks : [
    { title: copy.principles, body: copy.principlesHint }, { title: copy.tokensTitle, body: copy.tokensHint },
    { title: copy.componentsTitle, body: copy.componentsHint }, { title: copy.accessibility, body: copy.accessibilityHint },
  ];

  /** The opener is read before any await: by the time a file has loaded, focus may have moved on. */
  function openEditor(next: Editor, opener = document.activeElement as HTMLElement | null) { triggerRef.current = opener; cancelClose(); setError(''); setStatus(''); setEditor(next); }
  function cancelClose() { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = 0; setClosing(false); }
  function finishClose() { cancelClose(); setEditor(null); setFileView(null); }
  /** Every way out of the dialog. It plays its exit while still mounted, then the editor clears. */
  function closeDialog() {
    if (closeTimerRef.current) return;
    if (prefersReducedMotion()) { finishClose(); return; }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(finishClose, DIALOG_EXIT_MS);
  }
  /** Keeps the reader on the same entry or section across a change that reflows the page. */
  function holdPlace() {
    const scroller = scrollRef.current;
    const anchor = scroller ? readingAnchor(scroller) : null;
    pendingScrollRef.current = anchor ? { anchor } : null;
  }
  /**
   * Re-applies a restored anchor while the page settles: previews, fonts and the package frame land
   * after the first scroll and would push the reader off it. The first wheel, touch, click or key
   * from the reader ends it, so it never fights them.
   */
  function holdAnchor(scroller: HTMLElement, anchor: Anchor) {
    releaseHoldRef.current?.();
    const content = scroller.querySelector<HTMLElement>('[data-studio-page]');
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const top = anchorTop(scroller, anchor);
      if (top !== null && Math.abs(top - scroller.scrollTop) > 1) scroller.scrollTop = top;
    });
    const inputs = ['wheel', 'touchstart', 'pointerdown'] as const;
    const release = () => {
      observer.disconnect(); window.clearTimeout(timer);
      for (const name of inputs) scroller.removeEventListener(name, release);
      document.removeEventListener('keydown', release, true);
      if (releaseHoldRef.current === release) releaseHoldRef.current = null;
    };
    observer.observe(content);
    for (const name of inputs) scroller.addEventListener(name, release, { passive: true });
    document.addEventListener('keydown', release, true);
    const timer = window.setTimeout(release, PLACE_HOLD_MS);
    releaseHoldRef.current = release;
  }
  /** Holds the chips on a jump's target until the smooth scroll ends; crossing sections is not reading them. */
  function holdSpy(scroller: HTMLElement) {
    releaseSpyRef.current?.();
    spyHoldRef.current = true;
    const release = () => {
      spyHoldRef.current = false; window.clearTimeout(timer);
      scroller.removeEventListener('scrollend', release);
      if (releaseSpyRef.current === release) releaseSpyRef.current = null;
    };
    scroller.addEventListener('scrollend', release);
    const timer = window.setTimeout(release, SPY_HOLD_MS);
    releaseSpyRef.current = release;
  }
  /**
   * Every chapter is on the page already, so a jump is a scroll: to one colour's card, to a section,
   * or to the top of a chapter. The bar names the target at once and keeps it while the scroll runs.
   */
  function goTo(target: StudioJumpTarget) {
    if (target.token !== undefined) setSelectedToken(target.token);
    releaseHoldRef.current?.();
    setChapter(target.chapter);
    setSection(target.section ?? '');
    const scroller = scrollRef.current;
    if (!scroller) return;
    const card = target.token ? byAttr(scroller, 'data-palette-card', target.token) : null;
    const top = card
      ? Math.max(0, card.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - (scroller.clientHeight - card.offsetHeight) / 2)
      : target.section
        ? sectionTop(scroller, target.section)
        : target.chapter === CHAPTERS[0]
          ? 0
          : anchorTop(scroller, { attr: 'data-chapter', id: target.chapter, offset: SECTION_OFFSET });
    if (top === null) return;
    if (Math.abs(top - scroller.scrollTop) > 1) holdSpy(scroller);
    scroller.scrollTo?.({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
  function toggleExpanded() {
    studioViewTransition('expand', () => { holdPlace(); setExpanded((value) => !value); });
  }
  function changeFoundationsView(view: FoundationsView) {
    if (view === foundationsView) return;
    writeFoundationsView(view);
    studioViewTransition('swap', () => { holdPlace(); setFoundationsView(view); });
  }
  function startSaving() { savesRef.current += 1; setSaving(true); }
  function stopSaving() { savesRef.current = Math.max(0, savesRef.current - 1); if (!savesRef.current) setSaving(false); }
  /**
   * `pending` shows 正在保存… while the action runs and `done` shows 已保存 after it: reading a file
   * passes neither, and a download only the first.
   */
  async function work(action: () => Promise<void>, { pending = true, done = pending }: { pending?: boolean; done?: boolean } = {}) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setStatus('');
    if (pending) startSaving();
    const witness = identityRef.current;
    try { await action(); if (done && identityRef.current === witness) setStatus(copy.saved); }
    catch (err) { if (identityRef.current === witness) setError(err instanceof Error && /CONFLICT/.test(err.message) ? copy.conflict : err instanceof Error && /INVALID|EXISTS/.test(err.message) ? copy.invalid : copy.failed); }
    finally { busyRef.current = false; setBusy(false); if (pending) stopSaving(); }
  }
  /** A save made inside a chapter (dock, table, handbook): announced in the header, its failure left to the caller. */
  async function trackSave(action: () => Promise<void>) {
    const witness = identityRef.current;
    startSaving(); setStatus('');
    try { await action(); if (identityRef.current === witness) setStatus(copy.saved); }
    finally { stopSaving(); }
  }
  async function saveText(path: string, value: string, expected: string | null) {
    if (!canEdit || !id) throw new Error('READ_ONLY');
    const witness=identityRef.current;
    let nextProject: string | undefined;
    try { nextProject = await saveStudioFile({ id, projectId, path, content: value, expected, context: workspaceContext }); }
    catch (error) {
      // Someone else wrote the file since it was read (a rule learnt from a correction, another tab):
      // reload it, so the next attempt starts from what is on disk. The caller still reports the conflict.
      if (error instanceof Error && /CONFLICT/.test(error.message) && witness === identityRef.current) setReload((key) => key + 1);
      throw error;
    }
    if(witness!==identityRef.current)return;
    setProjectId(nextProject);
    if (path === tokenPath) setCss(value);
    if (path === 'DESIGN.md') setBody(value);
    setReload((key) => key + 1); onRefresh?.();
  }
  async function writeDocument(next:StudioDocument){
    if(documentWriteRef.current)throw new Error('SOURCE_BUSY');
    documentWriteRef.current=true;
    const witness=identityRef.current;
    const serialized=JSON.stringify(next,null,2);
    try{await saveText(STUDIO_DOCUMENT_PATH,serialized,documentRaw);if(witness===identityRef.current){setDocumentData(next);setDocumentRaw(serialized);}}
    finally{documentWriteRef.current=false;}
  }
  const saveDocument = (next: StudioDocument) => trackSave(() => writeDocument(next));
  async function saveTokens(next: string) {
    // The save names the css it expects on disk. A second one sent before the first lands would name
    // stale css and come back as a conflict, so it is refused here instead.
    if (tokenSaveRef.current) throw new Error('SOURCE_BUSY');
    tokenSaveRef.current = true;
    try { await trackSave(() => saveText(tokenPath, next, css)); }
    finally { tokenSaveRef.current = false; }
  }
  // A document holding nothing but rules (learnt from corrections, or added through the CLI) still
  // counts as not started: the starter is built around it and keeps those rules.
  const rulesOnly = documentRaw !== null && documentData.rules.length > 0 && JSON.stringify({ ...documentData, rules: [] }) === JSON.stringify({ ...emptyStudioDocument(), governance: documentData.governance });
  async function initialize(){await work(async()=>{const next=completeFoundationCss(css??'');await saveText(tokenPath,next,css);const starter=starterStudioDocument();await writeDocument(rulesOnly?appendStudioRules(starter,documentData.rules).doc:starter);});}
  const readResource=Object.assign(async(path:string)=>{const key=id+identity+reload+':'+path;let pending=resourceCacheRef.current.get(key);if(!pending){if(resourceCacheRef.current.size>100)resourceCacheRef.current.clear();pending=fetch(fileUrl(path),{cache:'no-store'}).then(response=>{if(!response.ok)throw new Error('RESOURCE_NOT_FOUND');return response.blob();});resourceCacheRef.current.set(key,pending);pending.catch(()=>resourceCacheRef.current.delete(key));}return pending;},{licenses:files.filter(file=>/\/(OFL|LICENSE|COPYING)(\.txt|\.md)?$/i.test(file))});
  async function useTemplate(entry:StudioLibraryEntry,prepared?:StudioEntryBundle){
    const bundle=prepared??await bundleStudioEntry(entry,css??'',readResource);
    const created=await createStudioEntryProject(entry,bundle,workspaceContext);
    navigate({kind:'project',projectId:created.project.id,conversationId:created.conversationId,fileName:'index.html'});
  }
  async function saveEditor() {
    if (!editor) return;
    await work(async () => {
      if (editor.kind === 'token') {
        if (typeof CSS !== 'undefined' && CSS.supports && !studioTokenValueSupported(editor.group, editor.name, editor.value, (property, value) => CSS.supports(property, value))) throw new Error('INVALID_TOKEN_VALUE');
        const next = editStudioToken(css ?? '', editor.token, editor.name, editor.value);
        await saveText(tokenPath, next, css);
      } else if (editor.kind === 'text') {
        await saveText(editor.path, editor.path==='DESIGN.md'&&documentRaw!==null?attachStudioHandbook(editor.value,documentData):editor.value, editor.original);
      } else if (editor.kind === 'github') {
        const result = await importGitHubDesignSystem({ githubUrl: editor.value.trim() });
        if ('error' in result) throw new Error('IMPORT_FAILED');
        navigate({ kind: 'design-system-detail', designSystemId: result.designSystem.id });
      } else if(editor.kind==='note'){
        await writeDocument({...documentData,tokenNotes:{...documentData.tokenNotes,[editor.name]:editor.value}});
      } else if(editor.kind==='theme'){
        if(!/^[a-z][a-z0-9-]*$/.test(editor.key)||!editor.name.trim())throw new Error('INVALID_THEME');
        const selector='[data-theme="'+editor.key+'"]';
        await writeDocument({...documentData,themes:[...documentData.themes.filter(theme=>theme.selector!==selector),{name:editor.name,selector,description:''}]});
      }
      closeDialog();
    });
  }

  async function duplicate() {
    await work(async () => {
      const draft = await createDesignSystemDraft({ title: id ? kit.name + ' — ' + copy.copyName : copy.copyName, body: body || '# ' + copy.copyName + '\n\n' + copy.intro + '\n\n' + overviewBlocks.map((block) => '## ' + block.title + '\n\n' + block.body).join('\n\n'), artifactMode: 'agent-managed' }, workspaceContext);
      if (!draft) throw new Error('CREATE_FAILED');
      const workspace = await ensureDesignSystemWorkspace(draft.id, workspaceContext);
      if (!workspace) throw new Error('WORKSPACE_UNAVAILABLE');
      // Copy only the public package surface; no project metadata or credentials.
      for (const file of files.filter(isStudioPackageAsset)) {
        const response = await fetch(fileUrl(file), { cache: 'no-store' });
        if (!response.ok) throw new Error('COPY_FAILED');
        let blob = await response.blob();
        if (file === 'manifest.json') {
          const manifest = JSON.parse(await blob.text());
          blob = new Blob([JSON.stringify({ ...manifest, id: draft.id.replace(/^user:/, ''), name: draft.title }, null, 2)], { type: 'application/json' });
        }
        if (!await uploadProjectFile(workspace.project.id, new File([blob], file.split('/').pop() ?? file), file, workspaceContext)) throw new Error('COPY_FAILED');
      }
      if (!await syncDesignSystemAssetsFromWorkspace(draft.id, workspaceContext)) throw new Error('SYNC_FAILED');
      onRefresh?.(); navigate({ kind: 'design-system-detail', designSystemId: draft.id });
    });
  }

  async function upload(selected: FileList | null) {
    if (!selected?.length || !canEdit || !id) return;
    const items = Array.from(selected);
    await work(async () => {
      const pid = projectId ?? (await ensureDesignSystemWorkspace(id, workspaceContext))?.project.id;
      if (!pid) throw new Error('WORKSPACE_UNAVAILABLE');
      setProjectId(pid);
      for (const file of items) {
        const safeName = file.name.replace(/[^\w.\-]+/g, '-').replace(/^\.+/, '') || 'brand-file';
        const isFont = /\.(woff2?|ttf|otf)$/i.test(safeName);
        const target = isFont ? 'fonts/' + safeName : 'assets/studio/' + safeName;
        if (safeName === 'tokens.css') { await saveText(tokenPath, await file.text(), css); continue; }
        if (safeName === 'components.html') {
          const componentPath = info?.manifest?.files?.components ?? 'components.html';
          await saveText(componentPath, await file.text(), await readStudioFile(fileUrl(componentPath))); continue;
        }
        const stored = await uploadProjectFile(pid, file, target, workspaceContext);
        if (!stored) throw new Error('UPLOAD_FAILED');
        if (isFont) {
          const family = safeName.replace(/\.[^.]+$/, '');
          const current = await readStudioFile(studioFileUrl(id, tokenPath, pid, workspaceContext));
          const face = '\n@font-face { font-family: "' + family + '"; src: url("./' + target + '"); font-display: swap; }\n';
          const next = editStudioToken((current ?? '') + face, null, '--font-' + family.toLowerCase().replace(/[^a-z0-9-]/g, '-') + '-' + Date.now().toString(36), '"' + family + '"');
          await saveStudioFile({ id, projectId: pid, path: tokenPath, content: next, expected: current, context: workspaceContext });
        }
      }
      if (!await syncDesignSystemAssetsFromWorkspace(id, workspaceContext)) throw new Error('SYNC_FAILED');
      setReload((key) => key + 1); onRefresh?.();
    });
  }
  async function viewFile(path: string) {
    triggerRef.current = document.activeElement as HTMLElement;
    await work(async () => {
      const text = await readStudioFile(fileUrl(path));
      if (text === null) throw new Error('FILE_NOT_FOUND');
      cancelClose(); setFileView({ path, text });
    }, { pending: false });
  }
  function editComponentSource() {
    const opener = document.activeElement as HTMLElement | null;
    void work(async () => {
      const path = componentsPath ?? 'components.html';
      const text = await readStudioFile(fileUrl(path));
      openEditor({ kind: 'text', path, value: text ?? '', original: text }, opener);
    }, { pending: false });
  }

  const addToken = (group: StudioTokenGroup) => openEditor({ kind: 'token', group, token: null, name: ({ colors: '--color-new', typography: '--font-body', spacing: '--space-new', radius: '--radius-new', shadows: '--shadow-new',motion:'--motion-new',layout:'--grid-new',measure:'--measure-new',sizing:'--size-new',layers:'--z-new',other:'--custom-new' })[group], value: ({ colors: '#353535', typography: 'system-ui', spacing: '16px', radius: '12px', shadows: '0 4px 16px rgb(0 0 0 / 0.08)',motion:'200ms',layout:'24px',measure:'65ch',sizing:'24px',layers:'10',other:'1' })[group] });
  const componentsPath = info?.manifest?.files?.components ?? (files.includes('components.html') ? 'components.html' : null);
  // The package page reports its own height, so it reads as part of the chapter instead of a cropped
  // window with a scroller of its own.
  const componentPreview = useMemo(() => componentHtml && typeof DOMParser !== 'undefined' ? studioComponentPreview(componentHtml, css ?? '', false, (asset) => {
    const path = new URL(asset, 'https://package.invalid/' + (componentsPath ?? 'components.html')).pathname.slice(1);
    return new URL(fileUrl(decodeURIComponent(path)), window.location.origin).href;
  }, undefined, true) : undefined, [componentHtml, css, componentsPath, id, projectId, identity]);
  const assetGroups = useMemo(() => studioAssetGroups(files, chinese), [files, chinese]);

  const openNote = (name: string) => openEditor({ kind: 'note', name, value: documentData.tokenNotes[name] ?? { group: '', layer: 'semantic', description: '' } });
  const isLibrary = (name: HandbookSection) => (LIBRARY_SECTIONS as string[]).includes(name);
  const handbook=(name:HandbookSection)=><StudioHandbook key={id+identity+name} section={name} document={documentData} onSave={saveDocument} editable={canEdit} busy={busy||loading} scope={id+':'+identity+':'+name} readResource={readResource} resourceRevision={reload} chinese={chinese} css={css??''} resolveAsset={path=>new URL(fileUrl(path.replace(/^\.\//,'')),window.location.origin).href} history={history} onTemplate={useTemplate} query={isLibrary(name) ? libraryQuery : undefined} addRequest={isLibrary(name) && canEdit ? addRequests[name as LibrarySection] ?? 0 : undefined} groupRequest={isLibrary(name) && canEdit ? groupRequests[name as LibrarySection] ?? 0 : undefined} previewTheme={previewTheme} onRestore={async revision=>{const change=revision.fileChanges?.[0];if(!change)throw new Error(copy.failed);const current=await readStudioFile(fileUrl(change.path));await saveText(change.path,change.proposedContent,current);}}/>;
  const actionButton = (label: string, icon: IconName, action: () => void) => <Button variant="ghost" size="sm" disabled={busy || loading} onClick={action}><Icon name={icon} size={14} />{label}</Button>;
  const isStarter = !id;

  const layers: { id: 'principles' | 'foundations' | 'components' | 'patterns' | 'templates'; label: string; done: boolean; target: StudioJumpTarget }[] = [
    { id: 'principles', label: copy.principles, done: overview.blocks.length > 0, target: { chapter: 'overview', section: 'principles' } },
    { id: 'foundations', label: copy.chapterFoundations, done: tokens.length > 0, target: { chapter: 'foundations' } },
    // A package that ships its own component page has components, even before any are catalogued.
    { id: 'components', label: copy.components, done: documentData.components.length > 0 || Boolean(componentPreview), target: { chapter: 'library', section: 'components' } },
    { id: 'patterns', label: copy.patterns, done: documentData.patterns.length > 0, target: { chapter: 'library', section: 'patterns' } },
    { id: 'templates', label: copy.templates, done: documentData.templates.length > 0, target: { chapter: 'library', section: 'templates' } },
  ];
  const completeLayers = layers.filter((layer) => layer.done).length;

  // Every system shows the same complete skeleton. A section a system leaves undefined, a preset's
  // included, keeps its place and says it is empty: hiding it would make the system read as a shorter
  // design system than the structure it is measured against. `other` is a catch-all, not a section.
  // Specimens draw some tokens under a neighbouring group (--focus-ring with shadows), so the view decides what is empty.
  // Typography also holds the type styles, the font upload and their add buttons, so an editable system always fills it.
  const hasGroup = (group: StudioTokenGroup) => (foundationsView === 'specimens' && group !== 'colors' ? studioSpecimenNames(group, tokens).length > 0 : tokens.some((token) => token.group === group)) || (group === 'typography' && (canEdit || documentData.typeStyles.length > 0));
  const foundationGroups = FOUNDATION_GROUPS.filter((group) => group !== 'other' || hasGroup(group));
  const hasLibrary = (item: LibrarySection) => documentData[item].length > 0 || (documentData.groups[item]?.length ?? 0) > 0 || (item === 'components' && Boolean(componentPreview));
  const hasGuideline: Record<GuidelineSection, boolean> = {
    content: Boolean(documentData.content.trim()),
    rules: documentData.rules.length > 0 || documentData.reviewChecks.length > 0,
    assets: Boolean(documentData.brand.trim()) || assetGroups.length > 0,
    accessibility: Boolean(documentData.accessibility.trim()) || documentData.checklist.length > 0 || tokens.length > 0,
    implementation: Object.values(documentData.implementation).some((value) => value.trim()),
    governance: Boolean(documentData.governance.owners.trim() || documentData.governance.contribution.trim() || documentData.governance.deprecation.trim()) || documentData.releases.length > 0,
  };
  const chapterSections: SectionId[] = chapter === 'foundations' ? foundationGroups : chapter === 'library' ? LIBRARY_SECTIONS : chapter === 'guidelines' ? GUIDELINE_SECTIONS : [];
  const activeSection = chapterSections.includes(section as SectionId) ? section : chapterSections[0] ?? '';
  const shownChapters: StudioChapterId[] = isStarter ? ['overview'] : CHAPTERS;
  // The section menu lists every section of every chapter, in reading order; the other language's
  // label is searchable too, so 颜色 finds Colors and Colors finds 颜色. An empty one is listed, dimmed.
  const navItem = (chapterId: StudioChapterId, item: SectionId, filled: boolean): StudioNavItem => ({
    id: item, chapter: chapterId, section: item, label: copy[item], icon: item as StudioNavIcon,
    keywords: studioCopy.en[item] + ' ' + studioCopy.zh[item], empty: filled ? undefined : copy.sectionEmptyTag,
  });
  const overviewItem: StudioNavItem = { id: 'overview', chapter: 'overview', label: copy.chapterOverview, icon: 'overview', keywords: studioCopy.en.chapterOverview + ' ' + studioCopy.zh.chapterOverview + ' readme principles 原则 手册' };
  const navGroups: StudioNavItem[][] = [
    [overviewItem],
    foundationGroups.map((item) => navItem('foundations', item, hasGroup(item))),
    LIBRARY_SECTIONS.map((item) => navItem('library', item, hasLibrary(item))),
    GUIDELINE_SECTIONS.map((item) => navItem('guidelines', item, hasGuideline[item])),
  ];
  const filesItem: StudioNavItem = { id: 'files', chapter: 'files', label: copy.files, icon: 'files', count: files.length, keywords: studioCopy.en.files + ' ' + studioCopy.zh.files };
  const currentNav = chapter === 'overview' || chapter === 'files' ? chapter : activeSection || chapterSections[0] || chapter;
  function selectNav(item: StudioNavItem) {
    goTo({ chapter: item.chapter, section: item.section });
  }
  const sectionMenu = <StudioSectionMenu groups={navGroups} files={filesItem} current={currentNav} label={copy.sectionMenu} searchLabel={copy.sectionSearch} emptyLabel={copy.sectionEmpty} position={(index, total) => copy.sectionPosition.replace('{n}', String(index + 1)).replace('{total}', String(total))} onSelect={selectNav} />;
  const navBar = (tools?: ReactNode) => <StudioNavBar label={copy.navigation} menu={sectionMenu}>{tools}</StudioNavBar>;

  // Inside the transition's update (full screen, specimens ⇄ table), so the new picture is captured
  // already in place. The microtask waits for the layout effects of the page's own children: the colour
  // board measures its columns in one, and a height that changes after this point would land the page
  // on the wrong section. Another system starts at its top.
  useLayoutEffect(() => {
    let current = true;
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = null;
    const switched = lastSystemRef.current !== id;
    lastSystemRef.current = id;
    queueMicrotask(() => {
      const scroller = scrollRef.current;
      if (!current || !scroller) return;
      const anchor = pending?.anchor ?? null;
      const top = anchor ? anchorTop(scroller, anchor) : null;
      if (anchor && top !== null) { scroller.scrollTop = top; holdAnchor(scroller, anchor); return; }
      releaseHoldRef.current?.();
      if (switched) scroller.scrollTop = 0;
    });
    return () => { current = false; };
  }, [expanded, id, foundationsView]);

  // The bar follows the reader across chapter boundaries: whichever chapter or section has passed the
  // reading line (a third of the way down, never above the sticky bar) is where the reader is. At the
  // very end the last marker speaks, since a short last section never climbs that far.
  const spiedStructure = shownChapters.join(' ') + '|' + navGroups.flat().map((item) => item.id).join(' ');
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !ready || isStarter) return undefined;
    let frame = 0;
    const read = () => {
      frame = 0;
      if (spyHoldRef.current) return;
      const markers = Array.from(root.querySelectorAll<HTMLElement>('[data-chapter], [data-chapter] [data-section]')).filter(laidOut);
      if (!markers.length) return;
      const atEnd = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      const line = root.getBoundingClientRect().top + Math.max(SECTION_OFFSET + 8, root.clientHeight * 0.32);
      let hit: HTMLElement = markers[0]!;
      if (atEnd) hit = markers[markers.length - 1]!;
      else for (const node of markers) { if (node.getBoundingClientRect().top <= line) hit = node; else break; }
      const owner = hit.closest<HTMLElement>('[data-chapter]');
      const nextChapter = (owner?.dataset.chapter ?? CHAPTERS[0]) as StudioChapterId;
      setChapter(nextChapter);
      setSection(hit === owner ? '' : hit.getAttribute('data-section') ?? '');
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    // A jump ends on `scrollend`; the bar then reads the page once more in case it landed short.
    const onEnd = () => { if (!spyHoldRef.current) onScroll(); };
    read();
    root.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('scrollend', onEnd);
    return () => { cancelAnimationFrame(frame); root.removeEventListener('scroll', onScroll); root.removeEventListener('scrollend', onEnd); };
  }, [ready, expanded, id, isStarter, spiedStructure]);

  const packageFrame = componentPreview ? <div className={styles.componentFrame}><iframe ref={componentFrameRef} title={copy.components} srcDoc={componentPreview} sandbox="allow-scripts allow-popups" loading="lazy" scrolling="no" style={componentHeight ? { height: componentHeight } : undefined} /></div> : null;
  const packagePreview = packageFrame ? <div className={styles.packagePreview}>
    <button type="button" className={styles.packageToggle} aria-expanded={packageOpen} onClick={() => setPackageOpen(!packageOpen)}><Icon name="chevron-down" size={14} />{copy.packagePreview}</button>
    <div className={styles.disclosure} data-open={packageOpen || undefined}><div className={styles.disclosureInner}>{packageFrame}</div></div>
  </div> : null;
  // A preset whose catalogue is empty has one thing to show, so it needs neither an empty catalogue nor a disclosure.
  const packageOnly = !canEdit && !documentData.components.length && Boolean(packageFrame);

  const frame = (sectionId: SectionId, index: number, body: ReactNode, actions?: ReactNode) => <section key={sectionId} data-section={sectionId} className={styles.section} style={{ '--i': index } as CSSProperties}>
    <div className={styles.sectionHeader}>
      <div className={styles.sectionTitle}><h2>{copy[sectionId]}</h2><p>{sectionId === 'components' ? (packageOnly ? copy.componentsSample : copy.componentsHint2) : sectionId === 'colors' && foundationsView === 'table' ? copy.colorsTableHint : copy[(sectionId + 'Hint') as keyof typeof copy]}</p></div>
      {actions ? <div className={styles.sectionActions}>{actions}</div> : null}
    </div>
    {body}
  </section>;

  // One theme switch, the same in every chapter that paints with the system: 概览, 基础 and 组件.
  const themeSwitch = scopes.length > 1 ? <Segmented size="sm" aria-label={copy.themeLabel} value={selectedScope} onValueChange={setScope}>{scopes.map((item) => <SegmentedItem key={item} value={item}>{studioScopeLabel(item, documentData.themes, chinese)}</SegmentedItem>)}</Segmented> : null;
  // The same choice for the sticky bar of 基础, which it shares with every section chip.
  const themePicker = scopes.length > 1 ? <ListSelect value={selectedScope} onValueChange={setScope}>
    <SelectTrigger size="sm" className={styles.themePicker} aria-label={copy.themeLabel}><SelectValue /></SelectTrigger>
    <SelectContent>{scopes.map((item) => <SelectItem key={item} value={item}>{studioScopeLabel(item, documentData.themes, chinese)}</SelectItem>)}</SelectContent>
  </ListSelect> : null;
  const specimens = (group: StudioTokenGroup) => group === 'colors'
    ? <StudioColorBoard tokens={tokens} scope={selectedScope} notes={documentData.tokenNotes} chinese={chinese} selected={selectedToken} onSelect={setSelectedToken} />
    : <StudioSpecimens group={group} tokens={tokens} scope={selectedScope} notes={documentData.tokenNotes} chinese={chinese} selected={selectedToken} onSelect={setSelectedToken} />;
  const groupBody = (group: StudioTokenGroup) => <>
    {foundationsView === 'table'
      ? <StudioTokenTable css={css ?? ''} group={group} document={documentData} editable={canEdit} busy={busy || loading || saving} chinese={chinese} onSave={saveTokens} onNote={openNote} />
      : specimens(group)}
    {group === 'typography' && (canEdit || documentData.typeStyles.length > 0) && <div className={styles.typeStyles}>{handbook('typeStyles')}</div>}
  </>;
  const groupActions = (group: StudioTokenGroup) => canEdit ? <>{actionButton(copy.add, 'plus', () => addToken(group))}{group === 'typography' && actionButton(copy.uploadFont, 'upload', () => fontRef.current?.click())}</> : undefined;

  const foundationsTools = <>
    {/* The table lays every theme out side by side, so a theme switch would do nothing there. */}
    {foundationsView === 'specimens' && themePicker}
    <Segmented size="sm" aria-label={copy.viewLabel} value={foundationsView} onValueChange={(value) => changeFoundationsView(value as FoundationsView)}><SegmentedItem value="specimens">{copy.viewSpecimens}</SegmentedItem><SegmentedItem value="table">{copy.viewTable}</SegmentedItem></Segmented>
  </>;
  // What an undefined section holds: one quiet line. An editable system adds from the heading's button.
  const emptyBody = (text: string, searchable = false) => <p className={styles.empty} data-section-empty="" data-no-match={searchable && libraryQuery.trim() ? '' : undefined}>{text}</p>;
  const foundationsChapter = <>
    <div className={styles.column}>
      {foundationGroups.map((group, index) => frame(group, index, hasGroup(group) ? groupBody(group) : emptyBody(canEdit ? copy.groupEmptyEditable : copy.sectionEmptyPreset), groupActions(group)))}
      {foundationsView === 'specimens' && <StudioTokenDock name={selectedToken && tokens.some((token) => token.name === selectedToken) ? selectedToken : null} scope={selectedScope} css={css ?? ''} document={documentData} editable={canEdit} busy={busy || loading || saving} chinese={chinese} onSave={saveTokens} onNote={openNote} onClose={() => setSelectedToken(null)} />}
    </div>
  </>;

  // A preset's empty catalogue is a line, not an invitation: there is nothing it can add.
  const libraryBody = (item: LibrarySection) => !canEdit && !hasLibrary(item) ? emptyBody(copy.sectionEmptyPreset, true) : item !== 'components' ? handbook(item) : packageOnly ? packageFrame : <>{handbook('components')}{packagePreview}</>;
  // An empty catalogue offers adding in its own empty state, so the heading only carries it once
  // there is something to add to: an entry or a group. A read-only system has nothing to add to.
  const libraryActions = (item: LibrarySection) => {
    if (!canEdit) return undefined;
    const addable = documentData[item].length > 0 || (documentData.groups[item]?.length ?? 0) > 0;
    const add = addable ? actionButton(copy.add, 'plus', () => setAddRequests((current) => ({ ...current, [item]: (current[item] ?? 0) + 1 }))) : null;
    const source = item === 'components' ? actionButton(copy.editSource, 'file-code', editComponentSource) : null;
    // Groups are the user's own: any catalogue can gain one, even before it holds an entry.
    const group = actionButton(copy.newGroup, 'folder', () => setGroupRequests((current) => ({ ...current, [item]: (current[item] ?? 0) + 1 })));
    return <>{add}{group}{source}</>;
  };
  const chipColumn = styles.column;
  // One search and one theme for the whole chapter, read by every catalogue below. A preset with no
  // catalogue entries (at most its sample page) has nothing to search.
  const hasCatalog = canEdit || LIBRARY_SECTIONS.some((item) => documentData[item].length > 0);
  const libraryChapter = <>
    <div className={chipColumn}>
      {hasCatalog && <div className={styles.libraryTools}>
        <SearchField className={styles.search} type="search" aria-label={copy.librarySearch} placeholder={copy.librarySearchHint} value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} />
        {themeSwitch}
      </div>}
      {LIBRARY_SECTIONS.map((item, index) => frame(item, index, libraryBody(item), libraryActions(item)))}
      {/* Shown by CSS only when every section above reports no match. */}
      {libraryQuery.trim() && <p className={styles.libraryEmpty}>{copy.libraryEmpty}</p>}
    </div>
  </>;

  // The brand handbook prints its own empty line, so a missing library adds nothing. Each folder under
  // assets/ is a group, as in Claude Design: pictures preview, video plays, anything else downloads.
  const assetsBody = <>
    {handbook('brand')}
    {assetGroups.map((group) => <section key={group.key} className={styles.assetGroup} data-asset-group={group.key || 'other'}>
      <h3>{group.label}<span>{group.assets.length}</span></h3>
      <div className={styles.assets} data-size={group.key === 'icons' ? 's' : undefined}>{group.assets.map((asset) => <a key={asset.path} href={fileUrl(asset.path)} target="_blank" rel="noreferrer" download={asset.kind === 'file' ? asset.name : undefined} title={asset.path}>
        <div>{asset.kind === 'image' ? <img src={fileUrl(asset.path)} alt={asset.name} loading="lazy" /> : asset.kind === 'video' ? <video src={fileUrl(asset.path)} muted playsInline preload="metadata" aria-label={asset.name} /> : <Icon name="file" size={22} />}</div>
        <span>{asset.name}</span>
      </a>)}</div>
    </section>)}
  </>;
  // An editable section keeps its own empty state, where writing starts; a preset's says it is empty.
  const guidelinesChapter = <>
    <div className={chipColumn}>
      {GUIDELINE_SECTIONS.map((item, index) => !canEdit && !hasGuideline[item]
        ? frame(item, index, emptyBody(copy.sectionEmptyPreset))
        : item === 'assets'
          ? frame(item, index, assetsBody, canEdit ? actionButton(copy.newSet, 'plus', () => uploadRef.current?.click()) : undefined)
          : frame(item, index, handbook(item)))}
    </div>
  </>;

  const filesChapter = <><div className={styles.column}>
    {frame('files', 0, <>
      <SearchField className={styles.search} type="search" aria-label={copy.searchFiles} placeholder={copy.searchFiles + '…'} value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} />
      <div className={styles.files}>{files.filter((file) => file.toLowerCase().includes(fileQuery.toLowerCase())).map((file) => <div key={file}><Icon name="file" size={16} /><button type="button" onClick={() => void viewFile(file)} disabled={busy || !/\.(md|css|html|json|txt)$/i.test(file)}>{file}</button><a href={fileUrl(file)} download={file.split('/').pop()} aria-label={copy.download + ': ' + file} title={copy.download} target="_blank" rel="noreferrer"><Icon name="download" size={15} /></a></div>)}</div>
    </>)}
  </div></>;

  const overviewActions = <>
    {isStarter && <Button variant="primary" size="sm" disabled={busy || loading} onClick={() => void duplicate()}><Icon name="plus" size={14} />{copy.create}</Button>}
    {!isStarter && !canEdit && actionButton(copy.copy, 'copy', () => void duplicate())}
    {canEdit && actionButton(copy.addTheme, 'plus', () => openEditor({ kind: 'theme', name: '', key: '' }))}
    {canEdit && (documentRaw === null || rulesOnly) && actionButton(copy.initialize, 'blocks', () => void initialize())}
    {/* Brings a system built from an older starter up to the guidance this build ships: the measure and
        sizing tokens it lacks, then the document. A system the starter never made is not offered it. */}
    {canEdit && documentRaw !== null && (documentData.catalogVersion ?? 1) < STUDIO_STARTER_VERSION && isStudioStarterDocument(documentData) && actionButton(copy.upgradeCatalog, 'refresh', () => void work(async () => { const nextCss = completeSizingCss(css ?? ''); if (nextCss !== (css ?? '')) await saveText(tokenPath, nextCss, css); await writeDocument(upgradeStudioStarterCatalog(documentData, new Set(parseStudioTokens(nextCss).map((token) => token.name)))); }))}
    {/* 深色 recolours the poster and tiles too, so the switch is where they are. */}
    {themeSwitch}
  </>;
  // Getting started is for a system that has barely begun. A preset can never act on it, and the
  // starter has no system yet to put the files in.
  const startSources = isStarter || (canEdit && completeLayers < 2) ? <>
    <h2 className={styles.startTitle}>{copy.start}</h2>
    <div className={styles.sources}>
    <button type="button" onClick={() => openEditor({ kind: 'github', value: '' })}><span className={styles.sourceIcon}><Icon name="github" size={18} /></span><strong>{copy.github}</strong><p>{copy.githubHint}</p></button>
    <button type="button" onClick={() => openEditor({ kind: 'connectors' })}><span className={styles.sourceIcon}><Icon name="blocks" size={18} /></span><strong>{copy.connectors}</strong><p>{copy.connectorsHint}</p></button>
    <button type="button" onClick={() => uploadRef.current?.click()} disabled={busy || loading || isStarter}><span className={styles.sourceIcon}><Icon name="upload" size={18} /></span><strong>{copy.upload}</strong><p>{copy.uploadHint}</p></button>
    </div>
  </> : undefined;
  // Claude Design's overview: the cover and the brand book on one sheet, the chapter's actions in the bar.
  const overviewChapter = <>
    <div className={styles.column + ' ' + (isStarter ? styles.columnPlain : styles.columnFlush)}>
      <StudioOverview name={kit.name || copy.copyName} intro={overview.intro || kit.description || copy.intro} book={brandBook} blocks={canEdit ? overviewBlocks : overview.blocks} placeholderBlocks={canEdit && !overview.blocks.length} tokens={tokens} scope={selectedScope} document={documentData} chinese={chinese} starter={isStarter} canEdit={canEdit} busy={busy || loading} layers={layers} version={documentData.governance.version} onJump={goTo} onEditDocument={canEdit ? () => openEditor({ kind: 'text', path: 'DESIGN.md', value: stripStudioHandbook(body), original: body }) : undefined} actions={isStarter ? overviewActions : undefined} start={startSources} />
    </div>
  </>;
  const chapterBodies: Record<StudioChapterId, ReactNode> = { overview: overviewChapter, foundations: foundationsChapter, library: libraryChapter, guidelines: guidelinesChapter, files: filesChapter };
  // One sticky bar over the whole page; its switches are those of the chapter being read.
  const chapterTools: Partial<Record<StudioChapterId, ReactNode>> = { overview: overviewActions, foundations: foundationsTools };
  const pageContent = <>
    {!isStarter && navBar(chapterTools[chapter])}
    {shownChapters.map((item) => <div key={item} data-chapter={item} className={styles.chapterBlock}>{chapterBodies[item]}</div>)}
  </>;
  const statusText = saving ? copy.saving : status;

  // No portal for full screen: `.expanded` is position:fixed from where the studio already sits, so
  // nothing remounts, and search text, focus, open cards and loaded previews all stay.
  return <div className={styles.root + (isStarter ? ' ' + styles.rootStarter : '') + (expanded ? ' ' + styles.expanded : '') + ' fx'} ref={rootRef} data-testid={dataTestId} data-studio-ready={ready || undefined}>
    {fontFaces && <style>{fontFaces}</style>}
    {!isStarter && <header className={styles.header}>
      <div className={styles.identity}>
        <div className={styles.lead}>
          {(!embedded || expanded) && <span className={styles.name} title={kit.name}>{studioDisplayName(kit.name)}</span>}
          {badgeSlot}
          <span className={styles.state}><span aria-live="polite"><span key={statusText} className={styles.stateText}>{statusText}</span></span>{!canEdit && id && <span>{id.startsWith('user:') ? copy.readOnlyPlain : copy.readOnly}</span>}</span>
        </div>
        <div className={styles.toolbarActions}>
          {actionsSlot}
          {canEdit && <Button variant="bare" size="icon-sm" title={copy.export} aria-label={copy.export} disabled={busy || loading} onClick={() => void work(async () => { if (!id || !await downloadDesignSystemArchive({ designSystemId: id, fallbackTitle: kit.name, workspaceContext })) throw new Error(copy.failed); }, { done: false })}><Icon name="download" size={15} /></Button>}
          {headerMenuActions?.length ? <HeaderActionsMenu groups={[headerMenuActions]} label={copy.more} /> : null}
          {expandable && <Button variant="bare" size="icon-sm" title={expanded ? copy.collapse : copy.expand} aria-label={expanded ? copy.collapse : copy.expand} onClick={toggleExpanded}><Icon name={expanded ? 'minimize' : 'maximize'} size={15} /></Button>}
          {trailingSlot}
        </div>
      </div>
    </header>}
    {error && !editor && <div className={styles.errorBar}><div className={styles.error} role="alert">{error}<Button variant="ghost" size="sm" onClick={() => setReload((key) => key + 1)}><Icon name="refresh" size={14} />{copy.retry}</Button></div></div>}
    <div className={styles.scroll + ' ' + styles.pageName + (isStarter ? ' ' + styles.scrollStarter : '')} ref={scrollRef} data-studio-scroll="" {...(isStarter ? {} : { role: 'region', 'aria-label': copy.chapters, tabIndex: -1 })}>
      {noticeSlot ? <div className={styles.notice}>{noticeSlot}</div> : null}
      {ready ? <ChapterPage key={id ?? ''}>{pageContent}</ChapterPage> : <ChapterSkeleton label={copy.loading} shownRef={skeletonShownRef} />}
    </div>
    <input ref={uploadRef} type="file" multiple hidden onChange={(event) => { void upload(event.target.files); event.target.value = ''; }} />
    <input ref={fontRef} type="file" accept=".woff,.woff2,.ttf,.otf" multiple hidden onChange={(event) => { void upload(event.target.files); event.target.value = ''; }} />
    {(editor || fileView) && <div className={styles.overlay} data-closing={closing || undefined} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) closeDialog(); }}><div role="dialog" aria-modal="true" aria-label={editor?.kind === 'token' ? copy[editor.group] : fileView?.path ?? copy.edit} className={styles.dialog}>
      <header><h3>{editor?.kind === 'token' ? copy[editor.group] : editor?.kind === 'github' ? copy.github : editor?.kind === 'connectors' ? copy.connectors : fileView?.path ?? (editor?.kind === 'text' ? editor.path : copy.edit)}</h3><Button variant="ghost" size="sm" aria-label={copy.close} disabled={busy} onClick={closeDialog}><Icon name="close" size={18} /></Button></header>
      {editor?.kind === 'token' && <div className={styles.fields}><label>{copy.name}<input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label><label>{copy.value}<input value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} /></label>{editor.group === 'colors' && /^#[\da-f]{6}$/i.test(editor.value) && <input type="color" aria-label={copy.colors} value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} />}</div>}
      {editor?.kind === 'text' && <Textarea className={styles.textEditor} value={editor.value} aria-label={editor.path} onChange={(event) => setEditor({ ...editor, value: event.target.value })} />}
      {editor?.kind === 'github' && <div className={styles.fields}><p>{copy.importHint}</p><label>{copy.repository}<input type="url" placeholder="https://github.com/owner/repository" value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} /></label></div>}
      {editor?.kind === 'connectors' && <p>{copy.connectorsInfo}</p>}
      {editor?.kind==='note'&&<div className={styles.fields}><strong>{editor.name}</strong><label>{copy.group}<input value={editor.value.group} onChange={event=>setEditor({...editor,value:{...editor.value,group:event.target.value}})}/></label><label>{copy.layer}<Select value={editor.value.layer} onChange={event=>setEditor({...editor,value:{...editor.value,layer:event.target.value as StudioTokenNote['layer']}})}><option value="primitive">Primitive · 基础</option><option value="semantic">Semantic · 语义</option><option value="component">Component · 组件</option></Select></label><label>{copy.description}<Textarea value={editor.value.description} onChange={event=>setEditor({...editor,value:{...editor.value,description:event.target.value}})}/></label></div>}
      {editor?.kind==='theme'&&<div className={styles.fields}><label>{copy.themeName}<input value={editor.name} onChange={event=>setEditor({...editor,name:event.target.value})}/></label><label>{copy.themeKey}<input value={editor.key} placeholder="high-contrast" onChange={event=>setEditor({...editor,key:event.target.value})}/></label><p>{copy.themeHint}</p></div>}
      {fileView && <pre className={styles.sourceText}>{fileView.text}</pre>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <footer><Button variant="ghost" size="sm" disabled={busy} onClick={closeDialog}>{fileView ? copy.close : copy.cancel}</Button>{editor?.kind === 'connectors' ? <Button variant="primary" size="sm" onClick={() => { closeDialog(); if (onSetup) onSetup(); else navigate({ kind: 'design-system-create' }); }}>{copy.openSetup}</Button> : editor ? <Button variant="primary" size="sm" disabled={busy || (!canEdit && editor.kind !== 'github') || (editor.kind === 'github' && !editor.value.trim())} onClick={() => void saveEditor()}>{busy ? copy.saving : editor.kind === 'github' ? copy.import : copy.save}</Button> : null}</footer>
    </div></div>}
  </div>;
}

/**
 * One chapter's page. Its entrance stagger plays only when the page arrives without a view transition:
 * inside one the browser already animates a picture of the page, a stagger would drift within that
 * picture, and the boxes would still be moving when the page measures where to scroll.
 */
function ChapterPage({ children }: { children: ReactNode }) {
  const [enter] = useState(() => typeof document === 'undefined' || !document.documentElement.dataset.studioVt);
  return <div className={styles.chapter} data-studio-page="" data-studio-enter={enter ? '' : undefined}>{children}</div>;
}

/**
 * Stands in for the overview, the only chapter a system opens on. The CSS holds it back for a beat so
 * a fast load never sees it, except inside a transition: there it is the new picture, and a held-back
 * skeleton would leave the pane blank once the old page has faded. `shownRef` records when it is on
 * screen, so the page that replaces it can crossfade instead of rising out of white.
 */
function ChapterSkeleton({ label, shownRef }: { label: string; shownRef: MutableRefObject<number | null> }) {
  const [instant] = useState(() => typeof document !== 'undefined' && Boolean(document.documentElement.dataset.studioVt));
  useLayoutEffect(() => {
    shownRef.current = performance.now() + (instant ? 0 : SKELETON_HOLD_MS);
    return () => { shownRef.current = null; };
  }, []);
  return <div className={styles.column + ' ' + styles.columnPlain}>
    <div className={styles.skeleton} data-instant={instant || undefined} role="status" aria-label={label} aria-busy="true">
      <div className={styles.skeletonPoster}>
        <Skeleton shape="line" className={styles.skeletonCaption} />
        <Skeleton className={styles.skeletonTitle} index={1} />
        <Skeleton shape="line" className={styles.skeletonLine} index={2} />
        <Skeleton shape="line" className={styles.skeletonLineShort} index={3} />
        <Skeleton className={styles.skeletonStrip} index={4} />
      </div>
      <div className={styles.skeletonTiles}>{[0, 1, 2].map((index) => <Skeleton key={index} index={index + 1} />)}</div>
    </div>
  </div>;
}
