import type { ReleaseChannel } from "@open-design/release";

/**
 * @module protocol
 *
 * The OpenDesign renderer host-bridge wire contract: the injected-global name
 * and version, client/updater constant registries, and every request/result
 * type that crosses the host bridge — including the {@link OpenDesignHostBridge}
 * shape itself. Pure declarations only; depends on nothing else in the package.
 */

export const OPEN_DESIGN_HOST_GLOBAL = "__od__";
export const OPEN_DESIGN_HOST_VERSION = 2;

export const OPEN_DESIGN_HOST_CLIENT_TYPES = Object.freeze({
  DESKTOP: "desktop",
} as const);

export type OpenDesignHostClientType =
  (typeof OPEN_DESIGN_HOST_CLIENT_TYPES)[keyof typeof OPEN_DESIGN_HOST_CLIENT_TYPES];

export type OpenDesignHostClient = {
  // BCP-47 locale string (e.g. "zh-CN", "pt-BR") the host process read from
  // the OS at startup. The renderer uses this so the packaged desktop app
  // can follow the OS language even when Chromium's built-in
  // `navigator.language` would have defaulted to en-US.
  osLocale?: string;
  platform?: string;
  type: OpenDesignHostClientType;
};

export type OpenDesignHostFailure = {
  details?: unknown;
  ok: false;
  reason: string;
};

export type OpenDesignHostActionResult =
  | { ok: true }
  | OpenDesignHostFailure;

/**
 * The workspace attribution the renderer gives the host so a folder import
 * lands in the caller's current workspace instead of the host's ambient one.
 *
 * This is a deliberate structural subset of the daemon/web
 * `WorkspaceCollabContext`, redeclared here rather than imported: this package
 * is the renderer host-bridge wire contract and must stay independent of the
 * daemon/web contracts package (enforced by the "stays independent from
 * daemon/web contracts" test). A full `WorkspaceCollabContext` is structurally
 * assignable to this type, so callers pass theirs unchanged.
 *
 * Only the fields the host actually forwards are modelled, and the enum-like
 * fields stay `string` because the host treats them as opaque pass-through
 * values — the daemon remains the authority that parses and validates them.
 * Deliberately no index signature: an interface never satisfies one, so adding
 * it would reject the very `WorkspaceCollabContext` callers pass. Callers hand
 * over a variable, not a fresh literal, so the extra fields ride along fine.
 */
export type OpenDesignHostWorkspaceContext = {
  lifecycleState: string;
  memberStatus: string;
  permissions: {
    canShareProjects: boolean;
    canWriteSyncedFiles: boolean;
  };
  role: string;
  workspaceId: string;
  workspaceMemberId: string;
  workspaceType: string;
};

export type OpenDesignHostMovieDestination =
  | { ok: true; id: string; path: string }
  | { ok: false; reason: string; cancelled?: boolean };
export interface OpenDesignHostMovieExport {
  chooseDestination(input: { filename: string; format: 'mp4' | 'mov' }): Promise<OpenDesignHostMovieDestination>;
  save(input: { destinationId: string; projectId: string; renderId: string; workspaceContext?: OpenDesignHostWorkspaceContext | null }): Promise<OpenDesignHostMovieDestination>;
  open(input: { destinationId: string; reveal: boolean }): Promise<OpenDesignHostActionResult>;
}

export type OpenDesignHostProjectImportInit = {
  designSystemId?: string | null;
  name?: string;
  skillId?: string | null;
  workspaceContext?: OpenDesignHostWorkspaceContext | null;
};

export type OpenDesignHostProjectImportSuccess = {
  conversationId: string;
  entryFile: string | null;
  ok: true;
  projectId: string;
};

export type OpenDesignHostProjectImportResult =
  | OpenDesignHostProjectImportSuccess
  | {
      canceled: true;
      ok: false;
    }
  | OpenDesignHostFailure;

export type OpenDesignHostProjectReplaceWorkingDirSuccess = {
  baseDir: string;
  entryFile: string | null;
  ok: true;
};

