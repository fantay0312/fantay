// Fantay 工作台 (workbench) contracts.
//
// The workbench is the creator desk ported from dsh-media-desk
// (https://github.com/woniuniuniu/dsh-media-desk, MIT, Copyright (c) 2026 woniuniuniu):
// 灵感 (library) · 成稿 (production studio) · 内容 · 排期 · 复盘 · 风格, plus an assistant
// that edits everything through the same whitelisted ops. The 灵感 library adds Resurf-style
// organisation: Inbox triage, Spaces, Tags, Starred, Trash, AI auto-organise, reader, highlights
// and resurfacing.
//
// The daemon owns one JSON state document under its data root. Every write goes through
// `POST /api/workbench/ops` (or a dedicated route below) and returns the full next state.
// Text and image models and social-account import all run on the signed-in TokenToSea
// account; the workbench never stores provider keys.
//
// Media `src` values are either `https://…` URLs or daemon-relative paths of the form
// `workbench/files/<name>` (user data) or `workbench/assets/<name>` (bundled samples).
// Clients resolve a relative path by prefixing `/api/` (see `workbenchMediaUrl`).
//
// Keep this file pure TypeScript — no Node, browser, or daemon imports.

export const WORKBENCH_STATUSES = ['idea', 'outline', 'draft', 'ready', 'published'] as const;
export type WorkbenchStatus = (typeof WORKBENCH_STATUSES)[number];

export const WORKBENCH_KINDS = ['note', 'quote', 'web', 'image', 'video', 'pdf', 'audio'] as const;
export type WorkbenchKind = (typeof WORKBENCH_KINDS)[number];

/** Platform names are stored verbatim (they are also the zh labels). */
export const WORKBENCH_PLATFORMS = ['公众号', '小红书', '抖音', 'B站', '视频号', 'TikTok', 'Instagram', 'YouTube', 'X'] as const;
export type WorkbenchPlatform = (typeof WORKBENCH_PLATFORMS)[number];

/** Platforms whose public account data can be imported through TokenToSea 社媒数据. */
export const WORKBENCH_IMPORT_PLATFORMS = ['小红书', '抖音', 'B站', 'TikTok', 'Instagram', 'X'] as const;
export type WorkbenchImportPlatform = (typeof WORKBENCH_IMPORT_PLATFORMS)[number];

/** Space colours, Resurf-style folder tints. */
export const WORKBENCH_SPACE_COLORS = ['blue', 'olive', 'pink', 'violet', 'green', 'orange', 'red', 'gray'] as const;
export type WorkbenchSpaceColor = (typeof WORKBENCH_SPACE_COLORS)[number];

export type WorkbenchDraftFormat = 'script' | 'article';
export type WorkbenchLanguage = 'auto' | 'zh' | 'en';

export interface WorkbenchMedia {
  src: string;
  poster?: string;
  w?: number;
  h?: number;
  mime?: string;
  bytes?: number;
  durationSec?: number;
  /** Dominant colours as #rrggbb, most prominent first (images only). */
  colors?: string[];
}

export interface WorkbenchPos { x: number; y: number; r: number }

export interface WorkbenchDraft {
  text: string;
  by: 'ai' | 'user';
  engine?: string;
  at: string;
  aiText?: string;
}

export type WorkbenchAssetStatus = 'idle' | 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface WorkbenchAsset {
  prompt: string;
  status: WorkbenchAssetStatus;
  src?: string;
  error?: string | null;
}
export interface WorkbenchFigure extends WorkbenchAsset { caption: string; anchor: string }
export interface WorkbenchShot extends WorkbenchAsset { no: number; shot: string; visual: string; voice: string; seconds: number }

/** Regeneration target: `cover`, `image:<index>` or `shot:<index>` (0-based). */
export type WorkbenchAssetTarget = 'cover' | `image:${number}` | `shot:${number}`;

export interface WorkbenchProduction {
  status: 'running' | 'done' | 'failed' | 'cancelled';
  stage: 'brief' | 'making' | 'done';
  withImages: boolean;
  startedAt: string;
  finishedAt?: string;
  format: WorkbenchDraftFormat;
  title: string;
  /** Big cover words, ≤ 24 chars. */
  coverText?: string;
  facts?: string[];
  outline?: string[];
  characters?: string;
  /** Markdown body without the leading `# title`. */
  article: string;
  aiArticle?: string;
  engine?: string;
  notice?: string | null;
  error?: string | null;
  /** Images were wanted but no TokenToSea image model is usable. */
  needsProvider?: boolean;
  cover: WorkbenchAsset | null;
  images: WorkbenchFigure[];
  shots: WorkbenchShot[];
  savedPath?: string;
  savedAt?: string;
}

