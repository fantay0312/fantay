import fs from 'node:fs';
import path from 'node:path';
import { applyTransform, checkClip, generate, parseSrt } from './build.js';
import { clone, fail, id, keys, micros, number, object, string, US } from './common.js';
import { readDraft, saveEdited, withOutputAsync } from './storage.js';
import { validateData } from './validate.js';

export function segments(data) { return data.tracks.flatMap(track => track.segments.map(segment => ({ track, segment }))); }
export function findSegment(data, segmentId) {
  string(segmentId, 'segmentId');
  const matches = segments(data).filter(item => item.segment.id === segmentId);
  if (matches.length !== 1) fail('SEGMENT_NOT_FOUND', `Expected one segment with id ${segmentId}, found ${matches.length}`);
  return matches[0];
}
function materialEntry(data, materialId) {
  for (const [bucket, items] of Object.entries(data.materials)) {
    if (!Array.isArray(items)) continue;
    const value = items.find(item => item.id === materialId);
    if (value) return { bucket, value };
  }
  fail('DANGLING_MATERIAL', `Material not found: ${materialId}`);
}
function mutableMaterial(data, segment, materialId, main = false) {
  const { bucket, value } = materialEntry(data, materialId);
  const count = segments(data).filter(({ segment: other }) => other.material_id === materialId || other.extra_material_refs?.includes(materialId)).length;
  if (count <= 1 && data.materials[bucket].filter(item => item.id === materialId).length === 1) return value;
  const replacement = { ...clone(value), id: id() };
  data.materials[bucket].push(replacement);
  if (main) segment.material_id = replacement.id;
  else segment.extra_material_refs = segment.extra_material_refs.map(ref => ref === materialId ? replacement.id : ref);
  return replacement;
}
const TRANSITION_TEMPLATES = {
  '叠化': {
    name: '叠化',
    effect_id: '6724845717472416269',
    resource_id: '6724845717472416269',
    path: '@userdata/Cache/effect/6724845717472416269/33d3a1ad16e89a4e2c9b6d45e3ec7aa1',
    is_overlap: true,
  },
  '推近': {
    name: '推近',
    effect_id: '6724226861666144779',
    resource_id: '6724226861666144779',
    path: '@userdata/Cache/effect/6724226861666144779/0d5c6e143e5d5bdce8b4728511dd81ed',
    is_overlap: true,
  },
  '闪黑': {
    name: '闪黑',
    effect_id: '6724239388189921806',
    resource_id: '6724239388189921806',
    path: '@userdata/Cache/effect/6724239388189921806/52062659daf3114347a63b78a0f2bbfc',
    is_overlap: false,
    category_id: '100000',
    category_name: '基础',
  },
  '滑动': {
    name: '滑动',
    effect_id: '6757982416649851399',
    resource_id: '6757982416649851399',
    path: '@userdata/Cache/effect/6757982416649851399/a34f0a60ae519076c7b7f5b9de319e53',
    is_overlap: true,
  },
  '翻页': {
    name: '翻页',
    effect_id: '6747979085894390279',
    resource_id: '6747979085894390279',
    path: '@userdata/Cache/effect/6747979085894390279/8bed2cd10ef9673107511b411b8179a1',
    is_overlap: true,
  },
};

