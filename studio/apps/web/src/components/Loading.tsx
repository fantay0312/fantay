import { FantayLoader } from '../fantay/brand/FantayLoader';
import { Icon } from './Icon';

interface SpinnerProps {
  size?: number;
  label?: string;
}

export function Spinner({ size = 14, label }: SpinnerProps) {
  return (
    <span className="loading-spinner" role="status" aria-live="polite">
      <Icon name="spinner" size={size} />
      {label ? <span className="loading-spinner-label">{label}</span> : null}
    </span>
  );
}

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
}

export function Skeleton({ width, height = 14, radius = 6, className }: SkeletonProps) {
  return (
    <span
      className={`skeleton-block${className ? ` ${className}` : ''}`}
      style={{ width, height, borderRadius: radius }}
      aria-hidden
    />
  );
}

/**
 * Centered overlay used while bootstrap data loads (agents, skills, design
 * systems, project list). Sits inside a flex/grid parent and grows with it.
 */
export function CenteredLoader({ label }: { label?: string }) {
  return (
    // The live region lives on the container, so the loader inside it is told
    // not to open a second one.
    <div className="centered-loader" role="status" aria-live="polite">
      <FantayLoader size={52} label={label || undefined} labelClassName="centered-loader-label" decorative />
    </div>
  );
}
