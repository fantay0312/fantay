# Personal Agent 执行模式

未配置 `OD_PA_CONFIG` 时，Fantay 使用个人模式和现有 PA 数据。配置文件由启动 daemon 的环境传入，应是仅所有者可访问的 JSON 文件。模式在 daemon 启动时选择。企业模式每个实例绑定一个租户，使用独立 SQLite、记忆目录和产物目录。两种模式使用同一任务状态机。

## 配置

顶层字段为 `version: 1`、`mode`，以及可选的 `sandbox`、`workers`、`leaseMs`、`maxHandoffs`。个人模式可单独配置 OCI 沙盒或远端执行器。企业模式另需 `enterprise`。字段类型和取值见 [配置校验](../apps/daemon/src/services/pa/config.ts)。

| 配置 | 内容 |
| --- | --- |
| `sandbox` | 已安装并经审核的镜像 ID，形如 `sha256:…`。执行器要求本机 Unix 套接字、Linux 容器引擎和 seccomp。可通过 `engineSocket` 指定套接字，或通过 `runtime` 选择引擎上安装的隔离运行时。镜像须包含 `/bin/sh` 和 `/usr/bin/timeout`，且不得声明自动挂载卷。 |
| `workers` | 每台执行器的 `id`、`tokenSha256`、毫秒时间戳 `expiresAt` 和 `capabilities`。能力可选 `shell` 或 `ollama`。Ollama 执行器另列允许的 `models`，推理时必须关闭 Ollama 云功能。 |
| `enterprise.members` | 成员 ID、`admin`／`operator`／`viewer` 角色、组、令牌摘要、授权版本和到期时间，以及可选的 `permissions`。`permissions` 目前只有 `library.manage`，授予后 `operator` 也能管理角色库。桌面 PA 使用成员令牌解锁。CLI 通过 `--access-token-file` 或 `OD_PA_ACCESS_TOKEN_FILE` 读取成员令牌，`od pa mode` 返回当前成员的角色和 `canManageLibrary`。 |
| `enterprise.orgServer` | 可选。跟随一台 [企业服务器](../apps/org-server/README.md)：`url`（HTTPS，或回环地址）、`credentialFile`（仅所有者可读的文件，内容是带 `directory.sync` 和 `library.sync` 范围的服务凭据）、`refreshSeconds`（同步间隔，默认 60）。配置后 `members` 可以留空，`budgets.groups` 须包含 `default`。 |
| `enterprise.budgets` | 分别配置租户、组和角色的 UTC 日额度。额度含模型调用次数、沙盒运行时间预留和金额预留。金额以百万分之一美元记账。实际扣费与价格上限由供应商管理。 |
| `enterprise.gateway` | 固定的模型 API 地址、获准模型、输出 token 上限、每次调用的金额预留和凭据引用。凭据可来自本机私有文件或 Vault KV v2。Vault token 应只获准读取对应的密钥路径。 |
| `enterprise.auditSigningKeyFile` | Ed25519 私钥文件。管理员可用 `od pa audit` 导出签名检查点，并把检查点及公钥保存在数据库之外。随后用 `od pa audit-verify --file <检查点文件>` 核对历史。 |

运行 `od pa provision-token --file <新令牌文件>` 生成成员或执行器令牌。命令只输出摘要，摘要填入配置，令牌文件通过部署方的凭据渠道交付。管理员可用 `od pa revoke --file <JSON>` 撤销成员或执行器。JSON 包含 `kind` 和 `id`。

## 企业模式的陪伴

企业模式把权限分成两个面，互不越界。

| 面 | 内容 | 谁能写 | 谁能读 |
| --- | --- | --- | --- |
| 角色库 | 智能体、群聊、角色卡、世界书、文风、入门角色安装、角色卡导入导出 | `admin`，以及带 `library.manage` 的 `operator` | 全体成员（世界书全文和导出仅管理者） |
| 成员数据 | 对话、消息、对话设置与剧情状态、人设、角色对该成员的记忆、聊天回合、朗读音频 | 该成员本人 | 该成员本人 |

