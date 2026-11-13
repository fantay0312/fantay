/** Legacy arguments are ignored; all cloud authority now belongs to TokenToSea. */
export function workspaceTeamTransportEnv(_profile?: string | null, _oldOrigin?: string | null): Record<string, string> {
  return {
    OD_WORKSPACE_CONTEXT_SOURCE: 'tokentosea',
    OD_TEAM_PROJECTS_TRANSPORT: 'tokentosea',
    OD_COLLAB_TRANSPORT: 'tokentosea',
    OD_RESOURCE_TRANSPORT: 'tokentosea',
  };
}
