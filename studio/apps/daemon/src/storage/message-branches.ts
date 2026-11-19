import type { ChatMessageBranchRequest } from '@open-design/contracts';
import type { SqliteDb } from '../db.js';

interface MessageNode {
  id: string;
  parentId: string | null;
  role: string;
  selected: number;
  visible: number;
}

export class MessageBranchConflict extends Error {}

function nodes(db: SqliteDb, conversationId: string): MessageNode[] {
  return db.prepare(
    `SELECT id, role, branch_parent_id AS parentId, branch_selected AS selected,
            branch_visible AS visible
       FROM messages WHERE conversation_id = ? ORDER BY position`,
  ).all(conversationId) as MessageNode[];
}

function initializeBranches(db: SqliteDb, conversationId: string): void {
  const changed = db.prepare(
    `UPDATE conversations SET message_branches_enabled = 1
      WHERE id = ? AND message_branches_enabled = 0`,
  ).run(conversationId).changes;
  if (!changed) return;
  db.prepare(
    `WITH linear AS MATERIALIZED (
       SELECT id, LAG(id) OVER (ORDER BY position) AS parentId
         FROM messages WHERE conversation_id = ?
     )
     UPDATE messages SET branch_parent_id = (SELECT parentId FROM linear WHERE linear.id = messages.id)
      WHERE conversation_id = ?`,
  ).run(conversationId, conversationId);
}

export function activeMessageLeafId(db: SqliteDb, conversationId: string): string | null {
  const message = db.prepare(
    `SELECT id FROM messages WHERE conversation_id = ? AND branch_visible = 1
      ORDER BY position DESC LIMIT 1`,
  ).get(conversationId) as { id: string } | undefined;
  return message?.id ?? null;
}

export function messageBranchVersions(db: SqliteDb, conversationId: string): Map<string, string[]> {
  const conversation = db.prepare(
    'SELECT message_branches_enabled AS enabled FROM conversations WHERE id = ?',
  ).get(conversationId) as { enabled: number } | undefined;
  const versions = new Map<string, string[]>();
  if (!conversation?.enabled) return versions;
  const groups = new Map<string | null, MessageNode[]>();
  for (const node of nodes(db, conversationId)) {
    const group = groups.get(node.parentId);
    if (group) group.push(node);
    else groups.set(node.parentId, [node]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ids = group.map(node => node.id);
    const current = group.find(node => node.visible);
    if (current) versions.set(current.id, ids);
  }
  return versions;
}

function forgetResumeState(db: SqliteDb, conversationId: string): void {
  // A session handle and its latched intent belong to the previously selected
  // transcript. The next run can recover the new context from the visible path.
  db.prepare('DELETE FROM agent_sessions WHERE conversation_id = ?').run(conversationId);
  db.prepare('UPDATE conversations SET intent_signals_json = NULL WHERE id = ?').run(conversationId);
}

/** Called inside the run's message-claim transaction before inserting its fresh messages. */
export function beginMessageBranch(
  db: SqliteDb,
  conversationId: string,
  request: ChatMessageBranchRequest,
  userMessageId: string,
  assistantMessageId: string,
): void {
  if (activeMessageLeafId(db, conversationId) !== request.expectedLeafId) {
    throw new MessageBranchConflict('The active conversation changed. Reload it before trying again.');
  }
  const transcript = nodes(db, conversationId).filter(node => node.visible);
  const index = transcript.findIndex(node => node.id === request.messageId);
  const target = transcript[index];
  const regenerated = request.action === 'regenerate';
  if (!target || target.role !== (regenerated ? 'assistant' : 'user')) {
    throw new MessageBranchConflict('The selected message is no longer on the active branch.');
  }
  if (regenerated) {
    const user = transcript.slice(0, index).reverse().find(node => node.role === 'user');
    if (user?.id !== userMessageId) {
      throw new MessageBranchConflict('The selected reply does not belong to the supplied question.');
    }
  }
  const usedId = regenerated
    ? db.prepare('SELECT 1 FROM messages WHERE id = ?').get(assistantMessageId)
    : db.prepare('SELECT 1 FROM messages WHERE id = ? OR id = ?').get(assistantMessageId, userMessageId);
  if (usedId) throw new MessageBranchConflict('New message versions require unused message IDs.');

  initializeBranches(db, conversationId);
  // The old tail retains its own selections. Only the fork point changes,
  // and the new rows attach to the last message still visible.
  db.prepare('UPDATE messages SET branch_selected = 0 WHERE id = ?').run(target.id);
  const hide = db.prepare('UPDATE messages SET branch_visible = 0 WHERE id = ?');
  for (const node of transcript.slice(index)) hide.run(node.id);
  forgetResumeState(db, conversationId);
}

export function selectMessageBranch(
  db: SqliteDb,
  conversationId: string,
  messageId: string,
  expectedLeafId: string,
): void {
  db.transaction(() => {
    if (activeMessageLeafId(db, conversationId) !== expectedLeafId) {
      throw new MessageBranchConflict('The active conversation changed. Reload it before switching versions.');
    }
    const tree = nodes(db, conversationId);
    const target = tree.find(node => node.id === messageId);
    if (!target) throw new MessageBranchConflict('The requested message version does not exist.');
    if (target.visible) return;
    const current = tree.find(node => node.visible && node.parentId === target.parentId);
    if (!current || current.role !== target.role) {
      throw new MessageBranchConflict('The requested version is outside the active branch.');
    }
    const updateSelection = db.prepare('UPDATE messages SET branch_selected = ? WHERE id = ?');
    updateSelection.run(0, current.id);
    updateSelection.run(1, target.id);
    current.selected = 0;
    target.selected = 1;

    const selectedChildren = new Map(tree.filter(node => node.selected).map(node => [node.parentId, node]));
    const active = new Set<string>();
    let node = selectedChildren.get(null);
    while (node && !active.has(node.id)) {
      active.add(node.id);
      node = selectedChildren.get(node.id);
    }
    const updateVisibility = db.prepare('UPDATE messages SET branch_visible = ? WHERE id = ?');
    for (const candidate of tree) {
      const visible = Number(active.has(candidate.id));
      if (visible !== candidate.visible) updateVisibility.run(visible, candidate.id);
    }
    forgetResumeState(db, conversationId);
  }).immediate();
}
