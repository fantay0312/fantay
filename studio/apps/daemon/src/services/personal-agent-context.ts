import type { PaAttempt, PaDataClass, PaMemory, PaMessage } from "@open-design/contracts";
import { paDigest } from "./personal-agent-gateway.js";

export function paCanReadClass(taskClass: PaDataClass | undefined, entryClass: PaDataClass | undefined): boolean {
  return entryClass !== "local_only" || taskClass === "local_only";
}

export function paMemoryActive(memory: PaMemory, at = Date.now()): boolean {
  const status = memory.status ?? "active";
  if (status === "superseded" || status === "archived") return false;
  return (memory.validFrom ?? 0) <= at && (memory.validUntil == null || memory.validUntil > at);
}

function terms(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLowerCase();
  const words: string[] = normalized.match(/[\p{Script=Latin}\d_]{2,}/gu) ?? [];
  for (const phrase of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...phrase];
    for (let index = 0; index < chars.length - 1; index++) words.push(chars[index]! + chars[index + 1]!);
  }
  return new Set(words);
}

/** Whether a memory shares at least one term with the text; pinned memories are selected even when it does not. */
export function paMemoryMatches(memory: PaMemory, goal: string): boolean {
  const query = terms(goal);
  return [...terms(memory.content)].some(term => query.has(term));
}

export function selectPaMemories(
  memories: PaMemory[],
  goal: string,
  options: { minScore?: number; limit?: number; budgetBytes?: number } = {},
): PaMemory[] {
  const query = terms(goal);
  const minScore = options.minScore ?? 1;
  const ranked = memories
    .map(memory => ({
      memory,
      score: [...terms(memory.content)].filter(term => query.has(term)).length,
    }))
    .sort(
      (a, b) =>
        Number(Boolean(b.memory.pinned)) - Number(Boolean(a.memory.pinned)) ||
        b.score - a.score ||
        b.memory.updatedAt - a.memory.updatedAt,
    );
  const selected: PaMemory[] = [];
  let remaining = options.budgetBytes ?? 24 * 1024;
  for (const { memory, score } of ranked) {
    if (options.limit !== undefined && selected.length === options.limit) break;
    if (!memory.pinned && score < minScore) continue;
    const bytes = Buffer.byteLength(JSON.stringify([memory.content, memory.source]));
    if (bytes > remaining) continue;
    remaining -= bytes;
    selected.push(memory);
  }
  return selected;
}

/** Large history stays in its original authorized record. Only a bounded preview is sent. */
export function preparePaHistory(messages: PaMessage[], attempts: PaAttempt[], evidenceAttemptId?: string): {
  messages: PaMessage[];
  contributions: string[];
  refs: NonNullable<PaAttempt["contextRefs"]>;
} {
  const refs: NonNullable<PaAttempt["contextRefs"]> = [];
  const preview = (kind: "message" | "attempt", id: string, value: string, max: number): string => {
    if (value.length <= max) return value;
    const digest = paDigest(value);
    refs.push({ kind, id, digest, bytes: Buffer.byteLength(value) });
    return `${value.slice(0, max)}\n[Excerpt from ${kind}:${id}; SHA-256: ${digest}]`;
  };
  return {
    messages: messages.slice(-12).map(message => ({ ...message, content: preview("message", message.id, message.content, 1500) })),
    contributions: attempts.slice(-4).map(attempt =>
      `${attempt.agentSnapshot.name} (${attempt.agentSnapshot.model.runtime}/${attempt.agentSnapshot.model.modelId}):\n${attempt.id === evidenceAttemptId
        ? attempt.output : preview("attempt", attempt.id, attempt.output, 2400)}`),
    refs,
  };
}
