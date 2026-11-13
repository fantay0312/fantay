import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { mediaPath, US } from './common.js';

export function validateData(data, { dir, checkMedia = false } = {}) {
  const errors = [], warnings = [];
  const error = (code, message) => errors.push({ code, message });
  const materials = new Map(), ids = new Set();
  const addId = (id, label) => {
    if (typeof id !== 'string' || !id) error('MISSING_ID', `${label} has no identifier`);
    else if (ids.has(id)) error('DUPLICATE_ID', `Duplicate identifier ${id}`);
    else ids.add(id);
  };
  if (!data || !Array.isArray(data.tracks) || !data.materials || typeof data.materials !== 'object') return { valid: false, errors: [{ code: 'INVALID_SCHEMA', message: 'tracks[] and materials{} are required' }], warnings };
  if (!(data.fps > 0) || !Number.isFinite(data.fps)) error('INVALID_FPS', 'fps must be finite and positive');
  if (!(data.canvas_config?.width > 0) || !(data.canvas_config?.height > 0)) error('INVALID_CANVAS', 'Canvas dimensions must be positive');
  for (const [bucket, values] of Object.entries(data.materials)) {
    if (!Array.isArray(values)) { warnings.push({ code: 'UNKNOWN_BUCKET', message: `Preserved non-array materials.${bucket}` }); continue; }
    for (const material of values) {
      if (!material || typeof material !== 'object') { error('INVALID_MATERIAL', `Invalid material in ${bucket}`); continue; }
      if (materials.has(material.id) && materials.get(material.id).bucket === bucket &&
          isDeepStrictEqual(material, Object.fromEntries(Object.entries(materials.get(material.id)).filter(([key]) => key !== 'bucket')))) {
        warnings.push({ code: 'IDENTICAL_MATERIAL_COPY', message: `Native serializer repeated material ${material.id}; preserved` });
        continue;
      }
      addId(material.id, `materials.${bucket}`);
      materials.set(material.id, { ...material, bucket });
      if (checkMedia && ['videos', 'images', 'audios'].includes(bucket) && material.path) {
        const file = mediaPath(material.path, dir ?? '.');
        if (!fs.existsSync(file)) error('MISSING_MEDIA', file);
      }
    }
  }
  let end = 0;
  for (const track of data.tracks) {
    addId(track.id, 'track');
    if (!Array.isArray(track.segments)) { error('INVALID_TRACK', 'Track requires segments[]'); continue; }
    const ranges = [];
    for (const segment of track.segments) {
      addId(segment.id, 'segment');
      const target = segment.target_timerange;
      if (!target || !Number.isSafeInteger(target.start ?? 0) || (target.start ?? 0) < 0 || !Number.isSafeInteger(target.duration) || target.duration <= 0) { error('INVALID_RANGE', `Invalid target range ${segment.id}`); continue; }
      const start = target.start ?? 0;
      end = Math.max(end, start + target.duration);
      ranges.push({ start, end: start + target.duration, id: segment.id });
      const material = materials.get(segment.material_id);
      if (!material) error('DANGLING_MATERIAL', `Unknown material ${segment.material_id}`);
      if (material && ['video', 'audio', 'text', 'subtitle'].includes(track.type)) {
        const allowed = track.type === 'video' ? ['videos', 'images'] : track.type === 'audio' ? ['audios'] : ['texts', 'text_templates', 'subtitles'];
        if (!allowed.includes(material.bucket)) error('MATERIAL_TYPE', `Wrong material bucket for ${track.type} segment ${segment.id}`);
      }
      for (const ref of segment.extra_material_refs ?? []) if (!materials.has(ref)) error('DANGLING_REFERENCE', `Unknown companion material ${ref}`);
      if (segment.common_keyframes && !Array.isArray(segment.common_keyframes)) {
        error('INVALID_KEYFRAME', `common_keyframes must be an array on segment ${segment.id}`);
      } else for (const kf of segment.common_keyframes ?? []) {
        if (!kf.property_type || !Array.isArray(kf.keyframe_list)) {
          error('INVALID_KEYFRAME', `Invalid keyframe group on segment ${segment.id}`);
          continue;
        }
        for (const pt of kf.keyframe_list) {
          if (!Number.isSafeInteger(pt.time_offset) || pt.time_offset < 0) {
            error('INVALID_KEYFRAME', `Invalid time_offset ${pt.time_offset} on segment ${segment.id}`);
          }
          if (pt.time_offset > target.duration + 1000) {
            error('KEYFRAME_BOUNDS', `Keyframe time_offset ${pt.time_offset} exceeds duration ${target.duration} on segment ${segment.id}`);
          }
        }
      }
      const source = segment.source_timerange;
      if (source) {
        if (!Number.isSafeInteger(source.start ?? 0) || (source.start ?? 0) < 0 || !Number.isSafeInteger(source.duration) || source.duration <= 0) error('INVALID_RANGE', `Invalid source range ${segment.id}`);
        if (material?.type !== 'photo' && Number.isFinite(material?.duration) && (source.start ?? 0) + source.duration > material.duration + 1000) error('SOURCE_BOUNDS', `Source range exceeds media duration ${segment.id}`);
        const speed = segment.speed ?? 1;
        if (!(speed > 0) || !Number.isFinite(speed)) error('INVALID_SPEED', segment.id);
        const curve = (segment.extra_material_refs ?? []).map(r => materials.get(r)).some(m => m?.type === 'speed' && m.curve_speed);
        if (!curve && material?.type !== 'photo' && Math.abs(source.duration - target.duration * speed) > Math.max(2, speed / 2 + 1)) error('SPEED_MISMATCH', segment.id);
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) if (ranges[i].start < ranges[i - 1].end) warnings.push({ code: 'TRACK_OVERLAP', message: `Track ${track.id}: ${ranges[i - 1].id} overlaps ${ranges[i].id}` });
  }
  if (Math.abs((data.duration ?? 0) - end) > 1) warnings.push({ code: 'DURATION_MISMATCH', message: `Timeline declares ${(data.duration ?? 0) / US}s, segments end at ${end / US}s` });
  return { valid: errors.length === 0, errors, warnings };
}
