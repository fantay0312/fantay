// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — conversation readers and the raw-window builder.
//
// Raw windows are a projection of stored messages. Every message becomes one `[HH:mm] Speaker: text` line and the
// lines are packed into overlapping windows that retrieval searches next to the extracted items.
//
// Incremental sync. The layout is a pure function of the messages and is prefix-stable: a window closes when the
// next line no longer fits, so appending messages only changes the last window and adds new ones. A message that
// has to be split always starts a fresh window, so the open region (the last window, plus the earlier windows of
// a split message that reaches into it) begins at a message boundary. The cursor handed to the sink holds
//   messageCount  messages covered by the windows before the open region,
//   prefixHash    `closed:open[:stamp]` where `closed` fingerprints those windows, `open` fingerprints the rest and
//                 `stamp` is a source-specific change marker (Studio) used to skip untouched conversations.
// Fingerprints cover everything that is written (text, ids, times, data class) and the conversation facts, so an
// edit of any closed message, a deletion, or a change of scope sends the rebuild back to seq 0, while an unchanged
// conversation writes nothing.

import { createHash } from "node:crypto";
import { parseArtifactAttrs, type PaDataClass } from "@open-design/contracts";
import type { SqliteDb } from "../../db.js";
import type { ChunkScopeInput } from "./policy.js";
import type { ChunkSink, ChunkWindow, IngestMessage } from "./types.js";

const DEFAULT_WINDOW_CHARS = 500;
const DEFAULT_OVERLAP_CHARS = 80;
const MIN_WINDOW_CHARS = 100;
const MIN_SEGMENT_CHARS = 24;
const MAX_MESSAGE_CHARS = 1200;
const MAX_SPEAKER_CHARS = 40;
const MAX_FENCE_BODY_CHARS = 600;
const TRUNCATION_MARK = "…（已截断）";
const DEFAULT_PRINCIPAL = "owner";
const USER_SPEAKER = "用户";
const ASSISTANT_SPEAKER = "助手";
const UNKNOWN_SPEAKER = "未知";
/** Bump when the layout rules change so stored windows are rebuilt. */
const LAYOUT_VERSION = 1;
const COMMENT_ANCHOR_PREFIX = "comment-anchor-";
/** Written between the calls of a split write; it never parses, so an interrupted write is rebuilt from seq 0. */
const UNFINISHED_CURSOR: Cursor = { messageCount: 0, prefixHash: "" };

type ChunkScope = Omit<ChunkScopeInput, "speakerAgentIds">;
type Cursor = { messageCount: number; prefixHash: string };

interface PreparedMessage {
  id: string;
  speaker: string;
  agentId: string | null;
  text: string;
  at: number;
  dataClass: PaDataClass;
}

interface Line {
  text: string;
  message: PreparedMessage;
  /** Index among the prepared (non-empty) messages. */
  messageIndex: number;
}

/** Lines [start, end) form one window; lines before `ownStart` are the overlap repeated from the previous one. */
interface Draft {
  start: number;
  ownStart: number;
  end: number;
  /** Length of the joined content so far. */
  size: number;
  firstMessageIndex: number;
}

interface PlacedWindow {
  window: ChunkWindow;
  dataClass: PaDataClass;
  /** First message that contributes its own line (not an overlap line) to this window. */
  firstMessageIndex: number;
}

// ---- Window builder ----------------------------------------------------------------------------------------------

/**
 * Packs messages into windows and returns those with `seq >= fromSeq`. The whole conversation is laid out on every
 * call (string work only), which keeps the result independent of where a caller resumes.
 */
export function buildWindows(
  messages: readonly IngestMessage[],
  options: { fromSeq: number; windowChars?: number; overlapChars?: number },
): ChunkWindow[] {
  const { windowChars, overlapChars } = resolveSizes(options);
  const fromSeq = Math.max(0, Math.floor(options.fromSeq));
  return layoutWindows(messages, windowChars, overlapChars)
    .slice(fromSeq)
    .map((placed) => placed.window);
}

