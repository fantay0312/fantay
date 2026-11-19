import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';

export type MarkdownViewerMode = 'live' | 'preview' | 'split' | 'edit';

interface Props {
  modes: readonly MarkdownViewerMode[];
  selected: MarkdownViewerMode;
  labels: Record<MarkdownViewerMode, string>;
  label: string;
  panelId: string;
  animated: boolean;
  readOnly: boolean;
  disabledTitle: string;
  onPressPreview(mode: MarkdownViewerMode | null): void;
  onSelect(mode: MarkdownViewerMode): void;
}

export function MarkdownModeTabs({ modes, selected, labels, label, panelId, animated, readOnly, disabledTitle, onPressPreview, onSelect }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const pressSequence = useRef(0);
  const endPreview = useRef(onPressPreview);
  endPreview.current = onPressPreview;
  useEffect(() => {
    const cancel = () => {
      root.current?.style.removeProperty('--md-press-index');
      endPreview.current(null);
    };
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);
  const clearPress = () => {
    root.current?.style.removeProperty('--md-press-index');
    onPressPreview(null);
  };
  const available = readOnly ? modes.filter(mode => mode === 'preview') : modes;
  const select = (next: MarkdownViewerMode) => { clearPress(); if (next !== selected) onSelect(next); };
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, mode: MarkdownViewerMode) {
    const i = available.indexOf(mode);
    if (event.key === 'Escape') { clearPress(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const rtl = root.current?.matches(':dir(rtl)');
    let target: number;
    switch (event.key) {
      case 'ArrowLeft': target = i + (rtl ? 1 : -1); break;
      case 'ArrowRight': target = i + (rtl ? -1 : 1); break;
      case 'Home': target = 0; break;
      case 'End': target = available.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const next = available[(target + available.length) % available.length]!;
    root.current?.querySelector<HTMLButtonElement>('[data-mode="' + next + '"]')?.focus({ preventScroll: true });
    select(next);
  }
  return (
    <div ref={root} className="viewer-tabs markdown-mode-tabs" role="tablist" aria-label={label}
      data-sliding={animated && modes.length > 1 ? '' : undefined}
      onPointerLeave={clearPress} onPointerCancel={clearPress} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) clearPress(); }}
      style={{ '--md-tab-index': modes.indexOf(selected), '--md-tab-count': modes.length } as CSSProperties}>
      {modes.map((mode, index) => (
        <button key={mode} type="button" role="tab" id={panelId + '-' + mode} data-mode={mode}
          className={'viewer-tab' + (selected === mode ? ' active' : '')} aria-selected={selected === mode}
          aria-controls={panelId} tabIndex={selected === mode ? 0 : -1} disabled={readOnly && mode !== 'preview'}
          title={readOnly && mode !== 'preview' ? disabledTitle : undefined}
          onPointerDown={event => {
            pressSequence.current++;
            if (!animated || event.button !== 0 || !event.isPrimary || event.ctrlKey || event.metaKey) return;
            root.current?.style.setProperty('--md-press-index', String(index));
            if (event.pointerType === 'mouse') onPressPreview(mode);
          }}
          onPointerLeave={clearPress} onPointerUp={() => {
            const pressed = pressSequence.current;
            requestAnimationFrame(() => { if (pressed === pressSequence.current) clearPress(); });
          }}
          onKeyDown={event => onKeyDown(event, mode)} onClick={() => select(mode)}>
          {labels[mode]}
        </button>
      ))}
      {animated && modes.length > 1 && <span className="md-mode-indicator" aria-hidden="true" />}
    </div>
  );
}
