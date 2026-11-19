# Fantay 企业服务器

`@fantay/org-server` 是团队版和企业版的管理服务器。它保存组织、成员、角色、用户组、共享角色库、策略和审计日志，并向 Fantay 客户端提供同步接口。

服务器只管理配置，不接收成员数据。成员与角色的对话、消息和记忆留在成员自己的 Fantay 里，服务器没有任何存取这些内容的接口，因此包括所有者在内的任何角色都无法在这里读到它们。

## 角色和权限

内置四种角色。权限只增不减：自定义角色在内置角色之上叠加，没有“禁止”项。

| 权限 | 含义 | 所有者 | 管理员 | 成员 | 访客 |
| --- | --- | --- | --- | --- | --- |
| `org.manage` | 组织名称、策略、服务凭据 | ✓ | | | |
| `roles.manage` | 指派管理员和所有者，定义和分配自定义角色 | ✓ | | | |
| `members.manage` | 添加、停用、移除成员和访客，轮换其令牌 | ✓ | ✓ | | |
| `groups.manage` | 用户组（企业版） | ✓ | ✓ | | |
| `library.manage` | 新建、编辑、发布、下架角色、世界书和文风 | ✓ | ✓ | | |
| `library.read` | 读取已发布的角色库 | ✓ | ✓ | ✓ | ✓ |
| `chat.use` | 与角色库里的角色对话 | ✓ | ✓ | ✓ | |
| `audit.read` | 读取和校验审计日志（企业版） | ✓ | | | |

持有权限之外，还要看操作对象：

- 管理员和所有者只能由所有者管理。管理员只能管理成员和访客。
- 任何人都不能对自己执行停用、移除或改角色。成员可以轮换和吊销自己的令牌。
- 主要所有者只有一位，不能被停用、移除或降级，只能由本人移交。套餐只有主要所有者能改。
- 成员的角色、自定义角色、用户组、状态或令牌变化时，`grantVersion` 前进，此前以旧版本委托的任务在守护进程一侧失效。

## 团队版和企业版

| 功能 | 团队版 `team` | 企业版 `enterprise` |
| --- | --- | --- |
| 内置四种角色 | ✓ | ✓ |
| 成员上限 | 150 | 10000 |
| 用户组 | | ✓ |
| 自定义角色（可分配给成员或用户组） | | ✓ |
| 角色库条目只对指定用户组可见 | | ✓ |
| 审计日志的读取和校验 | | ✓ |
| 策略里的保留期限 | | ✓ |
| 单点登录（OIDC） | ✓ | ✓ |
| 成员同步（SCIM 2.0） | | ✓ |

自定义角色可授予的权限是 `members.manage`、`groups.manage`、`library.manage`、`library.read`、`chat.use`、`audit.read`。`org.manage` 和 `roles.manage` 不能放进自定义角色。把自定义角色挂到用户组等于授予组内全体成员，所以这一步需要 `roles.manage`。从企业版降到团队版时，用户组和自定义角色保留在库里但不再生效。

## 管理界面

服务器自带管理界面，浏览器打开服务器地址即可。用访问令牌登录，启用单点登录后也可以用组织的身份提供方登录。界面只调用下面的接口，登录者没有的权限在界面里看不到，在接口上被拒绝。

| 页面 | 内容 | 需要 |
| --- | --- | --- |
| 概览 | 组织名称、套餐、本人身份和权限、轮换或吊销自己的访问令牌、移交组织 | 任意成员 |
| 成员 | 添加、编辑、改角色、停用、轮换令牌、移除 | `members.manage`，改角色需 `roles.manage` |
| 用户组 | 新建、编辑、删除，挂自定义角色 | `groups.manage`，企业版 |
| 自定义角色 | 新建、编辑、删除 | `roles.manage`，企业版 |
| 角色库 | 新建、编辑、发布、下架、删除、上传头像、限定可见范围 | 查看需 `library.read`，修改需 `library.manage` |
| 策略 | 陪伴对话、角色记忆、成员人设三个开关 | 查看任意成员，修改需 `org.manage` |
| 身份接入 | 单点登录设置，SCIM 令牌 | `org.manage` |
| 服务凭据 | 新建、删除给守护进程用的同步凭据 | `org.manage` |
| 审计日志 | 查看、校验完整性 | `audit.read`，企业版 |