function resolveSizes(options: { windowChars?: number; overlapChars?: number }): {
  windowChars: number;
  overlapChars: number;
} {
  const windowChars = Math.max(MIN_WINDOW_CHARS, Math.floor(options.windowChars ?? DEFAULT_WINDOW_CHARS));
  const requested = Math.max(0, Math.floor(options.overlapChars ?? DEFAULT_OVERLAP_CHARS));
  return { windowChars, overlapChars: Math.min(requested, Math.floor(windowChars / 2)) };
}

function layoutWindows(
  messages: readonly IngestMessage[],
  windowChars: number,
  overlapChars: number,
): PlacedWindow[] {
  const lines: Line[] = [];
  const drafts: Draft[] = [];
  let open: Draft | null = null;

  for (const [messageIndex, message] of prepareMessages(messages).entries()) {
    const texts = renderLines(message, windowChars);
    for (const [part, text] of texts.entries()) {
      const line: Line = { text, message, messageIndex };
      lines.push(line);
      const lineIndex = lines.length - 1;
      const startsSplitMessage = part === 0 && texts.length > 1;
      if (open && (startsSplitMessage || open.size + 1 + text.length > windowChars)) {
        drafts.push(open);
        open = null;
      }
      if (open) {
        open.end = lineIndex + 1;
        open.size += 1 + text.length;
      } else {
        open = beginDraft(lines, line, lineIndex, windowChars, overlapChars);
      }
    }
  }
  if (open) drafts.push(open);
  return drafts.map((draft, seq) => placeWindow(draft, seq, seq === drafts.length - 1, lines));
}

/** The overlap is the trailing whole lines before `ownStart`, as many as fit in the budget and in the window. */
function beginDraft(
  lines: readonly Line[],
  line: Line,
  ownStart: number,
  windowChars: number,
  overlapChars: number,
): Draft {
  const budget = Math.min(overlapChars, windowChars - line.text.length - 1);
  let start = ownStart;
  let overlap = 0;
  for (let previous = lines[start - 1]; previous; previous = lines[start - 1]) {
    const cost = previous.text.length + 1;
    if (overlap + cost > budget) break;
    overlap += cost;
    start -= 1;
  }
  return { start, ownStart, end: ownStart + 1, size: overlap + line.text.length, firstMessageIndex: line.messageIndex };
}

function placeWindow(draft: Draft, seq: number, open: boolean, lines: readonly Line[]): PlacedWindow {
  const texts: string[] = [];
  const speakers = new Set<string>();
  const agentIds = new Set<string>();
  const messageIds = new Set<string>();
  let startAt = Number.POSITIVE_INFINITY;
  let endAt = Number.NEGATIVE_INFINITY;
  let dataClass: PaDataClass = "standard";
  // The overlap lines are part of the content, so their messages count for speakers, ids and data class too.
  for (const { text, message } of lines.slice(draft.start, draft.end)) {
    texts.push(text);
    speakers.add(message.speaker);
    if (message.agentId) agentIds.add(message.agentId);
    messageIds.add(message.id);
    startAt = Math.min(startAt, message.at);
    endAt = Math.max(endAt, message.at);
    if (message.dataClass === "local_only") dataClass = "local_only";
  }
  return {
    window: {
      seq,
      content: texts.join("\n"),
      speakers: [...speakers],
      speakerAgentIds: [...agentIds],
      messageIds: [...messageIds],
      startAt,
      endAt,
      open,
    },
    dataClass,
    firstMessageIndex: draft.firstMessageIndex,
  };
}

// ---- Rendering ---------------------------------------------------------------------------------------------------

function prepareMessages(messages: readonly IngestMessage[]): PreparedMessage[] {
  const prepared: PreparedMessage[] = [];
  for (const message of messages) {
    const text = clipText(normalizeText(message.text));
    if (!text) continue;
    prepared.push({
      id: message.id,
      speaker: normalizeText(message.speaker).slice(0, MAX_SPEAKER_CHARS) || UNKNOWN_SPEAKER,
      agentId: message.agentId,
      text,
      at: Number.isFinite(message.at) ? message.at : 0,
      dataClass: message.dataClass,
    });
  }
  return prepared;
}

