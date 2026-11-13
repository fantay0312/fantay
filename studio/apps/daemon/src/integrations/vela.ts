import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type {
  AmrAuthErrorKind,
  AmrAuthNetworkPath,
  AmrAuthStage,
  AmrAuthStageResult,
  AmrEntryAttribution,
  TrackingAmrEntrySource,
  TrackingCampaignConversionSource,
  TrackingCampaignId,
  TrackingPageName,
} from '@open-design/contracts/analytics';
import type { AmrSessionState } from '@open-design/contracts';

import { resolveAmrProfile } from './vela-profile.js';
import { resolveEffectiveVelaConsoleOrigin } from './vela-console-origin.js';
import { optionalTokenToSeaRuntime } from './tokentosea-runtime.js';

export { resolveAmrProfile } from './vela-profile.js';

const AMR_ENTRY_SOURCES: ReadonlySet<TrackingAmrEntrySource> = new Set([
  'onboarding_amr_card',
  'onboarding_amr_sign_in_continue',
  'inline_model_switcher_amr_row',
  'settings_amr_agent_card',
  'settings_amr_authorize',
  'settings_cloud_callout',
  'settings_amr_console',
  'settings_amr_install',
  'avatar_amr_console',
  'handoff_amr_website',
  'chat_error_authorize_retry',
  'chat_error_recharge',
  'chat_error_upgrade',
  'chat_balance_gate_upgrade',
  'chat_upgrade_card',
  'chat_upgrade_card_auto_recharge',
  'home_balance_gate_upgrade',
  'chat_low_balance_warn_recharge',
  'home_low_balance_warn_recharge',
  'chat_balance_gate_sign_in',
  'home_balance_gate_sign_in',
  'chat_error_switch_retry_card',
  'generation_preview_authorize_retry',
  'generation_preview_recharge',
  'generation_preview_switch_retry_card',
  'settings_amr_upgrade',
  'inline_amr_upgrade',
  'go_plan_sunset_modal',
  'deepseek_unpaid_modal',
  'deepseek_workbench_badge',
  'deepseek_model_switcher_upgrade',
  'avatar_amr_upgrade',
  'avatar_amr_agent_card',
  'artifact_success_upgrade',
  'home_artifact_upgrade',
]);

function isCanonicalAmrAuthAttemptId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

const AMR_ONBOARDING_PROFILE_SOURCES: ReadonlySet<TrackingAmrEntrySource> = new Set([
  'onboarding_amr_card',
  'onboarding_amr_sign_in_continue',
]);

type AmrEntrySourcePageName = Extract<
  TrackingPageName,
  'onboarding' | 'chat_panel' | 'settings' | 'file_manager' | 'artifact' | 'home'
>;

const AMR_ENTRY_SOURCE_PAGES: ReadonlySet<AmrEntrySourcePageName> = new Set([
  'onboarding',
  'chat_panel',
  'settings',
  'file_manager',
  'artifact',
  'home',
]);

// Fail-closed: an id missing here voids the WHOLE entry, not just its campaign
// field, so a live campaign left out loses every attributed entry it produces.
// Both are listed because entries minted during the finished free week can
// still arrive within their attribution window.
const AMR_ENTRY_CAMPAIGN_IDS: ReadonlySet<TrackingCampaignId> = new Set([
  'deepseek_v4_flash',
  'deepseek_v4_pro',
  'go_plan_sunset_202608',
]);

const AMR_ENTRY_CAMPAIGN_CONVERSION_SOURCES: ReadonlySet<TrackingCampaignConversionSource> =
  new Set([
    'go_plan_sunset_modal',
    'deepseek_unpaid_modal',
    'deepseek_workbench_badge',
    'deepseek_model_switcher_upgrade',
    'landing_home_banner',
    'landing_pricing_personal_plan',
    'landing_pricing_team_plan',
  ]);

const AMR_ENTRY_SOURCE_PAGE_BY_SOURCE: Record<
  TrackingAmrEntrySource,
  AmrEntrySourcePageName
> = {
  onboarding_amr_card: 'onboarding',
  onboarding_amr_sign_in_continue: 'onboarding',
  inline_model_switcher_amr_row: 'chat_panel',
  settings_amr_agent_card: 'settings',
  settings_amr_authorize: 'settings',
  settings_cloud_callout: 'settings',
  settings_amr_console: 'settings',
  settings_amr_install: 'settings',
  avatar_amr_console: 'chat_panel',
  handoff_amr_website: 'artifact',
  chat_error_authorize_retry: 'chat_panel',
  chat_error_recharge: 'chat_panel',
  chat_error_upgrade: 'chat_panel',
  chat_balance_gate_upgrade: 'chat_panel',
  chat_upgrade_card: 'chat_panel',
  chat_upgrade_card_auto_recharge: 'chat_panel',
  home_balance_gate_upgrade: 'home',
  chat_low_balance_warn_recharge: 'chat_panel',
  home_low_balance_warn_recharge: 'home',
  chat_balance_gate_sign_in: 'chat_panel',
  home_balance_gate_sign_in: 'home',
  chat_error_switch_retry_card: 'chat_panel',
  generation_preview_authorize_retry: 'file_manager',
  generation_preview_recharge: 'file_manager',
  generation_preview_switch_retry_card: 'file_manager',
  settings_amr_upgrade: 'settings',
  inline_amr_upgrade: 'chat_panel',
  go_plan_sunset_modal: 'home',
  deepseek_unpaid_modal: 'home',
  deepseek_workbench_badge: 'home',
  deepseek_model_switcher_upgrade: 'chat_panel',
  avatar_amr_upgrade: 'chat_panel',
  avatar_amr_agent_card: 'chat_panel',
  artifact_success_upgrade: 'artifact',
  home_artifact_upgrade: 'home',
};

const AMR_ANALYTICS_EVENTS_URL =
  'https://amr-api.open-design.ai/api/v1/analytics/events';
