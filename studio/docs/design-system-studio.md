# Fantay design-system studio

The design-system manager and the project Design System tab share a neutral document canvas inspired by the owner's Claude Design references. The owner expanded the requested scope on 2026-10-26 to five layers: principles, foundations, components, patterns, and templates, plus content, brand, accessibility, implementation, and governance.

## Editing and data

- `DESIGN.md` remains the human/agent entry point. The overview editor preserves the structured handbook block.
- `tokens.css` is authoritative. The editor preserves unrelated declarations and selectors. Tables compare theme scopes, allow inline values and inherited overrides, display resolved aliases, and edit group/layer/usage metadata.
- Foundations include colors, type, spacing, radii, shadows, motion, grid/breakpoints, measure (line length only: `--measure-*`, `ch` for Latin and `ic` for Chinese), sizing & ratios (`--size-*`, `--control-height-*`, `--target-*`, `--icon-size-*`, `--aspect-*`), stacking levels, and other custom properties.
- Every system shows the same complete skeleton, a read-only preset included. A section the system does not define keeps its place, says it is left empty, and is dimmed with an 留空/Empty tag in the section menu; nothing is invented to fill it. Only the catch-all `other` group is omitted when empty. This matches Claude Design, whose fixed sections show an empty state instead of disappearing. The 153 bundled presets share one token schema with no measure, sizing, stacking or icon tokens and no asset folders, so those sections read as empty there by design.
- `system/studio.json` stores theme labels, token metadata, composite type styles, component/block/pattern/template definitions, rules (an instruction and its reason), a screen review checklist, content/brand/accessibility guidance, implementation links, version ownership, and changelog entries. `blocks`, `rules` and `reviewChecks` are optional on disk and read as empty when absent. Catalogue entries may carry `defaultVariant` and one `good` and one `bad` code example; the Studio shows them only when present.
- Catalogue groups are the user's own. An entry's optional `group` names it, and `groups.<section>` keeps the order, including groups created before anything is in them. A catalogue without groups shows one grid; with groups, each heads its own grid and ungrouped entries close the list. Groups can be created from the section heading, renamed, reordered and deleted (entries then become ungrouped); typing a new name in the entry editor creates the group. Components offer the shadcn/ui job groups (操作、输入、浮层、导航、布局、数据、反馈、智能体与聊天) as suggestions only; the starter (version 4) files its eight components under the six groups they belong to.
- Rules and skills are kept apart, as in Rico's "rules are always on, a skill is used when its job comes up". Rules (`rules`) are printed first in the DESIGN.md handbook and apply to every run. The screen review (`reviewChecks`) is an on-demand skill: saving studio.json writes `system/skills/screen-review/SKILL.md` (removed again when the list is emptied), each run stages it to `.od-skills/design-system/screen-review/SKILL.md`, and the handbook keeps a one-line pointer. Its checks are applied to the source while building, never as a post-render review round, so OD Next's build-only contract holds.
- Corrections become rules. When a user points out something wrong in a chat run that used a personal (user, non-team-synced) design system, the run-close hook (`apps/daemon/src/design-system-corrections.ts`) gates on correction wording or annotations, asks the memory model (same provider selection as memory extraction, independent of the chat auto-extraction switch) for at most three lasting rules, drops any that would trip the OD Next guard, and appends them with `source: 'correction'`, the date and what had gone wrong. The write goes through the same locked save as the editor, so the handbook and package are regenerated; a toast names the design system and opens it, and the Studio marks such rules 来自对话纠正. Presets and team copies are not written. `GET/POST /api/design-systems/:id/rules`, `DELETE /api/design-systems/:id/rules/:ruleId` and `od design-systems rules list|add|remove` manage the same list.
- Assets are grouped by the first folder under `assets/` (`assets/Logos/`, `assets/Icons/`, …), as in Claude Design; the package's `logos/` and `imagery/` folders join the matching group, files uploaded in the Studio appear under Uploads, and loose files under Other.
- Saving the structured document regenerates `system/studio-guide.md` and a bounded marked handbook block in `DESIGN.md`, so agents consuming the design system receive the same rules as the UI. Rules (each with `Why:`) and the screen review come first in that block.
- Components document status, variants, states, intended use, misuse, accessibility, API and HTML. Their previews run in opaque sandboxed iframes. Templates create a separate project and copy public package resources.
- The complete-starter action provides 8 component drafts, 4 patterns, 3 templates, semantic foundation tokens, three themes, content guidance, and an unchecked manual accessibility checklist. These are starting points, not product-specific acceptance claims.

