import fs from 'node:fs';
import path from 'node:path';
import { Draft } from '../vendor/jianying-mcp/draft.js';
import { clone, fail, id, json, keys, micros, number, rewritePaths, string, US, writeJSON } from './common.js';
import { withOutputAsync } from './storage.js';
import { validateData } from './validate.js';

const template = json(new URL('../vendor/jianying-mcp/jianying-11.6-template.json', import.meta.url));
const clipKeys = ['type', 'path', 'text', 'start', 'duration', 'sourceStart', 'speed', 'volume', 'track', 'style', 'subtitle', 'transform', 'fadeIn', 'fadeOut', 'fade', 'keyframes', 'transition'];

export const TRANSITION_PRESETS = {
  '叠化': {
    name: '叠化',
    resource_id: '6724845717472416269',
    effect_id: '6724845717472416269',
    path: '@userdata/Cache/effect/6724845717472416269/33d3a1ad16e89a4e2c9b6d45e3ec7aa1',
    category_id: '39663',
    category_name: '热门',
    is_overlap: true,
  },
  '推近': {
    name: '推近',
    resource_id: '6724226861666144779',
    effect_id: '6724226861666144779',
    path: '@userdata/Cache/effect/6724226861666144779/0d5c6e143e5d5bdce8b4728511dd81ed',
    category_id: '39663',
    category_name: '热门',
    is_overlap: true,
  },
  '闪黑': {
    name: '闪黑',
    resource_id: '6724239388189921806',
    effect_id: '6724239388189921806',
    path: '@userdata/Cache/effect/6724239388189921806/52062659daf3114347a63b78a0f2bbfc',
    category_id: '100000',
    category_name: '',
    is_overlap: true,
  },
  '滑动': {
    name: '滑动',
    resource_id: '6757982416649851399',
    effect_id: '6757982416649851399',
    path: '@userdata/Cache/effect/6757982416649851399/a34f0a60ae519076c7b7f5b9de319e53',
    category_id: '39663',
    category_name: '热门',
    is_overlap: true,
  },
};

export function snapEvenFrames(durationUs, fps, maxUs) {
  let frames = Math.round((durationUs * fps) / US);
  frames -= frames % 2;
  frames = Math.max(frames, 2);
  let snapped = Math.round((frames * US) / fps);
  if (maxUs !== undefined) {
    while (snapped > maxUs && frames > 2) {
      frames -= 2;
      snapped = Math.round((frames * US) / fps);
    }
  }
  return snapped;
}

export function makeTransitionMaterial(name, durationUs, fps, maxUs) {
  const snapped = snapEvenFrames(durationUs, fps, maxUs);
  const preset = TRANSITION_PRESETS[name] ?? {
    name,
    resource_id: id(),
    effect_id: id(),
    path: '',
    category_id: '',
    category_name: '',
    is_overlap: true,
  };
  const transId = id();
  return {
    ...preset,
    id: transId,
    type: 'transition',
    duration: snapped,
    source_platform: 1,
    third_resource_id: preset.resource_id,
  };
}

const KEYFRAME_PROPERTIES = [
  { key: 'x', type: 'KFTypePositionX' },
  { key: 'y', type: 'KFTypePositionY' },
  { key: 'scaleX', type: 'KFTypeScaleX', fallbackKey: 'scale' },
  { key: 'scaleY', type: 'KFTypeScaleY', fallbackKey: 'scale' },
  { key: 'rotation', type: 'KFTypeRotation' },
  { key: 'opacity', type: 'KFTypeAlpha', fallbackKey: 'alpha' },
  { key: 'volume', type: 'KFTypeVolume' },
];

export function buildCommonKeyframes(keyframePoints, maxDurationUs) {
  if (!Array.isArray(keyframePoints) || keyframePoints.length === 0) return [];
  const result = [];
  for (const { key, type, fallbackKey } of KEYFRAME_PROPERTIES) {
    const matching = keyframePoints
      .filter(pt => pt[key] !== undefined || (fallbackKey && pt[fallbackKey] !== undefined))
      .map(pt => ({
        at: pt.at,
        time_offset: Math.round(pt.at * US),
        val: pt[key] !== undefined ? pt[key] : pt[fallbackKey],
      }))
      .sort((a, b) => a.time_offset - b.time_offset);

    if (matching.length === 0) continue;
    let prev = -1;
    for (const m of matching) {
      if (m.time_offset < 0 || m.time_offset > maxDurationUs + 1000) {
        fail('INVALID_INPUT', `Keyframe time_offset ${m.time_offset} exceeds duration ${maxDurationUs}`);
      }
      if (m.time_offset <= prev) {
        fail('INVALID_INPUT', `Keyframes for ${key} must have strictly increasing timestamps`);
      }
      prev = m.time_offset;
    }
    result.push({
      id: id(),
      material_id: '',
      property_type: type,
      keyframe_list: matching.map(m => ({
        id: id(),
        time_offset: m.time_offset,
        values: [Number(m.val)],
        curveType: 'Line',
        graphID: '',
        left_control: { x: 0.0, y: 0.0 },
        right_control: { x: 0.0, y: 0.0 },
      })),
    });
  }
  return result;
}

