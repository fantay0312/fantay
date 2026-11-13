// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FantayMcpConnector } from '../../src/components/FantayMcpConnector';
import { I18nProvider } from '../../src/i18n';

function wrap(children: ReactNode) {
  return <I18nProvider initial="en">{children}</I18nProvider>;
}

function renderConnector(props: { defaultOpen?: boolean } = { defaultOpen: true }) {
  return render(wrap(<FantayMcpConnector {...props} />));
}

describe('FantayMcpConnector', () => {
  const installInfo = {
    command: '/Applications/Open Design.app/Contents/Resources/open-design/bin/node',
    args: [
      '/Applications/Open Design.app/Contents/Resources/app/node_modules/@open-design/daemon/dist/cli.js',
      'mcp',
      '--daemon-url',
      'http://127.0.0.1:51706',
    ],
    daemonUrl: 'http://127.0.0.1:51706',
    platform: 'darwin',
    cliExists: true,
    nodeExists: true,
    buildHint: null,
  };

  let fetchMock: ReturnType<typeof vi.fn>;
  let writeTextMock: ReturnType<typeof vi.fn>;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => installInfo,
    });
    vi.stubGlobal('fetch', fetchMock);

    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      delete (navigator as { clipboard?: Clipboard }).clipboard;
    }
    vi.clearAllMocks();
  });

  it('renders the default Claude Code install snippet after fetching daemon install info', async () => {
    renderConnector();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/mcp/install-info');
    });
    expect(screen.getByRole('heading', { name: /Connect Fantay to your coding agent/i })).toBeTruthy();
    expect(screen.queryByText(/Run this command in your terminal/i)).toBeNull();
    await waitFor(() => {
      expect(screen.getByText(/claude mcp add-json --scope user open-design/i)).toBeTruthy();
    });
    expect(screen.getByText(/Keep Fantay running\. Restart your coding agent after setup\./i)).toBeTruthy();
    expect(screen.getByText(/What your agent can do/i)).toBeTruthy();
  });

  it('switches client instructions and snippet content when a different MCP client is selected', async () => {
    renderConnector();

    await waitFor(() => {
      expect(screen.getByText(/claude mcp add-json --scope user open-design/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /Claude Code/i }));
    fireEvent.click(screen.getByRole('option', { name: /Codex/i }));

    await waitFor(() => {
      expect(screen.getByText(/Append this table to ~\/\.codex\/config\.toml/i)).toBeTruthy();
    });
    expect(screen.getByText(/\[mcp_servers\.open-design\]/i)).toBeTruthy();

    // Scope to the picker trigger ("Codex" + the TOML method chip) so
    // we don't collide with the new one-click "Install in Codex" /
    // "Remove from Codex" button on the same panel.
    fireEvent.click(screen.getByRole('button', { name: /Codex.*TOML/i }));
    fireEvent.click(screen.getByRole('option', { name: /Cursor/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Install in Cursor/i })).toBeTruthy();
    });
    expect(screen.getByText(/merge this JSON into ~\/\.cursor\/mcp\.json/i)).toBeTruthy();
    expect(screen.getByText(/"mcpServers"/i)).toBeTruthy();
  });

  it('copies the currently selected MCP snippet to the clipboard', async () => {
    renderConnector();

    await waitFor(() => {
      expect(screen.getByText(/claude mcp add-json --scope user open-design/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy setup command' }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        expect.stringContaining("claude mcp add-json --scope user open-design"),
      );
    });
    expect(screen.getByText('Copied')).toBeTruthy();
  });

  it('shows a daemon error state when install paths cannot be resolved', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    renderConnector();

    await waitFor(() => {
      const errorCard = document.querySelector('.empty-card');
      expect(errorCard?.textContent).toContain('reach the local daemon to resolve install paths');
    });
    expect(screen.getByText(/# resolving paths failed, see the error above/i)).toBeTruthy();
  });
});

describe('FantayMcpConnector row', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('stays one row and resolves nothing until it is opened', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    renderConnector({ defaultOpen: false });

    expect(screen.getByRole('heading', { name: 'Fantay MCP' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('fantay-mcp-toggle'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/mcp/install-info');
    });
  });
});