/** In-flight streaming view of a running production (`GET /api/workbench/production`). */
export interface WorkbenchProductionLive {
  running: boolean;
  stage?: 'brief' | 'making' | 'done';
  /** Article text streamed so far. */
  text?: string;
  title?: string;
  /** Shot visuals parsed from the streaming plan. */
  visuals?: string[];
}

export interface WorkbenchHighlight { id: string; text: string; note?: string; at: string }

/** Clean reader text for web items (Resurf reader). */
export interface WorkbenchReader {
  text: string;
  title?: string;
  byline?: string;
  siteName?: string;
  words?: number;
  fetchedAt: string;
  error?: string;
}

export interface WorkbenchItem {
  id: string;
  kind: WorkbenchKind;
  title: string;
  body: string;
  url?: string | null;
  source?: string;
  tags: string[];
  status: WorkbenchStatus;
  angleId?: string | null;
  personaIds: string[];
  /** Canvas grouping: a child idea hangs under its parent. */
  parentId?: string | null;
  rel?: string;
  scheduledAt?: string | null;
  publishedAt?: string | null;
  platform?: WorkbenchPlatform | null;
  pinned?: boolean;
  media?: WorkbenchMedia | null;
  /** Position on the infinite canvas. */
  pos?: WorkbenchPos;
  score?: number;
  createdAt: string;
  updatedAt?: string;
  drafts: Partial<Record<WorkbenchDraftFormat, WorkbenchDraft>>;
  production?: WorkbenchProduction;
  /** Sample data; removed by `clear_samples`. */
  sample?: boolean;
  /** Imported from a social account (`<platform>:<postId>`). */
  imported?: boolean;
  externalId?: string;

  // ── Library (Resurf) ──────────────────────────────────────────────
  starred?: boolean;
  spaceId?: string | null;
  /** Set when the item leaves the Inbox (assigned to a space by the user or by AI organise, or kept). Null/absent = in Inbox. */
  triagedAt?: string | null;
  /** Soft delete. Trashed items are hidden everywhere except Trash. */
  trashedAt?: string | null;
  /** AI summary (≤ 280 chars). */
  summary?: string;
  /** AI keywords (images and links). */
  keywords?: string[];
  /** Text recognised inside an image. */
  ocrText?: string;
  /** Estimated read time in minutes for web/pdf/note. */
  readMinutes?: number;
  reader?: WorkbenchReader;
  highlights?: WorkbenchHighlight[];
  organizedAt?: string;
  lastSurfacedAt?: string;
  surfacedCount?: number;
}

export interface WorkbenchSpace {
  id: string;
  name: string;
  color: WorkbenchSpaceColor;
  createdAt: string;
  sample?: boolean;
}

export interface WorkbenchPerson { id: string; name: string; role: string; note: string; traits: string[]; tone: number; createdAt?: string; sample?: boolean }
export interface WorkbenchAngle { id: string; name: string; hook: string; prompt: string; createdAt?: string; sample?: boolean }

export interface WorkbenchStyle {
  id: string;
  name: string;
  icon?: string;
  /** Preset board (科技数码, 旅行探店, …) for built-in presets. */
  board?: string;
  preset?: boolean;
  summary: string;
  tone: string;
  sentences: string;
  opening: string;
  structure: string;
  logic: string;
  story: string;
  flow: string;
  words: string[];
  avoid: string[];
  samples: string[];
  reference?: string;
  source?: string;
  sourceUrls?: string[];
  accountKey?: string;
  createdAt?: string;
  sample?: boolean;
}

export interface WorkbenchSkill {
  id: string;
  name: string;
  rule: string;
  source: string;
  status: 'proposed' | 'active' | 'exported' | 'dismissed' | string;
  confidence: number;
  evidence?: string;
  createdAt?: string;
  sample?: boolean;
}

export interface WorkbenchMetric {
  id: string;
  itemId?: string | null;
  platform: WorkbenchPlatform;
  date: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  externalId?: string;
  fetchedAt?: string;
  sample?: boolean;
}

export interface WorkbenchAccount {
  id: string;
  platform: string;
  handle: string;
  url: string | null;
  followers: number | null;
  note?: string;
  title?: string;
  description?: string;
  avatar?: string | null;
  fetchedAt?: string | null;
  fetchError?: string | null;
  externalId?: string;
  createdAt?: string;
  sample?: boolean;
}

export interface WorkbenchReceipt { text: string; target?: string; kind?: string }

export interface WorkbenchChatMessage {
  id: string;
  at: string;
  role: 'user' | 'assistant';
  text: string;
  /** Item the conversation is focused on (studio); absent = desk-wide / library assistant. */
  itemId?: string;
  receipts?: WorkbenchReceipt[];
  errors?: string[];
  engine?: string;
  notice?: string | null;
  undoable?: boolean;
  /** Library items the assistant cited (library Q&A). */
  citations?: string[];
}

