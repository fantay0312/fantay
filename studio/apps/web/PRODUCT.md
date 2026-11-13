# Integration implementation status

The project board and design-document APIs, local media operations and movie
preview capability endpoint are available independently of the frontend
assembly. The board tab is still controlled by FANTAY_BOARD_READY; enabling
it requires the real ProjectBoard host and the remaining workspace
integration. Legacy movie/materials/account redirects and the global create
hosts are connected and covered by focused browser checks. Board assembly
and visual design are tracked separately.

## Fantay

<!-- impeccable:product-schema 1 -->

## Platform

desktop

Fantay ships only as a desktop application for macOS and Windows.
The React/Next.js renderer in this directory is an internal part of the
Electron application, not a separately supported browser product. Normal
browser entry displays a desktop-app handoff without mounting the workspace.
The design canvas is a locally bundled OpenPencil module. TokenToSea is the
account and service entry; public deliverable sharing and login callbacks
remain supporting services.

## Users

个人创作者使用自己的设计素材库和已配置的 AI Agent 制作可编辑作品。

## Product Purpose

把设计体系、素材库、对话和作品预览放在一个工作区。动画制作以代码动画为主，兼容 AI 生成的图片/视频素材，从风格、分镜、样张、出片、审片到交付在同一界面完成。

## Operating Context

Fantay 是本地优先、仅提供桌面端的 open-design 二次开发。桌面界面使用本地 daemon 与已配置的 Agent；外部 Agent 通过 CLI/MCP 读写相同项目。用户明确要求延续 Fantay 现有设计，参考 Lemo Movie Studio 的制作流程，不复制它的品牌或视频素材。

## Capabilities and Constraints

动画工作台的设计与接口见 `../../docs/movie-studio.md`。具体模型是否可用取决于当前安装、登录及配置，不以品牌名称代替实测。UI 变更不授权提交、推送、部署或修改外部客户端设置。

## Brand Commitments

桌面端以 Palmier 的克制桌面工作区为视觉依据：统一中性表面、细分隔线、紧凑控件与清晰的素材 / 预览 / 检查器 / 时间线。浅色与深色默认跟随系统；品牌色不作为大面积装饰。网页及作品内容的设计令牌不被桌面外壳覆盖。

动画工作台使用完整页面，与首页共用创作想法、模型和项目入口。禁止把整套应用再嵌入对话弹窗，禁止重复侧栏与导航。画面预览和镜头是主区域，制作设置与 AI 对话在同一侧栏切换。

首页的动画模式使用 `/create/animation[/projectId]`，独立工作台保留 `/movies[/projectId]`，二者共用同一组件、项目文件及模型配置。MCP 的 `/movie-app[/projectId]` 是去掉应用外壳的同一工作台，不在宿主对话里重复全局侧栏。片库、四种开拍方式、分镜生成、样张、渲染、版本审片和交付须连贯；AI 修改不自动代表用户确认。

首页的「一句话生成影片」明确授权本次自动完成分镜、真实样张与 MP4；默认保留「先看分镜」人工分步入口，最终审片与交付仍需用户确认。完整样片必须包含连续事件、逐镜画面与对象运动，不能只替换颜色、文字和贴图。风格卡片直接播放真实完整 MP4。

从空白开始时不继承样例风格。AI 根据创意自行设计镜头、图形、关键帧和镜头运动；用户可以先预览并保存原创风格，再回主页选择「用我的风格」复用整组动画。画面动作说明与画面上的字幕分开，预览覆盖每个镜头的多个时点。

制作流程以「方案 / 制作 / 审片」组织。方案中的真实样张支持逐镜批注；审片支持成片缩略时间轴、逐帧查看、时间点、时间段和整片意见。意见保留来源版本，用户明确发送的意见才进入本次 AI 回改。新版本生成后标记为待确认，逐条确认与最终交付分别由用户操作。无音轨影片不得使用模拟波形。

新建区同时支持代码动画与视频剪辑。视频剪辑从已有视频素材库选择，也可上传 MP4、MOV、WebM 入库；创建项目后复制原片、保留来源，AI 根据真实帧和本地语音转写安排截取、倍速、原声、逐段字幕与叠加动效。成片和代码动画共用审片回改与交付。语音转写与 AI 撰写的解说文案必须区分，最终交付包含字幕 SRT、MP4 和可编辑源文件。

## Evidence on Hand

2026-11-03 latest decision: all daily video editing stays in the project pane
with AI and manual operations sharing one document and history. Windows and
macOS use the same React/Electron/FFmpeg pipeline. There is no separate full
editor launch. Former native timelines are imported with backups and explicit
compatibility notices; see ../../docs/unified-video-editor-20261103.md.


2026-10-30 latest correction: entering video creation stays inside the main
app, with a working compact editor on the right and an explicit action to open
the full native editor. All videos and animations have one permanent overview.
Native-linked films are previewed and edited through their actual native
timeline, preserving the original document rather than reviving stale Web
copies. Desktop home/settings and native home/settings retain the shared
surface palette. The native AI sidebar keeps the original message renderer.

2026-10-29 correction: footage editing uses a dedicated Palmier-referenced
workspace (`/movie-app/:id`), with media bin, viewer, inspector/AI and a fixed
timeline. Its surface rules live in `src/components/movie/DESIGN.md`. Manual
and real-agent structural editing are validated together; the prior inline
timeline must not be treated as the accepted visual standard. TokenToSea is
the user's selected provider for generated video materials.

用户提供了本地 Lemo Movie Studio 参考视频，确认第一版以代码动画为主、兼容 AI 素材。现有源代码提供素材库接口、多 Agent 对话和 HyperFrames 渲染。
