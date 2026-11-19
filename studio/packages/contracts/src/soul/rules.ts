// SPDX-License-Identifier: Apache-2.0
// Rules the daemon and the web must agree on: chat mode, names, variants and context, mentions, speaker choice.
import type { PaMessage } from "../api/personal-agent.js";

export function resolveChatMode(input: {
  explicit: "work" | "companion" | null | undefined;
  channel: boolean;                         // conversation.channelId is set
  channelCompanion?: boolean;               // that channel's chatMode is 'companion'
  memberIds: readonly string[] | null;      // group members, or null for a direct conversation
  agentId: string | null;
  hasCard: (agentId: string) => boolean;
  /** Enterprise mode: no member owns this conversation. A shared room is a work room whatever its settings say. */
  sharedRoom?: boolean;
}): "work" | "companion" {
  if (input.sharedRoom === true) return "work";
  if (input.explicit === "work" || input.explicit === "companion") return input.explicit;
  // A channel chat is work unless its channel was switched to chat mode; then the cards decide as anywhere else.
  if (input.channel && input.channelCompanion !== true) return "work";
  if (input.memberIds !== null) {
    return input.memberIds.length > 0 && input.memberIds.every(id => input.hasCard(id)) ? "companion" : "work";
  }
  return input.agentId !== null && input.hasCard(input.agentId) ? "companion" : "work";
}

export function resolveNames(input: { agentName: string; nickname?: string | null; personaName?: string | null; locale: "zh" | "en" }):
  { char: string; user: string } {
  return {
    char: input.nickname?.trim() || input.agentName,
    user: input.personaName?.trim() || (input.locale === "zh" ? "你" : "you"),
  };
}

export type SoulMessage = Pick<PaMessage, "id" | "createdAt" | "senderId" | "taskId" | "content" | "soul">;

/** soul.at ?? createdAt */
export function messageAt(message: SoulMessage): number {
  return message.soul?.at ?? message.createdAt;
}

/** soul.variantOf ?? id */
export function slotIdOf(message: SoulMessage): string {
  return message.soul?.variantOf ?? message.id;
}

export interface SoulSlot<M extends SoulMessage> { slotId: string; root: M; selected: M; variants: M[]; at: number; hidden: boolean }

/** The variant whose id equals `root.soul.activeVariant`, else the root. */
export function selectedVariant<M extends SoulMessage>(root: M, variants: readonly M[]): M {
  const active = root.soul?.activeVariant;
  if (active === undefined) return root;
  return variants.find(variant => variant.id === active) ?? root;
}

/** The id of the root a message is a variant of, or null when it is a root (orphaned variants are roots). */
function variantRootId(message: SoulMessage, exists: (id: string) => boolean): string | null {
  const target = message.soul?.variantOf;
  return target !== undefined && target !== message.id && exists(target) ? target : null;
}

/** Slots of one conversation (`messages` in storage order), sorted by time. Hidden slots are returned. */
export function visibleSlots<M extends SoulMessage>(messages: readonly M[]): SoulSlot<M>[] {
  const ids = new Set(messages.map(message => message.id));
  const exists = (id: string) => ids.has(id);
  const variantsByRoot = new Map<string, M[]>();
  const roots: M[] = [];
  for (const message of messages) {
    const rootId = variantRootId(message, exists);
    if (rootId === null) {
      roots.push(message);
      continue;
    }
    const list = variantsByRoot.get(rootId);
    if (list) list.push(message);
    else variantsByRoot.set(rootId, [message]);
  }
  const slots = roots.map((root, order) => {
    const variants = [root, ...(variantsByRoot.get(root.id) ?? [])];
    const selected = selectedVariant(root, variants);
    const slot: SoulSlot<M> = {
      slotId: root.id, root, selected, variants, at: messageAt(root), hidden: selected.soul?.hidden === true,
    };
    return { slot, order };
  });
  slots.sort((a, b) => a.slot.at - b.slot.at || a.order - b.order);
  return slots.map(entry => entry.slot);
}

/** Whether a stored message is part of the model context: not hidden, and the selected variant of its slot. */
export function isInContext(message: SoulMessage, lookup: (id: string) => SoulMessage | undefined): boolean {
  if (message.soul?.hidden === true) return false;
  const rootId = variantRootId(message, id => lookup(id) !== undefined);
  if (rootId !== null) return lookup(rootId)?.soul?.activeVariant === message.id;
  const active = message.soul?.activeVariant;
  if (active === undefined || active === message.id) return true;
  const named = lookup(active);
  return named === undefined || named.soul?.variantOf !== message.id;
}

const EVERYONE = ["@全体", "@所有人", "@all", "@everyone"];

export function mentionsEveryone(text: string): boolean {
  const folded = text.toLowerCase();
  return EVERYONE.some(tag => folded.includes(tag));
}

/** Member ids ordered by first mention. Names of two or more code points match as substrings; one code point needs `@`. */
export function mentionedMembers(text: string, members: ReadonlyArray<{ id: string; names: readonly string[] }>): string[] {
  const haystack = text.normalize("NFKC").toLowerCase();
  const hits: Array<{ id: string; at: number; order: number }> = [];
  const seen = new Set<string>();
  members.forEach((member, order) => {
    if (seen.has(member.id)) return;
    let first = -1;
    for (const name of member.names) {
      const needle = name.normalize("NFKC").toLowerCase().trim();
      if (!needle) continue;
      const short = Array.from(needle).length < 2;
      const found = short ? haystack.indexOf(`@${needle}`) : haystack.indexOf(needle);
      if (found < 0) continue;
      const at = short ? found + 1 : found;
      if (first < 0 || at < first) first = at;
    }
    if (first >= 0) {
      seen.add(member.id);
      hits.push({ id: member.id, at: first, order });
    }
  });
  hits.sort((a, b) => a.at - b.at || a.order - b.order);
  return hits.map(hit => hit.id);
}

/** One weighted draw; the previous speaker is excluded when another member exists. */
export function pickNaturalSpeaker(members: ReadonlyArray<{ id: string; talkativeness: number }>,
  previousSpeakerId: string | null, rng: () => number): string | null {
  if (members.length === 0) return null;
  const others = members.length > 1 ? members.filter(member => member.id !== previousSpeakerId) : members;
  const candidates = others.length > 0 ? others : members;
  const weights = candidates.map(member =>
    Number.isFinite(member.talkativeness) ? Math.max(0.05, member.talkativeness) : 0.05);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let point = rng() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    point -= weights[index] ?? 0;
    if (point < 0) return candidates[index]?.id ?? null;
  }
  return candidates[candidates.length - 1]?.id ?? null;
}
