# Built-in agents on pi — 2026-11-09

The TokenToSea agent and the BYOK agent (id `byok`; the OpenCode-era id
`byok-opencode` is still accepted and migrated) run the pi coding agent 1.5.0 (<https://github.com/earendil-works/pi>, MIT) instead of a
bundled OpenCode. A user-installed OpenCode CLI is still a selectable third-party
runtime, as is a user-installed pi (`pi` agent); neither is used by the built-ins.

## Runtime

| Concern | Implementation |
| --- | --- |
| Binary | Official standalone release, pinned with per-platform SHA-256 in `tools/pack/resources/pi-runtime.json`; cached under `.tmp/pi-runtime/` |
| Packaged location | `<resourceRoot>/bin/libexec/pi/` (whole release directory); daemon resolves `OD_RESOURCE_ROOT/bin/libexec/pi/pi` |
| Development | `tools-dev` passes `FANTAY_PI_BIN`; `OPEN_DESIGN_PI_BIN` overrides acquisition |
| Resolution | `resolveBundledPiExecutable` (`apps/daemon/src/runtimes/executables.ts`); PATH is never consulted for the built-ins |
| Protocol | `pi --mode rpc`, prompt through the RPC `prompt` command; adapter `apps/daemon/src/agent-protocol/pi-rpc/` |
| Turn end | `agent_settled`; if it never arrives, 10 s of quiet after a final `agent_end` with no compaction/retry in flight; legacy builds without `willRetry` end on `agent_end` |
| Errors | A failed attempt's error (including exhausted auto-retry) is held until pi settles: a retry or overflow-compaction retry drops it, a final failure reports it (also if pi exits first). Only `compaction_start`/`compaction_end` and auto-retry pause the fallback; summarization retries inside a compaction do not end that pause |
| Interrupted tools | A write/edit whose target path was shown when the message failed or was aborted (even after its block closed) is closed as an error row instead of staying pending |
| Resume | The stored native session must be an existing, non-empty absolute session file; anything else (e.g. an OpenCode id) starts a fresh pi session |
| Live previews | `toolcall_start/delta` → `tool_input_delta`, `tool_input_target`, `tool_input_progress` |
| Plan tool | FantayDesign's pi extension registers `todowrite` (`{ todos }`), rendered as the execution plan |

## Per-run configuration

`prepareBundledPiRunHome` (`apps/daemon/src/runtimes/bundled-pi.ts`) creates
`<data>/agent-runtime/<agent>/<account>/runs/<runId>/agent/` with `models.json`
(one `fantay` provider, one model), `settings.json` (`defaultProjectTrust: never`),
optional `mcp.json` (enabled external MCP servers, `exposure: direct`) and the
extension, all mode 0600. The directory is removed when the run ends; run
directories older than 12 h (a crashed daemon) are swept when the next run of
that agent and account starts. Sessions persist in
`<data>/agent-runtime/<agent>/<account>/sessions/`; the next turn reloads the
session file through RPC `switch_session`.

The API key never reaches disk: `models.json` names `$FANTAY_PI_API_KEY`, and only
the child's environment carries the value. MCP server env values and headers
(including OAuth bearer tokens) are written the same way, as `${FANTAY_PI_MCP_n}`
references whose values only the child receives; this also keeps pi from
running a value that starts with `!` as a shell command. pi's MCP client has no
SSE transport: enabled SSE servers are left out and reported as a
`mcp_transport_unsupported` run diagnostic.

pi starts with `--no-extensions -e builtin:mcp -e <extension> --no-skills
--no-prompt-templates --no-themes --no-context-files --no-approve --offline`, so
project folders cannot inject extensions, skills, settings or `AGENTS.md`/`CLAUDE.md`
instructions, and pi makes no update or catalog requests.

### TokenToSea

The provider points at the daemon's lease-guarded proxy:
`/api/tokentosea/agent/v1` (Chat Completions) or `/api/tokentosea/agent` (the
Anthropic client appends `/v1/messages`; it calls the beta endpoint with
`?beta=true`). The proxy keeps owning model identity, price revision, output
ceilings and reasoning controls; pi is told not to send `reasoning_effort` and to
use `max_tokens`. pi parses `reasoning_content`/`reasoning` deltas and replays them
on later assistant messages; models with interleaved reasoning also get
`requiresReasoningContentOnAssistantMessages`. Claude thinking blocks keep their
signatures across tool turns.

### BYOK

| Protocol | pi API |
| --- | --- |
| `anthropic` | `anthropic-messages`, base URL without the trailing `/v1` |
| `openai` on `api.openai.com` | `openai-responses` |
| other `openai`, `ollama`, `senseaudio`, `aihubmix` | `openai-completions` |
| `google` | `google-generative-ai` |
| `azure` | `azure-openai-responses` on `<resource>/openai/v1` (`AZURE_OPENAI_BASE_URL`/`AZURE_OPENAI_API_VERSION` pinned per run; `v1` unless the provider says `preview`) |

On the Responses APIs pi sends `store: false`; for reasoning families (`gpt-5`
and later except the `-chat` aliases, `o<n>`, `codex*`) the model is declared
reasoning-capable and runs at thinking level `medium` (`high` for `gpt-5-pro`,
which accepts nothing else), so pi requests encrypted reasoning it can replay on
tool turns. For Azure the decision reads the deployment name unless the
provider's **Reasoning model** setting (Settings → BYOK → Azure;
`ByokChatProviderConfig.reasoningModel`; `od run start --byok-reasoning-model
on|off|auto`) says otherwise. The Azure **API version** field keeps feeding the
deployments-route proxy (memory, finalize) with dated versions; pi uses `v1`
unless it is `preview`.
The Settings connection test calls the same endpoint, auth, model and
Responses reasoning fields (`store: false`, effort, encrypted reasoning) a run
uses (Responses for `api.openai.com` and Azure, Chat Completions for other
OpenAI-compatible hosts); a Responses reply that stops at the smoke output budget
while reasoning counts as a pass.
Run-scoped tool bundles with SSE servers are rejected for the built-ins at run
creation.
Inherited `AZURE_OPENAI_*` and `PI_*` session variables are stripped from the
child environment.

