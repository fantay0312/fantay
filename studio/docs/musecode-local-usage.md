# MuseCode 本机会话与用量接入

核查日期：2026-11-14（Asia/Taipei）。对象为本机 Muse Code CLI `1.4.18-R8587.1`。本次接入的是统计和按会话查看，不启动 Muse、继续对话或修改其数据。

## 入口与范围

设置 → AI 用量 → 本机全部 → MuseCode → 明细 → 会话。会话表按最近使用时间排列，可搜索会话 ID、查看请求、导出会话汇总或请求 CSV。汇总覆盖所选日期内的全部记录；单会话明细最多列出最近 1,000 条，并明确提示这一上限。

同一功能通过 `/api/usage?scope=device&provider=muse&sessionId=…` 和 CLI 提供：

```bash
od usage --scope device --provider muse --days 30 --json
od usage --scope device --provider muse --session <session-id> --from 2026-10-16 --to 2026-11-14 --json
```

`sessionId` 必须与 `provider` 同时提供，避免不同工具的相同会话 ID 串账。会话聚合在服务端完整日期范围上进行，不从首页最近 500 条请求反推。单会话查询只刷新所属工具；窄范围扫描缓存不会替代后续全来源扫描。首次打开“本机全部”仍需要读取其他工具的历史。

## 本机证据

| 数据 | 已核查结构与用途 |
| --- | --- |
| `~/.local/share/muse/session-index.db` | `sessions` 表 31 行；有 `session_id`、`session_log_path`、微秒时间、provider/model 和父子关系字段。当前关系字段为空，不能仅靠索引发现子代理。 |
| `~/.local/share/muse/sessions` | 31 个主会话日志及 241 个 `subagent/<id>/session.jsonl`。默认遵循 `XDG_DATA_HOME`。 |
| `~/Library/Application Support/Muse/session-name-authority` | 名称权威表，无 Token/费用字段；统计不依赖它。 |
| `session.peer-history.sqlite3`、`.msp-view-*` | 源记录缓存/投影，不能与源日志重复入账。 |
| `~/.local/share/muse/model-catalog/*.json` | `schema_version=3`、`source=provider_catalog`、`rows[].model_id/cost`。价格是 USD/百万 Token，不是账单。 |

日志的 `recorded_at` 是微秒；`stream.id` 是会话 ID；真正的模型完成事件位于 `payload.event.kind=model_completed`。外层 `retained_frame` 的 `children[].record_json` 需要展开，但不能递归扫描任意 prompt 或 checkpoint 对象。

可复核样例：`sessions/2026/11/03/01a1a165-b9fb-74b0-a6a5-24deb19e94cc/session.jsonl` 第 73–74 行，同一次调用分别写 attribution 和 completion；第 1330 行是子代理转发。其 `subagent/01a1a19f-ccc3-7002-b689-9c0fa5631b4f/session.jsonl` 第 22 行写同一笔用量，但 `usage_id` 不同。

## 核算规则

1. 以明确的 provider attribution 入账，随后 completion 补齐模型；没有 attribution 的 completion 保留为独立记录。工具事件、子代理控制汇总、checkpoint、`summarizer_usage` 不再相加。
2. 主会话的 reminder attribution 不能直接丢弃：许多调用没有持久化子日志。按主会话、reminder owner、Token 特征及同特征出现次数生成稳定键，与子日志转发去重；相同 Token 数值的多次真实调用仍各算一次。
3. 子代理日志计入所在主会话。用于配对的是 owner ID 和来源结构，而不是单凭 Token 数值。取子日志的精确模型补全父转发的未知模型。
4. compaction attribution 单独计入一次；没有模型证据时显示未知，不套用主模型。
5. 当前日志中 cache 是 input 的子集，reasoning 是 output 的子集。账本保存非缓存输入、输出和独立缓存读取；不再次把 reasoning 加入输出。若缓存或 reasoning 超过对应总量，标记格式不支持。
6. `reported=false` 或未提供 Token 的调用不伪造为零 Token 请求；来源显示“部分调用未提供 Token”。本机检测到 6 次此类调用，均有 attribution/completion 两个未报告事件。

## 费用边界

本机源日志未发现实际扣款金额。MuseCode 的渠道报告费用与实际扣费保持未知；显示的估算独立于这两类金额。

本机目录中 `muse-spark-1.3` 的输入/输出/缓存单价分别为 1.25/4.25/0.15 USD/百万 Token。主要调用模型 `muse-wonder-full-1.0` 不在目录中，不能把 `muse-wonder-1.0` 的 4/20/0.2 套给它。未知 reminder 模型也不猜价格。多个本机目录给同一模型不同价格时拒绝估算。

价格按当前本机目录计算，不代表历史成交单价、订阅分摊或应付账单。估算覆盖率由 `estimatedRequests` 表达，缺失价格不算免费。

## 实测结果

日期范围 2026-10-16 至 2026-11-14，Asia/Taipei：

| 指标 | 结果 |
| --- | ---: |
| 范围内参与扫描的源日志 | 262 |
| 有用量的主会话 | 25 |
| 去重后的用量记录 | 6,717 |
| 非缓存输入 Token | 34,902,037 |
| 输出 Token（含 reasoning） | 3,427,305 |
| 缓存读取 Token | 852,961,045 |
| 可估算记录 | 218 |
| 可估算记录价值 | $10.646120 |
| 有实际扣费证据的记录 | 0 |

其中 3,779 条模型为 `muse-wonder-full-1.0`、218 条为 `muse-spark-1.3`、2,720 条未提供可证明的模型身份。空会话及范围外会话不进入用量会话表。

专用临时账本多次实测结果一致，未写 Muse 源数据；读取耗时受同时进行的其他来源扫描影响，不将此轮数据视为性能基准。验证涵盖 retained frame、completion/attribution 配对、相同数值重试、父子转发去重、compaction、未知费用、精确模型价格、会话全量汇总、API/CLI 筛选、CSV 与界面按需读取。项目 `guard`、全项目类型检查及相关单元测试通过。实现位于 `usage-muse.ts`，账本与临时产物遵循项目的 Daemon data directory contract。

桌面开发窗口与真实 CLI 均返回 6,717 条/25 会话；实际打开一个 717 次请求的会话，确认明细独立读取。验证过程中开发预览遇到 Node 堆内存上限及热更新样式丢失，独立验证进程提高堆上限并完整重载后确认样式；未修改全局配置。当前交付为本地源码，未打包、安装、提交或发布。

## 既有决策核对

通过 Nowledge MCP，normal 查询“Fantay 本机 AI 用量 会话 MuseCode Muse”，范围 strict/default。相关命中：第 1 项 `f2a980a7-fbb5-4ce9-a464-c72c3c32bab3`（本机用量的范围/费用边界，0.99）；第 2 项 `fe02fc0d-3a43-4a3d-8c00-7364a3ab9528`（Muse 本机接入路径，0.8914）。本次格式和统计结论均以当前本机文件、源码与测试重新核实。当前未提供可验证同范围权限的图谱入口，因此未展开记忆图谱。
