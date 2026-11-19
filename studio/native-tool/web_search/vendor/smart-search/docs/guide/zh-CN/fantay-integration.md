# Fantay 搜索服务接入

本地分支支持通过 JSON CLI 调用整套搜索能力。Fantay 可以为每次调用传入 API 地址、密钥、协议、模型和工具配置，结果继续使用现有 JSON 格式。

## 配置与模型

仓库根目录的 `config.fantay.example.json` 按当前 api.fantay.me 的 Grok 配置提供示例。API Key 留空，由调用方从自己的凭据存储读取并填入。模型 ID、地址和联网工具均可调整。

| 配置项 | 作用 |
| --- | --- |
| `OPENAI_COMPATIBLE_API_URL` | 自定义 API 基础地址，也接受完整 `/responses` 或 `/chat/completions` 地址 |
| `OPENAI_COMPATIBLE_API_KEY` | 对应服务商密钥 |
| `OPENAI_COMPATIBLE_API_MODE` | `responses` 或 `chat-completions` |
| `OPENAI_COMPATIBLE_MODEL` | 服务商支持的任意模型 ID |
| `OPENAI_COMPATIBLE_TOOLS` | Responses 搜索工具，逗号分隔，可用 `web_search`、`web_search_preview`、`x_search` |
| `OPENAI_COMPATIBLE_STREAM` | 上游是否流式返回 |
| `XAI_ENABLED` | 是否允许同时使用已有 xAI 通道 |

`x_search` 需要上游提供 Grok 搜索工具支持。标准网页搜索可配置 `web_search`。`chat-completions` 的工具配置须留空，联网能力由对应上游模型提供。

读取当前已配置服务的模型列表只会请求 `/models`。

```sh
smart-search model list --provider xai-responses --format json
smart-search model list --provider openai-compatible --format json
```

可以保存任意模型 ID，也可以在 `search` 或 `research` 时传 `--model` 临时选择。

```sh
smart-search model set grok-4.20-multi-agent-0309 --provider xai-responses
smart-search model set your-model-id --provider openai-compatible
```

模型列表接口不可用时会返回明确错误，手动设置模型仍可使用。模型列表表示上游公布的 ID，联网能力需由对应工具的真实响应确认。

## 每次调用传入配置

`--config-stdin` 从标准输入读取一个 JSON 对象。对象使用上表和现有配置指南中的大写键，值均为字符串。其优先级高于当前调用的环境变量与已保存配置，作用范围为本次调用。`--config-dir` 指定绝对路径，用于独立配置、活动和健康状态。

Fantay 可以直接启动此源码的 Python 入口。下面的 Node.js 示例使用调用方已有的凭据，API Key 经子进程标准输入传递。

```js
import { spawn } from "node:child_process";
import { join } from "node:path";

const sourceRoot = process.env.SMART_SEARCH_SOURCE_ROOT;
const configDir = process.env.FANTAY_SEARCH_CONFIG_DIR;
const apiKey = process.env.FANTAY_SEARCH_API_KEY;
if (!sourceRoot || !configDir || !apiKey) {
  throw new Error("Configure the source path, profile directory, and API key first.");
}
const settings = {
  XAI_ENABLED: "false",
  OPENAI_COMPATIBLE_ENABLED: "true",
  OPENAI_COMPATIBLE_API_URL: "https://api.fantay.me/v1",
  OPENAI_COMPATIBLE_API_KEY: apiKey,
  OPENAI_COMPATIBLE_API_MODE: "responses",
  OPENAI_COMPATIBLE_MODEL: "grok-4.20-multi-agent-0309",
  OPENAI_COMPATIBLE_TOOLS: "web_search,x_search",
  SMART_SEARCH_INTENT_ROUTER: "local",
};

const { code, output } = await new Promise((resolve, reject) => {
  const child = spawn(join(sourceRoot, ".venv/bin/python"), [
    "-m", "smart_search.cli",
    "--config-dir", configDir,
    "--config-stdin",
    "search", "需要检索的问题",
    "--providers", "openai-compatible",
    "--format", "json",
  ], { cwd: sourceRoot, stdio: ["pipe", "pipe", "inherit"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
  child.once("error", reject);
  child.stdin.once("error", reject);
  child.once("close", code => resolve({ code, output }));
  child.stdin.end(JSON.stringify(settings));
});

// Both successful and failed searches return structured results.
const result = JSON.parse(output);
console.log({ code, result });
```

将命令及参数替换为以下内容即可复用同一调用方式。

| 命令 | 用途 |
| --- | --- |
| `model list --provider openai-compatible` | 读取模型列表供 Fantay 选择 |
| `search <query> --providers openai-compatible` | 单轮模型联网搜索 |
| `research <query> --budget standard` | 多轮研究，按已配置渠道执行 |
| `fetch <url>` | 通过已配置的抓取服务读取网页 |
| `route <query>` | 本地预览可用渠道 |
| `model current` | 读取本次调用的有效模型配置 |

`research` 的多轮判断需要配置 `TYPESAFE_API_KEY`；网页抓取、文档检索等沿用各自服务商配置。调用方可继续传入其他服务商的大写配置键。

保存设置使用现有 `config set` 或设置界面。带 `--config-stdin` 的调用用于查询与执行，配置写入命令会返回参数错误。JSON 标准输出保留 `ok`、`error_type`、来源、引用及部分结果等现有字段。

## 本地验证

此分支的验收覆盖自定义地址、任意模型 ID、Responses 工具、模型列表、独立配置目录、临时配置恢复与错误脱敏。使用本地模拟服务验证请求格式；真实 `/models` 列表检查与真实模型搜索分别验收。

2026-11-14 已通过本机凭据从 api.fantay.me 获取 21 个模型，包含示例中的 Grok 模型。搜索请求通过独立子进程与本地模拟服务验证。真实模型搜索及 Fantay 正式接入安排在后续联调。
