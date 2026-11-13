---
name: claude-design-system
zh_name: 设计系统构建规范
description: |
  Create or revise a design system the way the Claude Design system builder does: from the brand's real sources (codebase, files, decks, guidelines), with an agent-facing DESIGN.md of imperative usage rules, a compiled tokens.css with a usage note on every token, a structured system/studio.json, and a generated preview/cover.html. Use when the user asks for a design system, brand kit, token set or style guide to be built from a code repository, a design tool export, brand files, or from scratch, or to revise one that already exists.
zh_description: |
  按 Claude Design 的设计系统构建方式创建或修订设计系统：从品牌真实来源出发，写给 Agent 看的祈使句式 DESIGN.md、每个 token 都带用途说明的 tokens.css、结构化的 system/studio.json，以及由令牌生成的 preview/cover.html 封面。
triggers:
  - "design system"
  - "brand kit"
  - "style guide"
  - "design tokens"
  - "tokens.css"
  - "DESIGN.md"
  - "build a design system"
  - "extract a design system"
  - "设计系统"
  - "品牌规范"
  - "设计令牌"
od:
  mode: design-system
  category: design-systems
  design_system:
    requires: false
  craft:
    requires: [color, accessibility-baseline, content-discipline]
---

# Design system builder

A design system exists so later agents can build on the brand. Author it from the brand's real sources, track the whole inventory, and leave behind files a consuming agent can follow without asking anyone. This skill carries the rules of the Claude Design system builder (`references/craft.md`) and its cover rules (`references/cover.md`), mapped onto FantayDesign's package layout.

## What a system is made of

The package lives at the root of the design-system project. Use these paths and no others for the core:

| Path | What it holds |
|---|---|
| `DESIGN.md` | The brand book, written as usage rules for a consuming agent (see below). At least seven H2 sections that describe this system's real content. |
| `tokens.css` | The single source of every value: compiled custom properties in a `:root` block (plus theme scopes such as `[data-theme="dark"]`). Each token has a one-line usage comment. |
| `system/studio.json` | The structured document the Studio editor reads: themes, token notes, type styles, components, blocks, patterns, templates, rules, a screen review checklist, content, brand and accessibility guidance, implementation links, governance, releases. |
| `preview/cover.html` | The cover that opens above the brand book (`references/cover.md`). Written last. |
| `components.html` | Optional executable proof that the tokens compose into real controls (at least four component groups, using declared tokens). |
| `assets/<Group>/`, `fonts/`, `logos/`, `imagery/` | Brand files, copied byte for byte. The first folder under `assets/` names the group the Studio shows them in: `assets/Logos/`, `assets/Icons/`, `assets/Imagery/`; a file straight under `assets/` lands in Other. |
| `manifest.json` | Present only when the project already has one. Never invent a second manifest; if one exists, add the cover to `preview.pages` as `{"path": "preview/cover.html", "role": "cover", "title": "Cover"}`. |

Do not create `README.md`, `tokens.json` or other loose root files: the package rejects them. Do not edit the generated block between `<!-- fantay-studio-handbook:start -->` and `<!-- fantay-studio-handbook:end -->` in `DESIGN.md`, or `system/studio-guide.md`; saving the structured document regenerates them.

Line length is `--measure-*` (`ch` for Latin text, `ic` for Chinese, about 36ic and never more than 40 CJK glyphs). Fixed sizes and proportions, where the source has them, are `--size-*`, `--control-height-*`, `--target-*` (24px is the WCAG 2.5.8 minimum), `--icon-size-*` and `--aspect-*`; the Studio files these under Sizing & ratios.