An Anthropic-compatible gateway whose path carries a non-`v1` version segment now
receives `<base>/v1/messages`, because the Anthropic client always appends it.

## TokenToSea test origin

Purpose: let a development daemon (and e2e suites) talk to a local TokenToSea
stand-in — fake OAuth/connect plus `apps/share` — instead of the production
hosts. `TokenToSeaIdentity` (`packages/tokentosea`) takes an optional
`endpoints: { issuer?, connectBase?, designBase? }`; omitted fields keep
`TOKENTOSEA_ISSUER`, `TOKENTOSEA_CONNECT_BASE` and `TOKENTOSEA_DESIGN_BASE`.
The package never reads the environment and accepts only HTTPS or loopback
HTTP bases.

Guard: `TokenToSeaRuntime` reads `OD_TOKENTOSEA_TEST_ORIGIN` through
`resolveTokenToSeaTestOrigin` / `tokenToSeaEndpointsFromEnvironment`
(`apps/daemon/src/integrations/tokentosea-endpoints.ts`). The value is used
only when `isPackagedRuntime()` is false and it is a bare `http(s)` origin whose
hostname is `127.0.0.1`, `localhost` or `[::1]`; any other value is ignored
with one `[tokentosea] ignoring …` warning, and an active seam logs one
`[tokentosea] OD_TOKENTOSEA_TEST_ORIGIN active …` line. The packaged launcher
does not forward the variable either. Sessions are bound to the issuer that
minted them, so a persisted production session is never sent to a test origin.

| Endpoint | Production | With `OD_TOKENTOSEA_TEST_ORIGIN=<origin>` |
| --- | --- | --- |
| OAuth issuer (authorize, token, userinfo, jwks, revoke; `iss` checks; user id prefix) | `https://tokentosea.com/api/oauth` | `<origin>/api/oauth` |
| Connect services (`fantay/identity`, models, wallet, tools, official, chat) | `https://tokentosea.com/api/v1/connect` | `<origin>/api/v1/connect` |
| Design service (shares, comments, collaboration, stock search) | `https://design.tokentosea.com/api` | `<origin>/design/api` |

A stand-in serving `apps/share` must route `/design/*` to it with the
`/design` prefix removed, issue `id_token` and callback `iss` equal to
`<origin>/api/oauth`, and answer `fantay/identity` with that issuer.

The e2e stand-in is `e2e/lib/vitest/tokentosea-cloud.ts`, driven through
`suite.with.tokenToSea` (`e2e/lib/vitest/suite.ts`); the collab e2e suite
(`e2e/tests/collab/`) runs on it. The od CLI sends no session cookie: the
daemon runs a loopback request without a cookie or browser headers (Origin,
Referer, Sec-Fetch-Site/Dest; Node fetch's lone `Sec-Fetch-Mode: cors` is
allowed) as the one signed-in TokenToSea account it has seen through a cookie
request, and as signed out when none or several are
(`isLocalCliRequest` / `uniqueSignedInAccount` in
`apps/daemon/src/integrations/tokentosea-runtime.ts`).

## Compatibility

- Conversations whose stored native session is an OpenCode id start a fresh pi
  session; the transcript carries the context.
- BYOK no longer reads the third-party OpenCode CLI environment settings; its
  own `FANTAY_PI_BIN` override is accepted, as for TokenToSea.
- `canonicalAgentId` (contracts) maps `byok-opencode` → `byok` and `amr` →
  `tokentosea` for runtime lookup, OD Next eligibility and prompt composition;
  runs (HTTP and routines) are recorded under the canonical id, so AMR-only
  branches never apply to a TokenToSea run. TokenToSea runs get the managed
  image default `tokentosea/gpt-image-2` (formerly AMR-only) unless the run sets
  its own model;
  saved settings using `byok-opencode` are read under `byok`, and a saved `amr`
  selection (agent and model) under `tokentosea`.
