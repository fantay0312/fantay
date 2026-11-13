# Motion 即时编辑补齐（2026-11-03）

## 交付范围

在当前 `studio` 的统一视频编辑器上增量实现，继续使用 `movie-studio.json`、同一套时间线和撤销历史。没有另装上游编辑器，没有覆盖桌面安装版，也没有提交、推送或调用收费模型。

- 进入影片的「剪辑」视图后，播放栏提供画面文字、动画样式、时间批注三个入口。
- 双击预览文字或从列表选择标题、正文、字幕、文字图层，输入后约 250 ms 更新预览；保存使用局部编辑，取消恢复。文字图层来自全局样式时，只为当前镜头创建覆盖，保留其他镜头。
- 样式面板复用现有颜色、字体类别、构图与图层控制，并可设置字体名、从现有设计系统取用颜色和字体。绑定为快照，未声称持续自动同步设计系统。
- 尚未导出 MP4 时可保存时间点、时间段、整片批注，记录来源内容版本。批注入口保留勾选、定位和人工关闭；时间线顶端可跳转未解决批注，旧版本有明确标识。
- 「发给主聊天修改」只准备选中批注的源内容修改请求，不启动自动出片，不确认交付、不自动关闭批注。继续使用当前项目已配置的 Agent。
- 播放中收到新的源内容时恢复当前播放头和播放状态。未保存文字/样式期间暂缓外部更新，取消后补拉；新预览草稿也纳入现有草稿缓存。
- 人工文字编辑可与正在工作的 Agent 并行。保存依旧使用期望版本；冲突拒绝覆盖并保留草稿。查看者不能编辑。没有新增 LAN 分享服务器或字符级合并功能。

## 接口与 Agent

原有 `add-note` 接受未导出的时间点/时间段，镜头批注使用真实绝对轨道起点。原有保存、局部 edits、style-link、history 接口保持不变。

新增 `POST /api/projects/:id/movie/feedback-prompt`，请求为 `{ expectedRevision, noteIds }`，返回 `{ prompt, revision, noteIds }`；需要编辑权限，拒绝过期版本、无效或已解决批注。它只读取和准备请求，不写文档、不启动 Agent。

```sh
od movie add-note --project <id> --draft --scope time --time 2.5 --text '这里的标题再停留一下' --json
od movie feedback-prompt --project <id> --notes <note-id> --json
```

MCP 对应 `movie_feedback_prompt`。`fantay-movie` 技能和 authoring guide 说明：Build 阶段先交付可播放骨架，再逐镜头保存完整 checkpoint；保留稳定 ID 与人工改动，版本冲突时重新读取和协调。

## 参考与边界

只读参考 baoyu-design 提交 [`609638de1594fe264f6e89b28cae986086093210`](https://github.com/JimLiu/baoyu-design/commit/609638de1594fe264f6e89b28cae986086093210)。其增量文档预览、时间批注、编辑覆盖层对交互有参考价值；按 [NOTICE](https://github.com/JimLiu/baoyu-design/blob/609638de1594fe264f6e89b28cae986086093210/NOTICE.md) 的不同许可边界，本次未复制 Claude Motion 重建编辑器、字体或参考资料。

本次完善的是结构化 MovieDocument 编辑器。独立任意 HTML Motion 文件仍走现有文件预览；未把它们自动转换为可编辑镜头，也未把现有协作描述为无冲突实时共同写文件。Electron/FrameVelo 导出选择维持原有行为。

## 验证记录

最终验证：共享契约 4 项、Web 5 个文件 41 项、daemon 7 个文件 39 项，共 84 项针对性测试通过；Playwright `motion-live-editing.test.ts` 1 条端到端流程通过（测试体 17.6 秒，含启动总计 54.3 秒）。全仓类型检查、最终受影响包类型检查、仓库规则检查和正式前端构建通过。

端到端流程覆盖：真实 iframe 双击文字、输入时预览但尚未落盘、保存局部编辑、无 MP4 时添加时间批注、准备源内容修改请求、接收外部编辑、播放中收到新版本后保留播放头。正式构建的独立 Electron 实例还验证了真实鼠标保存、撤销记录、应用 Fantaydesign 设计系统后保留镜头、批注持久化与源内容请求；验证后关闭临时实例。

最终截图：`.tmp/motion-upgrade-20261103/live-text-production.png`（未保存草稿即时可见）和 `live-comments.png`。端到端完整 trace 在 `e2e/ui/reports/test-results/motion-live-editing-live-M-aa50b-re-one-source-before-export-chromium/trace.zip`。

开发验证中曾触及 Node 默认堆内存上限；仅为验证实例设置了临时内存额度。早期 UI 用例使用了加载前的即时 `count()`，漏点剪辑标签，已改为等待标签可操作。开发热更新期间另一次运行在等待保存响应时超时，未把它归因为已证实的业务故障：正式构建的真实鼠标保存通过；停止源码热更新、为每步收紧超时并启用 trace 后，完整用例通过，未扩大总超时。

临时证据与修改前快照在 `.tmp/motion-upgrade-20261103/`；测试详细日志按项目约定存于 `.tmp/test-records/`。
