# 本机 AI 用量

设置 → AI 用量可选择「仅 Fantay」或「本机全部」。默认保持仅 Fantay；进入本机全部时才读取外部 Agent 的历史。项目级用量始终限定为该 Fantay 项目。

## 数据范围

| 来源 | 读取内容 |
| --- | --- |
| Fantay | 已保存的对话用量事件、自带密钥生成记录、当前 TokenToSea 账号的服务回执 |
| Claude Code | `CLAUDE_CONFIG_DIR`（默认 `~/.claude`）内的 `projects` JSONL，包括子代理目录 |
| Codex | `CODEX_HOME`（默认 `~/.codex`）内的 `sessions`、`archived_sessions`，JSONL 及 Zstd 归档 |
| Gemini CLI | `~/.gemini/tmp/*/chats/session-*.json` 内的模型消息用量 |
| MuseCode | `XDG_DATA_HOME`（默认 `~/.local/share`）内的 `muse/sessions/**/session.jsonl`，含子代理；详见 [本机核查与核算规则](musecode-local-usage.md) |
| OpenCode | `XDG_DATA_HOME`（默认 `~/.local/share`）内的 `opencode/storage/message` JSON、`opencode/opencode.db` 的 `message` 表 |
| Grok Build | `~/.grok/{sessions,archived_sessions}/…/updates.jsonl`，逐轮、多模型分别读取 |
| Pi / Oh My Pi | `~/.pi/agent/sessions`、`~/.omp/agent/sessions`，支持 Pi 会话目录配置、OMP profiles 与 XDG 数据目录 |
| MCode | `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` 或 `~/.minimax/v2/sqlite/runtime-state.sqlite` |
| DeepSeek Harness | `DSH_HOME` 或 `~/.dsh` 下的 session 版本 JSONL、Zstd 日志 |
| Kimi Code | `KIMI_CODE_HOME` 或 `~/.kimi-code` 下 main / subagent 的 `wire.jsonl`；关联实际模型请求 |
| Copilot CLI | `COPILOT_HOME` 或 `~/.copilot/session-state/…/events.jsonl` 的 `session.usage_record` |
| WorkBuddy / CodeBuddy / WorkBuddy AI | 各自 `projects` JSONL；兼容 rawUsage 和 SDK usage，不把积分当 USD |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain/…/transcript_full.jsonl` 和 CC Switch 管理的 agy 目录 |
| Antigravity IDE / Insiders | 各自 `conversations/*.db` 的明文统计 protobuf，只读 `steps.metadata` 和 `gen_metadata` |
| Devin CLI | `~/.local/share/devin/cli` 下 `sessions.db` 或会话 `log.jsonl` 的调用元数据 |
| ZCode | `~/.zcode/cli/db/db.sqlite`，处理与 OpenCode 不同的缓存和推理计数语义 |
| Qoder / Qoder CN | `QODER_CONFIG_DIR` / `QODERCN_CONFIG_DIR` 或默认配置目录内的 Claude 格式 JSONL |
| Cindy / CindyGlobal / Raft | 系统配置目录内的 Pi 会话、SLOCK_HOME 管理的 `.pi-sessions` / `.builtin-sessions` |
| Cline | `CLINE_SESSION_DATA_DIR` / `CLINE_DATA_DIR` / `CLINE_DIR` 的会话 messages JSON，排除已知 fork 前缀 |
| Factory Droid | `.factory/sessions/*.settings.json` 中的累计用量；明确标记会话汇总 |
| Hermes | `HERMES_HOME` 与 profiles 的 `state.db`，按模型累计用量、辅助任务与未归属主循环余量；标记会话汇总 |
| Alma | 系统配置目录的 `alma/chat_threads.db`；读取独立用量表，排除 incognito 和 cron 会话 |
| Cursor / Cursor Agent | 识别本机配置；这些本地会话库没有可用 Token 统计，显示已识别且暂无本地用量接口 |

以上新增及原有入口合计 29 类（包括地区版和 IDE/CLI 分支），其中 Cursor 是仅识别；工作区同时保留独立接入的 Muse 来源。是否有可读记录取决于安装版本、历史及访问权限，不能把没有记录解读为零消耗。

Claude / Codex 额外发现同级账号目录、单层 profiles 集合，读取 CC Switch 的自定义目录和 Magpie 的 Claude 账号目录。只检查认证文件是否存在，不读取认证内容。OpenCode 支持 `OPENCODE_DB`、V1/V2 表及迁移中尚未转入 V2 的会话；Gemini 同名 JSONL 优先于旧 JSON。

不修改外部日志或配置，不启动 Agent，不发起模型调用。数据库只读打开。缓存与用量账本遵循 [AGENTS.md 的 Daemon data directory contract](../AGENTS.md#daemon-data-directory-contract)。缓存只包含用量元数据，不保存对话内容和凭据。

每个来源最多遍历 50,000 个条目、12 层目录，每次最多解析 1 GiB；单文件或解压内容最多 256 MiB。超过上限、无权限、损坏行或不支持的格式会显示具体原因。再次刷新复用已解析文件缓存，继续读取未缓存内容。显式根目录可解析软链接并去重，不递归跟随内部软链接。

## 去重与归属

- Claude 的同一会话/消息只记一次，合并更完整的输出 Token；补写快照会更新记录。
- Codex 优先使用每次请求的 `last_token_usage`，缺失才计算累计差分；重复累计快照不加一。现代 `token_usage_record` 与对应快照配对，压缩消耗单独保留。
- 无法证明父历史边界的分叉跳过并标记部分记录；没有前页累计基线的续写不把整个历史累计量算成一次新请求。
- 相同原生日志的副本使用稳定身份入账。重复读取、刷新和归档副本不累加。
- Gemini JSONL 合并同 ID 用量快照。统计的是已发生的消耗，撤回和内容补丁不会抵消此前调用花费；与只展示当前对话分支的浏览器不同。
- 只有累计数的来源不会伪造逐请求记录或时间。Droid / Hermes 标为会话汇总，已知调用次数单列；未知请求数不补成 1。累计消耗按最近记录时间归档，不代表当天新增消费。
- 已在 Fantay `agent_sessions` 或历史状态事件中记录的同一原生会话，以 Fantay 自身账本为准，避免应用记录与原生日志双算。目前该原生会话若后来在外部继续使用，外部追加部分也会排除；因此本机全部不是服务商审计账单。

## 费用口径

实际扣费、渠道报告和估算是三个独立字段。统计图的费用继续使用前两类；估算在独立金额、明细、CSV 和小票中展示。没有价格的记录仍为未知，不能解读为免费。

估算按 [models.dev](https://models.dev/) 公开目录的精确模型 ID、每百万输入/输出/缓存价格计算；价格表每天最多拉取一次，失败可读本地缓存。下载价格表不携带用量、会话或账号数据。未识别模型、缺失缓存价、1 小时缓存写入、阶梯或上下文相关价格暂不估算。订阅费用、税费、优惠与历史成交单价不在估算范围内。

## CLI

```bash
od usage --scope fantay --days 30 --json
od usage --scope device --from 2026-11-01 --to 2026-11-14 --json
```

两者都读取 `/api/usage`；`scope=device` 不接受 `projectId`，不会把外部记录混入项目账单。

## 参考实现

仅参考数据格式和去重策略，没有引入对方程序或复制其实现：

- [Magpie 用量与费用逻辑（ab4b1cf）](https://github.com/yetone/magpie/blob/ab4b1cf38f3483ab3f6474fd38bc56c9fb4af604/internal/usage/usage.go)
- [CC Switch 会话用量同步（8c76bfe）](https://github.com/farion1231/cc-switch/blob/8c76bfe1e2628fe385b2c009020036d85510b01d/src-tauri/src/services/session_usage.rs)
- [CC Switch Codex 记录格式](https://github.com/farion1231/cc-switch/blob/8c76bfe1e2628fe385b2c009020036d85510b01d/src-tauri/src/services/session_usage_codex.rs)
