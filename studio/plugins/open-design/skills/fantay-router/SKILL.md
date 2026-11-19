---
name: fantay-router
description: Find and use Fantay desktop workflows for designs, projects, files and runs when the user asks to work in Fantay.
---

Use the Fantay MCP server. Search workflows with `find_skills` using the task or exact ID, then use `read_skill` for one page. Pass the returned `nextOffset` as `offset` when needed. Set `file` to `references` to list supporting texts, or to a returned reference path to read it.

For project tools, search `find_tools` by task. Open one schema with `describe_tool`, then use `call_tool` with that name and its arguments. Hosts configured for the full tool list can call the named tool directly. For a new design, use the brief card before starting a run unless the user skips it. Poll the original run ID until completion.