令牌和凭据只在签发时显示一次。界面文件带内容安全策略，只加载自身的脚本和样式，只连接本服务器。

## 单点登录

单点登录使用 OpenID Connect 授权码流程（带 PKCE）。在“身份接入”里填写身份提供方地址（Issuer）、客户端 ID 和客户端密钥，把页面上显示的回调地址登记到身份提供方。需要先设置 `ORG_PUBLIC_URL`。

- 身份提供方只说明登录者是谁。角色始终在这里分配：已有成员保留原角色，首次登录自动加入的成员取设置里的默认角色（成员或访客）。
- 可以限定允许的邮箱域名。关闭“首次登录自动加入”时，只有已添加的成员能登录。已停用的成员不能登录。
- 登录成功后开启一个 12 小时的管理界面会话，不会轮换成员的访问令牌。成员在“概览”里自行签发桌面端使用的访问令牌。
- 身份令牌只接受 RS256 和 ES256 签名，并校验签发方、受众、有效期和本次登录的随机数。身份提供方未验证的邮箱会被拒绝。

## 成员同步（SCIM）

企业版可以让身份提供方通过 SCIM 2.0 同步成员和用户组。在“身份接入”里生成 SCIM 令牌，把基础地址 `<ORG_PUBLIC_URL>/scim/v2` 和令牌填到身份提供方。

- 支持 `Users` 和 `Groups` 的查询、创建、替换、`PATCH` 和删除，以及 `ServiceProviderConfig`、`ResourceTypes`、`Schemas`。筛选支持 `userName eq`、`externalId eq`、`emails.value eq`、`displayName eq`。
- `userName` 须是邮箱。`active` 为假时成员被停用，令牌随即失效。
- SCIM 不能分配角色，新成员一律是“成员”；不能停用或移除主要所有者。SCIM 令牌只能访问 `/scim/v2`，不能调用管理接口。
- 通过 SCIM 添加的成员没有访问令牌，需要本人用单点登录后自行签发，或由管理员签发。

## 角色库

条目有三种：`character`（角色卡，V2/V3 JSON）、`lorebook`（世界书）、`preset`（文风）。`document` 是对应的可移植文件，Fantay 可以直接导入。图片按用途保存，例如 `portrait`，同一用途的新图替换旧图。

条目状态为草稿、已发布、已下架。成员只能看到已发布且对自己可见的条目，其余条目对成员返回 404。删除一个用户组时，只对该组可见的条目退回草稿，不会变成全员可见。

## 运行

需要 Node 24。

~~~sh
mise x -- pnpm --filter @fantay/org-server build

# 首次：创建组织和主要所有者。令牌只显示这一次，服务器只保存它的 SHA-256。
ORG_DATA_DIR=<数据目录> node dist/server.mjs init --id <组织ID> --name <名称> \
  --owner-name <姓名> --owner-email <邮箱> --plan team

# 启动服务
ORG_DATA_DIR=<数据目录> PORT=47810 node dist/server.mjs
~~~

| 环境变量 | 含义 |
| --- | --- |
| `ORG_DATA_DIR` | 必填。数据目录，内含一个 SQLite 文件，权限仅限运行服务的账户。 |
| `ORG_HOST` | 监听地址，默认 `127.0.0.1`。 |
| `ORG_PUBLIC_URL` | 成员访问服务器的 HTTPS 地址，例如 `https://org.example.com`。单点登录的回调地址和 SCIM 的基础地址由它得出。 |
| `PORT` | 监听端口，默认 `47810`。 |

服务器不处理 TLS，应放在提供 HTTPS 的反向代理之后。来自本机代理的请求按 `X-Forwarded-For` 识别来源地址。同一地址每分钟最多 30 次失败的认证，同一令牌每分钟最多 600 次请求。

## 接口

