// SPDX-License-Identifier: AGPL-3.0-only
// What a file's tab says. The tab shows the file's own name; the folder it lives in is drawn in the
// viewer's bar, right under the tab. Two open files that share a name keep their parent folder in
// front, so the tabs can still be told apart.

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export function fileTabLabel(path: string, openPaths: readonly string[]): string {
  const base = baseName(path);
  if (base === path) return path;
  const clashes = openPaths.some((other) => other !== path && baseName(other) === base);
  if (!clashes) return base;
  const parts = path.split('/');
  return `${parts[parts.length - 2]}/${base}`;
}
