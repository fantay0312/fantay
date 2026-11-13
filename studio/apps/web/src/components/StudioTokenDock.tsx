// The inspector for one selected token. It stays mounted, so opening and closing can animate, and
// keeps the last token's content on screen while it leaves.
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseStudioTokens, resolveStudioToken, type StudioDocument, type StudioToken, type StudioTokenGroup } from '@open-design/contracts';
import { Button } from '../fantay/ui';
import { contrastRatio, parseStudioColor, studioPalette, studioTokenLabel } from '../runtime/studio-palette';
import { applyStudioTokenEdit, removeStudioTokenEverywhere, studioTokenEditMessage, studioTokenLine, studioTokenScopeLabel, studioTokenScopes } from '../runtime/studio-token-edit';
import { Icon } from './Icon';
import { specimenTokenLabel, specimenTokenNote, StudioTokenMini } from './StudioSpecimens';
import styles from './StudioTokenDock.module.css';

interface Props {
  name: string | null; css: string; document: StudioDocument; editable: boolean; busy: boolean; chinese: boolean;
  /** The theme the page is previewing; the header swatch and the copied value follow it. */
  scope?: string;
  onSave: (css: string) => Promise<void>; onNote: (name: string) => void; onClose: () => void;
}
interface Failure { name: string; scope: string | null; message: string }
interface BodyProps {
  name: string; tokens: StudioToken[]; document: StudioDocument; editable: boolean; busy: boolean; chinese: boolean;
  scope: string;
  failure: Failure | null;
  onCommit: (name: string, value: string, scope: string, group: StudioTokenGroup) => void;
  onCancel: () => void; onRemove: (name: string) => void; onNote: (name: string) => void; onClose: () => void;
}

/** Long enough for the 120ms crossfade to finish before the outgoing layer unmounts. */
const SWAP_MS = 140;
const BASE_SCOPE = ':root';
const editing = 'input, textarea, select, [contenteditable="true"]';
const overlay = '[role="dialog"], [role="alertdialog"], dialog[open], [role="menu"], [role="listbox"]';

