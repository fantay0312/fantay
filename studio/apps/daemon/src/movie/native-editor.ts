import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MovieError, readMovie } from './store.js';
import { withNativeProject } from './native-project-queue.js';

const associationFile = '.fantay-native-editor.json';
interface NativeAssociation {path:string;sourceRevision?:number;mediaIds?:string[]}
export const nativeRuntimeDir = (dataDir:string) => path.join(dataDir,'native-runtime');
export async function nativeSnapshot(dataDir:string,name:string,value:unknown){
  const dir=nativeRuntimeDir(dataDir);await mkdir(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,name),temp=`${file}.${randomUUID()}.tmp`;
  await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,file);
}
async function bindNativeProject(dataDir:string,nativePath:string,projectId:string){
  return withNativeProject(`bindings:${dataDir}`, async () => {
  let bindings:Record<string,string>={};try{bindings=JSON.parse(await readFile(path.join(nativeRuntimeDir(dataDir),'projects.json'),'utf8'));}catch{}
  if (bindings[nativePath] && bindings[nativePath] !== projectId) throw new MovieError('This video project is already linked to another project', 409);
  bindings[nativePath]=projectId;await nativeSnapshot(dataDir,'projects.json',bindings);
  });
}

export interface NativeProjectRecord {
  path: string; name: string; isAccessible: boolean; lastOpenedAt?: number; thumbnailBase64?: string;
}
export async function listNativeProjectRecords(dataDir: string): Promise<NativeProjectRecord[]> {
  // Listing films must never launch the former companion application.
  const paths = new Map<string, number>();
  try {
    const registry = JSON.parse(await readFile(path.join(process.env.FANTAY_NATIVE_LIBRARY_DIR ?? path.join(homedir(), 'Documents', 'Fantaydesign Video'), 'project-registry.json'), 'utf8'));
    for (const item of Array.isArray(registry) ? registry : []) {
      if (typeof item.url === 'string') paths.set(item.url.startsWith('file:') ? fileURLToPath(item.url) : item.url, (Number(item.lastOpenedDate ?? 0) + 978307200) * 1000);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { for (const file of Object.keys(JSON.parse(await readFile(path.join(nativeRuntimeDir(dataDir), 'projects.json'), 'utf8')))) if (!paths.has(file)) paths.set(file, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const rows: NativeProjectRecord[] = [];
  for (const [file, lastOpenedAt] of paths) {
    if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.palmier') continue;
    try { await access(path.join(file, 'project.json')); rows.push({ path: file, name: path.basename(file, '.palmier'), isAccessible: true, lastOpenedAt }); }
    catch { /* Preserve missing entries in the old registry without offering them for import. */ }
  }
  return rows;
}
export async function linkNativeProject(dir: string, projectId: string, nativePath: string, dataDir: string) {
  return withNativeProject(projectId, async () => {
  const current = await nativeEditorStatus(dir);
  if (current.project && path.resolve(current.project.path) !== path.resolve(nativePath)) {
    throw new MovieError('This project is already linked to a different video project', 409);
  }
  await bindNativeProject(dataDir, nativePath, projectId);
  if (!current.project) await writeFile(path.join(dir, associationFile), JSON.stringify({ path: nativePath, mediaIds: [] }), { mode: 0o600 });
  });
}
export async function nativeEditorStatus(dir:string){
  let project:NativeAssociation|null=null;try{project=JSON.parse(await readFile(path.join(dir,associationFile),'utf8'));}catch{}
  return {supported:process.platform==='darwin',project};
}
export async function importNativeSource(dir:string,projectId:string,assetId:string):Promise<boolean>{
  return Boolean((await readMovie(dir))?.style.assets?.some(asset => asset.id === assetId));
}
export async function writeNativeAccountSnapshot(dataDir:string,snapshot:unknown){
  const dir=nativeRuntimeDir(dataDir);await mkdir(dir,{recursive:true,mode:0o700});
  const at=process.execPath.indexOf('.app/Contents/');
  const hostApplicationPath=at>=0?process.execPath.slice(0,at+4):'/Applications/Fantay.app';
  await nativeSnapshot(dataDir,'account.json',{...snapshot as Record<string,unknown>,hostApplicationPath});
}
