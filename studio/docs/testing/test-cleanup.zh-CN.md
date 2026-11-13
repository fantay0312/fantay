# 测试结束后的自动清理

Fantay 的本地测试通过工作区任务运行。执行范围仍由调用者选择，不默认跑全量测试。

```sh
mise run studio:test -- pnpm --filter @open-design/e2e exec vitest run -c vitest.config.ts tests/scripts/fantay-test-cleanup.test.ts
mise run studio:test -- pnpm --filter @open-design/e2e exec playwright test -c playwright.config.ts ui/fantay-shell.test.ts --workers=1
mise run studio:guard
mise run studio:typecheck
```

`studio:test` 接受命令与独立参数，不经过第二次 shell 解释。需要执行一组命令时，把它们写入本地测试脚本，再把脚本交给入口执行。不要把整个命令拼成一个字符串参数。

测试成功、失败或正常响应 Ctrl+C 后，入口保存原退出码并执行清理。启动命令失败也会保存记录并清理；强制杀死进程、断电等无法执行收尾的情况，可在下一次测试结束时或手动运行 `mise run studio:clean` 补做。该命令不会主动停止仍在运行的服务。

## 清理与保留边界

| 内容 | 处理 |
| --- | --- |
| `.tmp/e2e/**/scratch` 内的测试数据库、临时项目和编译缓存 | 所属运行时已停止后删除；先保存运行日志 |
| `.tmp/tools-dev/*/web/next`、`apps/web/.next/cache`、根 `node_modules/.cache` | 确认没有测试或构建进程使用后删除 |
| `.tmp/tools-pack/cache` | 闲置时删除，可重新构建 |
| `.tmp/tools-pack/out` | 先保留最新安装包并校验 SHA-256，再删除重复构建输出 |
| `.tmp/desktop` | 始终保留；已有安装包更新时不被旧构建覆盖 |
| `.tmp/test-records/<时间-PID>/test.log`、`result.json` | 保留命令输出、退出码、清理清单和跳过原因 |
| e2e 的 `report/`、Playwright 输出、截图、trace、人工测试报告 | 保留；运行日志转存到对应 `report/runtime-logs/` |
| 源码、未提交修改、素材、真实 `.od` 数据、依赖、开发服务 | 不删除、不停止 |

安装包按平台和格式从最终输出目录选择：macOS `.dmg`、Windows `-setup.exe` / `-portable.zip`、Linux `.AppImage`。复制到 `.tmp/desktop/Fantaydesign<后缀>`，同格式已有文件更新时保留已有文件。复制或校验失败就保留原打包输出，不继续删除。

这项清理不扫描系统临时目录、不追随软链接、不进入 `studio-unify` 等其他工作区，不删除未知临时目录。外部打包目录需要由创建它的构建流程单独清理。

## 测试框架自动收尾

直接执行 Playwright 或 e2e Vitest 时，共享测试夹具也会处理自己创建的 `scratch`：先停止服务，保存失败诊断和日志，再删除临时数据。无需依赖测试通过，也不改变测试断言或结果。浏览器截图与 trace 的保存策略沿用 Playwright 配置。

临时目录带有创建进程标记，其他仍在运行的测试不会被全局清理碰到；打开的文件也会阻止清理。共享缓存还会检查测试/构建进程。进程检查不可用时保留目录并在记录中说明，不把“无法检查”当作“可以删除”。当前打开文件检查使用 `lsof`；没有该能力的平台会保守跳过，不能据此宣称已完成清理。

人工启动的 QA 运行时先用 `pnpm tools-dev stop --namespace <自己的 namespace>` 停止，再运行 `mise run studio:clean`。手工 QA 目录中的截图、日志和其他材料默认保留；清理器不会猜测哪些未知文件可以丢弃。
