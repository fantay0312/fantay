import type { StudioLibraryEntry, WorkspaceCollabContext } from '@open-design/contracts';
import { createProject, deleteProject } from '../state/projects';
import { writeProjectTextFile } from '../providers/registry';
import type { StudioEntryBundle } from './studio-entry-bundle';

/** The bundle is prepared first so missing dependencies cannot leave an empty project. */
export async function createStudioEntryProject(entry: StudioLibraryEntry, bundle: StudioEntryBundle, workspaceContext?: WorkspaceCollabContext | null) {
  const created = await createProject({ name: entry.name, skillId: null, designSystemId: null, workspaceContext });
  try {
    if (!await writeProjectTextFile(created.project.id, 'index.html', bundle.html, undefined, workspaceContext)) throw new Error('项目写入失败，请重试。');
    return created;
  } catch (error) {
    try { await deleteProject(created.project.id, workspaceContext); }
    catch { throw new Error('写入失败，临时项目 ' + created.project.id + ' 未能清理，请到项目列表删除后重试。'); }
    throw error;
  }
}
