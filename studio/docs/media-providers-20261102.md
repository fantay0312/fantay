# FantayDesign 媒体提供商与设置界面补齐

2026-11-02。本次为本地桌面应用更新；未提交、推送或发布到外部环境。

## 实现范围

- 原“即将上线”的 8 家提供商均可配置，统一通过现有 API / CLI / 后台媒体任务调用；移除设置中的路线图抽屉。
- 提供商是否出现在模型选择器中仍取决于凭据、代理地址和本地工作流，避免把未配置服务当成可用模型。
- 提供商列表、设置页签、通用按钮及项目/素材标签使用足够的文字行高，保留长名称省略，修复 g / y / p / q / j 下伸部分裁切。
- “关于”和更新窗口打开本地 FantayDesign 更新说明；取消上游发布页回退、上游宣传图片及帮助菜单外链。真实第三方许可证和内部兼容标识保留。
- 成员、工作区设置和大盘旧深链接入实际成员目录、可访问项目及 TokenToSea 管理入口。删除不可达的旧导入/企业版占位；现有 Figma 导入、项目引用、团队设计系统和评论继续使用已有实现。

## 提供商协议

| 提供商 | 已实现接入 | 配置要求 |
| --- | --- | --- |
| Black Forest Labs | `x-key`、提交任务、状态轮询、下载图片；支持 FLUX.2 Pro 和可配置模型 | BFL API key |
| ComfyUI | API 节点图、引用图上传、`/prompt`、`/history`、`/view`；图片/视频/音频输出 | 本地地址、API 格式工作流；认证可选 |
| Google AI / Vertex | Gemini Interactions 图片/视频/音频，Vertex `generateContent`、Veo 长任务、Lyria | Gemini API key；Cloud 模型需项目/区域 publisher URL 与 access token |
| Kling | 当前 Kling 3.0 提交/任务接口；旧接口 AK/SK JWT 兼容 | API key 或 `AccessKey:SecretKey` |
| Replicate | 模型版本/schema 查询、提交、轮询、结果保存；按 schema 构造输入 | API token、可选 `owner/name[:version]` |
| Midjourney (proxy) | novicezk/midjourney-proxy 的提交、轮询及图片保存 | 用户自有代理地址；`mj-api-secret` 可选 |
| Suno (proxy) | gcui-art/suno-api 的生成与 `/api/get` 轮询；默认由网关选择模型 | 用户自有代理地址；可选网关认证与模型 |
| Udio (custom gateway) | 下述明确的 FantayDesign music gateway v1 契约 | 用户自有网关地址及网关 key |

用户已确认当前没有 Midjourney、Suno、Udio 代理，先完成可配置接入。它们没有被冒充为无需配置的官方公共 API，也没有注册、购买或启用任何代理服务。

### ComfyUI

在提供商的 Model 文本框粘贴 **API 格式** JSON（每个节点包含 `class_type` 和 `inputs`），或填写当前项目内的 JSON 文件相对路径。普通 UI workflow JSON 不适用。

在正向文本节点中使用 `{{prompt}}`；引用图节点使用 `{{image}}`。支持 `{{seed}}`、`{{width}}`、`{{height}}`、`{{duration}}`，完整占位值保留数字类型。工作流必须包含与选择的媒体类型匹配的 Save 节点；模型、节点和插件由本机 ComfyUI 实例提供。

### Udio 自定义网关

这是本应用支持的显式网关契约，**不是 Udio 官方 API**。网关运营者负责实际 Udio 接入及账号授权；不要把 Udio 网站 Cookie 填入本应用。

```text
Authorization: Bearer <gateway-key>
POST <Base URL>/generations
{provider:"udio", model:"udio-v2", prompt, duration_seconds:30, instrumental:true}

=> {id, status:"queued"|"processing"|"completed"|"failed"}

GET <Base URL>/generations/<id>
=> {id, status:"completed", outputs:[{url, mime_type:"audio/mpeg"}]}
```

无网关地址时模型不会显示为可用；上游失败、超时、空结果或返回 HTML 均报错，不写入伪造的成功媒体文件。带认证的轮询不向任意返回地址转发密钥，外部产物下载继续使用现有地址校验边界。

## 一手来源