const AMR_ANALYTICS_TIMEOUT_MS = 1500;
const OD_DEVICE_ID_MAX_LENGTH = 128;

type AmrAnalyticsEnv = 'local' | 'test' | 'staging' | 'production';

const AMR_ANALYTICS_ENVS: ReadonlySet<AmrAnalyticsEnv> = new Set([
  'local',
  'test',
  'staging',
  'production',
]);

export interface AmrEntryAnalyticsPayload {
  pageName: 'open_design';
  sourcePageName: AmrEntrySourcePageName;
  area: 'amr_entry';
  element: TrackingAmrEntrySource;
  action: 'click_amr_entry';
  entryId: string;
  sourceProduct: 'open_design';
  sourceDetail: TrackingAmrEntrySource;
  entryOccurredAt: string;
  // Campaign dimensions mirrored from the web consent-gated channel so the
  // AMR ingest body matches the local PostHog + redirect URL envelope.
  campaignId?: TrackingCampaignId;
  conversionSource?: TrackingCampaignConversionSource;
  // Optional self-reported onboarding profile, forwarded to AMR for paid-
  // conversion segmentation. Open strings (not a union) so a new onboarding
  // option never forces a contract bump on either side. useCase is multi-select.
  odRole?: string;
  odOrgSize?: string;
  odUseCase?: string[];
  odSource?: string;
}

export interface AmrOnboardingProfileAnalyticsPayload {
  pageName: 'open_design';
  sourcePageName: 'onboarding';
  area: 'onboarding';
  element: 'about_you_submit';
  action: 'submit_profile';
  entryId: string;
  sourceProduct: 'open_design';
  sourceDetail: TrackingAmrEntrySource;
  entryOccurredAt: string;
  profileOccurredAt: string;
  odDeviceId?: string;
  odRole?: string;
  odOrgSize?: string;
  odUseCase?: string[];
  odSource?: string;
}

export interface AmrEntryAnalyticsContext {
  deviceId?: string | null;
  sessionId?: string | null;
  locale?: string | null;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
}

type FetchLike = (
  input: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface MirrorAmrEntryAnalyticsDeps {
  analyticsContext?: AmrEntryAnalyticsContext | null;
  appVersion?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

export interface MirrorAmrEntryAnalyticsResult {
  mirrored: boolean;
  status?: number;
  error?: string;
}

export interface VelaUser {
  id: string;
  email: string;
  name?: string;
  image?: string | null;
  plan?: string;
  /**
   * Wallet balance (USD, string), surfaced live from the control-plane
   * `/api/v1/me` endpoint. `null` when unknown (lookup failed, not yet warmed,
   * or upstream does not return it). Absent on stale config-only reads.
   */
  balanceUsd?: string | null;
}

export interface VelaLoginStatus {
  loggedIn: boolean;
  sessionState?: AmrSessionState;
  credentialRevision?: string;
  loginInFlight: boolean;
  profile: string;
  user: VelaUser | null;
  /**
   * Live billing projection (plan tier + wallet balance) for the signed-in
   * account. Kept SEPARATE from `user` so env-backed sessions (where `user` is
   * null) can surface plan/balance without fabricating a blank identity, and so
   * `user.id === null` keeps meaning "no account identity available" for
   * analytics and other callers. Absent until the live summary resolves;
   * absent means unknown / hidden.
   */
  account?: VelaLiveAccount;
  configPath: string;
  /**
   * Device-authorization URL parsed from `vela login` stdout, surfaced so the
   * user can complete sign-in manually when the browser did not auto-open.
   * Present only while a login is in flight and after vela has printed it.
   */
  activationUrl?: string;
  /** Device-authorization user code printed alongside the activation URL. */
  userCode?: string;
  /** True when vela warned it could not open the browser automatically. */
  browserOpenFailed?: boolean;
  /**
   * Origin of the vela web console this runtime talks to, when it was given
   * one. See {@link resolveVelaConsoleOrigin} — the client needs it to build
   * wallet / plans / upgrade links for a non-public AMR environment.
   */
  consoleOrigin?: string;
  authAttemptId?: string;
  authStages?: VelaLoginAuthStage[];
  authRoute?: AmrAuthNetworkPath;
  fallbackUsed?: boolean;
}

/**
 * The vela web console origin this runtime was configured with, normalized
 * without a trailing slash, or undefined when it was given none.
 *
 * Non-prod AMR environments are internal deployments, so their hostnames are
 * not literals in this public repository: packaging injects the origin from a
 * CI secret and the packaged runtime forwards it as `OD_VELA_WEB_URL`. Reporting
 * it on the login status is how the web client learns which console to link to.
 * The resolver combines that packaged origin with the settings-selected AMR
 * profile, so a runtime switch cannot keep linking to the package's backend.
 */
export function resolveVelaConsoleOrigin(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): string | undefined {
  return resolveEffectiveVelaConsoleOrigin(env, configuredEnv);
}

export interface VelaLoginAuthStage {
  sequence: number;
  stage: AmrAuthStage;
  result: AmrAuthStageResult;
  source: 'daemon';
  occurredAt: string;
  route: AmrAuthNetworkPath;
  errorKind?: AmrAuthErrorKind;
}

export interface VelaLoginAttemptSnapshot {
  authAttemptId?: string;
  authStages?: VelaLoginAuthStage[];
  authRoute?: AmrAuthNetworkPath;
  fallbackUsed?: boolean;
}

export interface VelaLoginActivation {
  activationUrl: string | null;
  userCode: string | null;
  browserOpenFailed: boolean;
}

// `vela login` is a device-authorization flow. Before it best-effort opens the
// browser it prints, to stdout, the exact lines:
//
//   Open this URL to continue:
//   <activation-url>
//
//   Code: <user-code>
//
// and, when the auto-open fails, warns on stderr "could not open browser
// automatically: …" (see apps/cli/internal/commands/login.go in the vela repo).
// The daemon spawns vela login headless, so this parser recovers the URL/code/
// warning from the captured streams to surface them to the user. Pure so the
// extraction rules stay unit-testable against vela's literal output format.
export function parseVelaLoginActivation(
  stdout: string,
  stderr: string,
): VelaLoginActivation {
  const urlMatch = /Open this URL to continue:\s*\r?\n\s*(\S+)/i.exec(stdout);
  // Anchor on a line start so a `user_code=` query param inside the URL is not
  // mistaken for the dedicated `Code:` line.
  const codeMatch = /^[^\S\r\n]*Code:\s*(\S+)/im.exec(stdout);
  return {
    activationUrl: urlMatch?.[1] ?? null,
    userCode: codeMatch?.[1] ?? null,
    browserOpenFailed: /could not open browser automatically/i.test(stderr),
  };
}

export interface VelaCredentialRevision {
  authSource: 'env' | 'file' | 'none';
  profile: string;
  loggedIn: boolean;
  userId: string;
  userEmail: string;
  configMtimeMs: number | null;
  /**
   * Non-secret fingerprint of the configured AMR env credentials
   * (`VELA_RUNTIME_KEY` / `VELA_LINK_URL`, which can come from `agentCliEnv.amr`
   * in app-config, not just process env). Env-backed sessions report
   * `user: null`, so without this an account switch that only rewrites the
   * Settings-backed env (leaving `~/.amr/config.json` untouched) would reuse the
   * previous account's cached plan/balance. File-backed sessions fingerprint
   * the stored keys as well, so a successful login is recognized even when a
   * filesystem preserves the config mtime.
   */
  credentialFingerprint: string;
}

export interface VelaControlApiContext {
  profile: string;
  apiUrl: string;
  controlKey: string;
  user: VelaUser | null;
  configMtimeMs: number | null;
}

export interface VelaApiContext {
  profile: string;
  apiUrl: string;
}

interface VelaProfileShape {
  controlKey?: string;
  runtimeKey?: string;
  apiUrl?: string;
  linkUrl?: string;
  user?: VelaUser | null;
}

interface VelaConfigFileShape {
  profiles?: Record<string, VelaProfileShape>;
}

interface VelaProfileConfigSnapshot {
  profile: string;
  stored: VelaProfileShape | undefined;
  configMtimeMs: number | null;
}

export function mergeVelaEnv(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...configuredEnv,
  };
}

function configDir(): string {
  const amrHome = process.env.AMR_HOME?.trim();
  if (amrHome === '~') return homedir();
  if (amrHome?.startsWith('~/')) return path.join(homedir(), amrHome.slice(2));
  if (amrHome) return amrHome;
  return path.join(homedir(), '.amr');
}

export function amrConfigPath(): string {
  return path.join(configDir(), 'config.json');
}

function readConfigFile(): VelaConfigFileShape | null {
  const file = amrConfigPath();
  if (!existsSync(file)) return null;
  try {
    const data = readFileSync(file, 'utf8');
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as VelaConfigFileShape;
  } catch {
    return null;
  }
}

function readVelaProfileConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): VelaProfileConfigSnapshot {
  const mergedEnv = mergeVelaEnv(env, configuredEnv);
  const profile = resolveAmrProfile(mergedEnv);
  const file = readConfigFile();
  return {
    profile,
    stored: file?.profiles?.[profile],
    configMtimeMs: existsSync(amrConfigPath()) ? statSync(amrConfigPath()).mtimeMs : null,
  };
}