export type OpenDesignHostProjectReplaceWorkingDirResult =
  | OpenDesignHostProjectReplaceWorkingDirSuccess
  | {
      canceled: true;
      ok: false;
    }
  | OpenDesignHostFailure;

export type OpenDesignHostPickWorkingDirSuccess = {
  baseDir: string;
  ok: true;
  // Single-use HMAC token (minted by the host main process for `baseDir`)
  // that the renderer threads into POST /api/projects/:id/working-dir once
  // the project exists. Lets the Home flow pick a folder before the project
  // is created without exposing the daemon's desktop-auth gate.
  token: string;
};

export type OpenDesignHostPickWorkingDirResult =
  | OpenDesignHostPickWorkingDirSuccess
  | {
      canceled: true;
      ok: false;
    }
  | OpenDesignHostFailure;

export type OpenDesignHostPdfPrintOptions = {
  deck?: boolean;
};

export type OpenDesignHostCaptureClip = { x: number; y: number; width: number; height: number };
export type OpenDesignHostCaptureOptions = { clip?: OpenDesignHostCaptureClip };
export type OpenDesignHostCaptureSuccess = { dataUrl: string; h: number; ok: true; w: number };
export type OpenDesignHostCaptureResult = OpenDesignHostCaptureSuccess | OpenDesignHostFailure;

export type OpenDesignHostPreviewNavigationFailure = {
  errorCode: number;
  eventId: number;
  frameName?: string;
  occurredAtMs: number;
  validatedUrl: string;
};

export type OpenDesignHostPreviewNavigationFailureListener = (
  failure: OpenDesignHostPreviewNavigationFailure,
) => void;

export type OpenDesignHostBrowserClearDataOptions = {
  cookies?: boolean;
  storage?: boolean;
};

/**
 * App theme values the renderer may pin the host window appearance to.
 * `light`/`dark` force the native window material (macOS under-window
 * vibrancy glass follows the OS appearance by default, which reads as a
 * muddy gray when the OS is dark but the app theme is explicitly light);
 * `system` restores following the OS.
 */
export const OPEN_DESIGN_HOST_APPEARANCE_THEMES = Object.freeze({
  DARK: "dark",
  LIGHT: "light",
  SYSTEM: "system",
} as const);

export type OpenDesignHostAppearanceTheme =
  (typeof OPEN_DESIGN_HOST_APPEARANCE_THEMES)[keyof typeof OPEN_DESIGN_HOST_APPEARANCE_THEMES];

export const OPEN_DESIGN_HOST_UPDATER_ACTIONS = Object.freeze({
  CHECK: "check",
  CLEAR_CACHE: "clear-cache",
  DOWNLOAD: "download",
  INSTALL: "install",
  QUIT: "quit",
  STATUS: "status",
} as const);

export type OpenDesignHostUpdaterAction =
  (typeof OPEN_DESIGN_HOST_UPDATER_ACTIONS)[keyof typeof OPEN_DESIGN_HOST_UPDATER_ACTIONS];

/** @internal Updater actions that return a status snapshot (every action except `quit`). */
export type OpenDesignHostUpdaterStatusAction = Exclude<
  OpenDesignHostUpdaterAction,
  typeof OPEN_DESIGN_HOST_UPDATER_ACTIONS.QUIT
>;

export const OPEN_DESIGN_HOST_UPDATER_STATES = Object.freeze({
  AVAILABLE: "available",
  CHECKING: "checking",
  DOWNLOADED: "downloaded",
  DOWNLOADING: "downloading",
  ERROR: "error",
  IDLE: "idle",
  INSTALLING: "installing",
  NOT_AVAILABLE: "not-available",
  UNSUPPORTED: "unsupported",
} as const);

export type OpenDesignHostUpdaterState =
  (typeof OPEN_DESIGN_HOST_UPDATER_STATES)[keyof typeof OPEN_DESIGN_HOST_UPDATER_STATES];

