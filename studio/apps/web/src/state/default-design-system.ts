// Which design system a fresh install selects on its own.
//
// The Fantay fork ships its own `fantay` system (open-design's product UI
// language, formalized) and prefers it; upstream's `default` stays the next
// choice, and any catalog without either falls back to its first entry.
// Only consulted while no selection is stored — a user's (or the daemon's)
// saved `designSystemId` always wins.

export const DEFAULT_DESIGN_SYSTEM_PREFERENCE = ['fantay', 'default'] as const;

export function pickDefaultDesignSystemId(
  systems: ReadonlyArray<{ id: string }>,
): string | null {
  for (const preferred of DEFAULT_DESIGN_SYSTEM_PREFERENCE) {
    const match = systems.find((system) => system.id === preferred);
    if (match) return match.id;
  }
  return systems[0]?.id ?? null;
}
