export type JsonObject = Record<string, unknown>;
export interface Codec {
  decode(raw: Uint8Array): JsonObject;
  encode(value: unknown): Uint8Array;
}
export interface NativeCodec extends Codec { manifest: JsonObject }
export interface KeyframePoint {
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
export interface Transition {
  name: string;
  duration?: number;
}
export interface Fade {
  in?: number;
  out?: number;
}
export interface Mask {
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
export interface Transform {
  x?: number; y?: number; scaleX?: number; scaleY?: number;
  rotation?: number; alpha?: number; flipX?: boolean; flipY?: boolean;
}
export interface TextStyle {
  size?: number; bold?: boolean; italic?: boolean; underline?: boolean;
  color?: [number, number, number]; alpha?: number; align?: 0 | 1 | 2;
  stroke?: { color?: [number, number, number]; width?: number };
}
interface ClipBase { start?: number; duration?: number; track?: number }
export interface VisualClip extends ClipBase {
  type: 'video' | 'image'; path: string; sourceStart?: number; speed?: number;
  volume?: number; transform?: Transform; fadeIn?: number; fadeOut?: number; fade?: Fade;
  keyframes?: KeyframePoint[]; transition?: Transition; mask?: Mask;
}
export interface AudioClip extends ClipBase {
  type: 'audio'; path: string; sourceStart?: number; volume?: number;
  fadeIn?: number; fadeOut?: number; fade?: Fade; keyframes?: KeyframePoint[];
}
export interface TextClip extends ClipBase {
  type: 'text'; text: string; duration: number; style?: TextStyle;
  subtitle?: boolean; transform?: Transform; keyframes?: KeyframePoint[];
}
export type Clip = VisualClip | AudioClip | TextClip;
export interface ProjectSpec {
  name: string; width?: number; height?: number; fps?: number; clips: Clip[];
  srt?: { path: string; offset?: number; track?: number };
}
export type Operation =
  | { op: 'add'; clip: Clip }
  | { op: 'import_srt'; path: string; offset?: number; track?: number }
  | { op: 'move'; segmentId: string; start: number; trackId?: string }
  | { op: 'trim'; segmentId: string; duration: number; sourceStart?: number }
  | { op: 'split'; segmentId: string; at: number }
  | { op: 'delete'; segmentId: string; ripple?: boolean }
  | { op: 'set_speed'; segmentId: string; speed: number }
  | { op: 'set_volume'; segmentId: string; volume: number }
  | { op: 'set_text'; segmentId: string; text: string }
  | { op: 'transform'; segmentId: string; transform: Transform }
  | { op: 'replace_media'; segmentId: string; path: string }
  | { op: 'set_keyframes'; segmentId: string; keyframes: KeyframePoint[] }
  | { op: 'set_transition'; segmentId: string; transition: Transition }
  | { op: 'set_fade'; segmentId: string; fade: Fade }
  | { op: 'relink'; segmentId: string; path: string };
export interface Validation {
  valid: boolean;
  errors: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}
export interface DraftResult {
  draftPath: string; projectId: string; duration: number;
}
export interface LoadedDraft {
  dir: string; data: JsonObject; original: JsonObject; meta: JsonObject;
  documents: Map<string, { value: JsonObject; encrypted: boolean; hash: string }>;
  relative: string; codec?: Codec;
}
export interface DraftInspection {
  path: string; name: string; projectId: string; timelineId: string;
  layout: string; version: string; encoding: 'plaintext' | 'native';
  duration: number; fps: number; canvas: JsonObject;
  tracks: { id: string; type: string; name?: string; attribute?: number;
    segments: { id: string; materialId: string; start: number; duration: number;
      sourceStart: number | null; sourceDuration: number | null; speed: number; volume: number; text?: string }[] }[];
}
export class DraftError extends Error { constructor(code: string, message: string, details?: unknown); code: string; details?: unknown }
export function nativeCodec(): NativeCodec;
export function defaultDraftsRoot(): string;
export function doctor(options?: { app?: string; root?: string }): JsonObject;
export function listDrafts(root?: string): { name: string; path: string }[];
export function parseSrt(text: string, options?: { offset?: number; track?: number }): TextClip[];
export function readDraft(input: string, options?: { codec?: Codec }): LoadedDraft;
export function inspectDraft(input: string, options?: { codec?: Codec }): DraftInspection;
export function validateDraft(input: string, options?: { codec?: Codec; checkMedia?: boolean }): Validation;
export function createDraft(spec: ProjectSpec, options: { output: string }): Promise<DraftResult & { clips: number; encoding: 'plaintext'; nativeVerified: false }>;
export function editDraft(input: string | LoadedDraft, operations: Operation[], options: { output: string; name?: string; codec?: Codec }): Promise<DraftResult & { operations: JsonObject[]; validation: Validation; encoding: 'plaintext' | 'native' }>;
export function installDraft(input: string, options?: { root?: string; name?: string; codec?: Codec }): Promise<DraftResult & { registry: string; registryBackup: string | null }>;
