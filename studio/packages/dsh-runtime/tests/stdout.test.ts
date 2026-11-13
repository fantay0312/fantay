import { describe, expect, it } from 'vitest';
import { isProfileProtocolChunk } from '../src/stdout.js';
describe('Harness protocol stdout', () => {
  it('keeps complete protocol frames on stdout', () => {
    expect(isProfileProtocolChunk('{"v":1,"type":"ready"}\n')).toBe(true);
    expect(isProfileProtocolChunk('{"v":1,"type":"text","content":"hello"}\n{"v":1,"type":"result","status":"completed"}\n')).toBe(true);
  });
  it('routes provider notices and other JSON to stderr', () => {
    expect(isProfileProtocolChunk('[llm-deepseek-account] model listing loaded 2 models\n')).toBe(false);
    expect(isProfileProtocolChunk('{"message":"notice"}\n')).toBe(false);
    expect(isProfileProtocolChunk('{"v":1,"type":"ready"}\nnotice\n')).toBe(false);
  });
});
