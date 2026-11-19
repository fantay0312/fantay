import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { movieFfmpeg, transcribeLocalAudio } from '../movie/video-sources.js';
import { PaError } from '../storage/personal-agent-store.js';

const exec = promisify(execFile);
const MAX_ENCODED_BYTES = 2 * 1024 * 1024;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
let transcribing = false;

export function paAudioFormat(bytes: Buffer): string | null {
  if (bytes.length < 4) return null;
  const header = bytes.toString('ascii', 0, 12);
  if (header.startsWith('#!SILK_V3') || header.startsWith('\x02#!SILK_V3')) return 'silk';
  if (bytes.readUInt32BE(0) === 0x1a45dfa3) return 'matroska';
  if (header.startsWith('OggS')) return 'ogg';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WAVE') return 'wav';
  if (header.slice(4, 8) === 'ftyp') return 'mov';
  if (header.startsWith('fLaC')) return 'flac';
  if (header.startsWith('#!AMR')) return 'amr';
  if (header.startsWith('ID3')) return 'mp3';
  if (bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return 'aac';
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 6) !== 0) return 'mp3';
  return null;
}

export async function transcribePaVoice(dataDir: string, audio: unknown, format: unknown, signal: AbortSignal): Promise<{ text: string }> {
  if (format !== 'webm' || typeof audio !== 'string' || audio.length > MAX_ENCODED_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio))
    throw new PaError('请输入有效的 WebM 录音');
  const bytes = Buffer.from(audio, 'base64');
  if (paAudioFormat(bytes) !== 'matroska') throw new PaError('无法读取录音格式');
  return transcribePaAudioFile(dataDir, bytes, signal);
}

export async function transcribePaAudioFile(dataDir: string, bytes: Buffer, signal: AbortSignal, pcmSampleRate?: number): Promise<{ text: string }> {
  const rawPcm = pcmSampleRate !== undefined && [8000, 12000, 16000, 24000, 32000, 44100, 48000].includes(pcmSampleRate);
  const format = rawPcm ? 's16le' : paAudioFormat(bytes);
  if (!format || !bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new PaError('无法读取录音或文件超过大小上限', 422);
  if (transcribing) throw new PaError('正在处理另一段录音，请稍后再试', 409);
  transcribing = true;
  let dir: string | undefined;
  try {
    const root = path.join(dataDir, 'pa', 'voice');
    await mkdir(root, { recursive: true });
    dir = await mkdtemp(path.join(root, 'capture-'));
    const source = path.join(dir, 'input.audio');
    const wav = path.join(dir, 'speech.wav');
    let input: Uint8Array = bytes;
    if (format === 'silk') {
      const { decode, getDuration } = await import('silk-wasm');
      const duration = getDuration(bytes);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 60_500) throw new PaError('每段录音最多 60 秒');
      input = (await decode(bytes, 16000)).data;
    }
    await writeFile(source, input, { mode: 0o600, signal });
    const pcmArgs = format === 'silk' || rawPcm ? ['-ar', String(rawPcm ? pcmSampleRate : 16000), '-ac', '1'] : [];
    await exec(movieFfmpeg(), [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file',
      '-f', format === 'silk' ? 's16le' : format, ...pcmArgs, '-i', source, '-map', '0:a:0',
      '-t', '61', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
    ], { timeout: 15000, maxBuffer: 128 * 1024, signal });
    if ((await stat(wav)).size > 60.5 * 16000 * 2 + 128) throw new PaError('每段录音最多 60 秒');
    await transcribeLocalAudio(wav, dir, 'auto', signal);
    const words: unknown = JSON.parse(await readFile(path.join(dir, 'transcript.json'), { encoding: 'utf8', signal }));
    const text = (Array.isArray(words) ? words : []).map((word: { text?: unknown; word?: unknown }) => {
      const value = word?.text ?? word?.word;
      return typeof value === 'string' && !/^\s*(?:\[[^\]]+\]|[♪♫]+)\s*$/.test(value) ? value.trim() : '';
    }).filter(Boolean).join(' ').replace(/(\p{Script=Han}) (?=\p{Script=Han})/gu, '$1').trim();
    if (!text) throw new PaError('没有识别到清晰的语音，请重新录制', 422);
    return { text: text.slice(0, 32000) };
  } catch (error) {
    if (error instanceof PaError) throw error;
    throw new PaError('本机语音转写失败，请检查录音和本地 Whisper 环境后重试', 422);
  } finally {
    try {
      if (dir) await rm(dir, { recursive: true, force: true });
    } finally {
      transcribing = false;
    }
  }
}
