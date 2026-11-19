// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — who may read what. This file is the single place that decides it.
//
// Reading a scope means: its items, plus every raw conversation window keyed to it.
//
//   Turn                                   Reads
//   -------------------------------------  ------------------------------------------------------------
//   Project conversation (Studio)          profile (unless Settings turned the profile off), project, this conversation
//   PA 1:1, bot mounts the owner profile   bot, this conversation, project (if any), profile
//   PA 1:1, bot mounts a persona           bot, this conversation, project (if any), that persona
//   PA 1:1, bot mounts nothing             bot, this conversation, project (if any)
//   PA group turn                          group, the speaking bot, this conversation, project (if any)
//   External channel, shared group memory  group
//   External channel, otherwise            nothing
//
// The owner's profile and personas are never read by a group or a channel turn. A bot never reads another bot.
// What a bot said and heard in a group is readable by that bot afterwards (group → bot write-back):
// group windows are keyed to the group and to every bot that took part.
//
// Derived text follows the same lines. An answer built on profile, persona or project memory that was recalled
// for that request is not copied into bot or group memory (which travel into groups): the bot keeps what was
// asked, and the full record stays with the conversation. PersonalAgentService.mayCarry decides it.
//
// Raw windows flow one way. In a group turn the speaking bot brings its own memory items but not its raw
// windows from elsewhere: what the owner said to it in private, or what was said in another group, is not
// quoted into this group. `resolveReadAccess().windowScopes` carries that rule.

import {
  memoryScopeKey,
  type MemoryScopeRef,
  type PaDataClass,
  type PaProfileMount,
} from "@open-design/contracts";

export interface MemoryAccessContext {
  surface: "studio" | "pa";
  projectId?: string | null | undefined;
  conversationId?: string | null | undefined;
  /** Studio: false when Settings → 记忆 has the owner profile switched off. Defaults to true. */
  ownerProfile?: boolean | undefined;
  /** PA: the bot whose turn it is. */
  agentId?: string | null | undefined;
  /** PA: set when the conversation is a group room. */
  groupId?: string | null | undefined;
  /** PA: set when the conversation belongs to an external channel. */
  channel?: { sharedGroupMemory: boolean } | null | undefined;
  /** PA 1:1 only: what the bot is allowed to know about the owner. Defaults to `none`. */
  profileMount?: PaProfileMount | undefined;
  /** PA 1:1 with `persona_only`: the persona in use. */
  personaId?: string | null | undefined;
  /** `local_only` data is readable only by a `local_only` turn. Defaults to `standard`. */
  dataClass?: PaDataClass | undefined;
  /** Enterprise mode: the member. Defaults to `owner`. */
  principalId?: string | undefined;
}

const scope = (kind: MemoryScopeRef["kind"], id = ""): MemoryScopeRef => ({ kind, id });

/** The scopes a turn may read, most specific first. */
export function resolveReadScopes(ctx: MemoryAccessContext): MemoryScopeRef[] {
  const out: MemoryScopeRef[] = [];
  if (ctx.surface === "studio") {
    if (ctx.conversationId) out.push(scope("conversation", ctx.conversationId));
    if (ctx.projectId) out.push(scope("project", ctx.projectId));
    if (ctx.ownerProfile !== false) out.push(scope("profile"));
    return out;
  }
  if (ctx.channel) {
    if (ctx.channel.sharedGroupMemory && ctx.groupId) out.push(scope("group", ctx.groupId));
    return out;
  }
  if (ctx.conversationId) out.push(scope("conversation", ctx.conversationId));
  if (ctx.groupId) {
    out.push(scope("group", ctx.groupId));
    if (ctx.agentId) out.push(scope("bot", ctx.agentId));
    if (ctx.projectId) out.push(scope("project", ctx.projectId));
    return out;
  }
  if (ctx.agentId) out.push(scope("bot", ctx.agentId));
  if (ctx.projectId) out.push(scope("project", ctx.projectId));
  const mount = ctx.profileMount ?? "none";
  if (mount === "owner_profile") out.push(scope("profile"));
  else if (mount === "persona_only" && ctx.personaId) out.push(scope("persona", ctx.personaId));
  return out;
}

export function resolveReadScopeKeys(ctx: MemoryAccessContext): string[] {
  return resolveReadScopes(ctx).map(memoryScopeKey);
}

export interface MemoryReadAccess {
  /** Scopes whose items the turn may read. */
  scopes: MemoryScopeRef[];
  /** The subset of `scopes` whose raw conversation windows the turn may read. */
  windowScopes: MemoryScopeRef[];
}

/**
 * What a turn may read, items and raw windows separately. They differ only in a PA group turn, where the
 * speaking bot's scope contributes items but no windows.
 */
export function resolveReadAccess(ctx: MemoryAccessContext): MemoryReadAccess {
  const scopes = resolveReadScopes(ctx);
  const inGroupTurn = ctx.surface === "pa" && !ctx.channel && Boolean(ctx.groupId);
  return {
    scopes,
    windowScopes: inGroupTurn ? scopes.filter((item) => item.kind !== "bot") : scopes,
  };
}

export interface ChunkScopeInput {
  source: "pa" | "studio";
  conversationId: string;
  /** Studio: the conversation's project. */
  projectId?: string | null | undefined;
  /** PA 1:1: the conversation's bot. */
  agentId?: string | null | undefined;
  /** PA group room. */
  groupId?: string | null | undefined;
  /** PA group room: bots that spoke in this window. */
  speakerAgentIds?: readonly string[] | undefined;
  /** PA: the conversation belongs to an external channel. */
  channel?: boolean | undefined;
}

/**
 * The scopes that may read one raw conversation window.
 * - Project conversation: the conversation and its project (sibling conversations of the project can recall it).
 * - PA 1:1: the conversation and its bot (the bot recalls it from its other conversations).
 * - PA group: the conversation, the group, and every bot that spoke in the window.
 * - External channel: the conversation only. Channel text never reaches a bot's or a group's memory.
 */
export function chunkScopeKeys(input: ChunkScopeInput): string[] {
  const out = [memoryScopeKey(scope("conversation", input.conversationId))];
  if (input.source === "studio") {
    if (input.projectId) out.push(memoryScopeKey(scope("project", input.projectId)));
    return out;
  }
  if (input.channel) return out;
  if (input.groupId) {
    out.push(memoryScopeKey(scope("group", input.groupId)));
    for (const id of new Set(input.speakerAgentIds ?? [])) out.push(memoryScopeKey(scope("bot", id)));
    return out;
  }
  if (input.agentId) out.push(memoryScopeKey(scope("bot", input.agentId)));
  return out;
}

/** `local_only` content is visible only to a `local_only` turn. */
export function canReadDataClass(turn: PaDataClass | undefined, doc: PaDataClass | undefined): boolean {
  return doc !== "local_only" || turn === "local_only";
}

/** Whether a remote model (embedding, reranker, judge, distiller) may see this content. */
export function remoteAllowed(dataClass: PaDataClass | undefined): boolean {
  return dataClass !== "local_only";
}