- The retired AMR runtime (Vela CLI wrapping a private OpenCode) is removed from
  the daemon: its runtime definition, model-catalog cache/probe, OpenCode
  companion resolution/env/version probe, Vela child-evidence adapter, image
  staging and the AMR-only branches in `server.ts` and the connection test. It had
  not been selectable since 2026-10-30. Vela collaboration, sharing and billing
  modules are separate and remain.

## Validation (2026-11-09, local)

- Daemon: new `tests/runtimes/bundled-pi.test.ts` (31), the TokenToSea run-lifecycle
  integration test and the BYOK chat-route tests drive the real daemon path with a
  pi stand-in; daemon/contracts/e2e/tools/web typechecks and the full repository
  `pnpm typecheck` pass.
- `e2e/tests/tokentosea-pi.test.ts` (6) runs the pinned pi binary through the real
  lease proxy and RPC adapter against a local upstream: Chat Completions with and
  without reasoning (legacy and official routes, `reasoning_content` replay, write
  tool), live thinking/text before upstream completion, and Claude Messages with
  signed thinking, tool history and the streamed write target.
- Installed macOS build (0.25.1, DMG SHA-256
  `d816344eefe4fa0308ad57e1939dd69e6a681161c60f2b6f7c2f2ffc41d46802`, after the
  settlement/MCP/Azure/reasoning fixes): TokenToSea and BYOK resolve
  `bin/libexec/pi/pi` 1.5.0; no OpenCode runtime is packaged. DeepSeek Flash
  completed a plan + write turn and a resumed edit turn (native session state
  `resumed`) on this build.
- Final installed build (0.25.1, DMG SHA-256
  `168a4efb24b246437b3bb86187dceea94b21f4745e53cdbeb9082536dd566982`, adds the
  Azure reasoning setting, canonical run ids, the TokenToSea image default and
  the connection-test reasoning fields): a BYOK run requested as `byok-opencode`
  was recorded as `byok`, and the packaged pi streamed two Chat Completions
  requests to a local OpenAI-compatible upstream (tools read, bash, edit, write,
  todowrite), wrote the file and succeeded. After a fresh TokenToSea sign-in
  (the previous session had been dropped by a failed token refresh), DeepSeek
  Flash completed a plan + write turn and a resumed edit turn (`resumed`) on
  this build. The Azure reasoning setting is covered by a rendered
  SettingsDialog test (choice shown only for Azure, saved with the Azure
  provider).
- TokenToSea sign-in survives transient token-refresh failures: network
  errors, timeouts, 429/5xx and malformed answers keep the session (the next
  request retries); only a 400/401/403 from the token endpoint ends it
  (`packages/tokentosea`, `TokenToSeaIdentity.refresh`). TokenToSea
  collaboration errors carry the API `errorCode`, so a 410 `SHARE_STOPPED`
  acknowledges the comment outbox instead of retrying forever.
- Final full verification (2026-11-09, after the TokenToSea test origin,
  the fake TokenToSea cloud and the restored collab e2e): daemon 14,403 tests
  (0 fail, 34 skipped); web 15,912 tests at CI-like parallelism (0 fail, 11
  skipped); every other package suite incl. apps/share green; e2e vitest 113
  files / 1,034 pass / 27 environment-gated skips (collab suite runs on the fake
  cloud); `pnpm guard` and `pnpm typecheck` green. Final installed build: DMG
  SHA-256 `8c5441dc7a00be6dfa851ebe02a2c6f23304b10b938ccfda5c7a88a1554ae5dc`
  (the test origin is inert there); DeepSeek Flash write + resumed edit and a
  local BYOK write turn succeeded on it.
- Clean Linux checkout (Docker `node:24-bookworm`, node under
  `/opt/hostedtoolcache` like GitHub's setup-node, `CI=1`): `pnpm install
  --frozen-lockfile` and its postinstall build pass once `packages/tokentosea` is
  a postinstall target (`scripts/postinstall.mjs`, `.github/config/postinstall.json`;
  guarded by the `e2e/tests/scripts/postinstall.test.ts` invariant that every
  dist-backed workspace library a build target imports is itself a target). The
  TokenToSea seam daemon tests (4 files, 22 tests) and the collab/TokenToSea e2e
  subset on the fake cloud (19 files, 38 tests) pass there.
- Daemon: `tests/pi-rpc.test.ts` covers held errors through retry, compaction
  (including summarization retries) and exhausted auto-retry recovered by
  overflow compaction, the settle fallback, and interrupted tool-call retirement;
  `tests/run-tool-bundle.test.ts` covers the SSE rejection.
- Real TokenToSea calls (17 upstream requests, US$0.024 charged): DeepSeek Flash
  completed a plan + write turn and a resumed edit turn; Claude Sonnet 4.6 completed
  a thinking + write + tool-history turn (one empty supplier reply was retried by the
  daemon). Claude Haiku 4.5 (suanlizhixuan) and Claude Fable 5.1 (TokenTide) streams
  ended in TokenToSea `market_usage_needs_review`; a direct service call without pi
  reproduced it, and Fable 5.1 already showed it on 2026-11-05. Those holds
  (US$0.916) were left to TokenToSea review.
