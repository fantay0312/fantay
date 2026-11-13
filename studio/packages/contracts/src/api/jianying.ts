/** Editable Jianying drafts. Public time values are seconds; edits always create a new copy. */
export interface JianyingTransform {
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  alpha?: number;
  flipX?: boolean;
  flipY?: boolean;
}

export interface JianyingKeyframePoint {
  /** Offset in seconds from clip start (0 <= at <= clip.duration) */
  at: number;
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  volume?: number;
}

export interface JianyingTransition {
  /** Transition name, e.g. "叠化" | "推近" | "闪黑" | "滑动" | "擦除" | "圆形遮罩" */
  name: string;
  /** Transition duration in seconds, defaults to 0.5s, snapped to even frames */
  duration?: number;
}

export interface JianyingFade {
  in?: number;
  out?: number;
}

export interface JianyingMask {
  type?: string;
  name?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  rotation?: number;
  feather?: number;
  invert?: boolean;
  roundCorner?: number;
}

export interface JianyingClip {
  type: 'video' | 'image' | 'audio' | 'text';
  path?: string;
  text?: string;
  start?: number;
  duration?: number;
  sourceStart?: number;
  speed?: number;
  volume?: number;
  track?: number;
  subtitle?: boolean;
  transform?: JianyingTransform;
  fadeIn?: number;
  fadeOut?: number;
  fade?: JianyingFade;
  keyframes?: JianyingKeyframePoint[];
  transition?: JianyingTransition;
  mask?: JianyingMask;
  style?: {
    size?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    color?: [number, number, number];
    alpha?: number;
    align?: 0 | 1 | 2;
    stroke?: { color?: [number, number, number]; width?: number };
  };
}

export interface JianyingProjectSpec {
  name: string;
  width?: number;
  height?: number;
  fps?: number;
  clips: JianyingClip[];
  srt?: { path: string; offset?: number; track?: number };
}

export type JianyingOperation =
  | { op: 'add'; clip: JianyingClip }
  | { op: 'import_srt'; path: string; offset?: number; track?: number }
  | { op: 'move'; segmentId: string; start: number; trackId?: string }
  | { op: 'trim'; segmentId: string; duration: number; sourceStart?: number }
  | { op: 'split'; segmentId: string; at: number }
  | { op: 'delete'; segmentId: string; ripple?: boolean }
  | { op: 'set_speed'; segmentId: string; speed: number }
  | { op: 'set_volume'; segmentId: string; volume: number }
  | { op: 'set_text'; segmentId: string; text: string }
  | { op: 'transform'; segmentId: string; transform: JianyingTransform }
  | { op: 'replace_media'; segmentId: string; path: string }
  | { op: 'set_keyframes'; segmentId: string; keyframes: JianyingKeyframePoint[] }
  | { op: 'set_transition'; segmentId: string; transition: JianyingTransition }
  | { op: 'set_fade'; segmentId: string; fade: JianyingFade }
  | { op: 'relink'; segmentId: string; path: string };
export interface JianyingEnvironment {
  platform: string;
  application: { installed: boolean; path: string | null; version: string | null; build: string | null; bundleId: string | null; running: boolean };
  compatibility: 'verified' | 'known' | 'unverified' | 'not-installed';
  profile: string | null;
  capabilities: { create: boolean; editPlaintext: boolean; editEncrypted: boolean; install: boolean; automaticUpdate: false };
  native: { available: boolean; prepared: boolean; reason: string | null };
  ffprobe: boolean; draftsRoot: string; messages: string[];
}
export interface JianyingDraftEntry { id: string; name: string; origin: 'project' | 'local'; path: string; modifiedAt: string }
export interface JianyingValidation { valid: boolean; errors: { code: string; message: string }[]; warnings: { code: string; message: string }[] }
export interface JianyingInspection {
  path: string; name?: string; projectId: string; timelineId: string; layout: string; version: string;
  encoding: 'plaintext' | 'native'; duration: number; fps: number; canvas: Record<string, unknown>;
  tracks: { id: string; type: string; name?: string; attribute?: number; segments: {
    id: string; materialId: string; start: number; duration: number; sourceStart: number | null;
    sourceDuration: number | null; speed: number; volume: number; text?: string;
  }[] }[];
}
export interface JianyingCreateRequest { source?: 'timeline' | 'plan'; name?: string; expectedRevision?: number; spec?: JianyingProjectSpec; allowUnverified?: boolean }
export interface JianyingEditRequest { draftId: string; name?: string; operations: JianyingOperation[] }
export interface JianyingDraftResult { draft: JianyingDraftEntry; inspection: JianyingInspection; validation: JianyingValidation; warnings: string[]; sourcePreserved: true }
