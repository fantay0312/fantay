# FantayDesign 剪辑模块升级 · 2026-11-02

本次按完整能力清单独立实现，延续现有 FantayDesign、TokenToSea 和原生剪辑器集成。Palmier 最新版已闭源；公开仓库的 `last-gpl-source` 仍指向本地已有的 `8805801fa4df8bc2dbc57cb0a854a1f5108f95c6`，因此没有用新版闭源二进制替换本地模块。

## 功能与入口

| 能力 | 本次实现 |
| --- | --- |
| 后台编辑 | `--headless`；不分配项目窗口；不同项目可并发；同项目工具串行，`targetTimelineId` 支持时间线短 ID 并恢复用户当前选中的时间线；显式 `focus:true` 可打开完整界面。 |
| 用量统计 | 设置中的 AI 用量、项目用量弹层、原生账户用量、`od usage` 共用本地账本；按天、项目、模型/渠道展示 Token、回执扣费、报告费用、退款和未知费用。 |
| 时间线历史 | 编辑自动记录、手动快照、恢复、撤销/重做、关闭后持久化；可恢复已删除时间线。每条时间线保留最近 100 个快照，恢复时适配当前项目帧率。 |
| 字幕 | 7 组完整样式预设；逐词字体、字号、颜色、粗斜体、描边和背景；`fadeIn`、`wordPop`、`wordBounce`；支持中日韩字符及 emoji 的稳定逐词索引；每条字幕可设 1–4 行。 |
| 色彩 | 自动识别或手动覆盖源色彩；支持 Rec.709、Rec.2020、HLG、PQ、Apple Log/Log 2、P3、sRGB 和线性输入；float32 DWG 合成、DaVinci Intermediate 调色；输出 Rec.709、Rec.2020 HLG/PQ，HDR 为 Main10。LUT 可选择 Rec.709 或 DI 域。 |
| 新模型 | Gemini 4 Argon、Muse Wonder、Kling V4 的快捷入口只匹配已授权动态目录中的真实可用模型；保留地区、工具能力及预算限制。目录未提供时显示不可用。 |
| 预览与任务 | Cmd+F 完整预览、独立 1.25× 预览速度、集中后台任务、时间线工具栏移除静音。 |
| NTSC 与音频 | 使用精确有理数帧率，覆盖 24000/1001、30000/1001 等；项目重定时、字幕、关键帧、时间码、XML/FCPXML 与导出采用同一时基；变速音频按视频终点裁切。 |
| 转写剪辑 | 删除单词时分析附近真实 PCM 低能量位置，保护保留词及重叠语音，支持变速和源裁切映射；无法分析时明确报告退回受保护的单词边界。 |

## 统计边界

- TokenToSea 回执按稳定账户 ID 隔离；记录先于付费请求落盘。重复流式回执和轮询更新同一请求，不累加重复扣费。只读对账覆盖已知请求及最近 50 条官方生成历史，失败轮询会让出位置。
- CLI 和自带密钥素材生成属于本机历史，切换 TokenToSea 账户后仍保留；全局汇总与项目汇总均按项目读取权限过滤。仅采集持久化 usage 事件，不读取对话正文或工具输出。
- CLI 历史仅在供应方提供数据时展示 Token/报告费用；素材生成至少记录任务及状态，解析供应方已返回的 usage。未提供的费用显示未知，不按现在的价格补算，不把未知写成免费。
- 历史快照保存编辑状态，不复制源媒体；恢复仍需要可访问的原素材。当前没有实际收费模型生成验收。

## 验证记录

本机安装及启动验收已完成。隔离验收资料位于 `.tmp/palmier-upgrade-20261102/`，旧应用和用户数据备份保留在下方注明的回滚目录。

- 原生首轮受影响路径：503 项、84 组通过。后续后台保存及精确 HDR 导出 9 项通过；透明素材、色彩和嵌套合成 35 项通过。
- 扩展原生检查执行 1,643 项：1,642 项直接通过，1 项 MCP 服务监听时序测试在隔离重跑中通过。没有宣称完整上游测试集全绿，具体限制见下文。
- Web：用量、原生工作区、启动和模型服务 12 项通过。
- Daemon：账本、流式回执、账户运行时、素材与路由 21 项通过；包含本轮审查发现的真实持久化字段和对账公平性回归。
- Web/Daemon 类型检查通过；设计检测无发现；项目 guard 通过。
- 真实后台操作通过：两个项目并发、同项目两条时间线短 ID 定向编辑、保留当前选中标签、快照恢复/撤销/重做、关闭重开持久化、字幕预设和逐词样式；全过程项目窗口与可见窗口均为 0。
- 真实成片回读：100/400/1000 尼特 PQ 素材降低两档曝光后，PQ 为 25.047/99.913/250.428 尼特，HLG 为 24.956/99.649/250.857 尼特。两者均为 BT.2020、正确传递函数、10 位、`30000/1001` 帧率、1.001 秒。
- 变速导出视频/音频均为 3.200000 秒；NTSC 导出视频/音频均为 4.004000 秒。
- 桌面已检查设置用量入口、项目用量弹层、字幕预设与行数、历史列表、后台任务、Cmd+F 和 1.25× 预览速度。正式构建的深色和浅色布局已检查；`od usage` 实际读取通过。