export type OpenDesignHostUpdaterMode = "js-incremental" | "package-launcher";
export type OpenDesignHostUpdaterChannel = ReleaseChannel;

export type OpenDesignHostUpdaterActionOptions = {
  payload?: Record<string, unknown>;
};

export type OpenDesignHostUpdaterCapabilitySet = {
  canApplyInPlace: boolean;
  canDownload: boolean;
  canOpenInstaller: boolean;
  requiresManualInstall: boolean;
};

export type OpenDesignHostUpdaterPathSnapshot = {
  downloadRoot?: string;
  manifestPath?: string;
};

export type OpenDesignHostUpdaterChecksumSnapshot = {
  algorithm: "sha256" | "sha512";
  url?: string;
  value?: string;
};

export type OpenDesignHostUpdaterArtifactSnapshot = {
  name?: string;
  platformKey?: string;
  size?: number;
  type?: string;
  url: string;
};

export type OpenDesignHostUpdaterProgressSnapshot = {
  receivedBytes: number;
  totalBytes?: number;
};

export type OpenDesignHostUpdaterErrorSnapshot = {
  code: string;
  details?: unknown;
  message: string;
};

export type OpenDesignHostUpdaterInstallResult = {
  activeVersion?: string;
  artifactPath?: string;
  dryRun?: boolean;
  helperLogPath?: string;
  launcherRuntimePath?: string;
  launchPath?: string;
  openedAt: string;
  path: string;
};

export type OpenDesignHostUpdaterReleaseSnapshot = {
  arch: string;
  artifact: OpenDesignHostUpdaterArtifactSnapshot;
  checksum: OpenDesignHostUpdaterChecksumSnapshot;
  channel: OpenDesignHostUpdaterChannel;
  downloadedAt: string;
  key: string;
  metadata?: Record<string, unknown>;
  path: string;
  platformKey: string;
  version: string;
};

export type OpenDesignHostUpdaterIncomingSnapshot = {
  arch: string;
  artifact: OpenDesignHostUpdaterArtifactSnapshot;
  channel: OpenDesignHostUpdaterChannel;
  key?: string;
  metadata?: Record<string, unknown>;
  progress?: OpenDesignHostUpdaterProgressSnapshot;
  startedAt: string;
  version: string;
};

export type OpenDesignHostUpdaterCacheLifecycleTrigger = "cold-start" | "manual" | "next-version-ready";

export type OpenDesignHostUpdaterReleaseLifecycleState =
  | "cleanup-deferred"
  | "cleanup-removed"
  | "deprecated"
  | "retained"
  | "unknown";

export type OpenDesignHostUpdaterCacheLifecycleSummary = {
  lastRunAt?: string;
  lastTrigger?: OpenDesignHostUpdaterCacheLifecycleTrigger;
  platform: string;
  releases: {
    cleanupDeferred: number;
    cleanupRemoved: number;
    deprecated: number;
    errors: number;
    retained: number;
    total: number;
    unknown: number;
  };
};

export type OpenDesignHostUpdaterCacheSnapshot = {
  lifecycle?: OpenDesignHostUpdaterCacheLifecycleSummary;
};

export type OpenDesignHostUpdaterReinstallReason =
  | "launcher-schema"
  | "outer-below-min"
  | "outer-version-unreadable";

/**
 * Present when the release feed requires a full installer reinstall instead of
 * an in-place payload update. `installedVersion` is the physically installed
 * outer package version; `url` is an optional operator-supplied explanation
 * link.
 */
export type OpenDesignHostUpdaterReinstallSnapshot = {
  installedVersion?: string;
  minVersion?: string;
  reason: OpenDesignHostUpdaterReinstallReason;
  url?: string;
};

