// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workspaceContextFixture } from '../helpers/workspace-context';
import { DesignSystemSwitchPicker } from '../../src/components/DesignSystemSwitchPicker';
import type { Dict } from '../../src/i18n/types';

const mocks = vi.hoisted(() => ({ context: null as unknown, load: vi.fn() }));
vi.mock('../../src/collab/useWorkspaceContext', () => ({ useWorkspaceContext: () => ({ context: mocks.context }) }));
vi.mock('../../src/providers/registry', () => ({ fetchDesignSystemsResult: (...args: unknown[]) => mocks.load(...args) }));
const system = { id: 'system-b', title: 'System B', category: 'Custom', summary: '' };
const props = { t: (key: keyof Dict) => key, onBack: vi.fn(), onSelect: vi.fn(async () => true) };
beforeEach(() => { vi.clearAllMocks(); mocks.context = workspaceContextFixture({ workspaceId: 'a', workspaceMemberId: 'a' }); });
afterEach(cleanup);

it('replaces a failed catalog when a new workspace succeeds', async () => {
  mocks.load.mockResolvedValueOnce({ ok: false, designSystems: [] });
  const view = render(<DesignSystemSwitchPicker {...props} />);
  await screen.findByTestId('composer-ds-picker-load-error');
  let finish!: (value: unknown) => void;
  mocks.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mocks.context = workspaceContextFixture({ workspaceId: 'b', workspaceMemberId: 'b' });
  view.rerender(<DesignSystemSwitchPicker {...props} />);
  expect(screen.queryByTestId('composer-ds-picker-load-error')).toBeNull();
  await act(async () => { finish({ ok: true, designSystems: [system] }); });
  expect(await screen.findByRole('option', { name: 'System B' })).toBeEnabled();
});

it('retries a failed catalog without remounting the picker', async () => {
  mocks.load.mockResolvedValueOnce({ ok: false, designSystems: [] });
  render(<DesignSystemSwitchPicker {...props} />);
  await screen.findByTestId('composer-ds-picker-load-error');
  mocks.load.mockResolvedValueOnce({ ok: true, designSystems: [system] });
  fireEvent.click(screen.getByRole('button', { name: 'preview.retry' }));
  expect(await screen.findByRole('option', { name: 'System B' })).toBeEnabled();
  await waitFor(() => expect(screen.queryByTestId('composer-ds-picker-load-error')).toBeNull());
});

it('hides the previous workspace catalog while the next one loads', async () => {
  mocks.load.mockResolvedValueOnce({ ok: true, designSystems: [{ ...system, id: 'system-a', title: 'System A' }] });
  const view = render(<DesignSystemSwitchPicker {...props} />);
  await screen.findByRole('option', { name: 'System A' });
  let finish!: (value: unknown) => void;
  mocks.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mocks.context = workspaceContextFixture({ workspaceId: 'b', workspaceMemberId: 'b' });
  view.rerender(<DesignSystemSwitchPicker {...props} />);
  expect(screen.queryByRole('option', { name: 'System A' })).toBeNull();
  await act(async () => { finish({ ok: true, designSystems: [system] }); });
  expect(await screen.findByRole('option', { name: 'System B' })).toBeEnabled();
});

it('shows a recoverable selection failure instead of rejecting the click handler', async () => {
  mocks.load.mockResolvedValue({ ok: true, designSystems: [system] });
  props.onSelect.mockRejectedValueOnce(new Error('offline'));
  render(<DesignSystemSwitchPicker {...props} />);
  fireEvent.click(await screen.findByRole('option', { name: 'System B' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('chat.importDesignSystemFailed');
  expect(screen.getByRole('option', { name: 'System B' })).toBeEnabled();
});