- 成员点开角色时创建自己的对话，对话记录带 `principalId`。只有成员自己的对话是陪伴对话；没有归属的对话是共享工作间，始终按工作模式处理。
- 全部由角色组成的群聊，每位成员各有一份自己的对话，开场白和对话设置从群聊的共享对话复制。
- 人设按成员保存。角色对成员的记忆使用 `agent` 作用域并绑定成员，成员之间互不可见。
- 管理员可以查看全部工作任务，但不能打开其他成员的陪伴对话、聊天回合、人设和角色记忆，接口对这些记录返回 403 或 404。
- `viewer` 只能读取角色库，不能发起对话。
- 立绘、头像和朗读音频由 `<img>`、`<audio>` 加载，不带令牌；文件编号是随机值或内容摘要，仍受回环地址和来源校验保护。
- 企业模式没有例行任务，因此不提供定时的"先开口"。

## 跟随企业服务器

配置 `enterprise.orgServer` 后，成员、角色、用户组、角色库和陪伴开关都在 [企业服务器](../apps/org-server/README.md) 上管理，守护进程启动时和之后每隔 `refreshSeconds` 拉取一次。

| 内容 | 行为 |
| --- | --- |
| 成员目录 | 服务器的列表整体替换本机目录。被移除、停用或令牌过期的成员随即无法访问；授权版本前进后，此前委托的任务失效。没有独立额度的用户组按 `default` 计。组织编号与 `tenantId` 不一致时整份拒收。 |
| 角色库 | 已发布的角色、世界书、文风导入为本机记录，服务器上的新版本原位覆盖，同一角色的智能体编号不变。下架或删除的角色被停用并保留，成员已有的对话仍可阅读；世界书和文风连同引用一起移除。 |
| 可见范围 | 只对指定用户组发布的角色，组外成员在快照和角色库里看不到，也不能与它新开或继续对话。管理员可见全部。 |
| 陪伴开关 | 随目录下发：关闭陪伴对话后不能新开对话和发送聊天回合；关闭角色记忆后不再读取和写入角色对成员的记忆；关闭成员人设后不能新建和修改人设。 |
| 本机角色库 | 只读。包括管理员在内，任何人都不能在本机修改角色卡、世界书和文风，修改在服务器的管理界面里进行。管理员仍可为智能体选择模型。 |

服务器不可达时，守护进程沿用最后一次取得的目录和角色库，并在状态里记录失败原因。某个条目导入失败时，角色库游标不前进，下次同步重试，状态里列出失败条目的名称。对话、人设和记忆不会发往服务器。

管理员可用 `od pa org-status` 查看两部分各自的版本、上次同步时间和最近一次失败，用 `od pa org-sync` 立即同步；桌面端的角色库页显示同样的状态和“立即同步”按钮。

## 即时通讯渠道

在个人模式打开 **Personal Agent → 连接 → 添加渠道**，选择平台、连接名称和接收消息的智能体或协作群组。Fantay 通过出站连接收发消息，运行期间可以在桌面查看连接状态、任务和发送回执。

