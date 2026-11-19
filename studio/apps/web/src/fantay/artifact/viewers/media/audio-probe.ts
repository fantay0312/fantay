// SPDX-License-Identifier: AGPL-3.0-only
// What an audio file says about itself in its first bytes: sample rate, channels, and for WAV where
// the samples are, so the waveform can be read straight from the file. The browser's decoder would
// answer with its own output rate, not the file's, so the header is the truthful source for the
// facts shown in the bar. Every read is bounds-checked: the file is untrusted. Pure: no DOM.

export interface PcmLayout {
  /** Byte offset of the first sample. */
  offset: number;
  /** Bytes of sample data. */
  length: number;
  channels: number;
  /** 8, 16, 24 or 32. */
  bits: number;
  float: boolean;
}

export interface AudioProbe {
  container: 'wav' | 'flac' | 'mp3' | 'aac' | 'ogg' | 'mp4';
  /** Hz; 0 when the header does not say. */
  sampleRate: number;
  /** 0 when the header does not say. */
  channels: number;
  /** Seconds, when the file itself states its length (WAV, FLAC, Ogg). */
  duration?: number;
  /** Set when the samples are plain PCM that can be read without a decoder. */
  pcm?: PcmLayout;
}

const MAX_BOXES = 4096;

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}

/** Length of a leading ID3v2 tag (MP3, and sometimes FLAC and AAC, carry one before the audio). */
function id3Length(bytes: Uint8Array): number {
  if (!ascii(bytes, 0, 'ID3') || bytes.length < 10) return 0;
  const size = ((bytes[6] ?? 0) & 0x7f) << 21 | ((bytes[7] ?? 0) & 0x7f) << 14 | ((bytes[8] ?? 0) & 0x7f) << 7 | ((bytes[9] ?? 0) & 0x7f);
  const footer = ((bytes[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

function probeWav(bytes: Uint8Array, view: DataView): AudioProbe | null {
  if (!ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WAVE')) return null;
  let offset = 12;
  let format: { tag: number; channels: number; sampleRate: number; bits: number } | null = null;
  for (let guard = 0; guard < MAX_BOXES && offset + 8 <= bytes.length; guard += 1) {
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (ascii(bytes, offset, 'fmt ') && body + 16 <= bytes.length) {
      let tag = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of its sub-format id.
      if (tag === 0xfffe && size >= 26 && body + 26 <= bytes.length) tag = view.getUint16(body + 24, true);
      format = {
        tag,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (ascii(bytes, offset, 'data') && format) {
      const probe: AudioProbe = { container: 'wav', sampleRate: format.sampleRate, channels: format.channels };
      const plain = (format.tag === 1 && [8, 16, 24, 32].includes(format.bits)) || (format.tag === 3 && format.bits === 32);
      if (plain && format.channels > 0 && format.channels <= 32) {
        // A streamed WAV can declare a size of 0 or 0xFFFFFFFF: the data then runs to the end.
        const length = Math.min(size === 0 || size === 0xffffffff ? Infinity : size, bytes.length - body);
        probe.pcm = { offset: body, length, channels: format.channels, bits: format.bits, float: format.tag === 3 };
        const bytesPerSecond = format.sampleRate * format.channels * (format.bits / 8);
        if (bytesPerSecond > 0 && length > 0) probe.duration = length / bytesPerSecond;
      }
      return probe;
    }
    offset = body + size + (size % 2);
  }
  return format ? { container: 'wav', sampleRate: format.sampleRate, channels: format.channels } : null;
}

function probeFlac(bytes: Uint8Array, view: DataView, start: number): AudioProbe | null {
  // 'fLaC', a 4-byte block header, then STREAMINFO: rate (20 bits) and channels - 1 (3 bits) at +10.
  if (!ascii(bytes, start, 'fLaC') || start + 4 + 4 + 18 > bytes.length) return null;
  if (((bytes[start + 4] ?? 0) & 0x7f) !== 0) return null;
  const packed = view.getUint32(start + 8 + 10);
  const probe: AudioProbe = { container: 'flac', sampleRate: packed >>> 12, channels: ((packed >>> 9) & 0x7) + 1 };
  // The sample count is 36 bits: the last four of this word, then the next word.
  const samples = (packed & 0xf) * 4294967296 + view.getUint32(start + 8 + 14);
  if (samples > 0 && probe.sampleRate > 0) probe.duration = samples / probe.sampleRate;
  return probe;
}

const MPEG_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** The first MPEG audio (MP3) or ADTS (AAC) frame header within a short reach of `start`. */
function probeFrames(bytes: Uint8Array, start: number): AudioProbe | null {
  const end = Math.min(bytes.length - 4, start + 64 * 1024);
  for (let offset = Math.max(0, start); offset <= end; offset += 1) {
    if (bytes[offset] !== 0xff) continue;
    const b1 = bytes[offset + 1] ?? 0;
    const b2 = bytes[offset + 2] ?? 0;
    const b3 = bytes[offset + 3] ?? 0;
    if ((b1 & 0xe0) !== 0xe0) continue;
    const layer = (b1 >> 1) & 0x3;
    if (layer === 0) {
      // ADTS: 12 sync bits, layer 0, then the rate index and a channel layout that spans two bytes.
      if ((b1 & 0xf0) !== 0xf0) continue;
      const sampleRate = ADTS_RATES[(b2 >> 2) & 0xf];
      const channels = ((b2 & 0x1) << 2) | (b3 >> 6);
      if (!sampleRate) continue;
      return { container: 'aac', sampleRate, channels: channels === 7 ? 8 : channels };
    }
    const version = (b1 >> 3) & 0x3;
    const bitrate = b2 >> 4;
    const sampleRate = MPEG_RATES[version]?.[(b2 >> 2) & 0x3];
    if (!sampleRate || bitrate === 0 || bitrate === 0xf) continue;
    return { container: 'mp3', sampleRate, channels: b3 >> 6 === 3 ? 1 : 2 };
  }
  return null;
}

/**
 * An Ogg stream's length is not in its header: the last page carries the position of its final
 * sample. Pages start with 'OggS'; the position is the 64-bit number six bytes in.
 */
function oggLastPosition(bytes: Uint8Array, view: DataView): number {
  const floor = Math.max(0, bytes.length - 128 * 1024);
  for (let offset = bytes.length - 14; offset >= floor; offset -= 1) {
    if (bytes[offset] !== 0x4f || !ascii(bytes, offset, 'OggS')) continue;
    const position = view.getBigUint64(offset + 6, true);
    // All ones marks a page on which no packet ends: the page before it has the answer.
    if (position !== 0xffffffffffffffffn) return Number(position);
  }
  return 0;
}

function probeOgg(bytes: Uint8Array, view: DataView): AudioProbe | null {
  if (!ascii(bytes, 0, 'OggS') || bytes.length < 28) return null;
  // The first page holds the codec's identification packet right after the segment table.
  const body = 27 + (bytes[26] ?? 0);
  const last = oggLastPosition(bytes, view);
  if (ascii(bytes, body + 1, 'vorbis') && body + 16 <= bytes.length) {
    const probe: AudioProbe = { container: 'ogg', sampleRate: view.getUint32(body + 12, true), channels: bytes[body + 11] ?? 0 };
    if (last > 0 && probe.sampleRate > 0) probe.duration = last / probe.sampleRate;
    return probe;
  }
  if (ascii(bytes, body, 'OpusHead') && body + 12 <= bytes.length) {
    // Opus always plays at 48 kHz, whatever rate the recording was made at; positions count from
    // before the "pre-skip" samples the decoder throws away.
    const probe: AudioProbe = { container: 'ogg', sampleRate: 48000, channels: bytes[body + 9] ?? 0 };
    const samples = last - view.getUint16(body + 10, true);
    if (samples > 0) probe.duration = samples / 48000;
    return probe;
  }
  if (ascii(bytes, body + 1, 'FLAC')) {
    // 0x7F 'FLAC', a version and a header count (4 bytes), then an ordinary FLAC stream header.
    const flac = probeFlac(bytes, view, body + 9);
    if (flac) return { ...flac, container: 'ogg' };
  }
  return { container: 'ogg', sampleRate: 0, channels: 0 };
}

/** Boxes that contain the sample description, from the outside in. */
const MP4_PATH = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function probeMp4(bytes: Uint8Array, view: DataView): AudioProbe | null {
  if (!ascii(bytes, 4, 'ftyp')) return null;
  let visited = 0;
  const walk = (start: number, end: number, depth: number): AudioProbe | null => {
    let offset = start;
    while (offset + 8 <= end) {
      visited += 1;
      if (visited > MAX_BOXES || depth > 8) return null;
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return null;
        size = Number(view.getBigUint64(offset + 8));
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) return null;
      const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0);
      if (MP4_PATH.has(type)) {
        const found = walk(offset + header, offset + size, depth + 1);
        if (found) return found;
      } else if (type === 'stsd') {
        // Version and flags (4), entry count (4), then the first entry: size (4), format (4),
        // 6 reserved, data reference (2), 8 reserved, channels (2), bits (2), 4, rate (16.16).
        const entry = offset + header + 8;
        if (entry + 36 <= offset + size) {
          const format = String.fromCharCode(bytes[entry + 4] ?? 0, bytes[entry + 5] ?? 0, bytes[entry + 6] ?? 0, bytes[entry + 7] ?? 0);
          if (['mp4a', 'alac', 'Opus', 'fLaC', 'ac-3', 'ec-3'].includes(format)) {
            return { container: 'mp4', sampleRate: view.getUint32(entry + 32) >>> 16, channels: view.getUint16(entry + 24) };
          }
        }
      }
      offset += size;
    }
    return null;
  };
  return walk(0, bytes.length, 0) ?? { container: 'mp4', sampleRate: 0, channels: 0 };
}

/** Reads the header. Null when the bytes are none of the formats known here. */
export function probeAudio(source: ArrayBuffer | Uint8Array): AudioProbe | null {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const tag = id3Length(bytes);
    return (
      probeWav(bytes, view) ??
      probeFlac(bytes, view, tag) ??
      probeOgg(bytes, view) ??
      probeMp4(bytes, view) ??
      probeFrames(bytes, tag)
    );
  } catch {
    // A read past the end of a truncated header.
    return null;
  }
}
