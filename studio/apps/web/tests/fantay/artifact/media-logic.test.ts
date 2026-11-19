// SPDX-License-Identifier: AGPL-3.0-only
// The pure parts of the audio and video viewers: clocks and sizing, the audio header reader, and
// the reduction of samples to a waveform.
import { describe, expect, it } from 'vitest';

import { probeAudio } from '../../../src/fantay/artifact/viewers/media/audio-probe';
import {
  bufferedEnd,
  clampTime,
  fitMedia,
  formatMediaTime,
  formatRate,
  formatSampleRate,
  fractionAt,
  nextRate,
  resumeTime,
} from '../../../src/fantay/artifact/viewers/media/media-time';
import { PEAK_BUCKETS, barsFromPeaks, peaksFromChannels, peaksFromPcm } from '../../../src/fantay/artifact/viewers/media/peaks';
import { memoryMediaType, servedInRanges } from '../../../src/fantay/artifact/viewers/media/use-memory-source';

function bytesOf(...parts: Array<string | number[]>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') for (const char of part) out.push(char.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array(out);
}

function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function le16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** A 16-bit PCM WAV with the given interleaved samples. */
function wav(samples: number[], channels: number, sampleRate: number): Uint8Array {
  const data: number[] = [];
  for (const sample of samples) data.push(...le16(sample & 0xffff));
  return bytesOf(
    'RIFF',
    le32(36 + data.length),
    'WAVE',
    'fmt ',
    le32(16),
    le16(1),
    le16(channels),
    le32(sampleRate),
    le32(sampleRate * channels * 2),
    le16(channels * 2),
    le16(16),
    'data',
    le32(data.length),
    data,
  );
}

/** An MP4 box: size, four-letter type, body. */
function box(type: string, ...body: Array<string | number[]>): number[] {
  const content = [...bytesOf(...body)];
  return [...be32(content.length + 8), ...bytesOf(type), ...content];
}

describe('media clock', () => {
  it('writes minutes and seconds, and hours from an hour on', () => {
    expect(formatMediaTime(0)).toBe('0:00');
    expect(formatMediaTime(222.9)).toBe('3:42');
    expect(formatMediaTime(3822)).toBe('1:03:42');
  });

  it('gives the elapsed time the shape of the duration next to it', () => {
    expect(formatMediaTime(310, 3822)).toBe('0:05:10');
    expect(formatMediaTime(310, 600)).toBe('5:10');
  });

  it('treats a time it cannot read as zero', () => {
    expect(formatMediaTime(Number.NaN)).toBe('0:00');
    expect(formatMediaTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatMediaTime(-4)).toBe('0:00');
  });

  it('labels speeds and sample rates without trailing zeros', () => {
    expect(formatRate(1)).toBe('1×');
    expect(formatRate(1.25)).toBe('1.25×');
    expect(formatRate(0.5)).toBe('0.5×');
    expect(formatSampleRate(44100)).toBe('44.1 kHz');
    expect(formatSampleRate(48000)).toBe('48 kHz');
    expect(formatSampleRate(22050)).toBe('22.05 kHz');
  });

  it('steps through the speeds and stops at both ends', () => {
    expect(nextRate(1, 1)).toBe(1.25);
    expect(nextRate(1, -1)).toBe(0.5);
    expect(nextRate(2, 1)).toBe(2);
    expect(nextRate(0.5, -1)).toBe(0.5);
    expect(nextRate(1.1, 1)).toBe(1);
  });
});

describe('where playback resumes', () => {
  it('goes back to the saved place', () => {
    expect(resumeTime(42.5, 180)).toBe(42.5);
  });

  it('starts over when the file had been played to its end', () => {
    expect(resumeTime(179.8, 180)).toBe(0);
    expect(resumeTime(500, 180)).toBe(0);
  });

  it('starts at the beginning when nothing usable was saved', () => {
    expect(resumeTime(undefined, 180)).toBe(0);
    expect(resumeTime(Number.NaN, 180)).toBe(0);
    expect(resumeTime(12, 0)).toBe(0);
  });

  it('keeps a seek inside the file', () => {
    expect(clampTime(-5, 60)).toBe(0);
    expect(clampTime(75, 60)).toBe(60);
    expect(clampTime(30, 60)).toBe(30);
    expect(clampTime(30, 0)).toBe(30);
  });
});

