const FRAME_TYPES = new Set(['probe', 'ready', 'models', 'text', 'thinking', 'tool_call', 'tool_result', 'usage', 'session', 'result', 'protocol_error']);

/** Harness 0.2 provider notices may use stdout; the host owns that channel. */
export function isProfileProtocolChunk(text: string): boolean {
  return text.split(/\r?\n/u).filter(line => line.trim()).every(line => {
    try {
      const value: unknown = JSON.parse(line);
      return !!value && typeof value === 'object' && !Array.isArray(value)
        && (value as { v?: unknown }).v === 1
        && FRAME_TYPES.has(String((value as { type?: unknown }).type));
    } catch { return false; }
  });
}

export function routeProfileLogsToStderr(stdout: NodeJS.WriteStream = process.stdout, stderr: NodeJS.WriteStream = process.stderr): () => void {
  const original = stdout.write;
  const protocolWrite = original.bind(stdout);
  const diagnosticWrite = stderr.write.bind(stderr);
  stdout.write = ((chunk: Uint8Array | string, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const target = isProfileProtocolChunk(text) ? protocolWrite : diagnosticWrite;
    return typeof encodingOrCallback === 'function'
      ? target(chunk, encodingOrCallback)
      : target(chunk, encodingOrCallback, callback);
  }) as typeof stdout.write;
  return () => { stdout.write = original; };
}
