import { tokenToSeaCliRequest } from './integrations/tokentosea-cli.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

/**
 * `od resource` is a compatibility entry point for the login-backed Vela
 * resource drive. OpenDesign intentionally owns no Resource Hub credentials
 * or content-addressed transfer implementation.
 */
export async function runResource(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args[0] === 'help') {
    console.log('Usage: od resource push|pull|head|shared|remove ... --workspace-id <id> [--daemon-url <url>]\nTokenToSea authorization is managed by the running Fantay daemon.'); return;
  }
  try {
    const command = [...args], workspaceIndex = command.indexOf('--workspace-id');
    const workspaceId = workspaceIndex >= 0 ? command[workspaceIndex + 1] : undefined;
    if (!workspaceId) throw new Error('An explicit --workspace-id is required');
    const daemonIndex = command.indexOf('--daemon-url'), daemonUrl = daemonIndex >= 0 ? command[daemonIndex + 1] : undefined;
    if (daemonIndex >= 0) command.splice(daemonIndex, 2);
    if (['push', 'pull'].includes(command[0]!) && command[3]) command[3] = path.resolve(command[3]);
    const inputIndex = command.indexOf('--requests-file');
    const input = inputIndex >= 0 && command[inputIndex + 1] !== '-' ? await readFile(path.resolve(command[inputIndex + 1]!), 'utf8') : undefined;
    const { stdout } = await tokenToSeaCliRequest('command', { args: ['resource', ...command], workspaceId, ...(input ? { input } : {}) }, daemonUrl);
    if (stdout) process.stdout.write(stdout);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'TokenToSea resource command failed');
    process.exitCode = 1;
  }
}