describe('fitting a film to the stage', () => {
  it('scales a large film down to the width', () => {
    expect(fitMedia({ width: 1920, height: 1080 }, { width: 768, height: 800 }, 24)).toEqual({ width: 720, height: 405 });
  });

  it('lets the height decide for a vertical film', () => {
    expect(fitMedia({ width: 1080, height: 1920 }, { width: 768, height: 688 }, 24)).toEqual({ width: 360, height: 640 });
  });

  it('scales a small film up: it is watched, not inspected', () => {
    expect(fitMedia({ width: 320, height: 180 }, { width: 688, height: 800 }, 24)).toEqual({ width: 640, height: 360 });
  });

  it('never returns an empty box for a real picture, and nothing for no picture', () => {
    expect(fitMedia({ width: 1920, height: 1080 }, { width: 10, height: 10 }, 24)).toEqual({ width: 1, height: 1 });
    expect(fitMedia({ width: 0, height: 0 }, { width: 600, height: 400 }, 24)).toEqual({ width: 0, height: 0 });
  });
});

describe('scrubber sums', () => {
  it('finds the end of the loaded stretch under the playhead', () => {
    const ranges = [
      { start: 0, end: 12 },
      { start: 40, end: 55 },
    ];
    expect(bufferedEnd(ranges, 5)).toBe(12);
    expect(bufferedEnd(ranges, 41)).toBe(55);
    expect(bufferedEnd(ranges, 20)).toBe(20);
    expect(bufferedEnd([], 7)).toBe(7);
  });

  it('turns a pointer position into a fraction of the track', () => {
    expect(fractionAt(150, 100, 200)).toBe(0.25);
    expect(fractionAt(50, 100, 200)).toBe(0);
    expect(fractionAt(900, 100, 200)).toBe(1);
    expect(fractionAt(150, 100, 0)).toBe(0);
  });
});

