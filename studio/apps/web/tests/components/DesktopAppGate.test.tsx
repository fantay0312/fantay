// @vitest-environment jsdom
import { useEffect } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import { DesktopAppGate } from '../../src/components/DesktopAppGate';
import { I18nProvider } from '../../src/i18n';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it('keeps the workspace unmounted in a normal browser', () => {
  const mounted = vi.fn();
  function Workspace() { useEffect(mounted, []); return <p>Private workspace</p>; }
  render(<I18nProvider initial="zh-CN"><DesktopAppGate><Workspace /></DesktopAppGate></I18nProvider>);
  expect(screen.getByRole('heading', { name: '请在桌面端使用 Fantay' })).toBeTruthy();
  expect(screen.getByRole('link', { name: '打开 Fantay' }).getAttribute('href')).toBe('opendesign://workspace/open');
  expect(screen.queryByText('Private workspace')).toBeNull();
  expect(mounted).not.toHaveBeenCalled();
});

it.each(['darwin', 'win32', 'linux'])('mounts the workspace in the %s desktop host', platform => {
  const restore = installMockOpenDesignHost({ host: { client: { platform } } });
  try {
    render(<I18nProvider initial="zh-CN"><DesktopAppGate><p>Desktop workspace</p></DesktopAppGate></I18nProvider>);
    expect(screen.getByText('Desktop workspace')).toBeTruthy();
    expect(screen.queryByTestId('desktop-app-required')).toBeNull();
  } finally { restore(); }
});

it('does not treat a client-type marker without the host capabilities as a desktop', () => {
  const restore = installMockOpenDesignHost({ host: { shell: { openPath: undefined as never } } });
  try {
    render(<I18nProvider initial="en"><DesktopAppGate><p>Private workspace</p></DesktopAppGate></I18nProvider>);
    expect(screen.getByRole('heading', { name: 'Use Fantay on your desktop' })).toBeTruthy();
    expect(screen.queryByText('Private workspace')).toBeNull();
  } finally { restore(); }
});

it('allows explicit development renderer checks', () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('NEXT_PUBLIC_FANTAY_RENDERER_DEV', '1');
  render(<I18nProvider initial="en"><DesktopAppGate><p>Development renderer</p></DesktopAppGate></I18nProvider>);
  expect(screen.getByText('Development renderer')).toBeTruthy();
});

it('ignores the development switch in a production build', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_FANTAY_RENDERER_DEV', '1');
  render(<I18nProvider initial="en"><DesktopAppGate><p>Private workspace</p></DesktopAppGate></I18nProvider>);
  expect(screen.getByRole('heading', { name: 'Use Fantay on your desktop' })).toBeTruthy();
  expect(screen.queryByText('Private workspace')).toBeNull();
});
