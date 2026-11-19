import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveDaemonUrl } from "../daemon-url.js";

const HELP = `Usage: od search <providers|configure|models|commands|query|fetch|execute> [options]
  providers                         Show masked provider settings
  configure --config-file <path|->  Save the same configuration used by Settings
  models --provider <id>            Read available model IDs
  commands                          List every Smart Search command and argument
  query --query <text>               Run native web search
  query --prompt-file <path|->       Read a long query from a file or stdin
  fetch --url <url>                  Read a web page
  execute --command <id> --arguments-file <path|->  Run a complete engine command
Optional: --provider <id> --max-results <1-20> --daemon-url <url> --json`;

export async function runSearchServiceCli(args: string[]): Promise<void> {
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        "daemon-url": { type: "string" },
        provider: { type: "string" },
        query: { type: "string" },
        "prompt-file": { type: "string" },
        url: { type: "string" },
        "max-results": { type: "string" },
        "config-file": { type: "string" },
        command: { type: "string" },
        "arguments-file": { type: "string" },
      },
    });
    const { values, positionals } = parsed;
    const sub = positionals[0];
    if (values.help || !sub) {
      console.log(HELP);
      return;
    }
    const root = (
      await resolveDaemonUrl({ flagUrl: values["daemon-url"] ?? null })
    ).replace(/\/$/, "");
    const readInput = (file: string) =>
      readFileSync(file === "-" ? 0 : file, "utf8");
    const readJson = (file: string): unknown => {
      const content = readInput(file);
      try { return JSON.parse(content) as unknown; }
      catch { throw new Error('The input file must contain valid JSON.'); }
    };
    let route = "";
    let method = "GET";
    let body: unknown;
    switch (sub) {
      case "providers":
        route = "providers";
        break;
      case "commands":
        route = "catalog";
        break;
      case "configure":
        if (!values["config-file"])
          throw new Error("--config-file is required");
        route = "config";
        method = "PUT";
        body = readJson(values["config-file"]);
        break;
      case "models":
        if (!values.provider) throw new Error("--provider is required");
        route = `providers/${encodeURIComponent(values.provider)}/models`;
        method = "POST";
        body = {};
        break;
      case "query": {
        const query = values["prompt-file"]
          ? readInput(values["prompt-file"])
          : values.query;
        if (!query?.trim())
          throw new Error("--query or --prompt-file is required");
        route = "search";
        method = "POST";
        body = {
          query,
          ...(values.provider ? { provider: values.provider } : {}),
          ...(values["max-results"]
            ? { maxResults: Number(values["max-results"]) }
            : {}),
        };
        break;
      }
      case "fetch":
        if (!values.url) throw new Error("--url is required");
        route = "fetch";
        method = "POST";
        body = {
          url: values.url,
          ...(values.provider ? { provider: values.provider } : {}),
        };
        break;
      case "execute":
        if (!values.command) throw new Error("--command is required");
        route = "execute";
        method = "POST";
        body = {
          command: values.command,
          arguments: values["arguments-file"]
            ? readJson(values["arguments-file"])
            : [],
        };
        break;
      default:
        throw new Error(`Unknown search command: ${sub}`);
    }
    const response = await fetch(`${root}/api/search/${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(process.env.OD_TOOL_TOKEN ? { authorization: `Bearer ${process.env.OD_TOOL_TOKEN}` } : {}),
      },
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
          }),
    });
    const payload: unknown = await response.json();
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Search command failed",
    );
    process.exitCode = 2;
  }
}