| 平台 | 连接方式 |
| --- | --- |
| 飞书 / Lark | 选择 **创建机器人**，在官方授权页确认创建。接入已有应用时选择飞书或 Lark，填入 App ID 和 App Secret。已有应用需要启用机器人能力、长连接和接收消息事件。 [飞书开放平台](https://open.feishu.cn/app) |
| 个人微信 | 用微信扫渠道二维码，经手机确认后配对自己的机器人私聊。支持平台已提供的语音转写。 |
| 钉钉 | 应用机器人使用 Stream 模式。提供 Client ID 和 Client Secret。 [钉钉开发者后台](https://open-dev.dingtalk.com/) |
| 企业微信 | 创建 API 模式的长连接智能机器人，提供 Bot ID 和 Secret。 [企业微信](https://work.weixin.qq.com/) |
| QQ | 提供 App ID 和 App Secret，测试应用需要把使用者加入应用的沙箱。 [QQ 开放平台](https://q.qq.com/qqbot/) |
| Telegram | 在 BotFather 创建机器人并取得 Bot Token。 [BotFather](https://t.me/BotFather) |
| Discord | 提供 Bot Token，开启 Message Content Intent，并邀请机器人加入有权限的服务器。 [Discord 开发者后台](https://discord.com/developers/applications) |
| Slack | 开启 Socket Mode 并提供 App-Level Token 与 Bot Token。应用需要订阅 `app_mention`、`message.im`，并取得 `connections:write`、`app_mentions:read`、`chat:write`、`im:history` 等相应权限。处理附件时需要 `files:read`。 [Slack 应用设置](https://api.slack.com/apps) |

个人微信扫码后自动配对。其它平台在 Fantay 生成一次性口令，把它发给要绑定的私聊或群聊，群里需要 @机器人。一个机器人可以选择 **绑定另一个会话**，给每个会话指定各自的目标。

能收附件的平台可读取 DOCX、XLSX、PPTX、带文字层的 PDF，以及 UTF-8 纯文本、Markdown、CSV 等文件。扫描版 PDF 无文字层时，可把前两页转成图像，交给支持图片的模型。平台自带的语音转写直接使用，原始语音由本机 Whisper 识别，单段最长 60 秒。原始语音支持 Ogg、WebM、MP3、WAV 等渠道格式，也支持个人微信的 SILK。首次使用本地 Whisper 时可能需要准备模型。

带编号的问题可直接回复编号，多选用空格分隔，支持卡片的平台也会显示按钮。图表、表格、计算器和表单可以在 Fantay 聊天记录里查看与操作。渠道会收到视图摘要，表单和可提交控件回 Fantay 填写，提交后继续原任务。创建项目默认走桌面审批。开启 **在聊天中审批项目** 后，已配对私聊也可以逐次审批。

对飞书私聊连接开启 **管理智能体团队**。目标助理会把团队要求转换为成员和职责，在 Fantay 建立协作群并担任主持者。新成员继承主持者模型。

~~~text
/team 建一个新品发布组，安排文案和视觉两位成员
/team-run 新品发布组 | 准备一版发布方案
~~~

**使用已登录的 TokenToSea 账号** 允许该渠道使用桌面账号的已配置模型。**同步桌面和定时任务回复** 可把目标智能体或群组的新回复发给已配对的会话。个人微信和 QQ 的回复受平台时限约束。

## 运行和接管

远端执行器使用出站连接。可以通过预先校验主机密钥的 SSH 隧道访问任务主机上的回环接口。两种模式都使用同一套任务、回执和产物提交规则。

~~~sh
od pa worker --controller http://127.0.0.1:<隧道端口> --worker-token-file <令牌文件> --worker-sandbox-file <沙盒配置>
od pa submit --conversation <会话ID> --prompt-file <任务文件> --generate-script --remote
od pa migrate <任务ID> --file <迁移请求JSON>
~~~

迁移请求包含目标 `workerId` 与当前任务 `revision`。切换时旧租约即失效。执行器中途失联时，协调器在租约失效后向另一台匹配能力的设备派发原阶段，拒收旧设备的迟到结果。恢复保留任务、尝试和阶段回执。沙盒工作目录按次清理，迁移以阶段为单位。

桌面 PA 的发送菜单可以选择本机或远端沙盒。CLI 也接受 `--script-file`。企业任务可显式使用 `--gateway-model <已批准模型>`，由控制器把沙盒标准输出交给指定模型。脚本不持有 Vault token 或模型凭据。

租户状态的持久化由单个权威控制器负责。执行器接管和控制器进程重启恢复已覆盖。控制器整机或磁盘失效后的异地接管、受管设备磁盘擦除、硬件远程证明和企业身份源联邦属于独立部署能力。
