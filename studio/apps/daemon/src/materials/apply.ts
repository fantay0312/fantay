// Copy one material record into a project folder.
//
// Destination resolution reuses the helpers behind the OD Library apply
// (`ensureProjectSubdir`, `resolveProjectDir`), so imported-folder projects
// honor `metadata.baseDir`. The caller (route) owns request gating: loopback
// check and the workspace `writeFiles` mutation gate.

import path from 'node:path';

import type { MaterialApplyResponse, MaterialFileField } from '@open-design/contracts';
import { MATERIAL_NOTICE } from '@open-design/contracts';

import { ensureProjectSubdir, resolveProjectDir, sanitizeName, sanitizePath } from '../projects.js';
import { MATERIAL_RECEIPT_FILE, executeMaterialCopy, planMaterialCopy } from './copy.js';
import { isWebsiteRecord } from './dto.js';
import { MaterialError, invalidRequest, unsafePath } from './errors.js';
import { isInsideByIdentity, isPathInsideOrSame, realpathOrExistingPrefix } from './paths.js';
import type { MaterialsService } from './service.js';
import { MATERIAL_THUMBNAIL_TYPES } from './service.js';

export const MATERIAL_APPLY_DEFAULT_DIR = 'references';

export interface ApplyMaterialInput {
  materials: MaterialsService;
  projectsDir: string;
  projectId: string;
  projectMetadata: unknown;
  id: string;
  dir?: string;
  fields?: readonly MaterialFileField[];
  files?: readonly string[];
  /** Result of `openCopyableMaterial`, when the caller already opened the record. */
  opened?: CopyableMaterial;
}

export type CopyableMaterial = Awaited<ReturnType<MaterialsService['openRecord']>>;

/** Rejects website bookmarks before any project lookup; returns the open record. */
export async function openCopyableMaterial(materials: MaterialsService, id: string): Promise<CopyableMaterial> {
  const opened = await materials.openRecord(id);
  if (isWebsiteRecord(opened.record)) {
    throw new MaterialError(
      'not-copyable',
      400,
      `${id} is a website record (a bookmark); reference its source URL instead of copying.`,
    );
  }
  return opened;
}

function sanitizeProjectDir(raw: string): string {
  try {
    return sanitizePath(raw);
  } catch (error) {
    throw invalidRequest(`Invalid dir: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isImageThumbnail(relativePath: string): boolean {
  return Boolean(MATERIAL_THUMBNAIL_TYPES[path.posix.extname(relativePath).toLowerCase()]);
}

export async function applyMaterialToProject(input: ApplyMaterialInput): Promise<MaterialApplyResponse> {
  const { catalog, record } = input.opened ?? (await openCopyableMaterial(input.materials, input.id));
  const requestedDir = input.dir?.trim() ? input.dir.trim() : MATERIAL_APPLY_DEFAULT_DIR;
  const parentRel = sanitizeProjectDir(requestedDir);

  let projectDir: string;
  try {
    projectDir = resolveProjectDir(input.projectsDir, input.projectId, input.projectMetadata);
  } catch (error) {
    throw invalidRequest(error instanceof Error ? error.message : String(error));
  }
  // Never write inside the library, even when an imported-folder project
  // points into it. Check before creating any folder.
  const intendedParent = await realpathOrExistingPrefix(path.join(projectDir, parentRel));
  const libraryRoots = input.materials.libraryRoots ? await input.materials.libraryRoots() : [catalog.root];
  for (const root of libraryRoots) {
    if (isPathInsideOrSame(intendedParent, root) || (await isInsideByIdentity(intendedParent, root))) {
      throw unsafePath('Copy destination must be outside every connected material library.');
    }
  }

  const plan = await planMaterialCopy(catalog, record, {
    ...(input.fields ? { fields: input.fields } : {}),
    ...(input.files ? { files: input.files } : {}),
  });

  let absDir: string;
  let relDir: string;
  try {
    ({ absDir, relDir } = await ensureProjectSubdir(
      input.projectsDir,
      input.projectId,
      parentRel,
      input.projectMetadata,
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EPATHESCAPE') {
      throw unsafePath('Destination leaves the project folder.');
    }
    throw invalidRequest(error instanceof Error ? error.message : String(error));
  }

  const folderName = sanitizeName(record.id);
  const projectRel = (folder: string, rel?: string) =>
    [relDir, folder, rel].filter((part): part is string => Boolean(part)).join('/');
  const { folder } = await executeMaterialCopy({
    plan,
    parentDir: absDir,
    folderName,
    libraryRoot: catalog.root,
    rootSource: catalog.rootSource,
    receiptContext: (name) => ({ project_id: input.projectId, destination: projectRel(name) }),
  });

  const attachments: string[] = [];
  if (plan.thumbnail && isImageThumbnail(plan.thumbnail)) attachments.push(projectRel(folder, plan.thumbnail));
  if (plan.mainEntry) {
    const main = projectRel(folder, plan.mainEntry);
    if (!attachments.includes(main)) attachments.push(main);
  }
  return {
    id: input.id,
    projectId: input.projectId,
    dir: projectRel(folder),
    files: plan.entries.map((entry) => ({
      relPath: projectRel(folder, entry.relativePath),
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    attachments,
    receiptRelPath: projectRel(folder, MATERIAL_RECEIPT_FILE),
    notice: MATERIAL_NOTICE,
  };
}
