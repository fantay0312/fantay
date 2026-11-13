// SPDX-License-Identifier: Apache-2.0
// 我的素材 storage: one folder per asset under `<RUNTIME_DATA_DIR>/user-assets/<id>/`, holding `asset.json` and the
// files. Writes run one at a time; a project only ever sees a copy (`apply`), so deleting an asset never touches work.
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  USER_ASSET_LIMITS,
  isUserAssetKind,
  type UserAsset,
  type UserAssetApplyResponse,
  type UserAssetFile,
  type UserAssetKind,
} from '@open-design/contracts';

import { ensureProjectSubdir, sanitizeName } from '../../projects.js';

export class UserAssetError extends Error {
  constructor(readonly status: number, readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'PAYLOAD_TOO_LARGE', message: string) {
    super(message);
  }
}

const ID_PATTERN = /^ua_[a-f0-9]{16}$/;
const FILE_ID_PATTERN = /^f_[a-f0-9]{12}(\.[a-z0-9]{1,12})?$/;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.avif': 'image/avif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain',
};

function mimeFor(name: string): string {
  return MIME_BY_EXTENSION[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

function checkName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > USER_ASSET_LIMITS.maxNameLength) {
    throw new UserAssetError(400, 'BAD_REQUEST', `name must be 1..${USER_ASSET_LIMITS.maxNameLength} characters`);
  }
  return name;
}

function checkDescription(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > USER_ASSET_LIMITS.maxDescriptionLength) {
    throw new UserAssetError(400, 'BAD_REQUEST', `description must be at most ${USER_ASSET_LIMITS.maxDescriptionLength} characters`);
  }
  return value.trim();
}

function notFound(id: string): UserAssetError {
  return new UserAssetError(404, 'NOT_FOUND', `asset not found: ${id}`);
}

export interface UserAssetsServiceDeps {
  dataDir: string;
  projectsDir: string;
  now?: () => number;
}

export type UserAssetsService = ReturnType<typeof createUserAssetsService>;