/** One message is one line: control characters and every run of whitespace, newlines included, become a space. */
function normalizeText(raw: string): string {
  return raw.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

function clipText(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const end = endsOnHighSurrogate(text, MAX_MESSAGE_CHARS) ? MAX_MESSAGE_CHARS - 1 : MAX_MESSAGE_CHARS;
  return text.slice(0, end).trimEnd() + TRUNCATION_MARK;
}

function endsOnHighSurrogate(text: string, end: number): boolean {
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function clock(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** A message longer than a window is split at sentence ends; every piece keeps the `[HH:mm] Speaker:` prefix. */
function renderLines(message: PreparedMessage, windowChars: number): string[] {
  const prefix = `[${clock(message.at)}] ${message.speaker}: `;
  if (prefix.length + message.text.length <= windowChars) return [prefix + message.text];
  const budget = Math.max(MIN_SEGMENT_CHARS, windowChars - prefix.length);
  return splitAtSentences(message.text, budget).map((piece) => prefix + piece);
}

const SENTENCE_END = new Set(["。", "！", "？", "!", "?", "；", ";"]);
const SENTENCE_CLOSER = new Set(["”", "’", "」", "』", "）", ")", "]", '"', "'"]);
const SOFT_BREAK = new Set([" ", "，", ",", "、", "：", ":"]);

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    const ends = SENTENCE_END.has(char) || ((char === "." || char === "…") && (next === "" || next === " "));
    index += 1;
    if (!ends) continue;
    while (index < text.length && (SENTENCE_END.has(text.charAt(index)) || SENTENCE_CLOSER.has(text.charAt(index)))) {
      index += 1;
    }
    sentences.push(text.slice(start, index));
    start = index;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}

function splitAtSentences(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let current = "";
  const flush = (): void => {
    const piece = current.trim();
    if (piece) pieces.push(piece);
    current = "";
  };
  for (const sentence of splitSentences(text)) {
    if (sentence.length > budget) {
      flush();
      pieces.push(...splitHard(sentence.trim(), budget));
    } else if (current.length + sentence.length > budget) {
      flush();
      current = sentence;
    } else {
      current += sentence;
    }
  }
  flush();
  return pieces;
}

/** A single sentence longer than the budget: cut at a space or comma near the end when there is one. */
function splitHard(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    const cut = softBreakBefore(rest, budget) ?? (endsOnHighSurrogate(rest, budget) ? budget - 1 : budget);
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function softBreakBefore(text: string, budget: number): number | null {
  const lowest = Math.floor(budget * 0.6);
  for (let index = budget - 1; index >= lowest; index -= 1) {
    if (SOFT_BREAK.has(text.charAt(index))) return index + 1;
  }
  return null;
}

// ---- Cursor and sync ---------------------------------------------------------------------------------------------

interface ConversationFacts {
  principalId: string;
  scope: ChunkScope;
}

interface CursorParts {
  closed: string;
  open: string;
  stamp: string;
}

function encodeCursor(parts: CursorParts): string {
  return parts.stamp ? `${parts.closed}:${parts.open}:${parts.stamp}` : `${parts.closed}:${parts.open}`;
}

function decodeCursor(prefixHash: string): CursorParts | null {
  const [closed, open, stamp = ""] = prefixHash.split(":");
  return closed && open ? { closed, open, stamp } : null;
}

function fingerprint(placed: PlacedWindow): string {
  const { window } = placed;
  return createHash("sha1")
    .update(
      JSON.stringify([
        placed.dataClass,
        window.speakers,
        window.speakerAgentIds,
        window.messageIds,
        window.startAt,
        window.endAt,
        window.content,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Digest of windows [from, to), seeded with the conversation facts so a change of scope invalidates it. */
function chainDigest(seed: string, fingerprints: readonly string[], from: number, to: number): string {
  return createHash("sha1").update(seed).update("\n").update(fingerprints.slice(from, to).join(",")).digest("hex").slice(0, 20);
}

function seedOf(facts: ConversationFacts): string {
  const { scope } = facts;
  return JSON.stringify([
    LAYOUT_VERSION,
    DEFAULT_WINDOW_CHARS,
    DEFAULT_OVERLAP_CHARS,
    facts.principalId,
    scope.projectId ?? null,
    scope.agentId ?? null,
    scope.groupId ?? null,
    scope.channel ?? false,
  ]);
}

/** First window of the open region: the last window, or the first window of the split message that reaches it. */
function openRegionStart(placed: readonly PlacedWindow[]): number {
  let seq = placed.length - 1;
  if (seq < 0) return 0;
  const first = placed[seq]?.firstMessageIndex;
  while (seq > 0 && placed[seq - 1]?.firstMessageIndex === first) seq -= 1;
  return seq;
}

/**
 * Where the stored windows stop being valid. A stored cursor is trusted only when the windows this layout puts
 * before the stored open region still hash to the stored `closed` fingerprint; anything else rebuilds from 0.
 */
function resumeSeq(
  stored: Cursor,
  storedParts: CursorParts,
  placed: readonly PlacedWindow[],
  fingerprints: readonly string[],
  seed: string,
): number {
  if (stored.messageCount === 0) return 0;
  const seq = placed.findIndex((window) => window.firstMessageIndex >= stored.messageCount);
  if (seq < 0 || placed[seq]?.firstMessageIndex !== stored.messageCount) return 0;
  return chainDigest(seed, fingerprints, 0, seq) === storedParts.closed ? seq : 0;
}

function syncMessages(sink: ChunkSink, facts: ConversationFacts, messages: readonly IngestMessage[], stamp: string): void {
  const placed = layoutWindows(messages, DEFAULT_WINDOW_CHARS, DEFAULT_OVERLAP_CHARS);
  const fingerprints = placed.map(fingerprint);
  const seed = seedOf(facts);
  const restart = openRegionStart(placed);
  const next: CursorParts = {
    closed: chainDigest(seed, fingerprints, 0, restart),
    open: chainDigest(seed, fingerprints, restart, placed.length),
    stamp,
  };
  const messageCount = placed[restart]?.firstMessageIndex ?? 0;
  const cursor: Cursor = { messageCount, prefixHash: encodeCursor(next) };

  const { source, conversationId } = facts.scope;
  const stored = sink.cursor(source, conversationId);
  if (!stored && placed.length === 0) return;
  const storedParts = stored ? decodeCursor(stored.prefixHash) : null;

  if (stored && storedParts) {
    const sameWindows =
      stored.messageCount === messageCount && storedParts.closed === next.closed && storedParts.open === next.open;
    if (sameWindows) {
      // Only the change marker moved: record it without touching any window.
      if (storedParts.stamp !== stamp) writeFrom(sink, facts, placed, placed.length, cursor);
      return;
    }
    writeFrom(sink, facts, placed, resumeSeq(stored, storedParts, placed, fingerprints, seed), cursor);
    return;
  }
  writeFrom(sink, facts, placed, 0, cursor);
}

/**
 * Writes windows `fromSeq` on. The sink takes one data class per call, so a run of windows with the same class is
 * one call, in ascending order: each call replaces everything from its first seq on, which the next call then refills.
 * Only the last call stores the real cursor.
 */
function writeFrom(
  sink: ChunkSink,
  facts: ConversationFacts,
  placed: readonly PlacedWindow[],
  fromSeq: number,
  cursor: Cursor,
): void {
  const runs = groupByDataClass(placed.slice(fromSeq));
  if (runs.length === 0) runs.push({ dataClass: "standard", fromSeq, windows: [] });
  for (const [index, run] of runs.entries()) {
    sink.writeWindows({
      source: facts.scope.source,
      conversationId: facts.scope.conversationId,
      fromSeq: run.fromSeq,
      windows: run.windows,
      dataClass: run.dataClass,
      principalId: facts.principalId,
      cursor: index === runs.length - 1 ? cursor : UNFINISHED_CURSOR,
      scope: facts.scope,
    });
  }
}

function groupByDataClass(placed: readonly PlacedWindow[]): Array<{
  dataClass: PaDataClass;
  fromSeq: number;
  windows: ChunkWindow[];
}> {
  const runs: Array<{ dataClass: PaDataClass; fromSeq: number; windows: ChunkWindow[] }> = [];
  for (const { window, dataClass } of placed) {
    const last = runs.at(-1);
    if (last && last.dataClass === dataClass) last.windows.push(window);
    else runs.push({ dataClass, fromSeq: window.seq, windows: [window] });
  }
  return runs;
}

/** The conversation is gone: its windows go with it, once. */
function clearWindows(sink: ChunkSink, source: "pa" | "studio", conversationId: string): void {
  const stored = sink.cursor(source, conversationId);
  if (!stored || (stored.messageCount === 0 && stored.prefixHash === "")) return;
  sink.writeWindows({
    source,
    conversationId,
    fromSeq: 0,
    windows: [],
    dataClass: "standard",
    principalId: DEFAULT_PRINCIPAL,
    cursor: UNFINISHED_CURSOR,
    scope: { source, conversationId },
  });
}

// ---- Personal agent conversations --------------------------------------------------------------------------------

export interface PaConversationReader {
  conversation(id: string): {
    id: string;
    title: string;
    agentId: string | null;
    groupId: string | null;
    channel: boolean;
    principalId: string;
  } | null;
  /** Already filtered to what belongs in context. */
  messages(conversationId: string): IngestMessage[];
}

export function ingestPaConversation(sink: ChunkSink, reader: PaConversationReader, conversationId: string): void {
  const conversation = reader.conversation(conversationId);
  if (!conversation) {
    clearWindows(sink, "pa", conversationId);
    return;
  }
  syncMessages(
    sink,
    {
      principalId: conversation.principalId,
      scope: {
        source: "pa",
        conversationId,
        agentId: conversation.agentId,
        groupId: conversation.groupId,
        channel: conversation.channel,
      },
    },
    reader.messages(conversationId),
    "",
  );
}

// ---- Studio conversations ----------------------------------------------------------------------------------------

type SqliteStatement = ReturnType<SqliteDb["prepare"]>;

interface StudioStatements {
  conversation: SqliteStatement;
  projectConversations: SqliteStatement;
  messages: SqliteStatement;
}

interface StudioConversationRow {
  id: string;
  projectId: string;
  updatedAt: number;
  visibleCount: number;
  lastPosition: number;
}

interface StudioMessageRow {
  id: string;
  role: string;
  content: string;
  agentName: string | null;
  createdAt: number;
}

const STUDIO_CONVERSATION_SELECT = `
  SELECT c.id AS id, c.project_id AS projectId, c.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM messages m
           WHERE m.conversation_id = c.id AND m.branch_visible = 1) AS visibleCount,
         (SELECT COALESCE(MAX(m.position), -1) FROM messages m
           WHERE m.conversation_id = c.id AND m.branch_visible = 1) AS lastPosition
    FROM conversations c`;

const studioStatementCache = new WeakMap<SqliteDb, StudioStatements>();
const deletedStatementCache = new WeakMap<SqliteDb, SqliteStatement>();

function studioStatements(db: SqliteDb): StudioStatements {
  let statements = studioStatementCache.get(db);
  if (!statements) {
    statements = {
      conversation: db.prepare(`${STUDIO_CONVERSATION_SELECT} WHERE c.id = ?`),
      projectConversations: db.prepare(
        `${STUDIO_CONVERSATION_SELECT} WHERE c.project_id = ? ORDER BY c.created_at ASC, c.rowid ASC`,
      ),
      messages: db.prepare(
        `SELECT id, role, content, agent_name AS agentName, created_at AS createdAt
           FROM messages
          WHERE conversation_id = ? AND branch_visible = 1 AND role IN ('user', 'assistant')
          ORDER BY position ASC`,
      ),
    };
    studioStatementCache.set(db, statements);
  }
  return statements;
}

/** Changes whenever a message is added, removed or rewritten through the daemon (each write bumps `updated_at`). */
function studioStamp(row: StudioConversationRow): string {
  return `${row.visibleCount}.${row.lastPosition}.${row.updatedAt}`;
}

function isCommentAnchor(conversationId: string): boolean {
  return conversationId.startsWith(COMMENT_ANCHOR_PREFIX);
}

function readStudioMessages(statements: StudioStatements, conversationId: string): IngestMessage[] {
  const messages: IngestMessage[] = [];
  for (const row of statements.messages.iterate(conversationId) as Iterable<StudioMessageRow>) {
    messages.push({
      id: row.id,
      speaker: row.role === "user" ? USER_SPEAKER : row.agentName?.trim() || ASSISTANT_SPEAKER,
      agentId: null,
      text: stripStudioMarkup(row.content),
      at: row.createdAt,
      dataClass: "standard",
    });
  }
  return messages;
}

function syncStudioRow(sink: ChunkSink, statements: StudioStatements, row: StudioConversationRow): void {
  syncMessages(
    sink,
    {
      principalId: DEFAULT_PRINCIPAL,
      scope: { source: "studio", conversationId: row.id, projectId: row.projectId },
    },
    readStudioMessages(statements, row.id),
    studioStamp(row),
  );
}

export function syncStudioConversation(sink: ChunkSink, db: SqliteDb, conversationId: string): void {
  if (isCommentAnchor(conversationId)) return;
  const statements = studioStatements(db);
  const row = statements.conversation.get(conversationId) as StudioConversationRow | undefined;
  if (!row) {
    clearWindows(sink, "studio", conversationId);
    return;
  }
  syncStudioRow(sink, statements, row);
}

/**
 * Brings every conversation of a project up to date and returns whether it finished. Conversations that did not
 * change cost one stamp comparison. With `budgetMs`, it stops before starting another conversation once the time
 * is used up and returns false; calling it again continues where it stopped, because finished ones are skipped.
 * `first` is synced before the others, so the conversation a turn belongs to is never the one left behind.
 */
export function syncStudioProject(
  sink: ChunkSink,
  db: SqliteDb,
  projectId: string,
  options: { budgetMs?: number | undefined; first?: string | null | undefined } = {},
): boolean {
  const statements = studioStatements(db);
  const deadline = options.budgetMs === undefined ? Number.POSITIVE_INFINITY : performance.now() + options.budgetMs;
  const rows = statements.projectConversations.all(projectId) as StudioConversationRow[];
  if (options.first) rows.sort((a, b) => Number(b.id === options.first) - Number(a.id === options.first));
  for (const row of rows) {
    if (isCommentAnchor(row.id)) continue;
    const stored = sink.cursor("studio", row.id);
    const storedStamp = stored ? decodeCursor(stored.prefixHash)?.stamp : undefined;
    if (storedStamp === studioStamp(row)) continue;
    if (row.id !== options.first && performance.now() > deadline) return false;
    syncStudioRow(sink, statements, row);
  }
  return true;
}

/**
 * Clears the windows of project conversations that no longer exist, however they were removed (the conversation
 * itself, its whole project, a cleanup). A window is a copy of what a conversation says: once the owner deletes the
 * conversation, its words must not keep being quoted to the model. Returns how many conversations were cleared.
 * `db` must be the database that holds both the conversations and the memory tables.
 */
export function sweepDeletedStudioConversations(sink: ChunkSink, db: SqliteDb): number {
  let deleted = deletedStatementCache.get(db);
  if (!deleted) {
    // One cursor row per conversation ever synced, so this stays small whatever the number of windows.
    deleted = db.prepare(
      `SELECT k.conversation_id AS id FROM mem_cursors k
        WHERE k.source = ?
          AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = k.conversation_id)
          AND EXISTS (SELECT 1 FROM mem_chunks w WHERE w.source = k.source AND w.conversation_id = k.conversation_id)`,
    );
    deletedStatementCache.set(db, deleted);
  }
  const gone = deleted.all("studio") as Array<{ id: string }>;
  for (const { id } of gone) {
    sink.writeWindows({
      source: "studio",
      conversationId: id,
      fromSeq: 0,
      windows: [],
      dataClass: "standard",
      principalId: DEFAULT_PRINCIPAL,
      cursor: UNFINISHED_CURSOR,
      scope: { source: "studio", conversationId: id },
    });
  }
  return gone.length;
}

// ---- Markup ------------------------------------------------------------------------------------------------------

type MarkupPlaceholder = (attributes: Record<string, string>) => string;

const MARKUP_BLOCKS: ReadonlyArray<{ tag: string; placeholder: MarkupPlaceholder }> = [
  { tag: "artifact", placeholder: (a) => `[产物：${a["title"] || a["identifier"] || a["type"] || "未命名"}]` },
  { tag: "question-form", placeholder: () => "[问题表单]" },
  { tag: "od-card", placeholder: () => "[卡片]" },
  // Control markers for the daemon, not content.
  { tag: "od-title", placeholder: () => "" },
  { tag: "open-design-plan-contract", placeholder: () => "" },
  { tag: "open-design-runtime-state", placeholder: () => "" },
];

/** Replaces generated artifacts, forms and long code blocks with one short placeholder each. */
function stripStudioMarkup(content: string): string {
  let text = content;
  for (const { tag, placeholder } of MARKUP_BLOCKS) text = replaceTagBlocks(text, tag, placeholder);
  return collapseLongFences(text);
}

/**
 * A real tag is `<tag` followed by whitespace or `>`. A tag with attributes and no closing tag is a block cut off
 * mid-stream and runs to the end; a bare `<tag>` without a close is just text.
 */
function replaceTagBlocks(text: string, tag: string, placeholder: MarkupPlaceholder): string {
  const openToken = `<${tag}`;
  const closeToken = `</${tag}>`;
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf(openToken, from);
    if (open < 0) break;
    const afterName = open + openToken.length;
    const next = text.charAt(afterName);
    const headEnd = text.indexOf(">", afterName);
    if (headEnd < 0 || !(next === ">" || /\s/.test(next))) {
      from = afterName;
      continue;
    }
    const attributes = text.slice(afterName, headEnd);
    const selfClosing = attributes.endsWith("/");
    const close = selfClosing ? -1 : text.indexOf(closeToken, headEnd);
    if (!selfClosing && close < 0 && next === ">") {
      from = afterName;
      continue;
    }
    const end = selfClosing ? headEnd + 1 : close < 0 ? text.length : close + closeToken.length;
    out += text.slice(copied, open) + placeholder(parseArtifactAttrs(attributes));
    copied = end;
    from = end;
  }
  return out + text.slice(copied);
}

function collapseLongFences(text: string): string {
  let out = "";
  let copied = 0;
  for (;;) {
    const open = text.indexOf("```", copied);
    if (open < 0) break;
    const bodyStart = text.indexOf("\n", open);
    if (bodyStart < 0) break;
    const close = text.indexOf("```", bodyStart);
    const end = close < 0 ? text.length : close + 3;
    const body = text.slice(bodyStart + 1, close < 0 ? text.length : close);
    if (body.length > MAX_FENCE_BODY_CHARS) {
      out += `${text.slice(copied, open)}[代码块，${body.trimEnd().split("\n").length} 行]`;
    } else {
      out += text.slice(copied, end);
    }
    copied = end;
  }
  return out + text.slice(copied);
}
