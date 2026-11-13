# 剪映草稿接入 FantayDesign

2026-11-03。已在 `studio` 主工作区接入草稿创建、保留原稿的修改、版本检测和内置 skill。剪映保持现有版本，接入没有安装或更新剪映。后续实际安装核对确认：`/Applications/FantayDesign.app` 已于当日 11:28（Asia/Taipei）更新，版本为 0.25.1，当前安装包包含本次剪映集成；早期“仅开发版、未覆盖安装版”的记录已过时。本次核对没有重复覆盖已更新的应用，未提交、推送或发布。

## 用户入口

打开项目里的视频剪辑器，在右上角“更多操作”选择：

- **创建剪映草稿**：从当前已保存时间线创建，检查 revision，复制原始素材，保留多轨位置、源入点、时长、固定倍速、音量、静态变换及字幕时间。生成后可添加到剪映首页。
- **修改剪映草稿副本**：选择当前项目或本机剪映库中的草稿，读取片段后修改字幕、音量、倍速、裁切、切分、位置、缩放、素材，或添加文字/媒体。每次保存都是新副本；连续修改自动接续最新副本。

弹窗显示安装与版本状态。未验收版本需要用户明确同意按基础格式生成；不自动适配为“已验证”，不安装或更新客户端。添加到剪映首页前要求客户端退出，登记册保留备份。

裁切、调色、关键帧、内嵌音频淡入淡出等尚不能保真转换的当前时间线内容会明确拒绝，不静默丢弃。文字与字幕使用可编辑的剪映默认样式，返回相应提示。复杂草稿的有歧义时间变更仍受原模块的保护规则限制。

## 平台与版本边界

| 能力 | macOS | Windows |
| --- | --- | --- |
| 安装位置、版本、运行状态检测 | 已接入，本机 11.6.0 实测 | 已接入，含默认目录和显式路径，完成模拟平台测试 |
| 从计划/当前基础时间线创建 | 共用引擎，本机实测 | 共用引擎和打包媒体探测器；桌面往返待 Windows 实机验证 |
| 修改明文草稿为新副本 | 已接入并测试 | 共用文件引擎；桌面往返待实机验证 |
| 客户端保存后的加密草稿 | 11.6.0 / Apple Silicon 实测 | 尚未启用原生加密适配器 |
| 首页登记 | 本机实测 | 共用登记逻辑及 Windows 路径；待实机验证 |
| 自动更新剪映 | 无此能力 | 无此能力 |

版本表区分 `verified / known / unverified / not-installed`。已知 schema 不代表整套功能已完成桌面验收。macOS 加密适配同时校验版本、build、源适配器及引擎/编译产物指纹。编译产物派生自 daemon 的 `RUNTIME_DATA_DIR`，数据路径规则见 [AGENTS.md](../AGENTS.md)。不复制或分发剪映私有库。

可选 `FANTAY_JIANYING_APP` 指定现有客户端，`FANTAY_JIANYING_DRAFTS_ROOT` 指定真实草稿根目录；不支持用符号链接绕过项目边界。媒体探测使用随应用依赖分发的 ffprobe，不要求 Windows 用户另外配置全局命令。

## CLI 与 AI

所有 UI 和 CLI 调用同一组项目 API：`/api/projects/:id/jianying/{status,drafts,inspect,create,edit,install}`。

```sh
od jianying status --project <id> --json
od jianying create --project <id> --revision <revision> --json
od jianying create --project <id> --file plan.json --json
od jianying list --project <id> --include-local --json
od jianying inspect --project <id> --draft <draft-id> --include-local --json
od jianying edit --project <id> --draft <draft-id> --file operations.json --json
od jianying install --project <id> --draft <project-draft-id> --json
```

计划与操作文件中的素材路径相对当前项目。`--file -` 接受 stdin，`--prompt-file` 是 JSON 输入的别名。仅在用户要求访问本机草稿时使用 `--include-local`。

内置 [jianying-draft skill](../skills/jianying-draft/SKILL.md) 已被真实技能目录发现，计划和操作说明全部随包携带。受限 DeepSeek agent 具有 `fantay_jianying_status/list/inspect/create/edit` 结构工具，只能操作当前项目内的草稿副本，不暴露外部草稿库或首页登记。外部草稿由用户在界面选入并保存为项目副本后，受限 agent 可继续编辑。项目授权、秘密文件过滤、真实路径及软硬链接规则在服务端执行。

## 代码与来源

- `apps/daemon/src/jianying/`：版本检测、项目服务、独立进程引擎、本地原生适配器和 CLI。
- `apps/daemon/src/routes/jianying.ts`：项目读写授权和统一 HTTP API。
- `packages/contracts/src/api/jianying.ts`：跨端纯 TypeScript DTO。
- `apps/web/src/components/movie/JianyingDraftDialog.tsx`：实际桌面工作区入口及操作表单。
- `packages/dsh-runtime/src/jianying-tools.ts`：固定项目的结构化工具。
- `vendor/jianying-draft/`：已验收的 0.1 草稿格式兼容运行时、MIT 生成器、原生声明及许可；运行时不依赖项目外的研究目录。

