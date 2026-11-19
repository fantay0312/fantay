import { expect, it } from 'vitest';
import { fantayReleaseDay, nextFantayVersion, parseFantayVersion, fantayDisplayVersion, fantayPackageVersion } from '../src/fantay-version.js';

it('uses Taipei calendar days and preserves four date digits', () => {
  expect(fantayReleaseDay(new Date('2026-11-13T18:00:00Z'))).toBe('2026-11-14');
  expect(nextFantayVersion([], '2026-01-01')).toBe('26.0101.1');
  expect(fantayPackageVersion('26.0101.1')).toBe('26.101.1');
  expect(fantayDisplayVersion('26.101.1')).toBe('26.0101.1');
  expect(fantayDisplayVersion('0.25.1')).toBe('0.25.1');
  expect(parseFantayVersion('26.1114.1')).toEqual({ date: '2026-11-14', sequence: 1 });
  expect(nextFantayVersion(['26.1114.1', '26.1114.2'], '2026-11-14')).toBe('26.1114.3');
  expect(nextFantayVersion(['26.1114.1'], '2026-11-15')).toBe('26.1115.1');
  expect(nextFantayVersion(['26.1231.4'], '2027-01-01')).toBe('27.0101.1');
});

it('rejects invalid dates, unpadded dates, rollback and Windows overflow', () => {
  for (const value of ['26.0229.1', '26.1301.1', '26.1114.0', '26.101.1', '26.1114.65536', '0.25.1']) expect(() => parseFantayVersion(value)).toThrow();
  expect(parseFantayVersion('28.0229.1').date).toBe('2028-02-29');
  expect(() => nextFantayVersion(['26.1114.1'], '2026-11-13')).toThrow();
  expect(() => nextFantayVersion(['26.1114.65535'], '2026-11-14')).toThrow();
});
