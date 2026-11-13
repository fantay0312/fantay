// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LanguageMenu } from '../../src/components/LanguageMenu';
import { I18nProvider, LOCALES, type Locale } from '../../src/i18n';

afterEach(() => {
  cleanup();
});

function renderLanguageMenu(locale: Locale = 'zh-CN', props?: Parameters<typeof LanguageMenu>[0]) {
  return render(
    <I18nProvider initial={locale}>
      <LanguageMenu {...props} />
    </I18nProvider>,
  );
}

describe('LanguageMenu', () => {
  it('opens immediately with all 19 locales, marks the active locale, and updates selection', async () => {
    const { container } = renderLanguageMenu('zh-CN');
    const trigger = container.querySelector<HTMLButtonElement>('.lang-pill')!;
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.lang-menu-popover')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const popover = container.querySelector('.lang-menu-popover');
    expect(popover?.classList.contains('lang-menu-popover--up')).toBe(true);
    expect(popover?.classList.contains('lang-menu-popover--align-start')).toBe(true);

    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(LOCALES.length);
    const active = container.querySelector('.lang-menu-item.active');
    expect(active?.getAttribute('aria-checked')).toBe('true');
    expect(active?.querySelector('.lang-menu-code')?.textContent).toBe('zh-CN');
    expect(container.querySelectorAll('.lang-menu-check svg')).toHaveLength(1);

    const englishOption = items.find((el) => el.querySelector('.lang-menu-code')?.textContent === 'en')!;
    fireEvent.click(englishOption);

    await waitFor(() => {
      expect(container.querySelector('.lang-menu-popover')).toBeNull();
    });
    expect(trigger.textContent).toContain('English');
  });

  it('supports keyboard open, roving focus across locales, and Escape focus restoration', async () => {
    const { container } = renderLanguageMenu('zh-CN', { placement: 'down', align: 'end' });
    const trigger = container.querySelector<HTMLButtonElement>('.lang-pill')!;
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const popover = container.querySelector<HTMLDivElement>('.lang-menu-popover')!;
    expect(popover).toBeTruthy();
    expect(popover.classList.contains('lang-menu-popover--down')).toBe(true);
    expect(popover.classList.contains('lang-menu-popover--align-end')).toBe(true);

    const items = screen.getAllByRole('menuitemradio');
    const zhCnIdx = LOCALES.indexOf('zh-CN');
    expect(document.activeElement).toBe(items[zhCnIdx]);

    fireEvent.keyDown(popover, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[zhCnIdx + 1]);

    fireEvent.keyDown(popover, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(popover, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(container.querySelector('.lang-menu-popover')).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });
});
