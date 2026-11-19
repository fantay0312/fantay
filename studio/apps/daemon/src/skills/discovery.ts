import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { catalogPage, shortDescription } from '../capability-discovery.js';
import { listSkillFiles, type SkillInfo } from '../skills.js';

export function findSkills(skills: readonly SkillInfo[], query: string, offset: number) {
  const page = catalogPage(skills, query, offset, skill => ({
    id: skill.id,
    terms: [skill.description, ...Object.values(skill.displayName ?? {}),
      ...Object.values(skill.descriptionI18n ?? {}), skill.category ?? '',
      ...skill.triggers.filter((v): v is string => typeof v === 'string')],
  }));
  return {
    ...page,
    items: page.items.map(skill => ({
      id: skill.id, source: skill.source,
      description: shortDescription((/\p{Script=Han}/u.test(query) && skill.descriptionI18n?.['zh-CN']) || skill.description),
    })),
  };
}

const referencePath = /^references\/(?:[^/\\\u0000-\u001f]+\/)*[^/\\\u0000-\u001f]+\.(?:md|markdown|txt|json|yaml|yml|csv)$/iu;
export async function readSkillPage(skill: SkillInfo, file: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (file === 'references') {
    const dir = path.join(await realpath(skill.dir), 'references');
    const root = await realpath(dir).catch(() => null);
    const entries = root === dir ? await listSkillFiles(dir) : [];
    const paths = entries.filter(entry => entry.kind === 'file')
      .map(entry => `references/${entry.path}`).filter(file => referencePath.test(file));
    return { id: skill.id, files: paths.slice(offset, offset + 20),
      nextOffset: offset + 20 < paths.length ? offset + 20 : null };
  }
  let body = skill.body;
  if (file !== 'SKILL.md') {
    if (!referencePath.test(file) || file.split('/').some(part => part.startsWith('.'))) {
      throw new Error('Use SKILL.md, references, or a text file listed under references/');
    }
    const root = await realpath(skill.dir);
    const target = path.resolve(root, ...file.split('/'));
    if (await realpath(target) !== target) throw new Error('Linked references cannot be read');
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('Reference must be a text file under 2 MB');
    body = await readFile(target, 'utf8');
  }
  // Offsets are UTF-16 positions. Avoid splitting a surrogate pair across two pages.
  let end = Math.min(offset + 4000, body.length);
  if (end < body.length && /[\uD800-\uDBFF]/u.test(body[end - 1] ?? '')) end--;
  return { id: skill.id, file, text: body.slice(offset, end), nextOffset: end < body.length ? end : null };
}