export function checkKeyframes(keyframes, clip) {
  if (!Array.isArray(keyframes)) fail('INVALID_INPUT', 'clip.keyframes must be an array');
  const allowed = ['at', 'x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'alpha', 'volume'];
  for (const pt of keyframes) {
    keys(pt, allowed, 'keyframe');
    if (typeof pt.at !== 'number' || !Number.isFinite(pt.at) || pt.at < 0) fail('INVALID_INPUT', 'keyframe.at must be a non-negative finite number');
    if (clip.duration !== undefined && pt.at > clip.duration) fail('INVALID_INPUT', 'Keyframe timestamp exceeds clip duration');
    for (const f of ['x', 'y', 'rotation']) if (pt[f] !== undefined) number(pt[f], `keyframe.${f}`, { min: -Infinity });
    for (const f of ['scale', 'scaleX', 'scaleY']) if (pt[f] !== undefined) number(pt[f], `keyframe.${f}`, { positive: true });
    for (const f of ['opacity', 'alpha', 'volume']) if (pt[f] !== undefined) number(pt[f], `keyframe.${f}`, { min: 0, max: 1 });
  }
}

export function checkTransition(transition) {
  keys(transition, ['name', 'duration'], 'transition');
  string(transition.name, 'transition.name');
  if (transition.duration !== undefined) number(transition.duration, 'transition.duration', { positive: true });
}

export function checkClip(clip) {
  keys(clip, clipKeys, 'clip');
  if (!['video', 'image', 'audio', 'text'].includes(clip.type)) fail('INVALID_INPUT', 'clip.type must be video, image, audio or text');
  micros(clip.start ?? 0, 'clip.start');
  if (clip.duration !== undefined) micros(clip.duration, 'clip.duration', true);
  micros(clip.sourceStart ?? 0, 'clip.sourceStart');
  number(clip.track ?? 0, 'clip.track', { integer: true, max: 100 });
  number(clip.speed ?? 1, 'clip.speed', { positive: true, max: 100 });
  number(clip.volume ?? 1, 'clip.volume', { max: 1 });
  if (clip.type === 'text') {
    string(clip.text, 'clip.text');
    if (clip.duration === undefined) fail('INVALID_INPUT', 'Text requires duration');
    for (const field of ['path', 'sourceStart', 'speed', 'volume', 'fadeIn', 'fadeOut', 'fade', 'keyframes', 'transition']) if (clip[field] !== undefined) fail('INVALID_INPUT', `Text does not accept ${field}`);
  } else {
    string(clip.path, 'clip.path');
    for (const field of ['text', 'style', 'subtitle']) if (clip[field] !== undefined) fail('INVALID_INPUT', `${clip.type} does not accept ${field}`);
  }
  if (clip.type === 'image' && (clip.duration === undefined || (clip.speed ?? 1) !== 1 || (clip.sourceStart ?? 0) !== 0)) fail('INVALID_INPUT', 'Images require duration and do not support source offsets or speed');
  if (clip.fade !== undefined) {
    keys(clip.fade, ['in', 'out'], 'clip.fade');
    if (clip.fade.in !== undefined) micros(clip.fade.in, 'clip.fade.in');
    if (clip.fade.out !== undefined) micros(clip.fade.out, 'clip.fade.out');
  }
  const fadeIn = clip.fade?.in ?? clip.fadeIn ?? 0;
  const fadeOut = clip.fade?.out ?? clip.fadeOut ?? 0;
  if (!['audio', 'video'].includes(clip.type) && (fadeIn > 0 || fadeOut > 0)) {
    fail('INVALID_INPUT', 'Fades are supported for audio and video only');
  }
  if (clip.type === 'audio' && ((clip.speed ?? 1) !== 1 || clip.transform !== undefined)) fail('INVALID_INPUT', 'Audio creation supports speed 1 and no visual transform');
  for (const field of ['fadeIn', 'fadeOut']) if (clip[field] !== undefined) micros(clip[field], field);
  if (clip.duration && (fadeIn + fadeOut) > clip.duration) fail('INVALID_INPUT', 'Audio fades exceed clip duration');
  if (clip.subtitle !== undefined && typeof clip.subtitle !== 'boolean') fail('INVALID_INPUT', 'subtitle must be boolean');
  if (clip.transform !== undefined) checkTransform(clip.transform);
  if (clip.keyframes !== undefined) checkKeyframes(clip.keyframes, clip);
  if (clip.transition !== undefined) {
    if (!['video', 'image'].includes(clip.type)) fail('INVALID_INPUT', 'Transitions are supported for video and image clips only');
    checkTransition(clip.transition);
  }
}

export function checkTransform(transform) {
  keys(transform, ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'alpha', 'flipX', 'flipY'], 'transform');
  for (const field of ['x', 'y', 'rotation']) if (transform[field] !== undefined) number(transform[field], field, { min: -Infinity });
  for (const field of ['scaleX', 'scaleY']) if (transform[field] !== undefined) number(transform[field], field, { positive: true });
  if (transform.alpha !== undefined) number(transform.alpha, 'alpha', { max: 1 });
  for (const field of ['flipX', 'flipY']) if (transform[field] !== undefined && typeof transform[field] !== 'boolean') fail('INVALID_INPUT', `${field} must be boolean`);
}

