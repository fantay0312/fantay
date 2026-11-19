// SPDX-License-Identifier: AGPL-3.0-only
// JSON is re-spaced for reading, never re-serialised: a number must come out exactly as it went in.
import { describe, expect, it } from 'vitest';

import {
  JSON_FORMAT_MAX_CHARS,
  detectJsonIndent,
  readJson,
  readJsonLines,
  reindentJson,
} from '../../../src/fantay/artifact/viewers/text/json-format';

describe('reindentJson', () => {
  it('lays out objects and arrays with two spaces', () => {
    expect(reindentJson('{"a":1,"b":[true,null,"x"],"c":{"d":"e"}}')).toBe(
      ['{', '  "a": 1,', '  "b": [', '    true,', '    null,', '    "x"', '  ],', '  "c": {', '    "d": "e"', '  }', '}'].join('\n'),
    );
  });

  it('copies every number character for character', () => {
    // JSON.stringify(JSON.parse(...)) would turn these into 1, 0, 12345678901234567000, null, 0.1 and 1e+21.
    const source = '{"a":1.0,"b":-0,"c":12345678901234567890,"d":1e400,"e":0.1000,"f":1E21,"g":-0.0e-0}';
    const formatted = reindentJson(source);
    for (const token of ['1.0', '-0', '12345678901234567890', '1e400', '0.1000', '1E21', '-0.0e-0']) {
      expect(formatted, token).toContain(`: ${token}`);
    }
    // Only whitespace was added: stripping it gives the source back.
    expect(formatted.replace(/\s+/g, '')).toBe(source);
  });

  it('leaves strings alone, including quotes, escapes and structural characters inside them', () => {
    const source = '{"k":"a \\" } ] , : { [","u":"\\u4e2d\\\\","s":"  two  spaces  "}';
    const formatted = reindentJson(source);
    expect(formatted).toContain('"k": "a \\" } ] , : { ["');
    expect(formatted).toContain('"u": "\\u4e2d\\\\"');
    expect(formatted).toContain('"s": "  two  spaces  "');
    expect(JSON.parse(formatted)).toEqual(JSON.parse(source));
  });

  it('keeps empty containers on one line', () => {
    expect(reindentJson('{"a":{},"b":[ ],"c":[[]]}')).toBe(['{', '  "a": {},', '  "b": [],', '  "c": [', '    []', '  ]', '}'].join('\n'));
  });

  it('handles a bare scalar and uses the indent it is given', () => {
    expect(reindentJson('  42 ')).toBe('42');
    expect(reindentJson('{"a":[1]}', '\t')).toBe('{\n\t"a": [\n\t\t1\n\t]\n}');
  });
});

describe('detectJsonIndent', () => {
  it('reads the indent a file already uses', () => {
    expect(detectJsonIndent('{\n    "a": 1\n}')).toBe('    ');
    expect(detectJsonIndent('{\n\t"a": 1\n}')).toBe('\t');
    expect(detectJsonIndent('{"a":1}')).toBe('  ');
  });
});

describe('readJson', () => {
  it('offers nothing for a file that is already regular, whatever its indent', () => {
    const two = JSON.stringify({ a: 1, b: [1, 2], c: { d: null } }, null, 2);
    const four = JSON.stringify({ a: 1, b: [1, 2], c: { d: null } }, null, 4);
    const tabs = JSON.stringify({ a: 1, b: [1, 2] }, null, '\t');
    expect(readJson(two).formatted).toBeNull();
    expect(readJson(`${two}\n`).formatted).toBeNull();
    expect(readJson(four).formatted).toBeNull();
    expect(readJson(tabs).formatted).toBeNull();
    expect(readJson(two.replace(/\n/g, '\r\n')).formatted).toBeNull();
  });

  it('opens a minified file formatted', () => {
    const minified = JSON.stringify({ items: Array.from({ length: 60 }, (_, index) => ({ id: index, name: `item ${index}` })) });
    const reading = readJson(minified);
    expect(reading.preferFormatted).toBe(true);
    expect(reading.formatted?.split('\n').length).toBeGreaterThan(200);
    expect(JSON.parse(reading.formatted ?? '')).toEqual(JSON.parse(minified));
  });

  it('offers the formatted view for a hand-written file but keeps the file as written first', () => {
    const irregular = '{\n  "files": ["dist", "README.md"],\n  "scripts": { "dev": "vite" }\n}\n';
    const reading = readJson(irregular);
    expect(reading.preferFormatted).toBe(false);
    expect(reading.formatted).toContain('"files": [\n    "dist",\n    "README.md"\n  ]');
  });

  it('never rewrites a number while formatting', () => {
    const reading = readJson('{"version":1.0,"id":12345678901234567890,"rate":6.02e23,"delta":-0.0}');
    expect(reading.formatted).toBe('{\n  "version": 1.0,\n  "id": 12345678901234567890,\n  "rate": 6.02e23,\n  "delta": -0.0\n}');
  });

  it('offers nothing for text that is not JSON, is empty, or is too large', () => {
    expect(readJson('{ // a comment\n "a": 1 }').formatted).toBeNull();
    expect(readJson("{'a': 1}").formatted).toBeNull();
    expect(readJson('').formatted).toBeNull();
    expect(readJson('   \n').formatted).toBeNull();
    expect(readJson(`"${'x'.repeat(JSON_FORMAT_MAX_CHARS)}"`).formatted).toBeNull();
  });

  it('ignores a byte-order mark', () => {
    expect(readJson('﻿{"a":1,"b":2}').formatted).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });
});

describe('readJsonLines', () => {
  it('opens every record up and leaves broken lines as they are', () => {
    const reading = readJsonLines('{"a":1,"n":1.50}\nnot json\n\n[1,2]\n');
    expect(reading.preferFormatted).toBe(false);
    expect(reading.formatted).toBe(['{', '  "a": 1,', '  "n": 1.50', '}', 'not json', '', '[', '  1,', '  2', ']'].join('\n'));
  });

  it('offers nothing when no record would change', () => {
    expect(readJsonLines('1\n"two"\ntrue\n').formatted).toBeNull();
    expect(readJsonLines('plain text\nmore text').formatted).toBeNull();
    expect(readJsonLines('').formatted).toBeNull();
  });
});
