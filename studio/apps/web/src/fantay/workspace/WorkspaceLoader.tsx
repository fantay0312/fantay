// SPDX-License-Identifier: AGPL-3.0-only
// Centred loading state for workspace surfaces (the board host while `ProjectBoard` loads, the project
// design-system tab). A whole pane with nothing to show yet gets the Fantay character flying on the spot
// (`FantayLoader`), the same wait the startup splash shows; the ring `Spinner` stays for busy controls.
import { FantayLoader } from '../brand/FantayLoader';
import { cn } from '../ui';

export interface WorkspaceLoaderProps {
  /** Announced (role="status") and shown under the character. */
  label: string;
  className?: string;
  'data-testid'?: string;
}

export function WorkspaceLoader({ label, className, 'data-testid': testId }: WorkspaceLoaderProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'fx flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center p-6 font-ui text-label text-ink-faint',
        className,
      )}
    >
      <FantayLoader size={56} label={label} />
    </div>
  );
}