describe('audio header', () => {
  it('reads a WAV and says where its samples are', () => {
    const probe = probeAudio(wav([0, 0, 100, -100], 2, 44100));
    expect(probe).toMatchObject({ container: 'wav', sampleRate: 44100, channels: 2 });
    expect(probe?.pcm).toEqual({ offset: 44, length: 8, channels: 2, bits: 16, float: false });
  });

  it('does not offer the samples of a compressed WAV', () => {
    const file = wav([0, 0], 1, 8000);
    file[20] = 0x55; // format tag 0x0055: MP3 inside a WAV container
    const probe = probeAudio(file);
    expect(probe).toMatchObject({ container: 'wav', sampleRate: 8000, channels: 1 });
    expect(probe?.pcm).toBeUndefined();
  });

  it('reads FLAC stream information, also behind an ID3 tag', () => {
    // Rate 48000 (20 bits), channels - 1 = 1 (3 bits), bits - 1 = 15 (5 bits), then the sample count.
    const packed = (48000 << 12) | (1 << 9) | (15 << 4);
    const flac = bytesOf('fLaC', [0x00, 0, 0, 34], new Array<number>(10).fill(0), be32(packed >>> 0), new Array<number>(20).fill(0));
    expect(probeAudio(flac)).toEqual({ container: 'flac', sampleRate: 48000, channels: 2 });
    const tagged = bytesOf('ID3', [4, 0, 0, 0, 0, 0, 6], [1, 2, 3, 4, 5, 6], [...flac]);
    expect(probeAudio(tagged)).toEqual({ container: 'flac', sampleRate: 48000, channels: 2 });
  });

  it('reads the first MP3 frame after the ID3 tag', () => {
    // MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo.
    const stereo = bytesOf('ID3', [3, 0, 0, 0, 0, 0, 4], [0xff, 0xff, 0xff, 0xff], [0xff, 0xfb, 0x90, 0x64], new Array<number>(16).fill(0));
    expect(probeAudio(stereo)).toEqual({ container: 'mp3', sampleRate: 44100, channels: 2 });
    // MPEG-2 Layer III, 22.05 kHz, mono.
    const mono = bytesOf([0xff, 0xf3, 0x40, 0xc4], new Array<number>(16).fill(0));
    expect(probeAudio(mono)).toEqual({ container: 'mp3', sampleRate: 22050, channels: 1 });
  });

  it('reads Ogg Vorbis and Ogg Opus identification packets', () => {
    const page = (packet: number[]): Uint8Array => bytesOf('OggS', new Array<number>(22).fill(0), [1, packet.length], packet);
    const vorbis = page([1, ...bytesOf('vorbis'), ...le32(0), 2, ...le32(44100), ...new Array<number>(16).fill(0)]);
    expect(probeAudio(vorbis)).toEqual({ container: 'ogg', sampleRate: 44100, channels: 2 });
    const opus = page([...bytesOf('OpusHead'), 1, 1, ...le16(312), ...le32(16000), 0, 0, 0]);
    // Opus plays at 48 kHz whatever the recording's rate was.
    expect(probeAudio(opus)).toEqual({ container: 'ogg', sampleRate: 48000, channels: 1 });
  });

  it('finds the sample description inside an MP4', () => {
    const entry = box('mp4a', new Array<number>(8).fill(0), new Array<number>(8).fill(0), [0, 2], [0, 16], [0, 0, 0, 0], be32(44100 * 65536));
    const stsd = box('stsd', be32(0), be32(1), entry);
    const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))));
    const file = new Uint8Array([...box('ftyp', 'M4A ', be32(0)), ...moov]);
    expect(probeAudio(file)).toEqual({ container: 'mp4', sampleRate: 44100, channels: 2 });
  });

  it('reads the length a file states about itself', () => {
    // WAV: one second of 16-bit stereo at 8 kHz is 32000 bytes of samples.
    expect(probeAudio(wav(new Array<number>(16000).fill(0), 2, 8000))?.duration).toBeCloseTo(1, 6);

    // FLAC: 96000 samples at 48 kHz.
    const packed = (48000 << 12) | (1 << 9) | (15 << 4);
    const flac = bytesOf('fLaC', [0x00, 0, 0, 34], new Array<number>(10).fill(0), be32(packed >>> 0), be32(96000), new Array<number>(16).fill(0));
    expect(probeAudio(flac)?.duration).toBeCloseTo(2, 6);

    // Ogg: the last page says where the final sample is. A page on which no packet ends (all ones)
    // is passed over for the one before it.
    const page = (position: number[], packet: number[]): number[] => [
      ...bytesOf('OggS'),
      0,
      0,
      ...position,
      ...new Array<number>(12).fill(0),
      1,
      packet.length,
      ...packet,
    ];
    const head = [1, ...bytesOf('vorbis'), ...le32(0), 2, ...le32(44100), ...new Array<number>(16).fill(0)];
    const vorbis = new Uint8Array([
      ...page(new Array<number>(8).fill(0), head),
      ...page([...le32(441000), 0, 0, 0, 0], [1, 2, 3]),
      ...page(new Array<number>(8).fill(0xff), [4, 5, 6]),
    ]);
    expect(probeAudio(vorbis)?.duration).toBeCloseTo(10, 6);

    // Opus counts at 48 kHz from before the samples the decoder skips.
    const opusHead = [...bytesOf('OpusHead'), 1, 2, ...le16(480), ...le32(44100), 0, 0, 0];
    const opus = new Uint8Array([...page(new Array<number>(8).fill(0), opusHead), ...page([...le32(48480), 0, 0, 0, 0], [1])]);
    expect(probeAudio(opus)).toEqual({ container: 'ogg', sampleRate: 48000, channels: 2, duration: 1 });
  });

  it('answers null for bytes it does not know and survives a truncated header', () => {
    expect(probeAudio(new Uint8Array(64))).toBeNull();
    expect(probeAudio(bytesOf('RIFF', le32(4), 'WAVE'))).toBeNull();
    expect(probeAudio(bytesOf('fLaC', [0, 0, 0, 34]))).toBeNull();
    expect(probeAudio(new Uint8Array(4))).toBeNull();
  });

  it('gives up on an MP4 whose boxes do not add up', () => {
    const file = new Uint8Array([...box('ftyp', 'M4A ', be32(0)), ...be32(4), ...bytesOf('moov')]);
    expect(probeAudio(file)).toEqual({ container: 'mp4', sampleRate: 0, channels: 0 });
  });
});

