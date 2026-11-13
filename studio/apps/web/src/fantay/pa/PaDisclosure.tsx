// SPDX-License-Identifier: AGPL-3.0-only
// A styled disclosure row (spec §12.5, §16): a 32 px bare-button trigger with the label, a tabular count and a
// chevron that turns 90° when open; the body folds on the grid-rows 0fr ↔ 1fr pattern. Never a raw <details>.
// Shared by the inspector day log, the task modal (events, attempts) and the Connections history (U4, U5).
import { ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Button, Icon, cn } from '../ui';
import styles from './PaWorkCards.module.css';

export interface PaDisclosureProps {
  label: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  className?: string;
  children: ReactNode;
}

export function PaDisclosure({ label, count, defaultOpen = false, open, onOpenChange, className, children }: PaDisclosureProps) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = open ?? innerOpen;
  const bodyId = useId();
  const innerRef = useRef<HTMLDivElement>(null);

  // `inert` is not in React 18's DOM typings; set it on the element so folded rows are neither focusable nor read.
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    if (isOpen) inner.removeAttribute('inert');
    else inner.setAttribute('inert', '');
  }, [isOpen]);

  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className={cn(styles.disclosure, className)} data-open={isOpen ? 'true' : 'false'}>
      <Button variant="bare" className={styles.disclosureTrigger} aria-expanded={isOpen} aria-controls={bodyId} onClick={toggle}>
        <span className={styles.disclosureLabel}>{label}</span>
        {count !== undefined ? (
          <>
            {' '}
            <span className={styles.disclosureCount}>{count}</span>
          </>
        ) : null}
        <Icon icon={ChevronRight} size={14} className={styles.disclosureChevron} />
      </Button>
      <div id={bodyId} className={styles.disclosureBody} aria-hidden={isOpen ? undefined : true}>
        <div ref={innerRef} className={styles.disclosureInner}>
          {children}
        </div>
      </div>
    </div>
  );
}