除 `GET /healthz`、`GET /v1/public`、单点登录的两次跳转和管理界面的静态文件外，所有接口都需要 `Authorization: Bearer <令牌>`。成员访问令牌以 `fto_` 开头，服务凭据以 `fts_` 开头，单点登录会话以 `fss_` 开头，SCIM 令牌以 `fsc_` 开头。错误格式为 `{ "error": { "code", "message" } }`，常见代码：`ORG_UNAUTHORIZED`（401）、`ORG_FORBIDDEN`（403，没有权限）、`ORG_PLAN_REQUIRED`（403，套餐不含该功能）、`ORG_NOT_FOUND`（404）、`ORG_REVISION_CONFLICT`（409，内容已被他人修改）。修改类请求在请求体里带当前 `revision`。

| 接口 | 需要 |
| --- | --- |
| `GET /v1/me` | 任意成员。返回组织、本人角色、有效权限、套餐功能、策略，以及守护进程使用的 `paRole`。 |
| `GET /v1/org`、`PATCH /v1/org` | 读取：任意成员；修改名称和策略：`org.manage` |
| `POST /v1/org/plan`、`POST /v1/org/transfer` | 主要所有者 |
| `GET /v1/members` | `members.manage` 或 `roles.manage` |
| `POST /v1/members`、`PATCH /v1/members/:id`、`DELETE /v1/members/:id` | `members.manage` |
| `POST /v1/members/:id/role` | `roles.manage` |
| `POST /v1/members/:id/token`、`DELETE /v1/members/:id/token` | 本人，或 `members.manage` |
| `/v1/groups`、`/v1/groups/:id` | `groups.manage`，企业版 |
| `/v1/roles`、`/v1/roles/:id` | `roles.manage`，企业版 |
| `GET /v1/library`、`GET /v1/library/:id`、`GET /v1/library/:id/assets/:assetId` | `library.read` |
| `POST /v1/library`、`PATCH /v1/library/:id`、`DELETE /v1/library/:id`、`POST /v1/library/:id/publish`、`POST /v1/library/:id/retire`、`POST /v1/library/:id/assets` | `library.manage` |
| `GET /v1/audit`、`GET /v1/audit/verify` | `audit.read`，企业版 |
| `/v1/service-tokens`、`/v1/service-tokens/:id` | `org.manage` |
| `GET /v1/sso`、`PUT /v1/sso` | `org.manage`。客户端密钥只写不读。 |
| `GET /v1/scim`、`POST /v1/scim/token`、`DELETE /v1/scim/token` | `org.manage`，企业版 |
| `GET /v1/sso/start`、`GET /v1/sso/callback` | 浏览器跳转，无需令牌 |
| `POST /v1/logout` | 结束单点登录会话 |
| `/scim/v2/...` | SCIM 令牌 |
| `GET /v1/sync/library?since=<版本>` | 成员令牌需 `library.read`，返回 `since` 之后有变化且对本人可见的条目，以及当前仍可见的条目编号。带 `library.sync` 范围的服务凭据取得全部已发布条目及其可见范围。 |
| `GET /v1/sync/directory` | 带 `directory.sync` 范围的服务凭据。返回成员目录和组织策略。 |

`/v1/sync/directory` 返回的 `members` 与 Fantay 守护进程企业配置里的 `enterprise.members` 同形（成员编号、`admin`／`operator`／`viewer`、组、令牌摘要、授权版本、到期时间、`permissions`、`groups`）。它只交给服务凭据，成员令牌无法调用。

## 审计日志

每次管理操作写一条记录：时间、操作者、动作、对象和不含内容的摘要。每条记录包含前一条的哈希，`/v1/audit/verify` 重新计算整条链，任何改动、删除或换序都会使其后的校验失败。

## 与 Fantay 守护进程的关系

守护进程的企业模式见 [`docs/personal-agent-execution.zh-CN.md`](../../docs/personal-agent-execution.zh-CN.md)。两者共用 `@open-design/contracts/org` 里的角色、权限和数据形状。

让守护进程跟随这台服务器：在“服务凭据”里新建一个带“成员目录同步”和“角色库同步”范围的凭据，把它写进仅所有者可读的文件，再在守护进程的企业配置里加上 `enterprise.orgServer`（服务器地址、凭据文件、同步间隔）。此后成员、角色、用户组、角色库和策略开关都在这里管理，守护进程定时拉取；各成员的对话、人设和记忆仍只保存在各自的 Fantay 里。
