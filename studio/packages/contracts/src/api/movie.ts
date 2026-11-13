/** Fantay Movie Studio: persistent, engine-independent editing document. */
import {
  MOVIE_VISUALS,
  type MovieVisual,
  type MovieStyleAsset,
  type MovieStyleReference,
  type MovieKeyframe,
} from "./movie-visual.js";
import { MOVIE_SAMPLES } from "./movie-samples.js";
import type { HtmlRenderer } from './media-generate.js';
export { MOVIE_SAMPLES, MOVIE_SAMPLE_MEDIA } from "./movie-samples.js";
export * from "./movie-visual.js";
/** The project file that holds a project's Movie Studio document (one film per project). */
export const MOVIE_DOCUMENT_FILE = "movie-studio.json" as const;
export const MOVIE_MAX_CLIPS = 1000;
export const MOVIE_MAX_DURATION = 14400;
export interface MovieSettings {
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
}
/** A render-only output profile; it never changes the editable project canvas. */
export interface MovieExportOptions extends MovieSettings {
  format: 'mp4' | 'mov';
}
export const movieFps = (doc: { settings?: MovieSettings }): number =>
  doc.settings ? doc.settings.frameRate.numerator / doc.settings.frameRate.denominator : 30;
export function movieFrameSize(doc: { aspect: string; settings?: MovieSettings }): { width: number; height: number } {
  return doc.settings ? { width: doc.settings.width, height: doc.settings.height } :
    doc.aspect === "9:16" ? { width: 1080, height: 1920 } : doc.aspect === "1:1" ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 };
}
export type MovieStartMode = "library" | "remix" | "personal" | "blank";
export type MoviePreviewRendererKind = "browser" | "desktop";
export interface MoviePreviewAvailability {
  available: boolean;
  renderer: MoviePreviewRendererKind | null;
}
export type MovieStage =
  | "style"
  | "storyboard"
  | "samples"
  | "render"
  | "review"
  | "deliver";