export function readVelaLoginStatus(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): VelaLoginStatus {
  const runtime = optionalTokenToSeaRuntime();
  if (runtime) {
    const current = runtime.current(), user = current?.user;
    return { loggedIn: Boolean(user), sessionState: user ? 'authenticated' : 'signed_out',
      credentialRevision: runtime.identityKey(), loginInFlight: current?.raw ? runtime.identity.pending(current.raw) : false,
      profile: 'tokentosea', user: user ? { id: user.id, email: user.email ?? '', name: user.name, ...(user.picture ? { image: user.picture } : {}) } : null,
      configPath: '', consoleOrigin: 'https://tokentosea.com' };
  }
  const rawStatus = readRawVelaLoginStatus(env, configuredEnv);
  const credentialRevision = velaCredentialRevisionDigest(
    readRawVelaCredentialRevision(env, configuredEnv, rawStatus),
  );
  let sessionState: AmrSessionState = 'authenticated';
  if (!rawStatus.loggedIn) {
    sessionState = 'signed_out';
  } else if (expiredVelaCredentialRevisions.has(credentialRevision)) {
    sessionState = 'reauth_required';
  }
  return {
    ...rawStatus,
    // `loggedIn` remains the backwards-compatible "credential is present"
    // projection. Routing must not treat an expired credential like a brand
    // new user and throw them back into first-run onboarding; new callers use
    // `sessionState` for authoritative validity.
    loggedIn: rawStatus.loggedIn,
    sessionState,
    credentialRevision,
  };
}

