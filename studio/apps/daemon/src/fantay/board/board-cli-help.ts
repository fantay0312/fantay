// SPDX-License-Identifier: Apache-2.0
// Help surface for `od board` (the project board, 画板). Kept pure and separate from the command module so a
// test can assert the advertised subcommands without spawning the CLI. Mirrors materials-cli-help.ts.

/**
 * Every `od board` subcommand. `generate` and `media` are dispatched to their own modules
 * (`fantay/board-generate-cli.ts`, `fantay/media-ops/media-ops-cli.ts`); see board-cli.ts.
 */
export const BOARD_SUBCOMMANDS = [
  'show', 'add', 'update', 'remove', 'move', 'layout', 'connect', 'group', 'ungroup',
  'sync', 'apply', 'replace', 'import-canvas', 'pages', 'generate', 'media',
] as const;
export type BoardSubcommand = (typeof BOARD_SUBCOMMANDS)[number];

/** Exit codes shared by every `od board` subcommand, `generate` and `media` included. */
export const BOARD_EXIT_CODES = {
  ok: 0,
  /** Anything else, including `not-implemented`. */
  error: 1,
  /** `invalid-request`: bad flags or arguments, or a request the daemon rejected as invalid. */
  usage: 2,
  daemonNotRunning: 64,
  /** `missing-input`: no project id. */
  missingInput: 67,
  projectNotFound: 68,
  /** `board-revision-conflict` after the retries (reuses the `snapshot-stale` number). */
  revisionConflict: 72,
  /** `od board generate`: generation still running when `--timeout` elapsed. */
  generationRunning: 73,
  /** `od board generate`: every candidate failed. */
  generationFailed: 74,
} as const;

