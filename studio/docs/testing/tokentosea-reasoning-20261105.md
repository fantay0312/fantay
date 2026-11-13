# TokenToSea reasoning acceptance — 2026-11-05

The initial catalogue contained 407 records, 230 chat records and 213 desktop-agent candidates. The paid audit covered 726 displayed choices, with bounded corrective retries. Full case/receipt evidence lives in `.tmp/tokentosea-reasoning-audit-20261105/`; the independent public catalogue and review fixtures live under `apps/daemon/tests/fixtures/tokentosea-reasoning-*`.

## Capability and identity boundaries

- Native model effort, thinking toggles, manual token budgets, between-tools mode and fixed thinking are different controls. TokenToSea exposes named choices rather than one speed/quality slider. An unknown contract does not mean the model has no thinking.
- Claude requires verified native Messages SSE for signed thinking/tool history. The three unverified Chat-only Claude converters are excluded from the desktop agent until their mapping is implemented and verified.
- TokenTide aliases `claude-opus-4-6`, `claude-opus-4-8` and `claude-opus-5` returned an Opus 5.5-only adaptive-thinking restriction. They remain in the service catalogue but are quarantined from desktop-agent selection pending identity verification. Matching a response's self-reported model field is not proof of authentic weights.
- Four older StepAudio chat/voice models, AutoGLM-Phone and the two GLM-4.1V-Thinking variants did not return the standard tool_calls contract required by this agent. They require dedicated adapters. StepAudio 3 Chat's working text/tool route remains eligible.
- Fourteen exact relay routes still returned public reasoning after both native disabled and compatible none requests. Their ineffective off choice is withheld; seven MiMo routes expose an explicit read-only on choice. The public evidence fixture is `tokentosea-relay-off-evidence-20261105.json`. This restriction applies to the tested route, not every model in the family. Restore off only after a new completed, settled off request returns no reasoning/signature or contradictory usage.
- The dated qwen-plus-2025-04-28 endpoint refused the 16K budget preset with both output-field projections. Its verified toggle and 1K/4K presets remain; the failed preset is withheld until its exact budget/output contract is verified.

## Request projection

The service-declared combined `max_completion_tokens` ceiling takes precedence over a generic family fallback. Native Messages always retains `max_tokens`. Ignoring the declared combined field caused Qwen thinking requests to reserve the model's much larger output bound. Budget presets should keep the selected budget while giving the response a bounded allowance; testing a 1,024-token budget does not require requesting the entire 131,072-token output capacity.

The selected route/choice owns the lease. Stale or forged reasoning fields are removed before projecting the chosen protocol. Generated catalogue examples cannot establish additional effort enums. Supplier IDs are retained until the gateway's reviewed upstream mapping. Supported Qwen and MiMo routes preserve reasoning_content across tool rounds through the same interleaved-history configuration as the other compatible reasoning providers.

## Streaming and billing

A real message_stop or DONE ends the local stream even if the relay leaves HTTP open. After idle output, a read-only receipt watch reports authoritative needs_review/failed states through a non-retryable protocol error. It does not synthesize success, regenerate inference, settle a disputed bill or release its reservation.

Some TokenTide Claude receipts contain complete native terminal frames and usage but only an aggregate cache-write count. The five-minute and one-hour rates differ. Missing TTL quantities cannot be guessed or charged as a selected TTL. Such receipts remain needs_review.

The paid harness keeps exact integer microdollar accounting. Actual charges plus each unresolved request's full authorized ceiling stay at or below US$10; each request stays at or below US$1. Prepared-but-refused budget tests are confirmed unexecuted before retry. Previously billed QA in other tasks is not included in this audit budget. No ledger rows, prices, permissions or old unresolved bills were manually changed.

## Evidence and limitations

`live-report.json`, `live-case-results.csv`, `live-model-results.csv` and `真实验收报告.md` distinguish current picker choices, protocol acceptance, control contradictions, supplier failures and unknown model contracts. HTTP 200 alone is insufficient: the harness checks structured tool arguments, the real terminal protocol and settlement. These tests do not establish different reasoning quality from a simple arithmetic tool task.

Primary control references: [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Claude thinking modes](https://platform.claude.com/docs/en/build-with-claude/thinking), [Qwen thinking](https://help.aliyun.com/zh/model-studio/deep-thinking), [Qwen function calling](https://help.aliyun.com/zh/model-studio/qwen-function-calling). Dedicated adapter references: [AutoGLM-Phone](https://docs.bigmodel.cn/cn/guide/models/vlm/autoglm-phone), [GLM-4.1V-Thinking](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.1v-thinking), [StepAudio](https://platform.stepfun.com/docs/zh/guides/models/audio).