function guardTemporal(data, segment, { allowKeyframes = false, allowTransitions = false, allowFades = false } = {}) {
  if (segment.reverse || segment.group_id || segment.template_id) fail('COMPLEX_SEGMENT', 'Timing changes on reverse clips, groups or templates require a dedicated adapter');
  if (!allowKeyframes && (segment.common_keyframes?.length || segment.keyframe_refs?.length)) fail('COMPLEX_SEGMENT', 'Timing changes on keyframed clips require a dedicated adapter');
  const companions = (segment.extra_material_refs ?? []).map(ref => materialEntry(data, ref));
  const staticDefault = ({ bucket, value }) => {
    if (bucket === 'speeds') return value.type === 'speed' && !value.curve_speed;
    if (bucket === 'canvases') return ['canvas_color', 'canvas_blur'].includes(value.type);
    if (allowTransitions && bucket === 'transitions') return true;
    if (allowFades && bucket === 'audio_fades') return true;
    // Native 11.6 adds these inert companion objects when opening a draft.
    return ['placeholder_infos', 'sound_channel_mappings', 'material_colors', 'vocal_separations'].includes(bucket) &&
      Object.keys(value).every(key => ['id', 'type', 'meta_type'].includes(key));
  };
  if (companions.some(item => !staticDefault(item))) fail('COMPLEX_SEGMENT', 'Timing changes on curves, effects, transitions or fades are not supported');
  if (Object.values(data.keyframes ?? {}).some(values => Array.isArray(values) && values.some(k => k?.segment_id === segment.id || k?.target_id === segment.id))) fail('COMPLEX_SEGMENT', 'Timeline keyframes reference this segment');
}
function containsReference(value, target) {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some(item => containsReference(item, target));
  if (value && typeof value === 'object') return Object.values(value).some(item => containsReference(item, target));
  return false;
}
function guardStructural(data, segment) {
  if (segment.group_id || segment.template_id || containsReference(data.keyframes, segment.id) ||
      containsReference(data.relationships, segment.id) || containsReference(data.group_container, segment.id)) {
    fail('COMPLEX_SEGMENT', 'This clip is referenced by global keyframes, groups or relationships');
  }
}
function overlapPairs(data) {
  const found = new Set();
  for (const track of data.tracks) {
    const sorted = [...track.segments].sort((a, b) => (a.target_timerange.start ?? 0) - (b.target_timerange.start ?? 0));
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
      if ((sorted[j].target_timerange.start ?? 0) >= (sorted[i].target_timerange.start ?? 0) + sorted[i].target_timerange.duration) break;
      found.add(`${track.id}:${[sorted[i].id, sorted[j].id].sort().join(':')}`);
    }
  }
  return found;
}
function recalculate(data) { data.duration = Math.max(0, ...segments(data).map(({ segment: s }) => (s.target_timerange.start ?? 0) + s.target_timerange.duration)); }

