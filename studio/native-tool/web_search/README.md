# Fantay 原生搜索工具

本模块将完整 Smart Search 0.1.34 引擎接入 Fantay。TypeScript 层负责私有进程、取消、配置传递和统一结果；`vendor/smart-search` 保留完整二开源码。运行环境随模块打包，包含 Python 和依赖。

## 已接入

- 设置 → 模型与提供商 → 搜索服务提供商，覆盖引擎配置和 TokenToSea 连接方式。
- 搜索与研究工具面板由原始命令目录生成，当前包含 31 个工具入口及完整参数。
- 内置聊天及 MCP 提供 `web_search`、`web_fetch`、`smart_search`、`smart_search_catalog`。
- `od search` 与界面复用 daemon API。原有 `od research search` 使用已保存的新搜索配置。
- 凭据由 daemon 保存，界面读取脱敏值，执行时经私有标准输入传递。每次运行的相对输出位于 daemon 分配的独立目录。

## DeepSeek 搜索

新配置默认使用 DeepSeek 的 TokenToSea 账号模式。搜索与网页读取通过 TokenToSea 原生 Search/Fetch 服务执行，沿用当前账号的授权额度、调用回执和 AI 用量记录。主聊天、MCP 与 CLI 的请求绑定到发起调用的账号。

在 DeepSeek 的“连接方式”中选择“自定义 API”，可填写基础地址、Bearer Key，以及可选的完整搜索和网页读取端点。基础地址支持带 `/v1` 或完整 `/v1/tools/search`、`/v1/tools/fetch`。已有自定义配置沿用自定义模式。

TokenToSea 账号凭据保留在 daemon 中。完整引擎只收到本次调用的回环接口和临时访问凭据，因此多轮研究也可复用同一账号授权。

## 自动复用已有服务

其余服务默认选择“自动复用”：先检查当前 TokenToSea 账号支持的 Exa 搜索、Firecrawl 搜索/读取和 Tavily 搜索操作，再使用已有的服务商环境配置。xAI / Grok、OpenAI 兼容接口和 Tavily 还可复用 Fantay 的已有 API 配置。OpenAI 兼容接口仍须选择支持联网的搜索模型，不会沿用图片生成模型。

TokenToSea 工具操作以当前账号的接口检查为准，下架或未开放的操作不会启用。Tavily 的账号通道目前只适配搜索；需要读取、站点地图等操作时使用支持该操作的服务或自定义 API。账号工具沿用报价、授权额度和调用回执，同一次引擎执行中的重复请求复用原任务。停止等待不会撤销已经发生的服务端用量。

已有自定义地址和密钥保持自定义模式，显式关闭的服务保持关闭。在“连接方式”中选择“自定义 API”即可单独设置；切回自动复用时保存的自定义配置仍保留。复用的凭据和临时接口不写入搜索配置文件，设置页只显示连接来源。主聊天、MCP、CLI 和设置页的搜索工具共用此逻辑。

## 开发

```sh
mise x -- pnpm --filter @fantay/native-web-search prepare:engine
mise x -- pnpm --filter @fantay/native-web-search build
mise x -- pnpm --filter @fantay/native-web-search test
```

构建需要 uv 和 Python 3.13.14。可通过 `FANTAY_SEARCH_BUILD_PYTHON` 指向已有构建解释器。`prepare:engine` 使用固定依赖，按当前平台生成自包含引擎，并同步工具和配置目录。改变引擎源码后重新执行此命令。

完整 CLI 位于 `runtime/<platform>-<arch>/smart-search`，Windows 文件名为 `smart-search.exe`。它保留上游 CLI 的全部命令。Fantay 的界面与原生工具通过同一引擎调用搜索、抓取、文档、学术、路由、诊断及多轮研究。

## 来源

源码来自 [Smart Search](https://github.com/konbakuyomu/smartsearch) 的 v0.1.34，含本地自定义模型与配置适配。MIT 原始许可保存在 `LICENSE.smart-search` 和 vendored 源码中。当前本机验证平台为 macOS arm64，其他平台在对应构建机生成运行环境。