Token names follow the repository contract (`design-systems/_schema/`): keep the shared names (`--bg`, `--surface`, `--fg`, `--muted`, `--border`, `--accent`, `--accent-on`, `--success`, `--warn`, `--danger`, `--font-display`, `--font-body`, `--font-mono`, `--text-*`, `--space-*`, `--radius-*`, `--motion-*`, and the rest of the required slots in an existing system's `tokens.css`) and bind them to the brand's real values. Brand-specific extra tokens are allowed only where the importer's extension allowlist permits them, plus the Studio foundation families named above (`--measure-*`, `--size-*`, `--control-height-*`, `--target-*`, `--icon-size-*`, `--aspect-*`) and the layout and stacking families (`--breakpoint-*`, `--grid-*`, `--z-*`); otherwise express them as component-level values in `components.html`.

## Procedure

1. **Find the sources and enumerate the inventory first.** A codebase's styles and components, brand files, decks, guidelines, a design-tool export, a live site. List every token family, component family and asset you will cover, and track against that list. Questions to the user go through a `<question-form>`, not prose.
2. **Nothing to build from?** Make a small first system and say so: 6 to 10 colors in one theme, 5 to 7 text styles, 4 spacing steps, 3 radii, a one-paragraph `DESIGN.md` section per topic, no components.
3. **Write `tokens.css` first**, with exact values from the source (`references/craft.md`: exact values; one source for every value). Add a usage comment per token naming where it is used and, for text colors, the grounds it reads on.
4. **Write `DESIGN.md`** as rules for a consuming agent (`references/craft.md`: the DESIGN.md is usage rules). Name tokens in every rule. No title block, provenance, build notes or "next steps": those go in your reply.
5. **Write `system/studio.json`** with `schemaVersion: 1` (every other top-level section may be omitted and then reads as empty): `themes` for every scope in `tokens.css`, `tokenNotes` keyed by token name (`{group, layer: "primitive" | "semantic" | "component", description}`), `typeStyles` wired to the real fonts, then `components`, `blocks`, `patterns` and `templates` only for what the source defines. Every entry needs `id` (letters, digits, `_`, `-`), `name`, `description`, `status`, `usage`, `avoid`, `accessibility`, `api`, `variants`, `states` and `html`; set `group` (one line, at most 40 characters) to the job the source's own catalogue files it under, record the order in `groups.<section>` (keys `components`, `blocks`, `patterns`, `templates`; unique names), and leave both out when the source has no grouping, add `defaultVariant` (one of `variants`) where the source has a real choice, and `good` / `bad` (one example each, from real code) where the source shows one. List the states a component really has, focus included for anything interactive; do not pad every entry to the same set. `blocks` are named compositions the source's screens keep rebuilding (a page header, a task row), never invented up front. Write `rules` as `{id, rule, reason}`: one short instruction and the reason right after it, taken from the source's own conventions, and `reviewChecks` as the few checks to apply to the source of a screen while building it (raw values that are not tokens; loading, empty and error states; status text that matches the real state). The Studio turns `reviewChecks` into the on-demand skill `system/skills/screen-review/SKILL.md`; do not write that file or a review section into DESIGN.md yourself. Keep ids unique. Leave out any field the source gives nothing for: an empty section reads as empty, which is honest.
6. **Write `preview/cover.html` last**, from what you built (`references/cover.md`).
7. **Check before you hand over:** every contrast pair in `references/craft.md` (Legible in every theme), every token in `DESIGN.md` exists in `tokens.css`, no raw hex in `components.html` outside the copied `:root` block, the inventory list is complete or the remainder is named. Then reply with what you built from, what you assumed, and what remains of the inventory; offer once to take it further.

## Rules that decide quality

- **The DESIGN.md is for the agent that will consume it.** Imperative sentences that name tokens, styles and assets ("Set body copy in `--text-base`; `--fg` on `--surface`; the accent only for the primary action"). Cover content fundamentals (tone, casing, voice, emoji or not; quote real copy), visual foundations (color, type, spacing, imagery, motion, states, borders, shadows, radii, layout) and iconography. Its length tracks the source: a files-only drop earns a few bullets, a real codebase earns sections with the brand's own examples. Never pad.
- **Assets are copied, never approximated.** No logo in the sources: set the name in plain type and note the absence in the brand section. Never draw or reconstruct a real company's mark from memory, never rebrand with an identity the user did not provide. Copy the brand's own icons; if they are unreachable, substitute the closest match and flag it under iconography.
- **The source defines the inventory.** Real names and values, in the source's order. Components: exactly the families the source defines, with no "usual" extras (toast, avatar) unless listed under "Intentional additions" with a reason. Only a from-scratch or guidelines-only brand gets a standard set. If you stop early, report exactly what remains.
- **Exact values from real sources.** The source beats any library it resembles; copy paddings, radii, sizes and line-heights exactly (5px stays 5px). Code is truth, screenshots are lossy guidance. If reads fail partway, say what you did and did not read; never invent names, structure or values.
- **One source for every value.** `tokens.css` holds every value; `DESIGN.md`, `system/studio.json` and previews refer to tokens, not to restated literals.
- **Legible in every theme.** Text colors hold 4.5:1 on the grounds their usage note names (3:1 for large text, borders, focus rings and icons that carry meaning), in every theme. Use `--accent-on` style tokens for text on an accent instead of literal white. A high-contrast theme is an added theme (7:1), not a re-tint of the brand. Status colors carry a word or icon and never rely on a red and green pair told apart by hue alone.
- **Avoid AI tropes** unless the source truly has them: blue-purple gradients, emoji as decoration, rounded cards with a colored left border, filler stats, overused fonts. No filler content; never recreate a company's proprietary UI for someone who does not work there.

## References

| File | Read when |
|---|---|
| `references/craft.md` | Always, before writing `DESIGN.md` and `tokens.css`: the authoring rules in full. |
| `references/cover.md` | When writing `preview/cover.html`. |
