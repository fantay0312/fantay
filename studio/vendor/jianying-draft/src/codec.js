import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { digest, json, fail } from './common.js';

export function nativeCodec() {
  const root = fileURLToPath(new URL('../.tmp/native/', import.meta.url));
  const binary = path.join(root, 'fantay-jy-codec');
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !fs.existsSync(path.join(root, 'runtime.json'))) {
    fail('NATIVE_UNAVAILABLE', 'Build the optional local codec with mise run build-codec first');
  }
  const manifest = json(path.join(root, 'runtime.json'));
  const plist = path.join(manifest.app, 'Contents/Info.plist');
  const version = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], { encoding: 'utf8' }).trim();
  if (version !== '11.6.0' || version !== manifest.version || digest(binary) !== manifest.binarySha256 ||
      digest(path.join(manifest.app, 'Contents/Frameworks/libvideoeditor.dylib')) !== manifest.librarySha256) {
    fail('NATIVE_CHANGED', 'The installed runtime or codec has changed; rebuild and verify it before use');
  }
  const call = (mode, input) => {
    const result = spawnSync(binary, [mode], { input, stdio: ['pipe', 'ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    if (result.error || result.status !== 0 || !result.output[3]?.length) fail('CODEC_FAILED', `Local Jianying codec failed (${mode}): ${result.status ?? result.error?.code}`);
    return result.output[3];
  };
  return {
    manifest,
    decode(raw) {
      try { return JSON.parse(call('decode', raw).toString('utf8')); }
      catch (error) { if (error.code) throw error; fail('CODEC_FAILED', 'Decoded data is not JSON'); }
    },
    encode(value) {
      const raw = Buffer.from(JSON.stringify(value));
      const encoded = call('encode', raw);
      if (JSON.stringify(this.decode(encoded)) !== raw.toString()) fail('CODEC_FAILED', 'Encryption round-trip did not preserve JSON');
      return encoded;
    },
  };
}
