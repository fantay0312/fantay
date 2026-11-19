import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveDaemonUrl } from '../daemon-url.js';

export async function runVoiceInputCli(args: string[]): Promise<void> {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
      'daemon-url': { type: 'string' }, 'config-file': { type: 'string' }, file: { type: 'string' },
    } });
    const command = positionals[0];
    if (values.help || !command) {
      console.log('Usage: od voice <settings|models|configure|transcribe> [--json]\n  configure --config-file <path|->\n  transcribe --file <recording.wav|webm|ogg|mp4>\n  Optional: --daemon-url <url>');
      return;
    }
    const base = (await resolveDaemonUrl({ flagUrl: values['daemon-url'] ?? null })).replace(/\/$/, '');
    let route: string = command;
    let options: RequestInit = {};
    if (command === 'configure') {
      if (!values['config-file']) throw new Error('--config-file is required');
      const content = readFileSync(values['config-file'] === '-' ? 0 : values['config-file'], 'utf8');
      let body: unknown;
      try { body = JSON.parse(content); }
      catch { throw new Error('The configuration file must contain valid JSON.'); }
      route = 'settings';
      options = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    } else if (command === 'transcribe') {
      if (!values.file) throw new Error('--file is required');
      const form = new FormData();
      form.set('file', new Blob([readFileSync(values.file)]), path.basename(values.file));
      options = { method: 'POST', body: form, signal: AbortSignal.timeout(200_000) };
    } else if (!['settings', 'models'].includes(command)) throw new Error(`Unknown voice command: ${command}`);
    const response = await fetch(`${base}/api/voice-input/${route}`, options);
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Voice input command failed');
    process.exitCode = 2;
  }
}
