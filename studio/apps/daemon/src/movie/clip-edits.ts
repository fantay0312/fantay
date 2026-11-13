import { randomUUID } from "node:crypto";
import { movieDuration, movieShotStarts, MOVIE_MAX_DURATION, sliceMovieClipKeyframes, type MovieShot } from "@open-design/contracts";
import type { EditableMovie } from "./edit-history.js";
import { MovieError, safeMovieAsset } from "./store.js";
import { probeMovieMedia } from "./video-sources.js";

const MIN_CLIP = 1 / 60;
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function position(value: unknown, length: number, append = false): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= length + (append ? 1 : 0))
    throw new MovieError("Choose a valid zero-based timeline index");
  return Number(value);
}
function newId(draft: EditableMovie, value: unknown): string {
  const id = value === undefined ? randomUUID() : value;
  if (typeof id !== "string" || !id.trim() || id.length > 100 || draft.shots.some((s) => s.id === id))
    throw new MovieError("New shot ID must be unique and non-empty");
  return id;
}

/** Crop in output seconds; source offsets use playback rate and captions remain shot-local. */
function slice(shot: MovieShot, start: number, end: number, extend = false): MovieShot {
  if (!finite(start) || !finite(end) || (!extend && (start < 0 || end > shot.duration + 1e-9)) || end - start < MIN_CLIP - 1e-9)
    throw new MovieError("Keep at least one frame inside the selected clip");
  const next = structuredClone(shot);
  next.duration = end - start;
  if (next.clip) {
    next.clip.in += start * next.clip.rate;
    if (shot.clip?.keyframes?.length) {
      const keyframes = sliceMovieClipKeyframes(shot.clip, start, end, shot.duration);
      if (keyframes) next.clip.keyframes = keyframes;
      else delete next.clip.keyframes;
    }
    for (const key of ['fadeIn', 'audioFadeIn'] as const) if (next.clip[key] !== undefined)
      next.clip[key] = Math.max(0, Math.min(end, next.clip[key]!) - Math.max(0, start));
    for (const key of ['fadeOut', 'audioFadeOut'] as const) if (next.clip[key] !== undefined)
      next.clip[key] = Math.max(0, end - Math.max(start, shot.duration - next.clip[key]!));
  }
  if (next.captions) next.captions = next.captions
    .filter((c) => c.end > start && c.start < end)
    .map((c) => ({ ...c, start: Math.max(c.start, start) - start, end: Math.min(c.end, end) - start }));
  return next;
}

