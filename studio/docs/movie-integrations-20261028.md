# Claude Code / DeepSeek Harness 实际制作验收

日期：2026-10-28，Asia/Taipei。

## 约定和结果

用户先要求接入 Claude 桌面端与 DeepSeek Harness，随后明确要求不操作 Claude App。本次遵守后一个约束：没有修改它的连接配置，没有重启它，没有在里面发送消息。提供的 Claude MCP 配置仍可由用户自行导入；桌面内嵌效果没有被宣称完成验收。

已经完成的是真实模型执行，不是用模拟回复替代：

| 路径 | 一句话打开 | 风格到交付 | 结果 |
| --- | --- | --- | --- |
| Claude Code → Movie MCP | 输入“打开动画工作台”，实际调用 `open_movie_studio` | 16 次工作台工具调用，查询风格、创建影片、修改分镜、固化风格、确认样张、渲染等待、批注、审片、交付 | 成功；6 秒、1920×1080、H.264 |
| DeepSeek Harness → Fantay → Movie CLI | 相同一句话，实际调用 `movie open`，返回浏览器工作台链接 | 14 次有结果的工具调用，完成同样的制作流程 | 成功；6 秒、1920×1080、H.264 |
| Fantay 网页首页 | 在真实输入框输入相同一句话并运行 | 页面进入 `/movies` | 成功 |

两个项目的服务端状态都验证了：3 个镜头、总长 6 秒、预期风格、风格快照已保存、渲染 done、当前版本已通过测试审片、批注已解决、交付已准备。两份 MP4 和 ZIP 均已实际下载，MP4 用 ffprobe 验证。批注明确标记为技术验收，不代表用户创意签收。

- Claude 项目：`1ebc33a2-59cc-4b33-951d-19c1cc79e324`，蓝图叙事。
- DeepSeek 项目：`1ec580ca-17ed-47a9-a636-30be480b7223`，纸上电影。

## Harness 修复

本机已经安装官方原生 Harness 0.2.1-rc.3；之前不可用是因为 CLI 不在搜索路径、没有 `open-design` profile，而且旧适配器只覆盖 0.1 版本族。

本次新增 macOS app-bundle CLI 发现，版本支持精确包含已测的 0.2.1-rc.3；没有泛化允许未测的 0.2 版本。连接组件升级为 0.1.2，复用 Harness 自己的 home 和凭据，并修复：

- 新版提供商日志占用 stdout，导致严格模型目录解析失败；现在日志进入 stderr，stdout 只保留协议帧。
- 新版 tool-role 结果与旧版嵌套结果结构不同；两者均可生成工具结果事件。
- 新版不再提供旧 assistant/chunk 事件；从持久助手消息补齐正文，避免误报“没有输出”，也避免重复已有流式正文。
- 已能 probe 的旧连接组件不能一直跳过升级；setup 现在验证实际组件版本。

安装前保存了 Harness 凭据的仅本人可读备份。完整实测后原凭据内容与备份逐字节一致；没有把密钥复制到 Fantay 配置或日志。

## 证据

工作区 `.tmp/movie-integrations/`：

- `claude-open.jsonl`、`claude-film.jsonl`、`claude-delivery-read.jsonl`。
- `dsh-open-v012.jsonl`、`dsh-film.jsonl`、`dsh-setup-v012.json`。
- `live-results.json`、`acceptance.json`。
- `claude-film.mp4`、`claude-film-delivery.zip`、`deepseek-film.mp4`、`deepseek-film-delivery.zip`。
- `provider-list.png`、`one-sentence-open.png`、`deepseek-workspace.png`。
- `dsh-tests.log`、`daemon-tests.log`、`cli-links-test.log`、`dsh-typecheck.log`、`daemon-typecheck-final.log`、`guard.log`。最终 daemon 类型检查文件退出码为 0；早期 `daemon-typecheck.log` 保留了一次随后修复的测试类型错误，不作为最终通过证据。

测试与检查均针对改动范围，没有运行全量 daemon/web 测试。本次没有提交、推送或部署。

## 首页模式后续验证与 Claude 使用边界

首页模式后续新增轻量 MCP 视图。实际 MCP stdio 客户端已验证 8 个工具、`get_movie_task` 上下文、`/create/animation` 外链及 `/movie-app` 嵌入资源，均共享同一项目文件。

2026-10-28 查询的 Anthropic 官方资料区分两种使用：

- [`claude -p` 非交互调用](https://code.claude.com/docs/en/headless)是官方提供的能力。
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) 允许在相关商业条款条件下运行未经修改的 Claude Code，并允许用户自行登录自己的订阅；同时禁止第三方收集、中转 Claude.ai 登录凭据、代用户转用订阅请求或转售用量。开发产品时需遵循其中的 API/支持云平台及商业条款要求，不能把“调用成功”视为合规认证。

本轮网页调用沿用现有 Claude Code CLI 适配器，使用 `-p`、JSON 流输入输出、`--permission-mode bypassPermissions`。后者是本地文件/工具执行权限边界，不是官方授权或免风控保证。本轮一次 Claude Code 请求停在等待响应，随后明确取消，未据此判断封号；后续影片生成与修改测试使用 DeepSeek Harness。未操作 Claude App，未提取或转用 Claude 登录 token，也未修改其认证方式。