export type OpenDesignHostUpdaterStatusSnapshot = {
  active?: OpenDesignHostUpdaterReleaseSnapshot;
  arch: string;
  artifact?: OpenDesignHostUpdaterArtifactSnapshot;
  artifactUrl?: string;
  availableVersion?: string;
  cache?: OpenDesignHostUpdaterCacheSnapshot;
  capabilities: OpenDesignHostUpdaterCapabilitySet;
  channel: OpenDesignHostUpdaterChannel;
  checksum?: OpenDesignHostUpdaterChecksumSnapshot;
  currentVersion: string;
  downloadPath?: string;
  enabled: boolean;
  error?: OpenDesignHostUpdaterErrorSnapshot;
  incoming?: OpenDesignHostUpdaterIncomingSnapshot;
  installResult?: OpenDesignHostUpdaterInstallResult;
  lastCheckedAt?: string;
  metadata?: Record<string, unknown>;
  mode: OpenDesignHostUpdaterMode;
  paths?: OpenDesignHostUpdaterPathSnapshot;
  platform: string;
  progress?: OpenDesignHostUpdaterProgressSnapshot;
  reinstall?: OpenDesignHostUpdaterReinstallSnapshot;
  state: OpenDesignHostUpdaterState;
  supported: boolean;
};

export type OpenDesignHostUpdaterResult =
  | { ok: true; status: OpenDesignHostUpdaterStatusSnapshot }
  | OpenDesignHostFailure;

export type OpenDesignHostUpdaterStatusListener = (status: OpenDesignHostUpdaterStatusSnapshot) => void;

export type OpenDesignHostUpdaterMenuLabels = {
  check: string;
  checking: string;
  downloading: string;
  install: string;
  installing: string;
  restart: string;
};

export type OpenDesignHostUpdaterOpenDialogRequest = {
  source: string;
};

export type OpenDesignHostUpdaterOpenDialogListener = (request: OpenDesignHostUpdaterOpenDialogRequest) => void;

export type OpenDesignHostDownloadResult = {
  url: string;
  state: "completed" | "cancelled" | "interrupted";
};

/**
 * Fantay native-menu commands (fork, spec 02 §5.7). The desktop main process
 * sends one of these ids to the renderer over `od:menu:command`; the renderer
 * maps it onto its own command registry. The protocol carries command ids
 * only: accelerators and menu placement belong to the desktop main process.
 */
export const OPEN_DESIGN_HOST_MENU_COMMANDS = Object.freeze({
  NEW_PROJECT: "fantay.newProject",
  NEW_CHAT: "fantay.newChat",
  SEARCH: "fantay.search",
  TOGGLE_SIDEBAR: "fantay.toggleSidebar",
  OPEN_SETTINGS: "fantay.openSettings",
  IMPORT_DESIGN_FILE: "fantay.design.import",
  BOARD_ZOOM_IN: "fantay.board.zoomIn",
  BOARD_ZOOM_OUT: "fantay.board.zoomOut",
  BOARD_ZOOM_FIT: "fantay.board.zoomFit",
  BOARD_ZOOM_100: "fantay.board.zoom100",
} as const);

export type OpenDesignHostMenuCommand =
  (typeof OPEN_DESIGN_HOST_MENU_COMMANDS)[keyof typeof OPEN_DESIGN_HOST_MENU_COMMANDS];

/** Renderer-localized labels for the Fantay native-menu items (fork, spec 02 §5.7). */
export type OpenDesignHostMenuLabels = {
  file: string;
  newProject: string;
  newChat: string;
  importDesign: string;
  settings: string;
  toggleSidebar: string;
  zoomIn: string;
  zoomOut: string;
  zoomFit: string;
  zoom100: string;
};

/**
 * Title-bar overlay colours for frameless windows (fork, spec 02 §5.7):
 * opaque `#rrggbb` values and an optional height in px. The host validates the
 * payload and applies it on Windows only.
 */
export type OpenDesignHostTitleBarOverlay = { color: string; symbolColor: string; height?: number };

/** Text a tool plugin shows in Fantay: one string, or one per locale tag (`zh`, `en`, `zh-CN` …). */
export type OpenDesignHostToolPluginText = string | Record<string, string>;

