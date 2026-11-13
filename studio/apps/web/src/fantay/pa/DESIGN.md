# Fantay workspace (formerly PA)

One-page guide for maintainers. The full redesign spec (2026-11-10) is the source of these rules; this page keeps the parts every change must respect.

## Binding rules

- **Owner taste.** Every tab is inline (never a "更多" overflow; a per-row ⋯ action menu is fine). Management and settings open a Fantay `Modal`; nothing unfolds inline and pushes the page. Segmented and filter rows span the full row with equal segments; KPI and footer text never truncates. Settings-like pages are a heading plus hairline group blocks. Disclosures are styled rows with a rotating chevron, never a raw `<details>`. Chat first: no type picker before the owner says anything. Desktop only, light and dark, Chinese first (English must fit too).
- **Governance** (`tests/fantay/governance.test.ts`). No raw `<button|select|textarea|input>`; use `../ui`. No `text-[Npx]`, `rounded-[Npx]`, bold weights or hex colours in `.tsx`. SPDX `AGPL-3.0-only` header on every source. Rule B1: a PA module may read only tokens from `packages/fantay-tokens/tokens.css`, `styles/legacy-aliases.css`, CSS under `src/fantay/` or inline styles — never `--chat-*`, `--font-size-*`, `--radius-xl`, `--shadow-md`, `--ease-out`. PA tokens live in `styles/pa.css`.
- **Honesty.** Activity comes from persisted events and goal progress comes from linked tasks. Routines run only at opted-in daily slots while the local service is available. Voice records on click and returns an editable draft. Never offer Resume when the daemon would refuse it (`pa-model.canResume`). Unreported usage reads "用量未报告", never 0. Channel chats say desktop replies do not go back to the channel.
- **`.fx` preflight.** The view renders in `FxRoot`; upstream markup (`renderMarkdown`, `.prose-block`, `ChatRoot`) goes inside `FxLegacy`.

## Layout

- `PersonalAgentWorkspace.tsx` is the root: `FxRoot[data-testid=pa-workspace]`, a grid of roster (`--pa-roster-col`) beside the main area. The main area is a conversation (chat column + inspector) or one page (动态, 任务, 记忆, 连接) that replaces the whole chat area, inspector included. The activity page keeps 动态, 目标 and 例行任务 visible as inline tabs.
- `styles/pa.css` makes the PA view full-bleed inside the entry shell (`entry-view-pa[data-active=true]`).
- `usePaLayout` measures the host (default 1280 when unmeasured):

| Host width | Roster | Inspector |
|---|---|---|
| ≥ 1180 | full 260 | docked, 340 (300–420, chat keeps ≥ 520) |
| 900–1179 | full 260 | floating 340, closed by default; does not change the docked preference |
| 720–899 | rail 64 | floating |
| < 720 | sheet (left `Sheet`, 300) | floating, `min(340, W − 24)` |

- Only these scroll: the roster list, the transcript, the inspector pane body, the page body, a modal body, the `@` list. The composer never scrolls away.
- View state (`place`, conversation, inspector, filters, modal, roster query) lives in the root and survives tab switches (the view stays mounted). `fantay.pa.ui.v1` remembers `{conversationId, inspectorOpen, inspectorWidth}`; `fantay.pa.seen.v1` holds the unread map. Both are guarded with try/catch.
- Default conversation: the remembered one, else Fantay's latest direct chat, else the first group chat, else the first conversation, else the Fantay empty state.

## Mascot and avatars

- **Fantay** is the main assistant: the agent with `avatar === 'fantay'`, else `agents[0]` (`pa-model.findFantay`). Its displayed name is always the live `agent.name`; the module label is the static `pa.title` = "Fantay". Only Fantay wears the mascot; a clone loses it.
- **Live mascot budget: at most 3 on screen** — the sidebar/rail icon while work runs (dwell 600 ms), the inspector hero (104, when open), and one transcript slot (the empty-state greeting when the inspector is closed, or the working line; never both). Everywhere else use the zero-JS `FantayMascotStill` (rail/roster disc 34, rows 28, clusters 65 %, empty illustrations 48, receipts 20).
- **Other agents** (`PaAvatar`): five folded-paper faces, stable per agent ID, tinted sage, teal, ochre, rose or slate. The mascot keeps its own silhouette and palette. The owner message bubble uses charcoal with light ink in dark mode.
- **Group clusters** (`PaGroupAvatar`): 1 face; 2 on a diagonal at 65 %; 3 in a triangle at 54 %; 4+ two faces plus "+N". Each face on a 2 px `--paper` collar; Fantay on a surface disc.
- **Colour meaning.** Warm (`--warning`) only for needs you (waiting tasks that need an action, channel approvals, uncertain deliveries). Failed is `--accent-ink`. Everything else is ink.

## Motion

Tokens (`styles/pa.css`): `--pa-ease` quint `cubic-bezier(0.23,1,0.32,1)`, `--pa-ease-fold` `cubic-bezier(0.32,0.72,0,1)` (folds only), `--pa-ease-pop` (only the step-done tick), `--pa-dur-quick 120`, `--pa-dur-enter 240`, `--pa-dur-exit 160`, `--pa-dur-fold 280`, `--pa-dur-swap 300`, `--pa-loop-shimmer 1.8s`.

| Moment | Motion |
|---|---|
| New turn or message | opacity + `translateY(6px)`, 240 ms (history renders still) |
| Conversation switch | fade in 200 ms, no slide, no exit |
| Working line | presence 160 ms; enter opacity + 4 px, 200 ms; label `SwapLabel` 300 ms; shimmer 1.8 s linear |
| Needs-you / approval card | opacity + `scale(.97 → 1)`, 240 ms; answered card dims to .7 over 160 ms |
| Docked inspector | column width 0 ↔ W, 240 ms open / 160 ms close; content keeps its width and fades |
| Floating inspector | opacity + `translateX(12px)`, 200 ms in / 150 ms out |
| Inspector tabs | chip glides 240 ms; pane items enter ±8 px, staggered 18 ms over 6 |
| Disclosure | grid rows 0fr ↔ 1fr + opacity, 280 ms fold / 160 ms close; chevron 90° in 150 ms |
| Row hover | background 120 ms; selection instant; hover actions swap in place ±5 px over 160 ms |
| Modals, sheet, popovers | the primitives' own motion (`fx-modal-in` from .96) |

Never animate from `scale(0)` (surfaces ≥ .96, icons ≥ .6). Under `prefers-reduced-motion` only opacity changes of ≤ 160 ms remain: no shimmer, stagger or glide, and the mascot is static.

## Where things live

`pa-types.ts` (contracts) · `pa-model.ts` (pure rules mirroring `apps/daemon/src/services/personal-agent-service.ts`; tested in `tests/fantay/pa/pa-model.test.ts`) · `usePaWorkspace.ts` (polling while active: snapshot 2 s with 2→4→8 s backoff, control and channels 5 s, models per activation; per-action pending keys) · `pa-transport.tsx` (injectable request function for the lab) · `PaRoster`, `PaAvatar`, `PaModalHost` (shell) · conversation, composer, inspector, cards, pages and modals in their own files.