export interface WorkbenchState {
  version: number;
  sampleCleared: boolean;
  sampleLang: 'zh' | 'en';
  items: WorkbenchItem[];
  spaces: WorkbenchSpace[];
  people: WorkbenchPerson[];
  angles: WorkbenchAngle[];
  skills: WorkbenchSkill[];
  accounts: WorkbenchAccount[];
  metrics: WorkbenchMetric[];
  styles: WorkbenchStyle[];
  presetVersion?: number;
  activeStyleId: string | null;
  draftFormat?: WorkbenchDraftFormat;
  chat: WorkbenchChatMessage[];
}

// ── Ops: the single write path for UI and assistant ─────────────────

export const WORKBENCH_OPS = [
  // ideas / content
  'add_item', 'update_item', 'delete_item', 'schedule_item', 'set_status', 'save_draft', 'update_production',
  // people, angles, styles, rules, data, accounts
  'add_person', 'update_person', 'delete_person', 'add_angle', 'update_angle', 'delete_angle',
  'add_style', 'update_style', 'delete_style', 'set_style', 'set_format',
  'add_skill', 'update_skill', 'delete_skill', 'add_metric', 'add_account', 'update_account', 'delete_account',
  'clear_samples',
  // library (Resurf)
  'star_items', 'move_to_space', 'keep_items', 'trash_items', 'restore_items', 'empty_trash',
  'add_space', 'update_space', 'delete_space', 'rename_tag', 'delete_tag', 'tag_items',
  'add_highlight', 'delete_highlight', 'mark_surfaced',
] as const;
export type WorkbenchOpName = (typeof WORKBENCH_OPS)[number];

/**
 * One op. Fields beyond `op` follow the daemon whitelist; unknown fields are dropped.
 * Library op shapes:
 * - `star_items { ids, starred }`
 * - `move_to_space { ids, spaceId | null }` (also triages)
 * - `keep_items { ids }` (leave Inbox without a space)
 * - `trash_items { ids }`, `restore_items { ids }`, `empty_trash {}` (permanent)
 * - `add_space { name, color? }`, `update_space { id, name?, color? }`, `delete_space { id }` (items keep living in Library)
 * - `rename_tag { from, to }`, `delete_tag { tag }`, `tag_items { ids, add?: string[], remove?: string[] }`
 * - `add_highlight { id, text, note? }`, `delete_highlight { id, highlightId }`
 * - `mark_surfaced { ids }`
 * `delete_item { id }` is permanent; normal UI deletion uses `trash_items`.
 */
export type WorkbenchOp = { op: WorkbenchOpName } & Record<string, unknown>;

// ── Settings ────────────────────────────────────────────────────────

export interface WorkbenchSettings {
  /** TokenToSea chat model id for writing/assistant; '' = first usable. */
  textModel: string;
  /** TokenToSea image model id; '' = first usable. */
  imageModel: string;
  /** Aspect ratio sent to the image model for covers/figures. */
  imageAspect: '1:1' | '3:2' | '2:3';
  /** Extra writing requirements appended to every article prompt. */
  voice: string;
  /** Folder where 保存 writes a production; '' = default (~/Documents/Fantay 工作台). */
  exportDir: string;
  generateImages: boolean;
  /** Figures per production, 0–4. */
  imageCount: number;
  /** Storyboard shots per production, 0–12. */
  shotCount: number;
  language: WorkbenchLanguage;
  /** Run AI auto-organise (title, tags, space, summary) on new captures. */
  autoOrganize: boolean;
}

export interface WorkbenchPublicSettings extends WorkbenchSettings {
  defaultExportDir: string;
  signedIn: boolean;
  /** A TokenToSea image model is available for this account. */
  imageReady: boolean;
  /** Labels of the models that will actually run. */
  textModelLabel: string | null;
  imageModelLabel: string | null;
}

export type WorkbenchSettingsPatch = Partial<WorkbenchSettings>;

export interface WorkbenchModelOption { id: string; name: string; provider?: string }
export interface WorkbenchModelsResponse {
  signedIn: boolean;
  text: WorkbenchModelOption[];
  image: WorkbenchModelOption[];
}

// ── Responses ───────────────────────────────────────────────────────

export interface WorkbenchStateResponse {
  state: WorkbenchState;
  signedIn: boolean;
  /** Label of the text model in use, null when none. */
  model: string | null;
  modelOk: boolean | null;
  modelError: string | null;
  canUndo: boolean;
  undoLabel?: string | null;
}

