# 本机 CLI 更新 · 2026-11-03

设置 → 模型与提供商 → 本机 CLI 现在可检查新版、逐项更新和全部更新。状态放在各 CLI 原有卡片内；模型、推理强度、启用开关以及 Claude 的 TUI / print 设置不变。进入该区域会发起带缓存的版本检查；点击“检查更新”强制刷新。更新必须由用户点击发起。

## 参考研究

本次阅读固定到以下提交，结论来自源码；没有对上游运行安装器，也不代表完整安全审计。

| 项目 | 采用的机制 | 未照搬的机制 |
| --- | --- | --- |
| [Magpie `a3768cd`](https://github.com/yetone/magpie/blob/a3768cdd1113118998863ed36bd6dd77c8e9e2cc/internal/agent/cliupdate.go) | 解析实际安装来源；npm 固定原 prefix；使用厂商自更新；更新后重新探测；批量串行 | 最新版查询失败时不能因没有 update 标记就显示最新；不能只凭进程退出成功判断可用；不将更新器原始输出直接送到界面 |
| [CC Switch `7afceec`](https://github.com/farion1231/cc-switch/blob/7afceec14b977ecc2f4373e8ffb40e7223b435ac/src-tauri/src/commands/misc.rs) | 后端持有安装锁；执行前重新解析安装；检查来源与更新来源一致；页面关闭不释放后台任务 | 不接收或拼接前端 shell 命令；不自动改换安装方式；不先卸载再修复；不把应用自身的 Tauri 更新器当成 CLI 更新能力 |

进一步证据：

- Magpie [来源判定与 npm prefix](https://github.com/yetone/magpie/blob/a3768cdd1113118998863ed36bd6dd77c8e9e2cc/internal/agent/cliupdate.go#L253-L425)、[更新与事后验证](https://github.com/yetone/magpie/blob/a3768cdd1113118998863ed36bd6dd77c8e9e2cc/internal/agent/cliupdate.go#L991-L1147)。
- CC Switch [后端锁](https://github.com/farion1231/cc-switch/blob/7afceec14b977ecc2f4373e8ffb40e7223b435ac/src-tauri/src/commands/misc.rs#L240-L403)、[原安装器选择](https://github.com/farion1231/cc-switch/blob/7afceec14b977ecc2f4373e8ffb40e7223b435ac/src-tauri/src/commands/misc.rs#L4007-L4258)、[UI 验证与恢复状态](https://github.com/farion1231/cc-switch/blob/7afceec14b977ecc2f4373e8ffb40e7223b435ac/src/components/apps/useToolManagement.ts#L659-L808)。
- 官方命令：[Claude `update` 和更新通道](https://code.claude.com/docs/en/setup#update-claude-code)、[Cursor CLI 更新](https://cursor.com/docs/cli/installation#updates)、[Antigravity 更新说明](https://antigravity.google/docs/cli/commands/changelog)。Cursor 安装脚本、Claude 通道指针和 Antigravity 平台清单只作元数据读取，不下载后执行脚本。

## 实现边界

- 原生安装的 Claude、Cursor Agent、Grok Build、Antigravity，以及识别出的 Codex/OpenCode 原生安装使用各自更新命令。Claude 读取原有 latest/stable 通道；Grok 通过 `update --check --json` 遵循原通道。npm 使用确切目标版本、原安装 prefix 与对应 Node 搜索路径；Homebrew 使用拥有该二进制的 formula/cask。
- 桌面应用包内的 CLI、项目依赖、来源不明的程序或暂未接入的包管理器不自动修改，显示原应用/官方更新入口。没有执行初次安装、切换安装方式、修改登录、密钥、模型或权限配置。
- 查询成功缓存 6 小时，查询失败 5 分钟；手动检查跳过缓存。单项失败不清空其他结果；未知/不可比较版本不显示“已是最新”。版本支持 SemVer 预发布和日期构建；同日不同 hash 不擅自判断先后。
- 一个 daemon 内所有更新串行，重复请求返回忙碌。任务状态保存在 daemon，关闭设置页或重新进入仍可继续查看；不宣称跨 daemon 重启恢复。运行中的 FantayDesign Agent 任务会阻止该 CLI 更新，排队的更新也会阻止该 CLI 开始新任务。
- 更新调用固定 argv；本地请求校验和服务端 ID 白名单保护写操作。更新超时 10 分钟，限制输出量，POSIX 整组终止子进程；更新器输出不进入 UI。Windows 的进程树终止实现未在本机运行验收。
- 更新后再次执行真实版本探测；只有可运行且达到目标版本才显示完成。退出码为 0 但版本没变，保留失败状态供重查/重试。

## API 与 CLI

```text
GET  /api/agents/updates
POST /api/agents/updates/check  { "force": true }
POST /api/agents/updates        { "agentIds": ["claude"] }

od agent updates --check --wait --json
od agent update claude --wait --json
od agent update all --wait --json
```

检查与更新接口立即返回快照，由后端继续执行。CLI 不传 `--wait` 时可用 `od agent updates --json` 查询进度。新 UI 文案已覆盖全部 19 个现有语言字典。

## 验证记录

- 17 项后端定向测试：SemVer/日期排序、npm 原 prefix 与实际 argv 执行、Homebrew 所有权、应用包保护、清单读取、检查失败、并发去重、串行更新、版本未变、目标改变、活动任务竞争、请求来源、CLI 失败退出和真实子进程树超时终止。
- 4 项 UI 定向测试：进入时检查、单项更新参数、失败状态、轮询完成和原应用入口。全项目类型检查与仓库 guard 通过；未运行全套测试。
- Electron 隔离实例实际读取 7 个本机 CLI。检查时 Claude 2.1.316、Codex 0.166.0、Grok 1.0.70、Cursor 2026.10.22-27dcf5f、Antigravity 1.4.12 与来源一致；OpenCode 1.18.18 → 1.19.5、DeepSeek Harness 0.2.1-rc.3 → rc.5 提示新版，并保留安装来源边界。它们是当时查询结果，不是永久版本常量。
- 桌面测试数据验证“有更新 → 更新中 → 完成”，实际请求仅发送 CLI ID；恢复真实接口后重新查询。没有为验证而更新用户的 CLI，没有付费模型调用。
- 本地证据在 `.tmp/cli-updater-research/`：`settings-live.png` 为真实结果，名称带 `fixture` 的截图和 `ui-flow.json` 为合成状态；二者不得混作真实升级证据。

## 本机交付

已在 2026-11-03 01:23（Asia/Taipei）更新 `/Applications/FantayDesign.app`，保留现有应用身份与版本号 `0.25.1`。安装包 SHA-256 为 `d3b86c48ae9388649e64c361707996c9e87e6b01342e504bf8fab2ac0738d4ca`。源码未提交、推送或发布。

安装版真实完成六个外部 CLI 的查询，设置页只有一个“检查更新”入口，保留原来选中的 Codex。开发环境中的 OpenCode 来自项目依赖，安装版没有将其误报为用户安装的外部 CLI。`installed.png` 与 `installed-verification.json` 记录安装版验证；本机检查没有执行实际 CLI 升级。

安装前创建完整备份。安装前后 7 个项目及其 ID、2 个登录会话、身份文件、应用配置、外观和 2 个原生工程摘要一致；数据库仅插件目录的 `refreshed_at` 发生正常启动刷新。比较证据为 `data-comparison.json`、`marketplace-comparison.json`。临时验证实例已停止。
