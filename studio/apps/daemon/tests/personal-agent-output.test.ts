import { describe, expect, it } from 'vitest';
import { summarizePaOutput } from '../src/services/personal-agent-output.js';
describe('PA large-output excerpts', () => {
  it('keeps important errors away from the head or tail of a large result', () => {
    const source = `${'Ordinary progress.\n\n'.repeat(500)}ERROR: build failed because output is missing.\n\n${'More routine detail.\n\n'.repeat(500)}`;
    const summary = summarizePaOutput(source, 1200);
    expect(summary).toContain('ERROR: build failed because output is missing'); expect(summary.length).toBeLessThanOrEqual(1200);
    expect(source.length).toBeGreaterThan(10000);
  });
  it('keeps a structured manifest and explicit issues without duplicating huge file bodies', () => {
    const summary = summarizePaOutput(JSON.stringify({ summary: 'A report', issues: ['Validation failed: missing citation'], files: [{ path: 'report.md', content: 'Body '.repeat(10000) }] }), 1200);
    expect(summary).toContain('missing citation'); expect(summary).toContain('report.md'); expect(summary).toContain('50000 chars');
  });
  it('preserves a critical error even when a tool emits one very long line', () => {
    const summary = summarizePaOutput(`${'x'.repeat(10000)} ERROR: cannot verify result ${'y'.repeat(10000)}`, 1000);
    expect(summary).toContain('ERROR: cannot verify result');
  });
});
