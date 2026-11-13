# Fantay 官网

本站与桌面应用的隐私说明共享 `packages/contracts/src/privacy-policy.ts`。官网是产品信息、下载与反馈入口，不提供网页版工作台。

构建：`mise x -- node --experimental-strip-types website/build.ts`。输出 `.tmp/fantay-website`，同时生成根目录 `PRIVACY.md`。字体、样式和脚本全部自托管。

`/feedback/` 只在用户点击后打开本机邮件客户端，不上传表单、不自动发送邮件。正式安装包从自有 CDN 元数据读取，尚未发布时显示真实的未发布状态。Clipper 与 Figma ZIP 是开发者安装包，不代表已经上架扩展商店。

部署到 `design.tokentosea.com` 时，只将 `/`、`/assets/*`、`/privacy/*`、`/feedback/*`、`/downloads/*`、`/credits/*` 交给静态站；其余路径继续转发既有 `fantay-share` 服务，保留分享链接、OAuth 回调、评论和管理功能。

## 发布准备

`mise x -- node --experimental-strip-types tools/release/src/fantay-prepare.ts --version 1.0.0 --mac-arm64 /absolute/installer.dmg --win-x64 /absolute/installer.exe`

该命令只准备文件，不创建 release、不推送源码、不上传。使用真实已验证的安装包；不要用旧版安装包冒充新版。生成的 `publish-plan.json` 给出双源上传顺序。原子切换 `stable/latest/metadata.json` 必须最后执行。GitHub 元数据独立指向 GitHub 的同版本文件；公共 CDN 元数据使用可匿名访问的自有分发地址；私有 GitHub 元数据供维护者归档访问，所有文件使用同一 SHA-256。

源仓库固定为 `fantay0312/fantay`；CDN 前缀为 `https://static.tokentosea.com/fantay-design`。COS 使用专属公开分发桶，不保存账户、私密作品、密钥或诊断数据。凭据通过受控环境注入，禁止写入源文件或打包到应用。
