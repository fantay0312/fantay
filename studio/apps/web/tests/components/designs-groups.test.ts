import { describe, expect, it } from 'vitest';

import { designTimeBucket, groupDesignItems, isActiveDesignStatus } from '../../src/components/designs-groups';

const NOW = new Date(2026, 10, 2, 15, 0).getTime();
const at = (month: number, day: number, hour = 12, minute = 0) => new Date(2026, month, day, hour, minute).getTime();

describe('designTimeBucket', () => {
  it('splits on local midnight, not on 24 hours ago', () => {
    expect(designTimeBucket(at(10, 2, 0, 0), NOW)).toBe('today');
    expect(designTimeBucket(at(10, 1, 23, 59), NOW)).toBe('week');
  });

  it('closes the week after seven calendar days and the month after thirty', () => {
    expect(designTimeBucket(at(9, 27, 0, 0), NOW)).toBe('week');
    expect(designTimeBucket(at(9, 26, 23, 59), NOW)).toBe('month');
    expect(designTimeBucket(at(9, 4, 0, 0), NOW)).toBe('month');
    expect(designTimeBucket(at(9, 3, 23, 59), NOW)).toBe('earlier');
  });

  it('treats a timestamp ahead of the clock as today', () => {
    expect(designTimeBucket(at(10, 3), NOW)).toBe('today');
  });
});

describe('groupDesignItems', () => {
  it('keeps the incoming order inside a shelf and omits empty shelves', () => {
    const items = [
      { id: 'a', updatedAt: at(10, 2, 14) },
      { id: 'b', updatedAt: at(10, 2, 9) },
      { id: 'c', updatedAt: at(5, 1) },
    ];
    expect(groupDesignItems(items, NOW).map(({ bucket, items: shelf }) => [bucket, shelf.map((item) => item.id)])).toEqual([
      ['today', ['a', 'b']],
      ['earlier', ['c']],
    ]);
  });
});

describe('isActiveDesignStatus', () => {
  it('holds only runs that have not settled', () => {
    expect(['running', 'queued', 'awaiting_input'].every((status) => isActiveDesignStatus(status as never))).toBe(true);
    expect(['succeeded', 'failed', 'incomplete', 'canceled', 'not_started'].some((status) => isActiveDesignStatus(status as never))).toBe(false);
    expect(isActiveDesignStatus(undefined)).toBe(false);
  });
});
