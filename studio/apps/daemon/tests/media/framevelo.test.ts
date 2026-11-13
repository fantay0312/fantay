import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { frameVeloAssetBase, frameVeloEligibility, injectFrameVeloDriver, validateFrameVeloProbe } from '../../src/media/framevelo.js';

describe('optional FrameVelo admission', () => {
  it('admits motion/captions, but retains standard footage and unprepared audio', () => {
    expect(frameVeloEligibility('<main><span>你好</span></main>')).toBeNull();
    expect(frameVeloEligibility('<video src="clip.mp4"></video>')).toMatch(/standard/);
    expect(frameVeloEligibility('<audio src="voice.wav"></audio>')).toMatch(/standard/);
  });
  it('uses the common clock without adding time offsets to captions', () => {
    const html = injectFrameVeloDriver('<html><head></head><body></body></html>', 9.7, 30);
    expect(html).toContain('<head><base href="/source/">');
    expect(html).toContain('duration:9.7,fps:30');
    expect(html).toContain('await window.__odFrameRenderer.seek(t)');
  });
  it('keeps parent-relative project assets and rejects missing or escaping files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'framevelo-assets-'));
    try {
      const source = path.join(root, 'motion', 'film');
      await mkdir(source, { recursive: true });
      await writeFile(path.join(root, 'motion', 'image.png'), 'fixture');
      await expect(frameVeloAssetBase('<img src="../image.png">', source, root)).resolves.toBe('/source/motion/film/');
      await expect(frameVeloAssetBase('<img src="../missing.png">', source, root)).rejects.toThrow(/unavailable/);
      await expect(frameVeloAssetBase('<img src="../../../outside.png">', source, root)).rejects.toThrow(/unavailable/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('checks the video track even when valid audio conceals a wrong container duration', () => {
    const expected = { frames: 291, fps: 30, width: 1920, height: 1080, audio: true };
    const video = { codec_type: 'video', nb_read_frames: '291', width: 1920, height: 1080, duration: '0.058854', color_space: 'bt709', color_transfer: 'iec61966-2-1', color_primaries: 'bt709' };
    const audio = { codec_type: 'audio', duration: '9.7' };
    const result = { format: { duration: '9.7' }, streams: [video, audio] };
    expect(() => validateFrameVeloProbe(result, expected)).toThrow(/timestamps/);
    video.duration = '9.7';
    expect(() => validateFrameVeloProbe(result, expected)).not.toThrow();
    video.color_transfer = 'bt709';
    expect(() => validateFrameVeloProbe(result, expected)).toThrow(/color contract/);
    video.color_transfer = 'iec61966-2-1';
    audio.duration = 'invalid';
    expect(() => validateFrameVeloProbe(result, expected)).toThrow(/audio/);
    video.nb_read_frames = '290';
    expect(() => validateFrameVeloProbe(result, expected)).toThrow(/frame count/);
  });
});
