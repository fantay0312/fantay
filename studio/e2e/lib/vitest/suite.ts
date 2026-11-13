import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

import { expect } from 'vitest';

import {
  createToolsDevSuite,
  e2eWorkspaceRoot as resolveE2eWorkspaceRoot,
} from '../tools-dev/runtime.ts';
import type {
  ToolsDevCheckResult,
  ToolsDevLogResult,
  ToolsDevPortAllocation,
  ToolsDevStartResult,
  ToolsDevStatusResult,
} from '../tools-dev/types.ts';
import { assertRelativeReportPath, createReport, type E2eReport } from './report.ts';
// Type-only: importing the cloud module loads apps/share, which no other suite needs.
import type {
  TokenToSeaCloud,
  TokenToSeaSeededSession,
  TokenToSeaSeedOptions,
} from './tokentosea-cloud.ts';
import type { JsonRequestOptions } from './http.ts';
import { cleanupTestScratch, registerTestScratch } from '../../../scripts/fantay-test-cleanup.ts';

export { e2eWorkspaceRoot } from '../tools-dev/runtime.ts';

export type SmokeSuite = {
  codexHomeDir: string;
  dataDir: string;
  namespace: string;
  report: E2eReport;
  root: string;
  scratchDir: string;
  toolsDevRoot: string;
  with: SmokeSuiteWith;
  writeScratchJson: (name: string, value: unknown) => Promise<string>;
  finalize: (result: SmokeSuiteFinalizeInput) => Promise<string>;
};

export type SmokeSuiteOptions = {
  /** Reuse one explicit daemon data root across process-restart witnesses. */
  dataDir?: string;
};

export type SmokeSuiteFinalizeInput = {
  diagnostics?: unknown;
  error?: unknown;
  success: boolean;
};

export type SmokeSuiteWith = {
  env: <T>(patch: EnvPatch, run: () => Promise<T>) => Promise<T>;
  pathEntry: <T>(entry: string, run: () => Promise<T>) => Promise<T>;
  toolsDev: (
    run: (context: ToolsDevSuiteContext) => Promise<void>,
    options?: ToolsDevSuiteOptions,
  ) => Promise<string>;
  /**
   * `toolsDev` signed in to a fake TokenToSea cloud as `member`: seeds the
   * member's session into this suite's data dir, starts the runtime with
   * `cloud.env(options.env)`, verifies the daemon accepts the session, and
   * fails if the egress guard refused any production TokenToSea connection.
   * Use a second suite (its own data dir) for a second device or member.
   */
  tokenToSea: (
    cloud: TokenToSeaCloud,
    member: string,
    run: (context: TokenToSeaSuiteContext) => Promise<void>,
    options?: TokenToSeaSuiteOptions,
  ) => Promise<string>;
};

export type TokenToSeaSuiteOptions = ToolsDevSuiteOptions & {
  session?: TokenToSeaSeedOptions;
};

export type TokenToSeaSuiteContext = ToolsDevSuiteContext & {
  cloud: TokenToSeaCloud;
  /** Direct daemon origin (not the web proxy). */
  daemonUrl: string;
  session: TokenToSeaSeededSession;
  /** fetch against the daemon with the member's session cookie; never throws on status. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** JSON request against the daemon with the member's session cookie; throws on non-2xx. */
  requestJson: <T>(path: string, options?: JsonRequestOptions) => Promise<T>;
};

export type EnvPatch = Record<string, string | null | undefined>;

export type ToolsDevSuiteContext = {
  check: () => Promise<ToolsDevCheckResult>;
  logs: () => Promise<Record<string, ToolsDevLogResult>>;
  runtime: ToolsDevPortAllocation;
  start: ToolsDevStartResult;
  status: ToolsDevStatusResult;
  webUrl: string;
};

export type ToolsDevSuiteOptions = {
  env?: Record<string, string | undefined>;
  onFailure?: (input: {
    context: ToolsDevSuiteContext | null;
    error: unknown;
    suite: SmokeSuite;
  }) => Promise<void>;
  skipFatalLogCheck?: boolean;
};