export function createUserAssetsService(deps: UserAssetsServiceDeps) {
  const root = path.join(deps.dataDir, 'user-assets');
  const now = deps.now ?? (() => Date.now());
  let writes: Promise<unknown> = Promise.resolve();

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = writes.then(run, run);
    writes = next.catch(() => undefined);
    return next;
  }

  function assetDir(id: string): string {
    if (!ID_PATTERN.test(id)) throw notFound(id);
    return path.join(root, id);
  }

  async function read(id: string): Promise<UserAsset> {
    try {
      return JSON.parse(await readFile(path.join(assetDir(id), 'asset.json'), 'utf8')) as UserAsset;
    } catch (error) {
      if (error instanceof UserAssetError) throw error;
      throw notFound(id);
    }
  }

  async function save(asset: UserAsset): Promise<UserAsset> {
    const dir = assetDir(asset.id);
    await mkdir(dir, { recursive: true });
    const temporary = path.join(dir, `asset.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temporary, JSON.stringify(asset, null, 2));
    await rename(temporary, path.join(dir, 'asset.json'));
    return asset;
  }

  return {
    async list(kind?: UserAssetKind): Promise<UserAsset[]> {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const assets = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
        .map((entry) => read(entry.name).catch(() => null)));
      return assets
        .filter((asset): asset is UserAsset => asset !== null && (kind === undefined || asset.kind === kind))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    get: read,

    create(input: { kind?: unknown; name?: unknown; description?: unknown }): Promise<UserAsset> {
      if (!isUserAssetKind(input.kind)) throw new UserAssetError(400, 'BAD_REQUEST', 'kind must be character, product or custom');
      const at = now();
      return serial(() => save({
        id: `ua_${randomBytes(8).toString('hex')}`,
        kind: input.kind as UserAssetKind,
        name: checkName(input.name),
        description: checkDescription(input.description),
        files: [],
        createdAt: at,
        updatedAt: at,
      }));
    },

    update(id: string, input: { name?: unknown; description?: unknown }): Promise<UserAsset> {
      return serial(async () => {
        const asset = await read(id);
        return save({
          ...asset,
          ...(input.name !== undefined ? { name: checkName(input.name) } : {}),
          ...(input.description !== undefined ? { description: checkDescription(input.description) } : {}),
          updatedAt: now(),
        });
      });
    },

    remove(id: string): Promise<void> {
      return serial(async () => {
        await read(id);
        await rm(assetDir(id), { recursive: true, force: true });
      });
    },

    addFile(id: string, rawName: unknown, body: Buffer): Promise<UserAsset> {
      return serial(async () => {
        const asset = await read(id);
        if (asset.files.length >= USER_ASSET_LIMITS.maxFiles) {
          throw new UserAssetError(400, 'BAD_REQUEST', `an asset holds at most ${USER_ASSET_LIMITS.maxFiles} files`);
        }
        if (typeof rawName !== 'string' || !rawName.trim() || body.length === 0) {
          throw new UserAssetError(400, 'BAD_REQUEST', 'a file needs a name and bytes');
        }
        const name = sanitizeName(path.basename(rawName.trim()));
        const extension = path.extname(name).toLowerCase();
        const fileId = `f_${randomBytes(6).toString('hex')}${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''}`;
        await mkdir(path.join(assetDir(id), 'files'), { recursive: true });
        await writeFile(path.join(assetDir(id), 'files', fileId), body);
        const file: UserAssetFile = {
          id: fileId,
          name,
          mime: mimeFor(name),
          size: body.length,
          url: `/api/user-assets/${id}/files/${encodeURIComponent(fileId)}`,
        };
        return save({ ...asset, files: [...asset.files, file], updatedAt: now() });
      });
    },

    removeFile(id: string, fileId: string): Promise<UserAsset> {
      return serial(async () => {
        const asset = await read(id);
        if (!asset.files.some((file) => file.id === fileId)) throw notFound(fileId);
        await rm(path.join(assetDir(id), 'files', fileId), { force: true });
        return save({ ...asset, files: asset.files.filter((file) => file.id !== fileId), updatedAt: now() });
      });
    },

    /** Absolute path of a stored file (the id comes from the asset record, never the request). */
    async filePath(id: string, fileId: string): Promise<{ path: string; file: UserAssetFile }> {
      if (!FILE_ID_PATTERN.test(fileId)) throw notFound(fileId);
      const asset = await read(id);
      const file = asset.files.find((entry) => entry.id === fileId);
      if (!file) throw notFound(fileId);
      return { path: path.join(assetDir(id), 'files', file.id), file };
    },

    /** Copies the asset into `<dir>/<name>-<id>/`, same folder every time, so a re-apply refreshes it. */
    async apply(id: string, input: { projectId: string; metadata: unknown; dir?: string }): Promise<UserAssetApplyResponse> {
      const asset = await read(id);
      const folder = `${input.dir?.trim() || 'references'}/${sanitizeName(asset.name)}-${id.slice(-6)}`;
      const { absDir, relDir } = await ensureProjectSubdir(deps.projectsDir, input.projectId, folder, input.metadata);
      const taken = new Set<string>();
      const paths: string[] = [];
      for (const file of asset.files) {
        let name = file.name;
        for (let copy = 2; taken.has(name.toLowerCase()); copy += 1) {
          const extension = path.extname(file.name);
          name = `${file.name.slice(0, file.name.length - extension.length)}-${copy}${extension}`;
        }
        taken.add(name.toLowerCase());
        await copyFile(path.join(assetDir(id), 'files', file.id), path.join(absDir, name));
        paths.push(`${relDir}/${name}`);
      }
      let briefPath: string | null = null;
      if (asset.description) {
        await writeFile(path.join(absDir, 'brief.md'), `# ${asset.name}\n\n${asset.description}\n`);
        briefPath = `${relDir}/brief.md`;
      }
      return { id, projectId: input.projectId, dir: relDir, paths, briefPath };
    },
  };
}
