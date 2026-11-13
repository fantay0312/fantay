// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { PrivacyConsentModal } from '../../src/components/PrivacyConsentModal';
afterEach(cleanup);
it('acknowledges first-run information without consenting to any upload',()=>{
  const onShare=vi.fn(), onDecline=vi.fn();
  render(<I18nProvider initial="en"><PrivacyConsentModal onShare={onShare} onDecline={onDecline}/></I18nProvider>);
  expect(screen.getByTestId('privacy-policy-offline')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Got it'}));
  expect(onDecline).toHaveBeenCalledTimes(1);
  expect(onShare).not.toHaveBeenCalled();
  expect(screen.getByRole('link',{name:'查看官网版本'}).getAttribute('href')).toBe('https://design.tokentosea.com/privacy/');
});
