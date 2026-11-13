import type { WorkspaceCollabContext } from '@open-design/contracts';
import { readVelaControlApiContext } from '../integrations/vela.js';
import { mapVelaWorkspaceContext } from './vela-workspace-context.js';
import { optionalTokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';

// Daemon half of the desktop invite hand-off ("桌面唤起和本地恢复", C's lane in
// the B-C invite contract). The desktop app receives an
// `opendesign://workspace/invite/continue?...&nonce=...` deeplink, parses it, and
// forwards the nonce here. The daemon proves identity with the SAME signed-in vela
// session (never a client-supplied one) and consumes the one-time continuation on
// B, which finalizes the membership and returns the current workspace context so
// the client can switch into the team workspace. Any failure degrades to a typed
// outcome the route maps onto HTTP — it never throws into the caller.

const DEFAULT_TIMEOUT_MS = 8_000;

function consumePath(nonce: string): string {
  return `/api/v1/workspace-invites/continuations/${encodeURIComponent(nonce)}/consume`;
}

export type InviteContinueOutcome =
  | { ok: true; context: WorkspaceCollabContext | null; workspaceMemberId: string }
  | { ok: false; status: number; error: string };

export interface ConsumeInviteContinuationOptions {
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Injectable for tests; defaults to reading ~/.amr / env. */
  readSession?: typeof readVelaControlApiContext;
  /** Settings-backed AMR environment selected by the desktop app. */
  configuredEnv?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Consume an invite continuation nonce, returning the mapped workspace context
 * on success. Errors are typed, not thrown.
 *
 * With a TokenToSea runtime the nonce is a collaboration invitation token,
 * accepted (`invitation.accept`, then `workspace.get`) as the request's
 * signed-in TokenToSea account. Every failure answers
 * `continuation_unreachable` with the upstream HTTP status when the failure
 * carries one (401 when signed out, or the collaboration service's own status,
 * e.g. an expired or already used invitation) and 502 otherwise, such as on a
 * transport failure.
 *
 * Otherwise the nonce is consumed against B using the local vela session:
 * `no_session` (401) when the client is not signed in, `continuation_<n>` for
 * B's 401/403/409/410 (subject mismatch / already consumed / expired), and
 * `continuation_unreachable` (502) on a transport failure.
 */
export async function consumeInviteContinuation(
  nonce: string,
  options: ConsumeInviteContinuationOptions = {},
): Promise<InviteContinueOutcome> {
  const runtime = optionalTokenToSeaRuntime();
  if (runtime) {
    try {
      const joined = await runtime.collaboration<{ workspaceId: string }>({ operation: 'invitation.accept', token: nonce });
      const wire = await runtime.collaboration<{ workspaceMemberId: string }>({ operation: 'workspace.get', workspaceId: joined.workspaceId });
      runtime.rememberWorkspace(joined.workspaceId);
      return { ok: true, context: mapVelaWorkspaceContext(wire), workspaceMemberId: wire.workspaceMemberId };
    } catch (error) { return { ok: false, status: (error as { status?: number }).status ?? 502, error: 'continuation_unreachable' }; }
  }
  const fetchImpl = options.fetch ?? fetch;
  const readSession = options.readSession ?? readVelaControlApiContext;
  const trimmed = nonce.trim();
  if (!trimmed) return { ok: false, status: 400, error: 'missing_nonce' };

  const configuredEnv = options.configuredEnv ?? {};
  const session = readSession(process.env, configuredEnv);
  if (!session || !session.controlKey || !session.apiUrl) {
    return { ok: false, status: 401, error: 'no_session' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(new URL(consumePath(trimmed), session.apiUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${session.controlKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `continuation_${response.status}` };
    }
    const body = (await response.json()) as {
      workspaceMemberId?: unknown;
      currentWorkspaceContext?: unknown;
    };
    return {
      ok: true,
      context: mapVelaWorkspaceContext(body.currentWorkspaceContext, configuredEnv),
      workspaceMemberId: typeof body.workspaceMemberId === 'string' ? body.workspaceMemberId : '',
    };
  } catch {
    return { ok: false, status: 502, error: 'continuation_unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}
