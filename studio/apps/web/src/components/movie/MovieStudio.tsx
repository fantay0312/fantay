// SPDX-License-Identifier: Apache-2.0
// The film editor (spec 07 §4, §6). presentation "project": the project's movie-studio.json opened in
// place in the workspace 文件 root (MotionEditorHost). It has no chat of its own: AI tasks go to the
// project's main chat through `chat.send` (skill `fantay-movie`), the film refetches when the file
// changes, and unsaved edits survive tab switches (movie-draft-cache). presentation "embedded": the
// chrome-free MCP Apps surface (`/movie-app/:id`, MovieEmbeddedApp), which keeps its SideChatTab.
// The film library and creation live in apps/web/src/fantay/motion (07 §5.2).
// Layout (07 §6.2): toolbar 44 / stage bar 40 / messages / body = edit pane with a 56px stage footer
// (exactly one primary) | inspector; on a narrow editor the inspector docks under the pane.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  Film,
  FolderOpen,
  MoreHorizontal,
  PanelBottom,
  Pause,
  Play,
  Plus,
  Redo2,
  Save,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  MOVIE_DOCUMENT_FILE,
  MOVIE_STYLES,
  movieAssistPrompt,
  movieCurrentRender,
  movieDuration,
  movieFps,
  MOVIE_MAX_CLIPS,
  MOVIE_MAX_DURATION,
  movieShotStarts,
  type LibraryAsset,
  type MaterialSummaryItem,
  type MovieAction,
  type HtmlRenderer,
  type MovieDocument,
  type MovieEditOperation,
  type MovieEditResponse,
  type MovieFeedbackResponse,
  type MovieLayout,
  type MovieNoteTarget,
  type MovieSettings,
  type MovieShot,
  type MovieStage,
  type MovieStyle,
  type MovieVideoSource,
  type WorkspaceCollabContext,
} from "@open-design/contracts";

import { workspaceIdentityCacheKey, workspaceResourceUrl } from "../../collab/workspace-identity";
import { useI18n } from "../../i18n";
import type { Dict } from "../../i18n/types";
import { isMovieNotFound, movieRequest, movieStyleRequest, getMovieVideoSources, initializeMovieEditor, uploadMovieMedia } from "../../providers/movie";
import { buildPath, registerNavigationGuard } from "../../router";
import { createConversation, listConversations, listProjects } from "../../state/projects";
import type { AgentInfo, AppConfig, Conversation, Project } from "../../types";
import type { ProjectChatSendResult } from "../../fantay/chat/project-chat-bridge";
import { MotionCreateError, importVideos, loadPersonalStyles } from "../../fantay/motion/motion-create";
import { openMotionCreate } from "../../fantay/motion/motion-create-store";
import { formatMotionTime, isMovieBusy, motionFrameSize, movieRawUrl } from "../../fantay/motion/motion-model";
import { motionEditorRoute } from "../../fantay/motion/motion-projects";
import { stashMovieDraft, takeMovieDraft } from "../../fantay/motion/movie-draft-cache";
import { MoviePreviewFrame, type MoviePreviewFrameHandle } from "../../fantay/motion/MoviePreviewFrame";
import { Scrubber } from "../../fantay/motion/Scrubber";
import { StyleFields } from "../../fantay/motion/StyleFields";
import { useMoviePreviewClock } from "../../fantay/motion/useMoviePreviewClock";
import {
  Button,
  Callout,
  Chip,
  Disclosure,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FxLegacy,
  Icon,
  IconButton,
  Input,
  MenuItemIcon,
  Modal,
  ModalTitle,
  Progress,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  StatusLabel,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  cn,
} from "../../fantay/ui";
import { MaterialPickerDialog } from "../materials/MaterialPickerDialog";
import { SideChatTab } from "../workspace/SideChatTab";
import { MovieConnection } from "./MovieConnection";
import { MovieEditReceipt } from "./MovieEditReceipt";
import { MovieReviewNotes } from "./MovieReviewNotes";
import { MovieLiveTools, MovieLiveMarkers, type MovieLiveToolsHandle } from './MovieLiveTools';
import { MovieReviewPlayer, type MovieReviewPlayerHandle } from "./MovieReviewPlayer";
import { MovieSelectionEditor } from "./MovieSelectionEditor";
import { MovieSources } from "./MovieSources";
import { MovieStoryboard } from "./MovieStoryboard";
import { MovieTimeline } from "./MovieTimeline";
import { MovieEditingWorkspace } from "./MovieEditingWorkspace";
import { getOpenDesignHost } from "@open-design/host";
import { MovieTrackTimeline } from "./MovieTrackTimeline";
import { MovieCompactInspector } from "./MovieCompactInspector";
import { movieCutOperations, movieDuplicatePlacement, movieEditPoint, movieLocalTime, movieLockOperations, movieTargetShot, useMovieEditorActions, type MovieInspectorRequest } from "./movie-editor-layout";
import { getMoviePref, setMoviePref } from "./movie-editor-prefs";
import type { MovieExternalChange } from "./MovieEditingWorkspace";
import { TokenToSeaServices } from "../tokentosea/TokenToSeaServices";
import { workspaceProjectHeaders } from "../../collab/workspace-identity";
import { MovieStudioLegacyRoute, type LegacyMovieStudioRouteProps } from "./MovieStudioLegacyRoute";
import { MovieVideoPicker } from "./MovieVideoPicker";
import styles from "./MovieStudio.module.css";

/** Where the editor's AI tasks go (07 §4.2). */
export type MovieStudioChat =
  | { mode: "main"; busy: boolean; send: (prompt: string) => Promise<ProjectChatSendResult>; reveal: () => void }
  | { mode: "side"; config: AppConfig; agents: AgentInfo[]; projects: Project[]; executionSwitcher: ReactNode };

export interface MovieStudioProps {
  presentation: "project" | "embedded";
  projectId: string;
  isActive: boolean;
  workspaceContext?: WorkspaceCollabContext | null;
  chat: MovieStudioChat;
  /** project: viewerOnly collaborators → every editing control disabled, banner motion.editor.readOnly. */
  readOnly?: boolean;
  /** project: movie-studio.json mtime; a change triggers one GET /movie when not dirty. */
  fileVersion?: number;
  /** project: back to board (hidden when undefined); embedded: back to the film list. */
  onExit?: () => void;
  /** embedded only: first AI task to dispatch through SideChatTab once the conversation is ready. */
  initialAiPrompt?: { id: string; prompt: string } | null;
  /** Dedicated animation-style root. It does not expose web design systems. */
  styleWorkspace?: boolean;
}

export type { LegacyMovieStudioRouteProps } from "./MovieStudioLegacyRoute";

/** The tabbed inspector, docked in the full workbench and in the compact pane's Adjust popover. */
function EditorInspector(props: Omit<ComponentProps<typeof MovieCompactInspector>, "layout" | "onOpenExport" | "onOpenJianying">) {
  const actions = useMovieEditorActions();
  return <MovieCompactInspector {...props} layout="tabs" onOpenExport={actions.openExport} onOpenJianying={actions.openJianying} />;
}

/** The timeline, wired to workspace actions: double-click reveals the inspector; badges/chips open a tab. */
function EditorTimeline({ onInspectorRequest, ...props }: Omit<ComponentProps<typeof MovieTrackTimeline>, "onOpenInspector" | "onRequestInspector"> & { onInspectorRequest(request: Omit<MovieInspectorRequest, "nonce">): void }) {
  const actions = useMovieEditorActions();
  return <MovieTrackTimeline {...props} onOpenInspector={actions.openInspector} onRequestInspector={request => { onInspectorRequest(request); actions.openInspector(); }} />;
}

function isEditorProps(props: MovieStudioProps | LegacyMovieStudioRouteProps): props is MovieStudioProps {
  return "chat" in props && props.chat !== undefined;
}

export function MovieStudio(props: MovieStudioProps | LegacyMovieStudioRouteProps) {
  // W2 → W3 bridge: EntryShell still mounts MovieStudio with the old route props for /movie-app,
  // /movies and /create/animation until W3-app-integration swaps in MovieEmbeddedApp (07 §5.4).
  if (!isEditorProps(props)) return <MovieStudioLegacyRoute {...props} />;
  // A different project or workspace identity is a different editor: remount with fresh state.
  const key = `${props.projectId}\u0000${workspaceIdentityCacheKey(props.workspaceContext)}`;
  return <MovieStudioEditor key={key} {...props} />;
}

type LoadState = "loading" | "ready" | "missing" | "error";
type InspectorTab = "notes" | "edit" | "settings" | "chat";
type EditorStage = MovieStage | "timeline" | "generate";
type StageGroup = "edit" | "plan" | "produce" | "review";
interface EditorNotice {
  text: string;
  showChat?: boolean;
}
interface PromptRequest {
  id: string;
  projectId: string;
  conversationId: string;
  prompt: string;
}

const STAGE_GROUP: Record<EditorStage, StageGroup> = {
  timeline: "edit",
  generate: "edit",
  style: "plan",
  storyboard: "plan",
  samples: "plan",
  render: "produce",
  review: "review",
  deliver: "review",
};
const GROUP_ENTRY: Record<StageGroup, EditorStage> = { edit: "timeline", plan: "samples", produce: "render", review: "review" };
const PLAN_STAGES: ReadonlyArray<{ stage: MovieStage; label: keyof Dict; text: keyof Dict }> = [
  { stage: "style", label: "motion.stage.style", text: "motion.stage.style" },
  { stage: "storyboard", label: "motion.stage.storyboard", text: "motion.stageBar.planStoryboard" },
  { stage: "samples", label: "motion.stage.samples", text: "motion.stageBar.planSamples" },
];
const STAGE_TABS: ReadonlyArray<{ group: StageGroup; label: keyof Dict }> = [
  { group: "edit", label: "motion.timeline.tab" },
  { group: "plan", label: "motion.stageBar.plan" },
  { group: "produce", label: "motion.stageBar.produce" },
  { group: "review", label: "motion.stage.review" },
];
const LAYOUTS: ReadonlyArray<{ value: MovieLayout; label: keyof Dict }> = [
  { value: "title", label: "motion.shot.layoutTitle" },
  { value: "statement", label: "motion.shot.layoutStatement" },
  { value: "split", label: "motion.shot.layoutSplit" },
  { value: "metric", label: "motion.shot.layoutMetric" },
];
const CLIP_FIELDS = [
  { key: "in", label: "motion.common.sourceIn", min: 0, max: 3600 },
  { key: "rate", label: "motion.shot.rate", min: 0.25, max: 4 },
  { key: "volume", label: "motion.shot.volume", min: 0, max: 1 },
] as const;
const ASPECTS: ReadonlyArray<MovieDocument["aspect"]> = ["16:9", "9:16", "1:1"];
/** Radix Select reserves "" for "nothing chosen"; an independent style is a real choice. */
const CURRENT_STYLE = "__current_style__";
const NOTICE_MS = 6000;
const POLL_MS = 3500;
const PREVIEW_DEBOUNCE_MS = 250;
const DOCK_MIN = 30;
const DOCK_MAX = 70;
const DOCK_DEFAULT = 42;

