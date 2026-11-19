import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FANTAY_RELEASES, type FantayRelease } from '@open-design/contracts';
import { nextFantayVersion, parseFantayVersion, fantayPackageVersion } from '@open-design/release';

export const FANTAY_VERSION_PACKAGES = [
  'package.json', 'e2e/package.json',
  ...['daemon', 'desktop', 'packaged', 'web'].map(name => `apps/${name}/package.json`),
  ...['contracts', 'release', 'sidecar-proto', 'host', 'sidecar', 'platform', 'download', 'launcher-proto'].map(name => `packages/${name}/package.json`),
  ...['dev', 'pack', 'release'].map(name => `tools/${name}/package.json`),
];
export const fantayStudioRoot = () => fileURLToPath(new URL('../../../', import.meta.url));

export function validateFantayReleases(releases: readonly FantayRelease[]): void {
  if (!releases.length) throw new Error('Add a detailed release record before changing the version');
  const seen: string[] = [];
  for (const release of releases) {
    const parsed = parseFantayVersion(release.version);
    if (parsed.date !== release.date) throw new Error(`Release date mismatch: ${release.version}`);
    if (nextFantayVersion(seen, release.date) !== release.version) throw new Error(`Release sequence must be contiguous: ${release.version}`);
    if (!release.title.trim() || !release.sections.length || !release.validation.length || !release.limitations.length) throw new Error(`Incomplete detailed release: ${release.version}`);
    for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
      const copy = release.manga.copy[locale];
      if (!release.summary[locale].length || !copy.title.trim() || !copy.tagline.trim() || copy.chapters.length < 3 || copy.chapters.some(ch => !ch.head.trim() || !ch.text.trim())) throw new Error(`Missing summary/manga in ${locale}: ${release.version}`);
    }
    seen.push(release.version);
  }
}

export function renderFantayRelease(release: FantayRelease): string {
  const list = (items: string[]) => items.map(text => `- ${text}`).join('\n');
  return [
    `# Fantay ${release.version} — ${release.title}`, '',
    `日期：${release.date}（Asia/Taipei） · 状态：${release.status === 'published' ? '已发布' : '本地准备，尚未发布'}`, '',
    '## 更新摘要', '', list(release.summary['zh-CN']), '',
    ...release.sections.flatMap(section => [`## ${section.title}`, '', list(section.items), '']),
    '## 验证', '', list(release.validation), '',
    '## 已知限制', '', list(release.limitations), '',
    '## 更新漫画', '', `《${release.manga.copy['zh-CN'].title}》 — ${release.manga.copy['zh-CN'].tagline}`, '',
    list(release.manga.copy['zh-CN'].chapters.map(ch => `**${ch.head}**：${ch.text}`)), '',
    '内容来源：`packages/contracts/src/fantay-releases.ts`。由 `tools-release sync-version` 生成，请修改来源后重新同步。', '',
  ].join('\n');
}

const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function renderFantayReleaseHtml(releases: readonly FantayRelease[]): string {
  const list = (items: string[]) => `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fantay 更新日志</title><style>body{margin:0;background:#fafafa;color:#202020;font:16px/1.8 system-ui,sans-serif}main{max-width:780px;margin:auto;padding:48px 24px}article{border-top:1px solid #d8d8d8;padding:24px 0 40px}h1{font-size:32px}h2{font-size:24px}h3{margin-top:32px;font-size:19px}li{margin:10px 0}a{color:inherit;text-underline-offset:3px}small{color:#555}@media(prefers-color-scheme:dark){body{background:#191919;color:#eee}article{border-color:#444}small{color:#bbb}}</style><main><h1>Fantay 更新日志</h1><p>每个版本的具体改动、验证结果与已知限制。</p>${[...releases].reverse().map(r => `<article id="v${r.version}"><h2>${r.version} · ${escapeHtml(r.title)}</h2><small>${r.date} · ${r.status === 'published' ? '已发布' : '本地准备，尚未发布'}</small>${list(r.summary['zh-CN'])}${r.sections.map(s => `<h3>${escapeHtml(s.title)}</h3>${list(s.items)}`).join('')}<h3>验证</h3>${list(r.validation)}<h3>已知限制</h3>${list(r.limitations)}<h3>更新漫画 · ${escapeHtml(r.manga.copy['zh-CN'].title)}</h3>${list(r.manga.copy['zh-CN'].chapters.map(ch => `${ch.head}：${ch.text}`))}<p><a href="${r.version}.md">下载 Markdown</a></p></article>`).join('')}<a href="releases.json">JSON 数据</a></main></html>\n`;
}

/** Local, deterministic and repeatable. All validation and reads happen before any write. */
export async function syncFantayVersion(check = false, root = fantayStudioRoot(), releases = FANTAY_RELEASES): Promise<string[]> {
  validateFantayReleases(releases);
  const latest = releases[releases.length - 1]!;
  const output = new Map<string, string>();
  for (const name of FANTAY_VERSION_PACKAGES) {
    const original = await readFile(resolve(root, name), 'utf8');
    const value = JSON.parse(original) as { version: string };
    if (typeof value.version !== 'string') throw new Error(`No version in ${name}`);
    // Change only the version, preserving unrelated fields and formatting in dirty manifests.
    output.set(name, original.replace(/("version"\s*:\s*")[^"]+(")/, (_match, prefix: string, suffix: string) => `${prefix}${fantayPackageVersion(latest.version)}${suffix}`));
  }
  for (const release of releases) output.set(`docs/releases/${release.version}.md`, renderFantayRelease(release));
  output.set('docs/whats-new.json', JSON.stringify({
    id: `fantay-${latest.version}`, title: `Fantay ${latest.version}`, body: latest.summary.en.join('\n'),
    linkUrl: 'https://design.tokentosea.com', ctaLabel: 'Visit Fantay',
    locales: {
      'zh-CN': { title: `Fantay ${latest.version}`, body: latest.summary['zh-CN'].join('\n'), ctaLabel: '查看 Fantay' },
      'zh-TW': { title: `Fantay ${latest.version}`, body: latest.summary['zh-TW'].join('\n'), ctaLabel: '查看 Fantay' },
    },
  }, null, 2) + '\n');
  output.set('docs/releases/releases.json', JSON.stringify({ schemaVersion: 1, timeZone: 'Asia/Taipei', latest: latest.version, releases }, null, 2) + '\n');
  output.set('docs/releases/index.html', renderFantayReleaseHtml(releases));
  output.set('docs/releases/README.md', `# Fantay 更新日志\n\n[网页详细版](index.html) · [网站 JSON 数据](releases.json)\n\n${[...releases].reverse().map(r => `- [${r.version} — ${r.title}](${r.version}.md) · ${r.date} · ${r.status === 'published' ? '已发布' : '本地准备'}`).join('\n')}\n\n编辑来源：\`packages/contracts/src/fantay-releases.ts\`。运行 \`mise x -- pnpm tools-release sync-version\` 同步所有输出。历史 OpenDesign 日志保留于 \`../CHANGELOG\`，不参与 Fantay 的每日版本计数。\n`);
  const changes: Array<[string, string]> = [];
  for (const [name, content] of output) {
    const previous = await readFile(resolve(root, name), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e; });
    if (previous !== content) changes.push([name, content]);
  }
  if (check && changes.length) throw new Error(`Version/release outputs are out of sync: ${changes.map(([name]) => name).join(', ')}`);
  if (!check) for (const [name, content] of changes) { await mkdir(join(root, name, '..'), { recursive: true }); await writeFile(resolve(root, name), content); }
  return changes.map(([name]) => name);
}
