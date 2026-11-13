import type { RuntimeAgentDef } from './types.js';

export type ClaudeExecutionMode = 'tui' | 'print';

export function resolveClaudeExecutionMode(value: unknown): ClaudeExecutionMode {
  return value === 'print' ? 'print' : 'tui';
}

/** Per-run copy: never mutate the shared registry or another running chat. */
export function withClaudeExecutionMode(def: RuntimeAgentDef, value: unknown): RuntimeAgentDef {
  if (def.id !== 'claude' || resolveClaudeExecutionMode(value) === 'print') return def;
  return {
    ...def,
    processTransport: 'claude-tui',
    buildArgs: (...params) => {
      const original = def.buildArgs(...params);
      const result: string[] = [];
      for (let i = 0; i < original.length; i++) {
        const arg = original[i]!;
        if (['--input-format', '--output-format', '--thinking-display'].includes(arg)) { i++; continue; }
        if (['-p', '--print', '--verbose', '--include-partial-messages', '--forward-subagent-text'].includes(arg)) continue;
        result.push(arg);
      }
      return result;
    },
  };
}