export type MovieLayout = "title" | "statement" | "metric" | "split";
export interface MovieCaption {
  /** Stable identity for localized edits; assigned to legacy cues on read. */
  id?: string;
  start: number;
  end: number;
  text: string;
}
export interface MovieCaptionStyle { fontSize:number;color:string;background:string;backgroundOpacity:number;y:number;outline:number;align:'left'|'center'|'right' }
export interface MovieStyle {
  id: string;
  name: string;
  description: string;
  background: string;
  foreground: string;
  accent: string;
  font: "sans" | "serif" | "mono";
  motion: "rise" | "slide" | "scale";
  source?: string;
  visual?: MovieVisual;
  assets?: MovieStyleAsset[];
  references?: MovieStyleReference[];
  designSystem?: { id: string; tokenFile: string; digest: string };
  typeface?: string;
  sourceProjectId?: string;
  demoShots?: MovieShot[];
  aspect?: "16:9" | "9:16" | "1:1";
  snapshotKey?: string;
}
export interface MovieShot {
  id: string;
  kind?: "text";
  locked?: boolean;
  textAnimation?: 'none'|'fade'|'rise'|'slide'|'typewriter';
  captionStyle?: MovieCaptionStyle;
  title: string;
  body: string;
  direction?: string;
  duration: number;
  layout: MovieLayout;
  /** Absolute timeline placement. Omitted on legacy sequential projects. Higher tracks render above lower tracks. */
  placement?: { start: number; track: number };
  /** Optional project-relative image or video, including AI-generated assets. */
  media?: string;
  /** A cut from an imported video asset. duration is output time, not source time. */
  clip?: {
    assetId: string;
    in: number;
    rate: number;
    volume: number;
    fit: "cover" | "contain";
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    opacity?: number;
    audioOnly?: boolean;
    muted?: boolean;
    fadeIn?: number;
    fadeOut?: number;
    audioFadeIn?: number;
    audioFadeOut?: number;
    rotation?: number;
    crop?: { top: number; right: number; bottom: number; left: number };
    color?: { exposure: number; contrast: number; saturation: number; blur: number; grayscale: number };
    keyframes?: Array<Pick<MovieKeyframe, 'at' | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity'>>;
  };
  captions?: MovieCaption[];
  visual?: MovieVisual;
}
export interface MovieVideoSource {
  assetId: string;
  path: string;
  previewPath?: string;
  label: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  kind?: "video" | "audio" | "image";
  /** Peaks decoded from this source's audio, cached with the source content. */
  audioPeaks?: number[];
  frames: Array<{ time: number; path: string }>;
  transcript?: Array<{ start: number; end: number; text: string }>;
}
export interface MovieRender {
  exportOptions?: MovieExportOptions;
  id: string;
  contentRevision: number;
  status: "running" | "done" | "failed";
  createdAt: string;
  sourcePath: string;
  file?: string;
  error?: string;
  progress?: string;
  duration?: number;
  assets?: string[];
  htmlRenderer?: HtmlRenderer;
  rendererNote?: string;
}
export type MovieNoteScope = "time" | "range" | "film" | "shot";
export interface MovieNoteTarget {
  scope: MovieNoteScope;
  renderId?: string;
  time: number;
  endTime?: number;
  shotId?: string;
  contentRevision?: number;
}
export interface MovieReviewNote {
  id: string;
  renderId?: string;
  scope?: MovieNoteScope;
  time: number;
  endTime?: number;
  shotId?: string;
  shotTitle?: string;
  contentRevision?: number;
  createdAt?: string;
  submittedBatchId?: string;
  addressedRenderId?: string;
  resolvedInRenderId?: string;
  text: string;
  resolved: boolean;
}
export interface MovieReviewBatch {
  id: string;
  productionId: string;
  createdAt: string;
  sourceRenderId?: string;
  sourceContentRevision: number;
  notes: MovieReviewNote[];
  status: "submitted" | "rendering" | "ready" | "failed";
  renderId?: string;
  error?: string;
}
export interface MovieReviewAssets {
  renderId: string;
  duration: number;
  fps: number;
  thumbnailFile: string;
  thumbnailCount: number;
  audio: "none" | "silent" | "present";
  peaks: number[];
  shots: Array<Pick<MovieShot, "id" | "title" | "duration">>;
}
export interface MovieDocument {
  schemaVersion: 1;
  revision: number;
  contentRevision: number;
  title: string;
  brief: string;
  startMode: MovieStartMode;
  aspect: "16:9" | "9:16" | "1:1";
  settings?: MovieSettings;
  editorMigration?: { version: 1 | 2; sourceDigest: string; migratedAt: string; warnings: string[] };
  style: MovieStyle;
  shots: MovieShot[];
  savedStyles: MovieStyle[];
  storyboardApproved: number | null;
  samplesApproved: number | null;
  renders: MovieRender[];
  notes: MovieReviewNote[];
  reviewBatch?: MovieReviewBatch;
  approvedRenderId: string | null;
  delivery: { renderId: string; createdAt: string; files: string[] } | null;
  updatedAt: string;
  authored?: boolean;
  editHistory?: {
    undoCount: number;
    redoCount: number;
    undoLabel?: string;
    redoLabel?: string;
    blocked?: boolean;
  };
  lastEdit?: MovieEditReceipt;
  stylePreview?: {
    contentRevision: number;
    assetDigest: string;
    frames: string[];
    times: number[];
    shotIds?: string[];
  } | null;
  production?: {
    id: string;
    status:
      | "armed"
      | "preparing"
      | "rendering"
      | "done"
      | "failed"
      | "cancelled";
    createdAt: string;
    baselineContentRevision: number;
    contentRevision?: number;
    renderId?: string;
    message?: string;
    frames?: string[];
    reviewBatchId?: string;
  };
}
export interface MovieSaveRequest {
  expectedRevision: number;
  document: Pick<
    MovieDocument,
    "title" | "brief" | "startMode" | "aspect" | "style" | "shots" | "settings"
  >;
}
export interface MovieAuthorRequest {
  expectedRevision: number;
  style?: Partial<
    Pick<
      MovieStyle,
      | "name"
      | "description"
      | "background"
      | "foreground"
      | "accent"
      | "font"
      | "motion"
      | "visual"
    >
  >;
  shots?: { mode: "replace" | "upsert"; items: MovieShot[] };
}
export type MovieEditOperation =
  | { op: 'lock-clip'; shotId: string; locked: boolean }
  | { op: "insert-text"; text: string; at: number; duration: number; track: number; newShotId?: string }
  | { op: "move-clip"; shotId: string; at: number; track: number }
  | { op: "duplicate-clip"; shotId: string; at?: number; track?: number; newShotId?: string }
  | { op: "split-clip"; shotId: string; at: number; newShotId?: string }
  | { op: "trim-clip"; shotId: string; start: number; end: number }
  | { op: "move-shot"; shotId: string; index: number }
  | { op: "remove-shot"; shotId: string; ripple?: boolean }
  | { op: "insert-clip"; assetId: string; index: number; in?: number; duration?: number; newShotId?: string }
  | {
      op: "update-shot";
      shotId: string;
      changes: Partial<
        Pick<MovieShot, "title" | "body" | "direction" | "duration" | "layout" | "visual" | "captionStyle" | "textAnimation">
      >;
    }
  | {
      op: "update-clip";
      shotId: string;
      changes: Partial<NonNullable<MovieShot["clip"]>>;
    }
  | {
      op: "update-caption";
      shotId: string;
      captionId: string;
      changes: Partial<Pick<MovieCaption, "start" | "end" | "text">>;
    }
  | { op: "add-caption"; shotId: string; caption: MovieCaption }
  | { op: "remove-caption"; shotId: string; captionId: string }
  | { op: "replace-captions"; shotId: string; captions: MovieCaption[] };
