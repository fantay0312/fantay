import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button } from '../fantay/ui';
import { parseStudioTokens, resolveStudioToken, studioContrast, type StudioDocument, type StudioTokenGroup } from '@open-design/contracts';
import { applyStudioTokenEdit, removeStudioTokenEverywhere, studioTokenEditMessage, studioTokenLine, studioTokenScopeLabel, studioTokenScopes } from '../runtime/studio-token-edit';
import { Icon } from './Icon';
import styles from './StudioTokenTable.module.css';

interface Props {
  css: string; group: StudioTokenGroup; document: StudioDocument; editable: boolean; busy: boolean; chinese: boolean;
  onSave: (css: string) => Promise<void>; onNote: (name: string) => void;
}

/** The precise view: every token against every theme, one row each. Specimens carry the visuals. */
export function StudioTokenTable({ css, group, document, editable, busy, chinese, onSave, onNote }: Props) {
  const tokens = useMemo(() => parseStudioTokens(css), [css]);
  const scopes = useMemo(() => studioTokenScopes(tokens, group, document.themes), [tokens, group, document.themes]);
  const { names, sets, tokenByScopeName, resolvedByScopeName, backgroundByScope } = useMemo(() => {
    const seen = new Set<string>();
    const groupNames: string[] = [];
    const byScopeName = new Map<string, (typeof tokens)[number]>();
    for (const token of tokens) {
      byScopeName.set(`${token.scope}\u0000${token.name}`, token);
      if (token.group === group && !seen.has(token.name)) {
        seen.add(token.name);
        groupNames.push(token.name);
      }
    }
    const groupedSets = new Map<string, string[]>();
    for (const name of groupNames) {
      const label = document.tokenNotes[name]?.group ?? '';
      let list = groupedSets.get(label);
      if (!list) {
        list = [];
        groupedSets.set(label, list);
      }
      list.push(name);
    }
    const allTokenNames = new Set(tokens.map((item) => item.name));
    const bgName = ['--bg', '--color-paper', '--paper', '--background'].find((key) => allTokenNames.has(key));
    const bgByScope = new Map<string, string | null>();
    const resolvedMap = new Map<string, string | null>();
    for (const scope of scopes) {
      bgByScope.set(scope, bgName ? resolveStudioToken(bgName, tokens, scope) : null);
      for (const name of groupNames) {
        resolvedMap.set(`${scope}\u0000${name}`, resolveStudioToken(name, tokens, scope));
      }
    }
    return {
      names: groupNames,
      sets: groupedSets,
      tokenByScopeName: byScopeName,
      resolvedByScopeName: resolvedMap,
      backgroundByScope: bgByScope,
    };
  }, [tokens, group, document.tokenNotes, scopes]);
  const [error, setError] = useState('');
  async function save(name: string, value: string, scope: string) {
    try {
      const next = applyStudioTokenEdit(css, name, value, scope, group);
      setError('');
      if (next !== null) await onSave(next);
    } catch (failure) { setError(studioTokenEditMessage(failure, chinese)); }
  }
  async function remove(name: string) {
    if (!window.confirm(chinese ? '删除这个变量在所有主题中的值？修改历史中会保留旧版本。' : 'Delete this token in every theme? Previous values remain in history.')) return;
    try { await onSave(removeStudioTokenEverywhere(css, name)); setError(''); } catch (failure) { setError(studioTokenEditMessage(failure, chinese)); }
  }
  if (!names.length) return <p className={styles.empty}>{chinese ? '还没有设计变量，点击「添加」开始。' : 'No tokens yet. Use Add to create one.'}</p>;
  const layerLabels = { primitive: chinese ? '基础' : 'Primitive', semantic: chinese ? '语义' : 'Semantic', component: chinese ? '组件' : 'Component' };
  return <div className={styles.root} style={{ '--columns': scopes.length } as CSSProperties}>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead><tr>
          <th scope="col">{chinese ? '名称' : 'Name'}</th>
          {scopes.map((scope) => <th key={scope} scope="col">{studioTokenScopeLabel(scope, document.themes, chinese)}</th>)}
          <th aria-label={chinese ? '说明' : 'Notes'} />
        </tr></thead>
        {[...sets].map(([label, setNames]) => <tbody key={label}>
          {label && <tr className={styles.setRow}><th scope="rowgroup" colSpan={scopes.length + 2}>{label}</th></tr>}
          {setNames.map((name) => {
            const layer = document.tokenNotes[name]?.layer;
            return <tr key={name}>
              <th scope="row"><span className={styles.name}><code title={name}>{name.replace(/^--/, '')}</code>{layer && <small>{layerLabels[layer]}</small>}</span></th>
              {scopes.map((scope) => {
                const cellKey = `${scope}\u0000${name}`;
                const token = tokenByScopeName.get(cellKey);
                const resolved = resolvedByScopeName.get(cellKey) ?? null;
                const value = resolved === null ? null : studioTokenLine(resolved);
                const background = backgroundByScope.get(scope) ?? null;
                const ratio = group === 'colors' && value && background && /ink|text|foreground|fg|on-|link/.test(name) ? studioContrast(value, background) : null;
                const own = studioTokenLine(token?.value ?? '');
                const alias = own.includes('var(');
                const input = <TokenInput key={scope + name + (token?.value ?? '')} label={name + ' · ' + scope} value={own} display={referencedName(own)} placeholder={!token && value ? (chinese ? '继承 ' : 'Inherits ') + value : '—'} readOnly={!editable || busy} onSave={(next) => void save(name, next, scope)} />;
                return <td key={scope} className={token ? undefined : styles.inherited}>
                  <div className={styles.field} data-alias={alias || undefined}>
                    {group === 'colors' && <span className={styles.swatch} style={{ background: value || 'transparent' }} />}
                    {alias
                      // An alias reads as two lines: the token it names, then the value that resolves to.
                      ? <span className={styles.stack}>{input}<small className={value ? styles.resolved : styles.broken} title={value ?? undefined}>{value ? '↳ ' + value : chinese ? '引用失效' : 'Broken alias'}</small></span>
                      : input}
                    {ratio !== null && <small className={ratio >= 4.5 ? styles.pass : styles.fail} title={chinese ? '与当前背景的对比度' : 'Contrast against the background'}>{ratio.toFixed(1)}:1</small>}
                  </div>
                </td>;
              })}
              <td className={styles.actions}>
                <Button variant="bare" size="icon-sm" title={document.tokenNotes[name]?.description || (chinese ? '变量说明' : 'Token notes')} aria-label={(chinese ? '编辑说明 ' : 'Edit notes ') + name} onClick={() => onNote(name)}><Icon name="comment" size={15} /></Button>
                {editable && <Button variant="bare" size="icon-sm" className={styles.delete} aria-label={(chinese ? '删除 ' : 'Delete ') + name} disabled={busy} onClick={() => void remove(name)}><Icon name="trash" size={14} /></Button>}
              </td>
            </tr>;
          })}
        </tbody>)}
      </table>
    </div>
  </div>;
}

/** The token a value only points at, `var(--name)` with or without a fallback, without the wrapper. */
function referencedName(value: string): string | undefined {
  return /^var\(\s*--([\w-]+)\s*(?:,[\s\S]*)?\)$/.exec(value)?.[1];
}

/** `display` stands in for an unchanged value while the field is not being edited; editing shows the CSS. */
function TokenInput({ value, display, placeholder, label, readOnly, onSave }: { value: string; display?: string; placeholder: string; label: string; readOnly: boolean; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const canceled = useRef(false);
  const shown = display !== undefined && !focused && draft === value ? display : draft;
  return <input
    aria-label={label} value={shown} placeholder={placeholder} readOnly={readOnly} spellCheck={false} autoComplete="off" title={draft || placeholder}
    onChange={(event) => setDraft(event.target.value)}
    onFocus={() => setFocused(true)}
    onBlur={() => { setFocused(false); if (canceled.current) { canceled.current = false; return; } if (draft !== value) onSave(draft); }}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { canceled.current = true; setDraft(value); event.currentTarget.blur(); } }}
  />;
}
