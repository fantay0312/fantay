import type { PaAttempt, PaDataClass, PaMemory, PaMessage } from "@open-design/contracts";
import { paDigest } from "./personal-agent-gateway.js";

export function paCanReadClass(taskClass: PaDataClass | undefined, entryClass: PaDataClass | undefined): boolean {
  return entryClass !== "local_only" || taskClass === "local_only";
}

export function paMemoryActive(memory: PaMemory, at = Date.now()): boolean {
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

export function selectPaMemories(memories: PaMemory[], goal: string): PaMemory[] {
  const query = terms(goal);
  const ranked = memories.map(memory => ({
    memory,
    score: [...terms(memory.content)].filter(term => query.has(term)).length,
  })).sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);
  const selected: PaMemory[] = [];
  let remaining = 24 * 1024;
  for (const { memory, score } of ranked) {
    if (selected.length === 8) break;
    if (!score && selected.length >= 2) continue;
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
