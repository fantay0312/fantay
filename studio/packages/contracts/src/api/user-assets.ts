// SPDX-License-Identifier: Apache-2.0
// 我的素材: reusable things the user owns across projects (a character, a product, anything else), each a name, a
// description and a few files. Brand kits are a separate domain (`./brands.ts`); the external archive is `./materials.ts`.
// Applying an asset copies it into a project's `references/` folder, so agents and the board read plain project files.

export const USER_ASSET_KINDS = ['character', 'product', 'custom'] as const;
export type UserAssetKind = (typeof USER_ASSET_KINDS)[number];

export const USER_ASSET_LIMITS = {
  maxNameLength: 80,
  maxDescriptionLength: 4_000,
  maxFiles: 24,
  maxFileBytes: 64 * 1024 * 1024,
} as const;

export interface UserAssetFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Daemon-relative URL of the bytes. */
  url: string;
}

export interface UserAsset {
  id: string;
  kind: UserAssetKind;
  name: string;
  description: string;
  files: UserAssetFile[];
  createdAt: number;
  updatedAt: number;
}

/** GET /api/user-assets */
export interface UserAssetsResponse { assets: UserAsset[] }
/** POST, PATCH, GET one, PUT file, DELETE file */
export interface UserAssetResponse { asset: UserAsset }

export interface UserAssetCreateRequest { kind: UserAssetKind; name: string; description?: string }
export interface UserAssetUpdateRequest { name?: string; description?: string }

/** POST /api/user-assets/:id/apply */
export interface UserAssetApplyRequest {
  projectId: string;
  /** Project-relative parent folder; default `references`. */
  dir?: string;
}
export interface UserAssetApplyResponse {
  id: string;
  projectId: string;
  /** Project-relative folder that received the copy. */
  dir: string;
  /** Project-relative paths of the copied files, in asset order. */
  paths: string[];
  /** Project-relative path of `brief.md` (name and description), when the asset has a description. */
  briefPath: string | null;
}

export function isUserAssetKind(value: unknown): value is UserAssetKind {
  return (USER_ASSET_KINDS as readonly unknown[]).includes(value);
}
