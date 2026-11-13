// SPDX-License-Identifier: AGPL-3.0-only
// Sidebar label of the Fantay entry: the name, then waiting > running > nothing as a status dot plus count (spec §3.1).
import { useT } from '../../i18n';
import { RunStatusDot } from '../shell/sidebar/RunStatusDot';
import { usePaActivity } from './pa-activity';

export function PaNavigationLabel() {
  const t = useT();
  const { running, waiting } = usePaActivity();
  const tone = waiting > 0 ? 'waiting' : running > 0 ? 'running' : null;
  const count = waiting > 0 ? waiting : running;
  const label = tone === 'waiting' ? t('pa.nav.waiting', { count }) : tone === 'running' ? t('pa.nav.running', { count }) : undefined;
  return (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <span className="min-w-0 truncate">{t('pa.title')}</span>
      {tone ? (
        <span className="inline-flex flex-none items-center gap-1.5" role="img" aria-label={label} data-testid="fantay-pa-activity" data-tone={tone}>
          <RunStatusDot tone={tone} />
          <span className="text-caption tabular-nums text-ink-soft" aria-hidden>
            {count}
          </span>
        </span>
      ) : null}
    </span>
  );
}
