import { describe, expect, it } from 'vitest';
import { workspaceTeamTransportEnv } from '../src/workspace-team.js';
describe('TokenToSea packaged transports', () => {
  it('uses the first-party transport without any upstream cloud origin', () => {
    const expected = { OD_WORKSPACE_CONTEXT_SOURCE: 'tokentosea', OD_TEAM_PROJECTS_TRANSPORT: 'tokentosea', OD_COLLAB_TRANSPORT: 'tokentosea', OD_RESOURCE_TRANSPORT: 'tokentosea' };
    expect(workspaceTeamTransportEnv()).toEqual(expected);
    expect(workspaceTeamTransportEnv('prod', 'https://ignored.invalid')).toEqual(expected);
  });
});