export function applyOperation(data, op) {
  string(op.op, 'operation.op');
  const fields = {
    move: ['start', 'trackId'], trim: ['sourceStart', 'duration'], split: ['at'], delete: ['ripple'],
    set_speed: ['speed'], set_volume: ['volume'], set_text: ['text'], transform: ['transform'],
    set_keyframes: ['keyframes'], set_transition: ['transition'], set_fade: ['fade'],
    relink: ['path'],
  };
  if (!fields[op.op]) fail('INVALID_OPERATION', `Unknown operation: ${op.op}`);
  keys(op, ['op', 'segmentId', ...fields[op.op]], op.op);
  const { segment, track } = findSegment(data, op.segmentId);
  const range = segment.target_timerange;
  const source = segment.source_timerange;
  if (op.op === 'move') {
    guardStructural(data, segment);
    range.start = micros(op.start, 'start');
    if (op.trackId !== undefined) {
      const target = data.tracks.find(t => t.id === op.trackId);
      if (!target || target.type !== track.type) fail('INVALID_TRACK', 'Target track must exist and have the same type');
      if (target !== track) {
        track.segments.splice(track.segments.indexOf(segment), 1);
        target.segments.push(segment);
        segment.track_attribute = target.attribute ?? 0;
        // Adopt the destination layer without replacing any other clip state.
        segment.render_index = target.segments.find(s => s !== segment)?.render_index ?? segment.render_index;
      }
    }
  } else if (op.op === 'trim') {
    guardTemporal(data, segment);
    range.duration = micros(op.duration, 'duration', true);
    if (source) {
      source.start = op.sourceStart === undefined ? source.start ?? 0 : micros(op.sourceStart, 'sourceStart');
      source.duration = Math.round(range.duration * (segment.speed ?? 1));
    } else if (op.sourceStart !== undefined) fail('INVALID_OPERATION', 'Text has no source offset');
  } else if (op.op === 'split') {
    guardTemporal(data, segment, { allowKeyframes: true, allowTransitions: true, allowFades: true });
    const at = micros(op.at, 'at');
    const start = range.start ?? 0, end = start + range.duration;
    if (at <= start || at >= end) fail('INVALID_RANGE', 'Split point must be strictly inside the clip');
    const splitOffset = at - start;
    const right = clone(segment);
    right.id = id();
    right.target_timerange = { ...range, start: at, duration: end - at };
    range.duration = splitOffset;
    if (source) {
      const leftSource = Math.round(range.duration * (segment.speed ?? 1));
      right.source_timerange = { ...source, start: (source.start ?? 0) + leftSource, duration: source.duration - leftSource };
      source.duration = leftSource;
      if (right.source_timerange.duration <= 0 || source.duration <= 0) fail('INVALID_RANGE', 'Split is below source precision');
    }

    // 1. 切分关键帧（common_keyframes）并线性插值
    if (segment.common_keyframes?.length) {
      const leftKfs = [], rightKfs = [];
      for (const group of segment.common_keyframes) {
        const list = group.keyframe_list ?? [];
        const leftPts = [], rightPts = [];
        for (const pt of list) {
          if (pt.time_offset < splitOffset) {
            leftPts.push(clone(pt));
          } else if (pt.time_offset > splitOffset) {
            const rpt = clone(pt);
            rpt.id = id();
            rpt.time_offset = pt.time_offset - splitOffset;
            rightPts.push(rpt);
          } else {
            leftPts.push(clone(pt));
            const rpt = clone(pt);
            rpt.id = id();
            rpt.time_offset = 0;
            rightPts.push(rpt);
          }
        }

        // 如果切分点落在两个关键帧之间，线性插值生成分界点
        const prev = [...list].reverse().find(p => p.time_offset < splitOffset);
        const next = list.find(p => p.time_offset > splitOffset);
        if (prev && next && !list.some(p => p.time_offset === splitOffset)) {
          const ratio = (splitOffset - prev.time_offset) / (next.time_offset - prev.time_offset);
          const v0 = prev.values?.[0] ?? 0, v1 = next.values?.[0] ?? 0;
          const interp = v0 + (v1 - v0) * ratio;

          const leftAnchor = {
            id: id(), time_offset: splitOffset,
            left_control: { x: 0.0, y: 0.0 }, right_control: { x: 0.0, y: 0.0 },
            values: [interp], curveType: 'Line', graphID: '',
          };
          leftPts.push(leftAnchor);
          leftPts.sort((a, b) => a.time_offset - b.time_offset);

          const rightAnchor = {
            id: id(), time_offset: 0,
            left_control: { x: 0.0, y: 0.0 }, right_control: { x: 0.0, y: 0.0 },
            values: [interp], curveType: 'Line', graphID: '',
          };
          rightPts.unshift(rightAnchor);
        }

        if (leftPts.length) leftKfs.push({ ...clone(group), id: id(), keyframe_list: leftPts });
        if (rightPts.length) rightKfs.push({ ...clone(group), id: id(), keyframe_list: rightPts });
      }
      segment.common_keyframes = leftKfs;
      right.common_keyframes = rightKfs;
    }

    // 2. 切分转场（转场仅保留在右侧片段）
    const isTransRef = ref => (data.materials.transitions ?? []).some(m => m.id === ref);
    segment.extra_material_refs = (segment.extra_material_refs ?? []).filter(ref => !isTransRef(ref));

    // 3. 切分淡入淡出（fade_in 保留在左，fade_out 保留在右）
    const fadeRef = (segment.extra_material_refs ?? []).find(ref => (data.materials.audio_fades ?? []).some(m => m.id === ref));
    if (fadeRef) {
      const origFade = (data.materials.audio_fades ?? []).find(m => m.id === fadeRef);
      if (origFade) {
        if (origFade.fade_in_duration) {
          const leftFade = { id: id(), type: 'audio_fade', fade_in_duration: Math.min(origFade.fade_in_duration, segment.target_timerange.duration), fade_out_duration: 0, fade_type: 0 };
          data.materials.audio_fades.push(leftFade);
          segment.extra_material_refs = segment.extra_material_refs.map(r => r === fadeRef ? leftFade.id : r);
        } else {
          segment.extra_material_refs = segment.extra_material_refs.filter(r => r !== fadeRef);
        }

        if (origFade.fade_out_duration) {
          const rightFade = { id: id(), type: 'audio_fade', fade_in_duration: 0, fade_out_duration: Math.min(origFade.fade_out_duration, right.target_timerange.duration), fade_type: 0 };
          data.materials.audio_fades.push(rightFade);
          right.extra_material_refs = (right.extra_material_refs ?? []).map(r => r === fadeRef ? rightFade.id : r);
        } else {
          right.extra_material_refs = (right.extra_material_refs ?? []).filter(r => r !== fadeRef);
        }
      }
    }

    track.segments.splice(track.segments.indexOf(segment) + 1, 0, right);
    recalculate(data);
    return { segmentId: segment.id, newSegmentId: right.id };
  } else if (op.op === 'delete') {
    guardStructural(data, segment);
    if (op.ripple !== undefined && typeof op.ripple !== 'boolean') fail('INVALID_INPUT', 'ripple must be boolean');

    const sorted = [...track.segments].sort((a, b) => (a.target_timerange.start ?? 0) - (b.target_timerange.start ?? 0));
    const segIdx = sorted.indexOf(segment);
    const prevSeg = segIdx > 0 ? sorted[segIdx - 1] : null;
    const nextSeg = segIdx < sorted.length - 1 ? sorted[segIdx + 1] : null;

    if (op.ripple) {
      const start = range.start ?? 0, end = start + range.duration;
      for (const { segment: other } of segments(data)) {
        if (other === segment) continue;
        const r = other.target_timerange, s = r.start ?? 0;
        if (s < end && s + r.duration > start) fail('RIPPLE_CONFLICT', 'Another clip intersects the removed interval; no changes were saved');
      }
      for (const { segment: other } of segments(data)) if ((other.target_timerange.start ?? 0) >= end) {
        guardStructural(data, other);
        other.target_timerange.start -= range.duration;
      }

      if (prevSeg) {
        const isTransRef = ref => (data.materials.transitions ?? []).some(m => m.id === ref);
        const prevTransRef = (prevSeg.extra_material_refs ?? []).find(isTransRef);
        if (prevTransRef) {
          if (!nextSeg) {
            prevSeg.extra_material_refs = prevSeg.extra_material_refs.filter(r => r !== prevTransRef);
          } else {
            const tMat = (data.materials.transitions ?? []).find(m => m.id === prevTransRef);
            if (tMat) {
              const limit = Math.floor(Math.min(prevSeg.target_timerange.duration, nextSeg.target_timerange.duration) / 2);
              if (tMat.duration > limit) {
                const fps = data.fps || 30;
                let frames = Math.floor(limit * fps / US);
                frames -= frames % 2;
                while (frames >= 2 && Math.round(frames * US / fps) > limit) frames -= 2;
                if (frames >= 2) tMat.duration = Math.round(frames * US / fps);
                else prevSeg.extra_material_refs = prevSeg.extra_material_refs.filter(r => r !== prevTransRef);
              }
            }
          }
        }
      }
    } else {
      if (prevSeg) {
        const isTransRef = ref => (data.materials.transitions ?? []).some(m => m.id === ref);
        prevSeg.extra_material_refs = (prevSeg.extra_material_refs ?? []).filter(ref => !isTransRef(ref));
      }
    }

    track.segments.splice(track.segments.indexOf(segment), 1);
    // Keep all materials: effects/templates may reference them indirectly.
  } else if (op.op === 'set_speed') {
    guardTemporal(data, segment);
    const main = materialEntry(data, segment.material_id).value;
    if (!source || main.type === 'photo') fail('INVALID_OPERATION', 'Only video and audio clips support speed changes');
    segment.speed = number(op.speed, 'speed', { positive: true, max: 100 });
    range.duration = Math.round(source.duration / segment.speed);
    if (range.duration <= 0) fail('INVALID_RANGE', 'Speed results in zero duration');
    const ref = (segment.extra_material_refs ?? []).find(ref => materialEntry(data, ref).value.type === 'speed');
    if (ref) mutableMaterial(data, segment, ref).speed = segment.speed;
    else {
      const speed = { id: id(), type: 'speed', mode: 0, speed: segment.speed, curve_speed: null };
      (data.materials.speeds ??= []).push(speed);
      (segment.extra_material_refs ??= []).push(speed.id);
    }
  } else if (op.op === 'set_volume') {
    if (track.type !== 'video' && track.type !== 'audio') fail('INVALID_OPERATION', 'Volume requires an audio or video clip');
    segment.volume = number(op.volume, 'volume', { max: 1 });
    if (segment.volume > 0) segment.last_nonzero_volume = segment.volume;
  } else if (op.op === 'set_text') {
    string(op.text, 'text');
    if (track.type !== 'text' || materialEntry(data, segment.material_id).bucket !== 'texts') fail('COMPLEX_TEXT', 'Only direct text materials are supported');
    const material = mutableMaterial(data, segment, segment.material_id, true);
    let content;
    try { content = JSON.parse(material.content); } catch { fail('COMPLEX_TEXT', 'Text content is not JSON'); }
    if (typeof content.text !== 'string') fail('COMPLEX_TEXT', 'Missing text content');
    if (content.styles?.length > 1 && op.text.length !== content.text.length) fail('COMPLEX_TEXT', 'Changing the length of multi-style text requires explicit style remapping');
    content.text = op.text;
    if (content.styles?.length === 1) content.styles[0].range = [0, op.text.length];
    material.content = JSON.stringify(content);
    if (typeof material.base_content === 'string' && material.base_content.startsWith('{')) material.base_content = material.content;
    if ('recognize_text' in material) material.recognize_text = op.text;
  } else if (op.op === 'transform') {
    if (track.type !== 'video' && track.type !== 'text') fail('INVALID_OPERATION', 'Transform requires a visual clip');
    if (segment.common_keyframes?.length || segment.keyframe_refs?.length) fail('COMPLEX_SEGMENT', 'Transforming a keyframed clip requires a dedicated adapter');
    applyTransform(segment, op.transform);
  } else if (op.op === 'set_keyframes') {
    if (!Array.isArray(op.keyframes)) fail('INVALID_INPUT', 'keyframes must be an array');
    const segDuration = range.duration;
    const propMap = {
      x: 'KFTypePositionX',
      y: 'KFTypePositionY',
      scaleX: 'KFTypeScaleX',
      scaleY: 'KFTypeScaleY',
      rotation: 'KFTypeRotation',
      opacity: 'KFTypeAlpha',
      volume: 'KFTypeVolume',
    };

    const propPoints = {};
    for (const key of Object.keys(propMap)) propPoints[key] = [];

    for (const pt of op.keyframes) {
      object(pt, 'keyframe');
      keys(pt, ['at', 'x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'alpha', 'volume'], 'keyframe');
      const at = micros(pt.at, 'keyframe.at');
      if (at < 0 || at > segDuration) fail('INVALID_RANGE', `Keyframe time ${pt.at}s is outside clip bounds (0..${segDuration / US}s)`);
      if (pt.scale !== undefined) {
        number(pt.scale, 'keyframe.scale', { positive: true });
        pt.scaleX ??= pt.scale;
        pt.scaleY ??= pt.scale;
      }
      if (pt.alpha !== undefined) {
        number(pt.alpha, 'keyframe.alpha', { min: 0, max: 1 });
        pt.opacity ??= pt.alpha;
      }
      for (const [prop, propType] of Object.entries(propMap)) {
        if (pt[prop] !== undefined) {
          const numOpts = ['scaleX', 'scaleY'].includes(prop)
            ? { positive: true }
            : ['opacity', 'volume'].includes(prop)
            ? { min: 0, max: 1 }
            : { min: -Infinity };
          number(pt[prop], `keyframe.${prop}`, numOpts);
          if (prop === 'volume' && track.type !== 'video' && track.type !== 'audio') {
            fail('INVALID_OPERATION', 'Volume keyframes require audio or video clip');
          }
          if (['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity'].includes(prop) && track.type !== 'video' && track.type !== 'text') {
            fail('INVALID_OPERATION', `${prop} keyframes require visual clip`);
          }
          propPoints[prop].push({ time_offset: at, value: pt[prop] });
        }
      }
    }

    const newKeyframes = [];
    for (const [prop, points] of Object.entries(propPoints)) {
      if (!points.length) continue;
      points.sort((a, b) => a.time_offset - b.time_offset);
      for (let i = 1; i < points.length; i++) {
        if (points[i].time_offset <= points[i - 1].time_offset) {
          fail('INVALID_INPUT', `Duplicate or non-increasing keyframe time for property ${prop}`);
        }
      }
      newKeyframes.push({
        id: id(),
        material_id: '',
        property_type: propMap[prop],
        keyframe_list: points.map(p => ({
          id: id(),
          time_offset: p.time_offset,
          left_control: { x: 0.0, y: 0.0 },
          right_control: { x: 0.0, y: 0.0 },
          values: [p.value],
          curveType: 'Line',
          graphID: '',
        })),
      });
    }

    segment.common_keyframes = newKeyframes;
    segment.keyframe_refs = [];
  } else if (op.op === 'set_transition') {
    if (track.type !== 'video') fail('INVALID_OPERATION', 'Transitions require a video track');
    let tr = op.transition;
    if (typeof tr === 'string') tr = { name: tr };
    object(tr, 'transition');
    string(tr.name, 'transition.name');

    const sorted = [...track.segments].sort((a, b) => (a.target_timerange.start ?? 0) - (b.target_timerange.start ?? 0));
    const idx = sorted.indexOf(segment);
    if (idx === sorted.length - 1) fail('INVALID_OPERATION', 'Transitions cannot be placed on the last clip of a track');

    const nextSeg = sorted[idx + 1];
    const segEnd = (segment.target_timerange.start ?? 0) + segment.target_timerange.duration;
    const nextStart = nextSeg.target_timerange.start ?? 0;
    if (Math.abs(nextStart - segEnd) > 1000) fail('INVALID_OPERATION', 'Transitions require adjacent clips with no gap');

    const fps = data.fps || 30;
    const rawDuration = tr.duration !== undefined ? micros(tr.duration, 'transition.duration', true) : 500000;
    const limit = Math.floor(Math.min(segment.target_timerange.duration, nextSeg.target_timerange.duration) / 2);
    if (rawDuration > limit) fail('INVALID_OPERATION', 'Transition duration exceeds half the shorter clip');

    let frames = Math.round(rawDuration * fps / US);
    frames -= frames % 2;
    frames = Math.max(frames, 2);
    while (frames > 2 && Math.round(frames * US / fps) > limit) frames -= 2;
    const snappedDuration = Math.round(frames * US / fps);
    if (snappedDuration > limit) fail('INVALID_OPERATION', 'Transition duration exceeds half the shorter clip');

    const tpl = TRANSITION_TEMPLATES[tr.name] ?? {
      name: tr.name,
      effect_id: id(),
      resource_id: id(),
      path: '',
      is_overlap: true,
    };

    const mat = {
      id: id(),
      type: 'transition',
      name: tpl.name,
      duration: snappedDuration,
      effect_id: tpl.effect_id,
      resource_id: tpl.resource_id,
      third_resource_id: tpl.third_resource_id ?? tpl.resource_id,
      source_platform: 1,
      path: tpl.path ?? '',
      is_overlap: tpl.is_overlap ?? true,
      category_id: tpl.category_id ?? '39663',
      category_name: tpl.category_name ?? '热门',
    };

    (data.materials.transitions ??= []).push(mat);

    // 清除该片段上既有的旧转场
    const isTransRef = ref => (data.materials.transitions ?? []).some(m => m.id === ref);
    segment.extra_material_refs = (segment.extra_material_refs ?? []).filter(ref => !isTransRef(ref));
    (segment.extra_material_refs ??= []).push(mat.id);
  } else if (op.op === 'set_fade') {
    if (track.type !== 'audio' && track.type !== 'video') fail('INVALID_OPERATION', 'Fades require audio or video clip');
    object(op.fade, 'fade');
    const fadeIn = op.fade.in !== undefined ? micros(op.fade.in, 'fade.in') : 0;
    const fadeOut = op.fade.out !== undefined ? micros(op.fade.out, 'fade.out') : 0;
    if (fadeIn + fadeOut > range.duration) fail('INVALID_INPUT', 'Audio fades exceed clip duration');

    const isFadeRef = ref => (data.materials.audio_fades ?? []).some(m => m.id === ref);
    segment.extra_material_refs = (segment.extra_material_refs ?? []).filter(ref => !isFadeRef(ref));

    if (fadeIn > 0 || fadeOut > 0) {
      const fadeId = id();
      const fadeMat = { id: fadeId, type: 'audio_fade', fade_in_duration: fadeIn, fade_out_duration: fadeOut, fade_type: 0 };
      (data.materials.audio_fades ??= []).push(fadeMat);
      (segment.extra_material_refs ??= []).push(fadeId);
      if (track.type === 'video') {
        const vMat = data.materials.videos?.find(v => v.id === segment.material_id);
        if (vMat) vMat.audio_fade = { ...fadeMat };
      }
    }
  } else if (op.op === 'relink') {
    string(op.path, 'path');
    const entry = materialEntry(data, segment.material_id);
    if (!['videos', 'audios', 'images'].includes(entry.bucket)) fail('INVALID_OPERATION', 'Relink requires video, audio or image');
    const mat = mutableMaterial(data, segment, segment.material_id, true);
    mat.path = op.path;
  }
  recalculate(data);
  return { segmentId: segment.id };
}

export async function editDraft(input, operations, { output, name, codec } = {}) {
  string(output, 'output');
  if (name !== undefined) string(name, 'name');
  if (!Array.isArray(operations) || !operations.length) fail('INVALID_INPUT', 'operations must be a nonempty array');
  const loaded = typeof input === 'string' ? readDraft(input, { codec }) : input;
  const data = clone(loaded.data);
  const originalOverlaps = overlapPairs(data);
  const initial = validateData(data, { dir: loaded.dir, checkMedia: true });
  if (!initial.valid) fail('INVALID_DRAFT', 'Source draft failed validation', initial.errors);
  return withOutputAsync(output, loaded.dir, async (stage, dest) => {
    const scratch = fs.mkdtempSync(path.join(stage, '.edit-work-'));
    const addedAssets = [], results = [];
    try {
      for (const operation of operations) {
        object(operation, 'operation');
        if (operation.op === 'add' || operation.op === 'import_srt' || operation.op === 'replace_media') {
          let clips;
          if (operation.op === 'add') {
            keys(operation, ['op', 'clip'], 'add');
            checkClip(operation.clip);
            clips = [operation.clip];
          } else if (operation.op === 'import_srt') {
            keys(operation, ['op', 'path', 'offset', 'track'], 'import_srt');
            clips = parseSrt(fs.readFileSync(string(operation.path, 'path'), 'utf8'), operation);
          } else {
            keys(operation, ['op', 'segmentId', 'path'], 'replace_media');
            const { segment, track } = findSegment(data, operation.segmentId);
            guardTemporal(data, segment);
            if (!['video', 'audio'].includes(track.type)) fail('INVALID_OPERATION', 'Media replacement requires video or audio');
            const type = materialEntry(data, segment.material_id).value.type === 'photo' ? 'image' : track.type;
            clips = [{ type, path: string(operation.path, 'path'), start: 0,
              duration: (type === 'audio' ? segment.source_timerange.duration : segment.target_timerange.duration) / US,
              ...(type === 'image' ? {} : { sourceStart: (segment.source_timerange?.start ?? 0) / US, speed: type === 'audio' ? 1 : segment.speed ?? 1 }) }];
          }
          const work = fs.mkdtempSync(path.join(scratch, 'add-'));
          if (operation.op !== 'replace_media') for (const clip of clips) {
            const type = clip.type === 'image' ? 'video' : clip.type;
            if ((clip.track ?? 0) > data.tracks.filter(t => t.type === type).length) fail('INVALID_TRACK', 'Track indices must be contiguous; create the next track before adding higher tracks');
          }
          const generated = await generate(clips, work, dest, { ...data.canvas_config, fps: data.fps, allowSparseTracks: true });
          // Give each added asset its own filename; never overwrite an existing one.
          for (const asset of generated.assets) {
            const filename = `${id()}${path.extname(asset)}`;
            const cached = path.join(scratch, filename);
            fs.copyFileSync(asset, cached, fs.constants.COPYFILE_EXCL);
            for (const values of Object.values(generated.data.materials)) for (const material of values) if (material.path === path.join(dest, 'materials', path.basename(asset))) material.path = path.join(dest, 'materials', filename);
            addedAssets.push(cached);
          }
          if (operation.op === 'replace_media') {
            const { segment } = findSegment(data, operation.segmentId);
            const replacement = generated.data.tracks[0].segments[0];
            segment.material_id = replacement.material_id;
            for (const bucket of ['videos', 'images', 'audios']) (data.materials[bucket] ??= []).push(...generated.data.materials[bucket]);
            results.push({ segmentId: segment.id });
          } else {
            for (const [bucket, values] of Object.entries(generated.data.materials)) (data.materials[bucket] ??= []).push(...values);
            for (const [index, sourceTrack] of generated.data.tracks.entries()) {
              const clip = clips.find(c => (c.type === 'image' ? 'video' : c.type) === sourceTrack.type);
              const ordinal = clip?.track ?? 0;
              const existing = data.tracks.filter(t => t.type === sourceTrack.type)[ordinal];
              const target = existing ?? sourceTrack;
              if (!existing) data.tracks.push(target);
              else {
                for (const segment of sourceTrack.segments) {
                  segment.track_attribute = existing.attribute ?? 0;
                  segment.render_index = existing.segments[0]?.render_index ?? segment.render_index;
                }
                existing.segments.push(...sourceTrack.segments);
              }
            }
            results.push({ segmentIds: generated.data.tracks.flatMap(t => t.segments.map(s => s.id)) });
          }
        } else results.push(applyOperation(data, operation));
      }
      recalculate(data);
      for (const pair of overlapPairs(data)) if (!originalOverlaps.has(pair)) fail('TRACK_OVERLAP', 'The edit creates overlapping clips on the same track');
      const validation = validateData(data);
      if (!validation.valid) fail('INVALID_DRAFT', 'Edited draft failed validation', validation.errors);
      const result = saveEdited({ ...loaded, data }, stage, dest, { name, addedAssets });
      return { ...result, operations: results, validation, encoding: [...loaded.documents.values()].some(d => d.encrypted) ? 'native' : 'plaintext' };
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });
}
