import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { LOCALE_LABEL, LOCALES, useI18n, type Locale } from '../i18n';
import { Icon } from './Icon';

const POPOVER_EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];
const POPOVER_EASE_EXIT: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94];

function keepOptionInPopoverView(popover: HTMLElement, option: HTMLElement, center = false) {
  const pad = 5;
  const optionTop = option.offsetTop;
  const optionBottom = optionTop + option.offsetHeight;
  const viewTop = popover.scrollTop;
  const viewBottom = viewTop + popover.clientHeight;
  if (center) {
    const target = optionTop - (popover.clientHeight - option.offsetHeight) / 2;
    popover.scrollTop = Math.max(0, target);
    return;
  }
  if (optionTop - pad < viewTop) {
    popover.scrollTop = Math.max(0, optionTop - pad);
  } else if (optionBottom + pad > viewBottom) {
    popover.scrollTop = optionBottom + pad - popover.clientHeight;
  }
}

/**
 * Compact language switcher rendered as a foot-pill in the entry view's
 * lower-left corner. Mirrors the "Local CLI · agent" pill so it doesn't
 * fight for visual weight, but remains discoverable for first-time users
 * who'd rather not dig into the settings dialog just to swap languages.
 */
export function LanguageMenu({
  compact = false,
  placement = 'up',
  align = 'start',
}: {
  compact?: boolean;
  placement?: 'up' | 'down';
  align?: 'start' | 'end';
} = {}) {
  const { locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<'active' | 'first' | 'last' | null>(null);

  const closeMenu = useCallback((restoreTriggerFocus = false) => {
    setOpen(false);
    if (restoreTriggerFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const focusInside = Boolean(wrapRef.current && wrapRef.current.contains(document.activeElement));
      closeMenu(focusInside);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closeMenu]);

  useLayoutEffect(() => {
    if (!open) return;
    const popover = popoverRef.current;
    if (!popover) return;
    const items = Array.from(popover.querySelectorAll<HTMLButtonElement>('.lang-menu-item'));
    const activeItem = popover.querySelector<HTMLButtonElement>('.lang-menu-item.active');
    const focusIntent = pendingFocusRef.current;
    pendingFocusRef.current = null;

    if (activeItem) {
      keepOptionInPopoverView(popover, activeItem, true);
    }
    if (focusIntent && items.length > 0) {
      const target =
        focusIntent === 'first'
          ? items[0]
          : focusIntent === 'last'
            ? items[items.length - 1]
            : (activeItem ?? items[0]);
      target?.focus();
      if (target) keepOptionInPopoverView(popover, target);
    }
  }, [open]);

  function handleTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      pendingFocusRef.current = open ? 'first' : 'active';
      setOpen(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      pendingFocusRef.current = open ? 'last' : 'active';
      setOpen(true);
    }
  }

  function handleMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const popover = popoverRef.current;
    if (!popover) return;
    const items = Array.from(popover.querySelectorAll<HTMLButtonElement>('.lang-menu-item'));
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const activeIndex = Math.max(0, LOCALES.indexOf(locale));

    let nextIndex = -1;
    if (e.key === 'ArrowDown') {
      nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : activeIndex;
    } else if (e.key === 'ArrowUp') {
      nextIndex = currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : activeIndex;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = items.length - 1;
    }

    if (nextIndex >= 0) {
      e.preventDefault();
      const target = items[nextIndex];
      if (target) {
        target.focus();
        keepOptionInPopoverView(popover, target);
      }
    }
  }

  const enterOffsetY = placement === 'up' ? 6 : -6;
  const exitOffsetY = placement === 'up' ? 4 : -4;

  return (
    <div className="lang-menu-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`foot-pill lang-pill${compact ? ' lang-pill--compact' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? LOCALE_LABEL[locale] : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
        title={LOCALE_LABEL[locale]}
      >
        <Icon name="translate" size={compact ? 16 : 14} className="lang-pill__icon" />
        {compact ? null : (
          <>
            <span className="lang-pill__label">{LOCALE_LABEL[locale]}</span>
            <Icon name="chevron-down" size={12} className="lang-pill__chevron" />
          </>
        )}
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            ref={popoverRef}
            className={`lang-menu-popover lang-menu-popover--${placement}${
              compact ? ' lang-menu-popover--compact' : ''
            } lang-menu-popover--align-${align}`}
            role="menu"
            onKeyDown={handleMenuKeyDown}
            initial={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, y: enterOffsetY, scale: 0.97 }
            }
            animate={
              reducedMotion
                ? { opacity: 1, transition: { duration: 0.1 } }
                : {
                    opacity: 1,
                    y: 0,
                    scale: 1,
                    transition: { duration: 0.18, ease: POPOVER_EASE_OUT },
                  }
            }
            exit={
              reducedMotion
                ? { opacity: 0, transition: { duration: 0.08 } }
                : {
                    opacity: 0,
                    y: exitOffsetY,
                    scale: 0.985,
                    transition: { duration: 0.11, ease: POPOVER_EASE_EXIT },
                  }
            }
          >
            {LOCALES.map((code) => {
              const active = locale === code;
              return (
                <button
                  key={code}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  className={`lang-menu-item${active ? ' active' : ''}`}
                  onClick={() => {
                    setLocale(code as Locale);
                    setOpen(false);
                  }}
                >
                  <span className="lang-menu-label">{LOCALE_LABEL[code]}</span>
                  <span className="lang-menu-code" dir="ltr">{code}</span>
                  <span className="lang-menu-check" aria-hidden>
                    {active ? <Icon name="check" size={14} /> : null}
                  </span>
                </button>
              );
            })}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
