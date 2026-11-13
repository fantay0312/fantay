import { expect, it, vi } from 'vitest';
import { jianyingToolDefinitions } from '../src/jianying-tools.js';

const env = { OD_PROJECT_ID: 'project-fixed', OD_DAEMON_URL: 'http://127.0.0.1:7456', OD_WORKSPACE_ID: 'space', OD_WORKSPACE_MEMBER_ID: 'member' };
it('exposes detection, creation and copy editing against one fixed project', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ sourcePreserved: true }) })) as unknown as typeof fetch;
  const tools = jianyingToolDefinitions(env, fetcher);
  expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['fantay_jianying_status', 'fantay_jianying_create', 'fantay_jianying_edit']));
  await tools.find(t => t.name === 'fantay_jianying_edit')!.execute({ draftId: 'project:local-copy', operations: [{ op: 'set_text', segmentId: 'text', text: 'new' }] }, {});
  expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:7456/api/projects/project-fixed/jianying/edit', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-od-workspace-id': 'space' }) }));
});
it('refuses an external draft before making a request and never exposes install/update', async () => {
  const fetcher = vi.fn() as unknown as typeof fetch, tools = jianyingToolDefinitions(env, fetcher);
  await expect(tools.find(t => t.name === 'fantay_jianying_inspect')!.execute({ draftId: 'local:user-draft' }, {})).rejects.toThrow(/Only draft copies/);
  expect(fetcher).not.toHaveBeenCalled(); expect(tools.some(t => /install|update/.test(t.name))).toBe(false);
});
