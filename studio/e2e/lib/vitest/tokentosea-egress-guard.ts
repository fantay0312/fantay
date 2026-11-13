/**
 * Process preload for daemons that run against the fake TokenToSea cloud
 * (`@/vitest/tokentosea-cloud`). `TokenToSeaCloud.env()` adds it to
 * `NODE_OPTIONS`, so tools-dev, the daemon, the web sidecar and every
 * descendant load it before any application code.
 *
 * It records every outbound connection that leaves loopback to the JSONL file
 * named by `OD_E2E_EGRESS_LOG`, and refuses (records with `blocked: true`)
 * any connection to a host under a suffix in `OD_E2E_EGRESS_DENY` (default
 * `tokentosea.com`). The production TokenToSea hosts can therefore never be
 * reached from a seam-backed run, even through a code path that bypasses the
 * `OD_TOKENTOSEA_TEST_ORIGIN` seam; the suite reads the log back and fails.
 *
 * Interception points: `fetch` (records the URL), `dns.lookup` and
 * `dns.promises.lookup` (every hostname connection made by http, https, net
 * and undici resolves through them), and `net.Socket#connect` for IP-literal
 * destinations that skip DNS (recorded only). Each process also writes one
 * `via: 'loaded'` line at startup, so a reader can prove the guard was active
 * in the daemon rather than trust an empty log. It must not import Vitest or
 * any application module.
 */
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
import net from 'node:net';

type EgressVia = 'fetch' | 'dns' | 'socket' | 'loaded';

const logPath = process.env.OD_E2E_EGRESS_LOG?.trim() || '';
const deniedSuffixes = (process.env.OD_E2E_EGRESS_DENY ?? 'tokentosea.com')
  .split(',')
  .map((value) => value.trim().toLowerCase().replace(/^\.+|\.+$/g, ''))
  .filter(Boolean);
const argv = process.argv.slice(1, 4);
const argvText = process.argv.slice(1).join(' ');
// The sidecar entries tools-dev launches (both the tsx launcher and its child).
// Builds, agent CLIs and other descendants are `other`.
const role = /apps[\\/]daemon[\\/]src[\\/]sidecar[\\/]/.test(argvText)
  ? 'daemon'
  : /apps[\\/]web[\\/]sidecar[\\/]/.test(argvText) ? 'web' : 'other';

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLocal(host: string): boolean {
  const value = normalizeHost(host);
  if (!value || value === 'localhost' || value.endsWith('.localhost')) return true;
  if (value === '::1' || value === '::' || value === '0.0.0.0') return true;
  if (value.startsWith('::ffff:')) return isLocal(value.slice('::ffff:'.length));
  return net.isIPv4(value) && value.startsWith('127.');
}

function isDenied(host: string): boolean {
  const value = normalizeHost(host);
  return deniedSuffixes.some((suffix) => value === suffix || value.endsWith(`.${suffix}`));
}

function record(via: EgressVia, host: string, blocked: boolean, url?: string): void {
  if (!logPath) return;
  const entry = {
    at: new Date().toISOString(),
    via,
    host: normalizeHost(host),
    ...(url ? { url } : {}),
    blocked,
    role,
    pid: process.pid,
    argv,
  };
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Diagnostics must never change the behavior of the process under test.
  }
}

function blockedError(host: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`getaddrinfo ENOTFOUND ${host} (blocked by the e2e TokenToSea egress guard)`),
    { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: host },
  );
}

/** Returns true when the lookup must be refused. */
function inspectLookup(hostname: unknown): boolean {
  if (typeof hostname !== 'string' || isLocal(hostname) || net.isIP(normalizeHost(hostname)) !== 0) return false;
  const blocked = isDenied(hostname);
  record('dns', hostname, blocked);
  return blocked;
}

record('loaded', '', false);

const originalLookup = dns.lookup;
const guardedLookup = function guardedLookup(this: unknown, hostname: string, ...rest: unknown[]) {
  if (inspectLookup(hostname)) {
    const callback = [...rest].reverse().find((value) => typeof value === 'function') as
      | ((error: NodeJS.ErrnoException) => void)
      | undefined;
    if (callback) process.nextTick(callback, blockedError(hostname));
    return {};
  }
  return (originalLookup as (...args: unknown[]) => unknown).apply(this, [hostname, ...rest]);
};
(dns as { lookup: unknown }).lookup = guardedLookup;

const promises = dns.promises as { lookup: (...args: unknown[]) => Promise<unknown> };
const originalPromisesLookup = promises.lookup;
promises.lookup = function guardedPromisesLookup(this: unknown, hostname: unknown, ...rest: unknown[]) {
  if (inspectLookup(hostname)) return Promise.reject(blockedError(String(hostname)));
  return originalPromisesLookup.apply(this, [hostname, ...rest]);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  let url: URL | null = null;
  try {
    url = new URL(input instanceof Request ? input.url : String(input instanceof URL ? input.href : input));
  } catch {
    url = null;
  }
  if (url && (url.protocol === 'http:' || url.protocol === 'https:') && !isLocal(url.hostname)) {
    const blocked = isDenied(url.hostname);
    record('fetch', url.hostname, blocked, `${url.origin}${url.pathname}`);
    if (blocked) {
      return Promise.reject(new TypeError(`fetch failed: ${url.origin} is blocked by the e2e TokenToSea egress guard`));
    }
  }
  return originalFetch(input, init);
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  try {
    const first = args[0];
    const options = Array.isArray(first) ? first[0] : first;
    const host = options && typeof options === 'object'
      ? (options as { host?: unknown; path?: unknown }).path == null ? (options as { host?: unknown }).host : undefined
      : typeof args[1] === 'string' ? args[1] : undefined;
    if (typeof host === 'string' && net.isIP(normalizeHost(host)) !== 0 && !isLocal(host)) {
      record('socket', host, false);
    }
  } catch {
    // Never let inspection break the connection itself.
  }
  return (originalConnect as (...connectArgs: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

export {};
