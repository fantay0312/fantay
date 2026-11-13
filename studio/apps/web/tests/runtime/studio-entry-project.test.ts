import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createStudioEntryProject} from '../../src/runtime/studio-entry-project';
import {createProject,deleteProject} from '../../src/state/projects';
import {writeProjectTextFile} from '../../src/providers/registry';
import type {StudioLibraryEntry} from '@open-design/contracts';
vi.mock('../../src/state/projects',()=>({createProject:vi.fn(async()=>({project:{id:'new-project'},conversationId:'chat'})),deleteProject:vi.fn(async()=>true)}));
vi.mock('../../src/providers/registry',()=>({writeProjectTextFile:vi.fn(async()=>({name:'index.html'}))}));
beforeEach(()=>vi.clearAllMocks());
const entry={name:'Form'} as StudioLibraryEntry;const bundle={html:'<!doctype html><html><body>Complete</body></html>',localResources:[],externalResources:[]};
describe('catalog project reuse',()=>{
  it('writes the prepared reusable document and returns the real project',async()=>{const result=await createStudioEntryProject(entry,bundle);expect(result.project.id).toBe('new-project');expect(writeProjectTextFile).toHaveBeenCalledWith('new-project','index.html',bundle.html,undefined,undefined);expect(deleteProject).not.toHaveBeenCalled();});
  it('removes the newly-created empty project when writing fails',async()=>{vi.mocked(writeProjectTextFile).mockResolvedValueOnce(null);await expect(createStudioEntryProject(entry,bundle)).rejects.toThrow('写入失败');expect(deleteProject).toHaveBeenCalledWith('new-project',undefined);});
});
