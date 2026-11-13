import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '../fantay/ui';
import { Icon } from './Icon';
import styles from './StudioHandbook.module.css';

const EXIT_MS = 140;

function canAnimate(dialog: HTMLDialogElement | null): boolean {
  if (typeof dialog?.animate !== 'function') return false;
  return !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Children may be a function of `dismiss`, so a Cancel button inside the dialog leaves the same way
 * the close button and Escape do. `onClose` unmounts the dialog, so the exit has to play before it.
 */
export function StudioDialog({ title, children, onClose, className = '', pending = false }: {
  title: string; children: ReactNode | ((dismiss: () => void) => ReactNode); onClose: () => void; className?: string; pending?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [closing, setClosing] = useState(false);
  // Unmounting an open dialog skips the browser's own focus return, so the opener is refocused by hand.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (ref.current?.showModal) ref.current.showModal(); else ref.current?.setAttribute('open', '');
    // React's autoFocus runs before showModal and is lost; a field marked data-autofocus gets focus here.
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const dismiss = () => {
    if (pending || closing) return;
    if (!canAnimate(ref.current)) { onClose(); return; }
    setClosing(true);
    timer.current = setTimeout(onClose, EXIT_MS);
  };
  // The tooltip would portal under the dialog's top layer, so the close button goes without one.
  return createPortal(<dialog ref={ref} className={styles.dialog + ' fx ' + className} data-closing={closing || undefined} aria-label={title} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header><h3>{title}</h3><IconButton size="sm" tooltip={false} aria-label="关闭 / Close" disabled={pending} onClick={dismiss}><Icon name="close" size={16} /></IconButton></header>{typeof children === 'function' ? children(dismiss) : children}
  </dialog>, document.body);
}