/**
 * One tool plugin as the desktop host sees it. `enabled` is the saved
 * preference; `active` and `status` describe the host half in this process.
 * Everything after `active` is absent on hosts that only ship built-in tools.
 */
export type OpenDesignHostToolPlugin = {
  id: string;
  shortcut?: string;
  enabled: boolean;
  active: boolean;
  /** `builtin` ships with Fantay; `installed` is a plugin package the user added and can delete. */
  source?: 'builtin' | 'installed';
  /** `dsh` marks a DeepSeek Harness bundle loaded through the compatibility layer. */
  flavor?: 'fantay' | 'dsh';
  version?: string;
  title?: OpenDesignHostToolPluginText;
  description?: OpenDesignHostToolPluginText;
  /** Image data URL. */
  icon?: string;
  /** The plugin has a workspace module, loaded while it is enabled. */
  client?: boolean;
  /**
   * `pending`: enabled, but a host entry waits for a service Fantay does not provide.
   * `failed`: a host entry threw while starting. `missing`: the package folder is gone or unreadable.
   */
  status?: 'inactive' | 'active' | 'pending' | 'failed' | 'missing';
  /** Diagnostic for `pending`, `failed` and `missing`; not localized. */
  issue?: string;
  /** Where the files of an installed plugin are kept. */
  path?: string;
};

export type OpenDesignHostToolPluginChangeResult =
  | { ok: true; plugins: OpenDesignHostToolPlugin[] }
  | {
      ok: false;
      reason: 'activation-failed' | 'save-failed' | 'invalid-package' | 'duplicate' | 'cancelled';
      /** Diagnostic for the failure; not localized. */
      message?: string;
    };

/** A plugin's workspace module: a script that calls `window.__ModuleLoader__.load({ id: moduleId, factory })`. */
export type OpenDesignHostToolPluginClientModule = {
  id: string;
  moduleId: string;
  code: string;
  /** Changes whenever the file changes. */
  rev: string;
};

/**
 * Where plugin HTTP routes are served. The workspace hands this to the daemon,
 * which forwards same-origin requests under each prefix to the loopback port.
 */
export type OpenDesignHostToolPluginGateway = {
  port: number;
  token: string;
  prefixes: string[];
};

export type OpenDesignHostToolPluginEvent =
  | { type: 'changed'; plugins: OpenDesignHostToolPlugin[] }
  /** A plugin's host half sent a message to its workspace half. */
  | { type: 'message'; pluginId: string; channel: string; payload: unknown };

