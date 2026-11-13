import { readFile } from 'node:fs/promises';
import { isStudioPackageAsset } from '@open-design/contracts';
import type { DesignSystemRevision } from '@open-design/contracts';

export async function studioHistoryFromCli(options:{base:string;id:string;headers:Record<string,string>;revision?:string}):Promise<unknown>{
  const {base,id,headers}=options;
  const response=await fetch(base+'/api/design-systems/'+encodeURIComponent(id)+'/revisions',{headers});
  if(!response.ok)throw new Error(await response.text());
  const data=await response.json() as {revisions:DesignSystemRevision[]};
  data.revisions=data.revisions.filter(entry=>entry.jobId==='studio-editor'&&entry.status==='accepted'&&entry.fileChanges?.length===1);
  if(!options.revision)return data;
  const revision=data.revisions.find(entry=>entry.id===options.revision);
  const change=revision?.fileChanges?.[0];
  if(!change)throw new Error('A source-file revision is required');
  const workspaceResponse=await fetch(base+'/api/design-systems/'+encodeURIComponent(id)+'/workspace',{method:'POST',headers});
  if(!workspaceResponse.ok)throw new Error(await workspaceResponse.text());
  const workspace=await workspaceResponse.json() as {project:{id:string}};
  const source=await fetch(base+'/api/projects/'+encodeURIComponent(workspace.project.id)+'/raw/'+change.path.split('/').map(encodeURIComponent).join('/'),{headers});
  if(!source.ok&&source.status!==404)throw new Error(await source.text());
  const saved=await fetch(base+'/api/design-systems/'+encodeURIComponent(id)+'/editor',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({path:change.path,content:change.proposedContent,expected:source.status===404?null:await source.text()})});
  if(!saved.ok)throw new Error(await saved.text());
  return saved.json();
}

/** CLI mirror of the canvas' project-file write plus canonical package sync. */
export async function editDesignSystemFromCli(options: {
  base: string; id: string; headers: Record<string, string>;
  path?: string; file?: string;
}): Promise<unknown> {
  const { base, id, headers } = options;
  async function request(path: string, body?: unknown) {
    const response = await fetch(base + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result as { project?: { id: string }; synced?: string[] };
  }
  if (options.file || options.path) {
    if (!options.file || !options.path || !(options.path === 'DESIGN.md' || isStudioPackageAsset(options.path))) throw new Error('edit requires --path <package-file> and --file <local-file>');
    const content = options.file === '-' ? await new Promise<string>((resolve, reject) => { let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { input += chunk; }); process.stdin.on('end', () => resolve(input)); process.stdin.on('error', reject); }) : await readFile(options.file, 'utf8');
    const workspace = await request('/api/design-systems/' + encodeURIComponent(id) + '/workspace');
    if (!workspace.project) throw new Error('workspace unavailable');
    const source = await fetch(base + '/api/projects/' + encodeURIComponent(workspace.project.id) + '/raw/' + options.path.split('/').map(encodeURIComponent).join('/'), { headers });
    if (!source.ok && source.status !== 404) throw new Error(await source.text());
    return request('/api/design-systems/' + encodeURIComponent(id) + '/editor', { path: options.path, content, expected: source.status === 404 ? null : await source.text() });
  }
  return request('/api/design-systems/' + encodeURIComponent(id) + '/sync-assets');
}
