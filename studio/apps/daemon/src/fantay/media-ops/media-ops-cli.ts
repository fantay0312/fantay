// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from 'node:util';
import { validateMediaOpRequest } from '@open-design/contracts';
import { resolveDaemonUrl } from '../../daemon-url.js';

export const MEDIA_OP_USAGE = `Usage: od board media <crop|split|scale|upscale|frame> --project <id> --input <project-file> [--json]
  crop:  --x <px> --y <px> --width <px> --height <px> [--output <file>]
  split: --rows <1..8> --cols <1..8> [--output-prefix <stem>]
  scale (or upscale): --factor <2|3|4> OR --width <px> and/or --height <px>
  frame: --time <seconds> [--output <file.png>]
Common: --daemon-url <url>, --workspace <id>, --workspace-member <id>
Files must be project-relative. Existing outputs are never overwritten.
Exit codes: 0 success, 2 usage, 64 daemon unreachable, 67 missing input, 68 missing project, 1 other.
`;

export async function runBoardMediaCli(args: string[]): Promise<{ exitCode: number }> {
  let code = 0;
  const fail = (message: string, exitCode: number, errorCode = 'INVALID_REQUEST') => {
    code = exitCode; process.stderr.write(JSON.stringify({ error: message, code: errorCode }) + '\n');
  };
  try {
    const { values: parsedValues, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
      ...Object.fromEntries(['project', 'input', 'output', 'output-prefix', 'x', 'y', 'width', 'height', 'rows', 'cols', 'factor', 'time', 'daemon-url', 'workspace', 'workspace-member'].map(key => [key, { type: 'string' as const }])),
    } });
    const values = parsedValues as Record<string, string | boolean | undefined>;
    if (values.help) { process.stdout.write(MEDIA_OP_USAGE); return { exitCode: 0 }; }
    const op = positionals[0] === 'upscale' ? 'scale' : positionals[0];
    if (positionals.length !== 1 || !values.project || !values.input) throw new Error('An operation, --project and --input are required. See od board media --help.');
    if (Boolean(values.workspace) !== Boolean(values['workspace-member'])) throw new Error('--workspace and --workspace-member must be supplied together');
    const allowed = op === 'crop' ? ['x', 'y', 'width', 'height'] : op === 'split' ? ['rows', 'cols'] : op === 'scale' ? ['factor', 'width', 'height'] : ['time'];
    for (const key of ['x', 'y', 'width', 'height', 'rows', 'cols', 'factor', 'time']) if (values[key] !== undefined && !allowed.includes(key)) throw new Error(`--${key} does not apply to ${op}`);
    if ((op === 'split' && values.output) || (op !== 'split' && values['output-prefix'])) throw new Error('Use --output-prefix only for split and --output for other operations');
    const params: Record<string, number> = {};
    for (const key of allowed) if (values[key] !== undefined) params[key === 'time' ? 'timeSec' : key] = Number(values[key]);
    const request = { op, input: values.input, params, ...(values.output ? { output: values.output } : {}), ...(values['output-prefix'] ? { outputPrefix: values['output-prefix'] } : {}) };
    const parsed = validateMediaOpRequest(request);
    if (!parsed.ok) throw new Error(parsed.issues.map(issue => issue.message).join('; '));
    const base = await resolveDaemonUrl({ flagUrl: typeof values['daemon-url'] === 'string' ? values['daemon-url'] : null });
    let response: Response;
    try {
      response = await fetch(`${base}/api/projects/${encodeURIComponent(String(values.project))}/media/ops`, {
        method: 'POST', signal: AbortSignal.timeout(180_000),
        headers: { 'Content-Type': 'application/json', ...(values.workspace ? { 'x-od-workspace-id': String(values.workspace), 'x-od-workspace-member-id': String(values['workspace-member']) } : {}) },
        body: JSON.stringify(parsed.value),
      });
    } catch { fail('Daemon is unreachable', 64, 'DAEMON_NOT_RUNNING'); return { exitCode: code }; }
    const body = await response.json() as { error?: { code?: string; message?: string }; code?: string; message?: string };
    if (!response.ok) {
      const error = body.error ?? body;
      const errorCode = error.code ?? 'MEDIA_ERROR';
      fail(error.message ?? 'Media operation failed', errorCode === 'PROJECT_NOT_FOUND' ? 68 : ['FILE_NOT_FOUND', 'MISSING_INPUT'].includes(errorCode) ? 67 : response.status === 400 ? 2 : 1, errorCode);
    } else process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  } catch (error) { fail(error instanceof Error ? error.message : String(error), 2); }
  return { exitCode: code };
}

/** Board extensions report the status through the CLI dispatcher process contract. */
export async function runBoardMedia(args: string[]): Promise<void> {
  const { exitCode } = await runBoardMediaCli(args);
  if (exitCode !== 0) process.exitCode = exitCode;
}