export interface MovieEditRequest {
  expectedRevision: number;
  label?: string;
  operations: MovieEditOperation[];
}
export interface MovieEditChange {
  shotId?: string;
  shotTitle?: string;
  captionId?: string;
  field: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}
export interface MovieEditReceipt {
  id: string;
  label: string;
  action: "edit" | "undo" | "redo";
  createdAt: string;
  fromRevision: number;
  revision: number;
  contentRevision: number;
  changedShotIds: string[];
  changes: MovieEditChange[];
  truncated: boolean;
  historyRecorded: boolean;
}
export interface MovieEditResponse {
  document: MovieDocument;
  receipt: MovieEditReceipt;
}
export type MovieAction =
  | {
      action:
        | "approve-storyboard"
        | "approve-samples"
        | "save-style"
        | "approve-review"
        | "deliver";
    }
  | { action: 'render' | 'render-preview'; htmlRenderer?: HtmlRenderer; exportOptions?: MovieExportOptions }
  | {
      action: "add-note";
      renderId?: string;
      scope?: MovieNoteScope;
      time: number;
      endTime?: number;
      shotId?: string;
      contentRevision?: number;
      text: string;
    }
  | { action: "resolve-note"; noteId: string; renderId?: string };
export const MOVIE_STYLES: readonly MovieStyle[] = [
  {
    id: "fantay",
    name: "Fantay 原生",
    description: "墨色、留白与一抹荧光绿。让想法清楚地发生。",
    background: "#f5f5f2",
    foreground: "#202020",
    accent: "#87ea5c",
    font: "sans",
    motion: "rise",
    visual: MOVIE_VISUALS.fantay!,
  },
  {
    id: "editorial",
    name: "纸上电影",
    description: "暖纸底色、衬线标题，像翻开一本会动的杂志。",
    background: "#eee8dc",
    foreground: "#2b302e",
    accent: "#b55039",
    font: "serif",
    motion: "slide",
    visual: MOVIE_VISUALS.editorial!,
  },
  {
    id: "signal",
    name: "信号现场",
    description: "黑白高对比与明黄色，适合数据、观点和发布。",
    background: "#181818",
    foreground: "#faf9f4",
    accent: "#f4de49",
    font: "sans",
    motion: "slide",
    visual: MOVIE_VISUALS.signal!,
  },
  {
    id: "blueprint",
    name: "蓝图叙事",
    description: "冷静的蓝与等宽文字，把复杂过程拆开讲清。",
    background: "#182b43",
    foreground: "#f0f5f8",
    accent: "#92cbf3",
    font: "mono",
    motion: "rise",
    visual: MOVIE_VISUALS.blueprint!,
  },
  {
    id: "soft",
    name: "柔软片刻",
    description: "低饱和的粉和深紫，留给生活与温柔的故事。",
    background: "#f4e7e6",
    foreground: "#503e53",
    accent: "#b5bfe1",
    font: "serif",
    motion: "scale",
    visual: MOVIE_VISUALS.soft!,
  },
  {
    id: "minimal",
    name: "纯粹字幕",
    description: "纯白与墨黑，只留下文字、节奏和呼吸。",
    background: "#ffffff",
    foreground: "#171717",
    accent: "#d9d9d9",
    font: "sans",
    motion: "rise",
    visual: MOVIE_VISUALS.minimal!,
  },
  {
    id: "collage",
    name: "纸片拼贴",
    description: "倾斜纸片、素材切片与错层移动，让图像参与叙事。",
    background: "#f3e9d5",
    foreground: "#242a28",
    accent: "#dd784f",
    font: "sans",
    motion: "slide",
    visual: MOVIE_VISUALS.collage!,
  },
  {
    id: "gallery",
    name: "影像手记",
    description: "满幅影像、留白字幕与缓慢推镜，适合作品集和品牌故事。",
    background: "#f2f0e9",
    foreground: "#202421",
    accent: "#547c69",
    font: "serif",
    motion: "scale",
    visual: MOVIE_VISUALS.gallery!,
  },
  ...MOVIE_SAMPLES,
];
export function createMovieDocument(
  title = "我的第一部短片",
  startMode: MovieStartMode = "library",
  style: MovieStyle = MOVIE_STYLES[0]!,
): MovieDocument {
  return {
    schemaVersion: 1,
    revision: 0,
    contentRevision: 1,
    title,
    brief: "",
    startMode,
    ...(startMode === "blank" ? { authored: true } : {}),
    aspect: startMode === "blank" ? "16:9" : (style.aspect ?? "16:9"),
    style:
      startMode === "blank"
        ? {
            id: "blank",
            name: "未定风格",
            description: "由故事决定画面与运动。",
            background: "#f5f4ef",
            foreground: "#202020",
            accent: "#87ea5c",
            font: "sans",
            motion: "rise",
            visual: {
              composition: "custom",
              copy: {
                x: 8,
                y: 83,
                width: 84,
                align: "left",
                titleSize: 3,
                bodySize: 1.3,
              },
              layers: [],
              transition: "fade",
              copyMode: "caption",
            },
          }
        : (JSON.parse(JSON.stringify(style)) as MovieStyle),
    shots:
      startMode === "blank"
        ? []
        : style.demoShots
          ? (JSON.parse(JSON.stringify(style.demoShots)) as MovieShot[])
          : [
              {
                id: "opening",
                title: "让想法\n动起来。",
                body: "从一个念头，到一部作品。",
                duration: 4,
                layout: "title",
              },
              {
                id: "story",
                title: "每一帧，\n都有你的风格。",
                body: "把文字、图像和节奏，编织成一个故事。",
                duration: 5,
                layout: "split",
              },
              {
                id: "closing",
                title: "现在，开拍。",
                body: "Created with Fantay",
                duration: 3,
                layout: "statement",
              },
            ],
    savedStyles: [],
    storyboardApproved: null,
    samplesApproved: null,
    renders: [],
    notes: [],
    approvedRenderId: null,
    delivery: null,
    updatedAt: new Date().toISOString(),
  };
}
export function movieDuration(doc: Pick<MovieDocument, "shots">): number {
  const starts = movieShotStarts(doc);
  return Math.max(0, ...doc.shots.map((shot, i) => starts[i]! + shot.duration));
}
export function movieShotStarts(doc: Pick<MovieDocument, "shots">): number[] {
  let cursor = 0;
  return doc.shots.map(shot => { const start = shot.placement?.start ?? cursor; cursor = start + shot.duration; return start; });
}
export function movieAssetPaths(doc: MovieDocument): string[] {
  return [
    ...new Set([
      ...doc.shots.flatMap((shot) => (shot.media ? [shot.media] : [])),
      ...(doc.style.assets ?? []).map((asset) => asset.path),
      ...(doc.style.demoShots ?? []).flatMap((shot) =>
        shot.media ? [shot.media] : [],
      ),
    ]),
  ];
}
export function movieCurrentRender(
  doc: MovieDocument,
): MovieRender | undefined {
  return [...doc.renders]
    .reverse()
    .find(
      (r) => r.status === "done" && r.contentRevision === doc.contentRevision,
    );
}

