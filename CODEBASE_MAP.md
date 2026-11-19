# Fantay 代码库地图

以 2026-11-14（Asia/Taipei）的本地源码为准，Git 基线为 `4151363d`，涵盖当前工作区里已经接入的功能。标注「工作区」的入口依赖当时尚未纳入 Git 的文件，标注「本机」的目录由根目录的 Git 忽略规则排除。版本与部署状态以对应发布记录为准。

- [按问题找代码](#按问题找代码)
- [仓库边界](#仓库边界)
- [启动与桌面外壳](#启动与桌面外壳)
- [项目对话与执行](#项目对话与执行)
- [创作工作台](#创作工作台)
- [个人智能体与组织](#个人智能体与组织)
- [账户用量与扩展](#账户用量与扩展)
- [共享包与工程工具](#共享包与工程工具)
- [本机工作区](#本机工作区)
- [运行与验证](#运行与验证)

## 按问题找代码

| 我想排查或调整 | 从这里打开 |
| --- | --- |
| 应用打不开、白屏、打开文件、菜单或系统权限 | [启动与桌面外壳](#启动与桌面外壳) |
| 发送消息、执行权限、切换模型、流式输出、历史与重试 | [项目对话与执行](#项目对话与执行) |
| 画板节点、文件、作品预览、设计文档、设计系统、图片或视频 | [创作工作台](#创作工作台) |
| Personal Agent 的会话、渠道、任务、远程执行、记忆、角色卡或组织 | [个人智能体与组织](#个人智能体与组织) |
| 登录、TokenToSea、用量、搜索、语音、插件或公开分享 | [账户用量与扩展](#账户用量与扩展) |
| 安装包、自动更新、发布记录、CLI 或测试 | [共享包与工程工具](#共享包与工程工具) · [运行与验证](#运行与验证) |
| 调整素材库、查找 Rust 原型或本机研究代码 | [本机工作区](#本机工作区) |

## 仓库边界

| 路径 | 负责什么 |
| --- | --- |
| [studio/](studio/) | Electron 主产品的 pnpm 工作区。[pnpm-workspace.yaml](studio/pnpm-workspace.yaml) 枚举应用、共享包、工具、终端外壳、原生工具和 e2e。用户界面位于 `apps/web`，本地 HTTP API、文件访问与 Agent 执行位于 `apps/daemon`。 |
| [studio/apps/](studio/apps/) | `desktop` 管窗口和系统能力，`packaged` 启动安装包内的进程，`canvas` 是设计文档的内嵌编辑器。`share` 是独立公开分享服务，`closure` 是独立分发内容包，`org-server`（工作区）是组织服务。 |
| [studio/packages/](studio/packages/) · [studio/tools/](studio/tools/) · [studio/e2e/](studio/e2e/) | 共享契约、运行时基础设施、开发与打包控制入口、跨包及端到端验证。 |
| [studio/skills/](studio/skills/) · [studio/plugins/](studio/plugins/) · [studio/design-templates/](studio/design-templates/) · [studio/design-systems/](studio/design-systems/) | Agent 技能、插件包、创作模板、设计系统。另有 [craft/](studio/craft/) 共用规则、[prompt-templates/](studio/prompt-templates/) 图片和视频提示词、[templates/](studio/templates/) 交付模板、[assets/](studio/assets/) 随包资源、[data/plugin-previews/](studio/data/plugin-previews/) 插件预览，以及 [mocks/](studio/mocks/) 可回放的测试 Agent。 |
| [studio/docs/](studio/docs/) · [studio/specs/](studio/specs/) · [studio/ui-audit/](studio/ui-audit/) | 架构与运维文档、当前及历史设计规格、界面验收记录。先用本文定位源码，再按需查功能文档和规格。 |
| [tools/](tools/) · [.github/](.github/) | 根目录的设计校验和图标工具、维护归属与 GitHub 验证。 |
| [素材库/](素材库/) · [rust/](rust/) · [doc/](doc/) · [设计系统](设计系统) | 本机目录及软链接。新检出时以 [.gitignore](.gitignore) 确认哪些路径需从本机恢复，设计系统源码可直接打开 [studio/design-systems/fantay/](studio/design-systems/fantay/)。 |

修改前按目录顺序读 [根 AGENTS.md](AGENTS.md) 和 [Studio AGENTS.md](studio/AGENTS.md)，再进入 [apps](studio/apps/AGENTS.md)、[daemon](studio/apps/daemon/AGENTS.md)、[packages](studio/packages/AGENTS.md)、[tools](studio/tools/AGENTS.md) 或 [e2e](studio/e2e/AGENTS.md) 的规则。根目录 [PROJECT.md](PROJECT.md) 和 [TEST_INFRA.md](TEST_INFRA.md) 记录剪映与视频创作 Skill 专项。

```text
开发  mise run studio → tools-dev → daemon + Next 渲染器 + Electron
安装  apps/packaged   → 打包进程启动与发现 → daemon + 渲染服务 + Electron

Electron ─ preload / IPC ─ 桌面系统能力
   └── 渲染器：页面 → provider → HTTP / SSE → daemon → 服务 → 存储或 Agent
                          └── 共享请求、响应和事件类型来自 packages/contracts
```

运行形态和信任边界详见 [架构文档](studio/docs/architecture.md)。用户入口由 Electron 提供。浏览器里直接打开渲染器、MCP 嵌入页和公开分享页各有自己的适用范围。

## 启动与桌面外壳

| 检查点 | 入口与下一跳 |
| --- | --- |
| 开发时进程起不来 | [根 mise.toml](mise.toml) → [tools-dev 入口](studio/tools/dev/src/index.ts) → 各应用的 sidecar。先看 `tools-dev status` 或 `logs` 判定卡在 daemon、Web 还是 Electron。 |
| 安装后进程起不来或链接打不开 | [packaged/index.ts](studio/apps/packaged/src/index.ts) → [sidecars.ts](studio/apps/packaged/src/sidecars.ts) → [desktop/main/index.ts](studio/apps/desktop/src/main/index.ts)。协议入口在 [packaged/protocol.ts](studio/apps/packaged/src/protocol.ts)，无图形运行入口在 [headless.ts](studio/apps/packaged/src/headless.ts)。 |
| 窗口、系统菜单、文件选择与导出 | [main/runtime.ts](studio/apps/desktop/src/main/runtime.ts) 组装 Electron 窗口与 IPC，[main/preload.cts](studio/apps/desktop/src/main/preload.cts) 暴露能力，[packages/host/src/](studio/packages/host/src/) 定义渲染器可用的接口和检测。问题定位可从 [main/fantay-window-chrome.ts](studio/apps/desktop/src/main/fantay-window-chrome.ts)、[fantay-menu.ts](studio/apps/desktop/src/main/fantay-menu.ts) 或 [conversation-window.ts](studio/apps/desktop/src/main/conversation-window.ts) 开始。 |
| 启动画面、白屏与重载 | [Next catch-all](studio/apps/web/app/%5B%5B...slug%5D%5D/page.tsx) → [client-app.tsx](studio/apps/web/app/%5B%5B...slug%5D%5D/client-app.tsx) → [DesktopAppGate.tsx](studio/apps/web/src/components/DesktopAppGate.tsx) → [App.tsx](studio/apps/web/src/App.tsx)。启动交接和崩溃循环分别看 [splash-handoff.ts](studio/apps/desktop/src/main/splash-handoff.ts) 和 [renderer-crash-loop.ts](studio/apps/desktop/src/main/renderer-crash-loop.ts)，前端观测在 [web/observability/](studio/apps/web/src/observability/)。 |
| 页面切换、侧栏、标签页和布局 | [router.ts](studio/apps/web/src/router.ts) 解析与构建应用路径，[FantayShell.tsx](studio/apps/web/src/fantay/shell/FantayShell.tsx) 和 [sidebar/](studio/apps/web/src/fantay/shell/sidebar/) 管外壳，[fantay/workspace/](studio/apps/web/src/fantay/workspace/) 管项目工作区标签与布局。 |
| 渲染器连接 daemon | [next.config.ts](studio/apps/web/next.config.ts) 配置开发时重写，[web/sidecar/server.ts](studio/apps/web/sidecar/server.ts) 也处理 API、产物和帧转发。业务请求集中在 [providers/](studio/apps/web/src/providers/)，流式基础层在 [sse.ts](studio/apps/web/src/providers/sse.ts)，项目事件另走 [project-events.ts](studio/apps/web/src/providers/project-events.ts) 的 `/api/projects/:id/events`。 |

桌面桥接优先看 [preload 边界测试](studio/apps/desktop/tests/main/preload-host-boundary.test.ts)，窗口与启动问题看 [startup-timing.test.ts](studio/apps/desktop/tests/main/startup-timing.test.ts)。导航和工作区交互从 [fantay-shell Playwright](studio/e2e/ui/fantay-shell.test.ts) 开始。

## 项目对话与执行

```text
项目主对话  ProjectView → streamViaDaemon ─┐
项目侧聊    SideChatTab → useConversationChat ├─ POST /api/runs
                                             └─ GET /api/runs/:id/events
                registerRunRoutes → Agent 启动与事件归一化 → message / run 持久化
```

| 现象 | 首查代码 | 下游与验证 |
| --- | --- | --- |
| 消息发不出、上下文或附件错位 | [ProjectView.tsx](studio/apps/web/src/components/ProjectView.tsx)、[ChatPane.tsx](studio/apps/web/src/components/ChatPane.tsx)、[ChatComposer.tsx](studio/apps/web/src/components/ChatComposer.tsx)。侧聊从 [SideChatTab.tsx](studio/apps/web/src/components/workspace/SideChatTab.tsx) 和 [useConversationChat.ts](studio/apps/web/src/components/workspace/useConversationChat.ts) 查。 | [daemon provider](studio/apps/web/src/providers/daemon.ts) 的 `streamViaDaemon` 创建 run 并消费事件。消息与对话范围见 [conversations.ts](studio/apps/daemon/src/routes/project/conversations.ts)。 |
| 执行权限、主对话与侧聊会话隔离 | [ChatPane.tsx](studio/apps/web/src/components/ChatPane.tsx) 的 `saveExecutionPermission` 和 [ExecutionPermissionPicker.tsx](studio/apps/web/src/components/ExecutionPermissionPicker.tsx) → [state/projects.ts](studio/apps/web/src/state/projects.ts) → [conversations 路由](studio/apps/daemon/src/routes/project/conversations.ts)。 | [runs 路由](studio/apps/daemon/src/routes/runs.ts) → [server.ts](studio/apps/daemon/src/server.ts) 的 `startChatRun` 读取会话设置 → [执行权限解析](studio/apps/daemon/src/runtimes/execution-permission.ts) 和 Agent 启动参数。[权限测试](studio/apps/daemon/tests/runtimes/execution-permissions.test.ts) |
| SSE、中断、重连、重试、工具调用或渲染 | [providers/daemon.ts](studio/apps/web/src/providers/daemon.ts) 的 `streamViaDaemon` 和 `reattachDaemonRun`，以及 [AssistantMessage.tsx](studio/apps/web/src/components/AssistantMessage.tsx)、[components/chat/](studio/apps/web/src/components/chat/) 与 [runtime/chat/](studio/apps/web/src/runtime/chat/)。 | [routes/runs.ts](studio/apps/daemon/src/routes/runs.ts) 注册创建、事件、取消和引导接口，[runtimes/runs.ts](studio/apps/daemon/src/runtimes/runs.ts) 管运行与事件。改工具调用或输出渲染前读 [Chat 分层规则](studio/apps/web/src/components/chat/AGENTS.md) 与 [Chat 设计与决策](studio/specs/current/chat-panel-next.md)。[事件续传测试](studio/apps/daemon/tests/runtimes/runs-durable-replay.test.ts) · [Web 重连测试](studio/apps/web/tests/providers/daemon-sse-reconnect.test.ts) · [真实 daemon 的 Playwright](studio/e2e/ui/real-daemon-run.test.ts) |
| 编辑消息、重生成、历史分支（工作区） | [MessageVersions.tsx](studio/apps/web/src/components/chat/MessageVersions.tsx)、[ProjectView.tsx](studio/apps/web/src/components/ProjectView.tsx) 与 [state/projects.ts](studio/apps/web/src/state/projects.ts)。 | [conversations 路由](studio/apps/daemon/src/routes/project/conversations.ts) → [message-branches.ts](studio/apps/daemon/src/storage/message-branches.ts) → [db.ts](studio/apps/daemon/src/db.ts)。见 [消息分支测试](studio/apps/daemon/tests/db-message-branches.test.ts)。 |
| 模型列表、Agent 检测、CLI 启动与 stdout | [daemon/agents.ts](studio/apps/daemon/src/agents.ts) 与 [runtimes/](studio/apps/daemon/src/runtimes/)。先按 Agent 找 [defs/](studio/apps/daemon/src/runtimes/defs/)，再查 [registry.ts](studio/apps/daemon/src/runtimes/registry.ts)、[detection.ts](studio/apps/daemon/src/runtimes/detection.ts)、[models.ts](studio/apps/daemon/src/runtimes/models.ts) 和 [launch.ts](studio/apps/daemon/src/runtimes/launch.ts)。 | [agent-protocol/](studio/apps/daemon/src/agent-protocol/) 和各 runtime 的流解析器把 stdout 转为应用事件。内置 TokenToSea/BYOK 的 Pi 适配在 [bundled-pi.ts](studio/apps/daemon/src/runtimes/bundled-pi.ts)。见 [高级适配说明](studio/docs/agent-adapters.md) 与 [runtimes 测试](studio/apps/daemon/tests/runtimes/)。 |
| Prompt、场景、工具、产物校验 | [server.ts](studio/apps/daemon/src/server.ts) 组装 [prompts/](studio/apps/daemon/src/prompts/)、[strategies/](studio/apps/daemon/src/strategies/)、[plugins/](studio/apps/daemon/src/plugins/) 和 [run-tool-bundle.ts](studio/apps/daemon/src/run-tool-bundle.ts)。 | 修改 Prompt 先读 [两条组合路径](studio/docs/prompt-composition.md)；随后检查 [skill 载入](studio/apps/daemon/src/skills.ts)、[工具及产物校验](studio/apps/daemon/src/run-deliverable-validation.ts)。 |

[daemon/cli.ts](studio/apps/daemon/src/cli.ts) 提供 `od`，`startServer` 在 [server.ts](studio/apps/daemon/src/server.ts) 组装 Express 与业务路由。定位时先在 `routes/` 搜 API 或路由注册函数，再回到 `server.ts` 查注入的依赖和调用范围。对话、run 和事件追到 [db.ts](studio/apps/daemon/src/db.ts) 与 [storage/](studio/apps/daemon/src/storage/)，项目文件权限和路径追到 [routes/project/](studio/apps/daemon/src/routes/project/) 与 [projects.ts](studio/apps/daemon/src/projects.ts)。管理数据路径遵循 [daemon 数据目录约定](studio/AGENTS.md#daemon-data-directory-contract)。接口变化先定位 [contracts/api/](studio/packages/contracts/src/api/) 与对应导出，然后检查调用方、保存回读、事件回放与取消路径。

主对话在恢复已有 run 时调用 `reattachDaemonRun`。侧聊重开由 `useConversationChat` 的 `listMessages` 读取持久化历史，活跃 run 期间轮询刷新。[主对话恢复](studio/apps/web/src/components/ProjectView.tsx) · [侧聊测试](studio/apps/web/tests/components/workspace/useConversationChat.test.tsx)

## 创作工作台

| 功能 | 从界面追到数据 | 对应验证 |
| --- | --- | --- |
| 无限画板、节点、缩放与撤销 | [ProjectBoard.tsx](studio/apps/web/src/fantay/board/ProjectBoard.tsx) 组装 `BoardDataProvider → GenerationProvider → BoardView`。[camera/](studio/apps/web/src/fantay/board/camera/)、[interaction/](studio/apps/web/src/fantay/board/interaction/)、[store/](studio/apps/web/src/fantay/board/store/) 管视图与交互，[data/](studio/apps/web/src/fantay/board/data/) 管操作、撤销和同步。往下查 [board 契约](studio/packages/contracts/src/board/)、[board routes](studio/apps/daemon/src/fantay/board/routes.ts) 的 `/api/projects/:id/board`、同目录 [service.ts](studio/apps/daemon/src/fantay/board/service.ts) 与 [store.ts](studio/apps/daemon/src/fantay/board/store.ts)。 | [画板规则](studio/apps/web/src/fantay/board/AGENTS.md) · [Web 测试](studio/apps/web/tests/fantay/board/) · [daemon 测试](studio/apps/daemon/tests/fantay/board/) · [画板 Playwright](studio/e2e/ui/fantay-board.test.ts) |
| 画板生成节点与素材处理 | [GeneratorPanel.tsx](studio/apps/web/src/fantay/generation/components/GeneratorPanel.tsx) 所在的 [generation/](studio/apps/web/src/fantay/generation/) 管模型参数、参考图、发起生成与候选结果，[media-nodes/](studio/apps/web/src/fantay/media-nodes/) 接入画板节点，[media-tools/](studio/apps/web/src/fantay/media-tools/) 管本地编辑弹窗。后端查 [media 路由](studio/apps/daemon/src/routes/media.ts)、[media/](studio/apps/daemon/src/media/)、[media-adapters/](studio/apps/daemon/src/media-adapters/) 和 [media-ops/](studio/apps/daemon/src/fantay/media-ops/)，命令行串联见 [board-generate-cli.ts](studio/apps/daemon/src/fantay/board-generate-cli.ts)。 | [画板与媒体操作](studio/docs/fantay-board.md) · [生成测试](studio/apps/web/tests/fantay/generation/) · [画板生成 Playwright](studio/e2e/ui/fantay-board-generation.test.ts) |
| 设计文档、OpenPencil 编辑器 | [FileWorkspace.tsx](studio/apps/web/src/components/FileWorkspace.tsx) 经 [file-editor.tsx](studio/apps/web/src/fantay/design/file-editor.tsx) 进入 [DesignDocumentViewer.tsx](studio/apps/web/src/fantay/design/DesignDocumentViewer.tsx) 与 [DesignEditorHost.tsx](studio/apps/web/src/fantay/design/DesignEditorHost.tsx)。[useDesignBridge.ts](studio/apps/web/src/fantay/design/useDesignBridge.ts) 与同源 iframe 通讯。iframe 从 [canvas/main.ts](studio/apps/canvas/src/main.ts) 启动，由 [Vite](studio/apps/canvas/vite.config.ts) 构建到 Web 的 `public/canvas-editor`。文件、版本和迁移看 [routes/designs.ts](studio/apps/daemon/src/routes/designs.ts)、[fantay/designs/](studio/apps/daemon/src/fantay/designs/) 和 [design-documents 契约](studio/packages/contracts/src/api/design-documents.ts)。`/api/design-canvas/documents` 是 [旧独立存储入口](studio/apps/daemon/src/routes/design-canvas.ts)。 | [文档格式与边界](studio/docs/fantay-design-documents.md) · [Canvas 测试](studio/apps/canvas/tests/) · [daemon 文档测试](studio/apps/daemon/tests/fantay/designs/) · [编辑器 Playwright](studio/e2e/ui/fantay-design-editor.test.ts) |
| 设计系统管理与默认选择 | [DesignSystemsTab.tsx](studio/apps/web/src/components/DesignSystemsTab.tsx)、[DesignSystemStudio.tsx](studio/apps/web/src/components/DesignSystemStudio.tsx) 和项目内 [ProjectDesignSystemTab.tsx](studio/apps/web/src/fantay/workspace/ProjectDesignSystemTab.tsx)。定义、目录和生成记录看 [routes/design-systems.ts](studio/apps/daemon/src/routes/design-systems.ts) 与 [daemon/design-systems/](studio/apps/daemon/src/design-systems/)。默认策略查 [default-design-system.ts](studio/apps/web/src/state/default-design-system.ts)。 | [设计系统包规范](studio/docs/design-systems.md) · [编辑器说明](studio/docs/design-system-studio.md) · [管理器 Playwright](studio/e2e/ui/design-systems-manager.test.ts) |
| 项目文件、生成物、预览与交付 | [FileWorkspace.tsx](studio/apps/web/src/components/FileWorkspace.tsx) 管工作区标签，[DesignFilesPanel.tsx](studio/apps/web/src/components/DesignFilesPanel.tsx) 管文件面板，[FileViewer.tsx](studio/apps/web/src/components/FileViewer.tsx) 管预览，[artifacts/](studio/apps/web/src/artifacts/) 处理前端产物协议。继续查 [daemon 的 project 路由](studio/apps/daemon/src/routes/project/)、[projects.ts](studio/apps/daemon/src/projects.ts)、[产物校验](studio/apps/daemon/src/artifacts/)、[对话产物](studio/apps/daemon/src/chat-artifacts/) 与 [Live Artifacts](studio/apps/daemon/src/live-artifacts/)。 | [产物协议测试](studio/apps/web/tests/artifacts/) · [daemon 产物测试](studio/apps/daemon/tests/artifacts/) · [渲染一致性测试](studio/e2e/tests/artifact-render-parity.test.ts) |
| 右侧工作区的起始页、代码面板与自动打开（工作区） | 起始页是 [WorkspaceStart.tsx](studio/apps/web/src/fantay/workspace/start/WorkspaceStart.tsx)，代码面板（文件树、源码、本轮更改）是 [CodeSurface.tsx](studio/apps/web/src/fantay/workspace/code/CodeSurface.tsx)，两者由 [FileWorkspace.tsx](studio/apps/web/src/components/FileWorkspace.tsx) 和 [useFantayWorkspace.tsx](studio/apps/web/src/fantay/workspace/useFantayWorkspace.tsx) 挂载。「打开哪个工具」的判定集中在 [surfaces/](studio/apps/web/src/fantay/workspace/surfaces/)：`surface-router.ts` 给出决定，`turn-changes.ts` 从本轮工具调用归纳文件改动，[ProjectView.tsx](studio/apps/web/src/components/ProjectView.tsx) 的 `openSurfaceIntent` 执行。模型用 `<od-focus tool="…"/>` 明示打开工具，标记的解析在 [artifact-focus-marker.ts](studio/packages/contracts/src/api/artifact-focus-marker.ts)，校验与下发在 [daemon 的同名文件](studio/apps/daemon/src/artifact-focus-marker.ts)。 | [surfaces 测试](studio/apps/web/tests/fantay/workspace/surfaces/) · [标记协议测试](studio/apps/daemon/tests/artifact-focus-protocol.test.ts) |
| 产物查看器、文件库面板与对话里的产物卡片（工作区） | 网页、幻灯片网页、React 组件和 Markdown 仍由 [FileViewer.tsx](studio/apps/web/src/components/FileViewer.tsx) 自己的查看器显示；其余文件在产品外壳下交给 [ArtifactViewer.tsx](studio/apps/web/src/fantay/artifact/ArtifactViewer.tsx)。它用 [file-family.ts](studio/apps/web/src/fantay/artifact/file-family.ts) 按扩展名和 MIME 选查看器，各类查看器在 [viewers/](studio/apps/web/src/fantay/artifact/viewers/)（PDF、Word 与电子书、表格与 SQLite、演示文稿、文本与笔记本、音视频、压缩包、字体、3D、图片、Mermaid 图表、Excalidraw 草图、邮件），统一外壳和工具栏在 [shell/](studio/apps/web/src/fantay/artifact/shell/)，读取文件用 [use-artifact-source.ts](studio/apps/web/src/fantay/artifact/use-artifact-source.ts)，切换标签后仍要保留的阅读位置放在 [use-view-state.ts](studio/apps/web/src/fantay/artifact/use-view-state.ts)。PDF 引擎的自托管资源在 [public/artifact/pdfjs/](studio/apps/web/public/artifact/pdfjs/)；Excalidraw 的字体在 [public/artifact/excalidraw/](studio/apps/web/public/artifact/excalidraw/)，Excalidraw 文件查看器经 [excalidraw-assets.ts](studio/apps/web/src/components/excalidraw-assets.ts) 指向这份本地字体。文件库面板是 [FilesSurface.tsx](studio/apps/web/src/fantay/workspace/files/FilesSurface.tsx)，由 [FileWorkspace.tsx](studio/apps/web/src/components/FileWorkspace.tsx) 在「文件」标签挂载。对话里的产物卡片是 [ArtifactCards.tsx](studio/apps/web/src/fantay/artifact/cards/ArtifactCards.tsx)，由 [FileOpsSummary.tsx](studio/apps/web/src/components/FileOpsSummary.tsx) 在产品外壳下渲染；当前打开的标签经 [active-artifact.ts](studio/apps/web/src/fantay/artifact/cards/active-artifact.ts) 传给卡片显示选中态。哪些产物在生成后自动打开看 [auto-open-file.ts](studio/apps/web/src/components/auto-open-file.ts)。公式排版共用 [math/](studio/apps/web/src/fantay/artifact/math/)：KaTeX 引擎在 [engine.ts](studio/apps/web/src/fantay/artifact/math/engine.ts)，哪些文字算公式由 [find-math.ts](studio/apps/web/src/fantay/artifact/math/find-math.ts) 判定，笔记本、Markdown 文档、对话消息和 Mermaid 标签都走这里。Mermaid 的绘制、按面板宽度重排和各类图的主题在 [viewers/diagram/](studio/apps/web/src/fantay/artifact/viewers/diagram/)（[render.ts](studio/apps/web/src/fantay/artifact/viewers/diagram/render.ts)、[theme.module.css](studio/apps/web/src/fantay/artifact/viewers/diagram/theme.module.css)）；对话和 Markdown 文档里内嵌的图表在 [embed/](studio/apps/web/src/fantay/artifact/embed/)，对话侧由 [runtime/markdown.tsx](studio/apps/web/src/runtime/markdown.tsx) 调用，文档侧由 [FileViewer.tsx](studio/apps/web/src/components/FileViewer.tsx) 的 Markdown 预览调用。邮件里远程图片的加载开关和消毒规则在 [sanitize-mail.ts](studio/apps/web/src/fantay/artifact/viewers/email/sanitize-mail.ts)。移植代码的来源登记在 [THIRD_PARTY_NOTICES.md](studio/THIRD_PARTY_NOTICES.md)。 | [artifact 测试](studio/apps/web/tests/fantay/artifact/) · [文件库测试](studio/apps/web/tests/fantay/workspace/files/) |
| 动画、分镜与视频导出 | 项目内入口是 [MotionEditorHost.tsx](studio/apps/web/src/fantay/motion/MotionEditorHost.tsx)，`/movie-app` 等入口由 [MovieEmbeddedApp.tsx](studio/apps/web/src/fantay/motion/MovieEmbeddedApp.tsx) 组装。时间线和导出入口集中在 [components/movie/](studio/apps/web/src/components/movie/)，请求走 [routes/movie.ts](studio/apps/daemon/src/routes/movie.ts)，工程、导出与本机编辑桥接在 [daemon/movie/](studio/apps/daemon/src/movie/)，数据契约在 [api/movie.ts](studio/packages/contracts/src/api/movie.ts)。 | [动画工作台文档](studio/docs/movie-studio.md) · [动效 UI 测试](studio/apps/web/tests/fantay/motion/) · [视频后端测试](studio/apps/daemon/tests/movie/) |
| 剪映草稿 | [JianyingDraftDialog.tsx](studio/apps/web/src/components/movie/JianyingDraftDialog.tsx) → [routes/jianying.ts](studio/apps/daemon/src/routes/jianying.ts) → [JianyingService](studio/apps/daemon/src/jianying/service.ts) → [vendor/jianying-draft](studio/vendor/jianying-draft/)，Agent 工具在 [jianying-tools.ts](studio/packages/dsh-runtime/src/jianying-tools.ts)，共用 [剪映契约](studio/packages/contracts/src/api/jianying.ts)。 | [剪映接入说明](studio/docs/jianying-integration-20261103.md) · [daemon 剪映测试](studio/apps/daemon/tests/jianying/) |
| 从素材库添加参考 | [MaterialsView.tsx](studio/apps/web/src/components/materials/MaterialsView.tsx)、[MaterialPickerDialog.tsx](studio/apps/web/src/components/materials/MaterialPickerDialog.tsx) 和 [MaterialsDrawerHost.tsx](studio/apps/web/src/fantay/materials/MaterialsDrawerHost.tsx) → [materials provider](studio/apps/web/src/providers/materials.ts) → [routes/materials.ts](studio/apps/daemon/src/routes/materials.ts) → [libraries.ts](studio/apps/daemon/src/materials/libraries.ts) 聚合多库检索，`apply.ts` 把选中的参考应用到项目。`od materials` 与 [fantay-materials 技能](studio/skills/fantay-materials/) 走同一能力。 | [路由测试](studio/apps/daemon/tests/materials-routes.test.ts) · [CLI 测试](studio/apps/daemon/tests/materials-cli.test.ts) · [输入框素材测试](studio/apps/web/tests/components/ChatComposer.materials.test.tsx) |

界面主题从 [app/layout.tsx](studio/apps/web/app/layout.tsx) 载入 [Fantay CSS 入口](studio/apps/web/src/fantay/styles/app.css)。应用令牌在 [packages/fantay-tokens/src/tokens.ts](studio/packages/fantay-tokens/src/tokens.ts)，生成 CSS 后由应用消费。UI 原语位于 [fantay/ui/](studio/apps/web/src/fantay/ui/)，功能样式通常紧邻组件。默认提供给作品与素材库的设计系统规则在 [fantay/DESIGN.md](studio/design-systems/fantay/DESIGN.md) 和 [fantay/tokens.css](studio/design-systems/fantay/tokens.css)。修改涉及示例或令牌映射时，查看 [校验脚本](tools/check_fantay.py) 的对应关系。

## 个人智能体与组织

| 功能 | 实际入口与下一跳 | 对应验证 |
| --- | --- | --- |
| Personal Agent（PA）会话、分组、任务、活动与项目访问 | `/pa` 经 [router.ts](studio/apps/web/src/router.ts) 和 [EntryShell.tsx](studio/apps/web/src/components/EntryShell.tsx) 进入 [PersonalAgentWorkspace.tsx](studio/apps/web/src/fantay/pa/PersonalAgentWorkspace.tsx)。[usePaWorkspace.ts](studio/apps/web/src/fantay/pa/usePaWorkspace.ts) 管轮询与操作，[pa-api.ts](studio/apps/web/src/fantay/pa/pa-api.ts) 连 [routes/personal-agent.ts](studio/apps/daemon/src/routes/personal-agent.ts)，后端为 [PersonalAgentService](studio/apps/daemon/src/services/personal-agent-service.ts) 和 [PA store](studio/apps/daemon/src/storage/personal-agent-store.ts)，共用 [PA 契约](studio/packages/contracts/src/api/personal-agent.ts)。`od pa` 接同一服务。 | [PA Web 测试](studio/apps/web/tests/fantay/pa/) · [任务生命周期](studio/apps/daemon/tests/personal-agent-lifecycle.test.ts) |
| PA 执行、安全与远程 worker | [services/pa/config.ts](studio/apps/daemon/src/services/pa/config.ts) 和 [kernel.ts](studio/apps/daemon/src/services/pa/kernel.ts) 负责模式、租户、身份及授权。[PersonalAgentService](studio/apps/daemon/src/services/personal-agent-service.ts) 分派本机模型、OCI 沙盒和远端执行，底层见 [sandbox.ts](studio/apps/daemon/src/services/pa/sandbox.ts)、[distributed.ts](studio/apps/daemon/src/services/pa/distributed.ts) 和 [worker.ts](studio/apps/daemon/src/services/pa/worker.ts)。worker 主动领取、续租和提交回执。 | [执行与恢复边界](studio/docs/personal-agent-execution.zh-CN.md) · [内核测试](studio/apps/daemon/tests/personal-agent-kernel.test.ts) |
| PA 飞书、微信和桌面后台 | [PersonalAgentChannels](studio/apps/daemon/src/services/personal-agent-channels.ts) 接收渠道事件并提交 PA 任务，[channels 路由](studio/apps/daemon/src/routes/personal-agent-channels.ts) 管渠道配置和动作，桌面后台策略见 [pa-background.ts](studio/apps/desktop/src/main/pa-background.ts)。由 [server.ts](studio/apps/daemon/src/server.ts) 按模式启动渠道。 | [渠道测试](studio/apps/daemon/tests/personal-agent-channels.test.ts) · [桌面后台测试](studio/apps/desktop/tests/main/pa-background.test.ts) |
| PA Soul 角色库、角色卡、对话与语音（工作区） | PA 工作区挂载 [pa/soul/](studio/apps/web/src/fantay/pa/soul/)，共享格式与规则在 [contracts/soul/](studio/packages/contracts/src/soul/)。后端 [Soul 路由](studio/apps/daemon/src/routes/personal-agent-soul.ts) → [Soul service](studio/apps/daemon/src/services/personal-agent-soul.ts) → PA 回合调度，[Soul live 路由](studio/apps/daemon/src/routes/personal-agent-soul-live.ts) 提供文字增量。设置和 fixture 可从 [PA lab](studio/apps/web/src/fantay/pa/lab/PaLab.tsx) 定位。 | [PA/Soul 界面说明](studio/apps/web/src/fantay/pa/DESIGN.md) · [Soul 生命周期](studio/apps/daemon/tests/personal-agent-soul-lifecycle.test.ts) · [Soul 实时增量](studio/apps/daemon/tests/personal-agent-soul-live.test.ts) |
| 记忆系统与记忆中心（工作区） | `/memory` → [MemoryCenterView.tsx](studio/apps/web/src/fantay/memory/MemoryCenterView.tsx) → [api.ts](studio/apps/web/src/fantay/memory/api.ts) → [memory-center 路由](studio/apps/daemon/src/routes/memory-center.ts) → [memory-center service](studio/apps/daemon/src/services/memory-center-service.ts) → [记忆引擎](studio/apps/daemon/src/services/memory/engine.ts)。引擎目录 [services/memory/](studio/apps/daemon/src/services/memory/)：谁能读什么只在 [policy.ts](studio/apps/daemon/src/services/memory/policy.ts)；只增不删的账本在 [store.ts](studio/apps/daemon/src/services/memory/store.ts)（表结构见 [schema.ts](studio/apps/daemon/src/services/memory/schema.ts)）；回忆在 [retrieval.ts](studio/apps/daemon/src/services/memory/retrieval.ts)；分歧规则在 [conflict-heuristics.ts](studio/apps/daemon/src/services/memory/conflict-heuristics.ts)；对话片段在 [ingest.ts](studio/apps/daemon/src/services/memory/ingest.ts)。个人智能体经 [pa-bridge.ts](studio/apps/daemon/src/services/memory/pa-bridge.ts) 接入，项目对话经 [studio-bridge.ts](studio/apps/daemon/src/services/memory/studio-bridge.ts) 接入（`server.ts` 里搜 `studioMemoryBridge`）。设置 → 记忆的手写条目仍在 [Studio memory.ts](studio/apps/daemon/src/memory.ts)，在记忆中心只读显示。`od memory` 走同一组路由（[memory-center-cli.ts](studio/apps/daemon/src/services/memory-center-cli.ts)）。产品说明见 [Fantay 记忆系统 1.0](doc/PA/记忆/md/version/Fantay%20记忆系统%201.0.md)。 | [引擎测试](studio/apps/daemon/tests/memory/) · [Memory Center daemon 测试](studio/apps/daemon/tests/memory-center.test.ts) · [PA 记忆测试](studio/apps/daemon/tests/personal-agent-memory.test.ts) · [Memory Center Web 测试](studio/apps/web/tests/fantay/memory/) · 检索评测 `apps/daemon/scripts/memory-eval.ts` |
| 组织管理、策略与共享角色库（工作区） | [org-server/main.ts](studio/apps/org-server/src/main.ts) 的 `init`、`serve` 启动独立服务，[server.ts](studio/apps/org-server/src/server.ts) 管路由，[service.ts](studio/apps/org-server/src/service.ts) 管角色、成员、策略与审计。企业 daemon 的 [org-link.ts](studio/apps/daemon/src/services/pa/org-link.ts) 拉取成员目录、策略及已发布角色。两端共用 [contracts/org/](studio/packages/contracts/src/org/)，成员对话和记忆由客户端侧保存。 | [组织服务说明](studio/apps/org-server/README.md) · [身份测试](studio/apps/org-server/tests/identity.test.ts) · [同步测试](studio/apps/daemon/tests/personal-agent-org-link.test.ts) |

企业端排查成员隔离时，记忆中心与 PA 路由要分别检查。记忆中心的每个读写都在 [memory-center service](studio/apps/daemon/src/services/memory-center-service.ts) 的 `ownedRow` / `principalOf` 处按成员过滤（含 `/chunks` 与 `/chunks/:id`）；PA 路由在 [personal-agent 路由](studio/apps/daemon/src/routes/personal-agent.ts) 的记忆守卫和 `PersonalAgentService.ownedRow` 处过滤，管理员也只能看到自己的记忆。已知未收紧的一处：`/memory-candidates/:id/resolve` 仍按任务归属授权。隔离用例见 [Memory Center daemon 测试](studio/apps/daemon/tests/memory-center.test.ts) 与 [PA soul 测试](studio/apps/daemon/tests/personal-agent-soul.test.ts)。

## 账户用量与扩展

| 功能 | 可追踪的入口 |
| --- | --- |
| 设置、登录、模型、余额与媒体服务 | [SettingsDialog.tsx](studio/apps/web/src/components/SettingsDialog.tsx) 组装设置，[fantay/account/](studio/apps/web/src/fantay/account/) 和 [TokenToSeaAccount.tsx](studio/apps/web/src/components/TokenToSeaAccount.tsx) 管账户显示。登录回调、模型与余额、推理转发分别在 [routes/tokentosea.ts](studio/apps/daemon/src/routes/tokentosea.ts)、[tokentosea-cloud.ts](studio/apps/daemon/src/routes/tokentosea-cloud.ts) 和 [integrations/tokentosea-runtime.ts](studio/apps/daemon/src/integrations/tokentosea-runtime.ts)。[packages/tokentosea/](studio/packages/tokentosea/) 共享客户端代码。Agent 探测与提供商连接测试另查 [static-resource.ts](studio/apps/daemon/src/routes/static-resource.ts) 和 [chat.ts](studio/apps/daemon/src/routes/chat.ts)。 |
| AI 用量、热力图、会话明细（设备扫描扩展在工作区） | [components/usage/](studio/apps/web/src/components/usage/) → [routes/usage.ts](studio/apps/daemon/src/routes/usage.ts) → [usage-store.ts](studio/apps/daemon/src/integrations/usage-store.ts)。本机 Agent 扫描由 [usage-local-agents.ts](studio/apps/daemon/src/integrations/usage-local-agents.ts) 与同目录 `usage-*` 适配器、解析器和定价辅助代码负责。核对计费口径查 [使用说明](studio/docs/local-agent-usage.md)、[用量契约](studio/packages/contracts/src/api/usage.ts) 和 [路由测试](studio/apps/daemon/tests/routes/usage.test.ts)。 |
| 搜索供应商与原生搜索工具（工作区） | [SettingsSearchProviders.tsx](studio/apps/web/src/components/SettingsSearchProviders.tsx) → [search provider](studio/apps/web/src/providers/search-service.ts) → [search-service 路由](studio/apps/daemon/src/routes/search-service.ts) → [research/search-service.ts](studio/apps/daemon/src/research/search-service.ts)。嵌入式引擎包装在 [native-tool/web_search/src/](studio/native-tool/web_search/src/)，同时检查 Pi、MCP 与 `od search` 的调用。[搜索测试](studio/apps/daemon/tests/research/) |
| 语音输入（工作区） | [SettingsVoiceInput.tsx](studio/apps/web/src/components/SettingsVoiceInput.tsx) 管设置，[VoiceInputButton.tsx](studio/apps/web/src/components/composer/VoiceInputButton.tsx) 接首页和聊天输入框。录音转录走 [voice provider](studio/apps/web/src/providers/voice-input.ts)、[voice-input 路由](studio/apps/daemon/src/routes/voice-input.ts) 和 [VoiceInputService](studio/apps/daemon/src/services/voice-input.ts)，也可查 `od voice`。[语音服务测试](studio/apps/daemon/tests/services/voice-input.test.ts) |
| 插件、市场、场景、技能与 MCP | [PluginsView.tsx](studio/apps/web/src/components/PluginsView.tsx) 和 [fantay/plugins/](studio/apps/web/src/fantay/plugins/) → [daemon 插件路由](studio/apps/daemon/src/routes/plugins/) → [daemon/plugins/](studio/apps/daemon/src/plugins/)、[packages/plugin-runtime/](studio/packages/plugin-runtime/) 与 [plugins/_official/](studio/plugins/_official/)。功能技能查 [skills.ts](studio/apps/daemon/src/skills.ts) 与 [技能协议](studio/docs/skills-protocol.md)。MCP 入口查 [mcp.ts](studio/apps/daemon/src/mcp.ts)、[mcp-routes.ts](studio/apps/daemon/src/mcp-routes.ts)；桌面工具插件另外由 [desktop/tool-plugins.ts](studio/apps/desktop/src/main/tool-plugins.ts) 与 [tool-plugin-gateway.ts](studio/apps/daemon/src/routes/tool-plugin-gateway.ts) 提供。 |
| 连接器、浏览器会话、终端与 Critique | [ConnectorsBrowser.tsx](studio/apps/web/src/components/ConnectorsBrowser.tsx) 及 [daemon/connectors/](studio/apps/daemon/src/connectors/) 管连接器。浏览器会话和终端入口在 [browser-sessions 路由](studio/apps/daemon/src/routes/browser-sessions.ts) 与 [terminal 路由](studio/apps/daemon/src/routes/terminal.ts)。Critique 运行在 [daemon/critique/](studio/apps/daemon/src/critique/)，界面、回放与流在 [components/Theater/](studio/apps/web/src/components/Theater/)。 |
| 工作台、自动化、桌面宠物 | [WorkbenchView.tsx](studio/apps/web/src/fantay/workbench/WorkbenchView.tsx) → [workbench 路由](studio/apps/daemon/src/routes/workbench.ts) → [daemon/workbench/](studio/apps/daemon/src/workbench/) 管灵感、内容、排期和数据。自动化查 [automation.ts](studio/apps/daemon/src/routes/automation.ts)、[routine.ts](studio/apps/daemon/src/routes/routine.ts) 与 [routines.ts](studio/apps/daemon/src/routines.ts)。宠物从 [desktop-pet 页面](studio/apps/web/app/desktop-pet/page.tsx) 和 [components/pet/](studio/apps/web/src/components/pet/) 查。 |
| 公开分享、评论、协作与团队资源 | [TokenToSeaSharePanel.tsx](studio/apps/web/src/components/share/TokenToSeaSharePanel.tsx) → [daemon 分享路由](studio/apps/daemon/src/routes/tokentosea-share.ts) → 独立 [share/main.ts](studio/apps/share/src/main.ts)、[share/server.ts](studio/apps/share/src/server.ts) 和 [share/client.ts](studio/apps/share/src/client.ts)。项目内联机协作从 Web [collab/](studio/apps/web/src/collab/) 和 daemon [collab/](studio/apps/daemon/src/collab/) 或 [team-resources 路由](studio/apps/daemon/src/routes/team-resources.ts) 查。[分享服务测试](studio/apps/share/tests/service.test.ts) · [本地云服务夹具](studio/e2e/lib/vitest/tokentosea-cloud.ts) |
| Clipper 和 Figma 导入 | 浏览器扩展从 [clipper/manifest.json](studio/clipper/manifest.json) 载入 [background.js](studio/clipper/background.js) 和 [content.js](studio/clipper/content.js)。剪藏写入 daemon [library.ts 路由](studio/apps/daemon/src/routes/library.ts) 的应用资产，素材库浏览走 `/api/materials/*`。Figma 插件由 [figma-plugin/manifest.json](studio/figma-plugin/manifest.json) 载入 `code.js` 与 `ui.html`，捕获格式见 [IR.md](studio/figma-plugin/IR.md)。 |

翻译查 [i18n/](studio/apps/web/src/i18n/)，从组件的 `useT()` 键追到 [locales/](studio/apps/web/src/i18n/locales/)，PA 进一步拆分在 [pa-ui/](studio/apps/web/src/i18n/pa-ui/)。

## 共享包与工程工具

### 把修改放到哪一层

| 模块 | 责任与入口 |
| --- | --- |
| [contracts/](studio/packages/contracts/) | Web、daemon 和独立消费者共用的纯 TypeScript 类型、解析规则和事件形状。先查 [src/api/](studio/packages/contracts/src/api/)、[src/index.ts](studio/packages/contracts/src/index.ts) 和对应的 feature 子入口。新增包子路径时检查 [exports](studio/packages/contracts/package.json) 和 [构建入口](studio/packages/contracts/esbuild.config.mjs)。 |
| [host/](studio/packages/host/) · [components/](studio/packages/components/) · [fantay-tokens/](studio/packages/fantay-tokens/) | Electron 给渲染器的宿主协议、共享 React 原语、Fantay 界面令牌。 |
| [sidecar-proto/](studio/packages/sidecar-proto/) · [sidecar/](studio/packages/sidecar/) · [platform/](studio/packages/platform/) | 依次是控制面业务 DTO、进程发现与生命周期和私有 IPC、通用 OS 进程原语。Web/daemon 的业务请求走 HTTP 和 `contracts`。 |
| [plugin-runtime/](studio/packages/plugin-runtime/) · [registry-protocol/](studio/packages/registry-protocol/) · [agui-adapter/](studio/packages/agui-adapter/) | 插件清单与运行规则、注册表协议及校验、应用事件到 AG-UI 的转换。I/O 由调用方注入。 |
| [dsh-runtime/](studio/packages/dsh-runtime/) · [tokentosea/](studio/packages/tokentosea/) | DeepSeek Harness 运行支持、启动与工具，以及 TokenToSea 客户端相关协议。 |
| [release/](studio/packages/release/) · [launcher-proto/](studio/packages/launcher-proto/) · [standalone/](studio/packages/standalone/) | 发布版本与元数据、启动器协议、分发验证和物化、激活与回滚。终端外壳和独立内容包可从 [terminal README](studio/shells/terminal/README.md) 的 sh/PowerShell 入口及 [Closure index.ts](studio/apps/closure/src/index.ts) 查起。 |
| [diagnostics/](studio/packages/diagnostics/) · [download/](studio/packages/download/) · [metatool/](studio/packages/metatool/) | 诊断归档与脱敏、可恢复及可校验下载、仓库工具构建元数据。 |

### 如何运行、打包和分发

| 操作 | 源码入口 |
| --- | --- |
| 开发进程启动、日志、状态与检查 | [tools/dev/src/index.ts](studio/tools/dev/src/index.ts)。`od` 的 [bin](studio/apps/daemon/bin/od.mjs) 加载编译后的 CLI，[daemon-url.ts](studio/apps/daemon/src/daemon-url.ts) 决定连接目标。直接启动与 sidecar 最终都经过 [daemon-startup.ts](studio/apps/daemon/src/daemon-startup.ts) 的 `startDaemonRuntime`。 |
| 安装包构建、运行与缓存 | 根任务为 `mise run studio:build:mac` 和 `mise run studio:build:windows`，分别在对应平台执行。[tools/pack/src/index.ts](studio/tools/pack/src/index.ts) 注册 macOS、Windows、Linux 命令，[workspace-build.ts](studio/tools/pack/src/workspace-build.ts) 管构建顺序。[打包测试](studio/tools/pack/tests/) · [打包约定](studio/tools/pack/AGENTS.md) · [缓存约定](studio/tools/pack/CACHE.md) |
| 自动更新失败、版本检测、升级后启动 | [desktop/main/updater.ts](studio/apps/desktop/src/main/updater.ts) 与 [updater/](studio/apps/desktop/src/main/updater/)。安装后的 payload 启动与交接查 [packaged/](studio/apps/packaged/src/)。本地 updater 夹具由 [tools/serve](studio/tools/serve/src/index.ts) 提供。[更新器测试](studio/apps/desktop/tests/main/updater/) · [更新生命周期文档](studio/docs/testing/updater-lifecycle.md) |
| 更新日志、漫画、安装包与发布清单 | 工作区的 [fantay-releases.ts](studio/packages/contracts/src/fantay-releases.ts) 保存结构化发布记录。[tools-release](studio/tools/release/src/index.ts) 注册 `next-version`、`sync-version` 和目录发布工具，[fantay-prepare.ts](studio/tools/release/src/fantay-prepare.ts) 从已验证的安装包准备校验和、发行说明和上传清单。界面看 [FantayReleaseNotes.tsx](studio/apps/web/src/components/FantayReleaseNotes.tsx) 与 [fantay-changelog/](studio/apps/web/src/components/fantay-changelog/)。发布版本用 `YY.MMDD.N`，材料与授权见 [版本约定](studio/AGENTS.md#calendar-versions-and-release-records)。[版本测试](studio/tools/release/tests/fantay-version.test.ts) · [漫画测试](studio/apps/web/tests/components/FantayChangelog.test.tsx) |
| 官网、下载页与分享服务部署 | 官网从 [website/build.ts](studio/website/build.ts) 生成独立静态产物，公开分享部署从 [deploy/share/](studio/deploy/share/) 查。两处有各自的 Caddy 配置，服务端问题先核对实际部署采用的入口。[官网构建](studio/website/README.md) · [部署说明](studio/deploy/README.md) |
| GitHub 验证和仓库规则 | [.github/workflows/ci.yml](.github/workflows/ci.yml) 手动触发，只读权限下执行 frozen-lockfile 安装、`guard` 和 `typecheck`。[CODEOWNERS](.github/CODEOWNERS) 管模块归属，[scripts/guard.ts](studio/scripts/guard.ts) 管仓库规则。 |

## 本机工作区

下列目录在当前电脑可用。新检出时可先确认路径存在，再按所属项目的说明运行。

| 范围 | 查找与修改入口 |
| --- | --- |
| 素材库网页、书签和索引 | [素材库/index.html](素材库/index.html) → [导览支持/](素材库/导览支持/) 的 `archive.js`、`websites.js` 和样式。网页服务在 [serve.py](素材库/导览支持/scripts/serve.py)，书签在 [bookmarks.py](素材库/导览支持/scripts/bookmarks.py)。编目从素材和 `entry.json` 等输入生成 [catalog.json](素材库/导览支持/catalog.json)、`catalog.js`、`assets.jsonl` 和搜索索引，入口是 [build_catalog.py](素材库/导览支持/scripts/build_catalog.py) 与 [verify_catalog.py](素材库/导览支持/scripts/verify_catalog.py)。查询当前收录数量用 [catalog-summary.json](素材库/导览支持/catalog-summary.json)。 |
| 素材库 CLI 与 Studio 接入 | [fantasy_design.py](素材库/导览支持/scripts/fantasy_design.py) 提供查询、取用，`mise run cli` 从根目录转发。[CLI 使用说明](素材库/导览支持/CLI使用说明.md) · [素材库 mise](素材库/导览支持/mise.toml) · [Studio 素材库路径解析](studio/apps/daemon/src/materials/root.ts)。 |
| 设计系统软链接和导航图标工具 | 根目录的 `设计系统` 指向 [studio/design-systems/fantay/](studio/design-systems/fantay/)。已纳入 Git 的 [tools/feature-icons/](tools/feature-icons/) 含 Kubai 图标源码、展示页、自检和 [同步脚本](tools/feature-icons/scripts/sync-studio.mjs)，该脚本生成 Web 的图标运行文件。 |
| Rust / GPUI 原型 | [rust/README.md](rust/README.md) 记录暂停决定和原型范围。[Cargo.toml](rust/Cargo.toml) → [src/main.rs](rust/src/main.rs) → [app.rs](rust/src/app.rs)；文档、存储、媒体在 [document.rs](rust/src/document.rs)、[storage.rs](rust/src/storage.rs)、[media.rs](rust/src/media.rs)。验证任务在 [rust/mise.toml](rust/mise.toml)。 |
| 剪映独立研究与 Palmier 历史源码 | [doc/剪映/](doc/剪映/) 有独立 CLI、格式验证和研究报告，运行入口见 [mise.toml](doc/剪映/mise.toml)。应用内草稿引擎在 [studio/vendor/jianying-draft/](studio/vendor/jianying-draft/)；原生 Palmier 的 Swift、Metal 和测试收在 [退役归档](doc/achieve/studio-retirement-20261107/files/native/palmier/)。 |
| PA 研究、LoopBack | [doc/PA/](doc/PA/) 保存早期产品方案与验收记录。[LoopBack README](doc/PA/插件/LoopBack/README.md) 对应独立的 macOS 应用和 HAL 音频驱动，入口为 [Package.swift](doc/PA/插件/LoopBack/Package.swift)、[Swift app](doc/PA/插件/LoopBack/Sources/FantayLoopBack/FantayLoopBackApp.swift) 与 [驱动](doc/PA/插件/LoopBack/Driver/FantayLoopBackDriver.cpp)。 |

历史研究、供应商原始代码和生成资源适合做对照。定位当前行为时，从运行入口或生产调用方倒查，尤其注意同名的库、编辑器、旧包装器和独立原型。

## 运行与验证

从仓库根目录执行。依赖安装步骤见 [Studio 快速开始](studio/QUICKSTART.md)，Node 和 pnpm 由 [studio/mise.toml](studio/mise.toml) 管理。

```sh
mise tasks
mise run studio
mise run studio:status
mise run studio:canvas
mise run studio:guard
mise run studio:typecheck
```

`studio` 前台启动 Electron。后台模式用 `studio:start` 和 `studio:stop`，需要先构建设计文档编辑器并后台启动时用 `studio:desktop`。改动需要隔离运行时，先查 [daemon 数据目录约定](studio/AGENTS.md#daemon-data-directory-contract) 和 [e2e 运行约定](studio/e2e/AGENTS.md)。

按包和用例选择验证。以下测试路径分别相对 Web、daemon、e2e 包目录。

```sh
mise run studio:test -- pnpm --filter @open-design/web test tests/components/DesktopAppGate.test.tsx
mise run studio:test -- pnpm --filter @open-design/daemon test tests/runtimes/execution-permissions.test.ts
mise run studio:test -- pnpm --filter @open-design/e2e exec playwright test -c playwright.config.ts ui/fantay-shell.test.ts --workers=1
```

| 修改范围 | 验证落点 |
| --- | --- |
| 单组件、状态和格式解析 | 所属应用或共享包的 `tests/`。涉及启动、跨组件导航或真实 daemon 生命周期时，选相应 [e2e/](studio/e2e/) 用例。 |
| HTTP / SSE 或 CLI 变更 | 对应路由与服务测试，配合 [Web provider 测试](studio/apps/web/tests/providers/)。检查创建、失败、重连、授权和保存回读中受改动影响的路径。 |
| 桌面系统能力、打包和更新 | [desktop/tests/main/](studio/apps/desktop/tests/main/) 和 [packaged/tests/](studio/apps/packaged/tests/)，需要运行产品时从 Electron 入口验证。包体和更新链的验收路径见 [pack 说明](studio/tools/pack/AGENTS.md)。 |
| 素材与设计规则 | `mise run library:check` 和 `mise run system:check`。变更编目输入后用 `mise run library:catalog` 重建并验证。根目录的 `mise run check` 组合这两类检查及 Studio guard、typecheck，需要本机素材库。 |
| 跨应用核心业务与 UI | [e2e/specs/](studio/e2e/specs/) 是核心业务链，[e2e/tests/](studio/e2e/tests/) 是跨模块检查，[e2e/ui/](studio/e2e/ui/) 是 Playwright。按 [覆盖状态](studio/docs/testing/e2e-coverage/status.md) 选用例。 |

[studio:test 包装器](studio/scripts/fantay-test.ts) 记录命令结果并清理失活的测试缓存，日志和保留规则见 [测试结束后的自动清理](studio/docs/testing/test-cleanup.zh-CN.md)。全量门禁和用例范围按 [Studio 验证约定](studio/AGENTS.md#local-validation-scope) 选择。

### 从代码反查调用方

在仓库根目录运行，或把示例改成待排查的函数、翻译键和路由片段。

```sh
rg -n 'streamViaDaemon|registerRunRoutes|startChatRun' studio/apps studio/packages/contracts
rg -n 'registerBoardRoutes|/api/projects/:id/board' studio/apps/daemon/src
rg --files studio/apps/web/tests studio/apps/daemon/tests studio/e2e | rg 'memory|personal-agent'
git status --short -- studio/apps/org-server studio/native-tool
git check-ignore -- rust/ 素材库/ doc/
```

功能入口、接口或测试移动后，顺手更新此地图里的链接。生产行为沿注册处确认，包名和命令沿对应的 `package.json` 与 `mise.toml` 确认。