function readRawVelaLoginStatus(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): Omit<VelaLoginStatus, 'sessionState' | 'credentialRevision'> {
  const mergedEnv = mergeVelaEnv(env, configuredEnv);
  const profile = resolveAmrProfile(mergedEnv);
  const configPath = amrConfigPath();
  const loginInFlight = isVelaLoginInFlight();
  // Only meaningful while signing in (loggedIn becomes true once vela writes the
  // runtime key); empty otherwise so completed sessions don't echo a stale URL.
  const activationFields: Partial<VelaLoginStatus> =
    loginInFlight && activeLoginActivation
      ? {
          ...(activeLoginActivation.activationUrl
            ? { activationUrl: activeLoginActivation.activationUrl }
            : {}),
          ...(activeLoginActivation.userCode
            ? { userCode: activeLoginActivation.userCode }
            : {}),
          ...(activeLoginActivation.browserOpenFailed
            ? { browserOpenFailed: true }
            : {}),
        }
      : {};
  const runtimeKey = mergedEnv.VELA_RUNTIME_KEY?.trim() ?? '';
  const linkUrl = mergedEnv.VELA_LINK_URL?.trim() ?? '';
  if (runtimeKey && linkUrl) {
    return {
      loggedIn: true,
      loginInFlight,
      profile,
      user: null,
      configPath,
      ...readVelaLoginAttemptSnapshot(),
    };
  }
  const file = readConfigFile();
  const stored = file?.profiles?.[profile];
  const storedRuntimeKey = stored?.runtimeKey?.trim() ?? '';
  if (!storedRuntimeKey) {
    return {
      loggedIn: false,
      loginInFlight,
      profile,
      user: null,
      configPath,
      ...activationFields,
      ...readVelaLoginAttemptSnapshot(),
    };
  }
  const rawUser = stored?.user ?? null;
  const user: VelaUser | null = rawUser
    ? {
        id: typeof rawUser.id === 'string' ? rawUser.id : '',
        email: typeof rawUser.email === 'string' ? rawUser.email : '',
        ...(typeof rawUser.name === 'string' ? { name: rawUser.name } : {}),
        ...(typeof rawUser.image === 'string' ? { image: rawUser.image } : {}),
        ...(typeof rawUser.plan === 'string' ? { plan: rawUser.plan } : {}),
      }
    : null;
  return {
    loggedIn: true,
    loginInFlight,
    profile,
    user,
    configPath,
    ...readVelaLoginAttemptSnapshot(),
  };
}

/**
 * Live account fields (plan tier + wallet balance) sourced from the vela CLI
 * (`vela billing summary`). Cached separately from the config-only
 * {@link readVelaLoginStatus} read so the status route can merge live data
 * without blocking: the route reads this cache synchronously and triggers a
 * background CLI refresh for the next poll. The CLI spawn itself lives in the
 * route layer (which already resolves the vela launch path for models).
 */
export interface VelaLiveAccount {
  plan?: string;
  balanceUsd?: string | null;
}

const liveAccountCache = new Map<string, VelaLiveAccount>();
const liveAccountFetchedAt = new Map<string, number>();
const LIVE_ACCOUNT_TTL_MS = 60_000;

/**
 * Cache key for the live account. Derived from the full credential revision
 * (auth source + profile + signed-in user + config mtime), NOT just the
 * profile — so a logout or an account switch on the same profile produces a
 * fresh key and the previous account's plan/balance can never leak into a new
 * session before the background refresh completes.
 */
export function velaLiveAccountCacheKey(
  revision: VelaCredentialRevision,
): string {
  return [
    revision.authSource,
    revision.profile,
    revision.loggedIn ? '1' : '0',
    revision.userId,
    revision.configMtimeMs ?? '',
    revision.credentialFingerprint,
  ].join('|');
}

/** Synchronous, non-blocking read of the most recent live-account projection. */
export function peekVelaLiveAccount(cacheKey: string): VelaLiveAccount | null {
  return liveAccountCache.get(cacheKey) ?? null;
}

/**
 * TTL gate for the background refresh. Returns true (and records the attempt)
 * at most once per cache key per {@link LIVE_ACCOUNT_TTL_MS}, so concurrent
 * status polls don't all spawn the CLI.
 */
export function shouldRefreshVelaLiveAccount(cacheKey: string): boolean {
  const last = liveAccountFetchedAt.get(cacheKey) ?? 0;
  if (Date.now() - last < LIVE_ACCOUNT_TTL_MS) return false;
  liveAccountFetchedAt.set(cacheKey, Date.now());
  return true;
}

/** Store a freshly fetched live-account projection. */
export function setVelaLiveAccount(
  cacheKey: string,
  account: VelaLiveAccount,
): void {
  liveAccountCache.set(cacheKey, account);
  // Stamp the fetch time so the warm-path TTL gate doesn't immediately trigger
  // a redundant refresh right after a (blocking) cold fetch populated the cache.
  liveAccountFetchedAt.set(cacheKey, Date.now());
}

/** Clear the refresh throttle so a failed fetch can retry on the next poll. */
export function clearVelaLiveAccountRefreshThrottle(cacheKey: string): void {
  liveAccountFetchedAt.delete(cacheKey);
}

/**
 * Drop every cached live-account projection + throttle. Call on logout so a
 * subsequent login can never surface the signed-out account's plan or balance.
 */
export function clearAllVelaLiveAccounts(): void {
  liveAccountCache.clear();
  liveAccountFetchedAt.clear();
}

/**
 * Attach a fetched live account (plan tier + wallet balance) to a login status
 * on the dedicated {@link VelaLoginStatus.account} field. Deliberately does NOT
 * touch `status.user`: env-backed sessions keep `user: null` (no fabricated
 * blank identity), and the billing projection rides on its own field so every
 * surface can read plan/balance uniformly. No-op when signed out or when there
 * is no account to apply.
 */
export function applyVelaLiveAccount(
  status: VelaLoginStatus,
  account: VelaLiveAccount | null,
): void {
  if (!status.loggedIn || !account) return;
  status.account = account;
}

export function readVelaCredentialRevision(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): VelaCredentialRevision {
  const runtime = optionalTokenToSeaRuntime();
  if (runtime) {
    const user = runtime.current()?.user;
    return { authSource: user ? 'file' : 'none', profile: 'tokentosea', loggedIn: Boolean(user),
      userId: user?.id ?? '', userEmail: user?.email ?? '', configMtimeMs: null, credentialFingerprint: runtime.identityKey() };
  }
  return readRawVelaCredentialRevision(
    env,
    configuredEnv,
    readRawVelaLoginStatus(env, configuredEnv),
  );
}