/** The stage a film opens on: the furthest step its saved state supports. */
function initialStage(next: MovieDocument): EditorStage {
  if (next.shots.some((shot) => shot.clip) || (!next.shots.length && next.style.assets?.some((a) => /\.(mp4|mov|webm)$/i.test(a.path)))) return "timeline";
  if (next.delivery) return "deliver";
  if (next.reviewBatch && next.renders.some((r) => r.status === "done")) return "review";
  if (movieCurrentRender(next)) return "review";
  if (next.renders.at(-1)?.status === "running" || next.samplesApproved === next.contentRevision) return "render";
  if (next.storyboardApproved === next.contentRevision) return "samples";
  return next.brief.trim() ? "storyboard" : "style";
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Radix tab and segment items cannot carry `disabledReason`: their reason tooltip sits on a wrapper. */
function Explained({ reason, children }: { reason: string | undefined; children: ReactElement }) {
  if (!reason) return children;
  return (
    <Tooltip label={reason}>
      <span className={styles.explained}>{children}</span>
    </Tooltip>
  );
}

function MovieStudioEditor({
  presentation,
  projectId,
  isActive,
  workspaceContext,
  chat,
  readOnly = false,
  fileVersion,
  onExit,
  initialAiPrompt = null,
  styleWorkspace = false,
}: MovieStudioProps) {
  const { t, locale } = useI18n();
  const scopeKey = workspaceIdentityCacheKey(workspaceContext);
  const embedded = presentation === "embedded";
  const sideChat = chat.mode === "side" ? chat : null;

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [doc, setDoc] = useState<MovieDocument | null>(null);
  const [draft, setDraft] = useState<MovieDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [stage, setStage] = useState<EditorStage>("style");
  const [personalStyles, setPersonalStyles] = useState<MovieStyle[]>([]);
  const [pickerRole, setPickerRole] = useState<"style" | "shot">("style");
  const [styleFrames, setStyleFrames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [selectedTrackKind,setSelectedTrackKind]=useState<'video'|'audio'>('video');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const onExecutionPermissionSaved = useCallback((id: string, executionPermission: Conversation['executionPermission']) => {
    setConversations((current) => current.map((conversation) =>
      conversation.id === id ? { ...conversation, executionPermission } : conversation,
    ));
  }, []);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [noteTarget, setNoteTarget] = useState<MovieNoteTarget>({ scope: "film", time: 0 });
  const [feedbackFocus, setFeedbackFocus] = useState(0);
  const [picker, setPicker] = useState(false);
  const [videoPicker, setVideoPicker] = useState(false);
  const [generationBusy, setGenerationBusy] = useState(false);
  const [editingSources, setEditingSources] = useState<MovieVideoSource[]>([]);
  const [selectionDirty, setSelectionDirty] = useState(false);
  const [livePreview, setLivePreview] = useState<MovieDocument | null>(null);
  const liveTools = useRef<MovieLiveToolsHandle>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("settings");
  const [videoTime, setVideoTime] = useState(0);
  const [aiRunning, setAiRunning] = useState(false);
  const [nativeStop,setNativeStop]=useState(0);
  const nativeMode = false;
  const desktopClient=getOpenDesignHost()?.client;
  const desktopNative=desktopClient?.type==='desktop';
  const [nativeGenerationPrompt,setNativeGenerationPrompt]=useState('');
  const [promptRequest, setPromptRequest] = useState<PromptRequest | null>(null);
  const [selectedRenderId, setSelectedRenderId] = useState<string | null>(null);
  const [htmlRenderer, setHtmlRenderer] = useState<HtmlRenderer>('electron');
  useEffect(() => setHtmlRenderer('electron'), [projectId]);
  const [inspectorOpen, setInspectorOpen] = useState(embedded);
  const [dockShare, setDockShare] = useState(DOCK_DEFAULT);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const reviewPlayer = useRef<MovieReviewPlayerHandle>(null);
  const frameRef = useRef<MoviePreviewFrameHandle>(null);
  /** Receipts produced by this editor instance; any other edit receipt came from elsewhere (the project chat). */
  const ownReceipts = useRef(new Set<string>());
  const mountReceipt = useRef<{ projectId: string; id: string | null } | null>(null);
  const [dismissedReceipt, setDismissedReceipt] = useState<string | null>(null);
  const [changeCursor, setChangeCursor] = useState<{ receiptId: string; index: number } | null>(null);
  const [inspectorRequest, setInspectorRequest] = useState<MovieInspectorRequest | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  /** The timeline editor's root takes focus, so shortcuts keep working after clicks on non-focusable areas. */
  const editorRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Give the editor keyboard focus when it opens, unless the user is already typing elsewhere (e.g. the chat).
    const element = editorRootRef.current;
    if (isActive && stage === "timeline" && element && (!document.activeElement || document.activeElement === document.body)) element.focus({ preventScroll: true });
  }, [isActive, stage]);
  const editScrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const openGeneration = useRef(0);
  const productionStageSeen = useRef("");
  const initialPromptSent = useRef<string | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const previewPositionInitialized = useRef(false);

  const current = draft ?? doc;
  const editingSourceKey = (current?.style.assets ?? []).map(a => a.id + a.path).join('|');
  useEffect(() => {
    if (loadState !== 'ready' || stage !== 'timeline') return;
    let active = true;
    getMovieVideoSources(projectId, workspaceContext).then(sources => { if (active) setEditingSources(sources); })
      .catch(cause => { if (active) setError(describe(cause)); });
    return () => { active = false; };
  }, [loadState, stage, projectId, workspaceContext, editingSourceKey]);
  // Unapplied shot edits live in the 编辑 tab's own state: nothing may switch that tab away or change
  // its shot until they are applied or discarded (the old pane-wide <fieldset disabled> did this).
  const selectionHeld = useRef(false);
  selectionHeld.current = selectionDirty;
  const openInspector = useCallback((tab: InspectorTab) => {
    if (!selectionHeld.current) { setInspectorTab(tab); setInspectorOpen(true); }
  }, []);
  const selectShotId = useCallback((id: string | null) => {
    if (!selectionHeld.current) setSelectedShotId(id);
  }, []);
  const aiBusy = chat.mode === "main" ? chat.busy : aiRunning || promptRequest !== null;
  const readOnlyReason = readOnly ? t("motion.editor.readOnly") : undefined;
  // Unapplied shot edits (the 编辑 tab) hold the rest of the editor until they are applied or discarded.
  const pendingEditReason = selectionDirty ? t("motion.editor.saveFirst") : undefined;
  const lockReason = readOnlyReason ?? pendingEditReason;
  const aiReason = lockReason ?? (aiBusy ? t("motion.editor.aiBusy") : undefined);

  // Latest values for async work and effects that must not re-run on identity churn.
  const env = useRef({ workspaceContext, chat, t, locale });
  env.current = { workspaceContext, chat, t, locale };
  const liveState = useRef({ scopeKey, projectId, dirty: false, revision: 0 });
  liveState.current = { scopeKey, projectId, dirty: dirty || selectionDirty, revision: doc?.revision ?? 0 };

  const describe = (cause: unknown) =>
    cause instanceof MotionCreateError ? t(cause.key) : cause instanceof Error ? cause.message : String(cause);

  const accept = useCallback((next: MovieDocument) => {
    liveState.current.dirty = false;
    liveState.current.revision = next.revision;
    setDoc(next);
    setDraft(next);
    setDirty(false);
    setSelectionDirty(false);
    setLivePreview(null);
    setStyleFrames(next.stylePreview?.contentRevision === next.contentRevision ? next.stylePreview.frames : []);
  }, []);
  /** Accept a document this editor wrote itself; the receipt it produced is not an external change. */
  const acceptOwn = useCallback((next: MovieDocument) => {
    if (next.lastEdit && next.lastEdit.revision === next.revision) ownReceipts.current.add(next.lastEdit.id);
    accept(next);
  }, [accept]);

  const open = useCallback(async () => {
    const generation = ++openGeneration.current;
    const requestedScope = liveState.current.scopeKey;
    const { workspaceContext: context, chat: target, t: translate } = env.current;
    setBusy(true);
    setError("");
    setNotice(null);
    try {
      const next = !readOnly && desktopNative
        ? await initializeMovieEditor(projectId, context)
        : await movieRequest(projectId, context);
      const list =
        target.mode === "side" ? await listConversations(projectId, { throwOnError: true, workspaceContext: context }) : [];
      if (generation !== openGeneration.current || requestedScope !== liveState.current.scopeKey) return;
      accept(next);
      setLoadState("ready");
      const initial = initialStage(next);
      setStage(styleWorkspace ? "style" : (!embedded && initial === "style" ? (desktopNative ? "timeline" : "storyboard") : initial));
      setPromptRequest(null);
      setSelectedRenderId(
        next.reviewBatch?.status === "ready" ? (next.reviewBatch.renderId ?? null) : (next.reviewBatch?.sourceRenderId ?? null),
      );
      setNoteTarget({ scope: "film", time: 0, contentRevision: next.contentRevision });
      if (target.mode === "side") {
        setConversations(list);
        setConversationId(list[0]?.id ?? null);
      }
      // Unsaved edits that were stashed when this editor last unmounted (07 §4.2).
      const restored = takeMovieDraft(projectId, next.revision);
      if (restored) {
        liveState.current.dirty = true;
        setDraft(restored);
        setDirty(true);
        setNotice({ text: translate("motion.editor.draftRestored") });
      }
    } catch (cause) {
      if (generation !== openGeneration.current || requestedScope !== liveState.current.scopeKey) return;
      if (isMovieNotFound(cause)) {
        setLoadState("missing");
        return;
      }
      setLoadState((state) => (state === "ready" ? "ready" : "error"));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === openGeneration.current && requestedScope === liveState.current.scopeKey) setBusy(false);
    }
  }, [accept, projectId, styleWorkspace, embedded, readOnly, desktopNative]);

  // One editor instance per project and workspace identity (MovieStudio keys it): load once.
  useEffect(() => {
    void open();
  }, [open]);

  useEffect(() => {
    if (!styleWorkspace || !isActive) return;
    let active = true;
    void listProjects({ workspaceContext }).then((projects) => loadPersonalStyles(projects, workspaceContext)).then((styles) => {
      if (active) setPersonalStyles(styles);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [styleWorkspace, isActive, workspaceContext, current?.savedStyles.length]);

  // Unsaved edits survive FileWorkspace unmounting the tab (07 §4.2).
  const stashState = useRef<{ dirty: boolean; draft: MovieDocument | null; revision: number }>({
    dirty: false,
    draft: null,
    revision: 0,
  });
  stashState.current = { dirty: dirty || Boolean(livePreview), draft: livePreview ?? draft, revision: doc?.revision ?? 0 };
  useEffect(
    () => () => {
      const state = stashState.current;
      if (state.dirty && state.draft)
        stashMovieDraft({ projectId, baseRevision: state.revision, draft: state.draft, savedAt: Date.now() });
    },
    [projectId],
  );

  useEffect(() => {
    if (!isActive || (!dirty && !selectionDirty)) return;
    const unregister = registerNavigationGuard(
      () => !liveState.current.dirty || window.confirm(env.current.t("motion.editor.leaveConfirm")),
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!liveState.current.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unregister();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [isActive, dirty, selectionDirty]);

  useEffect(() => {
    if (!isActive || !doc?.production || styleWorkspace) return;
    const production = doc.production;
    const key = `${production.id}:${production.status}`;
    if (productionStageSeen.current === key) return;
    productionStageSeen.current = key;
    const revising = doc.reviewBatch?.productionId === production.id;
    if (!revising && production.status === "preparing") setStage("samples");
    if (!revising && production.status === "rendering") setStage("render");
    if (production.status === "done" && movieCurrentRender(doc)?.id === production.renderId) {
      setSelectedRenderId(production.renderId ?? null);
      setStage("review");
      openInspector("notes");
    }
  }, [isActive, doc, openInspector, styleWorkspace]);

  // Main chat: refetch while the chat or the film is busy; the side chat keeps the 3.5 s poll (07 §4.2).
  const pollWhile = chat.mode === "side" || chat.busy || (doc ? isMovieBusy(doc) : false);
  useEffect(() => {
    if (!isActive || loadState !== "ready" || dirty || selectionDirty || !pollWhile) return;
    let canceled = false;
    let pending = false;
    const requestedScope = scopeKey;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void movieRequest(projectId, env.current.workspaceContext)
        .then((next) => {
          const live = liveState.current;
          if (!canceled && !live.dirty && live.projectId === projectId && live.scopeKey === requestedScope && next.revision > live.revision)
            accept(next);
        })
        .catch(() => {})
        .finally(() => {
          pending = false;
        });
    }, POLL_MS);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [isActive, loadState, dirty, selectionDirty, pollWhile, scopeKey, projectId, doc?.revision, accept]);

  // An agent edit changes the file's mtime: one read when the film is clean (07 §4.3). A version that
  // arrives while the first read is still in flight is handled once that read settles.
  const seenVersion = useRef(fileVersion);
  useEffect(() => {
    if (fileVersion === undefined || seenVersion.current === fileVersion || loadState === "loading") return;
    if (loadState === "missing" || loadState === "error") {
      seenVersion.current = fileVersion;
      void open();
      return;
    }
    if (liveState.current.dirty) return;
    let canceled = false;
    const requestedScope = liveState.current.scopeKey;
    void movieRequest(projectId, env.current.workspaceContext)
      .then((next) => {
        const live = liveState.current;
        if (!canceled && !live.dirty && live.scopeKey === requestedScope) {
          seenVersion.current = fileVersion;
          if (next.revision > live.revision) accept(next);
        }
      })
      .catch((cause: unknown) => {
        if (!canceled && isMovieNotFound(cause) && liveState.current.scopeKey === requestedScope) setLoadState("missing");
      });
    return () => { canceled = true; };
  }, [fileVersion, loadState, dirty, selectionDirty, open, accept, projectId]);

  // Embedded: the create flow's first prompt goes out once the conversation is known.
  useEffect(() => {
    if (chat.mode !== "side" || !initialAiPrompt || !conversationId || loadState !== "ready") return;
    if (initialPromptSent.current === initialAiPrompt.id) return;
    initialPromptSent.current = initialAiPrompt.id;
    setPromptRequest({ id: initialAiPrompt.id, projectId, conversationId, prompt: initialAiPrompt.prompt });
    openInspector("chat");
  }, [chat.mode, initialAiPrompt, conversationId, loadState, projectId, openInspector,desktopNative,stage,nativeMode]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    editScrollRef.current?.scrollTo?.({ top: 0 });
  }, [stage]);

  const selectedShot = Math.max(0, current?.shots.findIndex((shot) => shot.id === selectedShotId) ?? 0);
  const setSelectedShot = (index: number) => selectShotId(current?.shots[index]?.id ?? null);
  const selectReviewTarget = (target: MovieNoteTarget) => {
    setNoteTarget(target);
    if (target.scope === "shot") selectShotId(target.shotId ?? null);
  };
  const selectedReviewRender = current
    ? (current.renders.find((r) => r.id === selectedRenderId && r.status === "done") ??
      movieCurrentRender(current) ??
      [...current.renders].reverse().find((r) => r.status === "done"))
    : undefined;
  useEffect(() => {
    if (stage === "review" && selectedReviewRender) {
      setNoteTarget((target) =>
        target.renderId === selectedReviewRender.id ? target : { scope: "time", renderId: selectedReviewRender.id, time: 0 },
      );
      openInspector("notes");
    }
    // Follows the shown render only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, selectedReviewRender?.id]);

  // Style stage preview: a rAF clock drives the frame; drafts reach the iframe after a short pause in typing.
  const debouncedDraft = useDebounced(livePreview ?? draft, PREVIEW_DEBOUNCE_MS);
  const previewBase = (dirty || livePreview) && debouncedDraft ? debouncedDraft : current;
  const previewDoc = useMemo(() => {
    if (!previewBase || !editingSources.some(s => s.previewPath)) return previewBase;
    return { ...previewBase, shots: previewBase.shots.map(s => {
      const source = editingSources.find(a => a.assetId === s.clip?.assetId);
      return source?.previewPath ? { ...s, media: source.previewPath } : s;
    }) };
  }, [previewBase, editingSources]);
  const duration = current ? movieDuration(current) : 0;
  const clock = useMoviePreviewClock({
    duration,
    loop: false,
    initialTime: 0.8,
    onPlay: (time) => {
      frameRef.current?.seek(time);
      frameRef.current?.play({ loop: false });
    },
    onPause: (time) => {
      frameRef.current?.pause();
      frameRef.current?.seek(time);
    },
    onSeek: (time) => frameRef.current?.seek(time),
  });
  const clockState = useRef({ time: clock.time, playing: clock.playing });
  clockState.current = { time: clock.time, playing: clock.playing };
  useEffect(() => {
    if (duration > 0 && !previewPositionInitialized.current) {
      previewPositionInitialized.current = true;
      clock.seek(Math.min(0.8, duration / 2));
    }
  }, [duration, clock.seek]);
  useEffect(() => {
    if (styleWorkspace && duration > 0) clock.seek(Math.min(1.2, duration / 2));
    // A newly chosen style opens on a representative frame instead of its empty entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleWorkspace, current?.style.id, duration]);
  // A (re)mounted frame starts at its own initial time: put it where the clock is.
  const syncPreviewFrame = useCallback(() => {
    const { time, playing } = clockState.current;
    frameRef.current?.seek(time);
    if (playing) frameRef.current?.play({ loop: false });
    else frameRef.current?.pause();
  }, []);
  // A seek that needs the new duration (a shot just added) runs once the draft carries it.
  useEffect(() => {
    const at = pendingSeek.current;
    if (at === null) return;
    pendingSeek.current = null;
    clock.seek(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  const styleOptions = useMemo(() => [
    ...MOVIE_STYLES.map((style) => ({ key: `builtin:${style.id}`, style })),
    ...personalStyles.map((style) => ({ key: `${style.sourceProjectId}:${style.id}`, style })),
  ], [personalStyles]);

  // ── actions (same requests and order as before the refactor) ─────────────────────────────

  /** Runs one action and marks it as the one in flight, so its button shows a spinner. */
  const perform = (name: string, task: () => Promise<unknown>) => {
    setBusyAction(name);
    void task().finally(() => setBusyAction((value) => (value === name ? null : value)));
  };
  const loadingFor = (name: string) => busy && busyAction === name;

  function change(patch: Partial<MovieDocument>) {
    if (!current || busy || selectionDirty || readOnly) return;
    liveState.current.dirty = true;
    setDraft({ ...current, ...patch });
    setDirty(true);
    setStyleFrames([]);
    setNotice(null);
  }

  const stale = (operation: number, scope: string) =>
    operation !== openGeneration.current || liveState.current.scopeKey !== scope || liveState.current.projectId !== projectId;

  async function saveDraft(base: MovieDocument): Promise<MovieDocument> {
    if (!dirty || !current) return base;
    return movieRequest(projectId, workspaceContext, { document: current, expectedRevision: base.revision });
  }

  async function applyLocalized(label: string, operations: MovieEditOperation[]): Promise<boolean> {
    if (!doc || busy || dirty || readOnly) return false;
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      const result = await movieStyleRequest<MovieEditResponse>(projectId, workspaceContext, "edits", {
        expectedRevision: doc.revision,
        label,
        operations,
      });
      if (result.receipt) ownReceipts.current.add(result.receipt.id);
      if (stale(operation, scope)) return false;
      accept(result.document);
      setNotice(null);
      return true;
    } catch (cause) {
      if (operation === openGeneration.current) setError(describe(cause));
      return false;
    } finally {
      if (operation === openGeneration.current) setBusy(false);
    }
  }

  async function stepHistory(direction: "undo" | "redo") {
    if (!doc || busy || dirty || selectionDirty || aiBusy || readOnly) return;
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      const result = await movieStyleRequest<MovieEditResponse>(projectId, workspaceContext, `history/${direction}`, {
        expectedRevision: doc.revision,
      });
      if (result.receipt) ownReceipts.current.add(result.receipt.id);
      if (stale(operation, scope)) return;
      accept(result.document);
      setNotice(null);
    } catch (cause) {
      if (operation === openGeneration.current) setError(describe(cause));
    } finally {
      if (operation === openGeneration.current) setBusy(false);
    }
  }

  async function run(action: MovieAction, onResult?: (document: MovieDocument) => void): Promise<boolean> {
    if (!current || !doc || busy || selectionDirty || readOnly) return false;
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    setNotice(null);
    try {
      let saved = doc;
      if (dirty) {
        saved = await saveDraft(doc);
        accept(saved);
      }
      if (stale(operation, scope)) return false;
      const requestedAction = action.action === 'render' || action.action === 'render-preview'
        ? { ...action, htmlRenderer } : action;
      const next = await movieRequest(projectId, workspaceContext, requestedAction, saved.revision);
      if (stale(operation, scope)) return false;
      accept(next);
      onResult?.(next);
      if (action.action === "approve-storyboard") setStage("samples");
      if (action.action === "approve-samples") setStage("render");
      if (action.action === "approve-review") setStage("deliver");
      if (action.action === "save-style") setNotice({ text: t("motion.editor.styleSaved") });
      return true;
    } catch (cause) {
      if (operation === openGeneration.current && liveState.current.scopeKey === scope) setError(describe(cause));
      return false;
    } finally {
      if (operation === openGeneration.current && liveState.current.scopeKey === scope) setBusy(false);
    }
  }

  /** main → the project chat (skill fantay-movie); side → the embedded SideChatTab (07 §4.2). */
  async function dispatchAi(prompt: string): Promise<boolean> {
    if (chat.mode === "main") {
      const result = await chat.send(prompt);
      if (!result.accepted) {
        setError(
          t(
            result.reason === "no-chat"
              ? "motion.editor.chatUnavailable"
              : result.reason === "busy"
                ? "motion.editor.aiBusy"
                : "motion.editor.agentUnavailable",
          ),
        );
        return false;
      }
      setNotice({ text: t("motion.editor.sentToChat"), showChat: true });
      return true;
    }
    if (!conversationId) return false;
    setPromptRequest({ id: crypto.randomUUID(), projectId, conversationId, prompt });
    openInspector("chat");
    return true;
  }
  useEffect(()=>{
    const receive=(event?:Event)=>{
      if(loadState!=='ready')return;
      const stored=sessionStorage.getItem(`fantay:native-action:${projectId}`);
      const item=(event as CustomEvent|undefined)?.detail ?? (stored?JSON.parse(stored):null);
      if(!item||item.projectId!==projectId)return;
      sessionStorage.removeItem('fantay:native-entry');
      if(item.action==='chat-send'&&!conversationId){void createConversation(projectId,'Native editing',{workspaceContext}).then(next=>{if(next){setConversations(items=>[next,...items]);setConversationId(next.id);}});return;}
      sessionStorage.removeItem(`fantay:native-action:${projectId}`);
      if(item.action==='chat-send')void dispatchAi(item.value);
      if(item.action==='chat-stop')setNativeStop(n=>n+1);
      if(item.action==='chat-select'&&conversations.some(c=>c.id===item.value))setConversationId(item.value);
      if(item.action==='chat-new')void createConversation(projectId,'Native editing',{workspaceContext}).then(next=>{if(next){setConversations(items=>[next,...items]);setConversationId(next.id);}});
      if(item.action==='open-generation'){setNativeGenerationPrompt(item.value??'');window.dispatchEvent(new Event('fantay-native-generation'));}
    };
    receive();window.addEventListener('fantay-native-action',receive);return()=>window.removeEventListener('fantay-native-action',receive);
  },[projectId,loadState,conversationId,conversations]);

  async function askAi(task: "storyboard" | "refine-style") {
    if (!current || !doc || busy || aiBusy || selectionDirty || readOnly) return;
    if (chat.mode === "side" && !conversationId) return;
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      const saved = dirty ? await saveDraft(doc) : current;
      if (stale(operation, scope)) return;
      if (dirty) accept(saved);
      const sent = await dispatchAi(movieAssistPrompt(saved, task, locale));
      if (sent && task === "storyboard") setStage("storyboard");
    } catch (cause) {
      if (operation === openGeneration.current && liveState.current.scopeKey === scope) setError(describe(cause));
    } finally {
      if (operation === openGeneration.current && liveState.current.scopeKey === scope) setBusy(false);
    }
  }

  async function submitFeedback(noteIds: string[]) {
    if (!current || !doc || busy || aiBusy || selectionDirty || readOnly || !noteIds.length) return;
    if (chat.mode === "side" && !conversationId) return;
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      const base = dirty ? await saveDraft(doc) : doc;
      const result = await movieStyleRequest<{ document: MovieDocument }>(projectId, workspaceContext, "review-submit", {
        expectedRevision: base.revision,
        requestId: crypto.randomUUID(),
        noteIds,
        ...(noteTarget.renderId ? { sourceRenderId: noteTarget.renderId } : {}),
      });
      if (stale(operation, scope)) return;
      accept(result.document);
      await dispatchAi(movieAssistPrompt(result.document, "revise", locale));
      openInspector("notes");
    } catch (cause) {
      if (operation === openGeneration.current) setError(describe(cause));
    } finally {
      if (operation === openGeneration.current) setBusy(false);
    }
  }

  async function previewStyle() {
    if (!current || !doc || busy || readOnly) return;
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      if (dirty) {
        const saved = await saveDraft(doc);
        if (stale(operation, scope)) return;
        accept(saved);
      }
      for (let i = 0; i < current.shots.length; i += 6) {
        await movieStyleRequest<{ frames: string[] }>(projectId, workspaceContext, "style-preview", {
          motion: true,
          shotIds: current.shots.slice(i, i + 6).map((s) => s.id),
        });
        if (stale(operation, scope)) return;
      }
      const latest = await movieRequest(projectId, workspaceContext);
      if (stale(operation, scope)) return;
      accept(latest);
      setNotice({ text: t("motion.editor.styleSampleReady") });
    } catch (cause) {
      if (operation === openGeneration.current && liveState.current.scopeKey === scope) setError(describe(cause));
    } finally {
      if (operation === openGeneration.current) setBusy(false);
    }
  }

  async function proceedToRender() {
    if (!current || !doc || busy || readOnly) return;
    if (dirty || current.stylePreview?.contentRevision !== current.contentRevision) {
      await previewStyle();
      return;
    }
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      let next = current;
      if (next.storyboardApproved !== next.contentRevision)
        next = await movieRequest(projectId, workspaceContext, { action: "approve-storyboard" }, next.revision);
      if (next.samplesApproved !== next.contentRevision)
        next = await movieRequest(projectId, workspaceContext, { action: "approve-samples" }, next.revision);
      next = await movieRequest(projectId, workspaceContext, { action: "render" }, next.revision);
      if (stale(operation, scope)) return;
      accept(next);
      setStage("render");
    } catch (cause) {
      if (operation === openGeneration.current) setError(describe(cause));
    } finally {
      if (operation === openGeneration.current) setBusy(false);
    }
  }

  async function save() {
    if (!current || !doc || selectionDirty || busy || readOnly) return;
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      const next = await movieRequest(projectId, workspaceContext, { document: current, expectedRevision: doc.revision });
      if (stale(operation, scope)) return;
      acceptOwn(next);
      setNotice({ text: t("motion.common.saved") });
    } catch (cause) {
      if (operation === openGeneration.current && liveState.current.scopeKey === scope) setError(describe(cause));
    } finally {
      if (operation === openGeneration.current && liveState.current.scopeKey === scope) setBusy(false);
    }
  }

  async function linkStyle(input: Record<string, unknown>) {
    if (!current || !doc || busy || readOnly) return;
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      const base = dirty ? await saveDraft(doc) : current;
      const result = await movieStyleRequest<{ document: MovieDocument }>(projectId, workspaceContext, "style-link", {
        ...input,
        expectedRevision: base.revision,
      });
      if (!stale(operation, scope)) {
        accept(result.document);
        setStyleFrames([]);
      }
    } catch (cause) {
      if (operation === openGeneration.current && liveState.current.scopeKey === scope) setError(describe(cause));
    } finally {
      if (operation === openGeneration.current) setBusy(false);
    }
  }

  async function attachMaterials(items: MaterialSummaryItem[], mode: "attach" | "packet") {
    if (!current || !doc || readOnly) return;
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      let next = dirty ? await saveDraft(doc) : current;
      for (const item of items) {
        if (stale(operation, scope)) return;
        next = (
          await movieStyleRequest<{ document: MovieDocument }>(projectId, workspaceContext, "style-link", {
            kind: "material",
            materialId: item.id,
            mode,
            expectedRevision: next.revision,
          })
        ).document;
      }
      if (stale(operation, scope)) return;
      if (pickerRole === "shot" && mode === "attach" && next.style.assets?.length) {
        const media = next.style.assets.at(-1)!.path;
        next = await movieRequest(projectId, workspaceContext, {
          expectedRevision: next.revision,
          document: { ...next, shots: next.shots.map((s, i) => (i === selectedShot ? { ...s, media } : s)) },
        });
      }
      if (!stale(operation, scope)) {
        accept(next);
        setStyleFrames([]);
        setNotice({ text: t("motion.editor.materialLinked") });
      }
    } catch (cause) {
      if (operation === openGeneration.current && liveState.current.scopeKey === scope) setError(describe(cause));
    } finally {
      if (operation === openGeneration.current) {
        setBusy(false);
        setPicker(false);
      }
    }
  }

  async function chooseVideos(videos: LibraryAsset[]) {
    if (!current || !doc || readOnly) return;
    const operation = ++openGeneration.current;
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      const saved = dirty ? await saveDraft(doc) : current;
      const next = await importVideos(projectId, saved, videos, workspaceContext);
      if (!stale(operation, scope)) {
        acceptOwn(next);
        setStage("timeline");
        setNotice({ text: t("motion.editor.videosImported") });
      }
    } catch (cause) {
      if (operation === openGeneration.current) setError(describe(cause));
    } finally {
      if (operation === openGeneration.current) {
        setBusy(false);
        setVideoPicker(false);
      }
    }
  }

  async function cancelProduction() {
    try {
      const result = await movieStyleRequest<{ document: MovieDocument }>(projectId, workspaceContext, "production/cancel", {});
      accept(result.document);
    } catch (cause) {
      setError(describe(cause));
    }
  }

  function addShot() {
    if (!current) return;
    const id = crypto.randomUUID();
    change({
      shots: [...current.shots, { id, title: t("motion.shots.newShotTitle"), body: "", duration: 4, layout: "title" }],
    });
    selectShotId(id);
    setStage("storyboard");
    openInspector("settings");
    pendingSeek.current = movieDuration(current) + 0.8;
  }

  function updateShot(patch: Partial<MovieShot>) {
    if (!current) return;
    change({ shots: current.shots.map((s, i) => (i === selectedShot ? { ...s, ...patch } : s)) });
  }

  function startDockDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is a convenience; the drag works without it.
    }
    const move = (clientY: number) => {
      const rect = body.getBoundingClientRect();
      if (!(rect.height > 0)) return;
      const share = ((rect.bottom - clientY) / rect.height) * 100;
      setDockShare(Math.round(Math.max(DOCK_MIN, Math.min(DOCK_MAX, share))));
    };
    const onMove = (next: globalThis.PointerEvent) => move(next.clientY);
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  // ── non-ready states ────────────────────────────────────────────────────────────────────

  const exitButton = onExit ? (
    <IconButton size="md" aria-label={t(styleWorkspace ? "motion.style.backToFilm" : embedded ? "motion.library.back" : "motion.editor.backToBoard")} onClick={onExit}>
      <Icon icon={ArrowLeft} size="md" />
    </IconButton>
  ) : null;

  if (loadState === "missing")
    return (
      <div className={styles.editor} data-testid="movie-studio" data-state="missing">
        {exitButton ? <div className={styles.stateToolbar}>{exitButton}</div> : null}
        <div className={styles.stateBody}>
          <EmptyState
            variant="dashed"
            title={t("motion.editor.missingTitle")}
            description={t("motion.editor.missingBody")}
            action={
              <Button
                variant="primary"
                disabled={readOnly}
                disabledReason={readOnlyReason}
                onClick={() => openMotionCreate({ target: { kind: "existing-project", projectId }, source: "editor-empty" })}
              >
                {t("motion.node.createFilm")}
              </Button>
            }
          />
        </div>
      </div>
    );

  if (!current || loadState !== "ready")
    return (
      <div className={styles.editor} data-testid="movie-studio" data-state={loadState} aria-busy={!error}>
        {exitButton ? <div className={styles.stateToolbar}>{exitButton}</div> : null}
        <div className={styles.stateBody}>
          {error ? (
            <Callout tone="error" role="alert" className={styles.errorCallout}>
              <span>{error}</span>
              <Button variant="link" size="sm" onClick={() => void open()}>
                {t("motion.common.reload")}
              </Button>
            </Callout>
          ) : (
            <Spinner size="lg" label={t("motion.editor.opening")} />
          )}
        </div>
      </div>
    );

  // ── ready ───────────────────────────────────────────────────────────────────────────────

  const group = STAGE_GROUP[stage];
  const currentRender = movieCurrentRender(current);
  const render =
    stage === "deliver"
      ? currentRender
      : (current.renders.find((r) => r.id === selectedRenderId && r.status === "done") ??
        currentRender ??
        [...current.renders].reverse().find((r) => r.status === "done"));
  const latest = current.renders.at(-1);
  const latestDone = currentRender ?? [...current.renders].reverse().find((r) => r.status === "done" && r.file);
  const producing = ["preparing", "rendering"].includes(current.production?.status ?? "");
  const rendering = current.renders.some((r) => r.status === "running");
  const historyBusy = busy || aiBusy || current.editHistory?.blocked === true || rendering || producing;
  const historyReason = (direction: "undo" | "redo"): string | undefined => {
    if (readOnlyReason) return readOnlyReason;
    if (dirty || selectionDirty) return t("motion.editor.saveFirst");
    if (historyBusy) return t("motion.editor.historyBusy");
    const count = direction === "undo" ? current.editHistory?.undoCount : current.editHistory?.redoCount;
    if (!count) return t(direction === "undo" ? "motion.editor.nothingToUndo" : "motion.editor.nothingToRedo");
    return undefined;
  };
  const undoReason = historyReason("undo");
  const redoReason = historyReason("redo");
  const editLocked =
    readOnly ||
    busy ||
    selectionDirty ||
    (!(stage === "review" && current.reviewBatch?.productionId === current.production?.id) && producing);
  const noShotsReason = current.shots.length ? undefined : t("motion.editor.noShots");
  const shot = current.shots[selectedShot];
  const hasSourceVideos = current.style.assets?.some((asset) => /\.(mp4|mov|webm)$/i.test(asset.path)) ?? false;
  const frame = motionFrameSize(current.aspect);
  const ratioStyle = { "--movie-ratio": `${frame.width} / ${frame.height}` } as CSSProperties;
  const dockStyle = {
    "--motion-pane-fr": `${100 - dockShare}fr`,
    "--motion-dock-fr": `${dockShare}fr`,
  } as CSSProperties;
  const shotStart = (index: number) => movieShotStarts(current)[index] ?? 0;
  const saveStyleBlocked =
    (current.authored || current.startMode === "blank" || current.style.id.startsWith("ai-")) &&
    (current.stylePreview?.contentRevision !== current.contentRevision ||
      !current.shots.every((s) => current.stylePreview?.shotIds?.includes(s.id)));
  // i18n-extra motion.style.saveNeedsSample (placeholder: the action that unblocks it).
  const saveStyleReason =
    lockReason ?? noShotsReason ?? (saveStyleBlocked ? t("motion.style.saveNeedsSample") : undefined);
  const productionVisible =
    current.production &&
    (!latest || latest.id === current.production.renderId || ["armed", "preparing", "rendering"].includes(current.production.status));
  const productionText = (() => {
    const production = current.production;
    if (!production) return "";
    if (production.status === "armed")
      return t(current.reviewBatch?.productionId === production.id ? "motion.production.revising" : "motion.production.storyboarding");
    if (production.status === "preparing") return t("motion.production.checkingSamples");
    if (production.status === "rendering") return t("motion.production.rendering");
    if (production.status === "done") return t("motion.production.ready");
    return production.message ?? t("motion.production.stopped");
  })();
  const productionRunning = ["armed", "preparing", "rendering"].includes(current.production?.status ?? "");
  const durationText = formatMotionTime(duration, { tenths: true });
  const timeText = formatMotionTime(clock.time, { tenths: true });
  const doneRenders = current.renders.filter((r) => r.status === "done");
  const versionLabel = (renderId: string) => {
    const label = t("motion.review.version", { n: current.renders.findIndex((r) => r.id === renderId) + 1 });
    return renderId === currentRender?.id ? `${label} · ${t("motion.review.current")}` : label;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "z") return;
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || target.closest("input,textarea,select,[contenteditable=true]")) return;
    const direction = event.shiftKey ? "redo" : "undo";
    if (historyReason(direction)) return;
    event.preventDefault();
    void stepHistory(direction);
  };

  const showStage = (next: EditorStage, tab: InspectorTab) => {
    setStage(next);
    openInspector(tab);
  };
  const reviewingRevision = stage === "review" && current.reviewBatch?.productionId === current.production?.id;
  // The 编辑 tab needs a saved film and no production rewriting it.
  const editShotReason =
    readOnlyReason ??
    (dirty ? t("motion.editor.saveFirst") : undefined) ??
    (producing && !reviewingRevision ? productionText : undefined);
  // Why the storyboard's shot actions wait (editLocked minus the momentary request): 07 §6.1 rule 2.
  const editReason = lockReason ?? (producing && !reviewingRevision ? productionText : undefined);

  const shotStrip = (
    <section className={styles.shotsSection} aria-label={t("motion.summary.shots")}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{t("motion.summary.shots")}</h3>
        <span className={styles.sectionMeta}>{t("motion.shots.hint")}</span>
      </div>
      <div className={styles.shots}>
        {current.shots.map((s, i) => (
          <Explained key={s.id} reason={pendingEditReason}>
            <Chip
              size="sm"
              className={styles.shot}
              on={selectedShot === i}
              aria-pressed={selectedShot === i}
              disabled={selectionDirty}
              onClick={() => {
                setSelectedShot(i);
                showStage("storyboard", "settings");
                clock.seek(shotStart(i) + 0.8);
              }}
            >
              <span className={styles.shotNumber}>{String(i + 1).padStart(2, "0")}</span>
              <span className={styles.shotTitle}>{s.title.replace(/\n/g, " ") || t("motion.shots.untitled")}</span>
              <span className={styles.shotDuration}>{s.duration}s</span>
            </Chip>
          </Explained>
        ))}
      </div>
    </section>
  );

  const storyboard = (variant: "storyboard" | "samples") => (
    <MovieStoryboard
      variant={variant}
      document={current}
      projectId={projectId}
      context={workspaceContext}
      selectedShotId={current.shots[selectedShot]?.id}
      lockedReason={pendingEditReason}
      editLockedReason={editShotReason}
      onEdit={(target) => {
        selectShotId(target.id);
        openInspector("edit");
      }}
      onSelect={(target, at) => {
        selectShotId(target.id);
        setNoteTarget({
          scope: "shot",
          shotId: target.id,
          time: at,
          endTime: at + target.duration,
          contentRevision: current.contentRevision,
          ...(currentRender?.contentRevision === current.contentRevision ? { renderId: currentRender.id } : {}),
        });
        openInspector("notes");
        setFeedbackFocus((n) => n + 1);
      }}
    />
  );

  const stageContent = (): ReactNode => {
    switch (stage) {
      case "generate":
        return <TokenToSeaServices key={projectId} projectId={projectId} context={workspaceContext} active initialPrompt={nativeGenerationPrompt} videoOnly={!nativeMode} materialsOnly={nativeMode} onBusyChange={setGenerationBusy} onVideoImport={async (runId, assetId) => {
          const latest = await movieRequest(projectId, workspaceContext);
          const response = await fetch('/api/tokentosea/movie/import', { method: 'POST', headers: {
            'Content-Type': 'application/json', ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
          }, body: JSON.stringify({ projectId, runId, assetId, expectedRevision: latest.revision }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? 'Could not import generated video');
          accept(result.document);
        }} />;
      case "timeline":
      case "style":
        return (
          <>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>{t("motion.preview.title")}</h2>
              <span className={styles.sectionMeta}>{current.style.name}</span>
            </div>
            {styleFrames.length > 0 ? (
              <Disclosure className={styles.samples} label={t("motion.preview.motionSamples", { count: styleFrames.length })}>
                <div className={styles.sampleGrid}>
                  {styleFrames.map((path) => (
                    <img
                      key={path}
                      className={styles.sampleImage}
                      src={workspaceResourceUrl(`/api/projects/${projectId}/raw/${path}`, workspaceContext)}
                      alt={t("motion.preview.sampleAlt")}
                    />
                  ))}
                </div>
              </Disclosure>
            ) : null}
            <div className={styles.preview}>
              <div className={styles.previewBox} style={ratioStyle} data-testid="movie-style-preview">
                {isActive && previewDoc ? (
                  <MoviePreviewFrame
                    ref={frameRef}
                    document={previewDoc}
                    projectId={projectId}
                    workspaceContext={workspaceContext}
                    initialTime={0.8}
                    variant="fill"
                    title={current.title}
                    onReady={syncPreviewFrame}
                  />
                ) : null}
              </div>
              <div className={styles.previewTransport}>
                <IconButton
                  size="md"
                  aria-label={t(clock.playing ? "motion.common.pause" : "motion.common.play")}
                  disabled={!duration}
                  disabledReason={noShotsReason}
                  onClick={clock.toggle}
                >
                  <Icon icon={clock.playing ? Pause : Play} size="lg" />
                </IconButton>
                <span className={styles.previewTime} aria-hidden="true">
                  {timeText} / {durationText}
                </span>
                <Scrubber
                  className={styles.previewScrubber}
                  value={clock.time}
                  max={duration}
                  onChange={clock.seek}
                  ariaLabel={t("motion.preview.position")}
                  valueText={t("motion.node.timeValue", { current: timeText, total: durationText })}
                  disabled={!duration}
                />
              </div>
            </div>
            {stage === "timeline" ? <MovieTimeline
              document={current} projectId={projectId} context={workspaceContext}
              time={clock.time} selectedShotId={shot?.id}
              disabled={Boolean(lockReason) || editLocked || aiBusy || dirty || rendering}
              reason={lockReason ?? editReason ?? (dirty ? t("motion.editor.saveFirst") : undefined)}
              onSeek={clock.seek} onSelect={(id) => { setSelectedShotId(id); openInspector("edit"); }}
              onEdit={async (label, ops) => { clock.pause(); return applyLocalized(label, ops); }}
              onImport={() => setVideoPicker(true)}
              onGenerate={() => {
                setStage("generate");
              }}
              onAi={(request) => dispatchAi(`Edit this movie project ${projectId}. Read its latest movie document and sources first. Selected shot: ${shot?.id ?? "none"}. Playhead: ${clock.time.toFixed(3)}s. User request: ${request}\nUse localized edit operations (split-clip, trim-clip, move-shot, remove-shot, insert-clip, update-clip or caption edits) with the exact expectedRevision. Batch the requested changes into one undoable edit. Preserve unrelated content. Do not approve or deliver on the user's behalf.`)}
            /> : styleWorkspace ? null : shotStrip}
          </>
        );
      case "storyboard":
        return (
          <>
            {storyboard("storyboard")}
            {shotStrip}
          </>
        );
      case "samples":
        return storyboard("samples");
      case "render": {
        const running = latest?.status === "running";
        return (
          <div className={styles.renderPane}>
            <EmptyState
              variant="dashed"
              className={styles.stageState}
              title={t(running ? "motion.render.running" : "motion.render.title")}
              description={
                running ? (
                  <span role="status">{latest?.progress ?? t("motion.render.progressFallback")}</span>
                ) : (
                  t("motion.render.body")
                )
              }
              action={
                !running && current.samplesApproved !== current.contentRevision ? (
                  <p className={styles.hint}>{t("motion.render.needsApproval")}</p>
                ) : undefined
              }
            />
            {latest?.error ? (
              <Callout tone="error" role="alert">
                {latest.error}
              </Callout>
            ) : null}
            {current.renders.length ? (
              <ul className={styles.renderList}>
                {[...current.renders].reverse().map((r, i) => (
                  <li key={r.id} className={styles.renderRow}>
                    <span className={styles.renderVersion}>
                      {t("motion.render.versionRow", { n: current.renders.length - i, revision: r.contentRevision })}
                    </span>
                    <span className={styles.renderState} data-status={r.status}>
                      {t(r.status === "done" ? "motion.render.done" : r.status === "failed" ? "motion.render.failed" : "motion.render.inProgress")}
                    </span>
                    {r.file ? (
                      <Tooltip label={t("motion.review.downloadMp4")}>
                        <Button variant="ghost" size="icon-sm" asChild>
                          <a href={movieRawUrl(projectId, r.file, workspaceContext)} download aria-label={t("motion.review.downloadMp4")}>
                            <Icon icon={Download} size="sm" />
                          </a>
                        </Button>
                      </Tooltip>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      }
      case "review":
        return render ? (
          <>
            <div className={styles.reviewHead}>
              {doneRenders.length > 1 ? (
                <Explained reason={pendingEditReason}>
                  <Segmented
                    size="sm"
                    className={styles.versions}
                    aria-label={t("motion.review.versionsAria")}
                    value={render.id}
                    disabled={selectionDirty}
                    onValueChange={(id) => {
                      setSelectedRenderId(id);
                      setNoteTarget({ scope: "time", renderId: id, time: 0 });
                    }}
                  >
                    {doneRenders.map((r) => (
                      <SegmentedItem key={r.id} value={r.id}>
                        {versionLabel(r.id)}
                      </SegmentedItem>
                    ))}
                  </Segmented>
                </Explained>
              ) : (
                <span className={styles.reviewVersion}>{versionLabel(render.id)}</span>
              )}
              {render.file ? (
                <Button variant="link" size="sm" asChild>
                  <a href={movieRawUrl(projectId, render.file, workspaceContext)} download>
                    {t("motion.review.downloadMp4")}
                  </a>
                </Button>
              ) : null}
            </div>
            <MovieReviewPlayer
              ref={reviewPlayer}
              projectId={projectId}
              render={render}
              context={workspaceContext}
              notes={current.notes}
              target={noteTarget}
              onTarget={selectReviewTarget}
              onTime={setVideoTime}
              annotateDisabledReason={pendingEditReason}
              onAnnotate={() => {
                openInspector("notes");
                setFeedbackFocus((n) => n + 1);
              }}
            />
          </>
        ) : (
          <EmptyState
            variant="dashed"
            className={styles.stageState}
            title={t("motion.review.noRender")}
            action={
              <Button
                variant="default"
                disabled={selectionDirty}
                disabledReason={pendingEditReason}
                onClick={() => showStage("render", "settings")}
              >
                {t("motion.review.toProduction")}
              </Button>
            }
          />
        );
      case "deliver":
        return render ? (
          <EmptyState
            variant="dashed"
            className={styles.stageState}
            title={t("motion.deliver.title")}
            description={t("motion.deliver.body")}
          />
        ) : null;
    }
  };

  const stageFooter = (): ReactNode => {
    switch (stage) {
      case "generate":
        return <Button disabled={generationBusy} onClick={() => setStage("timeline")}>{t("motion.timeline.back")}</Button>;
      case "timeline":
        return <Button variant="primary" disabled={Boolean(lockReason) || !current.shots.length || busy || rendering || aiBusy}
          disabledReason={lockReason ?? noShotsReason} onClick={() => perform("render", async () => {
            if (await run({ action: "render-preview" })) showStage("render", "settings");
          })}>{t("motion.timeline.export")}</Button>;
      case "style":
        if (styleWorkspace) return <>
          <Button variant="default" disabled={Boolean(lockReason ?? noShotsReason) || busy}
            loading={loadingFor("preview")} onClick={() => perform("preview", previewStyle)}>
            <Icon icon={Play} size="md" />{t("motion.style.renderSample")}
          </Button>
          <Button variant="primary" disabled={Boolean(saveStyleReason) || busy}
            disabledReason={saveStyleReason} loading={loadingFor("saveStyle")}
            onClick={() => perform("saveStyle", () => run({ action: "save-style" }))}>
            <Icon icon={Save} size="md" />{t("motion.style.saveMine")}
          </Button>
        </>;
        return (
          <>
            <Button
              variant="default"
              disabled={Boolean(aiReason) || busy}
              disabledReason={aiReason}
              loading={loadingFor("ai")}
              onClick={() => perform("ai", () => askAi("refine-style"))}
            >
              <Icon icon={Sparkles} size="md" />
              {t("motion.style.refineWithAi")}
            </Button>
            <Button
              variant="default"
              disabled={Boolean(saveStyleReason) || busy}
              disabledReason={saveStyleReason}
              loading={loadingFor("saveStyle")}
              onClick={() => perform("saveStyle", () => run({ action: "save-style" }))}
            >
              <Icon icon={Save} size="md" />
              {t("motion.style.saveMine")}
            </Button>
            <Button
              variant="default"
              disabled={Boolean(lockReason ?? noShotsReason) || busy}
              disabledReason={lockReason ?? noShotsReason}
              loading={loadingFor("preview")}
              onClick={() => perform("preview", previewStyle)}
            >
              <Icon icon={Play} size="md" />
              {t("motion.style.renderSample")}
            </Button>
            <Button
              variant="primary"
              disabled={selectionDirty}
              disabledReason={pendingEditReason}
              onClick={() => setStage("storyboard")}
            >
              {t("motion.style.toStoryboard")}
            </Button>
          </>
        );
      case "storyboard":
        return (
          <>
            <Button
              variant="default"
              disabled={Boolean(aiReason) || busy}
              disabledReason={aiReason}
              loading={loadingFor("ai")}
              onClick={() => perform("ai", () => askAi("storyboard"))}
            >
              <Icon icon={Sparkles} size="md" />
              {t("motion.storyboard.generate")}
            </Button>
            <Button
              variant="ghost"
              disabled={Boolean(lockReason) || editLocked}
              disabledReason={editReason}
              onClick={addShot}
            >
              <Icon icon={Plus} size="md" />
              {t("motion.shots.add")}
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(aiReason ?? noShotsReason) || busy}
              disabledReason={aiReason ?? noShotsReason}
              loading={loadingFor("approve")}
              onClick={() => perform("approve", () => run({ action: "approve-storyboard" }))}
            >
              <Icon icon={Check} size="md" />
              {t("motion.storyboard.approve")}
            </Button>
          </>
        );
      case "samples":
        return (
          <>
            <Button
              variant="default"
              disabled={Boolean(lockReason ?? noShotsReason) || busy}
              disabledReason={lockReason ?? noShotsReason}
              loading={loadingFor("preview")}
              onClick={() => perform("preview", previewStyle)}
            >
              {t("motion.samples.refresh")}
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(aiReason ?? noShotsReason) || busy}
              disabledReason={aiReason ?? noShotsReason}
              loading={loadingFor("proceed")}
              onClick={() => perform("proceed", proceedToRender)}
            >
              {t(current.stylePreview?.contentRevision === current.contentRevision ? "motion.samples.continue" : "motion.samples.generate")}
            </Button>
          </>
        );
      case "render": {
        const blocked =
          lockReason ??
          (dirty ? t("motion.editor.saveFirst") : undefined) ??
          (current.samplesApproved !== current.contentRevision ? t("motion.render.needsApproval") : undefined);
        return (
          <>
            {render ? (
              <Button
                variant="default"
                disabled={selectionDirty}
                disabledReason={pendingEditReason}
                onClick={() => setStage("review")}
              >
                {t("motion.render.toReview")}
              </Button>
            ) : null}
            {latest?.status === "running" ? (
              <div className={styles.footerProgress} data-testid="movie-render-progress">
                <Progress value={null} aria-label={t("motion.render.running")} />
                <span className={styles.footerProgressText}>{t("motion.render.running")}</span>
              </div>
            ) : (
              <Button
                variant="primary"
                disabled={Boolean(blocked) || busy}
                disabledReason={blocked}
                loading={loadingFor("render")}
                onClick={() => perform("render", () => run({ action: "render" }))}
              >
                <Icon icon={Film} size="md" />
                {t("motion.render.start")}
              </Button>
            )}
          </>
        );
      }
      case "review": {
        if (!currentRender) return null;
        const blocked =
          lockReason ??
          (render?.id !== currentRender.id ? t("motion.review.deliverNeedsCurrent") : undefined) ??
          (current.notes.some((n) => !n.resolved) ? t("motion.editor.deliverBlockedNotes") : undefined);
        return (
          <Button
            variant="primary"
            disabled={Boolean(blocked) || busy}
            disabledReason={blocked}
            loading={loadingFor("deliver")}
            onClick={() => perform("deliver", () => run({ action: "approve-review" }))}
          >
            {t("motion.review.deliver")}
          </Button>
        );
      }
      case "deliver": {
        if (!render) return null;
        if (current.delivery)
          return (
            <Button variant="primary" asChild>
              <a href={workspaceResourceUrl(`/api/projects/${projectId}/movie/delivery`, workspaceContext)} download>
                <Icon icon={Download} size="md" />
                {t("motion.deliver.download")}
              </a>
            </Button>
          );
        const blocked = lockReason ?? (current.approvedRenderId !== render.id ? t("motion.review.deliverNeedsCurrent") : undefined);
        return (
          <Button
            variant="primary"
            disabled={Boolean(blocked) || busy}
            disabledReason={blocked}
            loading={loadingFor("prepare")}
            onClick={() => perform("prepare", () => run({ action: "deliver" }))}
          >
            {t("motion.deliver.prepare")}
          </Button>
        );
      }
    }
  };

  const rendererControl = <div title={locale.startsWith('zh') ? 'FrameVelo 用于 HTML 动效；实拍视频或加速失败时自动使用标准导出。' : 'FrameVelo is for HTML motion. Footage or failed acceleration uses standard export.'}>
    <Select value={htmlRenderer} disabled={busy || rendering || readOnly} onValueChange={value => setHtmlRenderer(value as HtmlRenderer)}>
      <SelectTrigger className={styles.rendererSelect} size="sm" aria-label={locale.startsWith('zh') ? '导出方式' : 'Export renderer'}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="electron">{locale.startsWith('zh') ? '标准导出' : 'Standard export'}</SelectItem>
        <SelectItem value="framevelo">{locale.startsWith('zh') ? 'FrameVelo 动效加速' : 'FrameVelo motion'}</SelectItem>
      </SelectContent>
    </Select>
  </div>;

  const settings = (
    <div className={styles.settings}>
      {stage === 'render' ? <Field label={locale.startsWith('zh') ? '导出方式' : 'Export renderer'}>{rendererControl}</Field> : null}
      {hasSourceVideos ? (
        <Disclosure defaultOpen={stage === "style"} label={t("motion.style.sourceVideos")}>
          <MovieSources
            projectId={projectId}
            context={workspaceContext}
            revision={(current.style.assets ?? []).map((asset) => asset.id + asset.path).join("|")}
          />
        </Disclosure>
      ) : null}
      {stage === "style" ? (
        <>
          <StyleFields value={current.style} onChange={(next) => change({ style: next })} disabled={editLocked} />
          <Button
            variant="default"
            size="sm"
            className={styles.inlineAction}
            disabled={Boolean(lockReason) || busy}
            disabledReason={lockReason}
            onClick={() => {
              setPickerRole("style");
              setPicker(true);
            }}
          >
            <Icon icon={FolderOpen} size="sm" />
            {t("motion.style.addMaterial")}
          </Button>
          {(current.style.references ?? []).map((reference) => (
            <div key={reference.materialId} className={styles.reference}>
              <strong className={styles.referenceTitle}>{reference.title}</strong>
              <span className={styles.referenceLicense}>{reference.license}</span>
              {reference.source && /^https?:\/\//i.test(reference.source) ? (
                <Button variant="link" size="sm" asChild>
                  <a href={reference.source} target="_blank" rel="noreferrer">
                    {t("motion.style.viewSource")}
                  </a>
                </Button>
              ) : null}
            </div>
          ))}
          <Field label={t("motion.style.brief")} htmlFor={`${projectId}-brief`} labelVariant="form">
            <Textarea
              id={`${projectId}-brief`}
              rows={5}
              value={current.brief}
              disabled={editLocked}
              onChange={(e) => change({ brief: e.target.value })}
            />
          </Field>
          <Field label={t("motion.common.aspectRatio")} htmlFor={`${projectId}-aspect`} labelVariant="form">
            <Select
              value={current.aspect}
              disabled={editLocked}
              onValueChange={(value) => change({ aspect: value as MovieDocument["aspect"] })}
            >
              <SelectTrigger id={`${projectId}-aspect`} size="sm" className={styles.select}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASPECTS.map((aspect) => (
                  <SelectItem key={aspect} value={aspect}>
                    {aspect}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </>
      ) : null}
      {stage === "storyboard" ? (
        <>
          <p className={styles.hint}>{t("motion.storyboard.generateHint")}</p>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t("motion.shot.settings")}</h3>
            <span className={styles.sectionMeta}>
              {current.shots.length ? `${selectedShot + 1} / ${current.shots.length}` : "0 / 0"}
            </span>
          </div>
          {shot ? (
            <div className={styles.shotFields}>
              <Field label={t("motion.shot.direction")} htmlFor={`${projectId}-shot-direction`} labelVariant="form">
                <Textarea
                  id={`${projectId}-shot-direction`}
                  rows={3}
                  value={shot.direction ?? ""}
                  disabled={editLocked}
                  onChange={(e) => updateShot({ direction: e.target.value })}
                />
              </Field>
              <Field label={t("motion.shot.title")} htmlFor={`${projectId}-shot-title`} labelVariant="form">
                <Textarea
                  id={`${projectId}-shot-title`}
                  rows={2}
                  value={shot.title}
                  disabled={editLocked}
                  onChange={(e) => updateShot({ title: e.target.value })}
                />
              </Field>
              <Field label={t("motion.shot.body")} htmlFor={`${projectId}-shot-body`} labelVariant="form">
                <Textarea
                  id={`${projectId}-shot-body`}
                  rows={2}
                  value={shot.body}
                  disabled={editLocked}
                  onChange={(e) => updateShot({ body: e.target.value })}
                />
              </Field>
              <div className={styles.fieldGrid}>
                <Field label={t("motion.shot.duration")} htmlFor={`${projectId}-shot-duration`} labelVariant="form">
                  <Input
                    id={`${projectId}-shot-duration`}
                    type="number"
                    variant="mono"
                    inputSize="sm"
                    min={1 / 60}
                    max={30}
                    value={shot.duration}
                    disabled={editLocked}
                    onChange={(e) => updateShot({ duration: Number(e.target.value) })}
                  />
                </Field>
                <Field label={t("motion.shot.layout")} htmlFor={`${projectId}-shot-layout`} labelVariant="form">
                  <Select
                    value={shot.layout}
                    disabled={editLocked}
                    onValueChange={(value) => updateShot({ layout: value as MovieLayout })}
                  >
                    <SelectTrigger id={`${projectId}-shot-layout`} size="sm" className={styles.select}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LAYOUTS.map((layout) => (
                        <SelectItem key={layout.value} value={layout.value}>
                          {t(layout.label)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {shot.clip ? (
                <div className={styles.clip}>
                  <strong className={styles.clipTitle}>{t("motion.shot.videoCut")}</strong>
                  <div className={styles.fieldGrid}>
                    {CLIP_FIELDS.map(({ key, label, min, max }) => (
                      <Field key={key} label={t(label)} htmlFor={`${projectId}-clip-${key}`} labelVariant="form">
                        <Input
                          id={`${projectId}-clip-${key}`}
                          type="number"
                          variant="mono"
                          inputSize="sm"
                          min={min}
                          max={max}
                          step={0.1}
                          value={shot.clip![key]}
                          disabled={editLocked}
                          onChange={(e) => updateShot({ clip: { ...shot.clip!, [key]: Number(e.target.value) } })}
                        />
                      </Field>
                    ))}
                  </div>
                  {(shot.captions ?? []).map((caption, j) => (
                    <Field
                      key={caption.id ?? j}
                      label={t("motion.shot.captionRange", { start: caption.start.toFixed(1), end: caption.end.toFixed(1) })}
                      htmlFor={`${projectId}-caption-${j}`}
                      labelVariant="form"
                    >
                      <Input
                        id={`${projectId}-caption-${j}`}
                        inputSize="sm"
                        value={caption.text}
                        disabled={editLocked}
                        onChange={(e) =>
                          updateShot({
                            captions: shot.captions!.map((c, k) => (k === j ? { ...c, text: e.target.value } : c)),
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
              ) : null}
              <Field label={t("motion.shot.media")} htmlFor={`${projectId}-shot-media`} labelVariant="form">
                <Input
                  id={`${projectId}-shot-media`}
                  variant="mono"
                  inputSize="sm"
                  value={shot.media ?? ""}
                  placeholder="assets/image.png"
                  disabled={editLocked}
                  onChange={(e) => updateShot({ media: e.target.value || undefined })}
                />
              </Field>
              <div className={styles.actionsRow}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(lockReason) || editLocked}
                  disabledReason={editReason}
                  onClick={() => {
                    setPickerRole("shot");
                    setPicker(true);
                  }}
                >
                  <Icon icon={FolderOpen} size="sm" />
                  {t("motion.shot.findReference")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(lockReason) || !selectedShot || editLocked}
                  // i18n-extra motion.shot.alreadyFirst (placeholder: how to pick another shot).
                  disabledReason={editReason ?? (!selectedShot ? t("motion.shot.alreadyFirst") : undefined)}
                  onClick={() => {
                    const shots = [...current.shots];
                    [shots[selectedShot - 1], shots[selectedShot]] = [shots[selectedShot]!, shots[selectedShot - 1]!];
                    change({ shots });
                  }}
                >
                  {t("motion.shot.moveEarlier")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={Boolean(lockReason) || editLocked}
                  disabledReason={editReason}
                  onClick={() => {
                    change({ shots: current.shots.filter((_, i) => i !== selectedShot) });
                    setSelectedShot(Math.max(0, selectedShot - 1));
                  }}
                >
                  <Icon icon={Trash2} size="sm" />
                  {t("motion.shot.remove")}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {stage !== "style" && stage !== "storyboard" ? (
        <div className={styles.summary}>
          <h3 className={styles.sectionTitle}>{t("motion.summary.title")}</h3>
          <dl className={styles.summaryList}>
            <dt className={styles.summaryTerm}>{t("motion.stage.style")}</dt>
            <dd className={styles.summaryValue}>{current.style.name}</dd>
            <dt className={styles.summaryTerm}>{t("motion.summary.aspect")}</dt>
            <dd className={styles.summaryValue}>{current.aspect}</dd>
            <dt className={styles.summaryTerm}>{t("motion.summary.duration")}</dt>
            <dd className={styles.summaryValue}>{duration}s</dd>
            <dt className={styles.summaryTerm}>{t("motion.summary.shots")}</dt>
            <dd className={styles.summaryValue}>{current.shots.length}</dd>
          </dl>
          <p className={styles.hint}>{t("motion.summary.hint")}</p>
          <Button
            variant="default"
            size="sm"
            className={styles.inlineAction}
            disabled={selectionDirty}
            disabledReason={pendingEditReason}
            onClick={() => setStage("storyboard")}
          >
            {t("motion.summary.editStoryboard")}
          </Button>
        </div>
      ) : null}
    </div>
  );

  if (stage === 'timeline' && !styleWorkspace) {
    const editDisabled = busy || aiBusy || dirty || selectionDirty || rendering || producing || readOnly;
    const chatPanel=sideChat && conversationId ? <FxLegacy><SideChatTab inlineComposer hideContextBanner editorAppearance composerFooterAccessory={sideChat.executionSwitcher} skillId="fantay-movie" composerPlaceholder={locale.startsWith('zh') ? '提问，或输入 @ 引用媒体' : 'Ask, or type @ to reference media'} projectId={projectId} conversationId={conversationId}
      externalStop={nativeStop}
      config={sideChat.config} agentsById={new Map(sideChat.agents.map(a => [a.id, a]))} locale={locale} workspaceContext={workspaceContext} projectFiles={[]} conversations={conversations}
      onSelectConversation={setConversationId} onDeleteConversation={() => {}} promptRequest={promptRequest} onActivityChange={setAiRunning}
      onExecutionPermissionSaved={readOnly ? undefined : onExecutionPermissionSaved}
      onNewConversation={readOnly ? undefined : () => { void createConversation(projectId, locale.startsWith('zh') ? '新剪辑对话' : 'New editing chat', { workspaceContext }).then(next => { if (next) { setConversations(items => [next, ...items]); setConversationId(next.id); } }); }}
      onPromptRequestSettled={(id, accepted) => { setPromptRequest(value => value?.id === id ? null : value); if (!accepted) setError(t('motion.editor.agentUnavailable')); }} /></FxLegacy> : null;
    const generationPanel=<TokenToSeaServices key={projectId} projectId={projectId} context={workspaceContext} active initialPrompt={nativeGenerationPrompt} videoOnly={!nativeMode} materialsOnly={nativeMode} onBusyChange={setGenerationBusy} onVideoImport={async (runId, assetId) => {
      const latest = await movieRequest(projectId, workspaceContext);
      const response = await fetch('/api/tokentosea/movie/import', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}) }, body: JSON.stringify({ projectId, runId, assetId, expectedRevision: latest.revision }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'Could not import media'); acceptOwn(result.document);
    }} />;
    // Explicit selection: nothing is selected until the user (or an edit) picks a clip.
    const editorShot = current.shots.find(s => s.id === selectedShotId);
    const zhEditor = locale.startsWith('zh');
    const requestEdit = (request: string) => dispatchAi(`Edit this movie project ${projectId}. Read its latest document and sources. Selected shot: ${editorShot?.id ?? 'none'}. Playhead: ${clock.time.toFixed(3)}s. User request: ${request}\nUse localized edit operations with the exact expectedRevision. Batch one intention into one undoable edit. Preserve unrelated content. Do not approve or deliver.`);
    const addSource = (source: MovieVideoSource, index = current.shots.length, placement?: {start:number;track:number}, range?:{in:number;duration:number}) => {
      const clipDuration=range?.duration??source.duration;
      if (current.shots.length >= MOVIE_MAX_CLIPS || duration + clipDuration > MOVIE_MAX_DURATION) { setError(zhEditor ? '当前时间线最多支持 1000 个片段、4 小时。' : 'A timeline supports up to 1,000 clips and four hours.'); return; }
      const id=crypto.randomUUID();
      // A placed clip goes to the end of the shot list: inserting mid-list would shift sequential films before the move.
      const ops: MovieEditOperation[]=[{op:'insert-clip',assetId:source.assetId,index:placement?current.shots.length:index,in:range?.in??0,duration:clipDuration,newShotId:id}];
      if(placement)ops.push({op:'move-clip',shotId:id,at:placement.start,track:placement.track});
      void applyLocalized(t('motion.timeline.addSource'), ops).then(ok=>{if(ok){setSelectedShotId(id);setSelectedTrackKind(source.kind==='audio'?'audio':'video');clock.seek(placement?.start??duration);}});
    };
    const updateProjectSettings = async (settings: MovieSettings, aspect: MovieDocument['aspect']) => {
      setBusy(true); setError('');
      try { acceptOwn(await movieRequest(projectId, workspaceContext, { expectedRevision: current.revision, document: { ...current, settings, aspect } })); }
      catch (cause) { setError(describe(cause)); } finally { setBusy(false); }
    };
    const changeAspect = (aspect: MovieDocument['aspect']) => {
      if (aspect === current.aspect) return;
      const size = aspect === '9:16' ? { width: 1080, height: 1920 } : aspect === '1:1' ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 };
      void updateProjectSettings({ ...size, frameRate: current.settings?.frameRate ?? { numerator: 30, denominator: 1 } }, aspect);
    };
    // The stacked inspector shows the first clip when nothing is selected; transcription follows what it shows.
    const transcribeTarget = editorShot ?? shot;
    const transcribeSelected = async () => {
      if (!transcribeTarget?.clip) return;
      const target = transcribeTarget, clip = transcribeTarget.clip;
      setBusy(true); setTranscribing(true); setError('');
      try {
        const source = await movieStyleRequest<MovieVideoSource>(projectId, workspaceContext, 'transcribe', { assetId: clip.assetId, language: zhEditor ? 'zh' : 'auto' });
        const rate = clip.rate, start = clip.in;
        const captions = (source.transcript ?? []).map(c => ({ id: crypto.randomUUID(), text: c.text, start: Math.max(0, (c.start-start)/rate), end: Math.min(target.duration, (c.end-start)/rate) })).filter(c => c.end > c.start);
        const result = await movieStyleRequest<MovieEditResponse>(projectId, workspaceContext, 'edits', { expectedRevision: current.revision, label: zhEditor ? '生成字幕' : 'Transcribe captions', operations: [{ op: 'replace-captions', shotId: target.id, captions }] });
        if (result.receipt) ownReceipts.current.add(result.receipt.id);
        accept(result.document);
      } catch (cause) { setError(describe(cause)); } finally { setBusy(false); setTranscribing(false); }
    };
    const selectClip = (id: string | null, kind?: 'video' | 'audio') => { if (selectionHeld.current) return; selectShotId(id); setSelectedTrackKind(kind ?? 'video'); };
    const startOf = (shot: MovieShot) => { const local = movieLocalTime(current, shot, 0); return local === null ? null : -local; };
    const duplicateSelected = () => {
      if (!editorShot || editorShot.locked) return;
      const id = crypto.randomUUID(), place = movieDuplicatePlacement(current, editorShot);
      void applyLocalized(zhEditor ? '复制片段' : 'Duplicate clip', [{ op: 'duplicate-clip', shotId: editorShot.id, newShotId: id, ...place }]).then(ok => { if (ok) selectClip(id, selectedTrackKind); });
    };
    /**
     * Cut commands act on the selected clip, or the clip under the playhead when nothing is selected.
     * They share movieCutOperations with the timeline toolbar, so 主轨磁吸 behaves the same everywhere.
     */
    const cutAtPlayhead = (kind: 'split' | 'trim-before' | 'trim-after') => {
      const target = movieTargetShot(current, clock.time, editorShot?.id);
      if (!target || target.locked || (!target.clip && kind === 'split') || (target.id === editorShot?.id && selectedTrackKind === 'audio' && !target.clip?.audioOnly)) return false;
      const local = movieLocalTime(current, target, clock.time), frame = 1 / movieFps(current);
      if (local === null || local < frame || local > target.duration - frame) return false;
      clock.pause();
      const label = kind === 'split' ? t('motion.timeline.split') : kind === 'trim-before' ? (zhEditor ? '向左裁剪' : 'Trim start to playhead') : (zhEditor ? '向右裁剪' : 'Trim end to playhead');
      void applyLocalized(label, movieCutOperations(current, target, local, kind, { magnet: getMoviePref('magnet') }));
      return true;
    };
    const deleteSelected = (ripple: boolean) => {
      if (!editorShot || editorShot.locked) return;
      if (selectedTrackKind === 'audio' && !editorShot.clip?.audioOnly) { void applyLocalized(zhEditor ? '关闭原声' : 'Mute clip audio', [{ op: 'update-clip', shotId: editorShot.id, changes: { muted: true } }]); return; }
      const ops = movieCutOperations(current, editorShot, 0, ripple ? 'ripple-delete' : 'delete', { magnet: getMoviePref('magnet') });
      void applyLocalized(ripple ? (zhEditor ? '删除并合拢' : 'Ripple delete') : t('motion.timeline.remove'), ops).then(ok => { if (ok) selectClip(null); });
    };
    // Edits that reach the document from somewhere else (the project chat's agent) get highlighted.
    if (!mountReceipt.current || mountReceipt.current.projectId !== projectId) mountReceipt.current = { projectId, id: doc?.lastEdit?.id ?? null };
    const lastEdit = doc?.lastEdit;
    const externalReceipt = lastEdit && lastEdit.action === 'edit' && lastEdit.id !== mountReceipt.current.id && !ownReceipts.current.has(lastEdit.id) && lastEdit.id !== dismissedReceipt ? lastEdit : null;
    const changedIds = externalReceipt ? externalReceipt.changedShotIds.filter(id => current.shots.some(s => s.id === id)) : [];
    const changeIndex = externalReceipt && changeCursor?.receiptId === externalReceipt.id ? changeCursor.index : -1;
    const externalChange: MovieExternalChange | null = externalReceipt ? { receipt: { ...externalReceipt, changedShotIds: changedIds }, index: changeIndex } : null;
    const navigateChange = (direction: -1 | 1) => {
      if (!externalReceipt || !changedIds.length) return;
      const next = changeIndex < 0 ? (direction > 0 ? 0 : changedIds.length - 1) : (changeIndex + direction + changedIds.length) % changedIds.length;
      setChangeCursor({ receiptId: externalReceipt.id, index: next });
      const target = current.shots.find(s => s.id === changedIds[next]);
      if (!target) return;
      selectClip(target.id, target.clip?.audioOnly ? 'audio' : 'video');
      const start = startOf(target);
      if (start !== null) clock.seek(start);
    };
    const hoverPreview = (time: number | null) => { if (!clock.playing) frameRef.current?.seek(time ?? clock.time); };
    return <div ref={editorRootRef} tabIndex={-1} className={styles.editor} data-testid="movie-studio" data-presentation={presentation} onKeyDown={e => {
      // Keys typed in portaled menus, popovers and dialogs bubble through React but are not editor keys.
      if (!e.currentTarget.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true],[role=slider]:not([data-timeline-ruler])')) return;
      onKeyDown(e);
      if (e.defaultPrevented) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
      const key = e.key.toLowerCase();
      // Space plays from anywhere in the editor, except on a focused control outside the timeline lanes, which it activates.
      const control = (e.target as HTMLElement).closest('button,a,[role=tab],[role=radio],[role=menuitem],[role=switch]');
      if (e.code === 'Space' && (!control || control.closest('[data-testid=movie-timeline-lanes]'))) { e.preventDefault(); clock.toggle(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); clock.seek(clock.time + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 1 / movieFps(current))); }
      if (plain && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { const point = movieEditPoint(current, clock.time, e.key === 'ArrowDown' ? 1 : -1); if (point !== null) { e.preventDefault(); clock.seek(point); } }
      if (plain && e.key === 'Home') { e.preventDefault(); clock.seek(0); }
      if (plain && e.key === 'End') { e.preventDefault(); clock.seek(duration); }
      if (e.ctrlKey && !e.metaKey && key === 'y' && !historyReason('redo')) { e.preventDefault(); void stepHistory('redo'); }
      if (!editDisabled && !mod && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteSelected(e.shiftKey); }
      if (!editDisabled && mod && key === 'b') { e.preventDefault(); cutAtPlayhead('split'); }
      if (!editDisabled && plain && !e.shiftKey && key === 'q') { e.preventDefault(); cutAtPlayhead('trim-before'); }
      if (!editDisabled && plain && !e.shiftKey && key === 'w') { e.preventDefault(); cutAtPlayhead('trim-after'); }
      if (!editDisabled && mod && key === 'd') { e.preventDefault(); duplicateSelected(); }
      if (!editDisabled && editorShot?.clip && !editorShot.locked && plain && !e.shiftKey && key === 'm') { e.preventDefault(); void applyLocalized(editorShot.clip.muted ? (zhEditor ? '取消静音' : 'Unmute clip') : (zhEditor ? '静音片段' : 'Mute clip'), [{ op: 'update-clip', shotId: editorShot.id, changes: { muted: !editorShot.clip.muted } }]); }
      if (!editDisabled && editorShot && mod && key === 'l') { e.preventDefault(); void applyLocalized(editorShot.locked ? (zhEditor ? '解锁片段' : 'Unlock clip') : (zhEditor ? '锁定片段' : 'Lock clip'), movieLockOperations(current, [editorShot], !editorShot.locked)); }
      if (plain && !e.shiftKey && key === 'n') { e.preventDefault(); setMoviePref('snap', !getMoviePref('snap')); }
      if (plain && !e.shiftKey && key === 's') { e.preventDefault(); setMoviePref('skim', !getMoviePref('skim')); }
      if (e.key === 'Escape' && editorShot) selectClip(null);
    }}>
      <MovieEditingWorkspace document={current} projectId={projectId} context={workspaceContext} sources={editingSources} compact={presentation === 'project'}
        selectedShotId={editorShot?.id} selectionKind={selectedTrackKind}
        exportOptions={rendererControl}
        time={clock.time} playing={clock.playing} disabled={editDisabled} error={error || (latest?.status === 'failed' ? latest.error ?? '' : '')} dirty={dirty} undoReason={undoReason} redoReason={redoReason} aiBusy={aiBusy} generationBusy={generationBusy}
        busyLabel={rendering ? (latest?.progress ?? t('motion.render.running')) : undefined}
        onExit={onExit} onImport={() => setVideoPicker(true)} onAddSource={(source,range,mode)=>addSource(source,current.shots.length,mode==='overlay'?{start:clock.time,track:Math.min(7,1+Math.max(0,...current.shots.map(s=>s.placement?.track??0)))}:undefined,range)} onPlay={clock.toggle} onSeek={clock.seek}
        onUpload={async files => {
          setBusy(true); setError('');
          try {
            let latestDoc = await movieRequest(projectId, workspaceContext);
            for (const file of files) latestDoc = await uploadMovieMedia(projectId, latestDoc.revision, file, workspaceContext);
            acceptOwn(latestDoc);
          } catch (cause) { setError(describe(cause)); }
          finally { setBusy(false); }
        }}
        onAddText={() => { const at = clock.time, id = crypto.randomUUID(); void applyLocalized(zhEditor ? '添加文字' : 'Add text', [{ op: 'insert-text', text: zhEditor ? '输入文字' : 'Your text', at, duration: 3, track: Math.min(7, 1 + Math.max(0, ...current.shots.map(s => s.placement?.track ?? 0))), newShotId: id }]).then(ok => { if (ok) selectClip(id); }); }}
        onUndo={() => void stepHistory('undo')} onRedo={() => void stepHistory('redo')} onExport={async exportOptions => {
          clock.pause();
          let output: import('@open-design/contracts').MovieRender | null = null;
          await run({ action: 'render-preview', exportOptions }, next => { output = next.renders.at(-1) ?? null; });
          return output;
        }} onSave={() => void save()}
        onPlan={() => setStage('storyboard')} onReview={() => setStage('review')}
        onApply={async (label, ops) => { clock.pause(); return applyLocalized(label, ops); }}
        onSelect={selectClip} onTranscribe={() => void transcribeSelected()} onAspectChange={changeAspect}
        onDismissError={() => setError('')} transcribing={transcribing} inspectorDirty={selectionDirty}
        externalChange={externalChange} onChangeNav={navigateChange} onChangeDismiss={() => { if (externalReceipt) setDismissedReceipt(externalReceipt.id); setChangeCursor(null); }}
        liveTools={<MovieLiveTools ref={liveTools} document={current} projectId={projectId} context={workspaceContext}
          time={clock.time} busy={busy} readOnly={readOnly} aiBusy={aiBusy} blocked={dirty || selectionDirty}
          onPause={clock.pause} onSeek={clock.seek}
          onPreview={next => { liveState.current.dirty = Boolean(next) || dirty; setLivePreview(next); setSelectionDirty(Boolean(next)); }}
          onApply={applyLocalized}
          onStyle={async style => {
            if (busy || readOnly) return false;
            setBusy(true); setError('');
            try { acceptOwn(await movieRequest(projectId, workspaceContext, { expectedRevision: current.revision, document: { ...current, style } })); return true; }
            catch (cause) { setError(describe(cause)); return false; }
            finally { setBusy(false); }
          }}
          onLinkStyle={async designSystemId => {
            if (busy || readOnly) return false;
            setBusy(true); setError('');
            try { const result = await movieStyleRequest<{ document: MovieDocument }>(projectId, workspaceContext, 'style-link', { expectedRevision: current.revision, kind: 'design-system', designSystemId }); acceptOwn(result.document); return true; }
            catch (cause) { setError(describe(cause)); return false; }
            finally { setBusy(false); }
          }}
          onAddNote={(target, text) => run({ action: 'add-note', ...target, contentRevision: target.contentRevision ?? current.contentRevision, text })}
          onSubmitNotes={async noteIds => {
            if (busy || aiBusy || readOnly) return false;
            setBusy(true); setError('');
            try { const result = await movieStyleRequest<MovieFeedbackResponse>(projectId, workspaceContext, 'feedback-prompt', { expectedRevision: current.revision, noteIds }); return await dispatchAi(result.prompt); }
            catch (cause) { setError(describe(cause)); return false; }
            finally { setBusy(false); }
          }}
          onResolveNote={note => { void run({ action: 'resolve-note', noteId: note.id }); }} />}
        liveMarkers={<MovieLiveMarkers document={current} onSeek={clock.seek} />}
        preview={isActive && previewDoc ? <MoviePreviewFrame ref={frameRef} document={previewDoc} projectId={projectId} workspaceContext={workspaceContext} initialTime={0.8} variant="fill" title={current.title} onReady={syncPreviewFrame}
          onEditText={readOnly ? undefined : target => liveTools.current?.editText(target)} /> : null}
        inspector={<EditorInspector document={doc!} selectedShotId={editorShot?.id} selectionKind={selectedTrackKind} time={clock.time} onSeek={clock.seek} onAudioDetached={id=>{setSelectedShotId(id);setSelectedTrackKind('audio');}} busy={busy || aiBusy || dirty || rendering} readOnly={readOnly||Boolean(editorShot?.locked)} onApply={applyLocalized} onDirtyChange={setSelectionDirty}
          onProjectSettings={(settings, aspect) => { void updateProjectSettings(settings, aspect); }}
          onTranscribe={() => void transcribeSelected()} requested={inspectorRequest} sources={editingSources} assetUrl={path => workspaceResourceUrl(`/api/projects/${projectId}/raw/${path}`, workspaceContext)} />}
        timeline={<EditorTimeline document={current} sources={editingSources} projectId={projectId} context={workspaceContext} time={clock.time} playing={clock.playing} selectedId={editorShot?.id} selectedKind={selectedTrackKind} disabled={editDisabled || nativeMode}
          onUndo={() => void stepHistory('undo')} onRedo={() => void stepHistory('redo')} undoEnabled={!undoReason} redoEnabled={!redoReason}
          highlightIds={changedIds} onHoverPreview={hoverPreview}
          onInspectorRequest={request => { if (!selectionHeld.current) setInspectorRequest({ ...request, nonce: Date.now() }); }}
          onSelect={selectClip} onSeek={clock.seek} onEdit={async (label, ops) => { clock.pause(); return applyLocalized(label, ops); }} onAddSource={addSource} />}
        chat={embedded ? chatPanel : undefined}
        onAi={embedded ? requestEdit : undefined}
        generation={generationPanel}
      />
      {videoPicker ? <FxLegacy><MovieVideoPicker onClose={() => setVideoPicker(false)} onConfirm={chooseVideos} /></FxLegacy> : null}
    </div>;
  }

  return (
    <div className={styles.editor} data-testid="movie-studio" data-presentation={presentation} data-style-workspace={styleWorkspace || undefined} onKeyDown={onKeyDown}>
      <header className={styles.toolbar} role="toolbar" aria-label={current.title || t("motion.section.film")} data-testid="movie-editor-toolbar">
        {exitButton}
        {styleWorkspace ? <strong className={styles.title}>{t("motion.style.workspaceTitle")}</strong> : <Input
          variant="title"
          className={styles.title}
          aria-label={t("motion.common.filmTitle")}
          value={current.title}
          disabled={busy || selectionDirty || readOnly}
          onChange={(e) => change({ title: e.target.value })}
        />}
        <StatusLabel tone={dirty ? "muted" : "done"} className={styles.saveState}>
          <span className={styles.collapsibleLabel}>{t(dirty ? "motion.editor.unsaved" : "motion.common.saved")}</span>
        </StatusLabel>
        {dirty ? (
          <Button
            variant="default"
            size="sm"
            disabled={Boolean(pendingEditReason) || busy}
            disabledReason={pendingEditReason}
            loading={loadingFor("save")}
            onClick={() => perform("save", save)}
          >
            <Icon icon={Save} size="sm" />
            {t("motion.common.save")}
          </Button>
        ) : null}
        <span className={styles.toolbarSpacer} />
        <IconButton
          size="sm"
          aria-label={t("motion.editor.undoAria")}
          tooltip={current.editHistory?.undoLabel || t("motion.editor.undo")}
          shortcut="mod+z"
          disabled={Boolean(undoReason)}
          disabledReason={undoReason}
          onClick={() => void stepHistory("undo")}
        >
          <Icon icon={Undo2} size="sm" />
        </IconButton>
        <IconButton
          size="sm"
          aria-label={t("motion.editor.redoAria")}
          tooltip={current.editHistory?.redoLabel || t("motion.editor.redo")}
          shortcut="mod+shift+z"
          disabled={Boolean(redoReason)}
          disabledReason={redoReason}
          onClick={() => void stepHistory("redo")}
        >
          <Icon icon={Redo2} size="sm" />
        </IconButton>
        {sideChat ? (
          <IconButton
            size="sm"
            aria-label={t("motion.embedded.chatToggle")}
            on={inspectorTab === "chat"}
            disabled={selectionDirty}
            disabledReason={pendingEditReason}
            onClick={() => openInspector(inspectorTab === "chat" ? "settings" : "chat")}
          >
            <Icon icon={Sparkles} size="sm" />
          </IconButton>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(lockReason) || busy}
          disabledReason={lockReason}
          onClick={() => setVideoPicker(true)}
        >
          <Icon icon={Film} size="sm" />
          <span className={styles.collapsibleLabel}>{t("motion.sources.title")}</span>
        </Button>
        {embedded ? (
          <Button variant="ghost" size="sm" asChild>
            <a href={buildPath(motionEditorRoute(projectId))} target="_blank" rel="noreferrer">
              <Icon icon={ExternalLink} size="sm" />
              <span className={styles.collapsibleLabel}>{t("motion.embedded.openInWorkspace")}</span>
            </a>
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" aria-label={t("motion.editor.moreActions")}>
              <Icon icon={MoreHorizontal} size="sm" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="md" align="end">
            {styleWorkspace ? <DropdownMenuItem disabled={Boolean(aiReason) || busy}
              onSelect={() => perform("ai", () => askAi("refine-style"))}>
              {t("motion.style.refineWithAi")}
            </DropdownMenuItem> : null}
            {latestDone?.file ? (
              <DropdownMenuItem asChild>
                <a href={movieRawUrl(projectId, latestDone.file, workspaceContext)} download>
                  <MenuItemIcon>
                    <Icon icon={Download} size="sm" />
                  </MenuItemIcon>
                  {t("motion.review.downloadMp4")}
                </a>
              </DropdownMenuItem>
            ) : null}
            {current.delivery ? (
              <DropdownMenuItem asChild>
                <a href={workspaceResourceUrl(`/api/projects/${projectId}/movie/delivery`, workspaceContext)} download>
                  <MenuItemIcon>
                    <Icon icon={Download} size="sm" />
                  </MenuItemIcon>
                  {t("motion.deliver.download")}
                </a>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem asChild>
              <a href={movieRawUrl(projectId, MOVIE_DOCUMENT_FILE, workspaceContext)} target="_blank" rel="noreferrer">
                <MenuItemIcon>
                  <Icon icon={ExternalLink} size="sm" />
                </MenuItemIcon>
                {t("motion.editor.openSourceFile")}
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setConnectionOpen(true)}>{t("motion.connection.menuItem")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton
          size="sm"
          className={styles.panelToggle}
          aria-label={t(styleWorkspace ? "motion.style.settingsTitle" : "motion.editor.panelToggle")}
          on={inspectorOpen}
          onClick={() => setInspectorOpen((value) => !value)}
        >
          <Icon icon={PanelBottom} size="sm" />
        </IconButton>
      </header>
      {styleWorkspace ? <div className={styles.stylePicker} data-testid="movie-style-catalog">
        <div className={styles.stylePickerField}>
          <span>{t("motion.style.libraryLabel")}</span>
          <Select value={CURRENT_STYLE} disabled={editLocked} onValueChange={(key) => {
            const selected = styleOptions.find((entry) => entry.key === key)?.style;
            if (!selected) return;
            if (selected.sourceProjectId) void linkStyle({ kind: "reuse", sourceProjectId: selected.sourceProjectId,
              styleId: selected.id });
            else change({ style: structuredClone(selected) });
          }}>
            <SelectTrigger aria-label={t("motion.style.libraryLabel")}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={CURRENT_STYLE}>{current.style.name}</SelectItem>
              {styleOptions.map(({ key, style }) => <SelectItem key={key} value={key}>
                {style.sourceProjectId ? t("motion.style.personalPrefix") : t("motion.style.builtinPrefix")} · {style.name}
              </SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className={styles.hint}>{t("motion.style.workspaceHint")}</p>
      </div> : null}
      <Tabs
        value={group}
        onValueChange={(next) => {
          const entry = GROUP_ENTRY[next as StageGroup];
          showStage(entry, entry === "render" ? "settings" : "notes");
        }}
        className={styles.stageTabsRoot}
      >
        {styleWorkspace ? null : <div className={styles.stageBar} data-testid="movie-stage-bar">
          <TabsList variant="line" size="md" aria-label={t("motion.stageBar.aria")} className={styles.stageTabs}>
            {STAGE_TABS.map((item) => (
              <Explained key={item.group} reason={item.group === group ? undefined : pendingEditReason}>
                <TabsTrigger value={item.group} disabled={generationBusy || (selectionDirty && item.group !== group)}>
                  {t(item.label)}
                </TabsTrigger>
              </Explained>
            ))}
          </TabsList>
          {group === "plan" ? (
            <Segmented
              size="sm"
              className={styles.planViews}
              aria-label={t("motion.stageBar.planAria")}
              value={stage}
              onValueChange={(next) => showStage(next as MovieStage, next === "style" ? "settings" : "notes")}
            >
              {PLAN_STAGES.filter((item) => embedded || item.stage !== "style").map((item) => (
                <Explained key={item.stage} reason={item.stage === stage ? undefined : pendingEditReason}>
                  <SegmentedItem value={item.stage} aria-label={t(item.label)} disabled={selectionDirty && item.stage !== stage}>
                    {t(item.text)}
                  </SegmentedItem>
                </Explained>
              ))}
            </Segmented>
          ) : null}
          <span role="status" className={styles.notice}>
            {notice ? <span className={styles.noticeText}>{notice.text}</span> : null}
            {notice?.showChat && chat.mode === "main" ? (
              <Button variant="link" size="sm" onClick={() => chat.reveal()}>
                {t("motion.editor.showChat")}
              </Button>
            ) : null}
          </span>
          <span className={styles.stageMeta}>
            {t("motion.stageBar.meta", { aspect: current.aspect, duration, shots: current.shots.length })}
          </span>
        </div>}
        <div className={styles.messages}>
          {readOnly ? <Callout tone="neutral">{t("motion.editor.readOnly")}</Callout> : null}
          {error ? (
            <Callout tone="error" role="alert" className={styles.errorCallout}>
              <span>{error}</span>
              <Button variant="link" size="sm" onClick={() => void open()}>
                {t("motion.common.reload")}
              </Button>
            </Callout>
          ) : null}
          {productionVisible ? (
            <div className={styles.statusRow} data-testid="movie-production-status">
              {productionRunning ? (
                <span className={styles.statusRunning}>
                  <Spinner size="xs" />
                  <span>{productionText}</span>
                </span>
              ) : (
                <StatusLabel tone={current.production?.status === "done" ? "done" : "muted"}>{productionText}</StatusLabel>
              )}
              {["armed", "preparing"].includes(current.production?.status ?? "") && !readOnly ? (
                <Button variant="bare" size="sm" onClick={() => void cancelProduction()}>
                  {t("motion.production.cancel")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {aiBusy ? (
            <div className={styles.statusRow} data-testid="movie-ai-status">
              <span className={styles.statusRunning}>
                <Spinner size="xs" />
                <span>{t("motion.editor.aiWorking")}</span>
              </span>
            </div>
          ) : null}
          {current.lastEdit ? <MovieEditReceipt receipt={current.lastEdit} /> : null}
        </div>
        <div ref={bodyRef} className={styles.body} data-inspector={inspectorOpen ? "shown" : "hidden"} style={dockStyle}>
          <TabsContent value={group} className={styles.editPane} data-stage={stage}>
            <div ref={editScrollRef} className={styles.editScroll}>
              {stageContent()}
            </div>
            <footer className={styles.stageFooter} data-testid="movie-stage-footer">
              {stageFooter()}
            </footer>
          </TabsContent>
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="horizontal"
            aria-label={t("fantay.ui.resizePanel")}
            aria-valuemin={DOCK_MIN}
            aria-valuemax={DOCK_MAX}
            aria-valuenow={dockShare}
            className={styles.dockHandle}
            onPointerDown={startDockDrag}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 10 : 2;
              let next: number | null = null;
              if (event.key === "ArrowUp") next = dockShare + step;
              else if (event.key === "ArrowDown") next = dockShare - step;
              else if (event.key === "Home") next = DOCK_MAX;
              else if (event.key === "End") next = DOCK_MIN;
              if (next === null) return;
              event.preventDefault();
              setDockShare(Math.max(DOCK_MIN, Math.min(DOCK_MAX, next)));
            }}
          />
          <aside className={styles.inspector} aria-label={t("motion.inspector.aria")} data-testid="movie-inspector">
            <Tabs
              value={sideChat || inspectorTab !== "chat" ? inspectorTab : "settings"}
              onValueChange={(next) => openInspector(next as InspectorTab)}
              className={styles.inspectorTabs}
            >
              <TabsList variant="line" size="md" aria-label={t("motion.inspector.aria")} className={styles.inspectorList} style={styleWorkspace ? { display: 'none' } : undefined}>
                <Explained reason={inspectorTab === "notes" ? undefined : pendingEditReason}>
                  <TabsTrigger value="notes" disabled={selectionDirty && inspectorTab !== "notes"}>
                    {t("motion.inspector.feedback")}
                  </TabsTrigger>
                </Explained>
                <Explained reason={dirty && inspectorTab !== "edit" ? t("motion.editor.saveFirst") : undefined}>
                  <TabsTrigger value="edit" disabled={dirty && inspectorTab !== "edit"}>
                    {t("motion.inspector.edit")}
                  </TabsTrigger>
                </Explained>
                <Explained reason={inspectorTab === "settings" ? undefined : pendingEditReason}>
                  <TabsTrigger value="settings" disabled={selectionDirty && inspectorTab !== "settings"}>
                    {t("motion.inspector.settings")}
                  </TabsTrigger>
                </Explained>
                {sideChat ? (
                  <Explained reason={inspectorTab === "chat" ? undefined : pendingEditReason}>
                    <TabsTrigger value="chat" disabled={selectionDirty && inspectorTab !== "chat"}>
                      {t("motion.inspector.chat")}
                    </TabsTrigger>
                  </Explained>
                ) : null}
              </TabsList>
              <TabsContent value="notes" forceMount hidden={inspectorTab !== "notes"} className={styles.inspectorPanel}>
                <MovieReviewNotes
                  document={current}
                  projectId={projectId}
                  context={workspaceContext}
                  target={noteTarget}
                  focusRequested={feedbackFocus}
                  onTarget={selectReviewTarget}
                  busy={busy}
                  aiRunning={aiBusy}
                  readOnly={readOnly}
                  onFreeze={() => {
                    const at = reviewPlayer.current?.freeze() ?? videoTime;
                    if (stage === "review" && noteTarget.scope === "time" && render)
                      setNoteTarget({ scope: "time", renderId: render.id, time: at });
                  }}
                  onAdd={async (text) => {
                    const ok = await run({ action: "add-note", ...noteTarget, contentRevision: current.contentRevision, text });
                    if (!ok) throw new Error("feedback not saved");
                  }}
                  onSubmit={(ids) => void submitFeedback(ids)}
                  onResolve={(note) =>
                    void run({
                      action: "resolve-note",
                      noteId: note.id,
                      ...(note.addressedRenderId ? { renderId: note.addressedRenderId } : {}),
                    })
                  }
                  onLocate={(note) => {
                    if (note.renderId) {
                      setSelectedRenderId(note.renderId);
                      setStage("review");
                      setNoteTarget({
                        scope: note.scope ?? "time",
                        renderId: note.renderId,
                        time: note.time,
                        ...(note.endTime === undefined ? {} : { endTime: note.endTime }),
                        ...(note.shotId ? { shotId: note.shotId } : {}),
                      });
                      reviewPlayer.current?.seek(note.time);
                    } else {
                      const index = current.shots.findIndex((s) => s.id === note.shotId);
                      if (index >= 0) setSelectedShot(index);
                      setStage("samples");
                      setNoteTarget({
                        scope: note.scope ?? "film",
                        time: note.time,
                        ...(note.shotId ? { shotId: note.shotId } : {}),
                      });
                    }
                    openInspector("notes");
                  }}
                  onAddMaterial={() => {
                    setPickerRole("style");
                    setPicker(true);
                  }}
                />
              </TabsContent>
              <TabsContent value="edit" className={styles.inspectorPanel}>
                {doc ? (
                  <MovieSelectionEditor
                    document={doc}
                    selectedShotId={current.shots[selectedShot]?.id}
                    onSelect={(id) => setSelectedShot(current.shots.findIndex((s) => s.id === id))}
                    busy={busy || aiBusy || dirty || rendering}
                    busyReason={
                      dirty
                        ? t("motion.editor.saveFirst")
                        : aiBusy
                          ? t("motion.editor.aiBusy")
                          : rendering
                            ? t("motion.node.renderRunning")
                            : undefined
                    }
                    readOnly={readOnly}
                    onApply={applyLocalized}
                    onDirtyChange={setSelectionDirty}
                  />
                ) : null}
              </TabsContent>
              <TabsContent value="settings" forceMount hidden={inspectorTab !== "settings"} className={styles.inspectorPanel}>
                {settings}
              </TabsContent>
              {sideChat ? (
                <TabsContent
                  value="chat"
                  forceMount
                  hidden={inspectorTab !== "chat"}
                  className={cn(styles.inspectorPanel, styles.chatPanel)}
                >
                  <div className={styles.chatHead}>
                    <span>{t("motion.embedded.currentModel")}</span>
                    <FxLegacy>{sideChat.executionSwitcher}</FxLegacy>
                  </div>
                  <p className={styles.hint}>{t("motion.embedded.chatHint")}</p>
                  <div className={styles.chatBody}>
                    {conversationId ? (
                      <FxLegacy>
                        <SideChatTab
                          inlineComposer
                          hideContextBanner
                          skillId="fantay-movie"
                          projectId={projectId}
                          conversationId={conversationId}
                          config={sideChat.config}
                          agentsById={new Map(sideChat.agents.map((agent) => [agent.id, agent]))}
                          locale={locale}
                          workspaceContext={workspaceContext}
                          projectFiles={[]}
                          conversations={conversations}
                          onSelectConversation={setConversationId}
                          onExecutionPermissionSaved={readOnly ? undefined : onExecutionPermissionSaved}
                          onDeleteConversation={() => {}}
                          promptRequest={promptRequest}
                          onActivityChange={setAiRunning}
                          onPromptRequestSettled={(id, accepted) => {
                            setPromptRequest((value) => (value?.id === id ? null : value));
                            if (!accepted) setError(t("motion.editor.agentUnavailable"));
                          }}
                        />
                      </FxLegacy>
                    ) : (
                      <p className={styles.hint}>{t("motion.embedded.preparingChat")}</p>
                    )}
                  </div>
                </TabsContent>
              ) : null}
            </Tabs>
          </aside>
        </div>
      </Tabs>
      {picker ? (
        <FxLegacy>
          <MaterialPickerDialog onClose={() => setPicker(false)} onConfirm={attachMaterials} />
        </FxLegacy>
      ) : null}
      {videoPicker ? (
        <FxLegacy>
          <MovieVideoPicker onClose={() => setVideoPicker(false)} onConfirm={chooseVideos} />
        </FxLegacy>
      ) : null}
      <Modal open={connectionOpen} onClose={() => setConnectionOpen(false)} size="md" aria-describedby={undefined}>
        <ModalTitle>{t("motion.connection.title")}</ModalTitle>
        <MovieConnection />
      </Modal>
    </div>
  );
}