export const BOARD_USAGE = `Usage:
  od board pages [--add <title>] [--rename <pageId> --title <t>] [--remove <pageId>] [--json]
      List the canvas pages, or add, rename or remove one. Removing a page
      removes its nodes (never their files). New nodes go to the page the
      user is on unless \`od board add\` is given --page <pageId>.
  od board show [--node <id>]... [--kind <kind>] [--no-sync] [--include-sync] [--json]
      Place new chat outputs (sync; skipped with --no-sync), then print the
      board: one line per node with id, kind, title|path|url, position and
      size, group, variant label and pending/missing flags. --node and
      --kind filter the nodes; --include-sync adds the sync ledger.
  od board add <kind> [kind flags] [placement] [--group <groupId>] [--title <t>]
               [--variant-label <label>] [--id <id>] [--if-absent] [--json]
      Add one node. Kinds and their flags:
        frame       --path <file.html> | --live-artifact <id>  [--device desktop|tablet|mobile|custom]
        web         --url <http(s) url>  [--device …]
        image|video|audio
                    --path <project file>
        note        --text <t> | --prompt-file <path|->  [--color <palette color>]
        shape       --shape rect|ellipse|text  [--text <t> | --prompt-file <path|->]
                    [--fill <color|none>] [--stroke <color|none>]
        group       --role section|variants
        generator   --surface image|video --model <id> (--prompt <t> | --prompt-file <path|->)
                    [--count 1-4] [--aspect 1:1|16:9|9:16|4:3|3:4] [--quality <q>]
                    [--resolution <r>] [--duration <sec>]
        design      --path designs/<name>.fig|.op
        motion      --movie <projectId> | --composition <path> [--render <file.mp4>]
      Placement: --x <n> --y <n> | --near <nodeId> [--side right|below]
      (default: below the current content). --if-absent skips an existing --id.
  od board update <nodeId> [--title <t>] [--text <t> | --prompt-file <path|->]
                  [--x <n>] [--y <n>] [--w <n>] [--h <n>] [--locked true|false]
                  [--hidden true|false] [--variant-label <label>|none]
                  [--parent <groupId>|none] [--patch-file <path|->] [--json]
      Patch one node. --text sets note/shape text or a generator prompt.
      --patch-file reads a JSON node patch (null clears a field); flags win.
  od board remove <nodeId...> [--cascade] [--json]
      Remove nodes and their edges. Children of a removed group move up one
      level unless --cascade removes them too. Unknown ids are skipped.
  od board move <nodeId...> (--x <n> --y <n> | [--dx <n>] [--dy <n>]) [--json]
      --x/--y: the first node goes to (x,y), the others keep their offsets.
      --dx/--dy: every node moves by the delta. Moving a group moves its
      contents.
  od board layout (--group <id> | --nodes <id,id,...> | --all)
                  [--mode row|column|grid|tidy] [--gap <n>] [--columns <n>] [--json]
      Arrange nodes (default mode tidy).
  od board connect <fromId> <toId> [--kind reference|output|lineage] [--label <t>] [--json]
      Add an edge (default lineage). reference: image|note|frame|web|design to
      a generator; output: generator to image|video|audio. An edge that
      already exists is reported and kept (exit 0).
  od board group <nodeId...> [--title <t>] [--role section|variants] [--json]
      Wrap sibling nodes in a new group (default role section).
  od board ungroup <groupId> [--json]
      Remove a group and keep its children where they are.
  od board sync [--json]
      Place new chat outputs, media tasks and renamed or deleted files now
      (the same planner the workspace runs).
  od board apply --prompt-file <path|-> [--json]
      Apply contract ops: a JSON BoardOp[] or {"ops":[...]} (at most 200).
  od board replace (--file <path|-> | --empty) [--base-revision <n>] [--json]
      Replace the whole board. --file reads {nodes, edges, title?, settings?}
      or the output of \`od board show --json\`; --empty clears nodes and
      edges. Default base revision: the current one (re-read on conflict);
      an explicit --base-revision fails with 72 instead of retrying.
  od board import-canvas (<documentId...> | --all) [--json]
      Copy global design-canvas documents into designs/ and add design nodes
      (already imported documents are reported, not copied twice).
  od board generate [<generatorNodeId>] [--create] [--surface image|video]
                    [--prompt <text> | --prompt-file <path|->] [--model <id>]
                    [--aspect <ratio>] [--quality <q>] [--resolution <r>]
                    [--length <sec>] [--count 1-4] [--locale zh-CN|en]
                    [--no-wait] [--timeout <sec>] [--json]
      Run a generator node with the configured media providers and write the
      candidates back to the board. \`od board generate --help\` lists the
      details; \`od media generate|wait\` stay the low-level path.
  od board media <crop|split|scale|frame> [op flags] [--json]
      Crop, split into tiles, scale (upscale) or grab a video frame from a
      project image or video; results are new project files.
      \`od board media --help\` lists the flags of each op.

Common options:
  --project <id>          Project (default $OD_PROJECT_ID).
  --workspace <id> --workspace-member <id>
                          Team-project identity, both or neither (default
                          $OD_WORKSPACE_ID + $OD_WORKSPACE_MEMBER_ID when both
                          are set). Empty values mean no workspace.
  --daemon-url <url>      Fantay daemon HTTP base.
  --json                  Print the daemon response as pretty JSON.
  --prompt-file -, --patch-file -, --file - read stdin (one of them per call).

Writes are recorded as {"kind":"agent","runId":$OD_STOCK_RUN_ID} when that
variable is set, else {"kind":"cli"}. add, update, remove, move, layout,
connect, group, ungroup, apply and replace read the board first and send its
revision (plus each node's rev for update, move, remove and ungroup); on a
revision conflict they re-read and retry, 3 attempts in all.

Exit codes:
  0 ok; 2 usage (invalid-request); 64 daemon-not-running; 67 missing-input
  (no project id); 68 project-not-found; 72 board-revision-conflict (after
  the retries); 73 generation still running at --timeout; 74 every
  candidate failed; 1 anything else (including not-implemented).
  Errors print {"error":{"code","message","data"}} on stderr.`;

// `help`, `--help`, and `-h` all route to the usage text above.
export function isBoardHelpArg(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h';
}
