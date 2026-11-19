// SPDX-License-Identifier: AGPL-3.0-only
// Marking the level word of each log line, so warnings and errors can be found at a glance.
import { describe, expect, it } from 'vitest';

import { logLevelSpans } from '../../../src/fantay/artifact/viewers/text/log-levels';

function marked(text: string): Array<[string, string | null, boolean]> {
  return logLevelSpans(text).map((span) => [text.slice(span.from, span.to), span.tone, span.bold]);
}

describe('logLevelSpans', () => {
  it('marks warnings, errors and debug lines and leaves INFO as plain ink', () => {
    const log = [
      '2026-10-14 08:00:00 WARN roaster batch=0 temp=190C',
      '2026-10-14 08:01:07 INFO roaster batch=1 temp=191C',
      '2026-10-14 08:02:14 ERROR roaster overheated',
      '[08:03:21] [DEBUG] heater=on',
      '08:04:28.120 FATAL: out of beans',
    ].join('\n');
    expect(marked(log)).toEqual([
      ['WARN', 'yellow', false],
      ['ERROR', 'red', true],
      ['DEBUG', 'faint', false],
      ['FATAL', 'red', true],
    ]);
  });

  it('marks one level per line and ignores a level word deep in the message', () => {
    expect(marked('2026-10-14 08:00:00 INFO retrying after the last ERROR from upstream, WARN was logged')).toEqual([]);
    expect(marked('08:00 INFO failed with ERROR 500')).toEqual([]);
    expect(marked('NOTICE: WARN threshold changed')).toEqual([]);
    expect(marked('WARN first ERROR second')).toEqual([['WARN', 'yellow', false]]);
  });

  it('matches whole words in upper case only', () => {
    expect(marked('ERRORS: 3\nwarning: lower case\nTERROR\nWARNING: disk')).toEqual([['WARNING', 'yellow', false]]);
  });

  it('gives offsets into the text, in order', () => {
    const text = 'a\nERROR b\n中文 WARN c\n';
    const spans = logLevelSpans(text);
    expect(spans.map((span) => [span.from, span.to])).toEqual([
      [2, 7],
      [13, 17],
    ]);
  });

  it('returns nothing for text without levels', () => {
    expect(logLevelSpans('')).toEqual([]);
    expect(logLevelSpans('just some notes\nand more')).toEqual([]);
  });
});