export function applyTransform(segment, transform) {
  checkTransform(transform);
  const c = segment.clip ??= { transform: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, alpha: 1, flip: { horizontal: false, vertical: false } };
  c.transform ??= { x: 0, y: 0 };
  c.scale ??= { x: 1, y: 1 };
  c.flip ??= { horizontal: false, vertical: false };
  for (const [source, target] of [['x', 'x'], ['y', 'y']]) if (transform[source] !== undefined) c.transform[target] = transform[source];
  if (transform.scaleX !== undefined) c.scale.x = transform.scaleX;
  if (transform.scaleY !== undefined) c.scale.y = transform.scaleY;
  if (transform.rotation !== undefined) c.rotation = transform.rotation;
  if (transform.alpha !== undefined) c.alpha = transform.alpha;
  if (transform.flipX !== undefined) c.flip.horizontal = transform.flipX;
  if (transform.flipY !== undefined) c.flip.vertical = transform.flipY;
}

export function parseSrt(text, { offset = 0, track = 0 } = {}) {
  micros(offset, 'SRT offset');
  const time = value => {
    const m = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(value);
    if (!m) fail('INVALID_SRT', `Invalid SRT timestamp: ${value}`);
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  };
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n/);
  if (blocks.length === 1 && !blocks[0]) fail('INVALID_SRT', 'SRT is empty');
  return blocks.map(block => {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const match = /^(\S+)\s+-->\s+(\S+)\s*$/.exec(lines.shift() ?? '');
    if (!match) fail('INVALID_SRT', 'Invalid SRT cue: expected a timestamp range followed by caption text');
    const start = time(match[1]), end = time(match[2]);
    const caption = lines.join('\n');
    if (end <= start || !caption.trim()) fail('INVALID_SRT', 'SRT cue requires increasing times and text');
    return { type: 'text', text: caption, start: start + offset, duration: end - start, subtitle: true, track };
  });
}