describe('waveform peaks', () => {
  it('keeps the shape of the file: quiet stays low, loud reaches the top', () => {
    const channel = new Float32Array(8000);
    for (let index = 0; index < channel.length; index += 1) {
      const loud = index >= 4000;
      channel[index] = Math.sin(index / 3) * (loud ? 0.8 : 0.1);
    }
    const peaks = peaksFromChannels([channel], 8);
    expect(peaks).toHaveLength(8);
    expect(Math.max(...peaks)).toBeCloseTo(1, 5);
    for (let index = 0; index < 4; index += 1) expect(peaks[index]).toBeLessThan(0.2);
    for (let index = 4; index < 8; index += 1) expect(peaks[index]).toBeGreaterThan(0.9);
  });

  it('shows a channel that only one side plays', () => {
    const left = new Float32Array(1000);
    const right = new Float32Array(1000).fill(0.5);
    expect(Math.max(...peaksFromChannels([left, right], 4))).toBeCloseTo(1, 5);
  });

  it('draws silence as silence', () => {
    const peaks = peaksFromChannels([new Float32Array(4096)], 16);
    expect([...peaks].every((value) => value === 0)).toBe(true);
  });

  it('never makes more values than there are frames, and has a default size', () => {
    expect(peaksFromChannels([new Float32Array(3).fill(1)], 16)).toHaveLength(3);
    expect(peaksFromChannels([new Float32Array(5000).fill(0.2)])).toHaveLength(PEAK_BUCKETS);
    expect(peaksFromChannels([], 16)).toHaveLength(16);
  });

  it('reads 16-bit samples straight from a WAV', () => {
    const samples: number[] = [];
    for (let frame = 0; frame < 400; frame += 1) {
      const value = frame < 200 ? 1000 : 30000;
      samples.push(frame % 2 === 0 ? value : -value, 0);
    }
    const file = wav(samples, 2, 44100);
    const layout = probeAudio(file)?.pcm;
    expect(layout).toBeDefined();
    const peaks = peaksFromPcm(file, layout!, 4);
    expect(peaks[0]).toBeLessThan(0.1);
    expect(peaks[3]).toBeCloseTo(1, 5);
  });

  it('reads 8-bit, 24-bit and float samples', () => {
    const eight = new Uint8Array([128, 128, 255, 0]);
    expect([...peaksFromPcm(eight, { offset: 0, length: 4, channels: 1, bits: 8, float: false }, 2)]).toEqual([0, 1]);
    // 24-bit little-endian: 0, then -8388608 (the loudest value).
    const twentyFour = new Uint8Array([0, 0, 0, 0x00, 0x00, 0x80]);
    expect([...peaksFromPcm(twentyFour, { offset: 0, length: 6, channels: 1, bits: 24, float: false }, 2)]).toEqual([0, 1]);
    const float = new Uint8Array(new Float32Array([0, -0.5]).buffer);
    expect([...peaksFromPcm(float, { offset: 0, length: 8, channels: 1, bits: 32, float: true }, 2)]).toEqual([0, 1]);
  });

  it('stops at the end of the bytes when the header claims more', () => {
    const file = wav([20000, -20000], 1, 8000);
    const peaks = peaksFromPcm(file, { offset: 44, length: 1_000_000, channels: 1, bits: 16, float: false }, 4);
    expect(peaks).toHaveLength(2);
  });

  it('resamples to the bars that fit and fills the height again', () => {
    const peaks = new Float32Array([0.1, 0.1, 0.5, 0.3, 1, 0.2, 0, 0]);
    const bars = barsFromPeaks(peaks, 4);
    expect(bars).toHaveLength(4);
    expect(Math.max(...bars)).toBeCloseTo(1, 5);
    expect(bars[0]).toBeLessThan(bars[1] ?? 0);
    expect(bars[3]).toBe(0);
    expect(barsFromPeaks(peaks, 0)).toHaveLength(0);
    expect(barsFromPeaks(new Float32Array(0), 4)).toHaveLength(4);
  });
});

describe('playing from memory', () => {
  it('plays from the address only what the server labels as audio or video', () => {
    expect(servedInRanges({ mime: 'audio/mpeg' })).toBe(true);
    expect(servedInRanges({ mime: 'video/mp4' })).toBe(true);
    expect(servedInRanges({ mime: 'application/octet-stream' })).toBe(false);
    expect(servedInRanges({ mime: '' })).toBe(false);
  });

  it('names the type of the formats that arrive unlabelled', () => {
    expect(memoryMediaType('flac')).toBe('audio/flac');
    expect(memoryMediaType('opus')).toBe('audio/ogg');
    expect(memoryMediaType('ogv')).toBe('video/ogg');
    expect(memoryMediaType('mp3')).toBe('');
  });
});