/** Structural timeline edits share the atomic revision and undo transaction with parameter edits. */
export async function editClipStructure(dir: string, draft: EditableMovie, op: Record<string, unknown>): Promise<string[] | null> {
  if (!["lock-clip", "insert-text", "insert-clip", "split-clip", "trim-clip", "move-shot", "remove-shot", "move-clip", "duplicate-clip"].includes(String(op.op))) return null;
  const fields: Record<string, string[]> = {
    "lock-clip": ["op","shotId","locked"],
    "insert-text": ["op", "text", "at", "duration", "track", "newShotId"],
    "insert-clip": ["op", "assetId", "index", "in", "duration", "newShotId"],
    "split-clip": ["op", "shotId", "at", "newShotId"],
    "trim-clip": ["op", "shotId", "start", "end"],
    "move-shot": ["op", "shotId", "index"],
    "remove-shot": ["op", "shotId", "ripple"],
    "move-clip": ["op", "shotId", "at", "track"],
    "duplicate-clip": ["op", "shotId", "at", "track", "newShotId"],
  };
  if (Object.keys(op).some((key) => !fields[String(op.op)]!.includes(key))) throw new MovieError("Unknown timeline edit field");
  if (op.op === "insert-text") {
    if (typeof op.text !== "string" || !op.text.trim() || !finite(op.at) || op.at < 0 || !finite(op.duration) || op.duration < MIN_CLIP || !Number.isInteger(op.track) || Number(op.track) < 0 || Number(op.track) > 7)
      throw new MovieError("Choose text, duration, position and a track from 0 to 7");
    const starts = movieShotStarts(draft);
    draft.shots.forEach((s, i) => { s.placement ??= { start: starts[i]!, track: 0 }; });
    const id = newId(draft, op.newShotId);
    draft.shots.push({ id, kind: "text", title: op.text, body: "", layout: "title", duration: op.duration,
      placement: { start: op.at, track: Number(op.track) },
      visual: { composition: "minimal", copy: { x: 10, y: 78, width: 80, align: "center", titleSize: 3.5, bodySize: 2 }, layers: [], transition: "cut", copyMode: "caption", foreground: "#FFFFFF" },
    });
    return [id];
  }
  if (op.op === "insert-clip") {
    const index = position(op.index, draft.shots.length, true);
    const id = newId(draft, op.newShotId);
    const asset = draft.style.assets?.find((a) => a.id === op.assetId);
    if (!asset) throw new MovieError("Choose imported media");
    const info = await probeMovieMedia(await safeMovieAsset(dir, asset.path));
    const start = op.in ?? 0;
    const duration = op.duration ?? Math.min(5, info.duration - Number(start));
    if (!finite(start) || start < 0 || !finite(duration) || duration < MIN_CLIP || duration > MOVIE_MAX_DURATION || (info.kind !== "image" && start + duration > info.duration + 0.04))
      throw new MovieError("Clip range exceeds the imported source");
    draft.shots.splice(index, 0, {
      id, title: asset.label || "Video clip", body: "", duration, layout: "split", media: asset.path,
      ...(draft.shots.some(s => s.placement) ? { placement: { start: movieDuration(draft), track: 0 } } : {}),
      clip: { assetId: asset.id, in: start, rate: 1, volume: info.hasAudio ? 1 : 0, fit: "contain", ...(info.kind === "audio" ? { audioOnly: true } : {}) }, captions: [],
      visual: { composition: "minimal", copy: { x: 8, y: 75, width: 84, align: "center", titleSize: 4, bodySize: 2 }, layers: [], transition: "cut", copyMode: "none" },
    });
    return [id];
  }
  const index = draft.shots.findIndex((s) => s.id === op.shotId);
  const shot = draft.shots[index];
  if (!shot) throw new MovieError("Choose an existing shot ID");
  if(op.op==='lock-clip'){if(typeof op.locked!=='boolean')throw new MovieError('locked must be boolean');shot.locked=op.locked;return [];}
  if (op.op === "move-clip" || op.op === "duplicate-clip") {
    const starts = movieShotStarts(draft);
    const at = op.at ?? starts[index]! + shot.duration;
    const track = op.track ?? shot.placement?.track ?? 0;
    if (!finite(at) || at < 0 || at + shot.duration > MOVIE_MAX_DURATION || !Number.isInteger(track) || Number(track) < 0 || Number(track) > 7)
      throw new MovieError("Choose a valid position and a track from 0 to 7");
    // Promote the whole sequence atomically so placing one clip never shifts its neighbours.
    draft.shots.forEach((s, i) => { s.placement ??= { start: starts[i]!, track: 0 }; });
    if (op.op === "duplicate-clip") {
      const copy = structuredClone(shot); copy.id = newId(draft, op.newShotId);
      copy.locked=false;
      copy.placement = { start: at, track: Number(track) };
      draft.shots.push(copy); return [copy.id];
    }
    shot.placement = { start: at, track: Number(track) }; return [shot.id];
  }
  if (op.op === "remove-shot") {
    if(op.ripple!==undefined&&typeof op.ripple!=='boolean')throw new MovieError('ripple must be a boolean');
    if(op.ripple&&shot.placement){const {start,track}=shot.placement;for(const other of draft.shots)if(other.id!==shot.id&&other.placement?.track===track&&other.placement.start>=start+shot.duration-1e-8)other.placement.start=Math.max(0,other.placement.start-shot.duration);}
    draft.shots.splice(index, 1);
    return [];
  }
  if (op.op === "move-shot") {
    const target = position(op.index, draft.shots.length);
    draft.shots.splice(index, 1);
    draft.shots.splice(target, 0, shot);
    return [];
  }
  if (op.op === "trim-clip") {
    const start = op.start as number, end = op.end as number;
    if (shot.clip && (start < 0 || end > shot.duration)) {
      const asset = draft.style.assets?.find(a => a.id === shot.clip!.assetId);
      if (!asset) throw new MovieError("Choose an imported source");
      const info = await probeMovieMedia(await safeMovieAsset(dir,asset.path));
      if (shot.clip.in + start*shot.clip.rate < -1e-9 || (info.kind !== "image" && shot.clip.in + end*shot.clip.rate > info.duration+0.04) || (shot.placement && shot.placement.start+start < 0)) throw new MovieError("Trim exceeds the source or timeline bounds");
    }
    draft.shots[index] = slice(shot, start, end, true);
    if (shot.placement) draft.shots[index]!.placement = { ...shot.placement, start: shot.placement.start + Number(op.start) };
    return [shot.id];
  }
  const id = newId(draft, op.newShotId);
  const left = slice(shot, 0, op.at as number);
  const right = slice(shot, op.at as number, shot.duration);
  right.id = id;
  if (shot.placement) right.placement = { ...shot.placement, start: shot.placement.start + Number(op.at) };
  draft.shots.splice(index, 1, left, right);
  return [shot.id, id];
}