/** Token names go into attribute selectors; jsdom has no `CSS.escape`, so quotes and backslashes are escaped by hand there. */
function escapeName(name: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(name) : name.replace(/["\\]/g, '\\$&');
}
/** The tile or colour card that shows a token; a colour card also answers for the tokens that repeat its value. */
function tokenTarget(name: string): HTMLElement | null {
  const key = escapeName(name);
  return window.document.querySelector<HTMLElement>(`[data-token="${key}"], [data-palette-card="${key}"], [data-palette-aliases~="${key}"]`);
}

export function StudioTokenDock({ name, css, document: doc, editable, busy, chinese, scope = BASE_SCOPE, onSave, onNote, onClose }: Props) {
  const tokens = useMemo(() => parseStudioTokens(css), [css]);
  const [shown, setShown] = useState(name || null);
  const [previous, setPrevious] = useState(name);
  const [leaving, setLeaving] = useState<string | null>(null);
  if (name !== previous) {
    setPrevious(name);
    if (name) {
      setShown(name);
      // Only a swap between two open tokens crossfades; reopening keeps its plain entrance.
      if (previous && previous !== name) setLeaving(previous);
    }
  }
  const exists = shown !== null && tokens.some((token) => token.name === shown);
  const open = Boolean(name) && exists;
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), SWAP_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  useEffect(() => { if (!name) setFailure(null); }, [name]);

  const panel = useRef<HTMLElement>(null);
  // React 18 drops a boolean `inert`, so it is set on the node.
  useEffect(() => { panel.current?.toggleAttribute('inert', !open); }, [open]);

  // The panel floats over the end of the column, so the column keeps room for it to scroll past.
  // It only ever grows: giving the room back on close would jump a page scrolled to its end.
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const node = panel.current;
    if (!open || !node || typeof ResizeObserver === 'undefined') return;
    const measure = () => setRoom((height) => Math.max(height, node.offsetHeight + 24));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open]);

  // The panel lands over the column, so a tile or colour card picked near the bottom edge has to
  // clear it, the card whole, tint strip and mark included.
  useEffect(() => {
    const node = panel.current;
    const tile = open && name ? tokenTarget(name) : null;
    if (!node || !tile?.scrollIntoView) return;
    tile.style.scrollMarginBottom = node.offsetHeight + 28 + 'px';
    tile.scrollIntoView({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [open, name]);

  const close = () => {
    // Hand focus back to the tile, since the dock is about to turn inert. Specimen tiles carry the
    // name in `data-token`; a colour card is a wrapper whose button is the focusable part.
    const target = shown ? tokenTarget(shown) : null;
    (target?.matches('[data-token]') ? target : target?.querySelector<HTMLElement>('[aria-pressed]'))?.focus({ preventScroll: true });
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    // Capture phase: this runs before a dialog or menu reacts and unmounts itself, so the overlay
    // check still sees it open, and one Escape never closes both the overlay and the dock.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if ((event.target as Element | null)?.closest?.(editing)) return;
      // The note dialog and the header menus open over the dock; their Escape belongs to them.
      if (window.document.querySelector(overlay)) return;
      closeRef.current();
      // Tells an outer Escape layer, such as leaving full screen, that the key was used.
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  async function commit(target: string, value: string, scope: string, group: StudioTokenGroup) {
    try {
      const next = applyStudioTokenEdit(css, target, value, scope, group);
      if (next !== null) await onSave(next);
      setFailure(null);
    } catch (error) { setFailure({ name: target, scope, message: studioTokenEditMessage(error, chinese) }); }
  }
  async function remove(target: string) {
    if (!window.confirm(chinese ? '删除这个变量在所有主题中的值？修改历史中会保留旧版本。' : 'Delete this token in every theme? Previous values remain in history.')) return;
    try {
      await onSave(removeStudioTokenEverywhere(css, target));
      setFailure(null);
      onClose();
    } catch (error) { setFailure({ name: target, scope: null, message: studioTokenEditMessage(error, chinese) }); }
  }

  const body = { tokens, document: doc, editable, busy, chinese, scope, failure, onCommit: (target: string, value: string, scope: string, group: StudioTokenGroup) => void commit(target, value, scope, group), onCancel: () => setFailure(null), onRemove: (target: string) => void remove(target), onNote, onClose: close };
  return <>
    <div style={{ height: room }} aria-hidden="true" />
    <div className={styles.dock} data-studio-dock="" data-open={open || undefined}>
      <section ref={panel} className={styles.panel} aria-label={chinese ? '变量详情' : 'Token details'} aria-hidden={open ? undefined : true}>
        {leaving && tokens.some((token) => token.name === leaving) && <div className={styles.leaving} aria-hidden="true" ref={(node) => node?.setAttribute('inert', '')}><DockBody {...body} name={leaving} failure={null} /></div>}
        {shown && exists && <div key={shown} className={leaving ? styles.entering : undefined}><DockBody {...body} name={shown} /></div>}
        {failure && <p role="alert" className={styles.error}>{failure.name !== shown ? failure.name + ': ' : ''}{failure.message}</p>}
      </section>
    </div>
  </>;
}

function DockBody({ name, tokens, document: doc, editable, busy, chinese, scope: previewed, failure, onCommit, onCancel, onRemove, onNote, onClose }: BodyProps) {
  const group = tokens.find((token) => token.name === name)?.group ?? 'other';
  const scopes = useMemo(() => studioTokenScopes(tokens, group, doc.themes), [tokens, group, doc.themes]);
  const palettes = useMemo(() => new Map(group === 'colors' ? scopes.map((scope) => [scope, studioPalette(tokens, scope, doc.tokenNotes, chinese)]) : []), [group, scopes, tokens, doc.tokenNotes, chinese]);
  // The header shows the theme on screen, so the swatch and the copied value match the page.
  const base = useMemo(() => studioPalette(tokens, previewed, doc.tokenNotes, chinese), [tokens, previewed, doc.tokenNotes, chinese]);
  const value = studioTokenLine(resolveStudioToken(name, tokens, previewed) ?? '');
  const themed = previewed !== BASE_SCOPE;
  const label = group === 'colors' ? studioTokenLabel(name, chinese) : specimenTokenLabel(name, chinese);
  const note = specimenTokenNote(name, doc.tokenNotes, chinese);
  return <div className={styles.body}>
    <header className={styles.head}>
      <StudioTokenMini name={name} group={group} value={value} ink={base.ink} ground={base.ground} />
      <div className={styles.title}>
        <p className={styles.label}>{label}<code>{name}</code></p>
        {note && <p className={styles.note}>{note}</p>}
      </div>
      <div className={styles.actions}>
        <CopyButton text={`var(${name})`} label={chinese ? '复制变量' : 'Copy variable'} short="var()" />
        <CopyButton text={value} title={themed ? `${value} · ${studioTokenScopeLabel(previewed, doc.themes, chinese)}` : value} label={chinese ? '复制值' : 'Copy value'} short={chinese ? '值' : 'Value'} disabled={!value} />
        <span className={styles.rule} />
        {/* Notes are edited, not read, from here; a read-only preset already shows its note above. */}
        {editable && <Button variant="bare" size="icon-sm" aria-label={(chinese ? '编辑说明 ' : 'Edit notes ') + name} title={chinese ? '说明' : 'Notes'} onClick={() => onNote(name)}><Icon name="comment" size={15} /></Button>}
        {editable && <Button variant="bare" size="icon-sm" aria-label={(chinese ? '删除 ' : 'Delete ') + name} title={chinese ? '删除' : 'Delete'} disabled={busy} onClick={() => onRemove(name)}><Icon name="trash" size={14} /></Button>}
        <Button variant="bare" size="icon-sm" aria-label={chinese ? '关闭详情' : 'Close details'} title={chinese ? '关闭' : 'Close'} onClick={onClose}><Icon name="close" size={14} /></Button>
      </div>
    </header>
    <div className={styles.fields}>
      {scopes.map((scope) => {
        const own = tokens.filter((token) => token.name === name && token.scope === scope).at(-1)?.value ?? null;
        const resolved = resolveStudioToken(name, tokens, scope);
        const palette = palettes.get(scope);
        const card = palette?.cards.find((item) => item.name === name);
        const ground = palette ? parseStudioColor(palette.ground)?.rgb : null;
        const contrast = card?.rgb && ground ? contrastRatio(card.rgb, ground) : null;
        return <ValueField
          key={scope + (own ?? '')} name={name} scope={scope} group={group} own={own} resolved={resolved}
          scopeLabel={studioTokenScopeLabel(scope, doc.themes, chinese)} single={scopes.length === 1} contrast={contrast} graded={card?.contrast != null}
          readOnly={!editable || busy} editable={editable} chinese={chinese}
          invalid={failure?.name === name && failure.scope === scope}
          onCommit={onCommit} onCancel={onCancel}
        />;
      })}
    </div>
  </div>;
}

function CopyButton({ text, title = text, label, short, disabled }: { text: string; title?: string; label: string; short: string; disabled?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1200);
    return () => window.clearTimeout(timer);
  }, [done]);
  return <Button variant="bare" size="sm" className={styles.copy} aria-label={label} title={title} disabled={disabled} onClick={() => { void navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false)); }}>
    <Icon name={done ? 'check' : 'copy'} size={13} /><span className={styles.copyText}>{short}</span>
  </Button>;
}

