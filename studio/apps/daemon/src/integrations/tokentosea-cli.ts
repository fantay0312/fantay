import { resolveDaemonUrl } from '../daemon-url.js';

export async function tokenToSeaCliRequest(resource: string, body?: unknown, daemonUrl?: string): Promise<any> {
  const base = await resolveDaemonUrl({ ...(daemonUrl ? { flagUrl: daemonUrl } : {}) });
  const response = await fetch(`${base}/api/tokentosea/cli/${resource}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Fantay-CLI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(process.env.OD_API_TOKEN ? { Authorization: `Bearer ${process.env.OD_API_TOKEN}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(600_000),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `TokenToSea request failed (${response.status})`);
  return result;
}

export async function runTokenToSeaCli(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args[0] === 'help') {
    console.log('Usage: od tokentosea login|status|logout [--json] [--daemon-url <url>]'); return;
  }
  const command = args[0], daemonIndex = args.indexOf('--daemon-url'), daemonUrl = daemonIndex >= 0 ? args[daemonIndex + 1] : undefined;
  try {
    if (!['login', 'logout', 'status'].includes(command!)) throw new Error('Unknown TokenToSea command');
    const result = await tokenToSeaCliRequest(command!, command === 'status' ? undefined : {}, daemonUrl);
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else if (result.authorizeUrl) console.log(`Open this URL to authorize TokenToSea:\n${result.authorizeUrl}`);
    else console.log(command === 'logout' ? 'TokenToSea signed out' : result.loggedIn ? `TokenToSea: ${result.user?.name ?? 'signed in'}` : 'TokenToSea: signed out');
  } catch (error) { console.error(error instanceof Error ? error.message : 'TokenToSea unavailable'); process.exitCode = 1; }
}
