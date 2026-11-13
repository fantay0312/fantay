import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMcpToolCall, TOOL_DEFS } from '../src/mcp.js';
afterEach(() => vi.unstubAllGlobals());
const text = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);
describe('TokenToSea MCP account tools', () => {
  it('advertises TokenToSea account tools rather than upstream login tools', () => {
    const names = TOOL_DEFS.map(tool => tool.name);
    expect(names).toContain('get_tokentosea_login_help'); expect(names).toContain('get_tokentosea_login_status');
    expect(names).not.toContain('start_vela_login');
  });
  it('keeps account consent in the app and never creates an orphan login session', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_tokentosea_login_help', {});
    expect(text(result)).toMatchObject({ requiresUserAction: true }); expect(request).not.toHaveBeenCalled();
  });
  it('reads only the account bound to the current authorized tool request', async () => {
    const request = vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:17456/api/tools/tokentosea/account');
      return Response.json({ loggedIn: true, user: { name: 'Alice' }, accessToken: 'must-not-leak', configPath: '/private' });
    }); vi.stubGlobal('fetch', request);
    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_tokentosea_login_status', {});
    expect(text(result)).toMatchObject({ loggedIn: true });
    expect(JSON.stringify(result)).not.toContain('must-not-leak'); expect(JSON.stringify(result)).not.toContain('/private');
  });
});
