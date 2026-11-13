# @open-design/dsh-runtime

Profile bundle that lets OpenDesign drive a user-installed DeepSeek Harness
through a strict JSONL stdio protocol. It does not ship the `dsh` executable,
Node.js, credentials, or provider configuration.

Install DeepSeek Harness first. Packaged OpenDesign builds carry an exact,
integrity-checked tarball of this component. When the DeepSeek Harness card
reports that the connection component is required, selecting the card asks for
confirmation and then invokes the user's own `dsh` to install that tarball into
the `open-design` profile. OpenDesign does not download or install `dsh`.

Repository developers can perform the equivalent operation manually:

```sh
pnpm --filter @open-design/dsh-runtime build
pnpm -C packages/dsh-runtime pack --pack-destination <temporary-directory>
dsh plugin --profile open-design add <temporary-directory>/open-design-dsh-runtime-0.1.2.tgz
dsh --profile open-design --probe
dsh --profile open-design --models
```

The daemon and `od agent setup deepseek-harness --json` use the same setup
endpoint as the UI. Setup is always explicit on the first incompatible
selection; cancelling does not select the agent or mutate the Harness profile.

The probe prints exactly one JSON object. OpenDesign starts one short-lived
`dsh --profile open-design --stdio` process per run; Harness session storage
provides cold resume across later processes.

The native macOS Harness 0.2.1-rc.3 CLI is also supported. The daemon discovers
the executable bundled inside the installed app when it is absent from PATH.
The profile uses the Harness-owned credential store. Version 0.1.2 of this
adapter routes provider notices to stderr, handles both legacy nested and 0.2
tool-role results, and derives visible text from durable assistant messages
when the runtime does not emit legacy assistant/chunk events. It does not
duplicate already streamed text or expose reasoning as the final answer.
Companion setup repairs an older adapter even when its protocol probe still
succeeds; it verifies the installed adapter version against the bundle.

The models command prints the provider-qualified catalog assembled by the
user's Harness profile. OpenDesign refreshes this read-only catalog during
agent detection; credentials and secret values are never included.
