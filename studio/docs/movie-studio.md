# Preview capability and CLI integration

Use od movie integration --json to read the same
/api/movie/integration?include=capabilities response used by the app.
capabilities.preview contains available and renderer (browser, desktop or
null). An explicitly configured HYPERFRAMES_BROWSER_PATH takes priority.
Otherwise, availability requires a running desktop that advertises frame
rendering; a callback merely being present does not establish availability.
The sidecar readiness probe is bounded to 1.5 seconds and cached for at most
10 seconds. It does not start a browser or invoke a generation provider.

The create host and film-file editor are connected to the project workspace.
Legacy movie routes redirect to the canonical file editor, and the MCP Apps
surface remains separate. Board assembly and visual polish are tracked
separately; backend capability readiness does not imply a finished board UI.

## Fantay 动画工作台

本地入口：`/movies`，具体作品使用 `/movies/:projectId`。旧的 `?project=` 链接仍可打开并转入新路径。对话中的工作台卡片直接进入完整制作页，不再弹窗嵌入整套应用。首页点击「动效设计」会携带当前创作想法进入工作台，共用模型选择和项目记录；首页原草稿保留。

## 已实现

- 四种开拍方式：从库里选、改一个风格、用我的风格、从空白开始。
- 六种内置代码动画风格；可编辑名称、颜色、字体和入场方式，并固化为个人风格。
- 同屏风格、逐镜分镜、样张、MP4 渲染、时间点审片、完整交付包。
- 制作页以画面预览和镜头时间线为主，右侧可切换「制作设置 / 与 AI 对话」，不再默认留出空白对话列。Next.js 开发工具悬浮入口已关闭。
- 逐镜修改标题、字幕、时长、布局，添加/删除/前移镜头；支持项目内图片与视频路径，兼容现有 AI 素材生成工具。
- 预览、样张与导出使用同一份 GSAP 时间线。当前内置动画默认无声，不生成配音或音乐。
- 真实项目及对话持久化，复用现有模型选择器。专用对话加载 `fantay-movie` 技能，指导 Agent 通过同一接口改片。
- 修改画面、风格、画幅或片名会使旧的分镜/样张/审片确认失效。保留所有渲染版本，不覆盖旧 MP4。
- 审片通过且无未解决批注后，下载 ZIP，包含成片、动画源码、本地 GSAP、素材、风格/分镜/审片记录。

## 数据与权限

每部影片是现有项目系统中的 `kind: video / intent: motion-design` 项目。项目文件夹内的 `movie-studio.json` 是工作流真源，路径解析遵守根 `AGENTS.md` 的 Daemon data directory contract。它与媒体临时任务表分开保存。

所有写入携带 `expectedRevision`，按项目串行写入，并通过原子替换保存；冲突返回 409。渲染及导出沿用项目授权检查。素材只允许项目内相对路径，拒绝目录穿越和符号链接。后台渲染回写独立版本状态；重启后的未完成渲染标记失败，可重新制作。

风格快照属于影片项目。片库通过当前有权访问的影片汇总个人风格，不修改外部素材档案，也不跨账户缓存。

## UI / HTTP / CLI

| 功能 | HTTP | CLI |
| --- | --- | --- |
| 读取 | `GET /api/projects/:id/movie` | `od movie get --project ID --json` |
| 保存 | `PUT /api/projects/:id/movie` | `od movie save --project ID --file document.json --json` |
| 阶段操作 | `POST /api/projects/:id/movie/actions` | `od movie approve-storyboard / approve-samples / save-style / render / approve-review / deliver` |
| 审片 | 同上，`add-note / resolve-note` | `od movie add-note --time 2.5 --text "…"`、`od movie resolve-note --note ID` |
| 交付包 | `GET /api/projects/:id/movie/delivery` | 由 `od movie deliver` 准备，下载同一接口 |
| 片库与创建 | 原有项目创建 API + 影片 API | `od movie styles`、`od movie create --name "…" --mode library --style fantay --prompt-file brief.txt` |

CLI 支持 `--json`、`--prompt-file <path|->`、`--daemon-url`、`--web-url`、工作区身份参数。先读最新 revision，再保存。`render` 返回任务已接受，不代表出片完成，须读取 `renders[].status`。

## 外部 Agent / Claude Desktop

`od movie mcp` 提供 stdio MCP：`open_movie_studio`、`list_movie_styles`、`create_movie`、`get_movie`、`save_movie`、`movie_action`、`wait_movie_render`。`ui://fantay/movie-studio.html` 使用 MCP Apps 资源协议和 `ui.resourceUri` 元数据，内嵌本地工作台；不支持 MCP Apps 的宿主仍可使用返回的工作台链接和数据工具。工具返回明确的四种开拍含义，以及实际工作台、视频和交付链接。CLI 的 `movie wait` 与 MCP 共用等待逻辑，浏览器地址从运行中的服务发现。

片库底部可获取本机连接配置并复制。配置不会自动写入 Claude 桌面端，也不会开放公网端口。2026-10-28 已实际验证 Claude Code → Movie MCP，以及 DeepSeek Harness 0.2.1-rc.3 → Fantay 运行服务 → Movie CLI 的完整模型工作流。用户明确要求不操作 Claude App，因此没有修改、重启或自动操控它；Claude App 内的内嵌展示仍待用户手动接入后验收，不与 CLI 成功混为一谈。详细证据见 [movie-integrations-20261028.md](movie-integrations-20261028.md)。

协议参考：[MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps)、[官方构建指南](https://modelcontextprotocol.io/extensions/apps/build)。

## 运行与边界

运行项目根的 `mise run studio`，或沿用 `mise run studio:start`。MP4 复用现有 HyperFrames 渲染器：默认走桌面渲染服务，Web-only 开发需显式提供 `HYPERFRAMES_BROWSER_PATH`。本机已在被 Git 忽略的项目 `.env.local` 中配置现有 Chrome 路径，标准启动会继续读取它；未改全局环境、安装或下载浏览器。其他机器需按实际安装位置配置。

UI 支持的当前文档上限为 60 个镜头、总长 300 秒、单镜头 1–30 秒。字幕是画面文本，没有独立 SRT 音轨时间线。AI 生成仍由现有配置和媒体权限控制，不为新工作台另行保存密钥或添加模型账户。素材库引用写入创作要求，实际素材需由 Agent 读取许可后复制到项目。

## 验证入口

```sh
mise x -- pnpm --filter @open-design/daemon exec vitest run tests/movie/store.test.ts
mise x -- pnpm --filter @open-design/web exec vitest run tests/router-movies.test.ts tests/components/EntryNavRail.materials.test.tsx tests/components/workspace/useConversationChat.test.tsx
mise x -- pnpm --filter @open-design/web typecheck
mise x -- pnpm --filter @open-design/daemon typecheck
mise x -- pnpm guard
```

参考视频仅用于理解工作流；未把原视频或其画面作为内置风格素材复制。
