// Reference packet for agents. Structurally identical to
// `fantasy-design context <ids> --task <text> --format markdown`
// (`markdown()` in `素材库/导览支持/scripts/fantasy_design.py`): same heading,
// task line, per-item block, snake_case metadata labels, `[missing]` markers
// and the closing reuse notice.

import type { MaterialDetail } from '@open-design/contracts';

export const MATERIAL_CONTEXT_HEADING = '# Fantasy Design 设计参考包';

const METADATA_LINES: ReadonlyArray<readonly [label: string, pick: (item: MaterialDetail) => unknown]> = [
  ['status', (item) => item.status],
  ['source', (item) => item.source],
  ['preview_kind', (item) => item.previewKind],
  ['preview_note', (item) => item.previewNote],
  ['collection_root', (item) => item.collectionRoot],
];

export function renderMaterialContextMarkdown(
  task: string,
  items: readonly MaterialDetail[],
  notice: string,
): string {
  const lines: string[] = [MATERIAL_CONTEXT_HEADING, '', task || '', ''];
  for (const item of items) {
    lines.push(
      `## ${item.title} (\`${item.id}\`)`,
      '',
      item.description || '',
      '',
      `- 入口：${item.absolutePath}`,
      `- 许可：${item.license}`,
    );
    for (const [label, pick] of METADATA_LINES) {
      const value = pick(item);
      if (value) lines.push(`- ${label}：${String(value)}`);
    }
    if (item.libraryName) lines.push(`- library：${item.libraryName}`);
    if (item.palette.length > 0) {
      lines.push(`- 色板：${item.palette.map((color) => `${color.name} ${color.value}`).join(' · ')}`);
    }
    for (const file of item.files) {
      lines.push(`- ${file.field}：${file.absolutePath}${file.exists ? '' : ' [missing]'}`);
    }
    lines.push('');
  }
  lines.push(notice);
  return lines.join('\n');
}