export function resolveVitestToolsDevEnv(
  env: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    // The hermetic Codex fixture emits the legacy `exec --json` stream. Pin
    // its matching transport here; app-server protocol coverage lives in the
    // daemon transport/parity suites, not in these fake-CLI smoke tests.
    OD_CODEX_TRANSPORT: 'exec-json',
    ...env,
  };
}

const workspaceRoot = resolveE2eWorkspaceRoot();

export async function createSmokeSuite(
  name: string,
  options: SmokeSuiteOptions = {},
): Promise<SmokeSuite> {
  const namespace = `e2e-${sanitizeSegment(name)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = join(workspaceRoot, '.tmp', 'e2e', namespace);
  const reportDir = join(root, 'report');
  const scratchDir = join(root, 'scratch');
  const codexHomeDir = join(scratchDir, 'codex-home');
  const toolsDevRoot = join(scratchDir, 'tools-dev');
  const dataDir = options.dataDir ?? join(scratchDir, 'data');

  await mkdir(reportDir, { recursive: true });
  await mkdir(scratchDir, { recursive: true });
  await registerTestScratch(scratchDir);
  const report = await createReport(reportDir);

  async function writeJson(baseDir: string, name: string, value: unknown): Promise<string> {
    const safeName = assertRelativeReportPath(name);
    const outputPath = join(baseDir, safeName);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return outputPath;
  }

  const suite: SmokeSuite = {
    codexHomeDir,
    dataDir,
    namespace,
    report,
    root,
    scratchDir,
    toolsDevRoot,
    with: {
      env: withEnv,
      pathEntry: (entry, run) => withEnv({ PATH: prependPathEntry(entry, process.env.PATH) }, run),
      toolsDev: (run, options) => runToolsDevSuite(suite, run, options),
      tokenToSea: (cloud, member, run, options) => runTokenToSeaSuite(suite, cloud, member, run, options),
    },
    writeScratchJson: (name, value) => writeJson(scratchDir, name, value),
    async finalize(result) {
      await report.json('suite-result.json', {
        namespace,
        reportPath: report.root,
        root,
        status: result.success ? 'success' : 'failed',
        timestamp: new Date().toISOString(),
      });

      if (!result.success) await report.json('failure/diagnostics.json', {
        diagnostics: result.diagnostics ?? null,
        error: formatUnknown(result.error),
      });
      const cleanup = await cleanupTestScratch({ workspaceRoot, scratchDir, reportDir, ownerStopped: true });
      await report.json('scratch-cleanup.json', cleanup);
      return report.root;
    },
  };
  return suite;
}

export type PackagedSmokePlatform = 'linux' | 'mac' | 'win';

export function resolvePackagedSmokeNamespace(
  platform: PackagedSmokePlatform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.OD_PACKAGED_E2E_NAMESPACE != null && env.OD_PACKAGED_E2E_NAMESPACE.trim() !== '') {
    return env.OD_PACKAGED_E2E_NAMESPACE;
  }
  const channel = env.OD_PACKAGED_E2E_RELEASE_CHANNEL;
  if (channel === 'prerelease' || channel === 'preview') {
    switch (platform) {
      case 'linux':
        return `release-${channel}-linux`;
      case 'mac':
        return `release-${channel}`;
      case 'win':
        return `release-${channel}-win`;
    }
  }
  switch (platform) {
    case 'linux':
      return 'ci-pr-linux';
    case 'mac':
      return 'release-beta';
    case 'win':
      return 'release-beta-win';
  }
}

async function withEnv<T>(patch: EnvPatch, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
  }
  applyEnvPatch(process.env, patch);
  try {
    return await run();
  } finally {
    const restorePatch: EnvPatch = {};
    for (const [key, value] of previous) {
      restorePatch[key] = value;
    }
    applyEnvPatch(process.env, restorePatch);
  }
}

function applyEnvPatch(target: NodeJS.ProcessEnv, patch: EnvPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete target[key];
    else target[key] = value;
  }
}

function prependPathEntry(entry: string, currentPath: string | undefined): string {
  return currentPath == null || currentPath === ''
    ? entry
    : `${entry}${delimiter}${currentPath}`;
}

async function runToolsDevSuite(
  suite: SmokeSuite,
  run: (context: ToolsDevSuiteContext) => Promise<void>,
  options: ToolsDevSuiteOptions = {},
): Promise<string> {
  const runtimeEnv = resolveVitestToolsDevEnv(options.env);
  const toolsDev = createToolsDevSuite({
    codexHomeDir: suite.codexHomeDir,
    dataDir: suite.dataDir,
    namespace: suite.namespace,
    root: suite.root,
    toolsDevRoot: suite.toolsDevRoot,
  });
  let context: ToolsDevSuiteContext | null = null;
  let diagnostics: unknown = null;
  let caughtError: unknown = null;
  let success = false;

  try {
    const start = await toolsDev.startWeb(runtimeEnv);
    const runtime = toolsDev.portAllocation;
    if (runtime == null) throw new Error('tools-dev did not expose its allocated ports');
    const webUrl = assertRuntimeUrl(start.web?.status.url, 'web');
    const status = await toolsDev.status(runtimeEnv);
    assertToolsDevStatus(suite, status);

    context = {
      check: () => toolsDev.check(runtimeEnv),
      logs: () => toolsDev.logs(runtimeEnv),
      runtime,
      start,
      status,
      webUrl,
    };

    await run(context);
    if (options.skipFatalLogCheck !== true) {
      assertNoFatalLogs(await context.logs());
    }
    success = true;
  } catch (error) {
    caughtError = error;
    diagnostics = await toolsDev.check(runtimeEnv).catch((diagnosticError: unknown) => ({
      error: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
    }));
    await options.onFailure?.({ context, error, suite }).catch((failureHookError: unknown) => {
      diagnostics = {
        diagnostics,
        failureHookError: failureHookError instanceof Error ? failureHookError.message : String(failureHookError),
      };
    });
    throw error;
  } finally {
    // tools-dev may have spawned namespace processes even if startWeb threw before
    // resolving, so cleanup must run unconditionally — otherwise orphans poison the
    // next smoke run on a shared CI runner.
    let stopError: unknown = null;
    try {
      await toolsDev.stopWeb(runtimeEnv);
    } catch (error) {
      stopError = error;
    }
    if (stopError != null) {
      diagnostics = {
        diagnostics,
        stopError: stopError instanceof Error ? stopError.message : String(stopError),
      };
      // If the test body already failed, the catch block rethrew it; treat the stop
      // failure as a side effect. If the body succeeded, the stop failure is the
      // test failure — silent leaks are worse than a noisy assertion.
      if (caughtError == null) {
        success = false;
        caughtError = stopError;
      }
    }
    await suite.finalize({ diagnostics, error: caughtError, success });
    if (stopError != null && caughtError === stopError) {
      throw stopError;
    }
  }
  return suite.report.root;
}

async function runTokenToSeaSuite(
  suite: SmokeSuite,
  cloud: TokenToSeaCloud,
  member: string,
  run: (context: TokenToSeaSuiteContext) => Promise<void>,
  options: TokenToSeaSuiteOptions = {},
): Promise<string> {
  const { session: seedOptions, env, ...toolsDevOptions } = options;
  // The daemon reads its identity file once at startup, so the session must exist first.
  const session = await cloud.seedSession(suite.dataDir, member, seedOptions);
  // Shared by every daemon on this cloud: only records added after this point prove *this* daemon loaded it.
  const guardLoadsBefore = (await cloud.egress.loaded('daemon')).length;
  return runToolsDevSuite(
    suite,
    async (context) => {
      const daemonUrl = assertRuntimeUrl(context.start.daemon?.status.url, 'daemon');
      const request = (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (!headers.has('cookie')) headers.set('cookie', session.cookieHeader);
        return fetch(new URL(path, `${daemonUrl}/`), { ...init, headers });
      };
      const requestJson = async <T>(path: string, json: JsonRequestOptions = {}): Promise<T> => {
        const response = await request(path, {
          method: json.method ?? (json.body === undefined ? 'GET' : 'POST'),
          headers: {
            ...(json.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...json.headers,
          },
          ...(json.body === undefined ? {} : { body: JSON.stringify(json.body) }),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${text.slice(0, 500)}`);
        return (text ? JSON.parse(text) : null) as T;
      };
      const tokenToSea: TokenToSeaSuiteContext = { ...context, cloud, daemonUrl, session, request, requestJson };
      try {
        await assertTokenToSeaSignedIn(tokenToSea);
        if (cloud.egress.enabled && (await cloud.egress.loaded('daemon')).length <= guardLoadsBefore) {
          throw new Error('the e2e egress guard did not load in the daemon (NODE_OPTIONS was not propagated); production egress checks would be vacuous');
        }
        await run(tokenToSea);
        const blocked = await cloud.egress.blocked();
        if (blocked.length > 0) {
          throw new Error(`a TokenToSea test-origin runtime tried to reach a production TokenToSea host: ${JSON.stringify(blocked.slice(0, 5))}`);
        }
      } finally {
        await suite.report.json('tokentosea-cloud/requests.json', cloud.requests()).catch(() => undefined);
        await suite.report.json('tokentosea-cloud/egress.json', await cloud.egress.read().catch(() => [])).catch(() => undefined);
      }
    },
    { ...toolsDevOptions, env: cloud.env(env) },
  );
}

