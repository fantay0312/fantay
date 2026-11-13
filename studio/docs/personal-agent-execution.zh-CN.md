# Personal Agent 执行模式

未配置 `OD_PA_CONFIG` 时，Fantay 使用个人模式和现有 PA 数据。配置文件由启动 daemon 的环境传入，应是仅所有者可访问的 JSON 文件。模式在 daemon 启动时选择。企业模式每个实例绑定一个租户，使用独立 SQLite、记忆目录和产物目录。两种模式使用同一任务状态机。

## 配置

顶层字段为 `version: 1`、`mode`，以及可选的 `sandbox`、`workers`、`leaseMs`、`maxHandoffs`。个人模式可单独配置 OCI 沙盒或远端执行器。企业模式另需 `enterprise`。字段类型和取值见 [配置校验](../apps/daemon/src/services/pa/config.ts)。

| 配置 | 内容 |
| --- | --- |
| `sandbox` | 已安装并经审核的镜像 ID，形如 `sha256:…`。执行器要求本机 Unix 套接字、Linux 容器引擎和 seccomp。可通过 `engineSocket` 指定套接字，或通过 `runtime` 选择引擎上安装的隔离运行时。镜像须包含 `/bin/sh` 和 `/usr/bin/timeout`，且不得声明自动挂载卷。 |
| `workers` | 每台执行器的 `id`、`tokenSha256`、毫秒时间戳 `expiresAt` 和 `capabilities`。能力可选 `shell` 或 `ollama`。Ollama 执行器另列允许的 `models`，推理时必须关闭 Ollama 云功能。 |
| `enterprise.members` | 成员 ID、`admin`／`operator`／`viewer` 角色、组、令牌摘要、授权版本和到期时间。桌面 PA 使用成员令牌解锁。CLI 通过 `--access-token-file` 或 `OD_PA_ACCESS_TOKEN_FILE` 读取成员令牌。 |
| `enterprise.budgets` | 分别配置租户、组和角色的 UTC 日额度。额度含模型调用次数、沙盒运行时间预留和金额预留。金额以百万分之一美元记账。实际扣费与价格上限由供应商管理。 |
| `enterprise.gateway` | 固定的模型 API 地址、获准模型、输出 token 上限、每次调用的金额预留和凭据引用。凭据可来自本机私有文件或 Vault KV v2。Vault token 应只获准读取对应的密钥路径。 |
| `enterprise.auditSigningKeyFile` | Ed25519 私钥文件。管理员可用 `od pa audit` 导出签名检查点，并把检查点及公钥保存在数据库之外。随后用 `od pa audit-verify --file <检查点文件>` 核对历史。 |

运行 `od pa provision-token --file <新令牌文件>` 生成成员或执行器令牌。命令只输出摘要，摘要填入配置，令牌文件通过部署方的凭据渠道交付。管理员可用 `od pa revoke --file <JSON>` 撤销成员或执行器。JSON 包含 `kind` 和 `id`。

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
