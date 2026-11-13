type Definition = { name: string; description: string; parameters: Record<string, unknown>; output: { schema: { type: 'string' }; render: (_args: unknown, value: string) => { type: 'text'; text: string }[] }; execute: (args: Record<string, unknown>, execution: { signal?: AbortSignal }) => Promise<string> };
export const JIANYING_TOOL_NAMES = new Set(['fantay_jianying_status', 'fantay_jianying_list', 'fantay_jianying_inspect', 'fantay_jianying_create', 'fantay_jianying_edit']);

/** Project agents can manipulate project copies, never the user's external draft library. */
export function jianyingToolDefinitions(env: NodeJS.ProcessEnv, fetcher: typeof fetch): Definition[] {
  if (!env.OD_PROJECT_ID || !env.OD_DAEMON_URL) return [];
  const base = new URL(env.OD_DAEMON_URL);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('Jianying tools require a fixed local daemon');
  const endpoint = `${base.origin}/api/projects/${encodeURIComponent(env.OD_PROJECT_ID)}/jianying`;
  const request = async (route: string, args: Record<string, unknown>, signal?: AbortSignal, write = false) => {
    if ('draftId' in args && (typeof args.draftId !== 'string' || !args.draftId.startsWith('project:'))) throw new Error('Only draft copies inside this project are available to the agent. Select an external draft in the app first.');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.OD_WORKSPACE_ID) headers['x-od-workspace-id'] = env.OD_WORKSPACE_ID;
    if (env.OD_WORKSPACE_MEMBER_ID) headers['x-od-workspace-member-id'] = env.OD_WORKSPACE_MEMBER_ID;
    const suffix = route === 'inspect' ? `/inspect?draftId=${encodeURIComponent(String(args.draftId))}` : `/${route}`;
    const response = await fetcher(endpoint + suffix, { method: write ? 'POST' : 'GET', headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(200_000)]) : AbortSignal.timeout(200_000), ...(write ? { body: JSON.stringify(args) } : {}) });
    const data = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(data.error?.message ?? `Jianying request failed (${response.status})`);
    return JSON.stringify(data);
  };
  const define = (name: string, description: string, parameters: Record<string, unknown>, route: string, write = false): Definition => ({ name, description, parameters, output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, execute: (args, execution) => request(route, args, execution.signal, write) });
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  const draftId = { type: 'string', pattern: '^project:' };
  return [
    define('fantay_jianying_status', 'Detect Jianying installation, exact version and per-platform draft capabilities. Never install or update the client.', empty, 'status'),
    define('fantay_jianying_list', 'List draft copies inside this project. The external Jianying library is not exposed.', empty, 'drafts'),
    define('fantay_jianying_inspect', 'Read exact track and segment IDs and validation before changing a project draft copy.', { type: 'object', properties: { draftId }, required: ['draftId'], additionalProperties: false }, 'inspect'),
    define('fantay_jianying_create', 'Create an editable Jianying draft from the saved timeline using expectedRevision, or from a plan using project-relative media paths. Returns an inspected and validated new project draft. Unknown client versions require explicit allowUnverified.', { type: 'object', properties: { source: { type: 'string', enum: ['timeline', 'plan'] }, expectedRevision: { type: 'integer', minimum: 0 }, name: { type: 'string' }, allowUnverified: { type: 'boolean' }, spec: { type: 'object', properties: { name: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, fps: { type: 'number' }, clips: { type: 'array', maxItems: 1000, items: { type: 'object' } } }, required: ['name', 'clips'] } }, additionalProperties: false }, 'create', true),
    define('fantay_jianying_edit', 'Edit a project draft as a NEW copy, preserving the original. Read segment IDs first. Operations: add, import_srt, move, trim, split, delete, set_speed, set_volume, set_text, transform, replace_media. All times are seconds; split.at is absolute timeline time. Read the jianying-draft skill for exact operation fields.', { type: 'object', properties: { draftId, name: { type: 'string' }, operations: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { op: { type: 'string', enum: ['add', 'import_srt', 'move', 'trim', 'split', 'delete', 'set_speed', 'set_volume', 'set_text', 'transform', 'replace_media'] }, segmentId: { type: 'string' }, text: { type: 'string' }, at: { type: 'number' }, start: { type: 'number' }, duration: { type: 'number' }, sourceStart: { type: 'number' }, speed: { type: 'number' }, volume: { type: 'number' }, path: { type: 'string' }, trackId: { type: 'string' }, track: { type: 'integer' }, offset: { type: 'number' }, ripple: { type: 'boolean' }, clip: { type: 'object' }, transform: { type: 'object' } }, required: ['op'] } } }, required: ['draftId', 'operations'], additionalProperties: false }, 'edit', true),
  ];
}
