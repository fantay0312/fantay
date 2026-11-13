# Fantay

Fantay 的工作区包含三部分：

- **设计系统 `fantay`**：统一的视觉基调，沿用 open-design 自身的产品 UI 语言。
- **素材库**：收集的风格、组件、SVG、设计 Skill 和网站收藏，共 1240 项。
- **Fantay 桌面应用**：基于 [nexu-io/open-design](https://github.com/nexu-io/open-design) 开发，可使用个人智能体、管理项目与素材，并完成设计和视频创作。

三部分共用一份设计令牌：`设计系统/tokens.css`。

## 目录

| 路径 | 内容 |
|---|---|
| `设计系统/` | 软链接，指向 `studio/design-systems/fantay/`。设计系统的唯一来源，内含 DESIGN.md、tokens.css、组件样张、预览页和 Albert Sans 字体 |
| `素材库/` | 素材本体与导览网页（`index.html`）；索引和工具在 `素材库/导览支持/` |
| `studio/` | Fantay 桌面应用源码。整个工作区使用根目录的 Git 仓库，默认分支为 `main`。开发说明见 [studio/FANTAY.md](studio/FANTAY.md) |
| `tools/check_fantay.py` | 检查设计系统和 Studio 界面令牌是否一致，以及素材库是否引用了设计系统 |
| `tools/feature-icons/` | Studio 导航入口的 25 个动态功能图标（Kubai Icons 引擎，Fantay 墨色）：展示页、自检、导出，以及同步到 Studio 的脚本 |
| `doc/参考.md` | 选型参考：设计系统的分层，以及为什么二开 open-design |
| `mise.toml` | 统一命令入口；同时关闭 Studio 的遥测 |

## 常用命令

在本目录运行：

```sh
mise tasks                 # 列出全部任务
mise run studio            # 前台运行 Studio：daemon 7456，界面 http://127.0.0.1:5173
mise run studio:start      # 后台启动；studio:status 查看状态，studio:stop 停止
mise run library           # 打开素材库网页 http://127.0.0.1:8766
mise run library:catalog   # 新增素材后重建索引并校验
mise run check             # 全部检查：设计系统一致性 + 素材库测试 + Studio 的 pnpm guard 与 typecheck
mise run studio:test -- pnpm --filter @open-design/e2e exec playwright test -c playwright.config.ts ui/fantay-shell.test.ts --workers=1
                           # 聚焦测试；结束后自动保存记录、清理缓存和临时数据
mise run studio:clean      # 补做清理，保留测试证据、项目数据和最新安装包
```

运行时版本不用手动管理：Studio 在 `studio/mise.toml` 固定 Node 24 和 pnpm 10.33.2，素材库工具在 `素材库/导览支持/mise.toml` 固定 Python 3.13。

测试后的清理与保留规则见 [自动清理说明](studio/docs/testing/test-cleanup.zh-CN.md)。

## 三部分怎么联动

```
          设计系统/tokens.css（唯一来源）
        ┌──────────┴───────────┐
        ▼                      ▼
 Fantay 桌面应用             素材库网页
 · 新对话默认选 fantay       · 页面直接引用 tokens.css 和字体
 · 生成作品遵循 DESIGN.md    · 「在 Fantay 中使用」链接
        ▲                      │
        └──── materials 接口 ◄─┘
   /materials 页面 · 输入框「从素材库添加」 · od materials · 技能 fantay-materials
```

- **设计系统 → Studio**：没有保存过选择时，新对话默认用 `fantay`；`od run redesign` 也默认用它。用户手动选择的设计系统优先。
- **设计系统 → 素材库**：素材库网页按相对路径加载 `studio/design-systems/fantay/tokens.css` 和 Albert Sans。页面自己的 CSS 不重新定义令牌，只引用。
- **素材库 → Studio**：
  - Studio 的 daemon 从 `studio/` 旁边的 `素材库/` 读取索引；设置环境变量 `FANTASY_DESIGN_LIBRARY` 可以指定别的位置。
  - 读取方式有四种：
    - 界面的「素材库」页（`/materials`）；
    - 对话输入框「+」菜单里的「从素材库添加」：组件和风格会复制进项目的 `references/<id>/`，并附带许可和来源证据；网站收藏插入参考包；
    - `od materials search|show|context|apply`；
    - 技能 `fantay-materials`，让 Agent 先查素材库，再决定是否自己做。
  - Studio 只读素材库，从不写入。
- **素材库 → 其他 Agent**：Claude Code、Codex 等继续用 `fantasy-design` CLI 和 `$fantasy-design` 技能，用法见 [素材库/llms.txt](素材库/llms.txt)。

## 设计系统

基调直接取自 open-design 的产品界面：

- **颜色**：白底和 `#fafafa`/`#ededed`/`#dbdbdb` 灰阶；`#202020` 墨色。
- **强调色**：近黑 `#353535`，荧光绿 `#87ea5c` 只在少数位置使用。
- **字体**：Albert Sans 600，14px，行高 125%。
- **组件和动效**：黑色胶囊主按钮，毛玻璃浮层；ease-out 动效，进入约 200ms，退出约 140ms。

每个令牌的产品出处都记在 DESIGN.md 的 Provenance 一节。

按 [doc/参考.md](doc/参考.md) 的设计系统分层，各层对应的位置：

| 分层 | 在哪里 |
|---|---|
| Foundations 基础层 | `DESIGN.md` 中的色彩、字体、间距/圆角/阴影、动效、布局各节 |
| Design Tokens | `tokens.css`：共 56 个通用令牌，另有派生的暗色块（未经产品验证，只在显式 `data-theme="dark"` 下生效） |
| Components 组件 | `components.html` 样张，`components.manifest.json` 为自动提取的机器可读清单 |
| Patterns 模式 | `DESIGN.md` 中的组件与布局两节，`USAGE.md` 的 Do / Avoid |
| Documentation 文档 | `DESIGN.md`、`USAGE.md`、`preview/` 中的色彩、字体、间距、应用四个预览页 |
| 代码与设计资产 | Studio 界面本身，以及随包分发的 Albert Sans（OFL 1.1） |
| Governance 治理 | `mise run check`：`tools/check_fantay.py` 和 Studio 的 `pnpm guard` 校验设计系统包格式 |

## 素材库

- 2026-10-26 从 `设计/素材库` 移到这里，原位置保留了一个兼容软链接，`设计/素材库` 指向 `fantay-design/素材库`。不要删除这个软链接：162 个来源证据字段，例如快照文件和收集记录，仍按旧路径记录，要靠它解析。
- 网页基调同日改为 Fantay Design，替换原来的“展陈画册”样式；所有功能、地址参数和快捷键不变。改动前的文件备份在 `素材库/导览支持/tmp/2026-10-26-fantay-unify/before/`，验收截图在 `素材库/导览支持/验收/2026-10-26-Fantay统一风格/`。
- 素材库网页依赖同级的 `studio/` 提供令牌和字体；单独移动素材库时，样式会丢失。
- 新增素材用 `$collect-materials`，完成后运行 `mise run library:catalog`。

## Fantay 桌面应用

- 基于 open-design 二次开发：
  - 新增 materials 能力，覆盖契约、daemon 接口、`od materials`、界面和技能；
  - 新增 `fantay` 设计系统并设为默认；
- Fantay 独立维护，仓库为 `fantay0312/fantay`，默认分支为 `main`。历史来源和应用开发说明见 [studio/FANTAY.md](studio/FANTAY.md)。
- 日常修改按 Fantay 的产品需求推进。引入外部代码时按具体任务审阅，并保留来源及许可证。
- 发布前在本目录运行 `mise run studio:guard` 和 `mise run studio:typecheck`，并补跑受影响路径的测试。
- 遥测：不配置任何遥测凭据；本目录 `mise.toml` 的 `[env]` 关闭了 Next.js 和 Vela 遥测。

## 维护规则

- **改视觉基调**：只改 `设计系统/tokens.css`，同步更新 `DESIGN.md`、`components.html` 中的 `:root`，然后运行 `mise run check`。素材库和 Studio 的生成作品会自动跟随。
  - 大部分令牌与 Studio 界面一一对应，检查脚本会比对它们。
  - 如果有意让某个令牌与产品不同，在 `tools/check_fantay.py` 的 `DIVERGED` 里登记这个令牌和原因，检查会显示 SKIP，不会报 FAIL。
- **界面令牌调整后**：运行 `system:check` 核对设计系统与应用的对应关系。有意保留的差异在 `DIVERGED` 登记原因。
- **素材**：不修改已归档的原件；下游项目只使用复制出来的文件。
- GitHub 仓库为私有仓库，远程 `origin` 指向 `https://github.com/fantay0312/fantay.git`。
- `.github/workflows/ci.yml` 提供手动触发的 guard 和 typecheck 检查。
- 素材库、归档文档、本地实验、运行数据、依赖和缓存按 `.gitignore` 保留在本机。
