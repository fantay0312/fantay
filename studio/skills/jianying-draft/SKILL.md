---
name: jianying-draft
zh_name: 剪映草稿
en_name: Jianying Draft
description: Create editable Jianying drafts from a FantayDesign timeline or local media plan, detect the installed client version, and edit existing drafts into new copies while preserving the original. Use for Jianying draft work, not MP4 export or updating Jianying.
triggers:
  - 剪映草稿
  - 创建剪映草稿
  - 修改剪映草稿
  - 检测剪映版本
  - jianying draft
od:
  mode: utility
  category: animation-motion
  design_system:
    requires: false
---

# Jianying drafts

Work through FantayDesign's project API. Speak the user's language. Creating
or editing a draft never authorizes updating Jianying or replacing a source
draft. Every modification returns a new project draft; use its returned ID
for subsequent changes. Do not edit draft JSON directly.

## Detect the environment

Start with `fantay_jianying_status`, or:

```sh
"$OD_NODE_BIN" "$OD_BIN" jianying status --project "$OD_PROJECT_ID" --json
```

Report the detected client version and relevant capability when it changes
the result. Windows and macOS share creation and plaintext editing. Encrypted
editing requires a matching native adapter; currently macOS Apple Silicon
11.6.0 is desktop-verified. A known schema or version is not proof of a tested
client round trip. Do not set `allowUnverified` without the user's agreement
to generate for an unverified client. Do not install or upgrade the client.

## Create

For the current saved film, read `fantay_movie_get` / `od movie get` and pass
its exact `revision` to `fantay_jianying_create` with `source: timeline`.
If the project has no film, or the user specifies media/timing directly,
create a plan with `source: plan`. See [references/plans.md](references/plans.md).

```sh
"$OD_NODE_BIN" "$OD_BIN" jianying create --project "$OD_PROJECT_ID" --revision 7 --name "Draft" --json
"$OD_NODE_BIN" "$OD_BIN" jianying create --project "$OD_PROJECT_ID" --file plan.json --json
```

Use actual project media, not preview proxies. Time values are seconds.
Code animations and unsupported visual effects are rejected instead of
silently presented as transferred editable objects. Explain the specific
limitation and offer an explicit plan or a rendered video when appropriate.

## Inspect and edit a copy

List project drafts, inspect the selected draft, then use exact current
segment IDs. `fantay_jianying_edit` accepts the operations described in
[references/operations.md](references/operations.md).

```sh
"$OD_NODE_BIN" "$OD_BIN" jianying list --project "$OD_PROJECT_ID" --json
"$OD_NODE_BIN" "$OD_BIN" jianying inspect --project "$OD_PROJECT_ID" --draft "project:ID" --json
"$OD_NODE_BIN" "$OD_BIN" jianying edit --project "$OD_PROJECT_ID" --draft "project:ID" --file operations.json --json
```

Only after a user requests work on their local Jianying library may an
unrestricted CLI caller add `--include-local` to list/inspect/edit. The scoped
`fantay_jianying_*` tools intentionally cannot read external drafts. In that
case have the user select the draft and save a copy through the app's
“修改剪映草稿副本” action; continue with the resulting project ID. Do not bypass
the project boundary with shell, arbitrary paths or direct filesystem reads.

Check the returned validation and operation result. State the new draft path,
whether the original was preserved, and any compatibility limitation.
File validation is not desktop visual verification; do not claim the latter
unless the client was actually opened and checked.

## Add to Jianying

When requested, use the returned project draft ID with `od jianying install`.
The client must be closed so it cannot overwrite its home registry. This
copies the project and backs up the registry; it does not launch, update or
install Jianying. Scoped agents leave this host-library step to the app UI.
