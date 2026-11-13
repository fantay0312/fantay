import { describe, expect, it } from 'vitest';

import { pickDefaultDesignSystemId } from '../../src/state/default-design-system';

// App.tsx auto-picks a design system for a fresh install (no stored
// selection) with this helper: Fantay's own system first, then upstream's
// `default`, then whatever the catalog lists first.
describe('pickDefaultDesignSystemId', () => {
  it('prefers fantay over default', () => {
    expect(
      pickDefaultDesignSystemId([{ id: 'airbnb' }, { id: 'default' }, { id: 'fantay' }]),
    ).toBe('fantay');
  });

  it('falls back to default when fantay is absent', () => {
    expect(pickDefaultDesignSystemId([{ id: 'airbnb' }, { id: 'default' }])).toBe('default');
  });

  it('falls back to the first system, and to null for an empty catalog', () => {
    expect(pickDefaultDesignSystemId([{ id: 'airbnb' }, { id: 'ant' }])).toBe('airbnb');
    expect(pickDefaultDesignSystemId([])).toBeNull();
  });
});
