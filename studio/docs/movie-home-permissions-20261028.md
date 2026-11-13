# 主页动画创作与执行权限收紧

## 用户决定

本工作区默认使用 DeepSeek Harness。用户后续明确纠正：**Claude Code 不应禁用，只是暂时不测试**。已撤掉 `OD_DISABLED_AGENTS=claude`，保留 Claude Code 的选择与执行能力；当前只跳过自动探测，验证工作继续使用 DeepSeek，不操作 Claude App。

## 实现

- 当前设置为 `OD_SKIP_AGENT_PROBES=claude`、`OD_PREFERRED_AGENT=deepseek-harness`、`OD_DSH_TOOL_POLICY=project`。应用配置通过原有 API 保存 DeepSeek 选择。配置未包含密钥。
- `runtimes/access-policy.ts` 的通用禁用机制仅在显式配置时生效；本工作区已不再禁用 Claude。自动列表通过静态路径发现展示它，不启动 CLI 做探测。
- 移除本仓库 Claude 适配器默认的 `bypassPermissions`，恢复 `default` 权限模式。未修改外部 Claude 配置。
- DeepSeek 连接组件更新为 0.1.4。每次创建或恢复会话都安装最终工具 guard，拒绝自动批准升级。未知工具、任意 shell、网络工具、子代理与外部文件访问均拒绝。
- 一般文件工具只允许当前项目路径，拒绝越界、符号链接、硬链接及常见凭据路径。影片 JSON 必须经版本检查接口保存，不能通过直接写文件绕过审批状态。
- 三个影片专用工具固定到当前项目和本机服务：`fantay_movie_get`、`fantay_movie_save`、`fantay_movie_save_style`。它们不能换项目或服务地址。渲染、分镜/样张确认、审片通过、交付和批注解决仍由工作台的按钮执行。

这是 Agent 工具层的访问限制，不能替代操作系统隔离；Harness 自身的模型网络连接和会话持久化仍按其正常机制运行。没有修改用户的 Harness 凭据或其他 profile。

## 主页体验

- 风格库在左侧、创作需求在右侧；移动端先显示需求输入。
- 草稿按工作区保存在当前浏览器，刷新后恢复名称、需求、画幅和风格；转为正式影片后清除创建草稿。
- 片库支持名称搜索和全部/制作中/已交付筛选，旧成片与当前内容版本分开判断，改稿后显示待重新出片。

## 验证

- 上一轮曾验证 `403 AGENT_DISABLED`，该禁用设置现已按用户纠正撤销。最新列表显示 Claude 与 DeepSeek 均可用；没有再次发起 Claude 连接测试或模型任务。
- 真实项目 `25544fd6-91da-41cc-947f-f27997f81b35` 从新版主页启动，DeepSeek 通过 `fantay_movie_get` / `fantay_movie_save` 生成 3 个各 2 秒镜头，没有使用 shell。分镜、样张确认和渲染通过页面完成。
- 页面审片和交付也已完成；下载的 `restricted-film.mp4` 为 6.000 秒、1920×1080、H.264，交付包为 `restricted-film-delivery.zip`。这些是技术测试，不代表用户创意签收。
- 桌面创建页的主操作在首屏可见；390 像素断点的页面内容宽度同为 390。创建草稿与风格刷新恢复、转为正式影片后清除草稿均已检查。截图为 `creator-refined-desktop.png`、`creator-refined-mobile.png`。
- 20 项连接组件测试覆盖路径越界、链接/凭据别名、未知工具、固定 HTTP 目标与无 guard 时拒绝运行；32 项运行环境与代理策略测试覆盖零探测执行及环境变量不可降级；58 项相关 Web 测试覆盖草稿与原有主页/工作台行为。类型检查与仓库 guard 通过。

本次不提交、不推送、不部署。证据存于 `.tmp/movie-reference-v2/`。
