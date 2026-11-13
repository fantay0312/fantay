# Project: 剪辑模块升级与素材库视频创作 Skill 收录

## Architecture
- **Monorepo Structure**:
  - `studio/`: 主工作区（Node 24, pnpm 10.33.2, TypeScript 5.9）
    - `studio/packages/contracts/src/api/jianying.ts`: 剪映草稿数据结构、片段定义、工程规格与编辑操作 DTO 契约。
    - `studio/vendor/jianying-draft/`: 隔离草稿处理引擎（Node 24 原生，零外部 npm 依赖），包含：
      - `src/build.js`: 草稿生成器（时间线构建、素材映射、轨道管理）。
      - `src/edit.js`: 草稿事务性编辑器（片段增删改、切分、属性设置）。
      - `src/storage.js`: 安全存储与哈希防篡改引擎。
      - `src/validate.js`: 草稿模型合法性校验器。
      - `worker.ts`: 子进程 IPC 调度入口。
    - `studio/apps/daemon/src/jianying/`: 服务端逻辑（`service.ts`, `environment.ts`, `engine.ts`, `cli.ts`）及 `movieToJianying` 电影时间线转换器。
    - `studio/packages/dsh-runtime/src/jianying-tools.ts`: Agent 剪辑工具集。
    - `studio/skills/jianying-draft/`: 内置剪映草稿 Agent 技能与参考文档。
  - `素材库/`: 资源与技能资产体系（Python 3.13.15）
    - `素材库/视频创作/Story-Studio-短视频创作工坊/`: 遵循素材库规范收录的全新视频创作 Skill。
    - `素材库/导览支持/scripts/build_catalog.py`: 资产编目构建脚本。
    - `素材库/导览支持/scripts/verify_catalog.py`: 编目合规与哈希校验脚本。
  - `doc/剪映/`: 剪映草稿独立研究与验证套件（含 `easy-jianying` 0.2.0 原型源码镜像）。

- **Design Philosophy**:
  - **高质量原生契约演进**：将 `easy-jianying` 经实机验证的草稿数据模型（7类线性关键帧、偶数帧转场、双向音频淡入淡出、原生识别字幕轨）吸纳进 `contracts` 与 `vendor/jianying-draft`，保持 TypeScript 纯净与零额外依赖。
  - **非破坏性副本原则**：所有草稿生成与编辑均保持 `sourcePreserved: true`，生成带有新 ID 与 revision 的副本，绝不原地破坏既有草稿。
  - **素材库严格契约合规**：新收录的 `story-studio` 技能严格符合 `kind == 'skill'` 的全部强校验（`document`, `license_document`, `source_manifest`，以及全量文件的 SHA-256 哈希校验）。

## Code Layout
- Contracts & Types:
  - `studio/packages/contracts/src/api/jianying.ts`
- Vendor Runtime & Draft Engine:
  - `studio/vendor/jianying-draft/src/build.js`
  - `studio/vendor/jianying-draft/src/edit.js`
  - `studio/vendor/jianying-draft/src/validate.js`
  - `studio/vendor/jianying-draft/worker.ts`
- Daemon Service & Router:
  - `studio/apps/daemon/src/jianying/service.ts`
  - `studio/apps/daemon/src/routes/jianying.ts`
- Library Assets & Skills:
  - `素材库/视频创作/Story-Studio-短视频创作工坊/entry.json`
  - `素材库/视频创作/Story-Studio-短视频创作工坊/README.md`
  - `素材库/视频创作/Story-Studio-短视频创作工坊/THIRD_PARTY_NOTICES.md`
  - `素材库/视频创作/Story-Studio-短视频创作工坊/upstream/SKILL.md`
  - `素材库/视频创作/Story-Studio-短视频创作工坊/references/source-manifest.json`
  - `素材库/视频创作/Story-Studio-短视频创作工坊/references/git-tree.json`
  - `素材库/视频创作/Story-Studio-短视频创作工坊/references/skills.json`
