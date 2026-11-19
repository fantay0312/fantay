// SPDX-License-Identifier: AGPL-3.0-only
// Sidebar label for the primary `记忆` column: the localized title plus a warm count while something waits for you.
import { useT } from '../../i18n';
import { RunStatusDot } from '../shell/sidebar/RunStatusDot';
import { useMemoryT } from './i18n';
import { useMemoryPendingCount } from './memory-badge-store';

export function MemoryNavigationLabel() {
  const t = useT();
  const mt = useMemoryT();
  const pending = useMemoryPendingCount();
  return (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <span className="min-w-0 truncate">{t('settings.memory')}</span>
      {pending > 0 ? (
        <span
          className="inline-flex flex-none items-center gap-1.5"
          role="img"
          aria-label={mt('memory.nav.pendingBadge', { count: pending })}
          data-testid="fantay-memory-pending"
        >
          <RunStatusDot tone="waiting" />
          <span className="text-caption tabular-nums text-ink-soft" aria-hidden>
            {pending}
          </span>
        </span>
      ) : null}
    </span>
  );
}