export type MovieAssistTask =
  | "storyboard"
  | "refine-style"
  | "revise"
  | "produce";
export function movieAssistPrompt(
  doc: MovieDocument,
  task: MovieAssistTask,
  language = "zh",
): string {
  const zh = language.startsWith("zh");
  const brief = doc.brief.trim() || doc.title;
  if (task === "revise") {
    const batch = doc.reviewBatch;
    const notes = (batch?.notes ?? doc.notes.filter((n) => !n.resolved))
      .map(
        (n) =>
          `[${n.id}] ${n.scope === "film" ? "整片" : n.scope === "shot" ? `镜头 ${n.shotId}` : n.scope === "range" ? `${n.time.toFixed(2)}–${n.endTime?.toFixed(2)}s` : `${n.time.toFixed(2)}s`}（${n.renderId ? `来源成片 ${n.renderId}` : `分镜版本 ${n.contentRevision}`}）：${n.text}`,
      )
      .join("\n");
    const authorized =
      batch &&
      doc.production?.reviewBatchId === batch.id &&
      doc.production.status === "armed";
    return zh
      ? `请按已提交的修改意见修订《${doc.title}》。先读当前影片，只处理下列意见，保留未涉及的镜头、风格、素材和关键帧，不要重新创作整片。意见已冻结到批次 ${batch?.id ?? "manual"}：\n${notes}\n优先使用 fantay_movie_edit 做局部修改：update-shot 改标题/时长，update-caption 根据已有 captionId 改字幕文字与时间，replace-captions 仅替换指定镜头的字幕数组，update-clip 改源片入点/速度/音量。它保留其他字段并返回修改清单；不要为改一句字幕重写整镜头。只有修改画面图层才使用 author upsert。保存后${authorized ? "用户已授权本次修改并生成下一版；调用 fantay_movie_produce，再用 fantay_movie_wait 等待真实新 MP4。" : "停下供用户检查，不要自行渲染。"}不要自行标记审片通过或解决意见；新版本生成后由用户确认。`
      : `Revise “${doc.title}” against this frozen feedback batch ${batch?.id ?? "manual"}:\n${notes}\nRead the current film and change only the affected shots. Preserve unrelated artwork, assets and motion. ${authorized ? "The user authorized this revision and next MP4: save, produce, then wait for the real result." : "Save and stop for review."} Never approve final review or resolve feedback yourself.`;
  }
  if (doc.style.assets?.some((a) => /\.(mp4|mov|webm)$/i.test(a.path))) {
    return `你是这部实拍短片的剪辑师。影片《${doc.title}》，要求：${brief}。先调用 fantay_movie_sources 取得已选视频的时长、音轨、真实缩略图和可用转写，用 read_image 查看代表帧，不能猜画面或原话。用 fantay_movie_author 创建有叙事顺序的剪辑：每镜 clip={assetId,in,rate,volume,fit}，duration 是成片秒数，源出点=in+duration*rate，不得越界。画面全屏，按动作挑选不同入点，必要时倍速；用 visual 图层/关键帧制作贴合画面的标题、标注和转场，不得用纯图形动画替代已选视频。字幕用 captions=[{start,end,text}]（镜头内秒数），不要把全部文案堆在画面上。要求转写原话时调用 fantay_movie_transcribe，依据真实转写裁切与调速后对齐；解说或氛围文案可自行撰写，但不要声称是原话。先完成全部镜头，再预览检查字幕/构图/衔接。${task === "produce" ? "用户已授权本次生成，最后调用 fantay_movie_produce 并用 fantay_movie_wait 等待真实 MP4。" : "完成后停在方案页供用户检查。"}不得自行批准最终审片或交付。`;
  }
  const original =
    doc.startMode === "blank" ||
    doc.startMode === "remix" ||
    !doc.shots.length ||
    task === "refine-style";
  if (original) {
    const ending =
      task === "produce"
        ? zh
          ? "用户已点击生成影片并授权本次出片。保存风格后，调用 fantay_movie_produce，再用 fantay_movie_wait 等待真实 MP4。"
          : "The user authorized this production. After saving the style, produce and wait for the actual MP4."
        : zh
          ? "完成后停在预览与已保存风格，不要开始出片。"
          : "Stop after previewing and saving the style; do not start production.";
    return zh
      ? `请从创作想法独立导演《${doc.title}》：${brief}\n先读 fantay_movie_get 和 fantay_movie_guide。不要选择或复制内置样片，也不要只改文案、排版或贴图。画面要有实心主体、明暗层次、接触阴影和前中后景，避免线框示意图、空白开场、文字配圆圈。用群组保持多部件运动一致，用主物体的位置、动作或形状把镜头接起来，不要每镜淡到空白。自行决定镜头数量、事件、构图、图形、关键帧和镜头运动；每镜用 direction 讲清楚可见动作，画面里的文字保持简短。用 fantay_movie_author 创建原创风格与逐镜 visual：首次 replace，后续可 upsert 单镜，无需重写整份项目。每次使用工具返回的新 revision。先完成整部影片，再集中检查 motion 预览的画面与转场，修复后复核一次并保存风格，避免反复孤立校准。${ending}最终审片与交付始终由用户确认。`
      : `Direct an original editable animation for “${doc.title}”: ${brief}. Read the movie and authoring guide. Invent shot events, composition, geometry, keyframes and camera; do not copy a built-in film or merely replace text/images. Describe visible actions in direction. Use author (replace first, upsert scenes), motion preview, read_image and save_style, always using the latest returned revision. ${ending} Never approve final review or delivery.`;
  }
  if (task === "produce")
    return zh
      ? `用户已在主页点击“生成影片”，授权本次从分镜、样张自动到 MP4。请为《${doc.title}》完成影片：${brief}\n先用 fantay_movie_get 读取影片。已选风格为${doc.style.name}，保留逐镜 visual、keyframes、camera 和素材，不要改成文字卡片或删除图形。使用 fantay_movie_update_story 按现有镜头 id 修改标题、字幕和时长，无需重写完整 JSON，也无需读取风格目录或调用 shell。之后调用 fantay_movie_produce（expectedRevision 用最新值），再用 fantay_movie_wait 等待并报告真实结果。不要自动通过最终审片或交付。`
      : `The user clicked Generate film and authorized this one storyboard-to-MP4 production for “${doc.title}”. Brief: ${brief}. Read with fantay_movie_get. Use fantay_movie_update_story with the existing shot IDs to adapt text/timing while preserving visuals, keyframes, camera and assets. Do not rewrite the full JSON or read the style catalog for this selected animation. Call fantay_movie_produce with the latest expectedRevision, then fantay_movie_wait. Never approve final review or delivery.`;
  return zh
    ? `请为《${doc.title}》生成具体可编辑的分镜。\n创作想法：${brief}\n视觉风格：${doc.style.name}；画幅：${doc.aspect}。\n根据故事合理安排每个镜头的画面文字、说明、时长和布局，写入当前影片，替换示例分镜。先让我看方案和样张，不要自动确认或开始渲染。`
    : `Create a concrete editable storyboard for “${doc.title}”.\nBrief: ${brief}\nStyle: ${doc.style.name}; aspect: ${doc.aspect}. Choose text, captions, durations and layouts, replacing demo shots in this film. Let me review the plan and samples; do not approve or render.`;
}
