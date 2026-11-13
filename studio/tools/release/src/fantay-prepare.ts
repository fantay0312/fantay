import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Prepare auditable dual-origin assets; this command never publishes. */
export async function prepareFantayRelease(args: string[]) {
  const flags = new Map<string,string>();
  for (let i=0;i<args.length;i+=2) {
    const key=args[i], value=args[i+1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Use --version VERSION [--mac-arm64 DMG] [--mac-x64 DMG] [--win-x64 EXE] [--linux-x64 APPIMAGE] [--out DIR]');
    if (!['--version','--mac-arm64','--mac-x64','--win-x64','--linux-x64','--out'].includes(key)) throw new Error('Unknown flag: '+key);
    flags.set(key,value);
  }
  const version=flags.get('--version');
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable x.y.z version is required');
  const out=resolve(flags.get('--out') ?? '.tmp/fantay-release/'+version);
  const primary='https://static.tokentosea.com/fantay-design/releases/'+version;
  const github='https://github.com/fantay0312/fantay/releases/download/v'+version;
  const platforms: Record<string,unknown>={};
  const githubPlatforms: Record<string,unknown>={};
  const sums:string[]=[];
  const assets:string[]=[];
  await mkdir(join(out,'assets'),{recursive:true});
  await mkdir(join(out,'github'),{recursive:true});
  for (const [flag,key,arch,kind,extension] of [
    ['--mac-arm64','mac','arm64','dmg','.dmg'],['--mac-x64','macIntel','x64','dmg','.dmg'],
    ['--win-x64','win','x64','installer','.exe'],['--linux-x64','linux','x64','appImage','.AppImage'],
  ]) {
    const source=flags.get(flag!);
    if (!source) continue;
    const info=await stat(source);
    if (!info.isFile() || !source.toLowerCase().endsWith(extension!.toLowerCase())) throw new Error('Invalid installer: '+source);
    const sha256=await sha256File(source);
    const name='Fantay-'+version+'-'+flag!.slice(2)+extension;
    await copyFile(source,join(out,'assets',name));
    sums.push(sha256+'  '+name);assets.push(name);
    const base={name,size:info.size,sha256};
    platforms[key!]={enabled:true,arch,artifacts:{[kind!]:{...base,url:primary+'/'+name}}};
    githubPlatforms[key!]={enabled:true,arch,artifacts:{[kind!]:{...base,url:github+'/'+name}}};
  }
  if (!assets.length) throw new Error('At least one real installer is required; no empty release is generated');
  const metadata={channel:'stable',releaseVersion:version,releaseState:'complete',platforms};
  await writeFile(join(out,'metadata.json'),JSON.stringify(metadata,null,2)+'\n');
  await writeFile(join(out,'github','metadata.json'),JSON.stringify({...metadata,platforms:githubPlatforms},null,2)+'\n');
  await writeFile(join(out,'assets','SHA256SUMS'),sums.join('\n')+'\n');
  await writeFile(join(out,'publish-plan.json'),JSON.stringify({repository:'fantay0312/fantay',tag:'v'+version,version,assets,cosPrefix:'fantay-design/releases/'+version,latestKey:'fantay-design/releases/stable/latest/metadata.json',order:['Upload versioned assets to COS','Create GitHub draft with assets and github/metadata.json','Verify both origins against SHA256SUMS','Publish the GitHub release','Publish COS version metadata, then stable/latest/metadata.json last']},null,2)+'\n');
  return out;
}

if (process.argv[1]?.endsWith('fantay-prepare.ts')) {
  console.log(await prepareFantayRelease(process.argv.slice(2)));
}