export type OpenDesignHostBridge = {
  toolPlugins?: {
    list(): Promise<OpenDesignHostToolPlugin[]>;
    setEnabled(id: string, enabled: boolean): Promise<OpenDesignHostToolPluginChangeResult>;
    // The members below are optional so hosts that only ship built-in tools keep the same contract.
    /**
     * Opens a folder picker and installs the chosen plugin package by copying it into Fantay's plugin
     * folder. A new plugin starts disabled; installing one that exists replaces its files.
     */
    install?(): Promise<OpenDesignHostToolPluginChangeResult>;
    /** Deletes an installed plugin: stops it and removes Fantay's copy of its files. */
    uninstall?(id: string): Promise<OpenDesignHostToolPluginChangeResult>;
    clientModule?(id: string): Promise<OpenDesignHostToolPluginClientModule | null>;
    gateway?(): Promise<OpenDesignHostToolPluginGateway | null>;
    /** Calls a handler the plugin's host half registered for `channel`. */
    invoke?(pluginId: string, channel: string, payload?: unknown): Promise<unknown>;
    subscribe?(listener: (event: OpenDesignHostToolPluginEvent) => void): () => void;
  };
  startup?: {
    context(): Promise<{ launch_attempt_id: string; app_session_id: string } | null>;
    signal(value: { launch_attempt_id: string; app_session_id: string;
      readiness_point: 'first_visible' | 'interactive_ready'; required_data_ready?: boolean; actions_ready?: boolean }): Promise<boolean>;
  };
  /** Optional on older hosts. Reports actual disk completion, never initiation. */
  downloads?: {
    subscribe(listener: (result: OpenDesignHostDownloadResult) => void): () => void;
  };
  // Optional so older host builds still satisfy the bridge shape; callers
  // must feature-detect before invoking.
  appearance?: {
    setTheme(theme: OpenDesignHostAppearanceTheme): void;
  };
  browser: {
    clearData(options?: OpenDesignHostBrowserClearDataOptions): Promise<OpenDesignHostActionResult>;
    subscribeNewTab?(listener: (request: { guestId: number; url: string }) => void): () => void;
  };
  capture: {
    page(options?: OpenDesignHostCaptureOptions): Promise<OpenDesignHostCaptureResult>;
  };
  client: OpenDesignHostClient;
  movieExport?: OpenDesignHostMovieExport;
  // Fantay fork (spec 02 §5.7): optional native-menu capability. Absent in web
  // and older hosts (version stays 2); callers feature-detect through the
  // action wrappers, and `isOpenDesignHostBridge` does not validate it.
  menu?: {
    subscribeCommand(listener: (command: OpenDesignHostMenuCommand) => void): () => void;
    setLabels(labels: OpenDesignHostMenuLabels): Promise<OpenDesignHostActionResult>;
  };
  pdf: {
    print(html: string, nonce?: string, options?: OpenDesignHostPdfPrintOptions): Promise<OpenDesignHostActionResult>;
  };
  pet: {
    setVisible(visible: boolean): void;
    setIgnoreMouseEvents?(ignore: boolean): void;
  };
  // Optional so web builds and older desktop hosts keep the same contract.
  // Electron is the only layer that can observe a compositor-affecting
  // subframe navigation failure after the iframe DOM remains healthy.
  preview?: {
    getLatestNavigationFailure(): OpenDesignHostPreviewNavigationFailure | null;
    subscribeNavigationFailure(listener: OpenDesignHostPreviewNavigationFailureListener): () => void;
  };
  project: {
    pickAndImport(init?: OpenDesignHostProjectImportInit): Promise<OpenDesignHostProjectImportResult>;
    pickAndReplaceWorkingDir(projectId: string): Promise<OpenDesignHostProjectReplaceWorkingDirResult>;
    // Optional so older host builds still satisfy the bridge shape; callers
    // must feature-detect before invoking.
    pickWorkingDir?(): Promise<OpenDesignHostPickWorkingDirResult>;
  };
  shell: {
    openExternal(url: string): Promise<OpenDesignHostActionResult>;
    openPath(projectId: string): Promise<OpenDesignHostActionResult>;
    openConversation?(projectId: string, conversationId: string): Promise<OpenDesignHostActionResult>;
  };
  // Desktop only. Absent in Web and old clients; callers must fail closed.
  updater: {
    check(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostUpdaterStatusSnapshot>;
    "clear-cache"(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostUpdaterStatusSnapshot>;
    download(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostUpdaterStatusSnapshot>;
    install(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostUpdaterStatusSnapshot>;
    quit(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostActionResult>;
    setMenuLabels(labels: OpenDesignHostUpdaterMenuLabels): Promise<OpenDesignHostActionResult>;
    status(options?: OpenDesignHostUpdaterActionOptions): Promise<OpenDesignHostUpdaterStatusSnapshot>;
    subscribe(listener: OpenDesignHostUpdaterStatusListener): () => void;
    subscribeOpenDialog(listener: OpenDesignHostUpdaterOpenDialogListener): () => void;
  };
  version: typeof OPEN_DESIGN_HOST_VERSION;
  // Fantay fork (spec 02 §5.7): optional window-chrome capability (Windows
  // title-bar overlay). Absent in web and older hosts; callers feature-detect.
  window?: {
    setTitleBarOverlay(overlay: OpenDesignHostTitleBarOverlay): Promise<OpenDesignHostActionResult>;
  };
};

export type OpenDesignHostGlobalScope = Record<string, unknown> & {
  window?: unknown;
};
