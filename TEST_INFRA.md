# E2E Test Infra: 剪辑模块升级与素材库视频创作 Skill 收录

## Test Philosophy
- 需求驱动、黑盒验收与契约验证并重。
- 双轨并行：剪辑模块核心能力自动化验证 + 素材库编目一致性强校验。

## Feature Inventory
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 |
|---|---------|--------|:------:|:------:|:------:|
| 1-5 | easy-jianying 剪映草稿关键帧、转场、淡入淡出及编辑操作 | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 6-9 | story-studio 素材库规范收录与编目哈希校验 | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 10-12 | 全局工程健康度与门禁验收 | ORIGINAL_REQUEST Acceptance | 3 | 3 | ✓ |

## Test Architecture
- **剪辑模块测试集**：
  - `pnpm --filter @open-design/daemon test tests/jianying`: 校验 Service, CLI, API 路由与环境探测。
  - `doc/剪映`: Node 原生测试套件，校验底层 draft 结构生成、关键帧、转场、淡入淡出与切分操作。
- **素材库编目测试集**：
  - `mise run library:catalog`: 编目重建。
  - `mise run library:check`: 完整性、分类断言、文件 SHA-256 哈希覆盖率。
- **全局健康度门禁**：
  - `mise run check`: 运行全部 4 项核心质量守卫（`system:check`, `library:check`, `studio:guard`, `studio:typecheck`）。
