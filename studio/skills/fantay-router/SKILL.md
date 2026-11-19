---
name: fantay-router
description: Find a Fantay design or production workflow and read its instructions on demand.
zh_name: Fantay 技能路由
zh_description: 按当前任务搜索 Fantay 工作区的技能，选中后分段读取正文和参考资料。
triggers: [find a Fantay skill, 查找技能, 技能路由]
od:
  mode: utility
  featured: 1
  design_system:
    requires: false
---

Search with `"$OD_NODE_BIN" "$OD_BIN" skill find "<task or skill name>"` inside Fantay. The wrapper uses this run's workspace and member. Use the localized task term or exact skill ID to narrow the results.

Read the matching workflow with `skill read <id>` through the same wrapper. A non-null `nextOffset` can be passed as `--offset <n>`. Use `--file references` to list supporting texts, then pass a returned path unchanged to `--file`. If the user already named the skill, go straight to its first page.
