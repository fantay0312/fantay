import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { movieFfmpeg, transcribeLocalAudio } from '../movie/video-sources.js';
import { PaError } from '../storage/personal-agent-store.js';

const exec = promisify(execFile);
const MAX_ENCODED_BYTES = 2 * 1024 * 1024;
let transcribing = false;

export async function transcribePaVoice(dataDir: string, audio: unknown, format: unknown, signal: AbortSignal): Promise<{ text: string }> {
  if (format !== 'webm' || typeof audio !== 'string' || audio.length > MAX_ENCODED_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio))
    throw new PaError('请输入有效的 WebM 录音');
  const bytes = Buffer.from(audio, 'base64');
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== 0x1a45dfa3) throw new PaError('无法读取录音格式');
  if (transcribing) throw new PaError('正在处理另一段录音，请稍后再试', 409);
  transcribing = true;
  let dir: string | undefined;
  try {
    const root = path.join(dataDir, 'pa', 'voice');
    await mkdir(root, { recursive: true });
    dir = await mkdtemp(path.join(root, 'capture-'));
    const source = path.join(dir, 'input.webm');
    const wav = path.join(dir, 'speech.wav');
    await writeFile(source, bytes, { mode: 0o600, signal });
    await exec(movieFfmpeg(), [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file',
      '-f', 'matroska', '-i', source, '-map', '0:a:0',
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