function readRawVelaCredentialRevision(
  env: NodeJS.ProcessEnv,
  configuredEnv: Record<string, string>,
  status: Omit<VelaLoginStatus, 'sessionState' | 'credentialRevision'>,
): VelaCredentialRevision {
  const mergedEnv = mergeVelaEnv(env, configuredEnv);
  const hasEnvCredentials =
    (mergedEnv.VELA_RUNTIME_KEY?.trim() ?? '').length > 0 &&
    (mergedEnv.VELA_LINK_URL?.trim() ?? '').length > 0;
  // One-way hash (never the raw key) so the cache key distinguishes env-backed
  // accounts whose only difference is the configured runtime credential.
  const fileProfile = hasEnvCredentials
    ? undefined
    : readConfigFile()?.profiles?.[status.profile];
  const credentialFingerprint = createHash('sha256')
    .update(
      hasEnvCredentials
        ? `${mergedEnv.VELA_RUNTIME_KEY ?? ''}\n${mergedEnv.VELA_LINK_URL ?? ''}`
        : [
            fileProfile?.runtimeKey ?? '',
            fileProfile?.controlKey ?? '',
            fileProfile?.linkUrl ?? '',
            fileProfile?.apiUrl ?? '',
          ].join('\n'),
    )
    .digest('hex')
    .slice(0, 16);
  return {
    authSource: hasEnvCredentials ? 'env' : status.loggedIn ? 'file' : 'none',
    profile: status.profile,
    loggedIn: status.loggedIn,
    userId: status.user?.id ?? '',
    userEmail: status.user?.email ?? '',
    // Include the config mtime even for env-backed auth: the live billing
    // summary is fetched with the config profile's controlKey, so a config
    // rewrite (account switch) must invalidate the cached plan/balance — even
    // when VELA_RUNTIME_KEY is the active runtime credential. Otherwise an
    // env-backed session keeps serving the previous account's plan/balance.
    configMtimeMs: existsSync(status.configPath)
      ? statSync(status.configPath).mtimeMs
      : null,
    credentialFingerprint,
  };
}

const expiredVelaCredentialRevisions = new Set<string>();
const expiredVelaControlKeys = new Set<string>();

function velaCredentialRevisionDigest(revision: VelaCredentialRevision): string {
  return createHash('sha256')
    .update(JSON.stringify(revision))
    .digest('hex')
    .slice(0, 20);
}

/** Mark only the currently-active credential revision as rejected upstream. */
export function markVelaAuthorizationExpired(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): string {
  const revision = velaCredentialRevisionDigest(readVelaCredentialRevision(env, configuredEnv));
  expiredVelaCredentialRevisions.add(revision);
  const control = readRawVelaControlApiContext(env, configuredEnv);
  if (control) expiredVelaControlKeys.add(velaControlKeyDigest(control.controlKey));
  return revision;
}

/** Test/logout seam. A rotated credential naturally has a different revision. */
export function clearVelaAuthorizationState(): void {
  expiredVelaCredentialRevisions.clear();
  expiredVelaControlKeys.clear();
}

function velaControlKeyDigest(controlKey: string): string {
  return createHash('sha256').update(controlKey).digest('hex').slice(0, 20);
}

export function readVelaControlApiContext(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): VelaControlApiContext | null {
  const runtime = optionalTokenToSeaRuntime();
  if (runtime) {
    const user = runtime.current()?.user;
    return user ? { profile: 'tokentosea', apiUrl: 'https://design.tokentosea.com',
      controlKey: runtime.identityKey(), user: { id: user.id, email: user.email ?? '', name: user.name }, configMtimeMs: null } : null;
  }
  const context = readRawVelaControlApiContext(env, configuredEnv);
  if (
    context
    && expiredVelaControlKeys.has(velaControlKeyDigest(context.controlKey))
  ) return null;
  return context;
}

function readRawVelaControlApiContext(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): VelaControlApiContext | null {
  const mergedEnv = mergeVelaEnv(env, configuredEnv);
  const profile = resolveAmrProfile(mergedEnv);
  const envControlKey = mergedEnv.VELA_CONTROL_KEY?.trim() ?? '';
  const envApiUrl = mergedEnv.VELA_API_URL?.trim() ?? '';
  if (envControlKey) {
    const status = readRawVelaLoginStatus(env, configuredEnv);
    return {
      profile,
      apiUrl: envApiUrl || 'https://amr-api.open-design.ai',
      controlKey: envControlKey,
      user: status.user,
      configMtimeMs: null,
    };
  }
  const snapshot = readVelaProfileConfigSnapshot(env, configuredEnv);
  const apiContext = readVelaApiContext(env, configuredEnv, snapshot);
  const stored = snapshot.stored;
  const controlKey = stored?.controlKey?.trim() ?? '';
  if (!controlKey) return null;
  return {
    ...apiContext,
    controlKey,
    user: stored?.user ?? null,
    configMtimeMs: snapshot.configMtimeMs,
  };
}

export function readVelaApiContext(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
  snapshot: VelaProfileConfigSnapshot = readVelaProfileConfigSnapshot(env, configuredEnv),
): VelaApiContext {
  const mergedEnv = mergeVelaEnv(env, configuredEnv);
  return {
    profile: snapshot.profile,
    apiUrl:
      snapshot.stored?.apiUrl?.trim()
      || mergedEnv.VELA_API_URL?.trim()
      || 'https://amr-api.open-design.ai',
  };
}

export function forgetVelaLogin(env: NodeJS.ProcessEnv = process.env): void {
  const file = amrConfigPath();
  if (!existsSync(file)) return;
  const parsed = readConfigFile();
  if (!parsed?.profiles) return;
  const profile = resolveAmrProfile(env);
  if (!Object.prototype.hasOwnProperty.call(parsed.profiles, profile)) return;
  const keptProfileConfig = { ...(parsed.profiles[profile] ?? {}) };
  delete keptProfileConfig.controlKey;
  delete keptProfileConfig.runtimeKey;
  delete keptProfileConfig.user;
  const nextProfiles = { ...parsed.profiles };
  nextProfiles[profile] = keptProfileConfig;
  writeFileSync(
    file,
    JSON.stringify({ ...parsed, profiles: nextProfiles }, null, 2),
    'utf8',
  );
}