主要生成底座是 [jianying-mcp](https://github.com/Ppppan9/jianying-mcp)。编辑策略参考 [capcut-cli](https://github.com/renezander030/capcut-cli)，原生调用声明参考 [jy-draftc](https://github.com/wenshui330/jy-draftc)，格式核对参考 [pyJianYingDraft](https://github.com/GuanYixuan/pyJianYingDraft)。新增对照了 [easy-jianying](https://github.com/YeJe-cpu/easy-jianying) 的应用发现、版本/能力分层和首页发布，以及 [jianying-headless](https://github.com/GdLinkLock/jianying-headless) 的版本化适配边界。本次运行依赖中未引入这两个项目的引擎源码。

兼容 JS 按固定版本保留，应用政策、入口、隔离 worker、CLI、UI 和新测试使用 TypeScript。资源树与 Windows 缓存键均包含兼容运行时；macOS/Windows 的打包配置包含固定版本 ffprobe，避免开发机可用但打包后缺依赖。

## 验证证据

- daemon 的剪映检测/服务/API/CLI/技能发现：15 项通过；另有受影响的既有 clip-edits 测试通过。
- 界面操作测试：4 项通过，覆盖版本检测、创建、未验证版本确认、修改新副本、连续接续及错误反馈。
- DeepSeek 项目策略与剪映工具：10 项通过。
- 资源复制、Windows 缓存与 macOS/Windows 预打包：37 项通过。
- 连同受影响的既有剪辑测试，本轮共 78 项互不重复的聚焦测试通过。
- `pnpm guard`、全仓 `pnpm typecheck` 通过；未运行完整 daemon/web 全量测试。
- 实际安装核对：剪映兼容运行时及 skill 的 22 个随包文件与工作区哈希一致，预打包 daemon 和 renderer 含当前实现；安装版 CLI 可发现 `jianying` 命令，正在运行的安装版能发现该 skill，剪映版本检测接口返回 200 并识别现有 11.6.0。
- 本机主程序接口真实创建：从项目上传并注册的原视频及当前时间线生成草稿，校验通过。
- 本机原生修改：读取现有剪映 11.6 保存的加密草稿，修改字幕为新副本；原稿 root、meta、活动时间线及时间线指针的哈希保持不变。新副本校验通过，适配器指纹检查通过，并成功加入剪映首页。
- 实际 Electron 工作区：从更多菜单打开创建并成功保存；选择加密项目副本，修改字幕并保存，界面接续到新草稿 ID。再次读取原项目副本，原字幕保持不变。

验证使用独立开发命名空间和生产 HTTP API 建立测试项目，没有调用收费模型。原生窗口工具无法准确区分本机多个 Electron 实例，因此使用项目自带 desktop inspect 接口验收指定实例。开发服务器热更新出现一次 CSS chunk 未加载，完整刷新后复核；未将缺失样式的早期截图作为视觉验收依据。

用户解锁并协助打开验收副本后，已补齐首轮剪映实机检查：播放器可播放，第一条字幕为“FantayDesign 主程序已接入 ✅”，在 `00:00:04:15` 可见绿色图片及第二条字幕。发送保存指令并退出客户端后，再由主程序 API 读取实际落盘文件，仍为 6 秒、30 fps、2 个视觉片段、1 个音频片段和 2 个字幕，校验通过，原稿哈希不变。当前引擎哈希与独立阶段一致，版本仍为 11.6.0。

额外的第二次冷重开尚未完成：重启后普通窗口中的指针操作仍返回 `windowNotFoundAtPosition`，不能写成已经通过。用户已明确要求使用普通窗口，不再最大化或切换全屏。本轮尝试的浏览器本地协议激活也被自动审批拒绝（仅允许 HTTP/HTTPS），没有绕过该限制；原生存档选择器不接受草稿 JSON，因此已取消，没有执行恢复或覆盖。

证据保留在 `.tmp/jianying-integration/`：`acceptance.json`、`gui-edit.json`、`client-readback.json`、`client-verification.json`、`installed-confirmation.json`、`installed-runtime-verify.json`、`typecheck-final.log`、`guard-final.log` 及截图。独立阶段历史材料仍在原 `doc/剪映` 目录。

打包检查还修正了触及测试文件中沿用旧 Vela 环境变量的夹具，使其验证当前独立 OpenCode 及相邻运行库复制；版本检查在该资源复制测试中单独注入，生产版本校验不变。现有关键帧代码和测试各有一处严格可选字段/元组类型写法阻挡构建，已作不改变运行语义的最小修正。

尚未进行 Windows 客户端实机往返、Windows 加密草稿编辑、复杂效果转换或成片自动导出。未将这些能力标记为已验收。
