// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClientSection } from '../../src/components/McpClientSection';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('McpClientSection OAuth controls', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/mcp/servers')) {
        return jsonResponse({
          servers: [
            {
              id: 'figma-use',
              label: 'figma-use',
              templateId: 'figma-use',
              transport: 'http',
              enabled: true,
              url: 'http://localhost:38451/mcp',
            },
          ],
          templates: [],
        });
      }
      if (url.startsWith('/api/mcp/oauth/status')) {
        return jsonResponse({ connected: false });
      }
      return jsonResponse({});
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does not force managed OAuth for saved localhost HTTP MCP servers', async () => {
    render(<McpClientSection />);

    const expand = await screen.findByRole('button', {
      name: /Expand this MCP server/i,
    });
    fireEvent.click(expand);

    await waitFor(() => {
      expect(screen.getAllByText(/No managed OAuth/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: /^Connect$/i })).toBeNull();
  });

  it('keeps existing servers direct until the user saves on-demand discovery', async () => {
    render(<McpClientSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Expand this MCP server/i }));
    const toggle = screen.getByRole('checkbox', { name: /discover tools on demand/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      const saved = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({ servers: [{ id: 'figma-use', onDemand: true }] });
    });
  });

  it('infers no managed OAuth when a custom HTTP row is pointed at localhost', async () => {
    render(<McpClientSection />);

    fireEvent.click(await screen.findByRole('button', { name: /Add server/i }));
    fireEvent.click(screen.getByRole('button', { name: /Custom server/i }));
    const expandButtons = screen.getAllByRole('button', {
      name: /Expand this MCP server/i,
    });
    fireEvent.click(expandButtons[expandButtons.length - 1]!);
    expect((screen.getByRole('checkbox', { name: /discover tools on demand/i }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('combobox', { name: 'Transport' }));
    fireEvent.click(screen.getByRole('option', { name: 'streamable HTTP' }));
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'http://localhost:38451/mcp' },
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'OAuth mode' }).textContent).toContain(
        'No managed OAuth',
      );
    });
    expect(screen.queryByRole('button', { name: /^Connect$/i })).toBeNull();
  });
});