// Nothing in this build spawns `vela login` any more (sign-in belongs to
// TokenToSea), so the supervisor state below stays idle; it only feeds the
// status/cancel readers that remain exported.
const activeLoginProcs = new Map<number, ChildProcess>();
interface VelaLoginAttemptRef {
  authAttemptId: string;
  generation: number;
}

interface VelaLoginAttemptState extends VelaLoginAttemptRef {
  authRequestId?: string;
  canceled: boolean;
  fallbackPending: boolean;
  fallbackStarted: boolean;
  currentPid: number | null;
  route: AmrAuthNetworkPath;
  fallbackUsed: boolean;
  stages: VelaLoginAuthStage[];
}

let loginGeneration = 0;
let latestLoginAttempt: VelaLoginAttemptState | null = null;
// Children registered for supervision until their `close`/`error` terminal
// handler runs. Distinct from `isVelaLoginInFlight()`: status can drop the
// public idle projection between `exit` and `close` once `exitCode` is set
// (especially after cancel, which suppresses the fallbackPending bridge).
let pendingVelaLoginTerminals = 0;
const LOGIN_CANCEL_KILL_GRACE_MS = 2000;

// Activation details captured from the in-flight `vela login` child. Reset on
// each spawn (one interactive login at a time); `readVelaLoginStatus` only
// surfaces it while a login is actually in flight.
let activeLoginActivation: VelaLoginActivation | null = null;

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function hasRunningVelaLoginChild(): boolean {
  for (const [pid, child] of activeLoginProcs) {
    if (isChildRunning(child)) return true;
    activeLoginProcs.delete(pid);
  }
  return false;
}

export function isVelaLoginInFlight(): boolean {
  return hasRunningVelaLoginChild()
    || Boolean(latestLoginAttempt?.fallbackPending && !latestLoginAttempt.canceled);
}

/**
 * True once every supervised login child has finished its `close`/`error`
 * terminal handler and no late proxy fallback is still pending.
 *
 * Stronger than `isVelaLoginInFlight()` for tests that must observe the
 * close-deferred late-fallback decision: the public idle projection can
 * flip true between `exit` and `close` when the attempt was canceled.
 */
export function isVelaLoginSupervisorSettled(): boolean {
  return pendingVelaLoginTerminals === 0
    && !Boolean(latestLoginAttempt?.fallbackPending && !latestLoginAttempt.canceled);
}

export interface CancelVelaLoginResult {
  canceled: boolean;
  pids: number[];
}

export function cancelVelaLogin(
  expectedAuthAttemptId?: string | null,
  expectedAuthRequestId?: string | null,
): CancelVelaLoginResult {
  if (
    expectedAuthAttemptId !== undefined
    && expectedAuthAttemptId !== null
    && latestLoginAttempt?.authAttemptId !== expectedAuthAttemptId
  ) {
    return { canceled: false, pids: [] };
  }
  if (
    expectedAuthRequestId !== undefined
    && expectedAuthRequestId !== null
    && latestLoginAttempt?.authRequestId !== expectedAuthRequestId
  ) {
    return { canceled: false, pids: [] };
  }
  const attemptWasActive = Boolean(
    latestLoginAttempt
      && !latestLoginAttempt.canceled
      && (latestLoginAttempt.fallbackPending || hasRunningVelaLoginChild()),
  );
  if (latestLoginAttempt) latestLoginAttempt.canceled = true;
  // Invalidate every callback/captured stage belonging to the canceled
  // attempt before signalling its child. A late direct exit can therefore
  // never start the proxy fallback after the user has canceled.
  loginGeneration += 1;
  const pids: number[] = [];
  for (const [pid, child] of activeLoginProcs) {
    if (!isChildRunning(child)) {
      activeLoginProcs.delete(pid);
      continue;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      activeLoginProcs.delete(pid);
      continue;
    }
    pids.push(pid);
    const killTimer = setTimeout(() => {
      try {
        if (isChildRunning(child)) child.kill('SIGKILL');
      } catch {
        activeLoginProcs.delete(pid);
      }
    }, LOGIN_CANCEL_KILL_GRACE_MS);
    killTimer.unref?.();
  }
  return { canceled: attemptWasActive || pids.length > 0, pids };
}

export function parseVelaAuthAttemptId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = (input as { authAttemptId?: unknown }).authAttemptId;
  return isCanonicalAmrAuthAttemptId(value) ? value : null;
}

export function parseVelaAuthRequestId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = (input as { authRequestId?: unknown }).authRequestId;
  return typeof value === 'string'
    && /^pending-amr-auth-[a-z0-9]+-[a-z0-9]+$/.test(value)
    ? value
    : null;
}

export function readVelaLoginAttemptSnapshot(): VelaLoginAttemptSnapshot {
  const attempt = latestLoginAttempt;
  return attempt
    ? {
        authAttemptId: attempt.authAttemptId,
        authStages: attempt.stages.map((stage) => ({ ...stage })),
        authRoute: attempt.route,
        fallbackUsed: attempt.fallbackUsed,
      }
    : {};
}

export function parseVelaLoginAttribution(input: unknown): AmrEntryAttribution | null {
  const raw = input && typeof input === 'object' && 'attribution' in input
    ? (input as { attribution?: unknown }).attribution
    : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<AmrEntryAttribution>;
  if (
    typeof value.entryId !== 'string'
    || value.entryId.length === 0
    || value.sourceProduct !== 'open_design'
    || typeof value.sourceDetail !== 'string'
    || !AMR_ENTRY_SOURCES.has(value.sourceDetail as TrackingAmrEntrySource)
    || typeof value.occurredAt !== 'string'
    || !Number.isFinite(Date.parse(value.occurredAt))
  ) {
    return null;
  }
  const odDeviceId = sanitizeOpenDesignDeviceId(value.odDeviceId);
  return {
    entryId: value.entryId,
    sourceProduct: value.sourceProduct,
    sourceDetail: value.sourceDetail as TrackingAmrEntrySource,
    occurredAt: value.occurredAt,
    ...(odDeviceId ? { odDeviceId } : {}),
  };
}

