// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { I18nProvider, useContentTranslator, useI18n } from '../../src/i18n';
import { loadLanguage, readyLanguage } from '../../src/i18n/dictionaries';

afterEach(cleanup);

function Probe({ contentTag }: { contentTag?: string }) {
  const { locale, t, setLocale } = useI18n();
  const contentT = useContentTranslator(contentTag, t);
  return <>
    <input aria-label="draft" />
    <output data-testid="locale">{locale}</output>
    <output data-testid="content">{contentT('qf.ownAnswer')}</output>
    <button onClick={() => setLocale('ar')}>Arabic</button>
    <button onClick={() => setLocale('zh-CN')}>Chinese</button>
  </>;
}

it('loads a separate form language once and leaves the interface language alone', async () => {
  expect(readyLanguage('pl')).toBeUndefined();
  render(<I18nProvider initial="en"><Probe contentTag="pl-PL" /></I18nProvider>);
  const pending = loadLanguage('pl');
  expect(loadLanguage('pl')).toBe(pending);
  const polish = await act(() => pending);
  expect(screen.getByTestId('content').textContent).toBe(polish.t('qf.ownAnswer'));
  expect(readyLanguage('pl')).toBe(polish);
  expect(document.documentElement.lang).toBe('en');
});

it('updates locale-scoped work immediately and preserves a draft across racing switches', async () => {
  render(<I18nProvider initial="en"><Probe /></I18nProvider>);
  const draft = screen.getByRole('textbox');
  fireEvent.change(draft, { target: { value: 'in progress' } });
  fireEvent.click(screen.getByText('Arabic'));
  expect(screen.getByTestId('locale').textContent).toBe('ar');
  expect(document.documentElement.dir).toBe('rtl');
  fireEvent.click(screen.getByText('Chinese'));
  await act(() => loadLanguage('ar'));
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(document.documentElement.dir).toBe('ltr');
  expect(screen.getByTestId('content').textContent).toBe('自己填');
  expect(screen.getByRole('textbox')).toBe(draft);
  expect(draft).toHaveValue('in progress');
});