/** Fail with the reason a seeded session is not signed in, instead of a later opaque 401. */
async function assertTokenToSeaSignedIn(context: TokenToSeaSuiteContext): Promise<void> {
  const response = await context.request('/api/tokentosea/status');
  const status = await response.json().catch(() => null) as
    | { signedIn?: boolean; user?: { id?: string } | null }
    | null;
  if (response.ok && status?.signedIn === true && status.user?.id === context.session.userId) return;
  const lines = Object.values(await context.logs().catch(() => ({}))).flatMap((entry) => entry.lines);
  const ignored = lines
    .map((line) => /ignoring OD_TOKENTOSEA_TEST_ORIGIN \(([^)]+)\)/.exec(line)?.[1])
    .find((reason) => reason != null);
  const active = lines.some((line) => line.includes(`OD_TOKENTOSEA_TEST_ORIGIN active: issuer=${context.cloud.issuer}`));
  const cause = ignored != null
    ? `the daemon ignored OD_TOKENTOSEA_TEST_ORIGIN (${ignored}) and kept the production endpoints`
    : active
      ? 'the test origin is active but the daemon did not accept the seeded session'
      : 'the daemon log has no "OD_TOKENTOSEA_TEST_ORIGIN active" line for this cloud';
  throw new Error(
    `seeded TokenToSea session for ${context.session.member.name} is not signed in: ${cause}; `
      + `HTTP ${response.status} ${JSON.stringify(status)}`,
  );
}

function assertRuntimeUrl(value: string | null | undefined, app: string): string {
  if (typeof value !== 'string' || !value.startsWith('http://')) {
    throw new Error(`${app} runtime did not expose an http URL: ${String(value)}`);
  }
  return value;
}

function assertToolsDevStatus(suite: SmokeSuite, status: ToolsDevStatusResult): void {
  expect(status.namespace).toBe(suite.namespace);
  expect(status.apps?.daemon?.state).toBe('running');
  expect(status.apps?.web?.state).toBe('running');
}

function assertNoFatalLogs(logs: Record<string, { lines: string[] }>): void {
  const combined = Object.values(logs)
    .flatMap((entry) => entry.lines)
    .join('\n');
  expect(combined).not.toMatch(/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
  expect(combined).not.toMatch(/standalone Next\.js server exited/i);
  expect(combined).not.toMatch(/packaged runtime failed/i);
  expect(combined).not.toMatch(/Agent completed without producing any output/i);
}

function sanitizeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'suite';
}

function formatUnknown(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
