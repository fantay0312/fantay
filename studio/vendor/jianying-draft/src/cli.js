#!/usr/bin/env node
import path from 'node:path';
import { createDraft, editDraft, inspectDraft, validateDraft, doctor, listDrafts, installDraft, nativeCodec } from './index.js';
import { fail, json } from './common.js';

const usage = `FantayDesign Jianying draft lab
  doctor
  create <project.json> --out <new-directory>
  inspect <draft-directory> [--native]
  validate <draft-directory> [--native]
  edit <draft-directory> <operations.json> --out <new-directory> [--name <name>] [--native]
  list [--root <drafts-root>]
  install <draft-directory> [--root <drafts-root>] [--name <name>] [--native]
Time values in input JSON are seconds. Existing directories are never overwritten.
--native uses only the verified locally built 11.6.0 codec; it never updates Jianying.`;

try {
  const args = process.argv.slice(2), command = args.shift();
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(usage); process.exit(0); }
  const positional = [], options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--native') options.native = true;
    else if (['--out', '--root', '--name'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_INPUT', `Missing value for ${args[i]}`);
      options[args[i].slice(2)] = args[++i];
    } else if (args[i].startsWith('--')) fail('INVALID_INPUT', `Unknown option ${args[i]}`);
    else positional.push(args[i]);
  }
  const codec = options.native ? nativeCodec() : undefined;
  const resolveMedia = (value, base) => {
    if (Array.isArray(value)) return value.map(v => resolveMedia(v, base));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'path' && typeof item === 'string' ? path.resolve(base, item) : resolveMedia(item, base)]));
  };
  const input = file => resolveMedia(json(file), path.dirname(path.resolve(file)));
  const expected = { doctor: 0, create: 1, inspect: 1, validate: 1, edit: 2, list: 0, install: 1 };
  if (!(command in expected) || positional.length !== expected[command]) fail('INVALID_INPUT', usage);
  let result;
  if (command === 'doctor') result = doctor({ root: options.root });
  else if (command === 'create') result = await createDraft(input(positional[0]), { output: options.out });
  else if (command === 'inspect') result = inspectDraft(positional[0], { codec });
  else if (command === 'validate') {
    result = validateDraft(positional[0], { codec });
    if (!result.valid) process.exitCode = 1;
  } else if (command === 'edit') result = await editDraft(positional[0], input(positional[1]), { output: options.out, name: options.name, codec });
  else if (command === 'list') result = listDrafts(options.root);
  else if (command === 'install') result = await installDraft(positional[0], { root: options.root, name: options.name, codec });
  console.log(JSON.stringify({ ok: process.exitCode !== 1, result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: error.code ?? 'OPERATION_FAILED', message: error.message, ...(error.details ? { details: error.details } : {}) } }, null, 2));
  process.exitCode = 1;
}
