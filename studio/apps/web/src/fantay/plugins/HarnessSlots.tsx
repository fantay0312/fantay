// SPDX-License-Identifier: AGPL-3.0-only
// The DeepSeek Harness slots Fantay draws outside plugin pages: actions at the foot of the sidebar and
// entries above the chat composer. A Harness plugin registers into them exactly as it does in the
// Harness; each entry gets the Harness owner props for its slot plus the session props
// (`harness-session.ts`), and sits in its own boundary so a broken entry only removes itself.
import { useMemo, type MutableRefObject } from 'react';

import { cn } from '../ui/cn';
import { HARNESS_EMPTY_INPUT, HARNESS_ROOT_PROPS, harnessSessionProps, useHarnessSessionSnapshot } from './harness-session';
import { PluginBoundary, useSlotEntries } from './react';
import styles from './HarnessSlots.module.css';

/** Class that maps the Harness theme tokens onto Fantay's; put it on any element that hosts a Harness component. */
export const harnessSurfaceClass = styles.harness;

/**
 * `sidebar.footer.action`: optional actions at the foot of the sidebar. `wide` tells an action whether
 * it has room for its label; Fantay's sidebar panel always does.
 */
export function PluginSidebarFooterActions({ wide = true }: { wide?: boolean }) {
  const entries = useSlotEntries('sidebar.footer.action');
  if (entries.length === 0) return null;
  return (
    <div className={cn(styles.harness, styles.footerActions)} data-testid="fantay-sidebar-plugin-actions">
      {entries.map((entry) => {
        const Action = entry.component;
        return (
          <PluginBoundary key={entry.uid}>
            <Action {...HARNESS_ROOT_PROPS} wide={wide} />
          </PluginBoundary>
        );
      })}
    </div>
  );
}

export interface PluginInputDockProps {
  /** The conversation the composer writes to; without one nothing is drawn, as the slot is session-scoped. */
  sessionId: string | null | undefined;
  /**
   * The dock's element. It stays mounted (hidden while empty) so the chat's resize tracking can hold on
   * to one node and still hear the dock grow or shrink.
   */
  containerRef?: MutableRefObject<HTMLDivElement | null>;
}

/** `conversation.input.dock`: full-width entries above the composer of the open conversation. */
export function PluginInputDock({ sessionId, containerRef }: PluginInputDockProps) {
  const entries = useSlotEntries('conversation.input.dock');
  const session = useHarnessSessionSnapshot(sessionId);
  const sessionProps = useMemo(() => harnessSessionProps(sessionId), [sessionId]);
  const shown = Boolean(sessionId) && entries.length > 0;
  return (
    <div
      ref={containerRef}
      className={cn(styles.harness, styles.inputDock)}
      data-testid="chat-plugin-dock"
      hidden={!shown}
    >
      {shown
        ? entries.map((entry) => {
            const Entry = entry.component;
            // Keyed by conversation as well: an entry's own state belongs to the session it was shown for.
            return (
              <PluginBoundary key={`${sessionId}:${entry.uid}`}>
                <Entry {...sessionProps} session={session} input={HARNESS_EMPTY_INPUT} />
              </PluginBoundary>
            );
          })
        : null}
    </div>
  );
}
