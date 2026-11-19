// SPDX-License-Identifier: AGPL-3.0-only
// Pure path helper of the 代码 surface.

/**
 * The absolute path of a project file, in the spelling of the project directory: a Windows
 * directory (backslashes, no forward slash) gets backslashes all the way.
 */
export function joinProjectPath(resolvedDir: string, name: string): string {
  const windows = resolvedDir.includes('\\') && !resolvedDir.includes('/');
  const separator = windows ? '\\' : '/';
  const base = resolvedDir.endsWith(separator) ? resolvedDir.slice(0, -1) : resolvedDir;
  return `${base}${separator}${windows ? name.split('/').join('\\') : name}`;
}
