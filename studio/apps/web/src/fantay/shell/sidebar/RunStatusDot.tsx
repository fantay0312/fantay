// SPDX-License-Identifier: AGPL-3.0-only
// The 6 px run-status dot of a sidebar row (spec 02 §11.3): running = brand with the status pulse, waiting = a
// hollow brand ring, failed = accent ink, unread (finished, not yet opened) = ink. Labelled with the shared
// status names (`STATUS_LABEL_KEYS`), so the dot is never colour-only information.
import { Dot } from '../../ui/dot';
import { cn } from '../../ui/cn';
import type { SidebarStatusTone } from './sidebar-model';

export interface RunStatusDotProps {
  tone: SidebarStatusTone;
  label?: string;
  className?: string;
  'data-testid'?: string;
}

const TONE_CLASS: Record<Exclude<SidebarStatusTone, null>, string> = {
  running: '',
  waiting: 'bg-transparent shadow-[inset_0_0_0_1px_var(--brand)]',
  failed: '',
  unread: 'text-ink',
};

const DOT_TONE: Record<Exclude<SidebarStatusTone, null>, 'running' | 'failed' | 'current'> = {
  running: 'running',
  waiting: 'current',
  failed: 'failed',
  unread: 'current',
};

export function RunStatusDot({ tone, label, className, 'data-testid': testId }: RunStatusDotProps) {
  if (!tone) return null;
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid={testId}
      data-tone={tone}
      className={cn('inline-grid size-2 flex-none place-items-center', className)}
    >
      <Dot size="sm" tone={DOT_TONE[tone]} className={TONE_CLASS[tone]} />
    </span>
  );
}
