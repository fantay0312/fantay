// SPDX-License-Identifier: Apache-2.0
// `od assets …`: CLI mirror of 我的素材, on the same `/api/user-assets` routes as the web UI (AGENTS.md dual-track).
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isUserAssetKind,
  type UserAsset,
  type UserAssetApplyResponse,
  type UserAssetResponse,
  type UserAssetsResponse,
} from '@open-design/contracts';

import { resolveDaemonUrl } from '../../daemon-url.js';

export const ASSETS_USAGE = `Usage:
  od assets list [--kind character|product|custom] [--json]
      Reusable assets of the local user (我的素材).
  od assets create --kind character|product|custom --name <name>
                   [--description <text> | --prompt-file <path|->] [--file <path>]... [--json]
      Create an asset and upload its files.
  od assets add-file <id> --file <path>... [--json]
  od assets remove <id> [--json]
  od assets apply <id> --project <projectId> [--dir <dir>] [--json]
      Copy the asset into the project (default references/<name>-<id>/), plus
      brief.md when it has a description.

Common flags: --daemon-url <url>, --json, --help`;

const STRING_FLAGS = new Set(['kind', 'name', 'description', 'prompt-file', 'project', 'dir', 'daemon-url']);

class UsageError extends Error {}

interface Parsed {
  flags: Map<string, string>;
  files: string[];
  json: boolean;
  help: boolean;
  positionals: string[];
}

function parse(args: readonly string[]): Parsed {
  const parsed: Parsed = { flags: new Map(), files: [], json: false, help: false, positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--file' || STRING_FLAGS.has(arg.slice(2))) {
      const value = args[index + 1];
      if (!arg.startsWith('--') || value === undefined) throw new UsageError(`flag ${arg} requires a value`);
      index += 1;
      if (arg === '--file') parsed.files.push(value);
      else parsed.flags.set(arg.slice(2), value);
    } else if (arg.startsWith('--')) throw new UsageError(`unknown flag: ${arg}. Run \`od assets --help\`.`);
    else parsed.positionals.push(arg);
  }
  return parsed;
}

async function call<T>(base: string, route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      /* not JSON */
    }
    throw new Error(`${response.status} ${message}`);
  }
  return JSON.parse(text) as T;
}

const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function upload(base: string, id: string, files: readonly string[]): Promise<UserAsset | null> {
  let asset: UserAsset | null = null;
  for (const file of files) {
    const bytes = await readFile(file);
    const route = `/api/user-assets/${encodeURIComponent(id)}/files?name=${encodeURIComponent(path.basename(file))}`;
    ({ asset } = await call<UserAssetResponse>(base, route, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    }));
  }
  return asset;
}

async function readTextInput(file: string): Promise<string> {
  if (file !== '-') return readFile(file, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function line(asset: UserAsset): string {
  return `${asset.id}  ${asset.kind}  ${asset.name}  (${asset.files.length} files)`;
}

export async function runAssets(args: string[]): Promise<void> {
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  try {
    const parsed = parse(args);
    const [sub, id] = parsed.positionals;
    if (!sub || parsed.help) {
      out(ASSETS_USAGE);
      process.exitCode = sub || parsed.help ? 0 : 2;
      return;
    }
    const flagUrl = parsed.flags.get('daemon-url');
    const base = (await resolveDaemonUrl({ ...(flagUrl ? { flagUrl } : {}), env: process.env })).replace(/\/+$/u, '');
    const print = (data: unknown, text: string): void => out(parsed.json ? JSON.stringify(data, null, 2) : text);
    const needId = (): string => {
      if (!id) throw new UsageError(`od assets ${sub} needs an asset id`);
      return encodeURIComponent(id);
    };
    switch (sub) {
      case 'list': {
        const kind = parsed.flags.get('kind');
        if (kind !== undefined && !isUserAssetKind(kind)) throw new UsageError('--kind must be character, product or custom');
        const data = await call<UserAssetsResponse>(base, `/api/user-assets${kind ? `?kind=${kind}` : ''}`);
        print(data, data.assets.map(line).join('\n') || 'No assets.');
        return;
      }
      case 'create': {
        const promptFile = parsed.flags.get('prompt-file');
        const description = promptFile
          ? await readTextInput(promptFile)
          : parsed.flags.get('description');
        const created = await call<UserAssetResponse>(base, '/api/user-assets', {
          method: 'POST',
          ...json({
            kind: parsed.flags.get('kind'),
            name: parsed.flags.get('name'),
            ...(description !== undefined ? { description } : {}),
          }),
        });
        const asset = (await upload(base, created.asset.id, parsed.files)) ?? created.asset;
        print({ asset }, line(asset));
        return;
      }
      case 'add-file': {
        const asset = await upload(base, needId(), parsed.files);
        if (!asset) throw new UsageError('pass at least one --file <path>');
        print({ asset }, line(asset));
        return;
      }
      case 'remove': {
        const data = await call<{ ok: true }>(base, `/api/user-assets/${needId()}`, { method: 'DELETE' });
        print(data, `Removed ${id}.`);
        return;
      }
      case 'apply': {
        const projectId = parsed.flags.get('project') ?? process.env.OD_PROJECT_ID;
        if (!projectId) throw new UsageError('pass --project <id> or set OD_PROJECT_ID');
        const dir = parsed.flags.get('dir');
        const data = await call<UserAssetApplyResponse>(base, `/api/user-assets/${needId()}/apply`, {
          method: 'POST',
          ...json({ projectId, ...(dir ? { dir } : {}) }),
        });
        print(data, [...data.paths, ...(data.briefPath ? [data.briefPath] : [])].join('\n'));
        return;
      }
      default:
        throw new UsageError(`unknown subcommand: ${sub}. Expected list, create, add-file, remove or apply.`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
