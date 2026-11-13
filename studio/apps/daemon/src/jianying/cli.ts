import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolveDaemonUrl } from '../daemon-url.js';

const USAGE = `od jianying <status|list|create|inspect|edit|install> --project <id> [--json]
  status                            Detect installation, version and supported capabilities
  list [--include-local]            List project drafts, optionally the local Jianying library
  create --revision <n>             Create from the current saved timeline
  create --file <plan.json|->       Create from a plan with project-relative media paths
  inspect --draft <id>              Read exact segment IDs before editing
  edit --draft <id> --file <ops|->   Write a new draft copy; preserve the original
  install --draft <project-id>      Add a generated copy to Jianying's home screen (quit it first)
Options: --name <title>, --allow-unverified, --include-local, --daemon-url <url>,
--workspace <id>, --workspace-member <id>, --prompt-file <JSON|-> (alias for --file).
This command never updates or installs Jianying. All requests use the same project API as the UI.`;

export async function runJianying(args: string[]): Promise<void> {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, 'include-local': { type: 'boolean' }, 'allow-unverified': { type: 'boolean' },
      project: { type: 'string' }, draft: { type: 'string' }, file: { type: 'string' }, name: { type: 'string' }, revision: { type: 'string' },
      'daemon-url': { type: 'string' }, workspace: { type: 'string' }, 'workspace-member': { type: 'string' }, 'prompt-file': { type: 'string' },
    } });
    if (values.help || !positionals.length) { console.log(USAGE); return; }
    const command = positionals[0]!;
    if (!['status', 'list', 'create', 'inspect', 'edit', 'install'].includes(command)) throw new Error(USAGE);
    const project = values.project ?? process.env.OD_PROJECT_ID;
    if (!project) throw new Error('Provide --project or OD_PROJECT_ID');
    const base = await resolveDaemonUrl({ flagUrl: values['daemon-url'] ?? null });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const workspace = values.workspace ?? process.env.OD_WORKSPACE_ID, member = values['workspace-member'] ?? process.env.OD_WORKSPACE_MEMBER_ID;
    if (workspace) headers['x-od-workspace-id'] = workspace;
    if (member) headers['x-od-workspace-member-id'] = member;
    if (values['include-local']) headers['x-fantay-local-drafts'] = '1';
    const file = values.file ?? values['prompt-file'];
    let raw = '';
    if (file === '-') { for await (const chunk of process.stdin) { raw += String(chunk); if (raw.length > 8 * 1024 * 1024) throw new Error('JSON input is too large'); } }
    else if (file) raw = await readFile(file, 'utf8');
    const input = file ? JSON.parse(raw) as unknown : undefined;
    let suffix = command === 'list' ? '/drafts' + (values['include-local'] ? '?local=true' : '') : `/${command}`, body: unknown;
    if (command === 'inspect') {
      if (!values.draft) throw new Error('Provide --draft from od jianying list');
      suffix += `?draftId=${encodeURIComponent(values.draft)}`;
    } else if (command === 'create') {
      if (!file && values.revision === undefined) throw new Error('Provide --revision for the saved timeline, or --file for a plan');
      body = { source: file ? 'plan' : 'timeline', ...(file ? { spec: input } : { expectedRevision: Number(values.revision) }), ...(values.name ? { name: values.name } : {}), allowUnverified: Boolean(values['allow-unverified']) };
    } else if (command === 'edit') {
      if (!values.draft || !file) throw new Error('Editing requires --draft and --file');
      body = { draftId: values.draft, operations: input, ...(values.name ? { name: values.name } : {}) };
    } else if (command === 'install') {
      if (!values.draft) throw new Error('Provide --draft');
      body = { draftId: values.draft, ...(values.name ? { name: values.name } : {}) };
    }
    const response = await fetch(`${base}/api/projects/${encodeURIComponent(project)}/jianying${suffix}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(200_000) });
    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));
    if (!response.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } })); process.exitCode = 1; }
}