interface FieldProps {
  name: string; scope: string; scopeLabel: string; single: boolean; group: StudioTokenGroup; own: string | null; resolved: string | null;
  contrast: number | null; graded: boolean; readOnly: boolean; editable: boolean; invalid: boolean; chinese: boolean;
  onCommit: BodyProps['onCommit']; onCancel: () => void;
}
function ValueField({ name, scope, scopeLabel, single, group, own, resolved: raw, contrast, graded, readOnly, editable, invalid, chinese, onCommit, onCancel }: FieldProps) {
  const saved = studioTokenLine(own ?? '');
  const resolved = raw === null ? null : studioTokenLine(raw);
  const [draft, setDraft] = useState(saved);
  const canceled = useRef(false);
  // An edit left while a save or load holds the field read-only is kept, and saved once it lets go.
  const pending = useRef(false);
  const colour = group === 'colors';
  const hex = colour ? pickerHex(draft || resolved) : null;
  const commit = (value: string) => onCommit(name, value, scope, group);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    if (readOnly || !pending.current) return;
    pending.current = false;
    // The latest commit applies the edit to the css as it is now, not as it was at blur.
    commitRef.current(draft);
  }, [readOnly, draft]);
  const chip = contrast !== null && contrast >= 1.05 ? contrast : null;
  const picker = useRef<HTMLInputElement>(null);
  const showPicker = hex !== null && editable;
  useEffect(() => {
    // React's onChange fires on every drag of the native picker; `change` marks the settled colour.
    const node = picker.current;
    if (!node) return;
    const settled = () => commitRef.current(node.value);
    node.addEventListener('change', settled);
    return () => node.removeEventListener('change', settled);
  }, [showPicker]);
  return <div className={styles.field}>
    {/* A system with one theme has nothing for the caption to tell apart; the contrast stays. */}
    {(!single || chip !== null) && <div className={styles.fieldHead}>
      {!single && <span>{scopeLabel}</span>}
      {chip !== null && <Contrast ratio={chip} graded={graded} chinese={chinese} />}
    </div>}
    <div className={styles.control} data-invalid={invalid || undefined}>
      {colour && <span className={styles.swatch} style={{ background: draft || resolved || 'transparent' }}>
        {showPicker && <input ref={picker} type="color" className={styles.picker} aria-label={(chinese ? '取色 ' : 'Pick colour ') + name + ' · ' + scope} value={hex} disabled={readOnly} onChange={(event) => setDraft(event.target.value)} />}
      </span>}
      <input
        aria-label={name + ' · ' + scope} aria-invalid={invalid || undefined} className={styles.input} value={draft} readOnly={readOnly}
        placeholder={own === null && resolved ? (chinese ? '继承 ' : 'Inherits ') + resolved : '—'} spellCheck={false} autoComplete="off" title={draft || resolved || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (canceled.current) { canceled.current = false; return; }
          if (draft === saved) return;
          if (!readOnly) commit(draft);
          else if (editable) pending.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') { canceled.current = true; pending.current = false; setDraft(saved); onCancel(); event.currentTarget.blur(); }
        }}
      />
    </div>
    {own?.includes('var(') && <p className={resolved ? styles.alias : styles.aliasBroken}>{resolved ? '↳ ' + resolved : chinese ? '循环或未定义的引用' : 'Circular or missing alias'}</p>}
  </div>;
}

/** Only text is held to WCAG grades. A surface or an edge is meant to sit close to the ground. */
function Contrast({ ratio, graded, chinese }: { ratio: number; graded: boolean; chinese: boolean }) {
  const grade = ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? (chinese ? '大字' : 'Large') : (chinese ? '不足' : 'Low');
  return <span className={graded && ratio < 3 ? styles.contrastLow : styles.contrast} title={chinese ? '与底色的对比度' : 'Contrast against the ground'}>{graded ? grade + ' ' : ''}{ratio.toFixed(1)}:1</span>;
}

/** The native picker only takes #rrggbb; an alias or an alpha value stays text-only. */
function pickerHex(value: string | null): string | null {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value?.trim() ?? '');
  if (!match) return null;
  const digits = match[1]!;
  return '#' + (digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits).toLowerCase();
}