### 本机安装结果

- 已更新 `/Applications/FantayDesign.app`，保留 `design.fantay.desktop` / `com.fantaydesign.video` 身份及现有用户目录；版本号仍为 `0.25.1`，本次是本地功能升级。
- 最终 DMG 构建成功，镜像校验和有效；宿主及原生子应用严格签名检查通过。全部 13 个项目 Metal 内核均已打包，已验收的原生发布程序与安装包二进制哈希一致。
- 已安装路径下的原生程序通过实际后台启动、中文文字渲染、`30000/1001` 导出及保存关闭检查。宿主正常启动、原有历史用量读取成功；现存花园剪辑工程的时间线、视频预览及宿主→完整原生编辑器入口已验证，中文字幕预设和新工具栏可见。
- 更新前备份：`~/Library/Application Support/Fantaydesign/Backups/editor-upgrade-20261102/`。包含旧应用、SQLite 一致性备份、账户及应用配置、原生工程登记、2 份现存原生工程元数据；所有可读工程元数据已校验。另 2 项登记指向此前已经不存在的临时验收工程，登记记录仍保留。
- 用户现有项目、会话和模型设置保留。没有实际收费模型调用，没有提交、推送或对外部署。
- 安装镜像：`/tmp/fantay-editor-upgrade-pack-20261102/out/mac/namespaces/fantay/dmg/Fantaydesign-fantay.dmg`。验收日志、媒体回读结果及截图保存在上述隔离验收目录。

### 全量测试的已知限制

第一次完整执行 1,672 项原生测试产生 48 个断言问题；其中本轮相关的四处问题已修复：帧率接口改为数值类型后的旧整数断言、历史记录增加保存通知、线性光嵌套透明度断言，以及真实透明素材的输入格式选择。

扩展检查暂时排除七类与现有 FantayDesign 适配不一致的旧断言：`TimelineGeometryTests` 的旧主题固定像素；`bundledEnglishLocalizationIsAvailable` 与 `CostEstimatorLocalizationTests` 的默认英语假设；`mainMenuUsesStandardNewFolderShortcut` 的英语菜单名；`AppNotificationsTests` 的旧 Palmier 品牌/文案；`newUserStartsAtWelcome` 的独立引导流程；`defaultMarkerNamesUseNextNumber` 的旧本地化匹配。原日志保留，未通过修改产品行为来迎合这些旧断言。

### 本轮发现并修复的关键边界

- Foundation 的 `URL.path()` 对中文/空格路径进行编码，旧 Metal 构建插件因此可能悄悄漏掉全部内核。已使用文件系统路径属性、枚举失败报错及打包完整性断言。
- 后台文档不调用可能等待系统面板的 AppKit 自动保存；编辑状态初始化和创建窗口分离。保存使用现有包写入器、串行协调与原子元数据文件，并保留保存期间后续编辑的变更计数。
- AVFoundation 在允许不带 alpha 的 YUV 格式时可能丢失 ProRes 透明通道；输入统一为 half-float RGBA，保留透明度和 HDR 精度。真实透明 PNG→ProRes→合成回归通过。
- HDR 写入器显式继承时间线时基，防止默认 600 时间刻度把 NTSC 导出量化成其他帧率。
- 用量捕获兼容真实持久化的 camelCase 字段；第三方素材生成纳入本地任务统计；全局视图过滤项目权限；失败对账让出轮询位置。

## 来源与许可

- [Palmier 公开仓库](https://github.com/palmier-io/palmier-pro)，GPL-3.0-only；保留源码包与原许可。
- [Blackmagic DWG / Intermediate 规范](https://documents.blackmagicdesign.com/InformationNotes/DaVinci_Resolve_17_Wide_Gamut_Intermediate.pdf)。
- [OpenColorIO Apple 相机变换](https://github.com/AcademySoftwareFoundation/OpenColorIO/blob/main/src/OpenColorIO/transforms/builtins/AppleCameras.cpp)，随附 BSD 许可与本地归属声明。
- [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)、[Meta 模型目录](https://dev.meta.ai/docs/models)、[Cloudflare Kling V4](https://developers.cloudflare.com/ai/models/klingai/kling-v4/)。这些来源证明模型标识，不代表当前账户已开通或已实测付费生成。
- [Apple 视频合成读取器](https://developer.apple.com/documentation/avfoundation/avassetreadervideocompositionoutput)。HDR 合成、解码、编码与色彩标签分别验证。