## Catalog v2: runnable editing and reuse

The 2026-10-26 follow-up audit found that the first catalog mixed real source persistence with incomplete demonstration behavior. Catalog v2 closes that gap:

- The 15 built-in entries now provide 72 executable state/variant examples. Form and Settings retain browser-local data; list/detail templates support actual creation, filtering, editing, cancel and reload recovery. Tabs include roving focus and arrow/Home/End handling; Dialog, Toast and error-recovery flows distinguish their actions.
- Components, patterns and templates share the same catalog editor, with specification/source/example tabs and live draft preview. Comma-separated fields remain editable while typing. An opened entry is compared with its original snapshot before saving; failed and stale saves retain the draft. Saving locks the editor until completion.
- All three types support duplication, confirmed deletion with error feedback, full-HTML copy, HTML download and creation of a separate project.
- Preview/copy/download/reuse share one package builder. It embeds referenced local resources, including CSS imports, fonts, images, srcset, poster and inline CSS URLs, and includes available asset licenses. Missing resources and unbuilt module dependencies fail visibly before project creation. External resource URLs remain external and are identified in the preview.
- Preview demo state is stored through the existing isolated preview-storage bridge, scoped by workspace/system/entry/example. Source data remains server-backed. Same-path resource replacement invalidates previews without sharing another entry's storage.
- Reuse creates the destination only after packaging succeeds. A failed document write removes the newly-created empty project.
- The upgrade action replaces only untouched shipped implementations and fields; user-authored entries and changed implementations are preserved. Starter version 3 (2026-11-03) adds the missing sizing and Chinese measure tokens to `tokens.css`, rules and the screen review when the system has none, the component contract on entries whose usage guidance is unchanged, and the newer content and brand guidance only where the old shipped text is still verbatim.

Follow-up evidence and tests are recorded in `docs/design-system-catalog-audit-20261026.md` and `.tmp/catalog-audit/`.

## Persistence

`POST /api/design-systems/:id/editor` receives `{path, content, expected}`. Existing workspace and ownership authorization runs before mutation. Editor writes for a system are serialized; stale snapshots return 409. The former source is journaled before overwrite, pending journal records survive retries, and a record becomes accepted only after synchronization succeeds.

Public package synchronization includes token source/adapters, component artifacts, manifests, fonts and assets. It excludes private project metadata and hidden paths. Token adapters and manifests are mirrored back into the editing project. Symbolic links are refused at package write destinations.

Manual source history reuses design-system revisions with `jobId: studio-editor`. Only accepted single-source records are offered as restorable source history. Restoration creates another checked editor write rather than silently accepting an unrelated AI revision. Source history supports the same 2,000,000-character limit as editor writes.

CLI equivalents: `od design-systems edit`, `sync`, `history`, and `restore`; imports and ZIP download retain their existing CLI/API surfaces. `edit --file -` and `--prompt-file` support piped content.

## Integration and validation boundaries

- Public GitHub import uses the existing importer. Connectors continue through the existing setup/authorization flow.
- Repository and Figma links record provenance. No new account authorization or bidirectional Figma synchronization is implied.
- Component/template implementations are editable HTML examples. They are not automatically published framework packages.
- Contrast checks calculate recognized opaque sRGB hex pairs. Manual checks remain explicit and unchecked until reviewed. The reference threshold is [WCAG 2.2 contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html); the screen is not a complete WCAG conformance audit.
- Package reference counts are static counts, not production analytics.
- Local validation evidence is stored under `.tmp/design-system-studio/`; visual acceptance is recorded in the root `design-qa.md`.
