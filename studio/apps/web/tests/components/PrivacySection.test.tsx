// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { PrivacySection } from '../../src/components/PrivacySection';
import type { AppConfig } from '../../src/types';
vi.mock('../../src/components/ExportDiagnosticsButton',()=>({ExportDiagnosticsRow:()=> <button>Export local diagnostics</button>}));
afterEach(cleanup);
it('keeps export and offline policy available without offering an upload opt-in',()=>{
  render(<I18nProvider initial="en"><PrivacySection cfg={{telemetry:{metrics:true,content:true}} as AppConfig} setCfg={vi.fn()} /></I18nProvider>);
  expect(screen.getByText('Automatic analytics and diagnostic uploads are off')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Export local diagnostics'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Share'})).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getByTestId('privacy-policy-offline').textContent).toContain('support@tokentosea.com');
});
