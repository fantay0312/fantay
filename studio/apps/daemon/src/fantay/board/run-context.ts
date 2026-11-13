// SPDX-License-Identifier: Apache-2.0
// `board-selection` run context (spec 04 §6.3): the daemon-side whitelist for the nodes the user selected on the
// project board, their prompt rendering and the agent tool hint. Wired into `runtimes/chat-run-context.ts`, which
// feeds both prompt implementations.
import {
  BOARD_ID_PATTERN,
  BOARD_LIMITS,
  BOARD_NODE_KINDS,
  type BoardNodeKind,
  type WorkspaceContextBoardNode,
} from '@open-design/contracts';

/**
 * Agent hint shown once per run when the context carries a board selection. `board generate` and `board media` are
 * named up front (amendment B7); their modules land with the generation and media-ops tasks.
 */
export const BOARD_SELECTION_TOOL_HINT =
  '- Board selection: the user selected these nodes on the project board (画板). File-backed nodes list their project-relative path; read and edit those files directly. Note text is the user\'s own instruction or reference. To produce alternatives of a selected file, write sibling files named `<name>.variant-<label>.<ext>`; the board groups them next to the original automatically. To inspect or rearrange the board itself, run `"$OD_NODE_BIN" "$OD_BIN" board show --json`, then `board move|layout|add|update|remove` (see `board --help`). `board generate <generatorNodeId>` runs a selected generator node, and `board media crop|split|scale|frame` derives new project files from a selected image or video.';

const FIELD_LIMITS = {
  id: 64,
  label: 120,
  path: 500,
  url: 1000,
  text: 500,
  group: 120,
  variantLabel: 32,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Trimmed, single-line, length-capped string ('' when absent). */
function cleanField(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/**
 * Whitelists `item.nodes` of a `board-selection` context item: at most `BOARD_LIMITS.maxSelectionContextNodes`
 * nodes; each needs an id matching `BOARD_ID_PATTERN` (≤ 64), a board node kind and a label (≤ 120). Optional
 * fields are trimmed and capped (path ≤ 500, url ≤ 1000, text ≤ 500, group ≤ 120, variantLabel ≤ 32). Duplicate ids
 * keep the first entry. Returns undefined when nothing valid remains.
 */
export function normalizeBoardSelectionNodes(value: unknown): WorkspaceContextBoardNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: WorkspaceContextBoardNode[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (out.length >= BOARD_LIMITS.maxSelectionContextNodes) break;
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id.length > FIELD_LIMITS.id || !BOARD_ID_PATTERN.test(id) || seen.has(id)) continue;
    const kind = entry.kind;
    if (typeof kind !== 'string' || !(BOARD_NODE_KINDS as readonly string[]).includes(kind)) continue;
    const label = cleanField(entry.label, FIELD_LIMITS.label);
    if (!label) continue;
    seen.add(id);
    const node: WorkspaceContextBoardNode = { id, kind: kind as BoardNodeKind, label };
    const pathValue = cleanField(entry.path, FIELD_LIMITS.path);
    const url = cleanField(entry.url, FIELD_LIMITS.url);
    const text = cleanField(entry.text, FIELD_LIMITS.text);
    const group = cleanField(entry.group, FIELD_LIMITS.group);
    const variantLabel = cleanField(entry.variantLabel, FIELD_LIMITS.variantLabel);
    if (pathValue) node.path = pathValue;
    if (url) node.url = url;
    if (text) node.text = text;
    if (group) node.group = group;
    if (variantLabel) node.variantLabel = variantLabel;
    out.push(node);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * One line per node: `   - <kind> "<label>" (`<id>`)` followed by ` path: `<path>``, ` url: <url>`,
 * ` text: "<text>"`, ` group: <group>` and ` variant: <label>` when present.
 */
export function formatBoardSelectionNodes(nodes: readonly WorkspaceContextBoardNode[]): string {
  return nodes
    .map((node) => {
      const parts = [`   - ${node.kind} "${node.label}" (\`${node.id}\`)`];
      if (node.path) parts.push(` path: \`${node.path}\``);
      if (node.url) parts.push(` url: ${node.url}`);
      if (node.text) parts.push(` text: "${node.text}"`);
      if (node.group) parts.push(` group: ${node.group}`);
      if (node.variantLabel) parts.push(` variant: ${node.variantLabel}`);
      return parts.join('');
    })
    .join('\n');
}
