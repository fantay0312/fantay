# 动画工作台本地验收 · 2026-10-28

本次新增 `/movies`，保留已有设计体系和素材库；实现范围、接口和客户端边界见 [movie-studio.md](movie-studio.md)。未提交、推送或部署。

后续已完成 Claude Code 与 DeepSeek Harness 的真实模型验收；下面保留的是首轮记录，当前状态见 [movie-integrations-20261028.md](movie-integrations-20261028.md)。Claude App 未被操作或改动。

## 验证结果

- Web：5 个聚焦测试文件、22 个测试通过，包含路由、两套身份侧栏、对话技能传递、在途轮询不覆盖草稿、较早创建不覆盖后续打开项目。
- Daemon：2 个聚焦测试文件、7 个测试通过，包含版本冲突、确认失效、风格快照、审片门槛、路径/符号链接拒绝、转义和视频播放/暂停/定位。
- Web / daemon typecheck 通过；repository guard 通过；`git diff --check` 通过。
- 本地 MCP SDK 客户端握手通过，列出 5 个工具，读取 `text/html;profile=mcp-app` 工作台资源，并通过工具得到当前影片链接。此结果不代表实际 Claude Desktop / DeepSeek 客户端已经连接。
- 真实本地输出：12 秒、1920×1080、H.264 MP4；还完成一个含项目内视频素材的 3 秒示例。最终源码保留独立 motion-source 播放器，完整 ZIP 已下载并检查条目。
- 桌面与 390px 窄屏检查覆盖片库和工作台。最后的修复保留原有视觉，增加异步响应隔离、内联 composer 和独立播放器。

## 本地证据

所有自动化临时文件在 `.tmp/movie-studio/`：

- `web-tests.log`、`race-test.log`、`video-test.log`、`store-test-focused.log`。
- `web-typecheck.log`、`daemon-typecheck.log`、`guard-final.log`。
- `library-desktop.png`、`library-mobile.png`、`workspace-desktop.png`、`workspace-mobile.png`。
- `fantay-demo.mp4`、`fantay-demo-delivery.zip`、`delivery-result.json`。
- `video-demo.mp4`、`video-demo-result.json`、`video-frame.png`。

演示项目 `bc9a03ec-7d16-4045-9135-58b2432a4dde`。其中的审片通过用于验证产品流程，记录中已明确注明不是用户创意签收。

## 尚未声称完成的验收

本机 `/api/agents` 检测 Claude Code、Codex CLI 可用，DeepSeek TUI、DeepSeek Harness 不可用。未替用户安装或登录这些客户端，未修改其配置。网页内的真实 AI 创作质量、外部客户端的 MCP Apps 内嵌显示仍需使用相应账户与客户端验收。

MP4 无音轨是当前模板的明确行为；本次没有生成配音或配乐。视觉检查不替代用户对影片风格与内容的最终验收。
