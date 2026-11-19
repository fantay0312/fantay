// SPDX-License-Identifier: AGPL-3.0-only
// Regression coverage for `runtime/shiki`: languages inside `shiki/bundle/web` (Python, TypeScript)
// and technical languages loaded on demand from `shiki/dist/langs/*` (Rust, Go, TOML, Dockerfile)
// must highlight without crashing `createHighlighter`, while unknown languages degrade to ''.
import { describe, expect, it } from 'vitest';

import { highlightCode } from '../../../src/runtime/shiki';

describe('runtime/shiki highlightCode', () => {
  it('highlights web-bundled languages and lazy extra grammars without throwing', async () => {
    const py = await highlightCode('def greet(name: str) -> str:\n    return f"hi {name}"', 'python');
    expect(py).toContain('<pre');
    expect(py).toContain('greet');

    const rust = await highlightCode('fn main() { println!("hello"); }', 'rust');
    expect(rust).toContain('<pre');
    expect(rust).toContain('println');

    const go = await highlightCode('package main\nfunc main() {}', 'go');
    expect(go).toContain('<pre');
    expect(go).toContain('package');

    const toml = await highlightCode('[package]\nname = "fantay"', 'toml');
    expect(toml).toContain('<pre');
  });

  it('returns empty string for unknown or blank language names', async () => {
    expect(await highlightCode('abc', '')).toBe('');
    expect(await highlightCode('abc', 'nonexistent-lang-xyz')).toBe('');
  });
});
