// One path for editing a single token, so the precise table and the inspector dock refuse the same
// values for the same reasons and word those reasons the same way.
import { editStudioToken, parseStudioTokens, removeStudioToken, resolveStudioToken, studioTokenValueSupported, type StudioTheme, type StudioToken, type StudioTokenGroup } from '@open-design/contracts';
import { studioScopeLabel } from './studio-palette';

export type StudioTokenEditError = 'INVALID' | 'ALIAS' | 'BASE_REQUIRED' | 'REFERENCED';

const reject = (code: StudioTokenEditError) => new Error(code);

/** Returns next css, or null when nothing changed; throws Error(StudioTokenEditError). */
export function applyStudioTokenEdit(css: string, name: string, value: string, scope: string, group: StudioTokenGroup): string | null {
  const own = parseStudioTokens(css).filter((token) => token.name === name && token.scope === scope).at(-1) ?? null;
  const trimmed = value.trim();
  if (own?.value === trimmed) return null;
  if (!trimmed) {
    if (!own) return null;
    // Only a theme override can be cleared back to inheritance; the base value is what it inherits.
    if (scope === ':root') throw reject('BASE_REQUIRED');
    return css.slice(0, own.start) + css.slice(own.end);
  }
  if (typeof CSS !== 'undefined' && CSS.supports && !studioTokenValueSupported(group, name, trimmed, (property, value) => CSS.supports(property, value))) throw reject('INVALID');
  let next: string;
  try { next = editStudioToken(css, own, name, trimmed, scope); } catch { throw reject('INVALID'); }
  if (trimmed.includes('var(') && resolveStudioToken(name, parseStudioTokens(next), scope) === null) throw reject('ALIAS');
  return next;
}

/** Removes the token from every theme; throws Error('REFERENCED') while anything still aliases it. */
export function removeStudioTokenEverywhere(css: string, name: string): string {
  // Last occurrence first, so the offsets of the earlier ones stay valid.
  const own = parseStudioTokens(css).filter((token) => token.name === name).sort((a, b) => b.start - a.start);
  try { return own.reduce((next, token) => removeStudioToken(next, token), css); } catch { throw reject('REFERENCED'); }
}

/** A value as one line: declarations often span several, and an input would keep their indent. */
export const studioTokenLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * The themes a token group is edited in, base theme first. As in `studioThemeScopes`, `:root` only
 * joins when the group declares something there (or nothing else is offered), so a package written
 * as `:root, .light {…}` gets no empty base field beside the scope that holds its values.
 */
export function studioTokenScopes(tokens: StudioToken[], group: StudioTokenGroup, themes: StudioTheme[]): string[] {
  const themed = group === 'colors' || group === 'shadows' ? themes.map((theme) => theme.selector) : [];
  const declared = tokens.filter((token) => token.group === group).map((token) => token.scope);
  const rest = Array.from(new Set([...themed, ...declared])).filter((scope) => scope !== ':root');
  return declared.includes(':root') || !rest.length ? [':root', ...rest] : rest;
}

export function studioTokenScopeLabel(scope: string, themes: StudioTheme[], chinese: boolean): string {
  if (/prefers-reduced-motion/.test(scope)) return chinese ? '减弱动态' : 'Reduced motion';
  return studioScopeLabel(scope, themes, chinese);
}

export function studioTokenEditMessage(error: unknown, chinese: boolean): string {
  switch (error instanceof Error ? error.message : '') {
    case 'INVALID': return chinese ? '这个值对该变量无效，未保存。' : 'That value is not valid for this token. Not saved.';
    case 'ALIAS': return chinese ? '引用的变量不存在，或形成了循环，未保存。' : 'The alias points to a missing token or a loop. Not saved.';
    case 'BASE_REQUIRED': return chinese ? '基础主题必须有值。要移除这个变量，请用删除。' : 'The base theme needs a value. Use Delete to remove the token.';
    case 'REFERENCED': return chinese ? '其他变量仍在引用它，请先处理这些引用。' : 'Other tokens still reference this one. Update them first.';
    default: return chinese ? '未能保存。请刷新后重试。' : 'Not saved. Reload and try again.';
  }
}
