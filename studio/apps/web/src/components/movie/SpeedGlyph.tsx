import { useId, type SVGProps } from 'react';
import { speedKind } from '../speedTiers';

/** Lucide's bolt, 24 viewBox. */
const BOLT = 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z';
/** Two narrower bolts side by side: the back one sits left, the front one right. */
const BACK = 'translate(9 12) scale(0.8) translate(-12 -12)';
const FRONT = 'translate(15 12) scale(0.8) translate(-12 -12)';

/**
 * The speed mark: an outline bolt for the standard tier, one solid bolt for 快速 (`fast` / `priority`) and
 * two overlapping bolts for 超快 (`ultrafast`). A tier no picker knows draws as one solid bolt.
 */
export function SpeedGlyph({ tier, size = 16, className, ...rest }: { tier: string | null | undefined; size?: number } & Omit<SVGProps<SVGSVGElement>, 'children'>) {
  const kind = speedKind(tier);
  const maskId = `speed-glyph-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden focusable="false" className={className} data-speed={kind} {...rest}>
    {kind === 'standard'
      ? <path d={BOLT} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"/>
      : kind === 'ultrafast'
        ? <>
          {/* The front bolt cuts a gap out of the back one, so the pair reads as two marks on any ground. */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <rect width="24" height="24" fill="#fff"/>
            <path d={BOLT} transform={FRONT} fill="#000" stroke="#000" strokeWidth={4.5} strokeLinejoin="round"/>
          </mask>
          {/* The mask sits on an untransformed group, so it is drawn in the glyph's own coordinates. */}
          <g mask={`url(#${maskId})`}><path d={BOLT} transform={BACK} fill="currentColor" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round"/></g>
          <path d={BOLT} transform={FRONT} fill="currentColor" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round"/>
        </>
        : <path d={BOLT} fill="currentColor" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round"/>}
  </svg>;
}