export function parseAmrEntryAnalyticsPayload(
  input: unknown,
): AmrEntryAnalyticsPayload | null {
  const raw = isRecord(input) && 'payload' in input ? input.payload : input;
  if (!isRecord(raw)) return null;
  const pageName = raw.pageName;
  const sourcePageName = raw.sourcePageName;
  const area = raw.area;
  const element = raw.element;
  const action = raw.action;
  const entryId = raw.entryId;
  const sourceProduct = raw.sourceProduct;
  const sourceDetail = raw.sourceDetail;
  const entryOccurredAt = raw.entryOccurredAt;
  const campaignId = raw.campaignId;
  const conversionSource = raw.conversionSource;
  const hasCampaignId = campaignId !== undefined;
  const hasConversionSource = conversionSource !== undefined;
  const odRole = sanitizeOptionalProfileValue(raw.odRole);
  const odOrgSize = sanitizeOptionalProfileValue(raw.odOrgSize);
  const odSource = sanitizeOptionalProfileValue(raw.odSource);
  const odUseCase = sanitizeOptionalProfileList(raw.odUseCase);
  if (
    pageName !== 'open_design'
    || typeof sourcePageName !== 'string'
    || !AMR_ENTRY_SOURCE_PAGES.has(sourcePageName as AmrEntrySourcePageName)
    || area !== 'amr_entry'
    || typeof element !== 'string'
    || !AMR_ENTRY_SOURCES.has(element as TrackingAmrEntrySource)
    || action !== 'click_amr_entry'
    || typeof entryId !== 'string'
    || entryId.length === 0
    || sourceProduct !== 'open_design'
    || typeof sourceDetail !== 'string'
    || !AMR_ENTRY_SOURCES.has(sourceDetail as TrackingAmrEntrySource)
    || sourceDetail !== element
    || sourcePageName
      !== AMR_ENTRY_SOURCE_PAGE_BY_SOURCE[sourceDetail as TrackingAmrEntrySource]
    || typeof entryOccurredAt !== 'string'
    || !Number.isFinite(Date.parse(entryOccurredAt))
    || (hasCampaignId
      && (typeof campaignId !== 'string'
        || !AMR_ENTRY_CAMPAIGN_IDS.has(campaignId as TrackingCampaignId)))
    || (hasConversionSource
      && (typeof conversionSource !== 'string'
        || !AMR_ENTRY_CAMPAIGN_CONVERSION_SOURCES.has(
          conversionSource as TrackingCampaignConversionSource,
        )))
    || odRole === INVALID_PROFILE_VALUE
    || odOrgSize === INVALID_PROFILE_VALUE
    || odSource === INVALID_PROFILE_VALUE
    || odUseCase === INVALID_PROFILE_VALUE
  ) {
    return null;
  }
  return {
    pageName,
    sourcePageName: sourcePageName as AmrEntrySourcePageName,
    area,
    element: element as TrackingAmrEntrySource,
    action,
    entryId,
    sourceProduct,
    sourceDetail: sourceDetail as TrackingAmrEntrySource,
    entryOccurredAt,
    ...(hasCampaignId ? { campaignId: campaignId as TrackingCampaignId } : {}),
    ...(hasConversionSource
      ? { conversionSource: conversionSource as TrackingCampaignConversionSource }
      : {}),
    ...(odRole ? { odRole } : {}),
    ...(odOrgSize ? { odOrgSize } : {}),
    ...(odUseCase ? { odUseCase } : {}),
    ...(odSource ? { odSource } : {}),
  };
}

export function parseAmrOnboardingProfileAnalyticsPayload(
  input: unknown,
): AmrOnboardingProfileAnalyticsPayload | null {
  const raw = isRecord(input) && 'payload' in input ? input.payload : input;
  if (!isRecord(raw)) return null;
  const pageName = raw.pageName;
  const sourcePageName = raw.sourcePageName;
  const area = raw.area;
  const element = raw.element;
  const action = raw.action;
  const entryId = raw.entryId;
  const sourceProduct = raw.sourceProduct;
  const sourceDetail = raw.sourceDetail;
  const entryOccurredAt = raw.entryOccurredAt;
  const profileOccurredAt = raw.profileOccurredAt;
  const odDeviceId = sanitizeOpenDesignDeviceId(raw.odDeviceId);
  const odRole = sanitizeOptionalProfileValue(raw.odRole);
  const odOrgSize = sanitizeOptionalProfileValue(raw.odOrgSize);
  const odSource = sanitizeOptionalProfileValue(raw.odSource);
  const odUseCase = sanitizeOptionalProfileList(raw.odUseCase);
  if (
    pageName !== 'open_design'
    || sourcePageName !== 'onboarding'
    || area !== 'onboarding'
    || element !== 'about_you_submit'
    || action !== 'submit_profile'
    || typeof entryId !== 'string'
    || entryId.length === 0
    || sourceProduct !== 'open_design'
    || typeof sourceDetail !== 'string'
    || !AMR_ENTRY_SOURCES.has(sourceDetail as TrackingAmrEntrySource)
    || !AMR_ONBOARDING_PROFILE_SOURCES.has(sourceDetail as TrackingAmrEntrySource)
    || typeof entryOccurredAt !== 'string'
    || !Number.isFinite(Date.parse(entryOccurredAt))
    || typeof profileOccurredAt !== 'string'
    || !Number.isFinite(Date.parse(profileOccurredAt))
    || odRole === INVALID_PROFILE_VALUE
    || odOrgSize === INVALID_PROFILE_VALUE
    || odSource === INVALID_PROFILE_VALUE
    || odUseCase === INVALID_PROFILE_VALUE
    || (!odRole && !odOrgSize && !odSource && !odUseCase)
  ) {
    return null;
  }
  return {
    pageName,
    sourcePageName,
    area,
    element,
    action,
    entryId,
    sourceProduct,
    sourceDetail: sourceDetail as TrackingAmrEntrySource,
    entryOccurredAt,
    profileOccurredAt,
    ...(odDeviceId ? { odDeviceId } : {}),
    ...(odRole ? { odRole } : {}),
    ...(odOrgSize ? { odOrgSize } : {}),
    ...(odUseCase ? { odUseCase } : {}),
    ...(odSource ? { odSource } : {}),
  };
}

