// SPDX-License-Identifier: AGPL-3.0-only
// The roster's bottom bar (Soul UI spec §3.4): four equal cells 角色库 · 记忆 · 工作 · 连接 under the conversation
// list. Badges come from stored state only: the needs-you count on 工作, a warm dot on 连接 when a channel needs
// attention (a faint one while Fantay is paused). The rail draws the same four places as stacked icon buttons
// (`SoulRailPlaces`, spec §3.5), so both variants share one table and one badge rule.
import { useT } from '../../../i18n';
import { Button, FeatureIcon, IconButton, VisuallyHidden, cn, type FeatureIconName } from '../../ui';
import { usePa } from '../pa-context';
import type { PaPlace } from '../pa-types';
import styles from './SoulBottomBar.module.css';
import shell from './SoulShell.module.css';

type BarPlace = 'library' | 'memory' | 'tasks' | 'connections';
type BarLabel = 'pa.soul.shell.bar.library' | 'pa.soul.shell.bar.memory' | 'pa.soul.shell.bar.work' | 'pa.soul.shell.bar.connect';

const CELLS: ReadonlyArray<{ place: BarPlace; icon: FeatureIconName; label: BarLabel; testId: string }> = [
  { place: 'library', icon: 'paAgents', label: 'pa.soul.shell.bar.library', testId: 'pa-place-library' },
  { place: 'memory', icon: 'paMemories', label: 'pa.soul.shell.bar.memory', testId: 'pa-place-memory' },
  { place: 'tasks', icon: 'paTasks', label: 'pa.soul.shell.bar.work', testId: 'pa-place-tasks' },
  { place: 'connections', icon: 'paConnections', label: 'pa.soul.shell.bar.connect', testId: 'pa-place-connections' },
];

type Badge = { kind: 'needs'; count: number } | { kind: 'issue' } | { kind: 'paused' } | null;

/** One badge rule for the bar and the rail: needs-you on 工作, channel trouble (else a paused Fantay) on 连接. */
function useBadges(): Record<BarPlace, Badge> {
  const { data, index } = usePa();
  const needs = index.needs.length;
  const broken = data.channels.channels.some((channel) => channel.status === 'error' || channel.status === 'login_required');
  return {
    library: null,
    memory: null,
    tasks: needs > 0 ? { kind: 'needs', count: needs } : null,
    connections: broken ? { kind: 'issue' } : data.control?.paused ? { kind: 'paused' } : null,
  };
}

/** 工作 stays lit on both of its pages (任务 and 动态 · 目标 · 例行). */
function isActive(place: BarPlace, current: PaPlace): boolean {
  return place === 'tasks' ? current === 'tasks' || current === 'activity' : current === place;
}

/** The badge's meaning for screen readers; the mark itself is decoration. */
function badgeText(badge: Badge, t: ReturnType<typeof useT>): string | null {
  if (!badge) return null;
  if (badge.kind === 'needs') return t('pa.soul.shell.bar.needs', { count: badge.count });
  return t(badge.kind === 'issue' ? 'pa.soul.shell.bar.channelIssue' : 'pa.soul.shell.bar.paused');
}

export function SoulBottomBar() {
  const t = useT();
  const { ui, nav } = usePa();
  const badges = useBadges();
  return (
    <nav aria-label={t('pa.soul.shell.bar.label')} data-testid="pa-bottom-bar" className={styles.bar}>
      {CELLS.map((cell) => {
        const active = isActive(cell.place, ui.place);
        const badge = badges[cell.place];
        const said = badgeText(badge, t);
        return (
          <Button
            key={cell.place}
            variant="bare"
            className={styles.cell}
            data-testid={cell.testId}
            data-active={active ? '' : undefined}
            aria-current={active ? 'page' : undefined}
            onClick={() => nav.openPlace(cell.place)}
          >
            <span className={styles.glyph}>
              <FeatureIcon name={cell.icon} size={18} />
              {badge?.kind === 'needs' ? (
                <span aria-hidden className={cn(shell.needsPill, styles.pill)} data-testid="pa-bar-needs">
                  {badge.count}
                </span>
              ) : badge ? (
                <span aria-hidden className={cn(styles.dot, badge.kind === 'paused' && styles.dotPaused)} />
              ) : null}
            </span>
            <span className={cn('text-caption', styles.label)}>{t(cell.label)}</span>
            {said ? <VisuallyHidden>{said}</VisuallyHidden> : null}
          </Button>
        );
      })}
    </nav>
  );
}

/** The rail's four place buttons (spec §3.5): IconButton md stacked, tooltip = label, a corner dot for a badge. */
export function SoulRailPlaces() {
  const t = useT();
  const { ui, nav } = usePa();
  const badges = useBadges();
  return (
    <div className={styles.rail} role="group" aria-label={t('pa.soul.shell.bar.label')}>
      {CELLS.map((cell) => {
        const badge = badges[cell.place];
        const said = badgeText(badge, t);
        const label = t(cell.label);
        return (
          <span key={cell.place} className={styles.railSlot}>
            <IconButton
              size="md"
              aria-label={said ? `${label} · ${said}` : label}
              tooltip={label}
              tooltipSide="right"
              on={isActive(cell.place, ui.place)}
              data-testid={cell.testId}
              onClick={() => nav.openPlace(cell.place)}
            >
              <FeatureIcon name={cell.icon} size={20} />
            </IconButton>
            {badge ? <span aria-hidden className={cn(styles.railDot, badge.kind === 'paused' && styles.dotPaused)} /> : null}
          </span>
        );
      })}
    </div>
  );
}
