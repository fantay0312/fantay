import type { PaSoulLiveText } from "@open-design/contracts";
import { SOUL_LIMITS, liveReplyText, type SoulReplyContext } from "@open-design/contracts/soul";
import { redactPaLiveText } from "./personal-agent-gateway.js";

interface LiveEntry {
  attemptId: string; taskId: string; conversationId: string; agentId: string; parse: SoulReplyContext;
  raw: string; seq: number; cached: { seq: number; text: string } | null;
}

/** The visible text so far of each running chat attempt. In memory only: no timers, no persistence; a daemon restart
 *  loses it and the next deltas start it again. Nothing here is ever stored as a message. */
export class PaSoulLive {
  private readonly entries = new Map<string, LiveEntry>();

  start(input: { attemptId: string; taskId: string; conversationId: string; agentId: string; parse: SoulReplyContext }): void {
    this.entries.delete(input.attemptId);           // re-inserted last, so a restarted attempt reads as the newest
    this.entries.set(input.attemptId, {
      attemptId: input.attemptId, taskId: input.taskId, conversationId: input.conversationId, agentId: input.agentId,
      parse: input.parse, raw: "", seq: 0, cached: null,
    });
  }

  append(attemptId: string, chunk: string, meta?: { reset?: boolean }): void {
    try {
      const entry = this.entries.get(attemptId);
      if (!entry) return;
      const reset = meta?.reset === true;
      const text = typeof chunk === "string" ? chunk : "";
      if (!reset && (!text || entry.raw.length >= SOUL_LIMITS.liveChars)) return;
      const base = reset ? "" : entry.raw;
      entry.raw = base.length + text.length > SOUL_LIMITS.liveChars ? (base + text).slice(0, SOUL_LIMITS.liveChars) : base + text;
      entry.seq += 1;
    } catch { /* a live preview never fails a model call */ }
  }

  end(attemptId: string): void {
    this.entries.delete(attemptId);
  }

  endTask(taskId: string): void {
    for (const [attemptId, entry] of [...this.entries]) if (entry.taskId === taskId) this.entries.delete(attemptId);
  }

  read(conversationId: string, known?: { attemptId: string; seq: number }): PaSoulLiveText | null {
    let latest: LiveEntry | undefined;
    for (const entry of this.entries.values()) if (entry.conversationId === conversationId) latest = entry;
    if (!latest) return null;
    const head = { attemptId: latest.attemptId, taskId: latest.taskId, agentId: latest.agentId, seq: latest.seq };
    if (known && known.attemptId === latest.attemptId && known.seq === latest.seq) return { ...head, unchanged: true };
    let cached = latest.cached;
    if (!cached || cached.seq !== latest.seq) cached = latest.cached = { seq: latest.seq, text: this.visible(latest) };
    return { ...head, text: cached.text };
  }

  private visible(entry: LiveEntry): string {
    try {
      const text = liveReplyText(redactPaLiveText(entry.raw), entry.parse);
      if (text.length <= SOUL_LIMITS.messageContent) return text;
      const cut = text.slice(0, SOUL_LIMITS.messageContent);
      return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;   // never end on half a surrogate pair
    } catch {
      return "";
    }
  }
}
