type Event = Record<string, unknown>;
type Emit = (event: Event) => void;

/**
 * Merges the two OpenCode sources for one text/reasoning part: live
 * `od_opencode_delta` frames from the event plugin and the native completed
 * `text` / `reasoning` record (`reasoning` needs `run --thinking`). Both are
 * keyed by `session:partID`, and `text` holds how many leading characters of
 * the part have been emitted, so whichever source arrives second contributes
 * only the suffix the first one did not.
 */
export class OpenCodeTextEvents {
  private sessionId: string | null = null;
  private readonly pending: Event[] = [];
  private pendingBytes = 0;
  private readonly text = new Map<string, number>();
  private thinking: string | null = null;

  startSession(session: string | null, emit: Emit): void {
    if (!session || this.sessionId && this.sessionId !== session) return;
    this.sessionId = session;
    for (const frame of this.pending) this.handle(frame, emit);
    this.pending.length = 0; this.pendingBytes = 0;
  }

  handle(frame: Event, emit: Emit): boolean {
    if (frame.type !== 'od_opencode_delta') return false;
    if (frame.version !== 1 || typeof frame.sessionID !== 'string' || typeof frame.partID !== 'string'
      || !['text', 'reasoning'].includes(String(frame.kind)) || typeof frame.delta !== 'string'
      || typeof frame.offset !== 'number' || !Number.isSafeInteger(frame.offset) || frame.offset < 0) return true;
    if (!this.sessionId) {
      if (this.pendingBytes + frame.delta.length < 512 * 1024) { this.pending.push(frame); this.pendingBytes += frame.delta.length; }
      return true;
    }
    if (frame.sessionID !== this.sessionId) return true;
    const key = `${frame.sessionID}:${frame.partID}`;
    const previous = this.text.get(key) ?? 0;
    // A gap (a lost line, or pending overflow before step_start) cannot be
    // filled from later frames. Leave the part accounted at its last contiguous
    // character: live frames for it stop, and complete() backfills the tail.
    if (frame.offset > previous || previous > 2 * 1024 * 1024) return true;
    const suffix = frame.delta.slice(Math.max(0, previous - frame.offset));
    if (suffix) {
      this.remember(key, previous + suffix.length);
      this.emit(key, String(frame.kind), suffix, emit);
    }
    return true;
  }

  complete(session: unknown, part: Event, kind: 'text' | 'reasoning', emit: Emit): void {
    if (this.sessionId && typeof session === 'string' && session !== this.sessionId) return;
    if (typeof part.text !== 'string' || !part.text) return;
    const key = typeof part.id === 'string' ? `${session}:${part.id}` : null;
    const previous = key ? this.text.get(key) ?? 0 : 0;
    const suffix = part.text.slice(previous);
    if (key) this.remember(key, Math.max(previous, part.text.length));
    if (suffix) this.emit(key ?? 'completed', kind, suffix, emit);
  }

  endThinking(emit: Emit): void {
    if (this.thinking) { emit({ type: 'thinking_end' }); this.thinking = null; }
  }

  private remember(key: string, text: number): void {
    this.text.set(key, text);
    if (this.text.size > 1024) this.text.delete(this.text.keys().next().value!);
  }
  private emit(key: string, kind: string, delta: string, emit: Emit): void {
    if (kind === 'reasoning') {
      if (this.thinking !== key) {
        // Never open a thinking block on whitespace alone: some providers lead
        // reasoning with blank lines, and a part with no visible thought must
        // render no thinking section at all.
        if (!delta.trim()) return;
        this.endThinking(emit); emit({ type: 'thinking_start' }); this.thinking = key;
      }
      emit({ type: 'thinking_delta', delta });
    } else { this.endThinking(emit); emit({ type: 'text_delta', delta }); }
  }
}