- Tests & Validation:
  - `studio/apps/daemon/tests/jianying/`
  - `doc/剪映/test/draft.test.js`

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | 剪映草稿数据模型契约扩展 | 在 `contracts/src/api/jianying.ts` 中增加关键帧（`JianyingKeyframePoint`）、转场（`JianyingTransition`）、音频淡入淡出（`JianyingFade`）及对应操作枚举 | M1 | survey_1, survey_2 |
| 2 | 核心草稿生成引擎（build.js）能力升级 | 支持关键帧（7类属性）、转场（挂载 extra_material_refs、偶数帧对齐）、淡入淡出及识别字幕轨（`flag: 1`）结构生成 | M1 | survey_2 |
| 3 | 核心草稿编辑引擎（edit.js）能力升级 | 增加 `set_keyframes`、`set_transition`、`relink` 操作，完善事务性编辑与结构校验 | M1 | survey_1, survey_2 |
| 4 | 解锁 movieToJianying 转换限制 | 在 `service.ts` 中放开对镜头关键帧、转场和音频淡入淡出的 `UNSUPPORTED_TIMELINE` 限制，支持完整保真导出 | M1 | survey_1, survey_2 |
| 5 | 剪辑模块单元与契约测试套件扩展 | 扩充 `studio/apps/daemon/tests/jianying/` 与 `doc/剪映/test/`，覆盖转场、关键帧和淡入淡出的自动化测试 | M1 | survey_1, survey_2 |
| 6 | story-studio 技能资产落盘与元数据配置 | 在 `素材库/视频创作/Story-Studio-短视频创作工坊/` 建立规范资产包（`entry.json`, `README.md`, `THIRD_PARTY_NOTICES.md`） | M2 | survey_3 |
| 7 | story-studio SKILL.md 与参考文档编排 | 编写符合 Agent 规约的 `upstream/SKILL.md` 及核心工作流与参考资料 | M2 | survey_3 |
| 8 | 资产来源清单与哈希校验契约生成 | 生成 `references/source-manifest.json`、`git-tree.json`、`skills.json`，确保逐文件 SHA-256 100% 覆盖 | M2 | survey_3 |
| 9 | 素材库编目重建与一致性校验通过 | 运行 `mise run library:catalog` 自动更新 `catalog.json` 等索引，并通过 `mise run library:check` 严格校验 | M2 | survey_3 |
| 10 | 跨模块端到端验证测试套件 (E2E) | 创建端到端验证用例，验证升级后的草稿生成、编辑与技能检索正常运作 | M3 | e2e_track |
| 11 | 工程全量健康度检验 (mise run check) | 执行 `mise run check`（含 `library:check`, `studio:guard`, `studio:typecheck`），确保全绿 0 报错 | M3 | survey_1, survey_3 |
| 12 | 司法级代码审计与完整性验收 | 审计员独立核验无作弊硬编码、无虚假实现、无破坏性变更 | M3 | auditor |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | easy-jianying 核心能力融入剪辑模块 | Features 1, 2, 3, 4, 5 (Contracts, Vendor runtime, Daemon service, tests) | none | DONE |
| 2 | story-studio 收集到素材库视频创作 Skill | Features 6, 7, 8, 9 (`素材库/视频创作/Story-Studio-短视频创作工坊/`, catalog rebuild & check) | none | DONE |
| 3 | 端到端集成验证与工程全量门禁验收 | Features 10, 11, 12 (E2E Test Suite, `mise run check`, 全量验收审计) | M1, M2 | DONE |

## Interface Contracts

### 1. Jianying Clip & Keyframes Extension (`contracts/src/api/jianying.ts`)
```typescript
export interface JianyingKeyframePoint {
  at: number; // 相对片段起点的秒数
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  opacity?: number;
  volume?: number;
}

export interface JianyingTransition {
  name: string; // "叠化" | "推近" | "闪黑" | "滑动" | string
  duration?: number; // 秒，默认 0.5 秒，自动对齐到偶数帧
}

export interface JianyingFade {
  in?: number;
  out?: number;
}
```

### 2. Jianying Operation Set Extension (`contracts/src/api/jianying.ts`)
```typescript
export type JianyingOperation =
  | { op: 'add'; clip: JianyingClip }
  | { op: 'import_srt'; path: string; offset?: number; track?: number }
  | { op: 'move'; segmentId: string; start: number; trackId?: string }
  | { op: 'trim'; segmentId: string; duration: number; sourceStart?: number }
  | { op: 'split'; segmentId: string; at: number }
  | { op: 'delete'; segmentId: string; ripple?: boolean }
  | { op: 'set_speed'; segmentId: string; speed: number }
  | { op: 'set_volume'; segmentId: string; volume: number }
  | { op: 'set_text'; segmentId: string; text: string }
  | { op: 'transform'; segmentId: string; transform: JianyingTransform }
  | { op: 'replace_media'; segmentId: string; path: string }
  | { op: 'set_keyframes'; segmentId: string; keyframes: JianyingKeyframePoint[] }
  | { op: 'set_transition'; segmentId: string; transition: JianyingTransition };
```

### 3. Story-Studio Skill Registration Contract (`entry.json`)
```json
{
  "id": "skill-story-studio",
  "title": "story-studio",
  "subtitle": "从选题到剪映草稿的一站式AI短视频创作工坊",
  "category": "视频创作",
  "kind": "skill",
  "collection": "视频技能与创作工具",
  "section": "视频拆解与工作流",
  "path": "upstream/SKILL.md",
  "document": "README.md",
  "license_document": "THIRD_PARTY_NOTICES.md",
  "source_manifest": "references/source-manifest.json"
}
```