export interface WorkbenchOpsRequest { ops: WorkbenchOp[]; label?: string; undoable?: boolean }
export interface WorkbenchOpsResponse { receipts: WorkbenchReceipt[]; errors: string[]; state: WorkbenchState; canUndo: boolean }

export interface WorkbenchUndoResponse { label: string | null; state: WorkbenchState; canUndo: boolean }

export type WorkbenchChatAction =
  | { type: 'produce'; id: string }
  | { type: 'open'; id: string }
  | { type: 'nav'; page: WorkbenchPage };

export interface WorkbenchChatRequest { message: string; focusId?: string }
export interface WorkbenchChatResponse {
  answer: WorkbenchChatMessage;
  actions: WorkbenchChatAction[];
  state: WorkbenchState;
  modelOk: boolean | null;
  modelError: string | null;
  canUndo: boolean;
}

export interface WorkbenchProduceRequest { id: string; withImages?: boolean }
export interface WorkbenchProduceResponse { started: boolean; state: WorkbenchState }
export interface WorkbenchProductionResponse {
  production: WorkbenchProduction | null;
  status?: WorkbenchStatus;
  live: WorkbenchProductionLive | null;
}
export interface WorkbenchRegenRequest { id: string; target: WorkbenchAssetTarget }
export interface WorkbenchSaveRequest { id: string; /** Browser-composited JPEG data URL of the video cover. */ videoCover?: string }
export interface WorkbenchSaveResponse { path: string; files: string[]; state: WorkbenchState }

export interface WorkbenchStyleExtractRequest { text?: string; urls?: string[]; name?: string }
export interface WorkbenchStyleExtractResponse { id: string; failures: string[]; state: WorkbenchState }

export interface WorkbenchSocialStatus {
  signedIn: boolean;
  /** TokenToSea 社媒数据 tool is reachable for this account. */
  available: boolean;
  platforms: WorkbenchImportPlatform[];
  /** Approximate cost per import, USD. */
  estimatedUsd: Partial<Record<WorkbenchImportPlatform, string>>;
  reason?: string;
}
export interface WorkbenchSocialImportRequest { text: string }
export interface WorkbenchSocialImportResponse {
  platform: WorkbenchImportPlatform;
  nickname: string;
  count: number;
  added: number;
  /** TokenToSea charge, USD string. */
  chargedUsd: string;
  styleName: string | null;
  styleError: string | null;
  state: WorkbenchState;
}

export interface WorkbenchCaptureUrlRequest { url: string; title?: string; note?: string; tags?: string[]; spaceId?: string | null }
export interface WorkbenchCaptureResponse { receipts: WorkbenchReceipt[]; errors: string[]; id?: string; state: WorkbenchState }

export interface WorkbenchUploadResponse { src: string; kind: Extract<WorkbenchKind, 'image' | 'video' | 'pdf' | 'audio'>; mime: string; bytes: number }

export interface WorkbenchOrganizeRequest { ids: string[] }
export interface WorkbenchOrganizeResponse { organized: string[]; errors: string[]; state: WorkbenchState }

export interface WorkbenchReaderRequest { id: string }
export interface WorkbenchReaderResponse { reader: WorkbenchReader; state: WorkbenchState }

export type WorkbenchSearchMode = 'text' | 'meaning';
export interface WorkbenchSearchHit { id: string; score: number; /** Matched excerpt with the query context. */ excerpt?: string }
export interface WorkbenchSearchResponse { mode: WorkbenchSearchMode; hits: WorkbenchSearchHit[] }

export interface WorkbenchInsights {
  views: number;
  engaged: number;
  engagementRate: number;
  published: number;
  followers: number;
  daily: Array<{ date: string; views: number; engaged: number }>;
  platforms: Array<{ platform: string; views: number; engaged: number; likes: number; comments: number; shares: number; saves: number }>;
  top: Array<{ id: string; title: string; platform?: string | null; views: number; likes: number; comments: number; shares: number; saves: number; engaged: number }>;
  hasSample: boolean;
}

export interface WorkbenchSkillsLearnResponse { added: number; state: WorkbenchState }
export interface WorkbenchSkillsExportResponse { name: string; path: string; rules: number; slug: string; state: WorkbenchState }

export interface WorkbenchSettingsTestResponse { src: string }

// ── Client navigation ───────────────────────────────────────────────

/** Workbench pages, also the `/workbench/<page>` URL segment. */
export const WORKBENCH_PAGES = ['inspiration', 'content', 'schedule', 'insights', 'style'] as const;
export type WorkbenchPage = (typeof WORKBENCH_PAGES)[number];

/** Resolve a stored media `src` to a URL the renderer can load. */
export function workbenchMediaUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  if (/^workbench\/(?:files|assets)\/[\w.-]+$/.test(src)) return `/api/${src}`;
  return null;
}