- [BFL 生成与轮询](https://docs.bfl.ai/quick_start/generating_images)
- [Replicate HTTP API](https://replicate.com/docs/reference/http)
- [ComfyUI 路由](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [Gemini 图片](https://ai.google.dev/gemini-api/docs/image-generation)、[视频](https://ai.google.dev/gemini-api/docs/video)、[音乐](https://ai.google.dev/gemini-api/docs/music-generation)
- [Kling 认证](https://kling.ai/document-api/api/get-started/authentication)
- [midjourney-proxy](https://github.com/novicezk/midjourney-proxy)
- [suno-api](https://github.com/gcui-art/suno-api)
- [Udio 官方公共 API 说明](https://help.udio.com/en/articles/10756277-udio-public-api)

接口依据文档及模拟响应验证；未调用真实收费模型。账号权限、地区、额度、网关部署和本地模型安装仍由实际配置决定。

## 验证记录

后台 77 项、设置与模型选择 166 项、更新窗口 26 项通过（合计 269 项）；全仓 typecheck、guard、媒体目录同步检查通过。打包安装和桌面截图记录位于 `.tmp/launch-completion-20261102/`。

## 历史决定检索

Nowledge Mem MCP：query=`FantayDesign media providers planned coming soon OpenDesign brand desktop install`，请求 mode=`normal`，返回 retrieval_mode=`strict`，scope=`default`，filters=无。

| 排名 | Memory ID | 标题 | relevance_score |
| --- | --- | --- | --- |
| 1 | d8abf674-1d39-4fad-a1a8-6464b506e87e | Fantaydesign 统一品牌、内置更新说明与三项上游能力核验（2026-10-29） | 0.8377078426713653 |
| 2 | c5be0402-0434-40f9-95c8-603bd36ce5fb | FantayDesign 设置页：媒体提供商并入模型与提供商，外观并入通用 | 0.8241104979711471 |
| 3 | c46cbeb8-8c02-4088-ac45-10651643d27d | Fantaydesign integration: W2 merged into studio, W3 interrupted, handoff in doc/progress.md | 0.8105960125577778 |
| 4 | 5f40f4e9-400e-48b6-b740-f11f342c5e4b | Fantaydesign 开场字标与离线动画资源边界（2026-10-29） | 0.7616793033195588 |
| 5 | 5de1681f-123d-4bcf-81ee-28e113c0df40 | FantayDesign 仅做桌面端，不再提供独立网页版 | 0.7528866858749228 |

当前代码与测试为最终行为依据。记忆图工具不可用，且无法确认浏览器图视图执行相同空间权限，故未显示图谱。

## 2026-11-03 本机交付

已安装 `/Applications/FantayDesign.app`，版本保留 `0.25.1`。由于工作区存在持续的并行修改，最终安装包来自固定快照；快照内 16,063 个源文件在构建期间未变化，不代表之后工作区中的所有改动均已装入。

用户反馈更新通知不符合产品基调后，更新通知、发布记录和更新操作窗口统一调整为中性表面、细分隔线、小尺寸品牌图标、清晰分项文字及右下角普通按钮。发布记录弹窗使用独立层级，实测能显示在设置窗口上方。

- 固定快照回归：daemon 80 项、桌面渲染层 204 项、共享生成契约 54 项，共 **338 项通过**。
- 真实桌面检查：8 家提供商均有可编辑表单，ComfyUI 有工作流文本框；23 个提供商标签的文字高度均足够容纳 `gypqj`，长名称省略仍保留。
- 通知与发布记录弹窗实测可见、未被遮挡；窗口宽 460px，圆角 16px。临时通知已读标记已恢复。
- 安装包校验及应用深层严格签名验证通过。仅用于本机安装，未做公共发布或公证。
- 7 个项目、2 个账号会话、2 个本地视频工程和其他受保护数据保持一致；数据库仅插件市场的刷新时间发生预期变化。
- 样式扫描保留了既有下载进度条的 `width` 动画提示；没有新增弹窗尺寸或布局动画。

最终证据：[交付记录](/Users/fantasy/Documents/备战%20408/设计/fantay-design/studio/.tmp/launch-completion-20261102/completion.json)、[通知弹窗](/Users/fantasy/Documents/备战%20408/设计/fantay-design/studio/.tmp/launch-completion-20261102/notification-after.png)、[发布记录弹窗](/Users/fantasy/Documents/备战%20408/设计/fantay-design/studio/.tmp/launch-completion-20261102/release-after.png)。