export async function generate(clips, work, destination, { width = 1920, height = 1080, fps = 30, allowSparseTracks = false } = {}) {
  number(width, 'width', { integer: true, positive: true, max: 16384 });
  number(height, 'height', { integer: true, positive: true, max: 16384 });
  number(fps, 'fps', { positive: true, max: 240 });
  for (const clip of clips) checkClip(clip);
  if (!allowSparseTracks) for (const type of ['video', 'audio', 'text']) {
    const tracks = [...new Set(clips.filter(c => (c.type === 'image' ? 'video' : c.type) === type).map(c => c.track ?? 0))].sort((a, b) => a - b);
    if (tracks.some((track, index) => track !== index)) fail('INVALID_TRACK', 'Track indices must be contiguous and start at zero');
  }
  const engine = new Draft({ name: 'payload', draftsRoot: work, width, height, fps });
  const generatedSegments = [];
  for (const clip of clips) {
    const fadeIn = clip.fade?.in ?? clip.fadeIn;
    const fadeOut = clip.fade?.out ?? clip.fadeOut;
    const input = { filePath: clip.path, start: clip.start, duration: clip.duration, sourceStart: clip.sourceStart, speed: clip.speed, volume: clip.volume, track: clip.track, style: clip.style, subtitle: clip.subtitle, text: clip.text, fadeIn: clip.type === 'audio' ? fadeIn : undefined, fadeOut: clip.type === 'audio' ? fadeOut : undefined };
    const segment = clip.type === 'text' ? engine.addText(input) : clip.type === 'audio' ? await engine.addAudio(input) : await engine.addVideo(input);
    generatedSegments.push({ clip, segment });
    if (clip.transform) applyTransform(segment, clip.transform);
  }
  const built = engine.buildDraftInfo();
  for (const { clip, segment } of generatedSegments) {
    if (!['image', 'video'].includes(clip.type)) continue;
    const type = built.materials.videos.find(m => m.id === segment.materialId)?.type;
    if (type !== (clip.type === 'image' ? 'photo' : 'video')) fail('MEDIA_TYPE', `Expected ${clip.type} media: ${clip.path}`);
  }
  const data = { ...clone(template), ...built, config: { ...clone(template.config), ...built.config }, materials: { ...clone(template.materials), ...built.materials }, new_version: template.new_version };
  data.materials.transitions = data.materials.transitions || [];
  data.materials.audio_fades = data.materials.audio_fades || [];
  data.materials.subtitles = data.materials.subtitles || [];

  // 1. Process Video Tracks: transitions and video audio fades
  const videoClipsByTrack = new Map();
  for (const item of generatedSegments) {
    if (['video', 'image'].includes(item.clip.type)) {
      const trk = item.clip.track ?? 0;
      if (!videoClipsByTrack.has(trk)) videoClipsByTrack.set(trk, []);
      videoClipsByTrack.get(trk).push(item);
    }
  }
  for (const [trackIdx, trackItems] of videoClipsByTrack.entries()) {
    trackItems.sort((a, b) => (a.clip.start ?? 0) - (b.clip.start ?? 0));
    for (let i = 0; i < trackItems.length; i++) {
      const { clip, segment } = trackItems[i];
      const targetSeg = data.tracks.flatMap(t => t.segments).find(s => s.id === segment.id);
      if (!targetSeg) continue;

      // Video audio fades
      const fadeIn = clip.fade?.in ?? clip.fadeIn ?? 0;
      const fadeOut = clip.fade?.out ?? clip.fadeOut ?? 0;
      if (clip.type === 'video' && (fadeIn > 0 || fadeOut > 0)) {
        const fadeInUs = Math.round(fadeIn * US);
        const fadeOutUs = Math.round(fadeOut * US);
        const fadeId = id();
        const fadeMat = { id: fadeId, type: 'audio_fade', fade_in_duration: fadeInUs, fade_out_duration: fadeOutUs, fade_type: 0 };
        data.materials.audio_fades.push(fadeMat);
        targetSeg.extra_material_refs = targetSeg.extra_material_refs || [];
        targetSeg.extra_material_refs.push(fadeId);
        const vMat = data.materials.videos?.find(v => v.id === targetSeg.material_id);
        if (vMat) vMat.audio_fade = { ...fadeMat };
      }

      // Video transitions
      if (clip.transition) {
        if (i === trackItems.length - 1) {
          fail('INVALID_INPUT', 'A transition goes between two clips; the last clip cannot have one');
        }
        const nextItem = trackItems[i + 1];
        const nextSeg = data.tracks.flatMap(t => t.segments).find(s => s.id === nextItem.segment.id);
        const currentEnd = (targetSeg.target_timerange.start ?? 0) + targetSeg.target_timerange.duration;
        const nextStart = nextSeg ? (nextSeg.target_timerange.start ?? 0) : 0;
        if (Math.abs(nextStart - currentEnd) > 1000) {
          fail('INVALID_INPUT', 'Transition requires adjacent clips with no gap or overlap');
        }
        const reqUs = clip.transition.duration !== undefined ? Math.round(clip.transition.duration * US) : 500000;
        const maxUs = Math.floor(Math.min(targetSeg.target_timerange.duration, nextSeg.target_timerange.duration) / 2);
        if (reqUs > maxUs) {
          fail('INVALID_INPUT', `Transition duration exceeds half the shorter clip (${maxUs / US}s)`);
        }
        const transMat = makeTransitionMaterial(clip.transition.name, reqUs, data.fps, maxUs);
        if (transMat.duration > maxUs) {
          fail('INVALID_INPUT', `Transition duration (${transMat.duration / US}s) exceeds half the shorter clip (${maxUs / US}s)`);
        }
        data.materials.transitions.push(transMat);
        targetSeg.extra_material_refs = targetSeg.extra_material_refs || [];
        targetSeg.extra_material_refs.push(transMat.id);
      }
    }
  }

  // 2. Process Keyframes on all clips
  for (const { clip, segment } of generatedSegments) {
    if (clip.keyframes?.length) {
      const targetSeg = data.tracks.flatMap(t => t.segments).find(s => s.id === segment.id);
      if (targetSeg) {
        targetSeg.common_keyframes = buildCommonKeyframes(clip.keyframes, targetSeg.target_timerange.duration);
      }
    }
  }

  // 3. Process Subtitle Tracks
  for (const { clip, segment } of generatedSegments) {
    if (clip.type === 'text' && clip.subtitle) {
      const track = data.tracks.find(t => t.segments.some(s => s.id === segment.id));
      if (track) {
        track.flag = 1;
      }
      const textMat = data.materials.texts?.find(m => m.id === segment.materialId);
      if (textMat) {
        textMat.type = 'subtitle';
        textMat.base_content = textMat.content;
        textMat.recognize_text = clip.text;
        textMat.add_type = 1;
      }
    }
  }

  // This profile uses UTF-16 offsets, as does the desktop text editor.
  for (const text of [...(data.materials.texts || []), ...(data.materials.subtitles || [])]) {
    const content = JSON.parse(text.content);
    if (content.styles?.length === 1) content.styles[0].range = [0, content.text.length];
    text.content = JSON.stringify(content);
  }
  return { data: rewritePaths(data, engine.materialsDir, path.join(destination, 'materials')), assets: fs.existsSync(engine.materialsDir) ? fs.readdirSync(engine.materialsDir).map(n => path.join(engine.materialsDir, n)) : [] };
}

