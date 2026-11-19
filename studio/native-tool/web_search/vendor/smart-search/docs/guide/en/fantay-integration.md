# Fantay search integration

The local branch exposes the existing search engine through its JSON CLI. Each invocation can supply a custom API endpoint, credentials, protocol, model ID, and search tools. See the [Chinese integration guide](../zh-CN/fantay-integration.md) for a complete Node.js subprocess example.

## Endpoint and model configuration

`config.fantay.example.json` contains an example for `https://api.fantay.me/v1` and `grok-4.20-multi-agent-0309`. The caller supplies the API key from its credential store.

- `OPENAI_COMPATIBLE_API_URL` accepts a base URL or a complete Responses / Chat Completions endpoint.
- `OPENAI_COMPATIBLE_API_MODE` selects `responses` or `chat-completions`.
- `OPENAI_COMPATIBLE_MODEL` accepts a custom model ID.
- `OPENAI_COMPATIBLE_TOOLS` accepts a comma-separated list of `web_search`, `web_search_preview`, and `x_search` in Responses mode. The upstream must implement the selected tools.
- `OPENAI_COMPATIBLE_STREAM` controls streaming to the upstream.
- `XAI_ENABLED=false` selects an OpenAI-compatible configuration while keeping existing xAI credentials in their original profile.

```sh
smart-search model list --provider openai-compatible --format json
smart-search model set your-model-id --provider openai-compatible
```

Model discovery calls the provider's `/models` endpoint. A custom model can also be entered manually or passed with `--model` for one search.

## Per-invocation configuration

Pass `--config-dir /absolute/profile/path --config-stdin` before the query command. Write one JSON object containing supported uppercase configuration keys and string values to stdin, then close stdin. Overrides take precedence for that invocation. The selected profile stores activity and health state.

The same mechanism supports `search`, `research`, `fetch`, `map`, `route`, `model current`, and `model list`. It also accepts the existing provider-specific configuration keys. Research judgment requires TypeSafe configuration, and fetch requires a supported page-reading provider.

Use the existing configuration commands to save settings. `--config-stdin` is intended for queries and rejects configuration-writing commands. Results retain the existing JSON fields, including `ok`, `error_type`, sources, citations, and partial results.

The local tests cover custom endpoints and models, Responses tools, inventory discovery, credential redaction, and isolated configuration. Model discovery and real model searches are verified separately.
