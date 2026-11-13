/** Isolated Node 24 driver for the pinned draft-format compatibility runtime. */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createDraft, editDraft, inspectDraft, validateDraft, installDraft } from './src/index.js';
import type { Codec, Operation, ProjectSpec } from './src/index.js';

type Input = { command: 'create' | 'edit' | 'inspect' | 'install'; source?: string; output?: string; name?: string; root?: string; spec?: ProjectSpec; operations?: Operation[]; nativeBinary?: string };
function codec(binary: string): Codec {
  const call = (mode: string, input: Uint8Array) => {
    const result = spawnSync(binary, [mode], { input, stdio: ['pipe', 'ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    if (result.error || result.status !== 0 || !result.output[3]?.length) throw new Error(`Native codec failed: ${mode}`);
    return result.output[3];
  };
  return {
    decode: raw => JSON.parse(call('decode', raw).toString('utf8')) as Record<string, unknown>,
    encode(value) {
      const raw = Buffer.from(JSON.stringify(value));
      const encoded = call('encode', raw);
      if (JSON.stringify(this.decode(encoded)) !== raw.toString('utf8')) throw new Error('Native codec round-trip mismatch');
      return encoded;
    },
  };
}
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8')) as Input;
  const options = input.nativeBinary ? { codec: codec(input.nativeBinary) } : {};
  let result: unknown;
  let destination = input.source;
  if (input.command === 'create') {
    result = await createDraft(input.spec!, { output: input.output! });
    destination = input.output;
  } else if (input.command === 'edit') {
    result = await editDraft(input.source!, input.operations!, { output: input.output!, ...(input.name ? { name: input.name } : {}), ...options });
    destination = input.output;
  } else if (input.command === 'install') {
    result = await installDraft(input.source!, { root: input.root!, ...(input.name ? { name: input.name } : {}), ...options });
    destination = (result as { draftPath: string }).draftPath;
  }
  const inspection = inspectDraft(destination!, options);
  const validation = validateDraft(destination!, options);
  console.log(JSON.stringify({ ok: true, result, inspection, validation }));
} catch (error) {
  const failure = error as Error & { code?: string; details?: unknown };
  console.log(JSON.stringify({ ok: false, error: { code: failure.code ?? 'JIANYING_FAILED', message: failure.message, details: failure.details } }));
  process.exitCode = 1;
}
