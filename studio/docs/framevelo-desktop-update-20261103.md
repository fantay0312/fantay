# FrameVelo 本机安装版更新（2026-11-03）

## 结果

已更新 `/Applications/FantayDesign.app`，版本号保持 **0.25.1**，应用标识 `design.fantay.desktop` 与 namespace `fantay` 不变。启动和重载正常，未重新显示首次引导。窗口已回到工作台首页。

FrameVelo 是可选 HTML 动效后端；默认仍为标准 Electron 导出。含实拍视频会回退到标准路径，原生剪辑与原生导出没有替换。

## 数据保留

更新前先正常关闭应用、确认原生编辑器没有打开的工程，再备份应用、所有 namespace 数据、账号和设置、原生工程及宿主元数据。

备份：`/Users/fantasy/Library/Application Support/Fantaydesign/Backups/framevelo-update-20261103-054352`。

最终与备份前快照对比全部一致：

- 7 个项目的 ID 集合，以及项目文件树内容哈希；
- 2 个保存的账号会话，身份目录与账号文件哈希；
- 应用配置、外观配置的文件哈希；
- 2 个原生工程的语义内容哈希。

验证期间只创建了一个临时验收项目，输出留档后已通过正式 API 删除；原项目未编辑。原生测试使用工程副本和隔离项目目录。

## 安装版实测

| 路径 | 实际结果 |
|---|---|
| 未指定后端的默认导出 | `hyperframes/electron-html`；H.264，640×360，30 帧，1 秒，BT.709 矩阵 / sRGB transfer；红色色块通过 |
| 显式选择 FrameVelo | `hyperframes/framevelo`；相同尺寸、帧数、时长与色彩声明；红色色块通过 |
| 含实拍视频但请求 FrameVelo | 自动回退 `hyperframes/electron-html`；1920×1080，180 帧，6 秒，AAC 音轨 6 秒 |
| 安装版界面操作 | 初始为“标准导出”；切换“FrameVelo 动效加速”后，点击导出得到 2 秒 MP4；渲染记录确认实际使用 FrameVelo |
| 原生编辑器 | 安装包内 `Fantaydesign Video.app` 打开原生工程副本并完成 H.264 720p 导出 |

原生结果与更新前备份里的原生编辑器再次导出同一副本进行对比：**302 帧解码结果完全一致，音频 PCM 样本完全一致**。视频为 10.066667 秒；音轨的 9.031655 秒长度同样与原版一致。

## 本次发现并修复的打包问题

第一份包启动时报 `Dynamic require of "child_process" is not supported`。原因是新加入桌面的 Sharp 被内联进 ESM 启动脚本，其依赖 `detect-libc` 的 CommonJS require 失效。出现问题时恢复了旧应用，用户数据未改动，再重新构建安装。

修复位于 `tools/pack/src/mac/prebundle.ts`：

- 将 `sharp` 保留为已随包携带的外部运行时依赖；
- 禁止把 Sharp / detect-libc 内联到启动脚本；
- 增加实际构建并加载桌面色彩转换模块的回归测试。

15 项 macOS 预打包测试、完整 workspace 类型检查与 guard 通过。最终包的预打包元数据确认没有内联 Sharp / detect-libc，包内原生 Sharp 色彩转换返回正确 `(255,0,0)`。应用和 DMG 校验通过。此次没有对外发布或申请公证，沿用本机签名方式。

## 安装包与证据

- 安装包：`.tmp/desktop/Fantaydesign-framevelo-20261103.dmg`
- SHA-256：`b6e1a907fef84c32bdc52d17b17da80297b1d1b1e5e83d9c7e34b51b20575cc1`
- 数据保留核验：`.tmp/framevelo-install-20261103/preservation.json`
- 各导出结果：`.tmp/framevelo-install-20261103/exports.json`
- 界面导出记录与截图：`ui-export.json`、`installed-framevelo-ui.png`
- 原生对比：`native-comparison.json`、`native-installed-check.mp4`、`native-baseline-check.mp4`
- 构建和检查日志：`build-fixed.log`、`typecheck.log`、`guard.log`

未调用付费模型，未提交、推送或部署到外部环境。开发阶段的根因与完整画面验证见 [FrameVelo 修复与接入记录](framevelo-integration-20261103.md)。