// Optional profile values are open strings; we accept absent/undefined, reject
// a present-but-wrong type or an over-long value (matches AMR's 64-char cap),
// and otherwise pass the trimmed string through.
const INVALID_PROFILE_VALUE = Symbol('invalid_profile_value');

function sanitizeOptionalProfileValue(
  value: unknown,
): string | undefined | typeof INVALID_PROFILE_VALUE {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return INVALID_PROFILE_VALUE;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return INVALID_PROFILE_VALUE;
  return trimmed;
}

// useCase is multi-select: accept absent/undefined, reject a non-array or any
// element that fails the open-string check, cap the count (matches AMR's array
// bound), and pass the trimmed list through.
function sanitizeOptionalProfileList(
  value: unknown,
): string[] | undefined | typeof INVALID_PROFILE_VALUE {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 20) return INVALID_PROFILE_VALUE;
  const cleaned: string[] = [];
  for (const entry of value) {
    const sanitized = sanitizeOptionalProfileValue(entry);
    if (sanitized === INVALID_PROFILE_VALUE || sanitized === undefined) {
      return INVALID_PROFILE_VALUE;
    }
    cleaned.push(sanitized);
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizeOpenDesignDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > OD_DEVICE_ID_MAX_LENGTH) return null;
  return trimmed;
}

export async function mirrorAmrEntryAnalytics(
  payload: AmrEntryAnalyticsPayload,
  deps: MirrorAmrEntryAnalyticsDeps = {},
): Promise<MirrorAmrEntryAnalyticsResult> {
  return mirrorAmrAnalyticsEvent(buildAmrEntryAnalyticsCommon(payload, deps), payload, deps);
}

export async function mirrorAmrOnboardingProfileAnalytics(
  payload: AmrOnboardingProfileAnalyticsPayload,
  deps: MirrorAmrEntryAnalyticsDeps = {},
): Promise<MirrorAmrEntryAnalyticsResult> {
  return mirrorAmrAnalyticsEvent(
    buildAmrOnboardingProfileAnalyticsCommon(payload, deps),
    payload,
    deps,
  );
}

async function mirrorAmrAnalyticsEvent(
  common: Record<string, unknown>,
  payload: AmrEntryAnalyticsPayload | AmrOnboardingProfileAnalyticsPayload,
  deps: MirrorAmrEntryAnalyticsDeps,
): Promise<MirrorAmrEntryAnalyticsResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) return { mirrored: false };
  const env = deps.env ?? process.env;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AMR_ANALYTICS_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(resolveAmrAnalyticsEventsUrl(env), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        events: [
          {
            common,
            payload,
          },
        ],
      }),
    });
    return { mirrored: response.ok, status: response.status };
  } catch (err) {
    return {
      mirrored: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildAmrEntryAnalyticsCommon(
  payload: AmrEntryAnalyticsPayload,
  deps: MirrorAmrEntryAnalyticsDeps,
) {
  const context = deps.analyticsContext ?? null;
  const anonymousId = context?.deviceId?.trim() || payload.entryId;
  const sessionId = context?.sessionId?.trim() || payload.entryId;
  return {
    eventId: `od-amr-entry-${payload.entryId}`,
    eventTime: payload.entryOccurredAt,
    registryKey: 'open_design_amr_entry',
    eventName: 'amr_entry',
    eventType: 'click',
    platform: 'web',
    env: resolveAmrAnalyticsEnv(deps.env ?? process.env),
    userId: null,
    anonymousId,
    sessionId,
    appVersion: deps.appVersion ?? null,
    locale: context?.locale?.trim() || null,
    timezone: null,
    deviceType: null,
    browser: null,
    os: null,
    arch: null,
    cliVersion: null,
    traceId: payload.entryId,
    walletBalance: null,
  };
}

function buildAmrOnboardingProfileAnalyticsCommon(
  payload: AmrOnboardingProfileAnalyticsPayload,
  deps: MirrorAmrEntryAnalyticsDeps,
) {
  const context = deps.analyticsContext ?? null;
  const anonymousId =
    context?.deviceId?.trim() || payload.odDeviceId || payload.entryId;
  const sessionId = context?.sessionId?.trim() || payload.entryId;
  return {
    eventId: `od-onboarding-profile-${payload.entryId}`,
    eventTime: payload.profileOccurredAt,
    registryKey: 'open_design_onboarding_profile',
    eventName: 'onboarding_profile',
    eventType: 'result',
    platform: 'web',
    env: resolveAmrAnalyticsEnv(deps.env ?? process.env),
    userId: null,
    anonymousId,
    sessionId,
    appVersion: deps.appVersion ?? null,
    locale: context?.locale?.trim() || null,
    timezone: null,
    deviceType: null,
    browser: null,
    os: null,
    arch: null,
    cliVersion: null,
    traceId: payload.entryId,
    walletBalance: null,
  };
}

function resolveAmrAnalyticsEventsUrl(env: NodeJS.ProcessEnv): string {
  return env.OPEN_DESIGN_AMR_ANALYTICS_URL?.trim() || AMR_ANALYTICS_EVENTS_URL;
}

function resolveAmrAnalyticsEnv(env: NodeJS.ProcessEnv): AmrAnalyticsEnv {
  const raw = env.OPEN_DESIGN_AMR_ANALYTICS_ENV?.trim();
  if (raw && AMR_ANALYTICS_ENVS.has(raw as AmrAnalyticsEnv)) {
    return raw as AmrAnalyticsEnv;
  }
  if (env.NODE_ENV === 'production') return 'production';
  if (env.NODE_ENV === 'test') return 'test';
  return 'local';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