export async function createDraft(spec, { output } = {}) {
  keys(spec, ['name', 'width', 'height', 'fps', 'clips', 'srt'], 'project');
  string(spec.name, 'name');
  string(output, 'output');
  if (!Array.isArray(spec.clips)) fail('INVALID_INPUT', 'clips must be an array');
  let clips = clone(spec.clips);
  if (spec.srt !== undefined) {
    keys(spec.srt, ['path', 'offset', 'track'], 'srt');
    clips.push(...parseSrt(fs.readFileSync(string(spec.srt.path, 'srt.path'), 'utf8'), spec.srt));
  }
  return withOutputAsync(output, null, async (stage, dest) => {
    const { data, assets } = await generate(clips, stage, dest, spec);
    data.name = spec.name;
    const errors = validateData(data).errors;
    if (errors.length) fail('INVALID_DRAFT', 'Generated draft failed validation', errors);
    fs.mkdirSync(path.join(stage, 'materials'), { recursive: true });
    for (const asset of assets) fs.renameSync(asset, path.join(stage, 'materials', path.basename(asset)));
    fs.rmSync(path.join(stage, 'payload'), { recursive: true, force: true });
    writeJSON(path.join(stage, 'draft_info.json'), data);
    const meta = { draft_id: data.id, draft_name: spec.name, draft_fold_path: dest, draft_root_path: path.dirname(dest), draft_json_file: path.join(dest, 'draft_info.json'), draft_is_invisible: false, draft_type: '', tm_duration: data.duration, tm_draft_create: Date.now() * 1000, tm_draft_modified: Date.now() * 1000, tm_draft_removed: 0, draft_materials: [{ type: 0, value: [] }, { type: 1, value: [] }, { type: 2, value: [] }, { type: 3, value: [] }, { type: 6, value: [] }, { type: 7, value: [] }, { type: 8, value: [] }] };
    writeJSON(path.join(stage, 'draft_meta_info.json'), meta);
    fs.writeFileSync(path.join(stage, 'draft_settings'), `[General]\ndraft_create_time=${Math.floor(Date.now() / 1000)}\ndraft_last_edit_time=${Math.floor(Date.now() / 1000)}\n`);
    writeJSON(path.join(stage, 'key_value.json'), {});
    return { draftPath: dest, projectId: data.id, duration: data.duration / US, clips: clips.length, encoding: 'plaintext', nativeVerified: false };
  });
}

export { createDraft as buildDraft };
